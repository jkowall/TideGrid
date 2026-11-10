/**
 * Private-charter deposits and balances (W3-G2.8) on the local PostgreSQL:
 * the quote and checkout take the deposit, the balance is owed until the
 * guest pays it by card or staff record an external payment, reminders are
 * written for the due date and move with it, the balance link is limited,
 * only a verified event marks a balance payment paid, and the database
 * refuses a balance payment for anything but what is owed.
 */
import { randomUUID } from "node:crypto";
import {
  createDb,
  inTenantTransaction,
  type TenantContext,
  type TenantTransaction,
} from "@tidegrid/database";
import type {} from "@tidegrid/database/global-setup";
import { tripAllocator } from "@tidegrid/domain-inventory/testing";
import { balanceEmailTiming } from "@tidegrid/domain-messaging";
import type { FakePaymentProvider } from "@tidegrid/domain-payments";
import { createPriceListVersion } from "@tidegrid/domain-pricing";
import { sql } from "kysely";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";
import { handleVerifiedEvent } from "./finalize.ts";
import {
  BALANCE_PAYMENT_REUSE_HOURS,
  cancelBooking,
  changeBalanceDueDate,
  ensureBalanceProviderPayment,
  getBookingBalance,
  MAX_BALANCE_LINKS_PER_HOUR,
  openBalancePayment,
  previewCancellation,
  previewStaffCancellation,
  recordExternalSettlement,
  sendBalanceLink,
  staffCancelBooking,
} from "./index.ts";
import {
  type CheckoutFixture,
  confirmBooking,
  createCheckoutFixture,
  fakeProvider,
  guestContext,
  quoteFor,
  verifiedFakeEvent,
} from "./test-fixtures.ts";

type Sql = ReturnType<typeof postgres>;

const env = inject("integrationDb");
const FAKE_MINIMUM = 50;
const DEPOSIT = 20_000;
// The fixture's charter is $1,000 with a 7% added tax.
const TOTAL = 107_000;

function staffContext(tenantId: string): TenantContext {
  return { tenantId, actorType: "staff", actorId: "staff-g28", requestId: `req-${randomUUID()}` };
}

function systemContext(tenantId: string): TenantContext {
  return { tenantId, actorType: "system", actorId: "test-g28", requestId: `req-${randomUUID()}` };
}

