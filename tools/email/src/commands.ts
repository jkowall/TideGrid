/**
 * The email admin CLI (W3-G2.16-rest, migration 0023). It runs on the admin
 * connection, the only one that may add, verify, or retire an operator's
 * sending domain, or lift a suppression: the runtime role holds no EXECUTE on
 * those functions. Every command acts on one tenant, named by slug, inside
 * that tenant's transaction, and the database writes its audit rows with
 * actor `support:email-cli`.
 *
 * It never calls Cloudflare and never changes DNS. Onboarding a domain with
 * the provider, publishing its records, and allowing its address on the
 * Worker's send_email binding are the owner's steps; `domain-add` prints them
 * and `domain-verify` records the evidence the owner saw.
 *
 * No command prints an address from the suppression list: `suppressions`
 * prints counts only, and `suppression-lift` takes the address the operator
 * gave and answers whether it was suppressed.
 */
import { randomUUID } from "node:crypto";
import { type Database, inTenantTransaction, type TenantContext } from "@tidegrid/database";
import { slugPattern } from "@tidegrid/tenant-config";
import { type Kysely, sql } from "kysely";

export const usage = `Usage:
  email domain-status <tenant-slug>
  email domain-add <tenant-slug> <domain> [--mailbox <local-part>]
  email domain-verify <tenant-slug> <domain> <evidence...>
  email domain-retire <tenant-slug> <domain> <reason...>
  email suppressions <tenant-slug>
  email suppression-lift <tenant-slug> <address> <reason...>

Environment: DATABASE_URL (the admin connection).
Evidence and reasons go into the audit trail: never put a guest's address in
them. suppression-lift takes the address on the command line, so it is in the
shell's history; clear it afterwards if the address is a real guest's.`;

export type Command =
  | { kind: "domain-status" | "suppressions"; slug: string }
  | { kind: "domain-add"; slug: string; domain: string; mailbox: string }
  | { kind: "domain-verify"; slug: string; domain: string; evidence: string }
  | { kind: "domain-retire"; slug: string; domain: string; reason: string }
  | { kind: "suppression-lift"; slug: string; address: string; reason: string };

export class UsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UsageError";
  }
}

/** The database's own rule, checked first so a typo is a usage error. */
export const domainPattern =
  /^(?=.{4,253}$)[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)+$/;
export const mailboxPattern = /^[a-z0-9]([a-z0-9._-]{0,62}[a-z0-9])?$/;

/** Why a name cannot be an operator's sending domain, or null. */
export function senderDomainProblem(domain: string): string | null {
  if (!domainPattern.test(domain)) return "not a lowercase domain name";
  if (/(^|\.)tidegrid\./.test(domain)) return "names TideGrid";
  if (/(^|\.)xn--/.test(domain)) return "has an internationalized (xn--) label";
  return null;
}

/** Evidence and reasons are audited; an address in them would be personal data there. */
function auditText(text: string, what: string): string {
  if (text.includes("@")) throw new UsageError(`keep addresses out of the ${what}`);
  return text;
}

export function parseArgs(argv: readonly string[]): Command {
  const [kind, slug, target, ...rest] = argv;
  if (!kind) throw new UsageError("name a command");
  if (!slug || !slugPattern.test(slug)) throw new UsageError("name a tenant by its slug");
  if (kind === "domain-status" || kind === "suppressions") {
    if (target !== undefined) throw new UsageError(`${kind} takes only a tenant slug`);
    return { kind, slug };
  }
  if (
    kind !== "domain-add" &&
    kind !== "domain-verify" &&
    kind !== "domain-retire" &&
    kind !== "suppression-lift"
  ) {
    throw new UsageError(`unknown command ${kind}`);
  }
  if (!target || target.startsWith("--")) {
    throw new UsageError(kind === "suppression-lift" ? "name the address" : "name the domain");
  }
  if (kind === "suppression-lift") {
    const reason = rest.join(" ").trim();
    if (!reason) throw new UsageError("give a reason for lifting");
    return {
      kind,
      slug,
      address: target.trim().toLowerCase(),
      reason: auditText(reason, "reason"),
    };
  }
  const domain = target.toLowerCase();
  const problem = senderDomainProblem(domain);
  if (problem) throw new UsageError(`that name cannot be a sending domain: ${problem}`);
  if (kind === "domain-add") {
    let mailbox = "bookings";
    if (rest.length > 0) {
      if (rest[0] !== "--mailbox" || rest.length !== 2) {
        throw new UsageError("domain-add takes only --mailbox <local-part>");
      }
      mailbox = (rest[1] as string).toLowerCase();
      if (!mailboxPattern.test(mailbox) || mailbox.includes("..")) {
        throw new UsageError(
          "the mailbox is lowercase letters, digits, dots, hyphens, underscores",
        );
      }
    }
    return { kind, slug, domain, mailbox };
  }
  const text = rest.join(" ").trim();
  if (kind === "domain-verify") {
    if (!text) {
      throw new UsageError("give the evidence: what the provider showed for SPF, DKIM, and DMARC");
    }
    return { kind, slug, domain, evidence: auditText(text, "evidence") };
  }
  if (!text) throw new UsageError("give a reason for retiring");
  return { kind, slug, domain, reason: auditText(text, "reason") };
}

