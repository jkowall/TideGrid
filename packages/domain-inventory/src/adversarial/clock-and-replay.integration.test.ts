/**
 * G2.6 adversarial checks of the clock decision, idempotent replays, the
 * sweep's promise never to wait, and all-or-nothing confirmation. Interleavings
 * that matter are forced, not hoped for: a session's transaction is opened and
 * paused with gates, and a session that must queue on the trip lock is
 * confirmed blocked through pg_blocking_pids before the holder commits.
 */
import { randomUUID } from "node:crypto";
import {
  createDb,
  inTenantTransaction,
  setTenantContext,
  type TenantContext,
  type TenantTransaction,
} from "@tidegrid/database";
import type {} from "@tidegrid/database/global-setup";
import { sql } from "kysely";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";
import {
  type AcquireHoldResult,
  type ConfirmHoldResult,
  confirmHold,
  expireDueHolds,
  type Hold,
  type ReleaseHoldResult,
  releaseHold,
  type SweepReport,
  sweepExpiredHolds,
} from "../index.ts";
import { createTenantFixture } from "../test-fixtures.ts";
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
  inTenant,
  type Outcome,
  ofKind,
  oversold,
  owner,
  RACE_ROUNDS,
  RACE_SESSIONS,
  type RoundStats,
  type Runtime,
  raceTimeout,
  reportRace,
  type Sql,
  STAGGER_MS,
  serviceRace,
  settle,
  sleep,
  tripSource,
  usageOf,
  usageOfTenants,
  valuesOf,
  waitUntilBlocked,
  within,
} from "./harness.ts";

const env = inject("integrationDb");

type Level = "repeatable read" | "serializable";

/**
 * A transaction that starts now (fixing its now()), reports its backend pid and
 * clock, then waits for `go` before running `body`; it commits only after
 * `commit` opens, so it can hold its locks while the test looks on.
 */
function pausedSession<T>(
  db: Runtime["db"],
  tenantId: string,
  body: (trx: TenantTransaction, ctx: TenantContext) => Promise<T>,
  options: { level?: Level } = {},
) {
  const started = gate();
  const go = gate();
  const ran = gate();
  const commit = gate();
  const ctx = context(tenantId);
  const info = { pid: 0, now: new Date(0) };
  let value: T | undefined;
  const run = async (trx: TenantTransaction) => {
    await setTenantContext(trx, ctx);
    const { rows } = await sql<{ pid: number; now: Date }>`
      select pg_backend_pid() as pid, now() as now`.execute(trx);
    info.pid = rows[0]?.pid ?? 0;
    info.now = rows[0]?.now ?? info.now;
    started.open();
    await go.opened;
    value = await body(trx, ctx);
    ran.open();
    await commit.opened;
    return value;
  };
  const builder = db.transaction();
  const done = settle(
    options.level ? builder.setIsolationLevel(options.level).execute(run) : builder.execute(run),
  );
  // A session that fails early must not leave the test waiting on its gates.
  void done.then((o) => {
    if (!o.ok) {
      started.open();
      ran.open();
    }
  });
  return {
    ctx,
    info,
    started: () => within(started.opened, 30_000, "session start"),
    go: () => go.open(),
    ran: () => within(ran.opened, 60_000, "session body"),
    commit: () => commit.open(),
    done,
  };
}

