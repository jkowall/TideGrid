/**
 * G2.6 two-tenant escapes. Tenant A tries to read, count, confirm, release,
 * expire, lock, and acquire against tenant B's trips and holds through every
 * surface this goal adds: the inventory services (with A's context, and with a
 * context that names B inside A's transaction), raw SQL as tidegrid_app, the
 * usage function, the sweep, and the catalog's trip listings. The last checks
 * probe rules the inventory README says the database enforces for every role.
 */
import { randomUUID } from "node:crypto";
import { createDb, inTenantTransaction, type TenantContext } from "@tidegrid/database";
import type {} from "@tidegrid/database/global-setup";
import { findAvailableTrips, listTrips } from "@tidegrid/domain-catalog";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";
import {
  confirmHold,
  expireDueHolds,
  findHoldsByOwner,
  getHold,
  getTripCapacity,
  type Hold,
  listTripHolds,
  releaseHold,
  sweepExpiredHolds,
} from "../index.ts";
import { createTenantFixture, type TenantFixture, tripAllocator } from "../test-fixtures.ts";
import {
  acquiredHold,
  acquireFor,
  barrier,
  checkHistories,
  context,
  errorsOf,
  expireByClock,
  gate,
  holdsByIds,
  holdsOfTenants,
  inTenant,
  oversold,
  owner,
  type Runtime,
  type Sql,
  serviceRace,
  settle,
  usageOf,
  usageOfTenants,
  valuesOf,
  whenOpen,
  within,
} from "./harness.ts";

const env = inject("integrationDb");
const DAYS = 14;

class Rollback extends Error {
  constructor(readonly payload: unknown) {
    super("rolled back on purpose");
  }
}

