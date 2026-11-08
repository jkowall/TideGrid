import type { BrowserContext, Page, Request, Route } from "@playwright/test";
import {
  CheckoutPaymentResponse,
  type CheckoutSession,
  CheckoutSessionCreateResponse,
  CheckoutSessionResponse,
  PublicExperienceResponse,
  QuoteResponse,
  TripAvailabilityResponse,
  TripOfferResponse,
} from "@tidegrid/contracts";

/**
 * Part A's Stripe pay step (W1-STRIPE-ELEMENT): a fake guest API and a
 * double of Stripe.js, both answered inside the browser through Playwright
 * routes. Nothing reaches the API, a database, or Stripe: every request to a
 * Stripe host but the one script is aborted and counted, and the script
 * Playwright serves at Stripe.js's address is this file's double. The page's
 * own loader and its real CSP run unchanged. Every answer is parsed against
 * the contract before it is served, so the double cannot drift from it.
 */

export const API_ORIGIN = "http://localhost:8961";
export const STRIPE_JS = "https://js.stripe.com/v3/";

// Synthetic, built at run time: never a real key or account.
export const publishableKey = `pk_test_${"E".repeat(32)}`;
export const account = "acct_1TestHarbor0000";
export const paymentRef = "pi_E2E00000000000000001";
export const clientSecret = `${paymentRef}_secret_${"e".repeat(24)}`;

export const tripId = "a99737eb-69c6-4c43-a430-a33aa4740556";
const productId = "6176c6d5-3994-4330-b3f1-6eac4cfed7f1";
const sessionId = "5d0c4a1e-2b3c-4d5e-8f60-0000000000e2";
const quoteId = "0b7f3a52-9c1e-4d2a-8f6b-0000000000e2";

const day = 24 * 60 * 60_000;
const iso = (ms: number) => new Date(ms).toISOString();

/** Three days out at 18:00 UTC, on a marina that keeps UTC, so no offset arithmetic. */
function tripTimes() {
  const start = new Date(Date.now() + 3 * day);
  start.setUTCHours(18, 0, 0, 0);
  const localDate = start.toISOString().slice(0, 10);
  return {
    timeZone: "UTC",
    localDate,
    localStartTime: "18:00",
    startsAt: start.toISOString(),
    startsAtLocal: `${localDate}T18:00:00+00:00`,
    endsAt: iso(start.getTime() + 90 * 60_000),
    endsAtLocal: `${localDate}T19:30:00+00:00`,
  };
}

const policyText = {
  cancellation: "Cancel at least 24 hours before departure for a full refund.",
  reschedule: "Move to another departure at least 24 hours before your trip.",
  noShow: "Guests who miss the departure are not refunded.",
  operatorCancellation: "If we cancel, you choose a full refund or a credit.",
  weather: "The captain decides on the day whether conditions allow the trip.",
};

function offer() {
  const t = tripTimes();
  return TripOfferResponse.parse({
    offer: {
      tripId,
      product: {
        id: productId,
        name: "Sunset Harbor Cruise",
        kind: "shared_seat",
        minPartySize: 1,
        maxPartySize: 10,
      },
      trip: {
        timeZone: t.timeZone,
        localDate: t.localDate,
        localStartTime: t.localStartTime,
        startsAt: t.startsAt,
        startsAtLocal: t.startsAtLocal,
      },
      currency: "USD",
      priceListVersion: 1,
      tickets: [{ code: "adult", name: "Adult", unitAmount: 4500, taxable: false }],
      charter: null,
      addOns: [],
      fees: [],
      taxes: [],
      policy: {
        version: 1,
        changeCutoffMinutes: 1440,
        changeCutoffAt: iso(Date.parse(t.startsAt) - day),
        beforeCutoff: { remedy: "full_refund", refundBp: null },
        afterCutoff: { remedy: "none", refundBp: null },
        noShow: { remedy: "none", refundBp: null },
        text: policyText,
      },
    },
  });
}

function listing() {
  const t = tripTimes();
  return TripAvailabilityResponse.parse({
    trips: [
      {
        tripId,
        timeZone: t.timeZone,
        localDate: t.localDate,
        localStartTime: t.localStartTime,
        startsAt: t.startsAt,
        endsAt: t.endsAt,
        startsAtLocal: t.startsAtLocal,
        endsAtLocal: t.endsAtLocal,
        durationMinutes: 90,
        product: {
          id: productId,
          name: "Sunset Harbor Cruise",
          kind: "shared_seat",
          summary: "Ninety minutes along the harbor at golden hour.",
          minPartySize: 1,
          maxPartySize: 10,
        },
        location: { name: "Harbor Marina, Dock C", meetingPoint: "Dock C, slip 14" },
        salesCloseAt: iso(Date.parse(t.startsAt) - 60 * 60_000),
        capacity: { kind: "seats", total: 20, remaining: 20, soldOut: false },
      },
    ],
  });
}

