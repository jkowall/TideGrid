import type {
  BookingDayTrip,
  BookingDetail,
  BookingListItem,
  BookingOrderLine,
  FinalizationException,
  Membership,
  MeResponse,
  StaffRole,
  StaffTrip,
  TripRoster,
} from "@tidegrid/contracts";
import { expect, vi } from "vitest";

/**
 * Shared test data for the booking views: one New York marina, one day of
 * trips and bookings, the other reads built from the same people, and a fetch
 * stub. Every name, email, and reference is invented. Ids are valid UUIDs, as
 * the API sends them.
 */

// People and places -------------------------------------------------------------------

export const tenantId = "7d1e5b3a-1c2f-4a8e-9b61-0a1c2e3f4a01";
export const tenantName = "Demo Harbor Charters";

export const membership = (role: StaffRole): Membership => ({
  tenantId,
  tenantSlug: "demo-harbor",
  tenantName,
  role,
});

export const me = (role: StaffRole = "owner"): MeResponse => ({
  principal: {
    userId: "5f0c3a52-2a55-4f8a-9d7e-5d6f0f1b2a01",
    email: "ava@demo-harbor.example",
    displayName: "Ava Marsh",
    authMethod: "magic_link",
  },
  memberships: [membership(role)],
});

export const bookers = {
  maya: { name: "Maya Okonkwo", email: "maya.okonkwo@guest.example" },
  luis: { name: "Luis Fernandez", email: "luis.fernandez@guest.example" },
  priya: { name: "Priya Raman", email: "priya.raman@guest.example" },
} as const;

/** Each part of every booker's name, and their emails, lowercased. */
export const personalFragments: string[] = Object.values(bookers)
  .flatMap((b) => [b.email, ...b.name.split(" ")])
  .map((s) => s.toLowerCase());

/** The parts of any booker's name or email that a text holds, for checks that none is there. */
export const bookerFragmentsIn = (value: string) =>
  personalFragments.filter((fragment) => value.toLowerCase().includes(fragment));

/** The marina's wall clock is New York's; the tests run with the viewer in Tokyo. */
export const marinaZone = "America/New_York";
export const marinaLocation = {
  name: "Harbor Marina, Dock C",
  meetingPoint: "Dock C, slip 14",
  meetingInstructions: "Check in at the dock office 20 minutes before departure.",
};

// Ids ---------------------------------------------------------------------------------

export const tripIds = {
  charter: "bc5f3492-d330-487d-8078-7221db331802",
  sunset: "bc5f3492-d330-487d-8078-7221db331801",
  honolulu: "bc5f3492-d330-487d-8078-7221db331803",
  quiet: "bc5f3492-d330-487d-8078-7221db331804",
} as const;

export const bookingIds = {
  maya: "3c1f6a52-9d44-4e0b-8a6f-2b7d5c9e0a11",
  luis: "3c1f6a52-9d44-4e0b-8a6f-2b7d5c9e0a12",
  priya: "3c1f6a52-9d44-4e0b-8a6f-2b7d5c9e0a13",
} as const;

export const exceptionIds = {
  noCapacity: "a1b2c3d4-0001-4e5f-8a9b-0c1d2e3f4a01",
  mismatch: "a1b2c3d4-0002-4e5f-8a9b-0c1d2e3f4a02",
  canceled: "a1b2c3d4-0003-4e5f-8a9b-0c1d2e3f4a03",
  failedRefund: "a1b2c3d4-0004-4e5f-8a9b-0c1d2e3f4a04",
} as const;

// A day: Wednesday, Nov 4, 2026 (EST) --------------------------------------------------

export const day = "2026-11-04";

export const charterTrip: BookingDayTrip = {
  tripId: tripIds.charter,
  productName: "Private Half-Day Charter",
  productKind: "private_charter",
  boatName: "Blue Heron",
  timeZone: marinaZone,
  localDate: day,
  localStartTime: "08:00",
  startsAt: "2026-11-04T13:00:00.000Z",
  salesState: "published",
  bookings: 1,
  guests: 6,
};

export const sunsetTrip: BookingDayTrip = {
  tripId: tripIds.sunset,
  productName: "Sunset Harbor Cruise",
  productKind: "shared_seat",
  boatName: "Sea Lark",
  timeZone: marinaZone,
  localDate: day,
  localStartTime: "18:00",
  startsAt: "2026-11-04T23:00:00.000Z",
  salesState: "published",
  bookings: 2,
  guests: 5,
};

