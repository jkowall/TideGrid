/**
 * G2.6 adversarial partial failures and retries. A caller that fails after a
 * hold command must leave nothing behind: no hold, no transition, no audit
 * row, no outbox event, and no lazy expiry. A retry with the same owner
 * reference must then behave as the first attempt. A checkout aborted by a
 * deadlock (two checkouts taking two trips in opposite order, which the
 * contract warns about) must likewise vanish and succeed once on retry.
 */
import { randomUUID } from "node:crypto";
import {
  createDb,
  inTenantTransaction,
  type TenantContext,
  type TenantTransaction,
} from "@tidegrid/database";
import type {} from "@tidegrid/database/global-setup";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";
import {
  type AcquireHoldResult,
  acquireHold,
  confirmHold,
  expireDueHolds,
  type Hold,
  releaseHold,
  sweepExpiredHolds,
} from "../index.ts";
import {
  acquiredHold,
  acquireFor,
  checkHistories,
  context,
  expireByClock,
  gate,
  holdsByIds,
  holdsOnTrip,
  inTenant,
  oversold,
  owner,
  type Runtime,
  type Sql,
  settle,
  tripSource,
  usageOf,
  usageOfTenants,
  within,
} from "./harness.ts";

const env = inject("integrationDb");

class CallerFailed extends Error {
  constructor(readonly payload: unknown) {
    super("the caller failed after the hold command");
  }
}

