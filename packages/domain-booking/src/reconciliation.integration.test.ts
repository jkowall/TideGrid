/**
 * External payment and reconciliation (W3-G2.10) on the local PostgreSQL:
 * cash, check, and other tender recorded with a reason and a key; TideGrid's
 * fee assessed once when a booking closes; draft invoices with the carry
 * forward and the annual-minimum true-up; disputes moved only by verified
 * events; pending payments past their hold read at the provider without ever
 * changing (D1, proposed); and the month's report, whose rows add up to the
 * fee ledgers.
 */
import { randomBytes, randomUUID } from "node:crypto";
import {
  createDb,
  inTenantTransaction,
  type TenantContext,
  type TenantTransaction,
} from "@tidegrid/database";
import type {} from "@tidegrid/database/global-setup";
import { tripAllocator } from "@tidegrid/domain-inventory/testing";
import type { FakePaymentProvider, ProviderPayment } from "@tidegrid/domain-payments";
import { sql } from "kysely";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";
import { FlakyProvider } from "./adversarial/harness.ts";
import { CORE_FEE_BP, feeReversalFor } from "./fee-ledger.ts";
import { handleVerifiedEvent } from "./finalize.ts";
import {
  assessClosedBookings,
  checkPendingPayment,
  createCheckoutSession,
  ensureProviderPayment,
  issueNextInvoice,
  listDisputes,
  listExternalSettlements,
  listFeeInvoices,
  listPaymentReconciliationExceptions,
  previewCancellation,
  previewStaffCancellation,
  reconciliationReport,
  recordExternalSettlement,
  staffCancelBooking,
  sweepReconciliation,
} from "./index.ts";
import {
  backdateCheckout,
  type CheckoutFixture,
  confirmBooking,
  createCheckoutFixture,
  fakeProvider,
  guestContext,
  newSecret,
  quoteFor,
  verifiedFakeEvent,
} from "./test-fixtures.ts";

type Sql = ReturnType<typeof postgres>;

const env = inject("integrationDb");

function staffContext(tenantId: string, actorId = "staff-g210"): TenantContext {
  return { tenantId, actorType: "staff", actorId, requestId: `req-${randomUUID()}` };
}

function systemContext(tenantId: string): TenantContext {
  return { tenantId, actorType: "system", actorId: "test-g210", requestId: `req-${randomUUID()}` };
}

function fakeEventId(): string {
  const suffix = randomBytes(18)
    .toString("base64")
    .replace(/[^A-Za-z0-9]/g, "")
    .padEnd(24, "x")
    .slice(0, 24);
  return `fevt_${suffix}`;
}

/** A signed fake dispute event body, shaped like Stripe's charge.dispute.* events. */
function disputeEventBody(input: {
  accountRef: string;
  disputeRef: string;
  paymentRef: string;
  amount: number;
  status: "needs_response" | "under_review" | "won" | "lost" | "closed";
}): string {
  return JSON.stringify({
    id: fakeEventId(),
    object: "event",
    type: "dispute.updated",
    created: Math.floor(Date.now() / 1000),
    account: input.accountRef,
    data: {
      object: {
        object: "dispute",
        id: input.disputeRef,
        payment: input.paymentRef,
        amount: input.amount,
        currency: "usd",
        status: input.status,
        reason: "fraudulent",
      },
    },
  });
}

/** A provider whose reading of a payment the test chooses. */
class ReadingProvider extends FlakyProvider {
  reading: ((real: ProviderPayment | null) => ProviderPayment | null) | null = null;
  override async retrievePayment(input: { accountRef: string; paymentRef: string }) {
    const real = await super.retrievePayment(input);
    return this.reading ? this.reading(real) : real;
  }
}

