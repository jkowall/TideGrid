/**
 * Public API response builders for the release tool tests. Each one returns a
 * complete body for one public route and passes it through that route's
 * contract schema, so a builder that drifts from the contract throws instead
 * of letting a test mock hide the drift. Synthetic data only. Tests only;
 * nothing in src imports this file.
 */
import {
  type AvailableTrip,
  type BookingCancellation,
  type BookingRefund,
  CancelBookingResponse,
  type CancellationTerms,
  CancellationTermsResponse,
  type CheckoutPayment,
  type CheckoutSession,
  CheckoutSessionCreateResponse,
  CheckoutSessionResponse,
  type CheckoutSessionState,
  type ManagedBooking,
  ManagedBookingResponse,
  ManageSessionResponse,
  type PolicyTerms,
  type ProductKind,
  type Quote,
  QuoteResponse,
  TripAvailabilityResponse,
  type TripOffer,
  TripOfferResponse,
} from "@tidegrid/contracts";

export const ids = {
  trip: "11111111-1111-4111-8111-111111111111",
  quote: "22222222-2222-4222-8222-222222222222",
  checkout: "33333333-3333-4333-8333-333333333333",
  product: "44444444-4444-4444-8444-444444444444",
  booking: "55555555-5555-4555-8555-555555555555",
  order: "66666666-6666-4666-8666-666666666666",
  taxRate: "77777777-7777-4777-8777-777777777777",
} as const;

export const syntheticReference = "ABCD2345";
const bookedAt = "2026-11-04T15:00:00.000Z";
const quotedAt = "2026-11-04T15:05:00.000Z";
const expiresAt = "2026-11-04T15:35:00.000Z";
const zone = "America/New_York";
const tzOffset = "-05:00";
const boat = "Sea Lark";
const productName = "Sunset Harbor Cruise";

function timing(localDate: string) {
  return {
    timeZone: zone,
    localDate,
    localStartTime: "17:00",
    startsAt: `${localDate}T22:00:00.000Z`,
    startsAtLocal: `${localDate}T17:00:00${tzOffset}`,
  };
}

// Trips -----------------------------------------------------------------------------------

export type TripsOver = {
  tripId?: string;
  localDate?: string;
  productName?: string;
  kind?: ProductKind;
  capacity?: number;
};

export function tripsResponse(over: TripsOver = {}): TripAvailabilityResponse {
  const localDate = over.localDate ?? "2026-11-06";
  const kind = over.kind ?? "shared_seat";
  const total = over.capacity ?? 20;
  const trip: AvailableTrip = {
    tripId: over.tripId ?? ids.trip,
    ...timing(localDate),
    endsAt: `${localDate}T23:30:00.000Z`,
    endsAtLocal: `${localDate}T18:30:00${tzOffset}`,
    durationMinutes: 90,
    product: {
      id: ids.product,
      name: over.productName ?? productName,
      kind,
      summary: "A 90 minute cruise around the harbor at sunset.",
      minPartySize: 1,
      maxPartySize: 20,
    },
    location: { name: "Harbor Marina, Dock C", meetingPoint: "Dock C, slip 14" },
    salesCloseAt: `${localDate}T20:00:00.000Z`,
    capacity: {
      kind: kind === "shared_seat" ? "seats" : "whole_boat",
      total,
      remaining: total,
      soldOut: false,
    },
  };
  return TripAvailabilityResponse.parse({ trips: [trip] });
}

// Offer -----------------------------------------------------------------------------------

function policyTerms(version: number): PolicyTerms {
  const text = "Cancel at least 24 hours before departure for a full refund.";
  return {
    version,
    changeCutoffMinutes: 1440,
    changeCutoffAt: "2026-11-05T22:00:00.000Z",
    beforeCutoff: { remedy: "full_refund", refundBp: null },
    afterCutoff: { remedy: "none", refundBp: null },
    noShow: { remedy: "none", refundBp: null },
    text: {
      cancellation: text,
      reschedule: "Rescheduling follows the cancellation terms.",
      noShow: "No refund for a no-show.",
      operatorCancellation: "If we cancel, you get a full refund.",
      weather: "Unsafe weather means a full refund or a new date.",
    },
  };
}

export type OfferOver = { tripId?: string; ticketCodes?: string[]; policyVersion?: number };

