/**
 * Staff reads (G2.7): a trip's bookings and the finalization exceptions that
 * need an operator. Read-only, under the caller's tenant transaction.
 */
import {
  type BookingSource,
  type BookingState,
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
  /** Canceled since lane 1 (G2.11c): a guest's cancellation within policy. */
  state: BookingState;
  /** Stamped from the checkout (G2.12d). */
  source: BookingSource;
  reacquired: boolean;
  confirmedAt: string;
  booker: { name: string; email: string };
  order: { id: string; status: OrderStatus; total: number; currency: "USD" };
  /** Null on a complimentary booking, which has no payment (0039). */
  payment: {
    id: string;
    provider: PaymentProviderName;
    state: PaymentState;
    amount: number;
  } | null;
}

/** Largest page of a trip's bookings a caller may ask for. */
export const MAX_TRIP_BOOKINGS_PAGE = 200;

export type TripBookingsPage =
  | {
      kind: "ok";
      bookings: StaffBooking[];
      /** The last booking's id when more follow; pass it back as `after`. Null on the last page. */
      nextAfter: string | null;
    }
  /** The cursor names no booking on this trip of this tenant. */
  | { kind: "cursor_invalid" };

interface StaffBookingRow {
  id: string;
  reference: string;
  trip_id: string;
  state: BookingState;
  source: BookingSource;
  party_size: number;
  reacquired: boolean;
  confirmed_at: Date | string;
  booker_name: string;
  booker_email: string;
  order_id: string;
  order_status: OrderStatus;
  total_amount: number;
  payment_id: string | null;
  provider: PaymentProviderName | null;
  payment_state: PaymentState | null;
  amount: number | null;
}

function toStaffBooking(r: StaffBookingRow): StaffBooking {
  return {
    id: r.id,
    reference: r.reference,
    tripId: r.trip_id,
    partySize: r.party_size,
    state: r.state,
    source: r.source,
    reacquired: r.reacquired,
    confirmedAt: iso(r.confirmed_at),
    booker: { name: r.booker_name, email: r.booker_email },
    order: { id: r.order_id, status: r.order_status, total: r.total_amount, currency: "USD" },
    payment:
      r.payment_id !== null && r.provider !== null && r.payment_state !== null && r.amount !== null
        ? { id: r.payment_id, provider: r.provider, state: r.payment_state, amount: r.amount }
        : null,
  };
}

async function tripExists(trx: TenantTransaction, tenantId: string, tripId: string) {
  const trip = await trx
    .selectFrom("scheduled_trips")
    .select("id")
    .where("tenant_id", "=", tenantId)
    .where("id", "=", tripId)
    .executeTakeFirst();
  return trip !== undefined;
}

/**
 * One trip's bookings, oldest first, from the cursor on, at most `limit` of
 * them when one is given. The caller has checked the trip.
 */
async function tripBookingRows(
  trx: TenantTransaction,
  tenantId: string,
  tripId: string,
  page: { limit: number; after?: string | undefined } | null,
): Promise<StaffBookingRow[]> {
  const cursor =
    page?.after === undefined
      ? sql``
      : sql`and (b.confirmed_at, b.id) > (
              select c.confirmed_at, c.id from bookings c
               where c.tenant_id = ${tenantId} and c.trip_id = ${tripId}
                 and c.id = ${page.after}::uuid)`;
  const limit = page === null ? sql`` : sql`limit ${page.limit + 1}`;
  const { rows } = await sql<StaffBookingRow>`
    select b.id, b.reference, b.trip_id, b.state, b.source, b.party_size, b.reacquired, b.confirmed_at,
           s.booker_name, s.booker_email,
           o.id as order_id, o.status as order_status, o.total_amount,
           p.id as payment_id, p.provider, p.state as payment_state, p.amount
      from bookings b
      join checkout_sessions s on s.tenant_id = b.tenant_id and s.id = b.checkout_session_id
      join orders o on o.tenant_id = b.tenant_id and o.id = b.order_id
      left join payments p on p.tenant_id = b.tenant_id and p.id = b.payment_id
     where b.tenant_id = ${tenantId} and b.trip_id = ${tripId}
       ${cursor}
     order by b.confirmed_at, b.id
     ${limit}`.execute(trx);
  return rows;
}

/**
 * Every booking on one trip, oldest first, in one read with no bound. Null
 * when the trip is not this tenant's. The staff route reads
 * `listTripBookingsPage` instead.
 */
export async function listTripBookings(
  trx: TenantTransaction,
  tenantId: string,
  tripId: string,
): Promise<StaffBooking[] | null> {
  if (!isUuid(tripId)) return null;
  if (!(await tripExists(trx, tenantId, tripId))) return null;
  return (await tripBookingRows(trx, tenantId, tripId, null)).map(toStaffBooking);
}

/**
 * One page of a trip's bookings, canceled ones included, oldest first: by
 * confirmation time, then id. Null when the trip is not this tenant's. The
 * cursor is the last booking id of the previous page and must name a booking
 * on this trip; its position is read in SQL, so the database's own precision
 * orders the page. A booking's confirmation time never changes and bookings
 * are never deleted, so a cursor stays valid and pages never repeat a
 * booking. The confirmation time is now(), the start of the confirming
 * transaction, so a booking whose transaction began before a page was read
 * and committed after it can land before that page's cursor. Read again
 * from the first page to see every booking. Run it in one snapshot
 * (`snapshotRead`) so the cursor check and the page agree.
 */
export async function listTripBookingsPage(
  trx: TenantTransaction,
  tenantId: string,
  tripId: string,
  page: { limit: number; after?: string | undefined },
): Promise<TripBookingsPage | null> {
  if (!Number.isInteger(page.limit) || page.limit < 1 || page.limit > MAX_TRIP_BOOKINGS_PAGE) {
    throw new RangeError(`limit must be a whole number from 1 to ${MAX_TRIP_BOOKINGS_PAGE}`);
  }
  if (!isUuid(tripId)) return null;
  if (!(await tripExists(trx, tenantId, tripId))) return null;
  if (page.after !== undefined) {
    if (!isUuid(page.after)) return { kind: "cursor_invalid" };
    const { rows: found } = await sql<{ id: string }>`
      select id from bookings
       where tenant_id = ${tenantId} and trip_id = ${tripId} and id = ${page.after}::uuid`.execute(
      trx,
    );
    if (!found[0]) return { kind: "cursor_invalid" };
  }
  const rows = await tripBookingRows(trx, tenantId, tripId, page);
  const bookings = rows.slice(0, page.limit).map(toStaffBooking);
  return {
    kind: "ok",
    bookings,
    nextAfter: rows.length > page.limit ? (bookings.at(-1)?.id ?? null) : null,
  };
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
