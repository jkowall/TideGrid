import type {
  BookingDetail,
  BookingExtra,
  BookingParty,
  BookingPaymentStatus,
  BookingTimelineEvent,
  FinalizationException,
} from "@tidegrid/contracts";
import type { IconName, LedgerRow, StatusTone } from "@tidegrid/design-system/components";
import {
  addDays,
  earlier,
  formatDate,
  formatMoney,
  formatRatePpm,
  inZone,
  isLocalDate,
  type LocalDate,
  later,
} from "@tidegrid/design-system/format";
import { horizonDays } from "../calendar/model.ts";

/**
 * The booking views' rules, apart from React: which day an address names,
 * how a party, extras, a payment, and an exception read, and the order as
 * ledger rows. Money reaches the screen only through formatMoney, from cents.
 */

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isUuid(value: string): boolean {
  return uuidPattern.test(value);
}

// Days and addresses ---------------------------------------------------------------

/** The first and last day a person can reach: two years either side of today, as the calendar. */
export function dayBounds(today: LocalDate): { first: LocalDate; last: LocalDate } {
  return { first: addDays(today, -horizonDays), last: addDays(today, horizonDays) };
}

export function clampDay(day: LocalDate, today: LocalDate): LocalDate {
  const { first, last } = dayBounds(today);
  return later(first, earlier(day, last));
}

/** `?day=` from the address, kept within two years of today, or today when missing or unreadable. */
export function readDay(search: string, today: LocalDate): LocalDate {
  const value = new URLSearchParams(search).get("day") ?? "";
  return isLocalDate(value) ? clampDay(value, today) : today;
}

/** `?trip=` from the address, when it is a trip id. */
export function readTrip(search: string): string | undefined {
  const value = new URLSearchParams(search).get("trip") ?? "";
  return isUuid(value) ? value.toLowerCase() : undefined;
}

/** The list's address: a day and, optionally, one trip. Ids and dates only. */
export function bookingsHref(day: LocalDate, tripId?: string): string {
  const params = new URLSearchParams({ day });
  if (tripId) params.set("trip", tripId);
  return `/bookings?${params}`;
}

export const bookingHref = (bookingId: string) => `/bookings/${encodeURIComponent(bookingId)}`;
export const rosterHref = (tripId: string) => `/trips/${encodeURIComponent(tripId)}/roster`;

// Parties, extras, and payments -------------------------------------------------------

export function guestsText(guests: number): string {
  return guests === 1 ? "1 guest" : `${guests} guests`;
}

/** "2 Adult, 1 Child (3 to 12)", or the charter as sold. */
export function partyDetail(party: BookingParty): string {
  if (party.kind === "charter") return party.charter;
  return party.tickets.map((t) => `${t.quantity} ${t.name}`).join(", ");
}

/** "1 Souvenir photo, 2 Drink voucher", or "None". */
export function extrasText(extras: readonly BookingExtra[]): string {
  return extras.length === 0 ? "None" : extras.map((e) => `${e.quantity} ${e.name}`).join(", ");
}

export interface StatusCopy {
  label: string;
  tone: StatusTone;
  icon: IconName;
}

/** A booking's payment in words: a refund, when there is one, says more than the charge. */
export function paymentCopy(payment: BookingPaymentStatus): StatusCopy {
  if (payment.refund) {
    switch (payment.refund.state) {
      case "succeeded":
        return { label: "Refunded", tone: "info", icon: "receipt" };
      case "requested":
        return { label: "Refund pending", tone: "pending", icon: "clock" };
      // A refund's states share the receipt; its tone tells them apart. A failed
      // refund is not a failed charge, so the two differ in icon as well as words.
      case "failed":
        return { label: "Refund failed", tone: "blocked", icon: "receipt" };
    }
  }
  switch (payment.state) {
    case "succeeded":
      return { label: "Paid", tone: "ready", icon: "credit-card" };
    case "pending":
      return { label: "Awaiting payment", tone: "pending", icon: "hourglass" };
    case "failed":
      return { label: "Payment failed", tone: "blocked", icon: "x-octagon" };
  }
}

/** Booking states. Confirmed is the only one until cancellation arrives. */
export const bookingStates: Record<"confirmed", StatusCopy> = {
  confirmed: { label: "Confirmed", tone: "ready", icon: "check" },
};

export function providerName(provider: "fake" | "stripe"): string {
  return provider === "fake" ? "Test payment (demo provider)" : "Stripe";
}

// Times -------------------------------------------------------------------------------

/** U+00A0, as the format module joins a time to its zone's name. */
const nbsp = String.fromCharCode(0x00a0);

/**
 * An instant on the marina's clock, named with the zone's short name, since
 * an instant is not a trip's stored wall clock: "Tue, Oct 6, 8:17 AM EDT".
 */
export function instantText(instant: string, timeZone: string): string {
  const at = inZone(instant, timeZone);
  return `${formatDate(at.date, "medium")}, ${at.time}${nbsp}${at.abbreviation}`;
}

