/**
 * Console reads (G2.12b): a day's bookings, one booking in detail, a lookup
 * by reference, a trip's roster, and the finalization exceptions page.
 * Read-only, under the caller's tenant transaction. Every query names its
 * tenant explicitly; row-level security is the backstop.
 *
 * The booker's name and email are personal data. A read selects them only
 * when the caller says the role may see them (`withBooker`), so a view for
 * any other role never holds them, not even in memory. Nothing here returns a
 * checkout secret's hash, a client key, an idempotency key, a payload hash,
 * or a provider's raw payload, and provider payment ids leave masked.
 */
import {
  type ChargeBasis,
  type CheckoutSessionState,
  type FinalizationReason,
  isUuid,
  type OrderLineKind,
  type OrderStatus,
  type PaymentProviderName,
  type PaymentState,
  type ProductKind,
  type RefundState,
  type TenantTransaction,
  type TripSalesState,
} from "@tidegrid/database";
import { type RawBuilder, sql } from "kysely";
import { iso, isoOrNull } from "./views.ts";

// Views ------------------------------------------------------------------------------

export interface TicketCountView {
  code: string;
  name: string;
  quantity: number;
}

export type PartyView =
  | { kind: "tickets"; guests: number; tickets: TicketCountView[] }
  | { kind: "charter"; guests: number; charter: string };

export interface ExtraView {
  code: string;
  name: string;
  quantity: number;
}

export interface PaymentStatusView {
  state: PaymentState;
  refund: { state: RefundState; amount: number } | null;
}

export interface TripSummaryView {
  tripId: string;
  productName: string;
  productKind: ProductKind;
  boatName: string;
  timeZone: string;
  localDate: string;
  localStartTime: string;
  startsAt: string;
  salesState: TripSalesState;
}

export interface DayTripView extends TripSummaryView {
  bookings: number;
  guests: number;
}

export interface DayBookingView {
  id: string;
  reference: string;
  tripId: string;
  state: "confirmed";
  source: "direct";
  confirmedAt: string;
  booker?: { name: string };
  party: PartyView;
  extras: ExtraView[];
  total: number;
  currency: "USD";
  payment: PaymentStatusView;
}

export interface TripTimingView extends TripSummaryView {
  endsAt: string;
  endsAtLocal: string;
  durationMinutes: number;
}

export interface LocationView {
  name: string;
  meetingPoint: string;
  meetingInstructions: string;
}

export interface OrderLineView {
  lineNo: number;
  kind: OrderLineKind;
  code: string;
  name: string;
  basis: ChargeBasis | null;
  quantity: number;
  unitAmount: number;
  amount: number;
  taxInclusive: boolean | null;
}

export type TimelineKind =
  | "checkout_opened"
  | "paid"
  | "confirmed"
  | "refund_requested"
  | "refunded"
  | "refund_failed";

export interface BookingDetailView {
  id: string;
  reference: string;
  state: "confirmed";
  source: "direct";
  reacquired: boolean;
  confirmedAt: string;
  trip: TripTimingView;
  location: LocationView;
  booker?: { name: string; email: string };
  party: PartyView;
  extras: ExtraView[];
  policyVersion: number;
  order: {
    id: string;
    status: OrderStatus;
    currency: "USD";
    lines: OrderLineView[];
    totals: {
      subtotal: number;
      discount: number;
      fees: number;
      tax: number;
      includedTax: number;
      total: number;
    };
  };
  payment: {
    provider: PaymentProviderName;
    state: PaymentState;
    amount: number;
    currency: "USD";
    providerReference: string | null;
    createdAt: string;
    succeededAt: string | null;
  };
  refund: {
    state: RefundState;
    amount: number;
    failureCode: string | null;
    requestedAt: string;
    settledAt: string | null;
  } | null;
  timeline: { kind: TimelineKind; at: string }[];
}

export interface RosterView {
  generatedAt: string;
  trip: TripTimingView & { seats: number };
  location: LocationView;
  totals: {
    bookings: number;
    guests: number;
    tickets: TicketCountView[];
    extras: ExtraView[];
  };
  bookings: {
    id: string;
    reference: string;
    booker: { name: string };
    party: PartyView;
    extras: ExtraView[];
    payment: PaymentStatusView;
  }[];
}

