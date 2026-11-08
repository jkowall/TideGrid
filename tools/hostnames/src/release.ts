/**
 * Recover a request interrupted between the provider and the database
 * (W1-SAAS-PREP, proposed). `request` reserves the name, creates the
 * provider's record, then stores its id. If the process dies after the
 * create and before the id is stored, the row stays pending with no provider
 * id, and running `request` again gets `already_exists`, because the adoption
 * rule never adopts a record it cannot prove this request made.
 *
 * `release` finds that record by its exact name. A dry run (the default)
 * prints its id and the reservation's time and changes nothing, so the admin
 * can check in the dashboard that the record was created after the
 * reservation. `--apply --provider-id <id>` audits the intent, deletes
 * exactly that record, audits the delete, and resumes the request, which
 * creates a fresh record and stores its id. A resumed request keeps its
 * original seven-day claim, so once that claim has ended `release` deletes
 * the record but never resumes: the next sweep would expire the name to
 * disabled. It never touches a row whose provider id is stored, a row of
 * another tenant, or an active row. Its reads run inside a tenant
 * transaction, as the tenant contract requires.
 *
 * A disabled row with no stored id (recheck Q3) is the removal runbook's
 * orphan: an interrupted request that was disabled, or whose claim ended.
 * `release` shows and deletes its record the same way, audited, and never
 * resumes it: a disabled name stays disabled.
 *
 * It runs holding the per-hostname guard (recheck Q1), as `request` does, so
 * no request attaches a record between release's check and its delete. It
 * checks the row again under the guard, in the transaction that audits the
 * intent, right before the delete.
 */
import { type Database, inTenantTransaction, type TenantContext } from "@tidegrid/database";
import {
  type AdminActor,
  assertHostnameGuardHeld,
  type CustomHostnameProvider,
  type HostnameGuard,
  requestCustomHostname,
  withHostnameGuard,
} from "@tidegrid/domain-hostnames";
import { customHostnameProblem } from "@tidegrid/tenant-config";
import { type Kysely, sql } from "kysely";
import { requestLines } from "./format.ts";

/** The tenant context the CLI's own reads and audit rows run in. */
export function cliContext(tenantId: string, actor: AdminActor): TenantContext {
  return {
    tenantId,
    actorType: "support",
    actorId: actor.actorId,
    requestId: actor.requestId,
  };
}

export interface ReleaseInput {
  tenantId: string;
  slug: string;
  hostname: string;
  apply: boolean;
  /** The record id the admin checked; required to delete one. */
  providerId: string | null;
  actor: AdminActor;
}

interface ReservationRow {
  kind: string;
  status: string;
  provider: string | null;
  provider_hostname_id: string | null;
  reserved_at: Date | null;
  claim_expires_at: Date | null;
  claim_ended: boolean | null;
}

/** This tenant's row for the name, read inside the caller's tenant transaction. */
async function readReservation(
  trx: Kysely<Database>,
  input: ReleaseInput,
): Promise<ReservationRow | null> {
  const { rows } = await sql<ReservationRow>`
    select h.kind, h.status, p.provider, p.provider_hostname_id, p.created_at as reserved_at,
           p.claim_expires_at, p.claim_expires_at <= now() as claim_ended
      from public.tenant_hostnames h
      left join public.tenant_hostname_provisioning p
        on p.hostname = h.hostname and p.tenant_id = h.tenant_id
     where h.tenant_id = ${input.tenantId} and h.hostname = ${input.hostname}`.execute(trx);
  return rows[0] ?? null;
}

async function reservation(
  db: Kysely<Database>,
  input: ReleaseInput,
): Promise<ReservationRow | null> {
  return inTenantTransaction(db, cliContext(input.tenantId, input.actor), (trx) =>
    readReservation(trx, input),
  );
}

/**
 * Why release must not touch a row, or null when it may: a pending or
 * disabled custom row of this tenant and provider with no stored id.
 */
function notReleasable(row: ReservationRow | null, provider: string): string | null {
  if (row?.kind !== "custom") return "not a custom hostname of this tenant";
  if (row.status !== "pending" && row.status !== "disabled") return `${row.status}, not pending`;
  if (row.provider !== provider) return `reserved for provider ${row.provider ?? "none"}`;
  if (row.provider_hostname_id !== null) {
    return row.status === "pending"
      ? "its provider id is stored, so the request was not interrupted"
      : `${row.status}, not pending, and its provider id is stored: delete its record by H5 of docs/runbooks/hostname-removal.md`;
  }
  return null;
}

/** Why release must not resume this row's request, or null when it may. */
function noResume(row: ReservationRow): { short: string; lines: string[] } | null {
  if (row.status === "disabled") {
    return {
      short: "The name is disabled",
      lines: [
        "not resumed: the name is disabled, and a disabled name stays disabled.",
        "  Continue the removal by docs/runbooks/hostname-removal.md.",
      ],
    };
  }
  // A resumed request keeps its original claim. Once the claim has ended, the
  // next sweep would expire the resumed request to disabled, which is final,
  // so release never resumes it (review S1).
  if (row.claim_ended !== false) {
    const claimAt = row.claim_expires_at ? row.claim_expires_at.toISOString() : "unknown";
    return {
      short: "The claim has ended",
      lines: [
        `not resumed: the seven-day claim ended at ${claimAt}, and the next sweep would expire a resumed request to disabled.`,
        "  Run disable with a reason and follow docs/runbooks/hostname-removal.md. Using the name again needs a migration.",
      ],
    };
  }
  return null;
}

type ReleaseAction = "hostname.provider_release_started" | "hostname.provider_released";

