/**
 * Delivery (G2.16 demo shim): send due messages after commit and record each
 * outcome. Runs from the API Worker's cron after the checkout sweep, and in
 * the background right after a request commits a message, so a guest sees
 * the email at once. Correctness never waits for it.
 *
 * One message at a time, in three steps:
 *
 * 1. Claim, in a short transaction: take a due message (queued and due, or
 *    sending with a lapsed lease, an attempt that crashed) with FOR UPDATE
 *    SKIP LOCKED, so concurrent runs never claim one message together; mark it
 *    sending under a lease, one more attempt; and, when it carries an access
 *    link, issue the link (only the token's hash is stored). Commit.
 * 2. Send, outside any transaction, with the message id as the provider's
 *    idempotency key and the link's URL written into the bodies.
 * 3. Record the outcome, in a second short transaction, only if the attempt
 *    is still the message's latest: sent; queued again after a temporary
 *    failure, with a backoff; or failed.
 *
 * A crash after the provider accepted and before step 3 leaves the message
 * sending; once its lease lapses a later run claims it again and sends with
 * the same key, and the provider answers with the first email. That attempt
 * issues a new token that the provider never sends, which simply expires.
 */
import {
  type Database,
  inTenantTransaction,
  type TenantContext,
  type TenantTransaction,
} from "@tidegrid/database";
import { type Kysely, sql } from "kysely";
import { issueAccessLink } from "./access.ts";
import {
  type EmailProvider,
  EmailProviderRejectedError,
  EmailProviderUnavailableError,
} from "./adapter.ts";
import { fillLinkSlot } from "./render.ts";

/** Attempts before a temporarily failing message fails for good. */
export const MAX_DELIVERY_ATTEMPTS = 6;
/** Seconds before attempt n + 1, after attempt n failed temporarily. */
export const RETRY_BACKOFF_SECONDS = [60, 300, 900, 3600, 14_400] as const;
export const DEFAULT_LEASE_SECONDS = 120;
/** The default guest-site origin for a tenant: its preview hostname. */
export const DEFAULT_GUEST_LINK_ORIGIN = "https://{slug}.book.tidegrid.us";

export interface DeliveryOptions {
  provider: EmailProvider;
  /** The sender address; the display name is the operator's brand name. */
  fromAddress: string;
  /**
   * The guest site's origin, with `{slug}` for the tenant's slug, such as
   * "https://{slug}.book.tidegrid.us" or locally "http://{slug}.book.localhost:5301".
   * Its hostname must be an active, verified hostname of the tenant.
   */
  guestLinkOrigin?: string;
  /** Correlates the run's writes, like a request id. */
  runId: string;
  /** Messages per tenant per run. */
  limit?: number;
  leaseSeconds?: number;
}

export type DeliveryOutcome =
  | "sent"
  /** A temporary failure; queued again with a backoff. */
  | "retry"
  /** Refused, out of attempts, or its link has no mapped host. */
  | "failed"
  /** Another run claimed it after this attempt's lease lapsed; that run records it. */
  | "superseded";

export interface DeliveryItem {
  messageId: string;
  attempt: number;
  outcome: DeliveryOutcome;
  code: string | null;
}

export interface TenantDeliveryReport {
  claimed: number;
  sent: number;
  retried: number;
  failed: number;
  superseded: number;
  items: DeliveryItem[];
}

interface ClaimedRow {
  id: string;
  attempts: number;
  booking_id: string | null;
  participant_id: string | null;
  subject_ref: string | null;
  to_email: string;
  to_name: string | null;
  from_name: string;
  reply_to: string | null;
  subject: string;
  html_body: string;
  text_body: string;
  link_purpose: "booking_manage" | "waiver_sign" | null;
  link_path: string | null;
  link_ttl_seconds: number | null;
  link_slot: string | null;
}

type Claimed =
  | { kind: "none" }
  | { kind: "ready"; row: ClaimedRow; url: string | null }
  | { kind: "failed"; messageId: string; attempt: number; code: string };

function backoffFor(attempt: number): number {
  return RETRY_BACKOFF_SECONDS[Math.min(attempt, RETRY_BACKOFF_SECONDS.length) - 1] ?? 14_400;
}

/**
 * The guest site's origin for a tenant, if its hostname is an active,
 * verified hostname of that tenant; null otherwise.
 */
export async function guestOriginFor(
  db: Kysely<Database>,
  tenantId: string,
  slug: string,
  template: string,
): Promise<string | null> {
  let url: URL;
  try {
    url = new URL(template.replaceAll("{slug}", slug));
  } catch {
    return null;
  }
  const local = url.hostname === "localhost" || url.hostname.endsWith(".localhost");
  if (url.protocol !== "https:" && !(url.protocol === "http:" && local)) return null;
  if (url.pathname !== "/" || url.search || url.hash || url.username || url.password) return null;
  const { rows } = await sql<{ tenant_id: string }>`
    select tenant_id from app.resolve_hostname(${url.hostname})`.execute(db);
  return rows[0]?.tenant_id === tenantId ? url.origin : null;
}

