import { z } from "zod";
import { TripSummary } from "./catalog.ts";
import { PaymentProviderName, RefundState } from "./checkout.ts";
import { bookingReferencePattern } from "./references.ts";

/**
 * Console booking reads (G2.12b): a day's bookings, one booking in detail, a
 * lookup by booking reference, and a trip's roster. All read-only.
 *
 * Who sees what. Every role that holds `payments.read` (owners, booking
 * staff, and finance) reads bookings, their parties and extras, totals,
 * order lines, payments, refunds, and exceptions. The booker's name and email
 * are personal data: they are sent only to roles that also hold
 * `bookings.read` (owners and booking staff). For any other role the `booker`
 * field is absent from the response, never blank or masked. A trip's roster
 * is a booking-management view and needs `bookings.read`.
 *
 * Money is integer US cents. A trip's local date and time are the stored wall
 * clock at the marina; instants are RFC 3339. The primitives below mirror the
 * private helpers in index.ts, which this module cannot import without a cycle.
 */

const Uuid = z.uuid();
const Instant = z.iso.datetime({ offset: true });
const Cents = z.number().int().describe("Integer US cents");
const LocalDate = z.iso.date().describe("Local calendar date at the marina, YYYY-MM-DD");
const OffsetDateTime = z.iso
  .datetime({ offset: true, local: false })
  .describe("The same instant with the zone's offset, for display");

export const BookingReference = z
  .string()
  .regex(bookingReferencePattern)
  .describe("Eight characters of Crockford base32; what the guest and the operator quote");

const PaymentState = z.enum(["pending", "succeeded", "failed"]);

// Shared pieces ------------------------------------------------------------------

export const BookingTicketCount = z.object({
  code: z.string().describe("The ticket type's code, such as adult"),
  name: z.string().describe("The ticket type as sold, such as Child (3 to 12)"),
  quantity: z.number().int().min(1),
});
export type BookingTicketCount = z.infer<typeof BookingTicketCount>;

export const BookingParty = z
  .discriminatedUnion("kind", [
    z.object({
      kind: z.literal("tickets"),
      guests: z.number().int().min(1).describe("Seats booked: the sum of the tickets"),
      tickets: z.array(BookingTicketCount).describe("Counts by ticket type, in the order sold"),
    }),
    z.object({
      kind: z.literal("charter"),
      guests: z.number().int().min(1).describe("Guests aboard, as the booker gave them"),
      charter: z.string().describe("The charter as sold, such as Whole boat, up to 12 guests"),
    }),
  ])
  .describe("Who is coming, from the order: counts by ticket type, or a charter's guests");
export type BookingParty = z.infer<typeof BookingParty>;

export const BookingExtra = z
  .object({
    code: z.string(),
    name: z.string(),
    quantity: z.number().int().min(1),
  })
  .describe("A paid add-on on the order");
export type BookingExtra = z.infer<typeof BookingExtra>;

export const BookingPaymentStatus = z
  .object({
    state: PaymentState.describe("The charge: succeeded once a verified provider event says so"),
    refund: z
      .object({ state: RefundState, amount: Cents })
      .nullable()
      .describe("A refund of the charge, when there is one"),
  })
  .describe("Paid is a succeeded charge with no refund");
export type BookingPaymentStatus = z.infer<typeof BookingPaymentStatus>;

const BookerName = z
  .object({ name: z.string() })
  .optional()
  .describe(
    "Personal data. Present only for roles that hold bookings.read (owners and booking staff); absent otherwise",
  );

const BookerContact = z
  .object({ name: z.string(), email: z.string() })
  .optional()
  .describe(
    "Personal data. Present only for roles that hold bookings.read (owners and booking staff); absent otherwise",
  );

// A day's bookings ------------------------------------------------------------------

