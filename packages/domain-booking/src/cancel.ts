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
 * term again (migration 0009). After commit the caller sends the refund
 * through the payment adapter with `settleRefund`; the checkout sweep resends
 * one whose outcome is unknown.
 *
 * Staff cancel too (W3-G2.9, `staffCancelBooking`): the policy's remedy, the
 * policy's refund value as booking credit instead, or an override with a
 * reason. Credit is issued in the same transaction, to the booker's credit
 * account; a refund is sent after commit as for a guest.
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
import { cancelMessage } from "@tidegrid/domain-messaging";
import { sql } from "kysely";
import { appendCreditEntry, creditBalanceForBooking, ensureCreditAccount } from "./credits.ts";
import {
  BALANCE_LINK_EMAIL,
  BALANCE_REMINDER_EMAIL,
  CONFIRMATION_TEMPLATE,
  enqueueCancellationEmail,
  MANAGE_LINK_TEMPLATE,
  REMINDER_TEMPLATE,
  RESCHEDULED_TEMPLATE,
} from "./emails.ts";
import { feeReversalFor } from "./fee-ledger.ts";
import { type BookingHooks, noBookingHooks } from "./hooks.ts";
import { withdrawProfileAccess } from "./participants.ts";
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
  /** Null on a complimentary booking (0039), which paid nothing. */
  payment_id: string | null;
  complimentary: boolean;
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
  order_total: number;
  /** Refunds staff recorded outside the card flow (W3-G2.10). */
  external_refunded: number;
  /** What lost disputes took back from the card (W3-G2.10). */
  lost_disputed: number;
  /** Payments staff recorded outside the card flow (W3-G2.10). */
  external_paid: number;
  /** A private charter that took a deposit (W3-G2.8). */
  has_deposit: boolean;
  /** Card payments of a charter's balance that succeeded (W3-G2.8). */
  balance_paid: number;
}

/** Half up to the cent, as the database computes it. */
export function refundFor(paid: number, bp: number): number {
  return Math.floor((paid * bp + 5000) / 10000);
}

