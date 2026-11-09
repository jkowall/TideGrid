import type {
  DeletionRequest,
  DeletionRequestCreateRequest,
  Invitation,
  Member,
  MemberStatusRequest,
  StaffRole,
  SupportGrant,
  SupportGrantCreateRequest,
  TenantExportResponse,
} from "@tidegrid/contracts";
import {
  type Database,
  enqueueOutbox,
  type JsonObject,
  recordAudit,
  type TenantContext,
  type TenantTransaction,
} from "@tidegrid/database";
import { type Kysely, sql } from "kysely";
import { type SupportGrantAccess, toMember } from "./members.ts";

/**
 * Tenant access remainder (W3-G2.2b, without managed OIDC and MFA). Every
 * function here runs in the caller's tenant transaction, after the API has
 * authorized the caller, except the invitation list, which reads only the
 * signed-in person's own invitations. The rules that matter for isolation
 * are also enforced in the database (migration `tenant_access_remainder`).
 */

/** A PostgreSQL error's SQLSTATE and constraint, when it has them. */
function pgError(error: unknown): { code?: string; constraint?: string } {
  if (typeof error !== "object" || error === null) return {};
  const e = error as { code?: unknown; constraint_name?: unknown; constraint?: unknown };
  const constraint =
    typeof e.constraint_name === "string"
      ? e.constraint_name
      : typeof e.constraint === "string"
        ? e.constraint
        : undefined;
  return {
    ...(typeof e.code === "string" ? { code: e.code } : {}),
    ...(constraint ? { constraint } : {}),
  };
}

// Members ------------------------------------------------------------------------------

export type MemberStatusResult =
  | { kind: "not_found" }
  | { kind: "self" }
  | { kind: "last_owner" }
  | { kind: "changed"; member: Member }
  | { kind: "unchanged"; member: Member };

/**
 * Enable or disable a member of the context tenant. `active` enables a member
 * who accepted; for one who never accepted it sends a fresh seven-day
 * invitation instead. `disabled` ends access here at once; when it was the
 * person's last active membership, the database also revokes their sessions
 * in this transaction. Nobody changes their own status, and the last active owner
 * stays (the database holds that under concurrency too).
 */
export async function setMemberStatus(
  trx: TenantTransaction,
  ctx: TenantContext,
  userId: string,
  input: MemberStatusRequest,
): Promise<MemberStatusResult> {
  const current = await trx
    .selectFrom("tenant_memberships as m")
    .innerJoin("staff_users as u", "u.id", "m.user_id")
    .select(["m.status", "m.role", "m.accepted_at", "m.invitation_expires_at"])
    .where("m.tenant_id", "=", ctx.tenantId)
    .where("m.user_id", "=", userId)
    .forUpdate("m")
    .executeTakeFirst();
  if (!current) return { kind: "not_found" };
  if (ctx.actorId === userId) return { kind: "self" };

  const target =
    input.status === "disabled" ? "disabled" : current.accepted_at ? "active" : "invited";
  const invitationLapsed =
    current.status === "invited" &&
    (current.invitation_expires_at === null || current.invitation_expires_at <= new Date());
  const unchanged = target === current.status && !(target === "invited" && invitationLapsed);

  let row: {
    user_id: string;
    role: StaffRole;
    status: "invited" | "active" | "disabled";
    display_name: string;
    created_at: Date;
    invitation_expires_at: Date | null;
  };
  try {
    if (unchanged) {
      row = await trx
        .selectFrom("tenant_memberships")
        .select([
          "user_id",
          "role",
          "status",
          "display_name",
          "created_at",
          "invitation_expires_at",
        ])
        .where("tenant_id", "=", ctx.tenantId)
        .where("user_id", "=", userId)
        .executeTakeFirstOrThrow();
    } else {
      // A lapsed invitation is sent again by passing through disabled: the
      // database stamps a fresh invitation only on a move into invited.
      if (target === "invited" && current.status === "invited") {
        await trx
          .updateTable("tenant_memberships")
          .set({ status: "disabled" })
          .where("tenant_id", "=", ctx.tenantId)
          .where("user_id", "=", userId)
          .execute();
      }
      row = await trx
        .updateTable("tenant_memberships")
        .set({ status: target })
        .where("tenant_id", "=", ctx.tenantId)
        .where("user_id", "=", userId)
        .returning([
          "user_id",
          "role",
          "status",
          "display_name",
          "created_at",
          "invitation_expires_at",
        ])
        .executeTakeFirstOrThrow();
    }
  } catch (error) {
    if (pgError(error).constraint === "tenant_memberships_last_owner")
      return { kind: "last_owner" };
    throw error;
  }

  const email = await trx
    .selectFrom("staff_users")
    .select("email")
    .where("id", "=", userId)
    .executeTakeFirstOrThrow();
  const member = toMember({ ...row, email: email.email });
  if (unchanged) return { kind: "unchanged", member };

  await recordAudit(trx, ctx, {
    action: target === "invited" ? "membership.invited_again" : "membership.status_changed",
    subjectType: "staff_user",
    subjectId: userId,
    reason: input.reason,
    before: { status: current.status },
    after: { status: row.status },
  });
  await enqueueOutbox(trx, ctx, {
    topic: "tenant.membership.status_changed",
    aggregateType: "tenant_membership",
    aggregateId: userId,
    payload: { tenantId: ctx.tenantId, userId, status: row.status },
  });
  return { kind: "changed", member };
}

