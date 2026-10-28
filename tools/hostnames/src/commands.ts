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
import type { Database } from "@tidegrid/database";
import {
  activateCustomHostname,
  type CustomHostnameProvider,
  createCloudflareHostnameProvider,
  createFakeHostnameProvider,
  disableHostname,
  requestCustomHostname,
  sweepHostnames,
} from "@tidegrid/domain-hostnames";
import { slugPattern } from "@tidegrid/tenant-config";
import { type Kysely, sql } from "kysely";

export const usage = `Usage:
  hostnames status <tenant-slug>
  hostnames request <tenant-slug> <hostname>        (Cloudflare for SaaS)
  hostnames activate <tenant-slug> <hostname>       (Cloudflare for SaaS)
  hostnames disable <tenant-slug> <hostname> <reason...>
  hostnames fake-lifecycle <tenant-slug> <hostname> (throwaway database only)

Environment: DATABASE_URL (admin connection). Cloudflare commands also need
CF_SAAS_ZONE_ID, CF_SAAS_API_TOKEN, and optionally CF_SAAS_ROUTING_TARGET
(default customers.tidegrid.us). fake-lifecycle needs TIDEGRID_EPHEMERAL_DB=1.`;

export type Command =
  | { kind: "status"; slug: string }
  | { kind: "request" | "activate" | "fake-lifecycle"; slug: string; hostname: string }
  | { kind: "disable"; slug: string; hostname: string; reason: string };

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
    kind !== "fake-lifecycle"
  ) {
    throw new UsageError(`unknown command ${kind}`);
  }
  if (!hostname) throw new UsageError("name the hostname");
  if (kind === "disable") {
    const reason = rest.join(" ").trim();
    if (!reason) throw new UsageError("give a reason for disabling");
    return { kind, slug, hostname, reason };
  }
  if (rest.length > 0) throw new UsageError(`${kind} takes a tenant slug and a hostname`);
  return { kind, slug, hostname };
}

export interface CliEnv {
  CF_SAAS_ZONE_ID?: string | undefined;
  CF_SAAS_API_TOKEN?: string | undefined;
  CF_SAAS_ROUTING_TARGET?: string | undefined;
  TIDEGRID_EPHEMERAL_DB?: string | undefined;
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

async function tenantIdFor(db: Kysely<Database>, slug: string): Promise<string> {
  const { rows } = await sql<{ id: string }>`
    select id from public.tenants where slug = ${slug}`.execute(db);
  const id = rows[0]?.id;
  if (!id) throw new UsageError(`no tenant ${slug}`);
  return id;
}

async function status(db: Kysely<Database>, tenantId: string): Promise<string[]> {
  const { rows } = await sql<{
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
     order by h.kind, h.hostname`.execute(db);
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

/** Run one command. Returns the lines to print. */
export async function runCommand(
  db: Kysely<Database>,
  command: Command,
  env: CliEnv,
  provider?: CustomHostnameProvider,
): Promise<string[]> {
  const tenantId = await tenantIdFor(db, command.slug);
  const actor = { actorId: "hostname-cli", requestId: `cli-${randomUUID()}` };
  switch (command.kind) {
    case "status":
      return status(db, tenantId);
    case "request": {
      const outcome = await requestCustomHostname(db, provider ?? cloudflareProvider(env), {
        tenantId,
        hostname: command.hostname,
        actor,
      });
      if (outcome.kind !== "requested") return [`${command.hostname}: ${outcome.kind}`];
      return [
        `${command.hostname}: requested${outcome.adopted ? " (adopted after a lost answer)" : ""}`,
        "Publish these records:",
        ...outcome.reading.instructions.map((i) =>
          i.kind === "cname"
            ? `  CNAME ${i.name} -> ${i.target}`
            : i.kind === "txt"
              ? `  TXT ${i.name} "${i.value}" (${i.purpose})`
              : `  HTTP ${i.url} (${i.purpose})`,
        ),
      ];
    }
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
  await sql`update public.tenant_hostname_provisioning set next_check_at = now()
             where tenant_id = ${tenantId} and hostname = ${hostname}`.execute(db);
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
