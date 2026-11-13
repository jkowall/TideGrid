/**
 * Private-charter balances (W3-G2.8): what happens after a deposit.
 *
 * - Reminders. The confirmation writes two balance reminders, due 7 days and
 *   1 day before the due date (D1). Each is checked again when it is due and
 *   canceled if nothing is owed any more (domain-messaging's reminders.ts).
 * - The balance link. The reminders, and an email staff send on request,
 *   carry the guest's management link; the booking page shows the balance and
 *   takes the payment. Staff may send at most three an hour per booking.
 * - Paying. The guest opens a balance payment for exactly what is owed, and
 *   the provider charges it. Only a verified provider event marks it paid or
 *   failed (onBalancePaymentEvent, from the inbox). A guest who comes back
 *   after the balance changed gets a new payment; the old one is abandoned.
 * - Staff record a balance paid outside the card flow as an external payment
 *   (W3-G2.10); it counts toward the balance at once.
 * - Staff move the due date with a reason. The reminders move with it.
 * - Nothing cancels a booking for an unpaid balance, and nothing is charged
 *   without the guest.
 *
 * Lock order: the booking row (FOR NO KEY UPDATE), then the balance payment.
 */
import {
  type Database,
  inTenantTransaction,
  isUuid,
  type TenantContext,
  type TenantTransaction,
} from "@tidegrid/database";
import {
  BALANCE_LINK_TEMPLATE,
  BALANCE_REMINDER_LEAD_DAYS,
  BALANCE_REMINDER_TEMPLATE,
  cancelMessage,
} from "@tidegrid/domain-messaging";
import {
  getPaymentAccount,
  type InboxEvent,
  type PaymentProvider,
  type PaymentProviderName,
  ProviderRejectedError,
  ProviderUnavailableError,
} from "@tidegrid/domain-payments";
import { type Kysely, sql } from "kysely";
import { type BalanceView, getBookingBalance } from "./balance-read.ts";
import { enqueueBalanceEmail } from "./emails.ts";
import { record } from "./views.ts";

/** Balance link emails staff may send for one booking in an hour. */
export const MAX_BALANCE_LINKS_PER_HOUR = 3;
/** A pending balance payment is reused for this long, well inside the provider's idempotency window. */
export const BALANCE_PAYMENT_REUSE_HOURS = 12;
/** A reminder due sooner than this after it is written is not written: the guest just heard from us. */
export const BALANCE_REMINDER_MIN_NOTICE_HOURS = 1;

export type BalancePaymentEventOutcome =
  /** A balance payment succeeded. */
  | "balance_paid"
  /** A balance payment failed; the guest may pay again. */
  | "balance_payment_failed"
  /** Nothing changed: it had already succeeded, or a failure came after success. */
  | "balance_already_settled"
  /** The event names a balance payment but not as it is. Nothing changed. */
  | "balance_payment_mismatch";

// Reminders ---------------------------------------------------------------------------------

/**
 * Write the booking's balance reminders, 7 days and 1 day before its due date,
 * each once per due date. One that would be due within the hour, or already
 * past, is not written. Returns how many were written.
 */
export async function enqueueBalanceReminders(
  trx: TenantTransaction,
  ctx: TenantContext,
  bookingId: string,
): Promise<number> {
  const { rows } = await sql<{ due_at: Date; generation: number; worth: boolean[] }>`
    select x.due_at,
           (select count(*)::int from balance_due_changes c
             where c.tenant_id = ${ctx.tenantId} and c.booking_id = ${bookingId}) as generation,
           array[${sql.join(
             BALANCE_REMINDER_LEAD_DAYS.map(
               (days) =>
                 sql`x.due_at - make_interval(hours => ${days * 24})
                       > now() + make_interval(hours => ${BALANCE_REMINDER_MIN_NOTICE_HOURS})`,
             ),
           )}] as worth
      from app.booking_balance(${ctx.tenantId}, ${bookingId}) x
     where x.owed > 0`.execute(trx);
  const row = rows[0];
  if (!row) return 0;
  const due = new Date(row.due_at);
  let written = 0;
  for (const [i, days] of BALANCE_REMINDER_LEAD_DAYS.entries()) {
    if (!row.worth[i]) continue;
    const done = await enqueueBalanceEmail(trx, ctx, bookingId, {
      kind: "reminder",
      // Each due date change is a new generation: moving the date back to one
      // used before writes new reminders, not the canceled ones.
      dedupeKey: `booking.balance_reminder:${bookingId}:${row.generation}:${due.toISOString()}:${days}`,
      notBefore: new Date(due.getTime() - days * 86_400_000),
    });
    if (done && !done.duplicate) written += 1;
  }
  return written;
}

