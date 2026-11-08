import {
  type AvailableTrip,
  BookerDetails,
  type CheckoutSession,
  type GuestParticipantWaiver,
  type PolicyOutcome,
  type PolicyTerms,
  type Quote,
  QuoteProblemCode,
  type TripOffer,
  type WaiverStatusCode,
} from "@tidegrid/contracts";
import {
  formatBasisPoints,
  formatCutoff,
  formatDate,
  formatMoney,
  formatRatePpm,
  formatTripTime,
  inZone,
  todayIn,
} from "@tidegrid/design-system/format";
import type { QuoteBody } from "./booking-api.ts";
import type { Failure } from "./http.ts";

/**
 * The booking journey's rules and words, apart from React. A port of the
 * guest web app's (apps/guest-site src/booking/model.ts) for the parts the
 * app shows, with the same words, so the two read alike. Every amount comes
 * from the API in integer cents and is only formatted here.
 */

/** The API's own ceiling on a ticket count. */
const maxCount = 500;

// Party -------------------------------------------------------------------------------

export interface Selection {
  /** Shared seats: tickets by type code. */
  tickets: Record<string, number>;
  /** Private charter: guests aboard. */
  guests: number;
  addOns: Record<string, number>;
}

export const isCharter = (offer: TripOffer) => offer.product.kind === "private_charter";

export function partySize(offer: TripOffer, selection: Selection): number {
  if (isCharter(offer)) return selection.guests;
  return Object.values(selection.tickets).reduce((sum, n) => sum + n, 0);
}

export interface PartyLimits {
  min: number;
  max: number;
  /** Seats left on a shared trip, when the list said; null for a charter or when unknown. */
  seatsLeft: number | null;
}

/** The party the trip can take, from the product and the list's seats left. The API decides. */
export function partyLimits(offer: TripOffer, listing: AvailableTrip | null): PartyLimits {
  const min = Math.max(1, offer.product.minPartySize);
  const productMax = Math.max(min, Math.min(offer.product.maxPartySize, maxCount));
  if (!listing) return { min, max: productMax, seatsLeft: null };
  const { kind, total, remaining } = listing.capacity;
  if (kind === "whole_boat") return { min, max: Math.min(productMax, total), seatsLeft: null };
  return { min, max: Math.min(productMax, remaining), seatsLeft: remaining };
}

export function addOnLimit(addOn: TripOffer["addOns"][number], party: number): number {
  return addOn.quantityRule === "per_participant"
    ? addOn.maxQuantity * Math.max(party, 1)
    : addOn.maxQuantity;
}

/** The first selection: the product's smallest party, of the first ticket type, and no extras. */
export function initialSelection(offer: TripOffer, limits: PartyLimits): Selection {
  const tickets: Record<string, number> = {};
  for (const ticket of offer.tickets) tickets[ticket.code] = 0;
  const first = offer.tickets[0];
  if (!isCharter(offer) && first) tickets[first.code] = Math.min(limits.min, limits.max);
  const addOns: Record<string, number> = {};
  for (const addOn of offer.addOns) addOns[addOn.code] = 0;
  return { tickets, guests: Math.max(1, Math.min(limits.min, limits.max)), addOns };
}

/** Keep add-ons within their limits for the party. */
export function fitAddOns(offer: TripOffer, selection: Selection): Selection {
  const party = partySize(offer, selection);
  const addOns: Record<string, number> = {};
  for (const addOn of offer.addOns) {
    addOns[addOn.code] = Math.min(selection.addOns[addOn.code] ?? 0, addOnLimit(addOn, party));
  }
  return { ...selection, addOns };
}

/** The quote request for a selection. Counts of zero are left out, as the API requires. */
export function quoteBody(offer: TripOffer, selection: Selection): QuoteBody {
  const party: QuoteBody["party"] = isCharter(offer)
    ? { kind: "charter", guests: selection.guests }
    : {
        kind: "tickets",
        tickets: offer.tickets
          .filter((t) => (selection.tickets[t.code] ?? 0) > 0)
          .map((t) => ({ code: t.code, quantity: selection.tickets[t.code] ?? 0 })),
      };
  const addOns = offer.addOns
    .filter((a) => (selection.addOns[a.code] ?? 0) > 0)
    .map((a) => ({ code: a.code, quantity: selection.addOns[a.code] ?? 0 }));
  return { tripId: offer.tripId, party, addOns };
}