export interface ConsoleExceptionView {
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
  trip: TripSummaryView;
  partySize: number;
  checkout: { state: CheckoutSessionState; expiresAt: string };
  payment: {
    provider: PaymentProviderName;
    providerReference: string | null;
    receivedAt: string;
    reportedAmount: number | null;
    reportedCurrency: string | null;
  };
  booker?: { name: string; email: string };
}

// Pure helpers -----------------------------------------------------------------------

const MASK = "••••";

/**
 * A provider's payment or refund id, masked for display: its prefix up to the
 * first underscore and, when enough is left to stay unguessable, its last
 * four characters ("fpay_••••a1B2", "pi_••••Xy9Z"). Enough to match a
 * provider dashboard by eye; not the id itself.
 */
export function maskProviderReference(ref: string | null): string | null {
  if (ref === null || ref.length === 0) return null;
  const underscore = ref.indexOf("_");
  const prefix = underscore > 0 && underscore <= 8 ? ref.slice(0, underscore + 1) : "";
  const rest = ref.slice(prefix.length);
  return rest.length >= 12 ? `${prefix}${MASK}${rest.slice(-4)}` : `${prefix}${MASK}`;
}

interface LineRow {
  order_id: string;
  kind: OrderLineKind;
  code: string;
  name: string;
  quantity: number;
}

/**
 * Who is coming, from an order's service lines: one line per ticket type on
 * a shared-seat trip, or the one charter line on a private charter.
 */
export function partyOf(
  kind: ProductKind,
  guests: number,
  serviceLines: readonly Pick<LineRow, "code" | "name" | "quantity">[],
): PartyView {
  if (kind === "private_charter") {
    return { kind: "charter", guests, charter: serviceLines[0]?.name ?? "Private charter" };
  }
  return {
    kind: "tickets",
    guests,
    tickets: serviceLines.map(({ code, name, quantity }) => ({ code, name, quantity })),
  };
}

/** Paid add-ons, from an order's add-on lines. */
export function extrasOf(addOnLines: readonly Pick<LineRow, "code" | "name" | "quantity">[]) {
  return addOnLines.map(({ code, name, quantity }) => ({ code, name, quantity }));
}

/** Counts summed by code, in the order each code first appears. */
export function sumByCode<T extends { code: string; name: string; quantity: number }>(
  items: readonly T[],
): { code: string; name: string; quantity: number }[] {
  const out = new Map<string, { code: string; name: string; quantity: number }>();
  for (const item of items) {
    const seen = out.get(item.code);
    if (seen) seen.quantity += item.quantity;
    else out.set(item.code, { code: item.code, name: item.name, quantity: item.quantity });
  }
  return [...out.values()];
}

/** RFC 3339 local time with its offset, from an instant and the stored offset. */
export function offsetDateTime(instant: Date | string, offsetMinutes: number): string {
  const ms = (typeof instant === "string" ? new Date(instant) : instant).getTime();
  const local = new Date(ms + offsetMinutes * 60_000).toISOString();
  const sign = offsetMinutes < 0 ? "-" : "+";
  const abs = Math.abs(offsetMinutes);
  const hh = String(Math.floor(abs / 60)).padStart(2, "0");
  const mm = String(abs % 60).padStart(2, "0");
  return `${local.slice(0, 19)}${sign}${hh}:${mm}`;
}

function paymentStatus(row: {
  payment_state: PaymentState;
  refund_state: RefundState | null;
  refund_amount: number | null;
}): PaymentStatusView {
  return {
    state: row.payment_state,
    refund:
      row.refund_state && row.refund_amount !== null
        ? { state: row.refund_state, amount: row.refund_amount }
        : null,
  };
}

// Shared SQL -----------------------------------------------------------------------------

/** A trip's summary columns; `t` is the trip, `p` its product, `bt` its boat. */
const tripColumns = sql`
  t.id as trip_id, p.name as product_name, p.kind as product_kind, bt.name as boat_name,
  t.time_zone, to_char(t.local_date, 'YYYY-MM-DD') as local_date,
  to_char(t.local_start_time, 'HH24:MI') as local_start_time,
  t.starts_at, t.sales_state`;

const tripJoins = sql`
  join products p on p.tenant_id = t.tenant_id and p.id = t.product_id
  join boats bt on bt.tenant_id = t.tenant_id and bt.id = t.boat_id`;