async function claimOne(
  db: Kysely<Database>,
  ctx: TenantContext,
  options: DeliveryOptions,
  origin: () => Promise<string | null>,
): Promise<Claimed> {
  const lease = options.leaseSeconds ?? DEFAULT_LEASE_SECONDS;
  return inTenantTransaction(db, ctx, async (trx) => {
    const { rows } = await sql<ClaimedRow & { state: string }>`
      select id, attempts, state, booking_id, participant_id, subject_ref, to_email, to_name,
             from_name, reply_to, subject, html_body, text_body, link_purpose, link_path,
             link_ttl_seconds, link_slot
        from email_messages
       where tenant_id = ${ctx.tenantId}
         and ((state = 'queued' and next_attempt_at <= now())
              or (state = 'sending' and lease_expires_at <= now()))
       order by next_attempt_at, id
       limit 1
       for update skip locked`.execute(trx);
    const found = rows[0];
    if (!found) return { kind: "none" } as const;
    const { rows: claimed } = await sql<{ attempts: number }>`
      update email_messages
         set state = 'sending', attempts = attempts + 1,
             lease_expires_at = now() + make_interval(secs => ${lease}),
             provider = ${options.provider.name}
       where tenant_id = ${ctx.tenantId} and id = ${found.id}
      returning attempts`.execute(trx);
    const attempt = claimed[0]?.attempts;
    if (attempt === undefined) throw new Error("a locked message did not claim");
    const row = { ...found, attempts: attempt };
    if (attempt > MAX_DELIVERY_ATTEMPTS) {
      // Attempts that crashed after claiming count too; stop somewhere.
      await fail(trx, ctx, row.id, attempt, "retries_exhausted");
      return { kind: "failed", messageId: row.id, attempt, code: "retries_exhausted" } as const;
    }
    if (row.link_purpose === null || row.link_path === null || row.link_ttl_seconds === null) {
      return { kind: "ready", row, url: null } as const;
    }
    const base = await origin();
    if (!base || row.booking_id === null) {
      await fail(trx, ctx, row.id, attempt, "link_host_unmapped");
      return { kind: "failed", messageId: row.id, attempt, code: "link_host_unmapped" } as const;
    }
    const issued = await issueAccessLink(trx, ctx, {
      bookingId: row.booking_id,
      participantId: row.participant_id,
      purpose: row.link_purpose,
      subjectRef: row.subject_ref,
      messageId: row.id,
      ttlSeconds: row.link_ttl_seconds,
    });
    return { kind: "ready", row, url: `${base}${row.link_path}#t=${issued.token}` } as const;
  });
}

async function fail(
  trx: TenantTransaction,
  ctx: TenantContext,
  messageId: string,
  attempt: number,
  code: string,
): Promise<boolean> {
  const { rows } = await sql<{ id: string }>`
    update email_messages set state = 'failed', last_error_code = ${code}
     where tenant_id = ${ctx.tenantId} and id = ${messageId}
       and state = 'sending' and attempts = ${attempt}
    returning id`.execute(trx);
  return rows.length === 1;
}

async function record(
  db: Kysely<Database>,
  ctx: TenantContext,
  row: ClaimedRow,
  result:
    | { kind: "sent"; providerMessageId: string }
    | { kind: "retry"; code: string }
    | { kind: "failed"; code: string },
): Promise<DeliveryItem> {
  const attempt = row.attempts;
  return inTenantTransaction(db, ctx, async (trx) => {
    let updated: number;
    if (result.kind === "sent") {
      const { rows } = await sql<{ id: string }>`
        update email_messages set state = 'sent', provider_message_id = ${result.providerMessageId}
         where tenant_id = ${ctx.tenantId} and id = ${row.id}
           and state = 'sending' and attempts = ${attempt}
        returning id`.execute(trx);
      updated = rows.length;
    } else if (result.kind === "retry" && attempt < MAX_DELIVERY_ATTEMPTS) {
      const { rows } = await sql<{ id: string }>`
        update email_messages
           set state = 'queued', last_error_code = ${result.code},
               next_attempt_at = now() + make_interval(secs => ${backoffFor(attempt)})
         where tenant_id = ${ctx.tenantId} and id = ${row.id}
           and state = 'sending' and attempts = ${attempt}
        returning id`.execute(trx);
      updated = rows.length;
    } else {
      const code = result.kind === "retry" ? "retries_exhausted" : result.code;
      updated = (await fail(trx, ctx, row.id, attempt, code)) ? 1 : 0;
      if (updated) return { messageId: row.id, attempt, outcome: "failed", code };
    }
    if (!updated) return { messageId: row.id, attempt, outcome: "superseded", code: null };
    return result.kind === "sent"
      ? { messageId: row.id, attempt, outcome: "sent", code: null }
      : { messageId: row.id, attempt, outcome: "retry", code: result.code };
  });
}

/**
 * Send one tenant's due messages, up to `limit`, one at a time. Safe to run
 * concurrently with itself and with the cron: claims skip what another run
 * holds, and outcomes are recorded only for the attempt that made them.
 */
