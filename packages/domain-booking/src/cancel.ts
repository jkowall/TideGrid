/**
 * A guest's cancellation within policy (lane 1, G2.11c). The remedy comes from
 * the booking's own policy version, its order's, on the database clock: the
 * cutoff is departure minus the policy's change cutoff; before it the policy's
 * before-cutoff remedy applies, at or after it the after-cutoff remedy. A
 * refund is the remedy's basis points of what was paid, rounded half up to the
 * cent. A remedy of credit is not self-service (credits are G2.9).
 *
 * One transaction cancels: the cancellation row with the terms as applied,
 * the booking canceled, the refund row for the computed amount, the booking's
 * confirmed hold released so the seats return to sale, audit and events, the
 * cancellation email, and the bookingCanceled hook. The database checks every
 * term again (migration 0008). After commit the caller sends the refund
 * through the payment adapter with `settleRefund`; the checkout sweep resends
 * one whose outcome is unknown.
 *
 * Lock order: checkout session, booking, payment, then the trip and the hold
 * inside the inventory call. The confirmation path takes the session, the
 * payment, the trip, and the hold in that order, so the two never deadlock: a
 * late or repeated payment event for a canceled booking finds its payment
 * already succeeded and changes nothing.
 */
import {
  type CancellationRemedy,
  isUuid,
  type PolicyRemedy,
  type TenantContext,
  type TenantTransaction,
} from "@tidegrid/database";
import { releaseHold } from "@tidegrid/domain-inventory";
import { sql } from "kysely";
import { ownerRefFor } from "./checkout.ts";
import { enqueueCancellationEmail } from "./emails.ts";
import { type BookingHooks, noBookingHooks } from "./hooks.ts";
import { iso, record } from "./views.ts";

export type CancelRefusal =
  /** Already canceled; nothing more to do. */
  | "already_canceled"
  /** The trip has departed; a cancellation is a no-show now. */
  | "trip_departed"
  /** The policy gives credit here, which the operator issues. */
  | "remedy_requires_operator";

/** What canceling now would do, on the database clock. */
export interface CancellationTerms {
  bookingId: string;
  reference: string;
  state: "confirmed" | "canceled";
  /** True when the guest can cancel now, with exactly these terms. */
  cancelable: boolean;
  refusal: CancelRefusal | null;
  remedy: PolicyRemedy;
  /** Basis points of what was paid: 10000 for a full refund, 0 for none or credit. */
  refundBp: number;
  paidAmount: number;
  refundAmount: number;
  currency: "USD";
  departsAt: string;
  cutoffAt: string;
  beforeCutoff: boolean;
  policyVersion: number;
  /** The policy's cancellation text, as the guest accepted it. */
  policyText: string;
  /** The database clock's instant these terms were computed at. */
  asOf: string;
}

interface TermsRow {
  reference: string;
  state: "confirmed" | "canceled";
  checkout_session_id: string;
  payment_id: string;
  hold_id: string;
  product_id: string;
  policy_version: number;
  starts_at: Date | string;
  paid: number;
  payment_state: string;
  cutoff_at: Date | string;
  before_cutoff: boolean;
  departed: boolean;
  as_of: Date | string;
  before_cutoff_remedy: PolicyRemedy;
  before_cutoff_refund_bp: number | null;
  after_cutoff_remedy: PolicyRemedy;
  after_cutoff_refund_bp: number | null;
  cancellation_text: string;
}

/** Half up to the cent, as the database computes it. */
export function refundFor(paid: number, bp: number): number {
  return Math.floor((paid * bp + 5000) / 10000);
}

function termsOf(bookingId: string, row: TermsRow): CancellationTerms {
  const remedy = row.before_cutoff ? row.before_cutoff_remedy : row.after_cutoff_remedy;
  const policyBp = row.before_cutoff ? row.before_cutoff_refund_bp : row.after_cutoff_refund_bp;
  const bp = remedy === "full_refund" ? 10000 : remedy === "percent_refund" ? (policyBp ?? 0) : 0;
  const refusal: CancelRefusal | null =
    row.state === "canceled"
      ? "already_canceled"
      : row.departed
        ? "trip_departed"
        : remedy === "credit"
          ? "remedy_requires_operator"
          : null;
  return {
    bookingId,
    reference: row.reference,
    state: row.state,
    cancelable: refusal === null,
    refusal,
    remedy,
    refundBp: bp,
    paidAmount: row.paid,
    refundAmount: refundFor(row.paid, bp),
    currency: "USD",
    departsAt: iso(row.starts_at),
    cutoffAt: iso(row.cutoff_at),
    beforeCutoff: row.before_cutoff,
    policyVersion: row.policy_version,
    policyText: row.cancellation_text,
    asOf: iso(row.as_of),
  };
}