describe.skipIf(!env)("G2.6 adversarial clock, replay, and sweep checks", () => {
  let admin: Sql;
  let runtime: Runtime;
  let sweeper: Runtime;
  let trips: ReturnType<typeof tripSource>;

  beforeAll(async () => {
    if (!env) return;
    admin = postgres(env.adminUrl, { max: 4, onnotice: () => {} });
    runtime = createDb(env.runtimeUrl, { max: RACE_SESSIONS + 2 });
    sweeper = createDb(env.runtimeUrl, { max: 8 });
    trips = tripSource(admin, runtime.db, "clock");
  });

  afterAll(async () => {
    await runtime?.end();
    await sweeper?.end();
    await admin?.end({ timeout: 5 });
  });

  const acquired = (tenantId: string, tripId: string, party: number, ownerRef = owner()) =>
    acquiredHold(runtime.db, tenantId, tripId, party, ownerRef);
  const confirm = (tenantId: string, h: Pick<Hold, "id" | "ownerRef">) =>
    inTenant(runtime.db, tenantId, (trx, ctx) =>
      confirmHold(trx, ctx, { holdId: h.id, ownerRef: h.ownerRef }),
    );
  const storedExpiry = async (holdId: string) => {
    const [row] = await holdsByIds(admin, [holdId]);
    if (!row) throw new Error("no hold");
    return row.expires_at;
  };
  /** Let the expiry instant pass now, after any session that already started. */
  const passInstantNow = async (holdId: string) => {
    await admin`update public.capacity_holds set expires_at = clock_timestamp() where id = ${holdId}`;
    await sleep(60);
  };
  const auditsOf = (holdId: string) =>
    admin<{ action: string; actor_id: string | null; request_id: string | null }[]>`
      select action, actor_id, request_id from public.audit_events
       where subject_type = 'capacity_hold' and subject_id = ${holdId} order by id`;

  // The clock -------------------------------------------------------------------------

  describe("the clock", () => {
    it("reports capacity lost when a confirm that began before the expiry instant reaches the trip lock after another owner expired the hold and took the boat", async () => {
      const { tenantId, tripId } = await trips.charter();
      const mine = await acquired(tenantId, tripId, 2);
      const confirming = pausedSession(runtime.db, tenantId, (trx, ctx) =>
        confirmHold(trx, ctx, { holdId: mine.id, ownerRef: mine.ownerRef }),
      );
      await confirming.started();
      await passInstantNow(mine.id);
      const taking = pausedSession(runtime.db, tenantId, (trx, ctx) =>
        acquireFor(trx, ctx, tripId, 3),
      );
      await taking.started();
      taking.go();
      await taking.ran();
      // The taker holds the trip lock, uncommitted. The confirm must queue behind it.
      confirming.go();
      const blockers = await waitUntilBlocked(admin, confirming.info.pid);
      expect(blockers).toContain(taking.info.pid);
      taking.commit();
      confirming.commit();
      const took = await taking.done;
      const result = await confirming.done;

      // The confirm's clock really did start before the instant.
      const expiresAt = await storedExpiry(mine.id);
      expect(confirming.info.now.getTime()).toBeLessThan(expiresAt.getTime());
      expect(taking.info.now.getTime()).toBeGreaterThan(expiresAt.getTime());

      expect(took).toMatchObject({ ok: true, value: { kind: "acquired" } });
      expect(result).toMatchObject({
        ok: true,
        value: {
          kind: "capacity_lost",
          reason: "no_capacity",
          hold: { id: mine.id, state: "expired", confirmedAt: null },
        },
      });
      expect(await auditsOf(mine.id)).toEqual([
        { action: "hold.acquired", actor_id: "adversary", request_id: expect.any(String) },
        {
          action: "hold.expired",
          actor_id: "hold-expiry",
          request_id: taking.ctx.requestId ?? null,
        },
      ]);
      expect(await usageOf(admin, tripId)).toMatchObject({
        counted: 6,
        countedHolds: 1,
        wholeBoats: 1,
      });
    });

    it("reacquires when a confirm that began before the instant finds the hold expired by a later clock but the seats still there", async () => {
      const { tenantId, tripId } = await trips.shared();
      const mine = await acquired(tenantId, tripId, 2);
      const confirming = pausedSession(runtime.db, tenantId, (trx, ctx) =>
        confirmHold(trx, ctx, { holdId: mine.id, ownerRef: mine.ownerRef }),
      );
      await confirming.started();
      await passInstantNow(mine.id);
      const taking = pausedSession(runtime.db, tenantId, (trx, ctx) =>
        acquireFor(trx, ctx, tripId, 3),
      );
      await taking.started();
      taking.go();
      await taking.ran();
      confirming.go();
      expect(await waitUntilBlocked(admin, confirming.info.pid)).toContain(taking.info.pid);
      taking.commit();
      confirming.commit();
      expect(await taking.done).toMatchObject({ ok: true, value: { kind: "acquired" } });
      expect(await confirming.done).toMatchObject({
        ok: true,
        value: { kind: "confirmed", reacquired: true, hold: { id: mine.id, state: "confirmed" } },
      });
      const history = await checkHistories(admin, [mine.id]);
      expect(history.problems).toEqual([]);
      expect(history.actions.get(mine.id)).toEqual([
        "hold.acquired",
        "hold.expired",
        "hold.confirmed",
      ]);
      expect(await usageOf(admin, tripId)).toMatchObject({ counted: 5, countedHolds: 2 });
    });

    it("confirms by the confirm's own clock, and a later clock queued behind it cannot expire the confirmed hold or take the boat", async () => {
      const { tenantId, tripId } = await trips.charter();
      const mine = await acquired(tenantId, tripId, 2);
      const confirming = pausedSession(runtime.db, tenantId, (trx, ctx) =>
        confirmHold(trx, ctx, { holdId: mine.id, ownerRef: mine.ownerRef }),
      );
      await confirming.started();
      await passInstantNow(mine.id);
      confirming.go();
      await confirming.ran();
      // The confirm holds the trip lock, uncommitted; a later clock queues behind it.
      const taking = pausedSession(runtime.db, tenantId, (trx, ctx) =>
        acquireFor(trx, ctx, tripId, 2),
      );
      await taking.started();
      taking.go();
      expect(await waitUntilBlocked(admin, taking.info.pid)).toContain(confirming.info.pid);
      confirming.commit();
      taking.commit();
      const result = await confirming.done;
      const took = await taking.done;
      expect(confirming.info.now.getTime()).toBeLessThan((await storedExpiry(mine.id)).getTime());
      expect(result).toMatchObject({
        ok: true,
        value: { kind: "confirmed", reacquired: false, hold: { state: "confirmed" } },
      });
      expect(took).toEqual({ ok: true, value: { kind: "insufficient_capacity", remaining: 0 } });
      const history = await checkHistories(admin, [mine.id]);
      expect(history.problems).toEqual([]);
      expect(history.actions.get(mine.id)).toEqual(["hold.acquired", "hold.confirmed"]);
      expect(await usageOf(admin, tripId)).toMatchObject({ counted: 6, countedHolds: 1 });
    });

    it("lets a confirm that began before the instant see the sweep's stored expiry: it reacquires a free boat and loses a taken one", async () => {
      const free = await trips.charter();
      const taken = await trips.charter();
      const onFree = await acquired(free.tenantId, free.tripId, 2);
      const onTaken = await acquired(taken.tenantId, taken.tripId, 2);
      const confirmFree = pausedSession(runtime.db, free.tenantId, (trx, ctx) =>
        confirmHold(trx, ctx, { holdId: onFree.id, ownerRef: onFree.ownerRef }),
      );
      const confirmTaken = pausedSession(runtime.db, taken.tenantId, (trx, ctx) =>
        confirmHold(trx, ctx, { holdId: onTaken.id, ownerRef: onTaken.ownerRef }),
      );
      await confirmFree.started();
      await confirmTaken.started();
      await passInstantNow(onFree.id);
      await passInstantNow(onTaken.id);
      const runId = `clock-sweep-${randomUUID()}`;
      const report = await sweepExpiredHolds(sweeper.db, { runId });
      expect(report.failedTenants).toBe(0);
      const other = await inTenant(runtime.db, taken.tenantId, (trx, ctx) =>
        acquireFor(trx, ctx, taken.tripId, 4),
      );
      expect(other.kind).toBe("acquired");
      confirmFree.go();
      confirmTaken.go();
      confirmFree.commit();
      confirmTaken.commit();
      expect(await confirmFree.done).toMatchObject({
        ok: true,
        value: { kind: "confirmed", reacquired: true },
      });
      expect(await confirmTaken.done).toMatchObject({
        ok: true,
        value: { kind: "capacity_lost", reason: "no_capacity", hold: { state: "expired" } },
      });
      for (const h of [onFree, onTaken]) {
        const expiry = (await auditsOf(h.id)).filter((a) => a.action === "hold.expired");
        expect(expiry).toEqual([
          { action: "hold.expired", actor_id: "hold-sweep", request_id: runId },
        ]);
      }
      expect((await checkHistories(admin, [onFree.id, onTaken.id])).problems).toEqual([]);
      expect(oversold(await usageOfTenants(admin, [free.tenantId, taken.tenantId]))).toEqual([]);
    });
  });

  // Idempotent replays -----------------------------------------------------------

  describe("replays", () => {
    it(
      "creates one hold for concurrent duplicate acquires by one owner, whatever party each asks for",
      async () => {
        const rounds: RoundStats[] = [];
        try {
          for (let round = 0; round < RACE_ROUNDS; round++) {
            const { tenantId, tripId } = await trips.shared();
            const ownerRef = owner();
            const n = RACE_SESSIONS;
            const party = (i: number) => (round % 2 === 0 ? 2 : 2 + (i % 2));
            const outcomes = await serviceRace(runtime.db, tenantId, n, barrier(n), (trx, ctx, i) =>
              acquireFor(trx, ctx, tripId, party(i), ownerRef),
            );
            const results = valuesOf(outcomes);
            const first = ofKind(results, "acquired");
            const replays = [...ofKind(results, "existing"), ...ofKind(results, "owner_conflict")];
            const rows = await admin<{ id: string }[]>`
              select id from public.capacity_holds where trip_id = ${tripId} and owner_ref = ${ownerRef}`;
            rounds.push({
              sessions: n,
              successes: first.length,
              refusals: replays.length,
              errors: errorsOf(outcomes).length,
              oversell: oversold([await usageOf(admin, tripId)]).length,
            });

            expect(errorsOf(outcomes)).toEqual([]);
            expect(first).toHaveLength(1);
            expect(replays).toHaveLength(n - 1);
            const winner = first[0]?.hold;
            expect(rows.map((r) => r.id)).toEqual([winner?.id]);
            outcomes.forEach((o, i) => {
              if (!o.ok || o.value.kind === "acquired") return;
              const expected = party(i) === winner?.partySize ? "existing" : "owner_conflict";
              expect(o.value).toEqual({ kind: expected, hold: winner });
            });
            const history = await checkHistories(admin, [winner?.id ?? ""]);
            expect(history.problems).toEqual([]);
            expect(history.actions.get(winner?.id ?? "")).toEqual(["hold.acquired"]);
          }
        } finally {
          reportRace("replay: duplicate acquires for one owner and trip", rounds);
        }
      },
      raceTimeout(30_000),
    );

    it(
      "confirms once under concurrent duplicate confirms, within the hold's time and after it",
      async () => {
        const rounds: RoundStats[] = [];
        try {
          for (let round = 0; round < RACE_ROUNDS; round++) {
            for (const late of [false, true]) {
              const { tenantId, tripId } = await trips.shared();
              const hold = await acquired(tenantId, tripId, 2);
              if (late) await expireByClock(admin, [hold.id]);
              const n = RACE_SESSIONS;
              const outcomes = await serviceRace(runtime.db, tenantId, n, barrier(n), (trx, ctx) =>
                confirmHold(trx, ctx, { holdId: hold.id, ownerRef: hold.ownerRef }),
              );
              const results = valuesOf(outcomes);
              const confirmed = ofKind(results, "confirmed");
              const again = ofKind(results, "already_confirmed");
              rounds.push({
                sessions: n,
                successes: confirmed.length,
                refusals: again.length,
                errors: errorsOf(outcomes).length,
                oversell: oversold([await usageOf(admin, tripId)]).length,
              });

              expect(errorsOf(outcomes)).toEqual([]);
              expect(confirmed).toHaveLength(1);
              expect(confirmed[0]?.reacquired).toBe(late);
              expect(again).toHaveLength(n - 1);
              expect(
                again.every((a) => a.hold.id === hold.id && a.hold.state === "confirmed"),
              ).toBe(true);
              const history = await checkHistories(admin, [hold.id]);
              expect(history.problems).toEqual([]);
              expect(history.actions.get(hold.id)).toEqual(
                late
                  ? ["hold.acquired", "hold.expired", "hold.confirmed"]
                  : ["hold.acquired", "hold.confirmed"],
              );
            }
          }
        } finally {
          reportRace("replay: duplicate confirms of one hold (live and late)", rounds);
        }
      },
      raceTimeout(40_000),
    );

    it(
      "releases once under concurrent duplicate releases, from active and from confirmed",
      async () => {
        const rounds: RoundStats[] = [];
        try {
          for (let round = 0; round < RACE_ROUNDS; round++) {
            for (const booked of [false, true]) {
              const { tenantId, tripId } = await trips.shared();
              const hold = await acquired(tenantId, tripId, 3);
              if (booked) expect((await confirm(tenantId, hold)).kind).toBe("confirmed");
              const n = RACE_SESSIONS;
              const outcomes = await serviceRace(runtime.db, tenantId, n, barrier(n), (trx, ctx) =>
                releaseHold(trx, ctx, {
                  holdId: hold.id,
                  ownerRef: hold.ownerRef,
                  reason: "replay",
                }),
              );
              const results = valuesOf(outcomes);
              const released = ofKind(results, "released");
              const unchanged = ofKind(results, "unchanged");
              const usage = await usageOf(admin, tripId);
              rounds.push({
                sessions: n,
                successes: released.length,
                refusals: unchanged.length,
                errors: errorsOf(outcomes).length,
                oversell: oversold([usage]).length,
              });

              expect(errorsOf(outcomes)).toEqual([]);
              expect(released.map((r) => r.from)).toEqual([booked ? "confirmed" : "active"]);
              expect(unchanged).toHaveLength(n - 1);
              expect(usage).toMatchObject({ counted: 0, live: 0 });
              const history = await checkHistories(admin, [hold.id]);
              expect(history.problems).toEqual([]);
              expect(history.actions.get(hold.id)?.filter((a) => a === "hold.released")).toEqual([
                "hold.released",
              ]);
            }
          }
        } finally {
          reportRace("replay: duplicate releases of one hold (active and confirmed)", rounds);
        }
      },
      raceTimeout(40_000),
    );

    it(
      "ends a hold released exactly once when its owner's confirms and releases race",
      async () => {
        const rounds: RoundStats[] = [];
        try {
          for (let round = 0; round < RACE_ROUNDS; round++) {
            const { tenantId, tripId } = await trips.shared();
            const hold = await acquired(tenantId, tripId, 2);
            const n = RACE_SESSIONS;
            const outcomes = await serviceRace<ConfirmHoldResult | ReleaseHoldResult>(
              runtime.db,
              tenantId,
              n,
              barrier(n),
              (trx, ctx, i) =>
                i % 2 === 0
                  ? confirmHold(trx, ctx, { holdId: hold.id, ownerRef: hold.ownerRef })
                  : releaseHold(trx, ctx, { holdId: hold.id, ownerRef: hold.ownerRef }),
            );
            const confirms = outcomes.filter((_, i) => i % 2 === 0);
            const releases = outcomes.filter((_, i) => i % 2 === 1);
            const confirmed = valuesOf(confirms).filter((r) => r.kind === "confirmed");
            const released = valuesOf(releases).filter(
              (r): r is Extract<ReleaseHoldResult, { kind: "released" }> => r.kind === "released",
            );
            const [stored] = await holdsByIds(admin, [hold.id]);
            rounds.push({
              sessions: n,
              successes: released.length,
              refusals: n - released.length - errorsOf(outcomes).length,
              errors: errorsOf(outcomes).length,
              oversell: oversold([await usageOf(admin, tripId)]).length,
            });

            expect(errorsOf(outcomes)).toEqual([]);
            expect(stored?.state).toBe("released");
            expect(released).toHaveLength(1);
            expect(confirmed.length).toBeLessThanOrEqual(1);
            expect(released[0]?.from).toBe(confirmed.length === 1 ? "confirmed" : "active");
            for (const r of valuesOf(confirms)) {
              expect(["confirmed", "already_confirmed", "released"]).toContain(r.kind);
            }
            for (const r of valuesOf(releases)) expect(["released", "unchanged"]).toContain(r.kind);
            const history = await checkHistories(admin, [hold.id]);
            expect(history.problems).toEqual([]);
          }
        } finally {
          reportRace("replay: one owner's confirms and releases interleaved", rounds);
        }
      },
      raceTimeout(30_000),
    );

    // Changed by the lead after this suite found the stale answer: acquisition now
    // expires the trip's due holds before it looks for the owner's hold.
    it("replays an acquire after the hold's instant as the expired hold, and writes the expiry down", async () => {
      const { tenantId, tripId } = await trips.shared();
      const hold = await acquired(tenantId, tripId, 2);
      await expireByClock(admin, [hold.id]);
      const replay = await inTenant(runtime.db, tenantId, (trx, ctx) =>
        acquireFor(trx, ctx, tripId, 2, hold.ownerRef),
      );
      expect(replay.kind).toBe("existing");
      if (replay.kind !== "existing") return;
      expect(replay.hold.state).toBe("expired");
      expect(replay.hold.expiredAt).not.toBeNull();
      expect(Date.parse(replay.hold.expiresAt)).toBeLessThan(Date.now());
      // Nothing counts it any more, and the only write was its expiry.
      expect(await usageOf(admin, tripId)).toMatchObject({ counted: 0, live: 0 });
      expect((await auditsOf(hold.id)).map((a) => a.action)).toEqual([
        "hold.acquired",
        "hold.expired",
      ]);
    });

    it(
      "expires every due hold exactly once under overlapping sweeps and tenant expiry loops, and reports exactly what it wrote",
      async () => {
        const rounds: RoundStats[] = [];
        try {
          for (let round = 0; round < RACE_ROUNDS; round++) {
            const due: Hold[] = [];
            const live: Hold[] = [];
            // Two tenants, three trips each: two full of due holds, one with live holds.
            const fixtures = [
              await createTenantFixture(admin, runtime.db, `sweep${round}a`, { days: 3 }),
              await createTenantFixture(admin, runtime.db, `sweep${round}b`, { days: 3 }),
            ];
            for (const fixture of fixtures) {
              const holds = await Promise.all(
                fixture.trips.shared.map(async (tripId, k) => {
                  const made: Hold[] = [];
                  for (let j = 0; j < (k < 2 ? 10 : 3); j++) {
                    made.push(await acquired(fixture.id, tripId, 1));
                  }
                  return { k, made };
                }),
              );
              for (const { k, made } of holds) (k < 2 ? due : live).push(...made);
            }
            expect([due.length, live.length]).toEqual([40, 6]);
            await expireByClock(
              admin,
              due.map((h) => h.id),
            );
            const runIds = Array.from({ length: 6 }, () => `overlap-${randomUUID()}`);
            const tenants = fixtures.map((f) => f.id);
            const loops = tenants.flatMap((tenantId) =>
              [0, 1].map(async () => {
                const ctx = { ...context(tenantId), actorId: "hold-sweep" };
                let total = 0;
                for (;;) {
                  const { expired } = await inTenantTransaction(runtime.db, ctx, (trx) =>
                    expireDueHolds(trx, ctx, { limit: 7 }),
                  );
                  total += expired.filter((h) => due.some((d) => d.id === h.id)).length;
                  if (expired.length === 0) return { requestId: ctx.requestId, total };
                }
              }),
            );
            const runs = runIds.map((runId) =>
              settle(sweepExpiredHolds(sweeper.db, { runId, batchSize: 4 })),
            );
            const reports = await Promise.all(runs);
            const loopResults = await Promise.all(loops.map((l) => settle(l)));
            const counts = await admin<{ request_id: string; n: number }[]>`
              select request_id, count(*)::int as n from public.audit_events
               where action = 'hold.expired'
                 and request_id in ${admin([...runIds, ...valuesOf(loopResults).map((l) => l.requestId ?? "")])}
               group by request_id`;
            const byRequest = new Map(counts.map((c) => [c.request_id, c.n]));
            const expiredReported =
              valuesOf(reports).reduce((s, r: SweepReport) => s + r.expired, 0) +
              valuesOf(loopResults).reduce((s, l) => s + l.total, 0);
            const errorCount =
              errorsOf(reports).length +
              errorsOf(loopResults).length +
              valuesOf(reports).reduce((s, r) => s + r.failedTenants, 0);
            rounds.push({
              sessions: runs.length + loops.length,
              successes: due.length,
              refusals: 0,
              errors: errorCount,
              oversell: oversold(await usageOfTenants(admin, tenants)).length,
            });

            expect(errorCount).toBe(0);
            // Each run's report matches the audit rows it wrote, exactly.
            for (const [i, report] of reports.entries()) {
              if (!report.ok) continue;
              expect(report.value.expired).toBe(byRequest.get(runIds[i] ?? "") ?? 0);
            }
            expect(expiredReported).toBeGreaterThanOrEqual(due.length);
            const history = await checkHistories(admin, [
              ...due.map((h) => h.id),
              ...live.map((h) => h.id),
            ]);
            expect(history.problems).toEqual([]);
            for (const h of due) {
              expect(history.actions.get(h.id)).toEqual(["hold.acquired", "hold.expired"]);
            }
            for (const h of live) expect(history.actions.get(h.id)).toEqual(["hold.acquired"]);
            // A further run finds nothing of ours left to do.
            const again = await sweepExpiredHolds(sweeper.db, { runId: `again-${randomUUID()}` });
            expect(again.failedTenants).toBe(0);
            const after = await checkHistories(
              admin,
              due.map((h) => h.id),
            );
            expect(after.audits.filter((a) => a.action === "hold.expired")).toHaveLength(
              due.length,
            );
          }
        } finally {
          reportRace("replay: 6 overlapping sweeps and 4 tenant loops over 40 due holds", rounds);
        }
      },
      raceTimeout(120_000),
    );
  });

  // The sweep never waits ------------------------------------------------------------

  describe("the sweep never waits", () => {
    // Other tests leave due holds in other tenants; sweep them first so the timed
    // sweep has only this test's tenant to visit. The bound is far above that
    // work and far below forever, which is how long a waiting sweep would take:
    // the checkout keeps its locks until the sweep returns.
    const SWEEP_BOUND_MS = 45_000;
    const preSweep = () => sweepExpiredHolds(sweeper.db, { runId: `pre-${randomUUID()}` });

    it("expires due holds on a trip whose lock a checkout is holding", async () => {
      const { tenantId, tripId } = await trips.shared();
      const live = await acquired(tenantId, tripId, 2);
      const due = [
        await acquired(tenantId, tripId, 1),
        await acquired(tenantId, tripId, 1),
        await acquired(tenantId, tripId, 1),
      ];
      await preSweep();
      await expireByClock(
        admin,
        due.map((h) => h.id),
      );
      const checkout = pausedSession(runtime.db, tenantId, (trx, ctx) =>
        confirmHold(trx, ctx, { holdId: live.id, ownerRef: live.ownerRef }),
      );
      await checkout.started();
      checkout.go();
      await checkout.ran();
      const runId = `nowait-${randomUUID()}`;
      const report = await settle(
        within(
          sweepExpiredHolds(sweeper.db, { runId }),
          SWEEP_BOUND_MS,
          "sweep beside a held trip lock",
        ),
      );
      checkout.commit();
      expect(await checkout.done).toMatchObject({ ok: true, value: { kind: "confirmed" } });
      expect(report).toMatchObject({ ok: true, value: { failedTenants: 0 } });
      for (const h of due) {
        expect(await auditsOf(h.id)).toEqual([
          expect.objectContaining({ action: "hold.acquired" }),
          { action: "hold.expired", actor_id: "hold-sweep", request_id: runId },
        ]);
      }
    });

    it("skips a due hold a checkout has locked, without waiting, and leaves it to that checkout", async () => {
      const { tenantId, tripId } = await trips.shared();
      const lockedByRelease = await acquired(tenantId, tripId, 1);
      const free = await acquired(tenantId, tripId, 1);
      await preSweep();
      await expireByClock(admin, [lockedByRelease.id, free.id]);
      const checkout = pausedSession(runtime.db, tenantId, (trx, ctx) =>
        releaseHold(trx, ctx, {
          holdId: lockedByRelease.id,
          ownerRef: lockedByRelease.ownerRef,
          reason: "abandoned",
        }),
      );
      await checkout.started();
      checkout.go();
      await checkout.ran();
      const runId = `skip-${randomUUID()}`;
      const report = await settle(
        within(
          sweepExpiredHolds(sweeper.db, { runId }),
          SWEEP_BOUND_MS,
          "sweep beside a locked hold",
        ),
      );
      checkout.commit();
      expect(await checkout.done).toMatchObject({
        ok: true,
        value: { kind: "released", from: "active" },
      });
      expect(report).toMatchObject({ ok: true, value: { failedTenants: 0 } });
      const history = await checkHistories(admin, [lockedByRelease.id, free.id]);
      expect(history.problems).toEqual([]);
      expect(history.actions.get(lockedByRelease.id)).toEqual(["hold.acquired", "hold.released"]);
      expect(history.actions.get(free.id)).toEqual(["hold.acquired", "hold.expired"]);
    });

    it("skips due holds that a late confirmation has expired and is reacquiring, which settles them once", async () => {
      const { tenantId, tripId } = await trips.shared();
      const confirming = await acquired(tenantId, tripId, 2);
      const neighbor = await acquired(tenantId, tripId, 2);
      await preSweep();
      await expireByClock(admin, [confirming.id, neighbor.id]);
      const checkout = pausedSession(runtime.db, tenantId, (trx, ctx) =>
        confirmHold(trx, ctx, { holdId: confirming.id, ownerRef: confirming.ownerRef }),
      );
      await checkout.started();
      checkout.go();
      await checkout.ran();
      const report = await settle(
        within(
          sweepExpiredHolds(sweeper.db, { runId: `late-${randomUUID()}` }),
          SWEEP_BOUND_MS,
          "sweep beside a late confirmation",
        ),
      );
      checkout.commit();
      expect(await checkout.done).toMatchObject({
        ok: true,
        value: { kind: "confirmed", reacquired: true },
      });
      expect(report).toMatchObject({ ok: true, value: { failedTenants: 0 } });
      const history = await checkHistories(admin, [confirming.id, neighbor.id]);
      expect(history.problems).toEqual([]);
      expect(history.actions.get(confirming.id)).toEqual([
        "hold.acquired",
        "hold.expired",
        "hold.confirmed",
      ]);
      expect(history.actions.get(neighbor.id)).toEqual(["hold.acquired", "hold.expired"]);
      expect(
        history.audits.filter((a) => a.action === "hold.expired").map((a) => a.actor_id),
      ).toEqual(["hold-expiry", "hold-expiry"]);
    });
  });

  // Several holds, all or nothing ---------------------------------------------------

  describe("all or nothing", () => {
    class Rollback extends Error {}

    /** Confirm every hold in trip order; roll back unless all confirmed. */
    const confirmAll = (tenantId: string, holds: Hold[]) =>
      settle(
        inTenant(runtime.db, tenantId, async (trx, ctx) => {
          const results: ConfirmHoldResult[] = [];
          for (const h of [...holds].sort((a, b) => a.tripId.localeCompare(b.tripId))) {
            const r = await confirmHold(trx, ctx, { holdId: h.id, ownerRef: h.ownerRef });
            results.push(r);
            if (r.kind !== "confirmed") throw new Rollback(r.kind);
          }
          return results;
        }),
      );

    it("confirms nothing when one of a checkout's holds lost its boat", async () => {
      const shared = await trips.shared();
      const charter = await trips.charter();
      if (shared.tenantId !== charter.tenantId) throw new Error("fixture tenants differ");
      const tenantId = shared.tenantId;
      const ownerRef = owner();
      const seats = await acquired(tenantId, shared.tripId, 2, ownerRef);
      const boat = await acquired(tenantId, charter.tripId, 2, ownerRef);
      await expireByClock(admin, [boat.id]);
      const other = await inTenant(runtime.db, tenantId, (trx, ctx) =>
        acquireFor(trx, ctx, charter.tripId, 2),
      );
      expect(other.kind).toBe("acquired");
      const result = await confirmAll(tenantId, [seats, boat]);
      expect(result.ok).toBe(false);
      const stored = await holdsByIds(admin, [seats.id, boat.id]);
      expect(Object.fromEntries(stored.map((h) => [h.id, h.state]))).toEqual({
        [seats.id]: "active",
        [boat.id]: "expired",
      });
      expect((await auditsOf(seats.id)).map((a) => a.action)).toEqual(["hold.acquired"]);
      expect((await checkHistories(admin, [seats.id, boat.id])).problems).toEqual([]);
    });

    it(
      "keeps every checkout's holds all confirmed or none while checkouts and acquirers race over two trips",
      async () => {
        const rounds: RoundStats[] = [];
        let committedTotal = 0;
        try {
          for (let round = 0; round < RACE_ROUNDS; round++) {
            const t1 = await trips.shared();
            const t2 = await trips.shared();
            if (t1.tenantId !== t2.tenantId) throw new Error("fixture tenants differ");
            const tenantId = t1.tenantId;
            const checkouts: Hold[][] = [];
            for (let k = 0; k < 5; k++) {
              const ownerRef = owner();
              checkouts.push([
                await acquired(tenantId, t1.tripId, 2, ownerRef),
                await acquired(tenantId, t2.tripId, 2, ownerRef),
              ]);
            }
            await expireByClock(
              admin,
              checkouts.flat().map((h) => h.id),
            );
            const others = RACE_SESSIONS - checkouts.length;
            const start = barrier(checkouts.length + others);
            // Checkouts read their hold before queuing on the trip lock, and need two
            // trip locks in turn, so acquirers spread over both trips beat them every
            // time. Even rounds race on both trips (checkouts roll back); odd rounds
            // give checkouts a head start and send acquirers to the first trip in
            // lock order only (checkouts commit).
            const acquirerDelay = STAGGER_MS[round % STAGGER_MS.length] ?? 0;
            const [firstTrip, secondTrip] = [t1.tripId, t2.tripId].sort();
            const acquirerTrip = (i: number) =>
              round % 2 === 1 || i % 2 === 0 ? firstTrip : secondTrip;
            const [settled, acquirers] = await Promise.all([
              Promise.all(
                checkouts.map((holds) =>
                  settle(
                    inTenant(runtime.db, tenantId, async (trx, ctx) => {
                      await start.arrive();
                      for (const h of [...holds].sort((a, b) => a.tripId.localeCompare(b.tripId))) {
                        const r = await confirmHold(trx, ctx, {
                          holdId: h.id,
                          ownerRef: h.ownerRef,
                        });
                        if (r.kind !== "confirmed") throw new Rollback(r.kind);
                      }
                      return "committed";
                    }),
                  ),
                ),
              ),
              serviceRace(runtime.db, tenantId, others, start, async (trx, ctx, i) => {
                await sleep(acquirerDelay);
                return acquireFor(trx, ctx, acquirerTrip(i) ?? t1.tripId, 2);
              }),
            ]);
            committedTotal += valuesOf(settled).length;
            const unexpected = [
              ...errorsOf(settled).filter((e) => !/^(capacity_lost|released)$/.test(e.message)),
              ...errorsOf(acquirers),
            ];
            const stored = await holdsByIds(
              admin,
              checkouts.flat().map((h) => h.id),
            );
            const state = new Map(stored.map((h) => [h.id, h.state]));
            const split = checkouts.filter(
              (holds) => new Set(holds.map((h) => state.get(h.id) === "confirmed")).size > 1,
            );
            const usage = [await usageOf(admin, t1.tripId), await usageOf(admin, t2.tripId)];
            const committed = valuesOf(settled).length;
            rounds.push({
              sessions: checkouts.length + others,
              successes: committed + ofKind(valuesOf(acquirers), "acquired").length,
              refusals:
                errorsOf(settled).length -
                unexpected.length +
                ofKind(valuesOf(acquirers), "insufficient_capacity").length,
              errors: unexpected.length + split.length,
              oversell: oversold(usage).length,
            });

            expect(unexpected).toEqual([]);
            expect(split).toEqual([]);
            expect(oversold(usage)).toEqual([]);
            for (const [i, outcome] of settled.entries()) {
              const holds = checkouts[i] ?? [];
              const confirmedNow = holds.every((h) => state.get(h.id) === "confirmed");
              expect(confirmedNow).toBe(outcome.ok);
            }
            const fresh = ofKind(valuesOf(acquirers), "acquired").map((a) => a.hold.id);
            expect(
              (await checkHistories(admin, [...checkouts.flat().map((h) => h.id), ...fresh]))
                .problems,
            ).toEqual([]);
          }
        } finally {
          reportRace("all or nothing: 5 two-trip checkouts confirming vs acquirers", rounds, {
            checkoutsCommitted: committedTotal,
          });
        }
      },
      raceTimeout(60_000),
    );
  });

  // Isolation: callers outside READ COMMITTED must be refused -------------------------

  describe("isolation", () => {
    /**
     * A late party of two whose seats another owner took, so the trip is full.
     * The caller's transaction starts (outside READ COMMITTED that fixes its
     * snapshot), then eight seats come free and commit before it runs.
     */
    async function lateConfirmAfterSeatsFreed(level?: Level) {
      const { tenantId, tripId } = await trips.shared();
      const late = await acquired(tenantId, tripId, 2);
      const filler = await acquired(tenantId, tripId, 8);
      await expireByClock(admin, [late.id]);
      await acquired(tenantId, tripId, 2);
      const confirming = pausedSession(
        runtime.db,
        tenantId,
        (trx, ctx) => confirmHold(trx, ctx, { holdId: late.id, ownerRef: late.ownerRef }),
        level ? { level } : {},
      );
      await confirming.started();
      const freed = await inTenant(runtime.db, tenantId, (trx, ctx) =>
        releaseHold(trx, ctx, { holdId: filler.id, ownerRef: filler.ownerRef }),
      );
      expect(freed.kind).toBe("released");
      confirming.go();
      confirming.commit();
      const result: Outcome<ConfirmHoldResult> = await confirming.done;
      return { result, usage: await usageOf(admin, tripId) };
    }

    /** A full trip; the caller starts, eight seats come free, then it asks for two. */
    async function acquireAfterSeatsFreed(level?: Level) {
      const { tenantId, tripId } = await trips.shared();
      const filler = await acquired(tenantId, tripId, 8);
      await acquired(tenantId, tripId, 2);
      const acquiring = pausedSession(
        runtime.db,
        tenantId,
        (trx, ctx) => acquireFor(trx, ctx, tripId, 2),
        level ? { level } : {},
      );
      await acquiring.started();
      const freed = await inTenant(runtime.db, tenantId, (trx, ctx) =>
        releaseHold(trx, ctx, { holdId: filler.id, ownerRef: filler.ownerRef }),
      );
      expect(freed.kind).toBe("released");
      acquiring.go();
      acquiring.commit();
      const result: Outcome<AcquireHoldResult> = await acquiring.done;
      return { result, usage: await usageOf(admin, tripId) };
    }

    it("control: under READ COMMITTED the late confirmation reacquires the freed seats", async () => {
      const { result, usage } = await lateConfirmAfterSeatsFreed();
      expect(result).toMatchObject({ ok: true, value: { kind: "confirmed", reacquired: true } });
      expect(usage).toMatchObject({ counted: 4, countedHolds: 2 });
    });

    it("control: under READ COMMITTED the acquisition takes the freed seats", async () => {
      const { result, usage } = await acquireAfterSeatsFreed();
      expect(result).toMatchObject({ ok: true, value: { kind: "acquired" } });
      expect(usage).toMatchObject({ counted: 4, countedHolds: 2 });
    });

    // Commands require READ COMMITTED. A caller at a stricter level must be refused
    // (the trigger uses SQLSTATE 25000; a service-side guard may throw instead),
    // never answered from its stale snapshot.
    const refusal = <T extends { kind: string }>(result: Outcome<T>) => ({
      refused: !result.ok,
      answered: result.ok ? result.value : null,
    });

    for (const level of ["repeatable read", "serializable"] as const) {
      it(`refuses a ${level} confirmation instead of reporting capacity lost from a stale snapshot`, async () => {
        const { result, usage } = await lateConfirmAfterSeatsFreed(level);
        // Eight of ten seats are free; a READ COMMITTED caller reacquires here (see the control).
        expect(usage.counted).toBe(2);
        expect(refusal(result)).toEqual({ refused: true, answered: null });
      });

      it(`refuses a ${level} acquisition instead of reporting no capacity from a stale snapshot`, async () => {
        const { result, usage } = await acquireAfterSeatsFreed(level);
        expect(usage.counted).toBe(2);
        expect(refusal(result)).toEqual({ refused: true, answered: null });
        expect(oversold([usage])).toEqual([]);
      });
    }

    // Changed by the lead with the D1 fix: every command needs READ COMMITTED, even
    // one that would not count, so the rule for callers has no exceptions.
    it("refuses a REPEATABLE READ caller even for a hold within its time, and leaves it active", async () => {
      const { tenantId, tripId } = await trips.shared();
      const hold = await acquired(tenantId, tripId, 2);
      const result = await settle(
        runtime.db
          .transaction()
          .setIsolationLevel("repeatable read")
          .execute(async (trx) => {
            const ctx = context(tenantId);
            await setTenantContext(trx, ctx);
            return confirmHold(trx, ctx, { holdId: hold.id, ownerRef: hold.ownerRef });
          }),
      );
      expect(refusal(result)).toEqual({ refused: true, answered: null });
      expect(await usageOf(admin, tripId)).toMatchObject({ counted: 2 });
      expect((await auditsOf(hold.id)).map((a) => a.action)).toEqual(["hold.acquired"]);
    });
  });

  it("leaves no trip of any tenant this file built over capacity", async () => {
    const usage = await usageOfTenants(admin, trips.tenantIds());
    expect(usage.length).toBeGreaterThan(0);
    expect(oversold(usage)).toEqual([]);
  });
});
