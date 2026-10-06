/**
 * G2.7 adversarial tests for interrupted work. A crash between the provider
 * call and recording its reference, with the guest's retry and the webhook
 * both arriving afterwards, alone and racing. A provider that loses the answer
 * to a payment or a refund, and the sweep that sends the refund again with the
 * same key. An event recorded in the inbox whose processing never ran, and the
 * sweep and a redelivery that finish it, alone and racing. Exactly one provider
 * payment per key and one provider refund per refund row, whatever happens.
 *
 * The first suite runs concurrently; the second runs alone, because the sweep
 * it drives reaches every tenant.
 */
import { randomUUID } from "node:crypto";
import { createDb, inTenantTransaction, type TenantContext } from "@tidegrid/database";
import type {} from "@tidegrid/database/global-setup";
import { tripAllocator } from "@tidegrid/domain-inventory/testing";
import { recordProviderEvent } from "@tidegrid/domain-payments";
import postgres from "postgres";
import { afterAll, beforeAll, describe, inject, it } from "vitest";
import {
  cancelCheckoutSession,
  ensureProviderPayment,
  getCheckoutSession,
  listFinalizationExceptions,
  processProviderEvent,
  settleRefund,
  sweepCheckouts,
} from "../index.ts";
import {
  type CheckoutFixture,
  createCheckoutFixture,
  fakeProvider,
  guestContext,
  verifiedFakeEvent,
} from "../test-fixtures.ts";
import {
  asGuest,
  auditCount,
  auditLedger,
  backdateMany,
  deliver,
  errorsOf,
  FlakyProvider,
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
  settle,
  settleFake,
  startAt,
  stateOf,
  sweepCtx,
  tally,
  usageOfTrips,
  valuesOf,
  type World,
} from "./harness.ts";

const env = inject("integrationDb");

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
  A = await createCheckoutFixture(admin, runtime.db, "advrec", {
    days: 40 + RACE_ROUNDS * RACE_SESSIONS,
  });
  trips = tripAllocator(A);
});

afterAll(async () => {
  await runtime?.end();
  await admin?.end({ timeout: 5 });
});

async function problems(tripIds: readonly string[]) {
  const usage = oversold(await usageOfTrips(admin, tripIds));
  return [
    ...(await auditLedger(admin, [A.id])),
    ...usage.map((u) => `trip ${u.tripId} oversold: ${JSON.stringify(u)}`),
  ];
}

async function fakePaymentsFor(key: string): Promise<number> {
  const [row] = await admin<{ n: number }[]>`
    select count(*)::int as n from public.fake_provider_payments where idempotency_key = ${key}`;
  return row?.n ?? 0;
}

/** The provider makes the payment, and the answer never reaches checkout. */
async function lostCreate(o: Opened): Promise<Opened> {
  const created = await world.provider.createPayment({
    accountRef: o.tenant.accountRef,
    amount: o.amount,
    currency: "USD",
    idempotencyKey: o.paymentKey,
    clientReference: o.paymentId,
  });
  return { ...o, paymentRef: created.paymentRef, clientSecret: created.clientSecret };
}

/** The webhook request records the event and dies before processing it. */
async function recordOnly(body: string): Promise<string> {
  const event = await verifiedFakeEvent(world.provider, body);
  const ctx: TenantContext = {
    tenantId: A.id,
    actorType: "system",
    actorId: "fake-webhook",
    requestId: `wh-${randomUUID()}`,
  };
  const recorded = await inTenantTransaction(runtime.db, ctx, (trx) =>
    recordProviderEvent(trx, ctx, event),
  );
  if (recorded.duplicate) throw new Error("the event was already recorded");
  return recorded.inboxId;
}

/** A checkout whose success cannot be honored: a charter lapsed and someone else took the boat. */
async function boatLost(): Promise<Opened> {
  const o = await openCheckout(world, A, trips.charter(), 2, { charter: true });
  await backdateMany(admin, [o.sessionId]);
  await openCheckout(world, A, o.tripId, 3, { charter: true });
  return o;
}

