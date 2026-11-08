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
 * reservation. `--apply --provider-id <id>` deletes exactly that record,
 * audits it, and resumes the request, which creates a fresh record and stores
 * its id. It never touches a row whose provider id is stored, a row of
 * another tenant, or a row that is not pending.
 */
import { type Database, inTenantTransaction } from "@tidegrid/database";
import {
  type AdminActor,
  type CustomHostnameProvider,
  requestCustomHostname,
} from "@tidegrid/domain-hostnames";
import { customHostnameProblem } from "@tidegrid/tenant-config";
import { type Kysely, sql } from "kysely";
import { requestLines } from "./format.ts";

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
}

async function reservation(
  db: Kysely<Database>,
  tenantId: string,
  hostname: string,
): Promise<ReservationRow | null> {
  const { rows } = await sql<ReservationRow>`
    select h.kind, h.status, p.provider, p.provider_hostname_id, p.created_at as reserved_at
      from public.tenant_hostnames h
      left join public.tenant_hostname_provisioning p
        on p.hostname = h.hostname and p.tenant_id = h.tenant_id
     where h.tenant_id = ${tenantId} and h.hostname = ${hostname}`.execute(db);
  return rows[0] ?? null;
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

export async function releaseInterruptedRequest(
  db: Kysely<Database>,
  provider: CustomHostnameProvider,
  input: ReleaseInput,
): Promise<string[]> {
  const { hostname } = input;
  const problem = customHostnameProblem(hostname);
  if (problem) return [`${hostname}: refused: ${problem}`];
  const row = await reservation(db, input.tenantId, hostname);
  const why = notInterrupted(row, provider.name);
  if (why) return [`${hostname}: nothing to release: ${why}`];
  const reservedAt = row?.reserved_at ? row.reserved_at.toISOString() : "unknown";

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
    const lines = [`${hostname}: no provider record holds this name; reserved at ${reservedAt}`];
    if (!input.apply) {
      return [...lines, "dry run: nothing changed. Run again with --apply to resume the request."];
    }
    return resume(lines);
  }

  const lines = [
    `${hostname}: provider record ${found.providerId} (hostname ${found.hostnameState}, certificate ${found.certificateState}); reserved at ${reservedAt}`,
  ];
  if (!input.apply) {
    return [
      ...lines,
      "dry run: nothing deleted. Check in the dashboard that this record was created after the reservation, then run:",
      `  hostnames release ${input.slug} ${hostname} --apply --provider-id ${found.providerId}`,
    ];
  }
  if (input.providerId !== found.providerId) {
    return [
      ...lines,
      `refused: --provider-id ${input.providerId ?? "(none)"} does not name the record found; nothing deleted`,
    ];
  }
  await provider.remove(found.providerId);
  if (await provider.findByHostname(hostname)) {
    return [...lines, "refused: a record still holds this name after the delete; nothing resumed"];
  }
  await inTenantTransaction(
    db,
    {
      tenantId: input.tenantId,
      actorType: "support",
      actorId: input.actor.actorId,
      requestId: input.actor.requestId,
    },
    async (trx) => {
      await sql`insert into public.audit_events
          (tenant_id, action, subject_type, subject_id, reason, after_state)
        values (${input.tenantId}, 'hostname.provider_released', 'tenant_hostname', ${hostname},
                'Deleted the provider record an interrupted request left behind',
                ${JSON.stringify({ provider_hostname_id: found.providerId })}::text::jsonb)`.execute(
        trx,
      );
    },
  );
  return resume([...lines, `deleted provider record ${found.providerId}`]);
}
