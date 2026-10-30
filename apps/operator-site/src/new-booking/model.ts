import type { BookingChannel, Quote, StaffCheckout, TripOffer } from "@tidegrid/contracts";
import type { LedgerRow } from "@tidegrid/design-system/components";
import { formatMoney } from "@tidegrid/design-system/format";

/**
 * Staff-assisted booking (G2.12d): the pure parts of the console's new
 * booking page. The party as staff count it, what the quote request says,
 * the booker's details as the API will take them, the quote as a ledger, and
 * what each refusal means for the person at the desk. No request and no DOM.
 */

/** The page's address: book a guest on one trip. No personal data in it. */
export const newBookingHref = (tripId: string) => `/trips/${encodeURIComponent(tripId)}/book`;

export const channelOptions: readonly { value: BookingChannel; label: string }[] = [
  { value: "phone", label: "Phone" },
  { value: "email", label: "Email" },
  { value: "walk_up", label: "Walk-up" },
];

export const channelLabels: Record<BookingChannel, string> = {
  phone: "phone",
  email: "email",
  walk_up: "walk-up",
};

/** What the Book rule reads of a trip: the calendar's, the roster's, and the day list's. */
export interface BookableTrip {
  salesState: string;
  startsAt: string;
  salesCloseAt?: string | undefined;
  blackedOut?: boolean | undefined;
}

/**
 * Whether a trip still takes a staff booking (G2.12d): the calendar's Book
 * rule, so the console never offers a booking the API refuses for these
 * reasons. On sale, not blacked out, and before its cutoff and departure. A
 * roster read from before G2.12d, without the cutoff, falls back to departure.
 * The API still decides: it also refuses a full trip and an inactive product,
 * location, or boat, and the new booking page says so.
 */
export function takesBooking(trip: BookableTrip, now: Date): boolean {
  if (trip.salesState !== "published" || trip.blackedOut === true) return false;
  const closes = Date.parse(trip.salesCloseAt ?? trip.startsAt);
  return closes > now.getTime() && Date.parse(trip.startsAt) > now.getTime();
}

/**
 * The Book rule for a trip on the day list (G2.12e). It fails closed: with
 * either input missing, as from an API before G2.12e, it offers no Book.
 */
export function dayTripTakesBooking(trip: BookableTrip, now: Date): boolean {
  return trip.salesCloseAt !== undefined && trip.blackedOut === false && takesBooking(trip, now);
}

/** "Staff booking, phone": how a booking's source reads beside it. */
export function sourceText(source: string | undefined, channel: BookingChannel | null | undefined) {
  if (source !== "staff_assisted") return "Online, by the guest";
  return channel ? `Staff booking, ${channelLabels[channel]}` : "Staff booking";
}

export interface PartyDraft {
  /** Shared seats: a count per ticket code. */
  tickets: Record<string, number>;
  /** A charter: guests aboard. */
  guests: number;
  addOns: Record<string, number>;
  promotionCode: string;
}

export function emptyParty(offer: TripOffer): PartyDraft {
  return {
    tickets: Object.fromEntries(offer.tickets.map((t) => [t.code, 0])),
    guests: offer.product.kind === "private_charter" ? offer.product.minPartySize : 0,
    addOns: Object.fromEntries(offer.addOns.map((a) => [a.code, 0])),
    promotionCode: "",
  };
}

export function guestsOf(offer: TripOffer, party: PartyDraft): number {
  return offer.product.kind === "private_charter"
    ? party.guests
    : Object.values(party.tickets).reduce((sum, n) => sum + n, 0);
}

/** What stops the party from being priced, in words, or null. */
export function partyProblem(offer: TripOffer, party: PartyDraft): string | null {
  const guests = guestsOf(offer, party);
  const { minPartySize: min, maxPartySize: max } = offer.product;
  if (guests < 1) return "Add at least one guest.";
  if (guests < min) return `This trip takes parties of ${min} to ${max}.`;
  if (guests > max) return `This trip takes parties of ${min} to ${max}.`;
  return null;
}

