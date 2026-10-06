import type {
  BookingDayTrip,
  BookingDetail,
  BookingDetailResponse,
  BookingListItem,
  BookingListResponse,
  BookingParty,
  BookingPaymentStatus,
  BookingReferenceResponse,
  FinalizationException,
  FinalizationExceptionsResponse,
  TripRoster,
  TripRosterResponse,
} from "@tidegrid/contracts";
import { isKnownZone, isLocalDate, type LocalDate } from "@tidegrid/design-system/format";
import { isKnownSalesState } from "../calendar/model.ts";
import { call, failureOf, type ReadFailure, tenantPath } from "../http.ts";

/**
 * The booking views' reads (G2.12b). Each never throws: it answers with what
 * it read or why it could not. The console does not run the contract's
 * schemas, so each answer is checked for what the screen uses.
 */

export type Read<T> = { kind: "ok"; value: T } | { kind: "failed"; reason: ReadFailure };

const json = { headers: { accept: "application/json" } };

async function read<T>(
  path: string,
  pick: (body: unknown) => T | null,
  signal?: AbortSignal,
): Promise<Read<T>> {
  try {
    const res = await call(path, json, signal);
    if (!res.ok) return { kind: "failed", reason: await failureOf(res) };
    const value = pick(await res.json().catch(() => null));
    return value === null ? { kind: "failed", reason: "unreadable" } : { kind: "ok", value };
  } catch {
    return { kind: "failed", reason: signal?.aborted ? "unavailable" : "unreachable" };
  }
}

// Shape checks --------------------------------------------------------------------------

const isInt = (v: unknown): v is number => Number.isSafeInteger(v);
const isString = (v: unknown): v is string => typeof v === "string";
const isInstant = (v: unknown) => isString(v) && !Number.isNaN(Date.parse(v));

function isTripSummary(t: Partial<BookingDayTrip> | null | undefined): boolean {
  return (
    isString(t?.tripId) &&
    isString(t.productName) &&
    isString(t.boatName) &&
    (t.productKind === "shared_seat" || t.productKind === "private_charter") &&
    isString(t.timeZone) &&
    isKnownZone(t.timeZone) &&
    isString(t.localDate) &&
    isLocalDate(t.localDate) &&
    isString(t.localStartTime) &&
    /^([01]\d|2[0-3]):[0-5]\d$/.test(t.localStartTime) &&
    isInstant(t.startsAt) &&
    isKnownSalesState(t.salesState)
  );
}

function isParty(p: Partial<BookingParty> | null | undefined): boolean {
  if (!isInt(p?.guests)) return false;
  if (p.kind === "charter") return isString((p as { charter?: unknown }).charter);
  if (p.kind !== "tickets") return false;
  const tickets = (p as { tickets?: unknown }).tickets;
  return (
    Array.isArray(tickets) &&
    tickets.every((t) => isString(t?.code) && isString(t?.name) && isInt(t?.quantity))
  );
}

function isExtras(extras: unknown): boolean {
  return (
    Array.isArray(extras) &&
    extras.every((e) => isString(e?.code) && isString(e?.name) && isInt(e?.quantity))
  );
}

const paymentStates = new Set(["pending", "succeeded", "failed"]);
const refundStates = new Set(["requested", "succeeded", "failed"]);

function isPaymentStatus(p: Partial<BookingPaymentStatus> | null | undefined): boolean {
  if (!paymentStates.has(p?.state as string)) return false;
  const refund = p?.refund;
  return refund === null || (refundStates.has(refund?.state as string) && isInt(refund?.amount));
}

/** A booker, when present, has the fields the role was sent; absent is fine. */
function isBooker(b: unknown, withEmail: boolean): boolean {
  if (b === undefined) return true;
  const booker = b as { name?: unknown; email?: unknown } | null;
  return isString(booker?.name) && (!withEmail || isString(booker?.email));
}

