/**
 * Giving up one place in a shared-seat booking's party (W3-G2.11-rest,
 * docs/v2/02: "remove shared-seat participants", "Removing a participant
 * releases their seat"). One transaction: the change's row, the participant
 * at that place (if one was named) marked removed and their waivers withdrawn
 * through the `participantRemoved` hook, the booking's hold released, a new
 * confirmed hold for the smaller party taken on the same trip, and the
 * booking pointed at it. The database checks every rule again (migration
 * 0035) and, at commit, that the old hold went back.
 *
 * The hold is released before the smaller one is taken, because on a full
 * trip the smaller hold would not fit beside it. Both happen under the trip's
 * lock, so no one else can take the seat in between; if the smaller hold is
 * refused (the trip is no longer on sale, or the party would fall below the
 * product's minimum), everything since the savepoint is rolled back and
 * nothing changes.
 *
 * Coordinator defaults pending the owner's confirmation (the W3-G2.11-rest
 * participant removal entry in docs/v2/06): the booking keeps the price it
 * was sold at, so giving up a place neither charges nor refunds; only shared-
 * seat bookings; before the policy's change cutoff the guest or staff may do
 * it, at or after the cutoff only an owner with a reason; never after the
 * trip has left, and never the last place (that is a cancellation). The
 * smaller hold is taken like a new sale, so the trip must still be on sale.
 *
 * Lock order: checkout session, booking, payment (as cancellation and moves
 * take them), the trip, then the participant, then the holds inside the
 * inventory calls.
 */
import { randomUUID } from "node:crypto";
import { isUuid, type TenantContext, type TenantTransaction } from "@tidegrid/database";
import {
  acquireHold,
  confirmHold,
  type NotBookableReason,
  releaseHold,
} from "@tidegrid/domain-inventory";
import { sql } from "kysely";
import { type BookingHooks, noBookingHooks } from "./hooks.ts";
import { placesGivenUp, placesOf, withdrawProfileAccess } from "./participants.ts";
import { iso, record } from "./views.ts";

export interface PartyChangeRecord {
  partyChangeId: string;
  /** The place given up, as the party numbered it. */
  position: number;
  /** The participant named at that place, now removed; null when it was unnamed. */
  participantId: string | null;
  fromPartySize: number;
  toPartySize: number;
  beforeCutoff: boolean;
  overridden: boolean;
  by: "staff" | "guest" | "system" | "support";
  changedAt: string;
}

/** Why the smaller party cannot keep its seats on the trip now. */
export type PartyChangeIssue = NotBookableReason | "insufficient_capacity";

export type RemoveParticipantResult =
  | { kind: "removed"; change: PartyChangeRecord }
  /** The same place was already given up, from the same party size: that change. */
  | { kind: "already_removed"; change: PartyChangeRecord }
  | { kind: "not_found" }
  | { kind: "not_confirmed" }
  /** A private charter: its party takes the whole boat, so no seat is freed. */
  | { kind: "not_shared_seat" }
  | { kind: "trip_departed" }
  /** At or after the cutoff and no override was given. */
  | { kind: "past_cutoff" }
  /** The party is no longer the size the asker saw. */
  | { kind: "booking_changed" }
  /** The party has no such place now. */
  | { kind: "place_not_found" }
  /** One place is left: give it up by canceling the booking. */
  | { kind: "last_place" }
  | { kind: "trip_unavailable"; issue: PartyChangeIssue };

export interface RemoveParticipantInput {
  bookingId: string;
  /** The place to give up: one of the party's places now. */
  position: number;
  /** The party size the asker saw; a change from any other size is refused. */
  partySize: number;
  /** Staff only: why the policy is set aside. The caller checks the permission. */
  overrideReason?: string | null;
}

interface BookingRow {
  state: "confirmed" | "canceled";
  payment_id: string;
  trip_id: string;
  hold_id: string;
  party_size: number;
  product_kind: "shared_seat" | "private_charter";
  min_party_size: number;
  departed: boolean;
  before_cutoff: boolean;
}

interface ChangeRow {
  id: string;
  position: number;
  participant_id: string | null;
  from_party_size: number;
  to_party_size: number;
  before_cutoff: boolean;
  override_reason: string | null;
  actor_type: PartyChangeRecord["by"];
  created_at: Date | string;
}

function toRecord(row: ChangeRow): PartyChangeRecord {
  return {
    partyChangeId: row.id,
    position: row.position,
    participantId: row.participant_id,
    fromPartySize: row.from_party_size,
    toPartySize: row.to_party_size,
    beforeCutoff: row.before_cutoff,
    overridden: row.override_reason !== null,
    by: row.actor_type,
    changedAt: iso(row.created_at),
  };
}

