import { describe, expect, it } from "vitest";
import { ItemCode, PromotionCodeInput, QuoteCreateRequest, QuoteProblemCode } from "./pricing.ts";

const tripId = "3f2b8c1e-7a4d-4e6f-9b0a-1c2d3e4f5a6b";

describe("pricing contracts", () => {
  it("defaults add-ons to none and trims the promotion code", () => {
    const parsed = QuoteCreateRequest.parse({
      tripId,
      party: { kind: "tickets", tickets: [{ code: "adult", quantity: 2 }] },
      promotionCode: "  harbor10 ",
    });
    expect(parsed.addOns).toEqual([]);
    expect(parsed.promotionCode).toBe("harbor10");
  });

  it("takes either ticket quantities or a charter guest count, never both shapes", () => {
    const base = { tripId, addOns: [] };
    expect(
      QuoteCreateRequest.safeParse({ ...base, party: { kind: "charter", guests: 6 } }).success,
    ).toBe(true);
    expect(
      QuoteCreateRequest.safeParse({ ...base, party: { kind: "charter", tickets: [] } }).success,
    ).toBe(false);
    expect(
      QuoteCreateRequest.safeParse({ ...base, party: { kind: "tickets", tickets: [] } }).success,
    ).toBe(false);
    expect(
      QuoteCreateRequest.safeParse({
        ...base,
        party: { kind: "tickets", tickets: [{ code: "adult", quantity: 1.5 }] },
      }).success,
    ).toBe(false);
  });

  it("accepts only operator codes and plausible promotion codes", () => {
    expect(ItemCode.safeParse("snorkel_gear").success).toBe(true);
    for (const bad of ["Adult", "1adult", "", "a".repeat(33), "adult-1"]) {
      expect(ItemCode.safeParse(bad).success).toBe(false);
    }
    expect(PromotionCodeInput.safeParse("REEF-25").success).toBe(true);
    for (const bad of ["ab", "has space", "x".repeat(33), "<script>"]) {
      expect(PromotionCodeInput.safeParse(bad).success).toBe(false);
    }
  });

  it("lists every quote problem code the API can return", () => {
    expect(QuoteProblemCode.options).toEqual([
      "pricing_unavailable",
      "party_kind_mismatch",
      "invalid_quantity",
      "unknown_ticket_type",
      "duplicate_ticket_type",
      "party_size_out_of_range",
      "insufficient_capacity",
      "unknown_add_on",
      "duplicate_add_on",
      "add_on_unavailable",
      "add_on_quantity_exceeded",
      "promotion_not_applicable",
      "quote_amount_too_large",
    ]);
  });
});