// Invitations --------------------------------------------------------------------------

/** The signed-in person's pending, unexpired invitations, across tenants. */
export async function listInvitations(db: Kysely<Database>, userId: string): Promise<Invitation[]> {
  const { rows } = await sql<{
    tenant_id: string;
    tenant_slug: string;
    tenant_name: string;
    role: StaffRole;
    invited_at: Date;
    expires_at: Date;
  }>`select * from app.auth_list_invitations(${userId})`.execute(db);
  return rows.map((r) => ({
    tenantId: r.tenant_id,
    tenantSlug: r.tenant_slug,
    tenantName: r.tenant_name,
    role: r.role,
    invitedAt: r.invited_at.toISOString(),
    expiresAt: r.expires_at.toISOString(),
  }));
}

/**
 * Accept or decline the actor's own invitation to the context tenant. The
 * context's actor must be the invited person; the database checks that too.
 * Returns null when there is no pending, unexpired invitation.
 */
export async function respondToInvitation(
  trx: TenantTransaction,
  ctx: TenantContext,
  accept: boolean,
): Promise<"active" | "disabled" | null> {
  const userId = ctx.actorId;
  if (!userId) throw new TypeError("an invitation is answered by a signed-in person");
  const { rows } = await sql<{ status: "active" | "disabled" | null }>`
    select app.auth_respond_invitation(${userId}, ${accept}, ${ctx.requestId ?? null}) as status
  `.execute(trx);
  const status = rows[0]?.status ?? null;
  if (!status) return null;
  await recordAudit(trx, ctx, {
    action: accept ? "membership.invitation_accepted" : "membership.invitation_declined",
    subjectType: "staff_user",
    subjectId: userId,
    before: { status: "invited" },
    after: { status },
  });
  await enqueueOutbox(trx, ctx, {
    topic: "tenant.membership.status_changed",
    aggregateType: "tenant_membership",
    aggregateId: userId,
    payload: { tenantId: ctx.tenantId, userId, status },
  });
  return status;
}

// Support access -------------------------------------------------------------------------

/** The open grant that lets the context's actor in as TideGrid support, or null. */
export async function loadSupportAccess(
  trx: TenantTransaction,
  userId: string,
): Promise<SupportGrantAccess | null> {
  const { rows } = await sql<{
    grant_id: string;
    reveal_personal_data: boolean;
    expires_at: Date;
    reason: string;
  }>`select * from app.support_grant_active(${userId})`.execute(trx);
  const row = rows[0];
  if (!row) return null;
  return {
    grantId: row.grant_id,
    revealPersonalData: row.reveal_personal_data,
    expiresAt: row.expires_at,
    reason: row.reason,
  };
}

