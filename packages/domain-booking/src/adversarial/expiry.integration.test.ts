/**
 * G2.7 adversarial tests for time. A success after its checkout expired, with
 * and without the capacity, for seats and for a whole-boat charter, before and
 * after the sweep ran. A success after the trip was canceled or closed. A
 * failure after expiry. What a guest sees and may do once the instant has
 * passed. The database clock decides every expiry; time passes only by moving
 * expiries earlier through the admin connection.
 *
 * The tests run concurrently. The matrix has a tenant of its own, because it
 * depends on which checkouts a sweep has and has not reached; the others
 * tolerate a sweep from a neighbouring test. The lazily expired cases (added
 * with the independent review's fixes) have a tenant of their own too, which
 * no test sweeps, so nothing can expire their checkouts before they act.
 */
import { createDb, inTenantTransaction } from "@tidegrid/database";
import type {} from "@tidegrid/database/global-setup";
import { changeTripSalesState } from "@tidegrid/domain-catalog";
import { tripAllocator } from "@tidegrid/domain-inventory/testing";
import postgres from "postgres";
import { afterAll, beforeAll, describe, type ExpectStatic, inject, it } from "vitest";
import { cancelCheckoutSession, ensureProviderPayment, getCheckoutSession } from "../index.ts";
import {
  type CheckoutFixture,
  createCheckoutFixture,
  fakeProvider,
  guestContext,
} from "../test-fixtures.ts";
import {
  asGuest,
  auditLedger,
  backdateMany,
  bodyFor,
  deliver,
  expireTenant,
  type Opened,
  openCheckout,
  outcomeOf,
  oversold,
  type Runtime,
  type Sql,
  sessionTrail,
  settleFake,
  stateOf,
  systemCtx,
  usageOfTrips,
  type World,
} from "./harness.ts";

const env = inject("integrationDb");

interface Case {
  kind: "seats" | "charter";
  capacity: boolean;
  swept: boolean;
}

const cases: Case[] = (["seats", "charter"] as const).flatMap((kind) =>
  [true, false].flatMap((capacity) => [true, false].map((swept) => ({ kind, capacity, swept }))),
);

const label = (c: Case) =>
  `${c.kind}, ${c.capacity ? "capacity free" : "capacity taken"}, ${c.swept ? "swept" : "not swept"}`;

