/**
 * A day's bookings as a report (G2.12c): one row per booking on the trips
 * departing that local date, with its money from the ledger, and the day's
 * control totals. The console shows the totals; the CSV export carries the
 * rows and the totals as its last row. Both come from this one read, so they
 * cannot disagree.
 *
 * The ledger here is each booking's immutable order (its subtotal, discount,
 * fees, added taxes, included taxes, and total) and its payment's refunds.
 * Refunds count when they have succeeded; a refund still requested is shown as
 * pending and left out of refunds and net until it settles.
 *
 * The rows come from one statement, so they are one moment even under READ
 * COMMITTED. The booker's name and email are selected only with
 * `withBooker`; otherwise the query never joins the checkout that holds them.
 */
import type {
  BookingState,
  PaymentState,
  ProductKind,
  RefundState,
  TenantTransaction,
} from "@tidegrid/database";
import { type RawBuilder, sql } from "kysely";
import { iso } from "./views.ts";

/** More bookings than this on one day is refused rather than cut short: totals must be whole. */
export const DAY_REPORT_LIMIT = 5000;

export interface DayReportMoney {
  /** Trip prices and paid extras, before discounts: the order's subtotal. */
  gross: number;
  discounts: number;
  fees: number;
  /** Taxes added on top of prices. */
  taxes: number;
  /** gross - discounts + fees + taxes: the order's total. */
  total: number;
  /** Succeeded refunds. */
  refunds: number;
  /** total - refunds. */
  net: number;
  /** Taxes inside prices, so inside gross. */
  includedTax: number;
}

export interface DayReportRow extends DayReportMoney {
  bookingId: string;
  reference: string;
  state: BookingState;
  confirmedAt: string;
  trip: {
    tripId: string;
    productName: string;
    productKind: ProductKind;
    boatName: string;
    timeZone: string;
    localDate: string;
    localStartTime: string;
    startsAt: string;
  };
  /**
   * 1 for a booking that counts on the day, 0 for a canceled one: its seats
   * went back on sale, while its order and refunds stay in the money.
   */
  bookings: number;
  /** The party's size, or 0 for a canceled booking. */
  guests: number;
  paymentState: PaymentState;
  /** The latest refund's state, or null when there is none. */
  refundState: RefundState | null;
  pendingRefund: { count: number; amount: number };
  booker?: { name: string; email: string };
}

export interface DayReportTotals extends DayReportMoney {
  bookings: number;
  guests: number;
  pendingRefunds: { count: number; amount: number };
}

export interface DayReport {
  date: string;
  generatedAt: string;
  rows: DayReportRow[];
  totals: DayReportTotals;
}

export type DayReportOutcome = { kind: "ok"; report: DayReport } | { kind: "too_large" };

interface ReportRow {
  id: string;
  reference: string;
  state: BookingState;
  confirmed_at: Date | string;
  party_size: number;
  trip_id: string;
  product_name: string;
  product_kind: ProductKind;
  boat_name: string;
  time_zone: string;
  local_date: string;
  local_start_time: string;
  starts_at: Date | string;
  subtotal_amount: number;
  discount_amount: number;
  fee_amount: number;
  tax_amount: number;
  included_tax_amount: number;
  total_amount: number;
  payment_state: PaymentState;
  refund_state: RefundState | null;
  refunded: number;
  pending_count: number;
  pending_amount: number;
  generated_at: Date | string;
  booker_name?: string;
  booker_email?: string;
}

/** The day's control totals: each column summed over the rows. Integer cents throughout. */
export function totalsOf(rows: readonly DayReportRow[]): DayReportTotals {
  const totals: DayReportTotals = {
    bookings: 0,
    guests: 0,
    gross: 0,
    discounts: 0,
    fees: 0,
    taxes: 0,
    total: 0,
    refunds: 0,
    net: 0,
    includedTax: 0,
    pendingRefunds: { count: 0, amount: 0 },
  };
  for (const row of rows) {
    totals.bookings += row.bookings;
    totals.guests += row.guests;
    totals.gross += row.gross;
    totals.discounts += row.discounts;
    totals.fees += row.fees;
    totals.taxes += row.taxes;
    totals.total += row.total;
    totals.refunds += row.refunds;
    totals.net += row.net;
    totals.includedTax += row.includedTax;
    totals.pendingRefunds.count += row.pendingRefund.count;
    totals.pendingRefunds.amount += row.pendingRefund.amount;
  }
  return totals;
}

