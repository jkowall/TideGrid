import type {
  AvailableTrip,
  CatalogProduct,
  CatalogResponse,
  ProductKind,
  ProductPublishProblem,
  StaffTrip,
  TripCapacity,
  TripSalesState,
} from "@tidegrid/contracts";
import {
  enqueueOutbox,
  recordAudit,
  type TenantContext,
  type TenantTransaction,
} from "@tidegrid/database";
import { sql } from "kysely";
import { expandSchedule } from "./recurrence.ts";
import type { BlackoutInterval, ScheduleRule, SkippedOccurrence } from "./schedule-types.ts";
import {
  addDays,
  type Disambiguation,
  daysBetween,
  type IsoWeekday,
  isLocalDate,
  MINUTE_MS,
  startOfLocalDay,
  toOffsetDateTime,
} from "./time.ts";

/** Longest span, in days after `from`, that one query or generation request covers. */
export const MAX_RANGE_DAYS = 92;

export type RangeProblem = "invalid_range" | "range_too_large";

/** Validates an inclusive local date range. */
export function checkRange(from: string, to: string): RangeProblem | null {
  if (!isLocalDate(from) || !isLocalDate(to)) return "invalid_range";
  const span = daysBetween(from, to);
  if (span < 0) return "invalid_range";
  if (span > MAX_RANGE_DAYS) return "range_too_large";
  return null;
}

// Row mapping -------------------------------------------------------------------

/** postgres.js reads a date column as a Date at UTC midnight of that date. */
function dateOnly(value: Date | string): string {
  return typeof value === "string" ? value.slice(0, 10) : value.toISOString().slice(0, 10);
}

function instant(value: Date | string): string {
  return (typeof value === "string" ? new Date(value) : value).toISOString();
}

interface TripRow {
  trip_id: string;
  product_id: string;
  product_name: string;
  product_kind: ProductKind;
  product_summary: string;
  min_party_size: number;
  max_party_size: number;
  booking_cutoff_minutes: number;
  boat_id: string;
  boat_name: string;
  location_name: string;
  meeting_point: string;
  schedule_id: string | null;
  time_zone: string;
  local_date: Date | string;
  local_start_time: string;
  starts_at: Date | string;
  ends_at: Date | string;
  start_utc_offset_minutes: number;
  end_utc_offset_minutes: number;
  duration_minutes: number;
  seat_capacity: number;
  sales_state: TripSalesState;
  sales_state_changed_at: Date | string;
  blacked_out: boolean;
}

/**
 * Capacity before any booking exists. G2.6 subtracts held and confirmed seats
 * and marks a whole boat taken; this is the seam it replaces.
 */
function capacityOf(row: Pick<TripRow, "product_kind" | "seat_capacity">): TripCapacity {
  return {
    kind: row.product_kind === "shared_seat" ? "seats" : "whole_boat",
    total: row.seat_capacity,
    remaining: row.seat_capacity,
  };
}

function timing(row: TripRow) {
  const startsAtMs = new Date(row.starts_at).getTime();
  const endsAtMs = new Date(row.ends_at).getTime();
  const localDate = dateOnly(row.local_date);
  const localStartTime = row.local_start_time.slice(0, 5);
  // The local end is derived from the snapshotted end offset, never recomputed.
  const localEnd = new Date(endsAtMs + row.end_utc_offset_minutes * MINUTE_MS).toISOString();
  return {
    timeZone: row.time_zone,
    localDate,
    localStartTime,
    startsAt: new Date(startsAtMs).toISOString(),
    endsAt: new Date(endsAtMs).toISOString(),
    startsAtLocal: toOffsetDateTime(localDate, localStartTime, row.start_utc_offset_minutes),
    endsAtLocal: toOffsetDateTime(
      localEnd.slice(0, 10),
      localEnd.slice(11, 16),
      row.end_utc_offset_minutes,
    ),
    durationMinutes: row.duration_minutes,
  };
}

