import type {
  Quote,
  StaffCheckout,
  StaffTestPaymentResponse,
  TripOffer,
} from "@tidegrid/contracts";
import { tenantId, tripIds } from "../bookings/fixtures.ts";

/**
 * Staff-assisted booking fixtures (G2.12d): a shared-seat offer on the New
 * York sunset cruise, a charter offer, the quotes they price to, and the
 * staff checkout at each point of its life. Synthetic only.
 */

const base = `/api/v1/staff/tenants/${tenantId}`;

export const checkoutId = "4b2d6c70-9a1e-4f3b-8c5d-2e7f9a0b1c31";
export const quoteId = "6a1c3e50-7b2d-4f8e-9a6b-1c2d3e4f5a61";
export const bookedId = "8e3f5a70-1b2c-4d3e-9f4a-5b6c7d8e9f01";

export const newRoute = {
  offer: (trip: string = tripIds.sunset) => `GET ${base}/trips/${trip}/offer`,
  quote: `POST ${base}/quotes`,
  open: `POST ${base}/checkouts`,
  read: (id: string = checkoutId) => `GET ${base}/checkouts/${id}`,
  cancel: (id: string = checkoutId) => `POST ${base}/checkouts/${id}/cancel`,
  pay: (id: string = checkoutId) => `POST ${base}/checkouts/${id}/test-payment`,
};

const policy = {
  version: 3,
  changeCutoffMinutes: 1440,
  changeCutoffAt: "2026-11-04T23:00:00.000Z",
  beforeCutoff: { remedy: "full_refund", refundBp: null },
  afterCutoff: { remedy: "none", refundBp: null },
  noShow: { remedy: "none", refundBp: null },
  text: {
    cancellation: "Cancel up to 24 hours before departure for a full refund.",
    reschedule: "Reschedule once, up to 24 hours before.",
    noShow: "No refund for a no-show.",
    operatorCancellation: "Full refund if we cancel.",
    weather: "Full refund for unsafe weather.",
  },
} as const;

const tripSnapshot = {
  timeZone: "America/New_York",
  localDate: "2026-11-05",
  localStartTime: "18:00",
  startsAt: "2026-11-05T23:00:00.000Z",
  startsAtLocal: "2026-11-05T18:00:00-05:00",
};

export function sharedOffer(over: Partial<TripOffer> = {}): TripOffer {
  return {
    tripId: tripIds.sunset,
    product: {
      id: "1a2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c51",
      name: "Sunset Harbor Cruise",
      kind: "shared_seat",
      minPartySize: 1,
      maxPartySize: 8,
    },
    trip: tripSnapshot,
    currency: "USD",
    priceListVersion: 2,
    tickets: [
      { code: "adult", name: "Adult", unitAmount: 4500, taxable: true },
      { code: "child", name: "Child 3 to 12", unitAmount: 2500, taxable: true },
    ],
    charter: null,
    addOns: [
      {
        code: "photo",
        name: "Souvenir photo",
        unitAmount: 1500,
        quantityRule: "per_booking",
        maxQuantity: 1,
        taxable: true,
      },
    ],
    fees: [],
    taxes: [{ name: "Sales tax", ratePpm: 70000, inclusive: false }],
    policy,
    ...over,
  };
}

export function charterOffer(): TripOffer {
  return sharedOffer({
    tripId: tripIds.charter,
    product: {
      id: "1a2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c52",
      name: "Private Reef Charter",
      kind: "private_charter",
      minPartySize: 2,
      maxPartySize: 6,
    },
    tickets: [],
    charter: { name: "Whole boat, up to 6 guests", amount: 90000, taxable: true },
    addOns: [],
  });
}

export function quoteFor(over: Partial<Quote> = {}): Quote {
  return {
    quoteId,
    tripId: tripIds.sunset,
    product: {
      id: "1a2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c51",
      name: "Sunset Harbor Cruise",
      kind: "shared_seat",
    },
    trip: tripSnapshot,
    partySize: 2,
    currency: "USD",
    priceListVersion: 2,
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
        taxable: true,
        taxes: [],
      },
    ],
    taxes: [
      {
        taxRateId: "9c8b7a65-4321-4fed-8cba-987654321001",
        version: 1,
        name: "Sales tax",
        ratePpm: 70000,
        inclusive: false,
        taxableAmount: 9000,
        amount: 630,
      },
    ],
    promotion: null,
    totals: {
      subtotal: 9000,
      discount: 0,
      fees: 0,
      tax: 630,
      includedTax: 0,
      total: 9630,
      amountDueNow: 9630,
    },
    policy,
    quotedAt: "2026-11-04T17:00:00.000Z",
    expiresAt: "2026-11-04T17:30:00.000Z",
    ...over,
  } as Quote;
}

export function staffCheckout(over: Partial<StaffCheckout> = {}): StaffCheckout {
  return {
    id: checkoutId,
    state: "open",
    tripId: tripIds.sunset,
    quoteId,
    partySize: 2,
    amount: 9630,
    currency: "USD",
    expiresAt: "2026-11-04T17:15:00.000Z",
    createdAt: "2026-11-04T17:00:00.000Z",
    channel: "phone",
    paymentState: "pending",
    lastTestPayment: null,
    booking: null,
    refund: null,
    ...over,
  };
}

export const confirmed = () =>
  staffCheckout({
    state: "confirmed",
    paymentState: "succeeded",
    booking: { id: bookedId, reference: "QKG6ERBF" },
  });

export function paid(over: Partial<StaffTestPaymentResponse> = {}): StaffTestPaymentResponse {
  return {
    checkoutId,
    outcome: "succeed",
    event: {
      id: "fevt_ABCDEFGHIJKLMNOPQRSTUVWX",
      type: "payment.succeeded",
      createdAt: "2026-11-04T17:01:00.000Z",
    },
    alreadySettled: false,
    delivery: { status: 200, outcome: "confirmed", duplicate: false },
    ...over,
  };
}

/** A synthetic booker, and every fragment that must never reach an address. */
export const caller = { name: "Rosa Telefono", email: "rosa.telefono@guest.example" };