describe.skipIf(!env)("G2.6 adversarial partial failures and retries", () => {
  let admin: Sql;
  let runtime: Runtime;
  let trips: ReturnType<typeof tripSource>;

  beforeAll(async () => {
    if (!env) return;
    admin = postgres(env.adminUrl, { max: 3, onnotice: () => {} });
    runtime = createDb(env.runtimeUrl, { max: 6 });
    trips = tripSource(admin, runtime.db, "retry", 20);
  });

  afterAll(async () => {
    await runtime?.end();
    await admin?.end({ timeout: 5 });
  });

  const acquired = (tenantId: string, tripId: string, party: number, ownerRef = owner()) =>
    acquiredHold(runtime.db, tenantId, tripId, party, ownerRef);

  const written = async (requestId: string) => {
    const [audits] = await admin<{ n: number }[]>`
      select count(*)::int as n from public.audit_events where request_id = ${requestId}`;
    const [events] = await admin<{ n: number }[]>`
      select count(*)::int as n from public.outbox_events where request_id = ${requestId}`;
    return { audits: audits?.n, events: events?.n };
  };

  it("leaves nothing behind when the caller fails after an acquire, and the retry acquires once", async () => {
    const { tenantId, tripId } = await trips.charter();
    const stale = await acquired(tenantId, tripId, 2);
    await expireByClock(admin, [stale.id]);
    const ownerRef = owner();
    const ctx = context(tenantId);
    let first: AcquireHoldResult | undefined;
    const failed = await settle(
      inTenantTransaction(runtime.db, ctx, async (trx) => {
        first = await acquireHold(trx, ctx, { ownerRef, tripId, partySize: 3, ttlSeconds: 600 });
        throw new CallerFailed(first);
      }),
    );
    expect(failed).toMatchObject({
      ok: false,
      message: "the caller failed after the hold command",
    });
    // Inside the failed transaction the hold was taken and the stale one expired...
    expect(first?.kind).toBe("acquired");
    // ...and none of it survived: no hold, no lazy expiry, no audit, no event.
    const firstId = first?.kind === "acquired" ? first.hold.id : "";
    expect(await holdsByIds(admin, [firstId])).toEqual([]);
    expect((await holdsByIds(admin, [stale.id]))[0]?.state).toBe("active");
    expect(await written(ctx.requestId ?? "")).toEqual({ audits: 0, events: 0 });
    expect(await usageOf(admin, tripId)).toMatchObject({ counted: 6, live: 0 });

    const retry = await inTenant(runtime.db, tenantId, (trx, c) =>
      acquireFor(trx, c, tripId, 3, ownerRef),
    );
    expect(retry.kind).toBe("acquired");
    if (retry.kind !== "acquired") return;
    expect(retry.hold.id).not.toBe(firstId);
    const history = await checkHistories(admin, [stale.id, retry.hold.id]);
    expect(history.problems).toEqual([]);
    expect(history.actions.get(stale.id)).toEqual(["hold.acquired", "hold.expired"]);
    expect(history.actions.get(retry.hold.id)).toEqual(["hold.acquired"]);
    expect(await usageOf(admin, tripId)).toMatchObject({ counted: 6, live: 6, countedHolds: 1 });
  });

  it("leaves holds as they were when the caller fails after a confirm, a late confirm, a release, or an expiry, and the retries settle once", async () => {
    const { tenantId, tripId } = await trips.shared();
    const live = await acquired(tenantId, tripId, 2);
    const late = await acquired(tenantId, tripId, 2);
    const leaving = await acquired(tenantId, tripId, 2);
    const due = await acquired(tenantId, tripId, 2);
    await expireByClock(admin, [late.id, due.id]);

    const attempts = [
      (trx: TenantTransaction, ctx: TenantContext) =>
        confirmHold(trx, ctx, { holdId: live.id, ownerRef: live.ownerRef }),
      (trx: TenantTransaction, ctx: TenantContext) =>
        confirmHold(trx, ctx, { holdId: late.id, ownerRef: late.ownerRef }),
      (trx: TenantTransaction, ctx: TenantContext) =>
        releaseHold(trx, ctx, { holdId: leaving.id, ownerRef: leaving.ownerRef }),
      (trx: TenantTransaction, ctx: TenantContext) => expireDueHolds(trx, ctx, { limit: 1000 }),
    ];
    const seenInside: unknown[] = [];
    for (const attempt of attempts) {
      const ctx = context(tenantId);
      const failed = await settle(
        inTenantTransaction(runtime.db, ctx, async (trx) => {
          const r = await attempt(trx, ctx);
          seenInside.push(r);
          throw new CallerFailed(r);
        }),
      );
      expect(failed.ok).toBe(false);
      expect(await written(ctx.requestId ?? "")).toEqual({ audits: 0, events: 0 });
    }
    expect(seenInside[0]).toMatchObject({ kind: "confirmed", reacquired: false });
    expect(seenInside[1]).toMatchObject({ kind: "confirmed", reacquired: true });
    expect(seenInside[2]).toMatchObject({ kind: "released", from: "active" });
    expect((seenInside[3] as { expired: Hold[] }).expired.map((h) => h.id).sort()).toEqual(
      expect.arrayContaining([due.id]),
    );
    const states = async () =>
      Object.fromEntries(
        (await holdsByIds(admin, [live.id, late.id, leaving.id, due.id])).map((h) => [
          h.id,
          h.state,
        ]),
      );
    expect(await states()).toEqual({
      [live.id]: "active",
      [late.id]: "active",
      [leaving.id]: "active",
      [due.id]: "active",
    });

    // The retries each settle once.
    expect(
      await inTenant(runtime.db, tenantId, (trx, ctx) =>
        confirmHold(trx, ctx, { holdId: live.id, ownerRef: live.ownerRef }),
      ),
    ).toMatchObject({ kind: "confirmed", reacquired: false });
    expect(
      await inTenant(runtime.db, tenantId, (trx, ctx) =>
        confirmHold(trx, ctx, { holdId: late.id, ownerRef: late.ownerRef }),
      ),
    ).toMatchObject({ kind: "confirmed", reacquired: true });
    expect(
      await inTenant(runtime.db, tenantId, (trx, ctx) =>
        releaseHold(trx, ctx, { holdId: leaving.id, ownerRef: leaving.ownerRef }),
      ),
    ).toMatchObject({ kind: "released", from: "active" });
    const report = await sweepExpiredHolds(runtime.db, { runId: `retry-${randomUUID()}` });
    expect(report.failedTenants).toBe(0);
    expect(await states()).toEqual({
      [live.id]: "confirmed",
      [late.id]: "confirmed",
      [leaving.id]: "released",
      [due.id]: "expired",
    });
    const history = await checkHistories(admin, [live.id, late.id, leaving.id, due.id]);
    expect(history.problems).toEqual([]);
    expect(history.actions.get(late.id)).toEqual([
      "hold.acquired",
      "hold.expired",
      "hold.confirmed",
    ]);
    expect(history.actions.get(due.id)).toEqual(["hold.acquired", "hold.expired"]);
  });

  it("aborts one of two checkouts that take two trips in opposite order, leaves nothing of it, and its retry in trip order succeeds once", async () => {
    const t1 = await trips.shared();
    const t2 = await trips.shared();
    if (t1.tenantId !== t2.tenantId) throw new Error("fixture tenants differ");
    const tenantId = t1.tenantId;
    const owners = { x: owner(), y: owner() };
    const firstTaken = { x: gate(), y: gate() };
    const ctxs = { x: context(tenantId), y: context(tenantId) };
    const checkout = (who: "x" | "y", first: string, second: string) =>
      settle(
        inTenantTransaction(runtime.db, ctxs[who], async (trx) => {
          const ctx = ctxs[who];
          const ownerRef = owners[who];
          const a = await acquireHold(trx, ctx, {
            ownerRef,
            tripId: first,
            partySize: 2,
            ttlSeconds: 600,
          });
          firstTaken[who].open();
          // Each waits until the other holds its first trip, then reaches for it.
          await within(firstTaken[who === "x" ? "y" : "x"].opened, 30_000, "the other checkout");
          const b = await acquireHold(trx, ctx, {
            ownerRef,
            tripId: second,
            partySize: 2,
            ttlSeconds: 600,
          });
          return [a.kind, b.kind];
        }),
      );
    const [x, y] = await Promise.all([
      checkout("x", t1.tripId, t2.tripId),
      checkout("y", t2.tripId, t1.tripId),
    ]);
    const outcomes = { x, y };
    const aborted = (["x", "y"] as const).filter((who) => !outcomes[who].ok);
    expect(aborted).toHaveLength(1);
    const loser = aborted[0] ?? "x";
    const winner = loser === "x" ? "y" : "x";
    expect(outcomes[loser]).toMatchObject({ ok: false, code: "40P01" });
    expect(outcomes[winner]).toEqual({ ok: true, value: ["acquired", "acquired"] });
    expect(await written(ctxs[loser].requestId ?? "")).toEqual({ audits: 0, events: 0 });
    const ownedBy = async (ownerRef: string) =>
      (
        await admin<{ trip_id: string }[]>`
        select trip_id from public.capacity_holds where owner_ref = ${ownerRef} order by trip_id`
      ).map((r) => r.trip_id);
    expect(await ownedBy(owners[loser])).toEqual([]);

    // The retry takes the trips in a stable order, as the contract asks.
    const ordered = [t1.tripId, t2.tripId].sort();
    const retry = await inTenant(runtime.db, tenantId, async (trx, ctx) => {
      const kinds: string[] = [];
      for (const tripId of ordered) {
        kinds.push((await acquireFor(trx, ctx, tripId, 2, owners[loser])).kind);
      }
      return kinds;
    });
    expect(retry).toEqual(["acquired", "acquired"]);
    expect(await ownedBy(owners[loser])).toEqual(ordered);
    expect(await ownedBy(owners[winner])).toEqual(ordered);
    for (const trip of [t1, t2]) {
      const holds = await holdsOnTrip(admin, trip.tripId);
      expect(holds).toHaveLength(2);
      expect(
        (
          await checkHistories(
            admin,
            holds.map((h) => h.id),
          )
        ).problems,
      ).toEqual([]);
      expect(await usageOf(admin, trip.tripId)).toMatchObject({ counted: 4, countedHolds: 2 });
    }
  });

  it("leaves no trip of any tenant this file built over capacity", async () => {
    const usage = await usageOfTenants(admin, trips.tenantIds());
    expect(usage.length).toBeGreaterThan(0);
    expect(oversold(usage)).toEqual([]);
  });
});