function isListItem(b: Partial<BookingListItem> | null | undefined): boolean {
  return (
    isString(b?.id) &&
    isString(b.reference) &&
    isString(b.tripId) &&
    b.state === "confirmed" &&
    isBooker(b.booker, false) &&
    isParty(b.party) &&
    isExtras(b.extras) &&
    isInt(b.total) &&
    isPaymentStatus(b.payment)
  );
}

// A day's bookings --------------------------------------------------------------------------

export interface DayPage {
  trips: BookingDayTrip[];
  bookings: BookingListItem[];
  nextAfter: string | null;
}

/** A page of a local date's bookings, optionally for one trip, after a cursor. */
export function loadDay(
  tenantId: string,
  query: { date: LocalDate; tripId?: string | undefined; after?: string | undefined },
  signal?: AbortSignal,
): Promise<Read<DayPage>> {
  const params = new URLSearchParams({ date: query.date });
  if (query.tripId) params.set("tripId", query.tripId);
  if (query.after) params.set("after", query.after);
  return read(
    `${tenantPath(tenantId)}/bookings?${params}`,
    (body) => {
      const b = body as Partial<BookingListResponse> | null;
      if (!Array.isArray(b?.trips) || !Array.isArray(b.bookings)) return null;
      if (!b.trips.every((t) => isTripSummary(t) && isInt(t.bookings) && isInt(t.guests))) {
        return null;
      }
      if (!b.bookings.every(isListItem)) return null;
      if (b.nextAfter !== null && !isString(b.nextAfter)) return null;
      return { trips: b.trips, bookings: b.bookings, nextAfter: b.nextAfter ?? null };
    },
    signal,
  );
}

// One booking ---------------------------------------------------------------------------------

const lineKinds = new Set(["service", "add_on", "fee", "discount", "tax"]);

function isDetail(b: Partial<BookingDetail> | null | undefined): b is BookingDetail {
  const order = b?.order;
  const totals = order?.totals;
  return (
    isString(b?.id) &&
    isString(b.reference) &&
    b.state === "confirmed" &&
    isInstant(b.confirmedAt) &&
    isTripSummary(b.trip) &&
    isInstant(b.trip?.endsAt) &&
    isString(b.trip?.endsAtLocal) &&
    isString(b.location?.name) &&
    isString(b.location?.meetingPoint) &&
    isString(b.location?.meetingInstructions) &&
    isBooker(b.booker, true) &&
    isParty(b.party) &&
    isExtras(b.extras) &&
    isInt(b.policyVersion) &&
    Array.isArray(order?.lines) &&
    order.lines.every(
      (l) =>
        lineKinds.has(l?.kind) &&
        isString(l?.name) &&
        isInt(l?.quantity) &&
        isInt(l?.unitAmount) &&
        isInt(l?.amount) &&
        (l?.taxRatePpm === null || isInt(l?.taxRatePpm)),
    ) &&
    [
      totals?.subtotal,
      totals?.discount,
      totals?.fees,
      totals?.tax,
      totals?.includedTax,
      totals?.total,
    ].every(isInt) &&
    (b.payment?.provider === "fake" || b.payment?.provider === "stripe") &&
    paymentStates.has(b.payment.state) &&
    isInt(b.payment.amount) &&
    (b.payment.providerReference === null || isString(b.payment.providerReference)) &&
    (b.refund === null ||
      (refundStates.has(b.refund?.state as string) &&
        isInt(b.refund?.amount) &&
        isInstant(b.refund?.requestedAt))) &&
    Array.isArray(b.timeline) &&
    b.timeline.every((t) => isString(t?.kind) && isInstant(t?.at))
  );
}

export function loadBooking(
  tenantId: string,
  bookingId: string,
  signal?: AbortSignal,
): Promise<Read<BookingDetail>> {
  return read(
    `${tenantPath(tenantId)}/bookings/${encodeURIComponent(bookingId)}`,
    (body) => {
      const booking = (body as Partial<BookingDetailResponse> | null)?.booking;
      return isDetail(booking) ? booking : null;
    },
    signal,
  );
}

