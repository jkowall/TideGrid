import { z } from "zod";

/**
 * Catalog and schedule contracts (G2.4). Local dates and times are the
 * operator's wall clock in the trip's IANA zone; instants are RFC 3339 in UTC;
 * `*Local` fields repeat the instant with its offset for display. The
 * primitives below mirror the private helpers in index.ts, which this module
 * cannot import without a cycle.
 */

const Uuid = z.uuid();
const Instant = z.iso.datetime({ offset: true });
const LocalDate = z.iso.date().describe("Local calendar date, YYYY-MM-DD");
const LocalTime = z
  .string()
  .regex(/^([01]\d|2[0-3]):[0-5]\d$/)
  .describe("Local wall-clock time, HH:MM, 24-hour");
const OffsetDateTime = z.iso
  .datetime({ offset: true, local: false })
  .describe("The same instant with the zone's offset, for display");
const TimeZone = z.string().describe("IANA time zone name, such as America/New_York");
const Reason = z
  .string()
  .trim()
  .min(1)
  .max(500)
  // biome-ignore lint/suspicious/noControlCharactersInRegex: the pattern exists to reject them.
  .regex(/^[^\u0000-\u001f\u007f]*$/, "Control characters are not allowed")
  .describe("Recorded in the audit history");

export const ProductKind = z.enum(["shared_seat", "private_charter"]);
export type ProductKind = z.infer<typeof ProductKind>;

export const ProductSalesStatus = z.enum(["draft", "published", "archived"]);
export type ProductSalesStatus = z.infer<typeof ProductSalesStatus>;

/**
 * Stored trip sales states. Sold out is reported through `capacity`, not as a
 * state; delayed belongs to trip changes, which the demo defers.
 */
export const TripSalesState = z.enum(["draft", "published", "closed", "canceled", "completed"]);
export type TripSalesState = z.infer<typeof TripSalesState>;

export const TripCapacity = z
  .object({
    kind: z.enum(["seats", "whole_boat"]),
    total: z.number().int().min(1).describe("Seats sold per trip, or guests aboard a charter"),
    remaining: z
      .number()
      .int()
      .min(0)
      .describe("Seats left, or the full total while the boat is free and 0 once taken"),
    // G2.6. Optional in the schema only so earlier clients and fixtures keep
    // validating; the API sends it on every trip.
    soldOut: z
      .boolean()
      .optional()
      .describe(
        "True when nothing remains, counting unexpired holds as taken. Guest listings omit trips without room for the party, so it is false there",
      ),
  })
  .describe(
    "Seats held by unexpired checkouts and confirmed seats are taken; a whole-boat hold takes every seat. Advisory: only acquiring a hold decides",
  );
export type TripCapacity = z.infer<typeof TripCapacity>;

/** Staff see how the taken seats split (G2.6). Sent on every staff trip; optional for the same reason. */
export const StaffTripCapacity = TripCapacity.extend({
  held: z
    .number()
    .int()
    .min(0)
    .optional()
    .describe("Seats taken by holds still within their time; a held charter counts every seat"),
  confirmed: z
    .number()
    .int()
    .min(0)
    .optional()
    .describe("Seats taken by confirmed holds; a confirmed charter counts every seat"),
}).describe("Capacity left, with the taken seats split into held and confirmed. Advisory");
export type StaffTripCapacity = z.infer<typeof StaffTripCapacity>;

export const TripTiming = z.object({
  timeZone: TimeZone,
  localDate: LocalDate,
  localStartTime: LocalTime,
  startsAt: Instant,
  endsAt: Instant,
  startsAtLocal: OffsetDateTime,
  endsAtLocal: OffsetDateTime,
  durationMinutes: z.number().int(),
});

// Public availability -----------------------------------------------------------

export const TripAvailabilityQuery = z.object({
  from: LocalDate.describe("First local date, inclusive"),
  to: LocalDate.describe("Last local date, inclusive; at most 92 days after from"),
  party: z.coerce.number().int().min(1).max(500).default(1),
  product: Uuid.optional().describe("Limit results to one product"),
});
export type TripAvailabilityQuery = z.infer<typeof TripAvailabilityQuery>;

export const AvailableTrip = TripTiming.extend({
  tripId: Uuid,
  product: z.object({
    id: Uuid,
    name: z.string(),
    kind: ProductKind,
    summary: z.string(),
    minPartySize: z.number().int(),
    maxPartySize: z.number().int(),
  }),
  location: z.object({ name: z.string(), meetingPoint: z.string() }),
  salesCloseAt: Instant.describe("Booking cutoff: no new checkout at or after this instant"),
  capacity: TripCapacity,
});
export type AvailableTrip = z.infer<typeof AvailableTrip>;

export const TripAvailabilityResponse = z
  .object({ trips: z.array(AvailableTrip) })
  .describe(
    "Published trips of published products, inside the sales window, clear of blackouts, with room for the party. Sorted by start.",
  );
export type TripAvailabilityResponse = z.infer<typeof TripAvailabilityResponse>;

// Staff views ---------------------------------------------------------------------