interface GrantRow {
  grant_id: string;
  agent_email: string;
  reason: string;
  reveal_personal_data: boolean;
  granted_by: string;
  granted_at: Date;
  expires_at: Date;
  revoked_at: Date | null;
  revoked_by: string | null;
}

function toGrant(r: GrantRow, now: Date): SupportGrant {
  return {
    id: r.grant_id,
    agentEmail: r.agent_email,
    reason: r.reason,
    revealPersonalData: r.reveal_personal_data,
    grantedBy: r.granted_by,
    grantedAt: r.granted_at.toISOString(),
    expiresAt: r.expires_at.toISOString(),
    revokedAt: r.revoked_at ? r.revoked_at.toISOString() : null,
    revokedBy: r.revoked_by,
    state: r.revoked_at ? "revoked" : r.expires_at <= now ? "expired" : "open",
  };
}

async function readGrants(trx: TenantTransaction, limit: number): Promise<GrantRow[]> {
  const { rows } = await sql<GrantRow>`select * from app.support_grant_list(${limit})`.execute(trx);
  return rows;
}

/** One grant by id, however old: never a search of the capped list. */
async function readGrant(trx: TenantTransaction, grantId: string): Promise<GrantRow | undefined> {
  const { rows } = await sql<GrantRow>`
    select * from app.support_grant_list(1, ${grantId}::uuid)`.execute(trx);
  return rows[0];
}

export async function listSupportGrants(trx: TenantTransaction): Promise<SupportGrant[]> {
  const { rows } = await sql<{ now: Date }>`select clock_timestamp() as now`.execute(trx);
  const now = rows[0]?.now ?? new Date();
  return (await readGrants(trx, 50)).map((r) => toGrant(r, now));
}

export type IssueSupportGrantResult =
  | { kind: "unknown_agent" }
  | { kind: "already_open" }
  | { kind: "issued"; grant: SupportGrant };

/**
 * Grant one TideGrid support agent read access to the context tenant. Only an
 * active owner can (the database checks the actor). The grant's reason is in
 * the audit history; the agent's address is not, only their user id.
 */
export async function issueSupportGrant(
  trx: TenantTransaction,
  ctx: TenantContext,
  input: SupportGrantCreateRequest,
): Promise<IssueSupportGrantResult> {
  let issued: { grant_id: string; agent_user_id: string } | undefined;
  try {
    await sql`savepoint support_grant_issue`.execute(trx);
    const { rows } = await sql<{ grant_id: string; agent_user_id: string }>`
      select grant_id, agent_user_id from app.support_grant_issue(
        ${input.agentEmail}, ${input.reason}, ${input.minutes}, ${input.revealPersonalData},
        ${ctx.requestId ?? null})
    `.execute(trx);
    await sql`release savepoint support_grant_issue`.execute(trx);
    issued = rows[0];
  } catch (error) {
    if (pgError(error).constraint === "support_access_grants_one_active") {
      await sql`rollback to savepoint support_grant_issue`.execute(trx);
      return { kind: "already_open" };
    }
    throw error;
  }
  if (!issued) return { kind: "unknown_agent" };
  const grant = await readGrant(trx, issued.grant_id);
  if (!grant) throw new Error("issued support grant not found");
  await recordAudit(trx, ctx, {
    action: "support_access.granted",
    subjectType: "support_grant",
    subjectId: issued.grant_id,
    reason: input.reason,
    before: null,
    after: {
      agentUserId: issued.agent_user_id,
      revealPersonalData: grant.reveal_personal_data,
      expiresAt: grant.expires_at.toISOString(),
    },
  });
  await enqueueOutbox(trx, ctx, {
    topic: "tenant.support_access.granted",
    aggregateType: "support_grant",
    aggregateId: issued.grant_id,
    payload: {
      tenantId: ctx.tenantId,
      grantId: issued.grant_id,
      agentUserId: issued.agent_user_id,
    },
  });
  return { kind: "issued", grant: toGrant(grant, grant.granted_at) };
}