/** A dive in Honolulu on the same date, so a day can hold two zones. */
export const honoluluTrip: BookingDayTrip = {
  tripId: tripIds.honolulu,
  productName: "Two-Tank Morning Dive",
  productKind: "shared_seat",
  boatName: "Reef Runner",
  timeZone: "Pacific/Honolulu",
  localDate: day,
  localStartTime: "07:30",
  startsAt: "2026-11-04T17:30:00.000Z",
  salesState: "published",
  bookings: 0,
  guests: 0,
};

/** A trip at the marina with nothing booked yet. */
export const quietTrip: BookingDayTrip = {
  tripId: tripIds.quiet,
  productName: "Early Harbor Tour",
  productKind: "shared_seat",
  boatName: "Gull",
  timeZone: marinaZone,
  localDate: day,
  localStartTime: "07:00",
  startsAt: "2026-11-04T12:00:00.000Z",
  salesState: "published",
  bookings: 0,
  guests: 0,
};

export const priyaBooking: BookingListItem = {
  id: bookingIds.priya,
  reference: "3ZRB8N4C",
  tripId: tripIds.charter,
  state: "confirmed",
  source: "direct",
  confirmedAt: "2026-10-20T14:00:00.000Z",
  booker: { name: bookers.priya.name },
  party: { kind: "charter", guests: 6, charter: "Whole boat, up to 12 guests" },
  extras: [],
  total: 126500,
  currency: "USD",
  payment: { state: "succeeded", refund: null },
};

export const mayaBooking: BookingListItem = {
  id: bookingIds.maya,
  reference: "QKG6ERBF",
  tripId: tripIds.sunset,
  state: "confirmed",
  source: "direct",
  confirmedAt: "2026-10-06T18:17:00.000Z",
  booker: { name: bookers.maya.name },
  party: {
    kind: "tickets",
    guests: 3,
    tickets: [
      { code: "adult", name: "Adult", quantity: 2 },
      { code: "child", name: "Child (3 to 12)", quantity: 1 },
    ],
  },
  extras: [{ code: "photo", name: "Souvenir photo", quantity: 1 }],
  total: 13109,
  currency: "USD",
  payment: { state: "succeeded", refund: null },
};

export const luisBooking: BookingListItem = {
  id: bookingIds.luis,
  reference: "7HM2P9TW",
  tripId: tripIds.sunset,
  state: "confirmed",
  source: "direct",
  confirmedAt: "2026-10-07T15:30:00.000Z",
  booker: { name: bookers.luis.name },
  party: { kind: "tickets", guests: 2, tickets: [{ code: "adult", name: "Adult", quantity: 2 }] },
  extras: [
    { code: "photo", name: "Souvenir photo", quantity: 1 },
    { code: "drinks", name: "Drink voucher", quantity: 2 },
  ],
  total: 9450,
  currency: "USD",
  payment: { state: "succeeded", refund: { state: "succeeded", amount: 9450 } },
};

/** The API's answer for the day: trips by departure, bookings by departure then confirmation. */
export function dayBody(
  over: Partial<{
    date: string;
    trips: BookingDayTrip[];
    bookings: BookingListItem[];
    nextAfter: string | null;
  }> = {},
) {
  return {
    date: day,
    trips: [charterTrip, sunsetTrip],
    bookings: [priyaBooking, mayaBooking, luisBooking],
    nextAfter: null,
    ...over,
  };
}

// One booking ---------------------------------------------------------------------------

