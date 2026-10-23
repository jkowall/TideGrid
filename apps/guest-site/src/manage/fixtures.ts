/**
 * Test fixtures for the booking management page (lane 1, G2.11c): a Demo
 * Harbor booking as its guest sees it, shaped exactly as the API returns it,
 * what canceling would do under each remedy, and a fake API that records every
 * call and answers from one booking the tests can change. Every name, email,
 * and token is made up. Used by the tests only; nothing in the app imports this
 * file.
 */
import {
  type BookingCancellation,
  type BookingOrderLine,
  CancelBookingRequest,
  type CancellationTerms,
  IdempotencyKey,
  type ManagedBooking,
  ManageLinkRenewRequest,
  ManageSessionCreateRequest,
  type Participant,
  ParticipantInput,
} from "@tidegrid/contracts";
import { vi } from "vitest";
import { type Answer, type Call, json, refusal, testNow, tripId } from "../booking/fixtures.ts";
import { apiBase } from "../bootstrap.ts";
import type { StoredSession } from "./session.ts";

export const bookingId = "4d2b7e90-6a1c-4f3e-9b58-1c7a0e5d2f01";
export const reference = "C03G4ZFJ";
const orderId = "8f2d4c6e-1a3b-4c5d-9e7f-0a1b2c3d4e5f";

/** The booker, who is also the first guest and the guardian of the second. */
export const booker = { name: "Ava Guest", email: "ava@example.test" } as const;

/** 43 base64url characters, as the API issues them: a link's token, then the session it opens. */
export const linkToken = "test_link_token_".padEnd(43, "L");
export const sessionToken = "test_session_token_".padEnd(43, "S");

const hour = 60 * 60_000;

// The party ---------------------------------------------------------------------------------

const participantId = (position: number) =>
  `7c1e9d3a-5b2f-4a6e-8d40-2f9b1c3e5a${String(position).padStart(2, "0")}`;

/** Guest 1: the booker, an adult with no email of their own. */
export const ava: Participant = {
  id: participantId(1),
  position: 1,
  name: "Ava Guest",
  isMinor: false,
  email: null,
  guardian: null,
  createdAt: "2026-10-05T15:55:00.000Z",
  updatedAt: "2026-10-05T15:55:00.000Z",
};

/** Guest 2: a minor, with the booker as guardian. Guest 3 is not named yet. */
export const theo: Participant = {
  id: participantId(2),
  position: 2,
  name: "Theo Guest",
  isMinor: true,
  email: null,
  guardian: { name: "Ava Guest", email: "ava@example.test" },
  createdAt: "2026-10-05T15:56:00.000Z",
  updatedAt: "2026-10-05T15:56:00.000Z",
};

// The receipt -------------------------------------------------------------------------------

function line(
  lineNo: number,
  kind: BookingOrderLine["kind"],
  code: string,
  name: string,
  quantity: number,
  unitAmount: number,
  over: Partial<BookingOrderLine> = {},
): BookingOrderLine {
  return {
    lineNo,
    kind,
    code,
    name,
    basis: null,
    quantity,
    unitAmount,
    amount: quantity * unitAmount,
    taxInclusive: null,
    taxRatePpm: null,
    ...over,
  };
}

/**
 * 2 adults and 1 child, a souvenir photo and 2 drink vouchers: $143.00, the
 * harbor fee for 3, then 1% and 6% tax added, for $160.51. The order's lines
 * are as the API orders them: trip price, add-ons, fees, then taxes.
 */
export const orderLines: BookingOrderLine[] = [
  line(1, "service", "adult", "Adult", 2, 4500),
  line(2, "service", "child", "Child (3 to 12)", 1, 2500),
  line(3, "add_on", "photo", "Souvenir photo", 1, 1200, { basis: "per_booking" }),
  line(4, "add_on", "drinks", "Drink voucher", 2, 800, { basis: "per_participant" }),
  line(5, "fee", "harbor_fee", "Harbor fee", 3, 250, { basis: "per_participant" }),
  line(6, "tax", "county_surtax", "County surtax", 1, 143, {
    taxInclusive: false,
    taxRatePpm: 10_000,
  }),
  line(7, "tax", "state_sales_tax", "State sales tax", 1, 858, {
    taxInclusive: false,
    taxRatePpm: 60_000,
  }),
];

export const orderTotals: ManagedBooking["order"]["totals"] = {
  subtotal: 14_300,
  discount: 0,
  fees: 750,
  tax: 1001,
  includedTax: 0,
  total: 16_051,
};