function termsOf(bookingId: string, row: TermsRow): CancellationTerms {
  // A complimentary booking (0039) paid nothing, so whatever its policy gives
  // a paid booking, it cancels with nothing to return, before departure.
  const remedy = row.complimentary
    ? "none"
    : row.before_cutoff
      ? row.before_cutoff_remedy
      : row.after_cutoff_remedy;
  const policyBp = row.before_cutoff ? row.before_cutoff_refund_bp : row.after_cutoff_refund_bp;
  const bp = remedy === "full_refund" ? 10000 : remedy === "percent_refund" ? (policyBp ?? 0) : 0;
  const refusal: CancelRefusal | null =
    row.state === "canceled"
      ? "already_canceled"
      : row.departed
        ? "trip_departed"
        : remedy === "credit"
          ? "remedy_requires_operator"
          : // Money already went back outside the card flow (W3-G2.10), so
            // the policy's refund would count it twice: the operator decides.
            // So would a refund of what a lost dispute already took back.
            bp > 0 && (row.external_refunded > 0 || row.lost_disputed > 0)
            ? "remedy_requires_operator"
            : // A deposit and a balance (W3-G2.8): whether a deposit comes back is
              // the operator's call (docs/v2/02), and a balance paid later is not
              // the card payment the policy refunds.
              bp > 0 && row.has_deposit
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
    select b.reference, b.state, b.checkout_session_id, b.payment_id,
           b.payment_id is null as complimentary, b.hold_id,
           o.product_id, o.policy_version, t.starts_at,
           coalesce(pay.amount, 0) as paid, coalesce(pay.state, 'none') as payment_state,
           t.starts_at - make_interval(mins => v.change_cutoff_minutes) as cutoff_at,
           now() < t.starts_at - make_interval(mins => v.change_cutoff_minutes) as before_cutoff,
           now() >= t.starts_at as departed,
           now() as as_of,
           v.before_cutoff_remedy, v.before_cutoff_refund_bp,
           v.after_cutoff_remedy, v.after_cutoff_refund_bp, v.cancellation_text,
           o.total_amount as order_total,
           coalesce((select sum(x.amount) from external_settlements x
                      where x.tenant_id = b.tenant_id and x.booking_id = b.id
                        and x.kind = 'refund'), 0)::int as external_refunded,
           coalesce((select sum(d.amount) from payment_disputes d
                      where d.tenant_id = b.tenant_id and d.payment_id = b.payment_id
                        and d.status = 'lost'), 0)::int as lost_disputed,
           coalesce((select sum(x.amount) from external_settlements x
                      where x.tenant_id = b.tenant_id and x.booking_id = b.id
                        and x.kind = 'payment'), 0)::int as external_paid,
           o.deposit_amount is not null as has_deposit,
           coalesce((select sum(bp.amount) from balance_payments bp
                      where bp.tenant_id = b.tenant_id and bp.booking_id = b.id
                        and bp.state = 'succeeded'), 0)::int as balance_paid
      from bookings b
      join orders o on o.tenant_id = b.tenant_id and o.id = b.order_id
      join scheduled_trips t on t.tenant_id = b.tenant_id and t.id = b.trip_id
      left join payments pay on pay.tenant_id = b.tenant_id and pay.id = b.payment_id
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
  creditAmount: number;
  creditEntryId: string | null;
  overridden: boolean;
  /** Who canceled, as the database stamped it. */
  by: "staff" | "guest" | "system" | "support";
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
    credit_amount: number;
    credit_entry_id: string | null;
    overridden: boolean;
    actor_type: CancellationRecord["by"];
    before_cutoff: boolean;
    cutoff_at: Date | string;
    policy_version: number;
  }>`
    select id, created_at, remedy, refund_bp, paid_amount, refund_amount, refund_id,
           credit_amount, credit_entry_id, override_reason is not null as overridden, actor_type,
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
    creditAmount: c.credit_amount,
    creditEntryId: c.credit_entry_id,
    overridden: c.overridden,
    by: c.actor_type,
    beforeCutoff: c.before_cutoff,
    cutoffAt: iso(c.cutoff_at),
    policyVersion: c.policy_version,
  };
}

/** Lock the session, the booking, and the payment, in that order, and read the terms. */
async function lockForCancel(
  trx: TenantTransaction,
  tenantId: string,
  bookingId: string,
): Promise<TermsRow | null> {
  // The session first, as confirmation takes it, then the booking and the payment.
  const { rows: located } = await sql<{ checkout_session_id: string }>`
    select checkout_session_id from bookings
     where tenant_id = ${tenantId} and id = ${bookingId}`.execute(trx);
  const sessionId = located[0]?.checkout_session_id;
  if (!sessionId) return null;
  await sql`select id from checkout_sessions where tenant_id = ${tenantId} and id = ${sessionId}
              for update`.execute(trx);
  // NO KEY UPDATE: the email delivery job's foreign key checks on the booking
  // never wait behind a cancellation whose hooks may wait for that job.
  await sql`select id from bookings where tenant_id = ${tenantId} and id = ${bookingId}
              for no key update`.execute(trx);
  const row = await termsRow(trx, tenantId, bookingId);
  if (!row) throw new Error("a locked booking's terms were not found");
  if (row.payment_id !== null) {
    await sql`select id from payments where tenant_id = ${tenantId} and id = ${row.payment_id}
                for update`.execute(trx);
  }
  return row;
}

/** The remedy a cancellation applies, as the database row carries it. */
interface Applied {
  remedy: CancellationRemedy;
  refundBp: number;
  overrideReason: string | null;
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
  const row = await lockForCancel(trx, ctx.tenantId, input.bookingId);
  if (!row) return { kind: "not_found" };
  if (row.state === "canceled") {
    const existing = await existingCancellation(trx, ctx.tenantId, input.bookingId);
    if (!existing) throw new Error("a canceled booking has no cancellation");
    return { kind: "already_canceled", cancellation: existing };
  }
  const terms = termsOf(input.bookingId, row);
  if (terms.refusal === "trip_departed") return { kind: "trip_departed" };
  if (terms.refusal === "remedy_requires_operator")
    return { kind: "remedy_requires_operator", terms };
  if (terms.refundAmount !== input.expectedRefundAmount) return { kind: "terms_changed", terms };
  const cancellation = await applyCancellation(
    trx,
    ctx,
    input.bookingId,
    row,
    terms,
    { remedy: terms.remedy as CancellationRemedy, refundBp: terms.refundBp, overrideReason: null },
    hooks,
    "booking canceled by its guest",
  );
  return { kind: "canceled", cancellation };
}

// Staff cancellation (W3-G2.9) ----------------------------------------------------------

/** What staff may apply instead of the policy's remedy. */
export type StaffRemedyChoice =
  /**
   * The policy's own remedy: its refund, its credit, or nothing. `remedy` is
   * the one staff were shown; a policy that now gives another changes nothing.
   */
  | { kind: "policy"; remedy: CancellationRemedy }
  /** The policy's refund value as booking credit instead (no reason needed). */
  | { kind: "credit" }
  /** Any remedy at any basis points the rules allow, with a reason. */
  | { kind: "override"; remedy: CancellationRemedy; refundBp: number; reason: string };

export interface StaffCancellationPreview {
  terms: CancellationTerms;
  /** Why staff cannot cancel now, or null. */
  refusal: "already_canceled" | "trip_departed" | null;
  /** The policy's value, in cents: what it refunds, or what it credits when its remedy is credit. */
  policyValue: number;
  /** Taking the policy's remedy. Null when the policy gives credit (see credit). */
  refund: {
    amount: number;
    /** TideGrid's fee reversed when this refund succeeds (negative cents). */
    feeReversal: number;
  } | null;
  /** Taking the policy's value as credit. Null when the policy gives nothing. */
  credit: { amount: number; balanceAfter: number } | null;
  /** The booker's credit balance with this operator now. */
  creditBalance: number;
}

/** The order's eligible value, for the fee reversal estimate. */
async function orderTotals(
  trx: TenantTransaction,
  tenantId: string,
  bookingId: string,
): Promise<{ total: number; eligible: number }> {
  const { rows } = await sql<{ total: number; eligible: number }>`
    select o.total_amount as total,
           o.total_amount - o.tax_amount - o.included_tax_amount as eligible
      from bookings b join orders o on o.tenant_id = b.tenant_id and o.id = b.order_id
     where b.tenant_id = ${tenantId} and b.id = ${bookingId}`.execute(trx);
  const row = rows[0];
  if (!row) throw new Error("a booking's order was not found");
  return row;
}

/**
 * What staff canceling now would do, with the credit alternative beside the
 * refund: the customer, the amount, the policy, and the resulting balance
 * (docs/v2/02). Read-only. Null when the booking is not this tenant's.
 */
export async function previewStaffCancellation(
  trx: TenantTransaction,
  tenantId: string,
  bookingId: string,
): Promise<StaffCancellationPreview | null> {
  if (!isUuid(bookingId)) return null;
  const row = await termsRow(trx, tenantId, bookingId);
  if (!row) return null;
  const terms = termsOf(bookingId, row);
  const value = policyValue(terms);
  const balance = await creditBalanceForBooking(trx, tenantId, bookingId);
  const totals = await orderTotals(trx, tenantId, bookingId);
  const refusal =
    terms.refusal === "already_canceled" || terms.refusal === "trip_departed"
      ? terms.refusal
      : null;
  return {
    terms,
    refusal,
    policyValue: value,
    refund:
      terms.remedy === "credit"
        ? null
        : {
            amount: terms.refundAmount,
            feeReversal:
              terms.refundAmount > 0
                ? feeReversalFor({
                    refundAmount: terms.refundAmount,
                    orderTotal: totals.total,
                    eligibleTotal: totals.eligible,
                  }).feeAmount
                : 0,
          },
    credit: value > 0 ? { amount: value, balanceAfter: balance + value } : null,
    creditBalance: balance,
  };
}

/** The policy's value in cents: its refund, or the whole payment when it gives credit. */
function policyValue(terms: CancellationTerms): number {
  return terms.remedy === "credit" ? terms.paidAmount : terms.refundAmount;
}

export type StaffCancelResult =
  | CancelBookingResult
  /** The policy gives nothing here, so there is nothing to credit. */
  | { kind: "nothing_to_credit"; terms: CancellationTerms }
  /** An override's remedy and basis points do not fit together. */
  | { kind: "override_invalid"; message: string };

// biome-ignore lint/suspicious/noControlCharactersInRegex: the pattern exists to reject them.
const overrideReasonPattern = /^[^\u0000-\u001f\u007f]{1,500}$/;

function checkOverride(choice: Extract<StaffRemedyChoice, { kind: "override" }>): string | null {
  const bp = choice.refundBp;
  if (!Number.isInteger(bp) || bp < 0 || bp > 10000) return "Basis points are 0 to 10000";
  if (!overrideReasonPattern.test(choice.reason.trim()) || choice.reason.trim() !== choice.reason) {
    return "An override needs a reason of 1 to 500 characters";
  }
  switch (choice.remedy) {
    case "full_refund":
      return bp === 10000 ? null : "A full refund is 10000 basis points";
    case "percent_refund":
      return bp >= 1 && bp <= 9999 ? null : "A percentage refund is 1 to 9999 basis points";
    case "credit":
      return bp >= 1 ? null : "Credit is 1 to 10000 basis points";
    case "none":
      return bp === 0 ? null : "No remedy is 0 basis points";
  }
}

/**
 * Staff cancel a confirmed booking, once: the policy's remedy, its value as
 * credit, or an override with a reason. `expectedAmount` is the value (refund
 * plus credit, in cents) staff were shown; if canceling now gives anything
 * else, nothing changes and the new terms come back. The caller claims its
 * idempotency key first, commits, and then settles any refund.
 */
export async function staffCancelBooking(
  trx: TenantTransaction,
  ctx: TenantContext,
  input: { bookingId: string; choice: StaffRemedyChoice; expectedAmount: number },
  hooks: BookingHooks = noBookingHooks,
): Promise<StaffCancelResult> {
  if (ctx.actorType !== "staff") throw new Error("staff cancellation runs as staff");
  if (!Number.isInteger(input.expectedAmount) || input.expectedAmount < 0) {
    throw new RangeError("the expected amount is a whole number of cents, at least 0");
  }
  if (input.choice.kind === "override") {
    const problem = checkOverride(input.choice);
    if (problem) return { kind: "override_invalid", message: problem };
  }
  if (!isUuid(input.bookingId)) return { kind: "not_found" };
  const row = await lockForCancel(trx, ctx.tenantId, input.bookingId);
  if (!row) return { kind: "not_found" };
  if (row.state === "canceled") {
    const existing = await existingCancellation(trx, ctx.tenantId, input.bookingId);
    if (!existing) throw new Error("a canceled booking has no cancellation");
    return { kind: "already_canceled", cancellation: existing };
  }
  const terms = termsOf(input.bookingId, row);
  if (terms.refusal === "trip_departed") return { kind: "trip_departed" };
  if (row.complimentary && input.choice.kind === "override") {
    return {
      kind: "override_invalid",
      message:
        "This booking was complimentary, so there is nothing to refund or credit. Cancel it under its policy",
    };
  }
  const policyRemedy: CancellationRemedy = terms.remedy;
  let applied: Applied;
  switch (input.choice.kind) {
    case "policy":
      // The same value can come as a refund before a cutoff and as credit
      // after it, so the remedy staff were shown is checked too.
      if (input.choice.remedy !== policyRemedy) return { kind: "terms_changed", terms };
      applied = {
        remedy: policyRemedy,
        refundBp: policyRemedy === "credit" ? 10000 : terms.refundBp,
        overrideReason: null,
      };
      break;
    case "credit":
      if (policyValue(terms) === 0) return { kind: "nothing_to_credit", terms };
      applied = {
        remedy: "credit",
        refundBp: policyRemedy === "credit" ? 10000 : terms.refundBp,
        overrideReason: null,
      };
      break;
    case "override":
      applied = {
        remedy: input.choice.remedy,
        refundBp: input.choice.refundBp,
        overrideReason: input.choice.reason,
      };
      break;
  }
  if (refundFor(terms.paidAmount, applied.refundBp) !== input.expectedAmount) {
    return { kind: "terms_changed", terms };
  }
  // Card and external refunds together return at most what the booking cost
  // (W3-G2.10); the database checks the same bound.
  const cardRefund = applied.remedy === "credit" ? 0 : input.expectedAmount;
  // At most what the booking cost, at most what is left on the card, and at
  // most the money still held across card and external tender together.
  const cardLimit = Math.min(
    row.order_total - row.external_refunded,
    row.paid - row.lost_disputed,
    row.paid + row.external_paid + row.balance_paid - row.lost_disputed - row.external_refunded,
  );
  if (cardRefund > 0 && cardRefund > cardLimit) {
    return {
      kind: "override_invalid",
      message: `External refunds (${row.external_refunded} cents) or a lost dispute (${row.lost_disputed} cents) already returned money; a card refund may return at most ${Math.max(0, cardLimit)} cents. Choose credit, a smaller refund with a reason, or no refund`,
    };
  }
  const cancellation = await applyCancellation(
    trx,
    ctx,
    input.bookingId,
    row,
    terms,
    applied,
    hooks,
    "booking canceled by staff",
  );
  return { kind: "canceled", cancellation };
}

/**
 * Write a cancellation whose terms are decided: the cancellation row, the
 * booking canceled, the refund row or the credit entry, the hold released,
 * audit and events, the emails, and the hook. Runs under lockForCancel's locks.
 */
async function applyCancellation(
  trx: TenantTransaction,
  ctx: TenantContext,
  bookingId: string,
  row: TermsRow,
  terms: CancellationTerms,
  applied: Applied,
  hooks: BookingHooks,
  holdReason: string,
): Promise<CancellationRecord> {
  const tenantId = ctx.tenantId;
  if (!row.complimentary && row.payment_state !== "succeeded")
    throw new Error("a confirmed booking's payment did not succeed");
  const value = refundFor(terms.paidAmount, applied.refundBp);
  const isCredit = applied.remedy === "credit";
  const refundAmount = isCredit ? 0 : value;
  const creditAmount = isCredit ? value : 0;
  const refundId = refundAmount > 0 ? crypto.randomUUID() : null;
  const creditEntryId = creditAmount > 0 ? crypto.randomUUID() : null;
  // The instants come from the rows themselves, in SQL, at full precision; the
  // database clock is this transaction's, the same one the terms were read at.
  const { rows: inserted } = await sql<{ id: string; created_at: Date | string }>`
    insert into booking_cancellations (tenant_id, booking_id, payment_id, product_id,
      policy_version, departs_at, cutoff_at, before_cutoff, remedy, refund_bp, paid_amount,
      refund_amount, refund_id, credit_amount, credit_entry_id, override_reason)
    select b.tenant_id, b.id, b.payment_id, o.product_id, o.policy_version, t.starts_at,
           t.starts_at - make_interval(mins => v.change_cutoff_minutes),
           now() < t.starts_at - make_interval(mins => v.change_cutoff_minutes),
           ${applied.remedy}, ${applied.refundBp}, coalesce(pay.amount, 0), ${refundAmount},
           ${refundId}::uuid, ${creditAmount}, ${creditEntryId}::uuid, ${applied.overrideReason}
      from bookings b
      join orders o on o.tenant_id = b.tenant_id and o.id = b.order_id
      join scheduled_trips t on t.tenant_id = b.tenant_id and t.id = b.trip_id
      left join payments pay on pay.tenant_id = b.tenant_id and pay.id = b.payment_id
      join policy_versions v
        on v.tenant_id = o.tenant_id and v.product_id = o.product_id and v.version = o.policy_version
     where b.tenant_id = ${tenantId} and b.id = ${bookingId}
    returning id, created_at`.execute(trx);
  const cancellation = inserted[0];
  if (!cancellation) throw new Error("cancellation insert returned no row");

  await trx
    .updateTable("bookings")
    .set({ state: "canceled" })
    .where("tenant_id", "=", tenantId)
    .where("id", "=", bookingId)
    .where("state", "=", "confirmed")
    .execute();

  if (refundId) {
    if (row.payment_id === null) throw new Error("a complimentary booking has nothing to refund");
    await trx
      .insertInto("payment_refunds")
      .values({
        id: refundId,
        tenant_id: tenantId,
        payment_id: row.payment_id,
        amount: refundAmount,
        currency: "USD",
        reason: "booking_canceled",
        idempotency_key: `booking_cancel_refund:${refundId}`,
      })
      .execute();
  }
  if (creditEntryId) {
    const { rows: booker } = await sql<{ booker_email: string }>`
      select booker_email from checkout_sessions
       where tenant_id = ${tenantId} and id = ${row.checkout_session_id}`.execute(trx);
    const email = booker[0]?.booker_email;
    if (!email) throw new Error("a booking's checkout has no booker email");
    const accountId = await ensureCreditAccount(trx, ctx, email);
    const issued = await appendCreditEntry(trx, ctx, {
      id: creditEntryId,
      accountId,
      kind: "issue",
      amount: creditAmount,
      bookingId,
      cancellationId: cancellation.id,
      idempotencyKey: `booking_cancel_credit:${bookingId}`,
    });
    if (issued.kind !== "applied" || issued.entry.id !== creditEntryId) {
      throw new Error("a cancellation's credit was not issued");
    }
  }

  // The hold's owner is whoever took it: the checkout, or the booking's last
  // move to another trip (W3-G2.11-rest).
  const { rows: holdOwner } = await sql<{ owner_ref: string }>`
    select owner_ref from capacity_holds
     where tenant_id = ${tenantId} and id = ${row.hold_id}`.execute(trx);
  const ownerRef = holdOwner[0]?.owner_ref;
  if (!ownerRef) throw new Error("a canceled booking's hold was not found");
  const released = await releaseHold(trx, ctx, {
    holdId: row.hold_id,
    ownerRef,
    reason: holdReason,
  });
  if (released.kind !== "released") {
    throw new Error(`a canceled booking's hold did not release: ${released.kind}`);
  }

  const after = {
    state: "canceled",
    cancellationId: cancellation.id,
    remedy: applied.remedy,
    refundBp: applied.refundBp,
    paidAmount: terms.paidAmount,
    refundAmount,
    refundId,
    creditAmount,
    creditEntryId,
    beforeCutoff: terms.beforeCutoff,
    policyVersion: terms.policyVersion,
    policyRemedy: terms.remedy,
    overridden: applied.overrideReason !== null,
  };
  await record(trx, ctx, {
    action: applied.overrideReason !== null ? "booking.canceled_override" : "booking.canceled",
    subjectType: "booking",
    subjectId: bookingId,
    reason: applied.overrideReason,
    before: { state: "confirmed", policyRemedy: terms.remedy, policyRefundBp: terms.refundBp },
    after,
    topic: "booking.canceled",
    payload: { bookingId, cancellationId: cancellation.id, refundId, creditEntryId },
  });
  if (refundId) {
    await record(trx, ctx, {
      action: "payment_refund.requested",
      subjectType: "payment_refund",
      subjectId: refundId,
      after: {
        state: "requested",
        paymentId: row.payment_id,
        amount: refundAmount,
        reason: "booking_canceled",
      },
    });
  }
  // The booking's own email still waiting to go out (a confirmation in its
  // retry backoff, a link asked for a moment ago, the trip reminder waiting
  // for its day) would arrive after the
  // cancellation's, saying the booking stands. Cancel it. Its links keep
  // working, so the guest can still open the canceled booking and its refund.
  const { rows: pending } = await sql<{ id: string }>`
    select id from email_messages
     where tenant_id = ${tenantId} and booking_id = ${bookingId}
       and template in (${CONFIRMATION_TEMPLATE.key}, ${MANAGE_LINK_TEMPLATE.key},
                        ${REMINDER_TEMPLATE.key}, ${BALANCE_REMINDER_EMAIL.key},
                        ${BALANCE_LINK_EMAIL.key}, ${RESCHEDULED_TEMPLATE.key})
       and state in ('queued', 'sending')
     order by id`.execute(trx);
  for (const message of pending) {
    await cancelMessage(trx, ctx, message.id, { code: "booking_canceled", revokeLinks: false });
  }
  // A balance payment still open (W3-G2.8) is abandoned: nothing more is
  // asked of a canceled booking. One the guest pays anyway is recorded, and
  // shows on the balance as overpaid, money staff return (balance-read.ts).
  await sql`
    update balance_payments set state = 'abandoned'
     where tenant_id = ${tenantId} and booking_id = ${bookingId} and state = 'pending'`.execute(
    trx,
  );
  await enqueueCancellationEmail(trx, ctx, bookingId);
  // Participants' invitations (0036) open nothing on a canceled booking:
  // their links and sessions end, and one not yet sent never goes.
  await withdrawProfileAccess(trx, ctx, { bookingId, reason: "booking_canceled" });
  await hooks.bookingCanceled?.(trx, ctx, {
    bookingId,
    cancellationId: cancellation.id,
    refundId,
  });
  return {
    cancellationId: cancellation.id,
    canceledAt: iso(cancellation.created_at),
    remedy: applied.remedy,
    refundBp: applied.refundBp,
    paidAmount: terms.paidAmount,
    refundAmount,
    refundId,
    creditAmount,
    creditEntryId,
    overridden: applied.overrideReason !== null,
    by: ctx.actorType,
    beforeCutoff: terms.beforeCutoff,
    cutoffAt: terms.cutoffAt,
    policyVersion: terms.policyVersion,
  };
}