/** A problem with the party, before anything is sent. */
export function partyProblem(
  offer: TripOffer,
  selection: Selection,
  limits: PartyLimits,
): string | null {
  const size = partySize(offer, selection);
  const charter = isCharter(offer);
  if (size < 1) return `Choose at least 1 ${charter ? "guest" : "ticket"}.`;
  if (size < limits.min) return `This trip needs at least ${limits.min} guests.`;
  if (size > limits.max) {
    if (limits.seatsLeft === 0) return "No seats are left on this trip.";
    const yours = `your party is ${size}`;
    if (limits.seatsLeft !== null && limits.seatsLeft < offer.product.maxPartySize) {
      const left = limits.seatsLeft === 1 ? "1 seat is" : `${limits.seatsLeft} seats are`;
      return `Only ${left} left, and ${yours}. Choose fewer guests.`;
    }
    return `${charter ? "The boat" : "This trip"} takes up to ${limits.max} guests, and ${yours}.`;
  }
  return null;
}

export const guests = (n: number) => (n === 1 ? "1 guest" : `${n} guests`);

export function eachPrice(unitAmount: number): string {
  return unitAmount === 0 ? "Free" : `${formatMoney(unitAmount)} each`;
}

export function addOnHint(addOn: TripOffer["addOns"][number]): string {
  const limit =
    addOn.quantityRule === "per_participant"
      ? `up to ${addOn.maxQuantity} per guest`
      : `up to ${addOn.maxQuantity} per booking`;
  return `${eachPrice(addOn.unitAmount)}, ${limit}`;
}

// Booker ------------------------------------------------------------------------------

/**
 * The booker's details as the API's contract takes them: a single line of
 * text up to 120 characters, and an ASCII address up to 254. Null when both
 * are fine. The API checks again.
 */
export function bookerProblems(name: string, email: string): { name?: string; email?: string } {
  const problems: { name?: string; email?: string } = {};
  const parsed = BookerDetails.safeParse({ name, email: email.trim() });
  if (parsed.success) return problems;
  for (const issue of parsed.error.issues) {
    if (issue.path[0] === "name") problems.name = "Enter the name of the person booking.";
    if (issue.path[0] === "email") {
      problems.email = "Enter an email address, such as name@example.com.";
    }
  }
  return problems;
}

// Prices ------------------------------------------------------------------------------

export interface Row {
  id: string;
  label: string;
  detail?: string;
  amount: string;
  kind: "item" | "subtotal" | "adjustment" | "total" | "note";
}

/** The quote's rows in the order its totals are built, as the web app's ledger shows them. */
export function quoteRows(quote: Quote): Row[] {
  const rows: Row[] = [];
  const line = (l: Quote["lines"][number], kind: Row["kind"] = "item"): Row => ({
    id: `line-${l.lineNo}`,
    label: l.name,
    ...(l.kind === "charter" && l.quantity === 1
      ? {}
      : {
          detail:
            l.unitAmount === 0
              ? `${l.quantity} at no charge`
              : `${l.quantity} × ${formatMoney(l.unitAmount)}`,
        }),
    amount: formatMoney(l.amount),
    kind,
  });
  for (const l of quote.lines) if (l.kind === "ticket" || l.kind === "charter") rows.push(line(l));
  for (const l of quote.lines) if (l.kind === "add_on") rows.push(line(l));
  rows.push({
    id: "subtotal",
    label: "Subtotal",
    amount: formatMoney(quote.totals.subtotal),
    kind: "subtotal",
  });
  for (const l of quote.lines) if (l.kind === "discount") rows.push(line(l, "adjustment"));
  for (const l of quote.lines) if (l.kind === "fee") rows.push(line(l));
  for (const tax of quote.taxes) {
    if (!tax.inclusive) {
      rows.push({
        id: `tax-${tax.taxRateId}`,
        label: `${tax.name} (${formatRatePpm(tax.ratePpm)})`,
        amount: formatMoney(tax.amount),
        kind: "item",
      });
    }
  }
  rows.push({
    id: "total",
    label: "Total",
    amount: formatMoney(quote.totals.total),
    kind: "total",
  });
  for (const tax of quote.taxes) {
    if (tax.inclusive) {
      rows.push({
        id: `tax-${tax.taxRateId}`,
        label: `Includes ${tax.name} (${formatRatePpm(tax.ratePpm)})`,
        amount: formatMoney(tax.amount),
        kind: "note",
      });
    }
  }
  return rows;
}

// Times -------------------------------------------------------------------------------

const nbsp = String.fromCharCode(0x00a0);

/** "Sat, Nov 14 at 9:00 AM", on the marina's own clock. */
export function tripWhen(trip: {
  localDate: string;
  localStartTime: string;
  startsAt: string;
  timeZone: string;
}): string {
  return `${formatDate(trip.localDate, "medium")} at ${formatTripTime(trip.localStartTime, trip.startsAt, trip.timeZone)}`;
}

