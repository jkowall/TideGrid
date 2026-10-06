/**
 * G2.7 adversarial races against PostgreSQL. Every racer runs on its own
 * connection as tidegrid_app. Checkout racers wait at a barrier inside their
 * open transactions, so every snapshot predates every write; webhook, cancel,
 * and sweep racers start together from a gate, some with head starts so both
 * orders occur. Each race runs RACE_ROUNDS rounds on fresh trips, checks every
 * returned result, the stored capacity invariant, and the tenant's whole
 * ledger, and prints one RACE_STATS line before it asserts.
 *
 * Three blocks. The capacity races run concurrently, each barrier race on a
 * pool of its own. The sweep races run concurrently, each in its own tenant, so
 * no sweep reaches another race's checkouts. The deterministic reproduction
 * runs alone, because it counts lock waiters across the database.
 */
import { createDb, type TenantContext, type TenantTransaction } from "@tidegrid/database";
import type {} from "@tidegrid/database/global-setup";
import { sweepExpiredHolds } from "@tidegrid/domain-inventory";
import { tripAllocator } from "@tidegrid/domain-inventory/testing";
import postgres from "postgres";
import { afterAll, beforeAll, describe, inject, it } from "vitest";
import {
  type CreateCheckoutResult,
  cancelCheckoutSession,
  createCheckoutSession,
  MAX_OPEN_CHECKOUTS_PER_CLIENT,
} from "../index.ts";
import {
  type CheckoutFixture,
  createCheckoutFixture,
  fakeProvider,
  newSecret,
  quoteFor,
} from "../test-fixtures.ts";
import {
  asGuest,
  auditCount,
  auditLedger,
  backdateMany,
  barrier,
  checkoutInput,
  type Db,
  daysFor,
  deliver,
  describeOpened,
  errorsOf,
  expireTenant,
  gate,
  type Opened,
  type Outcome,
  openCheckout,
  outcomeOf,
  oversold,
  type Quote,
  RACE_ROUNDS,
  RACE_SESSIONS,
  type RoundStats,
  type Runtime,
  raceTimeout,
  reportRace,
  type Sql,
  sessionTrail,
  settle,
  settleFake,
  sleep,
  startAt,
  stateOf,
  tally,
  usageOfTrips,
  valuesOf,
  type World,
} from "./harness.ts";

const env = inject("integrationDb");

let admin: Sql;
let runtime: Runtime;
let world: World;
/** A: capacity races. S: success against the sweep. H: sweeps at once. D: the sweep against late payments and new checkouts. R and Q: the two mirrored trials of the deterministic reproduction. */
let A: CheckoutFixture;
let S: CheckoutFixture;
let H: CheckoutFixture;
let D: CheckoutFixture;
let R: CheckoutFixture;
let Q: CheckoutFixture;
let tripsA: ReturnType<typeof tripAllocator>;
let tripsS: ReturnType<typeof tripAllocator>;
let tripsH: ReturnType<typeof tripAllocator>;
let tripsD: ReturnType<typeof tripAllocator>;

const pairs = Math.max(3, Math.floor(RACE_SESSIONS / 2));

beforeAll(async () => {
  if (!env) return;
  admin = postgres(env.adminUrl, { max: 8, onnotice: () => {} });
  runtime = createDb(env.runtimeUrl, { max: RACE_SESSIONS * 2 + 12 });
  world = { admin, db: runtime.db, provider: fakeProvider(runtime.db) };
  [A, S, H, D, R, Q] = await Promise.all([
    createCheckoutFixture(admin, runtime.db, "advra", { days: daysFor(4 + pairs) }),
    createCheckoutFixture(admin, runtime.db, "advrs", { days: daysFor(pairs) }),
    createCheckoutFixture(admin, runtime.db, "advrh", { days: daysFor(3) }),
    createCheckoutFixture(admin, runtime.db, "advrd", { days: daysFor(1) }),
    createCheckoutFixture(admin, runtime.db, "advrr", { days: 4 }),
    createCheckoutFixture(admin, runtime.db, "advrq", { days: 4 }),
  ]);
  tripsA = tripAllocator(A);
  tripsS = tripAllocator(S);
  tripsH = tripAllocator(H);
  tripsD = tripAllocator(D);
});

afterAll(async () => {
  await runtime?.end();
  await admin?.end({ timeout: 5 });
});

async function problems(tenant: CheckoutFixture, tripIds: readonly string[]) {
  const usage = oversold(await usageOfTrips(admin, tripIds));
  return [
    ...(await auditLedger(admin, [tenant.id])),
    ...usage.map((u) => `trip ${u.tripId} oversold: ${JSON.stringify(u)}`),
  ];
}

/** A pool of its own for one barrier race, so concurrent races never starve each other. */
async function withPool<T>(fn: (db: Db) => Promise<T>): Promise<T> {
  if (!env) throw new Error("no database");
  const pool = createDb(env.runtimeUrl, { max: RACE_SESSIONS + 2 });
  try {
    return await fn(pool.db);
  } finally {
    await pool.end();
  }
}