/**
 * Cancel the booking's balance emails still waiting to go out or being sent:
 * reminders when the due date moved (a link staff asked for stays), every one
 * when the booking was canceled. Waits for a delivery run that holds one, as
 * a cancellation does, so none is sent with an old date.
 */
export async function cancelQueuedBalanceEmails(
  trx: TenantTransaction,
  ctx: TenantContext,
  bookingId: string,
  code: "due_date_moved" | "booking_canceled",
): Promise<number> {
  const { rows } = await sql<{ id: string }>`
    select id from email_messages
     where tenant_id = ${ctx.tenantId} and booking_id = ${bookingId}
       and template in (${BALANCE_REMINDER_TEMPLATE},
                        ${code === "booking_canceled" ? BALANCE_LINK_TEMPLATE : BALANCE_REMINDER_TEMPLATE})
       and state in ('queued', 'sending')
     order by id`.execute(trx);
  let canceled = 0;
  for (const message of rows) {
    const done = await cancelMessage(trx, ctx, message.id, { code });
    if (done.kind === "canceled") canceled += 1;
  }
  return canceled;
}

// Staff: the due date and the link -------------------------------------------------------------

export type ChangeDueDateResult =
  | { kind: "changed"; balance: BalanceView }
  | { kind: "not_found" }
  /** The booking paid in full at checkout, or was canceled. */
  | { kind: "no_balance" }
  /** The new due date is not before the trip starts. */
  | { kind: "invalid_due_date" };

// biome-ignore lint/suspicious/noControlCharactersInRegex: the pattern exists to reject them.
const reasonPattern = /^[^\u0000-\u001f\u007f]{1,500}$/;

/**
 * Move a booking's balance due date, with a reason. The reminders for the
 * old date are canceled and new ones written for the new date.
 */
export async function changeBalanceDueDate(
  trx: TenantTransaction,
  ctx: TenantContext,
  input: { bookingId: string; dueAt: Date; reason: string },
): Promise<ChangeDueDateResult> {
  const reason = input.reason.trim();
  if (!reasonPattern.test(reason)) throw new RangeError("a reason is 1 to 500 characters");
  if (Number.isNaN(input.dueAt.getTime())) throw new RangeError("dueAt must be an instant");
  if (!isUuid(input.bookingId)) return { kind: "not_found" };
  const { rows } = await sql<{ state: string; starts_at: Date }>`
    select b.state, t.starts_at from bookings b
      join scheduled_trips t on t.tenant_id = b.tenant_id and t.id = b.trip_id
     where b.tenant_id = ${ctx.tenantId} and b.id = ${input.bookingId}
       for no key update of b`.execute(trx);
  const booking = rows[0];
  if (!booking) return { kind: "not_found" };
  const before = await getBookingBalance(trx, ctx.tenantId, input.bookingId);
  if (!before || booking.state !== "confirmed") return { kind: "no_balance" };
  if (input.dueAt.getTime() >= new Date(booking.starts_at).getTime()) {
    return { kind: "invalid_due_date" };
  }
  await sql`
    insert into balance_due_changes (tenant_id, booking_id, due_at, reason)
    values (${ctx.tenantId}, ${input.bookingId}, ${input.dueAt.toISOString()}, ${reason})`.execute(
    trx,
  );
  await cancelQueuedBalanceEmails(trx, ctx, input.bookingId, "due_date_moved");
  await enqueueBalanceReminders(trx, ctx, input.bookingId);
  const after = await getBookingBalance(trx, ctx.tenantId, input.bookingId);
  if (!after) throw new Error("a balance vanished inside its own transaction");
  await record(trx, ctx, {
    action: "booking.balance_due_changed",
    subjectType: "booking",
    subjectId: input.bookingId,
    reason,
    before: { dueAt: before.dueAt },
    after: { dueAt: after.dueAt },
    topic: "booking.balance_due_changed",
    payload: { bookingId: input.bookingId },
  });
  return { kind: "changed", balance: after };
}

export type SendBalanceLinkResult =
  | { kind: "enqueued"; messageId: string }
  | { kind: "not_found" }
  /** Nothing is owed, or the booking was canceled or its trip has left. */
  | { kind: "nothing_owed" }
  | { kind: "rate_limited"; limit: number }
  /** An imported booking: its email is held until the import releases it. */
  | { kind: "imported_booking" };

/**
 * Email the booker the balance link now, at staff's request: at most three an
 * hour per booking, counted under the booking's lock.
 */
