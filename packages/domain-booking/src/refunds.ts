/**
 * Refunds after they are requested (G2.7, G2.11c; pending, refund events,
 * exceptions, and fee reversal in W3-G2.9).
 *
 * A refund row is the intent, committed before the provider is called with
 * its idempotency key. Its state then moves only on the provider's answer
 * about that refund: a call's answer (`settleRefund`), or a verified refund
 * event in the inbox (`onRefundEvent`). requested may move to pending,
 * succeeded, or failed; pending to succeeded or failed (migration 0027).
 *
 * - succeeded: a cancellation refund reverses TideGrid's fee on the refunded
 *   eligible value, in proportion, in the same transaction (fee-ledger.ts).
 * - failed: a cancellation refund's guest is told once that the money is not
 *   on its way, as before.
 * - still unsettled 24 hours after it was requested (D1, a coordinator
 *   default pending owner confirmation), or a provider lookup still refused
 *   then: one refund exception, for staff (refund_exceptions).
 * - a refund event that says failed after the refund succeeded: one refund
 *   exception. The refund row stays succeeded; a person decides.
 *
 * Nothing here logs or stores the provider's refund object: only its id, its
 * status, TideGrid's own key, and a failure code.
 */
import {
  type Database,
  inTenantTransaction,
  type RefundExceptionReason,
  type RefundState,
  type TenantContext,
  type TenantTransaction,
} from "@tidegrid/database";
import {
  type InboxEvent,
  type PaymentProvider,
  type PaymentProviderName,
  ProviderRejectedError,
  ProviderUnavailableError,
} from "@tidegrid/domain-payments";
import { type Kysely, sql } from "kysely";
import { enqueueRefundFailedEmail } from "./emails.ts";
import { reverseFeeForRefund } from "./fee-ledger.ts";
import { record } from "./views.ts";

/** D1: a refund unsettled this long becomes an exception. The database checks the same bound. */
export const REFUND_EXCEPTION_AFTER_HOURS = 24;

export type SettleRefundResult =
  | { kind: "succeeded"; providerRefundId: string }
  | { kind: "failed"; failureCode: string }
  /** The provider accepted it and has not finished; its event or a later check settles it. */
  | { kind: "pending"; providerRefundId: string }
  /** The provider did not answer; the refund stays as it was for the next attempt. */
  | { kind: "unknown" }
  /** Settled already, or not this provider's. */
  | { kind: "not_pending" };

interface RefundRow {
  id: string;
  payment_id: string;
  reason: string;
  amount: number;
  idempotency_key: string;
  state: RefundState;
  provider_refund_id: string | null;
  provider: PaymentProviderName;
  account_ref: string;
  provider_payment_id: string | null;
}

const refundColumns = sql`r.id, r.payment_id, r.reason, r.amount, r.idempotency_key, r.state,
  r.provider_refund_id, p.provider, p.account_ref, p.provider_payment_id`;

type Outcome =
  | { state: "succeeded"; ref: string }
  | { state: "failed"; code: string; ref: string | null }
  | { state: "pending"; ref: string };

/**
 * Send an unsettled refund to the provider and record the answer. Outside any
 * transaction; idempotent by the refund's key, so it is safe to repeat after
 * a crash or a timeout until the outcome is known. A pending refund is asked
 * again too: the provider's lookup by key reads its current status.
 */
