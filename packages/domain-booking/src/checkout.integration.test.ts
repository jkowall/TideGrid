import { randomUUID } from "node:crypto";
import {
  createDb,
  inTenantTransaction,
  type TenantContext,
  type TenantTransaction,
} from "@tidegrid/database";
import type {} from "@tidegrid/database/global-setup";
import { changeTripSalesState } from "@tidegrid/domain-catalog";
import { systemContext, tripAllocator } from "@tidegrid/domain-inventory/testing";
import { FAKE_MINIMUM_AMOUNT, type FakePaymentProvider } from "@tidegrid/domain-payments";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";
import {
  type CreateCheckoutInput,
  cancelCheckoutSession,
  createCheckoutSession,
  ensureProviderPayment,
  getCheckoutSession,
  handleVerifiedEvent,
  listFinalizationExceptions,
  listTripBookings,
  MAX_OPEN_CHECKOUTS_PER_CLIENT,
  sweepCheckouts,
} from "./index.ts";
import {
  backdateCheckout,
  type CheckoutFixture,
  craftedFakeEventBody,
  createCheckoutFixture,
  fakeProvider,
  guestContext,
  newSecret,
  quoteFor,
  verifiedFakeEvent,
} from "./test-fixtures.ts";

type Sql = ReturnType<typeof postgres>;

const env = inject("integrationDb");

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