function quote() {
  const o = offer().offer;
  return QuoteResponse.parse({
    quote: {
      quoteId,
      tripId,
      product: { id: productId, name: "Sunset Harbor Cruise", kind: "shared_seat" },
      trip: o.trip,
      partySize: 2,
      currency: "USD",
      priceListVersion: 1,
      lines: [
        {
          lineNo: 1,
          kind: "ticket",
          code: "adult",
          name: "Adult",
          basis: null,
          quantity: 2,
          unitAmount: 4500,
          amount: 9000,
          discountAmount: 0,
          taxable: false,
          taxes: [],
        },
      ],
      taxes: [],
      promotion: null,
      totals: {
        subtotal: 9000,
        discount: 0,
        fees: 0,
        tax: 0,
        includedTax: 0,
        total: 9000,
        amountDueNow: 9000,
      },
      policy: o.policy,
      quotedAt: iso(Date.now()),
      expiresAt: iso(Date.now() + 30 * 60_000),
    },
  });
}

/** What the fake API does, set per test. */
export interface ApiScript {
  /** How long the checkout holds; 15 minutes by default. */
  holdMs?: number;
  /** The checkout's state on each read after a payment was sent; the last repeats. */
  afterPayment?: CheckoutSession["state"][];
  /** The state a read answers once the hold has run out. */
  afterExpiry?: CheckoutSession["state"];
  /** Released by the test, for a loading state it can see. */
  holdPaymentRead?: Promise<void>;
}

export interface FakeApi {
  /** Each API request, method and path, in order. */
  calls: { method: string; path: string; authorization: string | null }[];
  /** Requests that tried to reach a Stripe host other than the double. */
  stripeAttempts: string[];
  /** The page has sent a payment: reads move through `afterPayment`. */
  markPaid: () => void;
  /** Stripe.js answers 503 until this is called. */
  allowStripeJs: () => void;
}

const cors = {
  "access-control-allow-origin": "*",
  "access-control-allow-headers": "accept, content-type, authorization, idempotency-key",
  "access-control-allow-methods": "GET, POST, OPTIONS",
};

const reply = (route: Route, status: number, body: unknown) =>
  route.fulfill({
    status,
    headers: { ...cors, "content-type": "application/json", "cache-control": "no-store" },
    body: JSON.stringify(body),
  });

