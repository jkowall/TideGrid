// The guest is in Tokyo and the marina in New York: no rule or word here may follow the host zone.
process.env.TZ = "Asia/Tokyo";

import {
  type AvailableTrip,
  CheckoutSessionState,
  type PolicyTerms,
  type Quote,
  QuoteCreateRequest,
  type TripOffer,
} from "@tidegrid/contracts";
import type { LedgerRow } from "@tidegrid/design-system/components";
import { afterEach, describe, expect, it } from "vitest";
import type { BookingAddress } from "./address.ts";
import type { Failure } from "./api.ts";
import {
  charterListing,
  charterOffer,
  charterQuote,
  checkout,
  listing,
  offer,
  sharedQuote,
  testNow,
} from "./fixtures.ts";
import {
  addOnHint,
  addOnLimit,
  checkoutTrouble,
  contextOfOffer,
  contextOfQuote,
  deadlineText,
  describeParty,
  eachPrice,
  feeText,
  fitAddOns,
  guests as guestWords,
  heldThing,
  initialSelection,
  isCharter,
  isFinal,
  type PartyLimits,
  partyLimits,
  partyProblem,
  partySize,
  policySummary,
  pollDelay,
  quoteBody,
  quoteMatches,
  quoteProblems,
  quoteRows,
  quoteTrouble,
  remedyText,
  type Selection,
  type Trouble,
  taxText,
  timing,
} from "./model.ts";

/** U+00A0, which joins a time to AM or PM and to its zone's name. */
const nbsp = String.fromCharCode(0x00a0);
/** U+2212, which the money formatter uses for a negative amount. */
const minus = String.fromCharCode(0x2212);

const original = { ...timing };

afterEach(() => {
  Object.assign(timing, original);
});

// Fixtures, edited ------------------------------------------------------------------------

function addOnOf(from: TripOffer, code: string): TripOffer["addOns"][number] {
  const found = from.addOns.find((a) => a.code === code);
  if (!found) throw new Error(`no add-on ${code}`);
  return found;
}

/** The Harbor cruise's list entry with this many seats left. */
const withSeats = (remaining: number): AvailableTrip => ({
  ...listing,
  capacity: { kind: "seats", total: 20, remaining, soldOut: remaining === 0 },
});

/** The charter's list entry for a boat of this many guests. */
const boatOf = (total: number): AvailableTrip => ({
  ...charterListing,
  capacity: { kind: "whole_boat", total, remaining: total, soldOut: false },
});

const withMost = (from: TripOffer, maxPartySize: number): TripOffer => ({
  ...from,
  product: { ...from.product, maxPartySize },
});

type Asked = Pick<BookingAddress, "party" | "tickets" | "guests" | "addOns">;

/** What the address asks for; nothing unless a field says so. */
const asked = (fields: Partial<Asked> = {}): Asked => ({
  party: null,
  tickets: {},
  guests: null,
  addOns: {},
  ...fields,
});

const seatsFor = (
  tickets: Record<string, number>,
  addOns: Record<string, number> = {},
): Selection => ({ tickets, guests: 1, addOns });

const aboard = (n: number, addOns: Record<string, number> = {}): Selection => ({
  tickets: {},
  guests: n,
  addOns,
});

const harbor: PartyLimits = { min: 1, max: 10, seatsLeft: 20 };
const boat: PartyLimits = { min: 1, max: 12, seatsLeft: null };

const refused = (status: number, code: string, message = ""): Failure => ({
  kind: "refused",
  status,
  code,
  message,
});

/** A 422 as the API words it: the first problem is the code, the message lists them all. */
const cannotPrice = (...problems: string[]): Failure =>
  refused(
    422,
    (problems[0] ?? "").replace(/ \(.*\)$/, ""),
    `This quote cannot be priced: ${problems.join(", ")}`,
  );

/** A row as a Ledger reads it: a row with no kind is an item. */
const asRead = (rows: LedgerRow[]) => rows.map((row) => ({ ...row, kind: row.kind ?? "item" }));

const taxId = (quote: Quote, name: string) =>
  `tax-${quote.taxes.find((t) => t.name === name)?.taxRateId}`;

// The party ---------------------------------------------------------------------------------

describe("partyLimits", () => {
  it("allows the smaller of the product's most and the seats left on a shared trip", () => {
    expect(partyLimits(offer, listing)).toEqual({ min: 1, max: 10, seatsLeft: 20 });
    expect(partyLimits(offer, withSeats(4))).toEqual({ min: 1, max: 4, seatsLeft: 4 });
  });

  it("allows the product's most when no listing has said, and knows no seat count", () => {
    expect(partyLimits(offer, null)).toEqual({ min: 1, max: 10, seatsLeft: null });
  });

  it("allows a charter the smaller of the product's most and the boat's guests", () => {
    expect(partyLimits(charterOffer, charterListing)).toEqual(boat);
    expect(partyLimits(charterOffer, boatOf(8))).toEqual({ min: 1, max: 8, seatsLeft: null });
    expect(partyLimits(withMost(charterOffer, 6), charterListing)).toEqual({
      min: 1,
      max: 6,
      seatsLeft: null,
    });
  });

  it("keeps the smallest party at 1 or more and the largest within what an address may ask", () => {
    const odd = { ...offer, product: { ...offer.product, minPartySize: 0, maxPartySize: 1000 } };
    expect(partyLimits(odd, null)).toEqual({ min: 1, max: 500, seatsLeft: null });
  });
});

