import {
  enqueueOutbox,
  type HoldKind,
  type HoldState,
  isUuid,
  type JsonObject,
  type ProductKind,
  type ProductSalesStatus,
  recordAudit,
  type TenantContext,
  type TenantTransaction,
  type TripSalesState,
} from "@tidegrid/database";
import { sql } from "kysely";

/**
 * Capacity holds (G2.6). A hold reserves seats on a shared-seat trip, or the
 * whole boat on a private charter, for one opaque owner. Every function here
 * runs inside the caller's tenant transaction, so a checkout command (G2.7)
 * can acquire, confirm, or release holds atomically with its own writes and
 * roll them all back together. Rules the database also enforces are listed in
 * the capacity and holds migration; this module adds the location, boat, and
 * blackout checks that availability applies, and expires holds whose time has
 * passed before it counts capacity, so an expired hold never blocks a new one.
 *
 * Lock order: a trip's row before any of its hold rows. Acquire, confirm, and
 * release lock the trip first. The sweep locks hold rows only and skips any
 * that are locked, so it never waits. A caller that touches several trips in
 * one transaction should take them in a stable order, such as by trip id.
 * Commands need READ COMMITTED, the default; the database refuses a new or
 * reacquired hold under any other isolation level.
 */

/** Shortest and longest hold a caller may ask for. The database caps holds at one hour. */
export const MIN_HOLD_TTL_SECONDS = 60;
export const MAX_HOLD_TTL_SECONDS = 3600;
/** A sensible checkout window when the caller has no reason to pick another. */
export const DEFAULT_HOLD_TTL_SECONDS = 900;

const ownerRefPattern = /^[a-z][a-z0-9_]{0,39}:[A-Za-z0-9_.:-]{1,200}$/;

/** "<owner type>:<id>", such as "checkout_session:<uuid>". Opaque to this module. */
export function isOwnerRef(value: unknown): value is string {
  return typeof value === "string" && ownerRefPattern.test(value);
}

export interface Hold {
  id: string;
  tripId: string;
  ownerRef: string;
  /** seats on a shared-seat trip, whole_boat on a private charter. */
  kind: HoldKind;
  /** Guests the hold is for. */
  partySize: number;
  /** Capacity the hold takes: the party size, or every seat for a whole boat. */
  seats: number;
  state: HoldState;
  expiresAt: string;
  createdAt: string;
  confirmedAt: string | null;
  releasedAt: string | null;
  expiredAt: string | null;
}

/**
 * Why a trip cannot take a hold now. trip_unavailable covers a trip or product
 * that is not published, an inactive location or boat, and a blackout. When a
 * late payment reacquires a hold, it also covers a trip that no longer sells
 * what the hold reserved: a charter resized, or a trip's product or that
 * product's kind changed, after the hold was taken.
 */
export type NotBookableReason =
  | "trip_canceled"
  | "trip_unavailable"
  | "sales_closed"
  | "party_size_out_of_range";

export type AcquireHoldResult =
  | { kind: "acquired"; hold: Hold }
  /** This owner already holds this trip; the first result, in its current state. */
  | { kind: "existing"; hold: Hold }
  /** This owner already holds this trip for a different party size. */
  | { kind: "owner_conflict"; hold: Hold }
  | { kind: "trip_not_found" }
  | { kind: "not_bookable"; reason: NotBookableReason }
  | { kind: "insufficient_capacity"; remaining: number };

export interface AcquireHoldInput {
  ownerRef: string;
  tripId: string;
  partySize: number;
  /** Between MIN_HOLD_TTL_SECONDS and MAX_HOLD_TTL_SECONDS; never past departure. */
  ttlSeconds: number;
}

export type CapacityLostReason = NotBookableReason | "no_capacity";