/** The order a guest accepted: lines as the API orders them, totals as the order stored them. */
export const orderLines: BookingOrderLine[] = [
  {
    lineNo: 1,
    kind: "service",
    code: "adult",
    name: "Adult",
    basis: null,
    quantity: 2,
    unitAmount: 4500,
    amount: 9000,
    taxInclusive: null,
    taxRatePpm: null,
  },
  {
    lineNo: 2,
    kind: "service",
    code: "child",
    name: "Child (3 to 12)",
    basis: null,
    quantity: 1,
    unitAmount: 2500,
    amount: 2500,
    taxInclusive: null,
    taxRatePpm: null,
  },
  {
    lineNo: 3,
    kind: "add_on",
    code: "photo",
    name: "Souvenir photo",
    basis: "per_booking",
    quantity: 1,
    unitAmount: 1200,
    amount: 1200,
    taxInclusive: null,
    taxRatePpm: null,
  },
  {
    lineNo: 4,
    kind: "fee",
    code: "harbor_fee",
    name: "Harbor fee",
    basis: "per_participant",
    quantity: 3,
    unitAmount: 250,
    amount: 750,
    taxInclusive: null,
    taxRatePpm: null,
  },
  {
    lineNo: 5,
    kind: "discount",
    code: "HARBOR10",
    name: "HARBOR10, 10% off",
    basis: null,
    quantity: 1,
    unitAmount: 1150,
    amount: -1150,
    taxInclusive: null,
    taxRatePpm: null,
  },
  {
    lineNo: 6,
    kind: "tax",
    code: "state_sales_tax",
    name: "State sales tax",
    basis: null,
    quantity: 1,
    unitAmount: 693,
    amount: 693,
    taxInclusive: false,
    taxRatePpm: 60000,
  },
  {
    lineNo: 7,
    kind: "tax",
    code: "county_surtax",
    name: "County surtax",
    basis: null,
    quantity: 1,
    unitAmount: 116,
    amount: 116,
    taxInclusive: false,
    taxRatePpm: 10000,
  },
  {
    lineNo: 8,
    kind: "tax",
    code: "harbor_levy",
    name: "Harbor levy",
    basis: null,
    quantity: 1,
    unitAmount: 542,
    amount: 542,
    taxInclusive: true,
    taxRatePpm: 47120,
  },
];

export const orderTotals = {
  subtotal: 12700,
  discount: 1150,
  fees: 750,
  tax: 809,
  includedTax: 542,
  total: 13109,
};

export function bookingDetail(over: Partial<BookingDetail> = {}): BookingDetail {
  return {
    id: bookingIds.maya,
    reference: "QKG6ERBF",
    state: "confirmed",
    source: "direct",
    reacquired: false,
    // 2:17 PM in New York; already Oct 7 in Tokyo.
    confirmedAt: "2026-10-06T18:17:00.000Z",
    trip: {
      tripId: tripIds.sunset,
      productName: "Sunset Harbor Cruise",
      productKind: "shared_seat",
      boatName: "Sea Lark",
      timeZone: marinaZone,
      localDate: day,
      localStartTime: "18:00",
      startsAt: "2026-11-04T23:00:00.000Z",
      salesState: "published",
      endsAt: "2026-11-05T00:30:00.000Z",
      endsAtLocal: "2026-11-04T19:30:00-05:00",
      durationMinutes: 90,
    },
    location: marinaLocation,
    booker: { name: bookers.maya.name, email: bookers.maya.email },
    party: mayaBooking.party,
    extras: mayaBooking.extras,
    policyVersion: 3,
    order: {
      id: "8f2d4c6e-1a3b-4c5d-9e7f-0a1b2c3d4e5f",
      status: "paid",
      currency: "USD",
      lines: orderLines,
      totals: orderTotals,
    },
    payment: {
      provider: "fake",
      state: "succeeded",
      amount: 13109,
      currency: "USD",
      providerReference: "fpay_••••a1B2",
      createdAt: "2026-10-06T18:05:00.000Z",
      succeededAt: "2026-10-06T18:16:30.000Z",
    },
    refund: null,
    timeline: [
      { kind: "checkout_opened", at: "2026-10-06T18:05:00.000Z" },
      { kind: "paid", at: "2026-10-06T18:16:30.000Z" },
      { kind: "confirmed", at: "2026-10-06T18:17:00.000Z" },
    ],
    ...over,
  };
}

// Payment exceptions -----------------------------------------------------------------------