export async function sendBalanceLink(
  trx: TenantTransaction,
  ctx: TenantContext,
  bookingId: string,
): Promise<SendBalanceLinkResult> {
  if (!isUuid(bookingId)) return { kind: "not_found" };
  const { rows } = await sql<{ state: string; departed: boolean }>`
    select b.state, t.starts_at <= now() as departed from bookings b
      join scheduled_trips t on t.tenant_id = b.tenant_id and t.id = b.trip_id
     where b.tenant_id = ${ctx.tenantId} and b.id = ${bookingId}
       for no key update of b`.execute(trx);
  const booking = rows[0];
  if (!booking) return { kind: "not_found" };
  const balance = await getBookingBalance(trx, ctx.tenantId, bookingId);
  if (!balance || booking.state !== "confirmed" || booking.departed || balance.owed <= 0) {
    return { kind: "nothing_owed" };
  }
  const { rows: recent } = await sql<{ sent: number }>`
    select count(*)::int as sent from email_messages
     where tenant_id = ${ctx.tenantId} and booking_id = ${bookingId}
       and template = ${BALANCE_LINK_TEMPLATE}
       and created_at > now() - interval '1 hour'`.execute(trx);
  if ((recent[0]?.sent ?? 0) >= MAX_BALANCE_LINKS_PER_HOUR) {
    return { kind: "rate_limited", limit: MAX_BALANCE_LINKS_PER_HOUR };
  }
  const done = await enqueueBalanceEmail(trx, ctx, bookingId, {
    kind: "link",
    dedupeKey: `booking.balance_link:${bookingId}:${crypto.randomUUID()}`,
  });
  // An imported booking's email is held (W3-G2.13).
  if (!done) return { kind: "imported_booking" };
  await record(trx, ctx, {
    action: "booking.balance_link_sent",
    subjectType: "booking",
    subjectId: bookingId,
    after: { messageId: done.messageId, owed: balance.owed },
  });
  return { kind: "enqueued", messageId: done.messageId };
}

// The guest pays ------------------------------------------------------------------------------

export type OpenBalancePaymentResult =
  | { kind: "opened"; paymentId: string; amount: number; reused: boolean }
  | { kind: "not_found" }
  | { kind: "nothing_owed" }
  | { kind: "amount_too_small"; minimum: number }
  | { kind: "payments_unavailable" };

/**
 * Open the card payment of what the booking owes now, or reuse the open one
 * when it is for that amount. One for another amount (the balance changed
 * since) is abandoned first. Runs in the guest's transaction; the provider
 * is called after it commits (ensureBalanceProviderPayment).
 */
export async function openBalancePayment(
  trx: TenantTransaction,
  ctx: TenantContext,
  input: { bookingId: string; provider: PaymentProviderName; minimumAmount: number },
): Promise<OpenBalancePaymentResult> {
  if (!isUuid(input.bookingId)) return { kind: "not_found" };
  const { rows } = await sql<{ state: string; departed: boolean; source: string }>`
    select b.state, t.starts_at <= now() as departed, b.source from bookings b
      join scheduled_trips t on t.tenant_id = b.tenant_id and t.id = b.trip_id
     where b.tenant_id = ${ctx.tenantId} and b.id = ${input.bookingId}
       for no key update of b`.execute(trx);
  const booking = rows[0];
  // An imported booking's balance is paid to staff until the import's email
  // release (W3-G2.13, part D); no guest card payment opens on it.
  if (!booking || booking.source === "imported") return { kind: "not_found" };
  const balance = await getBookingBalance(trx, ctx.tenantId, input.bookingId);
  if (!balance || booking.state !== "confirmed" || booking.departed || balance.owed <= 0) {
    return { kind: "nothing_owed" };
  }
  if (balance.owed < input.minimumAmount) {
    return { kind: "amount_too_small", minimum: input.minimumAmount };
  }
  const account = await getPaymentAccount(trx, ctx.tenantId, input.provider);
  if (account?.status !== "active") return { kind: "payments_unavailable" };
  const { rows: open } = await sql<{
    id: string;
    amount: number;
    provider: string;
    fresh: boolean;
  }>`
    select id, amount, provider,
           created_at > now() - make_interval(hours => ${BALANCE_PAYMENT_REUSE_HOURS}) as fresh
      from balance_payments
     where tenant_id = ${ctx.tenantId} and booking_id = ${input.bookingId} and state = 'pending'
       for update`.execute(trx);
  const current = open[0];
  // Reused only while the provider still remembers its idempotency key
  // (Stripe keeps one about a day); an older one is replaced by a new one.
  if (
    current &&
    current.fresh &&
    current.amount === balance.owed &&
    current.provider === input.provider
  ) {
    return { kind: "opened", paymentId: current.id, amount: current.amount, reused: true };
  }
  if (current) {
    await sql`
      update balance_payments set state = 'abandoned'
       where tenant_id = ${ctx.tenantId} and id = ${current.id} and state = 'pending'`.execute(trx);
    await record(trx, ctx, {
      action: "booking.balance_payment_abandoned",
      subjectType: "booking",
      subjectId: input.bookingId,
      before: { paymentId: current.id, amount: current.amount },
      after: { owed: balance.owed },
    });
  }
  const paymentId = crypto.randomUUID();
  await sql`
    insert into balance_payments (id, tenant_id, booking_id, provider, account_ref,
      idempotency_key, amount)
    values (${paymentId}, ${ctx.tenantId}, ${input.bookingId}, ${input.provider},
      ${account.accountRef}, ${`balance_payment:${paymentId}`}, ${balance.owed})`.execute(trx);
  await record(trx, ctx, {
    action: "booking.balance_payment_opened",
    subjectType: "booking",
    subjectId: input.bookingId,
    after: { paymentId, amount: balance.owed },
  });
  return { kind: "opened", paymentId, amount: balance.owed, reused: false };
}

