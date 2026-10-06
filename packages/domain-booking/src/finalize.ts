/**
 * Payment outcome to booking (G2.7). A verified provider event is recorded in
 * the inbox and committed first; then one transaction locks the inbox row and
 * the checkout session and acts on it:
 *
 * - success on an open or expired checkout: confirm the hold (reacquiring it
 *   after expiry) and create the booking, or, when the capacity is gone, refund
 *   in full and raise a finalization exception;
 * - success after the checkout failed or was canceled: refund and raise;
 * - failure on an open checkout: release the hold and close it as failed;
 * - anything already decided: change nothing.
 *
 * Every outcome is idempotent per event and per payment, whatever order or
 * how many times the events arrive. The refund itself is a provider call, so
 * it runs after commit with the refund row's idempotency key; an unknown
 * outcome stays requested for the sweep.
 *
 * Lock order: inbox event, checkout session, then the trip and hold (inside
 * the inventory calls), then the payment and the rest.
 */
import {
  type CheckoutSessionState,
  type Database,
  type FinalizationReason,
  inTenantTransaction,
  type PaymentState,
  type TenantContext,
  type TenantTransaction,
} from "@tidegrid/database";
import { confirmHold, releaseHold } from "@tidegrid/domain-inventory";
import {
  type InboxEvent,
  lockInboxEvent,
  markInboxProcessed,
  type PaymentProvider,
  type PaymentProviderName,
  ProviderRejectedError,
  ProviderUnavailableError,
  recordProviderEvent,
  resolvePaymentAccount,
  type VerifiedProviderEvent,
} from "@tidegrid/domain-payments";
import { type Kysely, sql } from "kysely";
import { ownerRefFor } from "./checkout.ts";
import { newBookingReference } from "./secrets.ts";
import { record } from "./views.ts";

export type ProcessOutcome =
  /** A booking was created. */
  | "confirmed"
  /** A booking was created after the hold had expired, by taking the capacity again. */
  | "confirmed_reacquired"
  /** The success could not be honored; a full refund was requested and an exception raised. */
  | "refund_required"
  /** A failure closed an open checkout and released its hold. */
  | "released"
  /** A failure arrived after the checkout expired or was canceled; recorded on the payment. */
  | "failure_recorded"
  /** The payment had already succeeded; nothing changed. */
  | "already_succeeded"
  /** The payment had already failed; nothing changed. */
  | "already_failed"
  /** A failure arrived after the payment succeeded; nothing changed. */
  | "ignored_after_success"
  /** The event's amount, currency, account, or provider id does not match the payment. */
  | "payment_mismatch"
  /** No payment of this tenant matches the event. */
  | "unmatched_payment"
  /** An event type checkout does not act on. */
  | "ignored_event_type";

export interface ProcessResult {
  outcome: ProcessOutcome;
  checkoutSessionId: string | null;
  bookingId: string | null;
  /** Set when a refund was requested and must now be sent to the provider. */
  refundId: string | null;
}

interface PaymentRow {
  id: string;
  checkout_session_id: string;
  order_id: string;
  provider: PaymentProviderName;
  account_ref: string;
  provider_payment_id: string | null;
  amount: number;
  currency: string;
  state: PaymentState;
}

interface SessionRow {
  id: string;
  state: CheckoutSessionState;
  hold_id: string;
  trip_id: string;
  party_size: number;
}

const paymentColumns = sql`id, checkout_session_id, order_id, provider, account_ref,
  provider_payment_id, amount, currency, state`;

const result = (
  outcome: ProcessOutcome,
  fields: Partial<Omit<ProcessResult, "outcome">> = {},
): ProcessResult => ({
  outcome,
  checkoutSessionId: fields.checkoutSessionId ?? null,
  bookingId: fields.bookingId ?? null,
  refundId: fields.refundId ?? null,
});

/** The payment an event is about: by our own id when the provider echoed it, else by its id. */
async function findPayment(
  trx: TenantTransaction,
  tenantId: string,
  event: InboxEvent,
): Promise<PaymentRow | undefined> {
  if (event.clientReference) {
    const { rows } = await sql<PaymentRow>`
      select ${paymentColumns} from payments
       where tenant_id = ${tenantId} and provider = ${event.provider}
         and id = ${event.clientReference}`.execute(trx);
    return rows[0];
  }
  if (!event.paymentRef) return undefined;
  const { rows } = await sql<PaymentRow>`
    select ${paymentColumns} from payments
     where tenant_id = ${tenantId} and provider = ${event.provider}
       and provider_payment_id = ${event.paymentRef}`.execute(trx);
  return rows[0];
}