/** `quotes.length` checkouts, each in its own transaction, released together at a barrier. */
async function checkoutRace(
  db: Db,
  tenant: CheckoutFixture,
  quotes: readonly Quote[],
  clientAddress: string | null = null,
): Promise<{ results: Outcome<CreateCheckoutResult>[]; secrets: string[] }> {
  const start = barrier(quotes.length);
  const secrets = quotes.map(() => newSecret());
  const results = await Promise.all(
    quotes.map((quote, i) =>
      settle(
        asGuest(db, tenant.id, async (trx: TenantTransaction, ctx: TenantContext) => {
          await start.arrive();
          return createCheckoutSession(
            trx,
            ctx,
            checkoutInput(quote, secrets[i] ?? newSecret(), clientAddress),
          );
        }),
      ),
    ),
  );
  return { results, secrets };
}

/** Pay at the provider and deliver the event, for every winner at once. */
async function payAll(winners: readonly Opened[]): Promise<string[]> {
  const handled = await Promise.all(
    winners.map(async (o) => deliver(world, (await settleFake(world, o, "succeeded")).body)),
  );
  return handled.map(outcomeOf);
}

async function winnersOf(
  tenant: CheckoutFixture,
  quotes: readonly Quote[],
  results: readonly Outcome<CreateCheckoutResult>[],
  secrets: readonly string[],
): Promise<Opened[]> {
  return Promise.all(
    results.flatMap((r, i) => {
      const quote = quotes[i];
      if (!r.ok || r.value.kind !== "created" || !quote) return [];
      return [
        describeOpened(
          world,
          tenant,
          quote,
          secrets[i] ?? "",
          r.value.session.id,
          r.value.session.amount,
          true,
        ),
      ];
    }),
  );
}

/** Wait until `n` backends wait on a lock; pg_locks is readable by every role. */
async function waitForLockWaiters(n: number, timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const [row] = await admin<{ n: number }[]>`
      select count(distinct pid)::int as n from pg_locks where not granted`;
    if ((row?.n ?? 0) >= n) return;
    if (Date.now() > deadline) {
      throw new Error(`only ${row?.n ?? 0} of ${n} sessions waited on a lock`);
    }
    await sleep(25);
  }
}

const describeErrors = (round: number, who: string, outcomes: readonly Outcome<unknown>[]) =>
  errorsOf(outcomes).map((e) => `round ${round}: ${who} ${e.code} ${e.message.split("\n")[0]}`);