interface TripRow {
  trip_id: string;
  product_name: string;
  product_kind: ProductKind;
  boat_name: string;
  time_zone: string;
  local_date: string;
  local_start_time: string;
  starts_at: Date | string;
  sales_state: TripSalesState;
}

function tripSummary(row: TripRow): TripSummaryView {
  return {
    tripId: row.trip_id,
    productName: row.product_name,
    productKind: row.product_kind,
    boatName: row.boat_name,
    timeZone: row.time_zone,
    localDate: row.local_date,
    localStartTime: row.local_start_time,
    startsAt: iso(row.starts_at),
    salesState: row.sales_state,
  };
}

interface TimingRow extends TripRow {
  ends_at: Date | string;
  end_utc_offset_minutes: number;
  duration_minutes: number;
}

function tripTiming(row: TimingRow): TripTimingView {
  return {
    ...tripSummary(row),
    endsAt: iso(row.ends_at),
    endsAtLocal: offsetDateTime(row.ends_at, row.end_utc_offset_minutes),
    durationMinutes: row.duration_minutes,
  };
}

/** Service and add-on lines of some orders, grouped by order, in line order. */
async function partyLines(
  trx: TenantTransaction,
  tenantId: string,
  orderIds: readonly string[],
): Promise<Map<string, { service: LineRow[]; addOns: LineRow[] }>> {
  const byOrder = new Map<string, { service: LineRow[]; addOns: LineRow[] }>();
  if (orderIds.length === 0) return byOrder;
  const { rows } = await sql<LineRow>`
    select l.order_id, l.kind, l.code, l.name, l.quantity
      from order_lines l
     where l.tenant_id = ${tenantId}
       and l.order_id in (${sql.join(orderIds.map((id) => sql`${id}::uuid`))})
       and l.kind in ('service', 'add_on')
     order by l.order_id, l.line_no`.execute(trx);
  for (const row of rows) {
    let entry = byOrder.get(row.order_id);
    if (!entry) {
      entry = { service: [], addOns: [] };
      byOrder.set(row.order_id, entry);
    }
    (row.kind === "service" ? entry.service : entry.addOns).push(row);
  }
  return byOrder;
}

const empty = { service: [] as LineRow[], addOns: [] as LineRow[] };

// A day's bookings -------------------------------------------------------------------------

export const DAY_TRIPS_LIMIT = 200;

export type DayBookingsResult =
  | { kind: "ok"; trips: DayTripView[]; bookings: DayBookingView[]; nextAfter: string | null }
  | { kind: "cursor_invalid" };

/**
 * Bookings on trips departing on one local date, by departure and then by
 * confirmation, a page at a time, with every trip of that date and its counts.
 * The cursor is the last booking id of the previous page; its position is
 * read in SQL, so the database's own precision orders the page.
 */