describe("addOnLimit", () => {
  const photo = addOnOf(offer, "photo");
  const drinks = addOnOf(offer, "drinks");

  it("limits a per-booking add-on to its own maximum, whatever the party", () => {
    expect(addOnLimit(photo, 1)).toBe(2);
    expect(addOnLimit(photo, 8)).toBe(2);
  });

  it("limits a per-guest add-on to its maximum for each guest", () => {
    expect(addOnLimit(drinks, 1)).toBe(2);
    expect(addOnLimit(drinks, 3)).toBe(6);
  });

  it("counts an empty party as one guest", () => {
    expect(addOnLimit(drinks, 0)).toBe(2);
  });
});

describe("partySize and the words for it", () => {
  it("adds up the tickets of a shared trip and takes a charter's guests", () => {
    expect(partySize(offer, seatsFor({ adult: 2, child: 1, infant: 0 }))).toBe(3);
    expect(partySize(offer, seatsFor({}))).toBe(0);
    expect(partySize(charterOffer, aboard(6))).toBe(6);
    expect(isCharter(offer)).toBe(false);
    expect(isCharter(charterOffer)).toBe(true);
  });

  it("says 1 guest and then n guests", () => {
    expect(guestWords(1)).toBe("1 guest");
    expect(guestWords(2)).toBe("2 guests");
  });
});

describe("initialSelection", () => {
  it("turns the party hint into that many of the first ticket type", () => {
    const selection = initialSelection(offer, asked({ party: 3 }), harbor);
    expect(selection.tickets).toEqual({ adult: 3, child: 0, infant: 0 });
    expect(selection.addOns).toEqual({ photo: 0, drinks: 0 });
  });

  it("starts from one of the first ticket type when the address asks for nothing", () => {
    expect(initialSelection(offer, asked(), harbor).tickets).toEqual({
      adult: 1,
      child: 0,
      infant: 0,
    });
  });

  it("keeps the party hint within the room left and above the smallest party", () => {
    const crowded = initialSelection(offer, asked({ party: 12 }), harbor);
    expect(crowded.tickets.adult).toBe(10);
    const fewSeats = partyLimits(offer, withSeats(4));
    expect(initialSelection(offer, asked({ party: 6 }), fewSeats).tickets.adult).toBe(4);
    const needsTwo: PartyLimits = { min: 2, max: 10, seatsLeft: null };
    expect(initialSelection(offer, asked({ party: 1 }), needsTwo).tickets.adult).toBe(2);
  });

  it("prefers explicit tickets to the party hint", () => {
    const selection = initialSelection(offer, asked({ party: 5, tickets: { child: 2 } }), harbor);
    expect(selection.tickets).toEqual({ adult: 0, child: 2, infant: 0 });
  });

  it("keeps explicit tickets as asked while they fit", () => {
    const selection = initialSelection(offer, asked({ tickets: { adult: 2, child: 1 } }), harbor);
    expect(selection.tickets).toEqual({ adult: 2, child: 1, infant: 0 });
  });

  it("cuts explicit tickets to the room left, in the offer's order", () => {
    const four: PartyLimits = { min: 1, max: 4, seatsLeft: 4 };
    const selection = initialSelection(offer, asked({ tickets: { child: 3, adult: 3 } }), four);
    expect(selection.tickets).toEqual({ adult: 3, child: 1, infant: 0 });
    const five: PartyLimits = { min: 1, max: 5, seatsLeft: 5 };
    const rest = initialSelection(
      offer,
      asked({ tickets: { adult: 2, child: 2, infant: 2 } }),
      five,
    );
    expect(rest.tickets).toEqual({ adult: 2, child: 2, infant: 1 });
  });

  it("drops ticket codes the offer does not sell", () => {
    const selection = initialSelection(offer, asked({ tickets: { senior: 2, adult: 1 } }), harbor);
    expect(selection.tickets).toEqual({ adult: 1, child: 0, infant: 0 });
    expect(Object.keys(selection.tickets)).not.toContain("senior");
  });

  it("falls back to the party hint when every asked code is unknown", () => {
    const selection = initialSelection(offer, asked({ tickets: { senior: 2 }, party: 2 }), harbor);
    expect(selection.tickets).toEqual({ adult: 2, child: 0, infant: 0 });
  });

  it("starts a charter at the guests asked for, or the party hint", () => {
    const withGuests = initialSelection(charterOffer, asked({ guests: 6 }), boat);
    expect(withGuests.guests).toBe(6);
    expect(withGuests.tickets).toEqual({});
    expect(initialSelection(charterOffer, asked({ party: 8 }), boat).guests).toBe(8);
    expect(initialSelection(charterOffer, asked({ guests: 8, party: 3 }), boat).guests).toBe(8);
    expect(initialSelection(charterOffer, asked(), boat).guests).toBe(1);
  });

  it("keeps a charter's guests between the smallest party and the most", () => {
    expect(initialSelection(charterOffer, asked({ guests: 20 }), boat).guests).toBe(12);
    const needsFour: PartyLimits = { min: 4, max: 12, seatsLeft: null };
    expect(initialSelection(charterOffer, asked({ guests: 2 }), needsFour).guests).toBe(4);
  });

  it("cuts add-ons to the ones offered and to their limits for the party", () => {
    const selection = initialSelection(
      offer,
      asked({ party: 2, addOns: { photo: 5, drinks: 9, ghost: 3 } }),
      harbor,
    );
    expect(selection.addOns).toEqual({ photo: 2, drinks: 4 });
  });
});