export type RevokeSupportGrantResult =
  | { kind: "not_open" }
  | { kind: "revoked"; grant: SupportGrant };

export async function revokeSupportGrant(
  trx: TenantTransaction,
  ctx: TenantContext,
  grantId: string,
  reason: string,
): Promise<RevokeSupportGrantResult> {
  const { rows } = await sql<{ revoked: boolean }>`
    select app.support_grant_revoke(${grantId}) as revoked
  `.execute(trx);
  if (!rows[0]?.revoked) return { kind: "not_open" };
  const grant = await readGrant(trx, grantId);
  if (!grant) throw new Error("revoked support grant not found");
  await recordAudit(trx, ctx, {
    action: "support_access.revoked",
    subjectType: "support_grant",
    subjectId: grantId,
    reason,
    before: { state: "open" },
    after: { state: "revoked" },
  });
  return { kind: "revoked", grant: toGrant(grant, grant.revoked_at ?? new Date()) };
}

/**
 * Record one request a support agent makes under a grant, before the request
 * runs, in its own transaction: the tenant's audit history then holds every
 * support access, including reads that fail. Returns false when the grant is
 * no longer open.
 */
export async function recordSupportAccess(
  trx: TenantTransaction,
  ctx: TenantContext,
  userId: string,
  detail: { method: string; route: string; permission: string; allowed: boolean },
): Promise<SupportGrantAccess | null> {
  const access = await loadSupportAccess(trx, userId);
  if (!access) return null;
  await recordAudit(trx, ctx, {
    action: "support_access.used",
    subjectType: "support_grant",
    subjectId: access.grantId,
    reason: access.reason,
    before: null,
    after: {
      method: detail.method,
      route: detail.route,
      permission: detail.permission,
      allowed: detail.allowed,
      masked: !access.revealPersonalData,
    },
  });
  return access;
}

// Account deletion request -----------------------------------------------------------------

function toDeletionRequest(r: {
  id: string;
  state: "requested" | "withdrawn";
  reason: string;
  requested_by: string;
  requested_at: Date;
  withdrawn_by: string | null;
  withdrawn_at: Date | null;
}): DeletionRequest {
  return {
    id: r.id,
    state: r.state,
    reason: r.reason,
    requestedBy: r.requested_by,
    requestedAt: r.requested_at.toISOString(),
    withdrawnBy: r.withdrawn_by,
    withdrawnAt: r.withdrawn_at ? r.withdrawn_at.toISOString() : null,
  };
}

const deletionColumns = [
  "id",
  "state",
  "reason",
  "requested_by",
  "requested_at",
  "withdrawn_by",
  "withdrawn_at",
] as const;

export async function getOpenDeletionRequest(
  trx: TenantTransaction,
  tenantId: string,
): Promise<DeletionRequest | null> {
  const row = await trx
    .selectFrom("tenant_deletion_requests")
    .select(deletionColumns)
    .where("tenant_id", "=", tenantId)
    .where("state", "=", "requested")
    .executeTakeFirst();
  return row ? toDeletionRequest(row) : null;
}

export type CreateDeletionRequestResult =
  | { kind: "slug_mismatch" }
  | { kind: "already_open" }
  | { kind: "created"; request: DeletionRequest };

/**
 * Ask TideGrid to close and delete the tenant's account. Nothing is deleted
 * here: the request is recorded, audited, and announced on the outbox for
 * TideGrid's own follow-up, and the owner may withdraw it until then.
 */
