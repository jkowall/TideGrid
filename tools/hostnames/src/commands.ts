/**
 * The admin CLI for custom hostnames (G2.14b). It runs on the admin
 * connection, the only one that may request, activate, or disable a hostname;
 * the runtime role holds no EXECUTE on those functions. Every command acts on
 * one tenant, named by slug, and writes its audit rows with actor
 * `support:hostname-cli`.
 *
 * The scripted fake keeps its records in memory, so a fake hostname cannot
 * outlive one process. `fake-lifecycle` therefore runs the whole lifecycle in
 * one go against a throwaway database: request, validation, activation, a
 * recorded check, and disable.
 */
import { randomUUID } from "node:crypto";
import { type Database, inTenantTransaction } from "@tidegrid/database";
import {
  type AdminActor,
  activateCustomHostname,
  type CustomHostnameProvider,
  createCloudflareHostnameProvider,
  createFakeHostnameProvider,
  disableHostname,
  isAccountLevelRefusal,
  requestCustomHostname,
  sweepHostnames,
} from "@tidegrid/domain-hostnames";
import { customHostnameProblem, slugPattern } from "@tidegrid/tenant-config";
import { type Kysely, sql } from "kysely";
import { requestLines } from "./format.ts";
import { cliContext, releaseInterruptedRequest } from "./release.ts";
import {
  applyRoutePlan,
  createWorkersRoutesClient,
  DEFAULT_ROUTE_SCRIPT,
  describeOutcome,
  describePlan,
  planRoute,
  type WorkersRoutesClient,
} from "./routes.ts";

export { requestLines } from "./format.ts";

export const usage = `Usage:
  hostnames status <tenant-slug>
  hostnames request <tenant-slug> <hostname>        (Cloudflare for SaaS)
  hostnames activate <tenant-slug> <hostname>       (Cloudflare for SaaS)
  hostnames disable <tenant-slug> <hostname> <reason...>
  hostnames route <tenant-slug> <hostname> [--remove] [--apply]
                                                    (proposed; a dry run without --apply)
  hostnames release <tenant-slug> <hostname> [--apply --provider-id <id>]
                                                    (proposed; recovers an interrupted request)
  hostnames fake-lifecycle <tenant-slug> <hostname> (throwaway database only)

Environment: DATABASE_URL (admin connection). Cloudflare commands also need
CF_SAAS_ZONE_ID, CF_SAAS_API_TOKEN, and optionally CF_SAAS_ROUTING_TARGET
(default customers.tidegrid.us). route --apply needs the admin token's Workers
Routes Write permission (never the API Worker's secret), and optionally
CF_SAAS_ROUTE_SCRIPT (default tidegrid-guest).
fake-lifecycle needs TIDEGRID_EPHEMERAL_DB=1.`;

export type Command =
  | { kind: "status"; slug: string }
  | { kind: "request" | "activate" | "fake-lifecycle"; slug: string; hostname: string }
  | { kind: "disable"; slug: string; hostname: string; reason: string }
  | { kind: "route"; slug: string; hostname: string; remove: boolean; apply: boolean }
  | { kind: "release"; slug: string; hostname: string; apply: boolean; providerId: string | null };

/** Flags after the hostname, in any order. Each may appear once. */
function parseFlags(
  kind: string,
  rest: readonly string[],
  allowed: { boolean: readonly string[]; value: readonly string[] },
): Map<string, string | true> {
  const flags = new Map<string, string | true>();
  for (let i = 0; i < rest.length; i += 1) {
    const arg = rest[i] as string;
    if (flags.has(arg)) throw new UsageError(`${arg} given twice`);
    if (allowed.boolean.includes(arg)) {
      flags.set(arg, true);
    } else if (allowed.value.includes(arg)) {
      const value = rest[i + 1];
      if (value === undefined || value.startsWith("--")) {
        throw new UsageError(`${arg} needs a value`);
      }
      flags.set(arg, value);
      i += 1;
    } else {
      throw new UsageError(`${kind} does not take ${arg}`);
    }
  }
  return flags;
}

export class UsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UsageError";
  }
}

