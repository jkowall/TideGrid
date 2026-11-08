import { createRoute, type OpenAPIHono, z } from "@hono/zod-openapi";
import {
  CheckoutPaymentResponse,
  CheckoutSessionCreateRequest,
  CheckoutSessionCreateResponse,
  CheckoutSessionParams,
  CheckoutSessionResponse,
  IdempotencyKey,
  TripOfferResponse,
} from "@tidegrid/contracts";
import { inTenantTransaction } from "@tidegrid/database";
import {
  type CheckoutSessionView,
  cancelCheckoutSession,
  checkoutSecretPattern,
  createCheckoutSession,
  ensureProviderPayment,
  getCheckoutSession,
  MAX_OPEN_CHECKOUTS_PER_CLIENT,
  ownerRefFor,
} from "@tidegrid/domain-booking";
import { getTripSale } from "@tidegrid/domain-inventory";
import { getTripOffer } from "@tidegrid/domain-pricing";
import type { Context } from "hono";
import type { AppDeps, AppEnv } from "../context.ts";
import { getDb } from "../db.ts";
import { ApiError } from "../errors.ts";
import { providerFor } from "../payments.ts";
import { withPublicTenant } from "../public-tenant.ts";
import { ProblemError, problemAnswer, withProblems } from "./problems.ts";
import { errorBody } from "./responses.ts";