/** A booking's party changes, oldest first. Empty for an unknown booking. */
export async function listPartyChanges(
  trx: TenantTransaction,
  tenantId: string,
  bookingId: string,
): Promise<PartyChangeRecord[]> {
  if (!isUuid(bookingId)) return [];
  const { rows } = await sql<ChangeRow>`
    select id, position, participant_id, from_party_size, to_party_size, before_cutoff,
           override_reason, actor_type, created_at
      from booking_party_changes
     where tenant_id = ${tenantId} and booking_id = ${bookingId}
     order by created_at, id`.execute(trx);
  return rows.map(toRecord);
}

// biome-ignore lint/suspicious/noControlCharactersInRegex: the pattern exists to reject them.
const reasonPattern = /^[^\u0000-\u001f\u007f]{1,500}$/;

/**
 * Give up one place in a confirmed shared-seat booking's party, and remove
 * whoever was named there, once per request. With `overrideReason` (staff
 * with the override permission only; the caller checks), a change at or
 * after the change cutoff is allowed. The caller claims its idempotency key
 * first and delivers any queued email after commit.
 */
export async function removeParticipant(
  trx: TenantTransaction,
  ctx: TenantContext,
  input: RemoveParticipantInput,
  hooks: BookingHooks = noBookingHooks,
): Promise<RemoveParticipantResult> {
  const overrideReason = input.overrideReason ?? null;
  if (overrideReason !== null && !reasonPattern.test(overrideReason)) {
    throw new RangeError("an override reason is 1 to 500 characters, with no control characters");
  }
  if (!Number.isInteger(input.position) || input.position < 1 || input.position > 500) {
    throw new RangeError("a place is a whole number from 1 to 500");
  }
  if (!Number.isInteger(input.partySize) || input.partySize < 1 || input.partySize > 500) {
    throw new RangeError("a party size is a whole number from 1 to 500");
  }
  if (!isUuid(input.bookingId)) return { kind: "not_found" };
  const tenantId = ctx.tenantId;

  // The session first, as confirmation, cancellation, and moves take it, then
  // the booking and the payment.
  const { rows: located } = await sql<{ checkout_session_id: string }>`
    select checkout_session_id from bookings
     where tenant_id = ${tenantId} and id = ${input.bookingId}`.execute(trx);
  const sessionId = located[0]?.checkout_session_id;
  if (!sessionId) return { kind: "not_found" };
  await sql`select id from checkout_sessions where tenant_id = ${tenantId} and id = ${sessionId}
              for update`.execute(trx);
  const { rows: booked } = await sql<BookingRow>`
    select b.state, b.payment_id, b.trip_id, b.hold_id, b.party_size,
           p.kind as product_kind, p.min_party_size,
           t.starts_at <= now() as departed,
           now() < t.starts_at - make_interval(mins => v.change_cutoff_minutes) as before_cutoff
      from bookings b
      join orders o on o.tenant_id = b.tenant_id and o.id = b.order_id
      join products p on p.tenant_id = o.tenant_id and p.id = o.product_id
      join scheduled_trips t on t.tenant_id = b.tenant_id and t.id = b.trip_id
      join policy_versions v
        on v.tenant_id = o.tenant_id and v.product_id = o.product_id
       and v.version = o.policy_version
     where b.tenant_id = ${tenantId} and b.id = ${input.bookingId}
       for no key update of b`.execute(trx);
  const row = booked[0];
  if (!row) throw new Error("a located booking was not found");
  await sql`select id from payments where tenant_id = ${tenantId} and id = ${row.payment_id}
              for update`.execute(trx);

  if (row.state !== "confirmed") return { kind: "not_confirmed" };
  const givenUp = await placesGivenUp(trx, tenantId, input.bookingId);
  if (givenUp.includes(input.position)) {
    // A repeat of the change that gave this place up answers with that change.
    const earlier = (await listPartyChanges(trx, tenantId, input.bookingId)).find(
      (c) => c.position === input.position,
    );
    return earlier && earlier.fromPartySize === input.partySize
      ? { kind: "already_removed", change: earlier }
      : { kind: "place_not_found" };
  }
  if (row.product_kind !== "shared_seat") return { kind: "not_shared_seat" };
  if (row.party_size !== input.partySize) return { kind: "booking_changed" };
  if (!placesOf(row.party_size, givenUp).includes(input.position)) {
    return { kind: "place_not_found" };
  }
  if (row.departed) return { kind: "trip_departed" };
  if (!row.before_cutoff && overrideReason === null) return { kind: "past_cutoff" };
  if (row.party_size === 1) return { kind: "last_place" };
  if (row.party_size - 1 < row.min_party_size) {
    return { kind: "trip_unavailable", issue: "party_size_out_of_range" };
  }

  await sql`select id from scheduled_trips where tenant_id = ${tenantId} and id = ${row.trip_id}
              for no key update`.execute(trx);
  const { rows: named } = await sql<{ id: string }>`
    select id from booking_participants
     where tenant_id = ${tenantId} and booking_id = ${input.bookingId}
       and position = ${input.position}
       for no key update`.execute(trx);
  const participantId = named[0]?.id ?? null;

  const partyChangeId = randomUUID();
  const ownerRef = `booking_party_change:${partyChangeId}`;
  const toPartySize = row.party_size - 1;
  await sql`savepoint booking_party_change`.execute(trx);
  try {
    const { rows: inserted } = await sql<ChangeRow>`
      insert into booking_party_changes
        (id, tenant_id, booking_id, trip_id, from_hold_id, from_party_size, to_party_size,
         position, participant_id, before_cutoff, override_reason)
      values (${partyChangeId}, ${tenantId}, ${input.bookingId}, ${row.trip_id}, ${row.hold_id},
              ${row.party_size}, ${toPartySize}, ${input.position}, ${participantId},
              ${row.before_cutoff}, ${overrideReason})
      returning id, position, participant_id, from_party_size, to_party_size, before_cutoff,
                override_reason, actor_type, created_at`.execute(trx);
    const change = inserted[0];
    if (!change) throw new Error("a party change's row was not written");

    if (participantId !== null) {
      await sql`
        update booking_participants set removed_at = now()
         where tenant_id = ${tenantId} and id = ${participantId}`.execute(trx);
      // Before the booking's hold changes: that update locks the booking's
      // key, which a message delivery the hook cancels may be waiting on.
      await hooks.participantRemoved?.(trx, ctx, {
        bookingId: input.bookingId,
        participantId,
        position: input.position,
        partyChangeId,
      });
      // Their invitation's links and sessions end with them (0036).
      await withdrawProfileAccess(trx, ctx, {
        bookingId: input.bookingId,
        participantId,
        reason: "withdrawn",
      });
    }

    // The old hold's owner is whoever took it: the checkout, a move, or an
    // earlier party change.
    const { rows: oldHold } = await sql<{ owner_ref: string }>`
      select owner_ref from capacity_holds
       where tenant_id = ${tenantId} and id = ${row.hold_id}`.execute(trx);
    const oldOwner = oldHold[0]?.owner_ref;
    if (!oldOwner) throw new Error("a booking's hold was not found");
    const released = await releaseHold(trx, ctx, {
      holdId: row.hold_id,
      ownerRef: oldOwner,
      reason: "a place in the party was given up",
    });
    if (released.kind !== "released") {
      throw new Error(`a party change's old hold did not release: ${released.kind}`);
    }
    const acquired = await acquireHold(trx, ctx, {
      ownerRef,
      tripId: row.trip_id,
      partySize: toPartySize,
      ttlSeconds: 60,
    });
    if (acquired.kind !== "acquired") {
      await sql`rollback to savepoint booking_party_change`.execute(trx);
      await sql`release savepoint booking_party_change`.execute(trx);
      switch (acquired.kind) {
        case "not_bookable":
          return { kind: "trip_unavailable", issue: acquired.reason };
        case "insufficient_capacity":
          return { kind: "trip_unavailable", issue: "insufficient_capacity" };
        default:
          // The booking's own trip, and a fresh owner that never held it.
          throw new Error(`a party change's new hold was not acquired: ${acquired.kind}`);
      }
    }
    const confirmed = await confirmHold(trx, ctx, { holdId: acquired.hold.id, ownerRef });
    if (confirmed.kind !== "confirmed") {
      throw new Error(`a party change's new hold did not confirm: ${confirmed.kind}`);
    }
    await sql`
      update bookings set party_size = ${toPartySize}, hold_id = ${acquired.hold.id}
       where tenant_id = ${tenantId} and id = ${input.bookingId}`.execute(trx);

    const overridden = overrideReason !== null;
    await record(trx, ctx, {
      action: overridden ? "booking.party_reduced_override" : "booking.party_reduced",
      subjectType: "booking",
      subjectId: input.bookingId,
      reason: overrideReason,
      before: { partySize: row.party_size, holdId: row.hold_id },
      after: {
        partySize: toPartySize,
        holdId: acquired.hold.id,
        partyChangeId,
        position: input.position,
        participantId,
        beforeCutoff: change.before_cutoff,
        overridden,
      },
      topic: "booking.party_reduced",
      payload: {
        bookingId: input.bookingId,
        partyChangeId,
        tripId: row.trip_id,
        position: input.position,
        participantId,
        fromPartySize: row.party_size,
        toPartySize,
      },
    });
    await sql`release savepoint booking_party_change`.execute(trx);
    return { kind: "removed", change: toRecord(change) };
  } catch (error) {
    // Leaves the transaction usable for the caller's own handling; the error
    // still rolls it back.
    await sql`rollback to savepoint booking_party_change`.execute(trx).catch(() => undefined);
    throw error;
  }
}