export function finalizationException(
  over: Partial<FinalizationException> = {},
): FinalizationException {
  return {
    id: exceptionIds.noCapacity,
    reason: "no_capacity",
    checkoutSessionId: "5d6e7f80-1a2b-4c3d-8e4f-5a6b7c8d9e01",
    tripId: tripIds.sunset,
    paymentId: "6e7f8091-2b3c-4d4e-9f50-6b7c8d9e0f01",
    amount: 13109,
    createdAt: "2026-10-06T18:40:00.000Z",
    refund: {
      id: "7f8091a2-3c4d-4e5f-8a61-7c8d9e0f1a01",
      state: "succeeded",
      amount: 13109,
      failureCode: null,
      settledAt: "2026-10-06T18:42:00.000Z",
    },
    trip: {
      tripId: tripIds.sunset,
      productName: "Sunset Harbor Cruise",
      productKind: "shared_seat",
      boatName: "Sea Lark",
      timeZone: marinaZone,
      localDate: day,
      localStartTime: "18:00",
      startsAt: "2026-11-04T23:00:00.000Z",
      salesState: "published",
    },
    partySize: 3,
    checkout: { state: "unfulfilled", expiresAt: "2026-10-06T18:25:00.000Z" },
    payment: {
      provider: "fake",
      providerReference: "fpay_••••c3D4",
      receivedAt: "2026-10-06T18:40:00.000Z",
      reportedAmount: 13109,
      reportedCurrency: "USD",
    },
    booker: { name: bookers.maya.name, email: bookers.maya.email },
    ...over,
  };
}

// A trip's roster --------------------------------------------------------------------------

export function tripRoster(over: Partial<TripRoster> = {}): TripRoster {
  return {
    generatedAt: "2026-11-04T15:00:00.000Z",
    trip: {
      tripId: tripIds.sunset,
      productName: "Sunset Harbor Cruise",
      productKind: "shared_seat",
      boatName: "Sea Lark",
      timeZone: marinaZone,
      localDate: day,
      localStartTime: "18:00",
      startsAt: "2026-11-04T23:00:00.000Z",
      salesState: "published",
      endsAt: "2026-11-05T00:30:00.000Z",
      endsAtLocal: "2026-11-04T19:30:00-05:00",
      durationMinutes: 90,
      seats: 20,
    },
    location: marinaLocation,
    totals: {
      bookings: 2,
      guests: 5,
      tickets: [
        { code: "adult", name: "Adult", quantity: 4 },
        { code: "child", name: "Child (3 to 12)", quantity: 1 },
      ],
      extras: [
        { code: "photo", name: "Souvenir photo", quantity: 2 },
        { code: "drinks", name: "Drink voucher", quantity: 2 },
      ],
    },
    bookings: [
      {
        id: bookingIds.maya,
        reference: "QKG6ERBF",
        booker: { name: bookers.maya.name },
        party: mayaBooking.party,
        extras: mayaBooking.extras,
        payment: { state: "succeeded", refund: null },
      },
      {
        id: bookingIds.luis,
        reference: "7HM2P9TW",
        booker: { name: bookers.luis.name },
        party: luisBooking.party,
        extras: luisBooking.extras,
        payment: { state: "succeeded", refund: { state: "requested", amount: 9450 } },
      },
    ],
    ...over,
  };
}

// The calendar's trips -----------------------------------------------------------------------

/** A published Sunset Harbor Cruise on Thursday, Nov 5, 2026, with room for 20. */
export function staffTrip(over: Partial<StaffTrip> = {}): StaffTrip {
  return {
    tripId: tripIds.sunset,
    timeZone: marinaZone,
    localDate: "2026-11-05",
    localStartTime: "18:00",
    startsAt: "2026-11-05T23:00:00.000Z",
    endsAt: "2026-11-06T00:30:00.000Z",
    startsAtLocal: "2026-11-05T18:00:00-05:00",
    endsAtLocal: "2026-11-05T19:30:00-05:00",
    durationMinutes: 90,
    productId: "4f51db31-f9aa-492a-ad2b-05d7c1c3cb2a",
    productName: "Sunset Harbor Cruise",
    productKind: "shared_seat",
    boatId: "9a0e7c55-3b1d-4f2a-8c6e-1d2f3a4b5c01",
    boatName: "Sea Lark",
    scheduleId: null,
    salesState: "published",
    salesStateChangedAt: "2026-09-30T12:00:00.000Z",
    salesCloseAt: "2026-11-05T22:00:00.000Z",
    blackedOut: false,
    capacity: { kind: "seats", total: 20, remaining: 20 },
    ...over,
  };
}

// What the API leaves out ---------------------------------------------------------------------

/**
 * An answer as the API sends it to a role. Finance does not hold
 * bookings.read, so no booker key is in the body: absent, never blank.
 */
export function asSeenBy<T>(role: StaffRole, body: T): T {
  if (role !== "finance") return body;
  return JSON.parse(JSON.stringify(body, (key, value) => (key === "booker" ? undefined : value)));
}