export function offerResponse(over: OfferOver = {}): TripOfferResponse {
  const localDate = "2026-11-06";
  const offer: TripOffer = {
    tripId: over.tripId ?? ids.trip,
    product: {
      id: ids.product,
      name: productName,
      kind: "shared_seat",
      minPartySize: 1,
      maxPartySize: 20,
    },
    trip: timing(localDate),
    currency: "USD",
    priceListVersion: 1,
    tickets: (over.ticketCodes ?? ["adult"]).map((code) => ({
      code,
      name: code.charAt(0).toUpperCase() + code.slice(1),
      unitAmount: 6500,
      taxable: true,
    })),
    charter: null,
    addOns: [],
    fees: [],
    taxes: [],
    deposit: { kind: "none" },
    policy: policyTerms(over.policyVersion ?? 1),
  };
  return TripOfferResponse.parse({ offer });
}

// Quote -----------------------------------------------------------------------------------

export type QuoteOver = { quoteId?: string; tripId?: string; policyVersion?: number };

export function quoteResponse(over: QuoteOver = {}): QuoteResponse {
  const localDate = "2026-11-06";
  const quote: Quote = {
    quoteId: over.quoteId ?? ids.quote,
    tripId: over.tripId ?? ids.trip,
    product: { id: ids.product, name: productName, kind: "shared_seat" },
    trip: timing(localDate),
    partySize: 1,
    currency: "USD",
    priceListVersion: 1,
    lines: [
      {
        lineNo: 1,
        kind: "ticket",
        code: "adult",
        name: "Adult",
        basis: null,
        quantity: 1,
        unitAmount: 6500,
        amount: 6500,
        discountAmount: 0,
        taxable: true,
        taxes: [],
      },
    ],
    taxes: [],
    promotion: null,
    totals: {
      subtotal: 6500,
      discount: 0,
      fees: 0,
      tax: 0,
      includedTax: 0,
      total: 6500,
      amountDueNow: 6500,
    },
    deposit: null,
    policy: policyTerms(over.policyVersion ?? 1),
    quotedAt,
    expiresAt,
  };
  return QuoteResponse.parse({ quote });
}

// Checkout --------------------------------------------------------------------------------

export type CheckoutOver = {
  id?: string;
  quoteId?: string;
  tripId?: string;
  state?: CheckoutSessionState;
};

function checkoutSession(over: CheckoutOver): CheckoutSession {
  const state = over.state ?? "open";
  return {
    id: over.id ?? ids.checkout,
    state,
    quoteId: over.quoteId ?? ids.quote,
    tripId: over.tripId ?? ids.trip,
    partySize: 1,
    amount: 6500,
    currency: "USD",
    expiresAt,
    createdAt: quotedAt,
    booking: state === "confirmed" ? { reference: syntheticReference } : null,
    refund: null,
  };
}

export type CheckoutCreateOver = CheckoutOver & { payment?: CheckoutPayment | null };

export function checkoutCreateResponse(
  over: CheckoutCreateOver = {},
): CheckoutSessionCreateResponse {
  const payment =
    over.payment === undefined
      ? {
          provider: "fake" as const,
          paymentRef: "fpay_synthetic0001",
          clientSecret: "fpay_secret_synthetic0001",
        }
      : over.payment;
  return CheckoutSessionCreateResponse.parse({
    checkoutSession: checkoutSession(over),
    payment,
  });
}

export function checkoutSessionResponse(over: CheckoutOver = {}): CheckoutSessionResponse {
  return CheckoutSessionResponse.parse({ checkoutSession: checkoutSession(over) });
}

// Manage session --------------------------------------------------------------------------

export const syntheticSessionToken = "m".repeat(43);

export function manageSessionResponse(
  over: { token?: string; reference?: string } = {},
): ManageSessionResponse {
  return ManageSessionResponse.parse({
    session: { token: over.token ?? syntheticSessionToken, expiresAt: "2026-11-04T16:35:00.000Z" },
    booking: { reference: over.reference ?? syntheticReference },
  });
}

// Managed booking -------------------------------------------------------------------------

export type ManagedOver = {
  state?: ManagedBooking["state"];
  reference?: string;
  refund?: BookingRefund | null;
  cancellation?: BookingCancellation | null;
  paidAmount?: number;
  refundAmount?: number;
};