export async function settleRefund(
  db: Kysely<Database>,
  provider: PaymentProvider,
  ctx: TenantContext,
  refundId: string,
): Promise<SettleRefundResult> {
  const refund = await inTenantTransaction(db, ctx, async (trx) => {
    const { rows } = await sql<RefundRow>`
      select ${refundColumns}
        from payment_refunds r
        join payments p on p.tenant_id = r.tenant_id and p.id = r.payment_id
       where r.tenant_id = ${ctx.tenantId} and r.id = ${refundId}`.execute(trx);
    return rows[0];
  });
  if (
    !refund ||
    (refund.state !== "requested" && refund.state !== "pending") ||
    refund.provider !== provider.name
  ) {
    return { kind: "not_pending" };
  }
  if (refund.provider_payment_id === null) throw new Error("a refunded payment has no provider id");
  let outcome: Outcome;
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
        : answered.status === "pending"
          ? { state: "pending", ref: answered.refundRef }
          : {
              state: "failed",
              code: answered.failureCode ?? "refund_failed",
              ref: answered.refundRef,
            };
  } catch (err) {
    if (err instanceof ProviderRejectedError && refund.provider_refund_id === null) {
      outcome = { state: "failed", code: err.code, ref: null };
    } else if (err instanceof ProviderUnavailableError || err instanceof ProviderRejectedError) {
      // A rejection about a refund the provider already accepted (pending,
      // with its id) is no answer about that refund: it stays as it is and
      // reaches staff past the threshold, never settled failed blind. So does
      // no answer: stamp the check, and past the threshold raise it for staff.
      await inTenantTransaction(db, ctx, async (trx) => {
        const locked = await lockRefund(trx, ctx.tenantId, refund.id);
        if (!locked || (locked.state !== "requested" && locked.state !== "pending")) return;
        await stampChecked(trx, ctx.tenantId, locked.id);
        const code = safeCode(err instanceof ProviderRejectedError ? err.code : err.message);
        await raiseRefundException(
          trx,
          ctx,
          locked.id,
          code === "stripe_refund_lookup_refused" ? "lookup_refused" : "unsettled",
          code,
        );
      });
      return { kind: "unknown" };
    } else {
      throw err;
    }
  }
  return inTenantTransaction(db, ctx, async (trx) => {
    const locked = await lockRefund(trx, ctx.tenantId, refund.id);
    if (!locked || (locked.state !== "requested" && locked.state !== "pending")) {
      // Settled meanwhile (an event). An answer about the same refund that
      // says the opposite is raised for staff; the settled state stands.
      const sameRefund =
        locked !== undefined && outcome.ref !== null && locked.provider_refund_id === outcome.ref;
      if (sameRefund && locked.state === "succeeded" && outcome.state === "failed") {
        await raiseRefundException(trx, ctx, locked.id, "failed_after_success", outcome.code);
      } else if (sameRefund && locked.state === "failed" && outcome.state === "succeeded") {
        await raiseRefundException(trx, ctx, locked.id, "succeeded_after_failure", null);
      }
      return { kind: "not_pending" as const };
    }
    if (outcome.state === "failed" && outcome.ref === null && locked.provider_refund_id !== null) {
      // A rejection, but the provider accepted this refund meanwhile (an
      // event or another call recorded it pending): no answer about it.
      await stampChecked(trx, ctx.tenantId, locked.id);
      await raiseRefundException(trx, ctx, locked.id, "unsettled", safeCode(outcome.code));
      return { kind: "unknown" as const };
    }
    if (outcome.state === "pending") {
      if (locked.state === "requested") {
        await markPending(trx, ctx, locked, outcome.ref);
      } else {
        await stampChecked(trx, ctx.tenantId, locked.id);
      }
      await raiseRefundException(trx, ctx, locked.id, "unsettled", null);
      return { kind: "pending" as const, providerRefundId: outcome.ref };
    }
    await settleLocked(trx, ctx, locked, outcome);
    return outcome.state === "succeeded"
      ? { kind: "succeeded" as const, providerRefundId: outcome.ref }
      : { kind: "failed" as const, failureCode: outcome.code };
  });
}

function safeCode(value: string): string | null {
  return /^[a-z][a-z0-9_]{0,63}$/.test(value) ? value : null;
}

async function lockRefund(
  trx: TenantTransaction,
  tenantId: string,
  refundId: string,
): Promise<RefundRow | undefined> {
  const { rows } = await sql<RefundRow>`
    select ${refundColumns}
      from payment_refunds r
      join payments p on p.tenant_id = r.tenant_id and p.id = r.payment_id
     where r.tenant_id = ${tenantId} and r.id = ${refundId}
       for update of r`.execute(trx);
  return rows[0];
}

