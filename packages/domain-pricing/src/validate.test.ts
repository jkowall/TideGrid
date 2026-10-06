import { describe, expect, it } from "vitest";
import { discountLabel, policyTerms } from "./quotes.ts";
import {
  type PolicyInput,
  validatePolicy,
  validatePriceList,
  validatePromotionTerms,
  validateTaxRate,
} from "./validate.ts";

const ticket = { code: "adult", name: "Adult", unitAmount: 4500, taxable: true };
const fee = {
  code: "harbor",
  name: "Harbor fee",
  unitAmount: 250,
  basis: "per_participant" as const,
  taxable: false,
};
const addOn = {
  code: "photo",
  name: "Photo",
  unitAmount: 1200,
  quantityRule: "per_booking" as const,
  maxQuantity: 2,
  taxable: true,
};

describe("price list validation", () => {
  it("accepts a complete shared-seat or charter price list", () => {
    expect(
      validatePriceList("shared_seat", { tickets: [ticket], fees: [fee], addOns: [addOn] }),
    ).toEqual([]);
    expect(
      validatePriceList("private_charter", {
        charter: { name: "Whole boat", amount: 120000, taxable: true },
        fees: [fee],
      }),
    ).toEqual([]);
  });

  it("requires tickets for shared seats and a charter price for charters, not both", () => {
    expect(validatePriceList("shared_seat", {})).toEqual(["tickets_required"]);
    expect(
      validatePriceList("shared_seat", {
        tickets: [ticket],
        charter: { name: "Boat", amount: 1, taxable: true },
      }),
    ).toEqual(["charter_not_allowed"]);
    expect(validatePriceList("private_charter", { tickets: [ticket] })).toEqual([
      "charter_required",
      "tickets_not_allowed",
    ]);
  });

  it("names bad codes, repeated codes, names, amounts, limits, and dates", () => {
    expect(validatePriceList("shared_seat", { tickets: [{ ...ticket, code: "Adult" }] })).toEqual([
      "invalid_code",
    ]);
    expect(validatePriceList("shared_seat", { tickets: [ticket, ticket] })).toEqual([
      "duplicate_code",
    ]);
    expect(
      validatePriceList("shared_seat", { tickets: [{ ...ticket, name: "A\u0007dult" }] }),
    ).toEqual(["invalid_name"]);
    expect(validatePriceList("shared_seat", { tickets: [{ ...ticket, unitAmount: -1 }] })).toEqual([
      "invalid_amount",
    ]);
    expect(
      validatePriceList("shared_seat", { tickets: [{ ...ticket, unitAmount: 10.5 }] }),
    ).toEqual(["invalid_amount"]);
    expect(
      validatePriceList("shared_seat", { tickets: [ticket], fees: [{ ...fee, unitAmount: 0 }] }),
    ).toEqual(["invalid_amount"]);
    expect(
      validatePriceList("shared_seat", {
        tickets: [ticket],
        addOns: [{ ...addOn, maxQuantity: 0 }],
      }),
    ).toEqual(["invalid_max_quantity"]);
    expect(
      validatePriceList("shared_seat", {
        tickets: [ticket],
        addOns: [{ ...addOn, availableFrom: "2026-12-31", availableUntil: "2026-12-01" }],
      }),
    ).toEqual(["invalid_date_range"]);
    expect(
      validatePriceList("shared_seat", {
        tickets: [ticket],
        addOns: [{ ...addOn, availableFrom: "2026-02-30" }],
      }),
    ).toEqual(["invalid_date_range"]);
    expect(
      validatePriceList("shared_seat", {
        tickets: Array.from({ length: 21 }, (_, i) => ({ ...ticket, code: `t${i}` })),
      }),
    ).toEqual(["too_many_items"]);
  });

  it("allows the same code once in each of tickets, fees, and add-ons", () => {
    expect(
      validatePriceList("shared_seat", {
        tickets: [ticket],
        fees: [{ ...fee, code: "adult" }],
        addOns: [{ ...addOn, code: "adult" }],
      }),
    ).toEqual([]);
  });
});

const text = {
  cancellation: "Full refund until 24 hours before departure.",
  reschedule: "Move to another trip until 24 hours before departure.",
  noShow: "No refund for a no-show.",
  operatorCancellation: "If we cancel, you choose a refund or a credit.",
  weather: "The captain decides on the day.\nWe contact you if we cancel.",
};
const policy: PolicyInput = {
  changeCutoffMinutes: 1440,
  beforeCutoff: { remedy: "full_refund" },
  afterCutoff: { remedy: "percent_refund", refundBp: 5000 },
  noShow: { remedy: "none" },
  text,
};