function salesCloseAt(row: TripRow): string {
  return new Date(
    new Date(row.starts_at).getTime() - row.booking_cutoff_minutes * MINUTE_MS,
  ).toISOString();
}

function toStaffTrip(row: TripRow): StaffTrip {
  return {
    ...timing(row),
    tripId: row.trip_id,
    productId: row.product_id,
    productName: row.product_name,
    productKind: row.product_kind,
    boatId: row.boat_id,
    boatName: row.boat_name,
    scheduleId: row.schedule_id,
    salesState: row.sales_state,
    salesStateChangedAt: instant(row.sales_state_changed_at),
    salesCloseAt: salesCloseAt(row),
    blackedOut: row.blacked_out,
    capacity: capacityOf(row),
  };
}

function toAvailableTrip(row: TripRow): AvailableTrip {
  return {
    ...timing(row),
    tripId: row.trip_id,
    product: {
      id: row.product_id,
      name: row.product_name,
      kind: row.product_kind,
      summary: row.product_summary,
      minPartySize: row.min_party_size,
      maxPartySize: row.max_party_size,
    },
    location: { name: row.location_name, meetingPoint: row.meeting_point },
    salesCloseAt: salesCloseAt(row),
    capacity: capacityOf(row),
  };
}

/**
 * The trip columns every view needs. A blackout applies when it overlaps the
 * trip and is tenant-wide or names the trip's location, product, or boat.
 */
const tripSelect = sql`
  select t.id as trip_id, t.product_id, p.name as product_name, p.kind as product_kind,
         p.summary as product_summary, p.min_party_size, p.max_party_size,
         p.booking_cutoff_minutes, t.boat_id, b.name as boat_name,
         l.name as location_name, l.meeting_point, t.schedule_id, t.time_zone,
         t.local_date, t.local_start_time, t.starts_at, t.ends_at,
         t.start_utc_offset_minutes, t.end_utc_offset_minutes, t.duration_minutes,
         t.seat_capacity, t.sales_state, t.sales_state_changed_at,
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
    join boats b on b.tenant_id = t.tenant_id and b.id = t.boat_id`;

// Reads ---------------------------------------------------------------------------

export interface AvailabilityQuery {
  from: string;
  to: string;
  party: number;
  productId?: string | undefined;
  now: Date;
}

/**
 * What a guest may book: published trips of published products at active
 * locations on active boats, before the booking cutoff, clear of blackouts,
 * where the party fits the product and the trip's capacity.
 */
export async function findAvailableTrips(
  trx: TenantTransaction,
  tenantId: string,
  query: AvailabilityQuery,
): Promise<AvailableTrip[]> {
  const { rows } = await sql<TripRow>`
    select * from (${tripSelect}
     where t.tenant_id = ${tenantId}
       and t.local_date between ${query.from}::date and ${query.to}::date
       and t.sales_state = 'published'
       and p.sales_status = 'published'
       and l.status = 'active'
       and b.status = 'active'
       and t.starts_at - make_interval(mins => p.booking_cutoff_minutes) > ${query.now}
       and ${query.party}::int between p.min_party_size and p.max_party_size
       and t.seat_capacity >= ${query.party}::int
       ${query.productId ? sql`and t.product_id = ${query.productId}` : sql``}
    ) trips
    where not blacked_out
    order by starts_at, trip_id`.execute(trx);
  return rows.map(toAvailableTrip);
}

/** Every trip in the range, in any state, for the staff calendar. */
export async function listTrips(
  trx: TenantTransaction,
  tenantId: string,
  range: { from: string; to: string },
): Promise<StaffTrip[]> {
  const { rows } = await sql<TripRow>`
    ${tripSelect}
     where t.tenant_id = ${tenantId}
       and t.local_date between ${range.from}::date and ${range.to}::date
     order by t.starts_at, t.id`.execute(trx);
  return rows.map(toStaffTrip);
}

