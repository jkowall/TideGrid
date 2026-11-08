import { createRoute, type OpenAPIHono } from "@hono/zod-openapi";
import { PaymentWebhookParams, PaymentWebhookResponse } from "@tidegrid/contracts";
import { createDb, inTenantTransaction, type TenantContext } from "@tidegrid/database";
import {
  handleVerifiedEvent,
  type ProcessResult,
  processProviderEvent,
  type SettleRefundResult,
  settleRefund,
} from "@tidegrid/domain-booking";
import { deliverTenantMessages } from "@tidegrid/domain-messaging";
import {
  InboxConflictError,
  isStripeWebhookIp,
  type PaymentProvider,
  type RecordedEvent,
  recordProviderEvent,
  resolvePaymentAccount,
  tryLockInboxEvent,
  type VerifiedProviderEvent,
} from "@tidegrid/domain-payments";
import type { Logger } from "@tidegrid/observability";
import type { Context } from "hono";
import { bookingHooksFor } from "../booking-hooks.ts";
import type { AppDeps, AppEnv } from "../context.ts";
import { getDb } from "../db.ts";
import {
  afterCommitDeliveryOptions,
  deliverAfterCommit,
  deliversAfterCommit,
  emailProvider,
  sendErrorAttributes,
} from "../email.ts";
import { type Bindings, databaseUrl } from "../env.ts";
import { ApiError } from "../errors.ts";
import { providerFor, providerOver } from "../payments.ts";
import { errorBody } from "./responses.ts";

const webhookPath = "/v1/webhooks/payments/{provider}";
/** Outcomes an operator must see: refunded payments, and events that match no payment or the wrong one. */
/**
 * Outcomes a person must look at. The refund outcomes (W3-G2.9) log only the
 * outcome name: never the provider's refund object (data.object), its
 * failure text, or its metadata.
 */
const needsAttention = new Set([
  "refund_required",
  "payment_mismatch",
  "unmatched_payment",
  "refund_failed",
  "refund_failed_after_success",
  "refund_succeeded_after_failure",
  "refund_mismatch",
  "unmatched_refund",
]);
/** Provider events are small; Stripe's largest are well under this. */
export const MAX_WEBHOOK_BYTES = 64 * 1024;

/**
 * Provider callbacks (G2.7). A provider calls this route directly, so it has
 * no Origin and no session; the signature is the only credential. The order
 * of work is the point: the signature is checked on the raw body before
 * anything is parsed or any database is touched; then the event is recorded
 * once in the inbox of the tenant that owns its connected account; then it is
 * processed. A request that carries an Origin header came from a browser, not
 * a provider, and is refused.
 *
 * Under the Stripe provider (W1-STRIPE-WEBHOOK, coordinator defaults pending
 * the owner), two things change, and the fake's path does not:
 *
 * - The client address, read from `CF-Connecting-IP` only, must be on the
 *   committed list of Stripe's webhook addresses, or the route answers 403
 *   before it reads the body (D2, D3). `X-Forwarded-For` is never read.
 * - The route answers 200 once the event is recorded, and processes it
 *   afterwards through `waitUntil` on a connection of its own (D1). A crash
 *   after the 200 leaves the event received for the cron's checkout sweep,
 *   the only automatic backstop: Stripe counts the 200 as delivered and does
 *   not send the event again unless a person resends it. Processing is
 *   idempotent per event.
 */
/** The Stripe webhook's own path: the one the source check guards. */
export const STRIPE_WEBHOOK_PATH = "/v1/webhooks/payments/stripe";

/**
 * Under Stripe, refuse a client address not on the committed list (D2, D3).
 * Cloudflare sets CF-Connecting-IP at its edge and overwrites a client's own;
 * X-Forwarded-For is client-controlled and is never read. The body cap calls
 * this before it reads a byte, so an unlisted sender costs no upload, and the
 * route calls it again.
 */
export function refuseUnlistedStripeSource(c: Context<AppEnv>): void {
  const address = c.req.header("cf-connecting-ip") ?? null;
  if (isStripeWebhookIp(address)) return;
  c.get("log").warn("payment_webhook_source_refused", {
    "event.name": "payment_webhook_source_refused",
    "error.type": address === null ? "source_address_missing" : "source_address_not_listed",
  });
  throw new ApiError(403, "source_not_allowed", "Provider callbacks come from the provider");
}

