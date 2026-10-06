import {
  type AvailableTrip,
  type CheckoutSession,
  type PolicyOutcome,
  type PolicyTerms,
  type Quote,
  QuoteProblemCode,
  type TripOffer,
} from "@tidegrid/contracts";
import type { LedgerRow } from "@tidegrid/design-system/components";
import {
  formatBasisPoints,
  formatCutoff,
  formatDate,
  formatMoney,
  formatRatePpm,
  inZone,
  todayIn,
} from "@tidegrid/design-system/format";
import type { BookingAddress } from "./address.ts";
import { maxCount } from "./address.ts";
import type { Failure, QuoteBody } from "./api.ts";

/**
 * The booking page's rules and words, apart from React. Every amount comes
 * from the API in integer cents and is only formatted here; nothing adds,
 * multiplies, or rounds money in the browser.
 */

// The trip ------------------------------------------------------------------------------

/**
 * What the page shows about the trip being booked. It comes from the offer,
 * or, when a reload finds the trip off sale because this checkout's own hold
 * took its last seats, from the checkout's quote, which keeps the same
 * snapshot.
 */
export interface TripContext {
  tripId: string;
  productName: string;
  charter: boolean;
  trip: TripOffer["trip"];
}

export function contextOfOffer(offer: TripOffer): TripContext {
  return {
    tripId: offer.tripId,
    productName: offer.product.name,
    charter: offer.product.kind === "private_charter",
    trip: offer.trip,
  };
}

export function contextOfQuote(quote: Quote): TripContext {
  return {
    tripId: quote.tripId,
    productName: quote.product.name,
    charter: quote.product.kind === "private_charter",
    trip: quote.trip,
  };
}

/** What a hold keeps for the guest: "your seats", or "the boat" on a charter. */
export const heldThing = (charter: boolean) => (charter ? "the boat" : "your seats");

// Party -------------------------------------------------------------------------------

/** What the guest has chosen. Counts are whole numbers; zero means none. */
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
  /** The product's smallest party. */
  min: number;
  /** The most this trip can take now. */
  max: number;
  /** Seats left on a shared trip, when the list said; null for a charter or when unknown. */
  seatsLeft: number | null;
}

/**
 * The party the trip can take: the product's limits, and for shared seats the
 * seats left as the list last said. Only acquiring a hold decides, so the API
 * may still refuse a party this allows.
 */
export function partyLimits(offer: TripOffer, listing: AvailableTrip | null): PartyLimits {
  const min = Math.max(1, offer.product.minPartySize);
  const productMax = Math.max(min, Math.min(offer.product.maxPartySize, maxCount));
  if (!listing) return { min, max: productMax, seatsLeft: null };
  const { kind, total, remaining } = listing.capacity;
  if (kind === "whole_boat") return { min, max: Math.min(productMax, total), seatsLeft: null };
  return { min, max: Math.min(productMax, remaining), seatsLeft: remaining };
}

/** How many of an add-on a party may take. */
export function addOnLimit(addOn: TripOffer["addOns"][number], party: number): number {
  return addOn.quantityRule === "per_participant"
    ? addOn.maxQuantity * Math.max(party, 1)
    : addOn.maxQuantity;
}

/**
 * The first selection: what the address asks for, kept inside what the offer
 * sells. From the trips list, the party size becomes that many of the first
 * ticket type, or that many charter guests.
 */
export function initialSelection(
  offer: TripOffer,
  address: Pick<BookingAddress, "party" | "tickets" | "guests" | "addOns">,
  limits: PartyLimits,
): Selection {
  const tickets: Record<string, number> = {};
  for (const ticket of offer.tickets) tickets[ticket.code] = 0;
  let guests = Math.min(limits.max, Math.max(limits.min, address.guests ?? address.party ?? 1));
  if (isCharter(offer)) {
    guests = Math.max(1, guests);
  } else {
    let room = limits.max;
    const asked = offer.tickets.filter((t) => (address.tickets[t.code] ?? 0) > 0);
    if (asked.length > 0) {
      for (const ticket of asked) {
        const n = Math.min(address.tickets[ticket.code] ?? 0, room);
        tickets[ticket.code] = n;
        room -= n;
      }
    } else if (offer.tickets[0]) {
      tickets[offer.tickets[0].code] = Math.min(
        room,
        Math.max(limits.min, address.party ?? limits.min),
      );
    }
  }
  return fitAddOns(offer, { tickets, guests, addOns: address.addOns });
}

