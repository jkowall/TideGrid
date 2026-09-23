import type { AuditEvent, Member, MemberCreateRequest, StaffRole } from "@tidegrid/contracts";
import {
  enqueueOutbox,
  recordAudit,
  type TenantContext,
  type TenantTransaction,
} from "@tidegrid/database";
import { sql } from "kysely";

export interface StaffTenantAccess {
  tenant: { id: string; slug: string; name: string; status: "active" | "suspended" };
  role: StaffRole;
}

/**
 * The caller's membership in the transaction's tenant, or null. Filters by
 * tenant explicitly; row-level security enforces the same bound underneath.
 */
export async function loadStaffTenantAccess(
  trx: TenantTransaction,
  tenantId: string,
  userId: string,
): Promise<StaffTenantAccess | null> {
  const row = await trx
    .selectFrom("tenant_memberships as m")
    .innerJoin("tenants as t", "t.id", "m.tenant_id")
    .select(["t.id", "t.slug", "t.display_name", "t.status", "m.role"])
    .where("m.tenant_id", "=", tenantId)
    .where("t.id", "=", tenantId)
    .where("m.user_id", "=", userId)
    .where("m.status", "=", "active")
    .executeTakeFirst();
  if (!row) return null;
  return {
    tenant: { id: row.id, slug: row.slug, name: row.display_name, status: row.status },
    role: row.role,
  };
}

function toMember(row: {
  user_id: string;
  email: string;
  display_name: string;
  role: StaffRole;
  status: "active" | "disabled";
  created_at: Date;
}): Member {
  return {
    userId: row.user_id,
    email: row.email,
    displayName: row.display_name,
    role: row.role,
    status: row.status,
    createdAt: row.created_at.toISOString(),
  };
}

export async function listMembers(trx: TenantTransaction, tenantId: string): Promise<Member[]> {
  const rows = await trx
    .selectFrom("tenant_memberships as m")
    .innerJoin("staff_users as u", "u.id", "m.user_id")
    .select(["m.user_id", "u.email", "m.display_name", "m.role", "m.status", "m.created_at"])
    .where("m.tenant_id", "=", tenantId)
    .orderBy("m.display_name")
    .orderBy("m.user_id")
    .execute();
  return rows.map(toMember);
}

export type AddMemberResult = { kind: "created"; member: Member } | { kind: "exists" };

/**
 * Add a staff member to the context tenant. Records the change with its reason
 * and before and after values, and enqueues `tenant.membership.created`, all in
 * the caller's transaction. Authorization happens before this call.
 */
export async function addMember(
  trx: TenantTransaction,
  ctx: TenantContext,
  input: MemberCreateRequest,
): Promise<AddMemberResult> {
  const email = input.email.trim().toLowerCase();
  const ensured = await sql<{ id: string }>`
    select app.ensure_staff_user(${email}, ${ctx.requestId ?? null}) as id
  `.execute(trx);
  const userId = ensured.rows[0]?.id;
  if (!userId) throw new Error("ensure_staff_user returned no id");

  const inserted = await trx
    .insertInto("tenant_memberships")
    .values({
      tenant_id: ctx.tenantId,
      user_id: userId,
      role: input.role,
      display_name: input.displayName,
    })
    .onConflict((oc) => oc.columns(["tenant_id", "user_id"]).doNothing())
    .returning(["user_id", "role", "status", "display_name", "created_at"])
    .executeTakeFirst();
  if (!inserted) return { kind: "exists" };

  await recordAudit(trx, ctx, {
    action: "membership.created",
    subjectType: "staff_user",
    subjectId: userId,
    reason: input.reason,
    before: null,
    after: { role: inserted.role, status: inserted.status },
  });
  await enqueueOutbox(trx, ctx, {
    topic: "tenant.membership.created",
    aggregateType: "tenant_membership",
    aggregateId: userId,
    payload: { tenantId: ctx.tenantId, userId, role: inserted.role },
  });
  return {
    kind: "created",
    member: toMember({ ...inserted, email }),
  };
}

export async function listAuditEvents(
  trx: TenantTransaction,
  tenantId: string,
  page: { limit: number; before?: string | undefined },
): Promise<{ events: AuditEvent[]; nextBefore: string | null }> {
  let query = trx
    .selectFrom("audit_events")
    .select([
      "id",
      "occurred_at",
      "actor_type",
      "actor_id",
      "request_id",
      "action",
      "subject_type",
      "subject_id",
      "reason",
      "before_state",
      "after_state",
    ])
    .where("tenant_id", "=", tenantId)
    .orderBy("id", "desc")
    .limit(page.limit + 1);
  if (page.before) query = query.where("id", "<", page.before);
  const rows = await query.execute();
  const pageRows = rows.slice(0, page.limit);
  return {
    events: pageRows.map((r) => ({
      id: String(r.id),
      occurredAt: r.occurred_at.toISOString(),
      actorType: r.actor_type,
      actorId: r.actor_id,
      requestId: r.request_id,
      action: r.action,
      subjectType: r.subject_type,
      subjectId: r.subject_id,
      reason: r.reason,
      before: r.before_state,
      after: r.after_state,
    })),
    nextBefore: rows.length > page.limit ? String(pageRows.at(-1)?.id ?? "") || null : null,
  };
}