export type ConfirmHoldResult =
  /** reacquired: the hold had expired and capacity was taken again for it. */
  | { kind: "confirmed"; hold: Hold; reacquired: boolean }
  | { kind: "already_confirmed"; hold: Hold }
  /** Nothing was confirmed. The caller refunds and raises an operator exception. */
  | { kind: "capacity_lost"; hold: Hold; reason: CapacityLostReason }
  /** The hold was released before; it cannot be confirmed. */
  | { kind: "released"; hold: Hold }
  | { kind: "not_found" };

export type ReleaseHoldResult =
  | { kind: "released"; hold: Hold; from: "active" | "confirmed" }
  /** Already released or expired; nothing changed. */
  | { kind: "unchanged"; hold: Hold }
  | { kind: "not_found" };

// Rows ----------------------------------------------------------------------------

interface HoldRow {
  id: string;
  tenant_id: string;
  trip_id: string;
  owner_ref: string;
  kind: HoldKind;
  party_size: number;
  seats: number;
  state: HoldState;
  expires_at: Date | string;
  created_at: Date | string;
  confirmed_at: Date | string | null;
  released_at: Date | string | null;
  expired_at: Date | string | null;
}

function iso(value: Date | string): string {
  return (typeof value === "string" ? new Date(value) : value).toISOString();
}

function isoOrNull(value: Date | string | null): string | null {
  return value === null ? null : iso(value);
}

function toHold(row: HoldRow): Hold {
  return {
    id: row.id,
    tripId: row.trip_id,
    ownerRef: row.owner_ref,
    kind: row.kind,
    partySize: row.party_size,
    seats: row.seats,
    state: row.state,
    expiresAt: iso(row.expires_at),
    createdAt: iso(row.created_at),
    confirmedAt: isoOrNull(row.confirmed_at),
    releasedAt: isoOrNull(row.released_at),
    expiredAt: isoOrNull(row.expired_at),
  };
}

const holdColumns = sql`id, tenant_id, trip_id, owner_ref, kind, party_size, seats, state,
  expires_at, created_at, confirmed_at, released_at, expired_at`;

/** The trip facts a sale depends on, read with the database clock. */
interface TripSaleRow {
  trip_id: string;
  sales_state: TripSalesState;
  seat_capacity: number;
  product_kind: ProductKind;
  product_status: ProductSalesStatus;
  min_party_size: number;
  max_party_size: number;
  location_status: "active" | "archived";
  boat_status: "active" | "retired";
  sales_open: boolean;
  blacked_out: boolean;
}

// Validation ------------------------------------------------------------------------

function requireOwnerRef(ownerRef: string): void {
  if (!isOwnerRef(ownerRef)) {
    throw new TypeError("ownerRef must look like <type>:<id>, for example checkout_session:<uuid>");
  }
}

function requireTtl(ttlSeconds: number): void {
  if (
    !Number.isInteger(ttlSeconds) ||
    ttlSeconds < MIN_HOLD_TTL_SECONDS ||
    ttlSeconds > MAX_HOLD_TTL_SECONDS
  ) {
    throw new RangeError(
      `ttlSeconds must be a whole number from ${MIN_HOLD_TTL_SECONDS} to ${MAX_HOLD_TTL_SECONDS}`,
    );
  }
}

function requirePartySize(partySize: number): void {
  if (!Number.isInteger(partySize)) throw new TypeError("partySize must be a whole number");
}

// biome-ignore lint/suspicious/noControlCharactersInRegex: the pattern exists to reject them.
const reasonPattern = /^[^\u0000-\u001f\u007f]{1,500}$/;

function requireReason(reason: string | null | undefined): string | null {
  if (reason === null || reason === undefined) return null;
  if (!reasonPattern.test(reason)) {
    throw new RangeError("reason must be 1 to 500 characters without control characters");
  }
  return reason;
}

/**
 * A command ran above READ COMMITTED; nothing was decided or written. It
 * carries SQLSTATE 25000, as the database's own refusal does, so a caller can
 * handle both the same way.
 */
export class IsolationLevelError extends Error {
  readonly code = "25000";
  constructor(readonly isolation: string) {
    super(`capacity hold commands need READ COMMITTED, not ${isolation}`);
    this.name = "IsolationLevelError";
  }
}