export async function listDayBookings(
  trx: TenantTransaction,
  tenantId: string,
  query: { date: string; tripId?: string; limit: number; after?: string; withBooker: boolean },
): Promise<DayBookingsResult> {
  if (query.after !== undefined) {
    if (!isUuid(query.after)) return { kind: "cursor_invalid" };
    const found = await trx
      .selectFrom("bookings")
      .select("id")
      .where("tenant_id", "=", tenantId)
      .where("id", "=", query.after)
      .executeTakeFirst();
    if (!found) return { kind: "cursor_invalid" };
  }
  const { rows: tripRows } = await sql<TripRow & { bookings: number; guests: number }>`
    select ${tripColumns},
           count(b.id)::int as bookings, coalesce(sum(b.party_size), 0)::int as guests
      from scheduled_trips t
      ${tripJoins}
      left join bookings b on b.tenant_id = t.tenant_id and b.trip_id = t.id
     where t.tenant_id = ${tenantId} and t.local_date = ${query.date}::date
     group by t.id, p.name, p.kind, bt.name
     order by t.starts_at, t.id
     limit ${DAY_TRIPS_LIMIT}`.execute(trx);

  const tripFilter =
    query.tripId === undefined
      ? sql``
      : isUuid(query.tripId)
        ? sql`and b.trip_id = ${query.tripId}::uuid`
        : sql`and false`;
  const cursor =
    query.after === undefined
      ? sql``
      : sql`and (t.starts_at, t.id, b.confirmed_at, b.id) > (
              select t2.starts_at, t2.id, b2.confirmed_at, b2.id
                from bookings b2
                join scheduled_trips t2 on t2.tenant_id = b2.tenant_id and t2.id = b2.trip_id
               where b2.tenant_id = ${tenantId} and b2.id = ${query.after}::uuid)`;
  const bookerColumn: RawBuilder<unknown> = query.withBooker ? sql`, s.booker_name` : sql``;
  const bookerJoin: RawBuilder<unknown> = query.withBooker
    ? sql`join checkout_sessions s on s.tenant_id = b.tenant_id and s.id = b.checkout_session_id`
    : sql``;
  const { rows } = await sql<{
    id: string;
    reference: string;
    trip_id: string;
    party_size: number;
    confirmed_at: Date | string;
    product_kind: ProductKind;
    order_id: string;
    total_amount: number;
    payment_state: PaymentState;
    refund_state: RefundState | null;
    refund_amount: number | null;
    booker_name?: string;
  }>`
    select b.id, b.reference, b.trip_id, b.party_size, b.confirmed_at, p.kind as product_kind,
           o.id as order_id, o.total_amount,
           pay.state as payment_state, r.state as refund_state, r.amount as refund_amount
           ${bookerColumn}
      from bookings b
      join scheduled_trips t on t.tenant_id = b.tenant_id and t.id = b.trip_id
      join products p on p.tenant_id = t.tenant_id and p.id = t.product_id
      join orders o on o.tenant_id = b.tenant_id and o.id = b.order_id
      join payments pay on pay.tenant_id = b.tenant_id and pay.id = b.payment_id
      left join payment_refunds r on r.tenant_id = b.tenant_id and r.payment_id = b.payment_id
      ${bookerJoin}
     where b.tenant_id = ${tenantId} and t.local_date = ${query.date}::date
       ${tripFilter}
       ${cursor}
     order by t.starts_at, t.id, b.confirmed_at, b.id
     limit ${query.limit + 1}`.execute(trx);

  const page = rows.slice(0, query.limit);
  const lines = await partyLines(
    trx,
    tenantId,
    page.map((r) => r.order_id),
  );
  const bookings = page.map((r): DayBookingView => {
    const own = lines.get(r.order_id) ?? empty;
    return {
      id: r.id,
      reference: r.reference,
      tripId: r.trip_id,
      state: "confirmed",
      source: "direct",
      confirmedAt: iso(r.confirmed_at),
      ...(query.withBooker && r.booker_name !== undefined
        ? { booker: { name: r.booker_name } }
        : {}),
      party: partyOf(r.product_kind, r.party_size, own.service),
      extras: extrasOf(own.addOns),
      total: r.total_amount,
      currency: "USD",
      payment: paymentStatus(r),
    };
  });
  return {
    kind: "ok",
    trips: tripRows.map((row) => ({
      ...tripSummary(row),
      bookings: row.bookings,
      guests: row.guests,
    })),
    bookings,
    nextAfter: rows.length > query.limit ? (page.at(-1)?.id ?? null) : null,
  };
}

// One booking ---------------------------------------------------------------------------------