/** A deadline on the trip zone's clock, named with the zone ("3:42 PM EDT"). */
export function deadlineText(instant: string, timeZone: string, now: Date = new Date()): string {
  const at = inZone(instant, timeZone);
  const time = `${at.time}${nbsp}${at.abbreviation}`;
  return at.date === todayIn(timeZone, now) ? time : `${formatDate(at.date, "medium")}, ${time}`;
}

// Policy ------------------------------------------------------------------------------

export function remedyText(outcome: PolicyOutcome): string {
  switch (outcome.remedy) {
    case "full_refund":
      return "a full refund";
    case "percent_refund":
      return outcome.refundBp
        ? `a ${formatBasisPoints(outcome.refundBp)} refund`
        : "a partial refund";
    case "credit":
      return "a credit for a future trip";
    case "none":
      return "no refund";
  }
}

/** The policy in three short lines, on the marina's clock, as the web app says it. */
export function policySummary(
  policy: PolicyTerms,
  trip: { timeZone: string; localDate: string; startsAt: string },
  now: number,
): string[] {
  const lines: string[] = [];
  if (now < Date.parse(policy.changeCutoffAt)) {
    const close = inZone(policy.changeCutoffAt, trip.timeZone);
    const when =
      close.date === trip.localDate
        ? `${formatCutoff(policy.changeCutoffAt, trip)} on the day of the trip`
        : formatCutoff(policy.changeCutoffAt, trip);
    lines.push(`Cancel before ${when} for ${remedyText(policy.beforeCutoff)}.`);
    lines.push(`After that, canceling gets ${remedyText(policy.afterCutoff)}.`);
  } else {
    lines.push(
      `The deadline for changes has passed, so canceling now gets ${remedyText(policy.afterCutoff)}.`,
    );
  }
  lines.push(`If you miss the trip, you get ${remedyText(policy.noShow)}.`);
  return lines;
}

// Clock -------------------------------------------------------------------------------

/**
 * The API's clock, as the app estimates it, as the web app does
 * (apps/guest-site src/booking/clock.ts). Holds and prices expire on the
 * server's time; a phone's clock can be minutes or hours off. The app learns
 * the offset from a fresh quote's `quotedAt` or a new checkout's `createdAt`.
 * Until it learns, the phone's clock stands; the server decides every deadline.
 */
export class ServerClock {
  #offset = 0;

  learn(serverInstant: string, receivedAt: number = Date.now()): void {
    const at = Date.parse(serverInstant);
    if (!Number.isNaN(at)) this.#offset = at - receivedAt;
  }

  now(local: number = Date.now()): number {
    return local + this.#offset;
  }
}

// Checkout ----------------------------------------------------------------------------

export const finalStates: ReadonlySet<CheckoutSession["state"]> = new Set([
  "confirmed",
  "failed",
  "expired",
  "unfulfilled",
  "canceled",
]);

/** The gentle backoff between reads of a checkout's state, as the web app's. */
const pollDelaysMs = [500, 1_000, 1_500, 2_000, 3_000, 5_000];

export function pollDelay(attempt: number): number {
  return pollDelaysMs[Math.min(attempt, pollDelaysMs.length - 1)] ?? 5_000;
}

/** A checkout's short reference for support, from its id: "3BA66E4F". */
export function shortReference(sessionId: string): string {
  return sessionId.replace(/-/g, "").slice(0, 8).toUpperCase();
}

// Failures ----------------------------------------------------------------------------

/**
 * What a failed call means for the journey.
 * - notice: say so where the guest is, with a way to try again.
 * - party: a problem with the party, shown at the party step.
 * - soldOut / notBookable / pricing / payments: the trip cannot be booked here now.
 * - requote: the price is no longer usable; get a new one.
 */
export type Trouble =
  | { kind: "notice"; title: string; body: string }
  | { kind: "party"; text: string }
  | { kind: "stop"; stop: "sold_out" | "not_bookable" | "not_found" | "pricing" | "payments" }
  | { kind: "requote" };

const tryAgain: Trouble = {
  kind: "notice",
  title: "We couldn't reach the booking service",
  body: "Check your connection, then try again.",
};
const server: Trouble = {
  kind: "notice",
  title: "Something went wrong on our side",
  body: "Wait a moment, then try again.",
};
const limited: Trouble = {
  kind: "notice",
  title: "Too many tries in a short time",
  body: "Wait a minute, then try again.",
};