async function stampChecked(trx: TenantTransaction, tenantId: string, refundId: string) {
  // The value is the database clock's; the trigger stamps it.
  await sql`update payment_refunds set checked_at = now()
             where tenant_id = ${tenantId} and id = ${refundId}`.execute(trx);
}

async function markPending(
  trx: TenantTransaction,
  ctx: TenantContext,
  refund: RefundRow,
  providerRefundId: string,
): Promise<void> {
  await trx
    .updateTable("payment_refunds")
    .set({ state: "pending", provider_refund_id: providerRefundId })
    .where("tenant_id", "=", ctx.tenantId)
    .where("id", "=", refund.id)
    .where("state", "=", "requested")
    .execute();
  await record(trx, ctx, {
    action: "payment_refund.pending",
    subjectType: "payment_refund",
    subjectId: refund.id,
    before: { state: "requested" },
    after: { state: "pending", providerRefundId },
    topic: "payment.refund.pending",
    payload: { refundId: refund.id, paymentId: refund.payment_id },
  });
}

/**
 * Record a final answer on a locked, unsettled refund: the state, the audit
 * row and event, then the fee reversal (succeeded) or the guest's notice
 * (failed) for a cancellation refund.
 */
async function settleLocked(
  trx: TenantTransaction,
  ctx: TenantContext,
  refund: RefundRow,
  outcome: Exclude<Outcome, { state: "pending" }>,
): Promise<void> {
  const ref = outcome.ref ?? refund.provider_refund_id;
  await trx
    .updateTable("payment_refunds")
    .set(
      outcome.state === "succeeded"
        ? { state: "succeeded", provider_refund_id: outcome.ref }
        : {
            state: "failed",
            failure_code: outcome.code,
            ...(ref !== null ? { provider_refund_id: ref } : {}),
          },
    )
    .where("tenant_id", "=", ctx.tenantId)
    .where("id", "=", refund.id)
    .where("state", "in", ["requested", "pending"])
    .execute();
  await record(trx, ctx, {
    action: outcome.state === "succeeded" ? "payment_refund.succeeded" : "payment_refund.failed",
    subjectType: "payment_refund",
    subjectId: refund.id,
    before: { state: refund.state },
    after:
      outcome.state === "succeeded"
        ? { state: "succeeded", providerRefundId: outcome.ref }
        : { state: "failed", failureCode: outcome.code },
    topic: outcome.state === "succeeded" ? "payment.refund.succeeded" : "payment.refund.failed",
    payload: { refundId: refund.id, paymentId: refund.payment_id },
  });
  if (refund.reason !== "booking_canceled") return;
  if (outcome.state === "succeeded") {
    await reverseFeeForRefund(trx, ctx, refund.id);
  } else {
    await followUpRefusedRefund(trx, ctx, refund);
  }
}

/**
 * Raise one refund exception for staff, once per refund and reason. For
 * unsettled and lookup_refused, only once the refund has waited past the
 * threshold; the statement checks it on the database clock, so a younger
 * refund raises nothing. Returns whether one was raised now.
 */
export async function raiseRefundException(
  trx: TenantTransaction,
  ctx: TenantContext,
  refundId: string,
  reason: RefundExceptionReason,
  errorCode: string | null,
): Promise<boolean> {
  const due =
    reason === "failed_after_success"
      ? sql`state = 'succeeded'`
      : reason === "succeeded_after_failure"
        ? sql`state = 'failed'`
        : sql`state in ('requested', 'pending')
            and created_at <= now() - make_interval(hours => ${REFUND_EXCEPTION_AFTER_HOURS})`;
  const { rows } = await sql<{ id: string; refund_state: RefundState }>`
    insert into refund_exceptions (tenant_id, refund_id, reason, refund_state, error_code)
    select tenant_id, id, ${reason}, state, ${errorCode}
      from payment_refunds
     where tenant_id = ${ctx.tenantId} and id = ${refundId} and ${due}
    on conflict (tenant_id, refund_id, reason) do nothing
    returning id, refund_state`.execute(trx);
  const raised = rows[0];
  if (!raised) return false;
  await record(trx, ctx, {
    action: "payment_refund.exception_raised",
    subjectType: "payment_refund",
    subjectId: refundId,
    after: { reason, refundState: raised.refund_state, errorCode },
    topic: "payment.refund.exception_raised",
    payload: { refundId, exceptionId: raised.id, reason },
  });
  return true;
}