async function loadTrip(
  trx: TenantTransaction,
  tenantId: string,
  tripId: string,
): Promise<TripRow | undefined> {
  const { rows } = await sql<TripRow>`
    ${tripSelect} where t.tenant_id = ${tenantId} and t.id = ${tripId}`.execute(trx);
  return rows[0];
}

export async function loadCatalog(
  trx: TenantTransaction,
  tenantId: string,
): Promise<CatalogResponse> {
  // Sequential: one transaction is one connection, so parallel queries only queue.
  const locations = await trx
    .selectFrom("locations")
    .select(["id", "name", "time_zone", "meeting_point", "status"])
    .where("tenant_id", "=", tenantId)
    .orderBy("name")
    .execute();
  const boats = await trx
    .selectFrom("boats")
    .select(["id", "name", "guest_capacity", "status"])
    .where("tenant_id", "=", tenantId)
    .orderBy("name")
    .execute();
  const products = await trx
    .selectFrom("products")
    .selectAll()
    .where("tenant_id", "=", tenantId)
    .orderBy("name")
    .execute();
  const eligible = await trx
    .selectFrom("product_boats")
    .select(["product_id", "boat_id"])
    .where("tenant_id", "=", tenantId)
    .orderBy("boat_id")
    .execute();
  const schedules = await trx
    .selectFrom("schedules")
    .selectAll()
    .where("tenant_id", "=", tenantId)
    .orderBy("starts_on")
    .orderBy("id")
    .execute();
  return {
    locations: locations.map((l) => ({
      id: l.id,
      name: l.name,
      timeZone: l.time_zone,
      meetingPoint: l.meeting_point,
      status: l.status,
    })),
    boats: boats.map((b) => ({
      id: b.id,
      name: b.name,
      guestCapacity: b.guest_capacity,
      status: b.status,
    })),
    products: products.map((p) =>
      toCatalogProduct(
        p,
        eligible.filter((e) => e.product_id === p.id).map((e) => e.boat_id),
      ),
    ),
    schedules: schedules.map((s) => ({
      id: s.id,
      productId: s.product_id,
      boatId: s.boat_id,
      timeZone: s.time_zone,
      startsOn: dateOnly(s.starts_on),
      endsOn: dateOnly(s.ends_on),
      weekdays: s.weekdays,
      startTimes: s.start_times.map((t) => t.slice(0, 5)),
      ambiguousTime: s.ambiguous_time,
      status: s.status,
    })),
  };
}

interface ProductRow {
  id: string;
  location_id: string;
  kind: ProductKind;
  name: string;
  summary: string;
  duration_minutes: number;
  booking_cutoff_minutes: number;
  turnaround_buffer_minutes: number;
  min_party_size: number;
  max_party_size: number;
  seat_limit: number | null;
  sales_status: "draft" | "published" | "archived";
}

function toCatalogProduct(p: ProductRow, eligibleBoatIds: string[]): CatalogProduct {
  return {
    id: p.id,
    locationId: p.location_id,
    kind: p.kind,
    name: p.name,
    summary: p.summary,
    durationMinutes: p.duration_minutes,
    bookingCutoffMinutes: p.booking_cutoff_minutes,
    turnaroundBufferMinutes: p.turnaround_buffer_minutes,
    minPartySize: p.min_party_size,
    maxPartySize: p.max_party_size,
    seatLimit: p.seat_limit,
    salesStatus: p.sales_status,
    eligibleBoatIds,
  };
}

// Commands ------------------------------------------------------------------------

export type PublishProductResult =
  | { kind: "published"; product: CatalogProduct }
  | { kind: "unchanged"; product: CatalogProduct }
  | { kind: "not_found" }
  | { kind: "not_publishable"; problems: ProductPublishProblem[] };

/**
 * Publishing is blocked with a specific reason when the product could not be
 * sold. G2.5 adds price and policy checks to the same list.
 */