async function inboxState(inboxId: string) {
  const [row] = await admin<{ processing_state: string; outcome: string | null }[]>`
    select processing_state, outcome from public.provider_events where id = ${inboxId}`;
  return row;
}

describe.skipIf(!env).concurrent("G2.7 adversarial: interrupted payment work", () => {
  it("returns the same provider payment to every retry after a lost answer, and records its id once", async ({
    expect,
  }) => {
    const opened = await lostCreate(
      await openCheckout(world, A, trips.shared(), 2, { ensure: false }),
    );
    const go = gate();
    const retries = Array.from({ length: RACE_SESSIONS }, () =>
      startAt(go.opened, () =>
        ensureProviderPayment(runtime.db, world.provider, guestContext(A.id), opened.sessionId),
      ),
    );
    go.open();
    const results = await Promise.all(retries);
    expect(errorsOf(results)).toEqual([]);
    for (const r of valuesOf(results)) {
      expect(r).toEqual({
        kind: "ready",
        provider: "fake",
        paymentRef: opened.paymentRef,
        clientSecret: opened.clientSecret,
      });
    }
    expect(await fakePaymentsFor(opened.paymentKey)).toBe(1);
    expect((await stateOf(admin, opened.sessionId)).providerPaymentId).toBe(opened.paymentRef);
    expect(await auditCount(admin, opened.paymentId, "payment.provider_recorded")).toBe(1);
    expect(await problems([opened.tripId])).toEqual([]);
  });

  it("never makes a second payment when the provider fails before or after creating it", async ({
    expect,
  }) => {
    for (const failure of ["before", "after"] as const) {
      const opened = await openCheckout(world, A, trips.shared(), 1, { ensure: false });
      const flaky = new FlakyProvider(world.provider);
      flaky.failCreate = failure;
      expect(
        await ensureProviderPayment(runtime.db, flaky, guestContext(A.id), opened.sessionId),
      ).toEqual({ kind: "unavailable", reason: "unavailable" });
      expect(await fakePaymentsFor(opened.paymentKey)).toBe(failure === "after" ? 1 : 0);
      expect((await stateOf(admin, opened.sessionId)).providerPaymentId).toBeNull();
      const ready = await ensureProviderPayment(
        runtime.db,
        world.provider,
        guestContext(A.id),
        opened.sessionId,
      );
      expect(ready).toMatchObject({ kind: "ready" });
      expect(await fakePaymentsFor(opened.paymentKey)).toBe(1);
      const [fake] = await admin<{ id: string }[]>`
        select id from public.fake_provider_payments where idempotency_key = ${opened.paymentKey}`;
      expect(ready.kind === "ready" && ready.paymentRef).toBe(fake?.id);
      expect((await stateOf(admin, opened.sessionId)).providerPaymentId).toBe(fake?.id);
    }
    expect(await problems([])).toEqual([]);
  });

  it("records the provider id from a webhook that beats the payment request, once", async ({
    expect,
  }) => {
    const opened = await lostCreate(
      await openCheckout(world, A, trips.shared(), 2, { ensure: false }),
    );
    const paid = await settleFake(world, opened, "succeeded");
    expect(outcomeOf(await deliver(world, paid.body))).toBe("confirmed");
    expect(await stateOf(admin, opened.sessionId)).toMatchObject({
      session: "confirmed",
      providerPaymentId: opened.paymentRef,
      bookings: 1,
    });
    const [audit] = await admin<{ after_state: { fromEvent?: string } }[]>`
      select after_state from public.audit_events
       where subject_id = ${opened.paymentId} and action = 'payment.provider_recorded'`;
    expect(audit?.after_state.fromEvent).toEqual(expect.any(String));
    // The guest's retry arrives afterwards: no payment is offered, nothing is created.
    expect(
      await ensureProviderPayment(runtime.db, world.provider, guestContext(A.id), opened.sessionId),
    ).toEqual({ kind: "not_open", state: "confirmed" });
    expect(await fakePaymentsFor(opened.paymentKey)).toBe(1);
    expect(await auditCount(admin, opened.paymentId, "payment.provider_recorded")).toBe(1);
    expect(await problems([opened.tripId])).toEqual([]);
  });

  it(
    "records the provider id once when the webhook and the guest's retry race to record it",
    async ({ expect }) => {
      const rounds: RoundStats[] = [];
      const orders: string[] = [];
      const k = Math.max(3, Math.floor(RACE_SESSIONS / 2));
      for (let round = 0; round < RACE_ROUNDS; round++) {
        const opened = await Promise.all(
          Array.from({ length: k }, async () =>
            lostCreate(await openCheckout(world, A, trips.shared(), 1, { ensure: false })),
          ),
        );
        const bodies = await Promise.all(opened.map((o) => settleFake(world, o, "succeeded")));
        const go = gate();
        const pending = opened.map((o, i) => ({
          webhook: startAt(go.opened, () => deliver(world, bodies[i]?.body ?? ""), 0),
          retry: startAt(
            go.opened,
            () =>
              ensureProviderPayment(runtime.db, world.provider, guestContext(A.id), o.sessionId),
            i % 2 ? 1500 : 0,
          ),
        }));
        go.open();
        const settled = await Promise.all(
          pending.map(async (p) => ({ webhook: await p.webhook, retry: await p.retry })),
        );
        let errors = 0;
        for (const [i, s] of settled.entries()) {
          const o = opened[i];
          if (!o) continue;
          if (!s.webhook.ok || !s.retry.ok) {
            errors += 1;
            continue;
          }
          orders.push(`${outcomeOf(s.webhook.value)}+${s.retry.value.kind}`);
          expect(outcomeOf(s.webhook.value)).toBe("confirmed");
          expect(["ready", "not_open"]).toContain(s.retry.value.kind);
          if (s.retry.value.kind === "ready") {
            expect(s.retry.value.paymentRef).toBe(o.paymentRef);
          }
          expect(await fakePaymentsFor(o.paymentKey)).toBe(1);
          expect(await auditCount(admin, o.paymentId, "payment.provider_recorded")).toBe(1);
          expect(await stateOf(admin, o.sessionId)).toMatchObject({
            session: "confirmed",
            providerPaymentId: o.paymentRef,
            bookings: 1,
          });
        }
        rounds.push({
          sessions: k * 2,
          successes: k - errors,
          refusals: 0,
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
      reportRace("provider_id_webhook_vs_retry", rounds, { orders: tally(orders) });
    },
    raceTimeout(40_000),
  );

  it(
    "sends one provider refund when many attempts to settle one refund run at once",
    async ({ expect }) => {
      const rounds: RoundStats[] = [];
      for (let round = 0; round < RACE_ROUNDS; round++) {
        const o = await boatLost();
        const flaky = new FlakyProvider(world.provider);
        flaky.failRefund = "before";
        const handled = await deliver(world, (await settleFake(world, o, "succeeded")).body, flaky);
        expect(handled).toMatchObject({ outcome: "refund_required", refund: { kind: "unknown" } });
        const [refund] = await admin<{ id: string; idempotency_key: string }[]>`
          select r.id, r.idempotency_key from public.payment_refunds r
           where r.payment_id = ${o.paymentId}`;
        if (!refund) throw new Error("no refund");
        const go = gate();
        const attempts = Array.from({ length: RACE_SESSIONS }, () =>
          startAt(go.opened, () =>
            settleRefund(runtime.db, world.provider, sweepCtx(A.id), refund.id),
          ),
        );
        go.open();
        const results = await Promise.all(attempts);
        const errors = errorsOf(results);
        const kinds = valuesOf(results).map((r) => r.kind);
        rounds.push({
          sessions: RACE_SESSIONS,
          successes: kinds.filter((k) => k === "succeeded").length,
          refusals: kinds.filter((k) => k === "not_pending").length,
          errors: errors.length,
          oversell: 0,
        });
        expect(errors).toEqual([]);
        expect(kinds.filter((k) => k === "succeeded")).toHaveLength(1);
        expect(kinds.every((k) => k === "succeeded" || k === "not_pending")).toBe(true);
        const state = await stateOf(admin, o.sessionId);
        expect(state).toMatchObject({
          session: "unfulfilled",
          refund: "succeeded",
          refundKey: refund.idempotency_key,
          fakeRefunds: 1,
          fakeRefunded: o.amount,
        });
        const [fake] = await admin<{ id: string; idempotency_key: string }[]>`
          select id, idempotency_key from public.fake_provider_refunds
           where payment_id = ${o.paymentRef}`;
        expect(fake).toEqual({
          id: state.providerRefundId,
          idempotency_key: refund.idempotency_key,
        });
        expect(await auditCount(admin, refund.id, "payment_refund.succeeded")).toBe(1);
      }
      reportRace("refund_settle_storm", rounds);
      expect(await problems([])).toEqual([]);
    },
    raceTimeout(30_000),
  );

  it("keeps a refused refund failed and visible to the guest and the operator", async ({
    expect,
  }) => {
    const o = await boatLost();
    const flaky = new FlakyProvider(world.provider);
    flaky.failRefund = "reject";
    const handled = await deliver(world, (await settleFake(world, o, "succeeded")).body, flaky);
    expect(handled).toMatchObject({
      outcome: "refund_required",
      refund: { kind: "failed", failureCode: "simulated_refusal" },
    });
    expect(await stateOf(admin, o.sessionId)).toMatchObject({
      session: "unfulfilled",
      refund: "failed",
      refundFailure: "simulated_refusal",
      fakeRefunds: 0,
      bookings: 0,
    });
    const view = await asGuest(runtime.db, A.id, (trx) =>
      getCheckoutSession(trx, A.id, { sessionId: o.sessionId, secret: o.secret }),
    );
    expect(view).toMatchObject({ state: "unfulfilled", refund: { state: "failed" } });
    const listed = await asGuest(runtime.db, A.id, (trx) =>
      listFinalizationExceptions(trx, A.id, { limit: 100 }),
    );
    expect(listed.find((e) => e.checkoutSessionId === o.sessionId)).toMatchObject({
      reason: "no_capacity",
      refund: { state: "failed", failureCode: "simulated_refusal" },
    });
    // A settled refund, failed or not, is never sent again.
    const [refund] = await admin<{ id: string }[]>`
      select id from public.payment_refunds where payment_id = ${o.paymentId}`;
    expect(
      await settleRefund(runtime.db, world.provider, sweepCtx(A.id), refund?.id ?? ""),
    ).toEqual({
      kind: "not_pending",
    });
    expect((await stateOf(admin, o.sessionId)).fakeRefunds).toBe(0);
    expect(await problems([o.tripId])).toEqual([]);
  });

  it("finishes an event that was recorded but never processed when the provider delivers it again", async ({
    expect,
  }) => {
    const o = await openCheckout(world, A, trips.shared(), 2);
    const paid = await settleFake(world, o, "succeeded");
    const inboxId = await recordOnly(paid.body);
    expect(await inboxState(inboxId)).toEqual({ processing_state: "received", outcome: null });
    expect((await stateOf(admin, o.sessionId)).session).toBe("open");
    expect(await deliver(world, paid.body)).toMatchObject({
      kind: "processed",
      duplicate: true,
      outcome: "confirmed",
    });
    expect(await inboxState(inboxId)).toEqual({
      processing_state: "processed",
      outcome: "confirmed",
    });
    expect(await stateOf(admin, o.sessionId)).toMatchObject({ session: "confirmed", bookings: 1 });
    expect(await problems([o.tripId])).toEqual([]);
  });

  it(
    "processes a received event once when the sweep and a redelivery race",
    async ({ expect }) => {
      const rounds: RoundStats[] = [];
      const winners: string[] = [];
      const k = Math.max(3, Math.floor(RACE_SESSIONS / 2));
      for (let round = 0; round < RACE_ROUNDS; round++) {
        const opened = await Promise.all(
          Array.from({ length: k }, () => openCheckout(world, A, trips.shared(), 1)),
        );
        const bodies = await Promise.all(opened.map((o) => settleFake(world, o, "succeeded")));
        const inboxIds = await Promise.all(bodies.map((b) => recordOnly(b.body)));
        const go = gate();
        // The sweep's second step for each event, exactly as sweepCheckouts runs it.
        const pending = inboxIds.map((inboxId, i) => ({
          sweep: startAt(
            go.opened,
            () => {
              const ctx = sweepCtx(A.id);
              return inTenantTransaction(runtime.db, ctx, (trx) =>
                processProviderEvent(trx, ctx, inboxId, { skipLocked: true }),
              );
            },
            i % 2 ? 0 : 700,
          ),
          redelivery: startAt(go.opened, () => deliver(world, bodies[i]?.body ?? ""), 0),
        }));
        go.open();
        const settled = await Promise.all(
          pending.map(async (p) => ({ sweep: await p.sweep, redelivery: await p.redelivery })),
        );
        let errors = 0;
        for (const [i, s] of settled.entries()) {
          const o = opened[i];
          if (!o) continue;
          if (!s.sweep.ok || !s.redelivery.ok) {
            errors += 1;
            continue;
          }
          expect(outcomeOf(s.redelivery.value)).toBe("confirmed");
          expect([null, "confirmed"]).toContain(s.sweep.value?.outcome ?? null);
          const [who] = await admin<{ actor_id: string }[]>`
            select actor_id from public.audit_events
             where subject_id = ${o.paymentId} and action = 'payment.succeeded'`;
          winners.push(who?.actor_id ?? "nobody");
          expect(await auditCount(admin, o.paymentId, "payment.succeeded")).toBe(1);
          expect(await stateOf(admin, o.sessionId)).toMatchObject({
            session: "confirmed",
            bookings: 1,
          });
        }
        rounds.push({
          sessions: k * 2,
          successes: k - errors,
          refusals: 0,
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
      reportRace("received_event_sweep_vs_redelivery", rounds, { processedBy: tally(winners) });
    },
    raceTimeout(40_000),
  );
});

describe.skipIf(!env)("G2.7 adversarial: the sweep finishes interrupted work", () => {
  /**
   * The sweep's tenant list names tenants with refunds and inbox events a
   * minute old or more, whatever graceSeconds says, and the database stamps
   * those instants. A lapsed open checkout in the same tenant puts it on the
   * list now.
   */
  async function beacon(): Promise<Opened> {
    const o = await openCheckout(world, A, trips.shared(), 1, { ensure: false });
    await backdateMany(admin, [o.sessionId]);
    return o;
  }

  const sweep = (provider: World["provider"] | null) =>
    sweepCheckouts(runtime.db, {
      runId: `adv-sweep-${randomUUID()}`,
      provider,
      graceSeconds: 0,
    });

  it("sends a refund whose answer was lost again with the same key, once", async ({ expect }) => {
    const cases = await Promise.all(
      (["before", "after"] as const).map(async (failure) => {
        const o = await boatLost();
        const flaky = new FlakyProvider(world.provider);
        flaky.failRefund = failure;
        const handled = await deliver(world, (await settleFake(world, o, "succeeded")).body, flaky);
        expect(handled).toMatchObject({ outcome: "refund_required", refund: { kind: "unknown" } });
        expect(await stateOf(admin, o.sessionId)).toMatchObject({
          session: "unfulfilled",
          refund: "requested",
          fakeRefunds: failure === "after" ? 1 : 0,
        });
        return { failure, o };
      }),
    );

    // A sweep without a provider leaves them requested.
    await beacon();
    const idle = await sweep(null);
    expect(idle.refundsPending).toBeGreaterThanOrEqual(2);
    for (const { o, failure } of cases) {
      expect(await stateOf(admin, o.sessionId)).toMatchObject({
        refund: "requested",
        fakeRefunds: failure === "after" ? 1 : 0,
      });
    }

    await beacon();
    const report = await sweep(world.provider);
    expect(report.refundsSettled).toBeGreaterThanOrEqual(2);
    for (const { o } of cases) {
      const state = await stateOf(admin, o.sessionId);
      expect(state).toMatchObject({
        refund: "succeeded",
        fakeRefunds: 1,
        fakeRefunded: o.amount,
      });
      const [fake] = await admin<{ id: string; idempotency_key: string }[]>`
        select id, idempotency_key from public.fake_provider_refunds where payment_id = ${o.paymentRef}`;
      expect(fake).toEqual({ id: state.providerRefundId, idempotency_key: state.refundKey });
      const view = await asGuest(runtime.db, A.id, (trx) =>
        getCheckoutSession(trx, A.id, { sessionId: o.sessionId, secret: o.secret }),
      );
      expect(view).toMatchObject({ state: "unfulfilled", refund: { state: "succeeded" } });
    }

    // Again: a settled refund is never sent a second time.
    for (const { o } of cases) {
      const [refund] = await admin<{ id: string }[]>`
        select id from public.payment_refunds where payment_id = ${o.paymentId}`;
      expect(
        await settleRefund(runtime.db, world.provider, sweepCtx(A.id), refund?.id ?? ""),
      ).toEqual({ kind: "not_pending" });
      expect(await stateOf(admin, o.sessionId)).toMatchObject({
        refund: "succeeded",
        fakeRefunds: 1,
      });
    }
    expect(await problems(cases.map((c) => c.o.tripId))).toEqual([]);
  });

  it("processes events recorded but never processed, once, and sends the refunds they request", async ({
    expect,
  }) => {
    // A success for an open checkout, and one for a checkout the guest canceled.
    const open = await openCheckout(world, A, trips.shared(), 2);
    const canceled = await openCheckout(world, A, trips.shared(), 2);
    const result = await asGuest(runtime.db, A.id, (trx, ctx) =>
      cancelCheckoutSession(trx, ctx, { sessionId: canceled.sessionId, secret: canceled.secret }),
    );
    expect(result.kind).toBe("canceled");
    const openBody = (await settleFake(world, open, "succeeded")).body;
    const canceledBody = (await settleFake(world, canceled, "succeeded")).body;
    const ids = [await recordOnly(openBody), await recordOnly(canceledBody)];

    await beacon();
    const report = await sweep(world.provider);
    expect(report.reprocessed).toBeGreaterThanOrEqual(2);
    expect(await inboxState(ids[0] ?? "")).toEqual({
      processing_state: "processed",
      outcome: "confirmed",
    });
    expect(await inboxState(ids[1] ?? "")).toEqual({
      processing_state: "processed",
      outcome: "refund_required",
    });
    expect(await stateOf(admin, open.sessionId)).toMatchObject({
      session: "confirmed",
      bookings: 1,
    });
    expect(await stateOf(admin, canceled.sessionId)).toMatchObject({
      session: "unfulfilled",
      bookings: 0,
      refund: "succeeded",
      fakeRefunds: 1,
      exceptions: ["session_canceled"],
    });
    // The provider's retries afterwards change nothing.
    expect(await deliver(world, openBody)).toMatchObject({ duplicate: true, outcome: "confirmed" });
    expect(await deliver(world, canceledBody)).toMatchObject({
      duplicate: true,
      outcome: "refund_required",
    });
    expect((await stateOf(admin, canceled.sessionId)).fakeRefunds).toBe(1);
    expect(await problems([open.tripId, canceled.tripId])).toEqual([]);
  });

  it("leaves a fresh received event to the request that recorded it", async ({ expect }) => {
    const o = await openCheckout(world, A, trips.shared(), 1);
    const inboxId = await recordOnly((await settleFake(world, o, "succeeded")).body);
    await beacon();
    await sweepCheckouts(runtime.db, {
      runId: `adv-sweep-${randomUUID()}`,
      provider: world.provider,
    });
    expect(await inboxState(inboxId)).toEqual({ processing_state: "received", outcome: null });
    expect((await stateOf(admin, o.sessionId)).session).toBe("open");
    // Its redelivery finishes it.
    expect(
      await settle(deliver(world, (await settleFake(world, o, "succeeded")).body)),
    ).toMatchObject({
      ok: true,
      value: { outcome: "confirmed" },
    });
  });
});
