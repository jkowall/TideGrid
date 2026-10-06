/**
 * G2.6 adversarial races against PostgreSQL. Every session opens its own
 * transaction as tidegrid_app, waits at a barrier until all sessions are open,
 * then runs, so every competing snapshot and clock predates every write. Each
 * race runs RACE_ROUNDS rounds of RACE_SESSIONS sessions on fresh trips and
 * checks the returned results, the stored invariant, and every hold's audit and
 * outbox trail. Each race prints one RACE_STATS line for the verification log.
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
import { changeTripSalesState } from "@tidegrid/domain-catalog";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";
import {
  type AcquireHoldResult,
  acquireHold,
  type ConfirmHoldResult,
  confirmHold,
  expireDueHolds,
  type Hold,
  type ReleaseHoldResult,
  releaseHold,
  type SweepReport,
  sweepExpiredHolds,
} from "../index.ts";
import {
  barrier,
  checkHistories,
  context,
  errorsOf,
  expireByClock,
  holdsOnTrip,
  type Outcome,
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
  settle,
  sleep,
  type TripUsage,
  tripSource,
  usageOf,
  usageOfTenants,
  valuesOf,
  whenOpen,
} from "./harness.ts";

const env = inject("integrationDb");

type Level = "read committed" | "repeatable read" | "serializable";

function ofKind<T extends { kind: string }, K extends T["kind"]>(
  items: readonly T[],
  kind: K,
): Extract<T, { kind: K }>[] {
  return items.filter((i): i is Extract<T, { kind: K }> => i.kind === kind);
}

/** A small deterministic generator, so a storm replays the same choices. */
function prng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

