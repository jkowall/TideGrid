import { type Database, inTenantTransaction, type TenantContext } from "@tidegrid/database";
import { customHostnameProblem } from "@tidegrid/tenant-config";
import { type Kysely, sql } from "kysely";
import {
  type CustomHostnameProvider,
  HostnameProviderRejectedError,
  HostnameProviderUnavailableError,
  isActivatable,
  type ProviderHostname,
} from "./provider.ts";

/**
 * The custom-hostname lifecycle (G2.14b). Two halves with different
 * authority:
 *
 * - The admin half (request, attach, activate, disable) runs on the admin
 *   connection only, from the admin CLI. The runtime role holds no EXECUTE on
 *   those functions.
 * - The sweep runs in the API Worker's cron as the runtime role. It reads the
 *   provider and records what it read inside each tenant's own transaction,
 *   which may demote a hostname and never promotes one.
 *
 * No provider call is ever made inside a database transaction.
 */

export interface AdminActor {
  /** Who ran the command, for the audit trail, such as `hostname-cli`. */
  actorId: string;
  requestId: string;
}

function adminContext(tenantId: string, actor: AdminActor): TenantContext {
  return {
    tenantId,
    actorType: "support",
    actorId: actor.actorId,
    requestId: actor.requestId,
  };
}

export class HostnameNameRefusedError extends Error {
  constructor(readonly code: string) {
    super(`that name cannot be a custom hostname: ${code}`);
    this.name = "HostnameNameRefusedError";
  }
}

export type RequestOutcome =
  | { kind: "requested"; reading: ProviderHostname; adopted: boolean }
  /** The provider could not be reached; the name stays reserved and pending without a record. */
  | { kind: "provider_unavailable"; retryAfterSeconds: number | null }
  /** The provider holds the name already and nothing shows this request created it. */
  | { kind: "already_exists" };

/**
 * Request a custom hostname for a tenant (admin connection). The name is
 * checked and reserved in the database first, so two tenants can never race
 * for it at the provider. Then the provider's record is created and its id
 * stored once.
 *
 * Adoption rule: when the create's answer is lost, an exact-name lookup may
 * find the record this same request created. It is adopted only then, while
 * no provider id is stored yet, and the adoption is audited. A record found
 * any other way is `already_exists`: without Enterprise custom metadata,
 * nothing marks a record in the zone as TideGrid's.
 */
export async function requestCustomHostname(
  adminDb: Kysely<Database>,
  provider: CustomHostnameProvider,
  input: { tenantId: string; hostname: string; actor: AdminActor },
): Promise<RequestOutcome> {
  const problem = customHostnameProblem(input.hostname);
  if (problem) throw new HostnameNameRefusedError(problem);
  await inTenantTransaction(adminDb, adminContext(input.tenantId, input.actor), async (trx) => {
    // Running the request again resumes a reservation of this tenant's that
    // never got its provider record, such as after an outage. Anything else
    // reserves the name now, or is refused because some tenant holds it.
    const waiting = await trx
      .selectFrom("tenant_hostname_provisioning as p")
      .innerJoin("tenant_hostnames as h", (join) =>
        join.onRef("h.hostname", "=", "p.hostname").onRef("h.tenant_id", "=", "p.tenant_id"),
      )
      .select("p.hostname")
      .where("p.tenant_id", "=", input.tenantId)
      .where("p.hostname", "=", input.hostname)
      .where("p.provider", "=", provider.name)
      .where("p.provider_hostname_id", "is", null)
      .where("h.status", "=", "pending")
      .executeTakeFirst();
    if (waiting) return;
    await sql`select app.hostname_request(${input.tenantId}::uuid, ${input.hostname}, ${provider.name})`.execute(
      trx,
    );
  });

  let reading: ProviderHostname | null = null;
  let adopted = false;
  try {
    reading = await provider.create({ hostname: input.hostname, certificateValidation: "txt" });
  } catch (error) {
    if (error instanceof HostnameProviderRejectedError && error.code === "already_exists") {
      return { kind: "already_exists" };
    }
    if (!(error instanceof HostnameProviderUnavailableError)) throw error;
    // The answer may be lost after the provider acted. Look for exactly this
    // name; anything found now was created by this request, because the name
    // was reserved above and no other request may create it.
    try {
      reading = await provider.findByHostname(input.hostname);
    } catch (lookup) {
      if (lookup instanceof HostnameProviderUnavailableError) {
        return { kind: "provider_unavailable", retryAfterSeconds: lookup.retryAfterSeconds };
      }
      throw lookup;
    }
    if (!reading) {
      return { kind: "provider_unavailable", retryAfterSeconds: error.retryAfterSeconds };
    }
    adopted = true;
  }
  if (reading.hostname !== input.hostname) {
    throw new HostnameProviderRejectedError("hostname_mismatch");
  }
  // JSON travels as text and is cast in SQL: postgres.js would encode a
  // string sent for a jsonb parameter as a JSON string, not as the array.
  await inTenantTransaction(adminDb, adminContext(input.tenantId, input.actor), async (trx) => {
    await sql`select app.hostname_attach_provider(
        ${input.tenantId}::uuid, ${input.hostname}, ${reading.providerId},
        ${JSON.stringify(reading.instructions)}::text::jsonb)`.execute(trx);
    if (adopted) {
      await sql`insert into public.audit_events
          (tenant_id, action, subject_type, subject_id, reason, after_state)
        values (${input.tenantId}, 'hostname.provider_adopted', 'tenant_hostname', ${input.hostname},
                'Adopted the provider record after a lost create answer',
                ${JSON.stringify({ provider_hostname_id: reading.providerId })}::text::jsonb)`.execute(
        trx,
      );
    }
  });
  return { kind: "requested", reading, adopted };
}