describe.skipIf(!env)("checkout to confirmation against a real database", () => {
  let admin: Sql;
  let runtime: ReturnType<typeof createDb>;
  let provider: FakePaymentProvider;
  let A: CheckoutFixture;
  let B: CheckoutFixture;
  let tripsA: ReturnType<typeof tripAllocator>;

  const asGuest = <T>(
    tenantId: string,
    fn: (trx: TenantTransaction, ctx: TenantContext) => Promise<T>,
  ): Promise<T> => {
    const ctx = guestContext(tenantId);
    return inTenantTransaction(runtime.db, ctx, (trx) => fn(trx, ctx));
  };

  /** A quote and an open checkout on it, with its provider payment created. */
  async function checkout(
    tenant: CheckoutFixture,
    tripId: string,
    party: number,
    options: { charter?: boolean; overrides?: Partial<CreateCheckoutInput> } = {},
  ) {
    const quote = await quoteFor(runtime.db, tenant.id, tripId, party, {
      promotionCode: tenant.promotionCode,
      charter: options.charter ?? false,
    });
    const overrides = options.overrides ?? {};
    const secret = newSecret();
    const created = await asGuest(tenant.id, (trx, ctx) =>
      createCheckoutSession(trx, ctx, {
        quoteId: quote.quoteId,
        acceptedPolicyVersion: quote.policy.version,
        booker: { name: "Test Booker", email: "Booker@Example.TEST" },
        secret,
        clientAddress: null,
        provider: "fake",
        minimumAmount: FAKE_MINIMUM_AMOUNT,
        ...overrides,
      }),
    );
    if (created.kind !== "created") throw new Error(`checkout: ${JSON.stringify(created)}`);
    const ready = await ensureProviderPayment(
      runtime.db,
      provider,
      guestContext(tenant.id),
      created.session.id,
    );
    if (ready.kind !== "ready") throw new Error(`payment: ${JSON.stringify(ready)}`);
    return { quote, secret, session: created.session, paymentRef: ready.paymentRef };
  }

  /** Settle the fake payment and deliver its event through the real webhook path. */
  async function pay(tenant: CheckoutFixture, paymentRef: string, outcome: "succeeded" | "failed") {
    const settled = await provider.settlePayment(tenant.id, paymentRef, outcome, Date.now());
    if (settled.kind === "not_found") throw new Error("no fake payment");
    return deliver(settled.event.body);
  }

  async function deliver(body: string) {
    const event = await verifiedFakeEvent(provider, body);
    return handleVerifiedEvent(runtime.db, provider, event, { requestId: `wh-${randomUUID()}` });
  }

  async function stateOf(sessionId: string) {
    const [row] = await admin<
      {
        session: string;
        hold: string;
        order: string;
        payment: string;
        bookings: number;
        refund: string | null;
      }[]
    >`
      select s.state as session, h.state as hold, o.status as order, p.state as payment,
             (select count(*)::int from public.bookings b where b.checkout_session_id = s.id) as bookings,
             (select r.state from public.payment_refunds r where r.payment_id = p.id) as refund
        from public.checkout_sessions s
        join public.capacity_holds h on h.id = s.hold_id
        join public.orders o on o.checkout_session_id = s.id
        join public.payments p on p.checkout_session_id = s.id
       where s.id = ${sessionId}`;
    if (!row) throw new Error("no session");
    return row;
  }

  beforeAll(async () => {
    if (!env) return;
    admin = postgres(env.adminUrl, { max: 2, onnotice: () => {} });
    runtime = createDb(env.runtimeUrl, { max: 4 });
    provider = fakeProvider(runtime.db);
    A = await createCheckoutFixture(admin, runtime.db, "chk-a");
    B = await createCheckoutFixture(admin, runtime.db, "chk-b");
    tripsA = tripAllocator(A);
  });

  afterAll(async () => {
    await runtime?.end();
    await admin?.end({ timeout: 5 });
  });

  it("opens a checkout: a hold, the order copied from the quote, and a pending payment", async () => {
    const tripId = tripsA.shared();
    const { quote, session, paymentRef } = await checkout(A, tripId, 3);
    expect(session).toMatchObject({
      state: "open",
      quoteId: quote.quoteId,
      tripId,
      partySize: 3,
      amount: quote.totals.total,
      currency: "USD",
      booking: null,
      refund: null,
    });
    const [row] = await admin<
      {
        hold_state: string;
        hold_expires: string;
        session_expires: string;
        booker_email: string;
        order_total: number;
        payment_amount: number;
        payment_key: string;
        provider_payment_id: string;
        account_ref: string;
      }[]
    >`
      select h.state as hold_state, h.expires_at::text as hold_expires,
             s.expires_at::text as session_expires, s.booker_email,
             o.total_amount as order_total, p.amount as payment_amount,
             p.idempotency_key as payment_key, p.provider_payment_id, p.account_ref
        from public.checkout_sessions s
        join public.capacity_holds h on h.id = s.hold_id
        join public.orders o on o.checkout_session_id = s.id
        join public.payments p on p.checkout_session_id = s.id
       where s.id = ${session.id}`;
    expect(row).toMatchObject({
      hold_state: "active",
      booker_email: "booker@example.test",
      order_total: quote.totals.total,
      payment_amount: quote.totals.total,
      provider_payment_id: paymentRef,
      account_ref: A.accountRef,
    });
    expect(row?.session_expires).toBe(row?.hold_expires);
    expect(row?.payment_key).toMatch(/^checkout_payment:[0-9a-f-]{36}$/);

    // Every quote line, with the tax and discount, is on the order.
    const lines = await admin<{ kind: string; amount: number; line_no: number }[]>`
      select l.kind, l.amount, l.line_no from public.order_lines l
        join public.orders o on o.id = l.order_id
       where o.checkout_session_id = ${session.id}
       order by l.line_no`;
    expect(lines.map((l) => l.kind)).toEqual(["service", "discount", "tax"]);
    expect(lines.find((l) => l.kind === "tax")?.amount).toBe(quote.totals.tax);
    expect(quote.totals.discount).toBeGreaterThan(0);
  });

  it("refuses a stale quote, a used quote, an unaccepted policy, and another tenant's quote", async () => {
    const stale = await quoteFor(runtime.db, A.id, tripsA.shared(), 1, {
      now: new Date(Date.now() - 31 * 60_000),
    });
    const attempt = (tenantId: string, quoteId: string, policy: number) =>
      asGuest(tenantId, (trx, ctx) =>
        createCheckoutSession(trx, ctx, {
          quoteId,
          acceptedPolicyVersion: policy,
          booker: { name: "Late Guest", email: "late@example.test" },
          secret: newSecret(),
          clientAddress: null,
          provider: "fake",
          minimumAmount: FAKE_MINIMUM_AMOUNT,
        }),
      );
    expect(await attempt(A.id, stale.quoteId, stale.policy.version)).toEqual({
      kind: "quote_expired",
    });
    const fresh = await quoteFor(runtime.db, A.id, tripsA.shared(), 1);
    expect(await attempt(A.id, fresh.quoteId, fresh.policy.version + 1)).toEqual({
      kind: "policy_not_accepted",
      policyVersion: fresh.policy.version,
    });
    expect(await attempt(B.id, fresh.quoteId, fresh.policy.version)).toEqual({
      kind: "quote_not_found",
    });
    expect((await attempt(A.id, fresh.quoteId, fresh.policy.version)).kind).toBe("created");
    expect(await attempt(A.id, fresh.quoteId, fresh.policy.version)).toEqual({
      kind: "quote_already_used",
    });
  });

  it("limits open checkouts per client address", async () => {
    const results: string[] = [];
    for (let i = 0; i <= MAX_OPEN_CHECKOUTS_PER_CLIENT; i++) {
      const quote = await quoteFor(runtime.db, A.id, tripsA.shared(), 1);
      const created = await asGuest(A.id, (trx, ctx) =>
        createCheckoutSession(trx, ctx, {
          quoteId: quote.quoteId,
          acceptedPolicyVersion: quote.policy.version,
          booker: { name: "Busy Guest", email: "busy@example.test" },
          secret: newSecret(),
          clientAddress: "203.0.113.7",
          provider: "fake",
          minimumAmount: FAKE_MINIMUM_AMOUNT,
        }),
      );
      results.push(created.kind);
    }
    expect(results).toEqual([
      ...Array(MAX_OPEN_CHECKOUTS_PER_CLIENT).fill("created"),
      "too_many_checkouts",
    ]);
  });

  it("confirms a booking only on a verified success, once", async () => {
    const tripId = tripsA.shared();
    const { session, paymentRef, secret } = await checkout(A, tripId, 2);
    const handled = await pay(A, paymentRef, "succeeded");
    expect(handled).toMatchObject({ kind: "processed", duplicate: false, outcome: "confirmed" });
    expect(await stateOf(session.id)).toEqual({
      session: "confirmed",
      hold: "confirmed",
      order: "paid",
      payment: "succeeded",
      bookings: 1,
      refund: null,
    });
    const view = await asGuest(A.id, (trx) =>
      getCheckoutSession(trx, A.id, { sessionId: session.id, secret }),
    );
    expect(view?.state).toBe("confirmed");
    expect(view?.booking?.reference).toMatch(/^[0-9A-HJKMNP-TV-Z]{8}$/);

    // The same event again, and a second success event for the same payment.
    const fake = await provider.getPayment(A.id, paymentRef);
    const first = fake?.events[0];
    if (!first) throw new Error("no fake event");
    expect(await deliver(first.body)).toMatchObject({
      kind: "processed",
      duplicate: true,
      outcome: "confirmed",
    });
    const again = craftedFakeEventBody({
      type: "payment.succeeded",
      accountRef: A.accountRef,
      paymentRef,
      amount: session.amount,
      clientReference: (
        await admin<{ id: string }[]>`
          select id from public.payments where checkout_session_id = ${session.id}`
      )[0]?.id as string,
    });
    expect(await deliver(again)).toMatchObject({ outcome: "already_succeeded" });
    // A failure delivered after the success changes nothing.
    const late = craftedFakeEventBody({
      type: "payment.failed",
      accountRef: A.accountRef,
      paymentRef,
      amount: session.amount,
      clientReference: null,
    });
    expect(await deliver(late)).toMatchObject({ outcome: "ignored_after_success" });
    expect(await stateOf(session.id)).toMatchObject({ session: "confirmed", bookings: 1 });

    const bookings = await asGuest(A.id, (trx) => listTripBookings(trx, A.id, tripId));
    expect(bookings?.map((b) => b.booker)).toEqual([
      { name: "Test Booker", email: "booker@example.test" },
    ]);
    const [events] = await admin<{ topics: string[] }[]>`
      select array_agg(topic order by id) as topics from public.outbox_events
       where tenant_id = ${A.id} and payload->>'checkoutSessionId' = ${session.id}`;
    expect(events?.topics).toEqual([
      "checkout.session.opened",
      "payment.succeeded",
      "booking.confirmed",
    ]);
  });

  it("releases the hold on a verified failure", async () => {
    const { session, paymentRef } = await checkout(A, tripsA.shared(), 2);
    expect(await pay(A, paymentRef, "failed")).toMatchObject({ outcome: "released" });
    expect(await stateOf(session.id)).toEqual({
      session: "failed",
      hold: "released",
      order: "void",
      payment: "failed",
      bookings: 0,
      refund: null,
    });
  });

  it("expires with its hold, then a late success reacquires or is refunded", async () => {
    const tripId = tripsA.charter();
    const late = await checkout(A, tripId, 2, { charter: true });
    await backdateCheckout(admin, late.session.id);
    const swept = await sweepCheckouts(runtime.db, { runId: `sweep-${randomUUID()}`, provider });
    expect(swept.expired).toBeGreaterThanOrEqual(1);
    expect(await stateOf(late.session.id)).toMatchObject({ session: "expired", hold: "expired" });
    expect(await pay(A, late.paymentRef, "succeeded")).toMatchObject({
      outcome: "confirmed_reacquired",
    });
    expect(await stateOf(late.session.id)).toMatchObject({
      session: "confirmed",
      hold: "confirmed",
      bookings: 1,
    });

    // Another charter checkout on a new trip expires, someone else takes the
    // boat, and the late success is refunded with an exception.
    const other = tripsA.charter();
    const lost = await checkout(A, other, 2, { charter: true });
    await backdateCheckout(admin, lost.session.id);
    const taker = await checkout(A, other, 3, { charter: true });
    expect(taker.session.state).toBe("open");
    const handled = await pay(A, lost.paymentRef, "succeeded");
    expect(handled).toMatchObject({
      outcome: "refund_required",
      refund: { kind: "succeeded" },
    });
    expect(await stateOf(lost.session.id)).toEqual({
      session: "paid",
      hold: "expired",
      order: "void",
      payment: "succeeded",
      bookings: 0,
      refund: "succeeded",
    });
    const exceptions = await asGuest(A.id, (trx) =>
      listFinalizationExceptions(trx, A.id, { limit: 10 }),
    );
    expect(exceptions.find((e) => e.checkoutSessionId === lost.session.id)).toMatchObject({
      reason: "no_capacity",
      refund: { state: "succeeded", amount: lost.session.amount },
    });
    const fake = await provider.getPayment(A.id, lost.paymentRef);
    expect(fake?.amountRefunded).toBe(lost.session.amount);
  });

  it("refunds a success after the guest canceled", async () => {
    const { session, paymentRef, secret } = await checkout(A, tripsA.shared(), 1);
    const canceled = await asGuest(A.id, (trx, ctx) =>
      cancelCheckoutSession(trx, ctx, { sessionId: session.id, secret }),
    );
    expect(canceled.kind).toBe("canceled");
    expect(await stateOf(session.id)).toMatchObject({ session: "canceled", hold: "released" });
    expect(await pay(A, paymentRef, "succeeded")).toMatchObject({ outcome: "refund_required" });
    expect(await stateOf(session.id)).toMatchObject({
      session: "paid",
      payment: "succeeded",
      refund: "succeeded",
      bookings: 0,
    });
  });

  it("returns the same provider payment after a crash before its id was recorded", async () => {
    const quote = await quoteFor(runtime.db, A.id, tripsA.shared(), 1);
    const created = await asGuest(A.id, (trx, ctx) =>
      createCheckoutSession(trx, ctx, {
        quoteId: quote.quoteId,
        acceptedPolicyVersion: quote.policy.version,
        booker: { name: "Crash Guest", email: "crash@example.test" },
        secret: newSecret(),
        clientAddress: null,
        provider: "fake",
        minimumAmount: FAKE_MINIMUM_AMOUNT,
      }),
    );
    if (created.kind !== "created") throw new Error(created.kind);
    const [payment] = await admin<{ id: string; idempotency_key: string; amount: number }[]>`
      select id, idempotency_key, amount from public.payments
       where checkout_session_id = ${created.session.id}`;
    if (!payment) throw new Error("no payment");
    // The provider call succeeds, then the Worker stops before recording it.
    const lostCall = await provider.createPayment({
      accountRef: A.accountRef,
      amount: payment.amount,
      currency: "USD",
      idempotencyKey: payment.idempotency_key,
      clientReference: payment.id,
    });
    const retried = await ensureProviderPayment(
      runtime.db,
      provider,
      guestContext(A.id),
      created.session.id,
    );
    expect(retried).toMatchObject({ kind: "ready", paymentRef: lostCall.paymentRef });
    const [after] = await admin<{ n: number; provider_payment_id: string }[]>`
      select (select count(*)::int from public.fake_provider_payments
               where idempotency_key = ${payment.idempotency_key}) as n,
             p.provider_payment_id
        from public.payments p where p.id = ${payment.id}`;
    expect(after).toEqual({ n: 1, provider_payment_id: lostCall.paymentRef });
  });

  it("refuses to mark anything paid or booked without a verified event", async () => {
    const { session } = await checkout(A, tripsA.shared(), 1);
    const [ids] = await admin<{ payment: string; order: string; hold: string }[]>`
      select p.id as payment, o.id as order, s.hold_id as hold
        from public.checkout_sessions s
        join public.payments p on p.checkout_session_id = s.id
        join public.orders o on o.checkout_session_id = s.id
       where s.id = ${session.id}`;
    if (!ids) throw new Error("no ids");
    const ctx = systemContext(A.id);
    const asRuntime = <T>(fn: (trx: TenantTransaction) => Promise<T>) =>
      inTenantTransaction(runtime.db, ctx, fn);
    expect(
      await failure(
        asRuntime((trx) =>
          trx
            .updateTable("payments")
            .set({ state: "succeeded" })
            .where("id", "=", ids.payment)
            .execute(),
        ),
      ),
    ).toMatchObject({ code: "23514" });
    expect(
      await failure(
        asRuntime((trx) =>
          trx
            .updateTable("checkout_sessions")
            .set({ state: "confirmed" })
            .where("id", "=", session.id)
            .execute(),
        ),
      ),
    ).toMatchObject({ code: "23514", constraint: "checkout_sessions_evidence" });
    expect(
      await failure(
        asRuntime((trx) =>
          trx.updateTable("orders").set({ status: "paid" }).where("id", "=", ids.order).execute(),
        ),
      ),
    ).toMatchObject({ code: "23514", constraint: "orders_evidence" });
    expect(
      await failure(
        asRuntime((trx) =>
          trx
            .insertInto("bookings")
            .values({
              tenant_id: A.id,
              reference: "ABCDEFGH",
              checkout_session_id: session.id,
              order_id: ids.order,
              payment_id: ids.payment,
              hold_id: ids.hold,
              trip_id: session.tripId,
              party_size: 1,
              reacquired: false,
            })
            .execute(),
        ),
      ),
    ).toMatchObject({ code: "23514", constraint: "bookings_evidence" });
    // Even the owner role cannot.
    expect(
      await failure(
        admin`update public.payments set state = 'succeeded' where id = ${ids.payment}`,
      ),
    ).toMatchObject({ code: "23514" });
  });

  it("refuses to cancel a trip that has a confirmed booking", async () => {
    const tripId = tripsA.shared();
    const { paymentRef } = await checkout(A, tripId, 1);
    await pay(A, paymentRef, "succeeded");
    const ctx = systemContext(A.id);
    const changed = await inTenantTransaction(runtime.db, ctx, (trx) =>
      changeTripSalesState(trx, ctx, { tripId, to: "canceled", reason: "test", now: new Date() }),
    );
    expect(changed).toEqual({ kind: "has_bookings", confirmed: 1 });
    expect(
      await failure(
        admin`update public.scheduled_trips set sales_state = 'canceled' where id = ${tripId}`,
      ),
    ).toMatchObject({ code: "23514", constraint: "scheduled_trips_cancel_with_bookings" });
  });
});