/** The quote request for the party, as the API's QuoteCreateRequest. */
export function quoteRequest(offer: TripOffer, party: PartyDraft) {
  const code = party.promotionCode.trim();
  return {
    tripId: offer.tripId,
    party:
      offer.product.kind === "private_charter"
        ? { kind: "charter" as const, guests: party.guests }
        : {
            kind: "tickets" as const,
            tickets: offer.tickets
              .map((t) => ({ code: t.code, quantity: party.tickets[t.code] ?? 0 }))
              .filter((t) => t.quantity > 0),
          },
    addOns: offer.addOns
      .map((a) => ({ code: a.code, quantity: party.addOns[a.code] ?? 0 }))
      .filter((a) => a.quantity > 0),
    ...(code ? { promotionCode: code } : {}),
  };
}

/** The most of one add-on a party may take. */
export function addOnLimit(offer: TripOffer, code: string, party: PartyDraft): number {
  const addOn = offer.addOns.find((a) => a.code === code);
  if (!addOn) return 0;
  return addOn.quantityRule === "per_participant"
    ? addOn.maxQuantity * Math.max(guestsOf(offer, party), 1)
    : addOn.maxQuantity;
}

export interface BookerDraft {
  name: string;
  email: string;
}

// C0 and C1 controls, which the API refuses.
// biome-ignore lint/suspicious/noControlCharactersInRegex: the pattern exists to reject them.
const controls = /[\u0000-\u001f\u007f-\u009f]/;

/** The booker's details as the API takes them: a trimmed name and a lowercase ASCII address. */
export function cleanBooker(draft: BookerDraft): BookerDraft {
  return { name: draft.name.trim(), email: draft.email.trim().toLowerCase() };
}

export function bookerProblems(draft: BookerDraft): { name?: string; email?: string } {
  const { name, email } = cleanBooker(draft);
  const problems: { name?: string; email?: string } = {};
  if (name.length === 0) problems.name = "Enter the guest's name.";
  else if (name.length > 120) problems.name = "Use at most 120 characters.";
  else if (controls.test(name)) problems.name = "Use letters, spaces, and punctuation only.";
  if (email.length === 0) problems.email = "Enter the guest's email address.";
  else if (
    email.length > 254 ||
    !/^[\x21-\x7e]+$/.test(email) ||
    !/^[^@]+@[^@]+\.[^@]+$/.test(email)
  ) {
    problems.email = "Enter an address like name@example.com, in plain letters and digits.";
  }
  return problems;
}

/** The quote as a ledger: lines, the discount, fees, taxes, and the total, from the server's figures. */
export function quoteLedger(quote: Quote): LedgerRow[] {
  const rows: LedgerRow[] = quote.lines.map((line) => ({
    id: `line-${line.lineNo}`,
    label: line.name,
    detail:
      line.kind === "discount" || line.kind === "charter"
        ? undefined
        : `${line.quantity} × ${formatMoney(line.unitAmount)}`,
    amount: formatMoney(line.amount),
    kind: line.kind === "discount" ? ("adjustment" as const) : ("item" as const),
  }));
  for (const tax of quote.taxes) {
    rows.push({
      id: `tax-${tax.taxRateId}`,
      label: tax.inclusive ? `${tax.name} (included)` : tax.name,
      amount: formatMoney(tax.amount),
      kind: tax.inclusive ? "note" : "item",
    });
  }
  rows.push({
    id: "total",
    label: "Total",
    amount: formatMoney(quote.totals.total),
    kind: "total",
  });
  return rows;
}

/** A refusal's code, and what the person at the desk can do about it. */
export interface Refusal {
  title: string;
  body: string;
  /** requote: price again from the party; retry: send the same request again; stop: nothing here helps. */
  next: "requote" | "retry" | "stop" | "edit";
}

/**
 * The command a problem came from, so its copy and its Try again are that
 * command's. `check` is Check again on the outcome: an uncertain payment's
 * own request again, on a canceled checkout, then a read.
 */
export type BookingCommand = "quote" | "open" | "pay" | "cancel" | "edit" | "check";

/** What failed, in words, for a command that got no usable answer. */
export const commandFailureTitles: Record<BookingCommand, string> = {
  quote: "The party couldn't be priced",
  open: "The seats couldn't be held",
  pay: "The test payment may not have gone through",
  cancel: "The hold couldn't be released",
  edit: "The details couldn't be changed",
  check: "The payment couldn't be checked",
};