/** Keep add-ons to the ones offered, within their limits for the party. */
export function fitAddOns(offer: TripOffer, selection: Selection): Selection {
  const party = partySize(offer, selection);
  const addOns: Record<string, number> = {};
  for (const addOn of offer.addOns) {
    addOns[addOn.code] = Math.min(selection.addOns[addOn.code] ?? 0, addOnLimit(addOn, party));
  }
  return { ...selection, addOns };
}

/** The quote request for a selection. Counts of zero are left out, as the API requires. */
export function quoteBody(
  offer: TripOffer,
  selection: Selection,
  promotionCode: string | null,
): QuoteBody {
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
  return {
    tripId: offer.tripId,
    party,
    addOns,
    ...(promotionCode ? { promotionCode } : {}),
  };
}

/**
 * Whether a quote prices exactly this selection: the same tickets, or guests
 * aboard, and the same add-ons. A reload shows a stored quote only then.
 */
export function quoteMatches(offer: TripOffer, selection: Selection, quote: Quote): boolean {
  const quoted = (kind: Quote["lines"][number]["kind"]) =>
    sameCounts(
      Object.fromEntries(
        quote.lines.filter((l) => l.kind === kind).map((l) => [l.code, l.quantity]),
      ),
    );
  const chosen = (record: Record<string, number>) =>
    sameCounts(Object.fromEntries(Object.entries(record).filter(([, n]) => n > 0)));
  const addOns = quoted("add_on") === chosen(selection.addOns);
  if (isCharter(offer)) return addOns && quote.partySize === selection.guests;
  return addOns && quoted("ticket") === chosen(selection.tickets);
}

