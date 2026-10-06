import { z } from "zod";

/**
 * Capacity and holds contracts (G2.6). Staff read a trip's capacity and the
 * holds behind it. No route acquires, confirms, or releases a hold; checkout
 * (G2.7) owns those commands. The primitives mirror the private helpers in
 * index.ts, which this module cannot import without a cycle.
 */

const Uuid = z.uuid();
const Instant = z.iso.datetime({ offset: true });

export const HoldKind = z
  .enum(["seats", "whole_boat"])
  .describe("seats on a shared-seat trip; whole_boat on a private charter");
export type HoldKind = z.infer<typeof HoldKind>;

export const HoldState = z
  .enum(["active", "confirmed", "released", "expired"])
  .describe(
    "One way: active to confirmed, released, or expired; expired to confirmed when a late payment reacquires; confirmed to released",
  );
export type HoldState = z.infer<typeof HoldState>;

export const CapacityHold = z.object({
  id: Uuid,
  tripId: Uuid,
  ownerRef: z.string().describe("Opaque owner, such as checkout_session:<uuid>"),
  kind: HoldKind,
  partySize: z.number().int().min(1).describe("Guests the hold is for"),
  seats: z
    .number()
    .int()
    .min(1)
    .describe("Capacity the hold takes: its party size, or every seat for a whole boat"),
  state: HoldState,
  takesCapacity: z
    .boolean()
    .describe(
      "Confirmed, or active and not yet past its expiry instant. An active hold past its instant takes nothing, even before the sweep marks it expired",
    ),
  expiresAt: Instant,
  createdAt: Instant,
  confirmedAt: Instant.nullable(),
  releasedAt: Instant.nullable(),
  expiredAt: Instant.nullable(),
});
export type CapacityHold = z.infer<typeof CapacityHold>;

export const TripCapacityDetail = z.object({
  tripId: Uuid,
  kind: HoldKind,
  total: z.number().int().min(1),
  held: z.number().int().min(0).describe("Seats taken by holds still within their time"),
  confirmed: z.number().int().min(0).describe("Seats taken by confirmed holds"),
  remaining: z.number().int().min(0),
  soldOut: z.boolean(),
});
export type TripCapacityDetail = z.infer<typeof TripCapacityDetail>;

export const TripHoldsResponse = z
  .object({ capacity: TripCapacityDetail, holds: z.array(CapacityHold) })
  .describe("Every hold on the trip, in any state, oldest first, with the capacity left now");
export type TripHoldsResponse = z.infer<typeof TripHoldsResponse>;
