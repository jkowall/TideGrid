import { createRoute, type OpenAPIHono, z } from "@hono/zod-openapi";
import {
  CheckoutSessionCreateRequest,
  CheckoutSessionCreateResponse,
  CheckoutSessionParams,
  CheckoutSessionResponse,
  IdempotencyKey,
} from "@tidegrid/contracts";
import {
  type CheckoutSessionView,
  cancelCheckoutSession,
  checkoutSecretPattern,
  createCheckoutSession,
  ensureProviderPayment,
  getCheckoutSession,
  MAX_OPEN_CHECKOUTS_PER_CLIENT,
} from "@tidegrid/domain-booking";
import type { Context } from "hono";
import type { AppDeps, AppEnv } from "../context.ts";
import { getDb } from "../db.ts";
import { ApiError } from "../errors.ts";
import { providerFor } from "../payments.ts";
import { withPublicTenant } from "../public-tenant.ts";
import { errorBody } from "./responses.ts";

const sessionsPath = "/v1/public/checkout-sessions";
const sessionPath = "/v1/public/checkout-sessions/{checkoutSessionId}";
const cancelPath = "/v1/public/checkout-sessions/{checkoutSessionId}/cancel";

const checkoutNotFound = () =>
  new ApiError(404, "checkout_not_found", "No such checkout at this address");

const bearerSecurity = [{ checkoutSecret: [] }];

/**
 * The guest's capability secret, from `Authorization: Bearer <secret>`. It is
 * never accepted in a URL. A missing or malformed one answers 401; a wrong one
 * answers 404 like an unknown checkout, so checkouts cannot be probed.
 */
function checkoutSecret(c: Context<AppEnv>): string {
  const header = c.req.header("authorization") ?? "";
  const match = /^Bearer ([A-Za-z0-9_-]{43})$/.exec(header);
  if (!match?.[1] || !checkoutSecretPattern.test(match[1])) {
    throw new ApiError(
      401,
      "checkout_secret_required",
      "Send the checkout's secret as Authorization: Bearer <secret>",
    );
  }
  return match[1];
}

/**
 * Guest checkout (G2.7). Opening a checkout holds the quote's party and writes
 * the order and a pending payment in one transaction; the provider payment is
 * created after commit, outside any transaction, and its client secret is what
 * the guest pays with. Nothing here marks anything paid.
 */
