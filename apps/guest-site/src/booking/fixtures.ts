/**
 * Test fixtures for the booking page: a Demo Harbor shared-seat cruise and a
 * private charter, shaped exactly as the API returns them, quotes priced as
 * the server prices them, checkout states, and a fake API that records every
 * call. Used by the tests only; nothing in the app imports this file.
 */
import type {
  AvailableTrip,
  CheckoutSession,
  PublicBrand,
  Quote,
  TripOffer,
} from "@tidegrid/contracts";
import { vi } from "vitest";

export const brand: PublicBrand = {
  version: 1,
  name: "Demo Harbor Charters",
  colors: { primary: "#0b3c5d", accent: "#e0a526" },
  fonts: { display: "fraunces", body: "source-sans-3" },
  contact: { phone: "+13055550142", email: "hello@demo-harbor.test" },
  legal: { terms: "/legal/terms", privacy: "/legal/privacy" },
  locale: "en-US",
  capabilities: [],
};

/** Noon on Oct 5 in New York; already Oct 6 in Tokyo, where the tests run. */
export const testNow = new Date("2026-10-05T16:00:00Z");

export const tripId = "a99737eb-69c6-4c43-a430-a33aa4740556";
export const charterTripId = "72e4baf5-b274-46a5-8961-b3fe202d1fd6";
const productId = "6176c6d5-3994-4330-b3f1-6eac4cfed7f1";
const charterProductId = "6176c6d5-3994-4330-b3f1-6eac4cfed7f2";
const stateTax = "0b5f3e2a-1c2d-4e5f-8a9b-0c1d2e3f4a51";
const countyTax = "0b5f3e2a-1c2d-4e5f-8a9b-0c1d2e3f4a52";

const policy: TripOffer["policy"] = {
  version: 1,
  changeCutoffMinutes: 1440,
  changeCutoffAt: "2026-10-06T22:00:00.000Z",
  beforeCutoff: { remedy: "full_refund", refundBp: null },
  afterCutoff: { remedy: "none", refundBp: null },
  noShow: { remedy: "none", refundBp: null },
  text: {
    cancellation: "Cancel at least 24 hours before departure for a full refund.",
    reschedule: "Move to another departure at least 24 hours before your trip.",
    noShow: "Guests who miss the departure are not refunded.",
    operatorCancellation: "If we cancel, you choose a full refund or a credit.",
    weather: "The captain decides on the day whether conditions allow the trip.",
  },
};

/** The Oct 7, 6:00 PM Sunset Harbor Cruise. */
export const offer: TripOffer = {
  tripId,
  product: {
    id: productId,
    name: "Sunset Harbor Cruise",
    kind: "shared_seat",
    minPartySize: 1,
    maxPartySize: 10,
  },
  trip: {
    timeZone: "America/New_York",
    localDate: "2026-10-07",
    localStartTime: "18:00",
    startsAt: "2026-10-07T22:00:00.000Z",
    startsAtLocal: "2026-10-07T18:00:00-04:00",
  },
  currency: "USD",
  priceListVersion: 1,
  tickets: [
    { code: "adult", name: "Adult", unitAmount: 4500, taxable: true },
    { code: "child", name: "Child (3 to 12)", unitAmount: 2500, taxable: true },
    { code: "infant", name: "Infant (under 3)", unitAmount: 0, taxable: false },
  ],
  charter: null,
  addOns: [
    {
      code: "photo",
      name: "Souvenir photo",
      unitAmount: 1200,
      quantityRule: "per_booking",
      maxQuantity: 2,
      taxable: true,
    },
    {
      code: "drinks",
      name: "Drink voucher",
      unitAmount: 800,
      quantityRule: "per_participant",
      maxQuantity: 2,
      taxable: true,
    },
  ],
  fees: [
    {
      code: "harbor_fee",
      name: "Harbor fee",
      unitAmount: 250,
      basis: "per_participant",
      taxable: false,
    },
  ],
  taxes: [
    { name: "County surtax", ratePpm: 10_000, inclusive: false },
    { name: "State sales tax", ratePpm: 60_000, inclusive: false },
  ],
  policy,
};

export const listing: AvailableTrip = {
  tripId,
  timeZone: "America/New_York",
  localDate: "2026-10-07",
  localStartTime: "18:00",
  startsAt: "2026-10-07T22:00:00.000Z",
  endsAt: "2026-10-07T23:30:00.000Z",
  startsAtLocal: "2026-10-07T18:00:00-04:00",
  endsAtLocal: "2026-10-07T19:30:00-04:00",
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
  salesCloseAt: "2026-10-07T21:00:00.000Z",
  capacity: { kind: "seats", total: 20, remaining: 20, soldOut: false },
};