export type EnsureBalancePaymentResult =
  | { kind: "ready"; provider: PaymentProviderName; paymentRef: string; clientSecret: string }
  /** The payment is no longer open: paid, failed, or replaced. */
  | { kind: "not_open" }
  | { kind: "unavailable"; reason: string }
  | { kind: "not_found" };

/**
 * Make sure the provider has this balance payment, and return what the guest's
 * browser needs to pay it. Outside any transaction, as for checkout: the same
 * idempotency key returns the same provider payment, so a retry never makes a
 * second one.
 */
export async function ensureBalanceProviderPayment(
  db: Kysely<Database>,
  provider: PaymentProvider,
  ctx: TenantContext,
  paymentId: string,
): Promise<EnsureBalancePaymentResult> {
  if (!isUuid(paymentId)) return { kind: "not_found" };
  const row = await inTenantTransaction(db, ctx, async (trx) => {
    const { rows } = await sql<{
      id: string;
      provider: PaymentProviderName;
      account_ref: string;
      idempotency_key: string;
      provider_payment_id: string | null;
      amount: number;
      state: string;
    }>`
      select id, provider, account_ref, idempotency_key, provider_payment_id, amount, state
        from balance_payments
       where tenant_id = ${ctx.tenantId} and id = ${paymentId}`.execute(trx);
    return rows[0];
  });
  if (!row) return { kind: "not_found" };
  if (row.state !== "pending") return { kind: "not_open" };
  if (row.provider !== provider.name) return { kind: "unavailable", reason: "provider_changed" };
  let created: Awaited<ReturnType<PaymentProvider["createPayment"]>>;
  try {
    created = await provider.createPayment({
      accountRef: row.account_ref,
      amount: row.amount,
      currency: "USD",
      idempotencyKey: row.idempotency_key,
      clientReference: row.id,
    });
  } catch (err) {
    if (err instanceof ProviderRejectedError) return { kind: "unavailable", reason: err.code };
    if (err instanceof ProviderUnavailableError)
      return { kind: "unavailable", reason: "unavailable" };
    throw err;
  }
  // The payment may have been abandoned (the booking canceled, or the balance
  // changed) while the provider answered: hand the guest nothing to pay then.
  const stillOpen = await inTenantTransaction(db, ctx, async (trx) => {
    const { rows: now } = await sql<{ state: string }>`
      select bp.state from bookings b
        join balance_payments bp on bp.tenant_id = b.tenant_id and bp.booking_id = b.id
       where b.tenant_id = ${ctx.tenantId} and bp.id = ${row.id}
         for no key update of b`.execute(trx);
    if (now[0]?.state !== "pending") return false;
    if (row.provider_payment_id === null) {
      const recorded = await sql`
        update balance_payments set provider_payment_id = ${created.paymentRef}
         where tenant_id = ${ctx.tenantId} and id = ${row.id} and provider_payment_id is null`.execute(
        trx,
      );
      if (recorded.numAffectedRows === 1n) {
        await record(trx, ctx, {
          action: "booking.balance_payment_provider_recorded",
          subjectType: "balance_payment",
          subjectId: row.id,
          after: { providerPaymentId: created.paymentRef },
        });
      }
    }
    return true;
  });
  if (!stillOpen) return { kind: "not_open" };
  if (row.provider_payment_id !== null && row.provider_payment_id !== created.paymentRef) {
    // The provider forgot the key and made another payment: refuse it, so the
    // guest opens a new balance payment rather than paying an unrecorded one.
    return { kind: "unavailable", reason: "provider_key_expired" };
  }
  return {
    kind: "ready",
    provider: provider.name,
    paymentRef: created.paymentRef,
    clientSecret: created.clientSecret,
  };
}