describe.skipIf(!env).concurrent("G2.7 adversarial: late payments and expiry", () => {
  let admin: Sql;
  let runtime: Runtime;
  let world: World;
  let A: CheckoutFixture;
  let M: CheckoutFixture;
  let L: CheckoutFixture;
  let trips: ReturnType<typeof tripAllocator>;
  let matrixTrips: ReturnType<typeof tripAllocator>;
  let lazyTrips: ReturnType<typeof tripAllocator>;

  beforeAll(async () => {
    if (!env) return;
    admin = postgres(env.adminUrl, { max: 6, onnotice: () => {} });
    runtime = createDb(env.runtimeUrl, { max: 24 });
    world = { admin, db: runtime.db, provider: fakeProvider(runtime.db) };
    [A, M, L] = await Promise.all([
      createCheckoutFixture(admin, runtime.db, "advexp"),
      createCheckoutFixture(admin, runtime.db, "advexm"),
      createCheckoutFixture(admin, runtime.db, "advexl"),
    ]);
    trips = tripAllocator(A);
    matrixTrips = tripAllocator(M);
    lazyTrips = tripAllocator(L);
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

  const view = (o: Opened) =>
    asGuest(runtime.db, o.tenant.id, (trx) =>
      getCheckoutSession(trx, o.tenant.id, { sessionId: o.sessionId, secret: o.secret }),
    );

  async function setTripState(o: Opened, to: "canceled" | "closed") {
    const ctx = systemCtx(o.tenant.id, "operator");
    return inTenantTransaction(runtime.db, ctx, (trx) =>
      changeTripSalesState(trx, ctx, { tripId: o.tripId, to, reason: "test", now: new Date() }),
    );
  }

  it("reacquires a late success when the capacity is free and refunds it when it is not, for seats and charters, swept or not", async ({
    expect,
  }) => {
    // Every case on its own trip: seats hold a party of four on ten seats; a
    // charter holds the whole six-guest boat for a party of two.
    const opened = await Promise.all(
      cases.map((c) =>
        c.kind === "seats"
          ? openCheckout(world, M, matrixTrips.shared(), 4)
          : openCheckout(world, M, matrixTrips.charter(), 2, { charter: true }),
      ),
    );
    const pick = (swept: boolean) =>
      opened.filter((_, i) => cases[i]?.swept === swept).map((o) => o.sessionId);

    // Time passes for the swept cases, and the sweep runs; then it passes for
    // the others, which no sweep touches.
    await backdateMany(admin, pick(true));
    const swept = await expireTenant(runtime.db, M.id);
    expect([...swept.expired].sort()).toEqual([...pick(true)].sort());
    await backdateMany(admin, pick(false));
    for (const [i, o] of opened.entries()) {
      expect((await view(o))?.state, label(cases[i] as Case)).toBe("expired");
    }

    // Someone else takes the capacity a late payment needs: seven of ten seats,
    // or the boat.
    await Promise.all(
      cases.map(async (c, i) => {
        const o = opened[i];
        if (c.capacity || !o) return;
        if (c.kind === "seats") {
          await openCheckout(world, M, o.tripId, 4);
          await openCheckout(world, M, o.tripId, 3);
        } else {
          await openCheckout(world, M, o.tripId, 3, { charter: true });
        }
      }),
    );

    // Then every late payment succeeds at once.
    const bodies = await Promise.all(opened.map((o) => settleFake(world, o, "succeeded")));
    const handled = await Promise.all(bodies.map((b) => deliver(world, b.body)));

    for (const [i, c] of cases.entries()) {
      const o = opened[i];
      const h = handled[i];
      if (!o || !h) throw new Error("missing case");
      const name = label(c);
      const state = await stateOf(admin, o.sessionId);
      const trail = await sessionTrail(admin, o.sessionId);
      const expiredStep = c.swept ? ["checkout.session_expired"] : [];
      if (c.capacity) {
        expect(outcomeOf(h), name).toBe("confirmed_reacquired");
        expect(state, name).toMatchObject({
          session: "confirmed",
          hold: "confirmed",
          order: "paid",
          payment: "succeeded",
          bookings: 1,
          reacquired: true,
          refund: null,
          exceptions: [],
        });
        expect(trail, name).toEqual([
          "checkout.session_opened",
          ...expiredStep,
          "checkout.session_confirmed",
        ]);
        expect((await view(o))?.booking?.reference, name).toMatch(/^[0-9A-HJKMNP-TV-Z]{8}$/);
      } else {
        expect(h, name).toMatchObject({
          kind: "processed",
          outcome: "refund_required",
          refund: { kind: "succeeded" },
        });
        expect(state, name).toMatchObject({
          session: "unfulfilled",
          hold: "expired",
          order: "void",
          payment: "succeeded",
          bookings: 0,
          refund: "succeeded",
          exceptions: ["no_capacity"],
          fakeRefunds: 1,
          fakeRefunded: o.amount,
        });
        expect(trail, name).toEqual([
          "checkout.session_opened",
          ...expiredStep,
          "checkout.session_unfulfilled",
        ]);
        expect(await view(o), name).toMatchObject({
          state: "unfulfilled",
          booking: null,
          refund: { state: "succeeded", amount: o.amount },
        });
      }
      const [usage] = await usageOfTrips(admin, [o.tripId]);
      expect(usage, name).toMatchObject(
        c.capacity
          ? { counted: c.kind === "seats" ? 4 : 6, confirmed: c.kind === "seats" ? 4 : 6 }
          : { counted: c.kind === "seats" ? 7 : 6, confirmed: 0 },
      );
    }
    expect(
      await problems(
        M,
        opened.map((o) => o.tripId),
      ),
    ).toEqual([]);
  });

  it("refunds a success on a canceled trip, within its time and after it", async ({ expect }) => {
    const [within, late] = await Promise.all([
      openCheckout(world, A, trips.shared(), 2),
      openCheckout(world, A, trips.shared(), 2),
    ]);
    await backdateMany(admin, [late.sessionId]);
    expect((await setTripState(within, "canceled")).kind).toBe("changed");
    expect((await setTripState(late, "canceled")).kind).toBe("changed");
    const [handledWithin, handledLate] = await Promise.all(
      [within, late].map(async (o) =>
        deliver(world, (await settleFake(world, o, "succeeded")).body),
      ),
    );
    expect(handledWithin && outcomeOf(handledWithin)).toBe("refund_required");
    expect(handledLate && outcomeOf(handledLate)).toBe("refund_required");
    expect(await stateOf(admin, within.sessionId)).toMatchObject({
      session: "unfulfilled",
      hold: "released",
      bookings: 0,
      refund: "succeeded",
      exceptions: ["trip_canceled"],
    });
    expect(await stateOf(admin, late.sessionId)).toMatchObject({
      session: "unfulfilled",
      hold: "expired",
      bookings: 0,
      refund: "succeeded",
      exceptions: ["trip_canceled"],
    });
    expect(await problems(A, [within.tripId, late.tripId])).toEqual([]);
  });

  it("confirms a success on a closed trip within its time, and refunds a late one", async ({
    expect,
  }) => {
    const [within, late] = await Promise.all([
      openCheckout(world, A, trips.shared(), 2),
      openCheckout(world, A, trips.shared(), 2),
    ]);
    await backdateMany(admin, [late.sessionId]);
    expect((await setTripState(within, "closed")).kind).toBe("changed");
    expect((await setTripState(late, "closed")).kind).toBe("changed");
    expect(
      outcomeOf(await deliver(world, (await settleFake(world, within, "succeeded")).body)),
    ).toBe("confirmed");
    expect(outcomeOf(await deliver(world, (await settleFake(world, late, "succeeded")).body))).toBe(
      "refund_required",
    );
    expect(await stateOf(admin, within.sessionId)).toMatchObject({
      session: "confirmed",
      bookings: 1,
      reacquired: false,
    });
    const lateState = await stateOf(admin, late.sessionId);
    expect(lateState).toMatchObject({ session: "unfulfilled", bookings: 0, refund: "succeeded" });
    // A closed trip is not on sale, so a late payment cannot take capacity again.
    expect(lateState.exceptions).toHaveLength(1);
    expect(["trip_unavailable", "sales_closed"]).toContain(lateState.exceptions[0]);
    expect(await problems(A, [within.tripId, late.tripId])).toEqual([]);
  });

  it("records a failure after expiry without reopening anything, and refunds a success after it", async ({
    expect,
  }) => {
    const o = await openCheckout(world, A, trips.charter(), 3, { charter: true });
    await backdateMany(admin, [o.sessionId]);
    await expireTenant(runtime.db, A.id);
    expect((await stateOf(admin, o.sessionId)).session).toBe("expired");
    expect(outcomeOf(await deliver(world, (await settleFake(world, o, "failed")).body))).toBe(
      "failure_recorded",
    );
    expect(await stateOf(admin, o.sessionId)).toMatchObject({
      session: "expired",
      hold: "expired",
      order: "void",
      payment: "failed",
      bookings: 0,
    });
    // The provider said failed; a success after that is an anomaly and is refunded.
    expect(outcomeOf(await deliver(world, bodyFor(o, "payment.succeeded")))).toBe(
      "refund_required",
    );
    expect(await stateOf(admin, o.sessionId)).toMatchObject({
      session: "unfulfilled",
      hold: "expired",
      payment: "succeeded",
      bookings: 0,
      exceptions: ["session_failed"],
      // The fake's one outcome is failed, so it refuses the refund.
      refund: "failed",
      refundFailure: "payment_not_succeeded",
    });
    // The boat is free for someone else.
    const next = await openCheckout(world, A, o.tripId, 2, { charter: true });
    expect((await stateOf(admin, next.sessionId)).hold).toBe("active");
    expect(await problems(A, [o.tripId])).toEqual([]);
  });

  it("closes a lapsed checkout that the sweep has not reached as failed on a failure", async ({
    expect,
  }) => {
    const o = await openCheckout(world, A, trips.shared(), 2);
    await backdateMany(admin, [o.sessionId]);
    expect((await view(o))?.state).toBe("expired");
    const outcome = outcomeOf(await deliver(world, (await settleFake(world, o, "failed")).body));
    const state = await stateOf(admin, o.sessionId);
    if (outcome === "released") {
      expect(state).toMatchObject({
        session: "failed",
        hold: "released",
        order: "void",
        payment: "failed",
      });
    } else {
      // A neighbouring test's sweep reached it first.
      expect(outcome).toBe("failure_recorded");
      expect(state).toMatchObject({ session: "expired", order: "void", payment: "failed" });
    }
    // The sweep then has nothing to do for it.
    const swept = await expireTenant(runtime.db, A.id);
    expect(swept.expired).not.toContain(o.sessionId);
    expect(await problems(A, [o.tripId])).toEqual([]);
  });

  it("offers no payment for a lapsed checkout and shows it expired at its instant", async ({
    expect,
  }) => {
    const o = await openCheckout(world, A, trips.shared(), 8, { ensure: false });
    await backdateMany(admin, [o.sessionId], 1);
    expect(await view(o)).toMatchObject({ state: "expired", booking: null, refund: null });
    expect(
      await ensureProviderPayment(runtime.db, world.provider, guestContext(A.id), o.sessionId),
    ).toEqual({ kind: "not_open", state: "expired" });
    const [fake] = await admin<{ n: number }[]>`
      select count(*)::int as n from public.fake_provider_payments
       where idempotency_key = ${o.paymentKey}`;
    expect(fake?.n).toBe(0);
    // Eight more seats fit on ten: the lapsed hold stopped counting at its
    // instant, whether or not a sweep has run, and the new hold marks it expired.
    const next = await openCheckout(world, A, o.tripId, 8);
    expect(await stateOf(admin, next.sessionId)).toMatchObject({ session: "open", hold: "active" });
    const lapsed = await stateOf(admin, o.sessionId);
    expect(lapsed.hold).toBe("expired");
    expect(["open", "expired"]).toContain(lapsed.session);
    expect(await problems(A, [o.tripId])).toEqual([]);
  });

  it("never books a payment after the guest canceled a lapsed checkout", async ({ expect }) => {
    // A guest who sees "expired" and cancels anyway, then pays in another tab.
    const o = await openCheckout(world, A, trips.shared(), 2);
    await backdateMany(admin, [o.sessionId]);
    const canceled = await asGuest(runtime.db, A.id, (trx, ctx) =>
      cancelCheckoutSession(trx, ctx, { sessionId: o.sessionId, secret: o.secret }),
    );
    expect(["canceled", "not_cancelable"]).toContain(canceled.kind);
    const handled = await deliver(world, (await settleFake(world, o, "succeeded")).body);
    const state = await stateOf(admin, o.sessionId);
    if (canceled.kind === "canceled") {
      expect(outcomeOf(handled)).toBe("refund_required");
      expect(state).toMatchObject({
        session: "unfulfilled",
        bookings: 0,
        refund: "succeeded",
        exceptions: ["session_canceled"],
      });
    } else {
      expect(outcomeOf(handled)).toBe("confirmed_reacquired");
      expect(state).toMatchObject({ session: "confirmed", bookings: 1 });
    }
    expect(await problems(A, [o.tripId])).toEqual([]);
  });

  // Added with the independent review's fixes. The two tests above cover a
  // lapsed checkout whose hold is still stored active. Here another guest's
  // checkout on the same trip has already written the lapsed hold down as
  // expired (acquisition, a late confirmation, and the hold sweep all do),
  // while the checkout itself is still stored open. Before the fix the
  // database refused to cancel or fail it (23514): the guest's cancel failed,
  // and the failure event failed and stayed received for the sweep.

  /** A lapsed open checkout whose hold a second guest's checkout marked expired. */
  async function lazilyExpired(expect: ExpectStatic) {
    const tripId = lazyTrips.shared();
    const o = await openCheckout(world, L, tripId, 2);
    await backdateMany(admin, [o.sessionId]);
    const other = await openCheckout(world, L, tripId, 3);
    expect(await stateOf(admin, o.sessionId)).toMatchObject({
      session: "open",
      hold: "expired",
      order: "pending",
      payment: "pending",
    });
    expect((await view(o))?.state).toBe("expired");
    return { o, other, tripId };
  }

  it("lets the guest cancel a lapsed checkout whose hold another checkout already expired, and refunds a payment after it", async ({
    expect,
  }) => {
    const { o, other, tripId } = await lazilyExpired(expect);
    const cancel = () =>
      asGuest(runtime.db, L.id, (trx, ctx) =>
        cancelCheckoutSession(trx, ctx, { sessionId: o.sessionId, secret: o.secret }),
      );
    expect(await cancel()).toMatchObject({ kind: "canceled", session: { state: "canceled" } });
    expect(await cancel()).toMatchObject({ kind: "unchanged", session: { state: "canceled" } });
    expect(await stateOf(admin, o.sessionId)).toMatchObject({
      session: "canceled",
      hold: "expired",
      order: "void",
      payment: "pending",
      bookings: 0,
      refund: null,
    });
    expect(await problems(L, [tripId])).toEqual([]);

    // The guest pays in another tab anyway: refunded, never booked, and the
    // other guest's seats are untouched.
    const handled = await deliver(world, (await settleFake(world, o, "succeeded")).body);
    expect(handled).toMatchObject({
      kind: "processed",
      outcome: "refund_required",
      refund: { kind: "succeeded" },
    });
    expect(await stateOf(admin, o.sessionId)).toMatchObject({
      session: "unfulfilled",
      hold: "expired",
      order: "void",
      payment: "succeeded",
      bookings: 0,
      refund: "succeeded",
      exceptions: ["session_canceled"],
      fakeRefunded: o.amount,
    });
    expect(await sessionTrail(admin, o.sessionId)).toEqual([
      "checkout.session_opened",
      "checkout.session_canceled",
      "checkout.session_unfulfilled",
    ]);
    expect(await stateOf(admin, other.sessionId)).toMatchObject({
      session: "open",
      hold: "active",
    });
    const [usage] = await usageOfTrips(admin, [tripId]);
    expect(usage).toMatchObject({ counted: 3, confirmed: 0 });
    expect(await problems(L, [tripId])).toEqual([]);
  });

  it("closes a lapsed checkout whose hold another checkout already expired as failed on a failure, once", async ({
    expect,
  }) => {
    const { o, other, tripId } = await lazilyExpired(expect);
    const failure = await settleFake(world, o, "failed");
    expect(await deliver(world, failure.body)).toMatchObject({
      kind: "processed",
      duplicate: false,
      outcome: "released",
    });
    expect(await stateOf(admin, o.sessionId)).toMatchObject({
      session: "failed",
      hold: "expired",
      order: "void",
      payment: "failed",
      bookings: 0,
      refund: null,
    });
    // Processed at once: nothing is left received for the sweep, and the
    // provider's retry is a duplicate that changes nothing.
    const [inbox] = await admin<{ processing_state: string; outcome: string | null }[]>`
      select processing_state, outcome from public.provider_events where event_id = ${failure.id}`;
    expect(inbox).toEqual({ processing_state: "processed", outcome: "released" });
    expect(await deliver(world, failure.body)).toMatchObject({
      kind: "processed",
      duplicate: true,
      outcome: "released",
    });
    expect(await sessionTrail(admin, o.sessionId)).toEqual([
      "checkout.session_opened",
      "checkout.session_failed",
    ]);
    expect(await problems(L, [tripId])).toEqual([]);

    // A success after the provider said failed is an anomaly: refunded, never
    // booked. The fake settled the payment as failed, so it refuses the refund.
    expect(outcomeOf(await deliver(world, bodyFor(o, "payment.succeeded")))).toBe(
      "refund_required",
    );
    expect(await stateOf(admin, o.sessionId)).toMatchObject({
      session: "unfulfilled",
      hold: "expired",
      payment: "succeeded",
      bookings: 0,
      exceptions: ["session_failed"],
      refund: "failed",
      refundFailure: "payment_not_succeeded",
    });
    expect(await stateOf(admin, other.sessionId)).toMatchObject({
      session: "open",
      hold: "active",
    });
    expect(await problems(L, [tripId])).toEqual([]);
  });
});