export function registerCheckoutPublicRoutes(app: OpenAPIHono<AppEnv>, deps: AppDeps) {
  for (const path of [sessionsPath, "/v1/public/checkout-sessions/*"]) {
    app.use(path, async (c, next) => {
      await next();
      c.header("Cache-Control", "no-store");
      c.header("Vary", "Origin");
    });
  }

  app.openAPIRegistry.registerComponent("securitySchemes", "checkoutSecret", {
    type: "http",
    scheme: "bearer",
    description:
      "The guest's checkout secret: 43 base64url characters the guest's client generated and sent when it opened the checkout",
  });

  const createSessionRoute = createRoute({
    method: "post",
    path: sessionsPath,
    tags: ["public", "checkout"],
    summary: "Open a checkout for a quote",
    description: [
      "Resolves the browser Origin as /v1/public/trips does. Takes a quote by id and charges its stored total, never an amount the client sends. The quote must be this operator's, unused, and still valid by the database clock; the guest must have accepted its policy version. Holds the quote's party on the trip, which checks the party against the product and the seats left, holds included; writes the immutable order copied from the quote and a pending payment on the operator's connected account; then creates the provider payment and returns what the guest needs to pay.",
      "The guest's client generates `checkoutSecret` and keeps it; TideGrid stores only its hash. Idempotent by key: a retry with the same key and body returns the same checkout with `Idempotent-Replayed: true`, and creates the provider payment if an earlier attempt could not; the same key with another body answers 422. A 503 `payment_provider_unavailable` means the checkout exists and the provider did not answer: retry the same request.",
      `Rate limited per client address and operator like quotes, and at most ${MAX_OPEN_CHECKOUTS_PER_CLIENT} open checkouts per client address at a time. A limited request answers 429 and writes nothing.`,
    ].join("\n\n"),
    request: {
      headers: z.object({ "idempotency-key": IdempotencyKey }),
      body: {
        required: true,
        content: { "application/json": { schema: CheckoutSessionCreateRequest } },
      },
    },
    responses: {
      201: {
        content: { "application/json": { schema: CheckoutSessionCreateResponse } },
        description: "The open checkout and what the guest needs to pay",
      },
      400: errorBody("Request did not match the contract"),
      404: errorBody("No active tenant hostname matches the origin, or no such quote"),
      409: errorBody(
        "The quote is no longer valid (quote_expired) or already has a checkout (quote_already_used); the trip is not on sale (trip_not_bookable), has too few seats left (insufficient_capacity), or no longer takes this party (party_size_out_of_range); or the operator cannot take payments (payments_unavailable)",
      ),
      422: errorBody(
        "The accepted policy is not the quote's (policy_not_accepted), the total is below what the provider charges (payment_amount_too_small), or idempotency_key_reused",
      ),
      429: errorBody(
        "Too many requests from this address for this operator (rate_limited), or too many open checkouts (too_many_checkouts); nothing was written",
      ),
      503: errorBody(
        "Payments are not configured (payments_unavailable), or the provider did not answer (payment_provider_unavailable); for the latter, retry the same request with the same Idempotency-Key",
      ),
    },
  });

  app.openapi(createSessionRoute, async (c) => {
    const input = c.req.valid("json");
    const key = c.req.valid("header")["idempotency-key"];
    const provider = providerFor(c, deps);
    if (!provider) {
      throw new ApiError(503, "payments_unavailable", "Payments are not configured here");
    }
    const result = await withPublicTenant(
      c,
      {
        idempotency: {
          scope: "public.checkout_sessions.create",
          key,
          route: sessionsPath,
          body: input,
          successStatus: 201,
        },
      },
      async (trx, ctx) => {
        const created = await createCheckoutSession(trx, ctx, {
          quoteId: input.quoteId,
          acceptedPolicyVersion: input.acceptedPolicyVersion,
          booker: input.booker,
          secret: input.checkoutSecret,
          clientAddress: c.req.header("cf-connecting-ip") ?? null,
          provider: provider.name,
          minimumAmount: provider.minimumAmount("USD"),
        });
        switch (created.kind) {
          case "created":
            return { checkoutSession: { ...created.session } };
          case "quote_not_found":
            throw new ApiError(404, "quote_not_found", "No such quote at this address");
          case "quote_expired":
            throw new ApiError(409, "quote_expired", "This quote has expired; ask for a new one");
          case "quote_already_used":
            throw new ApiError(
              409,
              "quote_already_used",
              "This quote already has a checkout; ask for a new quote",
            );
          case "policy_not_accepted":
            throw new ApiError(
              422,
              "policy_not_accepted",
              `Accept policy version ${created.policyVersion} to continue`,
            );
          case "amount_too_small":
            throw new ApiError(
              422,
              "payment_amount_too_small",
              `Online payments start at ${created.minimum} cents`,
            );
          case "payments_unavailable":
            throw new ApiError(
              409,
              "payments_unavailable",
              "This operator cannot take payments online yet",
            );
          case "too_many_checkouts":
            throw new ApiError(
              429,
              "too_many_checkouts",
              `At most ${created.limit} open checkouts at a time; finish or cancel one first`,
            );
          case "not_bookable":
            if (created.reason === "party_size_out_of_range") {
              throw new ApiError(
                409,
                "party_size_out_of_range",
                "This trip no longer takes a party of this size",
              );
            }
            throw new ApiError(409, "trip_not_bookable", "This trip is not on sale now");
          case "insufficient_capacity":
            throw new ApiError(
              409,
              "insufficient_capacity",
              `Only ${created.remaining} seat(s) are left on this trip`,
            );
        }
      },
    );
    if (result.status !== 201) throw new Error(`unexpected stored status ${result.status}`);
    const session = result.body.checkoutSession as CheckoutSessionView;
    // Committed. Now the provider payment, outside any transaction.
    const ready = await ensureProviderPayment(getDb(c), provider, result.ctx, session.id);
    if (ready.kind === "unavailable") {
      c.get("log").warn("payment_provider_unavailable", {
        "event.name": "payment_provider_unavailable",
        "tidegrid.tenant_id": result.ctx.tenantId,
        "error.type": ready.reason,
      });
      throw new ApiError(
        503,
        "payment_provider_unavailable",
        "The payment provider did not answer; retry the same request with the same Idempotency-Key",
      );
    }
    if (ready.kind === "not_found") throw new Error("a committed checkout has no payment");
    if (result.replayed) c.header("Idempotent-Replayed", "true");
    return c.json(
      {
        checkoutSession: session,
        payment:
          ready.kind === "ready"
            ? {
                provider: ready.provider,
                paymentRef: ready.paymentRef,
                clientSecret: ready.clientSecret,
              }
            : null,
      },
      201,
    );
  });

  const readSessionRoute = createRoute({
    method: "get",
    path: sessionPath,
    tags: ["public", "checkout"],
    summary: "A checkout's state, for the guest who opened it",
    description:
      "Resolves the browser Origin as /v1/public/trips does and needs the checkout's secret as a bearer token. Shows the state, the amount, the expiry, the booking reference once confirmed, and the refund when a payment could not be honored. An open checkout past its expiry reads as expired. A wrong secret, another operator's checkout, and an unknown id answer the same 404.",
    security: bearerSecurity,
    request: { params: CheckoutSessionParams },
    responses: {
      200: {
        content: { "application/json": { schema: CheckoutSessionResponse } },
        description: "The checkout",
      },
      401: errorBody("No checkout secret, or a malformed one"),
      404: errorBody("No active tenant hostname matches the origin, or no such checkout"),
    },
  });

  app.openapi(readSessionRoute, async (c) => {
    const { checkoutSessionId } = c.req.valid("param");
    const secret = checkoutSecret(c);
    const { body } = await withPublicTenant(c, {}, async (trx, ctx) => {
      const session = await getCheckoutSession(trx, ctx.tenantId, {
        sessionId: checkoutSessionId,
        secret,
      });
      if (!session) throw checkoutNotFound();
      return { checkoutSession: { ...session } };
    });
    return c.json(body as { checkoutSession: CheckoutSessionView }, 200);
  });

  const cancelSessionRoute = createRoute({
    method: "post",
    path: cancelPath,
    tags: ["public", "checkout"],
    summary: "Abandon an open checkout",
    description:
      "Resolves the browser Origin and needs the checkout's secret as a bearer token. Releases the held seats at once and voids the order, so the party can be quoted again without its own hold counting against it. Repeating it changes nothing. A payment that succeeds afterwards anyway is refunded in full. Rate limited like other public commands.",
    security: bearerSecurity,
    request: { params: CheckoutSessionParams },
    responses: {
      200: {
        content: { "application/json": { schema: CheckoutSessionResponse } },
        description: "The canceled checkout",
      },
      401: errorBody("No checkout secret, or a malformed one"),
      404: errorBody("No active tenant hostname matches the origin, or no such checkout"),
      409: errorBody("The checkout is no longer open (checkout_not_cancelable)"),
      429: errorBody("Too many requests from this address for this operator (rate_limited)"),
    },
  });

  app.openapi(cancelSessionRoute, async (c) => {
    const { checkoutSessionId } = c.req.valid("param");
    const secret = checkoutSecret(c);
    const { body } = await withPublicTenant(c, { limit: true }, async (trx, ctx) => {
      const canceled = await cancelCheckoutSession(trx, ctx, {
        sessionId: checkoutSessionId,
        secret,
      });
      switch (canceled.kind) {
        case "canceled":
        case "unchanged":
          return { checkoutSession: { ...canceled.session } };
        case "not_cancelable":
          throw new ApiError(
            409,
            "checkout_not_cancelable",
            `This checkout is ${canceled.session.state} and cannot be canceled`,
          );
        case "not_found":
          throw checkoutNotFound();
      }
    });
    return c.json(body as { checkoutSession: CheckoutSessionView }, 200);
  });
}