/** The fake API for one page: bootstrap, trip, quote, checkout, and the payment read. */
export async function installFakeApi(
  context: BrowserContext,
  page: Page,
  slug: string,
  name: string,
  script: ApiScript = {},
  options: { stripeJs?: "serve" | "fail-until-allowed" } = {},
): Promise<FakeApi> {
  const calls: FakeApi["calls"] = [];
  const stripeAttempts: string[] = [];
  let paid = false;
  let reads = 0;
  let stripeAllowed = options.stripeJs !== "fail-until-allowed";
  const created = Date.now();
  let expiresAt = created + (script.holdMs ?? 15 * 60_000);

  const session = (state: CheckoutSession["state"]): CheckoutSession => ({
    id: sessionId,
    state,
    quoteId,
    tripId,
    partySize: 2,
    amount: 9000,
    currency: "USD",
    expiresAt: iso(expiresAt),
    createdAt: iso(created),
    booking: state === "confirmed" ? { reference: "C03G4ZFJ" } : null,
    refund: null,
  });

  const stateNow = (): CheckoutSession["state"] => {
    if (paid) {
      const states = script.afterPayment ?? ["open", "confirmed"];
      const state = states[Math.min(reads, states.length - 1)] ?? "open";
      reads += 1;
      return state;
    }
    if (Date.now() >= expiresAt) return script.afterExpiry ?? "expired";
    return "open";
  };

  // Every Stripe host is refused, and counted, except the one script below.
  await context.route(/^https:\/\/([a-z0-9-]+\.)*(stripe\.com|stripe\.network)\//, (route) => {
    stripeAttempts.push(route.request().url());
    return route.abort();
  });
  await context.route(STRIPE_JS, (route) =>
    stripeAllowed
      ? route.fulfill({
          status: 200,
          headers: { "content-type": "text/javascript; charset=utf-8" },
          body: stripeJsDouble,
        })
      : route.fulfill({ status: 503, body: "" }),
  );

  await page.route(`${API_ORIGIN}/**`, async (route: Route, request: Request) => {
    const url = new URL(request.url());
    const method = request.method();
    if (method === "OPTIONS") {
      return route.fulfill({ status: 204, headers: { ...cors, "access-control-max-age": "60" } });
    }
    calls.push({
      method,
      path: url.pathname,
      authorization: request.headers().authorization ?? null,
    });
    const path = url.pathname;
    if (path === "/v1/public/tenant") {
      return reply(
        route,
        200,
        PublicExperienceResponse.parse({
          tenant: { slug, name },
          brand: {
            version: 1,
            name,
            colors: { primary: "#0b3c5d", accent: "#e0a526" },
            fonts: { display: "fraunces", body: "source-sans-3" },
            contact: { phone: "+13055550142", email: "hello@demo-harbor.test" },
            legal: { terms: "/legal/terms", privacy: "/legal/privacy" },
            locale: "en-US",
            capabilities: [],
          },
        }),
      );
    }
    if (path === `/v1/public/trips/${tripId}/offer`) return reply(route, 200, offer());
    if (path === "/v1/public/trips") return reply(route, 200, listing());
    if (method === "POST" && path === "/v1/public/quotes") return reply(route, 201, quote());
    if (method === "POST" && path === "/v1/public/checkout-sessions") {
      expiresAt = Date.now() + (script.holdMs ?? 15 * 60_000);
      return reply(
        route,
        201,
        CheckoutSessionCreateResponse.parse({
          checkoutSession: session("open"),
          // Opening answers the client secret, never the key or the account.
          payment: { provider: "stripe", paymentRef, clientSecret },
        }),
      );
    }
    if (path === `/v1/public/checkout-sessions/${sessionId}/payment`) {
      if (script.holdPaymentRead) await script.holdPaymentRead;
      const state = Date.now() >= expiresAt ? (script.afterExpiry ?? "expired") : "open";
      return reply(
        route,
        200,
        CheckoutPaymentResponse.parse({
          checkoutSession: session(state),
          payment:
            state === "open"
              ? {
                  provider: "stripe",
                  paymentRef,
                  clientSecret,
                  stripe: { publishableKey, account },
                }
              : null,
        }),
      );
    }
    if (method === "POST" && path === `/v1/public/checkout-sessions/${sessionId}/cancel`) {
      return reply(
        route,
        200,
        CheckoutSessionResponse.parse({ checkoutSession: session("canceled") }),
      );
    }
    if (path === `/v1/public/checkout-sessions/${sessionId}`) {
      return reply(
        route,
        200,
        CheckoutSessionResponse.parse({ checkoutSession: session(stateNow()) }),
      );
    }
    return reply(route, 404, {
      error: { code: "not_found", message: "Not in this test", requestId: "e2e" },
    });
  });

  return {
    calls,
    stripeAttempts,
    markPaid: () => {
      paid = true;
    },
    allowStripeJs: () => {
      stripeAllowed = true;
    },
  };
}

/**
 * The script served at Stripe.js's address. `window.Stripe(key, options)`
 * records what the page passed and draws a card form of plain fields, each
 * 44 px tall, in the page's own document. Confirmations answer from
 * `window.__stripeDouble.answers`, which a test sets: "succeeded",
 * "card_declined", "expired_card", or "unknown" (a rejected promise). It
 * never charges, never calls out, and never sees the checkout secret.
 */
const stripeJsDouble = `(() => {
  const state = (window.__stripeDouble = window.__stripeDouble || { answers: ["succeeded"] });
  state.factory = [];
  state.elements = [];
  state.created = [];
  state.confirms = 0;
  window.Stripe = function (key, options) {
    state.factory.push({ key, options });
    return {
      elements(elementsOptions) {
        state.elements.push({ clientSecret: elementsOptions.clientSecret });
        return {
          create(type, createOptions) {
            state.created.push({ type, options: createOptions });
            const handlers = {};
            let root = null;
            return {
              mount(target) {
                root = document.createElement("div");
                for (const label of ["Card number", "Expiration date", "Security code"]) {
                  const field = document.createElement("input");
                  field.setAttribute("aria-label", label);
                  field.className = "stripe-double-field";
                  field.style.height = "44px";
                  field.style.boxSizing = "border-box";
                  field.style.width = "100%";
                  root.append(field);
                }
                target.append(root);
                setTimeout(() => handlers.ready && handlers.ready(), 50);
              },
              on(event, handler) { handlers[event] = handler; },
              focus() { root && root.querySelector("input") && root.querySelector("input").focus(); },
              destroy() { root && root.remove(); },
            };
          },
          submit() { return Promise.resolve({}); },
        };
      },
      confirmPayment() {
        const answers = state.answers;
        const answer = answers[Math.min(state.confirms, answers.length - 1)];
        state.confirms += 1;
        if (answer === "unknown") return Promise.reject(new TypeError("Failed to fetch"));
        if (answer === "succeeded") return Promise.resolve({ paymentIntent: { status: "succeeded" } });
        return Promise.resolve({ error: { type: "card_error", code: answer } });
      },
    };
  };
})();`;
