import { randomUUID } from "node:crypto";
import { createDb, inTenantTransaction, type TenantTransaction } from "@tidegrid/database";
import type {} from "@tidegrid/database/global-setup";
import { findAvailableTrips, listTrips } from "@tidegrid/domain-catalog";
import { CompiledQuery } from "kysely";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";
import {
  acquireHold,
  confirmHold,
  getTripCapacity,
  type Hold,
  listTripHolds,
  listTripHoldsPage,
  releaseHold,
} from "./index.ts";
import {
  backdateHold,
  createTenantFixture,
  systemContext,
  type TenantFixture,
  tripAllocator,
} from "./test-fixtures.ts";

// W1-INV-PRICING: the G2.6 review notes. Trip listings read every listed
// trip's seats taken in one grouped call (migration 0016), and the staff holds
// read pages with a stable cursor. As the runtime role, on the throwaway
// database only.

type Sql = ReturnType<typeof postgres>;

const env = inject("integrationDb");

const owner = () => `checkout_session:${randomUUID()}`;

interface PlanNode {
  "Node Type": string;
  "Function Name"?: string;
  "Actual Loops"?: number;
  Plans?: PlanNode[];
}

function walk(node: PlanNode, out: PlanNode[] = []): PlanNode[] {
  out.push(node);
  for (const child of node.Plans ?? []) walk(child, out);
  return out;
}