// Shared steps --------------------------------------------------------------------

/**
 * Capacity decisions read the rows committed by the time the trip lock is
 * granted. Above READ COMMITTED the transaction's first snapshot would answer
 * instead, so a seat freed a moment earlier would look taken and a late
 * payment would be refunded for nothing. The database refuses such a write;
 * this refuses before any decision, including the ones that write nothing.
 */
async function requireReadCommitted(trx: TenantTransaction): Promise<void> {
  const { rows } = await sql<{ isolation: string }>`
    select current_setting('transaction_isolation') as isolation`.execute(trx);
  const isolation = rows[0]?.isolation ?? "unknown";
  if (isolation !== "read committed") throw new IsolationLevelError(isolation);
}

/** Take the trip's row lock. Writers to one trip queue here, as the trigger also does. */
async function lockTrip(trx: TenantTransaction, tenantId: string, tripId: string) {
  const { rows } = await sql<{ id: string }>`
    select id from scheduled_trips
     where tenant_id = ${tenantId} and id = ${tripId}
       for no key update`.execute(trx);
  return rows.length > 0;
}

/**
 * Whether the trip is on sale now, by the same rules as availability: a
 * published trip of a published product at an active location on an active
 * boat, before the booking cutoff, clear of blackouts. Read after the trip
 * lock, in its own statement, so it sees every committed change.
 */
async function loadTripSale(
  trx: TenantTransaction,
  tenantId: string,
  tripId: string,
): Promise<TripSaleRow | undefined> {
  const { rows } = await sql<TripSaleRow>`
    select t.id as trip_id, t.sales_state, t.seat_capacity,
           p.kind as product_kind, p.sales_status as product_status,
           p.min_party_size, p.max_party_size,
           l.status as location_status, b.status as boat_status,
           now() < t.starts_at - make_interval(mins => p.booking_cutoff_minutes) as sales_open,
           exists (
             select 1 from blackouts x
              where x.tenant_id = t.tenant_id
                and x.starts_at < t.ends_at and t.starts_at < x.ends_at
                and (   (x.location_id is null and x.product_id is null and x.boat_id is null)
                     or x.location_id = p.location_id
                     or x.product_id = t.product_id
                     or x.boat_id = t.boat_id)
           ) as blacked_out
      from scheduled_trips t
      join products p on p.tenant_id = t.tenant_id and p.id = t.product_id
      join locations l on l.tenant_id = p.tenant_id and l.id = p.location_id
      join boats b on b.tenant_id = t.tenant_id and b.id = t.boat_id
     where t.tenant_id = ${tenantId} and t.id = ${tripId}`.execute(trx);
  return rows[0];
}

function notBookable(trip: TripSaleRow, partySize: number): NotBookableReason | null {
  if (trip.sales_state === "canceled") return "trip_canceled";
  if (
    trip.sales_state !== "published" ||
    trip.product_status !== "published" ||
    trip.location_status !== "active" ||
    trip.boat_status !== "active" ||
    trip.blacked_out
  ) {
    return "trip_unavailable";
  }
  if (!trip.sales_open) return "sales_closed";
  if (
    partySize < trip.min_party_size ||
    partySize > trip.max_party_size ||
    partySize > trip.seat_capacity
  ) {
    return "party_size_out_of_range";
  }
  return null;
}

/**
 * The kind and seats a hold on this trip takes now, as the database derives
 * them: the party size on a shared-seat trip, every seat on a charter.
 */
function holdShape(trip: TripSaleRow, partySize: number): { kind: HoldKind; seats: number } {
  return trip.product_kind === "shared_seat"
    ? { kind: "seats", seats: partySize }
    : { kind: "whole_boat", seats: trip.seat_capacity };
}