describe.skipIf(!env)("G2.6 two-tenant escapes and database rules", () => {
  let admin: Sql;
  let rt: Sql;
  let runtime: Runtime;
  let A: TenantFixture;
  let B: TenantFixture;
  let tripsA: ReturnType<typeof tripAllocator>;
  let tripsB: ReturnType<typeof tripAllocator>;

  beforeAll(async () => {
    if (!env) return;
    admin = postgres(env.adminUrl, { max: 3, onnotice: () => {} });
    rt = postgres(env.runtimeUrl, { max: 6, onnotice: () => {} });
    runtime = createDb(env.runtimeUrl, { max: 18 });
    A = await createTenantFixture(admin, runtime.db, "esc-a", { days: DAYS });
    B = await createTenantFixture(admin, runtime.db, "esc-b", { days: DAYS });
    tripsA = tripAllocator(A);
    tripsB = tripAllocator(B);
  });

  afterAll(async () => {
    await runtime?.end();
    await rt?.end({ timeout: 5 });
    await admin?.end({ timeout: 5 });
  });

  const acquired = (tenantId: string, tripId: string, party: number, ownerRef = owner()) =>
    acquiredHold(runtime.db, tenantId, tripId, party, ownerRef);

  /** Raw SQL as tidegrid_app in one transaction; `tenantId` null sets no context at all. */
  const raw = <T>(tenantId: string | null, fn: (tx: postgres.TransactionSql) => Promise<T>) =>
    rt.begin(async (tx) => {
      if (tenantId) await tx`select set_config('app.tenant_id', ${tenantId}, true)`;
      return fn(tx);
    }) as Promise<T>;

  /** Raw SQL that always rolls back, returning what `fn` saw. */
  const rawThenRollBack = async <T>(
    tenantId: string,
    fn: (tx: postgres.TransactionSql) => Promise<T>,
  ): Promise<T> => {
    try {
      await raw(tenantId, async (tx) => {
        throw new Rollback(await fn(tx));
      });
    } catch (err) {
      if (err instanceof Rollback) return err.payload as T;
      throw err;
    }
    throw new Error("unreachable");
  };

  /** Audit and outbox rows that mention any of `ids`, by tenant. */
  async function mentions(ids: string[]) {
    const audits = await admin<{ tenant_id: string; n: number }[]>`
      select tenant_id, count(*)::int as n from public.audit_events
       where subject_id in ${admin(ids)}
          or before_state::text like any (${ids.map((id) => `%${id}%`)})
          or after_state::text like any (${ids.map((id) => `%${id}%`)})
       group by tenant_id`;
    const events = await admin<{ tenant_id: string; n: number }[]>`
      select tenant_id, count(*)::int as n from public.outbox_events
       where aggregate_id in ${admin(ids)}
          or payload::text like any (${ids.map((id) => `%${id}%`)})
       group by tenant_id`;
    const asMap = (rows: { tenant_id: string; n: number }[]) =>
      Object.fromEntries(rows.map((r) => [r.tenant_id, r.n]));
    return { audits: asMap(audits), events: asMap(events) };
  }

  // The services ------------------------------------------------------------------

  it("never lets A's services read, count, confirm, release, expire, or acquire B's holds and trips, even with B's ids and owner references", async () => {
    const shared = owner();
    const tripB = tripsB.shared();
    const holdB = await acquired(B.id, tripB, 2, shared);
    const dueB = await acquired(B.id, tripsB.shared(), 1);
    await expireByClock(admin, [dueB.id]);
    const tripA = tripsA.shared();
    // The same owner reference in A is a different owner: a new hold, not B's.
    const holdA = await acquired(A.id, tripA, 2, shared);
    expect(holdA.id).not.toBe(holdB.id);
    const before = await mentions([holdB.id, dueB.id, tripB]);

    const seen = await inTenant(runtime.db, A.id, async (trx, ctx) => ({
      confirm: await confirmHold(trx, ctx, { holdId: holdB.id, ownerRef: holdB.ownerRef }),
      release: await releaseHold(trx, ctx, { holdId: holdB.id, ownerRef: holdB.ownerRef }),
      releaseDue: await releaseHold(trx, ctx, { holdId: dueB.id, ownerRef: dueB.ownerRef }),
      getAsA: await getHold(trx, A.id, holdB.id),
      getAsB: await getHold(trx, B.id, holdB.id),
      ownerInA: await findHoldsByOwner(trx, A.id, shared),
      ownerInB: await findHoldsByOwner(trx, B.id, shared),
      listAsA: await listTripHolds(trx, A.id, tripB),
      listAsB: await listTripHolds(trx, B.id, tripB),
      capacityAsA: await getTripCapacity(trx, A.id, tripB),
      capacityAsB: await getTripCapacity(trx, B.id, tripB),
      acquire: await acquireFor(trx, ctx, tripB, 1, shared),
      expired: (await expireDueHolds(trx, ctx, { limit: 1000 })).expired
        .map((h) => h.id)
        .filter((id) => id === holdB.id || id === dueB.id),
    }));
    expect(seen).toEqual({
      confirm: { kind: "not_found" },
      release: { kind: "not_found" },
      releaseDue: { kind: "not_found" },
      getAsA: null,
      getAsB: null,
      ownerInA: [holdA],
      ownerInB: [],
      listAsA: [],
      listAsB: [],
      capacityAsA: null,
      capacityAsB: null,
      acquire: { kind: "trip_not_found" },
      expired: [],
    });
    const stored = await holdsByIds(admin, [holdB.id, dueB.id]);
    expect(Object.fromEntries(stored.map((h) => [h.id, h.state]))).toEqual({
      [holdB.id]: "active",
      [dueB.id]: "active",
    });
    // A's calls wrote nothing about B anywhere, in either tenant.
    expect(await mentions([holdB.id, dueB.id, tripB])).toEqual(before);
    expect(before.audits[A.id]).toBeUndefined();
    expect(before.events[A.id]).toBeUndefined();
    expect(
      (await inTenant(runtime.db, B.id, (trx) => findHoldsByOwner(trx, B.id, shared))).map(
        (h) => h.id,
      ),
    ).toEqual([holdB.id]);
  });

  it("finds nothing and writes nothing when a service is handed a context for the other tenant inside A's transaction", async () => {
    const tripA = tripsA.shared();
    const tripB = tripsB.shared();
    const holdA = await acquired(A.id, tripA, 2);
    const holdB = await acquired(B.id, tripB, 2);
    const dueA = await acquired(A.id, tripsA.shared(), 1);
    const dueB = await acquired(B.id, tripsB.shared(), 1);
    await expireByClock(admin, [dueA.id, dueB.id]);
    const asB: TenantContext = context(B.id);
    const before = await mentions([holdA.id, holdB.id, dueA.id, dueB.id]);

    const seen = await inTenantTransaction(runtime.db, context(A.id), async (trx) => ({
      acquireB: await acquireFor(trx, asB, tripB, 1),
      acquireA: await acquireFor(trx, asB, tripA, 1),
      confirmB: await confirmHold(trx, asB, { holdId: holdB.id, ownerRef: holdB.ownerRef }),
      confirmA: await confirmHold(trx, asB, { holdId: holdA.id, ownerRef: holdA.ownerRef }),
      releaseB: await releaseHold(trx, asB, { holdId: holdB.id, ownerRef: holdB.ownerRef }),
      releaseA: await releaseHold(trx, asB, { holdId: holdA.id, ownerRef: holdA.ownerRef }),
      expired: (await expireDueHolds(trx, asB, { limit: 1000 })).expired.length,
    }));
    expect(seen).toEqual({
      acquireB: { kind: "trip_not_found" },
      acquireA: { kind: "trip_not_found" },
      confirmB: { kind: "not_found" },
      confirmA: { kind: "not_found" },
      releaseB: { kind: "not_found" },
      releaseA: { kind: "not_found" },
      expired: 0,
    });
    const stored = await holdsByIds(admin, [holdA.id, holdB.id, dueA.id, dueB.id]);
    expect(stored.map((h) => h.state)).toEqual(["active", "active", "active", "active"]);
    expect(await mentions([holdA.id, holdB.id, dueA.id, dueB.id])).toEqual(before);
    expect(
      await admin`select 1 from public.capacity_holds where tenant_id = ${B.id} and trip_id = ${tripA}`,
    ).toHaveLength(0);
  });

  // Raw SQL as the runtime role -----------------------------------------------------

  it("lets raw SQL as tidegrid_app see, count, and change only its own tenant's holds", async () => {
    const tripB = tripsB.shared();
    await acquired(B.id, tripB, 8);
    await acquired(B.id, tripB, 2);
    const dueB = await acquired(B.id, tripsB.shared(), 1);
    const tripA = tripsA.shared();
    const holdA = await acquired(A.id, tripA, 3);
    const dueA = await acquired(A.id, tripsA.shared(), 1);
    await expireByClock(admin, [dueA.id, dueB.id]);

    const seen = await rawThenRollBack(A.id, async (tx) => {
      const tenants = await tx<{ tenant_id: string }[]>`
        select distinct tenant_id from public.capacity_holds`;
      const named = await tx<{ n: number }[]>`
        select count(*)::int as n from public.capacity_holds where tenant_id = ${B.id}`;
      const usageB = await tx<{ held: number; confirmed: number }[]>`
        select held, confirmed from app.trip_capacity_usage(${B.id}, ${tripB})`;
      const usageMixed = await tx<{ held: number; confirmed: number }[]>`
        select held, confirmed from app.trip_capacity_usage(${A.id}, ${tripB})`;
      const usageA = await tx<{ held: number; confirmed: number }[]>`
        select held, confirmed from app.trip_capacity_usage(${A.id}, ${tripA})`;
      const releasedB = await tx`
        update public.capacity_holds set state = 'released' where trip_id = ${tripB}`;
      const expiredEverywhere = await tx<{ tenant_id: string }[]>`
        update public.capacity_holds set state = 'expired'
         where state = 'active' and expires_at <= now() returning tenant_id`;
      const auditB = await tx<{ n: number }[]>`
        select count(*)::int as n from public.audit_events where subject_id = ${dueB.id}`;
      const eventsB = await tx<{ n: number }[]>`
        select count(*)::int as n from public.outbox_events where aggregate_id = ${dueB.id}`;
      return {
        tenants: tenants.map((t) => t.tenant_id),
        named: named[0]?.n,
        usageB: usageB[0],
        usageMixed: usageMixed[0],
        usageA: usageA[0],
        releasedB: releasedB.count,
        expiredTenants: [...new Set(expiredEverywhere.map((r) => r.tenant_id))],
        auditB: auditB[0]?.n,
        eventsB: eventsB[0]?.n,
      };
    });
    expect(seen).toEqual({
      tenants: [A.id],
      named: 0,
      usageB: { held: 0, confirmed: 0 },
      usageMixed: { held: 0, confirmed: 0 },
      usageA: { held: 3, confirmed: 0 },
      releasedB: 0,
      expiredTenants: [A.id],
      auditB: 0,
      eventsB: 0,
    });
    // Writes that name B fail, whichever tenant column they carry.
    const insert = (tenantId: string, tripId: string) =>
      settle(
        raw(
          A.id,
          (tx) => tx`
            insert into public.capacity_holds (tenant_id, trip_id, owner_ref, party_size, expires_at)
            values (${tenantId}, ${tripId}, ${owner()}, 1, now() + interval '10 minutes')`,
        ),
      );
    const intoB = await insert(B.id, tripB);
    const pointAtB = await insert(A.id, tripB);
    expect([intoB.ok, pointAtB.ok]).toEqual([false, false]);
    if (!intoB.ok) expect(["23503", "42501"]).toContain(intoB.code);
    if (!pointAtB.ok)
      expect([pointAtB.code, pointAtB.constraint]).toEqual(["23503", "capacity_holds_trip"]);
    expect((await usageOf(admin, tripB)).counted).toBe(10);
    expect((await holdsByIds(admin, [holdA.id, dueB.id])).map((h) => h.state)).toEqual([
      "active",
      "active",
    ]);
  });

  it("never lets A see, wait on, or lock B's trip while B holds its lock", async () => {
    const tripB = tripsB.charter();
    const go = gate();
    const holding = gate();
    const ctxB = context(B.id);
    const bTakes = settle(
      inTenantTransaction(runtime.db, ctxB, async (trx) => {
        const r = await acquireFor(trx, ctxB, tripB, 2);
        holding.open();
        await go.opened;
        return r;
      }),
    );
    await within(holding.opened, 30_000, "B's acquisition");
    // B really holds its trip's lock: the owner role cannot take it without waiting.
    const ownerTry = await settle(
      admin.begin(
        (tx) =>
          tx`select id from public.scheduled_trips where id = ${tripB} for no key update nowait`,
      ),
    );
    expect(ownerTry).toMatchObject({ ok: false, code: "55P03" });
    const started = Date.now();
    const locked = await settle(
      raw(A.id, async (tx) => {
        await tx`set local lock_timeout = '3s'`;
        return tx`select id from public.scheduled_trips where id = ${tripB} for no key update`;
      }),
    );
    const viaService = await settle(
      within(
        inTenant(runtime.db, A.id, (trx, ctx) => acquireFor(trx, ctx, tripB, 2)),
        10_000,
        "A's acquire on B's trip",
      ),
    );
    const viaInsert = await settle(
      within(
        raw(
          A.id,
          (tx) => tx`
            insert into public.capacity_holds (tenant_id, trip_id, owner_ref, party_size, expires_at)
            values (${A.id}, ${tripB}, ${owner()}, 2, now() + interval '10 minutes')`,
        ),
        10_000,
        "A's raw insert on B's trip",
      ),
    );
    const elapsed = Date.now() - started;
    go.open();
    expect(await bTakes).toMatchObject({ ok: true, value: { kind: "acquired" } });
    expect(locked).toMatchObject({ ok: true });
    if (locked.ok) expect(locked.value).toHaveLength(0);
    expect(viaService).toEqual({ ok: true, value: { kind: "trip_not_found" } });
    expect(viaInsert).toMatchObject({
      ok: false,
      code: "23503",
      constraint: "capacity_holds_trip",
    });
    // None of the three waited behind B's lock (each would have needed seconds).
    expect(elapsed).toBeLessThan(8_000);
  });

  it("gives a session with no tenant context no holds to see, count, or write", async () => {
    const tripA = tripsA.shared();
    await acquired(A.id, tripA, 4);
    const seen = await raw(null, async (tx) => ({
      holds: (await tx<{ n: number }[]>`select count(*)::int as n from public.capacity_holds`)[0]
        ?.n,
      usage: (
        await tx<{ held: number; confirmed: number }[]>`
          select held, confirmed from app.trip_capacity_usage(${A.id}, ${tripA})`
      )[0],
      moved: (
        await tx`update public.capacity_holds set state = 'released' where trip_id = ${tripA}`
      ).count,
    }));
    expect(seen).toEqual({ holds: 0, usage: { held: 0, confirmed: 0 }, moved: 0 });
    const write = await settle(
      raw(
        null,
        (tx) => tx`
          insert into public.capacity_holds (tenant_id, trip_id, owner_ref, party_size, expires_at)
          values (${A.id}, ${tripA}, ${owner()}, 1, now() + interval '10 minutes')`,
      ),
    );
    expect(write.ok).toBe(false);
    expect((await usageOf(admin, tripA)).counted).toBe(4);
  });

  // The sweep ----------------------------------------------------------------------

  it("keeps every expiry in the hold's own tenant while sweeps and both tenants' acquisitions race", async () => {
    const due: Hold[] = [];
    const tripsUsed: { tenantId: string; tripId: string }[] = [];
    for (const [tenant, alloc] of [
      [A, tripsA],
      [B, tripsB],
    ] as const) {
      for (let k = 0; k < 2; k++) {
        const tripId = alloc.shared();
        tripsUsed.push({ tenantId: tenant.id, tripId });
        for (let j = 0; j < 5; j++) due.push(await acquired(tenant.id, tripId, 2));
      }
    }
    await expireByClock(
      admin,
      due.map((h) => h.id),
    );
    const perTrip = 3;
    const start = barrier(tripsUsed.length * perTrip);
    const sweeps = whenOpen(start, () =>
      Promise.all(
        [1, 2, 3].map(() =>
          settle(sweepExpiredHolds(runtime.db, { runId: `esc-${randomUUID()}`, batchSize: 3 })),
        ),
      ),
    );
    const acquirers = await Promise.all(
      tripsUsed.map(({ tenantId, tripId }) =>
        serviceRace(runtime.db, tenantId, perTrip, start, (trx, ctx) =>
          acquireFor(trx, ctx, tripId, 2),
        ),
      ),
    );
    const reports = await sweeps;
    expect(acquirers.flatMap((o) => errorsOf(o))).toEqual([]);
    expect(errorsOf(reports)).toEqual([]);
    expect(valuesOf(reports).map((r) => r.failedTenants)).toEqual([0, 0, 0]);
    const fresh = acquirers.flatMap((o) =>
      valuesOf(o).flatMap((r) => (r.kind === "acquired" ? [r.hold.id] : [])),
    );
    expect(fresh).toHaveLength(tripsUsed.length * perTrip);
    const history = await checkHistories(admin, [...due.map((h) => h.id), ...fresh]);
    expect(history.problems).toEqual([]);
    for (const h of due) {
      expect(history.actions.get(h.id)).toEqual(["hold.acquired", "hold.expired"]);
    }
  });

  // The trip listings ------------------------------------------------------------

  it("never shows or counts another tenant's trips or holds in either listing", async () => {
    // The last fixture day is the same date in both tenants and no other test uses it.
    const pick = (f: TenantFixture, key: "shared" | "charter") => {
      const id = f.trips[key][DAYS - 1];
      if (!id) throw new Error("no trip");
      return id;
    };
    const sharedA = pick(A, "shared");
    const charterA = pick(A, "charter");
    const sharedB = pick(B, "shared");
    const charterB = pick(B, "charter");
    const [day] = await admin<{ a: string; b: string }[]>`
      select (select local_date::text from public.scheduled_trips where id = ${sharedA}) as a,
             (select local_date::text from public.scheduled_trips where id = ${sharedB}) as b`;
    expect(day?.a).toBe(day?.b);
    const date = day?.a ?? "";
    await acquired(B.id, sharedB, 8);
    await acquired(B.id, sharedB, 2);
    await acquired(B.id, charterB, 2);
    await acquired(A.id, sharedA, 3);
    const bTrips = new Set([...B.trips.shared, ...B.trips.charter, ...B.trips.late]);

    const views = await inTenant(runtime.db, A.id, async (trx) => ({
      guestA: await findAvailableTrips(trx, A.id, {
        from: date,
        to: date,
        party: 2,
        now: new Date(),
      }),
      guestB: await findAvailableTrips(trx, B.id, {
        from: date,
        to: date,
        party: 2,
        now: new Date(),
      }),
      staffA: await listTrips(trx, A.id, { from: date, to: date }),
      staffB: await listTrips(trx, B.id, { from: date, to: date }),
    }));
    expect(views.guestB).toEqual([]);
    expect(views.staffB).toEqual([]);
    expect([...views.guestA, ...views.staffA].filter((t) => bTrips.has(t.tripId))).toEqual([]);
    // Party 2 fits every A product on that day; only A's own hold reduces A's seats.
    expect(
      Object.fromEntries(views.guestA.map((t) => [t.tripId, t.capacity.remaining])),
    ).toMatchObject({ [sharedA]: 7, [charterA]: 6 });
    const aTrips = new Set([...A.trips.shared, ...A.trips.charter, ...A.trips.late]);
    expect(views.guestA.every((t) => aTrips.has(t.tripId))).toBe(true);
    expect(views.staffA.every((t) => aTrips.has(t.tripId))).toBe(true);
    expect(views.staffA).toHaveLength(3);
    const staff = Object.fromEntries(views.staffA.map((t) => [t.tripId, t.capacity]));
    expect(staff[sharedA]).toMatchObject({ held: 3, confirmed: 0, remaining: 7, soldOut: false });
    expect(staff[charterA]).toMatchObject({ held: 0, confirmed: 0, remaining: 6, soldOut: false });

    // B's own views see B's sold-out trips, so the holds above are real.
    const bViews = await inTenant(runtime.db, B.id, async (trx) => ({
      guest: await findAvailableTrips(trx, B.id, {
        from: date,
        to: date,
        party: 2,
        now: new Date(),
      }),
      staff: await listTrips(trx, B.id, { from: date, to: date }),
    }));
    expect(bViews.guest.map((t) => t.tripId)).not.toContain(sharedB);
    expect(bViews.guest.map((t) => t.tripId)).not.toContain(charterB);
    expect(
      Object.fromEntries(bViews.staff.map((t) => [t.tripId, t.capacity.soldOut])),
    ).toMatchObject({
      [sharedB]: true,
      [charterB]: true,
    });
  });

  // Database rules the README claims for every role ----------------------------------

  it("lets no runtime write fake a hold's kind or seats", async () => {
    const charter = tripsA.charter();
    const shared = tripsA.shared();
    const insert = (tripId: string, kind: string, seats: number, party: number) =>
      settle(
        raw(
          A.id,
          (tx) => tx`
            insert into public.capacity_holds
              (tenant_id, trip_id, owner_ref, party_size, kind, seats, expires_at)
            values (${A.id}, ${tripId}, ${owner()}, ${party}, ${kind}, ${seats},
                    now() + interval '10 minutes')`,
        ),
      );
    const outcomes = [
      await insert(charter, "seats", 2, 2),
      await insert(charter, "whole_boat", 2, 2),
      await insert(shared, "seats", 1, 3),
    ];
    expect(outcomes.map((o) => (o.ok ? "accepted" : `${o.code} ${o.constraint}`))).toEqual([
      "23514 capacity_holds_kind",
      "23514 capacity_holds_kind",
      "23514 capacity_holds_kind",
    ]);
    expect((await usageOf(admin, charter)).counted).toBe(0);
    expect((await usageOf(admin, shared)).counted).toBe(0);
  });

  it("keeps trip capacity out of the runtime's reach entirely", async () => {
    const trip = tripsA.shared();
    const outcome = await settle(
      raw(A.id, (tx) => tx`update public.scheduled_trips set seat_capacity = 1 where id = ${trip}`),
    );
    expect(outcome).toMatchObject({ ok: false, code: "42501" });
  });

  it("refuses to shrink a trip below the seats its holds take, even for the owner role", async () => {
    const trip = tripsA.shared();
    await acquired(A.id, trip, 8);
    // Invariant 1 in the inventory README: for every trip, the seats of its active
    // and confirmed holds never exceed the trip's seat capacity, for every role.
    let accepted: { capacity: number; counted: number } | undefined;
    const outcome = await settle(
      admin.begin(async (tx) => {
        await tx`update public.scheduled_trips set seat_capacity = 4 where id = ${trip}`;
        const [after] = await tx<{ capacity: number; counted: number }[]>`
          select t.seat_capacity as capacity,
                 (select coalesce(sum(seats), 0)::int from public.capacity_holds h
                   where h.trip_id = t.id and h.state in ('active', 'confirmed')) as counted
            from public.scheduled_trips t where t.id = ${trip}`;
        accepted = after;
        // Always undo, so a missing guard leaves nothing behind for other tests.
        throw new Rollback(after);
      }),
    );
    expect(oversold(await usageOfTenants(admin, [A.id]))).toEqual([]);
    expect({ accepted, refusedWith: outcome.ok ? null : outcome.code }).toEqual({
      accepted: undefined,
      refusedWith: "23514",
    });
  });

  it("leaves both tenants within capacity and every hold's trail in its own tenant", async () => {
    expect(oversold(await usageOfTenants(admin, [A.id, B.id]))).toEqual([]);
    const holds = await holdsOfTenants(admin, [A.id, B.id]);
    const service = holds.filter((h) => h.owner_ref.startsWith("checkout_session:"));
    const history = await checkHistories(
      admin,
      service.map((h) => h.id),
    );
    // Raw inserts in this file wrote no audit rows; only service holds have trails.
    const trailed = history.problems.filter((p) => !p.includes("first audit undefined"));
    expect(trailed).toEqual([]);
  });
});
