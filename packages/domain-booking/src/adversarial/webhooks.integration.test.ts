/**
 * G2.7 adversarial tests for the webhook path at the service level: one event
 * delivered many times at once, distinct success events for one payment at
 * once, a success and a failure racing, events out of order, events that do
 * not match their payment, and events checkout does not act on. Every event is
 * signed by the fake provider and verified, as the route does; the route's own
 * signature checks are in the API suite. Each test ends by checking the whole
 * tenant's ledger against the chain of custody.
 *
 * The tests run concurrently: each uses its own trips, nothing here sweeps,
 * and every committed state must pass the ledger check at any moment.
 */
import { createDb } from "@tidegrid/database";
import type {} from "@tidegrid/database/global-setup";
import { tripAllocator } from "@tidegrid/domain-inventory/testing";
import postgres from "postgres";
import { afterAll, beforeAll, describe, inject, it } from "vitest";
import { ensureProviderPayment, getCheckoutSession, listFinalizationExceptions } from "../index.ts";
import {
  type CheckoutFixture,
  createCheckoutFixture,
  fakeProvider,
  guestContext,
} from "../test-fixtures.ts";
import {
  asGuest,
  auditCount,
  auditLedger,
  bodyFor,
  daysFor,
  deliver,
  errorsOf,
  eventBody,
  fakeEventId,
  fakePaymentRef,
  gate,
  type Opened,
  openCheckout,
  outcomeOf,
  oversold,
  RACE_ROUNDS,
  RACE_SESSIONS,
  type RoundStats,
  type Runtime,
  raceTimeout,
  reportRace,
  type Sql,
  settleFake,
  startAt,
  stateOf,
  tally,
  usageOfTrips,
  valuesOf,
  type World,
} from "./harness.ts";

const env = inject("integrationDb");