/** One booking with its order, payment, refund, and timeline. Null when it is not this tenant's. */
export async function getBookingDetail(
  trx: TenantTransaction,
  tenantId: string,
  bookingId: string,
  options: { withBooker: boolean },
): Promise<BookingDetailView | null> {
  if (!isUuid(bookingId)) return null;
  const booker: RawBuilder<unknown> = options.withBooker
    ? sql`s.booker_name, s.booker_email,`
    : sql``;
  const { rows } = await sql<
    TimingRow & {
      id: string;
      reference: string;
      reacquired: boolean;
      confirmed_at: Date | string;
      party_size: number;
      location_name: string;
      meeting_point: string;
      meeting_instructions: string;
      checkout_created_at: Date | string;
      policy_version: number;
      booker_name?: string;
      booker_email?: string;
      order_id: string;
      order_status: OrderStatus;
      subtotal_amount: number;
      discount_amount: number;
      fee_amount: number;
      tax_amount: number;
      included_tax_amount: number;
      total_amount: number;
      provider: PaymentProviderName;
      payment_state: PaymentState;
      payment_amount: number;
      provider_payment_id: string | null;
      payment_created_at: Date | string;
      succeeded_at: Date | string | null;
      refund_state: RefundState | null;
      refund_amount: number | null;
      failure_code: string | null;
      refund_created_at: Date | string | null;
      refund_settled_at: Date | string | null;
    }
  >`
    select b.id, b.reference, b.reacquired, b.confirmed_at, b.party_size,
           ${tripColumns},
           t.ends_at, t.end_utc_offset_minutes, t.duration_minutes,
           l.name as location_name, l.meeting_point, l.meeting_instructions,
           s.created_at as checkout_created_at, s.policy_version,
           ${booker}
           o.id as order_id, o.status as order_status, o.subtotal_amount, o.discount_amount,
           o.fee_amount, o.tax_amount, o.included_tax_amount, o.total_amount,
           pay.provider, pay.state as payment_state, pay.amount as payment_amount,
           pay.provider_payment_id, pay.created_at as payment_created_at, pay.succeeded_at,
           r.state as refund_state, r.amount as refund_amount, r.failure_code,
           r.created_at as refund_created_at, r.settled_at as refund_settled_at
      from bookings b
      join scheduled_trips t on t.tenant_id = b.tenant_id and t.id = b.trip_id
      ${tripJoins}
      join locations l on l.tenant_id = p.tenant_id and l.id = p.location_id
      join checkout_sessions s on s.tenant_id = b.tenant_id and s.id = b.checkout_session_id
      join orders o on o.tenant_id = b.tenant_id and o.id = b.order_id
      join payments pay on pay.tenant_id = b.tenant_id and pay.id = b.payment_id
      left join payment_refunds r on r.tenant_id = b.tenant_id and r.payment_id = b.payment_id
     where b.tenant_id = ${tenantId} and b.id = ${bookingId}::uuid`.execute(trx);
  const row = rows[0];
  if (!row) return null;
  const { rows: lineRows } = await sql<{
    line_no: number;
    kind: OrderLineKind;
    code: string;
    name: string;
    basis: ChargeBasis | null;
    quantity: number;
    unit_amount: number;
    amount: number;
    tax_inclusive: boolean | null;
  }>`
    select line_no, kind, code, name, basis, quantity, unit_amount, amount, tax_inclusive
      from order_lines
     where tenant_id = ${tenantId} and order_id = ${row.order_id}::uuid
     order by line_no`.execute(trx);

  const service = lineRows.filter((l) => l.kind === "service");
  const addOns = lineRows.filter((l) => l.kind === "add_on");
  const refund =
    row.refund_state && row.refund_amount !== null && row.refund_created_at !== null
      ? {
          state: row.refund_state,
          amount: row.refund_amount,
          failureCode: row.failure_code,
          requestedAt: iso(row.refund_created_at),
          settledAt: isoOrNull(row.refund_settled_at),
        }
      : null;
  const timeline: { kind: TimelineKind; at: string }[] = [
    { kind: "checkout_opened", at: iso(row.checkout_created_at) },
  ];
  if (row.succeeded_at !== null) timeline.push({ kind: "paid", at: iso(row.succeeded_at) });
  timeline.push({ kind: "confirmed", at: iso(row.confirmed_at) });
  if (refund) {
    timeline.push({ kind: "refund_requested", at: refund.requestedAt });
    if (refund.settledAt && refund.state !== "requested") {
      timeline.push({
        kind: refund.state === "succeeded" ? "refunded" : "refund_failed",
        at: refund.settledAt,
      });
    }
  }
  return {
    id: row.id,
    reference: row.reference,
    state: "confirmed",
    source: "direct",
    reacquired: row.reacquired,
    confirmedAt: iso(row.confirmed_at),
    trip: tripTiming(row),
    location: {
      name: row.location_name,
      meetingPoint: row.meeting_point,
      meetingInstructions: row.meeting_instructions,
    },
    ...(options.withBooker && row.booker_name !== undefined && row.booker_email !== undefined
      ? { booker: { name: row.booker_name, email: row.booker_email } }
      : {}),
    party: partyOf(row.product_kind, row.party_size, service),
    extras: extrasOf(addOns),
    policyVersion: row.policy_version,
    order: {
      id: row.order_id,
      status: row.order_status,
      currency: "USD",
      lines: lineRows.map((l) => ({
        lineNo: l.line_no,
        kind: l.kind,
        code: l.code,
        name: l.name,
        basis: l.basis,
        quantity: l.quantity,
        unitAmount: l.unit_amount,
        amount: l.amount,
        taxInclusive: l.kind === "tax" ? l.tax_inclusive : null,
      })),
      totals: {
        subtotal: row.subtotal_amount,
        discount: row.discount_amount,
        fees: row.fee_amount,
        tax: row.tax_amount,
        includedTax: row.included_tax_amount,
        total: row.total_amount,
      },
    },
    payment: {
      provider: row.provider,
      state: row.payment_state,
      amount: row.payment_amount,
      currency: "USD",
      providerReference: maskProviderReference(row.provider_payment_id),
      createdAt: iso(row.payment_created_at),
      succeededAt: isoOrNull(row.succeeded_at),
    },
    refund,
    timeline,
  };
}