describe.skipIf(!env)("G2.6 adversarial races as the runtime role", () => {
  let admin: Sql;
  let rt: Sql;
  let runtime: Runtime;
  let sweeper: Runtime;
  let trips: ReturnType<typeof tripSource>;

  beforeAll(async () => {
    if (!env) return;
    admin = postgres(env.adminUrl, { max: 4, onnotice: () => {} });
    rt = postgres(env.runtimeUrl, { max: RACE_SESSIONS + 2, onnotice: () => {} });
    runtime = createDb(env.runtimeUrl, { max: RACE_SESSIONS + 2 });
    sweeper = createDb(env.runtimeUrl, { max: 4 });
    trips = tripSource(admin, runtime.db, "race");
  });

  afterAll(async () => {
    await runtime?.end();
    await sweeper?.end();
    await rt?.end({ timeout: 5 });
    await admin?.end({ timeout: 5 });
  });

  // Helpers -------------------------------------------------------------------------

  const inTenant = <T>(
    db: Runtime["db"],
    tenantId: string,
    fn: (trx: TenantTransaction, ctx: TenantContext) => Promise<T>,
  ): Promise<T> => {
    const ctx = context(tenantId);
    return inTenantTransaction(db, ctx, (trx) => fn(trx, ctx));
  };

  const inLevel = <T>(
    level: Level,
    tenantId: string,
    fn: (trx: TenantTransaction, ctx: TenantContext) => Promise<T>,
  ): Promise<T> => {
    const ctx = context(tenantId);
    return runtime.db
      .transaction()
      .setIsolationLevel(level)
      .execute(async (trx) => {
        await setTenantContext(trx, ctx);
        return fn(trx, ctx);
      });
  };

  /** `n` service sessions, each in its own runtime transaction, released together. */
  const serviceRace = <T>(
    tenantId: string,
    n: number,
    start: ReturnType<typeof barrier>,
    fn: (trx: TenantTransaction, ctx: TenantContext, i: number) => Promise<T>,
  ): Promise<Outcome<T>[]> =>
    Promise.all(
      Array.from({ length: n }, (_, i) =>
        settle(
          inTenant(runtime.db, tenantId, async (trx, ctx) => {
            await start.arrive();
            return fn(trx, ctx, i);
          }),
        ),
      ),
    );

  /** `n` raw sessions as tidegrid_app, each in its own transaction bound to `tenantId`. */
  const rawRace = <T>(
    tenantId: string,
    n: number,
    start: ReturnType<typeof barrier>,
    fn: (tx: postgres.TransactionSql, i: number) => Promise<T>,
  ): Promise<Outcome<T>[]> =>
    Promise.all(
      Array.from({ length: n }, (_, i) =>
        settle(
          rt.begin(async (tx) => {
            await tx`select set_config('app.tenant_id', ${tenantId}, true)`;
            await start.arrive();
            return fn(tx, i);
          }) as Promise<T>,
        ),
      ),
    );

  const rawInsert = (
    tx: postgres.TransactionSql,
    tenantId: string,
    tripId: string,
    party: number,
  ) =>
    tx<{ id: string; kind: string; seats: number }[]>`
      insert into public.capacity_holds (tenant_id, trip_id, owner_ref, party_size, expires_at)
      values (${tenantId}, ${tripId}, ${owner()}, ${party}, now() + interval '10 minutes')
      returning id, kind, seats`;

  const acquire = (
    trx: TenantTransaction,
    ctx: TenantContext,
    tripId: string,
    partySize: number,
    ownerRef = owner(),
  ) => acquireHold(trx, ctx, { ownerRef, tripId, partySize, ttlSeconds: 600 });

  async function acquired(tenantId: string, tripId: string, party: number): Promise<Hold> {
    const result = await inTenant(runtime.db, tenantId, (trx, ctx) =>
      acquire(trx, ctx, tripId, party),
    );
    if (result.kind !== "acquired") throw new Error(`prefill got ${result.kind}`);
    return result.hold;
  }

  async function rawPrefill(tenantId: string, tripId: string, parties: number[]) {
    for (const party of parties) {
      await rt.begin(async (tx) => {
        await tx`select set_config('app.tenant_id', ${tenantId}, true)`;
        await rawInsert(tx, tenantId, tripId, party);
      });
    }
  }

  const sweepRun = (label: string, batchSize: number) =>
    settle(sweepExpiredHolds(sweeper.db, { runId: `${label}-${randomUUID()}`, batchSize }));

  function partyOf(i: number, from: number, to: number) {
    return from + (i % (to - from + 1));
  }

  /** Stats for one round, with the invariant read back from the database. */
  function stats(
    sessions: number,
    successes: number,
    refusals: number,
    errors: number,
    usage: TripUsage[],
  ): RoundStats {
    return { sessions, successes, refusals, errors, oversell: oversold(usage).length };
  }

  // 1. The last seat ------------------------------------------------------------------

  it(
    "gives the final seat of a shared trip to exactly one of many sessions",
    async () => {
      const rounds: RoundStats[] = [];
      try {
        for (let round = 0; round < RACE_ROUNDS; round++) {
          const { tenantId, tripId } = await trips.shared();
          const prefill = [
            await acquired(tenantId, tripId, 8),
            await acquired(tenantId, tripId, 1),
          ];
          const n = RACE_SESSIONS;
          const outcomes = await serviceRace(tenantId, n, barrier(n), (trx, ctx) =>
            acquire(trx, ctx, tripId, 1),
          );
          const results = valuesOf(outcomes);
          const won = ofKind(results, "acquired");
          const refused = ofKind(results, "insufficient_capacity");
          const usage = await usageOf(admin, tripId);
          rounds.push(stats(n, won.length, refused.length, errorsOf(outcomes).length, [usage]));

          expect(errorsOf(outcomes)).toEqual([]);
          expect(won).toHaveLength(1);
          expect(refused.map((r) => r.remaining)).toEqual(Array(n - 1).fill(0));
          expect(usage).toMatchObject({ capacity: 10, counted: 10, live: 10, countedHolds: 3 });
          const holds = await holdsOnTrip(admin, tripId);
          expect(holds.map((h) => h.id).sort()).toEqual(
            [...prefill.map((h) => h.id), won[0]?.hold.id].sort(),
          );
          expect(
            (
              await checkHistories(
                admin,
                holds.map((h) => h.id),
              )
            ).problems,
          ).toEqual([]);
        }
      } finally {
        reportRace("service: last seat of a shared trip (9 of 10 held, party 1)", rounds);
      }
    },
    raceTimeout(40_000),
  );

  it(
    "fills an empty shared trip exactly and refuses everyone after the tenth seat",
    async () => {
      const rounds: RoundStats[] = [];
      try {
        for (let round = 0; round < RACE_ROUNDS; round++) {
          const { tenantId, tripId } = await trips.shared();
          const n = RACE_SESSIONS;
          const outcomes = await serviceRace(tenantId, n, barrier(n), (trx, ctx) =>
            acquire(trx, ctx, tripId, 1),
          );
          const results = valuesOf(outcomes);
          const won = ofKind(results, "acquired");
          const refused = ofKind(results, "insufficient_capacity");
          const usage = await usageOf(admin, tripId);
          rounds.push(stats(n, won.length, refused.length, errorsOf(outcomes).length, [usage]));

          expect(errorsOf(outcomes)).toEqual([]);
          expect(won).toHaveLength(10);
          expect(refused.map((r) => r.remaining)).toEqual(Array(n - 10).fill(0));
          expect(usage).toMatchObject({ counted: 10, countedHolds: 10 });
          expect(
            (
              await checkHistories(
                admin,
                won.map((w) => w.hold.id),
              )
            ).problems,
          ).toEqual([]);
        }
      } finally {
        reportRace("service: empty shared trip filled by party-1 sessions", rounds);
      }
    },
    raceTimeout(40_000),
  );

  it(
    "never oversells a nearly full trip to parties of mixed sizes, and refuses only parties that no longer fit",
    async () => {
      const rounds: RoundStats[] = [];
      try {
        for (let round = 0; round < RACE_ROUNDS; round++) {
          const { tenantId, tripId } = await trips.shared();
          await acquired(tenantId, tripId, 6);
          const n = RACE_SESSIONS;
          const party = (i: number) => partyOf(i + round, 1, 4);
          const outcomes = await serviceRace(tenantId, n, barrier(n), (trx, ctx, i) =>
            acquire(trx, ctx, tripId, party(i)),
          );
          const usage = await usageOf(admin, tripId);
          const won: { i: number; hold: Hold }[] = [];
          const refused: { i: number; remaining: number }[] = [];
          const other: unknown[] = [];
          outcomes.forEach((o, i) => {
            if (!o.ok) return;
            if (o.value.kind === "acquired") won.push({ i, hold: o.value.hold });
            else if (o.value.kind === "insufficient_capacity") {
              refused.push({ i, remaining: o.value.remaining });
            } else other.push(o.value);
          });
          rounds.push(stats(n, won.length, refused.length, errorsOf(outcomes).length, [usage]));

          expect(errorsOf(outcomes)).toEqual([]);
          expect(other).toEqual([]);
          const seatsWon = won.reduce((s, w) => s + w.hold.seats, 0);
          expect(won.every((w) => w.hold.seats === party(w.i))).toBe(true);
          expect(usage.counted).toBe(6 + seatsWon);
          expect(usage.counted).toBeLessThanOrEqual(10);
          const finalRemaining = 10 - usage.counted;
          for (const r of refused) {
            // The party did not fit when refused, and capacity only shrank afterwards.
            expect(r.remaining).toBeLessThan(party(r.i));
            expect(r.remaining).toBeGreaterThanOrEqual(finalRemaining);
            expect(party(r.i)).toBeGreaterThan(finalRemaining);
          }
          expect(
            (
              await checkHistories(
                admin,
                won.map((w) => w.hold.id),
              )
            ).problems,
          ).toEqual([]);
        }
      } finally {
        reportRace("service: mixed parties 1-4 into a trip with 4 of 10 seats left", rounds);
      }
    },
    raceTimeout(40_000),
  );

  // 2. The whole boat -----------------------------------------------------------------

  it(
    "gives a private charter to exactly one of many sessions",
    async () => {
      const rounds: RoundStats[] = [];
      try {
        for (let round = 0; round < RACE_ROUNDS; round++) {
          const { tenantId, tripId } = await trips.charter();
          const n = RACE_SESSIONS;
          const outcomes = await serviceRace(tenantId, n, barrier(n), (trx, ctx, i) =>
            acquire(trx, ctx, tripId, partyOf(i, 2, 6)),
          );
          const results = valuesOf(outcomes);
          const won = ofKind(results, "acquired");
          const refused = ofKind(results, "insufficient_capacity");
          const usage = await usageOf(admin, tripId);
          rounds.push(stats(n, won.length, refused.length, errorsOf(outcomes).length, [usage]));

          expect(errorsOf(outcomes)).toEqual([]);
          expect(won).toHaveLength(1);
          expect(won[0]?.hold).toMatchObject({ kind: "whole_boat", seats: 6, state: "active" });
          expect(refused.map((r) => r.remaining)).toEqual(Array(n - 1).fill(0));
          expect(usage).toMatchObject({ counted: 6, countedHolds: 1, wholeBoats: 1 });
          expect(
            (
              await checkHistories(
                admin,
                won.map((w) => w.hold.id),
              )
            ).problems,
          ).toEqual([]);
        }
      } finally {
        reportRace("service: whole boat, parties 2-6", rounds);
      }
    },
    raceTimeout(40_000),
  );

  it(
    "frees a charter held past its time exactly once and gives it to exactly one session",
    async () => {
      const rounds: RoundStats[] = [];
      try {
        for (let round = 0; round < RACE_ROUNDS; round++) {
          const { tenantId, tripId } = await trips.charter();
          const stale = await acquired(tenantId, tripId, 4);
          await expireByClock(admin, [stale.id]);
          const n = RACE_SESSIONS;
          const outcomes = await serviceRace(tenantId, n, barrier(n), (trx, ctx, i) =>
            acquire(trx, ctx, tripId, partyOf(i, 2, 6)),
          );
          const results = valuesOf(outcomes);
          const won = ofKind(results, "acquired");
          const refused = ofKind(results, "insufficient_capacity");
          const usage = await usageOf(admin, tripId);
          rounds.push(stats(n, won.length, refused.length, errorsOf(outcomes).length, [usage]));

          expect(errorsOf(outcomes)).toEqual([]);
          expect(won).toHaveLength(1);
          expect(refused).toHaveLength(n - 1);
          expect(usage).toMatchObject({ counted: 6, countedHolds: 1, wholeBoats: 1 });
          const history = await checkHistories(admin, [stale.id, ...won.map((w) => w.hold.id)]);
          expect(history.problems).toEqual([]);
          expect(history.actions.get(stale.id)).toEqual(["hold.acquired", "hold.expired"]);
          expect(
            history.audits.filter((a) => a.subject_id === stale.id && a.action === "hold.expired"),
          ).toMatchObject([{ actor_id: "hold-expiry" }]);
        }
      } finally {
        reportRace("service: whole boat behind a hold past its time", rounds);
      }
    },
    raceTimeout(40_000),
  );

  // The trigger alone, with no service in front of it --------------------------------

  it(
    "keeps the last seat to one of many raw inserts that bypass the service",
    async () => {
      const rounds: RoundStats[] = [];
      try {
        for (let round = 0; round < RACE_ROUNDS; round++) {
          const { tenantId, tripId } = await trips.shared();
          await rawPrefill(tenantId, tripId, [8, 1]);
          const n = RACE_SESSIONS;
          const outcomes = await rawRace(tenantId, n, barrier(n), (tx) =>
            rawInsert(tx, tenantId, tripId, 1),
          );
          const errors = errorsOf(outcomes);
          const ok = valuesOf(outcomes);
          const usage = await usageOf(admin, tripId);
          const refused = errors.filter(
            (e) => e.code === "23514" && e.constraint === "capacity_holds_capacity",
          );
          rounds.push(stats(n, ok.length, refused.length, errors.length - refused.length, [usage]));

          expect(ok).toHaveLength(1);
          expect(errors.map((e) => [e.code, e.constraint])).toEqual(
            Array(n - 1).fill(["23514", "capacity_holds_capacity"]),
          );
          expect(usage).toMatchObject({ counted: 10, countedHolds: 3 });
        }
      } finally {
        reportRace("raw insert: last seat of a shared trip (9 of 10 held, party 1)", rounds);
      }
    },
    raceTimeout(30_000),
  );

  it(
    "fills an empty shared trip exactly with raw inserts that bypass the service",
    async () => {
      const rounds: RoundStats[] = [];
      try {
        for (let round = 0; round < RACE_ROUNDS; round++) {
          const { tenantId, tripId } = await trips.shared();
          const n = RACE_SESSIONS;
          const outcomes = await rawRace(tenantId, n, barrier(n), (tx) =>
            rawInsert(tx, tenantId, tripId, 1),
          );
          const errors = errorsOf(outcomes);
          const ok = valuesOf(outcomes);
          const usage = await usageOf(admin, tripId);
          const refused = errors.filter(
            (e) => e.code === "23514" && e.constraint === "capacity_holds_capacity",
          );
          rounds.push(stats(n, ok.length, refused.length, errors.length - refused.length, [usage]));

          expect(ok).toHaveLength(10);
          expect(errors.map((e) => [e.code, e.constraint])).toEqual(
            Array(n - 10).fill(["23514", "capacity_holds_capacity"]),
          );
          expect(usage).toMatchObject({ counted: 10, countedHolds: 10 });
        }
      } finally {
        reportRace("raw insert: empty shared trip filled by party-1 inserts", rounds);
      }
    },
    raceTimeout(30_000),
  );

  it(
    "never oversells to raw inserts of mixed party sizes into a nearly full trip",
    async () => {
      const rounds: RoundStats[] = [];
      try {
        for (let round = 0; round < RACE_ROUNDS; round++) {
          const { tenantId, tripId } = await trips.shared();
          await rawPrefill(tenantId, tripId, [6]);
          const n = RACE_SESSIONS;
          const party = (i: number) => partyOf(i + round, 1, 4);
          const outcomes = await rawRace(tenantId, n, barrier(n), (tx, i) =>
            rawInsert(tx, tenantId, tripId, party(i)),
          );
          const usage = await usageOf(admin, tripId);
          const errors = errorsOf(outcomes);
          const refused = errors.filter(
            (e) => e.code === "23514" && e.constraint === "capacity_holds_capacity",
          );
          const okSeats = outcomes.reduce((s, o) => s + (o.ok ? (o.value[0]?.seats ?? 0) : 0), 0);
          rounds.push(
            stats(n, n - errors.length, refused.length, errors.length - refused.length, [usage]),
          );

          expect(refused).toHaveLength(errors.length);
          expect(usage.counted).toBe(6 + okSeats);
          expect(usage.counted).toBeLessThanOrEqual(10);
          const finalRemaining = 10 - usage.counted;
          outcomes.forEach((o, i) => {
            if (!o.ok) expect(party(i)).toBeGreaterThan(finalRemaining);
          });
        }
      } finally {
        reportRace("raw insert: mixed parties 1-4 into a trip with 4 of 10 seats left", rounds);
      }
    },
    raceTimeout(30_000),
  );

  it(
    "gives a charter to one of many raw inserts that bypass the service",
    async () => {
      const rounds: RoundStats[] = [];
      try {
        for (let round = 0; round < RACE_ROUNDS; round++) {
          const { tenantId, tripId } = await trips.charter();
          const n = RACE_SESSIONS;
          const outcomes = await rawRace(tenantId, n, barrier(n), (tx, i) =>
            rawInsert(tx, tenantId, tripId, partyOf(i, 2, 6)),
          );
          const usage = await usageOf(admin, tripId);
          const errors = errorsOf(outcomes);
          const refused = errors.filter(
            (e) =>
              (e.code === "23514" && e.constraint === "capacity_holds_capacity") ||
              (e.code === "23505" && e.constraint === "capacity_holds_one_whole_boat"),
          );
          const ok = valuesOf(outcomes);
          rounds.push(stats(n, ok.length, refused.length, errors.length - refused.length, [usage]));

          expect(ok).toHaveLength(1);
          expect(ok[0]?.[0]).toMatchObject({ kind: "whole_boat", seats: 6 });
          expect(refused).toHaveLength(n - 1);
          expect(usage).toMatchObject({ counted: 6, countedHolds: 1, wholeBoats: 1 });
        }
      } finally {
        reportRace("raw insert: whole boat, parties 2-6", rounds);
      }
    },
    raceTimeout(30_000),
  );

  // 3. Holds against the sweep --------------------------------------------------------

  it(
    "expires due holds once while acquisitions and sweeps race for the freed seats",
    async () => {
      const rounds: RoundStats[] = [];
      const expiredBy = { lazily: 0, bySweep: 0 };
      try {
        for (let round = 0; round < RACE_ROUNDS; round++) {
          const { tenantId, tripId } = await trips.shared();
          const due: Hold[] = [];
          const live: Hold[] = [];
          for (let k = 0; k < 6; k++) due.push(await acquired(tenantId, tripId, 1));
          for (let k = 0; k < 4; k++) live.push(await acquired(tenantId, tripId, 1));
          await expireByClock(
            admin,
            due.map((h) => h.id),
          );
          const expirers = 2;
          const n = RACE_SESSIONS - expirers;
          const start = barrier(n + expirers);
          // Sweeps reach the due rows in fewer round trips than an acquirer's lazy
          // expiry, so they win every round unless they sometimes start later.
          const sweepDelay = STAGGER_MS[round % STAGGER_MS.length] ?? 0;
          const sweeps = whenOpen(start, async () => {
            await sleep(sweepDelay);
            return Promise.all([sweepRun("race-sweep", 2), sweepRun("race-sweep", 2)]);
          });
          const [acquirers, expiring] = await Promise.all([
            serviceRace(tenantId, n, start, (trx, ctx) => acquire(trx, ctx, tripId, 1)),
            serviceRace(tenantId, expirers, start, async (trx, ctx) => {
              await sleep(sweepDelay);
              return expireDueHolds(trx, ctx, { limit: 3 });
            }),
          ]);
          const sweepOutcomes = await sweeps;
          const results = valuesOf(acquirers);
          const won = ofKind(results, "acquired");
          const refused = ofKind(results, "insufficient_capacity");
          const usage = await usageOf(admin, tripId);
          const errorCount =
            errorsOf(acquirers).length +
            errorsOf(expiring).length +
            errorsOf(sweepOutcomes).length +
            valuesOf(sweepOutcomes).reduce((s, r: SweepReport) => s + r.failedTenants, 0);
          rounds.push(stats(n + expirers + 2, won.length, refused.length, errorCount, [usage]));

          expect(errorsOf(acquirers)).toEqual([]);
          expect(errorsOf(expiring)).toEqual([]);
          expect(errorsOf(sweepOutcomes)).toEqual([]);
          expect(valuesOf(sweepOutcomes).map((r) => r.failedTenants)).toEqual([0, 0]);
          expect(won).toHaveLength(6);
          expect(refused).toHaveLength(n - 6);
          expect(usage).toMatchObject({ counted: 10, live: 10, countedHolds: 10 });
          const history = await checkHistories(admin, [
            ...due.map((h) => h.id),
            ...live.map((h) => h.id),
            ...won.map((w) => w.hold.id),
          ]);
          expect(history.problems).toEqual([]);
          for (const h of due) {
            expect(history.actions.get(h.id)).toEqual(["hold.acquired", "hold.expired"]);
          }
          for (const h of live) expect(history.actions.get(h.id)).toEqual(["hold.acquired"]);
          for (const a of history.audits.filter((x) => x.action === "hold.expired")) {
            if (a.actor_id === "hold-expiry") expiredBy.lazily += 1;
            else expiredBy.bySweep += 1;
          }
        }
      } finally {
        reportRace(
          "service vs sweep: 6 due + 4 live holds, party-1 acquirers, 2 expirers, 2 sweeps",
          rounds,
          { expiredLazily: expiredBy.lazily, expiredBySweep: expiredBy.bySweep },
        );
      }
    },
    raceTimeout(60_000),
  );

  it(
    "expires a due charter hold once while acquisitions and sweeps race for the boat",
    async () => {
      const rounds: RoundStats[] = [];
      const expiredBy = { lazily: 0, bySweep: 0 };
      try {
        for (let round = 0; round < RACE_ROUNDS; round++) {
          const { tenantId, tripId } = await trips.charter();
          const stale = await acquired(tenantId, tripId, 2);
          await expireByClock(admin, [stale.id]);
          const expirers = 2;
          const n = RACE_SESSIONS - expirers;
          const start = barrier(n + expirers);
          const sweepDelay = STAGGER_MS[round % STAGGER_MS.length] ?? 0;
          const sweeps = whenOpen(start, async () => {
            await sleep(sweepDelay);
            return Promise.all([sweepRun("boat-sweep", 1), sweepRun("boat-sweep", 1)]);
          });
          const [acquirers, expiring] = await Promise.all([
            serviceRace(tenantId, n, start, (trx, ctx, i) =>
              acquire(trx, ctx, tripId, partyOf(i, 2, 6)),
            ),
            serviceRace(tenantId, expirers, start, async (trx, ctx) => {
              await sleep(sweepDelay);
              return expireDueHolds(trx, ctx, { limit: 1 });
            }),
          ]);
          const sweepOutcomes = await sweeps;
          const won = ofKind(valuesOf(acquirers), "acquired");
          const refused = ofKind(valuesOf(acquirers), "insufficient_capacity");
          const usage = await usageOf(admin, tripId);
          const errorCount =
            errorsOf(acquirers).length + errorsOf(expiring).length + errorsOf(sweepOutcomes).length;
          rounds.push(stats(n + expirers + 2, won.length, refused.length, errorCount, [usage]));
          const [staleExpiry] = await admin<{ actor_id: string }[]>`
            select actor_id from public.audit_events
             where subject_id = ${stale.id} and action = 'hold.expired'`;
          if (staleExpiry?.actor_id === "hold-expiry") expiredBy.lazily += 1;
          else expiredBy.bySweep += 1;

          expect(errorCount).toBe(0);
          expect(won).toHaveLength(1);
          expect(refused).toHaveLength(n - 1);
          expect(usage).toMatchObject({ counted: 6, countedHolds: 1, wholeBoats: 1 });
          const history = await checkHistories(admin, [stale.id, ...won.map((w) => w.hold.id)]);
          expect(history.problems).toEqual([]);
          expect(history.actions.get(stale.id)).toEqual(["hold.acquired", "hold.expired"]);
        }
      } finally {
        reportRace("service vs sweep: whole boat behind a due hold", rounds, {
          expiredLazily: expiredBy.lazily,
          expiredBySweep: expiredBy.bySweep,
        });
      }
    },
    raceTimeout(60_000),
  );

  // 4. Confirmation against expiry ---------------------------------------------------

  it(
    "settles every late confirmation exactly once while other owners and sweeps take the seats",
    async () => {
      const rounds: RoundStats[] = [];
      const tally = { reacquired: 0, lost: 0, acquired: 0 };
      try {
        for (let round = 0; round < RACE_ROUNDS; round++) {
          const { tenantId, tripId } = await trips.shared();
          const mine: Hold[] = [];
          for (let k = 0; k < 5; k++) mine.push(await acquired(tenantId, tripId, 2));
          await expireByClock(
            admin,
            mine.map((h) => h.id),
          );
          const expirers = 2;
          const others = RACE_SESSIONS - mine.length - expirers;
          const start = barrier(mine.length + others + expirers);
          // Confirmers read their hold before queuing on the trip lock, so acquirers
          // queue first unless they sometimes start later. Sweeps vary too.
          const acquirerDelay = STAGGER_MS[round % STAGGER_MS.length] ?? 0;
          const sweepDelay = STAGGER_MS[(round + 1) % STAGGER_MS.length] ?? 0;
          const sweeps = whenOpen(start, async () => {
            await sleep(sweepDelay);
            return Promise.all([sweepRun("late-sweep", 2)]);
          });
          const [confirms, acquirers, expiring] = await Promise.all([
            serviceRace(tenantId, mine.length, start, (trx, ctx, i) => {
              const h = mine[i];
              if (!h) throw new Error("no hold");
              return confirmHold(trx, ctx, { holdId: h.id, ownerRef: h.ownerRef });
            }),
            serviceRace(tenantId, others, start, async (trx, ctx) => {
              await sleep(acquirerDelay);
              return acquire(trx, ctx, tripId, 2);
            }),
            serviceRace(tenantId, expirers, start, async (trx, ctx) => {
              await sleep(sweepDelay);
              return expireDueHolds(trx, ctx, { limit: 2 });
            }),
          ]);
          const sweepOutcomes = await sweeps;
          const confirmed = ofKind(valuesOf(confirms), "confirmed");
          const lost = ofKind(valuesOf(confirms), "capacity_lost");
          const won = ofKind(valuesOf(acquirers), "acquired");
          const refused = ofKind(valuesOf(acquirers), "insufficient_capacity");
          const usage = await usageOf(admin, tripId);
          const errorCount =
            errorsOf(confirms).length +
            errorsOf(acquirers).length +
            errorsOf(expiring).length +
            errorsOf(sweepOutcomes).length;
          rounds.push(
            stats(
              mine.length + others + expirers + 1,
              confirmed.length + won.length,
              lost.length + refused.length,
              errorCount,
              [usage],
            ),
          );
          tally.reacquired += confirmed.length;
          tally.lost += lost.length;
          tally.acquired += won.length;

          expect(errorCount).toBe(0);
          expect(confirmed.length + lost.length).toBe(mine.length);
          expect(won.length + refused.length).toBe(others);
          // Ten seats, every attempt wants two, and every old hold expired first.
          expect(confirmed.length + won.length).toBe(5);
          expect(confirmed.every((c) => c.reacquired && c.hold.state === "confirmed")).toBe(true);
          expect(lost.every((l) => l.reason === "no_capacity" && l.hold.state === "expired")).toBe(
            true,
          );
          expect(usage).toMatchObject({ counted: 10, live: 10, countedHolds: 5 });
          const history = await checkHistories(admin, [
            ...mine.map((h) => h.id),
            ...won.map((w) => w.hold.id),
          ]);
          expect(history.problems).toEqual([]);
          for (const c of confirmed) {
            expect(history.actions.get(c.hold.id)).toEqual([
              "hold.acquired",
              "hold.expired",
              "hold.confirmed",
            ]);
          }
          for (const l of lost) {
            expect(history.actions.get(l.hold.id)).toEqual(["hold.acquired", "hold.expired"]);
          }
        }
      } finally {
        reportRace(
          "confirm vs expire: 5 due party-2 holds confirming, party-2 acquirers, 2 expirers, 1 sweep",
          rounds,
          tally,
        );
      }
    },
    raceTimeout(60_000),
  );

  it(
    "settles a late charter confirmation against other owners and sweeps without a second boat",
    async () => {
      const rounds: RoundStats[] = [];
      const tally = { confirmerWon: 0, acquirerWon: 0 };
      try {
        for (let round = 0; round < RACE_ROUNDS; round++) {
          const { tenantId, tripId } = await trips.charter();
          const mine = await acquired(tenantId, tripId, 3);
          await expireByClock(admin, [mine.id]);
          const expirers = 2;
          const others = RACE_SESSIONS - 1 - expirers;
          const start = barrier(1 + others + expirers);
          const acquirerDelay = STAGGER_MS[round % STAGGER_MS.length] ?? 0;
          const sweeps = whenOpen(start, () => Promise.all([sweepRun("late-boat", 1)]));
          const [confirms, acquirers, expiring] = await Promise.all([
            serviceRace(tenantId, 1, start, (trx, ctx) =>
              confirmHold(trx, ctx, { holdId: mine.id, ownerRef: mine.ownerRef }),
            ),
            serviceRace(tenantId, others, start, async (trx, ctx, i) => {
              await sleep(acquirerDelay);
              return acquire(trx, ctx, tripId, partyOf(i, 2, 6));
            }),
            serviceRace(tenantId, expirers, start, (trx, ctx) =>
              expireDueHolds(trx, ctx, { limit: 1 }),
            ),
          ]);
          const sweepOutcomes = await sweeps;
          const confirmed = ofKind(valuesOf(confirms), "confirmed");
          const lost = ofKind(valuesOf(confirms), "capacity_lost");
          const won = ofKind(valuesOf(acquirers), "acquired");
          const usage = await usageOf(admin, tripId);
          const errorCount =
            errorsOf(confirms).length +
            errorsOf(acquirers).length +
            errorsOf(expiring).length +
            errorsOf(sweepOutcomes).length;
          rounds.push(
            stats(
              1 + others + expirers + 1,
              confirmed.length + won.length,
              lost.length + (others - won.length),
              errorCount,
              [usage],
            ),
          );
          tally.confirmerWon += confirmed.length;
          tally.acquirerWon += won.length;

          expect(errorCount).toBe(0);
          expect(confirmed.length + won.length).toBe(1);
          expect(confirmed.length + lost.length).toBe(1);
          expect(usage).toMatchObject({ counted: 6, countedHolds: 1, wholeBoats: 1 });
          const history = await checkHistories(admin, [mine.id, ...won.map((w) => w.hold.id)]);
          expect(history.problems).toEqual([]);
          expect(history.actions.get(mine.id)?.slice(0, 2)).toEqual([
            "hold.acquired",
            "hold.expired",
          ]);
        }
      } finally {
        reportRace(
          "confirm vs expire: one due charter hold confirming, acquirers, sweeps",
          rounds,
          tally,
        );
      }
    },
    raceTimeout(60_000),
  );

  // Release and acquire in one transaction ------------------------------------------

  it(
    "lets an owner release and re-acquire on one trip in one transaction without deadlock or theft",
    async () => {
      const rounds: RoundStats[] = [];
      try {
        for (let round = 0; round < RACE_ROUNDS; round++) {
          const { tenantId, tripId } = await trips.shared();
          const swappers: Hold[] = [];
          for (let k = 0; k < 5; k++) swappers.push(await acquired(tenantId, tripId, 2));
          const others = RACE_SESSIONS - swappers.length;
          const start = barrier(swappers.length + others);
          const [swaps, plain] = await Promise.all([
            serviceRace(tenantId, swappers.length, start, async (trx, ctx, i) => {
              const h = swappers[i];
              if (!h) throw new Error("no hold");
              const released = await releaseHold(trx, ctx, {
                holdId: h.id,
                ownerRef: h.ownerRef,
                reason: "party changed",
              });
              const again = await acquire(trx, ctx, tripId, 2);
              return { released, again };
            }),
            serviceRace(tenantId, others, start, (trx, ctx, i) =>
              acquire(trx, ctx, tripId, partyOf(i, 1, 2)),
            ),
          ]);
          const usage = await usageOf(admin, tripId);
          const swapValues = valuesOf(swaps);
          const plainWon = ofKind(valuesOf(plain), "acquired");
          const errorCount = errorsOf(swaps).length + errorsOf(plain).length;
          rounds.push(
            stats(
              swappers.length + others,
              swapValues.filter((s) => s.again.kind === "acquired").length + plainWon.length,
              ofKind(valuesOf(plain), "insufficient_capacity").length,
              errorCount,
              [usage],
            ),
          );

          expect(errorsOf(swaps)).toEqual([]);
          expect(errorsOf(plain)).toEqual([]);
          expect(swapValues.map((s) => [s.released.kind, s.again.kind])).toEqual(
            Array(swappers.length).fill(["released", "acquired"]),
          );
          // Each swapper held the trip lock from its release to its commit.
          expect(plainWon).toEqual([]);
          expect(usage).toMatchObject({ counted: 10, countedHolds: 5 });
          const fresh = swapValues.flatMap((s) =>
            s.again.kind === "acquired" ? [s.again.hold.id] : [],
          );
          const history = await checkHistories(admin, [...swappers.map((h) => h.id), ...fresh]);
          expect(history.problems).toEqual([]);
        }
      } finally {
        reportRace("release then acquire in one transaction vs plain acquirers", rounds);
      }
    },
    raceTimeout(40_000),
  );

  // Isolation levels ---------------------------------------------------------------

  it(
    "never lets a REPEATABLE READ or SERIALIZABLE session take a seat, even when racing",
    async () => {
      const rounds: RoundStats[] = [];
      const strictRefusals = { sqlstate25000: 0, sqlstate40001: 0, insufficientCapacity: 0 };
      const levels: Level[] = ["read committed", "repeatable read", "serializable"];
      try {
        for (let round = 0; round < RACE_ROUNDS; round++) {
          const { tenantId, tripId } = await trips.shared();
          await acquired(tenantId, tripId, 8);
          await acquired(tenantId, tripId, 1);
          const n = RACE_SESSIONS;
          const start = barrier(n);
          const level = (i: number) => levels[i % levels.length] ?? "read committed";
          const outcomes: Outcome<AcquireHoldResult>[] = await Promise.all(
            Array.from({ length: n }, (_, i) =>
              settle(
                inLevel(level(i), tenantId, async (trx, ctx) => {
                  await start.arrive();
                  return acquire(trx, ctx, tripId, 1);
                }),
              ),
            ),
          );
          const usage = await usageOf(admin, tripId);
          const byLevel = (l: Level) => outcomes.filter((_, i) => level(i) === l);
          const rc = byLevel("read committed");
          const strict = [...byLevel("repeatable read"), ...byLevel("serializable")];
          const strictWon = strict.filter((o) => o.ok && o.value.kind === "acquired");
          const strictUnexpected = strict.filter(
            (o) =>
              (o.ok && o.value.kind !== "insufficient_capacity") ||
              (!o.ok && o.code !== "25000" && o.code !== "40001"),
          );
          const won = rc.filter((o) => o.ok && o.value.kind === "acquired");
          for (const o of strict) {
            if (o.ok && o.value.kind === "insufficient_capacity") {
              strictRefusals.insufficientCapacity += 1;
            } else if (!o.ok && o.code === "25000") strictRefusals.sqlstate25000 += 1;
            else if (!o.ok && o.code === "40001") strictRefusals.sqlstate40001 += 1;
          }
          rounds.push(
            stats(
              n,
              won.length + strictWon.length,
              n - won.length - strictWon.length - strictUnexpected.length,
              strictUnexpected.length + errorsOf(rc).length,
              [usage],
            ),
          );

          expect(strictWon).toEqual([]);
          expect(strictUnexpected).toEqual([]);
          expect(errorsOf(rc)).toEqual([]);
          expect(won).toHaveLength(1);
          expect(usage).toMatchObject({ counted: 10, countedHolds: 3 });
        }
      } finally {
        reportRace(
          "isolation: RC, RR, and SERIALIZABLE sessions for the last seat",
          rounds,
          strictRefusals,
        );
      }
    },
    raceTimeout(40_000),
  );

  // Cancellation -------------------------------------------------------------------

  it(
    "lets nothing take or confirm capacity on a trip after its cancellation commits",
    async () => {
      const rounds: RoundStats[] = [];
      try {
        for (let round = 0; round < RACE_ROUNDS; round++) {
          const { tenantId, tripId } = await trips.shared();
          const active: Hold[] = [];
          for (let k = 0; k < 4; k++) active.push(await acquired(tenantId, tripId, 1));
          const confirmers = active.length;
          const acquirers = RACE_SESSIONS - confirmers - 1;
          const start = barrier(confirmers + acquirers + 1);
          // Without a head start the cancellation, which reads the trip first,
          // queues behind everyone. In later rounds it goes first.
          const othersDelay = STAGGER_MS[round % STAGGER_MS.length] ?? 0;
          const [cancel, confirms, acquires] = await Promise.all([
            serviceRace(tenantId, 1, start, (trx, ctx) =>
              changeTripSalesState(trx, ctx, {
                tripId,
                to: "canceled",
                reason: "weather",
                now: new Date(),
              }),
            ),
            serviceRace(tenantId, confirmers, start, async (trx, ctx, i) => {
              const h = active[i];
              if (!h) throw new Error("no hold");
              await sleep(othersDelay);
              return confirmHold(trx, ctx, { holdId: h.id, ownerRef: h.ownerRef });
            }),
            serviceRace(tenantId, acquirers, start, async (trx, ctx) => {
              await sleep(othersDelay);
              return acquire(trx, ctx, tripId, 1);
            }),
          ]);
          const usage = await usageOf(admin, tripId);
          const canceled = valuesOf(cancel)[0];
          const confirmValues = valuesOf(confirms);
          const acquireValues = valuesOf(acquires);
          const errorCount =
            errorsOf(cancel).length + errorsOf(confirms).length + errorsOf(acquires).length;
          rounds.push(
            stats(
              confirmers + acquirers + 1,
              ofKind(confirmValues, "confirmed").length + ofKind(acquireValues, "acquired").length,
              ofKind(confirmValues, "capacity_lost").length +
                ofKind(acquireValues, "not_bookable").length +
                ofKind(acquireValues, "insufficient_capacity").length,
              errorCount,
              [usage],
            ),
          );

          expect(errorCount).toBe(0);
          const after = await holdsOnTrip(admin, tripId);
          const seats = (state: string) =>
            after.filter((h) => h.state === state).reduce((s, h) => s + h.seats, 0);
          // Since G2.7 a trip with a confirmed booking cannot be canceled. Either
          // a confirmation took the trip's lock first and the cancellation was
          // refused, or the cancellation went first and every later confirmation
          // lost its capacity.
          if (canceled?.kind === "has_bookings") {
            expect(usage.salesState).toBe("published");
            expect(seats("confirmed")).toBeGreaterThan(0);
            for (const r of confirmValues) expect(r.kind).toBe("confirmed");
            for (const r of acquireValues) {
              expect(["acquired", "insufficient_capacity"]).toContain(r.kind);
            }
          } else {
            if (canceled?.kind !== "changed") throw new Error(`cancel: ${canceled?.kind}`);
            // What the cancellation saw at its commit point is all there ever is.
            const seen = canceled.trip.capacity as { held?: number; confirmed?: number };
            expect(seen.confirmed).toBe(0);
            expect(seats("confirmed")).toBe(0);
            expect(seats("active")).toBe(seen.held);
            expect(usage.salesState).toBe("canceled");
            for (const r of confirmValues) {
              expect(r.kind).toBe("capacity_lost");
              if (r.kind === "capacity_lost") expect(r.reason).toBe("trip_canceled");
            }
            for (const r of acquireValues) {
              expect(["acquired", "not_bookable", "insufficient_capacity"]).toContain(r.kind);
              if (r.kind === "not_bookable") expect(r.reason).toBe("trip_canceled");
            }
          }
          const history = await checkHistories(
            admin,
            after.map((h) => h.id),
          );
          expect(history.problems).toEqual([]);
        }
      } finally {
        reportRace("cancel vs confirms and acquires", rounds);
      }
    },
    raceTimeout(40_000),
  );

  // Reacquisition, with and without the service ---------------------------------------

  it(
    "keeps raw reacquisitions and raw inserts that bypass the service to the seats left",
    async () => {
      const rounds: RoundStats[] = [];
      try {
        for (let round = 0; round < RACE_ROUNDS; round++) {
          const { tenantId, tripId } = await trips.shared();
          const late: Hold[] = [];
          for (let k = 0; k < 5; k++) late.push(await acquired(tenantId, tripId, 2));
          await expireByClock(
            admin,
            late.map((h) => h.id),
          );
          // Write the expiry down, then let four seats be taken by live holds.
          const swept = await inTenant(runtime.db, tenantId, (trx, ctx) =>
            expireDueHolds(trx, ctx, { limit: 1000 }),
          );
          expect(swept.expired.map((h) => h.id)).toEqual(
            expect.arrayContaining(late.map((h) => h.id)),
          );
          await rawPrefill(tenantId, tripId, [1, 1, 1, 1]);
          const n = RACE_SESSIONS;
          const isReacquire = (i: number) => i < late.length;
          const outcomes = await rawRace(tenantId, n, barrier(n), (tx, i) => {
            const h = late[i];
            return isReacquire(i) && h
              ? tx`update public.capacity_holds set state = 'confirmed' where id = ${h.id}
                   returning id, kind, seats`
              : rawInsert(tx, tenantId, tripId, 1);
          });
          const usage = await usageOf(admin, tripId);
          const errors = errorsOf(outcomes);
          const refused = errors.filter(
            (e) => e.code === "23514" && e.constraint === "capacity_holds_capacity",
          );
          rounds.push(
            stats(n, n - errors.length, refused.length, errors.length - refused.length, [usage]),
          );

          expect(refused).toHaveLength(errors.length);
          expect(usage.counted).toBeLessThanOrEqual(10);
          const won = outcomes.reduce((s, o, i) => s + (o.ok ? (isReacquire(i) ? 2 : 1) : 0), 0);
          expect(usage.counted).toBe(4 + won);
          const finalRemaining = 10 - usage.counted;
          outcomes.forEach((o, i) => {
            if (!o.ok) expect(isReacquire(i) ? 2 : 1).toBeGreaterThan(finalRemaining);
          });
        }
      } finally {
        reportRace("raw reacquire (5 expired party-2) and raw inserts into 6 free seats", rounds);
      }
    },
    raceTimeout(40_000),
  );

  it(
    "lets only one of several former holders of a charter win it back, through the service or the database",
    async () => {
      const rounds: RoundStats[] = [];
      const tally = { reacquired: 0, newHold: 0 };
      try {
        for (let round = 0; round < RACE_ROUNDS; round++) {
          const { tenantId, tripId } = await trips.charter();
          // Five owners held the boat one after another; each lost it to the next.
          // The first four are stored expired; the last is past its time but unswept.
          const former: Hold[] = [];
          for (let k = 0; k < 5; k++) {
            const h = await acquired(tenantId, tripId, 2 + (k % 5));
            await expireByClock(admin, [h.id]);
            former.push(h);
          }
          const rawTargets = former.slice(0, 2);
          const serviceTargets = former.slice(2);
          const others = RACE_SESSIONS - former.length;
          const start = barrier(former.length + others);
          const acquirerDelay = STAGGER_MS[round % STAGGER_MS.length] ?? 0;
          const [raws, confirms, acquirers] = await Promise.all([
            rawRace(tenantId, rawTargets.length, start, (tx, i) => {
              const h = rawTargets[i];
              if (!h) throw new Error("no hold");
              return tx`update public.capacity_holds set state = 'confirmed'
                         where id = ${h.id} and state = 'expired' returning id`;
            }),
            serviceRace(tenantId, serviceTargets.length, start, (trx, ctx, i) => {
              const h = serviceTargets[i];
              if (!h) throw new Error("no hold");
              return confirmHold(trx, ctx, { holdId: h.id, ownerRef: h.ownerRef });
            }),
            serviceRace(tenantId, others, start, async (trx, ctx, i) => {
              await sleep(acquirerDelay);
              return acquire(trx, ctx, tripId, partyOf(i, 2, 6));
            }),
          ]);
          const usage = await usageOf(admin, tripId);
          const confirmed = ofKind(valuesOf(confirms), "confirmed");
          const lost = ofKind(valuesOf(confirms), "capacity_lost");
          const won = ofKind(valuesOf(acquirers), "acquired");
          const rawOk = valuesOf(raws).filter((r) => r.length === 1);
          const rawErrors = errorsOf(raws);
          const rawUnexpected = [
            ...rawErrors.filter(
              (e) =>
                !(e.code === "23514" && e.constraint === "capacity_holds_capacity") &&
                !(e.code === "23505" && e.constraint === "capacity_holds_one_whole_boat"),
            ),
            ...valuesOf(raws).filter((r) => r.length !== 1),
          ];
          const errorCount =
            errorsOf(confirms).length + errorsOf(acquirers).length + rawUnexpected.length;
          rounds.push(
            stats(
              former.length + others,
              confirmed.length + won.length + rawOk.length,
              lost.length + (others - won.length) + rawErrors.length - rawUnexpected.length,
              errorCount,
              [usage],
            ),
          );
          tally.reacquired += confirmed.length + rawOk.length;
          tally.newHold += won.length;

          expect(errorCount).toBe(0);
          expect(confirmed.length + won.length + rawOk.length).toBe(1);
          expect(usage).toMatchObject({ counted: 6, countedHolds: 1, wholeBoats: 1 });
          const stored = await holdsOnTrip(admin, tripId);
          expect(
            stored.filter((h) => h.state === "active" || h.state === "confirmed"),
          ).toHaveLength(1);
          expect(lost.every((l) => l.reason === "no_capacity")).toBe(true);
        }
      } finally {
        reportRace(
          "charter won back: 2 former holders raw, 3 through the service, and acquirers",
          rounds,
          tally,
        );
      }
    },
    raceTimeout(40_000),
  );

  // A storm on one trip --------------------------------------------------------------

  it(
    "keeps the invariant at every instant of a storm of acquires, replays, confirms, releases, and expiries",
    async () => {
      const rounds: RoundStats[] = [];
      const extra = { ops: 0, samples: 0, maxCounted: 0, maxLive: 0, violationsSeen: 0 };
      const OPS = 5;
      try {
        for (let round = 0; round < RACE_ROUNDS; round++) {
          const { tenantId, tripId } = await trips.shared();
          const known: Hold[] = [];
          const workers = RACE_SESSIONS - 4;
          const counts = {
            acquired: 0,
            refused: 0,
            confirmed: 0,
            released: 0,
            errors: [] as string[],
            unexpected: [] as string[],
          };
          let storming = true;
          // An admin observer samples the stored and live sums while the storm runs.
          const observer = (async () => {
            const seen: TripUsage[] = [];
            while (storming) {
              seen.push(await usageOf(admin, tripId));
              await sleep(15);
            }
            return seen;
          })();
          const pick = (next: () => number) => known[Math.floor(next() * known.length)];
          const one = async (next: () => number) => {
            const roll = next();
            const target = pick(next);
            if (roll < 0.35 || !target) {
              const r = await settle(
                inTenant(runtime.db, tenantId, (trx, ctx) =>
                  acquire(trx, ctx, tripId, 1 + Math.floor(next() * 4)),
                ),
              );
              if (!r.ok) counts.errors.push(`acquire ${r.code} ${r.message}`);
              else if (r.value.kind === "acquired") {
                counts.acquired += 1;
                known.push(r.value.hold);
              } else if (r.value.kind === "insufficient_capacity") counts.refused += 1;
              else counts.unexpected.push(`acquire ${r.value.kind}`);
            } else if (roll < 0.45) {
              const r = await settle(
                inTenant(runtime.db, tenantId, (trx, ctx) =>
                  acquire(trx, ctx, tripId, target.partySize, target.ownerRef),
                ),
              );
              if (!r.ok) counts.errors.push(`replay ${r.code} ${r.message}`);
              else if (r.value.kind !== "existing" || r.value.hold.id !== target.id) {
                counts.unexpected.push(`replay ${r.value.kind}`);
              }
            } else if (roll < 0.65) {
              const r: Outcome<ConfirmHoldResult> = await settle(
                inTenant(runtime.db, tenantId, (trx, ctx) =>
                  confirmHold(trx, ctx, { holdId: target.id, ownerRef: target.ownerRef }),
                ),
              );
              if (!r.ok) counts.errors.push(`confirm ${r.code} ${r.message}`);
              else if (r.value.kind === "confirmed") counts.confirmed += 1;
              else if (r.value.kind === "capacity_lost" && r.value.reason !== "no_capacity") {
                counts.unexpected.push(`confirm lost ${r.value.reason}`);
              } else if (r.value.kind === "not_found") counts.unexpected.push("confirm not_found");
            } else if (roll < 0.8) {
              const r: Outcome<ReleaseHoldResult> = await settle(
                inTenant(runtime.db, tenantId, (trx, ctx) =>
                  releaseHold(trx, ctx, { holdId: target.id, ownerRef: target.ownerRef }),
                ),
              );
              if (!r.ok) counts.errors.push(`release ${r.code} ${r.message}`);
              else if (r.value.kind === "released") counts.released += 1;
              else if (r.value.kind === "not_found") counts.unexpected.push("release not_found");
            } else if (roll < 0.9) {
              const r = await settle(expireByClock(admin, [target.id], 1));
              if (!r.ok) counts.errors.push(`backdate ${r.code} ${r.message}`);
            } else if (roll < 0.95) {
              const r = await settle(
                inTenant(runtime.db, tenantId, (trx, ctx) =>
                  expireDueHolds(trx, ctx, { limit: 5 }),
                ),
              );
              if (!r.ok) counts.errors.push(`expire ${r.code} ${r.message}`);
            } else {
              const r = await sweepRun("storm", 3);
              if (!r.ok) counts.errors.push(`sweep ${r.code} ${r.message}`);
              else if (r.value.failedTenants > 0) counts.errors.push("sweep tenant failed");
            }
          };
          const start = barrier(workers);
          await Promise.all(
            Array.from({ length: workers }, async (_, w) => {
              const next = prng(round * 1000 + w + 1);
              await start.arrive();
              for (let k = 0; k < OPS; k++) await one(next);
            }),
          );
          storming = false;
          const samples = await observer;
          const usage = await usageOf(admin, tripId);
          expect(samples.length).toBeGreaterThan(0);
          const violations = oversold([...samples, usage]);
          extra.ops += workers * OPS;
          extra.samples += samples.length;
          extra.maxCounted = Math.max(extra.maxCounted, ...samples.map((s) => s.counted));
          extra.maxLive = Math.max(extra.maxLive, ...samples.map((s) => s.live));
          extra.violationsSeen += violations.length;
          rounds.push({
            sessions: workers,
            successes: counts.acquired,
            refusals: counts.refused,
            errors: counts.errors.length + counts.unexpected.length,
            oversell: violations.length,
          });

          expect(counts.errors).toEqual([]);
          expect(counts.unexpected).toEqual([]);
          expect(violations).toEqual([]);
          const holds = await holdsOnTrip(admin, tripId);
          const history = await checkHistories(
            admin,
            holds.map((h) => h.id),
          );
          expect(history.problems).toEqual([]);
          const audited = (action: string) =>
            history.audits.filter((a) => a.action === action).length;
          expect(audited("hold.acquired")).toBe(counts.acquired);
          expect(audited("hold.confirmed")).toBe(counts.confirmed);
          expect(audited("hold.released")).toBe(counts.released);
          expect(holds).toHaveLength(counts.acquired);
        }
      } finally {
        reportRace(
          "storm: acquire, replay, confirm, release, backdate, expire, sweep on one trip",
          rounds,
          extra,
        );
      }
    },
    raceTimeout(120_000),
  );

  // Every trip this file touched ----------------------------------------------------

  it("leaves no trip of any tenant this file built over capacity", async () => {
    const usage = await usageOfTenants(admin, trips.tenantIds());
    expect(usage.length).toBeGreaterThan(0);
    expect(oversold(usage)).toEqual([]);
  });
});
