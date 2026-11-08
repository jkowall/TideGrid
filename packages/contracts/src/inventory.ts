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

export const TripHoldsQuery = z.object({
  limit: z.coerce
    .number()
    .int()
    .min(1)
    .max(200)
    .default(100)
    .describe("Holds on this page; 1 to 200, 100 when absent (W1-INV-PRICING)"),
  after: Uuid.optional().describe(
    "Cursor: the last hold id of the previous page (nextAfter). One that names no hold on this trip of this operator answers 400 cursor_invalid",
  ),
});
export type TripHoldsQuery = z.infer<typeof TripHoldsQuery>;

export const TripHoldsResponse = z
  .object({
    capacity: TripCapacityDetail,
    holds: z.array(CapacityHold).describe("This page, oldest first: by creation, then by id"),
    nextAfter: Uuid.nullable().describe(
      "Pass as after for the next page; null on the last page. Holds are never deleted and a hold's creation time never changes, so a cursor stays valid and a page never repeats a hold. A hold's creation time is the start of the transaction that made it, so a hold whose transaction began before a page was read and committed after it can land before that page's cursor. Read again from the first page to see every hold",
    ),
  })
  .describe(
    "The trip's holds, in any state, a page at a time, oldest first, with the capacity left now",
  );
export type TripHoldsResponse = z.infer<typeof TripHoldsResponse>;