/**
 * Every booking on trips departing on one local date, by departure, trip,
 * and confirmation, with its money and the day's totals. More than `limit`
 * bookings (DAY_REPORT_LIMIT unless a test sets less) is `too_large`.
 */
export async function buildDayReport(
  trx: TenantTransaction,
  tenantId: string,
  query: { date: string; withBooker: boolean; limit?: number },
): Promise<DayReportOutcome> {
  const limit = Math.min(query.limit ?? DAY_REPORT_LIMIT, DAY_REPORT_LIMIT);
  const bookerColumns: RawBuilder<unknown> = query.withBooker
    ? sql`, s.booker_name, s.booker_email`
    : sql``;
  const bookerJoin: RawBuilder<unknown> = query.withBooker
    ? sql`join checkout_sessions s on s.tenant_id = b.tenant_id and s.id = b.checkout_session_id`
    : sql``;
  const { rows } = await sql<ReportRow>`
    select b.id, b.reference, b.state, b.confirmed_at, b.party_size,
           t.id as trip_id, p.name as product_name, p.kind as product_kind,
           bt.name as boat_name, t.time_zone,
           to_char(t.local_date, 'YYYY-MM-DD') as local_date,
           to_char(t.local_start_time, 'HH24:MI') as local_start_time,
           t.starts_at,
           o.subtotal_amount, o.discount_amount, o.fee_amount, o.tax_amount,
           o.included_tax_amount, o.total_amount,
           pay.state as payment_state,
           rf.refund_state, rf.refunded, rf.pending_count, rf.pending_amount,
           statement_timestamp() as generated_at
           ${bookerColumns}
      from bookings b
      join scheduled_trips t on t.tenant_id = b.tenant_id and t.id = b.trip_id
      join products p on p.tenant_id = t.tenant_id and p.id = t.product_id
      join boats bt on bt.tenant_id = t.tenant_id and bt.id = t.boat_id
      join orders o on o.tenant_id = b.tenant_id and o.id = b.order_id
      join payments pay on pay.tenant_id = b.tenant_id and pay.id = b.payment_id
      cross join lateral (
        select (array_agg(r.state order by r.created_at desc, r.id desc))[1] as refund_state,
               coalesce(sum(r.amount) filter (where r.state = 'succeeded'), 0)::int as refunded,
               count(*) filter (where r.state = 'requested')::int as pending_count,
               coalesce(sum(r.amount) filter (where r.state = 'requested'), 0)::int as pending_amount
          from payment_refunds r
         where r.tenant_id = b.tenant_id and r.payment_id = b.payment_id
      ) rf
      ${bookerJoin}
     where b.tenant_id = ${tenantId} and t.local_date = ${query.date}::date
     order by t.starts_at, t.id, b.confirmed_at, b.id
     limit ${limit + 1}`.execute(trx);
  if (rows.length > limit) return { kind: "too_large" };

  const reportRows = rows.map((r): DayReportRow => {
    const total = r.total_amount;
    return {
      bookingId: r.id,
      reference: r.reference,
      state: r.state,
      confirmedAt: iso(r.confirmed_at),
      trip: {
        tripId: r.trip_id,
        productName: r.product_name,
        productKind: r.product_kind,
        boatName: r.boat_name,
        timeZone: r.time_zone,
        localDate: r.local_date,
        localStartTime: r.local_start_time,
        startsAt: iso(r.starts_at),
      },
      // A canceled booking keeps its money (its order and its refunds), and
      // leaves the counts, as the day list's counts do.
      bookings: r.state === "canceled" ? 0 : 1,
      guests: r.state === "canceled" ? 0 : r.party_size,
      gross: r.subtotal_amount,
      discounts: r.discount_amount,
      fees: r.fee_amount,
      taxes: r.tax_amount,
      total,
      refunds: r.refunded,
      net: total - r.refunded,
      includedTax: r.included_tax_amount,
      paymentState: r.payment_state,
      refundState: r.refund_state,
      pendingRefund: { count: r.pending_count, amount: r.pending_amount },
      ...(query.withBooker && r.booker_name !== undefined && r.booker_email !== undefined
        ? { booker: { name: r.booker_name, email: r.booker_email } }
        : {}),
    };
  });
  // With no bookings the statement returns no row, so the time is read apart.
  const generatedAt =
    rows[0]?.generated_at ??
    (await sql<{ at: Date | string }>`select statement_timestamp() as at`.execute(trx)).rows[0]
      ?.at ??
    new Date();
  return {
    kind: "ok",
    report: {
      date: query.date,
      generatedAt: iso(generatedAt),
      rows: reportRows,
      totals: totalsOf(reportRows),
    },
  };
}