/** Seats of the trip's holds in a counted state. Call after expiring due holds. */
async function seatsCounted(trx: TenantTransaction, tenantId: string, tripId: string) {
  const { rows } = await sql<{ taken: number }>`
    select coalesce(sum(seats), 0)::int as taken from capacity_holds
     where tenant_id = ${tenantId} and trip_id = ${tripId}
       and state in ('active', 'confirmed')`.execute(trx);
  return rows[0]?.taken ?? 0;
}

async function selectHold(
  trx: TenantTransaction,
  tenantId: string,
  holdId: string,
  options: { lock: boolean },
): Promise<(HoldRow & { unexpired: boolean }) | undefined> {
  const { rows } = await sql<HoldRow & { unexpired: boolean }>`
    select ${holdColumns}, expires_at > now() as unexpired
      from capacity_holds
     where tenant_id = ${tenantId} and id = ${holdId}
     ${options.lock ? sql`for update` : sql``}`.execute(trx);
  return rows[0];
}

/**
 * Append audit and outbox rows for holds the system expired, in two
 * statements, so a sweep batch costs the same round trips as one hold. The
 * columns match recordAudit and enqueueOutbox.
 */
async function recordExpiries(
  trx: TenantTransaction,
  ctx: TenantContext,
  actorId: string,
  rows: readonly HoldRow[],
): Promise<void> {
  if (rows.length === 0) return;
  await trx
    .insertInto("audit_events")
    .values(
      rows.map((row) => ({
        tenant_id: ctx.tenantId,
        actor_type: "system" as const,
        actor_id: actorId,
        request_id: ctx.requestId ?? null,
        source_ip: null,
        action: "hold.expired",
        subject_type: "capacity_hold",
        subject_id: row.id,
        reason: null,
        before_state: { state: "active", expiresAt: iso(row.expires_at) },
        after_state: { state: "expired" },
      })),
    )
    .execute();
  await trx
    .insertInto("outbox_events")
    .values(
      rows.map((row) => ({
        tenant_id: ctx.tenantId,
        topic: "inventory.hold.expired",
        aggregate_type: "capacity_hold",
        aggregate_id: row.id,
        payload: eventPayload(row),
        request_id: ctx.requestId ?? null,
      })),
    )
    .execute();
}

/** Events carry identifiers only. */
function eventPayload(row: Pick<HoldRow, "id" | "trip_id" | "owner_ref">): JsonObject {
  return { holdId: row.id, tripId: row.trip_id, ownerRef: row.owner_ref };
}

/**
 * Mark the trip's holds expired once their instant has passed. Runs under the
 * trip lock, so the decision is written down before anyone counts on it; the
 * sweep would make the same change later.
 */
async function expireDueOnTrip(trx: TenantTransaction, ctx: TenantContext, tripId: string) {
  const { rows } = await sql<HoldRow>`
    update capacity_holds set state = 'expired'
     where tenant_id = ${ctx.tenantId} and trip_id = ${tripId}
       and state = 'active' and expires_at <= now()
    returning ${holdColumns}`.execute(trx);
  await recordExpiries(trx, ctx, "hold-expiry", rows);
  return rows;
}

// Commands ------------------------------------------------------------------------

/**
 * Reserve capacity on one trip for one owner. Idempotent per owner and trip:
 * a second call returns the first hold in whatever state it is now, and never
 * creates another. The trip's holds past their time are marked expired first,
 * so they never block a new hold and a replay reports an expired hold as
 * expired.
 */
