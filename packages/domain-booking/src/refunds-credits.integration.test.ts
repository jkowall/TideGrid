/**
 * Refunds and credits (W3-G2.9) on the local PostgreSQL: a refund the
 * provider has not finished, settled later by its event or by the sweep; the
 * fee reversed on a succeeded refund; an exception for staff after 24 hours;
 * booking credit issued, used, returned, and corrected; staff's cancellation
 * choices; and an unpaid payment canceled at the provider when its checkout
 * closes.
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
import type { FakePaymentProvider } from "@tidegrid/domain-payments";
import { createPolicyVersion } from "@tidegrid/domain-pricing";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";
import { FlakyProvider } from "./adversarial/harness.ts";
import { handleVerifiedEvent } from "./finalize.ts";
import {
  adjustCredit,
  CreditKeyReusedError,
  cancelBooking,
  cancelCheckoutSession,
  createCheckoutSession,
  creditAccountForBooking,
  ensureProviderPayment,
  feeReversalFor,
  getCreditAccount,
  listRefundExceptions,
  previewStaffCancellation,
  redeemCredit,
  reinstateCredit,
  settlePaymentCancellation,
  settleRefund,
  staffCancelBooking,
  sweepCheckouts,
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

function staffContext(tenantId: string): TenantContext {
  return { tenantId, actorType: "staff", actorId: "staff-g29", requestId: `req-${randomUUID()}` };
}

function fakeEventId(): string {
  const suffix = randomBytes(18)
    .toString("base64")
    .replace(/[^A-Za-z0-9]/g, "")
    .padEnd(24, "x")
    .slice(0, 24);
  return `fevt_${suffix}`;
}

/** A signed fake refund event body, shaped like Stripe's refund events. */
function refundEventBody(input: {
  accountRef: string;
  refundRef: string;
  paymentRef: string;
  amount: number;
  key: string;
  status: "pending" | "succeeded" | "failed";
  failureCode?: string;
}): string {
  return JSON.stringify({
    id: fakeEventId(),
    object: "event",
    type: "refund.updated",
    created: Math.floor(Date.now() / 1000),
    account: input.accountRef,
    data: {
      object: {
        id: input.refundRef,
        object: "refund",
        payment: input.paymentRef,
        amount: input.amount,
        currency: "usd",
        status: input.status,
        idempotency_key: input.key,
        failure_code: input.failureCode ?? null,
      },
    },
  });
}