// Responses and the fetch stub ---------------------------------------------------------------

export const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });

export const apiError = (status: number, code: string) =>
  json({ error: { code, message: "x", requestId: "r" } }, status);

/** An answer that fails as a dropped connection does. */
export const dropped = () => {
  throw new TypeError("Failed to fetch");
};

/** The operator's catalog, as far as the console reads it: its location's zone. */
export const catalog = (timeZone = marinaZone) =>
  json({
    locations: [
      {
        id: "0f2c7a10-1b2c-4d3e-8f40-5a6b7c8d9e01",
        name: marinaLocation.name,
        timeZone,
        meetingPoint: marinaLocation.meetingPoint,
        status: "active",
      },
    ],
    boats: [],
    products: [],
    schedules: [],
  });

/** A response the test releases when it chooses. */
export function deferred() {
  let release: (res: Response) => void = () => {};
  const promise = new Promise<Response>((resolve) => {
    release = resolve;
  });
  return { answer: () => promise, release };
}

export interface Call {
  method: string;
  path: string;
  query: URLSearchParams;
}

export type Answer = (call: Call) => Response | Promise<Response>;

const strays: string[] = [];

/** Requests no route answered since the last time this was read. Check it is empty after each test. */
export const strayRequests = () => strays.splice(0);

const base = (tenant = tenantId) => `/api/v1/staff/tenants/${tenant}`;

/** The routes the booking views call, as "METHOD /path" keys for `api`. */
export const route = {
  catalog: (tenant?: string) => `GET ${base(tenant)}/catalog`,
  day: (tenant?: string) => `GET ${base(tenant)}/bookings`,
  booking: (id: string, tenant?: string) => `GET ${base(tenant)}/bookings/${id}`,
  reference: (reference: string, tenant?: string) =>
    `GET ${base(tenant)}/booking-references/${reference}`,
  roster: (id: string, tenant?: string) => `GET ${base(tenant)}/trips/${id}/roster`,
  exceptions: (tenant?: string) => `GET ${base(tenant)}/finalization-exceptions`,
  trips: (tenant?: string) => `GET ${base(tenant)}/trips`,
};

/**
 * A fetch that answers "METHOD /path" from per-route queues (an array, one
 * answer per request) or from a handler (a function, for every request), and
 * records every call. The catalog answers with a New York marina unless a
 * route says otherwise. A request nothing answers is recorded in
 * `strayRequests` and fails as a dropped connection would.
 */
export function api(routes: Record<string, Answer | Answer[]>): Call[] {
  const calls: Call[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input), "http://localhost:5184");
      const method = init?.method ?? "GET";
      const key = `${method} ${url.pathname}`;
      const call: Call = { method, path: url.pathname, query: url.searchParams };
      calls.push(call);
      const queued = routes[key];
      const answer =
        (Array.isArray(queued) ? queued.shift() : queued) ??
        (key.endsWith("/catalog") ? () => catalog() : undefined);
      if (!answer) {
        strays.push(key);
        throw new Error(`unexpected request ${key}`);
      }
      return answer(call);
    }),
  );
  return calls;
}

/** The calls to one route, by "METHOD /path" key. */
export const callsTo = (calls: Call[], key: string) =>
  calls.filter((c) => `${c.method} ${c.path}` === key);

// Reading the screen ------------------------------------------------------------------------------

/** An element's text with every run of white space, no-break spaces included, as one space. */
export const text = (element: Element | null | undefined) =>
  (element?.textContent ?? "").replace(/\s+/g, " ").trim();

/** A definition list as { term: definition }, for lists with a div around each pair or none. */
export function terms(list: Element | null | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const term of list?.querySelectorAll("dt") ?? []) {
    out[text(term)] = text(term.nextElementSibling);
  }
  return out;
}

/** No booker's name or email is in the address bar or in any link's address. */
export function expectNoPersonalDataInAddresses() {
  const addresses = [
    window.location.href,
    ...[...document.querySelectorAll("a[href]")].map((a) => a.getAttribute("href") ?? ""),
  ].map((address) => decodeURIComponent(address).toLowerCase());
  for (const address of addresses) {
    for (const fragment of personalFragments) {
      expect(address, `"${fragment}" in an address`).not.toContain(fragment);
    }
  }
}