/**
 * A canceled booking's refund was refused: the cancellation email said it was
 * on its way, so the guest is told it is not, once. Written under a
 * savepoint, so an email problem never undoes the recorded refusal; a
 * failure is audited for staff instead.
 */
async function followUpRefusedRefund(
  trx: TenantTransaction,
  ctx: TenantContext,
  refund: Pick<RefundRow, "payment_id" | "amount">,
): Promise<void> {
  const { rows } = await sql<{ id: string }>`
    select id from bookings where tenant_id = ${ctx.tenantId} and payment_id = ${refund.payment_id}`.execute(
    trx,
  );
  const bookingId = rows[0]?.id;
  if (!bookingId) return;
  await sql`savepoint refund_failed_email`.execute(trx);
  try {
    await enqueueRefundFailedEmail(trx, ctx, bookingId, refund.amount);
    await sql`release savepoint refund_failed_email`.execute(trx);
  } catch (error) {
    await sql`rollback to savepoint refund_failed_email`.execute(trx);
    await record(trx, ctx, {
      action: "booking.refund_failed_email_failed",
      subjectType: "booking",
      subjectId: bookingId,
      after: { error: error instanceof Error ? error.name : "unknown" },
    });
  }
}

// Refund events ----------------------------------------------------------------------

export type RefundEventOutcome =
  /** The event settled the refund as succeeded. */
  | "refund_succeeded"
  /** The event settled the refund as failed. */
  | "refund_failed"
  /** The refund is pending at the provider; recorded, or already known. */
  | "refund_pending"
  /** The refund had already settled; nothing changed. */
  | "refund_already_settled"
  /** A failure after the refund succeeded: an exception for staff; the refund stays succeeded. */
  | "refund_failed_after_success"
  /** A success after TideGrid recorded the refund failed: an exception for staff; it stays failed. */
  | "refund_succeeded_after_failure"
  /** The event's payment, amount, account, or refund id does not match the refund. */
  | "refund_mismatch"
  /** No refund of this tenant carries the event's key. */
  | "unmatched_refund";

/**
 * Act on a locked, unprocessed refund.updated inbox event. The event names
 * the refund by the idempotency key TideGrid gave it; everything else it
 * says must match the refund before anything moves.
 */
export async function onRefundEvent(
  trx: TenantTransaction,
  ctx: TenantContext,
  event: InboxEvent,
): Promise<RefundEventOutcome> {
  const reported = event.refund;
  if (!reported) return "refund_mismatch";
  const { rows: found } = await sql<{ id: string }>`
    select id from payment_refunds
     where tenant_id = ${ctx.tenantId} and idempotency_key = ${reported.key}`.execute(trx);
  const refundId = found[0]?.id;
  if (!refundId) return "unmatched_refund";
  const refund = await lockRefund(trx, ctx.tenantId, refundId);
  if (!refund) throw new Error("a refund vanished inside its own transaction");
  if (
    refund.provider !== event.provider ||
    refund.account_ref !== event.accountRef ||
    refund.provider_payment_id === null ||
    refund.provider_payment_id !== event.paymentRef ||
    refund.amount !== event.amount ||
    event.currency !== "USD" ||
    (refund.provider_refund_id !== null && refund.provider_refund_id !== reported.ref)
  ) {
    return "refund_mismatch";
  }
  const unsettled = refund.state === "requested" || refund.state === "pending";
  switch (reported.status) {
    case "pending":
      if (refund.state === "requested") await markPending(trx, ctx, refund, reported.ref);
      return unsettled ? "refund_pending" : "refund_already_settled";
    case "succeeded":
      if (refund.state === "failed") {
        // The money moved after all: staff must know the guest was told otherwise.
        await raiseRefundException(trx, ctx, refund.id, "succeeded_after_failure", null);
        return "refund_succeeded_after_failure";
      }
      if (!unsettled) return "refund_already_settled";
      await settleLocked(trx, ctx, refund, { state: "succeeded", ref: reported.ref });
      return "refund_succeeded";
    case "failed":
      if (refund.state === "succeeded") {
        await raiseRefundException(
          trx,
          ctx,
          refund.id,
          "failed_after_success",
          reported.failureCode,
        );
        return "refund_failed_after_success";
      }
      if (!unsettled) return "refund_already_settled";
      await settleLocked(trx, ctx, refund, {
        state: "failed",
        code: reported.failureCode ?? "refund_failed",
        ref: reported.ref,
      });
      return "refund_failed";
  }
}

