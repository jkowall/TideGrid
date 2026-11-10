import { z } from "zod";
import { ManagedBooking } from "./self-service.ts";

/**
 * Moving a whole booking to another trip of its product (W3-G2.11-rest). The
 * guest moves it from the booking session before the policy's change cutoff;
 * staff move it too, and an owner may move it after the cutoff with a reason.
 * The booking keeps the price it was sold at.
 */

const Instant = z.iso.datetime({ offset: true });
const Uuid = z.uuid();

// biome-ignore lint/suspicious/noControlCharactersInRegex: the pattern exists to reject them.
const noControl = /^[^\u0000-\u001f\u007f]*$/;

export const RescheduleRefusal = z
  .enum(["not_confirmed", "trip_departed", "past_cutoff"])
  .describe(
    "not_confirmed: the booking was canceled. trip_departed: its trip has left. past_cutoff: at or after the policy's change cutoff, so only an owner may move it, with a reason",
  );

export const TripOptionIssue = z
  .string()
  .describe(
    "Why this trip cannot take the booking now: trip_canceled, trip_unavailable, sales_closed, party_size_out_of_range, insufficient_capacity, or balance_due_after_trip (a charter's balance would fall due after it leaves). A client shows any other code generically",
  );

export const RescheduleOption = z.object({
  tripId: Uuid,
  startsAt: Instant,
  endsAt: Instant,
  timeZone: z.string(),
  available: z.boolean().describe("True when a move there would be accepted now; advisory"),
  issue: TripOptionIssue.nullable(),
});

export const RescheduleRecord = z.object({
  rescheduleId: Uuid,
  fromTripId: Uuid,
  toTripId: Uuid,
  fromStartsAt: Instant,
  toStartsAt: Instant,
  beforeCutoff: z.boolean(),
  overridden: z.boolean().describe("True when an owner moved it against the policy, with a reason"),
  by: z.enum(["staff", "guest", "system", "support"]),
  movedAt: Instant,
});
export type RescheduleRecord = z.infer<typeof RescheduleRecord>;

export const ReschedulePreview = z
  .object({
    reference: z.string(),
    state: z.enum(["confirmed", "canceled"]),
    movable: z.boolean().describe("True when it may move now without an override"),
    refusal: RescheduleRefusal.nullable(),
    tripId: Uuid.describe("The trip it is on now"),
    departsAt: Instant,
    cutoffAt: Instant,
    beforeCutoff: z.boolean(),
    policyVersion: z.number().int().min(1),
    policyText: z.string().describe("The policy's reschedule text"),
    partySize: z.number().int().min(1),
    price: z
      .object({
        amount: z.number().int().min(0),
        currency: z.literal("USD"),
        changes: z.literal(false),
      })
      .describe("The booking keeps the price it was sold at: a move neither charges nor refunds"),
    options: z
      .array(RescheduleOption)
      .max(30)
      .describe("Other trips of the product, soonest first, up to 30 within a year"),
    moves: z.array(RescheduleRecord).describe("Earlier moves, oldest first"),
    asOf: Instant,
  })
  .describe("What moving the booking now would do, on the server's clock");
export type ReschedulePreview = z.infer<typeof ReschedulePreview>;

export const ReschedulePreviewResponse = z.object({ preview: ReschedulePreview });
export type ReschedulePreviewResponse = z.infer<typeof ReschedulePreviewResponse>;

export const RescheduleRequest = z.object({
  fromTripId: Uuid.describe(
    "The trip the booking was on when the preview was read. If it is on another now, nothing changes (409 booking_changed)",
  ),
  toTripId: Uuid,
});
export type RescheduleRequest = z.infer<typeof RescheduleRequest>;

export const StaffRescheduleRequest = RescheduleRequest.extend({
  overrideReason: z
    .string()
    .trim()
    .min(1)
    .max(500)
    .regex(noControl)
    .nullable()
    .optional()
    .describe(
      "Owners only (bookings.override): why a booking past its change cutoff moves anyway. Kept in the audit history",
    ),
});
export type StaffRescheduleRequest = z.infer<typeof StaffRescheduleRequest>;

export const StaffRescheduleResponse = z.object({ move: RescheduleRecord });
export type StaffRescheduleResponse = z.infer<typeof StaffRescheduleResponse>;

export const GuestRescheduleResponse = z.object({
  booking: ManagedBooking,
  move: RescheduleRecord,
});
export type GuestRescheduleResponse = z.infer<typeof GuestRescheduleResponse>;
