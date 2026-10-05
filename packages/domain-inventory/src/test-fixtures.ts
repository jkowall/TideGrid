/**
 * Integration-test fixtures (Node only; not exported from the package). Builds
 * one synthetic tenant through the real catalog services so trips pass every
 * catalog rule, then hands out unused trips so tests never share capacity.
 * Times are in UTC and relative to the database clock, so trips are always in
 * the future when the suite runs.
 */
import { randomUUID } from "node:crypto";
import { type createDb, inTenantTransaction, type TenantContext } from "@tidegrid/database";
import {
  addDays,
  createBoat,
  createLocation,
  createProduct,
  createSchedule,
  generateTrips,
  publishProduct,
} from "@tidegrid/domain-catalog";
import type postgres from "postgres";

type Sql = ReturnType<typeof postgres>;
type Db = ReturnType<typeof createDb>["db"];

export interface TenantFixture {
  id: string;
  slug: string;
  /** Daily 10:00 UTC departures from two days out (40 by default), oldest first. */
  trips: {
    /** Shared seats: party 1 to 8, 10 seats a trip, sales close 60 minutes before. */
    shared: string[];
    /** Private charter: party 2 to 6, the whole six-guest boat, no cutoff. */
    charter: string[];
    /** Shared seats whose sales close seven days before departure: always closed here. */
    late: string[];
  };
  location: string;
  boats: { lark: string; wren: string; tern: string };
  products: { shared: string; charter: string; late: string };
}

export function systemContext(tenantId: string, actorId = "inventory-test"): TenantContext {
  return { tenantId, actorType: "system", actorId, requestId: `req-${randomUUID()}` };
}

/** Today's UTC date by the database clock. */
async function databaseToday(admin: Sql): Promise<string> {
  const [row] = await admin<
    { today: string }[]
  >`select (now() at time zone 'UTC')::date::text as today`;
  if (!row) throw new Error("no database clock");
  return row.today;
}

export async function createTenantFixture(
  admin: Sql,
  db: Db,
  label: string,
  options: { days?: number } = {},
): Promise<TenantFixture> {
  const days = options.days ?? 40;
  const id = randomUUID();
  const slug = `${label}-${id.slice(0, 8)}`;
  await admin`insert into public.tenants (id, slug, display_name)
    values (${id}, ${slug}, ${`Inventory ${slug}`})`;
  const today = await databaseToday(admin);
  const from = addDays(today, 2);
  const to = addDays(from, days - 1);
  const ctx = systemContext(id, "fixture");
  return inTenantTransaction(db, ctx, async (trx) => {
    const reason = "fixture";
    const location = await createLocation(trx, ctx, { name: "Dock U", timeZone: "UTC", reason });
    const lark = await createBoat(trx, ctx, { name: "Lark", guestCapacity: 20, reason });
    const wren = await createBoat(trx, ctx, { name: "Wren", guestCapacity: 6, reason });
    const tern = await createBoat(trx, ctx, { name: "Tern", guestCapacity: 8, reason });
    const shared = await createProduct(trx, ctx, {
      locationId: location,
      kind: "shared_seat",
      name: "Harbor Seats",
      durationMinutes: 60,
      bookingCutoffMinutes: 60,
      maxPartySize: 8,
      seatLimit: 10,
      eligibleBoatIds: [lark],
      reason,
    });
    const charter = await createProduct(trx, ctx, {
      locationId: location,
      kind: "private_charter",
      name: "Wren Charter",
      durationMinutes: 120,
      bookingCutoffMinutes: 0,
      minPartySize: 2,
      maxPartySize: 6,
      eligibleBoatIds: [wren],
      reason,
    });
    const late = await createProduct(trx, ctx, {
      locationId: location,
      kind: "shared_seat",
      name: "Early Planner",
      durationMinutes: 60,
      bookingCutoffMinutes: 10080,
      maxPartySize: 8,
      eligibleBoatIds: [tern],
      reason,
    });
    const trips: TenantFixture["trips"] = { shared: [], charter: [], late: [] };
    for (const [key, productId, boatId] of [
      ["shared", shared, lark],
      ["charter", charter, wren],
      ["late", late, tern],
    ] as const) {
      const published = await publishProduct(trx, ctx, { productId, reason });
      if (published.kind !== "published") throw new Error(`fixture product ${key} did not publish`);
      const schedule = await createSchedule(trx, ctx, {
        productId,
        boatId,
        startsOn: from,
        endsOn: to,
        weekdays: [1, 2, 3, 4, 5, 6, 7],
        startTimes: ["10:00"],
        reason,
      });
      if (schedule.kind !== "created") throw new Error(`fixture schedule ${key} was rejected`);
      const generated = await generateTrips(trx, ctx, {
        scheduleId: schedule.id,
        fromDate: from,
        toDate: to,
        publish: true,
        reason,
      });
      if (generated.kind !== "generated" || generated.created.length !== days) {
        throw new Error(`fixture trips for ${key} were not generated`);
      }
      trips[key] = generated.created.map((t) => t.tripId);
    }
    return {
      id,
      slug,
      trips,
      location,
      boats: { lark, wren, tern },
      products: { shared, charter, late },
    };
  });
}

/** Hands out each fixture trip once, so tests never share capacity. */
export function tripAllocator(fixture: TenantFixture) {
  const used = { shared: 0, charter: 0, late: 0 };
  const take = (key: keyof TenantFixture["trips"]): string => {
    const id = fixture.trips[key][used[key]];
    if (!id) throw new Error(`fixture ran out of ${key} trips`);
    used[key] += 1;
    return id;
  };
  return {
    shared: () => take("shared"),
    charter: () => take("charter"),
    late: () => take("late"),
  };
}

/** Move a hold's expiry into the past, as time passing would. Admin only. */
export async function backdateHold(admin: Sql, holdId: string, seconds = 1): Promise<void> {
  const rows = await admin`
    update public.capacity_holds
       set expires_at = now() - make_interval(secs => ${seconds})
     where id = ${holdId}
    returning id`;
  if (rows.length !== 1) throw new Error(`no hold ${holdId} to backdate`);
}