export type ActivateOutcome =
  | { kind: "activated"; reading: ProviderHostname }
  | { kind: "not_ready"; reading: ProviderHostname | null };

/**
 * Activate a pending custom hostname (admin connection), re-reading the
 * provider at call time. Both the provider's ownership and certificate states
 * must be active; the database checks the provider id and the states again.
 */
export async function activateCustomHostname(
  adminDb: Kysely<Database>,
  provider: CustomHostnameProvider,
  input: { tenantId: string; hostname: string; actor: AdminActor },
): Promise<ActivateOutcome> {
  const stored = await inTenantTransaction(
    adminDb,
    adminContext(input.tenantId, input.actor),
    async (trx) =>
      trx
        .selectFrom("tenant_hostname_provisioning")
        .select(["provider_hostname_id", "provider"])
        .where("tenant_id", "=", input.tenantId)
        .where("hostname", "=", input.hostname)
        .executeTakeFirst(),
  );
  if (!stored?.provider_hostname_id || stored.provider !== provider.name) {
    return { kind: "not_ready", reading: null };
  }
  const providerId = stored.provider_hostname_id;
  const reading = await provider.get(providerId, input.hostname);
  if (!reading || reading.providerId !== providerId || !isActivatable(reading)) {
    return { kind: "not_ready", reading };
  }
  await inTenantTransaction(adminDb, adminContext(input.tenantId, input.actor), async (trx) => {
    await sql`select app.hostname_activate(${input.tenantId}::uuid, ${input.hostname},
        ${providerId}, ${reading.hostnameState}, ${reading.certificateState})`.execute(trx);
  });
  return { kind: "activated", reading };
}

/**
 * Disable a hostname of any kind (admin connection). Returns false when it
 * was already disabled. The provider's record is removed separately, with
 * `provider.remove`, once the operator has deleted the CNAME.
 */
export async function disableHostname(
  adminDb: Kysely<Database>,
  input: { tenantId: string; hostname: string; reason: string; actor: AdminActor },
): Promise<boolean> {
  return inTenantTransaction(adminDb, adminContext(input.tenantId, input.actor), async (trx) => {
    const { rows } = await sql<{ changed: boolean }>`
      select app.hostname_disable(${input.tenantId}::uuid, ${input.hostname}, ${input.reason}) as changed`.execute(
      trx,
    );
    return rows[0]?.changed === true;
  });
}

// The sweep ------------------------------------------------------------------------

