/**
 * A private charter's balance, as staff and the guest see it (W3-G2.8). The
 * database computes what came in and what is owed (`app.booking_balance`,
 * 0033); this adds the state the guest and the operator both read, from the
 * database clock, so the two never disagree.
 *
 * States, for a booking with a balance:
 * - `paid`: nothing is owed;
 * - `scheduled`: owed, and the first reminder has not come yet;
 * - `due`: owed, within the reminder window before the due date;
 * - `overdue`: owed, and the due date has passed. Nothing cancels the booking:
 *   staff decide;
 * - `canceled`: the booking was canceled; nothing more is asked.
 */
import type { BalancePaymentState, TenantTransaction } from "@tidegrid/database";
import { BALANCE_REMINDER_LEAD_DAYS } from "@tidegrid/domain-messaging";
import { sql } from "kysely";
import { iso, isoOrNull } from "./views.ts";

export type BalanceState = "paid" | "scheduled" | "due" | "overdue" | "canceled";

/** A booking's balance is due within this many days of its due date: the first reminder's lead. */
export const BALANCE_DUE_WINDOW_DAYS = Math.max(...BALANCE_REMINDER_LEAD_DAYS);

export interface BalancePaymentView {
  id: string;
  amount: number;
  state: BalancePaymentState;
  createdAt: string;
  succeededAt: string | null;
}

export interface BalanceDueChangeView {
  dueAt: string;
  /** Staff's reason; null for a reader who may not see free text that could name the guest. */
  reason: string | null;
  changedAt: string;
}

export interface BalanceView {
  state: BalanceState;
  currency: "USD";
  /** The booking's total. */
  total: number;
  /** The deposit charged at checkout. */
  deposit: number;
  /** Money that came in: the deposit paid, balance payments, and external payments. */
  paidIn: number;
  /** What is left to pay; zero once paid. */
  owed: number;
  /** Money in above the total, when the guest paid twice; staff return it. */
  overpaid: number;
  /** When the balance is due: the newest staff change, else the booking's own. */
  dueAt: string;
  /** The due date the booking was made with. */
  originalDueAt: string;
  /** Card payments of the balance, oldest first. */
  payments: BalancePaymentView[];
  /** Staff moves of the due date, oldest first. */
  dueChanges: BalanceDueChangeView[];
}

interface BalanceRow {
  total_amount: number;
  deposit_amount: number;
  due_at: Date | string;
  original_due_at: Date | string;
  paid_in: string;
  owed: string;
  canceled: boolean;
  overdue: boolean;
  in_window: boolean;
}

/**
 * The balance of one booking, or null when it paid in full at checkout (or is
 * not this tenant's). `withReasons` shows staff reasons for moving the due
 * date; a reader without booking access gets null in their place.
 */
export async function getBookingBalance(
  trx: TenantTransaction,
  tenantId: string,
  bookingId: string,
  options: { withReasons: boolean } = { withReasons: true },
): Promise<BalanceView | null> {
  const { rows } = await sql<BalanceRow>`
    select x.total_amount, x.deposit_amount, x.due_at, x.original_due_at,
           x.paid_in::text as paid_in, x.owed::text as owed,
           b.state = 'canceled' as canceled,
           now() >= x.due_at as overdue,
           now() >= x.due_at - make_interval(hours => ${BALANCE_DUE_WINDOW_DAYS * 24}) as in_window
      from bookings b
      cross join lateral app.booking_balance(b.tenant_id, b.id) x
     where b.tenant_id = ${tenantId} and b.id = ${bookingId}`.execute(trx);
  const row = rows[0];
  if (!row) return null;
  const paidIn = Number(row.paid_in);
  const owed = Number(row.owed);
  const { rows: payments } = await sql<{
    id: string;
    amount: number;
    state: BalancePaymentState;
    created_at: Date | string;
    succeeded_at: Date | string | null;
  }>`
    select id, amount, state, created_at, succeeded_at from balance_payments
     where tenant_id = ${tenantId} and booking_id = ${bookingId}
     order by created_at, id`.execute(trx);
  const { rows: changes } = await sql<{
    due_at: Date | string;
    reason: string;
    created_at: Date | string;
  }>`
    select due_at, reason, created_at from balance_due_changes
     where tenant_id = ${tenantId} and booking_id = ${bookingId}
     order by created_at, id`.execute(trx);
  const state: BalanceState = row.canceled
    ? "canceled"
    : owed <= 0
      ? "paid"
      : row.overdue
        ? "overdue"
        : row.in_window
          ? "due"
          : "scheduled";
  return {
    state,
    currency: "USD",
    total: row.total_amount,
    deposit: row.deposit_amount,
    paidIn,
    owed: row.canceled ? 0 : owed,
    overpaid: Math.max(0, paidIn - row.total_amount),
    dueAt: iso(row.due_at),
    originalDueAt: iso(row.original_due_at),
    payments: payments.map((p) => ({
      id: p.id,
      amount: p.amount,
      state: p.state,
      createdAt: iso(p.created_at),
      succeededAt: isoOrNull(p.succeeded_at),
    })),
    dueChanges: changes.map((c) => ({
      dueAt: iso(c.due_at),
      reason: options.withReasons ? c.reason : null,
      changedAt: iso(c.created_at),
    })),
  };
}
