import type { ProductKind } from "@tidegrid/contracts";
import { recordAudit, type TenantContext, type TenantTransaction } from "@tidegrid/database";
import { validateScheduleRule } from "./recurrence.ts";
import type { ScheduleRule, ScheduleRuleProblem } from "./schedule-types.ts";
import {
  addDays,
  type Disambiguation,
  type IsoWeekday,
  isLocalDate,
  isValidTimeZone,
  type LocalDate,
  type LocalTime,
  startOfLocalDay,
} from "./time.ts";

/**
 * Catalog setup commands. The demo seeds its catalog through these, so seeded
 * data passes the same validation a console will. Staff endpoints for them
 * arrive with the console goal; until then invalid input throws RangeError.
 */

export async function createLocation(
  trx: TenantTransaction,
  ctx: TenantContext,
  input: {
    name: string;
    timeZone: string;
    meetingPoint?: string;
    meetingInstructions?: string;
    reason: string;
  },
): Promise<string> {
  if (!isValidTimeZone(input.timeZone))
    throw new RangeError(`Unknown time zone: ${input.timeZone}`);
  const { id } = await trx
    .insertInto("locations")
    .values({
      tenant_id: ctx.tenantId,
      name: input.name,
      time_zone: input.timeZone,
      meeting_point: input.meetingPoint ?? "",
      meeting_instructions: input.meetingInstructions ?? "",
    })
    .returning("id")
    .executeTakeFirstOrThrow();
  await recordAudit(trx, ctx, {
    action: "location.created",
    subjectType: "location",
    subjectId: id,
    reason: input.reason,
    after: { name: input.name, timeZone: input.timeZone },
  });
  return id;
}

export async function createBoat(
  trx: TenantTransaction,
  ctx: TenantContext,
  input: { name: string; guestCapacity: number; reason: string },
): Promise<string> {
  const { id } = await trx
    .insertInto("boats")
    .values({ tenant_id: ctx.tenantId, name: input.name, guest_capacity: input.guestCapacity })
    .returning("id")
    .executeTakeFirstOrThrow();
  await recordAudit(trx, ctx, {
    action: "boat.created",
    subjectType: "boat",
    subjectId: id,
    reason: input.reason,
    after: { name: input.name, guestCapacity: input.guestCapacity },
  });
  return id;
}

/** Creates a draft product and the boats it may use. Publishing is a separate command. */
export async function createProduct(
  trx: TenantTransaction,
  ctx: TenantContext,
  input: {
    locationId: string;
    kind: ProductKind;
    name: string;
    summary?: string;
    durationMinutes: number;
    bookingCutoffMinutes?: number;
    turnaroundBufferMinutes?: number;
    minPartySize?: number;
    maxPartySize: number;
    seatLimit?: number | null;
    eligibleBoatIds: readonly string[];
    reason: string;
  },
): Promise<string> {
  const { id } = await trx
    .insertInto("products")
    .values({
      tenant_id: ctx.tenantId,
      location_id: input.locationId,
      kind: input.kind,
      name: input.name,
      summary: input.summary ?? "",
      duration_minutes: input.durationMinutes,
      booking_cutoff_minutes: input.bookingCutoffMinutes ?? 0,
      turnaround_buffer_minutes: input.turnaroundBufferMinutes ?? 0,
      min_party_size: input.minPartySize ?? 1,
      max_party_size: input.maxPartySize,
      seat_limit: input.seatLimit ?? null,
    })
    .returning("id")
    .executeTakeFirstOrThrow();
  if (input.eligibleBoatIds.length > 0) {
    await trx
      .insertInto("product_boats")
      .values(
        input.eligibleBoatIds.map((boatId) => ({
          tenant_id: ctx.tenantId,
          product_id: id,
          boat_id: boatId,
        })),
      )
      .execute();
  }
  await recordAudit(trx, ctx, {
    action: "product.created",
    subjectType: "product",
    subjectId: id,
    reason: input.reason,
    after: { name: input.name, kind: input.kind, eligibleBoatIds: [...input.eligibleBoatIds] },
  });
  return id;
}

export type CreateScheduleResult =
  | { kind: "created"; id: string }
  | { kind: "not_found" }
  | { kind: "invalid"; problems: ScheduleRuleProblem[] };