async function termsRow(
  trx: TenantTransaction,
  tenantId: string,
  bookingId: string,
): Promise<TermsRow | undefined> {
  const { rows } = await sql<TermsRow>`
    select b.reference, b.state, b.checkout_session_id, b.payment_id, b.hold_id,
           o.product_id, o.policy_version, t.starts_at,
           pay.amount as paid, pay.state as payment_state,
           t.starts_at - make_interval(mins => v.change_cutoff_minutes) as cutoff_at,
           now() < t.starts_at - make_interval(mins => v.change_cutoff_minutes) as before_cutoff,
           now() >= t.starts_at as departed,
           now() as as_of,
           v.before_cutoff_remedy, v.before_cutoff_refund_bp,
           v.after_cutoff_remedy, v.after_cutoff_refund_bp, v.cancellation_text
      from bookings b
      join orders o on o.tenant_id = b.tenant_id and o.id = b.order_id
      join scheduled_trips t on t.tenant_id = b.tenant_id and t.id = b.trip_id
      join payments pay on pay.tenant_id = b.tenant_id and pay.id = b.payment_id
      join policy_versions v
        on v.tenant_id = o.tenant_id and v.product_id = o.product_id and v.version = o.policy_version
     where b.tenant_id = ${tenantId} and b.id = ${bookingId}`.execute(trx);
  return rows[0];
}

/**
 * What canceling this booking now would do: the remedy, the refund, the
 * cutoff, and whether the guest may. Null when the booking is not this
 * tenant's. Read-only; the guest is shown the amount before confirming.
 */
export async function previewCancellation(
  trx: TenantTransaction,
  tenantId: string,
  bookingId: string,
): Promise<CancellationTerms | null> {
  if (!isUuid(bookingId)) return null;
  const row = await termsRow(trx, tenantId, bookingId);
  return row ? termsOf(bookingId, row) : null;
}

export interface CancellationRecord {
  cancellationId: string;
  canceledAt: string;
  remedy: CancellationRemedy;
  refundBp: number;
  paidAmount: number;
  refundAmount: number;
  refundId: string | null;
  beforeCutoff: boolean;
  cutoffAt: string;
  policyVersion: number;
}

export type CancelBookingResult =
  | { kind: "canceled"; cancellation: CancellationRecord }
  /** Canceled before, by this guest or a concurrent request: the same record. */
  | { kind: "already_canceled"; cancellation: CancellationRecord }
  | { kind: "not_found" }
  | { kind: "trip_departed" }
  | { kind: "remedy_requires_operator"; terms: CancellationTerms }
  /** The refund the guest was shown is no longer what canceling now gives. */
  | { kind: "terms_changed"; terms: CancellationTerms };

async function existingCancellation(
  trx: TenantTransaction,
  tenantId: string,
  bookingId: string,
): Promise<CancellationRecord | null> {
  const { rows } = await sql<{
    id: string;
    created_at: Date | string;
    remedy: CancellationRemedy;
    refund_bp: number;
    paid_amount: number;
    refund_amount: number;
    refund_id: string | null;
    before_cutoff: boolean;
    cutoff_at: Date | string;
    policy_version: number;
  }>`
    select id, created_at, remedy, refund_bp, paid_amount, refund_amount, refund_id,
           before_cutoff, cutoff_at, policy_version
      from booking_cancellations
     where tenant_id = ${tenantId} and booking_id = ${bookingId}`.execute(trx);
  const c = rows[0];
  if (!c) return null;
  return {
    cancellationId: c.id,
    canceledAt: iso(c.created_at),
    remedy: c.remedy,
    refundBp: c.refund_bp,
    paidAmount: c.paid_amount,
    refundAmount: c.refund_amount,
    refundId: c.refund_id,
    beforeCutoff: c.before_cutoff,
    cutoffAt: iso(c.cutoff_at),
    policyVersion: c.policy_version,
  };
}

/**
 * Cancel a confirmed booking within its policy, once. `expectedRefundAmount`
 * is what the guest was shown; if canceling now gives anything else (the
 * cutoff passed in between), nothing changes and the new terms come back.
 * Idempotent per booking: a second cancellation answers `already_canceled`
 * with the first one's record. The caller claims its idempotency key first,
 * commits, and then settles the refund outside the transaction.
 */