// What canceling would do ---------------------------------------------------------------------

/** The policy's cutoff: 6:00 PM on Tue, Oct 6 in New York, 24 hours before the cruise. */
export const cutoffAt = "2026-10-06T22:00:00.000Z";
export const departsAt = "2026-10-07T22:00:00.000Z";
export const paid = 16_051;

/**
 * What canceling now would do under one remedy, as the API computes it from
 * the booking's policy version. A full refund is before the cutoff; the others
 * are after it, so the clock is past the cutoff. A percent refund is rounded
 * half up to the cent: half of $160.51 is $80.26.
 */
export function terms(
  remedy: CancellationTerms["remedy"] = "full_refund",
  over: Partial<CancellationTerms> = {},
): CancellationTerms {
  const before = remedy === "full_refund";
  const shared = {
    currency: "USD" as const,
    departsAt,
    cutoffAt,
    policyVersion: 1,
    paidAmount: paid,
    beforeCutoff: before,
    asOf: before ? testNow.toISOString() : "2026-10-06T23:00:00.000Z",
  };
  switch (remedy) {
    case "full_refund":
      return {
        ...shared,
        cancelable: true,
        refusal: null,
        remedy,
        refundBp: 10_000,
        refundAmount: paid,
        ...over,
      };
    case "percent_refund":
      return {
        ...shared,
        cancelable: true,
        refusal: null,
        remedy,
        refundBp: 5000,
        refundAmount: 8026,
        ...over,
      };
    case "none":
      return {
        ...shared,
        cancelable: true,
        refusal: null,
        remedy,
        refundBp: 0,
        refundAmount: 0,
        ...over,
      };
    case "credit":
      return {
        ...shared,
        cancelable: false,
        refusal: "remedy_requires_operator",
        remedy,
        refundBp: 0,
        refundAmount: 0,
        ...over,
      };
  }
}

// The booking ---------------------------------------------------------------------------------

/** The Oct 7, 6:00 PM Sunset Harbor Cruise, confirmed, with two of three guests named. */
export function managedBooking(over: Partial<ManagedBooking> = {}): ManagedBooking {
  return {
    id: bookingId,
    reference,
    state: "confirmed",
    confirmedAt: "2026-10-05T15:50:00.000Z",
    booker: { ...booker },
    trip: {
      tripId,
      productName: "Sunset Harbor Cruise",
      productKind: "shared_seat",
      boatName: "Sea Lark",
      timeZone: "America/New_York",
      localDate: "2026-10-07",
      localStartTime: "18:00",
      startsAt: departsAt,
      salesState: "published",
      endsAt: "2026-10-07T23:30:00.000Z",
      endsAtLocal: "2026-10-07T19:30:00-04:00",
      durationMinutes: 90,
    },
    location: {
      name: "Harbor Marina, Dock C",
      meetingPoint: "Dock C, slip 14",
      meetingInstructions: "Check in at the dock office 20 minutes before departure.",
    },
    party: {
      kind: "tickets",
      guests: 3,
      tickets: [
        { code: "adult", name: "Adult", quantity: 2 },
        { code: "child", name: "Child (3 to 12)", quantity: 1 },
      ],
    },
    extras: [
      { code: "photo", name: "Souvenir photo", quantity: 1 },
      { code: "drinks", name: "Drink voucher", quantity: 2 },
    ],
    order: { id: orderId, status: "paid", currency: "USD", lines: orderLines, totals: orderTotals },
    payment: { provider: "fake", state: "succeeded", amount: paid, currency: "USD" },
    refund: null,
    cancellation: null,
    policy: {
      version: 1,
      cancellationText: "Cancel at least 24 hours before departure for a full refund.",
      cutoffAt,
    },
    participants: { partySize: 3, participants: [ava, theo] },
    partyEditable: true,
    cancellationTerms: terms("full_refund"),
    ...over,
  };
}

/**
 * The booking once canceled under its current terms, as the API sends it back:
 * the state, the terms applied, the refund they asked for, and a party and
 * terms that no longer change.
 */