describe("fitAddOns", () => {
  it("lowers a per-guest add-on when the party shrinks", () => {
    const two = seatsFor({ adult: 2, child: 0, infant: 0 }, { photo: 1, drinks: 4 });
    expect(fitAddOns(offer, two).addOns).toEqual({ photo: 1, drinks: 4 });
    const one = fitAddOns(offer, { ...two, tickets: { adult: 1, child: 0, infant: 0 } });
    expect(one.addOns).toEqual({ photo: 1, drinks: 2 });
  });

  it("limits a charter's per-guest add-on by its guests", () => {
    expect(fitAddOns(charterOffer, aboard(6, { lunch: 9 })).addOns).toEqual({ lunch: 6 });
    expect(fitAddOns(charterOffer, aboard(3, { lunch: 9 })).addOns).toEqual({ lunch: 3 });
  });

  it("drops add-ons that are not offered and fills in zero for those not chosen", () => {
    const fitted = fitAddOns(offer, seatsFor({ adult: 1 }, { ghost: 2 }));
    expect(fitted.addOns).toEqual({ photo: 0, drinks: 0 });
  });

  it("leaves the tickets and the guests alone and does not change its input", () => {
    const chosen = seatsFor({ adult: 1, child: 1 }, { drinks: 9 });
    const fitted = fitAddOns(offer, chosen);
    expect(fitted.tickets).toEqual({ adult: 1, child: 1 });
    expect(fitted.guests).toBe(1);
    expect(chosen.addOns).toEqual({ drinks: 9 });
  });
});

describe("quoteBody", () => {
  const accepted = (body: unknown) => QuoteCreateRequest.safeParse(body).success;

  it("leaves out ticket types and add-ons at zero, and keeps the offer's order", () => {
    const body = quoteBody(
      offer,
      seatsFor({ infant: 1, adult: 2, child: 0 }, { photo: 0, drinks: 2 }),
      null,
    );
    expect(body).toEqual({
      tripId: offer.tripId,
      party: {
        kind: "tickets",
        tickets: [
          { code: "adult", quantity: 2 },
          { code: "infant", quantity: 1 },
        ],
      },
      addOns: [{ code: "drinks", quantity: 2 }],
    });
    expect(accepted(body)).toBe(true);
  });

  it("sends the promotion code only when one is given", () => {
    const chosen = seatsFor({ adult: 1 });
    expect(quoteBody(offer, chosen, null)).not.toHaveProperty("promotionCode");
    expect(quoteBody(offer, chosen, "")).not.toHaveProperty("promotionCode");
    const body = quoteBody(offer, chosen, "HARBOR10");
    expect(body).toHaveProperty("promotionCode", "HARBOR10");
    expect(accepted(body)).toBe(true);
  });

  it("asks for a charter by its guests, with no tickets", () => {
    const body = quoteBody(charterOffer, aboard(6, { lunch: 3 }), null);
    expect(body).toEqual({
      tripId: charterOffer.tripId,
      party: { kind: "charter", guests: 6 },
      addOns: [{ code: "lunch", quantity: 3 }],
    });
    expect(accepted(body)).toBe(true);
    expect(quoteBody(charterOffer, aboard(6), null).addOns).toEqual([]);
  });
});

describe("quoteMatches", () => {
  const addOns = { photo: 1, drinks: 2 };
  const priced = seatsFor({ adult: 2, child: 1 }, addOns);
  const quote = sharedQuote();
  const withoutAddOns = { ...quote, lines: quote.lines.filter((l) => l.kind !== "add_on") };

  it("is true for the selection the quote priced", () => {
    expect(quoteMatches(offer, priced, quote)).toBe(true);
  });

  it("ignores counts of zero, the order of the types, and a promotion", () => {
    const same = seatsFor({ infant: 0, child: 1, adult: 2 }, { drinks: 2, ghost: 0, photo: 1 });
    expect(quoteMatches(offer, same, quote)).toBe(true);
    expect(quoteMatches(offer, priced, sharedQuote({ promotion: true }))).toBe(true);
  });

  it("is false when a ticket count differs, or a ticket type is added or missing", () => {
    expect(quoteMatches(offer, seatsFor({ adult: 3, child: 1 }, addOns), quote)).toBe(false);
    expect(quoteMatches(offer, seatsFor({ adult: 1, child: 2 }, addOns), quote)).toBe(false);
    expect(quoteMatches(offer, seatsFor({ adult: 2 }, addOns), quote)).toBe(false);
    expect(quoteMatches(offer, seatsFor({ adult: 2, child: 1, infant: 1 }, addOns), quote)).toBe(
      false,
    );
  });

  it("is false when an add-on count differs, or an add-on is added or missing", () => {
    const tickets = { adult: 2, child: 1 };
    expect(quoteMatches(offer, seatsFor(tickets, { photo: 2, drinks: 2 }), quote)).toBe(false);
    expect(quoteMatches(offer, seatsFor(tickets, { photo: 1 }), quote)).toBe(false);
    expect(quoteMatches(offer, priced, withoutAddOns)).toBe(false);
    expect(quoteMatches(offer, seatsFor(tickets), withoutAddOns)).toBe(true);
  });

  it("compares a charter by its guests and its add-ons", () => {
    const chartered = charterQuote();
    expect(quoteMatches(charterOffer, aboard(6), chartered)).toBe(true);
    expect(quoteMatches(charterOffer, aboard(6, { lunch: 0 }), chartered)).toBe(true);
    expect(quoteMatches(charterOffer, aboard(5), chartered)).toBe(false);
    expect(quoteMatches(charterOffer, aboard(6, { lunch: 2 }), chartered)).toBe(false);
    const lunch: Quote["lines"][number] = {
      lineNo: 3,
      kind: "add_on",
      code: "lunch",
      name: "Catered lunch",
      basis: "per_participant",
      quantity: 6,
      unitAmount: 2500,
      amount: 15_000,
      discountAmount: 0,
      taxable: true,
      taxes: [],
    };
    const withLunch = { ...chartered, lines: [...chartered.lines, lunch] };
    expect(quoteMatches(charterOffer, aboard(6, { lunch: 6 }), withLunch)).toBe(true);
    expect(quoteMatches(charterOffer, aboard(6), withLunch)).toBe(false);
  });
});

