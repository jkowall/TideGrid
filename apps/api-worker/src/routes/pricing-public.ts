import { createRoute, type OpenAPIHono, z } from "@hono/zod-openapi";
import {
  IdempotencyKey,
  PublicTripParams,
  QuoteCreateRequest,
  QuoteParams,
  QuoteResponse,
  TripOfferResponse,
} from "@tidegrid/contracts";
import { createQuote, getQuote, getTripOffer, type QuoteProblem } from "@tidegrid/domain-pricing";
import type { AppDeps, AppEnv } from "../context.ts";
import { ApiError } from "../errors.ts";
import { withPublicTenant } from "../public-tenant.ts";
import { errorBody } from "./responses.ts";

const offerPath = "/v1/public/trips/{tripId}/offer";
const quotesPath = "/v1/public/quotes";
const quotePath = "/v1/public/quotes/{quoteId}";

const tripNotFound = () => new ApiError(404, "trip_not_found", "No such trip at this address");
const tripNotOnSale = () => new ApiError(409, "trip_not_bookable", "This trip is not on sale now");
const pricingUnavailable = () =>
  new ApiError(409, "pricing_unavailable", "This trip cannot be priced yet");

/**
 * The first problem is the error code; the message lists every problem with
 * the ticket type or add-on it is about. Promotion problems share one code
 * whatever the reason, so codes cannot be probed.
 */
function quoteRejected(problems: readonly QuoteProblem[]): ApiError {
  const code = problems[0]?.code ?? "pricing_unavailable";
  const status = code === "insufficient_capacity" || code === "pricing_unavailable" ? 409 : 422;
  const detail = problems.map((p) => (p.subject ? `${p.code} (${p.subject})` : p.code)).join(", ");
  return new ApiError(status, code, `This quote cannot be priced: ${detail}`);
}

export function registerPricingPublicRoutes(app: OpenAPIHono<AppEnv>, deps: AppDeps) {
  const now = () => deps.now?.() ?? new Date();

  const offerRoute = createRoute({
    method: "get",
    path: offerPath,
    tags: ["public", "pricing"],
    summary: "What the calling site's operator sells for one trip",
    description:
      "Resolves the browser Origin as /v1/public/trips does. For a trip on sale now: its ticket types or charter price, the add-ons offered on its date, mandatory fees, active tax rates, and the cancellation policy, under the current versions. Grants no permission and never reveals another tenant's trips.",
    request: { params: PublicTripParams },
    responses: {
      200: {
        content: { "application/json": { schema: TripOfferResponse } },
        description: "The trip's offer",
      },
      404: errorBody("No active tenant hostname matches the origin, or no such trip"),
      409: errorBody(
        "The trip is not on sale now (trip_not_bookable) or has no price list or policy (pricing_unavailable)",
      ),
    },
  });

  app.openapi(offerRoute, async (c) => {
    const { tripId } = c.req.valid("param");
    const { body } = await withPublicTenant(c, {}, async (trx, ctx) => {
      const result = await getTripOffer(trx, ctx.tenantId, tripId, now());
      switch (result.kind) {
        case "offer":
          return { offer: result.offer };
        case "trip_not_found":
          throw tripNotFound();
        case "trip_not_on_sale":
          throw tripNotOnSale();
        case "pricing_unavailable":
          throw pricingUnavailable();
      }
    });
    // Prices feed checkout, so they are never served from a cache.
    c.header("Cache-Control", "no-store");
    c.header("Vary", "Origin");
    return c.json(body, 200);
  });

  const createQuoteRoute = createRoute({
    method: "post",
    path: quotesPath,
    tags: ["public", "pricing"],
    summary: "Price a party on a trip and keep the quote",
    description:
      "Resolves the browser Origin as /v1/public/trips does. Prices the party, add-ons, and optional promotion code on the server under the current versions and stores an immutable quote that names every version it used. Idempotent by key: a retry with the same key and body replays the first response with `Idempotent-Replayed: true`; the same key with another body answers 422.",
    request: {
      headers: z.object({ "idempotency-key": IdempotencyKey }),
      body: { required: true, content: { "application/json": { schema: QuoteCreateRequest } } },
    },
    responses: {
      201: {
        content: { "application/json": { schema: QuoteResponse } },
        description: "The stored quote (or the stored response replayed)",
      },
      400: errorBody("Request did not match the contract"),
      404: errorBody("No active tenant hostname matches the origin, or no such trip"),
      409: errorBody(
        "The trip is not on sale now (trip_not_bookable), has no price list or policy (pricing_unavailable), or has too few seats left (insufficient_capacity)",
      ),
      422: errorBody(
        "The party, add-ons, or promotion code cannot be priced (the code names the first problem; see QuoteProblemCode), or the idempotency key was reused with another request",
      ),
    },
  });

  app.openapi(createQuoteRoute, async (c) => {
    const input = c.req.valid("json");
    const key = c.req.valid("header")["idempotency-key"];
    const result = await withPublicTenant(
      c,
      {
        idempotency: {
          scope: "public.quotes.create",
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
    c.header("Cache-Control", "no-store");
    c.header("Vary", "Origin");
    return c.json(result.body, 201);
  });

  const readQuoteRoute = createRoute({
    method: "get",
    path: quotePath,
    tags: ["public", "pricing"],
    summary: "A stored quote, exactly as it was priced",
    description:
      "Resolves the browser Origin as /v1/public/trips does and returns the quote if it belongs to that tenant. Later price, tax, promotion, or policy changes never alter it; expiresAt says until when checkout may use it. Another tenant's quote and a malformed id answer the same 404.",
    request: { params: QuoteParams },
    responses: {
      200: {
        content: { "application/json": { schema: QuoteResponse } },
        description: "The quote",
      },
      404: errorBody("No active tenant hostname matches the origin, or no such quote"),
    },
  });

  app.openapi(readQuoteRoute, async (c) => {
    const { quoteId } = c.req.valid("param");
    const { body } = await withPublicTenant(c, {}, async (trx, ctx) => {
      const quote = await getQuote(trx, ctx.tenantId, quoteId);
      if (!quote) throw new ApiError(404, "quote_not_found", "No such quote at this address");
      return { quote };
    });
    c.header("Cache-Control", "no-store");
    c.header("Vary", "Origin");
    return c.json(body, 200);
  });
}