export async function acquireHold(
  trx: TenantTransaction,
  ctx: TenantContext,
  input: AcquireHoldInput,
): Promise<AcquireHoldResult> {
  requireOwnerRef(input.ownerRef);
  requireTtl(input.ttlSeconds);
  requirePartySize(input.partySize);
  if (!isUuid(input.tripId)) return { kind: "trip_not_found" };
  await requireReadCommitted(trx);
  if (!(await lockTrip(trx, ctx.tenantId, input.tripId))) return { kind: "trip_not_found" };
  await expireDueOnTrip(trx, ctx, input.tripId);

  const { rows: mine } = await sql<HoldRow>`
    select ${holdColumns} from capacity_holds
     where tenant_id = ${ctx.tenantId} and owner_ref = ${input.ownerRef}
       and trip_id = ${input.tripId}`.execute(trx);
  const existing = mine[0];
  if (existing) {
    return existing.party_size === input.partySize
      ? { kind: "existing", hold: toHold(existing) }
      : { kind: "owner_conflict", hold: toHold(existing) };
  }

  const trip = await loadTripSale(trx, ctx.tenantId, input.tripId);
  if (!trip) return { kind: "trip_not_found" };
  const reason = notBookable(trip, input.partySize);
  if (reason) return { kind: "not_bookable", reason };

  const taken = await seatsCounted(trx, ctx.tenantId, trip.trip_id);
  const needed = holdShape(trip, input.partySize).seats;
  if (taken + needed > trip.seat_capacity) {
    return { kind: "insufficient_capacity", remaining: Math.max(0, trip.seat_capacity - taken) };
  }

  // The expiry is the database's: now plus the TTL, never past departure.
  const { rows } = await sql<HoldRow>`
    insert into capacity_holds (tenant_id, trip_id, owner_ref, party_size, expires_at)
    select ${ctx.tenantId}, t.id, ${input.ownerRef}, ${input.partySize},
           least(now() + make_interval(secs => ${input.ttlSeconds}), t.starts_at)
      from scheduled_trips t
     where t.tenant_id = ${ctx.tenantId} and t.id = ${trip.trip_id}
    returning ${holdColumns}`.execute(trx);
  const row = rows[0];
  if (!row) throw new Error("hold insert returned no row");
  const hold = toHold(row);
  await recordAudit(trx, ctx, {
    action: "hold.acquired",
    subjectType: "capacity_hold",
    subjectId: hold.id,
    before: null,
    after: {
      state: hold.state,
      tripId: hold.tripId,
      ownerRef: hold.ownerRef,
      kind: hold.kind,
      partySize: hold.partySize,
      seats: hold.seats,
      expiresAt: hold.expiresAt,
    },
  });
  await enqueueOutbox(trx, ctx, {
    topic: "inventory.hold.acquired",
    aggregateType: "capacity_hold",
    aggregateId: hold.id,
    payload: eventPayload(row),
  });
  return { kind: "acquired", hold };
}

/**
 * Turn a hold into confirmed capacity, for a verified payment (G2.7). A hold
 * still within its time is confirmed as it is, unless its trip was canceled.
 * A hold past its time, swept or not, is reacquired: the trip must be on sale,
 * still take a hold of this kind and size, and have room, exactly as for a new
 * hold. If it cannot be, nothing is confirmed and the result says why, so the
 * caller can refund and raise an operator exception. The caller owns the
 * transaction; to confirm several holds all or nothing, roll back when any
 * result is not confirmed.
 */