async function insertAudit(
  trx: Kysely<Database>,
  input: ReleaseInput,
  action: ReleaseAction,
  reason: string,
  providerId: string,
): Promise<void> {
  await sql`insert into public.audit_events
      (tenant_id, action, subject_type, subject_id, reason, after_state)
    values (${input.tenantId}, ${action}, 'tenant_hostname', ${input.hostname}, ${reason},
            ${JSON.stringify({ provider_hostname_id: providerId })}::text::jsonb)`.execute(trx);
}

async function audit(
  db: Kysely<Database>,
  input: ReleaseInput,
  action: ReleaseAction,
  reason: string,
  providerId: string,
): Promise<void> {
  await inTenantTransaction(db, cliContext(input.tenantId, input.actor), (trx) =>
    insertAudit(trx, input, action, reason, providerId),
  );
}

export async function releaseInterruptedRequest(
  db: Kysely<Database>,
  provider: CustomHostnameProvider,
  input: ReleaseInput,
): Promise<string[]> {
  const { hostname } = input;
  const problem = customHostnameProblem(hostname);
  if (problem) return [`${hostname}: refused: ${problem}`];
  return withHostnameGuard(db, hostname, (guard) => releaseUnderGuard(guard, provider, input));
}

async function releaseUnderGuard(
  guard: HostnameGuard,
  provider: CustomHostnameProvider,
  input: ReleaseInput,
): Promise<string[]> {
  const { hostname } = input;
  const row = await reservation(guard.db, input);
  const why = notReleasable(row, provider.name);
  if (why || !row) return [`${hostname}: nothing to release: ${why}`];
  const reservedAt = row.reserved_at ? row.reserved_at.toISOString() : "unknown";
  const claimAt = row.claim_expires_at ? row.claim_expires_at.toISOString() : "unknown";
  const stop = noResume(row);
  const claimEnded = row.claim_ended !== false;
  const reservedLine = `reserved at ${reservedAt}; claim ${claimEnded ? "ended" : "ends"} at ${claimAt}`;

  const found = await provider.findByHostname(hostname);
  const resume = async (lines: string[]) => {
    // The claim may have ended, or the name been disabled, while the provider
    // was asked: read the row again under the guard and apply the same rule
    // before requesting another record (pull request review).
    const fresh = await inTenantTransaction(
      guard.db,
      cliContext(input.tenantId, input.actor),
      async (trx) => {
        await assertHostnameGuardHeld(trx, hostname);
        return readReservation(trx, input);
      },
    );
    const whyFresh = notReleasable(fresh, provider.name);
    if (whyFresh || !fresh) return [...lines, `not resumed: ${whyFresh ?? "the row is gone"}`];
    const stopFresh = noResume(fresh);
    if (stopFresh) return [...lines, ...stopFresh.lines];
    const outcome = await requestCustomHostname(
      guard.db,
      provider,
      { tenantId: input.tenantId, hostname, actor: input.actor },
      { guard },
    );
    return [...lines, ...requestLines(hostname, outcome)];
  };

  if (!found) {
    const lines = [`${hostname}: no provider record holds this name; ${reservedLine}`];
    if (stop) return [...lines, ...stop.lines];
    if (!input.apply) {
      return [...lines, "dry run: nothing changed. Run again with --apply to resume the request."];
    }
    return resume(lines);
  }

  const lines = [
    `${hostname}: provider record ${found.providerId} (hostname ${found.hostnameState}, certificate ${found.certificateState}); ${reservedLine}`,
  ];
  if (!input.apply) {
    return [
      ...lines,
      `dry run: nothing deleted.${stop ? ` ${stop.short}, so --apply deletes this record and does not resume the request.` : ""} Check in the dashboard that this record was created after the reservation, then run:`,
      `  hostnames release ${input.slug} ${hostname} --apply --provider-id ${found.providerId}`,
    ];
  }
  if (input.providerId !== found.providerId) {
    return [
      ...lines,
      `refused: --provider-id ${input.providerId ?? "(none)"} does not name the record found; nothing deleted`,
    ];
  }
  // Check the row again right before the delete, under the guard, in the
  // transaction that audits the intent (recheck Q1). Audit the intent before
  // the delete and the delete before anything else reads the provider, so no
  // path deletes a record without a trace (review R2, S2): not a delete that
  // times out after acting, not a follow-up lookup that fails or still sees
  // the record.
  const checked = await inTenantTransaction(
    guard.db,
    cliContext(input.tenantId, input.actor),
    async (trx) => {
      await assertHostnameGuardHeld(trx, hostname);
      const now = await readReservation(trx, input);
      const whyNow = notReleasable(now, provider.name);
      if (whyNow || !now) return { why: whyNow ?? "the row is gone" };
      await insertAudit(
        trx,
        input,
        "hostname.provider_release_started",
        "Deleting the provider record an interrupted request left behind",
        found.providerId,
      );
      return { row: now };
    },
  );
  if (!("row" in checked)) {
    return [...lines, `refused: ${checked.why}; nothing deleted`];
  }
  await provider.remove(found.providerId);
  await audit(
    guard.db,
    input,
    "hostname.provider_released",
    "Deleted the provider record an interrupted request left behind",
    found.providerId,
  );
  const deleted = [...lines, `deleted provider record ${found.providerId}`];
  const stopNow = noResume(checked.row);
  if (stopNow) return [...deleted, ...stopNow.lines];
  if (await provider.findByHostname(hostname)) {
    return [
      ...deleted,
      "refused: a record still holds this name after the delete; nothing resumed",
    ];
  }
  return resume(deleted);
}
