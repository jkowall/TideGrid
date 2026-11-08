/**
 * TideGrid's managed-booking fee ledger (W3-G2.9; assessment arrives with
 * G2.10). docs/v2/03: TideGrid's Core fee is 1.5% of net managed booking
 * value, and refunded eligible value leaves the fee base, so a succeeded
 * cancellation refund reverses the fee on its eligible share. Taxes are not
 * eligible; tips do not exist yet. Credit is not a refund: the value stays
 * counted on the original booking and is not charged again when redeemed, so
 * issuing credit reverses nothing.
 *
 * The arithmetic, in integer cents, checked again by the database (0029):
 *
 *   eligible total    = order total - added tax - included tax
 *   eligible refunded = floor(refund x eligible total / order total)
 *   fee reversed      = half up(eligible refunded x 150 / 10000), negative
 */
import type { TenantContext, TenantTransaction } from "@tidegrid/database";
import { sql } from "kysely";
import { record } from "./views.ts";

/** The Core fee, in basis points of net managed booking value (docs/v2/03). */
export const CORE_FEE_BP = 150;

export interface FeeReversal {
  bookingId: string;
  refundAmount: number;
  orderTotal: number;
  eligibleTotal: number;
  eligibleAmount: number;
  feeBp: number;
  /** Negative, in cents. */
  feeAmount: number;
}

/** The reversal for a refund of `refundAmount` from an order, as the database computes it. */
export function feeReversalFor(input: {
  refundAmount: number;
  orderTotal: number;
  eligibleTotal: number;
  feeBp?: number;
}): Pick<FeeReversal, "eligibleAmount" | "feeAmount" | "feeBp"> {
  const feeBp = input.feeBp ?? CORE_FEE_BP;
  if (input.orderTotal <= 0) return { eligibleAmount: 0, feeAmount: 0, feeBp };
  const eligible = Number(
    (BigInt(input.refundAmount) * BigInt(input.eligibleTotal)) / BigInt(input.orderTotal),
  );
  const fee = Number((BigInt(eligible) * BigInt(feeBp) + 5000n) / 10000n);
  return { eligibleAmount: eligible, feeAmount: fee === 0 ? 0 : -fee, feeBp };
}

/**
 * Write the reversal for a succeeded cancellation refund, once. Called in
 * the transaction that records the success. Returns null when the refund is
 * not a booking's (an unfulfilled payment had no fee) or was reversed before.
 */
export async function reverseFeeForRefund(
  trx: TenantTransaction,
  ctx: TenantContext,
  refundId: string,
): Promise<FeeReversal | null> {
  const { rows } = await sql<{
    booking_id: string;
    amount: number;
    total_amount: number;
    eligible_total: number;
  }>`
    select b.id as booking_id, r.amount, o.total_amount,
           o.total_amount - o.tax_amount - o.included_tax_amount as eligible_total
      from payment_refunds r
      join bookings b on b.tenant_id = r.tenant_id and b.payment_id = r.payment_id
      join orders o on o.tenant_id = b.tenant_id and o.id = b.order_id
     where r.tenant_id = ${ctx.tenantId} and r.id = ${refundId}
       and r.state = 'succeeded' and r.reason = 'booking_canceled'`.execute(trx);
  const row = rows[0];
  if (!row || row.total_amount <= 0) return null;
  const computed = feeReversalFor({
    refundAmount: row.amount,
    orderTotal: row.total_amount,
    eligibleTotal: row.eligible_total,
  });
  const { rows: inserted } = await sql<{ id: string }>`
    insert into fee_ledger_entries (tenant_id, kind, booking_id, refund_id, refund_amount,
      order_total, eligible_total, eligible_amount, fee_bp, fee_amount)
    values (${ctx.tenantId}, 'refund_reversal', ${row.booking_id}, ${refundId}, ${row.amount},
      ${row.total_amount}, ${row.eligible_total}, ${computed.eligibleAmount}, ${computed.feeBp},
      ${computed.feeAmount})
    on conflict (tenant_id, refund_id) do nothing
    returning id`.execute(trx);
  const entry = inserted[0];
  if (!entry) return null;
  const reversal: FeeReversal = {
    bookingId: row.booking_id,
    refundAmount: row.amount,
    orderTotal: row.total_amount,
    eligibleTotal: row.eligible_total,
    ...computed,
  };
  await record(trx, ctx, {
    action: "fee_ledger.refund_reversal",
    subjectType: "booking",
    subjectId: row.booking_id,
    after: {
      refundId,
      eligibleAmount: reversal.eligibleAmount,
      feeBp: reversal.feeBp,
      feeAmount: reversal.feeAmount,
    },
  });
  return reversal;
}