export function parseArgs(argv: readonly string[]): Command {
  const [kind, slug, hostname, ...rest] = argv;
  if (!kind) throw new UsageError("name a command");
  if (!slug || !slugPattern.test(slug)) throw new UsageError("name a tenant by its slug");
  if (kind === "status") {
    if (hostname !== undefined) throw new UsageError("status takes only a tenant slug");
    return { kind, slug };
  }
  if (
    kind !== "request" &&
    kind !== "activate" &&
    kind !== "disable" &&
    kind !== "route" &&
    kind !== "release" &&
    kind !== "fake-lifecycle"
  ) {
    throw new UsageError(`unknown command ${kind}`);
  }
  if (!hostname || hostname.startsWith("--")) throw new UsageError("name the hostname");
  if (kind === "disable") {
    const reason = rest.join(" ").trim();
    if (!reason) throw new UsageError("give a reason for disabling");
    return { kind, slug, hostname, reason };
  }
  if (kind === "route") {
    const flags = parseFlags(kind, rest, { boolean: ["--remove", "--apply"], value: [] });
    return { kind, slug, hostname, remove: flags.has("--remove"), apply: flags.has("--apply") };
  }
  if (kind === "release") {
    const flags = parseFlags(kind, rest, { boolean: ["--apply"], value: ["--provider-id"] });
    const providerId = flags.get("--provider-id");
    const apply = flags.has("--apply");
    if (providerId !== undefined && !apply) {
      throw new UsageError("--provider-id goes with --apply");
    }
    return {
      kind,
      slug,
      hostname,
      apply,
      providerId: typeof providerId === "string" ? providerId : null,
    };
  }
  if (rest.length > 0) throw new UsageError(`${kind} takes a tenant slug and a hostname`);
  return { kind, slug, hostname };
}

export interface CliEnv {
  CF_SAAS_ZONE_ID?: string | undefined;
  CF_SAAS_API_TOKEN?: string | undefined;
  CF_SAAS_ROUTING_TARGET?: string | undefined;
  CF_SAAS_ROUTE_SCRIPT?: string | undefined;
  TIDEGRID_EPHEMERAL_DB?: string | undefined;
}

/** Injected in tests; otherwise built from the environment, and only when a command calls out. */
export interface CliDeps {
  provider?: CustomHostnameProvider;
  routes?: WorkersRoutesClient;
}

export function workersRoutesClient(env: CliEnv): WorkersRoutesClient {
  if (!env.CF_SAAS_ZONE_ID || !env.CF_SAAS_API_TOKEN) {
    throw new UsageError("set CF_SAAS_ZONE_ID and CF_SAAS_API_TOKEN for route --apply");
  }
  return createWorkersRoutesClient({
    zoneId: env.CF_SAAS_ZONE_ID,
    apiToken: env.CF_SAAS_API_TOKEN,
  });
}

/**
 * One line for an error the CLI did not expect: its type and code, never a
 * token. An account-level refusal (W1-SAAS-PREP; the codes are unverified
 * until the first real request at P10) names the token and the zone.
 */
export function describeError(error: unknown): string {
  const code = (error as { code?: unknown } | null)?.code;
  const line = `${error instanceof Error ? error.name : "Error"}${typeof code === "string" ? ` ${code}` : ""}: ${error instanceof Error ? error.message : ""}`;
  if (isAccountLevelRefusal(error, { lookup: true })) {
    return `${line}\nThe provider refused the account, not this hostname: check that CF_SAAS_API_TOKEN is scoped to the SaaS zone with the permissions the hostnames package README lists, and that CF_SAAS_ZONE_ID names that zone.`;
  }
  return line;
}

export function cloudflareProvider(env: CliEnv): CustomHostnameProvider {
  if (!env.CF_SAAS_ZONE_ID || !env.CF_SAAS_API_TOKEN) {
    throw new UsageError("set CF_SAAS_ZONE_ID and CF_SAAS_API_TOKEN for Cloudflare for SaaS");
  }
  return createCloudflareHostnameProvider({
    zoneId: env.CF_SAAS_ZONE_ID,
    apiToken: env.CF_SAAS_API_TOKEN,
    routingTarget: env.CF_SAAS_ROUTING_TARGET || "customers.tidegrid.us",
  });
}