/** The zone comes from the product's location; the boat must be eligible for the product. */
export async function createSchedule(
  trx: TenantTransaction,
  ctx: TenantContext,
  input: {
    productId: string;
    boatId: string;
    startsOn: LocalDate;
    endsOn: LocalDate;
    weekdays: readonly IsoWeekday[];
    startTimes: readonly LocalTime[];
    ambiguousTime?: Disambiguation;
    reason: string;
  },
): Promise<CreateScheduleResult> {
  const product = await trx
    .selectFrom("products as p")
    .innerJoin("locations as l", (j) =>
      j.onRef("l.tenant_id", "=", "p.tenant_id").onRef("l.id", "=", "p.location_id"),
    )
    .select(["p.id", "p.duration_minutes", "l.time_zone"])
    .where("p.tenant_id", "=", ctx.tenantId)
    .where("p.id", "=", input.productId)
    .executeTakeFirst();
  if (!product) return { kind: "not_found" };
  const rule: ScheduleRule = {
    timeZone: product.time_zone,
    startsOn: input.startsOn,
    endsOn: input.endsOn,
    weekdays: input.weekdays,
    startTimes: input.startTimes,
    durationMinutes: product.duration_minutes,
    ambiguousTime: input.ambiguousTime ?? "reject",
  };
  const problems = validateScheduleRule(rule);
  if (problems.length > 0) return { kind: "invalid", problems };
  const { id } = await trx
    .insertInto("schedules")
    .values({
      tenant_id: ctx.tenantId,
      product_id: product.id,
      boat_id: input.boatId,
      time_zone: rule.timeZone,
      starts_on: rule.startsOn,
      ends_on: rule.endsOn,
      weekdays: [...rule.weekdays],
      start_times: rule.startTimes.map((t) => `${t}:00`),
      ambiguous_time: rule.ambiguousTime,
    })
    .returning("id")
    .executeTakeFirstOrThrow();
  await recordAudit(trx, ctx, {
    action: "schedule.created",
    subjectType: "schedule",
    subjectId: id,
    reason: input.reason,
    after: {
      productId: product.id,
      boatId: input.boatId,
      startsOn: rule.startsOn,
      endsOn: rule.endsOn,
      weekdays: [...rule.weekdays],
      startTimes: [...rule.startTimes],
      ambiguousTime: rule.ambiguousTime,
    },
  });
  return { kind: "created", id };
}

export type BlackoutScope =
  | { kind: "tenant"; timeZone: string }
  | { kind: "location"; locationId: string }
  | { kind: "product"; productId: string }
  | { kind: "boat"; boatId: string; timeZone: string };

/**
 * Whole local days with no sales. A location or product blackout uses that
 * location's zone; a tenant-wide or boat blackout names its zone.
 */
export async function createBlackout(
  trx: TenantTransaction,
  ctx: TenantContext,
  input: { scope: BlackoutScope; startsOn: LocalDate; endsOn: LocalDate; reason: string },
): Promise<string> {
  if (!isLocalDate(input.startsOn) || !isLocalDate(input.endsOn) || input.endsOn < input.startsOn) {
    throw new RangeError("A blackout needs valid dates with endsOn on or after startsOn");
  }
  const { scope } = input;
  let timeZone: string;
  if (scope.kind === "tenant" || scope.kind === "boat") {
    timeZone = scope.timeZone;
  } else {
    let query = trx
      .selectFrom("locations as l")
      .select("l.time_zone")
      .where("l.tenant_id", "=", ctx.tenantId);
    query =
      scope.kind === "location"
        ? query.where("l.id", "=", scope.locationId)
        : query.where(
            "l.id",
            "=",
            trx
              .selectFrom("products")
              .select("location_id")
              .where("tenant_id", "=", ctx.tenantId)
              .where("id", "=", scope.productId),
          );
    const row = await query.executeTakeFirst();
    if (!row) throw new RangeError(`No ${scope.kind} for this blackout`);
    timeZone = row.time_zone;
  }
  if (!isValidTimeZone(timeZone)) throw new RangeError(`Unknown time zone: ${timeZone}`);
  const startsAt = startOfLocalDay(timeZone, input.startsOn).epochMs;
  const endsAt = startOfLocalDay(timeZone, addDays(input.endsOn, 1)).epochMs;
  const { id } = await trx
    .insertInto("blackouts")
    .values({
      tenant_id: ctx.tenantId,
      location_id: scope.kind === "location" ? scope.locationId : null,
      product_id: scope.kind === "product" ? scope.productId : null,
      boat_id: scope.kind === "boat" ? scope.boatId : null,
      time_zone: timeZone,
      starts_on: input.startsOn,
      ends_on: input.endsOn,
      starts_at: new Date(startsAt),
      ends_at: new Date(endsAt),
      reason: input.reason,
    })
    .returning("id")
    .executeTakeFirstOrThrow();
  await recordAudit(trx, ctx, {
    action: "blackout.created",
    subjectType: "blackout",
    subjectId: id,
    reason: input.reason,
    after: { scope: scope.kind, startsOn: input.startsOn, endsOn: input.endsOn, timeZone },
  });
  return id;
}