describe("partyProblem", () => {
  it("asks for at least one ticket, or one guest on a charter", () => {
    expect(partyProblem(offer, seatsFor({ adult: 0, child: 0 }), harbor)).toBe(
      "Choose at least 1 ticket.",
    );
    expect(partyProblem(charterOffer, aboard(0), boat)).toBe("Choose at least 1 guest.");
  });

  it("names the smallest party when the party is below it", () => {
    const needsTwo: PartyLimits = { min: 2, max: 10, seatsLeft: null };
    expect(partyProblem(offer, seatsFor({ adult: 1 }), needsTwo)).toBe(
      "This trip needs at least 2 guests.",
    );
  });

  it("says how many seats are left when fewer than the product's most are", () => {
    const three: PartyLimits = { min: 1, max: 3, seatsLeft: 3 };
    expect(partyProblem(offer, seatsFor({ adult: 4 }), three)).toBe(
      "Only 3 seats are left. Choose fewer.",
    );
    const one: PartyLimits = { min: 1, max: 1, seatsLeft: 1 };
    expect(partyProblem(offer, seatsFor({ adult: 2 }), one)).toBe(
      "Only 1 seat is left. Choose fewer.",
    );
  });

  it("names the trip's most when the product's limit is the one exceeded", () => {
    const eleven = seatsFor({ adult: 11 });
    const plenty: PartyLimits = { min: 1, max: 10, seatsLeft: 20 };
    expect(partyProblem(offer, eleven, plenty)).toBe("This trip takes up to 10 guests.");
    // Seats left equal to the product's most is not "few seats left".
    const justEnough: PartyLimits = { min: 1, max: 10, seatsLeft: 10 };
    expect(partyProblem(offer, eleven, justEnough)).toBe("This trip takes up to 10 guests.");
    const unknown: PartyLimits = { min: 1, max: 10, seatsLeft: null };
    expect(partyProblem(offer, eleven, unknown)).toBe("This trip takes up to 10 guests.");
    expect(partyProblem(charterOffer, aboard(13), boat)).toBe("This trip takes up to 12 guests.");
  });

  it("finds no problem in a party from the smallest to the largest", () => {
    expect(partyProblem(offer, seatsFor({ adult: 1 }), harbor)).toBeNull();
    expect(partyProblem(offer, seatsFor({ adult: 6, child: 4 }), harbor)).toBeNull();
    expect(partyProblem(charterOffer, aboard(12), boat)).toBeNull();
  });
});

describe("describeParty", () => {
  it("lists a shared party's ticket lines from the quote", () => {
    expect(describeParty(3, sharedQuote())).toBe("3 guests: 2 Adult, 1 Child (3 to 12)");
  });

  it("says only how many guests when there is no quote, or no ticket line", () => {
    expect(describeParty(1, null)).toBe("1 guest");
    expect(describeParty(2, null)).toBe("2 guests");
    expect(describeParty(6, charterQuote())).toBe("6 guests");
  });
});

// Prices ------------------------------------------------------------------------------------

describe("prices, fees, and tax before any price", () => {
  it("says each price in dollars, and Free for none", () => {
    expect(eachPrice(4500)).toBe("$45.00 each");
    expect(eachPrice(1)).toBe("$0.01 each");
    expect(eachPrice(123_456)).toBe("$1,234.56 each");
    expect(eachPrice(0)).toBe("Free");
  });

  it("says an add-on's price and its limit per booking or per guest", () => {
    expect(addOnHint(addOnOf(offer, "photo"))).toBe("$12.00 each, up to 2 per booking");
    expect(addOnHint(addOnOf(offer, "drinks"))).toBe("$8.00 each, up to 2 per guest");
    expect(addOnHint({ ...addOnOf(offer, "photo"), unitAmount: 0 })).toBe(
      "Free, up to 2 per booking",
    );
  });

  it("says a fee's amount and what it is charged for", () => {
    expect(offer.fees.map(feeText)).toEqual(["Harbor fee: $2.50 per guest"]);
    expect(charterOffer.fees.map(feeText)).toEqual(["Fuel surcharge: $75.00 per booking"]);
  });

  describe("taxText", () => {
    const county = { name: "County surtax", ratePpm: 10_000, inclusive: false };
    const state = { name: "State sales tax", ratePpm: 60_000, inclusive: false };
    const levy = { name: "Harbor levy", ratePpm: 5000, inclusive: false };
    const taxed = (...taxes: TripOffer["taxes"]): TripOffer => ({ ...offer, taxes });

    it("says which taxes are added at checkout", () => {
      expect(taxText(offer)).toBe("County surtax (1%) and State sales tax (6%) are added.");
      expect(taxText(taxed(state))).toBe("State sales tax (6%) is added.");
      expect(taxText(taxed(county, state, levy))).toBe(
        "County surtax (1%), State sales tax (6%) and Harbor levy (0.5%) are added.",
      );
    });

    it("says which taxes the prices include", () => {
      expect(taxText(taxed({ ...state, inclusive: true }))).toBe(
        "Prices include State sales tax (6%).",
      );
      expect(taxText(taxed({ ...county, inclusive: true }, { ...state, inclusive: true }))).toBe(
        "Prices include County surtax (1%) and State sales tax (6%).",
      );
    });

    it("says both when some are added and some included", () => {
      expect(taxText(taxed(county, { ...state, inclusive: true }))).toBe(
        "County surtax (1%) is added. Prices include State sales tax (6%).",
      );
    });

    it("says nothing when there is no tax", () => {
      expect(taxText(taxed())).toBeNull();
    });
  });
});

