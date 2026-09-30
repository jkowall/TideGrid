import { randomUUID } from "node:crypto";
import { createDb, inTenantTransaction, type TenantContext } from "@tidegrid/database";
import type {} from "@tidegrid/database/global-setup";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";
import {
  changeTripSalesState,
  createBlackout,
  createBoat,
  createLocation,
  createProduct,
  createSchedule,
  findAvailableTrips,
  generateTrips,
  listTrips,
  loadCatalog,
  publishProduct,
} from "./index.ts";

type Sql = ReturnType<typeof postgres>;

const env = inject("integrationDb");

/** Postgres error code from a rejected promise. */
async function pgCode(p: Promise<unknown>): Promise<string | undefined> {
  try {
    await p;
    return undefined;
  } catch (err) {
    return (err as { code?: string }).code;
  }
}

describe.skipIf(!env)("catalog services against a real database as the runtime role", () => {
  let admin: Sql;
  let runtime: ReturnType<typeof createDb>;
  const run = randomUUID().slice(0, 8);
  const A = { id: randomUUID(), slug: `cat-a-${run}` };
  const B = { id: randomUUID(), slug: `cat-b-${run}` };
  const ctx = (tenantId: string): TenantContext => ({
    tenantId,
    actorType: "system",
    actorId: `catalog-test-${run}`,
    requestId: `req-${run}`,
  });
  const inA = <T>(fn: Parameters<typeof inTenantTransaction<T>>[2]) =>
    inTenantTransaction(runtime.db, ctx(A.id), fn);
  const inB = <T>(fn: Parameters<typeof inTenantTransaction<T>>[2]) =>
    inTenantTransaction(runtime.db, ctx(B.id), fn);

  // Tenant A: New York, which changes clocks. Tenant B: Honolulu, which does not.
  const a = { location: "", boat: "", smallBoat: "", product: "", charter: "", schedule: "" };
  const b = { location: "", boat: "", product: "", schedule: "" };

  beforeAll(async () => {
    if (!env) return;
    admin = postgres(env.adminUrl, { max: 2, onnotice: () => {} });
    runtime = createDb(env.runtimeUrl, { max: 2 });
    await admin`insert into public.tenants (id, slug, display_name) values
      (${A.id}, ${A.slug}, ${`Catalog A ${run}`}), (${B.id}, ${B.slug}, ${`Catalog B ${run}`})`;

    await inA(async (trx) => {
      const c = ctx(A.id);
      a.location = await createLocation(trx, c, {
        name: "Dock C",
        timeZone: "America/New_York",
        meetingPoint: "Slip 14",
        reason: "fixture",
      });
      a.boat = await createBoat(trx, c, { name: "Lark", guestCapacity: 20, reason: "fixture" });
      a.smallBoat = await createBoat(trx, c, { name: "Wren", guestCapacity: 6, reason: "fixture" });
      a.product = await createProduct(trx, c, {
        locationId: a.location,
        kind: "shared_seat",
        name: "Night and Sunset Cruise",
        durationMinutes: 90,
        bookingCutoffMinutes: 60,
        maxPartySize: 8,
        seatLimit: 12,
        eligibleBoatIds: [a.boat],
        reason: "fixture",
      });
      a.charter = await createProduct(trx, c, {
        locationId: a.location,
        kind: "private_charter",
        name: "Private Charter",
        durationMinutes: 240,
        bookingCutoffMinutes: 1440,
        maxPartySize: 6,
        eligibleBoatIds: [a.smallBoat],
        reason: "fixture",
      });
      expect((await publishProduct(trx, c, { productId: a.product, reason: "fixture" })).kind).toBe(
        "published",
      );
      expect((await publishProduct(trx, c, { productId: a.charter, reason: "fixture" })).kind).toBe(
        "published",
      );
      const schedule = await createSchedule(trx, c, {
        productId: a.product,
        boatId: a.boat,
        startsOn: "2026-10-01",
        endsOn: "2027-04-30",
        weekdays: [1, 2, 3, 4, 5, 6, 7],
        startTimes: ["18:00", "01:30"],
        reason: "fixture",
      });
      if (schedule.kind !== "created") throw new Error(JSON.stringify(schedule));
      a.schedule = schedule.id;
    });

    await inB(async (trx) => {
      const c = ctx(B.id);
      b.location = await createLocation(trx, c, {
        name: "Reef Point",
        timeZone: "Pacific/Honolulu",
        reason: "fixture",
      });
      b.boat = await createBoat(trx, c, { name: "Runner", guestCapacity: 16, reason: "fixture" });
      b.product = await createProduct(trx, c, {
        locationId: b.location,
        kind: "shared_seat",
        name: "Morning Dive",
        durationMinutes: 240,
        maxPartySize: 6,
        eligibleBoatIds: [b.boat],
        reason: "fixture",
      });
      await publishProduct(trx, c, { productId: b.product, reason: "fixture" });
      const schedule = await createSchedule(trx, c, {
        productId: b.product,
        boatId: b.boat,
        startsOn: "2026-10-01",
        endsOn: "2027-04-30",
        weekdays: [1, 2, 3, 4, 5, 6, 7],
        startTimes: ["07:30"],
        reason: "fixture",
      });
      if (schedule.kind !== "created") throw new Error(JSON.stringify(schedule));
      b.schedule = schedule.id;
      const generated = await generateTrips(trx, c, {
        scheduleId: b.schedule,
        fromDate: "2026-10-30",
        toDate: "2026-11-02",
        publish: true,
        reason: "fixture",
      });
      expect(generated).toMatchObject({ kind: "generated", alreadyScheduled: 0, skipped: [] });
    });
  });

  afterAll(async () => {
    await runtime?.end();
    await admin?.end();
  });

  describe("generation across clock changes", () => {
    it("skips the repeated 01:30 on the fall-back night and snapshots offsets on both sides", async () => {
      const result = await inA((trx) =>
        generateTrips(trx, ctx(A.id), {
          scheduleId: a.schedule,
          fromDate: "2026-10-31",
          toDate: "2026-11-02",
          publish: true,
          reason: "fall back",
        }),
      );
      if (result.kind !== "generated") throw new Error(JSON.stringify(result));
      expect(result.skipped).toEqual([
        { localDate: "2026-11-01", localStartTime: "01:30", reason: "ambiguous_local_time" },
      ]);
      expect(
        result.created.map((t) => [t.localDate, t.localStartTime, t.startsAt, t.startsAtLocal]),
      ).toEqual([
        ["2026-10-31", "01:30", "2026-10-31T05:30:00.000Z", "2026-10-31T01:30:00-04:00"],
        ["2026-10-31", "18:00", "2026-10-31T22:00:00.000Z", "2026-10-31T18:00:00-04:00"],
        ["2026-11-01", "18:00", "2026-11-01T23:00:00.000Z", "2026-11-01T18:00:00-05:00"],
        ["2026-11-02", "01:30", "2026-11-02T06:30:00.000Z", "2026-11-02T01:30:00-05:00"],
        ["2026-11-02", "18:00", "2026-11-02T23:00:00.000Z", "2026-11-02T18:00:00-05:00"],
      ]);
      expect(result.created.every((t) => t.salesState === "published")).toBe(true);
      expect(result.created[0]?.capacity).toEqual({ kind: "seats", total: 12, remaining: 12 });
    });

    it("keeps departures that exist on the spring-forward day and snapshots the new offset", async () => {
      // 01:30 exists on the spring-forward day; only 02:00 to 02:59 is skipped by the clocks.
      const result = await inA((trx) =>
        generateTrips(trx, ctx(A.id), {
          scheduleId: a.schedule,
          fromDate: "2027-03-13",
          toDate: "2027-03-15",
          publish: false,
          reason: "spring forward",
        }),
      );
      if (result.kind !== "generated") throw new Error(JSON.stringify(result));
      expect(result.skipped).toEqual([]);
      const byDay = result.created.map(
        (t) => `${t.localDate} ${t.localStartTime} ${t.startsAtLocal.slice(-6)}`,
      );
      expect(byDay).toEqual([
        "2027-03-13 01:30 -05:00",
        "2027-03-13 18:00 -05:00",
        "2027-03-14 01:30 -05:00",
        "2027-03-14 18:00 -04:00",
        "2027-03-15 01:30 -04:00",
        "2027-03-15 18:00 -04:00",
      ]);
    });

    it("rejects a departure in the spring-forward gap when the schedule asks for one", async () => {
      const gap = await inA((trx) =>
        createSchedule(trx, ctx(A.id), {
          productId: a.charter,
          boatId: a.smallBoat,
          startsOn: "2027-03-14",
          endsOn: "2027-03-14",
          weekdays: [7],
          startTimes: ["02:30"],
          reason: "gap",
        }),
      );
      if (gap.kind !== "created") throw new Error(JSON.stringify(gap));
      const result = await inA((trx) =>
        generateTrips(trx, ctx(A.id), {
          scheduleId: gap.id,
          fromDate: "2027-03-14",
          toDate: "2027-03-14",
          publish: false,
          reason: "gap",
        }),
      );
      expect(result).toMatchObject({
        kind: "generated",
        created: [],
        skipped: [
          { localDate: "2027-03-14", localStartTime: "02:30", reason: "nonexistent_local_time" },
        ],
      });
    });

    it("is idempotent and never revives a canceled departure", async () => {
      const first = await inA((trx) =>
        listTrips(trx, A.id, { from: "2026-11-02", to: "2026-11-02" }),
      );
      const canceled = first[0];
      if (!canceled) throw new Error("no trip on 2026-11-02");
      const change = await inA((trx) =>
        changeTripSalesState(trx, ctx(A.id), {
          tripId: canceled.tripId,
          to: "canceled",
          reason: "weather",
          now: new Date("2026-10-15T00:00:00Z"),
        }),
      );
      expect(change.kind).toBe("changed");
      const again = await inA((trx) =>
        generateTrips(trx, ctx(A.id), {
          scheduleId: a.schedule,
          fromDate: "2026-10-31",
          toDate: "2026-11-02",
          publish: true,
          reason: "rerun",
        }),
      );
      expect(again).toMatchObject({ kind: "generated", created: [], alreadyScheduled: 5 });
      const after = await inA((trx) =>
        listTrips(trx, A.id, { from: "2026-11-02", to: "2026-11-02" }),
      );
      expect(after.find((t) => t.tripId === canceled.tripId)?.salesState).toBe("canceled");
      const [audit] = await admin<{ n: number }[]>`
        select count(*)::int as n from audit_events
         where tenant_id = ${A.id} and action = 'schedule.trips_generated'`;
      expect(audit?.n).toBeGreaterThanOrEqual(3);
    });
  });

  describe("availability", () => {
    const now = new Date("2026-10-15T00:00:00Z");

    it("lists published trips in the local date range with room for the party", async () => {
      const trips = await inA((trx) =>
        findAvailableTrips(trx, A.id, { from: "2026-10-31", to: "2026-11-01", party: 2, now }),
      );
      expect(trips.map((t) => t.startsAtLocal)).toEqual([
        "2026-10-31T01:30:00-04:00",
        "2026-10-31T18:00:00-04:00",
        "2026-11-01T18:00:00-05:00",
      ]);
      expect(trips[0]).toMatchObject({
        product: {
          name: "Night and Sunset Cruise",
          kind: "shared_seat",
          minPartySize: 1,
          maxPartySize: 8,
        },
        location: { name: "Dock C", meetingPoint: "Slip 14" },
        timeZone: "America/New_York",
        salesCloseAt: "2026-10-31T04:30:00.000Z",
        capacity: { kind: "seats", total: 12, remaining: 12 },
      });
    });

    it("closes sales exactly at the booking cutoff", async () => {
      const find = (at: Date) =>
        inA((trx) =>
          findAvailableTrips(trx, A.id, {
            from: "2026-10-31",
            to: "2026-10-31",
            party: 1,
            now: at,
          }),
        );
      const cutoff = new Date("2026-10-31T21:00:00Z"); // 18:00 EDT departure, 60-minute cutoff
      const before = await find(new Date(cutoff.getTime() - 1));
      const at = await find(cutoff);
      expect(before.map((t) => t.localStartTime)).toEqual(["18:00"]);
      expect(at).toEqual([]);
    });

    it("filters by party size against the product and the trip's seats", async () => {
      const count = (party: number) =>
        inA((trx) =>
          findAvailableTrips(trx, A.id, { from: "2026-10-31", to: "2026-10-31", party, now }),
        ).then((t) => t.length);
      expect(await count(8)).toBe(2);
      expect(await count(9)).toBe(0);
    });

    it("hides closed trips, draft trips, and trips under a blackout, and says why to staff", async () => {
      const [first] = await inA((trx) =>
        findAvailableTrips(trx, A.id, { from: "2026-10-31", to: "2026-10-31", party: 1, now }),
      );
      if (!first) throw new Error("no trip");
      await inA((trx) =>
        changeTripSalesState(trx, ctx(A.id), {
          tripId: first.tripId,
          to: "closed",
          reason: "full",
          now,
        }),
      );
      await inA((trx) =>
        createBlackout(trx, ctx(A.id), {
          scope: { kind: "location", locationId: a.location },
          startsOn: "2026-11-01",
          endsOn: "2026-11-01",
          reason: "regatta",
        }),
      );
      const trips = await inA((trx) =>
        findAvailableTrips(trx, A.id, { from: "2026-10-31", to: "2027-01-01", party: 1, now }),
      );
      // 01:30 on the 31st is closed, the 1st is blacked out, 01:30 on the 2nd is canceled.
      expect(trips.map((t) => t.startsAtLocal)).toEqual([
        "2026-10-31T18:00:00-04:00",
        "2026-11-02T18:00:00-05:00",
      ]);
      const staff = await inA((trx) =>
        listTrips(trx, A.id, { from: "2026-10-31", to: "2026-11-01" }),
      );
      expect(staff.map((t) => [t.localDate, t.localStartTime, t.salesState, t.blackedOut])).toEqual(
        [
          ["2026-10-31", "01:30", "closed", false],
          ["2026-10-31", "18:00", "published", false],
          ["2026-11-01", "18:00", "published", true],
        ],
      );
      // Spring trips were generated as drafts, so guests never see them.
      const spring = await inA((trx) =>
        findAvailableTrips(trx, A.id, { from: "2027-03-13", to: "2027-03-15", party: 1, now }),
      );
      expect(spring).toEqual([]);
    });

    it("skips blackout days when generating", async () => {
      await inA((trx) =>
        createBlackout(trx, ctx(A.id), {
          scope: { kind: "tenant", timeZone: "America/New_York" },
          startsOn: "2026-12-25",
          endsOn: "2026-12-25",
          reason: "holiday",
        }),
      );
      const result = await inA((trx) =>
        generateTrips(trx, ctx(A.id), {
          scheduleId: a.schedule,
          fromDate: "2026-12-24",
          toDate: "2026-12-26",
          publish: true,
          reason: "holiday week",
        }),
      );
      if (result.kind !== "generated") throw new Error(JSON.stringify(result));
      expect(result.skipped).toEqual([
        { localDate: "2026-12-25", localStartTime: "01:30", reason: "blackout" },
        { localDate: "2026-12-25", localStartTime: "18:00", reason: "blackout" },
      ]);
      // The 18:00 trip on the 24th ends at 19:30, before the holiday starts: kept.
      expect(result.created.map((t) => `${t.localDate} ${t.localStartTime}`)).toEqual([
        "2026-12-24 01:30",
        "2026-12-24 18:00",
        "2026-12-26 01:30",
        "2026-12-26 18:00",
      ]);
    });
  });

  describe("sales states", () => {
    it("follows the state machine in the service and in the database", async () => {
      const [trip] = await inA((trx) =>
        listTrips(trx, A.id, { from: "2027-03-15", to: "2027-03-15" }),
      );
      if (!trip) throw new Error("no draft trip");
      expect(trip.salesState).toBe("draft");
      const move = (
        to: "published" | "closed" | "canceled" | "completed",
        now = new Date("2026-10-15T00:00:00Z"),
      ) =>
        inA((trx) =>
          changeTripSalesState(trx, ctx(A.id), { tripId: trip.tripId, to, reason: "test", now }),
        );
      expect(await move("closed")).toEqual({ kind: "conflict", from: "draft", to: "closed" });
      expect((await move("published")).kind).toBe("changed");
      expect(await move("completed")).toEqual({ kind: "not_departed" });
      expect((await move("canceled")).kind).toBe("changed");
      expect(await move("published")).toEqual({
        kind: "conflict",
        from: "canceled",
        to: "published",
      });

      const raw = postgres(env?.runtimeUrl ?? "", { max: 1, onnotice: () => {} });
      try {
        const attempt = (statement: string) =>
          pgCode(
            raw.begin(async (tx) => {
              await tx`select set_config('app.tenant_id', ${A.id}, true)`;
              await tx.unsafe(statement, [trip.tripId]);
            }),
          );
        expect(
          await attempt("update scheduled_trips set sales_state = 'published' where id = $1"),
        ).toBe("23514");
        expect(await attempt("update scheduled_trips set starts_at = now() where id = $1")).toBe(
          "42501",
        );
        expect(await attempt("delete from scheduled_trips where id = $1")).toBe("42501");
      } finally {
        await raw.end();
      }
    });
  });

  describe("database guards", () => {
    it("refuses a trip whose local and UTC values or zone disagree", async () => {
      // A consistent row: 18:00 EST on November 5 is 23:00 UTC, and 90 minutes later is 00:30.
      const valid = {
        tenant_id: A.id,
        product_id: a.product,
        boat_id: a.boat,
        time_zone: "America/New_York",
        local_date: "2026-11-05",
        local_start_time: "18:00",
        starts_at: "2026-11-05T23:00:00Z",
        ends_at: "2026-11-06T00:30:00Z",
        start_utc_offset_minutes: -300,
        end_utc_offset_minutes: -300,
        duration_minutes: 90,
        seat_capacity: 12,
      };
      const insert = (changes: Partial<typeof valid>) =>
        pgCode(admin`insert into public.scheduled_trips ${admin({ ...valid, ...changes })}`);
      expect(await insert({ local_start_time: "19:00" })).toBe("23514");
      expect(await insert({ start_utc_offset_minutes: -240 })).toBe("23514");
      // Consistent in Chicago, but the product's location is in New York.
      expect(
        await insert({
          time_zone: "America/Chicago",
          local_start_time: "17:00",
          start_utc_offset_minutes: -360,
          end_utc_offset_minutes: -360,
        }),
      ).toBe("23514");
      expect(await insert({ seat_capacity: 21 })).toBe("23514");
      expect(await insert({ time_zone: "Mars/Olympus" })).toBe("22023");
      expect(await insert({ time_zone: "EST5EDT" })).toBe("23514");
      expect(await insert({})).toBeUndefined();
    });

    it("requires blackout instants to be the local day boundaries", async () => {
      const code = await pgCode(
        admin`insert into public.blackouts (tenant_id, time_zone, starts_on, ends_on, starts_at, ends_at, reason)
          values (${A.id}, 'America/New_York', '2027-01-10', '2027-01-10',
                  '2027-01-10T00:00:00Z', '2027-01-11T00:00:00Z', 'utc midnight is wrong here')`,
      );
      expect(code).toBe("23514");
    });
  });

  describe("publishing", () => {
    it("blocks a product with no eligible boat or a party larger than it can seat", async () => {
      const results = await inA(async (trx) => {
        const c = ctx(A.id);
        const orphan = await createProduct(trx, c, {
          locationId: a.location,
          kind: "shared_seat",
          name: "No boat",
          durationMinutes: 60,
          maxPartySize: 4,
          eligibleBoatIds: [],
          reason: "test",
        });
        const oversized = await createProduct(trx, c, {
          locationId: a.location,
          kind: "shared_seat",
          name: "Too many",
          durationMinutes: 60,
          maxPartySize: 15,
          seatLimit: 10,
          eligibleBoatIds: [a.boat],
          reason: "test",
        });
        return [
          await publishProduct(trx, c, { productId: orphan, reason: "test" }),
          await publishProduct(trx, c, { productId: oversized, reason: "test" }),
          await publishProduct(trx, c, { productId: a.product, reason: "again" }),
        ];
      });
      expect(results[0]).toEqual({
        kind: "not_publishable",
        problems: ["product_missing_eligible_boat"],
      });
      expect(results[1]).toEqual({
        kind: "not_publishable",
        problems: ["product_party_exceeds_capacity"],
      });
      expect(results[2]?.kind).toBe("unchanged");
    });
  });

  describe("two tenants", () => {
    it("cannot see, reference, or change the other tenant's catalog", async () => {
      const bTrips = await inB((trx) =>
        listTrips(trx, B.id, { from: "2026-10-30", to: "2026-11-02" }),
      );
      expect(bTrips.length).toBe(4);
      const bTrip = bTrips[0];
      if (!bTrip) throw new Error("no B trip");

      // Explicit filters for B inside A's context find nothing: RLS bounds every read.
      expect(
        await inA((trx) => listTrips(trx, B.id, { from: "2026-10-30", to: "2026-11-02" })),
      ).toEqual([]);
      expect(await inA((trx) => loadCatalog(trx, B.id))).toEqual({
        locations: [],
        boats: [],
        products: [],
        schedules: [],
      });
      expect(
        await inA((trx) =>
          findAvailableTrips(trx, B.id, {
            from: "2026-10-30",
            to: "2026-11-02",
            party: 1,
            now: new Date("2026-10-15T00:00:00Z"),
          }),
        ),
      ).toEqual([]);

      // Commands in A's context cannot reach B's rows.
      expect(
        await inA((trx) =>
          changeTripSalesState(trx, ctx(A.id), {
            tripId: bTrip.tripId,
            to: "canceled",
            reason: "escape",
            now: new Date(),
          }),
        ),
      ).toEqual({ kind: "not_found" });
      expect(
        await inA((trx) =>
          generateTrips(trx, ctx(A.id), {
            scheduleId: b.schedule,
            fromDate: "2026-11-03",
            toDate: "2026-11-04",
            publish: true,
            reason: "escape",
          }),
        ),
      ).toEqual({ kind: "not_found" });

      // Writes naming B's rows fail: under A's tenant_id the composite keys do not
      // match, and under B's tenant_id the policy refuses the row.
      expect(
        await pgCode(
          inA((trx) =>
            trx
              .insertInto("product_boats")
              .values({ tenant_id: A.id, product_id: b.product, boat_id: b.boat })
              .execute(),
          ),
        ),
      ).toBe("23503");
      expect(
        await pgCode(
          inA((trx) =>
            trx
              .insertInto("boats")
              .values({ tenant_id: B.id, name: "Stowaway", guest_capacity: 4 })
              .execute(),
          ),
        ),
      ).toBe("42501");

      const unchanged = await inB((trx) =>
        listTrips(trx, B.id, { from: "2026-10-30", to: "2026-11-02" }),
      );
      expect(unchanged.map((t) => t.salesState)).toEqual([
        "published",
        "published",
        "published",
        "published",
      ]);
      expect(unchanged[0]?.startsAtLocal).toBe("2026-10-30T07:30:00-10:00");
    });
  });
});