const timelineLabels: Record<BookingTimelineEvent["kind"], string> = {
  checkout_opened: "Checkout opened",
  paid: "Payment received",
  confirmed: "Booking confirmed",
  refund_requested: "Refund requested",
  refunded: "Refunded",
  refund_failed: "Refund failed",
};

export function timelineLabel(kind: BookingTimelineEvent["kind"]): string {
  return timelineLabels[kind];
}

// The order as a ledger ------------------------------------------------------------------

function quantityDetail(quantity: number, unitAmount: number): string {
  return unitAmount === 0 ? `${quantity} at no charge` : `${quantity} × ${formatMoney(unitAmount)}`;
}

/**
 * The order's lines as ledger rows, in the order its totals are built: the
 * trip price and extras, their subtotal, the discount, fees, added taxes, and
 * the total, then any tax already included in the prices. The rows only
 * format the order's own numbers; nothing is added up here.
 */
export function orderRows(order: BookingDetail["order"]): LedgerRow[] {
  const rows: LedgerRow[] = [];
  const line = (l: BookingDetail["order"]["lines"][number]): LedgerRow => ({
    id: `line-${l.lineNo}`,
    label: l.name,
    ...(l.code === "charter" && l.quantity === 1
      ? {}
      : { detail: quantityDetail(l.quantity, l.unitAmount) }),
    amount: formatMoney(l.amount),
  });
  const of = (kind: string) => order.lines.filter((l) => l.kind === kind);
  for (const l of of("service")) rows.push(line(l));
  for (const l of of("add_on")) rows.push(line(l));
  rows.push({
    id: "subtotal",
    label: "Subtotal",
    amount: formatMoney(order.totals.subtotal),
    kind: "subtotal",
  });
  for (const l of of("discount")) {
    rows.push({
      id: `line-${l.lineNo}`,
      label: l.name,
      detail: "On the trip price, not extras",
      amount: formatMoney(l.amount),
      kind: "adjustment",
    });
  }
  for (const l of of("fee")) rows.push(line(l));
  const taxName = (l: BookingDetail["order"]["lines"][number]) =>
    l.taxRatePpm === null ? l.name : `${l.name} (${formatRatePpm(l.taxRatePpm)})`;
  for (const l of of("tax")) {
    if (l.taxInclusive === false) {
      rows.push({ id: `line-${l.lineNo}`, label: taxName(l), amount: formatMoney(l.amount) });
    }
  }
  rows.push({
    id: "total",
    label: "Total",
    amount: formatMoney(order.totals.total),
    kind: "total",
  });
  for (const l of of("tax")) {
    if (l.taxInclusive === true) {
      rows.push({
        id: `line-${l.lineNo}`,
        label: `Includes ${taxName(l)}`,
        amount: formatMoney(l.amount),
        kind: "note",
      });
    }
  }
  return rows;
}

// Finalization exceptions ----------------------------------------------------------------

/** What happened, in the operator's words. */
export function exceptionTitle(reason: FinalizationException["reason"]): string {
  switch (reason) {
    case "no_capacity":
      return "Paid after the checkout ran out of time, and the seats were gone";
    case "trip_canceled":
      return "Paid after the trip was canceled";
    case "trip_unavailable":
      return "Paid after the trip stopped taking bookings";
    case "sales_closed":
      return "Paid after sales closed for the trip";
    case "party_size_out_of_range":
      return "Paid for a party the trip no longer takes";
    case "session_failed":
      return "Paid after the payment provider had reported the payment failed";
    case "session_canceled":
      return "Paid after the guest canceled the checkout";
    case "payment_mismatch":
      return "A payment that didn't match its checkout";
  }
}

/** The refund, or why there is none. */
export function exceptionRefund(e: Pick<FinalizationException, "refund" | "reason">): StatusCopy & {
  detail: string;
} {
  if (!e.refund) {
    return {
      label: "Not refunded",
      tone: "warning",
      icon: "alert-triangle",
      detail:
        "Nothing was refunded automatically. Check this payment with the payment provider before you act.",
    };
  }
  const amount = formatMoney(e.refund.amount);
  switch (e.refund.state) {
    case "succeeded":
      return {
        label: "Refunded",
        tone: "info",
        icon: "receipt",
        detail: `${amount} was refunded in full to the guest's payment method.`,
      };
    case "requested":
      return {
        label: "Refund pending",
        tone: "pending",
        icon: "clock",
        detail: `A full refund of ${amount} is on its way. TideGrid retries it until the provider answers.`,
      };
    case "failed":
      return {
        label: "Refund failed",
        tone: "blocked",
        icon: "receipt",
        detail: `The provider refused the ${amount} refund${
          e.refund.failureCode ? ` (${e.refund.failureCode.replaceAll("_", " ")})` : ""
        }. Refund the guest another way, or contact the provider.`,
      };
  }
}
