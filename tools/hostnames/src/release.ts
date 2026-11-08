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
 * another tenant, or a row that is not pending. Its reads run inside a
 * tenant transaction, as the tenant contract requires.
 */
import { type Database, inTenantTransaction, type TenantContext } from "@tidegrid/database";
import {
  type AdminActor,
  type CustomHostnameProvider,
  requestCustomHostname,
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

async function reservation(
  db: Kysely<Database>,
  input: ReleaseInput,
): Promise<ReservationRow | null> {
  return inTenantTransaction(db, cliContext(input.tenantId, input.actor), async (trx) => {
    const { rows } = await sql<ReservationRow>`
      select h.kind, h.status, p.provider, p.provider_hostname_id, p.created_at as reserved_at,
             p.claim_expires_at, p.claim_expires_at <= now() as claim_ended
        from public.tenant_hostnames h
        left join public.tenant_hostname_provisioning p
          on p.hostname = h.hostname and p.tenant_id = h.tenant_id
       where h.tenant_id = ${input.tenantId} and h.hostname = ${input.hostname}`.execute(trx);
    return rows[0] ?? null;
  });
}

/** Why a row is not an interrupted request, or null when it is one. */
function notInterrupted(row: ReservationRow | null, provider: string): string | null {
  if (row?.kind !== "custom") return "not a custom hostname of this tenant";
  if (row.status !== "pending") return `${row.status}, not pending`;
  if (row.provider !== provider) return `reserved for provider ${row.provider ?? "none"}`;
  if (row.provider_hostname_id !== null) {
    return "its provider id is stored, so the request was not interrupted";
  }
  return null;
}

async function audit(
  db: Kysely<Database>,
  input: ReleaseInput,
  action: "hostname.provider_release_started" | "hostname.provider_released",
  reason: string,
  providerId: string,
): Promise<void> {
  await inTenantTransaction(db, cliContext(input.tenantId, input.actor), async (trx) => {
    await sql`insert into public.audit_events
        (tenant_id, action, subject_type, subject_id, reason, after_state)
      values (${input.tenantId}, ${action}, 'tenant_hostname', ${input.hostname}, ${reason},
              ${JSON.stringify({ provider_hostname_id: providerId })}::text::jsonb)`.execute(trx);
  });
}

export async function releaseInterruptedRequest(
  db: Kysely<Database>,
  provider: CustomHostnameProvider,
  input: ReleaseInput,
): Promise<string[]> {
  const { hostname } = input;
  const problem = customHostnameProblem(hostname);
  if (problem) return [`${hostname}: refused: ${problem}`];
  const row = await reservation(db, input);
  const why = notInterrupted(row, provider.name);
  if (why) return [`${hostname}: nothing to release: ${why}`];
  const reservedAt = row?.reserved_at ? row.reserved_at.toISOString() : "unknown";
  const claimAt = row?.claim_expires_at ? row.claim_expires_at.toISOString() : "unknown";
  // A resumed request keeps its original claim. Once the claim has ended, the
  // next sweep would expire the resumed request to disabled, which is final,
  // so release never resumes it (review S1).
  const claimEnded = row?.claim_ended !== false;
  const reservedLine = `reserved at ${reservedAt}; claim ${claimEnded ? "ended" : "ends"} at ${claimAt}`;
  const notResumed = [
    `not resumed: the seven-day claim ended at ${claimAt}, and the next sweep would expire a resumed request to disabled.`,
    "  Run disable with a reason and follow docs/runbooks/hostname-removal.md. Using the name again needs a migration.",
  ];

  const found = await provider.findByHostname(hostname);
  const resume = async (lines: string[]) => {
    const outcome = await requestCustomHostname(db, provider, {
      tenantId: input.tenantId,
      hostname,
      actor: input.actor,
    });
    return [...lines, ...requestLines(hostname, outcome)];
  };

  if (!found) {
    const lines = [`${hostname}: no provider record holds this name; ${reservedLine}`];
    if (claimEnded) return [...lines, ...notResumed];
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
      `dry run: nothing deleted.${claimEnded ? " The claim has ended, so --apply deletes this record and does not resume the request." : ""} Check in the dashboard that this record was created after the reservation, then run:`,
      `  hostnames release ${input.slug} ${hostname} --apply --provider-id ${found.providerId}`,
    ];
  }
  if (input.providerId !== found.providerId) {
    return [
      ...lines,
      `refused: --provider-id ${input.providerId ?? "(none)"} does not name the record found; nothing deleted`,
    ];
  }
  // Audit the intent before the delete and the delete before anything else
  // reads the provider, so no path deletes a record without a trace (review
  // R2, S2): not a delete that times out after acting, not a follow-up lookup
  // that fails or still sees the record.
  await audit(
    db,
    input,
    "hostname.provider_release_started",
    "Deleting the provider record an interrupted request left behind",
    found.providerId,
  );
  await provider.remove(found.providerId);
  await audit(
    db,
    input,
    "hostname.provider_released",
    "Deleted the provider record an interrupted request left behind",
    found.providerId,
  );
  const deleted = [...lines, `deleted provider record ${found.providerId}`];
  if (claimEnded) return [...deleted, ...notResumed];
  if (await provider.findByHostname(hostname)) {
    return [
      ...deleted,
      "refused: a record still holds this name after the delete; nothing resumed",
    ];
  }
  return resume(deleted);
}