export async function publishProduct(
  trx: TenantTransaction,
  ctx: TenantContext,
  input: { productId: string; reason: string },
): Promise<PublishProductResult> {
  const product = await trx
    .selectFrom("products")
    .selectAll()
    .where("tenant_id", "=", ctx.tenantId)
    .where("id", "=", input.productId)
    .executeTakeFirst();
  if (!product) return { kind: "not_found" };
  const location = await trx
    .selectFrom("locations")
    .select("status")
    .where("tenant_id", "=", ctx.tenantId)
    .where("id", "=", product.location_id)
    .executeTakeFirst();
  const boats = await trx
    .selectFrom("product_boats as pb")
    .innerJoin("boats as b", (j) =>
      j.onRef("b.tenant_id", "=", "pb.tenant_id").onRef("b.id", "=", "pb.boat_id"),
    )
    .select(["b.id", "b.guest_capacity"])
    .where("pb.tenant_id", "=", ctx.tenantId)
    .where("pb.product_id", "=", product.id)
    .where("b.status", "=", "active")
    .orderBy("b.id")
    .execute();
  const eligibleBoatIds = boats.map((b) => b.id);

  const problems: ProductPublishProblem[] = [];
  if (product.sales_status === "archived") problems.push("product_archived");
  if (location?.status !== "active") problems.push("product_location_inactive");
  if (boats.length === 0) problems.push("product_missing_eligible_boat");
  else {
    const largest = Math.max(...boats.map((b) => b.guest_capacity));
    const sellable =
      product.kind === "shared_seat" ? Math.min(product.seat_limit ?? largest, largest) : largest;
    if (product.max_party_size > sellable) problems.push("product_party_exceeds_capacity");
  }
  if (problems.length > 0) return { kind: "not_publishable", problems };
  if (product.sales_status === "published") {
    return { kind: "unchanged", product: toCatalogProduct(product, eligibleBoatIds) };
  }

  const updated = await trx
    .updateTable("products")
    .set({ sales_status: "published", updated_at: sql<Date>`now()` })
    .where("tenant_id", "=", ctx.tenantId)
    .where("id", "=", product.id)
    .where("sales_status", "=", "draft")
    .returningAll()
    .executeTakeFirst();
  if (!updated) return { kind: "not_publishable", problems: ["product_archived"] };
  await recordAudit(trx, ctx, {
    action: "product.published",
    subjectType: "product",
    subjectId: product.id,
    reason: input.reason,
    before: { salesStatus: product.sales_status },
    after: { salesStatus: updated.sales_status },
  });
  await enqueueOutbox(trx, ctx, {
    topic: "catalog.product.published",
    aggregateType: "product",
    aggregateId: product.id,
    payload: { productId: product.id },
  });
  return { kind: "published", product: toCatalogProduct(updated, eligibleBoatIds) };
}

const transitions: Record<TripSalesState, readonly TripSalesState[]> = {
  draft: ["published", "canceled"],
  published: ["closed", "canceled", "completed"],
  closed: ["published", "canceled", "completed"],
  canceled: [],
  completed: [],
};

export type TripStateResult =
  | { kind: "changed"; trip: StaffTrip }
  | { kind: "not_found" }
  | { kind: "conflict"; from: TripSalesState; to: TripSalesState }
  | { kind: "not_departed" };

/**
 * Moves a trip between sales states. Closing or canceling stops new sales and
 * leaves existing bookings alone; bookings arrive with G2.6 and G2.7. The same
 * transitions are enforced by a trigger in migration 0003.
 */
