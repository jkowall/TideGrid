/**
 * Moving a whole booking to another trip of its product (W3-G2.11-rest,
 * docs/v2/02 "Customer and staff changes"). One transaction: a new hold on
 * the new trip, owned by the move and confirmed at once, the move's row, the
 * booking pointed at the new trip and hold, and only then the old hold
 * released, so capacity is reacquired atomically or nothing changes. The
 * database checks every rule again (migration 0034) and, at commit, that the
 * old seats went back.
 *
 * Coordinator defaults pending the owner's confirmation (the W3-G2.11-rest
 * entry in docs/v2/06): the booking keeps the price it was sold at, so a move
 * neither charges nor refunds; only trips of the same product; before the
 * policy's change cutoff the guest or staff may move it, at or after the
 * cutoff only an owner with a reason; never after the trip has left. A move
 * takes a hold like a new sale, so the new trip must be on sale for this
 * party, before its booking cutoff, with room.
 *
 * Lock order: checkout session, booking, payment (as cancellation takes
 * them), then both trips in id order, then the holds inside the inventory
 * calls, so two moves in opposite directions never deadlock.
 *
 * After the move: the old trip reminder is canceled and a new one written
 * for the new trip, the guest is emailed the new time, and the booking's
 * audit and `booking.rescheduled` event are written.
 */
import { randomUUID } from "node:crypto";
import { isUuid, type TenantContext, type TenantTransaction } from "@tidegrid/database";
import {
  acquireHold,
  confirmHold,
  getTripSale,
  type NotBookableReason,
  releaseHold,
} from "@tidegrid/domain-inventory";
import { cancelMessage } from "@tidegrid/domain-messaging";
import { sql } from "kysely";
import {
  enqueueReminderEmail,
  enqueueRescheduledEmail,
  REMINDER_TEMPLATE,
  RESCHEDULED_TEMPLATE,
} from "./emails.ts";
import { iso, record } from "./views.ts";

/** At most this many trips are offered to move to, soonest first. */
export const MAX_RESCHEDULE_OPTIONS = 30;
/** Trips are offered up to this many days ahead. */
export const RESCHEDULE_HORIZON_DAYS = 365;

/** Why this booking cannot be moved by whoever asks without an override. */
export type RescheduleRefusal =
  /** Canceled; there is nothing to move. */
  | "not_confirmed"
  /** Its trip has left. */
  | "trip_departed"
  /** At or after the policy's change cutoff: only an owner, with a reason. */
  | "past_cutoff";

/** Why one trip cannot take this booking now. */
export type TripOptionIssue =
  | NotBookableReason
  | "insufficient_capacity"
  /** A private charter's balance would fall due after the new trip leaves. */
  | "balance_due_after_trip";

export interface RescheduleOption {
  tripId: string;
  startsAt: string;
  endsAt: string;
  timeZone: string;
  /** True when a move there would be accepted now (advisory; only the move decides). */
  available: boolean;
  issue: TripOptionIssue | null;
}

export interface RescheduleRecord {
  rescheduleId: string;
  fromTripId: string;
  toTripId: string;
  fromStartsAt: string;
  toStartsAt: string;
  beforeCutoff: boolean;
  overridden: boolean;
  by: "staff" | "guest" | "system" | "support";
  movedAt: string;
}

/** What moving this booking now would do, on the database clock. */
export interface ReschedulePreview {
  bookingId: string;
  reference: string;
  state: "confirmed" | "canceled";
  /** True when the asker may move it without an override. */
  movable: boolean;
  refusal: RescheduleRefusal | null;
  tripId: string;
  departsAt: string;
  cutoffAt: string;
  beforeCutoff: boolean;
  policyVersion: number;
  policyText: string;
  partySize: number;
  /** The booking keeps the price it was sold at: no charge and no refund. */
  price: { amount: number; currency: "USD"; changes: false };
  options: RescheduleOption[];
  moves: RescheduleRecord[];
  asOf: string;
}

