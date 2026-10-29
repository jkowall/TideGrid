import { createRoute, type OpenAPIHono, z } from "@hono/zod-openapi";
import {
  IdempotencyKey,
  QuoteCreateRequest,
  QuoteProblemCode,
  QuoteResponse,
  StaffCheckoutCreateRequest,
  StaffCheckoutCreateResponse,
  StaffCheckoutParams,
  StaffCheckoutResponse,
  StaffTenantParams,
  StaffTestPaymentRequest,
  StaffTestPaymentResponse,
  TripOfferResponse,
  TripParams,
} from "@tidegrid/contracts";
import { inTenantTransaction } from "@tidegrid/database";
import {
  type CreateCheckoutResult,
  cancelStaffCheckout,
  ensureProviderPayment,
  getStaffCheckout,
  MAX_OPEN_CHECKOUTS_PER_CLIENT,
  openStaffCheckout,
  recordStaffTestPaymentSuperseded,
  requestStaffTestPayment,
  type StaffCheckoutView,
  staffCheckoutPaymentRef,
  staffViewOf,
} from "@tidegrid/domain-booking";
import { type FakeEvent, ProviderUnavailableError } from "@tidegrid/domain-payments";
import { createQuote, getTripOffer, type QuoteProblem } from "@tidegrid/domain-pricing";
import { sql } from "kysely";
import type { AppDeps, AppEnv } from "../context.ts";
import { getDb } from "../db.ts";
import { ApiError } from "../errors.ts";
import { deliverFakeEvent } from "../fake-delivery.ts";
import { fakeProviderFor, providerFor } from "../payments.ts";
import { withStaffTenant } from "../staff-tenant.ts";
import { errorBody, staffSecurity } from "./responses.ts";

const offerPath = "/v1/staff/tenants/{tenantId}/trips/{tripId}/offer";
const quotesPath = "/v1/staff/tenants/{tenantId}/quotes";
const checkoutsPath = "/v1/staff/tenants/{tenantId}/checkouts";
const checkoutPath = "/v1/staff/tenants/{tenantId}/checkouts/{checkoutId}";
const cancelPath = "/v1/staff/tenants/{tenantId}/checkouts/{checkoutId}/cancel";
const testPaymentPath = "/v1/staff/tenants/{tenantId}/checkouts/{checkoutId}/test-payment";

const idempotencyHeader = z.object({ "idempotency-key": IdempotencyKey });

const tripNotFound = () => new ApiError(404, "trip_not_found", "No such trip for this tenant");
const tripNotOnSale = () => new ApiError(409, "trip_not_bookable", "This trip is not on sale now");
const checkoutNotFound = () =>
  new ApiError(404, "checkout_not_found", "No such staff checkout for this tenant");
const checkoutNotOpen = (state: string) =>
  new ApiError(409, "checkout_not_open", `This checkout is ${state}; no payment can be taken`);
const alreadySettled = (outcome: "succeed" | "fail") =>
  new ApiError(
    409,
    "test_payment_settled",
    outcome === "succeed"
      ? "This test payment already went through; it cannot be declined now"
      : "This test payment was already declined; take a new booking instead",
  );
const outcomeOfEvent = (type: string): "succeed" | "fail" | null =>
  type === "payment.succeeded" ? "succeed" : type === "payment.failed" ? "fail" : null;
const providerUnavailable = () =>
  new ApiError(
    503,
    "payment_provider_unavailable",
    "The payment provider did not answer; retry the same request with the same Idempotency-Key",
  );

/** Quote problems that depend on the trip's state rather than the request. */
const conflictProblems: readonly string[] = ["insufficient_capacity", "pricing_unavailable"];
const requestProblems = QuoteProblemCode.options.filter((c) => !conflictProblems.includes(c));

/** As the guest's quote route answers: the first problem is the code, the message lists all. */
function quoteRejected(problems: readonly QuoteProblem[]): ApiError {
  const code = problems[0]?.code ?? "pricing_unavailable";
  const status = conflictProblems.includes(code) ? 409 : 422;
  const detail = problems.map((p) => (p.subject ? `${p.code} (${p.subject})` : p.code)).join(", ");
  return new ApiError(status, code, `This quote cannot be priced: ${detail}`);
}