describe.skipIf(!env)("external payment and reconciliation (W3-G2.10)", () => {
  let admin: Sql;
  let runtime: ReturnType<typeof createDb>;
  let payments: FakePaymentProvider;
  let A: CheckoutFixture;
  let B: CheckoutFixture;
  let tripsA: ReturnType<typeof tripAllocator>;
  let tripsB: ReturnType<typeof tripAllocator>;
  let daysBack = 1;

  const as = <T>(
    ctx: TenantContext,
    fn: (trx: TenantTransaction, ctx: TenantContext) => Promise<T>,
  ): Promise<T> => inTenantTransaction(runtime.db, ctx, (trx) => fn(trx, ctx));

  async function paymentOf(bookingId: string) {
    const [row] = await admin<
      { id: string; ref: string; amount: number; state: string; total: number; eligible: number }[]
    >`
      select p.id, p.provider_payment_id as ref, p.amount, p.state, o.total_amount as total,
             o.total_amount - o.tax_amount - o.included_tax_amount as eligible
        from public.bookings b
        join public.payments p on p.id = b.payment_id
        join public.orders o on o.id = b.order_id
       where b.id = ${bookingId}`;
    if (!row) throw new Error("no payment for the booking");
    return row;
  }

  /** Move a booking's trip into the past, each call to its own day so boats never overlap. */
  async function endTrip(bookingId: string) {
    daysBack += 1;
    await admin`
      with t as (select date_trunc('minute', now()) - make_interval(days => ${daysBack}) as s)
      update public.scheduled_trips st
         set starts_at = t.s, ends_at = t.s + make_interval(mins => st.duration_minutes),
             boat_free_at = t.s + (st.boat_free_at - st.starts_at),
             local_date = (t.s at time zone st.time_zone)::date,
             local_start_time = (t.s at time zone st.time_zone)::time(0)
        from t, public.bookings b
       where b.id = ${bookingId} and st.id = b.trip_id`;
  }

  /** Move a ledger row's time, as if it was written then. Admin only, triggers off. */
  async function backdate(table: string, id: string, at: Date) {
    await admin.begin(async (tx) => {
      await tx`set local session_replication_role = replica`;
      await tx`update ${tx(`public.${table}`)} set created_at = ${at} where id = ${id}`;
    });
  }

  beforeAll(async () => {
    if (!env) return;
    admin = postgres(env.adminUrl, { max: 2, onnotice: () => {} });
    runtime = createDb(env.runtimeUrl, { max: 8 });
    payments = fakeProvider(runtime.db);
    A = await createCheckoutFixture(admin, runtime.db, "g210-a");
    B = await createCheckoutFixture(admin, runtime.db, "g210-b");
    tripsA = tripAllocator(A);
    tripsB = tripAllocator(B);
  });

  afterAll(async () => {
    await runtime?.end();
    await admin?.end({ timeout: 5 });
  });

  it("records cash, check, and other tender with a reason and a key, and bounds refunds", async () => {
    const booked = await confirmBooking(runtime.db, payments, A, tripsA.shared(), 2);
    const paid = await paymentOf(booked.bookingId);
    const staff = staffContext(A.id);
    const key = `external:${randomUUID()}`;
    const record = (input: Partial<Parameters<typeof recordExternalSettlement>[2]> = {}) =>
      as(staff, (trx, c) =>
        recordExternalSettlement(trx, c, {
          bookingId: booked.bookingId,
          kind: "payment",
          tender: "cash",
          amount: 2_000,
          reason: "Guest paid the deposit balance at the dock",
          idempotencyKey: key,
          ...input,
        }),
      );

    const first = await record();
    expect(first).toMatchObject({
      kind: "recorded",
      replayed: false,
      settlement: {
        kind: "payment",
        tender: "cash",
        amount: 2_000,
        tenderReference: null,
        eligibleAmount: null,
        feeAmount: null,
        recordedBy: "staff-g210",
      },
    });
    // The same command under the same key answers the first record.
    const again = await record();
    expect(again).toMatchObject({ kind: "recorded", replayed: true });
    if (first.kind !== "recorded" || again.kind !== "recorded") throw new Error("not recorded");
    expect(again.settlement.id).toBe(first.settlement.id);
    // Another command under it is refused.
    expect(await record({ amount: 2_001 })).toEqual({ kind: "key_reused" });

    // Only a signed-in staff member records external money, in code and in the database.
    await expect(
      as(systemContext(A.id), (trx, c) =>
        recordExternalSettlement(trx, c, {
          bookingId: booked.bookingId,
          kind: "payment",
          tender: "cash",
          amount: 1,
          reason: "system",
          idempotencyKey: `external:${randomUUID()}`,
        }),
      ),
    ).rejects.toThrow(TypeError);
    await expect(
      as(systemContext(A.id), (trx) =>
        sql`insert into external_settlements (tenant_id, booking_id, kind, tender, amount, reason,
              idempotency_key)
            values (${A.id}, ${booked.bookingId}, 'payment', 'cash', 1, 'system',
              ${`external:${randomUUID()}`})`.execute(trx),
      ),
    ).rejects.toMatchObject({ code: "42501" });

    // Another tenant's booking is not found, whoever asks.
    expect(
      await as(staffContext(B.id), (trx, c) =>
        recordExternalSettlement(trx, c, {
          bookingId: booked.bookingId,
          kind: "payment",
          tender: "check",
          amount: 100,
          reason: "wrong tenant",
          idempotencyKey: `external:${randomUUID()}`,
        }),
      ),
    ).toEqual({ kind: "not_found" });
    expect(
      await as(staffContext(B.id), (trx) => listExternalSettlements(trx, B.id, booked.bookingId)),
    ).toBeNull();

    // Money in: the card payment and the cash. A refund may return at most the
    // lower of that and the booking's total.
    const listed = await as(staff, (trx) => listExternalSettlements(trx, A.id, booked.bookingId));
    expect(listed?.refundable).toBe(Math.min(paid.amount + 2_000, paid.total));
    expect(
      await record({
        kind: "refund",
        amount: paid.total + 1,
        idempotencyKey: `external:${randomUUID()}`,
      }),
    ).toEqual({ kind: "refund_too_large", refundable: listed?.refundable });

    const refundKey = `external:${randomUUID()}`;
    const refund = await record({
      kind: "refund",
      tender: "check",
      amount: 1_500,
      reason: "Weather shortened the trip",
      tenderReference: "CHK-1042",
      idempotencyKey: refundKey,
    });
    const expected = feeReversalFor({
      refundAmount: 1_500,
      orderTotal: paid.total,
      eligibleTotal: paid.eligible,
    });
    expect(refund).toMatchObject({
      kind: "recorded",
      settlement: {
        kind: "refund",
        tender: "check",
        tenderReference: "CHK-1042",
        eligibleAmount: expected.eligibleAmount,
        feeAmount: expected.feeAmount,
      },
    });
    expect(expected.feeAmount).toBeLessThan(0);

    // Refunds together never pass the booking's total, here by one cent.
    const rest = paid.total - 1_500;
    expect(
      await record({
        kind: "refund",
        amount: rest + 1,
        idempotencyKey: `external:${randomUUID()}`,
      }),
    ).toMatchObject({ kind: "refund_too_large", refundable: rest });
    expect(
      await record({ kind: "refund", amount: rest, idempotencyKey: `external:${randomUUID()}` }),
    ).toMatchObject({ kind: "recorded" });
    expect(
      (await as(staff, (trx) => listExternalSettlements(trx, A.id, booked.bookingId)))?.refundable,
    ).toBe(0);

    // The records never change and never go, and each is in the audit history with its reason.
    const [row] = await admin<{ id: string }[]>`
      select id from public.external_settlements where idempotency_key = ${refundKey}`;
    await expect(
      as(staff, (trx) =>
        sql`update external_settlements set amount = 1 where id = ${row?.id ?? ""}`.execute(trx),
      ),
    ).rejects.toBeTruthy();
    await expect(
      as(staff, (trx) =>
        sql`delete from external_settlements where id = ${row?.id ?? ""}`.execute(trx),
      ),
    ).rejects.toBeTruthy();
    const audits = await admin<{ action: string; reason: string | null }[]>`
      select action, reason from public.audit_events
       where tenant_id = ${A.id} and subject_id = ${booked.bookingId}
         and action like 'booking.external_%'
       order by occurred_at, id`;
    expect(audits.map((a) => a.action)).toEqual([
      "booking.external_payment_recorded",
      "booking.external_refund_recorded",
      "booking.external_refund_recorded",
    ]);
    expect(audits[1]?.reason).toBe("Weather shortened the trip");
  });

  it("assesses TideGrid's fee once when a booking closes: its trip ended, or it was canceled", async () => {
    const sys = systemContext(A.id);
    const open = await confirmBooking(runtime.db, payments, A, tripsA.shared(), 1);
    const ended = await confirmBooking(runtime.db, payments, A, tripsA.shared(), 2);
    const canceled = await confirmBooking(runtime.db, payments, A, tripsA.shared(), 1);
    await endTrip(ended.bookingId);
    const staff = staffContext(A.id);
    const cancel = await as(staff, async (trx, c) => {
      const preview = await previewStaffCancellation(trx, A.id, canceled.bookingId);
      if (!preview) throw new Error("no preview");
      return staffCancelBooking(trx, c, {
        bookingId: canceled.bookingId,
        choice: { kind: "policy", remedy: preview.terms.remedy },
        expectedAmount: preview.refund?.amount ?? 0,
      });
    });
    expect(cancel.kind).toBe("canceled");

    let total = 0;
    for (;;) {
      const run = await as(sys, (trx, c) => assessClosedBookings(trx, c, 50));
      total += run.assessed;
      if (!run.more) break;
    }
    expect(total).toBeGreaterThanOrEqual(2);
    const rows = await admin<
      { booking_id: string; basis: string; eligible_total: number; fee_amount: number }[]
    >`
      select booking_id, basis, eligible_total, fee_amount from public.fee_assessments
       where booking_id in (${open.bookingId}, ${ended.bookingId}, ${canceled.bookingId})`;
    const byBooking = new Map(rows.map((r) => [r.booking_id, r]));
    expect(byBooking.has(open.bookingId)).toBe(false);
    const endedPaid = await paymentOf(ended.bookingId);
    expect(byBooking.get(ended.bookingId)).toEqual({
      booking_id: ended.bookingId,
      basis: "trip_completed",
      eligible_total: endedPaid.eligible,
      fee_amount: Math.round((endedPaid.eligible * CORE_FEE_BP) / 10_000),
    });
    expect(byBooking.get(canceled.bookingId)?.basis).toBe("canceled");

    // Once: a second run assesses nothing for them, and the database refuses
    // a second assessment, and one for a booking still open.
    expect((await as(sys, (trx, c) => assessClosedBookings(trx, c, 50))).assessed).toBe(0);
    const insert = (bookingId: string, total: number, eligible: number) =>
      as(sys, (trx) =>
        sql`insert into fee_assessments (tenant_id, booking_id, basis, order_total, eligible_total,
              fee_bp, fee_amount)
            values (${A.id}, ${bookingId}, 'trip_completed', ${total}, ${eligible},
              ${CORE_FEE_BP}, ${Math.round((eligible * CORE_FEE_BP) / 10_000)})`.execute(trx),
      );
    await expect(
      insert(ended.bookingId, endedPaid.total, endedPaid.eligible),
    ).rejects.toMatchObject({ code: "23505" });
    const openPaid = await paymentOf(open.bookingId);
    await expect(insert(open.bookingId, openPaid.total, openPaid.eligible)).rejects.toMatchObject({
      code: "23514",
    });
  });

  it("drafts each ended month's invoice from the ledgers, carries a negative balance, and trues up the year", async () => {
    const C = await createCheckoutFixture(admin, runtime.db, "g210-c");
    const tripsC = tripAllocator(C);
    const sys = systemContext(C.id);
    // TideGrid writes the plan; staff cannot.
    await expect(
      as(staffContext(C.id), (trx) =>
        sql`insert into billing_plans (tenant_id, monthly_fee, annual_minimum, starts_on, time_zone)
            values (${C.id}, 1000, 50000, '2025-01-01', 'UTC')`.execute(trx),
      ),
    ).rejects.toMatchObject({ code: "42501" });
    const [plan] = await admin<{ starts_on: string; first: Date; second: Date }[]>`
      insert into public.billing_plans (tenant_id, monthly_fee, annual_minimum, starts_on, time_zone)
      values (${C.id}, 1000, 50000,
              (date_trunc('month', now() at time zone 'UTC') - interval '13 months')::date, 'UTC')
      returning to_char(starts_on, 'YYYY-MM') as starts_on,
                (starts_on + interval '5 days')::timestamp at time zone 'UTC' as first,
                (starts_on + interval '1 month 5 days')::timestamp at time zone 'UTC' as second`;
    if (!plan) throw new Error("no plan");

    // Month 1: an external refund's fee reversal only, so the month is negative.
    // Month 2: the booking's assessment.
    const booked = await confirmBooking(runtime.db, payments, C, tripsC.shared(), 2);
    const paid = await paymentOf(booked.bookingId);
    const refunded = await as(staffContext(C.id), (trx, c) =>
      recordExternalSettlement(trx, c, {
        bookingId: booked.bookingId,
        kind: "refund",
        tender: "cash",
        amount: 3_000,
        reason: "Goodwill",
        idempotencyKey: `external:${randomUUID()}`,
      }),
    );
    if (refunded.kind !== "recorded") throw new Error(JSON.stringify(refunded));
    const reversal = refunded.settlement.feeAmount ?? 0;
    expect(reversal).toBeLessThan(0);
    await backdate("external_settlements", refunded.settlement.id, plan.first);
    await endTrip(booked.bookingId);
    expect((await as(sys, (trx, c) => assessClosedBookings(trx, c, 50))).assessed).toBe(1);
    const [assessment] = await admin<{ id: string; fee_amount: number }[]>`
      select id, fee_amount from public.fee_assessments where booking_id = ${booked.bookingId}`;
    if (!assessment) throw new Error("no assessment");
    await backdate("fee_assessments", assessment.id, plan.second);
    expect(assessment.fee_amount).toBe(Math.round((paid.eligible * CORE_FEE_BP) / 10_000));

    // Staff never issue an invoice.
    await expect(as(staffContext(C.id), (trx, c) => issueNextInvoice(trx, c))).rejects.toThrow(
      TypeError,
    );
    const issued = [];
    for (let i = 0; i < 20; i++) {
      const invoice = await as(sys, (trx, c) => issueNextInvoice(trx, c));
      if (!invoice) break;
      issued.push(invoice);
    }
    // Thirteen months have ended; this one has not.
    expect(issued).toHaveLength(13);
    expect(issued[0]).toMatchObject({
      month: plan.starts_on,
      contractMonth: 1,
      subscriptionAmount: 1000,
      variableAmount: reversal,
      carriedIn: 0,
      variableBilled: 0,
      carriedOut: reversal,
      trueUpAmount: 0,
      totalAmount: 1000,
      state: "draft",
    });
    const billed = assessment.fee_amount + reversal;
    expect(issued[1]).toMatchObject({
      contractMonth: 2,
      variableAmount: assessment.fee_amount,
      carriedIn: reversal,
      variableBilled: billed,
      carriedOut: 0,
      totalAmount: 1000 + billed,
    });
    const trueUp = 50_000 - (12 * 1000 + billed);
    expect(issued[11]).toMatchObject({
      contractMonth: 12,
      variableAmount: 0,
      trueUpAmount: trueUp,
      totalAmount: 1000 + trueUp,
    });
    expect(issued[12]).toMatchObject({ contractMonth: 1, trueUpAmount: 0, totalAmount: 1000 });

    // The database checks every figure: a draft that disagrees with the ledger is refused.
    const listed = await as(sys, (trx) => listFeeInvoices(trx, C.id));
    expect(listed.map((i) => i.id)).toEqual(issued.map((i) => i.id).reverse());
    await expect(
      as(sys, (trx) =>
        sql`insert into fee_invoices (tenant_id, period_start, contract_month, subscription_amount,
              variable_amount, carried_in, variable_billed, carried_out, true_up_amount, total_amount)
            values (${C.id}, (date_trunc('month', now() at time zone 'UTC'))::date, 2, 1000,
              5, 0, 5, 0, 0, 1005)`.execute(trx),
      ),
    ).rejects.toMatchObject({ code: "23514" });
  });

  it("moves a dispute only by its verified events, and shows it to staff", async () => {
    const booked = await confirmBooking(runtime.db, payments, B, tripsB.shared(), 2);
    const paid = await paymentOf(booked.bookingId);
    const disputeRef = `fdp_${randomUUID().replace(/-/g, "")}`;
    const deliver = async (
      status: "needs_response" | "under_review" | "won" | "lost" | "closed",
      overrides: { amount?: number; paymentRef?: string; disputeRef?: string } = {},
    ) => {
      const body = disputeEventBody({
        accountRef: B.accountRef,
        disputeRef: overrides.disputeRef ?? disputeRef,
        paymentRef: overrides.paymentRef ?? paid.ref,
        amount: overrides.amount ?? 4_000,
        status,
      });
      const event = await verifiedFakeEvent(payments, body);
      return handleVerifiedEvent(runtime.db, payments, event, { requestId: `req-${randomUUID()}` });
    };

    expect(await deliver("needs_response")).toMatchObject({
      kind: "processed",
      outcome: "dispute_opened",
    });
    let listed = await as(staffContext(B.id), (trx) => listDisputes(trx, B.id));
    expect(listed).toEqual([
      expect.objectContaining({
        status: "needs_response",
        open: true,
        amount: 4_000,
        reason: "fraudulent",
        closedAt: null,
        payment: { id: paid.id, amount: paid.amount },
        booking: { id: booked.bookingId, reference: booked.reference },
      }),
    ]);
    expect(await deliver("under_review")).toMatchObject({ outcome: "dispute_updated" });
    // A disputed amount that differs, a larger one, an unknown payment: nothing moves.
    expect(await deliver("won", { amount: 3_999 })).toMatchObject({
      outcome: "dispute_mismatch",
    });
    expect(
      await deliver("needs_response", {
        amount: paid.amount + 1,
        disputeRef: `fdp_${randomUUID().replace(/-/g, "")}`,
      }),
    ).toMatchObject({ outcome: "dispute_mismatch" });
    expect(
      await deliver("needs_response", {
        paymentRef: "fpay_unknownpayment0000000001",
        disputeRef: `fdp_${randomUUID().replace(/-/g, "")}`,
      }),
    ).toMatchObject({ outcome: "unmatched_dispute" });
    expect(await deliver("lost")).toMatchObject({ outcome: "dispute_closed" });
    // Closed is final.
    expect(await deliver("won")).toMatchObject({ outcome: "dispute_already_closed" });
    listed = await as(staffContext(B.id), (trx) => listDisputes(trx, B.id));
    expect(listed).toHaveLength(1);
    expect(listed[0]).toMatchObject({ status: "lost", open: false });
    // The lost dispute took 4,000 back, so a refund outside the card flow may
    // return at most what is left.
    const left = await as(staffContext(B.id), (trx) =>
      listExternalSettlements(trx, B.id, booked.bookingId),
    );
    expect(left?.refundable).toBe(Math.min(paid.amount - 4_000, paid.total));
    expect(listed[0]?.closedAt).not.toBeNull();
    // Another tenant sees none of it.
    expect(await as(staffContext(A.id), (trx) => listDisputes(trx, A.id))).toEqual([]);

    // The runtime cannot move a dispute without a dispute event that says so.
    const id = listed[0]?.id ?? "";
    await expect(
      as(staffContext(B.id), (trx) =>
        sql`update payment_disputes set status = 'won' where id = ${id}`.execute(trx),
      ),
    ).rejects.toMatchObject({ code: "23514" });
    const audits = await admin<{ action: string }[]>`
      select action from public.audit_events
       where tenant_id = ${B.id} and subject_id = ${paid.id} and action like 'payment.dispute_%'
       order by occurred_at, id`;
    expect(audits.map((a) => a.action)).toEqual([
      "payment.dispute_opened",
      "payment.dispute_updated",
      "payment.dispute_closed",
    ]);
  });

  it("reads a pending payment past its hold at the provider and never changes it (D1)", async () => {
    const quote = await quoteFor(runtime.db, B.id, tripsB.shared(), 1, { charter: false });
    const secret = newSecret();
    const guest = guestContext(B.id);
    const created = await as(guest, (trx, c) =>
      createCheckoutSession(trx, c, {
        quoteId: quote.quoteId,
        acceptedPolicyVersion: quote.policy.version,
        booker: { name: "Quiet Webhook", email: "quiet@example.test" },
        secret,
        clientAddress: null,
        provider: "fake",
        minimumAmount: 50,
      }),
    );
    if (created.kind !== "created") throw new Error(JSON.stringify(created));
    const ready = await ensureProviderPayment(runtime.db, payments, guest, created.session.id);
    if (ready.kind !== "ready") throw new Error(JSON.stringify(ready));
    await backdateCheckout(admin, created.session.id, 2 * 3600);
    const [payment] = await admin<{ id: string; amount: number }[]>`
      select id, amount from public.payments where provider_payment_id = ${ready.paymentRef}`;
    if (!payment) throw new Error("no payment");
    const sys = systemContext(B.id);
    const reader = new ReadingProvider(payments);
    const state = async () =>
      (
        await admin<{ state: string; checked_at: Date | null }[]>`
          select state, checked_at from public.payments where id = ${payment.id}`
      )[0];

    // Still pending at the provider: nothing to raise, the check is stamped.
    expect(await checkPendingPayment(runtime.db, reader, sys, payment.id)).toEqual({
      kind: "pending",
    });
    expect((await state())?.checked_at).not.toBeNull();

    // The provider says another amount, or has no such payment: raised, unchanged.
    reader.reading = (real) => (real ? { ...real, amount: real.amount + 1 } : real);
    expect(await checkPendingPayment(runtime.db, reader, sys, payment.id)).toEqual({
      kind: "raised",
      reason: "amount_mismatch",
    });
    reader.reading = () => null;
    expect(await checkPendingPayment(runtime.db, reader, sys, payment.id)).toEqual({
      kind: "raised",
      reason: "missing_at_provider",
    });
    reader.reading = null;

    // Paid at the provider, but its event never came: raised once, and the
    // payment stays pending with no booking. Only the verified event confirms.
    const settled = await payments.settlePayment(B.id, ready.paymentRef, "succeeded", Date.now());
    if (settled.kind === "not_found") throw new Error("no fake payment");
    for (let i = 0; i < 2; i++) {
      expect(await checkPendingPayment(runtime.db, reader, sys, payment.id)).toEqual({
        kind: "raised",
        reason: "succeeded_without_event",
      });
    }
    expect((await state())?.state).toBe("pending");
    const bookings = await admin`
      select 1 from public.bookings where checkout_session_id = ${created.session.id}`;
    expect(bookings).toHaveLength(0);
    let raised = await as(staffContext(B.id), (trx) =>
      listPaymentReconciliationExceptions(trx, B.id),
    );
    const mine = raised.filter((x) => x.payment.id === payment.id);
    expect(mine.map((x) => x.reason).sort()).toEqual([
      "amount_mismatch",
      "missing_at_provider",
      "succeeded_without_event",
    ]);
    expect(mine.every((x) => x.open)).toBe(true);
    expect(mine.find((x) => x.reason === "succeeded_without_event")).toMatchObject({
      providerStatus: "succeeded",
      providerAmount: payment.amount,
      checkoutSessionId: created.session.id,
    });

    // The runtime cannot raise one for a payment that is not pending, nor
    // stamp a check on one.
    // The verified event settles it, and the readings close with it.
    const event = await verifiedFakeEvent(payments, settled.event.body);
    const handled = await handleVerifiedEvent(runtime.db, payments, event, {
      requestId: `req-${randomUUID()}`,
    });
    expect(handled.kind).toBe("processed");
    expect((await state())?.state).not.toBe("pending");
    expect(await checkPendingPayment(runtime.db, reader, sys, payment.id)).toEqual({
      kind: "not_pending",
    });
    raised = await as(staffContext(B.id), (trx) => listPaymentReconciliationExceptions(trx, B.id));
    expect(raised.filter((x) => x.payment.id === payment.id).every((x) => !x.open)).toBe(true);
    await expect(
      as(sys, (trx) =>
        sql`update payments set checked_at = now() where id = ${payment.id}`.execute(trx),
      ),
    ).rejects.toMatchObject({ code: "23514" });
    await expect(
      as(sys, (trx) =>
        sql`insert into payment_reconciliation_exceptions (tenant_id, payment_id, reason)
            values (${B.id}, ${payment.id}, 'failed_without_event')`.execute(trx),
      ),
    ).rejects.toMatchObject({ code: "23514" });
  });

  it("reports the month with control totals that match the fee ledgers", async () => {
    const R = await createCheckoutFixture(admin, runtime.db, "g210-r");
    const tripsR = tripAllocator(R);
    const sys = systemContext(R.id);
    const one = await confirmBooking(runtime.db, payments, R, tripsR.shared(), 2);
    const two = await confirmBooking(runtime.db, payments, R, tripsR.shared(), 1);
    await endTrip(one.bookingId);
    await endTrip(two.bookingId);
    expect((await as(sys, (trx, c) => assessClosedBookings(trx, c, 50))).assessed).toBe(2);
    const staff = staffContext(R.id);
    const cash = await as(staff, (trx, c) =>
      recordExternalSettlement(trx, c, {
        bookingId: two.bookingId,
        kind: "payment",
        tender: "other",
        amount: 700,
        reason: "Gift card from the front desk",
        idempotencyKey: `external:${randomUUID()}`,
      }),
    );
    const back = await as(staff, (trx, c) =>
      recordExternalSettlement(trx, c, {
        bookingId: one.bookingId,
        kind: "refund",
        tender: "cash",
        amount: 2_500,
        reason: "Partial refund for a short trip",
        idempotencyKey: `external:${randomUUID()}`,
      }),
    );
    if (cash.kind !== "recorded" || back.kind !== "recorded") throw new Error("not recorded");
    const [month] = await admin<{ m: string }[]>`
      select to_char(now() at time zone 'UTC', 'YYYY-MM') as m`;
    const report = await as(staff, (trx) => reconciliationReport(trx, R.id, month?.m ?? ""));
    const p1 = await paymentOf(one.bookingId);
    const p2 = await paymentOf(two.bookingId);
    const fee1 = Math.round((p1.eligible * CORE_FEE_BP) / 10_000);
    const fee2 = Math.round((p2.eligible * CORE_FEE_BP) / 10_000);
    expect(report.timeZone).toBe("UTC");
    expect(report.rows).toHaveLength(2);
    expect(report.rows.find((r) => r.bookingId === one.bookingId)).toMatchObject({
      assessedValue: p1.eligible,
      refundedValue: back.settlement.eligibleAmount,
      externalPaid: 0,
      externalRefunded: 2_500,
      feeAmount: fee1 + (back.settlement.feeAmount ?? 0),
    });
    expect(report.rows.find((r) => r.bookingId === two.bookingId)).toMatchObject({
      assessedValue: p2.eligible,
      refundedValue: 0,
      externalPaid: 700,
      feeAmount: fee2,
    });
    expect(report.totals).toMatchObject({
      assessedValue: p1.eligible + p2.eligible,
      netManagedValue: p1.eligible + p2.eligible - (back.settlement.eligibleAmount ?? 0),
      feeAmount: fee1 + fee2 + (back.settlement.feeAmount ?? 0),
    });
    expect(report.ledgerFeeTotal).toBe(report.totals.feeAmount);
    expect(report.controlTotalsMatch).toBe(true);
    // Every closed booking was paid in full by card.
    expect(report).toMatchObject({ receivedShareBp: 10_000, shortBookings: 0, meetsTarget: true });
    // Another tenant's month is empty.
    const other = await as(staffContext(A.id), (trx) => reconciliationReport(trx, A.id, "2000-01"));
    expect(other).toMatchObject({ rows: [], ledgerFeeTotal: 0, controlTotalsMatch: true });
  });

  it("never lets a card refund stack on an external refund past the booking's total", async () => {
    const booked = await confirmBooking(runtime.db, payments, A, tripsA.shared(), 2);
    const paid = await paymentOf(booked.bookingId);
    const staff = staffContext(A.id);
    const before = await as(staff, (trx) => previewStaffCancellation(trx, A.id, booked.bookingId));
    const policyRefund = before?.refund?.amount ?? 0;
    expect(policyRefund).toBeGreaterThan(0);
    // Enough cash back that the policy's card refund would pass the total by a cent.
    const cash = paid.total - policyRefund + 1;
    const recorded = await as(staff, (trx, c) =>
      recordExternalSettlement(trx, c, {
        bookingId: booked.bookingId,
        kind: "refund",
        tender: "cash",
        amount: cash,
        reason: "Refunded at the dock",
        idempotencyKey: `external:${randomUUID()}`,
      }),
    );
    expect(recorded.kind).toBe("recorded");
    // The guest may no longer cancel for the policy's refund: the operator decides.
    const guest = await as(guestContext(A.id), (trx) =>
      previewCancellation(trx, A.id, booked.bookingId),
    );
    expect(guest).toMatchObject({ cancelable: false, refusal: "remedy_requires_operator" });
    // Staff taking the policy's refund are refused; no refund, with a reason, is fine.
    const policy = await as(staff, (trx, c) =>
      staffCancelBooking(trx, c, {
        bookingId: booked.bookingId,
        choice: { kind: "policy", remedy: before?.terms.remedy ?? "full_refund" },
        expectedAmount: policyRefund,
      }),
    );
    expect(policy).toMatchObject({ kind: "override_invalid" });
    const none = await as(staff, (trx, c) =>
      staffCancelBooking(trx, c, {
        bookingId: booked.bookingId,
        choice: { kind: "override", remedy: "none", refundBp: 0, reason: "Refunded in cash" },
        expectedAmount: 0,
      }),
    );
    expect(none.kind).toBe("canceled");
    const refunds = await admin`
      select 1 from public.payment_refunds where payment_id = ${paid.id}`;
    expect(refunds).toHaveLength(0);
  });

  it("runs the sweep: assesses, drafts invoices, and reads due payments, in fair turns", async () => {
    const S = await createCheckoutFixture(admin, runtime.db, "g210-s");
    const tripsS = tripAllocator(S);
    const booked = await confirmBooking(runtime.db, payments, S, tripsS.shared(), 1);
    await endTrip(booked.bookingId);
    await admin`
      insert into public.billing_plans (tenant_id, monthly_fee, annual_minimum, starts_on, time_zone)
      values (${S.id}, 500, 0,
              (date_trunc('month', now() at time zone 'America/New_York') - interval '2 months')::date,
              'America/New_York')`;
    // A pending payment past its hold.
    const quote = await quoteFor(runtime.db, S.id, tripsS.shared(), 1, { charter: false });
    const guest = guestContext(S.id);
    const created = await as(guest, (trx, c) =>
      createCheckoutSession(trx, c, {
        quoteId: quote.quoteId,
        acceptedPolicyVersion: quote.policy.version,
        booker: { name: "Swept Guest", email: "swept@example.test" },
        secret: newSecret(),
        clientAddress: null,
        provider: "fake",
        minimumAmount: 50,
      }),
    );
    if (created.kind !== "created") throw new Error(JSON.stringify(created));
    const ready = await ensureProviderPayment(runtime.db, payments, guest, created.session.id);
    if (ready.kind !== "ready") throw new Error(JSON.stringify(ready));
    await backdateCheckout(admin, created.session.id, 2 * 3600);

    const errors: unknown[] = [];
    const report = await sweepReconciliation(runtime.db, {
      runId: `run-${randomUUID()}`,
      provider: payments,
      tenantLimit: 1000,
      budgetMs: 60_000,
      onTenantError: (_t, e) => errors.push(e),
      onStampError: (_t, e) => errors.push(e),
    });
    expect(errors).toEqual([]);
    expect(report.assessed).toBeGreaterThanOrEqual(1);
    expect(report.invoiced).toBeGreaterThanOrEqual(2);
    expect(report.paymentsChecked).toBeGreaterThanOrEqual(1);
    const [assessed] = await admin`
      select 1 from public.fee_assessments where booking_id = ${booked.bookingId}`;
    expect(assessed).toBeDefined();
    const invoices = await admin`select 1 from public.fee_invoices where tenant_id = ${S.id}`;
    expect(invoices).toHaveLength(2);
    const [checked] = await admin<{ checked_at: Date | null; state: string }[]>`
      select checked_at, state from public.payments where provider_payment_id = ${ready.paymentRef}`;
    expect(checked).toMatchObject({ state: "pending" });
    expect(checked?.checked_at).not.toBeNull();
    const turns = await admin`
      select 1 from public.sweep_turns where tenant_id = ${S.id} and sweep = 'reconciliation'`;
    expect(turns.length).toBeGreaterThanOrEqual(1);

    // A second run has nothing new for the tenant: the payment was read within the hour.
    const second = await sweepReconciliation(runtime.db, {
      runId: `run-${randomUUID()}`,
      provider: payments,
      tenantLimit: 1000,
      budgetMs: 60_000,
    });
    expect(second.failedTenants).toBe(0);
    expect(await admin`select 1 from public.fee_invoices where tenant_id = ${S.id}`).toHaveLength(
      2,
    );
  });
});