describe("policy validation", () => {
  it("accepts a complete policy with newlines in its text", () => {
    expect(validatePolicy(policy)).toEqual([]);
  });

  it("ties a refund percentage to the percent_refund remedy only", () => {
    expect(validatePolicy({ ...policy, afterCutoff: { remedy: "percent_refund" } })).toEqual([
      "invalid_remedy",
    ]);
    expect(
      validatePolicy({ ...policy, beforeCutoff: { remedy: "full_refund", refundBp: 5000 } }),
    ).toEqual(["invalid_remedy"]);
    expect(
      validatePolicy({ ...policy, afterCutoff: { remedy: "percent_refund", refundBp: 10_000 } }),
    ).toEqual(["invalid_remedy"]);
  });

  it("bounds the cutoff and the text", () => {
    expect(validatePolicy({ ...policy, changeCutoffMinutes: -1 })).toEqual(["invalid_cutoff"]);
    expect(validatePolicy({ ...policy, changeCutoffMinutes: 43_201 })).toEqual(["invalid_cutoff"]);
    expect(validatePolicy({ ...policy, text: { ...text, weather: " " } })).toEqual([
      "invalid_text",
    ]);
    expect(validatePolicy({ ...policy, text: { ...text, noShow: "tab\there" } })).toEqual([
      "invalid_text",
    ]);
  });
});

describe("tax rate and promotion validation", () => {
  it("bounds a tax rate to between one millionth and 50%", () => {
    expect(validateTaxRate({ name: "Sales tax", ratePpm: 70_000, inclusive: false })).toEqual([]);
    expect(validateTaxRate({ name: "Zero", ratePpm: 0, inclusive: false })).toEqual([
      "invalid_rate",
    ]);
    expect(validateTaxRate({ name: "Huge", ratePpm: 500_001, inclusive: false })).toEqual([
      "invalid_rate",
    ]);
    expect(validateTaxRate({ name: "", ratePpm: 1, inclusive: true })).toEqual(["invalid_name"]);
  });

  it("bounds a discount, orders its window, and lists real products", () => {
    const base = {
      discount: { kind: "percent" as const, percentOffBp: 1000 },
      startsAt: new Date("2026-09-01T00:00:00Z"),
      endsAt: new Date("2027-06-01T00:00:00Z"),
      products: { all: true as const },
    };
    expect(validatePromotionTerms(base)).toEqual([]);
    expect(
      validatePromotionTerms({ ...base, discount: { kind: "percent", percentOffBp: 10_001 } }),
    ).toEqual(["invalid_discount"]);
    expect(
      validatePromotionTerms({ ...base, discount: { kind: "fixed_amount", amountOff: 0 } }),
    ).toEqual(["invalid_discount"]);
    expect(validatePromotionTerms({ ...base, endsAt: base.startsAt })).toEqual(["invalid_window"]);
    expect(validatePromotionTerms({ ...base, products: { productIds: [] } })).toEqual([
      "invalid_products",
    ]);
    expect(validatePromotionTerms({ ...base, products: { productIds: ["not-a-uuid"] } })).toEqual([
      "invalid_products",
    ]);
  });
});

describe("presentation", () => {
  it("labels a discount line by its code and value", () => {
    expect(discountLabel("HARBOR10", { kind: "percent", percentOffBp: 1000 })).toBe(
      "HARBOR10, 10% off",
    );
    expect(discountLabel("HALF", { kind: "percent", percentOffBp: 1250 })).toBe("HALF, 12.5% off");
    expect(discountLabel("ODD", { kind: "percent", percentOffBp: 333 })).toBe("ODD, 3.33% off");
    expect(discountLabel("REEF25", { kind: "fixed_amount", amountOff: 2500 })).toBe(
      "REEF25, $25.00 off",
    );
    expect(discountLabel("BIG", { kind: "fixed_amount", amountOff: 123456 })).toBe(
      "BIG, $1,234.56 off",
    );
  });

  it("shows the policy with its cutoff instant for one trip", () => {
    const terms = policyTerms(
      {
        productId: "11111111-1111-4111-8111-111111111111",
        version: 4,
        changeCutoffMinutes: 2880,
        beforeCutoff: { remedy: "full_refund", refundBp: null },
        afterCutoff: { remedy: "credit", refundBp: null },
        noShow: { remedy: "none", refundBp: null },
        text,
      },
      Date.parse("2026-11-10T17:30:00Z"),
    );
    expect(terms).toMatchObject({
      version: 4,
      changeCutoffMinutes: 2880,
      changeCutoffAt: "2026-11-08T17:30:00.000Z",
      afterCutoff: { remedy: "credit", refundBp: null },
    });
  });
});
