import { randomUUID } from "node:crypto";
import {
  createDb,
  inTenantTransaction,
  type TenantContext,
  type TenantTransaction,
} from "@tidegrid/database";
import type {} from "@tidegrid/database/global-setup";
import { tripAllocator } from "@tidegrid/domain-inventory/testing";
import { deliverTenantMessages, FakeEmailProvider } from "@tidegrid/domain-messaging";
import type { FakePaymentProvider } from "@tidegrid/domain-payments";
import { createPolicyVersion } from "@tidegrid/domain-pricing";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";
import { handleVerifiedEvent } from "./finalize.ts";
import {
  type BookingHooks,
  cancelBooking,
  getManagedBooking,
  manageSession,
  openManageSession,
  openManageSessionFromCheckout,
  previewCancellation,
  putParticipant,
  requestManageLink,
  settleRefund,
} from "./index.ts";
import {
  type CheckoutFixture,
  confirmBooking,
  craftedFakeEventBody,
  createCheckoutFixture,
  fakeProvider,
  guestContext,
  verifiedFakeEvent,
} from "./test-fixtures.ts";

type Sql = ReturnType<typeof postgres>;

const env = inject("integrationDb");

describe.skipIf(!env)("cancellation within policy, management, and booking email", () => {
  let admin: Sql;
  let runtime: ReturnType<typeof createDb>;
  let payments: FakePaymentProvider;
  let mail: FakeEmailProvider;
  let A: CheckoutFixture;
  let L: CheckoutFixture;
  let tripsA: ReturnType<typeof tripAllocator>;
  let tripsL: ReturnType<typeof tripAllocator>;

  const asGuest = <T>(
    tenantId: string,
    fn: (trx: TenantTransaction, ctx: TenantContext) => Promise<T>,
  ): Promise<T> => {
    const ctx = guestContext(tenantId);
    return inTenantTransaction(runtime.db, ctx, (trx) => fn(trx, ctx));
  };
  const deliver = (tenant: CheckoutFixture) =>
    deliverTenantMessages(runtime.db, tenant.id, {
      provider: mail,
      fromAddress: "bookings@tidegrid.test",
      guestLinkOrigin: "http://{slug}.book.localhost:5301",
      environment: "local",
      runId: `run-${randomUUID()}`,
    });
  async function seatsUsed(tripId: string) {
    const [row] = await admin<{ held: number }[]>`
      select coalesce(sum(seats), 0)::int as held from public.capacity_holds
       where trip_id = ${tripId} and state in ('active', 'confirmed')`;
    return row?.held ?? 0;
  }
  async function bookingRow(bookingId: string) {
    const [row] = await admin<
      { state: string; hold: string; refund: string | null; amount: number | null }[]
    >`
      select b.state, h.state as hold, r.state as refund, r.amount
        from public.bookings b
        join public.capacity_holds h on h.id = b.hold_id
        left join public.payment_refunds r on r.payment_id = b.payment_id
       where b.id = ${bookingId}`;
    return row;
  }

  beforeAll(async () => {
    if (!env) return;
    admin = postgres(env.adminUrl, { max: 2, onnotice: () => {} });
    runtime = createDb(env.runtimeUrl, { max: 8 });
    payments = fakeProvider(runtime.db);
    mail = new FakeEmailProvider({ db: runtime.db, environment: "local" });
    A = await createCheckoutFixture(admin, runtime.db, "cxl-a");
    // Late: its products' policy puts every trip inside a 30-day cutoff with a
    // 50% refund after it.
    L = await createCheckoutFixture(admin, runtime.db, "cxl-l");
    tripsA = tripAllocator(A);
    tripsL = tripAllocator(L);
    for (const t of [A, L]) {
      await admin`insert into public.tenant_hostnames (hostname, tenant_id, kind, status, verified_at)
        values (${`${t.slug}.book.localhost`}, ${t.id}, 'preview', 'active', now())`;
    }
    const products = await admin<{ id: string }[]>`
      select id from public.products where tenant_id = ${L.id} and kind = 'shared_seat'`;
    const ctx: TenantContext = { tenantId: L.id, actorType: "system", actorId: "test" };
    await inTenantTransaction(runtime.db, ctx, async (trx) => {
      for (const p of products) {
        const made = await createPolicyVersion(trx, ctx, {
          productId: p.id,
          changeCutoffMinutes: 43_200,
          beforeCutoff: { remedy: "full_refund" },
          afterCutoff: { remedy: "percent_refund", refundBp: 5000 },
          noShow: { remedy: "none" },
          text: {
            cancellation: "Within 30 days, half back.",
            reschedule: "Reschedule terms.",
            noShow: "No-show terms.",
            operatorCancellation: "Operator terms.",
            weather: "Weather terms.",
          },
          reason: "test: a long cutoff",
        });
        if (made.kind !== "created") throw new Error(`policy: ${JSON.stringify(made)}`);
      }
    });
  });

  afterAll(async () => {
    await runtime?.end();
    await admin?.end({ timeout: 5 });
  });

  it("emails the confirmation with a working link, which opens a session once", async () => {
    const booked = await confirmBooking(runtime.db, payments, A, tripsA.shared(), 2);
    const [queued] = await admin<{ template: string; state: string; link_purpose: string }[]>`
      select template, state, link_purpose from public.email_messages where booking_id = ${booked.bookingId}`;
    expect(queued).toEqual({
      template: "booking_confirmation",
      state: "queued",
      link_purpose: "booking_manage",
    });
    await deliver(A);
    const inbox = await mail.listMailbox(A.id);
    const email = inbox.find((m) => m.subject.includes(booked.reference));
    if (!email) throw new Error("no confirmation email");
    const message = await mail.getMailboxMessage(A.id, email.id);
    expect(message?.html).toContain("Total paid");
    const token = /#t=([A-Za-z0-9_-]{43})/.exec(message?.html ?? "")?.[1];
    if (!token) throw new Error("no link");
    const opened = await asGuest(A.id, (trx, ctx) => openManageSession(trx, ctx, { token }));
    expect(opened).toMatchObject({ kind: "opened", reference: booked.reference });
    expect(await asGuest(A.id, (trx, ctx) => openManageSession(trx, ctx, { token }))).toEqual({
      kind: "used",
    });
    if (opened.kind !== "opened") throw new Error("unreachable");
    const session = await asGuest(A.id, (trx) => manageSession(trx, A.id, opened.session.token));
    expect(session?.bookingId).toBe(booked.bookingId);
    const view = await asGuest(A.id, (trx) => getManagedBooking(trx, A.id, booked.bookingId));
    expect(view).toMatchObject({
      booking: { reference: booked.reference, state: "confirmed" },
      partyEditable: true,
      party: { partySize: 2, participants: [] },
      cancellation: { cancelable: true, remedy: "full_refund", refundBp: 10000 },
    });
  });

  it("cancels before the cutoff: full refund, seats back, email, once", async () => {
    const tripId = tripsA.shared();
    const booked = await confirmBooking(runtime.db, payments, A, tripId, 3);
    expect(await seatsUsed(tripId)).toBe(3);
    const terms = await asGuest(A.id, (trx) => previewCancellation(trx, A.id, booked.bookingId));
    if (!terms) throw new Error("no terms");
    expect(terms).toMatchObject({ cancelable: true, remedy: "full_refund", beforeCutoff: true });
    expect(terms.refundAmount).toBe(terms.paidAmount);

    const calls: string[] = [];
    const hooks: BookingHooks = {
      bookingCanceled: async (_trx, _ctx, event) => {
        calls.push(event.bookingId);
      },
    };
    const canceled = await asGuest(A.id, (trx, ctx) =>
      cancelBooking(
        trx,
        ctx,
        { bookingId: booked.bookingId, expectedRefundAmount: terms.refundAmount },
        hooks,
      ),
    );
    expect(canceled).toMatchObject({
      kind: "canceled",
      cancellation: { remedy: "full_refund", refundBp: 10000, refundAmount: terms.paidAmount },
    });
    expect(calls).toEqual([booked.bookingId]);
    expect(await seatsUsed(tripId)).toBe(0);
    expect(await bookingRow(booked.bookingId)).toMatchObject({
      state: "canceled",
      hold: "released",
      refund: "requested",
      amount: terms.paidAmount,
    });
    if (canceled.kind !== "canceled" || !canceled.cancellation.refundId)
      throw new Error("no refund");
    const settled = await settleRefund(
      runtime.db,
      payments,
      guestContext(A.id),
      canceled.cancellation.refundId,
    );
    expect(settled.kind).toBe("succeeded");
    // A second settle, as the sweep would retry, refunds nothing more.
    expect(
      (await settleRefund(runtime.db, payments, guestContext(A.id), canceled.cancellation.refundId))
        .kind,
    ).toBe("not_pending");
    const [fake] = await admin<{ refunded: number }[]>`
      select coalesce(sum(r.amount), 0)::int as refunded from public.fake_provider_refunds r
        join public.payments p on p.provider_payment_id = r.payment_id
        join public.bookings b on b.payment_id = p.id
       where b.id = ${booked.bookingId}`;
    expect(fake?.refunded).toBe(terms.paidAmount);

    // Once: a repeat answers with the first record and changes nothing.
    const again = await asGuest(A.id, (trx, ctx) =>
      cancelBooking(trx, ctx, { bookingId: booked.bookingId, expectedRefundAmount: 0 }),
    );
    expect(again).toMatchObject({
      kind: "already_canceled",
      cancellation: { refundId: canceled.cancellation.refundId },
    });
    const [counts] = await admin<{ cancellations: number; refunds: number; emails: number }[]>`
      select (select count(*)::int from public.booking_cancellations where booking_id = ${booked.bookingId}) as cancellations,
             (select count(*)::int from public.payment_refunds r join public.bookings b on b.payment_id = r.payment_id
               where b.id = ${booked.bookingId}) as refunds,
             (select count(*)::int from public.email_messages where booking_id = ${booked.bookingId}
               and template = 'booking_canceled') as emails`;
    expect(counts).toEqual({ cancellations: 1, refunds: 1, emails: 1 });

    // The party no longer changes, and a late duplicate success changes nothing.
    expect(
      await asGuest(A.id, (trx, ctx) =>
        putParticipant(trx, ctx, {
          bookingId: booked.bookingId,
          position: 1,
          details: { name: "Too Late", isMinor: false },
        }),
      ),
    ).toEqual({ kind: "booking_canceled" });
    const [pay] = await admin<{ provider_payment_id: string; id: string; amount: number }[]>`
      select p.provider_payment_id, p.id, p.amount from public.payments p
        join public.bookings b on b.payment_id = p.id where b.id = ${booked.bookingId}`;
    if (!pay) throw new Error("no payment");
    const late = await verifiedFakeEvent(
      payments,
      craftedFakeEventBody({
        type: "payment.succeeded",
        accountRef: A.accountRef,
        paymentRef: pay.provider_payment_id,
        amount: pay.amount,
        clientReference: pay.id,
      }),
    );
    const handled = await handleVerifiedEvent(runtime.db, payments, late, { requestId: "late" });
    expect(handled).toMatchObject({ kind: "processed", outcome: "already_succeeded" });
    expect(await bookingRow(booked.bookingId)).toMatchObject({
      state: "canceled",
      refund: "succeeded",
    });
  });

  it("applies the after-cutoff remedy, refuses changed terms, and rounds half up", async () => {
    const booked = await confirmBooking(runtime.db, payments, L, tripsL.shared(), 3);
    const terms = await asGuest(L.id, (trx) => previewCancellation(trx, L.id, booked.bookingId));
    if (!terms) throw new Error("no terms");
    expect(terms).toMatchObject({ remedy: "percent_refund", refundBp: 5000, beforeCutoff: false });
    expect(terms.refundAmount).toBe(Math.floor((terms.paidAmount * 5000 + 5000) / 10000));
    expect(
      await asGuest(L.id, (trx, ctx) =>
        cancelBooking(trx, ctx, {
          bookingId: booked.bookingId,
          expectedRefundAmount: terms.paidAmount,
        }),
      ),
    ).toMatchObject({ kind: "terms_changed", terms: { refundAmount: terms.refundAmount } });
    expect(await bookingRow(booked.bookingId)).toMatchObject({ state: "confirmed", refund: null });
    const canceled = await asGuest(L.id, (trx, ctx) =>
      cancelBooking(trx, ctx, {
        bookingId: booked.bookingId,
        expectedRefundAmount: terms.refundAmount,
      }),
    );
    expect(canceled).toMatchObject({
      kind: "canceled",
      cancellation: { refundAmount: terms.refundAmount },
    });
  });

  it("cancels concurrently once, with one refund and one email", async () => {
    const booked = await confirmBooking(runtime.db, payments, A, tripsA.shared(), 2);
    const terms = await asGuest(A.id, (trx) => previewCancellation(trx, A.id, booked.bookingId));
    if (!terms) throw new Error("no terms");
    const results = await Promise.all(
      Array.from({ length: 5 }, () =>
        asGuest(A.id, (trx, ctx) =>
          cancelBooking(trx, ctx, {
            bookingId: booked.bookingId,
            expectedRefundAmount: terms.refundAmount,
          }),
        ),
      ),
    );
    expect(results.filter((r) => r.kind === "canceled")).toHaveLength(1);
    expect(results.filter((r) => r.kind === "already_canceled")).toHaveLength(4);
    const [counts] = await admin<{ refunds: number; emails: number; released: number }[]>`
      select (select count(*)::int from public.payment_refunds r join public.bookings b on b.payment_id = r.payment_id
               where b.id = ${booked.bookingId}) as refunds,
             (select count(*)::int from public.email_messages where booking_id = ${booked.bookingId}
               and template = 'booking_canceled') as emails,
             (select count(*)::int from public.audit_events where subject_id = ${booked.bookingId}
               and action = 'booking.canceled') as released`;
    expect(counts).toEqual({ refunds: 1, emails: 1, released: 1 });
  });

  it("opens a session from the paying checkout within the hour, and limits link emails", async () => {
    const booked = await confirmBooking(runtime.db, payments, A, tripsA.shared(), 1);
    const opened = await asGuest(A.id, (trx, ctx) =>
      openManageSessionFromCheckout(trx, ctx, {
        checkoutSessionId: booked.checkoutSessionId,
        secret: booked.secret,
      }),
    );
    expect(opened).toMatchObject({ kind: "opened", reference: booked.reference });
    expect(
      await asGuest(A.id, (trx, ctx) =>
        openManageSessionFromCheckout(trx, ctx, {
          checkoutSessionId: booked.checkoutSessionId,
          secret: "A".repeat(43),
        }),
      ),
    ).toEqual({ kind: "not_found" });
    const kinds: string[] = [];
    for (let i = 0; i < 4; i++) {
      const sent = await asGuest(A.id, (trx, ctx) =>
        requestManageLink(trx, ctx, { bookingId: booked.bookingId, requestKey: `req-${i}` }),
      );
      kinds.push(sent.kind);
    }
    expect(kinds).toEqual(["enqueued", "enqueued", "enqueued", "rate_limited"]);
  });

  it("refuses a credit remedy, which the operator issues, in the service and the database", async () => {
    const C = await createCheckoutFixture(admin, runtime.db, "cxl-c");
    const products = await admin<{ id: string }[]>`
      select id from public.products where tenant_id = ${C.id} and kind = 'shared_seat'`;
    const ctx: TenantContext = { tenantId: C.id, actorType: "system", actorId: "test" };
    await inTenantTransaction(runtime.db, ctx, async (trx) => {
      for (const p of products) {
        const made = await createPolicyVersion(trx, ctx, {
          productId: p.id,
          changeCutoffMinutes: 43_200,
          beforeCutoff: { remedy: "full_refund" },
          afterCutoff: { remedy: "credit" },
          noShow: { remedy: "none" },
          text: {
            cancellation: "Within 30 days, a credit.",
            reschedule: "Reschedule terms.",
            noShow: "No-show terms.",
            operatorCancellation: "Operator terms.",
            weather: "Weather terms.",
          },
          reason: "test: credit after a long cutoff",
        });
        if (made.kind !== "created") throw new Error(`policy: ${JSON.stringify(made)}`);
      }
    });
    const booked = await confirmBooking(runtime.db, payments, C, tripAllocator(C).shared(), 1);
    const terms = await asGuest(C.id, (trx) => previewCancellation(trx, C.id, booked.bookingId));
    expect(terms).toMatchObject({
      cancelable: false,
      refusal: "remedy_requires_operator",
      remedy: "credit",
      refundAmount: 0,
    });
    expect(
      await asGuest(C.id, (trx, ctx) =>
        cancelBooking(trx, ctx, { bookingId: booked.bookingId, expectedRefundAmount: 0 }),
      ),
    ).toMatchObject({ kind: "remedy_requires_operator" });
    // Even a writer that skips the service cannot choose a remedy the policy does not give.
    const [b] = await admin<
      { payment_id: string; amount: number; product_id: string; v: number }[]
    >`
      select b.payment_id, p.amount, o.product_id, o.policy_version as v
        from public.bookings b join public.payments p on p.id = b.payment_id
        join public.orders o on o.id = b.order_id where b.id = ${booked.bookingId}`;
    if (!b) throw new Error("no booking");
    let refused: { code?: string; constraint_name?: string } = {};
    try {
      await admin`insert into public.booking_cancellations (tenant_id, booking_id, payment_id,
          product_id, policy_version, departs_at, cutoff_at, before_cutoff, remedy, refund_bp,
          paid_amount, refund_amount)
        select ${C.id}, ${booked.bookingId}, ${b.payment_id}, ${b.product_id}, ${b.v}, t.starts_at,
               t.starts_at - interval '30 days', false, 'none', 0, ${b.amount}, 0
          from public.scheduled_trips t join public.bookings bk on bk.trip_id = t.id
         where bk.id = ${booked.bookingId}`;
    } catch (err) {
      refused = err as typeof refused;
    }
    expect(refused).toMatchObject({
      code: "23514",
      constraint_name: "booking_cancellations_credit",
    });
  });

  it("never reaches another tenant's booking", async () => {
    const booked = await confirmBooking(runtime.db, payments, A, tripsA.shared(), 1);
    expect(
      await asGuest(L.id, (trx) => previewCancellation(trx, L.id, booked.bookingId)),
    ).toBeNull();
    expect(await asGuest(L.id, (trx) => getManagedBooking(trx, L.id, booked.bookingId))).toBeNull();
    expect(
      await asGuest(L.id, (trx, ctx) =>
        cancelBooking(trx, ctx, { bookingId: booked.bookingId, expectedRefundAmount: 0 }),
      ),
    ).toEqual({ kind: "not_found" });
    expect(
      await asGuest(L.id, (trx, ctx) =>
        openManageSessionFromCheckout(trx, ctx, {
          checkoutSessionId: booked.checkoutSessionId,
          secret: booked.secret,
        }),
      ),
    ).toEqual({ kind: "not_found" });
    expect(await bookingRow(booked.bookingId)).toMatchObject({ state: "confirmed" });
  });
});