export const StaffTrip = TripTiming.extend({
  tripId: Uuid,
  productId: Uuid,
  productName: z.string(),
  productKind: ProductKind,
  boatId: Uuid,
  boatName: z.string(),
  scheduleId: Uuid.nullable(),
  salesState: TripSalesState,
  salesStateChangedAt: Instant,
  salesCloseAt: Instant,
  blackedOut: z.boolean().describe("A blackout overlaps the trip, so it is hidden from guests"),
  capacity: StaffTripCapacity,
});
export type StaffTrip = z.infer<typeof StaffTrip>;

export const StaffTripQuery = z.object({
  from: LocalDate.describe("First local date, inclusive"),
  to: LocalDate.describe("Last local date, inclusive; at most 92 days after from"),
});

export const StaffTripListResponse = z.object({ trips: z.array(StaffTrip) });
export type StaffTripListResponse = z.infer<typeof StaffTripListResponse>;

export const CatalogLocation = z.object({
  id: Uuid,
  name: z.string(),
  timeZone: TimeZone,
  meetingPoint: z.string(),
  status: z.enum(["active", "archived"]),
});

export const CatalogBoat = z.object({
  id: Uuid,
  name: z.string(),
  guestCapacity: z.number().int(),
  status: z.enum(["active", "retired"]),
});

export const CatalogProduct = z.object({
  id: Uuid,
  locationId: Uuid,
  kind: ProductKind,
  name: z.string(),
  summary: z.string(),
  durationMinutes: z.number().int(),
  bookingCutoffMinutes: z.number().int(),
  turnaroundBufferMinutes: z.number().int(),
  minPartySize: z.number().int(),
  maxPartySize: z.number().int(),
  seatLimit: z.number().int().nullable(),
  salesStatus: ProductSalesStatus,
  eligibleBoatIds: z.array(Uuid),
});
export type CatalogProduct = z.infer<typeof CatalogProduct>;

export const CatalogSchedule = z.object({
  id: Uuid,
  productId: Uuid,
  boatId: Uuid,
  timeZone: TimeZone,
  startsOn: LocalDate,
  endsOn: LocalDate,
  weekdays: z.array(z.number().int().min(1).max(7)).describe("1 is Monday, 7 is Sunday"),
  startTimes: z.array(LocalTime),
  ambiguousTime: z.enum(["earlier", "later", "reject"]),
  status: z.enum(["active", "paused", "ended"]),
});

export const CatalogResponse = z.object({
  locations: z.array(CatalogLocation),
  boats: z.array(CatalogBoat),
  products: z.array(CatalogProduct),
  schedules: z.array(CatalogSchedule),
});
export type CatalogResponse = z.infer<typeof CatalogResponse>;

// Staff commands ------------------------------------------------------------------

export const ScheduleParams = z.object({ tenantId: z.string(), scheduleId: z.string() });
export const TripParams = z.object({ tenantId: z.string(), tripId: z.string() });
export const ProductParams = z.object({ tenantId: z.string(), productId: z.string() });

export const GenerateTripsRequest = z.object({
  fromDate: LocalDate.describe("First local date, inclusive"),
  toDate: LocalDate.describe("Last local date, inclusive; at most 92 days after fromDate"),
  publish: z.boolean().default(false).describe("Create the trips published instead of draft"),
  reason: Reason,
});
export type GenerateTripsRequest = z.infer<typeof GenerateTripsRequest>;

export const SkippedDeparture = z.object({
  localDate: LocalDate,
  localStartTime: LocalTime,
  reason: z
    .enum([
      "nonexistent_local_time",
      "ambiguous_local_time",
      "blackout",
      "boat_conflict",
      "zone_data_mismatch",
    ])
    .describe(
      "boat_conflict: the boat is busy then, counting turnaround. zone_data_mismatch: the runtime and the database read this zone's clock differently, so nothing was guessed.",
    ),
});

export const GenerateTripsResponse = z.object({
  created: z.array(StaffTrip),
  alreadyScheduled: z.number().int().describe("Departures that already existed; left unchanged"),
  skipped: z.array(SkippedDeparture),
});
export type GenerateTripsResponse = z.infer<typeof GenerateTripsResponse>;

export const TripSalesStateRequest = z.object({
  to: z.enum(["published", "closed", "canceled", "completed"]),
  reason: Reason,
});
export type TripSalesStateRequest = z.infer<typeof TripSalesStateRequest>;

export const TripResponse = z.object({ trip: StaffTrip });
export type TripResponse = z.infer<typeof TripResponse>;

export const PublishProductRequest = z.object({ reason: Reason });

export const ProductResponse = z.object({ product: CatalogProduct });
export type ProductResponse = z.infer<typeof ProductResponse>;

/**
 * Error codes a publish attempt can return, in the order they are checked.
 * The last two (G2.5): a product needs a price list and a policy.
 */
export const ProductPublishProblem = z.enum([
  "product_archived",
  "product_location_inactive",
  "product_missing_eligible_boat",
  "product_party_exceeds_capacity",
  "product_missing_price",
  "product_missing_policy",
]);
export type ProductPublishProblem = z.infer<typeof ProductPublishProblem>;