describe("quoteRows", () => {
  it("lists a shared quote's lines, subtotal, fee, added taxes, and total, in that order", () => {
    const quote = sharedQuote();
    expect(asRead(quoteRows(quote))).toEqual([
      { id: "line-1", label: "Adult", detail: "2 × $45.00", amount: "$90.00", kind: "item" },
      {
        id: "line-2",
        label: "Child (3 to 12)",
        detail: "1 × $25.00",
        amount: "$25.00",
        kind: "item",
      },
      {
        id: "line-3",
        label: "Souvenir photo",
        detail: "1 × $12.00",
        amount: "$12.00",
        kind: "item",
      },
      { id: "line-4", label: "Drink voucher", detail: "2 × $8.00", amount: "$16.00", kind: "item" },
      { id: "subtotal", label: "Subtotal", amount: "$143.00", kind: "subtotal" },
      { id: "line-5", label: "Harbor fee", detail: "3 × $2.50", amount: "$7.50", kind: "item" },
      {
        id: taxId(quote, "County surtax"),
        label: "County surtax (1%)",
        amount: "$1.43",
        kind: "item",
      },
      {
        id: taxId(quote, "State sales tax"),
        label: "State sales tax (6%)",
        amount: "$8.58",
        kind: "item",
      },
      { id: "total", label: "Total", amount: "$160.51", kind: "total" },
    ]);
  });

  it("puts the discount after the subtotal, as an adjustment", () => {
    const quote = sharedQuote({ promotion: true });
    const rows = asRead(quoteRows(quote));
    expect(rows).toEqual([
      { id: "line-1", label: "Adult", detail: "2 × $45.00", amount: "$90.00", kind: "item" },
      {
        id: "line-2",
        label: "Child (3 to 12)",
        detail: "1 × $25.00",
        amount: "$25.00",
        kind: "item",
      },
      {
        id: "line-3",
        label: "Souvenir photo",
        detail: "1 × $12.00",
        amount: "$12.00",
        kind: "item",
      },
      { id: "line-4", label: "Drink voucher", detail: "2 × $8.00", amount: "$16.00", kind: "item" },
      { id: "subtotal", label: "Subtotal", amount: "$143.00", kind: "subtotal" },
      {
        id: "line-6",
        label: "HARBOR10, 10% off",
        amount: `${minus}$11.50`,
        kind: "adjustment",
      },
      { id: "line-5", label: "Harbor fee", detail: "3 × $2.50", amount: "$7.50", kind: "item" },
      {
        id: taxId(quote, "County surtax"),
        label: "County surtax (1%)",
        amount: "$1.32",
        kind: "item",
      },
      {
        id: taxId(quote, "State sales tax"),
        label: "State sales tax (6%)",
        amount: "$7.89",
        kind: "item",
      },
      { id: "total", label: "Total", amount: "$148.21", kind: "total" },
    ]);
    expect(rows.find((r) => r.kind === "adjustment")).not.toHaveProperty("detail");
  });

  it("gives a charter line no detail, and its fee a quantity", () => {
    const quote = charterQuote();
    const rows = quoteRows(quote);
    expect(rows[0]).not.toHaveProperty("detail");
    expect(asRead(rows)).toEqual([
      { id: "line-1", label: "Whole boat, up to 12 guests", amount: "$1,200.00", kind: "item" },
      { id: "subtotal", label: "Subtotal", amount: "$1,200.00", kind: "subtotal" },
      {
        id: "line-2",
        label: "Fuel surcharge",
        detail: "1 × $75.00",
        amount: "$75.00",
        kind: "item",
      },
      {
        id: taxId(quote, "State sales tax"),
        label: "State sales tax (7%)",
        amount: "$89.25",
        kind: "item",
      },
      { id: "total", label: "Total", amount: "$1,364.25", kind: "total" },
    ]);
  });

  it("reads a $0 ticket line as at no charge, and keeps the ticket lines together", () => {
    const quote = sharedQuote();
    const infant: Quote["lines"][number] = {
      lineNo: 6,
      kind: "ticket",
      code: "infant",
      name: "Infant (under 3)",
      basis: null,
      quantity: 1,
      unitAmount: 0,
      amount: 0,
      discountAmount: 0,
      taxable: false,
      taxes: [],
    };
    const rows = quoteRows({ ...quote, lines: [...quote.lines, infant] });
    expect(rows.map((r) => r.id).slice(0, 5)).toEqual([
      "line-1",
      "line-2",
      "line-6",
      "line-3",
      "line-4",
    ]);
    expect(rows[2]).toEqual({
      id: "line-6",
      label: "Infant (under 3)",
      detail: "1 at no charge",
      amount: "$0.00",
      kind: "item",
    });
    const twins = quoteRows({ ...quote, lines: [...quote.lines, { ...infant, quantity: 2 }] });
    expect(twins[2]?.detail).toBe("2 at no charge");
  });

  it("shows a tax already in the prices as a note after the total", () => {
    const quote = sharedQuote();
    const edited: Quote = {
      ...quote,
      taxes: quote.taxes.map((t) => (t.name === "County surtax" ? { ...t, inclusive: true } : t)),
    };
    const rows = asRead(quoteRows(edited));
    expect(rows.slice(-3)).toEqual([
      {
        id: taxId(quote, "State sales tax"),
        label: "State sales tax (6%)",
        amount: "$8.58",
        kind: "item",
      },
      { id: "total", label: "Total", amount: "$160.51", kind: "total" },
      {
        id: taxId(quote, "County surtax"),
        label: "Includes County surtax (1%)",
        amount: "$1.43",
        kind: "note",
      },
    ]);
    expect(rows.map((r) => r.label)).not.toContain("County surtax (1%)");
  });

  it("gives every row its own id", () => {
    for (const quote of [sharedQuote(), sharedQuote({ promotion: true }), charterQuote()]) {
      const ids = quoteRows(quote).map((r) => r.id);
      expect(new Set(ids).size).toBe(ids.length);
    }
  });
});