export function canceledBooking(
  from: ManagedBooking = managedBooking(),
  refundState: "requested" | "succeeded" = "requested",
): ManagedBooking {
  const now = from.cancellationTerms;
  if (now.remedy === "credit") throw new Error("a credit is issued by the operator, not canceled");
  const cancellation: BookingCancellation = {
    canceledAt: now.asOf,
    by: "guest",
    remedy: now.remedy,
    refundBp: now.refundBp,
    refundAmount: now.refundAmount,
    paidAmount: now.paidAmount,
    cutoffAt: now.cutoffAt,
    beforeCutoff: now.beforeCutoff,
    policyVersion: now.policyVersion,
  };
  return {
    ...from,
    state: "canceled",
    cancellation,
    refund:
      now.refundAmount > 0
        ? {
            state: refundState,
            amount: now.refundAmount,
            failureCode: null,
            requestedAt: now.asOf,
            settledAt:
              refundState === "succeeded"
                ? new Date(Date.parse(now.asOf) + 2 * 60_000).toISOString()
                : null,
          }
        : null,
    partyEditable: false,
    cancellationTerms: { ...now, cancelable: false, refusal: "already_canceled" },
  };
}

/** The same booking, with what canceling would do changed. */
export const withTerms = (booking: ManagedBooking, next: CancellationTerms): ManagedBooking => ({
  ...booking,
  cancellationTerms: next,
});

/** The session the page keeps in this tab, an hour from the device's now, opened with a link. */
export function storedSession(over: Partial<StoredSession> = {}): StoredSession {
  return {
    token: sessionToken,
    expiresAt: new Date(Date.now() + hour).toISOString(),
    reference,
    linkToken,
    ...over,
  };
}

/** The session "Name your party now" opens right after paying: no link was used, so none is kept. */
export function storedCheckoutSession(over: Partial<StoredSession> = {}): StoredSession {
  return {
    token: sessionToken,
    expiresAt: new Date(Date.now() + hour).toISOString(),
    reference,
    ...over,
  };
}

// The fake API --------------------------------------------------------------------------------

/** One call the page made, as the API saw it, and the page's address at that moment. */
export interface ManageCall extends Call {
  /** Where the page was when it sent this: a link's fragment must be gone from it. */
  address: string;
  referrerPolicy: string | undefined;
  cache: string | undefined;
}

export type Route =
  | "open"
  | "renew"
  | "read"
  | "saveParticipant"
  | "readTerms"
  | "cancel"
  | "emailLink"
  | "end";

export function routeOf(call: Pick<Call, "method" | "path">): Route {
  const { method, path } = call;
  if (method === "POST" && path === "/v1/public/booking-access") return "open";
  if (method === "POST" && path === "/v1/public/booking-access/renewals") return "renew";
  if (method === "GET" && path === "/v1/public/manage/booking") return "read";
  if (method === "PUT" && /^\/v1\/public\/manage\/participants\/\d+$/.test(path)) {
    return "saveParticipant";
  }
  if (method === "GET" && path === "/v1/public/manage/cancellation") return "readTerms";
  if (method === "POST" && path === "/v1/public/manage/cancellation") return "cancel";
  if (method === "POST" && path === "/v1/public/manage/link-email") return "emailLink";
  if (method === "POST" && path === "/v1/public/manage/session/end") return "end";
  throw new Error(`unexpected request ${method} ${path}`);
}

/** What the API holds: the booking its sessions open. Tests change it to change what the API says. */
export const server: { booking: ManagedBooking } = { booking: managedBooking() };

const strays: string[] = [];

/** Requests nothing answered since the last stub. Check it is empty after each test. */
export const strayRequests = () => strays.splice(0);

const sessionExpiry = () => new Date(Date.now() + hour).toISOString();

/** An answer for a route that needs the booking session, as the API checks it first. */
const withSession =
  (answer: Answer): Answer =>
  (call) =>
    call.headers.get("authorization") === `Bearer ${sessionToken}`
      ? answer(call)
      : refusal(401, "session_required");

function nameParticipant(position: number, input: ParticipantInput, was?: Participant) {
  const at = new Date(Date.now()).toISOString();
  return {
    id: was?.id ?? participantId(position),
    position,
    name: input.name,
    isMinor: input.isMinor,
    email: input.email ?? null,
    guardian: input.guardian ?? null,
    createdAt: was?.createdAt ?? at,
    updatedAt: at,
  } satisfies Participant;
}

/**
 * What the API answers for each route, from `server.booking`. A test lists one
 * of these after an answer of its own, such as `inOrder(offline, answers.read)`,
 * to have the API answer once the lost one is over.
 */