describe.skipIf(!env).concurrent("G2.7 adversarial races: capacity and checkout", () => {
  it(
    "holds exactly the seats that are left when many guests check out the last seats at once",
    async ({ expect }) => {
      const rounds: RoundStats[] = [];
      const found: string[] = [];
      await withPool(async (db) => {
        for (let round = 0; round < RACE_ROUNDS; round++) {
          const tripId = tripsA.shared();
          const parties = Array.from({ length: RACE_SESSIONS }, (_, i) => (i % 2 === 0 ? 1 : 2));
          // Price every party first, while the trip has room; then seven of ten seats go.
          const [prefill, ...quotes] = await Promise.all([
            quoteFor(runtime.db, A.id, tripId, 7),
            ...parties.map((p) => quoteFor(runtime.db, A.id, tripId, p)),
          ]);
          if (!prefill) throw new Error("no prefill quote");
          await openCheckout(world, A, tripId, 7, { quote: prefill, ensure: false });
          const left = 3;

          const { results, secrets } = await checkoutRace(db, A, quotes);
          const kinds = valuesOf(results).map((r) => r.kind);
          const won = results.reduce(
            (n, r, i) => n + (r.ok && r.value.kind === "created" ? (parties[i] ?? 0) : 0),
            0,
          );
          const finalRemaining = left - won;
          if (won > left) found.push(`round ${round}: ${won} seats held of ${left}`);
          for (const [i, r] of results.entries()) {
            if (!r.ok || r.value.kind === "created") continue;
            const party = parties[i] ?? 0;
            if (r.value.kind !== "insufficient_capacity") {
              found.push(`round ${round} racer ${i}: ${r.value.kind}`);
            } else if (r.value.remaining >= party || r.value.remaining < finalRemaining) {
              found.push(
                `round ${round} racer ${i}: refused a party of ${party} with ${r.value.remaining} left, ${finalRemaining} at the end`,
              );
            }
          }
          const paid = await payAll(await winnersOf(A, quotes, results, secrets));
          if (paid.some((o) => o !== "confirmed")) found.push(`paid: ${paid.join(",")}`);
          const [usage] = await usageOfTrips(admin, [tripId]);
          if (usage?.counted !== 7 + won || usage?.confirmed !== won) {
            found.push(`round ${round} usage ${JSON.stringify(usage)} for ${won} won`);
          }
          found.push(
            ...(await problems(A, [tripId])),
            ...describeErrors(round, "checkout", results),
          );
          rounds.push({
            sessions: quotes.length,
            successes: kinds.filter((k) => k === "created").length,
            refusals: kinds.filter((k) => k === "insufficient_capacity").length,
            errors: errorsOf(results).length,
            oversell: oversold(usage ? [usage] : []).length,
          });
        }
      });
      reportRace("checkout_last_seats", rounds, { seatsLeft: 3 });
      expect(found).toEqual([]);
    },
    raceTimeout(60_000),
  );

  it(
    "lets exactly one guest hold a charter boat when many check it out at once",
    async ({ expect }) => {
      const rounds: RoundStats[] = [];
      const found: string[] = [];
      await withPool(async (db) => {
        for (let round = 0; round < RACE_ROUNDS; round++) {
          const tripId = tripsA.charter();
          const quotes = await Promise.all(
            Array.from({ length: RACE_SESSIONS }, (_, i) =>
              quoteFor(runtime.db, A.id, tripId, 2 + (i % 5), { charter: true }),
            ),
          );
          const { results, secrets } = await checkoutRace(db, A, quotes);
          const values = valuesOf(results);
          const created = values.filter((r) => r.kind === "created");
          const refused = values.filter(
            (r) => r.kind === "insufficient_capacity" && r.remaining === 0,
          );
          if (created.length !== 1) found.push(`round ${round}: ${created.length} won`);
          if (refused.length !== values.length - created.length) {
            found.push(`round ${round}: ${JSON.stringify(tally(values.map((v) => v.kind)))}`);
          }
          const paid = await payAll(await winnersOf(A, quotes, results, secrets));
          if (paid.some((o) => o !== "confirmed")) found.push(`paid: ${paid.join(",")}`);
          const [usage] = await usageOfTrips(admin, [tripId]);
          if (usage?.wholeBoats !== 1 || usage.counted !== 6 || usage.confirmed !== 6) {
            found.push(`round ${round} usage ${JSON.stringify(usage)}`);
          }
          found.push(
            ...(await problems(A, [tripId])),
            ...describeErrors(round, "checkout", results),
          );
          rounds.push({
            sessions: quotes.length,
            successes: created.length,
            refusals: refused.length,
            errors: errorsOf(results).length,
            oversell: oversold(usage ? [usage] : []).length,
          });
        }
      });
      reportRace("checkout_one_charter", rounds);
      expect(found).toEqual([]);
    },
    raceTimeout(60_000),
  );

  it(
    "opens one checkout per quote when many guests use one quote at once",
    async ({ expect }) => {
      const rounds: RoundStats[] = [];
      const found: string[] = [];
      await withPool(async (db) => {
        for (let round = 0; round < RACE_ROUNDS; round++) {
          const tripId = tripsA.shared();
          const quote = await quoteFor(runtime.db, A.id, tripId, 2);
          const { results } = await checkoutRace(
            db,
            A,
            Array.from({ length: RACE_SESSIONS }, () => quote),
          );
          const kinds = valuesOf(results).map((r) => r.kind);
          const created = kinds.filter((k) => k === "created").length;
          const reused = kinds.filter((k) => k === "quote_already_used").length;
          if (created !== 1 || reused !== RACE_SESSIONS - 1) {
            found.push(`round ${round}: ${JSON.stringify(tally(kinds))}`);
          }
          const [rows] = await admin<
            { sessions: number; holds: number; orders: number; payments: number }[]
          >`
            select (select count(*)::int from public.checkout_sessions
                     where quote_id = ${quote.quoteId}) as sessions,
                   (select count(*)::int from public.capacity_holds where trip_id = ${tripId}) as holds,
                   (select count(*)::int from public.orders where quote_id = ${quote.quoteId}) as orders,
                   (select count(*)::int from public.payments p
                      join public.orders o on o.id = p.order_id
                     where o.quote_id = ${quote.quoteId}) as payments`;
          if (
            rows?.sessions !== 1 ||
            rows.holds !== 1 ||
            rows.orders !== 1 ||
            rows.payments !== 1
          ) {
            found.push(`round ${round}: stored ${JSON.stringify(rows)}`);
          }
          found.push(
            ...(await problems(A, [tripId])),
            ...describeErrors(round, "checkout", results),
          );
          rounds.push({
            sessions: RACE_SESSIONS,
            successes: created,
            refusals: reused,
            errors: errorsOf(results).length,
            oversell: 0,
          });
        }
      });
      reportRace("checkout_quote_reuse", rounds);
      expect(found).toEqual([]);
    },
    raceTimeout(30_000),
  );

  it(
    "keeps one client address to three open checkouts when it opens many at once",
    async ({ expect }) => {
      const rounds: RoundStats[] = [];
      const found: string[] = [];
      await withPool(async (db) => {
        for (let round = 0; round < RACE_ROUNDS; round++) {
          const tripId = tripsA.shared();
          const address = `198.51.100.${20 + round}`;
          const quotes = await Promise.all(
            Array.from({ length: RACE_SESSIONS }, () => quoteFor(runtime.db, A.id, tripId, 1)),
          );
          const { results, secrets } = await checkoutRace(db, A, quotes, address);
          const kinds = valuesOf(results).map((r) => r.kind);
          const created = kinds.filter((k) => k === "created").length;
          const limited = kinds.filter((k) => k === "too_many_checkouts").length;
          if (created !== MAX_OPEN_CHECKOUTS_PER_CLIENT || limited !== RACE_SESSIONS - created) {
            found.push(`round ${round}: ${JSON.stringify(tally(kinds))}`);
          }
          if (round === 0) {
            // Canceling one makes room for that address; so does one that expired.
            const [first, second] = await winnersOf(A, quotes, results, secrets);
            if (!first || !second) throw new Error("no winners");
            const canceled = await asGuest(runtime.db, A.id, (trx, ctx) =>
              cancelCheckoutSession(trx, ctx, { sessionId: first.sessionId, secret: first.secret }),
            );
            if (canceled.kind !== "canceled") found.push(`cancel: ${canceled.kind}`);
            await openCheckout(world, A, tripId, 1, { clientAddress: address, ensure: false });
            await backdateMany(admin, [second.sessionId]);
            await openCheckout(world, A, tripId, 1, { clientAddress: address, ensure: false });
            const extra = await quoteFor(runtime.db, A.id, tripId, 1);
            const refused = await asGuest(runtime.db, A.id, (trx, ctx) =>
              createCheckoutSession(trx, ctx, checkoutInput(extra, newSecret(), address)),
            );
            if (refused.kind !== "too_many_checkouts") found.push(`fourth: ${refused.kind}`);
            // Another address is not limited by this one.
            await openCheckout(world, A, tripId, 1, {
              clientAddress: `198.51.100.${120 + round}`,
              ensure: false,
            });
          }
          found.push(
            ...(await problems(A, [tripId])),
            ...describeErrors(round, "checkout", results),
          );
          rounds.push({
            sessions: RACE_SESSIONS,
            successes: created,
            refusals: limited,
            errors: errorsOf(results).length,
            oversell: 0,
          });
        }
      });
      reportRace("checkout_client_limit", rounds, { limit: MAX_OPEN_CHECKOUTS_PER_CLIENT });
      expect(found).toEqual([]);
    },
    raceTimeout(40_000),
  );

  it(
    "ends a success racing the guest's cancel in exactly one booking or one refund",
    async ({ expect }) => {
      const rounds: RoundStats[] = [];
      const found: string[] = [];
      const orders: string[] = [];
      for (let round = 0; round < RACE_ROUNDS; round++) {
        const opened = await Promise.all(
          Array.from({ length: pairs }, () => openCheckout(world, A, tripsA.shared(), 1)),
        );
        const bodies = await Promise.all(opened.map((o) => settleFake(world, o, "succeeded")));
        const go = gate();
        // The webhook needs more round trips before it locks the checkout than
        // the cancel does, so the cancel starts later for two pairs in three.
        const pending = opened.map((o, i) => ({
          pay: startAt(go.opened, () => deliver(world, bodies[i]?.body ?? "")),
          cancel: startAt(
            go.opened,
            () =>
              asGuest(runtime.db, A.id, (trx, ctx) =>
                cancelCheckoutSession(trx, ctx, { sessionId: o.sessionId, secret: o.secret }),
              ),
            [0, 350, 700][i % 3],
          ),
        }));
        go.open();
        const settled = await Promise.all(
          pending.map(async (p) => ({ pay: await p.pay, cancel: await p.cancel })),
        );
        let errors = 0;
        let booked = 0;
        let refunded = 0;
        for (const [i, s] of settled.entries()) {
          const o = opened[i];
          if (!o) continue;
          if (!s.pay.ok || !s.cancel.ok) {
            errors += 1;
            found.push(
              `pair ${i}: ${s.pay.ok ? "" : s.pay.message} ${s.cancel.ok ? "" : s.cancel.message}`,
            );
            continue;
          }
          const pair = `${outcomeOf(s.pay.value)}+${s.cancel.value.kind}`;
          orders.push(pair);
          const state = await stateOf(admin, o.sessionId);
          if (pair === "confirmed+not_cancelable") {
            booked += 1;
            if (state.session !== "confirmed" || state.bookings !== 1 || state.refund !== null) {
              found.push(`pair ${i}: ${JSON.stringify(state)}`);
            }
          } else if (pair === "refund_required+canceled") {
            refunded += 1;
            if (
              state.session !== "unfulfilled" ||
              state.bookings !== 0 ||
              state.refund !== "succeeded" ||
              state.exceptions.join() !== "session_canceled"
            ) {
              found.push(`pair ${i}: ${JSON.stringify(state)}`);
            }
          } else {
            found.push(`pair ${i}: ${pair}`);
          }
        }
        found.push(
          ...(await problems(
            A,
            opened.map((o) => o.tripId),
          )),
        );
        rounds.push({
          sessions: pairs * 2,
          successes: booked,
          refusals: refunded,
          errors,
          oversell: oversold(
            await usageOfTrips(
              admin,
              opened.map((o) => o.tripId),
            ),
          ).length,
        });
      }
      reportRace("success_vs_guest_cancel", rounds, { orders: tally(orders) });
      expect(found).toEqual([]);
    },
    raceTimeout(40_000),
  );

  it(
    "gives a late payment no priority over a new checkout for one boat, and never both",
    async ({ expect }) => {
      const rounds: RoundStats[] = [];
      const found: string[] = [];
      const orders: string[] = [];
      for (let round = 0; round < Math.max(RACE_ROUNDS, 2) * 2; round++) {
        const tripId = tripsA.charter();
        const late = await openCheckout(world, A, tripId, 2, { charter: true });
        const body = (await settleFake(world, late, "succeeded")).body;
        await backdateMany(admin, [late.sessionId]);
        // Another guest prices the boat once the lapsed hold stops counting.
        const fresh = await quoteFor(runtime.db, A.id, tripId, 3, { charter: true });
        const go = gate();
        const pay = startAt(go.opened, () => deliver(world, body), round % 2 ? 0 : 300);
        const create = startAt(
          go.opened,
          () =>
            asGuest(runtime.db, A.id, (trx, ctx) =>
              createCheckoutSession(trx, ctx, checkoutInput(fresh, newSecret())),
            ),
          round % 2 ? 300 : 0,
        );
        go.open();
        const [paid, made] = await Promise.all([pay, create]);
        found.push(
          ...describeErrors(round, "webhook", [paid]),
          ...describeErrors(round, "new checkout", [made]),
        );
        if (paid.ok && made.ok) {
          const pair = `${outcomeOf(paid.value)}+${made.value.kind}`;
          orders.push(pair);
          if (
            pair !== "confirmed_reacquired+insufficient_capacity" &&
            pair !== "refund_required+created"
          ) {
            found.push(`round ${round}: ${pair}`);
          }
          const state = await stateOf(admin, late.sessionId);
          const expected =
            pair === "refund_required+created"
              ? { session: "unfulfilled", bookings: 0, refund: "succeeded" }
              : { session: "confirmed", bookings: 1, refund: null };
          if (
            state.session !== expected.session ||
            state.bookings !== expected.bookings ||
            state.refund !== expected.refund
          ) {
            found.push(`round ${round}: ${JSON.stringify(state)}`);
          }
        }
        const [usage] = await usageOfTrips(admin, [tripId]);
        if (usage?.wholeBoats !== 1 || usage.counted !== 6) {
          found.push(`round ${round}: usage ${JSON.stringify(usage)}`);
        }
        found.push(...(await problems(A, [tripId])));
        rounds.push({
          sessions: 2,
          successes: paid.ok && outcomeOf(paid.value) === "confirmed_reacquired" ? 1 : 0,
          refusals: paid.ok && outcomeOf(paid.value) === "refund_required" ? 1 : 0,
          errors: errorsOf([paid]).length + errorsOf([made]).length,
          oversell: oversold(usage ? [usage] : []).length,
        });
      }
      reportRace("late_payment_vs_new_checkout_one_boat", rounds, { orders: tally(orders) });
      expect(found).toEqual([]);
    },
    raceTimeout(40_000),
  );
});