// Times and policy ---------------------------------------------------------------------------

describe("deadlineText", () => {
  it("names the time and the zone for a deadline today on the marina's clock", () => {
    // 12:30 PM in New York on Oct 5, which is already Oct 6 in Tokyo.
    expect(deadlineText("2026-10-05T16:30:00.000Z", "America/New_York", testNow)).toBe(
      `12:30${nbsp}PM${nbsp}EDT`,
    );
  });

  it("reads today by the marina's calendar, not UTC's or the host's", () => {
    // 11:30 PM on Oct 5 in New York, already Oct 6 in UTC and in Tokyo.
    expect(deadlineText("2026-10-06T03:30:00.000Z", "America/New_York", testNow)).toBe(
      `11:30${nbsp}PM${nbsp}EDT`,
    );
  });

  it("names the day first when the deadline is on another day", () => {
    expect(deadlineText("2026-10-07T22:00:00.000Z", "America/New_York", testNow)).toBe(
      `Wed, Oct 7, 6:00${nbsp}PM${nbsp}EDT`,
    );
    expect(deadlineText("2026-10-06T16:30:00.000Z", "America/New_York", testNow)).toBe(
      `Tue, Oct 6, 12:30${nbsp}PM${nbsp}EDT`,
    );
  });

  it("names the zone as it is at that instant, and reads another marina's clock", () => {
    const december = new Date("2026-12-01T12:00:00.000Z");
    expect(deadlineText("2026-12-01T17:00:00.000Z", "America/New_York", december)).toBe(
      `12:00${nbsp}PM${nbsp}EST`,
    );
    const honolulu = new Date("2026-10-05T20:00:00.000Z");
    expect(deadlineText("2026-10-05T22:30:00.000Z", "Pacific/Honolulu", honolulu)).toBe(
      `12:30${nbsp}PM${nbsp}HST`,
    );
  });
});

describe("remedyText", () => {
  it("words each remedy", () => {
    expect(remedyText({ remedy: "full_refund", refundBp: null })).toBe("a full refund");
    expect(remedyText({ remedy: "credit", refundBp: null })).toBe("a credit for a future trip");
    expect(remedyText({ remedy: "none", refundBp: null })).toBe("no refund");
    expect(remedyText({ remedy: "percent_refund", refundBp: null })).toBe("a partial refund");
  });

  it("states a percent refund from its basis points", () => {
    expect(remedyText({ remedy: "percent_refund", refundBp: 5000 })).toBe("a 50% refund");
    expect(remedyText({ remedy: "percent_refund", refundBp: 1250 })).toBe("a 12.5% refund");
  });
});

describe("policySummary", () => {
  const before = testNow.getTime();
  const cutoff = Date.parse(offer.policy.changeCutoffAt);

  it("gives the cancel line, the after line, and the no-show line before the cutoff", () => {
    expect(policySummary(offer.policy, offer.trip, before)).toEqual([
      `Cancel before Tue, Oct 6, 6:00${nbsp}PM for a full refund.`,
      "After that, canceling gets no refund.",
      "If you miss the trip, you get no refund.",
    ]);
  });

  it("says the deadline has passed, then the no-show line, once the cutoff is reached", () => {
    const passed = [
      "The deadline for changes has passed, so canceling now gets no refund.",
      "If you miss the trip, you get no refund.",
    ];
    expect(policySummary(offer.policy, offer.trip, cutoff)).toEqual(passed);
    expect(policySummary(offer.policy, offer.trip, cutoff + 60_000)).toEqual(passed);
    expect(policySummary(offer.policy, offer.trip, cutoff - 1)).toHaveLength(3);
  });

  it("says the day of the trip when the cutoff is on it", () => {
    const sameDay: PolicyTerms = { ...offer.policy, changeCutoffAt: "2026-10-07T18:00:00.000Z" };
    expect(policySummary(sameDay, offer.trip, before)[0]).toBe(
      `Cancel before 2:00${nbsp}PM on the day of the trip for a full refund.`,
    );
  });

  it("words each remedy where it applies", () => {
    const policy: PolicyTerms = {
      ...offer.policy,
      beforeCutoff: { remedy: "percent_refund", refundBp: 5000 },
      afterCutoff: { remedy: "credit", refundBp: null },
      noShow: { remedy: "full_refund", refundBp: null },
    };
    expect(policySummary(policy, offer.trip, before)).toEqual([
      `Cancel before Tue, Oct 6, 6:00${nbsp}PM for a 50% refund.`,
      "After that, canceling gets a credit for a future trip.",
      "If you miss the trip, you get a full refund.",
    ]);
    expect(policySummary(policy, offer.trip, cutoff)).toEqual([
      "The deadline for changes has passed, so canceling now gets a credit for a future trip.",
      "If you miss the trip, you get a full refund.",
    ]);
  });
});

// Failures ----------------------------------------------------------------------------------

describe("quoteProblems", () => {
  it("reads one problem, with no subject", () => {
    expect(quoteProblems("This quote cannot be priced: promotion_not_applicable")).toEqual([
      { code: "promotion_not_applicable", subject: null },
    ]);
  });

  it("reads several, in order, each with its subject when it has one", () => {
    const message =
      "This quote cannot be priced: add_on_quantity_exceeded (drinks), promotion_not_applicable";
    expect(quoteProblems(message)).toEqual([
      { code: "add_on_quantity_exceeded", subject: "drinks" },
      { code: "promotion_not_applicable", subject: null },
    ]);
  });

  it("reads a subject of letters, digits, and underscores", () => {
    expect(
      quoteProblems("This quote cannot be priced: add_on_unavailable (snorkel_gear2)"),
    ).toEqual([{ code: "add_on_unavailable", subject: "snorkel_gear2" }]);
  });

  it("finds none when nothing follows the colon", () => {
    expect(quoteProblems("")).toEqual([]);
    expect(quoteProblems("This quote cannot be priced: ")).toEqual([]);
  });
});