// Verified events ---------------------------------------------------------------------------

/**
 * A verified payment event that names no checkout payment may name a balance
 * payment: by our own id when the provider echoed it, else by the provider's
 * id. Returns null when it names none, so the inbox records it as unmatched.
 */
export async function onBalancePaymentEvent(
  trx: TenantTransaction,
  ctx: TenantContext,
  event: InboxEvent,
  kind: "succeeded" | "failed",
): Promise<{ outcome: BalancePaymentEventOutcome; bookingId: string } | null> {
  // Our own id when the provider echoed one; a reference that is not one of
  // ours (not a uuid) must not reach a uuid comparison.
  const by =
    event.clientReference && isUuid(event.clientReference)
      ? sql`id = ${event.clientReference}`
      : event.paymentRef
        ? sql`provider_payment_id = ${event.paymentRef}`
        : null;
  if (by === null) return null;
  const { rows: found } = await sql<{ booking_id: string }>`
    select booking_id from balance_payments
     where tenant_id = ${ctx.tenantId} and provider = ${event.provider} and ${by}`.execute(trx);
  const bookingId = found[0]?.booking_id;
  if (!bookingId) return null;
  // The booking's lock first, as everything that changes a balance takes it.
  await sql`select id from bookings where tenant_id = ${ctx.tenantId} and id = ${bookingId}
              for no key update`.execute(trx);
  const { rows } = await sql<{
    id: string;
    account_ref: string;
    provider_payment_id: string | null;
    amount: number;
    currency: string;
    state: string;
  }>`
    select id, account_ref, provider_payment_id, amount, currency, state from balance_payments
     where tenant_id = ${ctx.tenantId} and provider = ${event.provider} and ${by}
       for update`.execute(trx);
  const payment = rows[0];
  if (!payment) return null;
  const mismatch =
    event.paymentRef === null ||
    event.accountRef !== payment.account_ref ||
    (payment.provider_payment_id !== null && payment.provider_payment_id !== event.paymentRef) ||
    (kind === "succeeded" &&
      (event.amount !== payment.amount || event.currency !== payment.currency));
  if (mismatch) {
    await record(trx, ctx, {
      action: "booking.balance_payment_mismatch",
      subjectType: "booking",
      subjectId: bookingId,
      after: { paymentId: payment.id, providerEventId: event.id },
      topic: "booking.balance_payment_mismatch",
      payload: { bookingId, paymentId: payment.id },
    });
    return { outcome: "balance_payment_mismatch", bookingId };
  }
  if (payment.provider_payment_id === null && event.paymentRef !== null) {
    await sql`
      update balance_payments set provider_payment_id = ${event.paymentRef}
       where tenant_id = ${ctx.tenantId} and id = ${payment.id}
         and provider_payment_id is null`.execute(trx);
  }
  if (payment.state === "succeeded") return { outcome: "balance_already_settled", bookingId };
  if (kind === "failed") {
    if (payment.state !== "pending") return { outcome: "balance_already_settled", bookingId };
    await sql`
      update balance_payments set state = 'failed', failed_event_id = ${event.id}
       where tenant_id = ${ctx.tenantId} and id = ${payment.id} and state = 'pending'`.execute(trx);
    await record(trx, ctx, {
      action: "booking.balance_payment_failed",
      subjectType: "booking",
      subjectId: bookingId,
      after: { paymentId: payment.id, amount: payment.amount },
    });
    return { outcome: "balance_payment_failed", bookingId };
  }
  await sql`
    update balance_payments set state = 'succeeded', succeeded_event_id = ${event.id}
     where tenant_id = ${ctx.tenantId} and id = ${payment.id}
       and state in ('pending', 'failed', 'abandoned')`.execute(trx);
  const balance = await getBookingBalance(trx, ctx.tenantId, bookingId);
  await record(trx, ctx, {
    action: "booking.balance_paid",
    subjectType: "booking",
    subjectId: bookingId,
    before: { state: payment.state },
    after: {
      paymentId: payment.id,
      amount: payment.amount,
      owed: balance?.owed ?? 0,
      overpaid: balance?.overpaid ?? 0,
    },
    topic: "booking.balance_paid",
    payload: { bookingId, paymentId: payment.id },
  });
  return { outcome: "balance_paid", bookingId };
}