describe.skipIf(!env)("refunds, fee reversal, and booking credit (W3-G2.9)", () => {
  let admin: Sql;
  let runtime: ReturnType<typeof createDb>;
  let payments: FakePaymentProvider;
  let A: CheckoutFixture;
  let C: CheckoutFixture;
  let tripsA: ReturnType<typeof tripAllocator>;
  let tripsC: ReturnType<typeof tripAllocator>;

  const as = <T>(
    ctx: TenantContext,
    fn: (trx: TenantTransaction, ctx: TenantContext) => Promise<T>,
  ): Promise<T> => inTenantTransaction(runtime.db, ctx, (trx) => fn(trx, ctx));

  async function refundOf(bookingId: string) {
    const [row] = await admin<
      {
        id: string;
        state: string;
        amount: number;
        idempotency_key: string;
        provider_refund_id: string | null;
        checked_at: Date | null;
        payment_ref: string;
      }[]
    >`
      select r.id, r.state, r.amount, r.idempotency_key, r.provider_refund_id, r.checked_at,
             p.provider_payment_id as payment_ref
        from public.bookings b
        join public.payments p on p.id = b.payment_id
        join public.payment_refunds r on r.payment_id = b.payment_id
       where b.id = ${bookingId}`;
    if (!row) throw new Error("no refund for the booking");
    return row;
  }

  /** Staff cancel a booking with the policy's refund, without settling it. */
  async function staffCancelForRefund(tenant: CheckoutFixture, bookingId: string) {
    const ctx = staffContext(tenant.id);
    const canceled = await as(ctx, async (trx, c) => {
      const preview = await previewStaffCancellation(trx, tenant.id, bookingId);
      if (!preview?.refund) throw new Error("no refund to preview");
      return staffCancelBooking(trx, c, {
        bookingId,
        choice: { kind: "policy" },
        expectedAmount: preview.refund.amount,
      });
    });
    if (canceled.kind !== "canceled" || !canceled.cancellation.refundId) {
      throw new Error(`staff cancel: ${JSON.stringify(canceled)}`);
    }
    return { ctx, refundId: canceled.cancellation.refundId, cancellation: canceled.cancellation };
  }

  async function deliverRefundEvent(
    tenant: CheckoutFixture,
    refund: Awaited<ReturnType<typeof refundOf>>,
    status: "pending" | "succeeded" | "failed",
    overrides: { amount?: number; key?: string; refundRef?: string } = {},
  ) {
    const body = refundEventBody({
      accountRef: tenant.accountRef,
      refundRef: overrides.refundRef ?? refund.provider_refund_id ?? "frf_eventonly0001",
      paymentRef: refund.payment_ref,
      amount: overrides.amount ?? refund.amount,
      key: overrides.key ?? refund.idempotency_key,
      status,
      ...(status === "failed" ? { failureCode: "expired_or_canceled_card" } : {}),
    });
    const event = await verifiedFakeEvent(payments, body);
    return handleVerifiedEvent(runtime.db, payments, event, { requestId: `req-${randomUUID()}` });
  }

  beforeAll(async () => {
    if (!env) return;
    admin = postgres(env.adminUrl, { max: 2, onnotice: () => {} });
    runtime = createDb(env.runtimeUrl, { max: 8 });
    payments = fakeProvider(runtime.db);
    A = await createCheckoutFixture(admin, runtime.db, "g29-a");
    // Credit: its products' policy gives booking credit instead of a refund.
    C = await createCheckoutFixture(admin, runtime.db, "g29-c");
    tripsA = tripAllocator(A);
    tripsC = tripAllocator(C);
    const products = await admin<{ id: string }[]>`
      select id from public.products where tenant_id = ${C.id} and kind = 'shared_seat'`;
    const ctx: TenantContext = { tenantId: C.id, actorType: "system", actorId: "test" };
    await inTenantTransaction(runtime.db, ctx, async (trx) => {
      for (const p of products) {
        const made = await createPolicyVersion(trx, ctx, {
          productId: p.id,
          changeCutoffMinutes: 60,
          beforeCutoff: { remedy: "credit" },
          afterCutoff: { remedy: "none" },
          noShow: { remedy: "none" },
          text: {
            cancellation: "Cancel for booking credit.",
            reschedule: "Reschedule terms.",
            noShow: "No-show terms.",
            operatorCancellation: "Operator terms.",
            weather: "Weather terms.",
          },
          reason: "test: a credit policy",
        });
        if (made.kind !== "created") throw new Error(`policy: ${JSON.stringify(made)}`);
      }
    });
  });

  afterAll(async () => {
    await runtime?.end();
    await admin?.end({ timeout: 5 });
  });

  it("records a refund the provider has not finished as pending, and settles it by its event", async () => {
    const booked = await confirmBooking(runtime.db, payments, A, tripsA.shared(), 2);
    const { ctx, refundId } = await staffCancelForRefund(A, booked.bookingId);
    const flaky = new FlakyProvider(payments);
    flaky.failRefund = "pending";
    const first = await settleRefund(runtime.db, flaky, ctx, refundId);
    expect(first.kind).toBe("pending");
    let refund = await refundOf(booked.bookingId);
    expect(refund.state).toBe("pending");
    expect(refund.provider_refund_id).toMatch(/^frf_pending/);
    expect(refund.checked_at).not.toBeNull();
    // Asked again while still pending: it stays pending, with a new check stamp.
    expect((await settleRefund(runtime.db, flaky, ctx, refundId)).kind).toBe("pending");

    // A pending event changes nothing more.
    expect(await deliverRefundEvent(A, refund, "pending")).toMatchObject({
      kind: "processed",
      outcome: "refund_pending",
    });
    // An event whose amount or key does not match is recorded and moves nothing.
    expect(
      await deliverRefundEvent(A, refund, "succeeded", { amount: refund.amount - 1 }),
    ).toMatchObject({ kind: "processed", outcome: "refund_mismatch" });
    expect(
      await deliverRefundEvent(A, refund, "succeeded", { key: `refund:${randomUUID()}` }),
    ).toMatchObject({ kind: "processed", outcome: "unmatched_refund" });
    expect((await refundOf(booked.bookingId)).state).toBe("pending");

    // The success arrives: the refund settles and TideGrid's fee is reversed once.
    expect(await deliverRefundEvent(A, refund, "succeeded")).toMatchObject({
      kind: "processed",
      outcome: "refund_succeeded",
    });
    refund = await refundOf(booked.bookingId);
    expect(refund.state).toBe("succeeded");
    expect(await deliverRefundEvent(A, refund, "succeeded")).toMatchObject({
      outcome: "refund_already_settled",
    });

    const [order] = await admin<{ total: number; eligible: number }[]>`
      select o.total_amount as total,
             o.total_amount - o.tax_amount - o.included_tax_amount as eligible
        from public.bookings b join public.orders o on o.id = b.order_id
       where b.id = ${booked.bookingId}`;
    if (!order) throw new Error("no order");
    expect(order.eligible).toBeLessThan(order.total);
    const expected = feeReversalFor({
      refundAmount: refund.amount,
      orderTotal: order.total,
      eligibleTotal: order.eligible,
    });
    const fees = await admin<{ kind: string; fee_amount: number; eligible_amount: number }[]>`
      select kind, fee_amount, eligible_amount from public.fee_ledger_entries
       where booking_id = ${booked.bookingId}`;
    expect(fees).toEqual([
      {
        kind: "refund_reversal",
        fee_amount: expected.feeAmount,
        eligible_amount: expected.eligibleAmount,
      },
    ]);
    expect(expected.feeAmount).toBeLessThan(0);

    // A failure reported after the success leaves it succeeded and raises it for staff.
    expect(await deliverRefundEvent(A, refund, "failed")).toMatchObject({
      outcome: "refund_failed_after_success",
    });
    expect((await refundOf(booked.bookingId)).state).toBe("succeeded");
    const listed = await as(staffContext(A.id), (trx) => listRefundExceptions(trx, A.id));
    expect(listed.find((x) => x.refund.id === refundId)).toMatchObject({
      reason: "failed_after_success",
      booking: { id: booked.bookingId },
    });
  });

  it("settles a pending refund as failed by its event, with no fee reversed", async () => {
    const booked = await confirmBooking(runtime.db, payments, A, tripsA.shared(), 1);
    const { ctx, refundId } = await staffCancelForRefund(A, booked.bookingId);
    const flaky = new FlakyProvider(payments);
    flaky.failRefund = "pending";
    expect((await settleRefund(runtime.db, flaky, ctx, refundId)).kind).toBe("pending");
    const refund = await refundOf(booked.bookingId);
    expect(await deliverRefundEvent(A, refund, "failed")).toMatchObject({
      outcome: "refund_failed",
    });
    expect((await refundOf(booked.bookingId)).state).toBe("failed");
    // A success reported after the failure leaves it failed and raises it for staff.
    expect(await deliverRefundEvent(A, refund, "succeeded")).toMatchObject({
      outcome: "refund_succeeded_after_failure",
    });
    expect((await refundOf(booked.bookingId)).state).toBe("failed");
    const listed = await as(ctx, (trx) => listRefundExceptions(trx, A.id));
    expect(listed.find((x) => x.refund.id === refundId)).toMatchObject({
      reason: "succeeded_after_failure",
      open: true,
    });
    const [fees] = await admin<{ n: number }[]>`
      select count(*)::int as n from public.fee_ledger_entries where booking_id = ${booked.bookingId}`;
    expect(fees?.n).toBe(0);
  });

  it("raises an unanswered refund for staff only after 24 hours, once", async () => {
    const booked = await confirmBooking(runtime.db, payments, A, tripsA.shared(), 1);
    const { ctx, refundId } = await staffCancelForRefund(A, booked.bookingId);
    const flaky = new FlakyProvider(payments);
    flaky.failRefund = "before";
    expect((await settleRefund(runtime.db, flaky, ctx, refundId)).kind).toBe("unknown");
    const count = async () => {
      const [row] = await admin<{ n: number }[]>`
        select count(*)::int as n from public.refund_exceptions where refund_id = ${refundId}`;
      return row?.n ?? 0;
    };
    expect(await count()).toBe(0);
    // The database refuses a younger exception even when written directly.
    await expect(
      as(ctx, (trx) =>
        trx
          .insertInto("refund_exceptions")
          .values({
            tenant_id: A.id,
            refund_id: refundId,
            reason: "unsettled",
            refund_state: "requested",
          })
          .execute(),
      ),
    ).rejects.toThrow();
    // Make the refund a day old, with triggers off, as time passing would.
    await admin.begin(async (tx) => {
      await tx`set local session_replication_role = replica`;
      await tx`update public.payment_refunds set created_at = now() - interval '25 hours'
                where id = ${refundId}`;
    });
    expect((await settleRefund(runtime.db, flaky, ctx, refundId)).kind).toBe("unknown");
    expect((await settleRefund(runtime.db, flaky, ctx, refundId)).kind).toBe("unknown");
    expect(await count()).toBe(1);
    const listed = await as(ctx, (trx) => listRefundExceptions(trx, A.id));
    expect(listed.find((x) => x.refund.id === refundId)).toMatchObject({
      reason: "unsettled",
      open: true,
    });
    // The provider answers at last: the refund settles and the exception reads as closed.
    expect((await settleRefund(runtime.db, payments, ctx, refundId)).kind).toBe("succeeded");
    const after = await as(ctx, (trx) => listRefundExceptions(trx, A.id));
    expect(after.find((x) => x.refund.id === refundId)).toMatchObject({ open: false });
  });

  it("lets staff take the policy's refund value as credit, and use, return, and correct it", async () => {
    const booker = { name: "Credit Booker", email: `credit-${randomUUID()}@example.test` };
    const booked = await confirmBooking(runtime.db, payments, A, tripsA.shared(), 2, { booker });
    const ctx = staffContext(A.id);
    const preview = await as(ctx, (trx) => previewStaffCancellation(trx, A.id, booked.bookingId));
    if (!preview?.credit || !preview.refund) throw new Error("no credit alternative");
    expect(preview.creditBalance).toBe(0);
    expect(preview.credit).toEqual({
      amount: preview.policyValue,
      balanceAfter: preview.policyValue,
    });
    const canceled = await as(ctx, (trx, c) =>
      staffCancelBooking(trx, c, {
        bookingId: booked.bookingId,
        choice: { kind: "credit" },
        expectedAmount: preview.credit?.amount ?? 0,
      }),
    );
    if (canceled.kind !== "canceled") throw new Error(JSON.stringify(canceled));
    expect(canceled.cancellation).toMatchObject({
      remedy: "credit",
      refundAmount: 0,
      refundId: null,
      creditAmount: preview.policyValue,
      overridden: false,
      by: "staff",
    });
    const [noRefund] = await admin<{ n: number }[]>`
      select count(*)::int as n from public.payment_refunds r
        join public.bookings b on b.payment_id = r.payment_id where b.id = ${booked.bookingId}`;
    expect(noRefund?.n).toBe(0);

    const found = await as(ctx, (trx) => creditAccountForBooking(trx, A.id, booked.bookingId));
    if (!found) throw new Error("no credit account");
    const accountId = found.id;
    const balance = async () =>
      (await as(ctx, (trx) => getCreditAccount(trx, A.id, accountId)))?.balance;
    expect(await balance()).toBe(preview.policyValue);

    // Use some of it toward a later booking of the same customer.
    const later = await confirmBooking(runtime.db, payments, A, tripsA.shared(), 1, { booker });
    const redeemKey = `redeem:${randomUUID()}`;
    const redeem = (amount: number, key = redeemKey) =>
      as(ctx, (trx, c) =>
        redeemCredit(trx, c, {
          accountId,
          bookingId: later.bookingId,
          amount,
          idempotencyKey: key,
        }),
      );
    expect(await redeem(preview.policyValue + 1, `redeem:${randomUUID()}`)).toEqual({
      kind: "insufficient",
      balance: preview.policyValue,
    });
    const used = await redeem(1000);
    if (used.kind !== "applied") throw new Error(JSON.stringify(used));
    expect(used).toMatchObject({ duplicate: false, entry: { kind: "redeem", amount: -1000 } });
    expect(used.entry.balanceAfter).toBe(preview.policyValue - 1000);
    // The same key again returns the first entry; a different command under it is refused.
    expect(await redeem(1000)).toMatchObject({ kind: "applied", duplicate: true });
    await expect(redeem(999)).rejects.toBeInstanceOf(CreditKeyReusedError);
    expect(await balance()).toBe(preview.policyValue - 1000);
    // Two commands with one key at once move the balance once.
    const raceKey = `redeem:${randomUUID()}`;
    const raced = await Promise.all([redeem(100, raceKey), redeem(100, raceKey)]);
    expect(raced.map((r) => r.kind)).toEqual(["applied", "applied"]);
    expect(await balance()).toBe(preview.policyValue - 1100);
    await as(ctx, (trx, c) =>
      adjustCredit(trx, c, {
        accountId,
        amount: 100,
        reason: "test: undo the race",
        idempotencyKey: `adjust:${randomUUID()}`,
      }),
    );
    expect(await balance()).toBe(preview.policyValue - 1000);

    // Credit comes back only once its booking is canceled, and then once.
    await expect(
      as(ctx, (trx, c) =>
        reinstateCredit(trx, c, {
          redeemEntryId: used.entry.id,
          idempotencyKey: `reinstate:${randomUUID()}`,
        }),
      ),
    ).rejects.toThrow(/whose booking was canceled/);
    await staffCancelForRefund(A, later.bookingId);
    const reinstated = await as(ctx, (trx, c) =>
      reinstateCredit(trx, c, {
        redeemEntryId: used.entry.id,
        idempotencyKey: `reinstate:${used.entry.id}`,
      }),
    );
    expect(reinstated).toMatchObject({
      kind: "applied",
      entry: { kind: "reinstate", amount: 1000 },
    });
    await expect(
      as(ctx, (trx, c) =>
        reinstateCredit(trx, c, {
          redeemEntryId: used.entry.id,
          idempotencyKey: `reinstate:${randomUUID()}`,
        }),
      ),
    ).rejects.toThrow();
    expect(await balance()).toBe(preview.policyValue);

    // Staff correct the balance down, never below zero; a guest cannot.
    expect(
      await as(ctx, (trx, c) =>
        adjustCredit(trx, c, {
          accountId,
          amount: -(preview.policyValue + 1),
          reason: "test: too much",
          idempotencyKey: `adjust:${randomUUID()}`,
        }),
      ),
    ).toMatchObject({ kind: "insufficient" });
    expect(
      await as(ctx, (trx, c) =>
        adjustCredit(trx, c, {
          accountId,
          amount: -500,
          reason: "test: goodwill correction",
          idempotencyKey: `adjust:${randomUUID()}`,
        }),
      ),
    ).toMatchObject({ kind: "applied", entry: { kind: "adjust", amount: -500, by: "staff" } });
    await expect(
      as(guestContext(A.id), (trx, c) =>
        adjustCredit(trx, c, {
          accountId,
          amount: 500,
          reason: "a guest tries",
          idempotencyKey: `adjust:${randomUUID()}`,
        }),
      ),
    ).rejects.toThrow();
    expect(await balance()).toBe(preview.policyValue - 500);
    const account = await as(ctx, (trx) => getCreditAccount(trx, A.id, accountId));
    // The ledger reads in the order the balance moved: its last entry is the balance.
    expect(account?.entries.at(-1)?.balanceAfter).toBe(account?.balance);
    expect(account?.entries.map((e) => e.kind).sort()).toEqual(
      ["adjust", "adjust", "issue", "redeem", "redeem", "reinstate"].sort(),
    );
    // Issuing credit reverses no fee.
    const [fees] = await admin<{ n: number }[]>`
      select count(*)::int as n from public.fee_ledger_entries where booking_id = ${booked.bookingId}`;
    expect(fees?.n).toBe(0);
  });

  it("lets staff override the policy with a reason, and refuses an override that does not fit", async () => {
    const booked = await confirmBooking(runtime.db, payments, A, tripsA.shared(), 2);
    const ctx = staffContext(A.id);
    const preview = await as(ctx, (trx) => previewStaffCancellation(trx, A.id, booked.bookingId));
    if (!preview) throw new Error("no preview");
    const paid = preview.terms.paidAmount;
    expect(
      await as(ctx, (trx, c) =>
        staffCancelBooking(trx, c, {
          bookingId: booked.bookingId,
          choice: { kind: "override", remedy: "full_refund", refundBp: 5000, reason: "x" },
          expectedAmount: 0,
        }),
      ),
    ).toMatchObject({ kind: "override_invalid" });
    expect(
      await as(ctx, (trx, c) =>
        staffCancelBooking(trx, c, {
          bookingId: booked.bookingId,
          choice: { kind: "override", remedy: "percent_refund", refundBp: 2500, reason: "" },
          expectedAmount: 0,
        }),
      ),
    ).toMatchObject({ kind: "override_invalid" });
    const quarter = Math.floor((paid * 2500 + 5000) / 10000);
    // The amount shown must match what canceling gives.
    expect(
      await as(ctx, (trx, c) =>
        staffCancelBooking(trx, c, {
          bookingId: booked.bookingId,
          choice: {
            kind: "override",
            remedy: "percent_refund",
            refundBp: 2500,
            reason: "Engine trouble",
          },
          expectedAmount: quarter + 1,
        }),
      ),
    ).toMatchObject({ kind: "terms_changed" });
    const canceled = await as(ctx, (trx, c) =>
      staffCancelBooking(trx, c, {
        bookingId: booked.bookingId,
        choice: {
          kind: "override",
          remedy: "percent_refund",
          refundBp: 2500,
          reason: "Engine trouble",
        },
        expectedAmount: quarter,
      }),
    );
    expect(canceled).toMatchObject({
      kind: "canceled",
      cancellation: {
        remedy: "percent_refund",
        refundBp: 2500,
        refundAmount: quarter,
        overridden: true,
      },
    });
    const [row] = await admin<
      { policy_remedy: string; policy_refund_bp: number; override_reason: string | null }[]
    >`select policy_remedy, policy_refund_bp, override_reason from public.booking_cancellations
       where booking_id = ${booked.bookingId}`;
    expect(row).toEqual({
      policy_remedy: preview.terms.remedy,
      policy_refund_bp: preview.terms.refundBp,
      override_reason: "Engine trouble",
    });
    // A guest's context cannot write an override, even directly.
    const other = await confirmBooking(runtime.db, payments, A, tripsA.shared(), 1);
    await expect(
      as(guestContext(A.id), (trx, c) =>
        staffCancelBooking(trx, c, {
          bookingId: other.bookingId,
          choice: { kind: "policy" },
          expectedAmount: 0,
        }),
      ),
    ).rejects.toThrow(/runs as staff/);
  });

  it("gives a credit policy's value as credit when staff cancel, and leaves it to staff for a guest", async () => {
    const booked = await confirmBooking(runtime.db, payments, C, tripsC.shared(), 1);
    const terms = await as(guestContext(C.id), (trx, c) =>
      cancelBooking(trx, c, { bookingId: booked.bookingId, expectedRefundAmount: 0 }),
    );
    expect(terms.kind).toBe("remedy_requires_operator");
    const ctx = staffContext(C.id);
    const preview = await as(ctx, (trx) => previewStaffCancellation(trx, C.id, booked.bookingId));
    if (!preview) throw new Error("no preview");
    expect(preview.terms.remedy).toBe("credit");
    expect(preview.refund).toBeNull();
    expect(preview.policyValue).toBe(preview.terms.paidAmount);
    const canceled = await as(ctx, (trx, c) =>
      staffCancelBooking(trx, c, {
        bookingId: booked.bookingId,
        choice: { kind: "policy" },
        expectedAmount: preview.policyValue,
      }),
    );
    expect(canceled).toMatchObject({
      kind: "canceled",
      cancellation: { remedy: "credit", refundBp: 10000, creditAmount: preview.policyValue },
    });
  });

  it("cancels an unpaid payment at the provider when its guest cancels the checkout", async () => {
    const tripId = tripsA.shared();
    const quote = await quoteFor(runtime.db, A.id, tripId, 1, { charter: false });
    const secret = newSecret();
    const ctx = guestContext(A.id);
    const created = await as(ctx, (trx, c) =>
      createCheckoutSession(trx, c, {
        quoteId: quote.quoteId,
        acceptedPolicyVersion: quote.policy.version,
        booker: { name: "Abandoning Guest", email: "abandon@example.test" },
        secret,
        clientAddress: null,
        provider: "fake",
        minimumAmount: 50,
      }),
    );
    if (created.kind !== "created") throw new Error(JSON.stringify(created));
    const ready = await ensureProviderPayment(runtime.db, payments, ctx, created.session.id);
    if (ready.kind !== "ready") throw new Error(JSON.stringify(ready));
    const canceled = await as(ctx, (trx, c) =>
      cancelCheckoutSession(trx, c, { sessionId: created.session.id, secret }),
    );
    if (canceled.kind !== "canceled" || !canceled.paymentCancellationId) {
      throw new Error(JSON.stringify(canceled));
    }
    const id = canceled.paymentCancellationId;
    // No answer the first time: it stays requested for the sweep.
    const flaky = new FlakyProvider(payments);
    flaky.failCancel = "before";
    expect(await settlePaymentCancellation(runtime.db, flaky, ctx, id)).toEqual({
      kind: "unknown",
    });
    expect(await settlePaymentCancellation(runtime.db, payments, ctx, id)).toEqual({
      kind: "canceled",
    });
    expect(await settlePaymentCancellation(runtime.db, payments, ctx, id)).toEqual({
      kind: "not_pending",
    });
    const fake = await payments.getPayment(A.id, ready.paymentRef);
    expect(fake?.status).toBe("failed");
    const [row] = await admin<{ state: string }[]>`
      select state from public.payment_cancellations where id = ${id}`;
    expect(row?.state).toBe("canceled");
  });

  it("cancels a payment whose checkout closed while the provider was creating it", async () => {
    const quote = await quoteFor(runtime.db, A.id, tripsA.shared(), 1, { charter: false });
    const secret = newSecret();
    const ctx = guestContext(A.id);
    const created = await as(ctx, (trx, c) =>
      createCheckoutSession(trx, c, {
        quoteId: quote.quoteId,
        acceptedPolicyVersion: quote.policy.version,
        booker: { name: "Racing Guest", email: "racing@example.test" },
        secret,
        clientAddress: null,
        provider: "fake",
        minimumAmount: 50,
      }),
    );
    if (created.kind !== "created") throw new Error(JSON.stringify(created));
    const slow = new FlakyProvider(payments);
    slow.createPayment = async (input) => {
      const answer = await payments.createPayment(input);
      // The guest cancels while the provider is still answering.
      const canceled = await as(ctx, (trx, c) =>
        cancelCheckoutSession(trx, c, { sessionId: created.session.id, secret }),
      );
      expect(canceled).toMatchObject({ kind: "canceled", paymentCancellationId: null });
      return answer;
    };
    expect(await ensureProviderPayment(runtime.db, slow, ctx, created.session.id)).toEqual({
      kind: "not_open",
      state: "canceled",
    });
    const [row] = await admin<{ id: string; state: string }[]>`
      select c.id, c.state from public.payment_cancellations c
        join public.payments p on p.id = c.payment_id
       where p.checkout_session_id = ${created.session.id}`;
    expect(row?.state).toBe("requested");
    if (!row) throw new Error("no cancellation");
    expect(await settlePaymentCancellation(runtime.db, payments, ctx, row.id)).toEqual({
      kind: "canceled",
    });
  });

  it("has the sweep cancel an expired checkout's payment and ask again about a pending refund", async () => {
    // An expired checkout with an open payment.
    const tripId = tripsA.shared();
    const quote = await quoteFor(runtime.db, A.id, tripId, 1, { charter: false });
    const ctx = guestContext(A.id);
    const created = await as(ctx, (trx, c) =>
      createCheckoutSession(trx, c, {
        quoteId: quote.quoteId,
        acceptedPolicyVersion: quote.policy.version,
        booker: { name: "Lapsed Guest", email: "lapsed@example.test" },
        secret: newSecret(),
        clientAddress: null,
        provider: "fake",
        minimumAmount: 50,
      }),
    );
    if (created.kind !== "created") throw new Error(JSON.stringify(created));
    const ready = await ensureProviderPayment(runtime.db, payments, ctx, created.session.id);
    if (ready.kind !== "ready") throw new Error(JSON.stringify(ready));
    await backdateCheckout(admin, created.session.id, 3600);

    // A refund pending at the provider, last checked two hours ago.
    const booked = await confirmBooking(runtime.db, payments, A, tripsA.shared(), 1);
    const { ctx: staff, refundId } = await staffCancelForRefund(A, booked.bookingId);
    const flaky = new FlakyProvider(payments);
    flaky.failRefund = "pending";
    expect((await settleRefund(runtime.db, flaky, staff, refundId)).kind).toBe("pending");
    await admin.begin(async (tx) => {
      await tx`set local session_replication_role = replica`;
      await tx`update public.payment_refunds set checked_at = now() - interval '2 hours'
                where id = ${refundId}`;
    });

    // The provider has finished it now; it answers for the same refund by its key.
    const pendingRef = (await refundOf(booked.bookingId)).provider_refund_id;
    if (!pendingRef) throw new Error("no pending refund id");
    flaky.refundPayment = async () => ({ refundRef: pendingRef, status: "succeeded" as const });
    const report = await sweepCheckouts(runtime.db, {
      runId: `sweep-${randomUUID()}`,
      provider: flaky,
      graceSeconds: 0,
    });
    expect(report.cancellationsSettled).toBeGreaterThanOrEqual(1);
    const [cancellation] = await admin<{ state: string }[]>`
      select c.state from public.payment_cancellations c
        join public.payments p on p.id = c.payment_id
       where p.checkout_session_id = ${created.session.id}`;
    expect(cancellation?.state).toBe("canceled");
    expect((await payments.getPayment(A.id, ready.paymentRef))?.status).toBe("failed");
    expect((await refundOf(booked.bookingId)).state).toBe("succeeded");
  });
});
