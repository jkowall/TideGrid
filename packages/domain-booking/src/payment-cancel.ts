/**
 * Canceling an unpaid payment at the provider (W3-G2.9). When a checkout
 * expires or its guest or staff cancel it, its payment may still be open at
 * the provider, where a guest could pay it after all; that payment would then
 * be refunded in full as a late success. Canceling it first means the guest
 * is never charged and refunded. A payment that succeeds before the cancel
 * reaches the provider still takes the late-success path (finalize.ts), so
 * money is never lost either way.
 *
 * Same shape as a refund: the payment_cancellations row is the intent,
 * written in the transaction that closes the checkout, for a payment still
 * pending that has a provider id; the provider is called after commit with
 * the row's own key, and the checkout sweep resends one whose outcome is
 * unknown. The provider's own event about the canceled payment then arrives
 * through the inbox and records the payment as failed (D3: Stripe's
 * payment_intent.canceled maps to payment.failed, with no new state).
 */
import {
  type Database,
  inTenantTransaction,
  type PaymentCancellationState,
  type TenantContext,
  type TenantTransaction,
} from "@tidegrid/database";
import {
  type PaymentProvider,
  type PaymentProviderName,
  ProviderRejectedError,
  ProviderUnavailableError,
} from "@tidegrid/domain-payments";
import { type Kysely, sql } from "kysely";
import { record } from "./views.ts";

/**
 * Record the intent to cancel this checkout's payment, in the transaction
 * that expires or cancels the checkout (after its state changed). Returns the
 * intent's id, or null when there is nothing to cancel: no provider id yet,
 * or the payment already settled.
 */
export async function requestPaymentCancellation(
  trx: TenantTransaction,
  ctx: TenantContext,
  checkoutSessionId: string,
): Promise<string | null> {
  const id = crypto.randomUUID();
  const { rows } = await sql<{ id: string; payment_id: string }>`
    insert into payment_cancellations (id, tenant_id, payment_id, checkout_session_id,
      idempotency_key)
    select ${id}, p.tenant_id, p.id, p.checkout_session_id, ${`payment_cancel:${id}`}
      from payments p
     where p.tenant_id = ${ctx.tenantId} and p.checkout_session_id = ${checkoutSessionId}
       and p.state = 'pending' and p.provider_payment_id is not null
    on conflict (tenant_id, payment_id) do nothing
    returning id, payment_id`.execute(trx);
  const inserted = rows[0];
  if (!inserted) return null;
  await record(trx, ctx, {
    action: "payment.cancel_requested",
    subjectType: "payment",
    subjectId: inserted.payment_id,
    after: { cancellationId: inserted.id, checkoutSessionId },
  });
  return inserted.id;
}

export type SettleCancellationResult =
  | { kind: "canceled" }
  /** The payment was paid first; the late-success refund takes over. */
  | { kind: "too_late" }
  /** The provider will never cancel it. */
  | { kind: "refused"; code: string }
  /** No answer; it stays requested for the sweep. */
  | { kind: "unknown" }
  /** Settled already, or not this provider's. */
  | { kind: "not_pending" };

interface CancellationRow {
  id: string;
  payment_id: string;
  idempotency_key: string;
  state: PaymentCancellationState;
  provider: PaymentProviderName;
  account_ref: string;
  provider_payment_id: string | null;
  payment_state: string;
}

/**
 * Send a requested payment cancellation to the provider and record the
 * answer. Outside any transaction; idempotent by the row's key.
 */
export async function settlePaymentCancellation(
  db: Kysely<Database>,
  provider: PaymentProvider,
  ctx: TenantContext,
  cancellationId: string,
): Promise<SettleCancellationResult> {
  const row = await inTenantTransaction(db, ctx, async (trx) => {
    const { rows } = await sql<CancellationRow>`
      select c.id, c.payment_id, c.idempotency_key, c.state, p.provider, p.account_ref,
             p.provider_payment_id, p.state as payment_state
        from payment_cancellations c
        join payments p on p.tenant_id = c.tenant_id and p.id = c.payment_id
       where c.tenant_id = ${ctx.tenantId} and c.id = ${cancellationId}`.execute(trx);
    return rows[0];
  });
  if (row?.state !== "requested" || row.provider !== provider.name) {
    return { kind: "not_pending" };
  }
  if (row.provider_payment_id === null) throw new Error("a canceled payment has no provider id");
  let outcome: { state: Exclude<PaymentCancellationState, "requested">; code: string | null };
  if (row.payment_state === "succeeded") {
    // The success is already recorded: nothing to ask the provider.
    outcome = { state: "too_late", code: null };
  } else {
    try {
      const answered = await provider.cancelPayment({
        accountRef: row.account_ref,
        paymentRef: row.provider_payment_id,
        idempotencyKey: row.idempotency_key,
      });
      outcome =
        answered.status === "canceled"
          ? { state: "canceled", code: null }
          : { state: "too_late", code: null };
    } catch (err) {
      if (err instanceof ProviderRejectedError) {
        outcome = { state: "refused", code: err.code };
      } else if (err instanceof ProviderUnavailableError) {
        return { kind: "unknown" };
      } else {
        throw err;
      }
    }
  }
  return inTenantTransaction(db, ctx, async (trx) => {
    const updated = await trx
      .updateTable("payment_cancellations")
      .set({ state: outcome.state, outcome_code: outcome.code })
      .where("tenant_id", "=", ctx.tenantId)
      .where("id", "=", row.id)
      .where("state", "=", "requested")
      .executeTakeFirst();
    if (updated.numUpdatedRows !== 1n) return { kind: "not_pending" as const };
    await record(trx, ctx, {
      action: `payment.cancel_${outcome.state}`,
      subjectType: "payment",
      subjectId: row.payment_id,
      before: { cancellation: "requested" },
      after: { cancellation: outcome.state, code: outcome.code },
    });
    return outcome.state === "refused"
      ? { kind: "refused" as const, code: outcome.code ?? "refused" }
      : { kind: outcome.state };
  });
}