/**
 * Act on one recorded inbox event, once. Locks the inbox row first; an event
 * already processed returns its recorded outcome and changes nothing. With
 * `skipLocked`, an event another transaction is processing returns null.
 */
export async function processProviderEvent(
  trx: TenantTransaction,
  ctx: TenantContext,
  inboxId: string,
  options: { skipLocked?: boolean } = {},
): Promise<ProcessResult | null> {
  if (options.skipLocked) {
    const { rows } = await sql<{ id: string }>`
      select id from provider_events where tenant_id = ${ctx.tenantId} and id = ${inboxId}
         for update skip locked`.execute(trx);
    if (!rows[0]) return null;
  }
  const event = await lockInboxEvent(trx, ctx.tenantId, inboxId);
  if (!event) throw new Error("inbox event not found in this tenant");
  if (event.processingState === "processed") {
    return result((event.outcome ?? "ignored_event_type") as ProcessOutcome);
  }
  const outcome =
    event.eventType === "payment.succeeded"
      ? await onSuccess(trx, ctx, event)
      : event.eventType === "payment.failed"
        ? await onFailure(trx, ctx, event)
        : result("ignored_event_type");
  await markInboxProcessed(trx, ctx.tenantId, event.id, outcome.outcome);
  return outcome;
}

type Locked =
  | { kind: "locked"; session: SessionRow; payment: PaymentRow }
  | { kind: "unmatched" }
  /** The event names this payment but another provider payment or account. */
  | { kind: "mismatch"; payment: PaymentRow };

/** The session and the payment, locked in that order; the payment's provider id recorded if missing. */
async function lockCheckout(
  trx: TenantTransaction,
  ctx: TenantContext,
  event: InboxEvent,
): Promise<Locked> {
  const found = await findPayment(trx, ctx.tenantId, event);
  if (!found) return { kind: "unmatched" };
  const { rows: sessions } = await sql<SessionRow>`
    select id, state, hold_id, trip_id, party_size from checkout_sessions
     where tenant_id = ${ctx.tenantId} and id = ${found.checkout_session_id}
       for update`.execute(trx);
  const session = sessions[0];
  if (!session) throw new Error("a payment's checkout session was not found");
  const { rows: payments } = await sql<PaymentRow>`
    select ${paymentColumns} from payments
     where tenant_id = ${ctx.tenantId} and id = ${found.id}
       for update`.execute(trx);
  const payment = payments[0];
  if (!payment) throw new Error("payment vanished inside its own transaction");
  if (event.paymentRef === null || event.accountRef !== payment.account_ref) {
    return { kind: "mismatch", payment };
  }
  if (payment.provider_payment_id === null) {
    // The webhook arrived before checkout recorded the provider's id: the same
    // payment, reconciled here (the provider echoed our id).
    await trx
      .updateTable("payments")
      .set({ provider_payment_id: event.paymentRef })
      .where("tenant_id", "=", ctx.tenantId)
      .where("id", "=", payment.id)
      .where("provider_payment_id", "is", null)
      .execute();
    await record(trx, ctx, {
      action: "payment.provider_recorded",
      subjectType: "payment",
      subjectId: payment.id,
      before: { providerPaymentId: null },
      after: { providerPaymentId: event.paymentRef, fromEvent: event.id },
    });
    payment.provider_payment_id = event.paymentRef;
  } else if (payment.provider_payment_id !== event.paymentRef) {
    return { kind: "mismatch", payment };
  }
  return { kind: "locked", session, payment };
}

