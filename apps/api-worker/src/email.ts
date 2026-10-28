import { createDb, type Database } from "@tidegrid/database";
import {
  createCloudflareEmailProvider,
  DEFAULT_GUEST_LINK_ORIGIN,
  type DeliveryOptions,
  deliverTenantMessages,
  type EmailProvider,
  type EmailProviderLog,
  FakeEmailProvider,
  isEmailAddress,
  normalizeRecipient,
  type RecipientPolicy,
  type SendEmailBinding,
} from "@tidegrid/domain-messaging";
import { createLogger, type Logger } from "@tidegrid/observability";
import type { Context } from "hono";
import type { Kysely } from "kysely";
import type { AppDeps, AppEnv } from "./context.ts";
import { getDb } from "./db.ts";
import { type Bindings, databaseUrl } from "./env.ts";

/**
 * Transactional email for this deployment. Off unless EMAIL_PROVIDER names
 * a provider, and then fail closed on every configuration error, the way
 * custom hostnames are (src/hostnames.ts):
 *
 * - "fake" (lane 1, the G2.16 demo shim, the owner's decision of 2026-10-05,
 *   "You can just shim stripe or others"): only in local development and
 *   never beside an EMAIL binding. The fake stores full bodies, raw link
 *   tokens included, in its own table, so a deployed Worker must never run
 *   it (coordinator default D6 A, 2026-10-28).
 * - "cloudflare" (G2.16a): the Cloudflare Email Service adapter over the
 *   `send_email` binding EMAIL. Without the binding it is off. Outside
 *   production it sends only to the EMAIL_ALLOWED_RECIPIENTS secret's
 *   addresses, and an empty list keeps it off (D3 B). No deployed
 *   configuration in the repository turns it on; the live step does.
 *
 * With no provider, messages stay queued and nothing is sent.
 */
export type EmailSettings =
  | { kind: "fake"; fromAddress: string; guestLinkOrigin: string }
  | {
      kind: "cloudflare";
      fromAddress: string;
      guestLinkOrigin: string;
      recipients: RecipientPolicy;
    }
  | { kind: "off"; reason: "unset" | "binding_missing" | "allowlist_missing" }
  | {
      kind: "refused";
      reason:
        | "fake_outside_local"
        | "fake_with_binding"
        | "allowlist_invalid"
        | "from_address_invalid"
        | "unknown_provider";
    };

/** A TideGrid-controlled sender, as the demo build plan says; the display name is the brand's. */
export const DEFAULT_FROM_ADDRESS = "bookings@tidegrid.us";
/** One Cloudflare send's bound: well inside the 120 s lease and the waitUntil budget. */
export const CLOUDFLARE_SEND_TIMEOUT_MS = 10_000;
/**
 * How long after-commit delivery may run. `waitUntil` allows 30 s after the
 * response; stopping new claims well before leaves the rest to the cron.
 */
export const AFTER_COMMIT_BUDGET_MS = 18_000;

/**
 * The recipient allowlist, parsed: entries trimmed, empties dropped, and
 * lowercased. Judged on the parsed set, never the raw string, so "", " ",
 * "," and " , " are all empty. Null when an entry is not one address.
 */
export function parseAllowedRecipients(value: string | undefined): Set<string> | null {
  const out = new Set<string>();
  // The same split as env.ts `list()`: trimmed, empties dropped.
  const entries = (value ?? "")
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
  for (const entry of entries) {
    const address = normalizeRecipient(entry);
    if (!isEmailAddress(address)) return null;
    out.add(address);
  }
  return out;
}

/**
 * Whether the sender is one address. EMAIL_FROM_ADDRESS is checked here, with
 * the adapter's own rule, so a typo turns email off as a configuration fault
 * instead of failing every message as invalid_message.
 */
function senderIsValid(env: Bindings): boolean {
  return isEmailAddress(env.EMAIL_FROM_ADDRESS || DEFAULT_FROM_ADDRESS);
}

function origins(env: Bindings) {
  return {
    fromAddress: env.EMAIL_FROM_ADDRESS || DEFAULT_FROM_ADDRESS,
    guestLinkOrigin: env.GUEST_LINK_ORIGIN || DEFAULT_GUEST_LINK_ORIGIN,
  };
}

export function emailSettings(env: Bindings): EmailSettings {
  const name = env.EMAIL_PROVIDER;
  if (!name) return { kind: "off", reason: "unset" };
  if (name === "fake") {
    if (env.EMAIL) return { kind: "refused", reason: "fake_with_binding" };
    if (env.ENVIRONMENT !== "local") return { kind: "refused", reason: "fake_outside_local" };
    if (!senderIsValid(env)) return { kind: "refused", reason: "from_address_invalid" };
    return { kind: "fake", ...origins(env) };
  }
  if (name === "cloudflare") {
    if (!env.EMAIL) return { kind: "off", reason: "binding_missing" };
    const allowed = parseAllowedRecipients(env.EMAIL_ALLOWED_RECIPIENTS);
    if (!allowed) return { kind: "refused", reason: "allowlist_invalid" };
    if (allowed.size === 0 && env.ENVIRONMENT !== "production") {
      return { kind: "off", reason: "allowlist_missing" };
    }
    if (!senderIsValid(env)) return { kind: "refused", reason: "from_address_invalid" };
    return {
      kind: "cloudflare",
      ...origins(env),
      recipients: allowed.size > 0 ? { kind: "only", addresses: allowed } : { kind: "any" },
    };
  }
  return { kind: "refused", reason: "unknown_provider" };
}

type DbSource = Kysely<Database> | (() => Kysely<Database>);

