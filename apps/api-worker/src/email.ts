import { createDb, type Database } from "@tidegrid/database";
import {
  DEFAULT_GUEST_LINK_ORIGIN,
  deliverTenantMessages,
  type EmailProvider,
  FakeEmailProvider,
} from "@tidegrid/domain-messaging";
import type { Context } from "hono";
import type { Kysely } from "kysely";
import type { AppDeps, AppEnv } from "./context.ts";
import { getDb } from "./db.ts";
import { type Bindings, databaseUrl } from "./env.ts";

/**
 * Transactional email for this deployment (lane 1, the G2.16 demo shim). The
 * demo sends through the fake provider, the owner's decision of 2026-10-05
 * ("You can just shim stripe or others"); a Cloudflare Email Service adapter
 * replaces it behind the same interface before any live booking. The fake is
 * refused outright in a production configuration. With no provider, messages
 * stay queued and nothing is sent.
 */
export type EmailSettings =
  | { kind: "fake"; fromAddress: string; guestLinkOrigin: string }
  | { kind: "off"; reason: "unset" | "not_built" }
  | { kind: "refused"; reason: "fake_in_production" | "unknown_provider" };

/** A TideGrid-controlled sender, as the demo build plan says; the display name is the brand's. */
export const DEFAULT_FROM_ADDRESS = "bookings@tidegrid.us";

export function emailSettings(env: Bindings): EmailSettings {
  const name = env.EMAIL_PROVIDER;
  if (!name) return { kind: "off", reason: "unset" };
  if (name === "fake") {
    if (env.ENVIRONMENT === "production") return { kind: "refused", reason: "fake_in_production" };
    return {
      kind: "fake",
      fromAddress: env.EMAIL_FROM_ADDRESS || DEFAULT_FROM_ADDRESS,
      guestLinkOrigin: env.GUEST_LINK_ORIGIN || DEFAULT_GUEST_LINK_ORIGIN,
    };
  }
  if (name === "cloudflare") return { kind: "off", reason: "not_built" };
  return { kind: "refused", reason: "unknown_provider" };
}

type DbSource = Kysely<Database> | (() => Kysely<Database>);

/** The configured provider, or null when email is off. */
export function emailProvider(env: Bindings, db: DbSource): EmailProvider | null {
  return fakeEmailProvider(env, db);
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

/** Where a sent link points and who sends, for a test's override or the configured fake. */
export function deliverySettings(env: Bindings): { fromAddress: string; guestLinkOrigin: string } {
  const settings = emailSettings(env);
  return settings.kind === "fake"
    ? { fromAddress: settings.fromAddress, guestLinkOrigin: settings.guestLinkOrigin }
    : {
        fromAddress: env.EMAIL_FROM_ADDRESS || DEFAULT_FROM_ADDRESS,
        guestLinkOrigin: env.GUEST_LINK_ORIGIN || DEFAULT_GUEST_LINK_ORIGIN,
      };
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

/**
 * After a request commits mail, send that tenant's due messages in the
 * background, on a connection of their own, so the guest sees the email at
 * once. Best effort: the cron's sweep sends whatever this misses, and the
 * outcome is recorded on each message either way.
 */
export function deliverAfterCommit(c: Context<AppEnv>, deps: AppDeps, tenantId: string): void {
  if (deps.deliverEmailAfterCommit === false) return;
  const url = databaseUrl(c.env);
  if (!url) return;
  if (!deps.emailProvider && emailSettings(c.env).kind !== "fake") return;
  const log = c.get("log");
  const runId = c.get("requestId");
  const env = c.env;
  c.executionCtx.waitUntil(
    (async () => {
      const handle = createDb(url, { max: 1 });
      try {
        const provider = deps.emailProvider
          ? deps.emailProvider(handle.db, env)
          : emailProvider(env, handle.db);
        if (!provider) return;
        const report = await deliverTenantMessages(handle.db, tenantId, {
          provider,
          ...deliverySettings(env),
          runId,
          limit: 10,
          onSendError: (_messageId, error) =>
            log.error("email_send_error", sendErrorAttributes(error)),
        });
        log.info("email_delivery", {
          "event.name": "email_delivery",
          "tidegrid.tenant_id": tenantId,
          "tidegrid.email.sent_count": report.sent,
          "tidegrid.email.retried_count": report.retried,
          "tidegrid.email.failed_count": report.failed,
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