export const BookingListQuery = z.object({
  date: LocalDate.describe("The marina's local date: bookings on trips departing that day"),
  tripId: Uuid.optional().describe(
    "Only this trip's bookings. A trip of another operator, or on another date, matches nothing",
  ),
  limit: z.coerce.number().int().min(1).max(200).default(100),
  after: Uuid.optional().describe(
    "Cursor: the last booking id of the previous page (nextAfter). One that names no booking of this operator answers 400 cursor_invalid",
  ),
});
export type BookingListQuery = z.infer<typeof BookingListQuery>;

export const BookingDayTrip = TripSummary.extend({
  bookings: z.number().int().min(0).describe("Bookings on the trip"),
  guests: z.number().int().min(0).describe("Guests across those bookings"),
});
export type BookingDayTrip = z.infer<typeof BookingDayTrip>;

export const BookingListItem = z.object({
  id: Uuid,
  reference: BookingReference,
  tripId: Uuid.describe("One of the response's trips"),
  state: z.literal("confirmed"),
  source: z.literal("direct").describe("direct: booked by the guest online"),
  confirmedAt: Instant,
  booker: BookerName,
  party: BookingParty,
  extras: z.array(BookingExtra),
  total: Cents.describe("The order's total"),
  currency: z.literal("USD"),
  payment: BookingPaymentStatus,
});
export type BookingListItem = z.infer<typeof BookingListItem>;

export const BookingListResponse = z
  .object({
    date: LocalDate,
    trips: z
      .array(BookingDayTrip)
      .describe(
        "Every trip departing on the date, in any sales state, with its booking and guest counts across all pages; sorted by departure; at most 200",
      ),
    bookings: z
      .array(BookingListItem)
      .describe("This page, sorted by departure, then by confirmation"),
    nextAfter: Uuid.nullable().describe(
      "Pass as after for the next page; null on the last page. The same cursor always returns the same page while nothing is booked in between",
    ),
  })
  .describe("Bookings on trips departing on one local date");
export type BookingListResponse = z.infer<typeof BookingListResponse>;

// One booking -------------------------------------------------------------------------

export const BookingParams = z.object({
  tenantId: z.string(),
  bookingId: z.string().describe("Booking UUID; anything else answers 404"),
});

export const BookingOrderLine = z.object({
  lineNo: z.number().int().min(1),
  kind: z
    .enum(["service", "add_on", "fee", "discount", "tax"])
    .describe("service: tickets or the charter price"),
  code: z.string(),
  name: z.string(),
  basis: z.enum(["per_booking", "per_participant"]).nullable().describe("Fees and add-ons only"),
  quantity: z.number().int().min(1),
  unitAmount: Cents,
  amount: Cents.describe("Negative on the discount line"),
  taxInclusive: z
    .boolean()
    .nullable()
    .describe("Tax lines only: true when the tax is inside the prices and reported, not added"),
});
export type BookingOrderLine = z.infer<typeof BookingOrderLine>;

export const BookingOrder = z
  .object({
    id: Uuid,
    status: z.enum(["pending", "paid", "void"]),
    currency: z.literal("USD"),
    lines: z
      .array(BookingOrderLine)
      .describe("In order: trip price, add-ons, fees, discount, taxes"),
    totals: z.object({
      subtotal: Cents.describe("Trip price and add-ons, before the discount"),
      discount: Cents,
      fees: Cents,
      tax: Cents.describe("Taxes added on top of prices"),
      includedTax: Cents.describe("Taxes already inside prices; informational"),
      total: Cents.describe("subtotal - discount + fees + tax"),
    }),
  })
  .describe("The immutable order, copied from the quote the guest accepted");
export type BookingOrder = z.infer<typeof BookingOrder>;

export const BookingPayment = z.object({
  provider: PaymentProviderName,
  state: PaymentState,
  amount: Cents,
  currency: z.literal("USD"),
  providerReference: z
    .string()
    .nullable()
    .describe(
      "The provider's payment id, masked: its prefix and last four characters, such as fpay_••••a1B2",
    ),
  createdAt: Instant,
  succeededAt: Instant.nullable(),
});
export type BookingPayment = z.infer<typeof BookingPayment>;