// Quick find ------------------------------------------------------------------------------------

export function findReference(
  tenantId: string,
  reference: string,
  signal?: AbortSignal,
): Promise<Read<BookingReferenceResponse["booking"]>> {
  return read(
    `${tenantPath(tenantId)}/booking-references/${encodeURIComponent(reference)}`,
    (body) => {
      const b = (body as Partial<BookingReferenceResponse> | null)?.booking;
      return isString(b?.id) && isString(b.reference) && isString(b.localDate) ? b : null;
    },
    signal,
  );
}

// A trip's roster -------------------------------------------------------------------------------

function isRoster(r: Partial<TripRoster> | null | undefined): r is TripRoster {
  return (
    !!r &&
    isInstant(r.generatedAt) &&
    isTripSummary(r.trip) &&
    isString(r.trip?.endsAtLocal) &&
    isInt(r.trip?.seats) &&
    isString(r.location?.name) &&
    isString(r.location?.meetingPoint) &&
    isString(r.location?.meetingInstructions) &&
    isInt(r.totals?.bookings) &&
    isInt(r.totals?.guests) &&
    isExtras(r.totals?.tickets) &&
    isExtras(r.totals?.extras) &&
    Array.isArray(r.bookings) &&
    r.bookings.every(
      (b) =>
        isString(b?.id) &&
        isString(b?.reference) &&
        isString(b?.booker?.name) &&
        isParty(b?.party) &&
        isExtras(b?.extras) &&
        isPaymentStatus(b?.payment),
    )
  );
}

export function loadRoster(
  tenantId: string,
  tripId: string,
  signal?: AbortSignal,
): Promise<Read<TripRoster>> {
  return read(
    `${tenantPath(tenantId)}/trips/${encodeURIComponent(tripId)}/roster`,
    (body) => {
      const roster = (body as Partial<TripRosterResponse> | null)?.roster;
      return isRoster(roster) ? roster : null;
    },
    signal,
  );
}

// Finalization exceptions ---------------------------------------------------------------------------

const reasons = new Set([
  "no_capacity",
  "trip_canceled",
  "trip_unavailable",
  "sales_closed",
  "party_size_out_of_range",
  "session_failed",
  "session_canceled",
  "payment_mismatch",
]);

function isException(e: Partial<FinalizationException> | null | undefined): boolean {
  return (
    isString(e?.id) &&
    reasons.has(e.reason as string) &&
    isInt(e.amount) &&
    isInstant(e.createdAt) &&
    (e.refund === null ||
      (refundStates.has(e.refund?.state as string) && isInt(e.refund?.amount))) &&
    isTripSummary(e.trip) &&
    isInt(e.partySize) &&
    isInstant(e.checkout?.expiresAt) &&
    isInstant(e.payment?.receivedAt) &&
    (e.payment?.providerReference === null || isString(e.payment?.providerReference)) &&
    (e.payment?.reportedAmount === null || isInt(e.payment?.reportedAmount)) &&
    isBooker(e.booker, true)
  );
}

export interface ExceptionsPage {
  exceptions: FinalizationException[];
  nextBefore: string | null;
}

export function loadExceptions(
  tenantId: string,
  query: { before?: string | undefined },
  signal?: AbortSignal,
): Promise<Read<ExceptionsPage>> {
  const params = new URLSearchParams({ limit: "50" });
  if (query.before) params.set("before", query.before);
  return read(
    `${tenantPath(tenantId)}/finalization-exceptions?${params}`,
    (body) => {
      const b = body as Partial<FinalizationExceptionsResponse> | null;
      if (!Array.isArray(b?.exceptions) || !b.exceptions.every(isException)) return null;
      if (b.nextBefore !== null && !isString(b.nextBefore)) return null;
      return { exceptions: b.exceptions, nextBefore: b.nextBefore ?? null };
    },
    signal,
  );
}