interface BookingRow {
  reference: string;
  state: "confirmed" | "canceled";
  checkout_session_id: string;
  payment_id: string;
  trip_id: string;
  hold_id: string;
  party_size: number;
  product_id: string;
  policy_version: number;
  reschedule_text: string;
  total_amount: number;
  has_deposit: boolean;
  starts_at: Date | string;
  cutoff_at: Date | string;
  before_cutoff: boolean;
  departed: boolean;
  as_of: Date | string;
  balance_owed: number;
  balance_due_at: Date | string | null;
}

async function bookingRow(
  trx: TenantTransaction,
  tenantId: string,
  bookingId: string,
): Promise<BookingRow | undefined> {
  const { rows } = await sql<BookingRow>`
    select b.reference, b.state, b.checkout_session_id, b.payment_id, b.trip_id, b.hold_id,
           b.party_size, o.product_id, o.policy_version, v.reschedule_text, o.total_amount,
           o.deposit_amount is not null as has_deposit,
           t.starts_at,
           t.starts_at - make_interval(mins => v.change_cutoff_minutes) as cutoff_at,
           now() < t.starts_at - make_interval(mins => v.change_cutoff_minutes) as before_cutoff,
           now() >= t.starts_at as departed,
           now() as as_of,
           coalesce(bal.owed, 0)::int as balance_owed, bal.due_at as balance_due_at
      from bookings b
      join orders o on o.tenant_id = b.tenant_id and o.id = b.order_id
      join scheduled_trips t on t.tenant_id = b.tenant_id and t.id = b.trip_id
      join policy_versions v
        on v.tenant_id = o.tenant_id and v.product_id = o.product_id and v.version = o.policy_version
      left join lateral app.booking_balance(b.tenant_id, b.id) bal on true
     where b.tenant_id = ${tenantId} and b.id = ${bookingId}`.execute(trx);
  return rows[0];
}

function refusalOf(row: BookingRow): RescheduleRefusal | null {
  if (row.state !== "confirmed") return "not_confirmed";
  if (row.departed) return "trip_departed";
  if (!row.before_cutoff) return "past_cutoff";
  return null;
}

/** A balance still owed must fall due before the new trip leaves (0033). */
function balanceBlocks(row: BookingRow, startsAt: Date | string): boolean {
  return (
    row.has_deposit &&
    row.balance_owed > 0 &&
    row.balance_due_at !== null &&
    new Date(row.balance_due_at).getTime() >= new Date(startsAt).getTime()
  );
}

interface TripRow {
  id: string;
  starts_at: Date | string;
  ends_at: Date | string;
  time_zone: string;
  seat_capacity: number;
}

/** Whether one trip would take this booking now, by the same rules as a hold. */
async function issueFor(
  trx: TenantTransaction,
  tenantId: string,
  row: BookingRow,
  trip: TripRow,
): Promise<TripOptionIssue | null> {
  const sale = await getTripSale(trx, tenantId, trip.id, { partySize: row.party_size });
  if (!sale) return "trip_unavailable";
  if (sale.notBookable) return sale.notBookable;
  const needed = sale.kind === "whole_boat" ? trip.seat_capacity : row.party_size;
  if (sale.remaining < needed) return "insufficient_capacity";
  if (balanceBlocks(row, trip.starts_at)) return "balance_due_after_trip";
  return null;
}

async function listMoves(
  trx: TenantTransaction,
  tenantId: string,
  bookingId: string,
): Promise<RescheduleRecord[]> {
  const { rows } = await sql<{
    id: string;
    from_trip_id: string;
    to_trip_id: string;
    from_starts_at: Date | string;
    to_starts_at: Date | string;
    before_cutoff: boolean;
    overridden: boolean;
    actor_type: RescheduleRecord["by"];
    created_at: Date | string;
  }>`
    select r.id, r.from_trip_id, r.to_trip_id, f.starts_at as from_starts_at,
           t.starts_at as to_starts_at, r.before_cutoff,
           r.override_reason is not null as overridden, r.actor_type, r.created_at
      from booking_reschedules r
      join scheduled_trips f on f.tenant_id = r.tenant_id and f.id = r.from_trip_id
      join scheduled_trips t on t.tenant_id = r.tenant_id and t.id = r.to_trip_id
     where r.tenant_id = ${tenantId} and r.booking_id = ${bookingId}
     order by r.created_at, r.id`.execute(trx);
  return rows.map((r) => ({
    rescheduleId: r.id,
    fromTripId: r.from_trip_id,
    toTripId: r.to_trip_id,
    fromStartsAt: iso(r.from_starts_at),
    toStartsAt: iso(r.to_starts_at),
    beforeCutoff: r.before_cutoff,
    overridden: r.overridden,
    by: r.actor_type,
    movedAt: iso(r.created_at),
  }));
}