function cliActor(): AdminActor {
  return { actorId: "hostname-cli", requestId: `cli-${randomUUID()}` };
}

async function tenantIdFor(db: Kysely<Database>, slug: string): Promise<string> {
  const { rows } = await sql<{ id: string }>`
    select id from public.tenants where slug = ${slug}`.execute(db);
  const id = rows[0]?.id;
  if (!id) throw new UsageError(`no tenant ${slug}`);
  return id;
}

async function status(
  db: Kysely<Database>,
  tenantId: string,
  actor: AdminActor,
): Promise<string[]> {
  const rows = await inTenantTransaction(db, cliContext(tenantId, actor), async (trx) => {
    const result = await sql<{
      hostname: string;
      kind: string;
      status: string;
      hostname_state: string | null;
      certificate_state: string | null;
      last_error_code: string | null;
    }>`
    select h.hostname, h.kind, h.status, p.hostname_state, p.certificate_state, p.last_error_code
      from public.tenant_hostnames h
      left join public.tenant_hostname_provisioning p
        on p.hostname = h.hostname and p.tenant_id = h.tenant_id
     where h.tenant_id = ${tenantId}
     order by h.kind, h.hostname`.execute(trx);
    return result.rows;
  });
  return rows.map((r) =>
    [
      r.hostname,
      r.kind,
      r.status,
      r.hostname_state ? `hostname ${r.hostname_state}` : "",
      r.certificate_state ? `certificate ${r.certificate_state}` : "",
      r.last_error_code ? `error ${r.last_error_code}` : "",
    ]
      .filter(Boolean)
      .join("  "),
  );
}

/**
 * This tenant's own row for a hostname, or null. The read runs inside a
 * tenant transaction, as the tenant contract requires, so it does not depend
 * on the admin role bypassing row-level security.
 */
export async function customHostnameRow(
  db: Kysely<Database>,
  tenantId: string,
  hostname: string,
  actor: AdminActor = cliActor(),
) {
  return inTenantTransaction(db, cliContext(tenantId, actor), async (trx) => {
    const { rows } = await sql<{ kind: string; status: string }>`
      select kind, status from public.tenant_hostnames
       where tenant_id = ${tenantId} and hostname = ${hostname}`.execute(trx);
    return rows[0] ?? null;
  });
}

/**
 * The per-hostname route (proposed, W1-SAAS-PREP). Adding needs an active
 * custom hostname of this tenant; removing needs a custom hostname of this
 * tenant in any status, so a disabled name's route can go. A dry run makes no
 * call and needs no token (D3).
 */
async function route(
  db: Kysely<Database>,
  tenantId: string,
  command: Extract<Command, { kind: "route" }>,
  env: CliEnv,
  routes: WorkersRoutesClient | undefined,
  actor: AdminActor,
): Promise<string[]> {
  const problem = customHostnameProblem(command.hostname);
  if (problem) throw new UsageError(`that name cannot be a custom hostname: ${problem}`);
  const row = await customHostnameRow(db, tenantId, command.hostname, actor);
  if (row?.kind !== "custom") {
    return [`${command.hostname}: refused: not a custom hostname of ${command.slug}`];
  }
  if (!command.remove && row.status !== "active") {
    return [`${command.hostname}: refused: ${row.status}, and only an active hostname is routed`];
  }
  const plan = planRoute(
    command.remove ? "remove" : "add",
    command.hostname,
    env.CF_SAAS_ROUTE_SCRIPT || DEFAULT_ROUTE_SCRIPT,
  );
  if (!command.apply) return describePlan(plan);
  return describeOutcome(plan, await applyRoutePlan(routes ?? workersRoutesClient(env), plan));
}