export async function createDeletionRequest(
  trx: TenantTransaction,
  ctx: TenantContext,
  tenantSlug: string,
  input: DeletionRequestCreateRequest,
): Promise<CreateDeletionRequestResult> {
  if (input.confirmSlug.trim().toLowerCase() !== tenantSlug) return { kind: "slug_mismatch" };
  const inserted = await trx
    .insertInto("tenant_deletion_requests")
    .values({ tenant_id: ctx.tenantId, reason: input.reason })
    .onConflict((oc) => oc.column("tenant_id").where("state", "=", "requested").doNothing())
    .returning(deletionColumns)
    .executeTakeFirst();
  if (!inserted) return { kind: "already_open" };
  const request = toDeletionRequest(inserted);
  await recordAudit(trx, ctx, {
    action: "account.deletion_requested",
    subjectType: "tenant",
    subjectId: ctx.tenantId,
    reason: input.reason,
    before: null,
    after: { requestId: request.id, state: request.state },
  });
  await enqueueOutbox(trx, ctx, {
    topic: "tenant.deletion.requested",
    aggregateType: "tenant",
    aggregateId: ctx.tenantId,
    payload: { tenantId: ctx.tenantId, requestId: request.id },
  });
  return { kind: "created", request };
}

export type WithdrawDeletionRequestResult =
  | { kind: "none_open" }
  | { kind: "withdrawn"; request: DeletionRequest };

export async function withdrawDeletionRequest(
  trx: TenantTransaction,
  ctx: TenantContext,
  reason: string,
): Promise<WithdrawDeletionRequestResult> {
  const updated = await trx
    .updateTable("tenant_deletion_requests")
    .set({ state: "withdrawn" })
    .where("tenant_id", "=", ctx.tenantId)
    .where("state", "=", "requested")
    .returning(deletionColumns)
    .executeTakeFirst();
  if (!updated) return { kind: "none_open" };
  const request = toDeletionRequest(updated);
  await recordAudit(trx, ctx, {
    action: "account.deletion_withdrawn",
    subjectType: "tenant",
    subjectId: ctx.tenantId,
    reason,
    before: { requestId: request.id, state: "requested" },
    after: { requestId: request.id, state: "withdrawn" },
  });
  await enqueueOutbox(trx, ctx, {
    topic: "tenant.deletion.withdrawn",
    aggregateType: "tenant",
    aggregateId: ctx.tenantId,
    payload: { tenantId: ctx.tenantId, requestId: request.id },
  });
  return { kind: "withdrawn", request };
}

// Data export -----------------------------------------------------------------------------

/**
 * The tables a tenant export holds, in order. Left out on purpose: sign-in and
 * guest link credentials, idempotency records, the outbox, sweep stamps,
 * quotes and holds (short-lived working state), email messages and waiver
 * deliveries (their payloads can carry link tokens), and the fake provider's
 * tables.
 */
export const EXPORT_TABLES = [
  "locations",
  "boats",
  "products",
  "product_boats",
  "schedules",
  "scheduled_trips",
  "blackouts",
  "brand_config_versions",
  "brand_activations",
  "price_list_versions",
  "price_list_items",
  "policy_versions",
  "tax_rate_versions",
  "promotions",
  "promotion_versions",
  "promotion_version_products",
  "payment_accounts",
  "checkout_sessions",
  "orders",
  "order_lines",
  "payments",
  "payment_refunds",
  "payment_cancellations",
  "refund_exceptions",
  "fee_ledger_entries",
  "credit_accounts",
  "credit_entries",
  "external_settlements",
  "payment_disputes",
  "payment_reconciliation_exceptions",
  "fee_assessments",
  "billing_plans",
  "fee_invoices",
  "bookings",
  "booking_participants",
  "booking_cancellations",
  "booking_notes",
  "finalization_exceptions",
  "finalization_exception_resolutions",
  "waiver_templates",
  "waiver_template_versions",
  "waiver_requests",
  "waiver_evidence",
  "tenant_hostnames",
  "tenant_deletion_requests",
  "audit_events",
] as const;

/**
 * Columns never exported, whatever the table: credentials, client addresses,
 * and stored file bytes (a signed waiver's document, which would swell the
 * export; its hash and metadata stay).
 */
const EXCLUDED_COLUMN =
  /(^|_)(hash|secret|token)$|^client_key$|^idempotency_key$|^source_ip$|^document$/;