const noReach: Trouble = {
  notice: {
    title: "We couldn't reach the booking service",
    body: "Check your connection, then try again.",
  },
};
const serverSide: Trouble = {
  notice: { title: "Something went wrong on our side", body: "Wait a moment, then try again." },
};
const tooMany: Trouble = {
  notice: { title: "Too many tries in a short time", body: "Wait a minute, then try again." },
};

describe("quoteTrouble", () => {
  const cases: Array<[string, Failure, Trouble]> = [
    ["no answer", { kind: "network" }, noReach],
    ["an unreadable answer", { kind: "unreadable" }, serverSide],
    ["429 rate_limited", refused(429, "rate_limited"), tooMany],
    ["a 500", refused(500, "internal_error"), serverSide],
    ["a 503", refused(503, "database_unconfigured"), serverSide],
    ["a 500 that carries a code the page knows", refused(500, "trip_not_bookable"), serverSide],
    ["a 404", refused(404, "trip_not_found"), { stop: "not_found" }],
    ["409 trip_not_bookable", refused(409, "trip_not_bookable"), { stop: "not_bookable" }],
    ["409 pricing_unavailable", refused(409, "pricing_unavailable"), { stop: "pricing" }],
    [
      "409 insufficient_capacity",
      refused(409, "insufficient_capacity", "This quote cannot be priced: insufficient_capacity"),
      { party: "There aren't enough seats left for this party. Choose fewer guests." },
    ],
    ["another 409", refused(409, "something_new"), serverSide],
    ["a 400", refused(400, "validation_failed"), serverSide],
    [
      "422 promotion_not_applicable",
      cannotPrice("promotion_not_applicable"),
      { promo: "This code can't be used for this trip. Check it, or book without it." },
    ],
    [
      "422 party_size_out_of_range",
      cannotPrice("party_size_out_of_range"),
      { party: "This trip takes 1 to 10 guests." },
    ],
    [
      "422 add_on_quantity_exceeded (drinks)",
      cannotPrice("add_on_quantity_exceeded (drinks)"),
      { addOns: { drinks: "That's more than this party can take." } },
    ],
    [
      "422 add_on_quantity_exceeded (nonexistent), a stale page",
      cannotPrice("add_on_quantity_exceeded (nonexistent)"),
      { stale: true },
    ],
    [
      "422 add_on_unavailable (photo)",
      cannotPrice("add_on_unavailable (photo)"),
      { addOns: { photo: "Souvenir photo isn't offered on this date." } },
    ],
    [
      "422 add_on_unavailable (nonexistent), a stale page",
      cannotPrice("add_on_unavailable (nonexistent)"),
      { stale: true },
    ],
    [
      "422 quote_amount_too_large",
      cannotPrice("quote_amount_too_large"),
      { party: "This booking is too large to pay online. Call or email to book it." },
    ],
    [
      "422 unknown_ticket_type (adult), a stale page",
      cannotPrice("unknown_ticket_type (adult)"),
      { stale: true },
    ],
    ["422 party_kind_mismatch, a stale page", cannotPrice("party_kind_mismatch"), { stale: true }],
    [
      "422 idempotency_key_reused, listed as a problem",
      cannotPrice("idempotency_key_reused"),
      serverSide,
    ],
    [
      "422 listing two problems",
      cannotPrice("add_on_quantity_exceeded (drinks)", "promotion_not_applicable"),
      {
        addOns: { drinks: "That's more than this party can take." },
        promo: "This code can't be used for this trip. Check it, or book without it.",
      },
    ],
    [
      "422 listing two add-ons",
      cannotPrice("add_on_quantity_exceeded (drinks)", "add_on_unavailable (photo)"),
      {
        addOns: {
          drinks: "That's more than this party can take.",
          photo: "Souvenir photo isn't offered on this date.",
        },
      },
    ],
    [
      "422 listing a stale ticket type and a promotion",
      cannotPrice("unknown_ticket_type (adult)", "promotion_not_applicable"),
      {
        stale: true,
        promo: "This code can't be used for this trip. Check it, or book without it.",
      },
    ],
    ["422 listing no problem", refused(422, "unknown", ""), serverSide],
    [
      "422 idempotency_key_reused, in the API's own words",
      refused(
        422,
        "idempotency_key_reused",
        "idempotency key was already used with a different request",
      ),
      serverSide,
    ],
  ];

  it.each(cases)("answers %s", (_name, failure, expected) => {
    expect(quoteTrouble(failure, offer, harbor)).toEqual(expected);
  });

  it("names the product's most and the party's smallest when the size is out of range", () => {
    const needsTwo: PartyLimits = { min: 2, max: 4, seatsLeft: 4 };
    expect(quoteTrouble(cannotPrice("party_size_out_of_range"), offer, needsTwo)).toEqual({
      party: "This trip takes 2 to 10 guests.",
    });
  });
});