export const BookingRefund = z.object({
  state: RefundState,
  amount: Cents,
  failureCode: z.string().nullable(),
  requestedAt: Instant,
  settledAt: Instant.nullable(),
});
export type BookingRefund = z.infer<typeof BookingRefund>;

export const BookingTimelineEvent = z.object({
  kind: z.enum([
    "checkout_opened",
    "paid",
    "confirmed",
    "refund_requested",
    "refunded",
    "refund_failed",
  ]),
  at: Instant,
});
export type BookingTimelineEvent = z.infer<typeof BookingTimelineEvent>;

export const BookingDetail = z.object({
  id: Uuid,
  reference: BookingReference,
  state: z.literal("confirmed"),
  source: z.literal("direct"),
  reacquired: z
    .boolean()
    .describe("Confirmed after its hold had expired, by taking the seats again"),
  confirmedAt: Instant,
  trip: TripSummary.extend({
    endsAt: Instant,
    endsAtLocal: OffsetDateTime,
    durationMinutes: z.number().int(),
  }),
  location: z.object({
    name: z.string(),
    meetingPoint: z.string(),
    meetingInstructions: z.string(),
  }),
  booker: BookerContact,
  party: BookingParty,
  extras: z.array(BookingExtra),
  policyVersion: z.number().int().min(1).describe("The policy version the guest accepted"),
  order: BookingOrder,
  payment: BookingPayment,
  refund: BookingRefund.nullable(),
  timeline: z
    .array(BookingTimelineEvent)
    .describe("Checkout opened, paid, confirmed, and any refund, oldest first"),
});
export type BookingDetail = z.infer<typeof BookingDetail>;

export const BookingDetailResponse = z.object({ booking: BookingDetail });
export type BookingDetailResponse = z.infer<typeof BookingDetailResponse>;

// Lookup by reference ------------------------------------------------------------------

export const BookingReferenceParams = z.object({
  tenantId: z.string(),
  reference: z
    .string()
    .describe(
      "A booking reference as typed: case, spaces, and hyphens are ignored, and O, I, and L read as 0, 1, and 1. Anything that cannot be a reference answers 404",
    ),
});

export const BookingReferenceResponse = z.object({
  booking: z.object({
    id: Uuid,
    reference: BookingReference,
    tripId: Uuid,
    localDate: LocalDate.describe("The trip's local date at the marina"),
  }),
});
export type BookingReferenceResponse = z.infer<typeof BookingReferenceResponse>;

// A trip's roster --------------------------------------------------------------------------

export const RosterBooking = z.object({
  id: Uuid,
  reference: BookingReference,
  booker: z.object({ name: z.string() }).describe("Personal data; the roster needs bookings.read"),
  party: BookingParty,
  extras: z.array(BookingExtra),
  payment: BookingPaymentStatus,
});
export type RosterBooking = z.infer<typeof RosterBooking>;

export const TripRoster = z
  .object({
    generatedAt: Instant.describe("When the roster was read; it lists the bookings as of then"),
    trip: TripSummary.extend({
      endsAt: Instant,
      endsAtLocal: OffsetDateTime,
      durationMinutes: z.number().int(),
      seats: z.number().int().min(1).describe("Seats sold per trip, or guests aboard a charter"),
    }),
    location: z.object({
      name: z.string(),
      meetingPoint: z.string(),
      meetingInstructions: z.string(),
    }),
    totals: z.object({
      bookings: z.number().int().min(0),
      guests: z.number().int().min(0),
      tickets: z.array(BookingTicketCount).describe("Shared seats: counts by ticket type"),
      extras: z.array(BookingExtra).describe("Every add-on to prepare, summed"),
    }),
    bookings: z
      .array(RosterBooking)
      .describe("Every booking on the trip, oldest first. Complete: a trip seats at most 500"),
  })
  .describe(
    "A booking-management roster for one trip. Not a passenger manifest: participants and waivers are not collected yet",
  );
export type TripRoster = z.infer<typeof TripRoster>;

export const TripRosterResponse = z.object({ roster: TripRoster });
export type TripRosterResponse = z.infer<typeof TripRosterResponse>;