export interface HostnameSweepOptions {
  provider: CustomHostnameProvider;
  /** Correlates this run's audit rows, like a request id. */
  runId: string;
  tenantLimit?: number;
  /** Hostnames read per tenant per run. */
  perTenantLimit?: number;
  /**
   * Provider calls per run. Cloudflare allows 1,200 requests per 5 minutes
   * for the whole account; a run every 15 minutes stays far below that.
   */
  maxProviderCalls?: number;
  /** No new hostname starts after this many milliseconds. */
  budgetMs?: number;
  onTenantError?: (tenantId: string, error: unknown) => void;
  /** Check only these tenants, as the admin CLI's fake run does. */
  onlyTenants?: readonly string[];
  /**
   * The provider gave no reading for one record (a refusal about the record):
   * its opaque provider id and the code, for the log. The run goes on.
   */
  onUnread?: (tenantId: string, providerHostnameId: string, code: string) => void;
  /** A servable hostname whose certificate is close to expiry (G2.14b, D10). */
  onExpiring?: (tenantId: string, hostname: string) => void;
  clock?: () => number;
}

export interface HostnameSweepReport {
  tenants: number;
  checked: number;
  demoted: number;
  expired: number;
  failedTenants: number;
  /** The provider asked to wait (429 or 5xx); the run stopped early. */
  throttled: boolean;
  /**
   * The provider refused for the whole account (401 or 403, an
   * authentication code, a missing zone): the code, and the run stopped
   * early. Nothing was recorded, so nothing was demoted.
   */
  providerFault: string | null;
  /** The provider record being read when the account-level refusal came. */
  providerFaultHostnameId: string | null;
  /** Hostnames the provider gave no reading for, recorded with their code and no change. */
  unread: number;
  retryAfterSeconds: number | null;
  /** False when the budget, the call limit, the tenant limit, or throttling cut the run short. */
  complete: boolean;
}

export const DEFAULT_HOSTNAME_SWEEP_TENANT_LIMIT = 100;
export const DEFAULT_HOSTNAME_SWEEP_PER_TENANT = 20;
export const DEFAULT_HOSTNAME_SWEEP_PROVIDER_CALLS = 200;
export const DEFAULT_HOSTNAME_SWEEP_BUDGET_MS = 20_000;

interface DueHostname {
  hostname: string;
  provider_hostname_id: string;
  /** A pending hostname whose claim has run out: expired from the database alone. */
  claim_ended: boolean;
}

class Throttled extends Error {
  constructor(readonly retryAfterSeconds: number | null) {
    super("the provider asked to wait");
  }
}

/**
 * Refusals about the account, the token, or the zone rather than one record:
 * any HTTP 401 or 403, whatever Cloudflare code it carries (an expired,
 * rotated, or mis-scoped token), these Cloudflare codes in addition, and an
 * exact-name lookup that cannot find the zone (404). Every other hostname would get the same answer, so the run stops and
 * records nothing. The Cloudflare codes are its authentication and routing
 * errors as remembered from its API (invalid or missing token, bad
 * Authorization header, an object identifier that routes nowhere); they are
 * unverified against live Cloudflare and listed for G2.14b-live. Any code not
 * listed is treated as about the one record.
 */
const accountLevelRefusals = new Set([
  "http_401",
  "http_403",
  "cloudflare_9106",
  "cloudflare_9109",
  "cloudflare_10000",
  "cloudflare_6003",
  "cloudflare_6103",
  "cloudflare_6111",
  "cloudflare_7003",
]);

/** The provider refused for the whole account: stop the run and record nothing. */
export class HostnameSweepFault extends Error {
  constructor(
    readonly code: string,
    /** The provider record being read when the refusal came, an opaque provider id. */
    readonly providerHostnameId: string,
  ) {
    super(`the custom-hostname provider refused the account: ${code}`);
    this.name = "HostnameSweepFault";
  }
}

type Reading =
  | { kind: "reading"; hostnameState: string; certificateState: string; errorCode: string | null }
  /** The provider gave no reading for this one record: record the code, change nothing. */
  | { kind: "no_reading"; errorCode: string };

const recordGone = (errorCode: string): Reading => ({
  kind: "reading",
  hostnameState: "deleted",
  certificateState: "failed",
  errorCode,
});