function commonTrouble(failure: Failure): Trouble | null {
  if (failure.kind === "network") return tryAgain;
  if (failure.kind === "unreadable") return server;
  if (failure.status === 429 && failure.code === "rate_limited") return limited;
  if (failure.status >= 500 && failure.code !== "payments_unavailable") return server;
  return null;
}

function fewerSeats(seats: number): string {
  return `Only ${seats} ${seats === 1 ? "seat is" : "seats are"} left now. Choose fewer guests.`;
}

/** Too few seats: a charter whose boat is taken, or a trip with none left, is sold out. */
function capacity(charter: boolean, remaining: number | null): Trouble {
  if (charter || remaining === 0) return { kind: "stop", stop: "sold_out" };
  return {
    kind: "party",
    text:
      remaining === null
        ? "There aren't enough seats left for this party. Choose fewer guests."
        : fewerSeats(remaining),
  };
}

const problemCodes: ReadonlySet<string> = new Set(QuoteProblemCode.options);

/** What a refused quote means. */
export function quoteTrouble(failure: Failure, offer: TripOffer, limits: PartyLimits): Trouble {
  const common = commonTrouble(failure);
  if (common || failure.kind !== "refused") return common ?? server;
  const { status, code } = failure;
  const remaining = failure.remaining ?? limits.seatsLeft;
  if (status === 404) return { kind: "stop", stop: "not_found" };
  if (code === "trip_not_bookable") return { kind: "stop", stop: "not_bookable" };
  if (code === "pricing_unavailable") return { kind: "stop", stop: "pricing" };
  if (code === "insufficient_capacity") return capacity(isCharter(offer), remaining);
  if (status !== 422 || code === "idempotency_key_reused") return server;
  const codes = (failure.problems ?? [{ code, subject: null }])
    .map((p) => p.code)
    .filter((c) => problemCodes.has(c));
  if (codes.includes("pricing_unavailable")) return { kind: "stop", stop: "pricing" };
  if (codes.includes("insufficient_capacity")) return capacity(isCharter(offer), remaining);
  if (codes.includes("party_size_out_of_range")) {
    return {
      kind: "party",
      text: `This trip takes ${limits.min} to ${offer.product.maxPartySize} guests.`,
    };
  }
  if (codes.includes("add_on_quantity_exceeded")) {
    return { kind: "party", text: "That's more extras than this party can take." };
  }
  if (codes.includes("quote_amount_too_large")) {
    return {
      kind: "party",
      text: "This booking is too large to pay online. Call or email to book it.",
    };
  }
  // A ticket type or add-on the server no longer sells: the options are out of date.
  return {
    kind: "notice",
    title: "This trip's options changed",
    body: "Go back and choose again.",
  };
}

/** What a refused checkout means. */
export function checkoutTrouble(failure: Failure, operator: string, charter: boolean): Trouble {
  if (failure.kind === "refused" && failure.code === "payments_unavailable") {
    return { kind: "stop", stop: "payments" };
  }
  const common = commonTrouble(failure);
  if (common || failure.kind !== "refused") return common ?? server;
  switch (failure.code) {
    case "quote_not_found":
    case "quote_expired":
    case "quote_already_used":
    case "policy_not_accepted":
      return { kind: "requote" };
    case "trip_not_bookable":
      return { kind: "stop", stop: "not_bookable" };
    case "insufficient_capacity":
      return capacity(charter, failure.remaining ?? null);
    case "party_size_out_of_range":
      return { kind: "party", text: "This trip no longer takes a party of this size." };
    case "payment_amount_too_small":
      return {
        kind: "notice",
        title: "This total is too small to pay online",
        body: `Online payments start at $0.50. Call or email ${operator} to book.`,
      };
    case "too_many_checkouts":
      return {
        kind: "notice",
        title: "Too many checkouts are open",
        body: "Finish or cancel a checkout you started, or wait up to 15 minutes for it to end.",
      };
    default:
      return server;
  }
}

export function stopText(
  stop: Extract<Trouble, { kind: "stop" }>["stop"],
  operator: string,
): { title: string; body: string } {
  switch (stop) {
    case "sold_out":
      return { title: "This trip is sold out", body: "Choose another trip or date." };
    case "not_bookable":
      return {
        title: "This trip can't be booked now",
        body: "Booking may have closed. Choose another trip.",
      };
    case "not_found":
      return { title: "We couldn't find this trip", body: "Choose another trip." };
    case "pricing":
      return {
        title: "Prices aren't set for this trip yet",
        body: `Call or email ${operator} to book it.`,
      };
    case "payments":
      return {
        title: "Online payment isn't available right now",
        body: `Call or email ${operator} to book.`,
      };
  }
}