export async function cancelBooking(
  trx: TenantTransaction,
  ctx: TenantContext,
  input: { bookingId: string; expectedRefundAmount: number },
  hooks: BookingHooks = noBookingHooks,
): Promise<CancelBookingResult> {
  if (!Number.isInteger(input.expectedRefundAmount) || input.expectedRefundAmount < 0) {
    throw new RangeError("the expected refund is a whole number of cents, at least 0");
  }
  if (!isUuid(input.bookingId)) return { kind: "not_found" };
  const tenantId = ctx.tenantId;

  // The session first, as confirmation takes it, then the booking and the payment.
  const { rows: located } = await sql<{ checkout_session_id: string }>`
    select checkout_session_id from bookings
     where tenant_id = ${tenantId} and id = ${input.bookingId}`.execute(trx);
  const sessionId = located[0]?.checkout_session_id;
  if (!sessionId) return { kind: "not_found" };
  await sql`select id from checkout_sessions where tenant_id = ${tenantId} and id = ${sessionId}
              for update`.execute(trx);
  await sql`select id from bookings where tenant_id = ${tenantId} and id = ${input.bookingId}
              for update`.execute(trx);
  const row = await termsRow(trx, tenantId, input.bookingId);
  if (!row) throw new Error("a locked booking's terms were not found");
  await sql`select id from payments where tenant_id = ${tenantId} and id = ${row.payment_id}
              for update`.execute(trx);

  if (row.state === "canceled") {
    const existing = await existingCancellation(trx, tenantId, input.bookingId);
    if (!existing) throw new Error("a canceled booking has no cancellation");
    return { kind: "already_canceled", cancellation: existing };
  }
  const terms = termsOf(input.bookingId, row);
  if (terms.refusal === "trip_departed") return { kind: "trip_departed" };
  if (terms.refusal === "remedy_requires_operator")
    return { kind: "remedy_requires_operator", terms };
  if (terms.refundAmount !== input.expectedRefundAmount) return { kind: "terms_changed", terms };
  if (row.payment_state !== "succeeded")
    throw new Error("a confirmed booking's payment did not succeed");
  const remedy = terms.remedy as CancellationRemedy;

  const refundId = terms.refundAmount > 0 ? crypto.randomUUID() : null;
  // The instants come from the rows themselves, in SQL, at full precision; the
  // database clock is this transaction's, the same one the terms were read at.
  const { rows: inserted } = await sql<{ id: string; created_at: Date | string }>`
    insert into booking_cancellations (tenant_id, booking_id, payment_id, product_id,
      policy_version, departs_at, cutoff_at, before_cutoff, remedy, refund_bp, paid_amount,
      refund_amount, refund_id)
    select b.tenant_id, b.id, b.payment_id, o.product_id, o.policy_version, t.starts_at,
           t.starts_at - make_interval(mins => v.change_cutoff_minutes),
           now() < t.starts_at - make_interval(mins => v.change_cutoff_minutes),
           ${remedy}, ${terms.refundBp}, pay.amount, ${terms.refundAmount}, ${refundId}::uuid
      from bookings b
      join orders o on o.tenant_id = b.tenant_id and o.id = b.order_id
      join scheduled_trips t on t.tenant_id = b.tenant_id and t.id = b.trip_id
      join payments pay on pay.tenant_id = b.tenant_id and pay.id = b.payment_id
      join policy_versions v
        on v.tenant_id = o.tenant_id and v.product_id = o.product_id and v.version = o.policy_version
     where b.tenant_id = ${tenantId} and b.id = ${input.bookingId}
    returning id, created_at`.execute(trx);
  const cancellation = inserted[0];
  if (!cancellation) throw new Error("cancellation insert returned no row");

  await trx
    .updateTable("bookings")
    .set({ state: "canceled" })
    .where("tenant_id", "=", tenantId)
    .where("id", "=", input.bookingId)
    .where("state", "=", "confirmed")
    .execute();

  if (refundId) {
    await trx
      .insertInto("payment_refunds")
      .values({
        id: refundId,
        tenant_id: tenantId,
        payment_id: row.payment_id,
        amount: terms.refundAmount,
        currency: "USD",
        reason: "booking_canceled",
        idempotency_key: `booking_cancel_refund:${refundId}`,
      })
      .execute();
  }

  const released = await releaseHold(trx, ctx, {
    holdId: row.hold_id,
    ownerRef: ownerRefFor(row.checkout_session_id),
    reason: "booking canceled by its guest",
  });
  if (released.kind !== "released") {
    throw new Error(`a canceled booking's hold did not release: ${released.kind}`);
  }

  const after = {
    state: "canceled",
    cancellationId: cancellation.id,
    remedy,
    refundBp: terms.refundBp,
    paidAmount: terms.paidAmount,
    refundAmount: terms.refundAmount,
    refundId,
    beforeCutoff: terms.beforeCutoff,
    policyVersion: terms.policyVersion,
  };
  await record(trx, ctx, {
    action: "booking.canceled",
    subjectType: "booking",
    subjectId: input.bookingId,
    before: { state: "confirmed" },
    after,
    topic: "booking.canceled",
    payload: { bookingId: input.bookingId, cancellationId: cancellation.id, refundId },
  });
  if (refundId) {
    await record(trx, ctx, {
      action: "payment_refund.requested",
      subjectType: "payment_refund",
      subjectId: refundId,
      after: {
        state: "requested",
        paymentId: row.payment_id,
        amount: terms.refundAmount,
        reason: "booking_canceled",
      },
    });
  }
  await enqueueCancellationEmail(trx, ctx, input.bookingId);
  await hooks.bookingCanceled?.(trx, ctx, {
    bookingId: input.bookingId,
    cancellationId: cancellation.id,
    refundId,
  });
  return {
    kind: "canceled",
    cancellation: {
      cancellationId: cancellation.id,
      canceledAt: iso(cancellation.created_at),
      remedy,
      refundBp: terms.refundBp,
      paidAmount: terms.paidAmount,
      refundAmount: terms.refundAmount,
      refundId,
      beforeCutoff: terms.beforeCutoff,
      cutoffAt: terms.cutoffAt,
      policyVersion: terms.policyVersion,
    },
  };
}