async function onSuccess(
  trx: TenantTransaction,
  ctx: TenantContext,
  event: InboxEvent,
): Promise<ProcessResult> {
  const locked = await lockCheckout(trx, ctx, event);
  if (locked.kind === "unmatched") return result("unmatched_payment");
  if (locked.kind === "mismatch") return mismatch(trx, ctx, event, locked.payment);
  const { session, payment } = locked;
  if (
    event.amount !== payment.amount ||
    event.currency !== payment.currency ||
    event.accountRef !== payment.account_ref
  ) {
    return mismatch(trx, ctx, event, payment);
  }
  const ids = { checkoutSessionId: session.id };
  if (payment.state === "succeeded") return result("already_succeeded", ids);
  // A success after the provider declared the payment failed: its hold is
  // gone, so it is refunded, never booked.
  if (payment.state === "failed")
    return unfulfilled(trx, ctx, event, session, payment, "session_failed");
  switch (session.state) {
    case "open":
    case "expired": {
      const confirmed = await confirmHold(trx, ctx, {
        holdId: session.hold_id,
        ownerRef: ownerRefFor(session.id),
      });
      if (confirmed.kind === "confirmed") {
        return book(trx, ctx, event, session, payment, confirmed.reacquired);
      }
      if (confirmed.kind === "capacity_lost") {
        return unfulfilled(trx, ctx, event, session, payment, confirmed.reason);
      }
      throw new Error(`an open checkout's hold could not be confirmed: ${confirmed.kind}`);
    }
    case "failed":
      return unfulfilled(trx, ctx, event, session, payment, "session_failed");
    case "canceled":
      return unfulfilled(trx, ctx, event, session, payment, "session_canceled");
    case "confirmed":
    case "unfulfilled":
      throw new Error(`checkout ${session.id} is ${session.state} with a pending payment`);
  }
}

/** A verified success whose amount, currency, account, or id is not the payment's. */
async function mismatch(
  trx: TenantTransaction,
  ctx: TenantContext,
  event: InboxEvent,
  payment: Pick<PaymentRow, "id" | "checkout_session_id">,
): Promise<ProcessResult> {
  const { rows } = await sql<{ id: string }>`
    insert into finalization_exceptions (tenant_id, checkout_session_id, payment_id,
      provider_event_id, reason)
    values (${ctx.tenantId}, ${payment.checkout_session_id}, ${payment.id}, ${event.id},
            'payment_mismatch')
    returning id`.execute(trx);
  const exceptionId = rows[0]?.id;
  if (!exceptionId) throw new Error("exception insert returned no row");
  await record(trx, ctx, {
    action: "finalization_exception.raised",
    subjectType: "finalization_exception",
    subjectId: exceptionId,
    after: {
      reason: "payment_mismatch",
      checkoutSessionId: payment.checkout_session_id,
      paymentId: payment.id,
      providerEventId: event.id,
    },
    topic: "checkout.finalization_exception.raised",
    payload: {
      exceptionId,
      checkoutSessionId: payment.checkout_session_id,
      paymentId: payment.id,
      reason: "payment_mismatch",
    },
  });
  return result("payment_mismatch", { checkoutSessionId: payment.checkout_session_id });
}

async function markSucceeded(
  trx: TenantTransaction,
  ctx: TenantContext,
  event: InboxEvent,
  payment: PaymentRow,
): Promise<void> {
  await trx
    .updateTable("payments")
    .set({ state: "succeeded", succeeded_event_id: event.id })
    .where("tenant_id", "=", ctx.tenantId)
    .where("id", "=", payment.id)
    .where("state", "=", payment.state)
    .execute();
  await record(trx, ctx, {
    action: "payment.succeeded",
    subjectType: "payment",
    subjectId: payment.id,
    before: { state: payment.state },
    after: { state: "succeeded", providerEventId: event.id },
    topic: "payment.succeeded",
    payload: { paymentId: payment.id, checkoutSessionId: payment.checkout_session_id },
  });
}