export async function deliverTenantMessages(
  db: Kysely<Database>,
  tenantId: string,
  options: DeliveryOptions,
): Promise<TenantDeliveryReport> {
  const limit = options.limit ?? 25;
  if (!Number.isInteger(limit) || limit < 1 || limit > 500) {
    throw new RangeError("limit is a whole number from 1 to 500");
  }
  const ctx: TenantContext = {
    tenantId,
    actorType: "system",
    actorId: "email-delivery",
    requestId: options.runId,
  };
  const template = options.guestLinkOrigin ?? DEFAULT_GUEST_LINK_ORIGIN;
  let originMemo: Promise<string | null> | undefined;
  const origin = () => {
    originMemo ??= (async () => {
      const slug = await inTenantTransaction(db, ctx, async (trx) => {
        const { rows } = await sql<{ slug: string }>`
          select slug from tenants where id = ${tenantId}`.execute(trx);
        return rows[0]?.slug ?? null;
      });
      return slug ? guestOriginFor(db, tenantId, slug, template) : null;
    })();
    return originMemo;
  };

  const report: TenantDeliveryReport = {
    claimed: 0,
    sent: 0,
    retried: 0,
    failed: 0,
    superseded: 0,
    items: [],
  };
  for (let i = 0; i < limit; i++) {
    const claimed = await claimOne(db, ctx, options, origin);
    if (claimed.kind === "none") break;
    report.claimed += 1;
    let item: DeliveryItem;
    if (claimed.kind === "failed") {
      item = {
        messageId: claimed.messageId,
        attempt: claimed.attempt,
        outcome: "failed",
        code: claimed.code,
      };
    } else {
      const { row, url } = claimed;
      let result:
        | { kind: "sent"; providerMessageId: string }
        | { kind: "retry"; code: string }
        | { kind: "failed"; code: string };
      try {
        const html =
          row.link_slot && url ? fillLinkSlot(row.html_body, row.link_slot, url) : row.html_body;
        const text =
          row.link_slot && url ? fillLinkSlot(row.text_body, row.link_slot, url) : row.text_body;
        const sent = await options.provider.send({
          idempotencyKey: row.id,
          tenantId,
          from: { email: options.fromAddress, name: row.from_name },
          replyTo: row.reply_to,
          to: { email: row.to_email, name: row.to_name },
          subject: row.subject,
          html,
          text,
        });
        result = { kind: "sent", providerMessageId: sent.providerMessageId };
      } catch (error) {
        if (error instanceof EmailProviderRejectedError) {
          result = { kind: "failed", code: error.code };
        } else if (error instanceof EmailProviderUnavailableError) {
          result = { kind: "retry", code: error.code };
        } else {
          // An unknown outcome: retry with the same key, as for an outage.
          result = { kind: "retry", code: "send_error" };
        }
      }
      item = await record(db, ctx, row, result);
    }
    report.items.push(item);
    if (item.outcome === "sent") report.sent += 1;
    else if (item.outcome === "retry") report.retried += 1;
    else if (item.outcome === "failed") report.failed += 1;
    else report.superseded += 1;
  }
  return report;
}

export interface EmailSweepOptions extends DeliveryOptions {
  tenantLimit?: number;
  /** Stop starting tenants after this long. */
  budgetMs?: number;
  /** One tenant's run failed; the sweep moves on. */
  onTenantError?: (tenantId: string, error: unknown) => void;
  clock?: () => number;
}

export interface EmailSweepReport {
  tenants: number;
  claimed: number;
  sent: number;
  retried: number;
  failed: number;
  superseded: number;
  failedTenants: number;
  complete: boolean;
}

/**
 * The cron's delivery run: every tenant with due mail, as
 * `app.email_delivery_tenants` names them (tenant ids only), each in its own
 * transactions under row-level security. A tenant whose run fails is
 * reported and skipped; the next run retries it.
 */
export async function sweepEmail(
  db: Kysely<Database>,
  options: EmailSweepOptions,
): Promise<EmailSweepReport> {
  const clock = options.clock ?? Date.now;
  const started = clock();
  const budget = options.budgetMs ?? 20_000;
  const tenantLimit = options.tenantLimit ?? 100;
  const { rows } = await sql<{ tenant_id: string }>`
    select tenant_id from app.email_delivery_tenants(${tenantLimit})`.execute(db);
  const report: EmailSweepReport = {
    tenants: 0,
    claimed: 0,
    sent: 0,
    retried: 0,
    failed: 0,
    superseded: 0,
    failedTenants: 0,
    complete: rows.length < tenantLimit,
  };
  for (const { tenant_id: tenantId } of rows) {
    if (clock() - started >= budget) {
      report.complete = false;
      break;
    }
    report.tenants += 1;
    try {
      const done = await deliverTenantMessages(db, tenantId, options);
      report.claimed += done.claimed;
      report.sent += done.sent;
      report.retried += done.retried;
      report.failed += done.failed;
      report.superseded += done.superseded;
    } catch (error) {
      report.failedTenants += 1;
      report.complete = false;
      options.onTenantError?.(tenantId, error);
    }
  }
  return report;
}
