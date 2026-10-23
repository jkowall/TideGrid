/**
 * The booking facts a waiver shows: the operator, the trip, when and where it
 * leaves, and the booking reference. Read-only, under the caller's tenant
 * transaction, with the tenant named in the query.
 */
import { isUuid, type TenantTransaction } from "@tidegrid/database";
import { sql } from "kysely";
import { formatInstant } from "./format.ts";

export interface BookingContext {
  bookingId: string;
  reference: string;
  state: string;
  tripId: string;
  productId: string;
  productName: string;
  startsAt: Date;
  endsAt: Date;
  timeZone: string;
  locationName: string;
  operatorName: string;
}

export async function loadBookingContext(
  trx: TenantTransaction,
  tenantId: string,
  bookingId: string,
): Promise<BookingContext | null> {
  if (!isUuid(bookingId)) return null;
  const { rows } = await sql<{
    reference: string;
    state: string;
    trip_id: string;
    product_id: string;
    product_name: string;
    starts_at: Date;
    ends_at: Date;
    time_zone: string;
    location_name: string;
    operator_name: string;
  }>`
    select b.reference, b.state, b.trip_id, p.id as product_id, p.name as product_name,
           t.starts_at, t.ends_at, t.time_zone, l.name as location_name,
           tn.display_name as operator_name
      from bookings b
      join scheduled_trips t on t.tenant_id = b.tenant_id and t.id = b.trip_id
      join products p on p.tenant_id = t.tenant_id and p.id = t.product_id
      join locations l on l.tenant_id = p.tenant_id and l.id = p.location_id
      join tenants tn on tn.id = b.tenant_id
     where b.tenant_id = ${tenantId} and b.id = ${bookingId}`.execute(trx);
  const row = rows[0];
  if (!row) return null;
  return {
    bookingId,
    reference: row.reference,
    state: row.state,
    tripId: row.trip_id,
    productId: row.product_id,
    productName: row.product_name,
    startsAt: row.starts_at,
    endsAt: row.ends_at,
    timeZone: row.time_zone,
    locationName: row.location_name,
    operatorName: row.operator_name,
  };
}

/** The trip as the email, the signing page, and the PDF describe it. */
export function tripFacts(booking: BookingContext) {
  return {
    name: booking.productName,
    when: formatInstant(booking.startsAt, booking.timeZone),
    place: booking.locationName,
    bookingReference: booking.reference,
  };
}

/**
 * Whether the booking's trip has ended by the database clock, as the evidence
 * trigger judges it: a waiver is signed, and a link opens, only before then.
 */
export async function tripIsOver(
  trx: TenantTransaction,
  tenantId: string,
  bookingId: string,
): Promise<boolean> {
  const { rows } = await sql<{ over: boolean }>`
    select t.ends_at <= now() as over
      from bookings b join scheduled_trips t on t.tenant_id = b.tenant_id and t.id = b.trip_id
     where b.tenant_id = ${tenantId} and b.id = ${bookingId}`.execute(trx);
  return rows[0]?.over === true;
}