describe.skipIf(!env)("private-charter deposits and balances (W3-G2.8)", () => {
  let admin: Sql;
  let runtime: ReturnType<typeof createDb>;
  let payments: FakePaymentProvider;
  let A: CheckoutFixture;
  let trips: ReturnType<typeof tripAllocator>;

  const as = <T>(
    ctx: TenantContext,
    fn: (trx: TenantTransaction, ctx: TenantContext) => Promise<T>,
  ): Promise<T> => inTenantTransaction(runtime.db, ctx, (trx) => fn(trx, ctx));

  /** A charter trip far enough out that its balance is due after the quote. */
  const charterTrip = () => trips.charter();

  async function balanceOf(bookingId: string) {
    return as(staffContext(A.id), (trx) => getBookingBalance(trx, A.id, bookingId));
  }

  async function payBalance(bookingId: string) {
    const opened = await as(guestContext(A.id), (trx, c) =>
      openBalancePayment(trx, c, { bookingId, provider: "fake", minimumAmount: FAKE_MINIMUM }),
    );
    if (opened.kind !== "opened") throw new Error(`open: ${JSON.stringify(opened)}`);
    const ready = await ensureBalanceProviderPayment(
      runtime.db,
      payments,
      guestContext(A.id),
      opened.paymentId,
    );
    if (ready.kind !== "ready") throw new Error(`ready: ${JSON.stringify(ready)}`);
    return { opened, ready };
  }

  async function settle(paymentRef: string, outcome: "succeeded" | "failed") {
    const settled = await payments.settlePayment(A.id, paymentRef, outcome, Date.now());
    if (settled.kind === "not_found") throw new Error("no fake payment");
    const event = await verifiedFakeEvent(payments, settled.event.body);
    return handleVerifiedEvent(runtime.db, payments, event, { requestId: `req-${randomUUID()}` });
  }

  beforeAll(async () => {
    if (!env) return;
    admin = postgres(env.adminUrl, { max: 2, onnotice: () => {} });
    runtime = createDb(env.runtimeUrl, { max: 8 });
    payments = fakeProvider(runtime.db);
    A = await createCheckoutFixture(admin, runtime.db, "g28-a", { days: 12 });
    trips = tripAllocator(A);
    // The first trips are too close for a balance due a day before; skip them.
    for (let i = 0; i < 3; i += 1) trips.charter();
    const sys = systemContext(A.id);
    const created = await as(sys, (trx, c) =>
      createPriceListVersion(trx, c, {
        productId: A.products.charter,
        charter: { name: "Whole boat", amount: 100_000, taxable: true },
        deposit: { kind: "fixed", amount: DEPOSIT, balanceDueDays: 1 },
        reason: "deposit terms",
      }),
    );
    if (created.kind !== "created") throw new Error(JSON.stringify(created));
  });

  afterAll(async () => {
    await runtime?.end();
    await admin?.end({ timeout: 5 });
  });

  it("quotes and charges the deposit, and keeps the balance owed", async () => {
    const tripId = charterTrip();
    const quote = await quoteFor(runtime.db, A.id, tripId, 4, { charter: true });
    expect(quote.totals.total).toBe(TOTAL);
    expect(quote.totals.amountDueNow).toBe(DEPOSIT);
    expect(quote.deposit).toMatchObject({ amount: DEPOSIT, balanceAmount: TOTAL - DEPOSIT });

    const booked = await confirmBooking(runtime.db, payments, A, tripId, 4, { charter: true });
    const [paid] = await admin<{ amount: number }[]>`
      select p.amount from public.payments p
       where p.checkout_session_id = ${booked.checkoutSessionId}`;
    expect(paid?.amount).toBe(DEPOSIT);

    const balance = await balanceOf(booked.bookingId);
    expect(balance).toMatchObject({
      total: TOTAL,
      deposit: DEPOSIT,
      paidIn: DEPOSIT,
      owed: TOTAL - DEPOSIT,
      overpaid: 0,
      payments: [],
      dueChanges: [],
    });
    expect(["scheduled", "due"]).toContain(balance?.state);

    // Reminders were written for the due date, and none goes out for a settled booking.
    const reminders = await admin<{ n: number }[]>`
      select count(*)::int as n from public.email_messages
       where booking_id = ${booked.bookingId} and template = 'booking_balance_reminder'`;
    expect(reminders[0]?.n).toBeGreaterThan(0);
    const timing = await as(systemContext(A.id), (trx) =>
      balanceEmailTiming(trx, A.id, booked.bookingId),
    );
    expect(timing).toBe("ok");
  });

  it("pays nothing more on a shared trip: no balance", async () => {
    const booked = await confirmBooking(runtime.db, payments, A, trips.shared(), 2);
    expect(await balanceOf(booked.bookingId)).toBeNull();
  });

  it("takes the balance by card, and only a verified event marks it paid", async () => {
    const booked = await confirmBooking(runtime.db, payments, A, charterTrip(), 3, {
      charter: true,
    });
    const first = await payBalance(booked.bookingId);
    expect(first.opened).toMatchObject({ amount: TOTAL - DEPOSIT, reused: false });
    // The guest comes back before paying: the same payment.
    const again = await as(guestContext(A.id), (trx, c) =>
      openBalancePayment(trx, c, {
        bookingId: booked.bookingId,
        provider: "fake",
        minimumAmount: FAKE_MINIMUM,
      }),
    );
    expect(again).toMatchObject({
      kind: "opened",
      paymentId: first.opened.paymentId,
      reused: true,
    });

    // A declined card leaves the balance owed; the guest may pay again.
    const failed = await settle(first.ready.paymentRef, "failed");
    expect(failed).toMatchObject({ kind: "processed", outcome: "balance_payment_failed" });
    expect((await balanceOf(booked.bookingId))?.owed).toBe(TOTAL - DEPOSIT);

    const second = await payBalance(booked.bookingId);
    expect(second.opened.paymentId).not.toBe(first.opened.paymentId);
    const paid = await settle(second.ready.paymentRef, "succeeded");
    expect(paid).toMatchObject({ kind: "processed", outcome: "balance_paid" });

    const balance = await balanceOf(booked.bookingId);
    expect(balance).toMatchObject({ state: "paid", owed: 0, paidIn: TOTAL, overpaid: 0 });
    expect(balance?.payments.map((p) => p.state)).toEqual(["failed", "succeeded"]);

    // Nothing more is owed: no new payment, no link, and the reminders stand down.
    const more = await as(guestContext(A.id), (trx, c) =>
      openBalancePayment(trx, c, {
        bookingId: booked.bookingId,
        provider: "fake",
        minimumAmount: FAKE_MINIMUM,
      }),
    );
    expect(more.kind).toBe("nothing_owed");
    const link = await as(staffContext(A.id), (trx, c) =>
      sendBalanceLink(trx, c, booked.bookingId),
    );
    expect(link.kind).toBe("nothing_owed");
    const timing = await as(systemContext(A.id), (trx) =>
      balanceEmailTiming(trx, A.id, booked.bookingId),
    );
    expect(timing).toBe("settled");
  });

  it("counts an external payment, and abandons a card payment for an older balance", async () => {
    const booked = await confirmBooking(runtime.db, payments, A, charterTrip(), 2, {
      charter: true,
    });
    const open = await payBalance(booked.bookingId);
    const staff = staffContext(A.id);
    const external = await as(staff, (trx, c) =>
      recordExternalSettlement(trx, c, {
        bookingId: booked.bookingId,
        kind: "payment",
        tender: "cash",
        amount: 7_000,
        reason: "Part of the balance in cash at the dock",
        idempotencyKey: `external:${randomUUID()}`,
      }),
    );
    expect(external.kind).toBe("recorded");
    expect((await balanceOf(booked.bookingId))?.owed).toBe(TOTAL - DEPOSIT - 7_000);

    const reopened = await payBalance(booked.bookingId);
    expect(reopened.opened.paymentId).not.toBe(open.opened.paymentId);
    expect(reopened.opened.amount).toBe(TOTAL - DEPOSIT - 7_000);
    const states = await admin<{ id: string; state: string }[]>`
      select id, state from public.balance_payments where booking_id = ${booked.bookingId}
       order by created_at`;
    expect(states.map((s) => s.state)).toEqual(["abandoned", "pending"]);

    // A late success of the abandoned payment still counts: money came in.
    const late = await settle(open.ready.paymentRef, "succeeded");
    expect(late).toMatchObject({ kind: "processed", outcome: "balance_paid" });
    const balance = await balanceOf(booked.bookingId);
    expect(balance).toMatchObject({ owed: 0, state: "paid", overpaid: 7_000 });
  });

  it("moves the due date with a reason, and the reminders with it", async () => {
    const tripId = charterTrip();
    const booked = await confirmBooking(runtime.db, payments, A, tripId, 2, { charter: true });
    const [trip] = await admin<{ starts_at: Date }[]>`
      select starts_at from public.scheduled_trips where id = ${tripId}`;
    const startsAt = trip?.starts_at.getTime() ?? 0;
    const staff = staffContext(A.id);

    const late = await as(staff, (trx, c) =>
      changeBalanceDueDate(trx, c, {
        bookingId: booked.bookingId,
        dueAt: new Date(startsAt),
        reason: "Guest asked for more time",
      }),
    );
    expect(late.kind).toBe("invalid_due_date");

    const before = await admin<{ id: string }[]>`
      select id from public.email_messages
       where booking_id = ${booked.bookingId} and template = 'booking_balance_reminder'
         and state = 'queued'`;
    const dueAt = new Date(startsAt - 3 * 3_600_000);
    const moved = await as(staff, (trx, c) =>
      changeBalanceDueDate(trx, c, {
        bookingId: booked.bookingId,
        dueAt,
        reason: "Guest asked for more time",
      }),
    );
    expect(moved.kind).toBe("changed");
    if (moved.kind !== "changed") return;
    expect(moved.balance.dueAt).toBe(dueAt.toISOString());
    expect(moved.balance.dueChanges).toEqual([
      expect.objectContaining({ dueAt: dueAt.toISOString(), reason: "Guest asked for more time" }),
    ]);
    if (before.length > 0) {
      const old = await admin<{ state: string }[]>`
        select state from public.email_messages where id in ${admin(before.map((r) => r.id))}`;
      expect(old.every((m) => m.state === "canceled")).toBe(true);
    }
    // The guest's view leaves staff's reason out.
    const guestView = await as(guestContext(A.id), (trx) =>
      getBookingBalance(trx, A.id, booked.bookingId, { withReasons: false }),
    );
    expect(guestView?.dueChanges[0]?.reason).toBeNull();

    // History cannot be rewritten.
    await expect(
      admin.begin(async (tx) => {
        await tx`set local role tidegrid_app`;
        await tx`select set_config('app.tenant_id', ${A.id}, true)`;
        await tx`update public.balance_due_changes set reason = 'x' where booking_id = ${booked.bookingId}`;
      }),
    ).rejects.toThrow();
  });

  it("limits the balance link to three an hour", async () => {
    const booked = await confirmBooking(runtime.db, payments, A, charterTrip(), 2, {
      charter: true,
    });
    const staff = staffContext(A.id);
    for (let i = 0; i < MAX_BALANCE_LINKS_PER_HOUR; i += 1) {
      const sent = await as(staff, (trx, c) => sendBalanceLink(trx, c, booked.bookingId));
      expect(sent.kind).toBe("enqueued");
    }
    const refused = await as(staff, (trx, c) => sendBalanceLink(trx, c, booked.bookingId));
    expect(refused).toEqual({ kind: "rate_limited", limit: MAX_BALANCE_LINKS_PER_HOUR });
  });

  it("sends a refund cancellation of a deposit booking to the operator", async () => {
    const booked = await confirmBooking(runtime.db, payments, A, charterTrip(), 2, {
      charter: true,
    });
    const terms = await as(guestContext(A.id), (trx) =>
      previewCancellation(trx, A.id, booked.bookingId),
    );
    expect(terms).toMatchObject({ cancelable: false, refusal: "remedy_requires_operator" });
    const canceled = await as(guestContext(A.id), (trx, c) =>
      cancelBooking(trx, c, { bookingId: booked.bookingId, expectedRefundAmount: 0 }),
    );
    expect(canceled.kind).toBe("remedy_requires_operator");
  });

  it("lets staff cancel a deposit booking, refunding at most the deposit and closing the balance", async () => {
    const booked = await confirmBooking(runtime.db, payments, A, charterTrip(), 2, {
      charter: true,
    });
    const open = await payBalance(booked.bookingId);
    const staff = staffContext(A.id);
    const cancel = await as(staff, async (trx, c) => {
      const preview = await previewStaffCancellation(trx, A.id, booked.bookingId);
      if (!preview) throw new Error("no preview");
      expect(preview.refund?.amount ?? 0).toBeLessThanOrEqual(DEPOSIT);
      return staffCancelBooking(trx, c, {
        bookingId: booked.bookingId,
        choice: { kind: "policy", remedy: preview.terms.remedy },
        expectedAmount: preview.refund?.amount ?? 0,
      });
    });
    expect(cancel.kind).toBe("canceled");
    const [row] = await admin<{ state: string }[]>`
      select state from public.balance_payments where id = ${open.opened.paymentId}`;
    expect(row?.state).toBe("abandoned");
    const queued = await admin<{ n: number }[]>`
      select count(*)::int as n from public.email_messages
       where booking_id = ${booked.bookingId}
         and template in ('booking_balance_reminder', 'booking_balance_link')
         and state = 'queued'`;
    expect(queued[0]?.n).toBe(0);
    expect(await balanceOf(booked.bookingId)).toMatchObject({ state: "canceled", owed: 0 });
  });

  it("replaces an open card payment older than the provider remembers its key", async () => {
    const booked = await confirmBooking(runtime.db, payments, A, charterTrip(), 2, {
      charter: true,
    });
    const first = await payBalance(booked.bookingId);
    await admin.begin(async (tx) => {
      await tx`set local session_replication_role = replica`;
      await tx`update public.balance_payments
                  set created_at = now() - make_interval(hours => ${BALANCE_PAYMENT_REUSE_HOURS + 1})
                where id = ${first.opened.paymentId}`;
    });
    const second = await payBalance(booked.bookingId);
    expect(second.opened).toMatchObject({ reused: false, amount: TOTAL - DEPOSIT });
    expect(second.opened.paymentId).not.toBe(first.opened.paymentId);
    const [old] = await admin<{ state: string }[]>`
      select state from public.balance_payments where id = ${first.opened.paymentId}`;
    expect(old?.state).toBe("abandoned");
  });

  it("refuses a balance payment for anything but what is owed", async () => {
    const booked = await confirmBooking(runtime.db, payments, A, charterTrip(), 2, {
      charter: true,
    });
    const insert = (amount: number) =>
      as(guestContext(A.id), (trx) =>
        sql`
          insert into balance_payments (tenant_id, booking_id, provider, account_ref,
            idempotency_key, amount, currency)
          values (${A.id}, ${booked.bookingId}, 'fake', ${A.accountRef},
            ${`balance:${randomUUID()}`}, ${amount}, 'USD')`.execute(trx),
      );
    await expect(insert(TOTAL - DEPOSIT - 1)).rejects.toMatchObject({ code: "23514" });
    await expect(insert(TOTAL - DEPOSIT)).resolves.toBeDefined();
    // At most one open payment per booking.
    await expect(insert(TOTAL - DEPOSIT)).rejects.toMatchObject({ code: expect.any(String) });
    // The runtime never deletes.
    await expect(
      as(guestContext(A.id), (trx) =>
        sql`delete from balance_payments where booking_id = ${booked.bookingId}`.execute(trx),
      ),
    ).rejects.toThrow();
  });
});