export async function confirmHold(
  trx: TenantTransaction,
  ctx: TenantContext,
  input: { holdId: string; ownerRef: string },
): Promise<ConfirmHoldResult> {
  if (!isUuid(input.holdId) || !isOwnerRef(input.ownerRef)) return { kind: "not_found" };
  await requireReadCommitted(trx);
  const located = await selectHold(trx, ctx.tenantId, input.holdId, { lock: false });
  if (!located || located.owner_ref !== input.ownerRef) return { kind: "not_found" };

  // The trip first, then the hold: the same order acquisition uses.
  await lockTrip(trx, ctx.tenantId, located.trip_id);
  const held = await selectHold(trx, ctx.tenantId, input.holdId, { lock: true });
  if (!held) throw new Error("hold vanished inside its own transaction");

  if (held.state === "confirmed") return { kind: "already_confirmed", hold: toHold(held) };
  if (held.state === "released") return { kind: "released", hold: toHold(held) };

  if (held.state === "active" && held.unexpired) {
    const { rows: tripRows } = await sql<{ sales_state: TripSalesState }>`
      select sales_state from scheduled_trips
       where tenant_id = ${ctx.tenantId} and id = ${held.trip_id}`.execute(trx);
    if (tripRows[0]?.sales_state === "canceled") {
      return { kind: "capacity_lost", hold: toHold(held), reason: "trip_canceled" };
    }
    const { rows } = await sql<HoldRow>`
      update capacity_holds set state = 'confirmed'
       where tenant_id = ${ctx.tenantId} and id = ${held.id} and state = 'active'
      returning ${holdColumns}`.execute(trx);
    const row = rows[0];
    if (!row) throw new Error("locked active hold did not confirm");
    await recordConfirmation(trx, ctx, row, false);
    return { kind: "confirmed", hold: toHold(row), reacquired: false };
  }

  // Past its time: write the expiry down first, then take capacity again.
  await expireDueOnTrip(trx, ctx, held.trip_id);
  const current = await selectHold(trx, ctx.tenantId, held.id, { lock: false });
  if (current?.state !== "expired") {
    throw new Error("an expired hold was not marked expired");
  }
  const trip = await loadTripSale(trx, ctx.tenantId, held.trip_id);
  if (!trip) throw new Error("locked trip vanished inside its own transaction");
  const reason = notBookable(trip, current.party_size);
  if (reason) return { kind: "capacity_lost", hold: toHold(current), reason };
  // The trip may have changed while the hold had expired and did not count: a
  // charter resized, or another product or kind. A hold's seats never change,
  // so one that no longer takes what a new hold would is not reacquired; the
  // database refuses it too (capacity_holds_kind).
  const shape = holdShape(trip, current.party_size);
  if (shape.kind !== current.kind || shape.seats !== current.seats) {
    return { kind: "capacity_lost", hold: toHold(current), reason: "trip_unavailable" };
  }
  const taken = await seatsCounted(trx, ctx.tenantId, trip.trip_id);
  if (taken + current.seats > trip.seat_capacity) {
    return { kind: "capacity_lost", hold: toHold(current), reason: "no_capacity" };
  }
  const { rows } = await sql<HoldRow>`
    update capacity_holds set state = 'confirmed'
     where tenant_id = ${ctx.tenantId} and id = ${current.id} and state = 'expired'
    returning ${holdColumns}`.execute(trx);
  const row = rows[0];
  if (!row) throw new Error("locked expired hold did not reacquire");
  await recordConfirmation(trx, ctx, row, true);
  return { kind: "confirmed", hold: toHold(row), reacquired: true };
}

async function recordConfirmation(
  trx: TenantTransaction,
  ctx: TenantContext,
  row: HoldRow,
  reacquired: boolean,
): Promise<void> {
  await recordAudit(trx, ctx, {
    action: "hold.confirmed",
    subjectType: "capacity_hold",
    subjectId: row.id,
    before: { state: reacquired ? "expired" : "active" },
    after: { state: "confirmed", reacquired },
  });
  await enqueueOutbox(trx, ctx, {
    topic: "inventory.hold.confirmed",
    aggregateType: "capacity_hold",
    aggregateId: row.id,
    payload: eventPayload(row),
  });
}

/**
 * Give a hold's capacity back: an abandoned or failed checkout, or a canceled
 * booking. Idempotent: a hold already released or expired is left as it is.
 */