export function registerPaymentWebhookRoutes(app: OpenAPIHono<AppEnv>, deps: AppDeps) {
  const webhookRoute = createRoute({
    method: "post",
    path: webhookPath,
    tags: ["webhooks"],
    summary: "Receive a signed payment provider event",
    description:
      "For the payment provider only. The body is the provider's event, signed over its raw bytes with a timestamp (the fake provider's `Fake-Signature: t=<unix>,v1=<hex HMAC-SHA256>`; Stripe's `Stripe-Signature` in the same scheme, when the Stripe adapter is configured, which no deployment does yet). A signature outside the tolerance window, or for another body, answers 400 and nothing is recorded. A Stripe event must be a snapshot Connect event in test mode; a live, platform-scope, or thin event answers 400 payload_invalid. A verified event is recorded once per event id; a duplicate changes nothing, and a Stripe redelivery whose per-delivery fields changed counts as the same event. A booking is confirmed only here or by the sweep, from a verified event. A 500 leaves the event recorded and unprocessed for the provider's retry and the sweep. Under Stripe only: the client address (`CF-Connecting-IP`) must be one of Stripe's published webhook addresses, or the route answers 403 source_not_allowed before reading the body; and a newly recorded event answers 200 with outcome `received` before it is processed, after the response, with the sweep as the backstop.",
    request: { params: PaymentWebhookParams },
    responses: {
      200: {
        content: { "application/json": { schema: PaymentWebhookResponse } },
        description: "Verified and recorded",
      },
      400: errorBody(
        "Missing, malformed, stale, or wrong signature (signature_invalid), or an unreadable event (payload_invalid)",
      ),
      403: errorBody(
        "The request came from a browser (origin_not_allowed), or, under Stripe, from an address not on Stripe's webhook list (source_not_allowed)",
      ),
      404: errorBody("This deployment does not use that provider"),
      413: errorBody("The body is larger than any provider event (payload_too_large)"),
    },
  });

  app.openapi(webhookRoute, async (c) => {
    const receivedAt = Date.now();
    if (c.req.header("origin") !== undefined) {
      throw new ApiError(403, "origin_not_allowed", "Provider callbacks come from the provider");
    }
    const { provider: name } = c.req.valid("param");
    const provider = providerFor(c, deps);
    if (!provider || provider.name !== name) {
      throw new ApiError(404, "not_found", "No such route");
    }
    // The body cap (src/body-limit.ts) already ran this check for a configured
    // Stripe provider, before reading any byte; it runs again here for a
    // provider a test injects.
    if (provider.name === "stripe") refuseUnlistedStripeSource(c);
    const declared = Number(c.req.header("content-length") ?? "0");
    if (Number.isFinite(declared) && declared > MAX_WEBHOOK_BYTES) {
      throw new ApiError(413, "payload_too_large", "The event is too large");
    }
    const rawBody = await c.req.text();
    if (new TextEncoder().encode(rawBody).length > MAX_WEBHOOK_BYTES) {
      throw new ApiError(413, "payload_too_large", "The event is too large");
    }
    const verified = await provider.verifyWebhook({
      rawBody,
      signatureHeader: c.req.header(provider.signatureHeader) ?? null,
      nowMs: Date.now(),
    });
    const log = c.get("log");
    if (verified.kind === "rejected") {
      log.warn("payment_webhook_rejected", {
        "event.name": "payment_webhook_rejected",
        "error.type": verified.reason,
      });
      if (verified.reason === "payload_invalid") {
        throw new ApiError(400, "payload_invalid", "The event could not be read");
      }
      throw new ApiError(400, "signature_invalid", "The event's signature did not verify");
    }

    if (provider.name === "stripe") {
      return acknowledgeThenProcess(c, deps, verified.event, receivedAt);
    }

    const handled = await handleVerifiedEvent(getDb(c), provider, verified.event, {
      requestId: c.get("requestId"),
      sourceIp: c.req.header("cf-connecting-ip") ?? null,
      hooks: bookingHooksFor(c.env, deps),
    });
    if (handled.kind === "unknown_account") {
      // Not an account any operator here owns, so not a payment TideGrid made.
      log.error("payment_webhook_unknown_account", {
        "event.name": "payment_webhook_unknown_account",
      });
      return c.json({ received: true as const, duplicate: false, outcome: "unknown_account" }, 200);
    }
    if (handled.kind === "payload_mismatch") {
      log.error("payment_webhook_payload_mismatch", {
        "event.name": "payment_webhook_payload_mismatch",
        "tidegrid.tenant_id": handled.tenantId,
      });
      return c.json({ received: true as const, duplicate: true, outcome: "payload_mismatch" }, 200);
    }
    // Money that moved without a booking, or an event that matches no payment
    // or does not match its payment, needs a person, once: a redelivery of an
    // event already handled is routine. A refund that did not settle always is.
    // A new booking's confirmation email goes out now, in the background (lane 1).
    if (handled.outcome === "confirmed" || handled.outcome === "confirmed_reacquired") {
      deliverAfterCommit(c, deps, handled.tenantId);
    }
    const attention =
      (needsAttention.has(handled.outcome) && !handled.duplicate) ||
      (handled.refund !== null &&
        handled.refund.kind !== "succeeded" &&
        handled.refund.kind !== "pending");
    (attention ? log.error : log.info)("payment_webhook", {
      "event.name": "payment_webhook",
      "tidegrid.tenant_id": handled.tenantId,
      "tidegrid.payment_event.outcome": handled.outcome,
      "tidegrid.payment_event.duplicate": handled.duplicate,
      ...(handled.refund && handled.refund.kind !== "succeeded" && handled.refund.kind !== "pending"
        ? { "error.type": `refund_${handled.refund.kind}` }
        : {}),
    });
    return c.json(
      { received: true as const, duplicate: handled.duplicate, outcome: handled.outcome },
      200,
    );
  });
}