/**
 * One hostname's reading. Only a reading the provider actually gave about
 * this record may change the hostname:
 *
 * - the record, mapped;
 * - the record now names another hostname: gone for this hostname;
 * - no record by id, confirmed by an exact-name lookup that answers normally:
 *   gone (or replaced by a record with another id).
 *
 * Anything else is not a reading. 429 and 5xx throttle the run. An
 * account-level refusal (see accountLevelRefusals, and a lookup's 404, which
 * means the zone itself is missing or out of the token's reach) throws
 * HostnameSweepFault, which stops the run and records nothing. Any other
 * refusal is about this record (a malformed answer for it, an ambiguous name,
 * another 4xx for its id): it is recorded as no reading, which keeps the
 * states, backs the next check off, and lets the run go on to the next
 * hostname, so one odd record never blocks every later check.
 *
 * Limit: if the token can reach another real zone and the zone id names it,
 * the lookup answers normally with no match and every hostname reads as
 * missing. The token is therefore scoped to the one SaaS zone (G2.14b-live).
 */
async function readHostname(
  provider: CustomHostnameProvider,
  item: DueHostname,
  countCall: () => void,
): Promise<Reading> {
  const refuse = (error: unknown, accountLevel: (code: string) => boolean): Reading => {
    if (error instanceof HostnameProviderUnavailableError) {
      throw new Throttled(error.retryAfterSeconds);
    }
    if (!(error instanceof HostnameProviderRejectedError)) throw error;
    if (error.httpStatus === 401 || error.httpStatus === 403 || accountLevel(error.code)) {
      throw new HostnameSweepFault(error.code, item.provider_hostname_id);
    }
    return { kind: "no_reading", errorCode: error.code };
  };
  let reading: ProviderHostname | null;
  try {
    reading = await provider.get(item.provider_hostname_id, item.hostname);
  } catch (error) {
    if (error instanceof HostnameProviderRejectedError && error.code === "hostname_mismatch") {
      return recordGone("hostname_mismatch");
    }
    return refuse(error, (code) => accountLevelRefusals.has(code));
  }
  if (!reading) {
    countCall();
    let found: ProviderHostname | null;
    try {
      found = await provider.findByHostname(item.hostname);
    } catch (error) {
      return refuse(error, (code) => code === "http_404" || accountLevelRefusals.has(code));
    }
    if (!found) return recordGone("provider_record_missing");
    if (found.providerId !== item.provider_hostname_id) {
      return recordGone("provider_record_replaced");
    }
    reading = found;
  }
  return {
    kind: "reading",
    hostnameState: reading.hostnameState,
    certificateState: reading.certificateState,
    errorCode: reading.errors[0] ?? null,
  };
}

/**
 * Check every custom hostname that is due, for the API Worker's cron, as the
 * runtime role. The tenant list comes from app.hostname_sweep_tenants (tenant
 * ids only). Each tenant's due rows are read, and each reading recorded,
 * inside that tenant's own transaction; the provider is read between them.
 * Only a definitive negative demotes an active hostname (the database's
 * rule): ownership moved, blocked, or deleted, or the certificate failed. A
 * record the provider no longer has, confirmed by an exact-name lookup, and a
 * record that names another hostname read as deleted. An account-level
 * refusal records nothing and stops the run (`providerFault`); a refusal
 * about one record is recorded with no change (`unread`) and the run goes
 * on; a 429 or 5xx stops the run, which honors `retry-after` because the next
 * run is 15 minutes away.
 */