export function exportRow(row: JsonObject): JsonObject {
  return Object.fromEntries(Object.entries(row).filter(([key]) => !EXCLUDED_COLUMN.test(key)));
}

export const DEFAULT_EXPORT_ROW_LIMIT = 10_000;

/**
 * The context tenant's records as JSON, one section per table, each capped at
 * `rowLimit` rows with a `truncated` flag. Every query filters by the tenant
 * explicitly, and row-level security bounds it underneath. Run it in a
 * snapshot read so every section shows the same moment.
 */
export async function exportTenantData(
  trx: TenantTransaction,
  tenant: { id: string; slug: string; name: string },
  options: { rowLimit?: number; now?: Date } = {},
): Promise<TenantExportResponse> {
  const rowLimit = options.rowLimit ?? DEFAULT_EXPORT_ROW_LIMIT;
  const sections: TenantExportResponse["sections"] = {};

  const members = await trx
    .selectFrom("tenant_memberships as m")
    .innerJoin("staff_users as u", "u.id", "m.user_id")
    .select([
      "m.user_id",
      "u.email",
      "m.display_name",
      "m.role",
      "m.status",
      "m.created_at",
      "m.invitation_expires_at",
    ])
    .where("m.tenant_id", "=", tenant.id)
    .orderBy("m.created_at")
    .orderBy("m.user_id")
    .limit(rowLimit + 1)
    .execute();
  sections.members = {
    rows: members.slice(0, rowLimit).map((m) => toMember(m) as unknown as JsonObject),
    truncated: members.length > rowLimit,
  };

  for (const table of EXPORT_TABLES) {
    const { rows } = await sql<{ row: JsonObject }>`
      -- Stored file bytes (a signed waiver's document, up to 2 MB a row)
      -- are dropped in the database, never sent to the Worker.
      select to_jsonb(t) - 'document' as row from ${sql.table(table)} t
       where t.tenant_id = ${tenant.id}
       limit ${rowLimit + 1}
    `.execute(trx);
    sections[table] = {
      rows: rows.slice(0, rowLimit).map((r) => exportRow(r.row)),
      truncated: rows.length > rowLimit,
    };
  }

  return {
    format: "tidegrid.tenant-export.v1",
    exportedAt: (options.now ?? new Date()).toISOString(),
    tenant,
    rowLimit,
    sections,
  };
}

// Retention ----------------------------------------------------------------------------------

/**
 * How long an abandoned checkout keeps its booker's name and email: coordinator
 * default D2, 30 days, pending owner confirmation. The database refuses
 * anything under 30 days.
 */
export const ABANDONED_CHECKOUT_RETENTION_DAYS = 30;
/** The most checkouts one cron run redacts; the rest wait for the next run. */
export const RETENTION_BATCH_LIMIT = 500;

/**
 * The cron's retention job: replace the booker's name and email on abandoned
 * checkouts (expired, failed, or canceled, with no booking and no successful
 * payment) older than the retention period with a fixed redaction, and record
 * one audit event per tenant touched. One statement across tenants, through
 * app.retention_redact_abandoned_checkouts.
 */
export async function redactAbandonedCheckouts(
  db: Kysely<Database>,
  options: { days?: number; limit?: number } = {},
): Promise<{ tenants: number; redacted: number; complete: boolean }> {
  // The database clamps a batch to 1 to 5,000; clamp here too, so that
  // "complete" compares against the batch the database actually ran.
  const limit = Math.max(1, Math.min(Math.trunc(options.limit ?? RETENTION_BATCH_LIMIT), 5000));
  const { rows } = await sql<{ tenant_id: string; redacted: number }>`
    select * from app.retention_redact_abandoned_checkouts(
      ${options.days ?? ABANDONED_CHECKOUT_RETENTION_DAYS}, ${limit})
  `.execute(db);
  const redacted = rows.reduce((sum, r) => sum + r.redacted, 0);
  return { tenants: rows.length, redacted, complete: redacted < limit };
}