/** A database error: its type, SQLSTATE, and constraint, never a connection string. */
export function describeError(error: unknown): string {
  const e = error as { code?: unknown; constraint_name?: unknown } | null;
  const code = typeof e?.code === "string" ? ` ${e.code}` : "";
  const constraint = typeof e?.constraint_name === "string" ? ` (${e.constraint_name})` : "";
  return `${error instanceof Error ? error.name : "Error"}${code}${constraint}: ${error instanceof Error ? error.message : ""}`;
}

export interface CliActor {
  actorId: string;
  requestId: string;
}

export function cliActor(): CliActor {
  return { actorId: "email-cli", requestId: `email-cli-${randomUUID()}` };
}

function cliContext(tenantId: string, actor: CliActor): TenantContext {
  return { tenantId, actorType: "support", actorId: actor.actorId, requestId: actor.requestId };
}

async function tenantIdFor(db: Kysely<Database>, slug: string): Promise<string> {
  const { rows } = await sql<{ id: string }>`
    select id from public.tenants where slug = ${slug}`.execute(db);
  const id = rows[0]?.id;
  if (!id) throw new UsageError(`no tenant ${slug}`);
  return id;
}

const iso = (v: Date | null) => (v ? v.toISOString() : "");

/** The owner's steps between adding a domain and verifying it. */
export function onboardingSteps(domain: string, mailbox: string): string[] {
  const address = `${mailbox}@${domain}`;
  return [
    `${domain}: pending. Nothing sends from it until it is verified.`,
    "Owner steps (none of them run from here):",
    `  1. Onboard ${domain} in Cloudflare Email Sending, in the account the API Worker sends from.`,
    "  2. Have the operator publish the SPF, DKIM, and DMARC records Cloudflare lists, then wait for Cloudflare to show the domain verified.",
    `  3. Allow ${address} on the API Worker's send_email binding (allowed_sender_addresses), or remove that list, and release the API.`,
    `  4. Run: email domain-verify <tenant-slug> ${domain} <what Cloudflare showed for SPF, DKIM, and DMARC, and when>`,
  ];
}

/** Run one command. Returns the lines to print. */
export async function runCommand(
  db: Kysely<Database>,
  command: Command,
  actor: CliActor = cliActor(),
): Promise<string[]> {
  const tenantId = await tenantIdFor(db, command.slug);
  return inTenantTransaction(db, cliContext(tenantId, actor), async (trx) => {
    switch (command.kind) {
      case "domain-status": {
        const { rows } = await sql<{
          domain: string;
          local_part: string;
          status: string;
          verified_at: Date | null;
          retired_at: Date | null;
        }>`
          select domain, local_part, status, verified_at, retired_at
            from public.tenant_sender_domains
           where tenant_id = ${tenantId}
           order by created_at, id`.execute(trx);
        if (rows.length === 0)
          return [`${command.slug}: no sending domain; mail uses the shared sender`];
        return rows.map((r) =>
          [
            `${r.local_part}@${r.domain}`,
            r.status,
            r.verified_at ? `verified at ${iso(r.verified_at)}` : "",
            r.retired_at ? `retired at ${iso(r.retired_at)}` : "",
          ]
            .filter(Boolean)
            .join("  "),
        );
      }
      case "domain-add": {
        await sql`select app.sender_domain_add(${tenantId}::uuid, ${command.domain}, ${command.mailbox})`.execute(
          trx,
        );
        return onboardingSteps(command.domain, command.mailbox);
      }
      case "domain-verify": {
        const { rows } = await sql<{ changed: boolean }>`
          select app.sender_domain_verify(${tenantId}::uuid, ${command.domain}, ${command.evidence}) as changed`.execute(
          trx,
        );
        return [`${command.domain}: ${rows[0]?.changed ? "verified" : "already verified"}`];
      }
      case "domain-retire": {
        const { rows } = await sql<{ changed: boolean }>`
          select app.sender_domain_retire(${tenantId}::uuid, ${command.domain}, ${command.reason}) as changed`.execute(
          trx,
        );
        return [
          `${command.domain}: ${rows[0]?.changed ? "retired" : "no live domain of that name"}`,
        ];
      }
      case "suppressions": {
        const { rows } = await sql<{ reason: string; active: string; lifted: string }>`
          select reason,
                 count(*) filter (where lifted_at is null)::text as active,
                 count(*) filter (where lifted_at is not null)::text as lifted
            from public.email_suppressions
           where tenant_id = ${tenantId}
           group by reason order by reason`.execute(trx);
        if (rows.length === 0) return [`${command.slug}: no suppressed addresses`];
        return rows.map((r) => `${r.reason}: ${r.active} active, ${r.lifted} lifted`);
      }
      case "suppression-lift": {
        const { rows } = await sql<{ changed: boolean }>`
          select app.email_suppression_lift(${tenantId}::uuid, ${command.address}, ${command.reason}) as changed`.execute(
          trx,
        );
        return [rows[0]?.changed ? "lifted" : "that address is not suppressed for this tenant"];
      }
    }
  });
}