type WebhookContext = Context<AppEnv>;

/**
 * Under Stripe: record the verified event in its tenant's inbox, in one
 * transaction, answer 200, and process it after the response. Everything up
 * to the record is what `handleVerifiedEvent` does, in the same order, so the
 * answers for an unknown account, a changed body, and an event already
 * processed are the same as the inline path's.
 */
async function acknowledgeThenProcess(
  c: WebhookContext,
  deps: AppDeps,
  event: VerifiedProviderEvent,
  receivedAt: number,
) {
  const log = c.get("log");
  const db = getDb(c);
  const account = await resolvePaymentAccount(db, event.provider, event.accountRef);
  if (!account) {
    log.error("payment_webhook_unknown_account", {
      "event.name": "payment_webhook_unknown_account",
    });
    return c.json({ received: true as const, duplicate: false, outcome: "unknown_account" }, 200);
  }
  const ctx: TenantContext = {
    tenantId: account.tenantId,
    actorType: "system",
    actorId: `${event.provider}-webhook`,
    requestId: c.get("requestId"),
    sourceIp: c.req.header("cf-connecting-ip") ?? null,
  };
  let recorded: RecordedEvent | null;
  try {
    recorded = await inTenantTransaction(db, ctx, (trx) => recordProviderEvent(trx, ctx, event));
  } catch (err) {
    if (!(err instanceof InboxConflictError)) throw err;
    recorded = null;
  }
  if (recorded === null || (recorded.duplicate && !recorded.samePayload)) {
    log.error("payment_webhook_payload_mismatch", {
      "event.name": "payment_webhook_payload_mismatch",
      "tidegrid.tenant_id": account.tenantId,
    });
    return c.json({ received: true as const, duplicate: true, outcome: "payload_mismatch" }, 200);
  }
  if (recorded.processingState === "processed") {
    log.info("payment_webhook", {
      "event.name": "payment_webhook",
      "tidegrid.tenant_id": account.tenantId,
      "tidegrid.payment_event.outcome": recorded.outcome ?? "processed",
      "tidegrid.payment_event.duplicate": true,
      duration_ms: Date.now() - receivedAt,
    });
    return c.json(
      { received: true as const, duplicate: true, outcome: recorded.outcome ?? "processed" },
      200,
    );
  }
  // Received, not yet processed: a new event, or a redelivery of one whose
  // processing failed or is still running. Processing takes the row only if
  // no one else holds it, so a redelivery never waits on the first delivery.
  processAfterResponse(c, deps, ctx, recorded.inboxId, receivedAt);
  log.info("payment_webhook_recorded", {
    "event.name": "payment_webhook_recorded",
    "tidegrid.tenant_id": account.tenantId,
    "tidegrid.payment_event.outcome": "received",
    "tidegrid.payment_event.duplicate": recorded.duplicate,
    duration_ms: Date.now() - receivedAt,
  });
  return c.json(
    { received: true as const, duplicate: recorded.duplicate, outcome: "received" },
    200,
  );
}

type Processed =
  | { kind: "busy" }
  | { kind: "already_processed"; outcome: string | null }
  | { kind: "processed"; result: ProcessResult };

/**
 * Process one recorded event after the response, through `waitUntil`, on a
 * connection of its own: the request's connection closes with the response.
 * Best effort, like after-commit email: any failure is logged and leaves the
 * event received, which the checkout sweep processes on its next run, up to
 * the cron interval plus the sweep's grace later. Stripe does not retry a
 * delivery it got a 200 for; a manual resend from Stripe's dashboard, or a
 * delivery whose 200 was lost, schedules processing again. A booking it
 * confirms gets its
 * confirmation email in the same background task, inside the `waitUntil`
 * window counted from before the response.
 */