describe.skipIf(!env).concurrent("G2.7 adversarial: webhook deliveries", () => {
  let admin: Sql;
  let runtime: Runtime;
  let world: World;
  let A: CheckoutFixture;
  let trips: ReturnType<typeof tripAllocator>;

  beforeAll(async () => {
    if (!env) return;
    admin = postgres(env.adminUrl, { max: 6, onnotice: () => {} });
    runtime = createDb(env.runtimeUrl, { max: RACE_SESSIONS * 3 + 10 });
    world = { admin, db: runtime.db, provider: fakeProvider(runtime.db) };
    A = await createCheckoutFixture(admin, runtime.db, "advwh", {
      days: daysFor(2 + Math.max(2, Math.floor(RACE_SESSIONS / 2))),
    });
    trips = tripAllocator(A);
  });

  afterAll(async () => {
    await runtime?.end();
    await admin?.end({ timeout: 5 });
  });

  async function inboxRows(eventId: string) {
    const rows = await admin<
      { id: string; processing_state: string; outcome: string | null; amount: number }[]
    >`
      select id, processing_state, outcome, amount from public.provider_events
       where event_id = ${eventId}`;
    return [...rows];
  }

  /** Ledger and capacity problems; an empty list is clean. */
  async function problems(tripIds: readonly string[] = []): Promise<string[]> {
    const usage = oversold(await usageOfTrips(admin, tripIds));
    return [
      ...(await auditLedger(admin, [A.id])),
      ...usage.map((u) => `trip ${u.tripId} oversold: ${JSON.stringify(u)}`),
    ];
  }

  it(
    "records and books once when one event arrives many times at once",
    async ({ expect }) => {
      const rounds: RoundStats[] = [];
      const outcomes: string[] = [];
      for (let round = 0; round < RACE_ROUNDS; round++) {
        const opened = await openCheckout(world, A, trips.shared(), 2);
        const { id: eventId, body } = await settleFake(world, opened, "succeeded");
        const go = gate();
        const pending = Array.from({ length: RACE_SESSIONS }, () =>
          startAt(go.opened, () => deliver(world, body)),
        );
        go.open();
        const results = await Promise.all(pending);
        const errors = errorsOf(results);
        const handled = valuesOf(results);
        outcomes.push(...handled.map(outcomeOf));
        const firsts = handled.filter((h) => h.kind === "processed" && !h.duplicate);
        rounds.push({
          sessions: RACE_SESSIONS,
          successes: firsts.length,
          refusals: handled.length - firsts.length,
          errors: errors.length,
          oversell: oversold(await usageOfTrips(admin, [opened.tripId])).length,
        });

        expect(errors).toEqual([]);
        expect(handled.map(outcomeOf)).toEqual(Array(RACE_SESSIONS).fill("confirmed"));
        expect(firsts).toHaveLength(1);
        const inbox = await inboxRows(eventId);
        expect(inbox).toEqual([
          expect.objectContaining({ processing_state: "processed", outcome: "confirmed" }),
        ]);
        expect(await stateOf(admin, opened.sessionId)).toMatchObject({
          session: "confirmed",
          hold: "confirmed",
          order: "paid",
          payment: "succeeded",
          bookings: 1,
          refund: null,
          exceptions: [],
        });
        const [evidence] = await admin<{ succeeded_event_id: string }[]>`
          select succeeded_event_id from public.payments where id = ${opened.paymentId}`;
        expect(evidence?.succeeded_event_id).toBe(inbox[0]?.id);
        expect(await auditCount(admin, opened.paymentId, "payment.succeeded")).toBe(1);
        expect(await auditCount(admin, opened.sessionId, "checkout.session_confirmed")).toBe(1);
        const [events] = await admin<{ n: number }[]>`
          select count(*)::int as n from public.outbox_events
           where topic = 'booking.confirmed' and payload->>'checkoutSessionId' = ${opened.sessionId}`;
        expect(events?.n).toBe(1);
        expect(await problems([opened.tripId])).toEqual([]);
      }
      reportRace("webhook_same_event_many_times", rounds, { outcomes: tally(outcomes) });
    },
    raceTimeout(30_000),
  );

  it(
    "books once when distinct success events for one payment arrive at once",
    async ({ expect }) => {
      const rounds: RoundStats[] = [];
      const outcomes: string[] = [];
      for (let round = 0; round < RACE_ROUNDS; round++) {
        const opened = await openCheckout(world, A, trips.shared(), 3);
        const own = await settleFake(world, opened, "succeeded");
        // The provider's own event, and others for the same payment: half name
        // our payment id, half only the provider's payment id.
        const bodies = [
          own.body,
          ...Array.from({ length: RACE_SESSIONS - 1 }, (_, i) =>
            bodyFor(opened, "payment.succeeded", {
              clientReference: i % 2 === 0 ? opened.paymentId : null,
            }),
          ),
        ];
        const go = gate();
        const pending = bodies.map((body) => startAt(go.opened, () => deliver(world, body)));
        go.open();
        const results = await Promise.all(pending);
        const errors = errorsOf(results);
        const got = valuesOf(results).map(outcomeOf);
        outcomes.push(...got);
        rounds.push({
          sessions: bodies.length,
          successes: got.filter((o) => o === "confirmed").length,
          refusals: got.filter((o) => o === "already_succeeded").length,
          errors: errors.length,
          oversell: oversold(await usageOfTrips(admin, [opened.tripId])).length,
        });

        expect(errors).toEqual([]);
        expect(tally(got)).toEqual({ confirmed: 1, already_succeeded: bodies.length - 1 });
        const inbox = await admin<{ id: string; outcome: string; processing_state: string }[]>`
          select id, outcome, processing_state from public.provider_events
           where payment_ref = ${opened.paymentRef} order by verified_at, id`;
        expect(inbox).toHaveLength(bodies.length);
        expect(inbox.every((e) => e.processing_state === "processed")).toBe(true);
        const [evidence] = await admin<{ succeeded_event_id: string }[]>`
          select succeeded_event_id from public.payments where id = ${opened.paymentId}`;
        expect(inbox.find((e) => e.outcome === "confirmed")?.id).toBe(evidence?.succeeded_event_id);
        expect(await stateOf(admin, opened.sessionId)).toMatchObject({
          session: "confirmed",
          payment: "succeeded",
          bookings: 1,
          refund: null,
          exceptions: [],
        });
        expect(await problems([opened.tripId])).toEqual([]);
      }
      reportRace("webhook_distinct_successes_one_payment", rounds, { outcomes: tally(outcomes) });
    },
    raceTimeout(30_000),
  );

  it("ignores a failure after a success, and refunds a success after a failure without booking it", async ({
    expect,
  }) => {
    const [won, lost] = await Promise.all([
      openCheckout(world, A, trips.shared(), 2),
      openCheckout(world, A, trips.shared(), 2),
    ]);
    const [paid, declined] = await Promise.all([
      settleFake(world, won, "succeeded"),
      settleFake(world, lost, "failed"),
    ]);

    // A failure delivered after the success changes nothing.
    expect(outcomeOf(await deliver(world, paid.body))).toBe("confirmed");
    expect(outcomeOf(await deliver(world, bodyFor(won, "payment.failed")))).toBe(
      "ignored_after_success",
    );
    expect(await stateOf(admin, won.sessionId)).toMatchObject({
      session: "confirmed",
      hold: "confirmed",
      order: "paid",
      payment: "succeeded",
      bookings: 1,
      refund: null,
    });

    // A success after the provider said the payment failed: the hold was
    // released, so it is refunded and never booked.
    expect(outcomeOf(await deliver(world, declined.body))).toBe("released");
    expect(await stateOf(admin, lost.sessionId)).toMatchObject({
      session: "failed",
      hold: "released",
      order: "void",
      payment: "failed",
    });
    const late = bodyFor(lost, "payment.succeeded");
    const handled = await deliver(world, late);
    // The fake's one outcome for this payment is failed, so it refuses the
    // refund; the refund stays failed and visible, never reads as completed.
    expect(handled).toMatchObject({
      kind: "processed",
      outcome: "refund_required",
      refund: { kind: "failed", failureCode: "payment_not_succeeded" },
    });
    const after = await stateOf(admin, lost.sessionId);
    expect(after).toMatchObject({
      session: "unfulfilled",
      hold: "released",
      order: "void",
      payment: "succeeded",
      bookings: 0,
      refund: "failed",
      refundFailure: "payment_not_succeeded",
      exceptions: ["session_failed"],
      fakeRefunded: 0,
    });
    const view = await asGuest(runtime.db, A.id, (trx) =>
      getCheckoutSession(trx, A.id, { sessionId: lost.sessionId, secret: lost.secret }),
    );
    expect(view).toMatchObject({
      state: "unfulfilled",
      booking: null,
      refund: { state: "failed", amount: lost.amount },
    });
    const listed = await asGuest(runtime.db, A.id, (trx) =>
      listFinalizationExceptions(trx, A.id, { limit: 100 }),
    );
    expect(listed.find((e) => e.checkoutSessionId === lost.sessionId)).toMatchObject({
      reason: "session_failed",
      refund: { state: "failed", failureCode: "payment_not_succeeded", amount: lost.amount },
    });

    // The same success again, another success, and another failure change nothing.
    expect(await deliver(world, late)).toMatchObject({
      duplicate: true,
      outcome: "refund_required",
      refund: null,
    });
    expect(outcomeOf(await deliver(world, bodyFor(lost, "payment.succeeded")))).toBe(
      "already_succeeded",
    );
    expect(outcomeOf(await deliver(world, bodyFor(lost, "payment.failed")))).toBe(
      "ignored_after_success",
    );
    expect(await stateOf(admin, lost.sessionId)).toEqual(after);
    expect(await problems([won.tripId, lost.tripId])).toEqual([]);
  });

  it(
    "ends a success racing a failure for one payment in exactly one booking or one refund",
    async ({ expect }) => {
      const rounds: RoundStats[] = [];
      const orders: string[] = [];
      const pairs = Math.max(2, Math.floor(RACE_SESSIONS / 2));
      for (let round = 0; round < RACE_ROUNDS; round++) {
        const opened: Opened[] = await Promise.all(
          Array.from({ length: pairs }, () => openCheckout(world, A, trips.shared(), 1)),
        );
        const bodies = await Promise.all(
          opened.map(async (o) => ({
            success: (await settleFake(world, o, "succeeded")).body,
            failure: bodyFor(o, "payment.failed"),
          })),
        );
        const go = gate();
        // Pair i gives the success a head start, the failure one, or neither.
        const pending = bodies.map((b, i) => ({
          success: startAt(go.opened, () => deliver(world, b.success), i % 3 === 1 ? 150 : 0),
          failure: startAt(go.opened, () => deliver(world, b.failure), i % 3 === 2 ? 150 : 0),
        }));
        go.open();
        const settled = await Promise.all(
          pending.map(async (p) => ({ success: await p.success, failure: await p.failure })),
        );
        let errors = 0;
        let booked = 0;
        let refunded = 0;
        for (const [i, s] of settled.entries()) {
          const o = opened[i];
          if (!o) throw new Error("no checkout");
          if (!s.success.ok || !s.failure.ok) {
            errors += 1;
            continue;
          }
          const pair = `${outcomeOf(s.success.value)}+${outcomeOf(s.failure.value)}`;
          orders.push(pair);
          const state = await stateOf(admin, o.sessionId);
          if (pair === "confirmed+ignored_after_success") {
            booked += 1;
            expect(state).toMatchObject({ session: "confirmed", bookings: 1, refund: null });
          } else {
            refunded += 1;
            expect(pair).toBe("refund_required+released");
            expect(state).toMatchObject({
              session: "unfulfilled",
              hold: "released",
              bookings: 0,
              refund: "succeeded",
              exceptions: ["session_failed"],
              fakeRefunded: o.amount,
            });
          }
        }
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
        expect(errors).toBe(0);
        expect(await problems(opened.map((o) => o.tripId))).toEqual([]);
      }
      reportRace("webhook_success_vs_failure", rounds, { orders: tally(orders) });
    },
    raceTimeout(40_000),
  );

  it("raises an exception for a success that does not match its payment, and still books the genuine one", async ({
    expect,
  }) => {
    const opened = await openCheckout(world, A, trips.shared(), 1);
    const mismatches = [
      bodyFor(opened, "payment.succeeded", { amount: opened.amount + 1 }),
      bodyFor(opened, "payment.succeeded", { currency: "eur" }),
      // Our payment id, but a provider payment other than the one recorded.
      bodyFor(opened, "payment.succeeded", { paymentRef: fakePaymentRef() }),
    ];
    const handled = await Promise.all(mismatches.map((body) => deliver(world, body)));
    expect(handled.map(outcomeOf)).toEqual(Array(3).fill("payment_mismatch"));
    expect(await stateOf(admin, opened.sessionId)).toMatchObject({
      session: "open",
      hold: "active",
      order: "pending",
      payment: "pending",
      providerPaymentId: opened.paymentRef,
      bookings: 0,
      refund: null,
      exceptions: Array(3).fill("payment_mismatch"),
    });
    const listed = await asGuest(runtime.db, A.id, (trx) =>
      listFinalizationExceptions(trx, A.id, { limit: 100 }),
    );
    expect(
      listed
        .filter((e) => e.checkoutSessionId === opened.sessionId)
        .map((e) => ({ reason: e.reason, refund: e.refund })),
    ).toEqual(Array(3).fill({ reason: "payment_mismatch", refund: null }));

    const genuine = await settleFake(world, opened, "succeeded");
    expect(outcomeOf(await deliver(world, genuine.body))).toBe("confirmed");
    // A mismatched success after the booking is still only an exception.
    expect(
      outcomeOf(
        await deliver(world, bodyFor(opened, "payment.succeeded", { amount: opened.amount - 1 })),
      ),
    ).toBe("payment_mismatch");
    expect(await stateOf(admin, opened.sessionId)).toMatchObject({
      session: "confirmed",
      bookings: 1,
      refund: null,
      exceptions: Array(4).fill("payment_mismatch"),
    });
    expect(await problems([opened.tripId])).toEqual([]);
  });

  it("does not let a mismatched success that beats the provider id block the genuine payment", async ({
    expect,
  }) => {
    const opened = await openCheckout(world, A, trips.shared(), 1, { ensure: false });
    // The provider made the payment, and its answer was lost before checkout
    // recorded the provider's id.
    const created = await world.provider.createPayment({
      accountRef: A.accountRef,
      amount: opened.amount,
      currency: "USD",
      idempotencyKey: opened.paymentKey,
      clientReference: opened.paymentId,
    });
    const withRef: Opened = { ...opened, paymentRef: created.paymentRef };
    expect(
      outcomeOf(
        await deliver(
          world,
          bodyFor(withRef, "payment.succeeded", { amount: opened.amount + 100 }),
        ),
      ),
    ).toBe("payment_mismatch");
    expect(await stateOf(admin, opened.sessionId)).toMatchObject({
      session: "open",
      payment: "pending",
      bookings: 0,
      refund: null,
    });
    // The guest's retry still finds the same provider payment, and the genuine success books.
    expect(
      await ensureProviderPayment(runtime.db, world.provider, guestContext(A.id), opened.sessionId),
    ).toMatchObject({ kind: "ready", paymentRef: created.paymentRef });
    const genuine = await settleFake(world, withRef, "succeeded");
    expect(outcomeOf(await deliver(world, genuine.body))).toBe("confirmed");
    expect(await stateOf(admin, opened.sessionId)).toMatchObject({
      session: "confirmed",
      providerPaymentId: created.paymentRef,
      bookings: 1,
    });
    expect(await problems([opened.tripId])).toEqual([]);
  });

  it("never lets an event for one checkout act on another checkout of the same operator", async ({
    expect,
  }) => {
    const [x, y] = await Promise.all([
      openCheckout(world, A, trips.shared(), 1),
      openCheckout(world, A, trips.shared(), 1),
    ]);
    // X's payment id with Y's provider payment: a mismatch for X, nothing for Y.
    const crossed = { paymentRef: y.paymentRef ?? "" };
    expect(outcomeOf(await deliver(world, bodyFor(x, "payment.succeeded", crossed)))).toBe(
      "payment_mismatch",
    );
    expect(outcomeOf(await deliver(world, bodyFor(x, "payment.failed", crossed)))).toBe(
      "payment_mismatch",
    );
    // A payment id that is no payment's.
    expect(
      outcomeOf(
        await deliver(
          world,
          bodyFor(x, "payment.succeeded", {
            clientReference: "00000000-0000-4000-8000-000000000000",
            paymentRef: fakePaymentRef(),
          }),
        ),
      ),
    ).toBe("unmatched_payment");
    for (const o of [x, y]) {
      expect(await stateOf(admin, o.sessionId)).toMatchObject({
        session: "open",
        hold: "active",
        payment: "pending",
        bookings: 0,
        refund: null,
      });
    }
    expect((await stateOf(admin, y.sessionId)).exceptions).toEqual([]);
    expect(await problems([x.tripId, y.tripId])).toEqual([]);
  });

  it("records nothing for an unknown account, never reprocesses an id with another body, and ignores other kinds", async ({
    expect,
  }) => {
    const opened = await openCheckout(world, A, trips.shared(), 1);

    const ghost = bodyFor(opened, "payment.succeeded", { accountRef: "acct_fake_nobody_here" });
    const ghostId = (JSON.parse(ghost) as { id: string }).id;
    expect(await deliver(world, ghost)).toEqual({ kind: "unknown_account" });
    expect(await inboxRows(ghostId)).toEqual([]);

    // One id, two bodies: the first (a mismatch) is processed; the second, the
    // genuine amount under the same id, is never processed.
    const eventId = fakeEventId();
    const first = bodyFor(opened, "payment.succeeded", { eventId, amount: opened.amount + 1 });
    expect(outcomeOf(await deliver(world, first))).toBe("payment_mismatch");
    const second = bodyFor(opened, "payment.succeeded", { eventId });
    expect(await deliver(world, second)).toEqual({ kind: "payload_mismatch", tenantId: A.id });
    expect(await inboxRows(eventId)).toEqual([
      expect.objectContaining({
        processing_state: "processed",
        outcome: "payment_mismatch",
        amount: opened.amount + 1,
      }),
    ]);

    // Other kinds are recorded once and ignored, even when they name the payment.
    for (const type of ["charge.dispute.created", "payment.refunded", "payment.succeeded.extra"]) {
      const body = eventBody({
        type,
        accountRef: A.accountRef,
        paymentRef: opened.paymentRef ?? "",
        amount: opened.amount,
        clientReference: opened.paymentId,
      });
      const id = (JSON.parse(body) as { id: string }).id;
      expect(outcomeOf(await deliver(world, body))).toBe("ignored_event_type");
      expect(await inboxRows(id)).toEqual([
        expect.objectContaining({ processing_state: "processed", outcome: "ignored_event_type" }),
      ]);
    }
    expect(await stateOf(admin, opened.sessionId)).toMatchObject({
      session: "open",
      hold: "active",
      payment: "pending",
      bookings: 0,
      exceptions: ["payment_mismatch"],
    });
    expect(await problems([opened.tripId])).toEqual([]);
  });
});
