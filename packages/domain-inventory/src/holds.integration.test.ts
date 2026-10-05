import { randomUUID } from "node:crypto";
import {
  createDb,
  inTenantTransaction,
  type TenantContext,
  type TenantTransaction,
} from "@tidegrid/database";
import type {} from "@tidegrid/database/global-setup";
import {
  changeTripSalesState,
  createBlackout,
  createBoat,
  createProduct,
  createSchedule,
  findAvailableTrips,
  generateTrips,
  listTrips,
  publishProduct,
} from "@tidegrid/domain-catalog";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";
import {
  acquireHold,
  confirmHold,
  expireDueHolds,
  findHoldsByOwner,
  getHold,
  getTripCapacity,
  type Hold,
  listTripHolds,
  releaseHold,
  sweepExpiredHolds,
} from "./index.ts";
import {
  backdateHold,
  createTenantFixture,
  systemContext,
  type TenantFixture,
  tripAllocator,
} from "./test-fixtures.ts";

type Sql = ReturnType<typeof postgres>;

const env = inject("integrationDb");

/** SQLSTATE and constraint name of a rejected promise. */
async function failure(p: Promise<unknown>): Promise<{ code?: string; constraint?: string }> {
  try {
    await p;
  } catch (err) {
    const e = err as { code?: string; constraint_name?: string };
    return {
      ...(e.code ? { code: e.code } : {}),
      ...(e.constraint_name ? { constraint: e.constraint_name } : {}),
    };
  }
  throw new Error("expected a database error");
}

const owner = () => `checkout_session:${randomUUID()}`;