function processAfterResponse(
  c: WebhookContext,
  deps: AppDeps,
  ctx: TenantContext,
  inboxId: string,
  receivedAt: number,
): void {
  const url = databaseUrl(c.env);
  if (!url) return;
  const env = c.env;
  const log = c.get("log");
  const runId = c.get("requestId");
  const hooks = bookingHooksFor(env, deps);
  const clock = deps.emailClock ?? Date.now;
  // Taken before the response is sent, so the email's 30 s cap is never late.
  const emailStartedAt = clock();
  c.executionCtx.waitUntil(
    (async () => {
      const handle = createDb(url, { max: 1 });
      try {
        const provider = providerOver(handle.db, env, deps);
        if (!provider) throw new Error("the payment provider is not configured");
        const processed = await inTenantTransaction(
          handle.db,
          ctx,
          async (trx): Promise<Processed> => {
            const row = await tryLockInboxEvent(trx, ctx.tenantId, inboxId);
            if (!row) return { kind: "busy" };
            if (row.processingState === "processed") {
              return { kind: "already_processed", outcome: row.outcome };
            }
            const result = await processProviderEvent(trx, ctx, inboxId, { hooks });
            if (!result) throw new Error("an inbox event was skipped without skipLocked");
            return { kind: "processed", result };
          },
        );
        if (processed.kind !== "processed") {
          // Someone else holds or already finished the row: it logs its own outcome.
          log.info("payment_webhook_processing_skipped", {
            "event.name": "payment_webhook_processing_skipped",
            "tidegrid.tenant_id": ctx.tenantId,
            "error.type": processed.kind,
          });
          return;
        }
        const outcome = processed.result.outcome;
        const processedAt = Date.now();
        const refund = processed.result.refundId
          ? await settleRefundBestEffort(handle.db, provider, ctx, processed.result.refundId)
          : null;
        logProcessed(log, ctx.tenantId, outcome, false, refund, processedAt - receivedAt);
        if (outcome === "confirmed" || outcome === "confirmed_reacquired") {
          await deliverConfirmation(handle.db, env, deps, log, ctx.tenantId, runId, emailStartedAt);
        }
      } catch (error) {
        log.error("payment_webhook_processing_failed", {
          "event.name": "payment_webhook_processing_failed",
          "tidegrid.tenant_id": ctx.tenantId,
          "error.type": error instanceof Error ? error.name : "unknown",
          duration_ms: Date.now() - receivedAt,
        });
      } finally {
        await handle.end().catch(() => undefined);
      }
    })(),
  );
}

async function settleRefundBestEffort(
  db: Parameters<typeof settleRefund>[0],
  provider: PaymentProvider,
  ctx: TenantContext,
  refundId: string,
): Promise<SettleRefundResult> {
  // The decision is committed; an unknown outcome stays requested for the sweep.
  try {
    return await settleRefund(db, provider, ctx, refundId);
  } catch {
    return { kind: "unknown" };
  }
}

/** The inline path's outcome log, with the time from receipt to the processing commit. */
function logProcessed(
  log: Logger,
  tenantId: string,
  outcome: string,
  duplicate: boolean,
  refund: SettleRefundResult | null,
  durationMs: number,
): void {
  const attention =
    (needsAttention.has(outcome) && !duplicate) ||
    (refund !== null && refund.kind !== "succeeded" && refund.kind !== "pending");
  (attention ? log.error : log.info)("payment_webhook", {
    "event.name": "payment_webhook",
    "tidegrid.tenant_id": tenantId,
    "tidegrid.payment_event.outcome": outcome,
    "tidegrid.payment_event.duplicate": duplicate,
    ...(refund && refund.kind !== "succeeded" && refund.kind !== "pending"
      ? { "error.type": `refund_${refund.kind}` }
      : {}),
    duration_ms: durationMs,
  });
}

/**
 * The confirmation email for a booking processing just confirmed, on the
 * background task's own connection. The same run `deliverAfterCommit` makes,
 * with its window counted from before the response, not from now.
 */
async function deliverConfirmation(
  db: Parameters<typeof deliverTenantMessages>[0],
  env: Bindings,
  deps: AppDeps,
  log: Logger,
  tenantId: string,
  runId: string,
  startedAt: number,
): Promise<void> {
  if (!deliversAfterCommit(env, deps)) return;
  const clock = deps.emailClock ?? Date.now;
  try {
    const provider = deps.emailProvider ? deps.emailProvider(db, env) : emailProvider(env, db, log);
    if (!provider) return;
    const report = await deliverTenantMessages(
      db,
      tenantId,
      afterCommitDeliveryOptions(
        env,
        provider,
        runId,
        // The connection has just committed processing, so it is ready now.
        { startedAt, readyAt: clock() },
        (_messageId, error) => log.error("email_send_error", sendErrorAttributes(error)),
        clock,
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
      "error.type": error instanceof Error ? error.name : "unknown",
    });
  }
}