export const answers: Record<Route, Answer> = {
  open: (call) =>
    ManageSessionCreateRequest.safeParse(call.body).success
      ? json(
          {
            session: { token: sessionToken, expiresAt: sessionExpiry() },
            booking: { reference: server.booking.reference },
          },
          201,
        )
      : refusal(400, "invalid_request"),
  renew: (call) =>
    ManageLinkRenewRequest.safeParse(call.body).success
      ? json({ status: "accepted" }, 202)
      : refusal(400, "invalid_request"),
  read: withSession(() =>
    json({ booking: server.booking, session: { expiresAt: sessionExpiry() } }),
  ),
  // Names the place, or corrects the one there, as the API does.
  saveParticipant: withSession((call) => {
    const position = Number(call.path.split("/").at(-1));
    const key = IdempotencyKey.safeParse(call.headers.get("idempotency-key"));
    const input = ParticipantInput.safeParse(call.body);
    if (!key.success || !input.success) return refusal(400, "invalid_request");
    const booking = server.booking;
    if (booking.state === "canceled") return refusal(409, "booking_canceled");
    if (!booking.partyEditable) return refusal(409, "trip_departed");
    if (position < 1 || position > booking.participants.partySize) {
      return refusal(422, "position_out_of_range");
    }
    const was = booking.participants.participants.find((p) => p.position === position);
    const participant = nameParticipant(position, input.data, was);
    server.booking = {
      ...booking,
      participants: {
        ...booking.participants,
        participants: [
          ...booking.participants.participants.filter((p) => p.position !== position),
          participant,
        ].sort((a, b) => a.position - b.position),
      },
    };
    return json({ participant, created: was === undefined });
  }),
  readTerms: withSession(() => json({ terms: server.booking.cancellationTerms })),
  // Cancels once, if the guest was shown what canceling gives now.
  cancel: withSession((call) => {
    const key = IdempotencyKey.safeParse(call.headers.get("idempotency-key"));
    const body = CancelBookingRequest.safeParse(call.body);
    if (!key.success || !body.success) return refusal(400, "invalid_request");
    const { booking } = server;
    if (booking.state === "canceled") return json({ booking });
    const now = booking.cancellationTerms;
    if (now.refusal === "trip_departed") return refusal(409, "trip_departed");
    if (now.refusal === "remedy_requires_operator") {
      return refusal(409, "remedy_requires_operator");
    }
    if (body.data.expectedRefundAmount !== now.refundAmount) {
      return refusal(409, "cancellation_terms_changed");
    }
    server.booking = canceledBooking(booking);
    return json({ booking: server.booking });
  }),
  emailLink: withSession(() => json({ status: "accepted" }, 202)),
  end: withSession(() => json({ ended: true })),
};

/**
 * Stub fetch with one answer per route and record every call. Unlisted routes
 * answer as the API would for `server.booking`, which starts as the Harbor
 * booking or `options.booking`. A request to any other address or route is a
 * stray. A call that leaves its credentials in the request fails the test.
 */
export function stubManageApi(
  routes: Partial<Record<Route, Answer>> = {},
  options: { booking?: ManagedBooking } = {},
): ManageCall[] {
  server.booking = options.booking ?? managedBooking();
  strays.length = 0;
  const calls: ManageCall[] = [];
  const apiOrigin = new URL(apiBase).origin;
  const fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    // Waiver evidence (G2.15): the page's waiver card reads its own status.
    // Answered here, as no waiver applying, and not recorded, so these tests
    // see only the management page's own calls; the card has its own tests.
    if ((init?.method ?? "GET") === "GET" && url.pathname === "/v1/public/manage/waivers") {
      return new Response(
        JSON.stringify({ waivers: { applies: false, unnamedPlaces: 0, participants: [] } }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }
    const call: ManageCall = {
      method: init?.method ?? "GET",
      url: String(input),
      path: url.pathname,
      search: url.searchParams,
      headers: new Headers(init?.headers),
      body: init?.body ? JSON.parse(String(init.body)) : undefined,
      keepalive: init?.keepalive === true,
      address: window.location.href,
      referrerPolicy: init?.referrerPolicy,
      cache: init?.cache,
    };
    calls.push(call);
    if (init?.credentials !== "omit") throw new Error("credentials must be omitted");
    if (url.origin !== apiOrigin) {
      strays.push(`${call.method} ${url.origin}${call.path}`);
      throw new Error(`unexpected origin ${url.origin}`);
    }
    let route: Route;
    try {
      route = routeOf(call);
    } catch (error) {
      strays.push(`${call.method} ${call.path}`);
      throw error;
    }
    return (routes[route] ?? answers[route])(call);
  });
  vi.stubGlobal("fetch", fetch);
  return calls;
}

/** The calls to one route. */
export const callsTo = (calls: ManageCall[], route: Route) =>
  calls.filter((c) => routeOf(c) === route);
