/**
 * Staff reads (G2.7): a trip's bookings and the finalization exceptions that
 * need an operator. Read-only, under the caller's tenant transaction.
 */
import {
  type FinalizationReason,
  isUuid,
  type OrderStatus,
  type PaymentProviderName,
  type PaymentState,
  type RefundState,
  type TenantTransaction,
} from "@tidegrid/database";
import { sql } from "kysely";
import { iso, isoOrNull } from "./views.ts";

export interface StaffBooking {
  id: string;
  reference: string;
  tripId: string;
  partySize: number;
  state: "confirmed";
  source: "direct";
  reacquired: boolean;
  confirmedAt: string;
  booker: { name: string; email: string };
  order: { id: string; status: OrderStatus; total: number; currency: "USD" };
  payment: { id: string; provider: PaymentProviderName; state: PaymentState; amount: number };
}

/** Every booking on one trip, oldest first. Null when the trip is not this tenant's. */
export async function listTripBookings(
  trx: TenantTransaction,
  tenantId: string,
  tripId: string,
): Promise<StaffBooking[] | null> {
  if (!isUuid(tripId)) return null;
  const trip = await trx
    .selectFrom("scheduled_trips")
    .select("id")
    .where("tenant_id", "=", tenantId)
    .where("id", "=", tripId)
    .executeTakeFirst();
  if (!trip) return null;
  const { rows } = await sql<{
    id: string;
    reference: string;
    trip_id: string;
    party_size: number;
    reacquired: boolean;
    confirmed_at: Date | string;
    booker_name: string;
    booker_email: string;
    order_id: string;
    order_status: OrderStatus;
    total_amount: number;
    payment_id: string;
    provider: PaymentProviderName;
    payment_state: PaymentState;
    amount: number;
  }>`
    select b.id, b.reference, b.trip_id, b.party_size, b.reacquired, b.confirmed_at,
           s.booker_name, s.booker_email,
           o.id as order_id, o.status as order_status, o.total_amount,
           p.id as payment_id, p.provider, p.state as payment_state, p.amount
      from bookings b
      join checkout_sessions s on s.tenant_id = b.tenant_id and s.id = b.checkout_session_id
      join orders o on o.tenant_id = b.tenant_id and o.id = b.order_id
      join payments p on p.tenant_id = b.tenant_id and p.id = b.payment_id
     where b.tenant_id = ${tenantId} and b.trip_id = ${tripId}
     order by b.confirmed_at, b.id`.execute(trx);
  return rows.map((r) => ({
    id: r.id,
    reference: r.reference,
    tripId: r.trip_id,
    partySize: r.party_size,
    state: "confirmed" as const,
    source: "direct" as const,
    reacquired: r.reacquired,
    confirmedAt: iso(r.confirmed_at),
    booker: { name: r.booker_name, email: r.booker_email },
    order: { id: r.order_id, status: r.order_status, total: r.total_amount, currency: "USD" },
    payment: { id: r.payment_id, provider: r.provider, state: r.payment_state, amount: r.amount },
  }));
}

export interface FinalizationExceptionView {
  id: string;
  reason: FinalizationReason;
  checkoutSessionId: string;
  tripId: string;
  paymentId: string;
  amount: number;
  createdAt: string;
  refund: {
    id: string;
    state: RefundState;
    amount: number;
    failureCode: string | null;
    settledAt: string | null;
  } | null;
}

/** The newest exceptions first, up to `limit`. */
export async function listFinalizationExceptions(
  trx: TenantTransaction,
  tenantId: string,
  options: { limit: number },
): Promise<FinalizationExceptionView[]> {
  const { rows } = await sql<{
    id: string;
    reason: FinalizationReason;
    checkout_session_id: string;
    trip_id: string;
    payment_id: string;
    amount: number;
    created_at: Date | string;
    refund_id: string | null;
    refund_state: RefundState | null;
    refund_amount: number | null;
    failure_code: string | null;
    settled_at: Date | string | null;
  }>`
    select e.id, e.reason, e.checkout_session_id, s.trip_id, e.payment_id, p.amount,
           e.created_at, r.id as refund_id, r.state as refund_state, r.amount as refund_amount,
           r.failure_code, r.settled_at
      from finalization_exceptions e
      join checkout_sessions s on s.tenant_id = e.tenant_id and s.id = e.checkout_session_id
      join payments p on p.tenant_id = e.tenant_id and p.id = e.payment_id
      left join payment_refunds r on r.tenant_id = e.tenant_id and r.id = e.refund_id
     where e.tenant_id = ${tenantId}
     order by e.created_at desc, e.id
     limit ${options.limit}`.execute(trx);
  return rows.map((r) => ({
    id: r.id,
    reason: r.reason,
    checkoutSessionId: r.checkout_session_id,
    tripId: r.trip_id,
    paymentId: r.payment_id,
    amount: r.amount,
    createdAt: iso(r.created_at),
    refund:
      r.refund_id && r.refund_state && r.refund_amount !== null
        ? {
            id: r.refund_id,
            state: r.refund_state,
            amount: r.refund_amount,
            failureCode: r.failure_code,
            settledAt: isoOrNull(r.settled_at),
          }
        : null,
  }));
}