/** The adapter's log lines, at warn: codes, ids, and hashes only. */
function providerLog(logger: Logger): EmailProviderLog {
  return (event, attributes) => logger.warn(event, attributes);
}

/**
 * The configured provider, or null when email is off or refused. Neither
 * `off` nor `refused` ever builds one.
 */
export function emailProvider(env: Bindings, db: DbSource, log?: Logger): EmailProvider | null {
  const settings = emailSettings(env);
  switch (settings.kind) {
    case "fake":
      return new FakeEmailProvider({ db, environment: env.ENVIRONMENT });
    case "cloudflare": {
      // The generated `SendEmail` type must fit the adapter's structural
      // binding type; `wrangler types` regenerates it on every typecheck.
      const binding: SendEmailBinding | undefined = env.EMAIL;
      return createCloudflareEmailProvider({
        binding,
        recipients: settings.recipients,
        environment: env.ENVIRONMENT,
        timeoutMs: CLOUDFLARE_SEND_TIMEOUT_MS,
        log: providerLog(log ?? createLogger({ "event.name": "email_provider" })),
      });
    }
    default:
      return null;
  }
}

/** The fake provider with its mailbox, or null unless the fake is configured. */
export function fakeEmailProvider(env: Bindings, db: DbSource): FakeEmailProvider | null {
  const settings = emailSettings(env);
  if (settings.kind !== "fake") return null;
  return new FakeEmailProvider({ db, environment: env.ENVIRONMENT });
}

/** The fake provider's mailbox for this request, or null. */
export function fakeEmailProviderFor(c: Context<AppEnv>): FakeEmailProvider | null {
  return fakeEmailProvider(c.env, () => getDb(c));
}

/**
 * Where a sent link points and who sends, for a test's override or the
 * configured provider. The environment goes along so the link origin passes
 * the strict origin parser under this deployment's rules (G2.14b).
 */
export function deliverySettings(env: Bindings): {
  fromAddress: string;
  guestLinkOrigin: string;
  environment: Bindings["ENVIRONMENT"];
} {
  const settings = emailSettings(env);
  const chosen =
    settings.kind === "fake" || settings.kind === "cloudflare"
      ? { fromAddress: settings.fromAddress, guestLinkOrigin: settings.guestLinkOrigin }
      : origins(env);
  return { ...chosen, environment: env.ENVIRONMENT };
}

function errorType(error: unknown): string {
  return error instanceof Error ? error.name : "unknown";
}

/** A send's unexpected failure, for the log: its type and any SQLSTATE, never its message. */
export function sendErrorAttributes(error: unknown): Record<string, string> {
  const code = (error as { code?: unknown } | null)?.code;
  return {
    "event.name": "email_send_error",
    "error.type": errorType(error),
    ...(typeof code === "string" ? { "db.response.status_code": code } : {}),
  };
}

/** Whether a committed request starts background delivery under this configuration. */
export function deliversAfterCommit(env: Bindings, deps: AppDeps): boolean {
  if (deps.deliverEmailAfterCommit === false) return false;
  if (deps.emailProvider) return true;
  const kind = emailSettings(env).kind;
  return kind === "fake" || kind === "cloudflare";
}

/**
 * The run after-commit delivery makes: at most 10 messages, and none
 * claimed once a send could outlast the `waitUntil` budget (G2.16a).
 */
export function afterCommitDeliveryOptions(
  env: Bindings,
  provider: EmailProvider,
  runId: string,
  startedAt: number,
  onSendError: DeliveryOptions["onSendError"],
): DeliveryOptions {
  return {
    provider,
    ...deliverySettings(env),
    runId,
    limit: 10,
    deadline: startedAt + AFTER_COMMIT_BUDGET_MS,
    ...(onSendError ? { onSendError } : {}),
  };
}

/**
 * After a request commits mail, send that tenant's due messages in the
 * background, on a connection of their own, so the guest sees the email at
 * once. Best effort: the cron's sweep sends whatever this misses, and the
 * outcome is recorded on each message either way.
 */
export function deliverAfterCommit(c: Context<AppEnv>, deps: AppDeps, tenantId: string): void {
  if (!deliversAfterCommit(c.env, deps)) return;
  const url = databaseUrl(c.env);
  if (!url) return;
  const log = c.get("log");
  const runId = c.get("requestId");
  const env = c.env;
  const startedAt = Date.now();
  c.executionCtx.waitUntil(
    (async () => {
      const handle = createDb(url, { max: 1 });
      try {
        const provider = deps.emailProvider
          ? deps.emailProvider(handle.db, env)
          : emailProvider(env, handle.db, log);
        if (!provider) return;
        const report = await deliverTenantMessages(
          handle.db,
          tenantId,
          afterCommitDeliveryOptions(env, provider, runId, startedAt, (_messageId, error) =>
            log.error("email_send_error", sendErrorAttributes(error)),
          ),
        );
        log.info("email_delivery", {
          "event.name": "email_delivery",
          "tidegrid.tenant_id": tenantId,
          "tidegrid.email.sent_count": report.sent,
          "tidegrid.email.retried_count": report.retried,
          "tidegrid.email.failed_count": report.failed,
          "tidegrid.email.canceled_count": report.canceled,
          ...(report.stopped ? { "tidegrid.email.stopped": report.stopped } : {}),
        });
      } catch (error) {
        log.error("email_delivery_failed", {
          "event.name": "email_delivery_failed",
          "tidegrid.tenant_id": tenantId,
          "error.type": errorType(error),
        });
      } finally {
        await handle.end().catch(() => undefined);
      }
    })(),
  );
}
