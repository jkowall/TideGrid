import { createRoute, type OpenAPIHono } from "@hono/zod-openapi";
import { PaymentWebhookParams, PaymentWebhookResponse } from "@tidegrid/contracts";
import { handleVerifiedEvent } from "@tidegrid/domain-booking";
import type { AppDeps, AppEnv } from "../context.ts";
import { getDb } from "../db.ts";
import { ApiError } from "../errors.ts";
import { providerFor } from "../payments.ts";
import { errorBody } from "./responses.ts";

const webhookPath = "/v1/webhooks/payments/{provider}";
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
 */
export function registerPaymentWebhookRoutes(app: OpenAPIHono<AppEnv>, deps: AppDeps) {
  const webhookRoute = createRoute({
    method: "post",
    path: webhookPath,
    tags: ["webhooks"],
    summary: "Receive a signed payment provider event",
    description:
      "For the payment provider only. The body is the provider's event, signed over its raw bytes with a timestamp (the fake provider's `Fake-Signature: t=<unix>,v1=<hex HMAC-SHA256>`). A signature outside the tolerance window, or for another body, answers 400 and nothing is recorded. A verified event is recorded once per event id; a duplicate changes nothing. A booking is confirmed only here, from a verified success. A 500 leaves the event recorded and unprocessed for the provider's retry and the sweep.",
    request: { params: PaymentWebhookParams },
    responses: {
      200: {
        content: { "application/json": { schema: PaymentWebhookResponse } },
        description: "Verified and recorded",
      },
      400: errorBody(
        "Missing, malformed, stale, or wrong signature (signature_invalid), or an unreadable event (payload_invalid)",
      ),
      403: errorBody("The request came from a browser (origin_not_allowed)"),
      404: errorBody("This deployment does not use that provider"),
      413: errorBody("The body is larger than any provider event (payload_too_large)"),
    },
  });

  app.openapi(webhookRoute, async (c) => {
    if (c.req.header("origin") !== undefined) {
      throw new ApiError(403, "origin_not_allowed", "Provider callbacks come from the provider");
    }
    const { provider: name } = c.req.valid("param");
    const provider = providerFor(c, deps);
    if (!provider || provider.name !== name) {
      throw new ApiError(404, "not_found", "No such route");
    }
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

    const handled = await handleVerifiedEvent(getDb(c), provider, verified.event, {
      requestId: c.get("requestId"),
      sourceIp: c.req.header("cf-connecting-ip") ?? null,
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
    log.info("payment_webhook", {
      "event.name": "payment_webhook",
      "tidegrid.tenant_id": handled.tenantId,
      "tidegrid.payment_event.outcome": handled.outcome,
      "tidegrid.payment_event.duplicate": handled.duplicate,
      ...(handled.refund && handled.refund.kind !== "succeeded"
        ? { "error.type": `refund_${handled.refund.kind}` }
        : {}),
    });
    return c.json(
      { received: true as const, duplicate: handled.duplicate, outcome: handled.outcome },
      200,
    );
  });
}
