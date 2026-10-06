/**
 * Staff reads (G2.7): a trip's bookings and the finalization exceptions that
 * need an operator. Read-only, under the caller's tenant transaction.
 */
import {
  isUuid,
  type OrderStatus,
  type PaymentProviderName,
  type PaymentState,
  type TenantTransaction,
} from "@tidegrid/database";
import { sql } from "kysely";
import { type ConsoleExceptionView, listExceptionsPage } from "./console.ts";
import { iso } from "./views.ts";

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

/**
 * The newest exceptions first, up to `limit`, with no personal data: the G2.7
 * read, kept for its callers. The console's paged read is
 * `listExceptionsPage` (console.ts), which this delegates to.
 */
export type FinalizationExceptionView = ConsoleExceptionView;

export async function listFinalizationExceptions(
  trx: TenantTransaction,
  tenantId: string,
  options: { limit: number },
): Promise<FinalizationExceptionView[]> {
  const page = await listExceptionsPage(trx, tenantId, {
    limit: options.limit,
    withBooker: false,
  });
  if (page.kind !== "ok") throw new Error("an exceptions read without a cursor cannot fail");
  return page.exceptions;
}
