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
  offsetMinutesAt,
  publishProduct,
  ZoneDataMismatchError,
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
      const audits = async () =>
        (
          await admin<{ n: number }[]>`
            select count(*)::int as n from audit_events
             where tenant_id = ${A.id} and action = 'schedule.trips_generated'`
        )[0]?.n;
      const auditsBefore = await audits();
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
      // A run that creates nothing changes nothing, so it leaves no audit row.
      expect(await audits()).toBe(auditsBefore);
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
      expect(
        await pgCode(
          admin`insert into public.scheduled_trips ${admin({ ...valid, local_date: "2026-11-06", starts_at: "2026-11-06T23:00:00Z", ends_at: "2026-11-07T00:30:00Z", sales_state: "completed" })}`,
        ),
      ).toBe("23514");
      expect(await insert({})).toBeUndefined();
    });

    it("requires a location blackout to use its location's zone", async () => {
      // Correct Chicago day boundaries, but the location keeps New York time.
      const code = await pgCode(
        admin`insert into public.blackouts (tenant_id, location_id, time_zone, starts_on, ends_on, starts_at, ends_at, reason)
          values (${A.id}, ${a.location}, 'America/Chicago', '2027-01-10', '2027-01-10',
                  '2027-01-10T06:00:00Z', '2027-01-11T06:00:00Z', 'wrong zone')`,
      );
      expect(code).toBe("23514");
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

  describe("clock changes stored through the database", () => {
    it("closes sales at the cutoff instant when the cutoff spans a clock change", async () => {
      // 00:30 EST on November 2 is 05:30 UTC. A 24-hour cutoff closes sales 24
      // elapsed hours earlier, at 05:30 UTC on November 1, which is 01:30 EDT and
      // not 00:30: the clocks go back in between.
      const schedule = await inA((trx) =>
        createSchedule(trx, ctx(A.id), {
          productId: a.charter,
          boatId: a.smallBoat,
          startsOn: "2026-11-02",
          endsOn: "2026-11-02",
          weekdays: [1],
          startTimes: ["00:30"],
          reason: "cutoff",
        }),
      );
      if (schedule.kind !== "created") throw new Error(JSON.stringify(schedule));
      await inA((trx) =>
        generateTrips(trx, ctx(A.id), {
          scheduleId: schedule.id,
          fromDate: "2026-11-02",
          toDate: "2026-11-02",
          publish: true,
          reason: "cutoff",
        }),
      );
      const find = (now: Date) =>
        inA((trx) =>
          findAvailableTrips(trx, A.id, {
            from: "2026-11-02",
            to: "2026-11-02",
            party: 2,
            productId: a.charter,
            now,
          }),
        );
      const open = await find(new Date("2026-11-01T05:29:59.999Z"));
      expect(open.map((t) => [t.product.name, t.startsAtLocal, t.salesCloseAt])).toEqual([
        ["Private Charter", "2026-11-02T00:30:00-05:00", "2026-11-01T05:30:00.000Z"],
      ]);
      expect(open[0]?.capacity).toEqual({ kind: "whole_boat", total: 6, remaining: 6 });
      expect(await find(new Date("2026-11-01T05:30:00Z"))).toEqual([]);
    });

    it("stores the earlier and later readings of a repeated time", async () => {
      const product = await inA((trx) =>
        createProduct(trx, ctx(A.id), {
          locationId: a.location,
          kind: "shared_seat",
          name: "Night Fishing",
          durationMinutes: 60,
          maxPartySize: 4,
          eligibleBoatIds: [a.boat, a.smallBoat],
          reason: "overlap",
        }),
      );
      const trips = [];
      for (const [boatId, ambiguousTime] of [
        [a.boat, "earlier"],
        [a.smallBoat, "later"],
      ] as const) {
        const schedule = await inA((trx) =>
          createSchedule(trx, ctx(A.id), {
            productId: product,
            boatId,
            startsOn: "2027-11-07",
            endsOn: "2027-11-07",
            weekdays: [7],
            startTimes: ["01:30"],
            ambiguousTime,
            reason: "overlap",
          }),
        );
        if (schedule.kind !== "created") throw new Error(JSON.stringify(schedule));
        const generated = await inA((trx) =>
          generateTrips(trx, ctx(A.id), {
            scheduleId: schedule.id,
            fromDate: "2027-11-07",
            toDate: "2027-11-07",
            publish: true,
            reason: "overlap",
          }),
        );
        if (generated.kind !== "generated") throw new Error(JSON.stringify(generated));
        trips.push(...generated.created);
      }
      expect(trips.map((t) => [t.boatName, t.startsAt, t.startsAtLocal])).toEqual([
        ["Lark", "2027-11-07T05:30:00.000Z", "2027-11-07T01:30:00-04:00"],
        ["Wren", "2027-11-07T06:30:00.000Z", "2027-11-07T01:30:00-05:00"],
      ]);
    });
  });

  describe("one departure per boat", () => {
    it("refuses departures too close for one boat and skips overlaps with other products", async () => {
      const tooClose = await inA((trx) =>
        createSchedule(trx, ctx(A.id), {
          productId: a.product,
          boatId: a.boat,
          startsOn: "2027-05-01",
          endsOn: "2027-05-31",
          weekdays: [6],
          startTimes: ["09:00", "10:00"],
          reason: "too close",
        }),
      );
      expect(tooClose).toEqual({ kind: "invalid", problems: ["departures_too_close"] });

      const sprint = await inA((trx) =>
        createProduct(trx, ctx(A.id), {
          locationId: a.location,
          kind: "shared_seat",
          name: "Harbor Sprint",
          durationMinutes: 60,
          maxPartySize: 4,
          eligibleBoatIds: [a.boat],
          reason: "overlap",
        }),
      );
      const evening = await inA((trx) =>
        createSchedule(trx, ctx(A.id), {
          productId: sprint,
          boatId: a.boat,
          startsOn: "2026-10-31",
          endsOn: "2026-11-02",
          weekdays: [1, 6, 7],
          startTimes: ["18:30", "01:45"],
          reason: "overlap",
        }),
      );
      if (evening.kind !== "created") throw new Error(JSON.stringify(evening));
      const result = await inA((trx) =>
        generateTrips(trx, ctx(A.id), {
          scheduleId: evening.id,
          fromDate: "2026-10-31",
          toDate: "2026-11-02",
          publish: true,
          reason: "overlap",
        }),
      );
      if (result.kind !== "generated") throw new Error(JSON.stringify(result));
      // The cruise holds the boat from 18:00 to 19:30 each evening, and its 01:30
      // departures hold it until 03:00, except November 2, whose 01:30 was
      // canceled and so no longer occupies the boat. On November 1, 01:45 falls
      // in the fall-back overlap and 18:30 is under the regatta blackout; both
      // are reported before boat occupancy is considered.
      expect(result.skipped).toEqual([
        { localDate: "2026-10-31", localStartTime: "01:45", reason: "boat_conflict" },
        { localDate: "2026-10-31", localStartTime: "18:30", reason: "boat_conflict" },
        { localDate: "2026-11-01", localStartTime: "01:45", reason: "ambiguous_local_time" },
        { localDate: "2026-11-01", localStartTime: "18:30", reason: "blackout" },
        { localDate: "2026-11-02", localStartTime: "18:30", reason: "boat_conflict" },
      ]);
      expect(result.created.map((t) => `${t.localDate} ${t.localStartTime}`)).toEqual([
        "2026-11-02 01:45",
      ]);

      // The database refuses the same overlap from a writer that skips the check.
      const code = await pgCode(
        admin`insert into public.scheduled_trips (tenant_id, product_id, boat_id, time_zone,
                local_date, local_start_time, starts_at, ends_at, start_utc_offset_minutes,
                end_utc_offset_minutes, duration_minutes, seat_capacity)
              values (${A.id}, ${sprint}, ${a.boat}, 'America/New_York', '2026-10-31', '18:30',
                '2026-10-31T22:30:00Z', '2026-10-31T23:30:00Z', -240, -240, 60, 10)`,
      );
      expect(code).toBe("23P01");
    });
  });

  describe("availability filters", () => {
    const now = new Date("2026-10-15T00:00:00Z");
    const bDates = () =>
      inB((trx) =>
        findAvailableTrips(trx, B.id, { from: "2026-10-30", to: "2026-11-02", party: 1, now }),
      ).then((trips) => trips.map((t) => t.localDate));

    it("hides trips under product and boat blackouts", async () => {
      expect(await bDates()).toEqual(["2026-10-30", "2026-10-31", "2026-11-01", "2026-11-02"]);
      await inB(async (trx) => {
        await createBlackout(trx, ctx(B.id), {
          scope: { kind: "product", productId: b.product },
          startsOn: "2026-10-31",
          endsOn: "2026-10-31",
          reason: "private event",
        });
        await createBlackout(trx, ctx(B.id), {
          scope: { kind: "boat", boatId: b.boat, timeZone: "Pacific/Honolulu" },
          startsOn: "2026-11-01",
          endsOn: "2026-11-01",
          reason: "haul-out",
        });
      });
      expect(await bDates()).toEqual(["2026-10-30", "2026-11-02"]);
    });

    it("hides trips on a retired boat or at an archived location", async () => {
      await admin`update public.boats set status = 'retired' where id = ${b.boat}`;
      expect(await bDates()).toEqual([]);
      await admin`update public.boats set status = 'active' where id = ${b.boat}`;
      await admin`update public.locations set status = 'archived' where id = ${b.location}`;
      expect(await bDates()).toEqual([]);
      await admin`update public.locations set status = 'active' where id = ${b.location}`;
      expect(await bDates()).toEqual(["2026-10-30", "2026-11-02"]);
    });
  });

  describe("zone data drift", () => {
    it("skips and names departures the database reads differently, and writes the rest", async () => {
      // British Columbia's rules changed recently, so the runtime and PostgreSQL
      // may disagree about Vancouver from November 2026. Whatever the two say
      // on this machine, generation must never fail or store a guessed time.
      const probe = Date.UTC(2026, 11, 1, 20);
      const [pg] = await admin<{ offset: number }[]>`
        select (extract(epoch from timezone('America/Vancouver', ${new Date(probe).toISOString()}::timestamptz)
                - timezone('UTC', ${new Date(probe).toISOString()}::timestamptz)) / 60)::int as offset`;
      const drifting = pg?.offset !== offsetMinutesAt("America/Vancouver", probe);

      const scheduleId = await inA(async (trx) => {
        const c = ctx(A.id);
        const locationId = await createLocation(trx, c, {
          name: "West Dock",
          timeZone: "America/Vancouver",
          reason: "drift",
        });
        const boatId = await createBoat(trx, c, {
          name: "Orca",
          guestCapacity: 8,
          reason: "drift",
        });
        const productId = await createProduct(trx, c, {
          locationId,
          kind: "shared_seat",
          name: "Whale Watch",
          durationMinutes: 180,
          maxPartySize: 6,
          eligibleBoatIds: [boatId],
          reason: "drift",
        });
        const schedule = await createSchedule(trx, c, {
          productId,
          boatId,
          startsOn: "2026-10-26",
          endsOn: "2026-11-12",
          weekdays: [1, 2, 3, 4, 5, 6, 7],
          startTimes: ["09:00"],
          reason: "drift",
        });
        if (schedule.kind !== "created") throw new Error(JSON.stringify(schedule));
        return schedule.id;
      });
      const result = await inA((trx) =>
        generateTrips(trx, ctx(A.id), {
          scheduleId,
          fromDate: "2026-10-26",
          toDate: "2026-11-12",
          publish: false,
          reason: "drift",
        }),
      );
      if (result.kind !== "generated") throw new Error(JSON.stringify(result));
      expect(result.created.length + result.skipped.length).toBe(18);
      expect(result.skipped.every((s) => s.reason === "zone_data_mismatch")).toBe(true);
      expect(result.created.every((t) => t.localDate < "2026-11-01")).toBe(drifting);
      if (drifting) {
        expect(result.created.length).toBe(6);
        await expect(
          inA((trx) =>
            createBlackout(trx, ctx(A.id), {
              scope: { kind: "tenant", timeZone: "America/Vancouver" },
              startsOn: "2026-12-25",
              endsOn: "2026-12-25",
              reason: "drift",
            }),
          ),
        ).rejects.toBeInstanceOf(ZoneDataMismatchError);
      } else {
        expect(result.skipped).toEqual([]);
      }
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