/** The Oct 10, 8:00 AM Private Half-Day Charter. */
export const charterOffer: TripOffer = {
  ...offer,
  tripId: charterTripId,
  product: {
    id: charterProductId,
    name: "Private Half-Day Charter",
    kind: "private_charter",
    minPartySize: 1,
    maxPartySize: 12,
  },
  trip: {
    timeZone: "America/New_York",
    localDate: "2026-10-10",
    localStartTime: "08:00",
    startsAt: "2026-10-10T12:00:00.000Z",
    startsAtLocal: "2026-10-10T08:00:00-04:00",
  },
  tickets: [],
  charter: { name: "Whole boat, up to 12 guests", amount: 120_000, taxable: true },
  addOns: [
    {
      code: "lunch",
      name: "Catered lunch",
      unitAmount: 2500,
      quantityRule: "per_participant",
      maxQuantity: 1,
      taxable: true,
    },
  ],
  fees: [
    { code: "fuel", name: "Fuel surcharge", unitAmount: 7500, basis: "per_booking", taxable: true },
  ],
  policy: {
    ...policy,
    changeCutoffMinutes: 10_080,
    changeCutoffAt: "2026-10-03T12:00:00.000Z",
    afterCutoff: { remedy: "credit", refundBp: null },
  },
};

export const charterListing: AvailableTrip = {
  ...listing,
  tripId: charterTripId,
  localDate: "2026-10-10",
  localStartTime: "08:00",
  startsAt: "2026-10-10T12:00:00.000Z",
  endsAt: "2026-10-10T16:00:00.000Z",
  startsAtLocal: "2026-10-10T08:00:00-04:00",
  endsAtLocal: "2026-10-10T12:00:00-04:00",
  durationMinutes: 240,
  product: {
    id: charterProductId,
    name: "Private Half-Day Charter",
    kind: "private_charter",
    summary: "The whole boat for your group.",
    minPartySize: 1,
    maxPartySize: 12,
  },
  salesCloseAt: "2026-10-09T12:00:00.000Z",
  capacity: { kind: "whole_boat", total: 12, remaining: 12, soldOut: false },
};

let quoteCount = 0;
/** A fresh quote id each call, as the server writes a new quote each time. */
export function nextQuoteId(): string {
  quoteCount += 1;
  return `0b7f3a52-9c1e-4d2a-8f6b-${String(quoteCount).padStart(12, "0")}`;
}

/**
 * 2 adults and 1 child, a souvenir photo and 2 drink vouchers, priced as the
 * server prices them: $143.00, the harbor fee for 3, then 6% and 1% tax, for
 * $160.51. With HARBOR10, 10% off the $115.00 trip price: $148.21.
 */