describe("checkoutTrouble", () => {
  const operator = "Demo Harbor Charters";
  const cases: Array<[string, Failure, Trouble]> = [
    ["no answer", { kind: "network" }, noReach],
    ["an unreadable answer", { kind: "unreadable" }, serverSide],
    ["429 rate_limited", refused(429, "rate_limited"), tooMany],
    ["a 500", refused(500, "internal_error"), serverSide],
    ["503 payment_provider_unavailable", refused(503, "payment_provider_unavailable"), serverSide],
    ["a 500 that carries a code the page knows", refused(500, "quote_expired"), serverSide],
    ["409 payments_unavailable", refused(409, "payments_unavailable"), { stop: "payments" }],
    ["503 payments_unavailable", refused(503, "payments_unavailable"), { stop: "payments" }],
    ["404 quote_not_found", refused(404, "quote_not_found"), { requote: true }],
    ["409 quote_expired", refused(409, "quote_expired"), { requote: true }],
    ["409 quote_already_used", refused(409, "quote_already_used"), { requote: true }],
    ["409 trip_not_bookable", refused(409, "trip_not_bookable"), { stop: "not_bookable" }],
    [
      "409 insufficient_capacity, with the seats left",
      refused(409, "insufficient_capacity", "Only 3 seat(s) are left on this trip"),
      { party: "Only 3 seats are left now. Choose fewer guests." },
    ],
    [
      "409 insufficient_capacity, with one seat left",
      refused(409, "insufficient_capacity", "Only 1 seat(s) are left on this trip"),
      { party: "Only 1 seat is left now. Choose fewer guests." },
    ],
    [
      "409 insufficient_capacity, with no count",
      refused(409, "insufficient_capacity", "No seats"),
      { party: "There aren't enough seats left for this party now. Choose fewer guests." },
    ],
    [
      "409 party_size_out_of_range",
      refused(409, "party_size_out_of_range"),
      { party: "This trip no longer takes a party of this size." },
    ],
    [
      "422 payment_amount_too_small",
      refused(422, "payment_amount_too_small", "Online payments start at 50 cents"),
      {
        notice: {
          title: "This total is too small to pay online",
          body: "Online payments start at $0.50. Call or email Demo Harbor Charters to book.",
        },
      },
    ],
    [
      "429 too_many_checkouts",
      refused(429, "too_many_checkouts", "At most 3 open checkouts at a time"),
      {
        notice: {
          title: "Too many checkouts are open",
          body: "Finish or cancel a checkout you started, or wait up to 15 minutes for it to end.",
        },
      },
    ],
    [
      "422 policy_not_accepted",
      refused(422, "policy_not_accepted", "Accept policy version 1 to continue"),
      { requote: true },
    ],
    ["422 idempotency_key_reused", refused(422, "idempotency_key_reused"), serverSide],
    ["an unknown 422", refused(422, "something_new"), serverSide],
    ["an unknown 409", refused(409, "something_new"), serverSide],
  ];

  it.each(cases)("answers %s", (_name, failure, expected) => {
    expect(checkoutTrouble(failure, operator)).toEqual(expected);
  });

  it("names the operator the guest can call or email when the total is too small", () => {
    const trouble = checkoutTrouble(refused(422, "payment_amount_too_small"), "Blue Dock Tours");
    expect(trouble.notice?.body).toBe(
      "Online payments start at $0.50. Call or email Blue Dock Tours to book.",
    );
  });
});

// Clocks and states -----------------------------------------------------------------------------

describe("pollDelay", () => {
  it("follows the timing's delays and repeats the last", () => {
    const delays = timing.pollDelaysMs;
    const last = delays.at(-1);
    expect(delays.length).toBeGreaterThan(1);
    for (const [attempt, delay] of delays.entries()) expect(pollDelay(attempt)).toBe(delay);
    expect(pollDelay(delays.length)).toBe(last);
    expect(pollDelay(delays.length + 50)).toBe(last);
  });

  it("follows a shorter list the page's tests set", () => {
    timing.pollDelaysMs = [5, 10];
    expect([0, 1, 2, 3, 9].map(pollDelay)).toEqual([5, 10, 10, 10, 10]);
    timing.pollDelaysMs = [7];
    expect([0, 1, 4].map(pollDelay)).toEqual([7, 7, 7]);
  });

  it("falls back to five seconds when no delay is set", () => {
    timing.pollDelaysMs = [];
    expect(pollDelay(0)).toBe(5000);
    expect(pollDelay(3)).toBe(5000);
  });

  it("is put back after each test", () => {
    expect(timing).toEqual(original);
  });
});

describe("isFinal", () => {
  const states: Array<[CheckoutSessionState, boolean]> = [
    ["open", false],
    ["confirmed", true],
    ["failed", true],
    ["expired", true],
    ["unfulfilled", true],
    ["canceled", true],
  ];

  it.each(states)("says %s is final: %s", (state, final) => {
    expect(isFinal(checkout(state))).toBe(final);
  });

  it("covers every state the contract has", () => {
    expect([...CheckoutSessionState.options].sort()).toEqual(states.map(([s]) => s).sort());
  });
});

describe("what the page shows about the trip", () => {
  it("takes the trip from the offer", () => {
    expect(contextOfOffer(offer)).toEqual({
      tripId: offer.tripId,
      productName: "Sunset Harbor Cruise",
      charter: false,
      trip: offer.trip,
    });
    expect(contextOfOffer(charterOffer)).toEqual({
      tripId: charterOffer.tripId,
      productName: "Private Half-Day Charter",
      charter: true,
      trip: charterOffer.trip,
    });
  });

  it("takes the same from a quote, which keeps the trip's snapshot", () => {
    const shared = sharedQuote();
    expect(contextOfQuote(shared)).toEqual({
      tripId: shared.tripId,
      productName: "Sunset Harbor Cruise",
      charter: false,
      trip: offer.trip,
    });
    const charter = charterQuote();
    expect(contextOfQuote(charter)).toEqual({
      tripId: charter.tripId,
      productName: "Private Half-Day Charter",
      charter: true,
      trip: charterOffer.trip,
    });
  });

  it("names what a hold keeps", () => {
    expect(heldThing(false)).toBe("your seats");
    expect(heldThing(true)).toBe("the boat");
  });
});