export async function changeTripSalesState(
  trx: TenantTransaction,
  ctx: TenantContext,
  input: { tripId: string; to: Exclude<TripSalesState, "draft">; reason: string; now: Date },
): Promise<TripStateResult> {
  const trip = await loadTrip(trx, ctx.tenantId, input.tripId);
  if (!trip) return { kind: "not_found" };
  const from = trip.sales_state;
  if (!transitions[from].includes(input.to)) return { kind: "conflict", from, to: input.to };
  if (input.to === "completed" && new Date(trip.starts_at).getTime() > input.now.getTime()) {
    return { kind: "not_departed" };
  }
  const updated = await trx
    .updateTable("scheduled_trips")
    .set({
      sales_state: input.to,
      sales_state_changed_at: sql<Date>`now()`,
      updated_at: sql<Date>`now()`,
    })
    .where("tenant_id", "=", ctx.tenantId)
    .where("id", "=", trip.trip_id)
    .where("sales_state", "=", from)
    .returning("id")
    .executeTakeFirst();
  if (!updated) return { kind: "conflict", from, to: input.to };
  await recordAudit(trx, ctx, {
    action: "trip.sales_state_changed",
    subjectType: "scheduled_trip",
    subjectId: trip.trip_id,
    reason: input.reason,
    before: { salesState: from },
    after: { salesState: input.to },
  });
  await enqueueOutbox(trx, ctx, {
    topic: "catalog.trip.sales_state_changed",
    aggregateType: "scheduled_trip",
    aggregateId: trip.trip_id,
    payload: { tripId: trip.trip_id, from, to: input.to },
  });
  const reloaded = await loadTrip(trx, ctx.tenantId, trip.trip_id);
  if (!reloaded) throw new Error("trip vanished inside its own transaction");
  return { kind: "changed", trip: toStaffTrip(reloaded) };
}

export type GenerateTripsResult =
  | {
      kind: "generated";
      created: StaffTrip[];
      alreadyScheduled: number;
      skipped: SkippedOccurrence[];
    }
  | { kind: "not_found" }
  | { kind: "schedule_inactive" }
  | { kind: "product_archived" }
  | { kind: "range"; problem: RangeProblem };

const INSERT_BATCH = 500;

/**
 * Expands a schedule into trips for an inclusive local date range. Idempotent:
 * a departure that already exists (same product, boat, and instant) is left
 * untouched, including a canceled one, so generation never revives it.
 */