describe.skipIf(!env).concurrent("G2.7 adversarial races: the sweep", () => {
  it(
    "lets late payments and new checkouts on one trip finish with no error when no sweep runs",
    async ({ expect }) => {
      // The control for the race below: the same contention without the
      // checkout sweep. Tenant A has no lapsed checkouts a sweep would reach.
      const rounds: RoundStats[] = [];
      const found: string[] = [];
      const outcomes: string[] = [];
      for (let round = 0; round < RACE_ROUNDS; round++) {
        const tripId = tripsA.shared();
        const quotes = await Promise.all(
          Array.from({ length: pairs }, () => quoteFor(runtime.db, A.id, tripId, 2)),
        );
        const lapsed = await Promise.all(
          Array.from({ length: 5 }, () => openCheckout(world, A, tripId, 2)),
        );
        const bodies = await Promise.all(lapsed.map((o) => settleFake(world, o, "succeeded")));
        await backdateMany(
          admin,
          lapsed.map((o) => o.sessionId),
        );
        const go = gate();
        const payments = bodies.map((b, i) =>
          startAt(go.opened, () => deliver(world, b.body), 40 + i * 50),
        );
        const creates = quotes.map((q, i) =>
          startAt(
            go.opened,
            () =>
              asGuest(runtime.db, A.id, (trx, ctx) =>
                createCheckoutSession(trx, ctx, checkoutInput(q, newSecret())),
              ),
            20 + i * 60,
          ),
        );
        go.open();
        const [paid, made] = await Promise.all([Promise.all(payments), Promise.all(creates)]);
        const errors = [
          ...describeErrors(round, "webhook", paid),
          ...describeErrors(round, "new checkout", made),
        ];
        const delivered = valuesOf(paid).map(outcomeOf);
        const created = valuesOf(made).map((r) => r.kind);
        outcomes.push(...delivered, ...created);
        const [usage] = await usageOfTrips(admin, [tripId]);
        const reacquired = delivered.filter((o) => o === "confirmed_reacquired").length;
        const opened = created.filter((c) => c === "created").length;
        if (
          usage &&
          (usage.confirmed !== 2 * reacquired || usage.counted !== 2 * (reacquired + opened))
        ) {
          found.push(`round ${round}: usage ${JSON.stringify(usage)}`);
        }
        found.push(...(await problems(A, [tripId])), ...errors);
        rounds.push({
          sessions: lapsed.length + quotes.length,
          successes: reacquired + opened,
          refusals: delivered.length - reacquired + created.length - opened,
          errors: errors.length,
          oversell: oversold(usage ? [usage] : []).length,
        });
      }
      reportRace("late_payments_and_new_checkouts_one_trip_no_sweep", rounds, {
        outcomes: tally(outcomes),
      });
      expect(found).toEqual([]);
    },
    raceTimeout(60_000),
  );

  it(
    "ends a late success racing the sweep for its checkout confirmed, directly or after expiring, with no error",
    async ({ expect }) => {
      const rounds: RoundStats[] = [];
      const found: string[] = [];
      const paths: string[] = [];
      for (let round = 0; round < RACE_ROUNDS; round++) {
        // One lapsed checkout per trip, so each success races the sweep for its own checkout.
        const opened = await Promise.all(
          Array.from({ length: pairs }, () => openCheckout(world, S, tripsS.shared(), 2)),
        );
        const bodies = await Promise.all(opened.map((o) => settleFake(world, o, "succeeded")));
        await backdateMany(
          admin,
          opened.map((o) => o.sessionId),
        );
        const go = gate();
        // Odd rounds start the sweep late, so early webhooks hold their checkouts first.
        const sweeps = [0, 120].map((delay) =>
          startAt(go.opened, () => expireTenant(runtime.db, S.id), delay + (round % 2) * 900),
        );
        const payments = bodies.map((b, i) =>
          startAt(go.opened, () => deliver(world, b.body), i * 100),
        );
        go.open();
        const [swept, paid] = await Promise.all([Promise.all(sweeps), Promise.all(payments)]);
        found.push(
          ...describeErrors(round, "sweep", swept),
          ...describeErrors(round, "webhook", paid),
        );
        const expiredBy = valuesOf(swept).flatMap((s) => s.expired);
        let direct = 0;
        let afterExpiry = 0;
        for (const [i, o] of opened.entries()) {
          const p = paid[i];
          if (p?.ok && outcomeOf(p.value) !== "confirmed_reacquired") {
            found.push(`checkout ${i}: ${outcomeOf(p.value)}`);
          }
          const trail = await sessionTrail(admin, o.sessionId);
          const state = await stateOf(admin, o.sessionId);
          const viaExpiry = trail.includes("checkout.session_expired");
          if (viaExpiry) afterExpiry += 1;
          else direct += 1;
          paths.push(viaExpiry ? "expired_then_confirmed" : "confirmed");
          const expected = [
            "checkout.session_opened",
            ...(viaExpiry ? ["checkout.session_expired"] : []),
            "checkout.session_confirmed",
          ];
          if (JSON.stringify(trail) !== JSON.stringify(expected)) {
            found.push(`checkout ${i}: trail ${trail.join(",")}`);
          }
          if (state.session !== "confirmed" || state.bookings !== 1 || state.reacquired !== true) {
            found.push(`checkout ${i}: ${JSON.stringify(state)}`);
          }
          const times = expiredBy.filter((id) => id === o.sessionId).length;
          if (times !== (viaExpiry ? 1 : 0)) {
            found.push(`checkout ${i}: expired ${times} times by the sweeps`);
          }
        }
        found.push(
          ...(await problems(
            S,
            opened.map((o) => o.tripId),
          )),
        );
        rounds.push({
          sessions: pairs + sweeps.length,
          successes: direct + afterExpiry,
          refusals: 0,
          errors: errorsOf(swept).length + errorsOf(paid).length,
          oversell: oversold(
            await usageOfTrips(
              admin,
              opened.map((o) => o.tripId),
            ),
          ).length,
        });
      }
      reportRace("success_vs_sweep_same_checkout", rounds, { paths: tally(paths) });
      expect(found).toEqual([]);
    },
    raceTimeout(40_000),
  );

  it(
    "expires each lapsed checkout once when several sweeps and the hold sweep run at once",
    async ({ expect }) => {
      const rounds: RoundStats[] = [];
      const found: string[] = [];
      for (let round = 0; round < RACE_ROUNDS; round++) {
        // Two lapsed checkouts on each of three trips.
        const tripIds = [tripsH.shared(), tripsH.shared(), tripsH.shared()];
        const opened = await Promise.all(
          tripIds.flatMap((t) => [
            openCheckout(world, H, t, 1, { ensure: false }),
            openCheckout(world, H, t, 2, { ensure: false }),
          ]),
        );
        await backdateMany(
          admin,
          opened.map((o) => o.sessionId),
        );
        const go = gate();
        const sweeps = [0, 0, 40].map((delay) =>
          startAt(go.opened, () => expireTenant(runtime.db, H.id, 2), delay),
        );
        const holdSweep = startAt(go.opened, () =>
          sweepExpiredHolds(runtime.db, { runId: `adv-hold-sweep-${round}` }),
        );
        go.open();
        const [swept, held] = await Promise.all([Promise.all(sweeps), holdSweep]);
        found.push(
          ...describeErrors(round, "sweep", swept),
          ...describeErrors(round, "hold sweep", [held]),
        );
        // Whatever the first wave left, more passes finish; nothing is expired twice.
        const all = valuesOf(swept).flatMap((s) => s.expired);
        for (let pass = 0; pass < 4; pass++) {
          all.push(...(await expireTenant(runtime.db, H.id)).expired);
        }
        for (const o of opened) {
          const times = all.filter((id) => id === o.sessionId).length;
          const state = await stateOf(admin, o.sessionId);
          if (times !== 1 || state.session !== "expired" || state.hold !== "expired") {
            found.push(`checkout ${o.sessionId}: expired ${times} times, ${JSON.stringify(state)}`);
          }
          if ((await auditCount(admin, o.sessionId, "checkout.session_expired")) !== 1) {
            found.push(`checkout ${o.sessionId}: expiry audited more than once`);
          }
          if ((await auditCount(admin, o.holdId, "hold.expired")) !== 1) {
            found.push(`hold ${o.holdId}: expiry audited more than once`);
          }
        }
        found.push(...(await problems(H, tripIds)));
        rounds.push({
          sessions: sweeps.length + 1,
          successes: opened.length,
          refusals: 0,
          errors: errorsOf(swept).length + errorsOf([held]).length,
          oversell: oversold(await usageOfTrips(admin, tripIds)).length,
        });
      }
      reportRace("sweeps_at_once", rounds);
      expect(found).toEqual([]);
    },
    raceTimeout(30_000),
  );

  it(
    "lets the sweep, late payments, and new checkouts on one trip all finish, with no error and no oversell",
    async ({ expect }) => {
      const rounds: RoundStats[] = [];
      const found: string[] = [];
      const errorsBy: string[] = [];
      const outcomes: string[] = [];
      for (let round = 0; round < RACE_ROUNDS; round++) {
        const tripId = tripsD.shared();
        // New guests price their parties while the trip has room.
        const quotes = await Promise.all(
          Array.from({ length: pairs }, () => quoteFor(runtime.db, D.id, tripId, 2)),
        );
        // Five parties of two fill the ten seats, pay at the provider, and lapse
        // together, before their events arrive.
        const lapsed = await Promise.all(
          Array.from({ length: 5 }, () => openCheckout(world, D, tripId, 2)),
        );
        const bodies = await Promise.all(lapsed.map((o) => settleFake(world, o, "succeeded")));
        await backdateMany(
          admin,
          lapsed.map((o) => o.sessionId),
        );
        const go = gate();
        const sweep = startAt(go.opened, () => expireTenant(runtime.db, D.id), (round % 2) * 100);
        const payments = bodies.map((b, i) =>
          startAt(go.opened, () => deliver(world, b.body), 40 + i * 50),
        );
        const creates = quotes.map((q, i) =>
          startAt(
            go.opened,
            () =>
              asGuest(runtime.db, D.id, (trx, ctx) =>
                createCheckoutSession(trx, ctx, checkoutInput(q, newSecret())),
              ),
            20 + i * 60,
          ),
        );
        go.open();
        const [swept, paid, made] = await Promise.all([
          sweep,
          Promise.all(payments),
          Promise.all(creates),
        ]);
        const errors = [
          ...describeErrors(round, "sweep", [swept]),
          ...describeErrors(round, "webhook", paid),
          ...describeErrors(round, "new checkout", made),
        ];
        errorsBy.push(
          ...errorsOf([swept]).map((e) => `sweep:${e.code}`),
          ...errorsOf(paid).map((e) => `webhook:${e.code}`),
          ...errorsOf(made).map((e) => `new_checkout:${e.code}`),
        );
        const delivered = valuesOf(paid).map(outcomeOf);
        const created = valuesOf(made).map((r) => r.kind);
        outcomes.push(...delivered, ...created);
        for (const o of delivered) {
          if (o !== "confirmed_reacquired" && o !== "refund_required") {
            found.push(`round ${round}: delivered ${o}`);
          }
        }
        for (const c of created) {
          if (c !== "created" && c !== "insufficient_capacity") {
            found.push(`round ${round}: created ${c}`);
          }
        }
        const [usage] = await usageOfTrips(admin, [tripId]);
        const reacquired = delivered.filter((o) => o === "confirmed_reacquired").length;
        const opened = created.filter((c) => c === "created").length;
        if (
          usage &&
          (usage.confirmed !== 2 * reacquired || usage.counted !== 2 * (reacquired + opened))
        ) {
          found.push(`round ${round}: usage ${JSON.stringify(usage)}`);
        }
        found.push(...(await problems(D, [tripId])), ...errors);
        rounds.push({
          sessions: 1 + lapsed.length + quotes.length,
          successes: reacquired + opened,
          refusals: delivered.length - reacquired + created.length - opened,
          errors: errors.length,
          oversell: oversold(usage ? [usage] : []).length,
        });
      }
      reportRace("sweep_vs_late_payments_and_new_checkouts_one_trip", rounds, {
        outcomes: tally(outcomes),
        errorsBy: tally(errorsBy),
      });
      expect(found).toEqual([]);
    },
    raceTimeout(60_000),
  );
});