/**
 * What moving this booking now would do: whether it may move without an
 * override, and the trips of its product it could move to, soonest first,
 * each with whether it would take the booking now. Null when the booking is
 * not this tenant's. Read-only and advisory: only the move decides. With
 * `forGuest`, only departures on sale are listed.
 */
export async function previewReschedule(
  trx: TenantTransaction,
  tenantId: string,
  bookingId: string,
  view: { forGuest?: boolean } = {},
): Promise<ReschedulePreview | null> {
  if (!isUuid(bookingId)) return null;
  const row = await bookingRow(trx, tenantId, bookingId);
  if (!row) return null;
  const refusal = refusalOf(row);
  const options: RescheduleOption[] = [];
  if (refusal !== "not_confirmed" && refusal !== "trip_departed") {
    const { rows: trips } = await sql<TripRow>`
      select t.id, t.starts_at, t.ends_at, t.time_zone, t.seat_capacity
        from scheduled_trips t
       where t.tenant_id = ${tenantId} and t.product_id = ${row.product_id}
         and t.id <> ${row.trip_id}
         and ${view.forGuest ? sql`t.sales_state = 'published'` : sql`t.sales_state <> 'canceled'`}
         and t.starts_at > now()
         and t.starts_at < now() + make_interval(days => ${RESCHEDULE_HORIZON_DAYS})
       order by t.starts_at, t.id
       limit ${MAX_RESCHEDULE_OPTIONS}`.execute(trx);
    for (const trip of trips) {
      const issue = await issueFor(trx, tenantId, row, trip);
      // A guest sees only departures on sale, as the public catalog shows them,
      // never the operator's drafts, closed dates, or blackouts.
      if (view.forGuest && (issue === "trip_unavailable" || issue === "trip_canceled")) {
        continue;
      }
      options.push({
        tripId: trip.id,
        startsAt: iso(trip.starts_at),
        endsAt: iso(trip.ends_at),
        timeZone: trip.time_zone,
        available: issue === null,
        issue,
      });
    }
  }
  return {
    bookingId,
    reference: row.reference,
    state: row.state,
    movable: refusal === null,
    refusal,
    tripId: row.trip_id,
    departsAt: iso(row.starts_at),
    cutoffAt: iso(row.cutoff_at),
    beforeCutoff: row.before_cutoff,
    policyVersion: row.policy_version,
    policyText: row.reschedule_text,
    partySize: row.party_size,
    price: { amount: row.total_amount, currency: "USD", changes: false },
    options,
    moves: await listMoves(trx, tenantId, bookingId),
    asOf: iso(row.as_of),
  };
}

export type RescheduleResult =
  | { kind: "moved"; move: RescheduleRecord }
  /** The booking is already on that trip by its last move: the same record. */
  | { kind: "already_moved"; move: RescheduleRecord }
  | { kind: "not_found" }
  | { kind: "not_confirmed" }
  | { kind: "trip_departed" }
  /** At or after the cutoff and no override was given. */
  | { kind: "past_cutoff" }
  /** The booking is no longer on the trip the asker saw. */
  | { kind: "booking_changed" }
  /** The new trip is not another of this product's trips that has not left. */
  | { kind: "trip_not_found" }
  | { kind: "trip_unavailable"; issue: TripOptionIssue };

export interface RescheduleInput {
  bookingId: string;
  /** The trip the asker saw the booking on; a move from anywhere else is refused. */
  fromTripId: string;
  toTripId: string;
  /** Staff only: why the policy is set aside. The caller checks the permission. */
  overrideReason?: string | null;
}