describe.skipIf(!env)("capacity holds against a real database as the runtime role", () => {
  let admin: Sql;
  let rt: Sql;
  let runtime: ReturnType<typeof createDb>;
  let A: TenantFixture;
  let B: TenantFixture;
  let tripsA: ReturnType<typeof tripAllocator>;
  let tripsB: ReturnType<typeof tripAllocator>;

  /** One service call in one runtime transaction for `tenantId`. */
  const as = <T>(
    tenantId: string,
    fn: (trx: TenantTransaction, ctx: TenantContext) => Promise<T>,
  ): Promise<T> => {
    const ctx = systemContext(tenantId);
    return inTenantTransaction(runtime.db, ctx, (trx) => fn(trx, ctx));
  };
  const acquire = (
    tenantId: string,
    tripId: string,
    partySize: number,
    ownerRef = owner(),
    ttlSeconds = 600,
  ) =>
    as(tenantId, (trx, ctx) => acquireHold(trx, ctx, { ownerRef, tripId, partySize, ttlSeconds }));
  const acquired = async (
    tenantId: string,
    tripId: string,
    partySize: number,
    ownerRef = owner(),
  ) => {
    const result = await acquire(tenantId, tripId, partySize, ownerRef);
    if (result.kind !== "acquired") throw new Error(`expected acquired, got ${result.kind}`);
    return result.hold;
  };
  const confirm = (tenantId: string, hold: Pick<Hold, "id" | "ownerRef">) =>
    as(tenantId, (trx, ctx) => confirmHold(trx, ctx, { holdId: hold.id, ownerRef: hold.ownerRef }));
  const release = (tenantId: string, hold: Pick<Hold, "id" | "ownerRef">, reason?: string) =>
    as(tenantId, (trx, ctx) =>
      releaseHold(trx, ctx, { holdId: hold.id, ownerRef: hold.ownerRef, reason: reason ?? null }),
    );
  const holdState = async (tenantId: string, holdId: string) =>
    (await as(tenantId, (trx) => getHold(trx, tenantId, holdId)))?.state;
  const capacity = (tenantId: string, tripId: string) =>
    as(tenantId, (trx) => getTripCapacity(trx, tenantId, tripId));
  const dbNow = async () => {
    const [row] = await admin<{ now: Date }[]>`select now() as now`;
    if (!row) throw new Error("no clock");
    return row.now.getTime();
  };
  /** Raw SQL as the runtime role, inside one transaction bound to `tenantId`. */
  const raw = <T>(
    tenantId: string,
    fn: (tx: postgres.TransactionSql) => Promise<T>,
    mode = "",
  ): Promise<T> =>
    rt.begin(mode, async (tx) => {
      await tx`select set_config('app.tenant_id', ${tenantId}, true)`;
      return fn(tx);
    }) as Promise<T>;
  const auditFor = (holdId: string) => admin<{ action: string; actor_id: string | null }[]>`
    select action, actor_id from public.audit_events
     where subject_type = 'capacity_hold' and subject_id = ${holdId} order by id`;
  const eventsFor = (holdId: string) => admin<
    { topic: string; payload: Record<string, unknown> }[]
  >`
    select topic, payload from public.outbox_events
     where aggregate_type = 'capacity_hold' and aggregate_id = ${holdId} order by id`;

  beforeAll(async () => {
    if (!env) return;
    admin = postgres(env.adminUrl, { max: 2, onnotice: () => {} });
    rt = postgres(env.runtimeUrl, { max: 2, onnotice: () => {} });
    runtime = createDb(env.runtimeUrl, { max: 4 });
    A = await createTenantFixture(admin, runtime.db, "inv-a");
    B = await createTenantFixture(admin, runtime.db, "inv-b");
    tripsA = tripAllocator(A);
    tripsB = tripAllocator(B);
  });

  afterAll(async () => {
    await runtime?.end();
    await rt?.end({ timeout: 5 });
    await admin?.end({ timeout: 5 });
  });

  describe("acquire", () => {
    it("takes seats on a shared trip, once per owner and trip", async () => {
      const trip = tripsA.shared();
      const ownerRef = owner();
      const before = await dbNow();
      const first = await acquire(A.id, trip, 3, ownerRef, 600);
      const after = await dbNow();
      if (first.kind !== "acquired") throw new Error(first.kind);
      expect(first.hold).toMatchObject({
        tripId: trip,
        ownerRef,
        kind: "seats",
        partySize: 3,
        seats: 3,
        state: "active",
        confirmedAt: null,
        releasedAt: null,
        expiredAt: null,
      });
      const expires = Date.parse(first.hold.expiresAt);
      expect(expires).toBeGreaterThanOrEqual(before + 600_000);
      expect(expires).toBeLessThanOrEqual(after + 600_000);

      expect(await acquire(A.id, trip, 3, ownerRef)).toEqual({
        kind: "existing",
        hold: first.hold,
      });
      expect(await acquire(A.id, trip, 4, ownerRef)).toEqual({
        kind: "owner_conflict",
        hold: first.hold,
      });
      expect(await as(A.id, (trx) => findHoldsByOwner(trx, A.id, ownerRef))).toEqual([first.hold]);

      expect(await auditFor(first.hold.id)).toEqual([
        { action: "hold.acquired", actor_id: "inventory-test" },
      ]);
      expect(await eventsFor(first.hold.id)).toEqual([
        {
          topic: "inventory.hold.acquired",
          payload: { holdId: first.hold.id, tripId: trip, ownerRef },
        },
      ]);
    });

    it("fills a shared trip exactly and refuses the next seat", async () => {
      const trip = tripsA.shared();
      await acquired(A.id, trip, 4);
      await acquired(A.id, trip, 4);
      expect(await acquire(A.id, trip, 3)).toEqual({ kind: "insufficient_capacity", remaining: 2 });
      await acquired(A.id, trip, 2);
      expect(await acquire(A.id, trip, 1)).toEqual({ kind: "insufficient_capacity", remaining: 0 });
      expect(await capacity(A.id, trip)).toEqual({
        tripId: trip,
        kind: "seats",
        total: 10,
        held: 10,
        confirmed: 0,
        remaining: 0,
        soldOut: true,
      });
    });

    it("takes the whole boat on a charter, for any party size", async () => {
      const trip = tripsA.charter();
      const hold = await acquired(A.id, trip, 2);
      expect(hold).toMatchObject({ kind: "whole_boat", partySize: 2, seats: 6 });
      expect(await acquire(A.id, trip, 2)).toEqual({ kind: "insufficient_capacity", remaining: 0 });
      expect(await capacity(A.id, trip)).toMatchObject({ held: 6, remaining: 0, soldOut: true });
    });

    it("does not let a hold past its time block a new one, even before the sweep", async () => {
      const charter = tripsA.charter();
      const stale = await acquired(A.id, charter, 4);
      await backdateHold(admin, stale.id);
      // Reads stop counting it at once; acquisition writes the expiry down first.
      expect(await capacity(A.id, charter)).toMatchObject({ held: 0, remaining: 6 });
      const fresh = await acquired(A.id, charter, 3);
      expect(await holdState(A.id, stale.id)).toBe("expired");
      expect(await auditFor(stale.id)).toEqual([
        { action: "hold.acquired", actor_id: "inventory-test" },
        { action: "hold.expired", actor_id: "hold-expiry" },
      ]);
      expect((await eventsFor(stale.id)).map((e) => e.topic)).toEqual([
        "inventory.hold.acquired",
        "inventory.hold.expired",
      ]);
      expect(await holdState(A.id, fresh.id)).toBe("active");

      const shared = tripsA.shared();
      const big = await acquired(A.id, shared, 8);
      await acquired(A.id, shared, 2);
      await backdateHold(admin, big.id);
      await acquired(A.id, shared, 8);
      expect(await capacity(A.id, shared)).toMatchObject({ held: 10, remaining: 0 });
    });

    it("refuses trips that are not on sale, with a reason", async () => {
      const closed = tripsA.shared();
      const canceled = tripsA.shared();
      const blackedOut = tripsA.shared();
      await as(A.id, async (trx, ctx) => {
        const now = new Date();
        await changeTripSalesState(trx, ctx, { tripId: closed, to: "closed", reason: "test", now });
        await changeTripSalesState(trx, ctx, {
          tripId: canceled,
          to: "canceled",
          reason: "test",
          now,
        });
      });
      const [row] = await admin<{ local_date: string }[]>`
        select local_date::text from public.scheduled_trips where id = ${blackedOut}`;
      await as(A.id, (trx, ctx) =>
        createBlackout(trx, ctx, {
          scope: { kind: "boat", boatId: A.boats.lark, timeZone: "UTC" },
          startsOn: row?.local_date ?? "",
          endsOn: row?.local_date ?? "",
          reason: "engine service",
        }),
      );
      const reason = async (tripId: string, party: number) => {
        const result = await acquire(A.id, tripId, party);
        return result.kind === "not_bookable" ? result.reason : result.kind;
      };
      expect(await reason(closed, 2)).toBe("trip_unavailable");
      expect(await reason(canceled, 2)).toBe("trip_canceled");
      expect(await reason(blackedOut, 2)).toBe("trip_unavailable");
      expect(await reason(tripsA.late(), 2)).toBe("sales_closed");
      expect(await reason(tripsA.shared(), 9)).toBe("party_size_out_of_range");
      expect(await reason(tripsA.charter(), 1)).toBe("party_size_out_of_range");
      expect(await reason(tripsA.charter(), 7)).toBe("party_size_out_of_range");
      expect(await acquire(A.id, randomUUID(), 2)).toEqual({ kind: "trip_not_found" });
      expect(await acquire(A.id, "not-a-uuid", 2)).toEqual({ kind: "trip_not_found" });
    });

    it("rejects malformed owners, sizes, and lifetimes before touching the database", async () => {
      const trip = tripsA.shared();
      const call = (input: { ownerRef?: string; partySize?: number; ttlSeconds?: number }) =>
        as(A.id, (trx, ctx) =>
          acquireHold(trx, ctx, {
            ownerRef: input.ownerRef ?? owner(),
            tripId: trip,
            partySize: input.partySize ?? 1,
            ttlSeconds: input.ttlSeconds ?? 600,
          }),
        );
      await expect(call({ ownerRef: "no-type" })).rejects.toThrow(TypeError);
      await expect(call({ ownerRef: "Checkout:1" })).rejects.toThrow(TypeError);
      await expect(call({ partySize: 1.5 })).rejects.toThrow(TypeError);
      await expect(call({ ttlSeconds: 59 })).rejects.toThrow(RangeError);
      await expect(call({ ttlSeconds: 3601 })).rejects.toThrow(RangeError);
      expect(await as(A.id, (trx) => listTripHolds(trx, A.id, trip))).toEqual([]);
    });

    it("never lets a hold outlive its trip's departure", async () => {
      // A one-off departure 40 minutes from now on its own boat, with no cutoff.
      const [clock] = await admin<{ day: string; at: string }[]>`
        select to_char(now() at time zone 'UTC' + interval '40 minutes', 'YYYY-MM-DD') as day,
               to_char(now() at time zone 'UTC' + interval '40 minutes', 'HH24:MI') as at`;
      if (!clock) throw new Error("no clock");
      const tripId = await as(A.id, async (trx, ctx) => {
        const boat = await createBoat(trx, ctx, {
          name: "Skiff",
          guestCapacity: 4,
          reason: "test",
        });
        const product = await createProduct(trx, ctx, {
          locationId: A.location,
          kind: "shared_seat",
          name: "Last Minute",
          durationMinutes: 30,
          maxPartySize: 4,
          eligibleBoatIds: [boat],
          reason: "test",
        });
        await publishProduct(trx, ctx, { productId: product, reason: "test" });
        const schedule = await createSchedule(trx, ctx, {
          productId: product,
          boatId: boat,
          startsOn: clock.day,
          endsOn: clock.day,
          weekdays: [1, 2, 3, 4, 5, 6, 7],
          startTimes: [clock.at],
          reason: "test",
        });
        if (schedule.kind !== "created") throw new Error("schedule rejected");
        const generated = await generateTrips(trx, ctx, {
          scheduleId: schedule.id,
          fromDate: clock.day,
          toDate: clock.day,
          publish: true,
          reason: "test",
        });
        if (generated.kind !== "generated" || !generated.created[0]) throw new Error("no trip");
        return generated.created[0];
      });
      const result = await acquire(A.id, tripId.tripId, 2, owner(), 3600);
      if (result.kind !== "acquired") throw new Error(result.kind);
      expect(result.hold.expiresAt).toBe(tripId.startsAt);
    });
  });

  describe("confirm", () => {
    it("confirms a hold within its time, once", async () => {
      const trip = tripsA.shared();
      const hold = await acquired(A.id, trip, 3);
      const first = await confirm(A.id, hold);
      if (first.kind !== "confirmed") throw new Error(first.kind);
      expect(first.reacquired).toBe(false);
      expect(first.hold).toMatchObject({ id: hold.id, state: "confirmed", expiredAt: null });
      expect(first.hold.confirmedAt).not.toBeNull();
      expect(await confirm(A.id, hold)).toEqual({ kind: "already_confirmed", hold: first.hold });
      expect(await capacity(A.id, trip)).toMatchObject({ held: 0, confirmed: 3, remaining: 7 });
      expect((await auditFor(hold.id)).map((a) => a.action)).toEqual([
        "hold.acquired",
        "hold.confirmed",
      ]);
      expect((await eventsFor(hold.id)).map((e) => e.topic)).toEqual([
        "inventory.hold.acquired",
        "inventory.hold.confirmed",
      ]);
    });

    it("reacquires a hold past its time when the trip still has room, swept or not", async () => {
      const trip = tripsA.shared();
      const unswept = await acquired(A.id, trip, 2);
      await backdateHold(admin, unswept.id);
      const late = await confirm(A.id, unswept);
      if (late.kind !== "confirmed") throw new Error(late.kind);
      expect(late.reacquired).toBe(true);
      expect(late.hold.state).toBe("confirmed");
      expect(late.hold.expiredAt).not.toBeNull();
      expect((await auditFor(unswept.id)).map((a) => a.action)).toEqual([
        "hold.acquired",
        "hold.expired",
        "hold.confirmed",
      ]);
      const [reacquiredAudit] = await admin<{ after_state: Record<string, unknown> }[]>`
        select after_state from public.audit_events
         where subject_id = ${unswept.id} and action = 'hold.confirmed'`;
      expect(reacquiredAudit?.after_state).toEqual({ state: "confirmed", reacquired: true });

      const swept = await acquired(A.id, trip, 2);
      await backdateHold(admin, swept.id);
      const sweep = await as(A.id, (trx, ctx) => expireDueHolds(trx, ctx, { limit: 50 }));
      expect(sweep.expired.map((h) => h.id)).toContain(swept.id);
      const after = await confirm(A.id, swept);
      expect(after.kind === "confirmed" && after.reacquired).toBe(true);
      expect(await capacity(A.id, trip)).toMatchObject({ confirmed: 4, remaining: 6 });
    });

    it("reports lost capacity when another owner took the boat", async () => {
      const trip = tripsA.charter();
      const first = await acquired(A.id, trip, 4);
      await backdateHold(admin, first.id);
      const second = await acquired(A.id, trip, 2);
      const result = await confirm(A.id, first);
      expect(result).toMatchObject({ kind: "capacity_lost", reason: "no_capacity" });
      expect(result.kind === "capacity_lost" && result.hold.state).toBe("expired");
      expect(await holdState(A.id, second.id)).toBe("active");
      expect((await auditFor(first.id)).map((a) => a.action)).toEqual([
        "hold.acquired",
        "hold.expired",
      ]);
    });

    it("reports lost capacity when the trip was canceled or sales closed", async () => {
      const canceledTrip = tripsA.shared();
      const live = await acquired(A.id, canceledTrip, 2);
      await as(A.id, (trx, ctx) =>
        changeTripSalesState(trx, ctx, {
          tripId: canceledTrip,
          to: "canceled",
          reason: "weather",
          now: new Date(),
        }),
      );
      expect(await confirm(A.id, live)).toMatchObject({
        kind: "capacity_lost",
        reason: "trip_canceled",
        hold: { state: "active" },
      });

      const closedTrip = tripsA.shared();
      const stale = await acquired(A.id, closedTrip, 2);
      await backdateHold(admin, stale.id);
      await as(A.id, (trx, ctx) =>
        changeTripSalesState(trx, ctx, {
          tripId: closedTrip,
          to: "closed",
          reason: "full",
          now: new Date(),
        }),
      );
      expect(await confirm(A.id, stale)).toMatchObject({
        kind: "capacity_lost",
        reason: "trip_unavailable",
        hold: { state: "expired" },
      });
      // A hold still within its time on a closed trip confirms: the checkout began first.
      const reopened = tripsA.shared();
      const inFlight = await acquired(A.id, reopened, 2);
      await as(A.id, (trx, ctx) =>
        changeTripSalesState(trx, ctx, {
          tripId: reopened,
          to: "closed",
          reason: "full",
          now: new Date(),
        }),
      );
      expect(await confirm(A.id, inFlight)).toMatchObject({ kind: "confirmed", reacquired: false });
    });

    it("refuses other owners, malformed ids, and released holds", async () => {
      const hold = await acquired(A.id, tripsA.shared(), 1);
      expect(await confirm(A.id, { id: hold.id, ownerRef: owner() })).toEqual({
        kind: "not_found",
      });
      expect(await confirm(A.id, { id: "nope", ownerRef: hold.ownerRef })).toEqual({
        kind: "not_found",
      });
      expect(await confirm(A.id, { id: hold.id, ownerRef: "bad" })).toEqual({ kind: "not_found" });
      await release(A.id, hold);
      expect(await confirm(A.id, hold)).toMatchObject({
        kind: "released",
        hold: { state: "released" },
      });
    });
  });

  describe("release", () => {
    it("releases active and confirmed holds once, and gives the seats back", async () => {
      const trip = tripsA.shared();
      const active = await acquired(A.id, trip, 4);
      const booked = await acquired(A.id, trip, 6);
      expect(await confirm(A.id, booked)).toMatchObject({ kind: "confirmed" });
      expect(await capacity(A.id, trip)).toMatchObject({ remaining: 0, soldOut: true });

      const first = await release(A.id, active, "checkout abandoned");
      expect(first).toMatchObject({
        kind: "released",
        from: "active",
        hold: { state: "released" },
      });
      expect(await release(A.id, active)).toMatchObject({ kind: "unchanged" });
      expect(await release(A.id, booked, "booking canceled")).toMatchObject({
        kind: "released",
        from: "confirmed",
      });
      expect(await capacity(A.id, trip)).toMatchObject({ held: 0, confirmed: 0, remaining: 10 });
      const [audit] = await admin<{ reason: string | null; before_state: unknown }[]>`
        select reason, before_state from public.audit_events
         where subject_id = ${booked.id} and action = 'hold.released'`;
      expect(audit).toEqual({ reason: "booking canceled", before_state: { state: "confirmed" } });
      expect((await eventsFor(active.id)).map((e) => e.topic)).toEqual([
        "inventory.hold.acquired",
        "inventory.hold.released",
      ]);
    });

    it("leaves expired holds alone and refuses other owners", async () => {
      const hold = await acquired(A.id, tripsA.shared(), 1);
      expect(await release(A.id, { id: hold.id, ownerRef: owner() })).toEqual({
        kind: "not_found",
      });
      await backdateHold(admin, hold.id);
      await as(A.id, (trx, ctx) => expireDueHolds(trx, ctx, { limit: 50 }));
      expect(await release(A.id, hold)).toMatchObject({
        kind: "unchanged",
        hold: { state: "expired" },
      });
      await expect(
        as(A.id, (trx, ctx) =>
          releaseHold(trx, ctx, { holdId: hold.id, ownerRef: hold.ownerRef, reason: "" }),
        ),
      ).rejects.toThrow(RangeError);
    });
  });

  describe("expiry and the sweep", () => {
    it("expires only due holds, once each", async () => {
      const trip = tripsA.shared();
      const due = await acquired(A.id, trip, 1);
      const fresh = await acquired(A.id, trip, 1);
      await backdateHold(admin, due.id);
      const first = await as(A.id, (trx, ctx) => expireDueHolds(trx, ctx, { limit: 1000 }));
      expect(first.expired.map((h) => h.id)).toContain(due.id);
      expect(first.expired.map((h) => h.id)).not.toContain(fresh.id);
      const second = await as(A.id, (trx, ctx) => expireDueHolds(trx, ctx, { limit: 1000 }));
      expect(second.expired.map((h) => h.id)).not.toContain(due.id);
      expect(await auditFor(due.id)).toEqual([
        { action: "hold.acquired", actor_id: "inventory-test" },
        { action: "hold.expired", actor_id: "hold-sweep" },
      ]);
      expect(await holdState(A.id, fresh.id)).toBe("active");
      await expect(as(A.id, (trx, ctx) => expireDueHolds(trx, ctx, { limit: 0 }))).rejects.toThrow(
        RangeError,
      );
    });

    it("sweeps every tenant in its own transaction, idempotently", async () => {
      const inA = await acquired(A.id, tripsA.shared(), 1);
      const inB = await acquired(B.id, tripsB.shared(), 1);
      await backdateHold(admin, inA.id);
      await backdateHold(admin, inB.id);
      const report = await sweepExpiredHolds(runtime.db, { runId: `sweep-${randomUUID()}` });
      expect(report.failedTenants).toBe(0);
      expect(report.expired).toBeGreaterThanOrEqual(2);
      expect(await holdState(A.id, inA.id)).toBe("expired");
      expect(await holdState(B.id, inB.id)).toBe("expired");
      const [rows] = await admin<{ n: number }[]>`
        select count(*)::int as n from public.audit_events
         where action = 'hold.expired' and subject_id in (${inA.id}, ${inB.id})`;
      expect(rows?.n).toBe(2);
      const again = await sweepExpiredHolds(runtime.db, { runId: `sweep-${randomUUID()}` });
      expect(again.failedTenants).toBe(0);
      const [still] = await admin<{ n: number }[]>`
        select count(*)::int as n from public.audit_events
         where action = 'hold.expired' and subject_id in (${inA.id}, ${inB.id})`;
      expect(still?.n).toBe(2);
      // Each tenant's expiry events stay in that tenant.
      const tenantsOf = await admin<{ tenant_id: string; aggregate_id: string }[]>`
        select tenant_id, aggregate_id from public.outbox_events
         where topic = 'inventory.hold.expired' and aggregate_id in (${inA.id}, ${inB.id})
         order by aggregate_id`;
      expect(Object.fromEntries(tenantsOf.map((r) => [r.aggregate_id, r.tenant_id]))).toEqual({
        [inA.id]: A.id,
        [inB.id]: B.id,
      });
    });

    it("lists only tenants with due holds, by id only", async () => {
      const hold = await acquired(B.id, tripsB.shared(), 1);
      await backdateHold(admin, hold.id);
      const listed = await rt<{ tenant_id: string }[]>`
        select * from app.capacity_hold_sweep_tenants(1000)`;
      expect(listed.map((r) => r.tenant_id)).toContain(B.id);
      expect(Object.keys(listed[0] ?? {})).toEqual(["tenant_id"]);
      await sweepExpiredHolds(runtime.db, { runId: `sweep-${randomUUID()}` });
      const after = await rt<{ tenant_id: string }[]>`
        select * from app.capacity_hold_sweep_tenants(1000)`;
      expect(after.map((r) => r.tenant_id)).not.toContain(B.id);
    });
  });

  describe("database rules for the runtime role", () => {
    const insert = (
      tx: postgres.TransactionSql,
      tenantId: string,
      tripId: string,
      fields: { state?: string; kind?: string; party?: number; expires?: string } = {},
    ) => tx`
      insert into public.capacity_holds (tenant_id, trip_id, owner_ref, party_size, expires_at,
                                         state, kind)
      values (${tenantId}, ${tripId}, ${owner()}, ${fields.party ?? 1},
              now() + ${fields.expires ?? "10 minutes"}::interval,
              ${fields.state ?? "active"}, ${fields.kind ?? null})`;

    it("refuses holds that skip a rule, whoever writes them", async () => {
      const trip = tripsA.shared();
      expect(
        await failure(raw(A.id, (tx) => insert(tx, A.id, trip, { state: "confirmed" }))),
      ).toEqual({ code: "23514", constraint: "capacity_holds_transition" });
      expect(
        await failure(raw(A.id, (tx) => insert(tx, A.id, trip, { kind: "whole_boat" }))),
      ).toEqual({ code: "23514", constraint: "capacity_holds_kind" });
      expect(
        await failure(raw(A.id, (tx) => insert(tx, A.id, trip, { expires: "2 hours" }))),
      ).toEqual({ code: "23514", constraint: "capacity_holds_expiry" });
      expect(
        await failure(raw(A.id, (tx) => insert(tx, A.id, trip, { expires: "-1 minute" }))),
      ).toEqual({ code: "23514", constraint: "capacity_holds_expiry" });
      expect(await failure(raw(A.id, (tx) => insert(tx, A.id, trip, { party: 9 })))).toEqual({
        code: "23514",
        constraint: "capacity_holds_eligibility",
      });
      expect(await failure(raw(A.id, (tx) => insert(tx, A.id, tripsA.late())))).toEqual({
        code: "23514",
        constraint: "capacity_holds_eligibility",
      });
      // Straight past the service: the trigger still counts.
      await raw(A.id, (tx) => insert(tx, A.id, trip, { party: 8 }));
      expect(await failure(raw(A.id, (tx) => insert(tx, A.id, trip, { party: 3 })))).toEqual({
        code: "23514",
        constraint: "capacity_holds_capacity",
      });
      expect(
        await failure(raw(A.id, (tx) => insert(tx, A.id, trip), "isolation level repeatable read")),
      ).toEqual({ code: "25000" });
      expect(
        await failure(raw(A.id, (tx) => insert(tx, A.id, trip), "isolation level serializable")),
      ).toEqual({ code: "25000" });
    });

    it("lets the runtime change state only, one way, and never delete", async () => {
      const hold = await acquired(A.id, tripsA.shared(), 2);
      expect(
        await failure(
          raw(
            A.id,
            (tx) => tx`update public.capacity_holds set party_size = 1 where id = ${hold.id}`,
          ),
        ),
      ).toEqual({ code: "42501" });
      expect(
        await failure(
          raw(
            A.id,
            (tx) =>
              tx`update public.capacity_holds set expires_at = now() + interval '50 minutes'
                  where id = ${hold.id}`,
          ),
        ),
      ).toEqual({ code: "42501" });
      expect(
        await failure(
          raw(
            A.id,
            (tx) => tx`update public.capacity_holds set state = 'expired' where id = ${hold.id}`,
          ),
        ),
      ).toEqual({ code: "23514", constraint: "capacity_holds_expiry" });
      expect(
        await failure(
          raw(A.id, (tx) => tx`delete from public.capacity_holds where id = ${hold.id}`),
        ),
      ).toEqual({ code: "42501" });
      await release(A.id, hold);
      for (const to of ["active", "confirmed", "expired"]) {
        expect(
          await failure(
            raw(
              A.id,
              (tx) => tx`update public.capacity_holds set state = ${to} where id = ${hold.id}`,
            ),
          ),
        ).toEqual({ code: "23514", constraint: "capacity_holds_transition" });
      }
    });

    it("keeps every tenant's holds in that tenant", async () => {
      const tripB = tripsB.shared();
      expect(await failure(raw(A.id, (tx) => insert(tx, A.id, tripB)))).toEqual({
        code: "23503",
        constraint: "capacity_holds_trip",
      });
      // The trigger looks the trip up under the caller's row-level security first.
      expect(await failure(raw(A.id, (tx) => insert(tx, B.id, tripB)))).toEqual({
        code: "23503",
        constraint: "capacity_holds_trip",
      });
      const holdB = await acquired(B.id, tripB, 2);
      const seen = await raw(
        A.id,
        (tx) => tx`select count(*)::int as n from public.capacity_holds where id = ${holdB.id}`,
      );
      expect(seen[0]?.n).toBe(0);
      const usage = await raw(
        A.id,
        (tx) => tx`select held, confirmed from app.trip_capacity_usage(${B.id}, ${tripB})`,
      );
      expect(usage).toEqual([{ held: 0, confirmed: 0 }]);
      const moved = await raw(
        A.id,
        (tx) => tx`update public.capacity_holds set state = 'released' where id = ${holdB.id}`,
      );
      expect(moved.count).toBe(0);
      expect(await holdState(B.id, holdB.id)).toBe("active");
    });
  });

  describe("database rules for the owner role", () => {
    it("applies the same capacity and immutability rules, and forbids removal", async () => {
      const trip = tripsA.charter();
      const hold = await acquired(A.id, trip, 2);
      expect(
        await failure(admin`
          insert into public.capacity_holds (tenant_id, trip_id, owner_ref, party_size, expires_at)
          values (${A.id}, ${trip}, ${owner()}, 2, now() + interval '10 minutes')`),
      ).toEqual({ code: "23514", constraint: "capacity_holds_capacity" });
      expect(
        await failure(admin`update public.capacity_holds set seats = 1 where id = ${hold.id}`),
      ).toEqual({ code: "23514", constraint: "capacity_holds_immutable" });
      expect(
        await failure(
          admin`update public.capacity_holds set trip_id = ${tripsA.charter()} where id = ${hold.id}`,
        ),
      ).toEqual({ code: "23514", constraint: "capacity_holds_immutable" });
      expect(await failure(admin`delete from public.capacity_holds where id = ${hold.id}`)).toEqual(
        {
          code: "55000",
        },
      );
      expect(await failure(admin`truncate public.capacity_holds`)).toEqual({ code: "55000" });
    });

    it("backs the whole-boat rule with a unique index that needs no trigger", async () => {
      const trip = tripsA.charter();
      const insert = (q: postgres.TransactionSql) => q`
        insert into public.capacity_holds
          (tenant_id, trip_id, owner_ref, kind, party_size, seats, expires_at)
        values (${A.id}, ${trip}, ${owner()}, 'whole_boat', 2, 6, now() + interval '10 minutes')`;
      // The trigger is switched off inside a transaction that always rolls back,
      // so even a regression here cannot leave it off or leave rows behind.
      const rollback = new Error("always roll back");
      let second: unknown = "not attempted";
      await expect(
        admin.begin(async (tx) => {
          await tx`alter table public.capacity_holds disable trigger capacity_holds_rules`;
          await insert(tx);
          try {
            await tx.savepoint((sp) => insert(sp));
            second = "inserted";
          } catch (err) {
            const e = err as { code?: string; constraint_name?: string };
            second = { code: e.code, constraint: e.constraint_name };
          }
          throw rollback;
        }),
      ).rejects.toBe(rollback);
      expect(second).toEqual({ code: "23505", constraint: "capacity_holds_one_whole_boat" });
      const [rules] = await admin<{ enabled: string }[]>`
        select tgenabled as enabled from pg_trigger
         where tgname = 'capacity_holds_rules' and tgrelid = 'public.capacity_holds'::regclass`;
      expect(rules?.enabled).toBe("O");
    });
  });

  describe("availability", () => {
    async function dateOf(tripId: string) {
      const [row] = await admin<{ local_date: string }[]>`
        select local_date::text from public.scheduled_trips where id = ${tripId}`;
      if (!row) throw new Error("no trip");
      return row.local_date;
    }
    const listed = async (tenantId: string, tripId: string, party: number) => {
      const date = await dateOf(tripId);
      const trips = await as(tenantId, (trx) =>
        findAvailableTrips(trx, tenantId, { from: date, to: date, party, now: new Date() }),
      );
      return trips.find((t) => t.tripId === tripId);
    };
    const staff = async (tenantId: string, tripId: string) => {
      const date = await dateOf(tripId);
      const trips = await as(tenantId, (trx) => listTrips(trx, tenantId, { from: date, to: date }));
      return trips.find((t) => t.tripId === tripId);
    };

    it("subtracts held and confirmed seats and hides a trip without room", async () => {
      const trip = tripsA.shared();
      const held = await acquired(A.id, trip, 3);
      const booked = await acquired(A.id, trip, 5);
      await confirm(A.id, booked);
      expect((await listed(A.id, trip, 2))?.capacity).toEqual({
        kind: "seats",
        total: 10,
        remaining: 2,
        soldOut: false,
      });
      expect(await listed(A.id, trip, 3)).toBeUndefined();
      expect((await staff(A.id, trip))?.capacity).toEqual({
        kind: "seats",
        total: 10,
        remaining: 2,
        soldOut: false,
        held: 3,
        confirmed: 5,
      });
      await backdateHold(admin, held.id);
      expect((await listed(A.id, trip, 5))?.capacity.remaining).toBe(5);
      expect((await staff(A.id, trip))?.capacity).toMatchObject({ held: 0, confirmed: 5 });
    });

    it("shows a held charter as sold out to staff and hides it from guests", async () => {
      const trip = tripsA.charter();
      expect((await listed(A.id, trip, 2))?.capacity).toEqual({
        kind: "whole_boat",
        total: 6,
        remaining: 6,
        soldOut: false,
      });
      const hold = await acquired(A.id, trip, 2);
      expect(await listed(A.id, trip, 2)).toBeUndefined();
      expect((await staff(A.id, trip))?.capacity).toEqual({
        kind: "whole_boat",
        total: 6,
        remaining: 0,
        soldOut: true,
        held: 6,
        confirmed: 0,
      });
      await release(A.id, hold);
      expect((await listed(A.id, trip, 6))?.capacity.remaining).toBe(6);
    });

    it("never counts another tenant's holds", async () => {
      const tripB = tripsB.charter();
      await acquired(B.id, tripB, 2);
      const fromA = await as(A.id, (trx) => getTripCapacity(trx, A.id, tripB));
      expect(fromA).toBeNull();
      const fromB = await as(B.id, (trx) => getTripCapacity(trx, B.id, tripB));
      expect(fromB).toMatchObject({ held: 6, soldOut: true });
    });
  });

  describe("two tenants", () => {
    it("never confirms, releases, reads, or acquires across tenants", async () => {
      const holdB = await acquired(B.id, tripsB.shared(), 2);
      expect(await confirm(A.id, holdB)).toEqual({ kind: "not_found" });
      expect(await release(A.id, holdB)).toEqual({ kind: "not_found" });
      expect(await as(A.id, (trx) => getHold(trx, A.id, holdB.id))).toBeNull();
      expect(await as(A.id, (trx) => getHold(trx, B.id, holdB.id))).toBeNull();
      expect(await as(A.id, (trx) => listTripHolds(trx, B.id, holdB.tripId))).toEqual([]);
      expect(await as(A.id, (trx) => findHoldsByOwner(trx, B.id, holdB.ownerRef))).toEqual([]);
      expect(await acquire(A.id, holdB.tripId, 1)).toEqual({ kind: "trip_not_found" });
      await backdateHold(admin, holdB.id);
      const sweptByA = await as(A.id, (trx, ctx) => expireDueHolds(trx, ctx, { limit: 1000 }));
      expect(sweptByA.expired.map((h) => h.id)).not.toContain(holdB.id);
      expect(await holdState(B.id, holdB.id)).toBe("active");
    });
  });
});