// Lookup by reference -----------------------------------------------------------------------

/** The booking a reference names, in its issued form. Null when it is not this tenant's. */
export async function findBookingByReference(
  trx: TenantTransaction,
  tenantId: string,
  reference: string,
): Promise<{ id: string; reference: string; tripId: string; localDate: string } | null> {
  const { rows } = await sql<{
    id: string;
    reference: string;
    trip_id: string;
    local_date: string;
  }>`
    select b.id, b.reference, b.trip_id, to_char(t.local_date, 'YYYY-MM-DD') as local_date
      from bookings b
      join scheduled_trips t on t.tenant_id = b.tenant_id and t.id = b.trip_id
     where b.tenant_id = ${tenantId} and b.reference = ${reference}`.execute(trx);
  const row = rows[0];
  return row
    ? { id: row.id, reference: row.reference, tripId: row.trip_id, localDate: row.local_date }
    : null;
}

// A trip's roster ------------------------------------------------------------------------------

/**
 * Every booking on one trip with its party, extras, and payment state, and
 * the trip's time, place, and totals. Complete, not paged: a trip seats at
 * most 500, and each booking takes at least one seat. Null when the trip is
 * not this tenant's. Callers must hold bookings.read: it names the bookers.
 */
export async function getTripRoster(
  trx: TenantTransaction,
  tenantId: string,
  tripId: string,
): Promise<RosterView | null> {
  if (!isUuid(tripId)) return null;
  const { rows: tripRows } = await sql<
    TimingRow & {
      seat_capacity: number;
      location_name: string;
      meeting_point: string;
      meeting_instructions: string;
      generated_at: Date | string;
    }
  >`
    select ${tripColumns},
           t.ends_at, t.end_utc_offset_minutes, t.duration_minutes, t.seat_capacity,
           l.name as location_name, l.meeting_point, l.meeting_instructions,
           now() as generated_at
      from scheduled_trips t
      ${tripJoins}
      join locations l on l.tenant_id = p.tenant_id and l.id = p.location_id
     where t.tenant_id = ${tenantId} and t.id = ${tripId}::uuid`.execute(trx);
  const trip = tripRows[0];
  if (!trip) return null;
  const { rows } = await sql<{
    id: string;
    reference: string;
    party_size: number;
    order_id: string;
    booker_name: string;
    payment_state: PaymentState;
    refund_state: RefundState | null;
    refund_amount: number | null;
  }>`
    select b.id, b.reference, b.party_size, b.order_id, s.booker_name,
           pay.state as payment_state, r.state as refund_state, r.amount as refund_amount
      from bookings b
      join checkout_sessions s on s.tenant_id = b.tenant_id and s.id = b.checkout_session_id
      join payments pay on pay.tenant_id = b.tenant_id and pay.id = b.payment_id
      left join payment_refunds r on r.tenant_id = b.tenant_id and r.payment_id = b.payment_id
     where b.tenant_id = ${tenantId} and b.trip_id = ${tripId}::uuid
     order by b.confirmed_at, b.id`.execute(trx);
  const lines = await partyLines(
    trx,
    tenantId,
    rows.map((r) => r.order_id),
  );
  const bookings = rows.map((r) => {
    const own = lines.get(r.order_id) ?? empty;
    return {
      id: r.id,
      reference: r.reference,
      booker: { name: r.booker_name },
      party: partyOf(trip.product_kind, r.party_size, own.service),
      extras: extrasOf(own.addOns),
      payment: paymentStatus(r),
    };
  });
  return {
    generatedAt: iso(trip.generated_at),
    trip: { ...tripTiming(trip), seats: trip.seat_capacity },
    location: {
      name: trip.location_name,
      meetingPoint: trip.meeting_point,
      meetingInstructions: trip.meeting_instructions,
    },
    totals: {
      bookings: bookings.length,
      guests: bookings.reduce((sum, b) => sum + b.party.guests, 0),
      tickets: sumByCode(
        bookings.flatMap((b) => (b.party.kind === "tickets" ? b.party.tickets : [])),
      ),
      extras: sumByCode(bookings.flatMap((b) => b.extras)),
    },
    bookings,
  };
}