const sessionsPath = "/v1/public/checkout-sessions";
const sessionPath = "/v1/public/checkout-sessions/{checkoutSessionId}";
const cancelPath = "/v1/public/checkout-sessions/{checkoutSessionId}/cancel";
const paymentPath = "/v1/public/checkout-sessions/{checkoutSessionId}/payment";
const offerPath = "/v1/public/checkout-sessions/{checkoutSessionId}/offer";

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
      409: problemAnswer(
        "The quote is no longer valid (quote_expired) or already has a checkout (quote_already_used); the trip is not on sale (trip_not_bookable), has too few seats left (insufficient_capacity, with `remaining`: the seats left on the quote's trip), or no longer takes this party (party_size_out_of_range); or the operator cannot take payments (payments_unavailable). Problem details",
      ),
      422: problemAnswer(
        "The accepted policy is not the quote's (policy_not_accepted), the total is below what the provider charges (payment_amount_too_small), or idempotency_key_reused. Problem details",
      ),
      429: errorBody(
        "Too many requests from this address for this operator (rate_limited), or too many open checkouts (too_many_checkouts); nothing was written",
      ),
      503: errorBody(
        "Payments are not configured (payments_unavailable), or the provider did not answer (payment_provider_unavailable); for the latter, retry the same request with the same Idempotency-Key",
      ),
    },
  });

  app.openapi(createSessionRoute, (c) =>
    withProblems(c, async () => {
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
              throw new ProblemError(
                409,
                "insufficient_capacity",
                `Only ${created.remaining} seat(s) are left on this trip`,
                [{ code: "insufficient_capacity", subject: null }],
                created.remaining,
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
    }),
  );

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

  const readPaymentRoute = createRoute({
    method: "get",
    path: paymentPath,
    tags: ["public", "checkout"],
    summary: "What the guest needs to pay an open checkout, read again",
    description: [
      "Resolves the browser Origin as /v1/public/trips does and needs the checkout's secret as a bearer token, never a URL. For an open checkout within its expiry, returns the provider payment and its client secret, so a page that reloaded, or lost the answer to opening the checkout, can still pay without sending the booker's details again. It asks the provider with the payment's own idempotency key, so it never creates a second payment. Any other state answers 200 with `payment: null`, including a checkout that closes or lapses while it is read: the body then shows the closed state. A wrong secret, another operator's checkout, and an unknown id answer the same 404.",
      "Never cached. Rate limited like public commands, since it may call the provider. The client secret is a capability: keep it out of URLs and logs.",
    ].join("\n\n"),
    security: bearerSecurity,
    request: { params: CheckoutSessionParams },
    responses: {
      200: {
        content: { "application/json": { schema: CheckoutPaymentResponse } },
        description: "The checkout, and what to pay with while it is open",
      },
      401: errorBody("No checkout secret, or a malformed one"),
      404: errorBody("No active tenant hostname matches the origin, or no such checkout"),
      429: errorBody("Too many requests from this address for this operator (rate_limited)"),
      503: errorBody(
        "Payments are not configured (payments_unavailable), or the provider did not answer (payment_provider_unavailable); read again later",
      ),
    },
  });

  app.openapi(readPaymentRoute, async (c) => {
    const { checkoutSessionId } = c.req.valid("param");
    const secret = checkoutSecret(c);
    const provider = providerFor(c, deps);
    if (!provider) {
      throw new ApiError(503, "payments_unavailable", "Payments are not configured here");
    }
    const read = await withPublicTenant(c, { limit: true }, async (trx, ctx) => {
      const session = await getCheckoutSession(trx, ctx.tenantId, {
        sessionId: checkoutSessionId,
        secret,
      });
      if (!session) throw checkoutNotFound();
      return { checkoutSession: { ...session } };
    });
    const session = read.body.checkoutSession as CheckoutSessionView;
    if (session.state !== "open") return c.json({ checkoutSession: session, payment: null }, 200);
    // Outside any transaction, as when the checkout was opened.
    const ready = await ensureProviderPayment(getDb(c), provider, read.ctx, session.id);
    if (ready.kind === "unavailable") {
      c.get("log").warn("payment_provider_unavailable", {
        "event.name": "payment_provider_unavailable",
        "tidegrid.tenant_id": read.ctx.tenantId,
        "error.type": ready.reason,
      });
      throw new ApiError(
        503,
        "payment_provider_unavailable",
        "The payment provider did not answer; read again later",
      );
    }
    if (ready.kind === "not_found") throw new Error("a committed checkout has no payment");
    if (ready.kind === "not_open") {
      // It closed or lapsed after the view was read: read the view again, so
      // the answer never shows an open checkout with no payment.
      const closed = await inTenantTransaction(getDb(c), read.ctx, (trx) =>
        getCheckoutSession(trx, read.ctx.tenantId, { sessionId: session.id, secret }),
      );
      if (!closed) throw checkoutNotFound();
      const state = closed.state === "open" ? ready.state : closed.state;
      return c.json({ checkoutSession: { ...closed, state }, payment: null }, 200);
    }
    return c.json(
      {
        checkoutSession: session,
        payment: {
          provider: ready.provider,
          paymentRef: ready.paymentRef,
          clientSecret: ready.clientSecret,
        },
      },
      200,
    );
  });

  const readOfferRoute = createRoute({
    method: "get",
    path: offerPath,
    tags: ["public", "checkout"],
    summary: "The offer of a checkout's trip, without the guest's own hold",
    description:
      "Resolves the browser Origin and needs the checkout's secret as a bearer token. The same offer as GET /v1/public/trips/{tripId}/offer for the checkout's trip, except that while the checkout is open and within its expiry its own hold does not count against the trip when that hold is what takes the trip off sale: a checkout whose hold took the last seats, or the whole boat, still reads its trip's offer. Every other rule applies as for the public offer. Once the checkout is closed it answers exactly as the public offer does. A wrong secret, another operator's checkout, and an unknown id answer the same 404.",
    security: bearerSecurity,
    request: { params: CheckoutSessionParams },
    responses: {
      200: {
        content: { "application/json": { schema: TripOfferResponse } },
        description: "The trip's offer",
      },
      401: errorBody("No checkout secret, or a malformed one"),
      404: errorBody("No active tenant hostname matches the origin, or no such checkout"),
      409: errorBody(
        "The trip is not on sale now, even without this checkout's hold (trip_not_bookable), or has no price list or policy (pricing_unavailable)",
      ),
    },
  });

  app.openapi(readOfferRoute, async (c) => {
    const { checkoutSessionId } = c.req.valid("param");
    const secret = checkoutSecret(c);
    const now = deps.now?.() ?? new Date();
    const { body } = await withPublicTenant(c, {}, async (trx, ctx) => {
      const session = await getCheckoutSession(trx, ctx.tenantId, {
        sessionId: checkoutSessionId,
        secret,
      });
      if (!session) throw checkoutNotFound();
      // Only an open, unexpired checkout's own hold is set aside; the view
      // already reads an open checkout past its expiry as expired.
      const ownerRef = session.state === "open" ? ownerRefFor(session.id) : null;
      const result = await getTripOffer(
        trx,
        ctx.tenantId,
        session.tripId,
        now,
        ownerRef
          ? {
              ownHold: async (minPartySize) => {
                const sale = await getTripSale(trx, ctx.tenantId, session.tripId, {
                  partySize: minPartySize,
                  at: now,
                  exceptOwnerRef: ownerRef,
                });
                return sale && sale.notBookable === null ? sale.remaining : null;
              },
            }
          : {},
      );
      switch (result.kind) {
        case "offer":
          return { offer: result.offer };
        case "trip_not_found":
          // A checkout's trip is a foreign key; it cannot vanish.
          throw new Error("a checkout's trip was not found");
        case "trip_not_on_sale":
          throw new ApiError(409, "trip_not_bookable", "This trip is not on sale now");
        case "pricing_unavailable":
          throw new ApiError(409, "pricing_unavailable", "This trip cannot be priced yet");
      }
    });
    return c.json(body, 200);
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