/** Run one command. Returns the lines to print. */
export async function runCommand(
  db: Kysely<Database>,
  command: Command,
  env: CliEnv,
  deps: CliDeps = {},
): Promise<string[]> {
  const tenantId = await tenantIdFor(db, command.slug);
  const actor = cliActor();
  const provider = deps.provider;
  switch (command.kind) {
    case "status":
      return status(db, tenantId, actor);
    case "request": {
      const outcome = await requestCustomHostname(db, provider ?? cloudflareProvider(env), {
        tenantId,
        hostname: command.hostname,
        actor,
      });
      return requestLines(command.hostname, outcome);
    }
    case "route":
      return route(db, tenantId, command, env, deps.routes, actor);
    case "release":
      return releaseInterruptedRequest(db, provider ?? cloudflareProvider(env), {
        tenantId,
        slug: command.slug,
        hostname: command.hostname,
        apply: command.apply,
        providerId: command.providerId,
        actor,
      });
    case "activate": {
      const outcome = await activateCustomHostname(db, provider ?? cloudflareProvider(env), {
        tenantId,
        hostname: command.hostname,
        actor,
      });
      if (outcome.kind === "activated") return [`${command.hostname}: active`];
      const r = outcome.reading;
      return [
        `${command.hostname}: not ready${r ? ` (hostname ${r.hostnameState}, certificate ${r.certificateState})` : ""}`,
      ];
    }
    case "disable": {
      const changed = await disableHostname(db, {
        tenantId,
        hostname: command.hostname,
        reason: command.reason,
        actor,
      });
      return [`${command.hostname}: ${changed ? "disabled" : "already disabled"}`];
    }
    case "fake-lifecycle":
      return fakeLifecycle(db, tenantId, command.hostname, env, actor);
  }
}

async function resolvedTenant(db: Kysely<Database>, hostname: string): Promise<string | null> {
  const { rows } = await sql<{ tenant_id: string }>`
    select tenant_id from app.resolve_hostname(${hostname})`.execute(db);
  return rows[0]?.tenant_id ?? null;
}

async function fakeLifecycle(
  db: Kysely<Database>,
  tenantId: string,
  hostname: string,
  env: CliEnv,
  actor: { actorId: string; requestId: string },
): Promise<string[]> {
  if (env.TIDEGRID_EPHEMERAL_DB !== "1") {
    throw new UsageError(
      "fake-lifecycle runs only against a throwaway database (TIDEGRID_EPHEMERAL_DB=1)",
    );
  }
  // A prefix of its own: provider ids are unique across the database, and
  // earlier fake runs may have used the default sequence.
  const fake = createFakeHostnameProvider({ idPrefix: `fake-cli-${randomUUID().slice(0, 8)}` });
  const lines: string[] = [];
  const requested = await requestCustomHostname(db, fake, { tenantId, hostname, actor });
  lines.push(`request: ${requested.kind}`);
  if (requested.kind !== "requested") return lines;
  lines.push(`resolves before validation: ${(await resolvedTenant(db, hostname)) === tenantId}`);
  const early = await activateCustomHostname(db, fake, { tenantId, hostname, actor });
  lines.push(`activate before validation: ${early.kind}`);
  fake.advance(hostname, { hostnameState: "active", certificateState: "active" });
  const activated = await activateCustomHostname(db, fake, { tenantId, hostname, actor });
  lines.push(`activate after validation: ${activated.kind}`);
  lines.push(`resolves when active: ${(await resolvedTenant(db, hostname)) === tenantId}`);
  fake.advance(hostname, { hostnameState: "moved" });
  await inTenantTransaction(db, cliContext(tenantId, actor), async (trx) => {
    await sql`update public.tenant_hostname_provisioning set next_check_at = now()
               where tenant_id = ${tenantId} and hostname = ${hostname}`.execute(trx);
  });
  const report = await sweepHostnames(db, {
    provider: fake,
    runId: actor.requestId,
    onlyTenants: [tenantId],
  });
  lines.push(`sweep after the CNAME moved: ${report.demoted} demoted`);
  lines.push(`resolves after demotion: ${(await resolvedTenant(db, hostname)) === tenantId}`);
  const again = await disableHostname(db, {
    tenantId,
    hostname,
    reason: "Fake lifecycle run",
    actor,
  });
  lines.push(`disable: ${again ? "disabled" : "already disabled"}`);
  return lines;
}