export function refusalOf(code: string | undefined, command?: BookingCommand): Refusal {
  if (code === "payment_provider_unavailable" && command === "check") {
    return {
      title: "The payment provider didn't answer",
      body: "The payment's result couldn't be checked yet. The same request goes again, so nothing is charged twice.",
      next: "retry",
    };
  }
  if (code === "payment_provider_unavailable" && command === "pay") {
    return {
      title: "The test payment may not have gone through",
      body: "The payment provider didn't answer, so it may have gone through or not. Try again: the same request is sent, so the guest is never charged twice.",
      next: "retry",
    };
  }
  switch (code) {
    case "quote_expired":
    case "quote_already_used":
    case "quote_not_found":
      return {
        title: "The price needs refreshing",
        body: "The quote is no longer valid. Price the party again, then check the total with the guest.",
        next: "requote",
      };
    case "insufficient_capacity":
      return {
        title: "Not enough seats left",
        body: "Someone else took the seats. Tell the guest, and try a smaller party or another trip.",
        next: "edit",
      };
    case "party_size_out_of_range":
      return {
        title: "This trip doesn't take a party of this size",
        body: "Change the party, then price it again.",
        next: "edit",
      };
    case "trip_not_bookable":
      return {
        title: "This trip isn't on sale now",
        body: "Sales may have closed, the cutoff passed, or the trip was canceled. Staff follow the same sales rules as guests.",
        next: "stop",
      };
    case "pricing_unavailable":
      return {
        title: "This trip can't be priced yet",
        body: "It has no price list or policy. An owner sets them in the catalog.",
        next: "stop",
      };
    case "payments_unavailable":
      return {
        title: "This operator can't take payments yet",
        body: "Nothing was booked. An owner connects payments before bookings can be paid.",
        next: "stop",
      };
    case "too_many_checkouts":
      return {
        title: "You have three bookings waiting for payment",
        body: "Held seats are released within 15 minutes of being held. Try again once one of them has been paid, canceled, or released.",
        next: "stop",
      };
    case "checkout_not_cancelable":
      return {
        title: "This booking can no longer be canceled here",
        body: "Its payment was decided first. See where it stands below.",
        next: "stop",
      };
    case "test_payment_settled":
      return {
        title: "This test payment was already decided",
        body: "The provider settled it the other way first. See where the booking stands below.",
        next: "stop",
      };
    case "payment_provider_unavailable":
      return {
        title: "The payment provider didn't answer",
        body: "The seats are held. Try again: the same booking is sent, so nothing is held twice.",
        next: "retry",
      };
    case "policy_not_accepted":
      return {
        title: "The policy changed",
        body: "The trip's policy has a new version. Price the party again and tell the guest the new policy.",
        next: "requote",
      };
    case "payment_amount_too_small":
      return {
        title: "This total is too small to pay",
        body: "Payments start at 50 cents. Change the party, then price it again.",
        next: "edit",
      };
    case "promotion_not_applicable":
      return {
        title: "That promotion code doesn't apply",
        body: "Check the code with the guest, or remove it.",
        next: "edit",
      };
    case "checkout_not_open":
      return {
        title: "This booking is no longer waiting for payment",
        body: "Its hold ended or it was canceled. Nothing was charged now.",
        next: "stop",
      };
    case "idempotency_key_reused":
      return {
        title: "This request was already used for something else",
        body: "Start the booking again from the trip.",
        next: "stop",
      };
    default:
      if (
        code &&
        /^(unknown_|duplicate_|add_on_|invalid_quantity|party_kind_mismatch)/.test(code)
      ) {
        return {
          title: "This party can't be priced",
          body: "Check the tickets and extras, then price it again.",
          next: "edit",
        };
      }
      return {
        title: command ? commandFailureTitles[command] : "That didn't work",
        body: "TideGrid couldn't finish this. Try again in a moment.",
        next: "retry",
      };
  }
}

/** Where a checkout stands, for the outcome step. */
export type Outcome = "waiting" | "confirmed" | "declined" | "unfulfilled" | "expired" | "canceled";

export function outcomeOf(checkout: Pick<StaffCheckout, "state">): Outcome {
  switch (checkout.state) {
    case "open":
      return "waiting";
    case "confirmed":
      return "confirmed";
    case "failed":
      return "declined";
    case "unfulfilled":
      return "unfulfilled";
    case "expired":
      return "expired";
    case "canceled":
      return "canceled";
  }
}

/** A fresh Idempotency-Key. */
export const newKey = () => crypto.randomUUID();
