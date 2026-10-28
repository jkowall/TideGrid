import { describe, expect, it } from "vitest";
import { charterOffer, quoteFor, sharedOffer } from "./fixtures.ts";
import {
  addOnLimit,
  bookerProblems,
  cleanBooker,
  emptyParty,
  guestsOf,
  newBookingHref,
  outcomeOf,
  partyProblem,
  quoteLedger,
  quoteRequest,
  refusalOf,
  sourceText,
} from "./model.ts";

describe("the party (G2.12d)", () => {
  it("starts empty for shared seats and at the minimum for a charter", () => {
    expect(emptyParty(sharedOffer())).toEqual({
      tickets: { adult: 0, child: 0 },
      guests: 0,
      addOns: { photo: 0 },
      promotionCode: "",
    });
    expect(emptyParty(charterOffer()).guests).toBe(2);
  });

  it("counts guests and refuses parties outside the product's range", () => {
    const offer = sharedOffer();
    const party = { ...emptyParty(offer), tickets: { adult: 2, child: 1 } };
    expect(guestsOf(offer, party)).toBe(3);
    expect(partyProblem(offer, party)).toBeNull();
    expect(partyProblem(offer, emptyParty(offer))).toBe("Add at least one guest.");
    expect(partyProblem(offer, { ...party, tickets: { adult: 9, child: 0 } })).toBe(
      "This trip takes parties of 1 to 8.",
    );
    const charter = charterOffer();
    expect(partyProblem(charter, { ...emptyParty(charter), guests: 7 })).toBe(
      "This trip takes parties of 2 to 6.",
    );
  });

  it("asks for only the counted tickets and extras, and a trimmed promotion code", () => {
    const offer = sharedOffer();
    expect(
      quoteRequest(offer, {
        tickets: { adult: 2, child: 0 },
        guests: 0,
        addOns: { photo: 1 },
        promotionCode: "  SAVE10 ",
      }),
    ).toEqual({
      tripId: offer.tripId,
      party: { kind: "tickets", tickets: [{ code: "adult", quantity: 2 }] },
      addOns: [{ code: "photo", quantity: 1 }],
      promotionCode: "SAVE10",
    });
    expect(
      quoteRequest(charterOffer(), { ...emptyParty(charterOffer()), guests: 4 }).party,
    ).toEqual({ kind: "charter", guests: 4 });
  });

  it("limits an add-on per booking or per guest", () => {
    const offer = sharedOffer({
      addOns: [
        {
          code: "snorkel",
          name: "Snorkel set",
          unitAmount: 1200,
          quantityRule: "per_participant",
          maxQuantity: 1,
          taxable: true,
        },
      ],
    });
    const party = { ...emptyParty(offer), tickets: { adult: 3, child: 0 } };
    expect(addOnLimit(offer, "snorkel", party)).toBe(3);
    expect(addOnLimit(sharedOffer(), "photo", party)).toBe(1);
    expect(addOnLimit(offer, "unknown", party)).toBe(0);
  });
});

describe("the booker", () => {
  it("takes a trimmed name and a lowercase ASCII address", () => {
    expect(cleanBooker({ name: "  Rosa T ", email: " Rosa@Guest.Example " })).toEqual({
      name: "Rosa T",
      email: "rosa@guest.example",
    });
    expect(bookerProblems({ name: "Rosa", email: "rosa@guest.example" })).toEqual({});
  });

  it.each([
    [{ name: "", email: "a@b.co" }, "name"],
    [{ name: "x".repeat(121), email: "a@b.co" }, "name"],
    [{ name: "Rosa\u0007", email: "a@b.co" }, "name"],
    [{ name: "Rosa", email: "" }, "email"],
    [{ name: "Rosa", email: "rosa at home" }, "email"],
    [{ name: "Rosa", email: "rosa@münchen.example" }, "email"],
    [{ name: "Rosa", email: "rosa@example" }, "email"],
  ])("refuses %j on its %s", (draft, field) => {
    expect(Object.keys(bookerProblems(draft))).toEqual([field]);
  });
});

describe("the quote as a ledger", () => {
  it("shows the server's lines, taxes, and total, with no arithmetic of its own", () => {
    expect(quoteLedger(quoteFor()).map((r) => [r.label, r.detail, r.amount, r.kind])).toEqual([
      ["Adult", "2 × $45.00", "$90.00", "item"],
      ["Sales tax", undefined, "$6.30", "item"],
      ["Total", undefined, "$96.30", "total"],
    ]);
  });
});

describe("words for the desk", () => {
  it("names a source and its channel", () => {
    expect(sourceText("staff_assisted", "walk_up")).toBe("Staff booking, walk-up");
    expect(sourceText("staff_assisted", null)).toBe("Staff booking");
    expect(sourceText("direct", null)).toBe("Online, by the guest");
  });

  it.each([
    ["quote_expired", "requote"],
    ["insufficient_capacity", "edit"],
    ["trip_not_bookable", "stop"],
    ["payment_provider_unavailable", "retry"],
    ["too_many_checkouts", "stop"],
    ["unknown_ticket_type", "edit"],
    [undefined, "retry"],
  ] as const)("says what to do about %s", (code, next) => {
    expect(refusalOf(code).next).toBe(next);
  });

  it("says what a provider timeout means on the payment step, and how held seats are released (review UI-13)", () => {
    expect(refusalOf("payment_provider_unavailable", "pay")).toMatchObject({
      title: "The test payment didn't go through",
      next: "retry",
    });
    expect(refusalOf("payment_provider_unavailable", "pay").body).not.toContain("held");
    expect(refusalOf("payment_provider_unavailable", "open").body).toContain("The seats are held");
    expect(refusalOf("too_many_checkouts").body).toContain("released within 15 minutes");
    expect(refusalOf("too_many_checkouts").body).not.toContain(
      "Finish or cancel one of them first",
    );
    expect(refusalOf("checkout_not_cancelable").next).toBe("stop");
    expect(refusalOf("test_payment_settled").next).toBe("stop");
  });

  it("reads every checkout state as an outcome", () => {
    expect(
      (["open", "confirmed", "failed", "unfulfilled", "expired", "canceled"] as const).map(
        (state) => outcomeOf({ state }),
      ),
    ).toEqual(["waiting", "confirmed", "declined", "unfulfilled", "expired", "canceled"]);
  });

  it("puts only the trip's id in the page's address", () => {
    expect(newBookingHref("bc5f3492-d330-487d-8078-7221db331801")).toBe(
      "/trips/bc5f3492-d330-487d-8078-7221db331801/book",
    );
  });
});