export async function sweepHostnames(
  db: Kysely<Database>,
  options: HostnameSweepOptions,
): Promise<HostnameSweepReport> {
  const clock = options.clock ?? Date.now;
  const started = clock();
  const budgetMs = options.budgetMs ?? DEFAULT_HOSTNAME_SWEEP_BUDGET_MS;
  const maxCalls = options.maxProviderCalls ?? DEFAULT_HOSTNAME_SWEEP_PROVIDER_CALLS;
  const perTenant = options.perTenantLimit ?? DEFAULT_HOSTNAME_SWEEP_PER_TENANT;
  const tenantLimit = options.tenantLimit ?? DEFAULT_HOSTNAME_SWEEP_TENANT_LIMIT;
  const { rows } = await sql<{ tenant_id: string }>`
    select tenant_id from app.hostname_sweep_tenants(${tenantLimit})`.execute(db);
  const report: HostnameSweepReport = {
    tenants: 0,
    checked: 0,
    demoted: 0,
    expired: 0,
    failedTenants: 0,
    throttled: false,
    retryAfterSeconds: null,
    providerFault: null,
    providerFaultHostnameId: null,
    unread: 0,
    complete: rows.length < tenantLimit,
  };
  let calls = 0;
  const stop = () => calls >= maxCalls || clock() - started >= budgetMs;

  // After a throttle or an account-level refusal the run reads the provider
  // no more, but it still expires claims that ran out: that is the
  // database's own fact and needs no provider answer.
  let expiryOnly = false;
  for (const { tenant_id: tenantId } of rows) {
    if (options.onlyTenants && !options.onlyTenants.includes(tenantId)) continue;
    if (!expiryOnly && stop()) {
      report.complete = false;
      expiryOnly = true;
    }
    report.tenants += 1;
    const ctx: TenantContext = {
      tenantId,
      actorType: "system",
      actorId: "hostname-sweep",
      requestId: options.runId,
    };
    try {
      const due = await inTenantTransaction(db, ctx, async (trx) => {
        const { rows: found } = await sql<DueHostname>`
          select p.hostname, p.provider_hostname_id,
                 (h.status = 'pending' and p.claim_expires_at <= now()) as claim_ended
            from public.tenant_hostname_provisioning p
            join public.tenant_hostnames h
              on h.hostname = p.hostname and h.tenant_id = p.tenant_id
           where p.tenant_id = ${tenantId}
             and h.kind = 'custom'
             and p.provider = ${options.provider.name}
             and p.provider_hostname_id is not null
             and ((h.status = 'pending' and (p.next_check_at <= now() or p.claim_expires_at <= now()))
                  or (h.status = 'active' and p.next_check_at <= now()))
           order by claim_ended desc, p.next_check_at, p.hostname
           limit ${perTenant}`.execute(trx);
        return found;
      });
      if (due.length === perTenant) report.complete = false;
      for (const item of due) {
        if (item.claim_ended) {
          // No provider call: record_check with no reading expires it.
          const outcome = await inTenantTransaction(db, ctx, async (trx) => {
            const { rows: result } = await sql<{ outcome: string }>`
              select app.hostname_record_check(${tenantId}::uuid, ${item.hostname},
                ${item.provider_hostname_id}, null, null, 'claim_ended') as outcome`.execute(trx);
            return result[0]?.outcome;
          });
          if (outcome === "expired") report.expired += 1;
          continue;
        }
        if (expiryOnly) continue;
        if (stop()) {
          report.complete = false;
          expiryOnly = true;
          continue;
        }
        calls += 1;
        const reading = await readHostname(options.provider, item, () => {
          calls += 1;
        });
        const hostnameState = reading.kind === "reading" ? reading.hostnameState : null;
        const certificateState = reading.kind === "reading" ? reading.certificateState : null;
        if (certificateState === "expiring") options.onExpiring?.(tenantId, item.hostname);
        if (reading.kind === "no_reading") {
          report.unread += 1;
          options.onUnread?.(tenantId, item.provider_hostname_id, reading.errorCode);
        }
        const outcome = await inTenantTransaction(db, ctx, async (trx) => {
          const { rows: result } = await sql<{ outcome: string }>`
            select app.hostname_record_check(${tenantId}::uuid, ${item.hostname},
              ${item.provider_hostname_id}, ${hostnameState}, ${certificateState},
              ${reading.errorCode}) as outcome`.execute(trx);
          return result[0]?.outcome;
        });
        report.checked += 1;
        if (outcome === "demoted") report.demoted += 1;
        if (outcome === "expired") report.expired += 1;
      }
    } catch (error) {
      if (error instanceof Throttled) {
        report.throttled = true;
        report.retryAfterSeconds = error.retryAfterSeconds;
        report.complete = false;
        expiryOnly = true;
        continue;
      }
      if (error instanceof HostnameSweepFault) {
        // A refusal about the account, the token, or the zone, not one
        // hostname: read the provider no more, record nothing for this
        // hostname, and let the next run try again.
        report.providerFault = error.code;
        report.providerFaultHostnameId = error.providerHostnameId;
        report.failedTenants += 1;
        report.complete = false;
        options.onTenantError?.(tenantId, error);
        expiryOnly = true;
        continue;
      }
      report.failedTenants += 1;
      report.complete = false;
      options.onTenantError?.(tenantId, error);
    }
  }
  return report;
}