// Finalization exceptions -------------------------------------------------------------------------

export type ExceptionsPageResult =
  | { kind: "ok"; exceptions: ConsoleExceptionView[]; nextBefore: string | null }
  | { kind: "cursor_invalid" };

/**
 * The newest exceptions first, a page at a time, with the trip, the checkout,
 * the masked provider reference, and, for roles that may see them, the
 * booker's name and email to follow up with the guest.
 */
export async function listExceptionsPage(
  trx: TenantTransaction,
  tenantId: string,
  query: { limit: number; before?: string; withBooker: boolean },
): Promise<ExceptionsPageResult> {
  if (query.before !== undefined) {
    if (!isUuid(query.before)) return { kind: "cursor_invalid" };
    const found = await trx
      .selectFrom("finalization_exceptions")
      .select("id")
      .where("tenant_id", "=", tenantId)
      .where("id", "=", query.before)
      .executeTakeFirst();
    if (!found) return { kind: "cursor_invalid" };
  }
  const cursor =
    query.before === undefined
      ? sql``
      : sql`and (e.created_at, e.id) < (
              select e2.created_at, e2.id from finalization_exceptions e2
               where e2.tenant_id = ${tenantId} and e2.id = ${query.before}::uuid)`;
  const booker: RawBuilder<unknown> = query.withBooker
    ? sql`, s.booker_name, s.booker_email`
    : sql``;
  const { rows } = await sql<
    TripRow & {
      id: string;
      reason: FinalizationReason;
      checkout_session_id: string;
      payment_id: string;
      created_at: Date | string;
      party_size: number;
      checkout_state: CheckoutSessionState;
      expires_at: Date | string;
      amount: number;
      provider: PaymentProviderName;
      provider_reference: string | null;
      received_at: Date | string;
      reported_amount: number | null;
      reported_currency: string | null;
      refund_id: string | null;
      refund_state: RefundState | null;
      refund_amount: number | null;
      failure_code: string | null;
      settled_at: Date | string | null;
      booker_name?: string;
      booker_email?: string;
    }
  >`
    select e.id, e.reason, e.checkout_session_id, e.payment_id, e.created_at,
           s.party_size, s.state as checkout_state, s.expires_at,
           pay.amount, pay.provider,
           coalesce(pay.provider_payment_id, ev.payment_ref) as provider_reference,
           ev.verified_at as received_at, ev.amount as reported_amount,
           ev.currency as reported_currency,
           ${tripColumns},
           r.id as refund_id, r.state as refund_state, r.amount as refund_amount,
           r.failure_code, r.settled_at
           ${booker}
      from finalization_exceptions e
      join checkout_sessions s on s.tenant_id = e.tenant_id and s.id = e.checkout_session_id
      join payments pay on pay.tenant_id = e.tenant_id and pay.id = e.payment_id
      join provider_events ev on ev.tenant_id = e.tenant_id and ev.id = e.provider_event_id
      join scheduled_trips t on t.tenant_id = s.tenant_id and t.id = s.trip_id
      ${tripJoins}
      left join payment_refunds r on r.tenant_id = e.tenant_id and r.id = e.refund_id
     where e.tenant_id = ${tenantId}
       ${cursor}
     order by e.created_at desc, e.id desc
     limit ${query.limit + 1}`.execute(trx);
  const page = rows.slice(0, query.limit);
  return {
    kind: "ok",
    exceptions: page.map((r) => ({
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
      trip: tripSummary(r),
      partySize: r.party_size,
      checkout: { state: r.checkout_state, expiresAt: iso(r.expires_at) },
      payment: {
        provider: r.provider,
        providerReference: maskProviderReference(r.provider_reference),
        receivedAt: iso(r.received_at),
        reportedAmount: r.reported_amount,
        reportedCurrency: r.reported_currency,
      },
      ...(query.withBooker && r.booker_name !== undefined && r.booker_email !== undefined
        ? { booker: { name: r.booker_name, email: r.booker_email } }
        : {}),
    })),
    nextBefore: rows.length > query.limit ? (page.at(-1)?.id ?? null) : null,
  };
}