/** The guest's checkout codes, for the same refusals (G2.7). */
function checkoutRefused(created: Exclude<CreateCheckoutResult, { kind: "created" }>): ApiError {
  switch (created.kind) {
    case "quote_not_found":
      return new ApiError(404, "quote_not_found", "No such staff quote for this tenant");
    case "quote_expired":
      return new ApiError(409, "quote_expired", "This quote has expired; ask for a new one");
    case "quote_already_used":
      return new ApiError(
        409,
        "quote_already_used",
        "This quote already has a checkout; ask for a new quote",
      );
    case "policy_not_accepted":
      return new ApiError(
        422,
        "policy_not_accepted",
        `Tell the guest policy version ${created.policyVersion} to continue`,
      );
    case "amount_too_small":
      return new ApiError(
        422,
        "payment_amount_too_small",
        `Payments start at ${created.minimum} cents`,
      );
    case "payments_unavailable":
      return new ApiError(409, "payments_unavailable", "This operator cannot take payments yet");
    case "too_many_checkouts":
      return new ApiError(
        429,
        "too_many_checkouts",
        `At most ${created.limit} open checkouts per staff member; finish or cancel one first`,
      );
    case "not_bookable":
      return created.reason === "party_size_out_of_range"
        ? new ApiError(
            409,
            "party_size_out_of_range",
            "This trip no longer takes a party of this size",
          )
        : tripNotOnSale();
    case "insufficient_capacity":
      return new ApiError(
        409,
        "insufficient_capacity",
        `Only ${created.remaining} seat(s) are left on this trip`,
      );
  }
}

const viewJson = (view: StaffCheckoutView) => ({
  ...view,
  lastTestPayment: view.lastTestPayment ? { ...view.lastTestPayment } : null,
  booking: view.booking ? { ...view.booking } : null,
  refund: view.refund ? { ...view.refund } : null,
});

const commonRefusals = {
  400: errorBody("Request did not match the contract, or the Idempotency-Key is missing"),
  401: errorBody("Not signed in"),
  403: errorBody(
    "The role cannot create bookings (forbidden), the origin is not the console (origin_not_allowed), or the tenant is suspended (tenant_suspended)",
  ),
};

/**
 * Staff-assisted booking (G2.12d): an owner or booking staff member books for
 * a guest who phoned, emailed, or walked up. Every route needs
 * `bookings.create`, which finance does not hold. The chain is the guest's:
 * an offer, a stored quote, a checkout that holds the party and writes the
 * order and a pending payment, and a booking only from a verified provider
 * event. The demo's test payment settles the fake payment and posts its
 * signed event to the real webhook route, after the request's own
 * transaction has committed; nothing here writes payment, order, or booking
 * state itself.
 */