describe.skipIf(!env)("G2.7 adversarial races: deterministic reproduction", () => {
  /**
   * One trial: two lapsed checkouts on one trip, opened in order; the sweep
   * reaches `lead` first (its checkout lapsed first). One extra session holds
   * the lead's hold row. Before the fix the sweep waited on that row while it
   * held the trailing checkout, and a new checkout for the trip, expiring the
   * trip's due holds in its own scan order, closed the cycle (40P01).
   *
   * Since the fix (lead's change after this suite's first run) the sweep never
   * waits: it finishes while the extra session still holds the row, expiring
   * the trailing checkout and leaving the lead's for the next run. The new
   * checkout then waits for the extra session alone, and the next sweep run
   * expires the lead's checkout. Each trial checks all three steps.
   */
  async function trial(tenant: CheckoutFixture, sweepTakesOlderFirst: boolean) {
    const tripId = tripAllocator(tenant).shared();
    const older = await openCheckout(world, tenant, tripId, 1, { ensure: false });
    const newer = await openCheckout(world, tenant, tripId, 1, { ensure: false });
    const [lead, trail] = sweepTakesOlderFirst ? [older, newer] : [newer, older];
    await admin`update public.checkout_sessions
      set expires_at = least(expires_at, now() - interval '20 seconds') where id = ${lead.sessionId}`;
    await admin`update public.checkout_sessions
      set expires_at = least(expires_at, now() - interval '10 seconds') where id = ${trail.sessionId}`;
    await admin`update public.capacity_holds
      set expires_at = least(expires_at, now() - interval '15 seconds')
     where id in ${admin([older.holdId, newer.holdId])}`;
    const quote = await quoteFor(runtime.db, tenant.id, tripId, 1);

    if (!env) throw new Error("no database");
    const holder = postgres(env.runtimeUrl, { max: 1, onnotice: () => {} });
    const locked = gate();
    const release = gate();
    const holding = settle(
      holder.begin(async (tx) => {
        await tx`select set_config('app.tenant_id', ${tenant.id}, true)`;
        await tx`select id from public.capacity_holds where id = ${lead.holdId} for update`;
        locked.open();
        await release.opened;
      }),
    );
    try {
      await locked.opened;
      // The sweep must finish while the row is still held: it never waits.
      let timer: ReturnType<typeof setTimeout> | undefined;
      const swept = await settle(
        Promise.race([
          expireTenant(runtime.db, tenant.id),
          new Promise<never>((_, reject) => {
            timer = setTimeout(
              () =>
                reject(
                  Object.assign(new Error("the sweep waited on a held row"), { code: "waited" }),
                ),
              15_000,
            );
          }),
        ]).finally(() => clearTimeout(timer)),
      );
      const checkout = settle(
        asGuest(runtime.db, tenant.id, (trx, ctx) =>
          createCheckoutSession(trx, ctx, checkoutInput(quote, newSecret())),
        ),
      );
      await waitForLockWaiters(1);
      release.open();
      const created = await checkout;
      const next = await settle(expireTenant(runtime.db, tenant.id));
      const states = await admin<{ id: string; state: string }[]>`
        select id, state from public.checkout_sessions
         where id in ${admin([lead.sessionId, trail.sessionId])}`;
      const stateOfSession = (id: string) => states.find((s) => s.id === id)?.state;
      return {
        tripId,
        result: {
          sweep: swept.ok
            ? { expired: swept.value.expired.length, skipped: swept.value.skipped.length }
            : { error: swept.code },
          checkout: created.ok ? created.value.kind : { error: created.code },
          nextSweep: next.ok ? { expired: next.value.expired.length } : { error: next.code },
          lead: stateOfSession(lead.sessionId),
          trail: stateOfSession(trail.sessionId),
        },
      };
    } finally {
      release.open();
      await holding;
      await holder.end({ timeout: 5 });
    }
  }

  it("does not deadlock the sweep against a new checkout that expires the same trip's holds", async ({
    expect,
  }) => {
    // Two trials with the sweep's order mirrored: whichever order the new
    // checkout's scan uses, one trial meets the sweep's order reversed.
    const olderFirst = await trial(R, true);
    const newerFirst = await trial(Q, false);
    const results = [olderFirst.result, newerFirst.result];
    reportRace(
      "sweep_vs_new_checkout_deterministic",
      results.map((r) => ({
        sessions: 2,
        successes: ("expired" in r.sweep ? 1 : 0) + (typeof r.checkout === "string" ? 1 : 0),
        refusals: 0,
        errors: ("error" in r.sweep ? 1 : 0) + (typeof r.checkout === "string" ? 0 : 1),
        oversell: 0,
      })),
      { results },
    );
    const expected = {
      sweep: { expired: 1, skipped: 1 },
      checkout: "created",
      nextSweep: { expired: 1 },
      lead: "expired",
      trail: "expired",
    };
    expect(results).toEqual([expected, expected]);
    expect([
      ...(await problems(R, [olderFirst.tripId])),
      ...(await problems(Q, [newerFirst.tripId])),
    ]).toEqual([]);
  });
});