export function sharedQuote(options: { promotion?: boolean; quoteId?: string } = {}): Quote {
  const promo = options.promotion ?? false;
  const quotedAt = new Date(Date.now()).toISOString();
  const expiresAt = new Date(Date.now() + 30 * 60_000).toISOString();
  const tax = (amount: number, stateAmount: number, countyAmount: number) => [
    {
      taxRateId: countyTax,
      name: "County surtax",
      ratePpm: 10_000,
      inclusive: false,
      taxableAmount: amount,
      amount: countyAmount,
    },
    {
      taxRateId: stateTax,
      name: "State sales tax",
      ratePpm: 60_000,
      inclusive: false,
      taxableAmount: amount,
      amount: stateAmount,
    },
  ];
  const line = (
    lineNo: number,
    kind: Quote["lines"][number]["kind"],
    code: string,
    name: string,
    quantity: number,
    unitAmount: number,
    discountAmount: number,
    taxes: Quote["lines"][number]["taxes"],
  ): Quote["lines"][number] => ({
    lineNo,
    kind,
    code,
    name,
    basis: kind === "fee" || kind === "add_on" ? "per_booking" : null,
    quantity,
    unitAmount,
    amount: quantity * unitAmount,
    discountAmount,
    taxable: taxes.length > 0,
    taxes,
  });
  const lines: Quote["lines"] = promo
    ? [
        line(1, "ticket", "adult", "Adult", 2, 4500, 900, tax(8100, 486, 81)),
        line(2, "ticket", "child", "Child (3 to 12)", 1, 2500, 250, tax(2250, 135, 23)),
        line(3, "add_on", "photo", "Souvenir photo", 1, 1200, 0, tax(1200, 72, 12)),
        line(4, "add_on", "drinks", "Drink voucher", 2, 800, 0, tax(1600, 96, 16)),
        line(5, "fee", "harbor_fee", "Harbor fee", 3, 250, 0, []),
        {
          lineNo: 6,
          kind: "discount",
          code: "HARBOR10",
          name: "HARBOR10, 10% off",
          basis: null,
          quantity: 1,
          unitAmount: 1150,
          amount: -1150,
          discountAmount: 0,
          taxable: false,
          taxes: [],
        },
      ]
    : [
        line(1, "ticket", "adult", "Adult", 2, 4500, 0, tax(9000, 540, 90)),
        line(2, "ticket", "child", "Child (3 to 12)", 1, 2500, 0, tax(2500, 150, 25)),
        line(3, "add_on", "photo", "Souvenir photo", 1, 1200, 0, tax(1200, 72, 12)),
        line(4, "add_on", "drinks", "Drink voucher", 2, 800, 0, tax(1600, 96, 16)),
        line(5, "fee", "harbor_fee", "Harbor fee", 3, 250, 0, []),
      ];
  const totals = promo
    ? {
        subtotal: 14_300,
        discount: 1150,
        fees: 750,
        tax: 921,
        includedTax: 0,
        total: 14_821,
        amountDueNow: 14_821,
      }
    : {
        subtotal: 14_300,
        discount: 0,
        fees: 750,
        tax: 1001,
        includedTax: 0,
        total: 16_051,
        amountDueNow: 16_051,
      };
  return {
    quoteId: options.quoteId ?? nextQuoteId(),
    tripId,
    product: { id: productId, name: "Sunset Harbor Cruise", kind: "shared_seat" },
    trip: offer.trip,
    partySize: 3,
    currency: "USD",
    priceListVersion: 1,
    lines,
    taxes: [
      {
        taxRateId: countyTax,
        version: 1,
        name: "County surtax",
        ratePpm: 10_000,
        inclusive: false,
        taxableAmount: promo ? 13_150 : 14_300,
        amount: promo ? 132 : 143,
      },
      {
        taxRateId: stateTax,
        version: 1,
        name: "State sales tax",
        ratePpm: 60_000,
        inclusive: false,
        taxableAmount: promo ? 13_150 : 14_300,
        amount: promo ? 789 : 858,
      },
    ],
    promotion: promo
      ? {
          code: "HARBOR10",
          version: 1,
          discountKind: "percent",
          amountOff: null,
          percentOffBp: 1000,
        }
      : null,
    totals,
    policy,
    quotedAt,
    expiresAt,
  };
}

/** The charter for 6 guests, with the fuel surcharge and 7% tax: $1,364.25. */
export function charterQuote(): Quote {
  const quotedAt = new Date(Date.now()).toISOString();
  const expiresAt = new Date(Date.now() + 30 * 60_000).toISOString();
  return {
    quoteId: nextQuoteId(),
    tripId: charterTripId,
    product: { id: charterProductId, name: "Private Half-Day Charter", kind: "private_charter" },
    trip: charterOffer.trip,
    partySize: 6,
    currency: "USD",
    priceListVersion: 1,
    lines: [
      {
        lineNo: 1,
        kind: "charter",
        code: "charter",
        name: "Whole boat, up to 12 guests",
        basis: null,
        quantity: 1,
        unitAmount: 120_000,
        amount: 120_000,
        discountAmount: 0,
        taxable: true,
        taxes: [],
      },
      {
        lineNo: 2,
        kind: "fee",
        code: "fuel",
        name: "Fuel surcharge",
        basis: "per_booking",
        quantity: 1,
        unitAmount: 7500,
        amount: 7500,
        discountAmount: 0,
        taxable: true,
        taxes: [],
      },
    ],
    taxes: [
      {
        taxRateId: stateTax,
        version: 1,
        name: "State sales tax",
        ratePpm: 70_000,
        inclusive: false,
        taxableAmount: 127_500,
        amount: 8925,
      },
    ],
    promotion: null,
    totals: {
      subtotal: 120_000,
      discount: 0,
      fees: 7500,
      tax: 8925,
      includedTax: 0,
      total: 136_425,
      amountDueNow: 136_425,
    },
    policy: charterOffer.policy,
    quotedAt,
    expiresAt,
  };
}

let sessionCount = 0;
export function nextSessionId(): string {
  sessionCount += 1;
  return `5d0c4a1e-2b3c-4d5e-8f60-${String(sessionCount).padStart(12, "0")}`;
}

/** A checkout as the guest sees it. */
export function checkout(
  state: CheckoutSession["state"],
  fields: Partial<CheckoutSession> = {},
): CheckoutSession {
  return {
    id: fields.id ?? "5d0c4a1e-2b3c-4d5e-8f60-000000000000",
    state,
    quoteId: fields.quoteId ?? "0b7f3a52-9c1e-4d2a-8f6b-000000000000",
    tripId,
    partySize: 3,
    amount: 16_051,
    currency: "USD",
    expiresAt: new Date(Date.now() + 15 * 60_000).toISOString(),
    createdAt: new Date(Date.now()).toISOString(),
    booking: state === "confirmed" ? { reference: "C03G4ZFJ" } : null,
    refund: null,
    ...fields,
  };
}