export async function generateTrips(
  trx: TenantTransaction,
  ctx: TenantContext,
  input: { scheduleId: string; fromDate: string; toDate: string; publish: boolean; reason: string },
): Promise<GenerateTripsResult> {
  const problem = checkRange(input.fromDate, input.toDate);
  if (problem) return { kind: "range", problem };
  const schedule = await trx
    .selectFrom("schedules as s")
    .innerJoin("products as p", (j) =>
      j.onRef("p.tenant_id", "=", "s.tenant_id").onRef("p.id", "=", "s.product_id"),
    )
    .innerJoin("boats as b", (j) =>
      j.onRef("b.tenant_id", "=", "s.tenant_id").onRef("b.id", "=", "s.boat_id"),
    )
    .select([
      "s.id",
      "s.product_id",
      "s.boat_id",
      "s.time_zone",
      "s.starts_on",
      "s.ends_on",
      "s.weekdays",
      "s.start_times",
      "s.ambiguous_time",
      "s.status",
      "p.kind",
      "p.location_id",
      "p.duration_minutes",
      "p.seat_limit",
      "p.sales_status",
      "b.guest_capacity",
    ])
    .where("s.tenant_id", "=", ctx.tenantId)
    .where("s.id", "=", input.scheduleId)
    .executeTakeFirst();
  if (!schedule) return { kind: "not_found" };
  if (schedule.status !== "active") return { kind: "schedule_inactive" };
  if (schedule.sales_status === "archived") return { kind: "product_archived" };

  const rule: ScheduleRule = {
    timeZone: schedule.time_zone,
    startsOn: dateOnly(schedule.starts_on),
    endsOn: dateOnly(schedule.ends_on),
    weekdays: schedule.weekdays as IsoWeekday[],
    startTimes: schedule.start_times.map((t) => t.slice(0, 5)),
    durationMinutes: schedule.duration_minutes,
    ambiguousTime: schedule.ambiguous_time as Disambiguation,
  };
  const toExclusive = addDays(input.toDate, 1);
  // A day either side covers any trip that starts in the range and runs past it.
  const windowStart = startOfLocalDay(rule.timeZone, addDays(input.fromDate, -1)).epochMs;
  const windowEnd = startOfLocalDay(rule.timeZone, addDays(toExclusive, 1)).epochMs;
  const blackoutRows = await trx
    .selectFrom("blackouts")
    .select(["starts_at", "ends_at"])
    .where("tenant_id", "=", ctx.tenantId)
    .where("starts_at", "<", new Date(windowEnd))
    .where("ends_at", ">", new Date(windowStart))
    .where((eb) =>
      eb.or([
        eb.and([
          eb("location_id", "is", null),
          eb("product_id", "is", null),
          eb("boat_id", "is", null),
        ]),
        eb("location_id", "=", schedule.location_id),
        eb("product_id", "=", schedule.product_id),
        eb("boat_id", "=", schedule.boat_id),
      ]),
    )
    .execute();
  const blackouts: BlackoutInterval[] = blackoutRows.map((b) => ({
    startsAtMs: new Date(b.starts_at).getTime(),
    endsAtMs: new Date(b.ends_at).getTime(),
  }));

  const expansion = expandSchedule(
    rule,
    { fromDate: input.fromDate, toDate: toExclusive },
    blackouts,
  );
  const seatCapacity =
    schedule.kind === "shared_seat"
      ? Math.min(schedule.seat_limit ?? schedule.guest_capacity, schedule.guest_capacity)
      : schedule.guest_capacity;

  const createdIds: string[] = [];
  for (let i = 0; i < expansion.occurrences.length; i += INSERT_BATCH) {
    const batch = expansion.occurrences.slice(i, i + INSERT_BATCH);
    const inserted = await trx
      .insertInto("scheduled_trips")
      .values(
        batch.map((o) => ({
          tenant_id: ctx.tenantId,
          product_id: schedule.product_id,
          boat_id: schedule.boat_id,
          schedule_id: schedule.id,
          time_zone: rule.timeZone,
          local_date: o.localDate,
          local_start_time: `${o.localStartTime}:00`,
          starts_at: new Date(o.startsAtMs),
          ends_at: new Date(o.endsAtMs),
          start_utc_offset_minutes: o.startOffsetMinutes,
          end_utc_offset_minutes: o.endOffsetMinutes,
          duration_minutes: rule.durationMinutes,
          seat_capacity: seatCapacity,
          sales_state: input.publish ? ("published" as const) : ("draft" as const),
        })),
      )
      .onConflict((oc) =>
        oc.columns(["tenant_id", "product_id", "boat_id", "starts_at"]).doNothing(),
      )
      .returning("id")
      .execute();
    createdIds.push(...inserted.map((r) => r.id));
  }
  const alreadyScheduled = expansion.occurrences.length - createdIds.length;

  await recordAudit(trx, ctx, {
    action: "schedule.trips_generated",
    subjectType: "schedule",
    subjectId: schedule.id,
    reason: input.reason,
    before: null,
    after: {
      fromDate: input.fromDate,
      toDate: input.toDate,
      publish: input.publish,
      created: createdIds.length,
      alreadyScheduled,
      skipped: expansion.skipped.length,
    },
  });
  if (createdIds.length > 0) {
    await enqueueOutbox(trx, ctx, {
      topic: "catalog.schedule.trips_generated",
      aggregateType: "schedule",
      aggregateId: schedule.id,
      payload: {
        scheduleId: schedule.id,
        fromDate: input.fromDate,
        toDate: input.toDate,
        created: createdIds.length,
      },
    });
  }

  const created =
    createdIds.length === 0
      ? []
      : (
          await sql<TripRow>`
            ${tripSelect}
             where t.tenant_id = ${ctx.tenantId} and t.id = any(${createdIds}::uuid[])
             order by t.starts_at, t.id`.execute(trx)
        ).rows.map(toStaffTrip);
  return { kind: "generated", created, alreadyScheduled, skipped: expansion.skipped };
}