function terms(
  paidAmount: number,
  refundAmount: number,
): CancellationTerms & { remedy: "full_refund" | "none" } {
  return {
    cancelable: true,
    refusal: null,
    remedy: refundAmount > 0 ? "full_refund" : "none",
    refundBp: paidAmount > 0 ? Math.round((refundAmount * 10_000) / paidAmount) : 0,
    paidAmount,
    refundAmount,
    currency: "USD",
    departsAt: "2026-11-06T22:00:00.000Z",
    cutoffAt: "2026-11-05T22:00:00.000Z",
    beforeCutoff: true,
    policyVersion: 1,
    asOf: "2026-11-04T16:00:00.000Z",
  };
}

export function managedBooking(over: ManagedOver = {}): ManagedBooking {
  const paid = over.paidAmount ?? 6500;
  const booking: ManagedBooking = {
    id: ids.booking,
    reference: over.reference ?? syntheticReference,
    state: over.state ?? "confirmed",
    confirmedAt: bookedAt,
    booker: { name: "Ava Guest", email: "ava@example.test" },
    trip: {
      tripId: ids.trip,
      productName,
      productKind: "shared_seat",
      boatName: boat,
      timeZone: zone,
      localDate: "2026-11-06",
      localStartTime: "17:00",
      startsAt: "2026-11-06T22:00:00.000Z",
      salesState: "published",
      endsAt: "2026-11-06T23:30:00.000Z",
      endsAtLocal: `2026-11-06T18:30:00${tzOffset}`,
      durationMinutes: 90,
    },
    location: {
      name: "Harbor Marina, Dock C",
      meetingPoint: "Dock C, slip 14",
      meetingInstructions: "Check in at the dock office 20 minutes before departure.",
    },
    party: { kind: "tickets", guests: 1, tickets: [{ code: "adult", name: "Adult", quantity: 1 }] },
    extras: [],
    order: {
      id: ids.order,
      status: "paid",
      currency: "USD",
      lines: [
        {
          lineNo: 1,
          kind: "service",
          code: "adult",
          name: "Adult",
          basis: null,
          quantity: 1,
          unitAmount: paid,
          amount: paid,
          taxInclusive: null,
          taxRatePpm: null,
        },
      ],
      totals: { subtotal: paid, discount: 0, fees: 0, tax: 0, includedTax: 0, total: paid },
    },
    payment: { provider: "stripe", state: "succeeded", amount: paid, currency: "USD" },
    refund: over.refund === undefined ? null : over.refund,
    cancellation: over.cancellation === undefined ? null : over.cancellation,
    policy: {
      version: 1,
      cancellationText: "Cancel at least 24 hours before departure for a full refund.",
      cutoffAt: "2026-11-05T22:00:00.000Z",
    },
    participants: { partySize: 1, participants: [] },
    partyEditable: (over.state ?? "confirmed") === "confirmed",
    cancellationTerms: terms(paid, over.refundAmount ?? paid),
  };
  return booking;
}

export function managedBookingResponse(over: ManagedOver = {}): ManagedBookingResponse {
  return ManagedBookingResponse.parse({
    booking: managedBooking(over),
    session: { expiresAt: "2026-11-04T16:35:00.000Z" },
  });
}

export function cancellationTermsResponse(
  over: { refundAmount?: number; paidAmount?: number } = {},
): CancellationTermsResponse {
  const paid = over.paidAmount ?? 6500;
  return CancellationTermsResponse.parse({ terms: terms(paid, over.refundAmount ?? paid) });
}

/** The booking as the cancel call returns it: canceled, with the refund requested. */
export function cancelBookingResponse(
  over: { refundAmount?: number; paidAmount?: number; refundState?: BookingRefund["state"] } = {},
): CancelBookingResponse {
  const paid = over.paidAmount ?? 6500;
  const refund = over.refundAmount ?? paid;
  const t = terms(paid, refund);
  return CancelBookingResponse.parse({
    booking: managedBooking({
      state: "canceled",
      paidAmount: paid,
      refundAmount: refund,
      cancellation: {
        canceledAt: t.asOf,
        by: "guest",
        remedy: t.remedy,
        refundBp: t.refundBp,
        refundAmount: t.refundAmount,
        creditAmount: 0,
        overridden: false,
        paidAmount: t.paidAmount,
        cutoffAt: t.cutoffAt,
        beforeCutoff: t.beforeCutoff,
        policyVersion: t.policyVersion,
      },
      refund: {
        state: over.refundState ?? "requested",
        amount: refund,
        failureCode: null,
        requestedAt: t.asOf,
        settledAt: null,
      },
    }),
  });
}