export async function releaseHold(
  trx: TenantTransaction,
  ctx: TenantContext,
  input: { holdId: string; ownerRef: string; reason?: string | null },
): Promise<ReleaseHoldResult> {
  const reason = requireReason(input.reason);
  if (!isUuid(input.holdId) || !isOwnerRef(input.ownerRef)) return { kind: "not_found" };
  await requireReadCommitted(trx);
  const located = await selectHold(trx, ctx.tenantId, input.holdId, { lock: false });
  if (!located || located.owner_ref !== input.ownerRef) return { kind: "not_found" };
  // The trip first, as everywhere else, so a caller that releases and then
  // acquires on the same trip cannot deadlock against another acquisition.
  await lockTrip(trx, ctx.tenantId, located.trip_id);
  const held = await selectHold(trx, ctx.tenantId, input.holdId, { lock: true });
  if (!held) throw new Error("hold vanished inside its own transaction");
  if (held.state !== "active" && held.state !== "confirmed") {
    return { kind: "unchanged", hold: toHold(held) };
  }
  const from = held.state;
  const { rows } = await sql<HoldRow>`
    update capacity_holds set state = 'released'
     where tenant_id = ${ctx.tenantId} and id = ${held.id} and state = ${from}
    returning ${holdColumns}`.execute(trx);
  const row = rows[0];
  if (!row) throw new Error("locked hold did not release");
  await recordAudit(trx, ctx, {
    action: "hold.released",
    subjectType: "capacity_hold",
    subjectId: row.id,
    reason,
    before: { state: from },
    after: { state: "released" },
  });
  await enqueueOutbox(trx, ctx, {
    topic: "inventory.hold.released",
    aggregateType: "capacity_hold",
    aggregateId: row.id,
    payload: eventPayload(row),
  });
  return { kind: "released", hold: toHold(row), from };
}

/** Largest batch one expiry transaction takes. */
export const MAX_EXPIRY_BATCH = 1000;

/**
 * Mark up to `limit` of this tenant's holds expired once their instant has
 * passed, oldest first. Holds another transaction has locked are skipped, so
 * a sweep never waits on a checkout; the next pass takes them. Idempotent: an
 * expired hold is never touched again. Writes one audit row and one
 * inventory.hold.expired event per hold.
 */
export async function expireDueHolds(
  trx: TenantTransaction,
  ctx: TenantContext,
  options: { limit: number },
): Promise<{ expired: Hold[] }> {
  if (!Number.isInteger(options.limit) || options.limit < 1 || options.limit > MAX_EXPIRY_BATCH) {
    throw new RangeError(`limit must be a whole number from 1 to ${MAX_EXPIRY_BATCH}`);
  }
  await requireReadCommitted(trx);
  const { rows } = await sql<HoldRow>`
    with due as (
      select id from capacity_holds
       where tenant_id = ${ctx.tenantId} and state = 'active' and expires_at <= now()
       order by expires_at, id
       limit ${options.limit}
         for update skip locked
    )
    update capacity_holds h set state = 'expired'
      from due
     where h.tenant_id = ${ctx.tenantId} and h.id = due.id and h.state = 'active'
    returning h.id, h.tenant_id, h.trip_id, h.owner_ref, h.kind, h.party_size, h.seats,
              h.state, h.expires_at, h.created_at, h.confirmed_at, h.released_at,
              h.expired_at`.execute(trx);
  await recordExpiries(trx, ctx, "hold-sweep", rows);
  return { expired: rows.map(toHold) };
}

export type ExpireHoldResult =
  | { kind: "expired"; hold: Hold }
  /** Already expired, released, or confirmed; nothing changed. */
  | { kind: "unchanged"; hold: Hold }
  /** Active and not yet past its expiry instant by the database clock. */
  | { kind: "not_due"; hold: Hold }
  | { kind: "not_found" };

/**
 * Mark one owner's hold expired once its instant has passed, for checkout's
 * own expiry (G2.7). Like the sweep it locks the hold row only, never the
 * trip, because an expiry takes no capacity; a caller may already hold its
 * own row locks, such as the checkout session's. Idempotent, and writes the
 * same audit row and event as every other expiry, under the caller's actor.
 */