export const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

export const refusal = (status: number, code: string, message = "Refused") =>
  json({ error: { code, message, requestId: "req_test" } }, status);

/** One call the page made, as the API saw it. */
export interface Call {
  method: string;
  url: string;
  path: string;
  search: URLSearchParams;
  headers: Headers;
  body: unknown;
}

export type Route =
  | "offer"
  | "listing"
  | "createQuote"
  | "getQuote"
  | "openCheckout"
  | "readCheckout"
  | "cancel"
  | "succeed"
  | "fail";

export function routeOf(call: Pick<Call, "method" | "path">): Route {
  const { method, path } = call;
  if (method === "GET" && /^\/v1\/public\/trips\/[^/]+\/offer$/.test(path)) return "offer";
  if (method === "GET" && path === "/v1/public/trips") return "listing";
  if (method === "POST" && path === "/v1/public/quotes") return "createQuote";
  if (method === "GET" && path.startsWith("/v1/public/quotes/")) return "getQuote";
  if (method === "POST" && path === "/v1/public/checkout-sessions") return "openCheckout";
  if (method === "POST" && path.endsWith("/cancel")) return "cancel";
  if (method === "GET" && path.startsWith("/v1/public/checkout-sessions/")) return "readCheckout";
  if (method === "POST" && path.endsWith("/succeed")) return "succeed";
  if (method === "POST" && path.endsWith("/fail")) return "fail";
  throw new Error(`unexpected request ${method} ${path}`);
}

export type Answer = (call: Call) => Response | Promise<Response>;

/** Answers in order; the last one repeats. */
export function inOrder(...answers: Answer[]): Answer {
  let index = 0;
  return (call) => {
    const answer = answers[Math.min(index, answers.length - 1)];
    index += 1;
    if (!answer) throw new Error("no answer");
    return answer(call);
  };
}

/** A network failure: fetch rejects. */
export const offline: Answer = () => Promise.reject(new TypeError("Failed to fetch"));

/** An answer the test releases when it chooses. */
export function held(): { answer: Answer; release: (res: Response) => void } {
  let release: (res: Response) => void = () => {};
  const promise = new Promise<Response>((resolve) => {
    release = resolve;
  });
  return { answer: () => promise, release };
}

/**
 * Stub fetch with one answer per route. Unlisted routes answer with the
 * Harbor cruise's offer and listing, a fresh quote, and an open checkout.
 */
export function stubApi(routes: Partial<Record<Route, Answer>> = {}): Call[] {
  const calls: Call[] = [];
  const defaults: Record<Route, Answer> = {
    offer: () => json({ offer }),
    listing: () => json({ trips: [listing] }),
    createQuote: (call) =>
      json(
        {
          quote: sharedQuote({
            promotion: Boolean((call.body as { promotionCode?: string }).promotionCode),
          }),
        },
        201,
      ),
    getQuote: () => refusal(404, "quote_not_found"),
    openCheckout: (call) => {
      const body = call.body as { quoteId: string };
      return json(
        {
          checkoutSession: checkout("open", { id: nextSessionId(), quoteId: body.quoteId }),
          payment: {
            provider: "fake",
            paymentRef: "fpay_test_1",
            clientSecret: "fpay_test_1_secret_abc123",
          },
        },
        201,
      );
    },
    readCheckout: () => json({ checkoutSession: checkout("open") }),
    cancel: () => json({ checkoutSession: checkout("canceled") }),
    succeed: () =>
      json({
        event: { id: "evt_1", type: "payment.succeeded", createdAt: new Date().toISOString() },
        alreadySettled: false,
        delivery: { status: 200, outcome: "confirmed", duplicate: false },
      }),
    fail: () =>
      json({
        event: { id: "evt_2", type: "payment.failed", createdAt: new Date().toISOString() },
        alreadySettled: false,
        delivery: { status: 200, outcome: "released", duplicate: false },
      }),
  };
  const fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    const call: Call = {
      method: init?.method ?? "GET",
      url: String(input),
      path: url.pathname,
      search: url.searchParams,
      headers: new Headers(init?.headers),
      body: init?.body ? JSON.parse(String(init.body)) : undefined,
    };
    calls.push(call);
    if (init?.credentials !== "omit") throw new Error("credentials must be omitted");
    const route = routeOf(call);
    return (routes[route] ?? defaults[route])(call);
  });
  vi.stubGlobal("fetch", fetch);
  return calls;
}

/** The calls to one route. */
export const callsTo = (calls: Call[], route: Route) => calls.filter((c) => routeOf(c) === route);