/** The hold is confirmed: record the payment, create the booking, close the checkout. */
async function book(
  trx: TenantTransaction,
  ctx: TenantContext,
  event: InboxEvent,
  session: SessionRow,
  payment: PaymentRow,
  reacquired: boolean,
): Promise<ProcessResult> {
  await markSucceeded(trx, ctx, event, payment);
  let booking: { id: string; reference: string } | undefined;
  for (let attempt = 0; attempt < 5 && !booking; attempt++) {
    const { rows } = await sql<{ id: string; reference: string }>`
      insert into bookings (tenant_id, reference, checkout_session_id, order_id, payment_id,
        hold_id, trip_id, party_size, reacquired)
      values (${ctx.tenantId}, ${newBookingReference()}, ${session.id}, ${payment.order_id},
              ${payment.id}, ${session.hold_id}, ${session.trip_id}, ${session.party_size},
              ${reacquired})
      on conflict (tenant_id, reference) do nothing
      returning id, reference`.execute(trx);
    booking = rows[0];
  }
  if (!booking) throw new Error("could not choose a free booking reference");
  await trx
    .updateTable("orders")
    .set({ status: "paid" })
    .where("tenant_id", "=", ctx.tenantId)
    .where("id", "=", payment.order_id)
    .where("status", "=", "pending")
    .execute();
  await trx
    .updateTable("checkout_sessions")
    .set({ state: "confirmed" })
    .where("tenant_id", "=", ctx.tenantId)
    .where("id", "=", session.id)
    .where("state", "=", session.state)
    .execute();
  await record(trx, ctx, {
    action: "booking.confirmed",
    subjectType: "booking",
    subjectId: booking.id,
    after: {
      state: "confirmed",
      reference: booking.reference,
      checkoutSessionId: session.id,
      tripId: session.trip_id,
      partySize: session.party_size,
      orderId: payment.order_id,
      paymentId: payment.id,
      reacquired,
    },
    topic: "booking.confirmed",
    payload: {
      bookingId: booking.id,
      checkoutSessionId: session.id,
      tripId: session.trip_id,
      orderId: payment.order_id,
      paymentId: payment.id,
      reacquired,
    },
  });
  await record(trx, ctx, {
    action: "checkout.session_confirmed",
    subjectType: "checkout_session",
    subjectId: session.id,
    before: { state: session.state },
    after: { state: "confirmed", bookingId: booking.id, orderStatus: "paid", reacquired },
  });
  return result(reacquired ? "confirmed_reacquired" : "confirmed", {
    checkoutSessionId: session.id,
    bookingId: booking.id,
  });
}

/**
 * A success that cannot become a booking. The payment is recorded as
 * succeeded, because the money moved; any capacity the hold still takes is
 * given back; a full refund is requested and a finalization exception raised;
 * the order is void and the checkout closes as unfulfilled.
 */
async function unfulfilled(
  trx: TenantTransaction,
  ctx: TenantContext,
  event: InboxEvent,
  session: SessionRow,
  payment: PaymentRow,
  reason: Exclude<FinalizationReason, "payment_mismatch">,
): Promise<ProcessResult> {
  const released = await releaseHold(trx, ctx, {
    holdId: session.hold_id,
    ownerRef: ownerRefFor(session.id),
    reason: "checkout payment could not be honored",
  });
  if (released.kind === "not_found") throw new Error("a checkout session's hold was not found");
  await markSucceeded(trx, ctx, event, payment);
  const refundId = crypto.randomUUID();
  await trx
    .insertInto("payment_refunds")
    .values({
      id: refundId,
      tenant_id: ctx.tenantId,
      payment_id: payment.id,
      amount: payment.amount,
      currency: "USD",
      reason: "unfulfilled_payment",
      idempotency_key: `checkout_refund:${refundId}`,
    })
    .execute();
  const { rows } = await sql<{ id: string }>`
    insert into finalization_exceptions (tenant_id, checkout_session_id, payment_id,
      provider_event_id, reason, refund_id)
    values (${ctx.tenantId}, ${session.id}, ${payment.id}, ${event.id}, ${reason}, ${refundId})
    returning id`.execute(trx);
  const exceptionId = rows[0]?.id;
  if (!exceptionId) throw new Error("exception insert returned no row");
  await trx
    .updateTable("orders")
    .set({ status: "void" })
    .where("tenant_id", "=", ctx.tenantId)
    .where("id", "=", payment.order_id)
    .where("status", "=", "pending")
    .execute();
  await trx
    .updateTable("checkout_sessions")
    .set({ state: "unfulfilled" })
    .where("tenant_id", "=", ctx.tenantId)
    .where("id", "=", session.id)
    .where("state", "=", session.state)
    .execute();
  await record(trx, ctx, {
    action: "payment_refund.requested",
    subjectType: "payment_refund",
    subjectId: refundId,
    after: { state: "requested", paymentId: payment.id, amount: payment.amount },
  });
  await record(trx, ctx, {
    action: "finalization_exception.raised",
    subjectType: "finalization_exception",
    subjectId: exceptionId,
    after: {
      reason,
      checkoutSessionId: session.id,
      paymentId: payment.id,
      providerEventId: event.id,
      refundId,
    },
    topic: "checkout.finalization_exception.raised",
    payload: { exceptionId, checkoutSessionId: session.id, paymentId: payment.id, reason },
  });
  await record(trx, ctx, {
    action: "checkout.session_unfulfilled",
    subjectType: "checkout_session",
    subjectId: session.id,
    reason,
    before: { state: session.state },
    after: { state: "unfulfilled", orderStatus: "void", refundId },
  });
  return result("refund_required", { checkoutSessionId: session.id, refundId });
}