export async function expireHold(
  trx: TenantTransaction,
  ctx: TenantContext,
  input: { holdId: string; ownerRef: string },
): Promise<ExpireHoldResult> {
  if (!isUuid(input.holdId) || !isOwnerRef(input.ownerRef)) return { kind: "not_found" };
  await requireReadCommitted(trx);
  const held = await selectHold(trx, ctx.tenantId, input.holdId, { lock: true });
  if (!held || held.owner_ref !== input.ownerRef) return { kind: "not_found" };
  if (held.state !== "active") return { kind: "unchanged", hold: toHold(held) };
  if (held.unexpired) return { kind: "not_due", hold: toHold(held) };
  const { rows } = await sql<HoldRow>`
    update capacity_holds set state = 'expired'
     where tenant_id = ${ctx.tenantId} and id = ${held.id} and state = 'active'
       and expires_at <= now()
    returning ${holdColumns}`.execute(trx);
  const row = rows[0];
  if (!row) throw new Error("locked due hold did not expire");
  await recordExpiries(trx, ctx, ctx.actorId ?? "hold-expiry", [row]);
  return { kind: "expired", hold: toHold(row) };
}

// Reads ---------------------------------------------------------------------------

export interface TripCapacityView {
  tripId: string;
  kind: HoldKind;
  /** Seats sold per trip, or guests aboard a charter. */
  total: number;
  /** Seats taken by holds still within their time; a held charter counts every seat. */
  held: number;
  /** Seats taken by confirmed holds. */
  confirmed: number;
  remaining: number;
  soldOut: boolean;
}

/**
 * Seats remaining on one trip now: capacity minus holds within their time and
 * confirmed holds. Advisory, like availability; only acquisition decides.
 */
export async function getTripCapacity(
  trx: TenantTransaction,
  tenantId: string,
  tripId: string,
): Promise<TripCapacityView | null> {
  if (!isUuid(tripId)) return null;
  const { rows } = await sql<{
    trip_id: string;
    product_kind: ProductKind;
    seat_capacity: number;
    held: number;
    confirmed: number;
  }>`
    select t.id as trip_id, p.kind as product_kind, t.seat_capacity, u.held, u.confirmed
      from scheduled_trips t
      join products p on p.tenant_id = t.tenant_id and p.id = t.product_id
      cross join lateral app.trip_capacity_usage(t.tenant_id, t.id) u
     where t.tenant_id = ${tenantId} and t.id = ${tripId}`.execute(trx);
  const row = rows[0];
  if (!row) return null;
  const remaining = Math.max(0, row.seat_capacity - row.held - row.confirmed);
  return {
    tripId: row.trip_id,
    kind: row.product_kind === "shared_seat" ? "seats" : "whole_boat",
    total: row.seat_capacity,
    held: row.held,
    confirmed: row.confirmed,
    remaining,
    soldOut: remaining === 0,
  };
}

export async function getHold(
  trx: TenantTransaction,
  tenantId: string,
  holdId: string,
): Promise<Hold | null> {
  if (!isUuid(holdId)) return null;
  const row = await selectHold(trx, tenantId, holdId, { lock: false });
  return row ? toHold(row) : null;
}

/** Every hold an owner has, one per trip, oldest first. */
export async function findHoldsByOwner(
  trx: TenantTransaction,
  tenantId: string,
  ownerRef: string,
): Promise<Hold[]> {
  if (!isOwnerRef(ownerRef)) return [];
  const { rows } = await sql<HoldRow>`
    select ${holdColumns} from capacity_holds
     where tenant_id = ${tenantId} and owner_ref = ${ownerRef}
     order by created_at, id`.execute(trx);
  return rows.map(toHold);
}

export interface TripHold extends Hold {
  /** Confirmed, or active and not yet past its expiry instant, by the database clock. */
  takesCapacity: boolean;
}

/** Every hold on one trip in any state, oldest first, for staff. */
export async function listTripHolds(
  trx: TenantTransaction,
  tenantId: string,
  tripId: string,
): Promise<TripHold[]> {
  if (!isUuid(tripId)) return [];
  const { rows } = await sql<HoldRow & { takes_capacity: boolean }>`
    select ${holdColumns},
           (state = 'confirmed' or (state = 'active' and expires_at > now())) as takes_capacity
      from capacity_holds
     where tenant_id = ${tenantId} and trip_id = ${tripId}
     order by created_at, id`.execute(trx);
  return rows.map((row) => ({ ...toHold(row), takesCapacity: row.takes_capacity }));
}