/** Counts as a stable string, so two sets of counts compare by value. */
function sameCounts(counts: Record<string, number>): string {
  return JSON.stringify(Object.entries(counts).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
}

/**
 * A problem with the party, before anything is sent. A party past a limit is
 * never cut down here: the guest's own count stays on screen beside the words.
 */
export function partyProblem(offer: TripOffer, selection: Selection, limits: PartyLimits) {
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

/** Add-ons past what this party may take, by code, in words for each field. */
export function addOnProblems(offer: TripOffer, selection: Selection): Record<string, string> {
  const party = partySize(offer, selection);
  const problems: Record<string, string> = {};
  for (const addOn of offer.addOns) {
    const count = selection.addOns[addOn.code] ?? 0;
    const most = addOnLimit(addOn, party);
    if (count <= most) continue;
    problems[addOn.code] =
      addOn.quantityRule === "per_participant"
        ? `Up to ${addOn.maxQuantity} per guest: ${most} for ${guests(party)}.`
        : `Up to ${most} per booking.`;
  }
  return problems;
}

/**
 * What changed when a smaller party lowered its add-ons, for the page to say
 * aloud: "Drink voucher lowered to 2, the most for 1 guest." Null when
 * nothing was lowered.
 */
export function addOnChangeText(offer: TripOffer, before: Selection, after: Selection) {
  const party = partySize(offer, after);
  const lowered = offer.addOns.filter(
    (a) => (after.addOns[a.code] ?? 0) < (before.addOns[a.code] ?? 0),
  );
  if (lowered.length === 0) return null;
  return lowered
    .map((a) => `${a.name} lowered to ${after.addOns[a.code] ?? 0}, the most for ${guests(party)}.`)
    .join(" ");
}

/** A count as a form holds it: an empty field is none, a typed number is that number. */
function formCount(data: FormData, name: string, fallback: number): number {
  const raw = data.get(name);
  if (typeof raw !== "string") return fallback;
  const text = raw.trim();
  if (text === "") return 0;
  return /^\d{1,4}$/.test(text) ? Number(text) : fallback;
}

/**
 * The selection as the party form holds it when it is sent, so what is priced
 * is exactly what the fields show, including a count still being typed.
 * Fields are named as the address names them: t.<code>, guests, a.<code>.
 */
export function committedSelection(
  offer: TripOffer,
  selection: Selection,
  data: FormData,
): Selection {
  const tickets: Record<string, number> = { ...selection.tickets };
  for (const ticket of offer.tickets) {
    tickets[ticket.code] = formCount(data, `t.${ticket.code}`, tickets[ticket.code] ?? 0);
  }
  const addOns: Record<string, number> = { ...selection.addOns };
  for (const addOn of offer.addOns) {
    addOns[addOn.code] = formCount(data, `a.${addOn.code}`, addOns[addOn.code] ?? 0);
  }
  const guestsAboard = isCharter(offer)
    ? formCount(data, "guests", selection.guests)
    : selection.guests;
  return { tickets, guests: guestsAboard, addOns };
}

/**
 * Keep a guest's choices when the trip's options load again: only what the
 * offer still sells, within the product's own limits. The seats left are not
 * applied here; a party past them stays, with the reason beside it.
 */
export function keepSelection(offer: TripOffer, current: Selection): Selection {
  return initialSelection(
    offer,
    { party: null, tickets: current.tickets, guests: current.guests, addOns: current.addOns },
    partyLimits(offer, null),
  );
}

export const guests = (n: number) => (n === 1 ? "1 guest" : `${n} guests`);

/**
 * Who is coming, in words: "3 guests: 2 Adult, 1 Child (3 to 12)" from a
 * quote's ticket lines, or "6 guests" for a charter or when no quote is known.
 */
export function describeParty(partySizeValue: number, quote: Quote | null): string {
  const tickets = quote?.lines.filter((l) => l.kind === "ticket") ?? [];
  if (tickets.length === 0) return guests(partySizeValue);
  return `${guests(partySizeValue)}: ${tickets.map((l) => `${l.quantity} ${l.name}`).join(", ")}`;
}

/** The paid extras, in words: "Souvenir photo × 1, Drink voucher × 2". Null when none. */
export function describeExtras(quote: Quote | null): string | null {
  const extras = quote?.lines.filter((l) => l.kind === "add_on" && l.quantity > 0) ?? [];
  if (extras.length === 0) return null;
  return extras.map((l) => `${l.name} × ${l.quantity}`).join(", ");
}

/**
 * A checkout's short reference for support, from its id: "3BA66E4F". Shown
 * where no booking reference exists, such as a refunded payment.
 */
export function shortReference(sessionId: string): string {
  return sessionId.replace(/-/g, "").slice(0, 8).toUpperCase();
}

// Prices ------------------------------------------------------------------------------

/** A ticket's or add-on's unit price: "$45.00 each", or "Free". */
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

export function feeText(fee: TripOffer["fees"][number]): string {
  const basis = fee.basis === "per_participant" ? "per guest" : "per booking";
  return `${fee.name}: ${formatMoney(fee.unitAmount)} ${basis}`;
}

/** How tax is shown before the price: added at checkout, or already included. */
export function taxText(offer: TripOffer): string | null {
  const rate = (t: TripOffer["taxes"][number]) => `${t.name} (${formatRatePpm(t.ratePpm)})`;
  const added = offer.taxes.filter((t) => !t.inclusive).map(rate);
  const included = offer.taxes.filter((t) => t.inclusive).map(rate);
  const parts: string[] = [];
  if (added.length > 0) parts.push(`${list(added)} ${added.length === 1 ? "is" : "are"} added.`);
  if (included.length > 0) parts.push(`Prices include ${list(included)}.`);
  return parts.length > 0 ? parts.join(" ") : null;
}

function list(items: string[]): string {
  if (items.length <= 1) return items.join("");
  return `${items.slice(0, -1).join(", ")} and ${items.at(-1)}`;
}

function quantityDetail(quantity: number, unitAmount: number): string {
  return unitAmount === 0 ? `${quantity} at no charge` : `${quantity} × ${formatMoney(unitAmount)}`;
}

/**
 * The quote as ledger rows, in the order its totals are built: the trip price
 * and add-ons, their subtotal, the discount, fees, added taxes, and the
 * total, then any tax already included in the prices.
 */
export function quoteRows(quote: Quote): LedgerRow[] {
  const rows: LedgerRow[] = [];
  const line = (l: Quote["lines"][number], kind: LedgerRow["kind"] = "item"): LedgerRow => ({
    id: `line-${l.lineNo}`,
    label: l.name,
    ...(l.kind === "charter" && l.quantity === 1
      ? {}
      : { detail: quantityDetail(l.quantity, l.unitAmount) }),
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
  for (const l of quote.lines) {
    if (l.kind === "discount") {
      rows.push({
        id: `line-${l.lineNo}`,
        label: l.name,
        // A code comes off the trip price only, never extras, fees, or tax.
        detail: "On the trip price, not extras",
        amount: formatMoney(l.amount),
        kind: "adjustment",
      });
    }
  }
  for (const l of quote.lines) if (l.kind === "fee") rows.push(line(l));
  for (const tax of quote.taxes) {
    if (!tax.inclusive) {
      rows.push({
        id: `tax-${tax.taxRateId}`,
        label: `${tax.name} (${formatRatePpm(tax.ratePpm)})`,
        amount: formatMoney(tax.amount),
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

/** U+00A0: keeps a time and its zone's name together, as the format module does. */
const nbsp = String.fromCharCode(0x00a0);

/**
 * A deadline, such as a price's or a hold's expiry, on the trip zone's clock
 * and named with the zone ("3:42 PM EDT"), so it reads the same for a guest
 * anywhere. A deadline on another day than today there names the day too.
 */
export function deadlineText(instant: string, timeZone: string, now: Date = new Date()): string {
  const at = inZone(instant, timeZone);
  const time = `${at.time}${nbsp}${at.abbreviation}`;
  return at.date === todayIn(timeZone, now) ? time : `${formatDate(at.date, "medium")}, ${time}`;
}

// Policy -------------------------------------------------------------------------------

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

/**
 * The policy in three short lines, on the marina's clock. Once the change
 * deadline has passed, the first line says so instead of offering it.
 */
export function policySummary(
  policy: PolicyTerms,
  trip: { timeZone: string; localDate: string; startsAt: string },
  now: number,
): string[] {
  const lines: string[] = [];
  const cutoff = Date.parse(policy.changeCutoffAt);
  if (now < cutoff) {
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

// Outcomes -----------------------------------------------------------------------------

export const finalStates: ReadonlySet<CheckoutSession["state"]> = new Set([
  "confirmed",
  "failed",
  "expired",
  "unfulfilled",
  "canceled",
]);

export const isFinal = (session: CheckoutSession) => finalStates.has(session.state);

/** The page's clocks, in milliseconds. Tests shorten them. */
export const timing = {
  /** The gentle backoff between reads of a checkout's state; the last repeats. */
  pollDelaysMs: [500, 1_000, 1_500, 2_000, 3_000, 5_000] as readonly number[],
  /** How often a deadline on screen ("about 14 minutes") is brought up to date. */
  clockTickMs: 5_000,
  /** Waits before sending a new checkout again when the provider did not answer. */
  providerRetryDelaysMs: [1_000, 2_000, 4_000] as readonly number[],
  /** After a payment button, how long the page waits before saying it is slow. */
  slowAfterMs: 15_000,
  /** How long after a hold's expiry the payment step reads the checkout's state. */
  expiryGraceMs: 1_000,
  /**
   * After a payment was sent, how long the page keeps reading a checkout that
   * reads expired: a late success can still book it, or refund it.
   */
  lateSuccessGraceMs: 30_000,
};

export function pollDelay(attempt: number): number {
  const delays = timing.pollDelaysMs;
  return delays[Math.min(attempt, delays.length - 1)] ?? 5_000;
}

// Failures -------------------------------------------------------------------------------

/** Why the trip itself cannot be booked here now. */
export type Stop = "not_found" | "not_bookable" | "pricing" | "payments";

export interface Trouble {
  /** Shown on the party fieldset. */
  party?: string;
  /** Shown on an add-on's field, by code. */
  addOns?: Record<string, string>;
  /** Shown on the promotion code field. */
  promo?: string;
  /** The trip's options changed since the page loaded them. */
  stale?: true;
  /** The trip cannot be booked; the page says so in place of the steps. */
  stop?: Stop;
  /** A notice at the step, with a way to try again. */
  notice?: { title: string; body: string };
  /** The quote is no longer usable: ask for a new one. */
  requote?: true;
}

const problemCodes: ReadonlySet<string> = new Set(QuoteProblemCode.options);

/**
 * The problems a 422 lists: "This quote cannot be priced:
 * add_on_quantity_exceeded (drinks), promotion_not_applicable". Only the
 * contract's problem codes count, so no word of other prose is taken for one.
 * When nothing in the message parses, the error's own code stands for the
 * problem, if it is one.
 */
export function quoteProblems(
  message: string,
  fallbackCode?: string,
): { code: string; subject: string | null }[] {
  const colon = message.indexOf(":");
  const detail = colon >= 0 ? message.slice(colon + 1) : "";
  const found = [...detail.matchAll(/([a-z_]+)(?: \(([a-z][a-z0-9_]*)\))?/g)]
    .filter((m) => problemCodes.has(m[1] as string))
    .map((m) => ({ code: m[1] as string, subject: m[2] ?? null }));
  if (found.length === 0 && fallbackCode && problemCodes.has(fallbackCode)) {
    return [{ code: fallbackCode, subject: null }];
  }
  return found;
}

const tryAgainNotice = {
  title: "We couldn't reach the booking service",
  body: "Check your connection, then try again.",
};
const serverNotice = {
  title: "Something went wrong on our side",
  body: "Wait a moment, then try again.",
};
const limitedNotice = {
  title: "Too many tries in a short time",
  body: "Wait a minute, then try again.",
};

/** A failure every call can meet: no answer, an unreadable answer, a server error, or the rate limit. */
function commonTrouble(failure: Failure): Trouble | null {
  if (failure.kind === "network") return { notice: tryAgainNotice };
  if (failure.kind === "unreadable") return { notice: serverNotice };
  if (failure.status === 429 && failure.code === "rate_limited") return { notice: limitedNotice };
  if (failure.status >= 500) return { notice: serverNotice };
  return null;
}

/**
 * Too few seats for the party. A charter whose boat is taken, or a trip with
 * no seats left, cannot be booked at all; "choose fewer guests" would mislead.
 */
function capacityTrouble(charter: boolean, seatsLeft: number | null, party: string): Trouble {
  if (charter || seatsLeft === 0) return { stop: "not_bookable" };
  return { party };
}

/** What a failed quote means for the page. */
export function quoteTrouble(failure: Failure, offer: TripOffer, limits: PartyLimits): Trouble {
  const common = commonTrouble(failure);
  if (common || failure.kind !== "refused") return common ?? { notice: serverNotice };
  const { status, code, message } = failure;
  const fewer = "There aren't enough seats left for this party. Choose fewer guests.";
  if (status === 404) return { stop: "not_found" };
  if (code === "trip_not_bookable") return { stop: "not_bookable" };
  if (code === "pricing_unavailable") return { stop: "pricing" };
  if (code === "insufficient_capacity") {
    return capacityTrouble(isCharter(offer), limits.seatsLeft, fewer);
  }
  if (status !== 422) return { notice: serverNotice };
  // The page always sends a fresh key with a new body, so a reused key is ours
  // to fix, not the guest's. Its message is prose, not a problem list.
  if (code === "idempotency_key_reused") return { notice: serverNotice };
  const trouble: Trouble = {};
  for (const problem of quoteProblems(message, code)) {
    const addOn = offer.addOns.find((a) => a.code === problem.subject);
    switch (problem.code) {
      case "pricing_unavailable":
        return { stop: "pricing" };
      case "insufficient_capacity": {
        const found = capacityTrouble(isCharter(offer), limits.seatsLeft, fewer);
        if (found.stop) return found;
        trouble.party = fewer;
        break;
      }
      case "promotion_not_applicable":
        trouble.promo = "This code can't be used for this trip. Check it, or book without it.";
        break;
      case "party_size_out_of_range":
        trouble.party = `This trip takes ${limits.min} to ${offer.product.maxPartySize} guests.`;
        break;
      case "add_on_quantity_exceeded":
        if (addOn) {
          trouble.addOns = {
            ...trouble.addOns,
            [addOn.code]: "That's more than this party can take.",
          };
        } else trouble.stale = true;
        break;
      case "add_on_unavailable":
        if (addOn) {
          trouble.addOns = {
            ...trouble.addOns,
            [addOn.code]: `${addOn.name} isn't offered on this date.`,
          };
        } else trouble.stale = true;
        break;
      case "quote_amount_too_large":
        trouble.party = "This booking is too large to pay online. Call or email to book it.";
        break;
      default:
        // A ticket type or add-on the server no longer knows, a duplicate, a
        // party of the wrong kind, a bad quantity: the page's options are out
        // of date.
        trouble.stale = true;
    }
  }
  if (!trouble.promo && !trouble.party && !trouble.addOns && !trouble.stale && !trouble.notice) {
    trouble.notice = serverNotice;
  }
  return trouble;
}

/**
 * What a refused checkout means for the page. The 503 retry is the caller's.
 * `charter`: the trip is a private charter, so too few seats means the boat is taken.
 */
export function checkoutTrouble(failure: Failure, operator: string, charter = false): Trouble {
  // Payments not configured: 409 from the operator's account, 503 from the API.
  if (failure.kind === "refused" && failure.code === "payments_unavailable") {
    return { stop: "payments" };
  }
  const common = commonTrouble(failure);
  if (common || failure.kind !== "refused") return common ?? { notice: serverNotice };
  const { status, code, message } = failure;
  switch (code) {
    case "quote_not_found":
    case "quote_expired":
    case "quote_already_used":
      return { requote: true };
    case "trip_not_bookable":
      return { stop: "not_bookable" };
    case "payments_unavailable":
      return { stop: "payments" };
    case "insufficient_capacity": {
      const seats = /Only (\d+) seat/.exec(message)?.[1];
      return capacityTrouble(
        charter,
        seats === undefined ? null : Number(seats),
        seats
          ? `Only ${seats} ${seats === "1" ? "seat is" : "seats are"} left now. Choose fewer guests.`
          : "There aren't enough seats left for this party now. Choose fewer guests.",
      );
    }
    case "party_size_out_of_range":
      return { party: "This trip no longer takes a party of this size." };
    case "payment_amount_too_small":
      return {
        notice: {
          title: "This total is too small to pay online",
          body: `Online payments start at $0.50. Call or email ${operator} to book.`,
        },
      };
    case "too_many_checkouts":
      return {
        notice: {
          title: "Too many checkouts are open",
          body: "Finish or cancel a checkout you started, or wait up to 15 minutes for it to end.",
        },
      };
    default:
      return status === 422 && code === "policy_not_accepted"
        ? { requote: true }
        : { notice: serverNotice };
  }
}