async function onFailure(
  trx: TenantTransaction,
  ctx: TenantContext,
  event: InboxEvent,
): Promise<ProcessResult> {
  const locked = await lockCheckout(trx, ctx, event);
  if (locked.kind === "unmatched") return result("unmatched_payment");
  // Nothing moved on a failure, so a mismatched one is recorded and left alone.
  if (locked.kind === "mismatch") return result("payment_mismatch");
  const { session, payment } = locked;
  const ids = { checkoutSessionId: session.id };
  if (payment.state === "succeeded") return result("ignored_after_success", ids);
  if (payment.state === "failed") return result("already_failed", ids);

  await trx
    .updateTable("payments")
    .set({ state: "failed", failed_event_id: event.id })
    .where("tenant_id", "=", ctx.tenantId)
    .where("id", "=", payment.id)
    .where("state", "=", "pending")
    .execute();
  await record(trx, ctx, {
    action: "payment.failed",
    subjectType: "payment",
    subjectId: payment.id,
    before: { state: "pending" },
    after: { state: "failed", providerEventId: event.id },
    topic: "payment.failed",
    payload: { paymentId: payment.id, checkoutSessionId: session.id },
  });
  // The payment can no longer succeed, so its order never becomes a sale.
  await trx
    .updateTable("orders")
    .set({ status: "void" })
    .where("tenant_id", "=", ctx.tenantId)
    .where("id", "=", payment.order_id)
    .where("status", "=", "pending")
    .execute();
  if (session.state !== "open") return result("failure_recorded", ids);

  const released = await releaseHold(trx, ctx, {
    holdId: session.hold_id,
    ownerRef: ownerRefFor(session.id),
    reason: "checkout payment failed",
  });
  if (released.kind === "not_found") throw new Error("a checkout session's hold was not found");
  await trx
    .updateTable("checkout_sessions")
    .set({ state: "failed" })
    .where("tenant_id", "=", ctx.tenantId)
    .where("id", "=", session.id)
    .where("state", "=", "open")
    .execute();
  await record(trx, ctx, {
    action: "checkout.session_failed",
    subjectType: "checkout_session",
    subjectId: session.id,
    before: { state: "open" },
    after: { state: "failed", orderStatus: "void" },
    topic: "checkout.session.failed",
    payload: { checkoutSessionId: session.id },
  });
  return result("released", ids);
}

// Refunds -------------------------------------------------------------------------------

export type SettleRefundResult =
  | { kind: "succeeded"; providerRefundId: string }
  | { kind: "failed"; failureCode: string }
  /** The provider did not answer; the refund stays requested for the next attempt. */
  | { kind: "unknown" }
  /** Not requested any more, or not this provider's. */
  | { kind: "not_pending" };

interface RefundRow {
  id: string;
  payment_id: string;
  amount: number;
  idempotency_key: string;
  state: string;
  provider: PaymentProviderName;
  account_ref: string;
  provider_payment_id: string | null;
}

/**
 * Send a requested refund to the provider and record the answer. Outside any
 * transaction; idempotent by the refund's key, so it is safe to repeat after a
 * crash or a timeout until the outcome is known.
 */