// After paying ------------------------------------------------------------------------

/** What a final checkout means, in words. */
export function outcomeText(
  session: CheckoutSession,
  operator: string,
  paymentTried = false,
): { title: string; body: string } {
  switch (session.state) {
    case "confirmed":
      return {
        title: "You're booked",
        body: `Your booking reference is ${session.booking?.reference ?? ""}. A confirmation email is on its way.`,
      };
    case "failed":
      return {
        title: "Your payment was declined",
        body: "Nothing was charged, and no booking was made. You can start over.",
      };
    case "expired":
      return {
        title: "Your checkout expired",
        body: paymentTried
          ? "Time ran out before your payment was confirmed. If it went through, it is booked or refunded in full, and we'll email you. Check your email before booking again."
          : "Time ran out before a payment arrived. Nothing was charged, and the hold was released. Start over to book.",
      };
    case "canceled":
      return {
        title: "This checkout was canceled",
        body: paymentTried
          ? "Your checkout was canceled, and the hold was released. If your test payment went through, it is refunded in full."
          : "Nothing was charged, and the hold was released.",
      };
    case "unfulfilled": {
      const refund = session.refund;
      return {
        title: "We couldn't book this trip",
        body: `Your payment arrived after this checkout could no longer become a booking, so no booking was made. ${refund?.state === "failed" ? `The refund hasn't gone through yet. Contact ${operator} to put it right` : `It ${refund?.state === "succeeded" ? "has been" : "is being"} refunded in full`}. Reference ${shortReference(session.id)}.`,
      };
    }
    case "open":
      return { title: "Waiting for the payment", body: "This can take a moment." };
  }
}

// The email link ----------------------------------------------------------------------

/**
 * The token from a pasted booking link (".../manage#t=<token>") or the token
 * alone. The token is 43 base64url characters; anything else is not a link.
 */
export function linkTokenFrom(text: string): string | null {
  const trimmed = text.trim();
  const fromLink = /#t=([A-Za-z0-9_-]{43})$/.exec(trimmed);
  if (fromLink) return fromLink[1] ?? null;
  return /^[A-Za-z0-9_-]{43}$/.test(trimmed) ? trimmed : null;
}

// Waivers -----------------------------------------------------------------------------

export type WaiverTone = "ready" | "pending" | "blocked" | "warning" | "neutral";

/** The same labels as the web app's party waivers, with a symbol so color is never alone. */
export const waiverStatus: Record<
  WaiverStatusCode,
  { tone: WaiverTone; symbol: string; label: string }
> = {
  signed: { tone: "ready", symbol: "✓", label: "Signed" },
  waiting: { tone: "pending", symbol: "◷", label: "Waiting for signature" },
  email_failed: { tone: "blocked", symbol: "✕", label: "Email didn't go through" },
  no_address: { tone: "warning", symbol: "!", label: "Needs an email address" },
  email_held: { tone: "warning", symbol: "!", label: "Email on hold" },
  not_assigned: { tone: "warning", symbol: "!", label: "Not sent yet" },
  not_required: { tone: "neutral", symbol: "·", label: "No waiver needed" },
  not_needed: { tone: "neutral", symbol: "·", label: "Not needed" },
};

/** What happened and what the booker can do, as the web app says it. */
export function waiverDetail(
  p: GuestParticipantWaiver,
  operator: string,
  timeZone: string,
): string | null {
  const guardian = p.signer === "guardian";
  switch (p.status) {
    case "signed":
      return guardian ? "Signed by a parent or guardian." : "Signed.";
    case "waiting":
      if (!p.sentTo) return "Their email is on its way.";
      if (p.sendsAt) {
        const at = deadlineText(p.sendsAt, timeZone);
        return guardian
          ? `We'll email the link to their parent or guardian at ${p.sentTo} at ${at}.`
          : `We'll email the link to ${p.sentTo} at ${at}.`;
      }
      return guardian
        ? `We emailed the link to their parent or guardian at ${p.sentTo}.`
        : `We emailed the link to ${p.sentTo}.`;
    case "email_failed":
      return `The email${p.sentTo ? ` to ${p.sentTo}` : ""} didn't go through. Contact ${operator}.`;
    case "no_address":
      return "Add their email on the booking's web page, and we'll send their waiver.";
    case "email_held":
      return `We can't email this address again just yet. ${operator} can send it once it's allowed.`;
    case "not_assigned":
      return `${operator} hasn't sent this waiver yet. Contact them if your trip is soon.`;
    default:
      return null;
  }
}