export function registerStaffBookingRoutes(app: OpenAPIHono<AppEnv>, deps: AppDeps) {
  const now = () => deps.now?.() ?? new Date();

  // R1 ---------------------------------------------------------------------------------
  const offerRoute = createRoute({
    method: "get",
    path: offerPath,
    tags: ["staff", "bookings"],
    summary: "What one trip sells, for a staff booking",
    description:
      "Owners and booking staff (bookings.create). The guest's offer for one trip on sale now: ticket types or the charter price, the add-ons offered on its date, mandatory fees, active tax rates, and the cancellation policy. Staff follow the guest's sales rules: there is no override. An unknown, malformed, or other tenant's trip answers the same 404.",
    security: staffSecurity,
    request: { params: TripParams },
    responses: {
      200: {
        content: { "application/json": { schema: TripOfferResponse } },
        description: "The trip's offer",
      },
      ...commonRefusals,
      404: errorBody("No such tenant, or no such trip for it (trip_not_found)"),
      409: errorBody(
        "The trip is not on sale now (trip_not_bookable) or has no price list or policy (pricing_unavailable)",
      ),
    },
  });

  app.openapi(offerRoute, async (c) => {
    const { tenantId, tripId } = c.req.valid("param");
    const { body } = await withStaffTenant(
      c,
      deps,
      { tenantId, permission: "bookings.create" },
      async (trx, ctx) => {
        const result = await getTripOffer(trx, ctx.tenantId, tripId, now());
        switch (result.kind) {
          case "offer":
            return { offer: result.offer };
          case "trip_not_found":
            throw tripNotFound();
          case "trip_not_on_sale":
            throw tripNotOnSale();
          case "pricing_unavailable":
            throw new ApiError(409, "pricing_unavailable", "This trip cannot be priced yet");
        }
      },
    );
    return c.json(body, 200);
  });

  // R2 ---------------------------------------------------------------------------------
  const quoteRoute = createRoute({
    method: "post",
    path: quotesPath,
    tags: ["staff", "bookings"],
    summary: "Price a party for a staff booking and keep the quote",
    description:
      "Owners and booking staff (bookings.create). Prices the party, add-ons, and optional promotion code on the server under the current versions, as the guest's quote does, and stores an immutable quote recorded as the staff member's. No price override. The tenant comes from the path and the membership, never from the Origin. Idempotent by key: a retry with the same key and body replays the first response with `Idempotent-Replayed: true`; the same key with another body answers 422.",
    security: staffSecurity,
    request: {
      params: StaffTenantParams,
      headers: idempotencyHeader,
      body: { required: true, content: { "application/json": { schema: QuoteCreateRequest } } },
    },
    responses: {
      201: {
        content: { "application/json": { schema: QuoteResponse } },
        description: "The stored quote (or the stored response replayed)",
      },
      ...commonRefusals,
      404: errorBody("No such tenant, or no such trip for it (trip_not_found)"),
      409: errorBody(
        "The trip is not on sale now (trip_not_bookable), has no price list or policy (pricing_unavailable), or has too few seats left (insufficient_capacity)",
      ),
      422: errorBody(
        `The party, add-ons, or promotion code cannot be priced: ${requestProblems.join(", ")}. Or idempotency_key_reused`,
      ),
    },
  });

  app.openapi(quoteRoute, async (c) => {
    const { tenantId } = c.req.valid("param");
    const input = c.req.valid("json");
    const key = c.req.valid("header")["idempotency-key"];
    const result = await withStaffTenant(
      c,
      deps,
      {
        tenantId,
        permission: "bookings.create",
        idempotency: {
          scope: "staff.quotes.create",
          key,
          route: quotesPath,
          body: input,
          successStatus: 201,
        },
      },
      async (trx, ctx) => {
        const created = await createQuote(trx, ctx, {
          tripId: input.tripId,
          party: input.party,
          addOns: input.addOns,
          promotionCode: input.promotionCode ?? null,
          now: now(),
        });
        switch (created.kind) {
          case "created":
            return { quote: created.quote };
          case "trip_not_found":
            throw tripNotFound();
          case "trip_not_on_sale":
            throw tripNotOnSale();
          case "rejected":
            throw quoteRejected(created.problems);
        }
      },
    );
    if (result.replayed) c.header("Idempotent-Replayed", "true");
    if (result.status !== 201) throw new Error(`unexpected stored status ${result.status}`);
    return c.json(result.body, 201);
  });

  // R3 ---------------------------------------------------------------------------------
  const openRoute = createRoute({
    method: "post",
    path: checkoutsPath,
    tags: ["staff", "bookings"],
    summary: "Open a staff-assisted checkout for a guest",
    description: [
      "Owners and booking staff (bookings.create). Takes a quote this tenant's staff created and charges its stored total, never an amount the client sends. Holds the quote's party on the trip under the same rules and lock as a guest's checkout, so the two never oversell, and writes the immutable order and a pending payment. The database records the checkout as staff_assisted and the signed-in staff member as its opener; neither can be sent.",
      "Staff attest that they told the guest the policy of the quote's version and read the email address back to them, which cannot be changed later. The confirmation email, with the management link and waiver requests, goes to that address once the payment is verified.",
      `Idempotent by key: a retry with the same key and body returns the same checkout with \`Idempotent-Replayed: true\` and creates the provider payment if an earlier attempt could not. A 503 payment_provider_unavailable means the checkout exists: retry the same request. At most ${MAX_OPEN_CHECKOUTS_PER_CLIENT} open checkouts per staff member at a time. The response carries no payment secret.`,
    ].join("\n\n"),
    security: staffSecurity,
    request: {
      params: StaffTenantParams,
      headers: idempotencyHeader,
      body: {
        required: true,
        content: { "application/json": { schema: StaffCheckoutCreateRequest } },
      },
    },
    responses: {
      201: {
        content: { "application/json": { schema: StaffCheckoutCreateResponse } },
        description: "The open checkout",
      },
      ...commonRefusals,
      404: errorBody(
        "No such tenant, or no such staff quote for it (quote_not_found); a guest's quote reads the same",
      ),
      409: errorBody(
        "quote_expired, quote_already_used, trip_not_bookable, insufficient_capacity, party_size_out_of_range, or payments_unavailable",
      ),
      422: errorBody("policy_not_accepted, payment_amount_too_small, or idempotency_key_reused"),
      429: errorBody("Too many open checkouts for this staff member (too_many_checkouts)"),
      503: errorBody(
        "Payments are not configured (payments_unavailable), or the provider did not answer (payment_provider_unavailable); for the latter, retry with the same Idempotency-Key",
      ),
    },
  });

  app.openapi(openRoute, async (c) => {
    const { tenantId } = c.req.valid("param");
    const input = c.req.valid("json");
    const key = c.req.valid("header")["idempotency-key"];
    const provider = providerFor(c, deps);
    if (!provider) {
      throw new ApiError(503, "payments_unavailable", "Payments are not configured here");
    }
    const result = await withStaffTenant(
      c,
      deps,
      {
        tenantId,
        permission: "bookings.create",
        idempotency: {
          scope: "staff.checkouts.create",
          key,
          route: checkoutsPath,
          body: input,
          successStatus: 201,
        },
      },
      async (trx, ctx) => {
        const created = await openStaffCheckout(trx, ctx, {
          quoteId: input.quoteId,
          acceptedPolicyVersion: input.acceptedPolicyVersion,
          booker: input.booker,
          channel: input.channel,
          attestations: input.attestations,
          provider: provider.name,
          minimumAmount: provider.minimumAmount("USD"),
        });
        if (created.kind !== "created") throw checkoutRefused(created);
        return { checkout: viewJson(staffViewOf(created.session, input.channel)) };
      },
    );
    if (result.status !== 201) throw new Error(`unexpected stored status ${result.status}`);
    const checkout = result.body.checkout as StaffCheckoutView;
    // Committed. Now the provider payment, outside any transaction.
    const ready = await ensureProviderPayment(getDb(c), provider, result.ctx, checkout.id);
    if (ready.kind === "unavailable") {
      c.get("log").warn("payment_provider_unavailable", {
        "event.name": "payment_provider_unavailable",
        "tidegrid.tenant_id": result.ctx.tenantId,
        "error.type": ready.reason,
      });
      throw providerUnavailable();
    }
    if (ready.kind === "not_found") throw new Error("a committed checkout has no payment");
    if (result.replayed) c.header("Idempotent-Replayed", "true");
    return c.json({ checkout, paymentReady: ready.kind === "ready" }, 201);
  });

  // R4 ---------------------------------------------------------------------------------
  const readRoute = createRoute({
    method: "get",
    path: checkoutPath,
    tags: ["staff", "bookings"],
    summary: "A staff-assisted checkout's state",
    description:
      "Owners and booking staff (bookings.create). The state, the amount, the hold's end, the payment's state, the latest test payment asked for, the booking once confirmed, and the refund when a payment could not be honored. An open checkout past its expiry reads as expired. A guest's checkout, another tenant's, an unknown id, and a malformed one answer the same 404.",
    security: staffSecurity,
    request: { params: StaffCheckoutParams },
    responses: {
      200: {
        content: { "application/json": { schema: StaffCheckoutResponse } },
        description: "The checkout",
      },
      ...commonRefusals,
      404: errorBody("No such tenant, or no such staff checkout for it (checkout_not_found)"),
    },
  });

  app.openapi(readRoute, async (c) => {
    const { tenantId, checkoutId } = c.req.valid("param");
    const { body } = await withStaffTenant(
      c,
      deps,
      { tenantId, permission: "bookings.create" },
      async (trx, ctx) => {
        const view = await getStaffCheckout(trx, ctx.tenantId, checkoutId);
        if (!view) throw checkoutNotFound();
        return { checkout: viewJson(view) };
      },
    );
    return c.json(body, 200);
  });

  // R5 ---------------------------------------------------------------------------------
  const cancelRoute = createRoute({
    method: "post",
    path: cancelPath,
    tags: ["staff", "bookings"],
    summary: "Cancel an open staff-assisted checkout",
    description:
      "Owners and booking staff (bookings.create). Releases the held seats at once and voids the order, recorded with the staff member and the reason. Repeating it changes nothing. A confirmed booking is not canceled here. A payment that succeeds afterwards anyway is refunded in full. Idempotent by key.",
    security: staffSecurity,
    request: { params: StaffCheckoutParams, headers: idempotencyHeader },
    responses: {
      200: {
        content: { "application/json": { schema: StaffCheckoutResponse } },
        description: "The canceled checkout",
      },
      ...commonRefusals,
      404: errorBody("No such tenant, or no such staff checkout for it (checkout_not_found)"),
      409: errorBody("The checkout is no longer open (checkout_not_cancelable)"),
      422: errorBody("Idempotency key reused with a different request"),
    },
  });

  app.openapi(cancelRoute, async (c) => {
    const { tenantId, checkoutId } = c.req.valid("param");
    const key = c.req.valid("header")["idempotency-key"];
    const result = await withStaffTenant(
      c,
      deps,
      {
        tenantId,
        permission: "bookings.create",
        idempotency: {
          scope: "staff.checkouts.cancel",
          key,
          route: cancelPath,
          params: { checkoutId },
          body: {},
          successStatus: 200,
        },
      },
      async (trx, ctx) => {
        const canceled = await cancelStaffCheckout(trx, ctx, { sessionId: checkoutId });
        switch (canceled.kind) {
          case "canceled":
          case "unchanged": {
            const view = await getStaffCheckout(trx, ctx.tenantId, checkoutId);
            if (!view) throw new Error("a canceled staff checkout vanished");
            return { checkout: viewJson(view) };
          }
          case "not_cancelable":
            throw new ApiError(
              409,
              "checkout_not_cancelable",
              `This checkout is ${canceled.session.state} and cannot be canceled`,
            );
          case "not_found":
            throw checkoutNotFound();
        }
      },
    );
    if (result.replayed) c.header("Idempotent-Replayed", "true");
    return c.json(result.body, 200);
  });

  // R6 ---------------------------------------------------------------------------------
  const testPaymentRoute = createRoute({
    method: "post",
    path: testPaymentPath,
    tags: ["staff", "bookings", "fake-provider"],
    summary: "Take or decline a test payment for a staff checkout (fake provider only)",
    description: [
      "Owners and booking staff (bookings.create). Exists only when PAYMENT_PROVIDER=fake, which a production configuration refuses; anywhere else it answers 404 not_found. No card is charged.",
      "First, in the request's transaction, the checkout must be open and inside its hold, and the request is recorded with the staff member. Then, after commit: the fake payment settles, once (a payment that already settled keeps its first outcome), and its signed event is posted to the real webhook route, which alone decides the booking. A delivery whose status is not 200 decided nothing yet: send the same request again with the same Idempotency-Key, which posts the same event again; the webhook records each event once.",
    ].join("\n\n"),
    security: staffSecurity,
    request: {
      params: StaffCheckoutParams,
      headers: idempotencyHeader,
      body: {
        required: true,
        content: { "application/json": { schema: StaffTestPaymentRequest } },
      },
    },
    responses: {
      200: {
        content: { "application/json": { schema: StaffTestPaymentResponse } },
        description: "The payment's outcome event and what the webhook answered",
      },
      ...commonRefusals,
      404: errorBody(
        "Not the fake provider (not_found), no such tenant, or no such staff checkout for it (checkout_not_found)",
      ),
      409: errorBody(
        "The checkout is not open or its hold has ended (checkout_not_open), or its payment already settled the other way (test_payment_settled); nothing new is settled",
      ),
      422: errorBody("Idempotency key reused with a different request"),
      503: errorBody("The provider did not answer (payment_provider_unavailable); retry"),
    },
  });

  app.openapi(testPaymentRoute, async (c) => {
    const fake = fakeProviderFor(c);
    if (!fake) throw new ApiError(404, "not_found", "No such route");
    const { tenantId, checkoutId } = c.req.valid("param");
    const input = c.req.valid("json");
    const key = c.req.valid("header")["idempotency-key"];
    // Phase 1, in the request's transaction: refuse, or record who asked.
    const result = await withStaffTenant(
      c,
      deps,
      {
        tenantId,
        permission: "bookings.create",
        idempotency: {
          scope: "staff.checkouts.test_payment",
          key,
          route: testPaymentPath,
          params: { checkoutId },
          body: input,
          successStatus: 200,
        },
      },
      async (trx, ctx) => {
        const asked = await requestStaffTestPayment(trx, ctx, {
          sessionId: checkoutId,
          outcome: input.outcome,
          // How the fake already settled it, read in this transaction: the
          // fake's own storage, beside the checkout, under row-level security.
          settledOutcome: async (paymentRef) => {
            const { rows } = await sql<{ type: string }>`
              select type from fake_provider_events
               where tenant_id = ${ctx.tenantId} and payment_id = ${paymentRef}`.execute(trx);
            return rows[0] ? outcomeOfEvent(rows[0].type) : null;
          },
        });
        switch (asked.kind) {
          case "requested":
            return { checkoutId, outcome: input.outcome };
          case "already_settled":
            throw alreadySettled(asked.outcome);
          case "not_open":
            throw checkoutNotOpen(asked.state);
          case "not_found":
            throw checkoutNotFound();
        }
      },
    );
    // Phase 2, after commit, on every call, replays included: the fake
    // settles in its own transaction and the webhook opens its own
    // connection, so neither can run inside the first.
    const db = getDb(c);
    const found = await inTenantTransaction(db, result.ctx, (trx) =>
      staffCheckoutPaymentRef(trx, tenantId, checkoutId),
    );
    if (!found) throw checkoutNotFound();
    let paymentRef = found.paymentRef;
    if (paymentRef === null) {
      // An earlier open got a 503 from the provider; create the payment now.
      const provider = providerFor(c, deps);
      if (!provider) throw providerUnavailable();
      const ready = await ensureProviderPayment(db, provider, result.ctx, checkoutId);
      switch (ready.kind) {
        case "ready":
          paymentRef = ready.paymentRef;
          break;
        case "unavailable":
          throw providerUnavailable();
        case "not_open":
          throw checkoutNotOpen(ready.state);
        case "not_found":
          throw checkoutNotFound();
      }
    }
    // A settled event is delivered again whatever the checkout's state, so a
    // lost delivery still lands. Nothing new is settled on a checkout that is
    // no longer open or past its hold: a replay skips phase 1's check.
    let event: FakeEvent;
    let wasSettled: boolean;
    try {
      const existing = (await fake.getPayment(tenantId, paymentRef))?.events[0];
      if (existing) {
        event = existing;
        wasSettled = true;
      } else {
        if (!found.open) throw checkoutNotOpen(found.state);
        const settled = await fake.settlePayment(
          tenantId,
          paymentRef,
          input.outcome === "succeed" ? "succeeded" : "failed",
          Date.now(),
        );
        if (settled.kind === "not_found") throw checkoutNotFound();
        event = settled.event;
        wasSettled = settled.kind === "already_settled";
      }
    } catch (err) {
      // The request is recorded; the provider's storage did not answer. Same key again.
      if (err instanceof ProviderUnavailableError) throw providerUnavailable();
      throw err;
    }
    const settledAs = outcomeOfEvent(event.type);
    if (settledAs !== null && settledAs !== input.outcome) {
      // Two requests raced before either settled, and the other one won. The
      // record says so, and this one delivers nothing.
      await inTenantTransaction(db, result.ctx, (trx) =>
        recordStaffTestPaymentSuperseded(trx, result.ctx, {
          sessionId: checkoutId,
          requested: input.outcome,
          settled: settledAs,
        }),
      );
      throw alreadySettled(settledAs);
    }
    const delivery = await deliverFakeEvent(app, c, fake, event);
    if (result.replayed) c.header("Idempotent-Replayed", "true");
    return c.json(
      {
        checkoutId,
        outcome: input.outcome,
        event: { id: event.id, type: event.type, createdAt: event.createdAt },
        alreadySettled: wasSettled,
        delivery,
      },
      200,
    );
  });
}