export async function settleRefund(
  db: Kysely<Database>,
  provider: PaymentProvider,
  ctx: TenantContext,
  refundId: string,
): Promise<SettleRefundResult> {
  const refund = await inTenantTransaction(db, ctx, async (trx) => {
    const { rows } = await sql<RefundRow>`
      select r.id, r.payment_id, r.amount, r.idempotency_key, r.state, p.provider, p.account_ref,
             p.provider_payment_id
        from payment_refunds r
        join payments p on p.tenant_id = r.tenant_id and p.id = r.payment_id
       where r.tenant_id = ${ctx.tenantId} and r.id = ${refundId}`.execute(trx);
    return rows[0];
  });
  if (refund?.state !== "requested" || refund.provider !== provider.name) {
    return { kind: "not_pending" };
  }
  if (refund.provider_payment_id === null) throw new Error("a refunded payment has no provider id");
  let outcome: { state: "succeeded"; ref: string } | { state: "failed"; code: string };
  try {
    const answered = await provider.refundPayment({
      accountRef: refund.account_ref,
      paymentRef: refund.provider_payment_id,
      amount: refund.amount,
      currency: "USD",
      idempotencyKey: refund.idempotency_key,
    });
    outcome =
      answered.status === "succeeded"
        ? { state: "succeeded", ref: answered.refundRef }
        : { state: "failed", code: answered.failureCode ?? "refund_failed" };
  } catch (err) {
    if (err instanceof ProviderRejectedError) outcome = { state: "failed", code: err.code };
    else if (err instanceof ProviderUnavailableError) return { kind: "unknown" };
    else throw err;
  }
  return inTenantTransaction(db, ctx, async (trx) => {
    const updated = await trx
      .updateTable("payment_refunds")
      .set(
        outcome.state === "succeeded"
          ? { state: "succeeded", provider_refund_id: outcome.ref }
          : { state: "failed", failure_code: outcome.code },
      )
      .where("tenant_id", "=", ctx.tenantId)
      .where("id", "=", refund.id)
      .where("state", "=", "requested")
      .executeTakeFirst();
    if (updated.numUpdatedRows !== 1n) return { kind: "not_pending" as const };
    await record(trx, ctx, {
      action: outcome.state === "succeeded" ? "payment_refund.succeeded" : "payment_refund.failed",
      subjectType: "payment_refund",
      subjectId: refund.id,
      before: { state: "requested" },
      after:
        outcome.state === "succeeded"
          ? { state: "succeeded", providerRefundId: outcome.ref }
          : { state: "failed", failureCode: outcome.code },
      topic: outcome.state === "succeeded" ? "payment.refund.succeeded" : "payment.refund.failed",
      payload: { refundId: refund.id, paymentId: refund.payment_id },
    });
    return outcome.state === "succeeded"
      ? { kind: "succeeded" as const, providerRefundId: outcome.ref }
      : { kind: "failed" as const, failureCode: outcome.code };
  });
}

// The webhook path ---------------------------------------------------------------------

export type HandledEvent =
  | {
      kind: "processed";
      tenantId: string;
      duplicate: boolean;
      outcome: string;
      refund: SettleRefundResult | null;
    }
  /** No tenant owns the account the event names. Nothing was recorded. */
  | { kind: "unknown_account" }
  /** The event id is known with a different body. Nothing was processed. */
  | { kind: "payload_mismatch"; tenantId: string };

/**
 * Everything after the signature check, for the webhook route and for tests:
 * find the tenant by the event's account, record the event in that tenant's
 * inbox and commit, process it in a second transaction, then send any refund
 * it requested. A duplicate delivery of an event already processed does
 * nothing. A failure while processing propagates, leaving the event received
 * for the provider's retry and the sweep.
 */
export async function handleVerifiedEvent(
  db: Kysely<Database>,
  provider: PaymentProvider,
  event: VerifiedProviderEvent,
  meta: { requestId: string | null; sourceIp?: string | null },
): Promise<HandledEvent> {
  const account = await resolvePaymentAccount(db, event.provider, event.accountRef);
  if (!account) return { kind: "unknown_account" };
  const ctx: TenantContext = {
    tenantId: account.tenantId,
    actorType: "system",
    actorId: `${event.provider}-webhook`,
    requestId: meta.requestId,
    sourceIp: meta.sourceIp ?? null,
  };
  const recorded = await inTenantTransaction(db, ctx, (trx) =>
    recordProviderEvent(trx, ctx, event),
  );
  if (recorded.duplicate && !recorded.samePayload) {
    return { kind: "payload_mismatch", tenantId: account.tenantId };
  }
  if (recorded.processingState === "processed") {
    return {
      kind: "processed",
      tenantId: account.tenantId,
      duplicate: true,
      outcome: recorded.outcome ?? "processed",
      refund: null,
    };
  }
  const processed = await inTenantTransaction(db, ctx, (trx) =>
    processProviderEvent(trx, ctx, recorded.inboxId),
  );
  if (!processed) throw new Error("an inbox event was skipped without skipLocked");
  let refund: SettleRefundResult | null = null;
  if (processed.refundId) {
    // The decision is committed; the refund call is best effort here, and an
    // unknown outcome stays requested for the sweep.
    try {
      refund = await settleRefund(db, provider, ctx, processed.refundId);
    } catch {
      refund = { kind: "unknown" };
    }
  }
  return {
    kind: "processed",
    tenantId: account.tenantId,
    duplicate: recorded.duplicate,
    outcome: processed.outcome,
    refund,
  };
}