// biome-ignore lint/suspicious/noControlCharactersInRegex: the pattern exists to reject them.
const reasonPattern = /^[^\u0000-\u001f\u007f]{1,500}$/;

/**
 * Move a confirmed booking to another trip of its product, whole, once per
 * request. With `overrideReason` (staff with the override permission only;
 * the caller checks), a move at or after the change cutoff is allowed. The
 * caller claims its idempotency key first and delivers email after commit.
 */
export async function rescheduleBooking(
  trx: TenantTransaction,
  ctx: TenantContext,
  input: RescheduleInput,
): Promise<RescheduleResult> {
  const overrideReason = input.overrideReason ?? null;
  if (overrideReason !== null && !reasonPattern.test(overrideReason)) {
    throw new RangeError("an override reason is 1 to 500 characters, with no control characters");
  }
  if (!isUuid(input.bookingId)) return { kind: "not_found" };
  if (!isUuid(input.fromTripId) || !isUuid(input.toTripId)) return { kind: "trip_not_found" };
  const tenantId = ctx.tenantId;

  // The session first, as confirmation and cancellation take it, then the
  // booking and the payment.
  const { rows: located } = await sql<{ checkout_session_id: string }>`
    select checkout_session_id from bookings
     where tenant_id = ${tenantId} and id = ${input.bookingId}`.execute(trx);
  const sessionId = located[0]?.checkout_session_id;
  if (!sessionId) return { kind: "not_found" };
  await sql`select id from checkout_sessions where tenant_id = ${tenantId} and id = ${sessionId}
              for update`.execute(trx);
  await sql`select id from bookings where tenant_id = ${tenantId} and id = ${input.bookingId}
              for no key update`.execute(trx);
  const row = await bookingRow(trx, tenantId, input.bookingId);
  if (!row) throw new Error("a locked booking was not found");
  await sql`select id from payments where tenant_id = ${tenantId} and id = ${row.payment_id}
              for update`.execute(trx);

  if (row.state !== "confirmed") return { kind: "not_confirmed" };
  if (input.fromTripId === input.toTripId) return { kind: "trip_not_found" };
  if (row.trip_id === input.toTripId) {
    // A repeat of the move that put it there answers with that move.
    const last = (await listMoves(trx, tenantId, input.bookingId)).at(-1);
    return last && last.fromTripId === input.fromTripId && last.toTripId === input.toTripId
      ? { kind: "already_moved", move: last }
      : { kind: "booking_changed" };
  }
  if (row.trip_id !== input.fromTripId) return { kind: "booking_changed" };
  if (row.departed) return { kind: "trip_departed" };
  if (!row.before_cutoff && overrideReason === null) return { kind: "past_cutoff" };

  const { rows: targets } = await sql<TripRow>`
    select t.id, t.starts_at, t.ends_at, t.time_zone, t.seat_capacity
      from scheduled_trips t
     where t.tenant_id = ${tenantId} and t.id = ${input.toTripId}
       and t.product_id = ${row.product_id} and t.starts_at > now()`.execute(trx);
  const target = targets[0];
  if (!target) return { kind: "trip_not_found" };
  if (balanceBlocks(row, target.starts_at)) {
    return { kind: "trip_unavailable", issue: "balance_due_after_trip" };
  }

  // Both trips, in id order, before either inventory call takes one.
  for (const tripId of [row.trip_id, target.id].sort()) {
    await sql`select id from scheduled_trips where tenant_id = ${tenantId} and id = ${tripId}
                for no key update`.execute(trx);
  }

  const rescheduleId = randomUUID();
  const ownerRef = `booking_reschedule:${rescheduleId}`;
  const acquired = await acquireHold(trx, ctx, {
    ownerRef,
    tripId: target.id,
    partySize: row.party_size,
    ttlSeconds: 60,
  });
  switch (acquired.kind) {
    case "acquired":
      break;
    case "trip_not_found":
      return { kind: "trip_not_found" };
    case "not_bookable":
      return { kind: "trip_unavailable", issue: acquired.reason };
    case "insufficient_capacity":
      return { kind: "trip_unavailable", issue: "insufficient_capacity" };
    default:
      // A fresh owner never has a hold already.
      throw new Error(`a move's new hold was not acquired: ${acquired.kind}`);
  }
  const confirmed = await confirmHold(trx, ctx, { holdId: acquired.hold.id, ownerRef });
  if (confirmed.kind !== "confirmed") {
    throw new Error(`a move's new hold did not confirm: ${confirmed.kind}`);
  }

  // The reminder waiting for the old trip's day, and an earlier move's notice
  // not yet sent, would name a time the booking no longer has. Canceled now,
  // once the move is sure, and before the booking's hold changes: that update
  // takes the booking's row FOR UPDATE, and a delivery holding one of these
  // messages waits for the booking's key, so the messages are locked first.
  const { rows: reminders } = await sql<{ id: string }>`
    select id from email_messages
     where tenant_id = ${tenantId} and booking_id = ${input.bookingId}
       and template in (${REMINDER_TEMPLATE.key}, ${RESCHEDULED_TEMPLATE.key})
       and state in ('queued', 'sending')
     order by id`.execute(trx);
  for (const message of reminders) {
    await cancelMessage(trx, ctx, message.id, { code: "booking_moved", revokeLinks: false });
  }
  const { rows: inserted } = await sql<{
    created_at: Date | string;
    before_cutoff: boolean;
    actor_type: RescheduleRecord["by"];
  }>`
    insert into booking_reschedules
      (id, tenant_id, booking_id, from_trip_id, to_trip_id, from_hold_id, to_hold_id,
       before_cutoff, override_reason)
    values (${rescheduleId}, ${tenantId}, ${input.bookingId}, ${row.trip_id}, ${target.id},
            ${row.hold_id}, ${acquired.hold.id}, ${row.before_cutoff}, ${overrideReason})
    returning created_at, before_cutoff, actor_type`.execute(trx);
  const move = inserted[0];
  if (!move) throw new Error("a move's row was not written");
  await sql`
    update bookings set trip_id = ${target.id}, hold_id = ${acquired.hold.id}
     where tenant_id = ${tenantId} and id = ${input.bookingId}`.execute(trx);

  // The old hold's owner is whoever took it: the checkout, or an earlier move.
  const { rows: oldHold } = await sql<{ owner_ref: string }>`
    select owner_ref from capacity_holds
     where tenant_id = ${tenantId} and id = ${row.hold_id}`.execute(trx);
  const oldOwner = oldHold[0]?.owner_ref;
  if (!oldOwner) throw new Error("a booking's hold was not found");
  const released = await releaseHold(trx, ctx, {
    holdId: row.hold_id,
    ownerRef: oldOwner,
    reason: "booking moved to another trip",
  });
  if (released.kind !== "released") {
    throw new Error(`a moved booking's old hold did not release: ${released.kind}`);
  }

  const overridden = overrideReason !== null;
  await record(trx, ctx, {
    action: overridden ? "booking.rescheduled_override" : "booking.rescheduled",
    subjectType: "booking",
    subjectId: input.bookingId,
    reason: overrideReason,
    before: { tripId: row.trip_id, holdId: row.hold_id },
    after: {
      tripId: target.id,
      holdId: acquired.hold.id,
      rescheduleId,
      beforeCutoff: move.before_cutoff,
      overridden,
    },
    topic: "booking.rescheduled",
    payload: {
      bookingId: input.bookingId,
      rescheduleId,
      fromTripId: row.trip_id,
      toTripId: target.id,
    },
  });

  await enqueueReminderEmail(trx, ctx, input.bookingId, {
    dedupeKey: `booking.reminder:${input.bookingId}:${rescheduleId}`,
  });
  await enqueueRescheduledEmail(trx, ctx, input.bookingId, {
    rescheduleId,
    fromStartsAt: iso(row.starts_at),
  });

  return {
    kind: "moved",
    move: {
      rescheduleId,
      fromTripId: row.trip_id,
      toTripId: target.id,
      fromStartsAt: iso(row.starts_at),
      toStartsAt: iso(target.starts_at),
      beforeCutoff: move.before_cutoff,
      overridden,
      by: move.actor_type,
      movedAt: iso(move.created_at),
    },
  };
}