describe.skipIf(!env)("trip usage and the holds page (W1-INV-PRICING)", () => {
  let admin: Sql;
  let runtime: ReturnType<typeof createDb>;
  let A: TenantFixture;
  let B: TenantFixture;
  let tripsA: ReturnType<typeof tripAllocator>;
  let tripsB: ReturnType<typeof tripAllocator>;

  const as = <T>(tenantId: string, fn: (trx: TenantTransaction) => Promise<T>): Promise<T> =>
    inTenantTransaction(runtime.db, systemContext(tenantId), fn);

  const acquired = async (tenantId: string, tripId: string, partySize: number) => {
    const ctx = systemContext(tenantId);
    const result = await inTenantTransaction(runtime.db, ctx, (trx) =>
      acquireHold(trx, ctx, { ownerRef: owner(), tripId, partySize, ttlSeconds: 600 }),
    );
    if (result.kind !== "acquired") throw new Error(`expected acquired, got ${result.kind}`);
    return result.hold;
  };
  const confirm = async (tenantId: string, hold: Hold) => {
    const ctx = systemContext(tenantId);
    const result = await inTenantTransaction(runtime.db, ctx, (trx) =>
      confirmHold(trx, ctx, { holdId: hold.id, ownerRef: hold.ownerRef }),
    );
    if (result.kind !== "confirmed") throw new Error(`expected confirmed, got ${result.kind}`);
  };
  const release = async (tenantId: string, hold: Hold) => {
    const ctx = systemContext(tenantId);
    await inTenantTransaction(runtime.db, ctx, (trx) =>
      releaseHold(trx, ctx, { holdId: hold.id, ownerRef: hold.ownerRef, reason: null }),
    );
  };

  /** The first and last local dates of a tenant's fixture trips. */
  const span = async (tenantId: string) => {
    const [row] = await admin<{ from: string; to: string; trips: number }[]>`
      select min(local_date)::text as from, max(local_date)::text as to, count(*)::int as trips
        from public.scheduled_trips where tenant_id = ${tenantId}`;
    if (!row) throw new Error("no trips");
    return row;
  };

  /** Every statement one call emits, as compiled, with its parameters. */
  async function capture<T>(tenantId: string, fn: (trx: TenantTransaction) => Promise<T>) {
    const captured: { sql: string; parameters: readonly unknown[] }[] = [];
    const db = runtime.db.withPlugin({
      transformQuery: (args) => {
        const compiled = runtime.db.getExecutor().compileQuery(args.node, args.queryId);
        captured.push({ sql: compiled.sql, parameters: compiled.parameters });
        return args.node;
      },
      transformResult: async (args) => args.result,
    });
    const result = await inTenantTransaction(db, systemContext(tenantId), fn);
    // The tenant transaction's own statements (the leaked-context check and
    // the context itself) come first and are not the listing's.
    const statements = captured.filter(
      (s) => !/current_setting\('app\.tenant_id'|set_config\('app\.tenant_id'/.test(s.sql),
    );
    return { result, statements };
  }

  /** One captured statement, executed under EXPLAIN ANALYZE as the runtime in the tenant's context. */
  function analyze(
    tenantId: string,
    statement: { sql: string; parameters: readonly unknown[] },
  ): Promise<PlanNode> {
    type Row = { "QUERY PLAN": { Plan: PlanNode }[] };
    return as(tenantId, async (trx) => {
      const { rows } = await trx.executeQuery<Row>(
        CompiledQuery.raw(`explain (analyze, format json) ${statement.sql}`, [
          ...statement.parameters,
        ]),
      );
      const plan = rows[0]?.["QUERY PLAN"][0]?.Plan;
      if (!plan) throw new Error("no plan");
      return plan;
    });
  }

  /** Seats taken per trip, from the per-trip function 0006 named, now a wrapper. */
  const perTrip = async (tenantId: string, tripIds: readonly string[]) => {
    const out = new Map<string, { held: number; confirmed: number }>();
    for (const tripId of tripIds) {
      const [row] = await as(tenantId, async (trx) => {
        const { rows } = await trx.executeQuery<{ held: number; confirmed: number }>(
          CompiledQuery.raw("select held, confirmed from app.trip_capacity_usage($1, $2)", [
            tenantId,
            tripId,
          ]),
        );
        return rows;
      });
      if (!row) throw new Error("the per-trip function returned no row");
      out.set(tripId, { held: row.held, confirmed: row.confirmed });
    }
    return out;
  };

  beforeAll(async () => {
    if (!env) return;
    admin = postgres(env.adminUrl, { max: 2, onnotice: () => {} });
    runtime = createDb(env.runtimeUrl, { max: 4 });
    A = await createTenantFixture(admin, runtime.db, "usage-a");
    B = await createTenantFixture(admin, runtime.db, "usage-b");
    tripsA = tripAllocator(A);
    tripsB = tripAllocator(B);
  });

  afterAll(async () => {
    await runtime?.end();
    await admin?.end({ timeout: 5 });
  });

  describe("grouped usage", () => {
    it("reads every listed trip's seats taken in one statement and one grouped call", async () => {
      // Held, confirmed, expired, released, a whole boat, and B's hold on its own trip.
      const heldTrip = tripsA.shared();
      const confirmedTrip = tripsA.shared();
      const expiredTrip = tripsA.shared();
      const releasedTrip = tripsA.shared();
      const charterTrip = tripsA.charter();
      await acquired(A.id, heldTrip, 3);
      await acquired(A.id, heldTrip, 2);
      await confirm(A.id, await acquired(A.id, confirmedTrip, 4));
      await acquired(A.id, confirmedTrip, 1);
      await backdateHold(admin, (await acquired(A.id, expiredTrip, 5)).id, 1);
      await release(A.id, await acquired(A.id, releasedTrip, 6));
      await acquired(A.id, charterTrip, 2);
      await acquired(B.id, tripsB.shared(), 7);
      const { from, to, trips } = await span(A.id);
      expect(trips).toBeGreaterThan(80);

      const staff = await capture(A.id, (trx) => listTrips(trx, A.id, { from, to }));
      expect(staff.result).toHaveLength(trips);
      expect(staff.statements).toHaveLength(1);
      const guest = await capture(A.id, (trx) =>
        findAvailableTrips(trx, A.id, { from, to, party: 1, now: new Date() }),
      );
      expect(guest.statements).toHaveLength(1);
      for (const { sql } of [...staff.statements, ...guest.statements]) {
        expect(sql.match(/app\.trip_capacity_usage_grouped\(/g)).toHaveLength(1);
        expect(sql).not.toMatch(/app\.trip_capacity_usage\(/);
        expect(sql).not.toMatch(/lateral/i);
      }

      // Executed: one function scan, run once, however many trips are listed.
      for (const statement of [staff.statements[0], guest.statements[0]]) {
        if (!statement) throw new Error("no statement");
        const scans = walk(await analyze(A.id, statement)).filter(
          (n) => n["Node Type"] === "Function Scan",
        );
        expect(scans.map((n) => [n["Function Name"], n["Actual Loops"]])).toEqual([
          ["trip_capacity_usage_grouped", 1],
        ]);
      }

      // The numbers: each trip as the per-trip function and getTripCapacity read it.
      const byTrip = new Map(staff.result.map((t) => [t.tripId, t.capacity]));
      expect(byTrip.get(heldTrip)).toMatchObject({ held: 5, confirmed: 0, remaining: 5 });
      expect(byTrip.get(confirmedTrip)).toMatchObject({ held: 1, confirmed: 4, remaining: 5 });
      expect(byTrip.get(expiredTrip)).toMatchObject({ held: 0, confirmed: 0, remaining: 10 });
      expect(byTrip.get(releasedTrip)).toMatchObject({ held: 0, confirmed: 0, remaining: 10 });
      expect(byTrip.get(charterTrip)).toMatchObject({ held: 6, confirmed: 0, soldOut: true });
      const ids = staff.result.map((t) => t.tripId);
      const reference = await perTrip(A.id, ids);
      for (const trip of staff.result) {
        expect({
          trip: trip.tripId,
          held: trip.capacity.held,
          confirmed: trip.capacity.confirmed,
        }).toEqual({ trip: trip.tripId, ...reference.get(trip.tripId) });
      }
      for (const tripId of [heldTrip, confirmedTrip, charterTrip]) {
        const view = await as(A.id, (trx) => getTripCapacity(trx, A.id, tripId));
        expect(view).toMatchObject({ ...reference.get(tripId), tripId });
      }

      // The guest listing leaves out the charter whose boat is held, and keeps
      // the rest, each with the room left.
      const offered = new Map(guest.result.map((t) => [t.tripId, t.capacity.remaining]));
      expect(offered.has(charterTrip)).toBe(false);
      expect(offered.get(heldTrip)).toBe(5);
      expect(offered.get(expiredTrip)).toBe(10);
      const forSix = await as(A.id, (trx) =>
        findAvailableTrips(trx, A.id, { from, to, party: 6, now: new Date() }),
      );
      const sixIds = new Set(forSix.map((t) => t.tripId));
      expect(sixIds.has(heldTrip)).toBe(false);
      expect(sixIds.has(confirmedTrip)).toBe(false);
      expect(sixIds.has(releasedTrip)).toBe(true);
    });

    it("answers one row per distinct trip id, zeros included, and only for the tenant in context", async () => {
      const trip = tripsA.shared();
      await acquired(A.id, trip, 2);
      const tripB = tripsB.shared();
      await acquired(B.id, tripB, 4);
      const grouped = (tenantId: string, scope: string, ids: (string | null)[]) =>
        as(scope, async (trx) => {
          const { rows } = await trx.executeQuery<{
            trip_id: string | null;
            held: number;
            confirmed: number;
          }>(
            CompiledQuery.raw(
              "select trip_id, held, confirmed from app.trip_capacity_usage_grouped($1, $2::uuid[]) order by trip_id nulls last",
              [tenantId, ids],
            ),
          );
          return rows;
        });
      const unknown = randomUUID();
      const rows = await grouped(A.id, A.id, [trip, trip, tripB, unknown, null]);
      expect(rows).toHaveLength(4);
      expect(rows).toContainEqual({ trip_id: trip, held: 2, confirmed: 0 });
      expect(rows).toContainEqual({ trip_id: tripB, held: 0, confirmed: 0 });
      expect(rows).toContainEqual({ trip_id: unknown, held: 0, confirmed: 0 });
      expect(rows).toContainEqual({ trip_id: null, held: 0, confirmed: 0 });
      expect(await grouped(A.id, A.id, [])).toEqual([]);
      // Naming B while A's context is set reads nothing: row-level security
      // applies inside the invoker function.
      expect(await grouped(B.id, A.id, [tripB])).toEqual([
        { trip_id: tripB, held: 0, confirmed: 0 },
      ]);
      expect(await grouped(B.id, B.id, [tripB])).toEqual([
        { trip_id: tripB, held: 4, confirmed: 0 },
      ]);
    });
  });

  describe("the holds page", () => {
    it("pages a trip's holds oldest first with a stable cursor", async () => {
      const trip = tripsA.shared();
      const first = await acquired(A.id, trip, 1);
      // Three holds in one transaction share a creation time; the id breaks the tie.
      const ctx = systemContext(A.id);
      await inTenantTransaction(runtime.db, ctx, async (trx) => {
        for (let i = 0; i < 3; i++) {
          const r = await acquireHold(trx, ctx, {
            ownerRef: owner(),
            tripId: trip,
            partySize: 1,
            ttlSeconds: 600,
          });
          if (r.kind !== "acquired") throw new Error(r.kind);
        }
      });
      const last = await acquired(A.id, trip, 2);
      const all = await as(A.id, (trx) => listTripHolds(trx, A.id, trip));
      expect(all).toHaveLength(5);
      expect(all[0]?.id).toBe(first.id);
      expect(all[4]?.id).toBe(last.id);
      const tied = all.slice(1, 4);
      expect(new Set(tied.map((h) => h.createdAt)).size).toBe(1);
      expect(tied.map((h) => h.id)).toEqual(tied.map((h) => h.id).sort());

      const page = (limit: number, after?: string) =>
        as(A.id, (trx) =>
          listTripHoldsPage(trx, A.id, trip, { limit, ...(after ? { after } : {}) }),
        );
      const pages: Hold[][] = [];
      let after: string | undefined;
      for (;;) {
        const p = await page(2, after);
        if (p.kind !== "ok") throw new Error(p.kind);
        pages.push(p.holds);
        if (p.nextAfter === null) break;
        expect(p.nextAfter).toBe(p.holds.at(-1)?.id);
        after = p.nextAfter;
      }
      expect(pages.map((p) => p.length)).toEqual([2, 2, 1]);
      expect(pages.flat()).toEqual(all);
      // The same cursor gives the same page, through a tie.
      const second = await page(2, all[1]?.id);
      expect(await page(2, all[1]?.id)).toEqual(second);
      expect(second).toEqual({ kind: "ok", holds: all.slice(2, 4), nextAfter: all[3]?.id });
      expect(await page(5)).toEqual({ kind: "ok", holds: all, nextAfter: null });

      // State changes move nothing; a later hold lands at the end.
      await release(A.id, all[2] as Hold);
      await confirm(A.id, all[3] as Hold);
      const later = await acquired(A.id, trip, 1);
      const moved = await page(3, all[1]?.id);
      if (moved.kind !== "ok") throw new Error(moved.kind);
      expect(moved.holds.map((h) => h.id)).toEqual([all[2]?.id, all[3]?.id, all[4]?.id]);
      expect(moved.holds.map((h) => [h.state, h.takesCapacity])).toEqual([
        ["released", false],
        ["confirmed", true],
        ["active", true],
      ]);
      expect(moved.nextAfter).toBe(all[4]?.id);
      expect(await page(3, all[4]?.id)).toMatchObject({
        kind: "ok",
        holds: [{ id: later.id }],
        nextAfter: null,
      });

      // A cursor must name a hold on this trip of this tenant.
      const elsewhere = await acquired(A.id, tripsA.shared(), 1);
      const holdB = await acquired(B.id, tripsB.shared(), 1);
      for (const cursor of [elsewhere.id, holdB.id, randomUUID(), "nope", first.id.toUpperCase()]) {
        expect(await page(2, cursor), cursor).toEqual({ kind: "cursor_invalid" });
      }
      // B cannot page A's trip, and A's trip lists nothing for B.
      expect(
        await as(B.id, (trx) => listTripHoldsPage(trx, B.id, trip, { limit: 2, after: first.id })),
      ).toEqual({ kind: "cursor_invalid" });
      expect(await as(B.id, (trx) => listTripHoldsPage(trx, B.id, trip, { limit: 2 }))).toEqual({
        kind: "ok",
        holds: [],
        nextAfter: null,
      });
      for (const limit of [0, 201, 2.5]) {
        await expect(page(limit)).rejects.toThrow(RangeError);
      }
    });

    it("can place a hold from a transaction that began before a page was read ahead of that page's cursor", async () => {
      // Review finding R3: created_at is now(), the transaction's start. A
      // hold whose transaction began before a page was read, and committed
      // after it, sorts before that page's cursor. The listing is advisory,
      // and the first page still shows it, as the contract now says.
      const trip = tripsA.shared();
      const ctx = systemContext(A.id);
      let open!: () => void;
      const gate = new Promise<void>((resolve) => {
        open = resolve;
      });
      let begun!: () => void;
      const started = new Promise<void>((resolve) => {
        begun = resolve;
      });
      const early = inTenantTransaction(runtime.db, ctx, async (trx) => {
        // The tenant context statement has run, so now() is fixed.
        begun();
        await gate;
        const r = await acquireHold(trx, ctx, {
          ownerRef: owner(),
          tripId: trip,
          partySize: 1,
          ttlSeconds: 600,
        });
        if (r.kind !== "acquired") throw new Error(r.kind);
        return r.hold;
      });
      try {
        await started;
        // Let the database clock move past the early transaction's start.
        await as(A.id, (trx) => trx.executeQuery(CompiledQuery.raw("SELECT pg_sleep(0.05)")));
        const late = await acquired(A.id, trip, 1);
        const before = await as(A.id, (trx) => listTripHoldsPage(trx, A.id, trip, { limit: 1 }));
        if (before.kind !== "ok") throw new Error(before.kind);
        expect(before.holds.map((h) => h.id)).toEqual([late.id]);
        expect(before.nextAfter).toBeNull();
        open();
        const held = await early;
        expect(held.createdAt < late.createdAt).toBe(true);

        // The cursor from the earlier read never reaches the early hold.
        expect(
          await as(A.id, (trx) =>
            listTripHoldsPage(trx, A.id, trip, { limit: 10, after: late.id }),
          ),
        ).toEqual({ kind: "ok", holds: [], nextAfter: null });
        // Reading again from the first page shows every hold.
        const again = await as(A.id, (trx) => listTripHoldsPage(trx, A.id, trip, { limit: 10 }));
        if (again.kind !== "ok") throw new Error(again.kind);
        expect(again.holds.map((h) => h.id)).toEqual([held.id, late.id]);
      } finally {
        open();
        await early.catch(() => undefined);
      }
    });
  });
});