// The exceptions list ---------------------------------------------------------------

export interface RefundExceptionView {
  id: string;
  reason: RefundExceptionReason;
  errorCode: string | null;
  raisedAt: string;
  open: boolean;
  refund: { id: string; state: RefundState; amount: number; requestedAt: string };
  booking: { id: string; reference: string } | null;
  nextStep: string;
}

function nextStepFor(reason: RefundExceptionReason, state: RefundState): string {
  if (reason === "failed_after_success") {
    return "The payment provider reported this refund failed after it had succeeded. Check it in the provider's dashboard, then pay the guest another way if the money did not arrive.";
  }
  if (reason === "succeeded_after_failure") {
    return "The payment provider reported this refund succeeded after TideGrid recorded it failed, so the guest may have been told it failed. Check it in the provider's dashboard and tell the guest; do not refund them again another way.";
  }
  if (state === "succeeded") return "Settled since it was raised; nothing to do.";
  if (state === "failed") {
    return "The refund failed. Refund the guest another way, or contact the provider.";
  }
  return reason === "lookup_refused"
    ? "The payment provider keeps refusing to say what happened to this refund. Check it in the provider's dashboard; TideGrid keeps asking."
    : "No final answer from the payment provider after 24 hours. Check it in the provider's dashboard; TideGrid keeps asking.";
}

/** Every refund exception of this tenant, newest first, at most `limit`. */
export async function listRefundExceptions(
  trx: TenantTransaction,
  tenantId: string,
  limit = 100,
): Promise<RefundExceptionView[]> {
  const { rows } = await sql<{
    id: string;
    reason: RefundExceptionReason;
    error_code: string | null;
    created_at: Date | string;
    refund_id: string;
    state: RefundState;
    amount: number;
    requested_at: Date | string;
    booking_id: string | null;
    reference: string | null;
  }>`
    select x.id, x.reason, x.error_code, x.created_at, r.id as refund_id, r.state, r.amount,
           r.created_at as requested_at, b.id as booking_id, b.reference
      from refund_exceptions x
      join payment_refunds r on r.tenant_id = x.tenant_id and r.id = x.refund_id
      left join bookings b on b.tenant_id = r.tenant_id and b.payment_id = r.payment_id
     where x.tenant_id = ${tenantId}
     order by x.created_at desc, x.id
     limit ${Math.max(1, Math.min(limit, 500))}`.execute(trx);
  return rows.map((row) => ({
    id: row.id,
    reason: row.reason,
    errorCode: row.error_code,
    raisedAt: new Date(row.created_at).toISOString(),
    open:
      row.reason === "failed_after_success" ||
      row.reason === "succeeded_after_failure" ||
      row.state === "requested" ||
      row.state === "pending" ||
      row.state === "failed",
    refund: {
      id: row.refund_id,
      state: row.state,
      amount: row.amount,
      requestedAt: new Date(row.requested_at).toISOString(),
    },
    booking:
      row.booking_id !== null && row.reference !== null
        ? { id: row.booking_id, reference: row.reference }
        : null,
    nextStep: nextStepFor(row.reason, row.state),
  }));
}
