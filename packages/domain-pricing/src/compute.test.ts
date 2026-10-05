import { describe, expect, it } from "vitest";
import {
  addOnAvailableOn,
  changeCutoffAt,
  MAX_QUOTE_AMOUNT,
  normalizePromotionCode,
  type PricedQuote,
  priceQuote,
  promotionRejection,
  type QuoteInput,
  type QuoteOutcome,
  type QuoteSelection,
} from "./compute.ts";
import type { PolicyVersion, PriceList, PromotionTerms, TaxRate } from "./terms.ts";

// Every expected amount below was worked by hand and cross-checked with exact
// rational arithmetic outside this code. Amounts are cents.

const PRODUCT = "11111111-1111-4111-8111-111111111111";
const OTHER_PRODUCT = "22222222-2222-4222-8222-222222222222";
const NOW = Date.parse("2026-10-15T12:00:00Z");

const sharedList = (): PriceList => ({
  productId: PRODUCT,
  version: 3,
  productKind: "shared_seat",
  tickets: [
    { code: "adult", name: "Adult", unitAmount: 4500, taxable: true },
    { code: "child", name: "Child", unitAmount: 2500, taxable: true },
    { code: "infant", name: "Infant", unitAmount: 0, taxable: false },
  ],
  charter: null,
  fees: [
    {
      code: "harbor",
      name: "Harbor fee",
      unitAmount: 250,
      basis: "per_participant",
      taxable: false,
    },
    { code: "booking", name: "Booking fee", unitAmount: 199, basis: "per_booking", taxable: true },
  ],
  addOns: [
    {
      code: "photo",
      name: "Souvenir photo",
      unitAmount: 1200,
      quantityRule: "per_booking",
      maxQuantity: 2,
      taxable: true,
      availableFrom: null,
      availableUntil: null,
    },
    {
      code: "drink",
      name: "Drink voucher",
      unitAmount: 800,
      quantityRule: "per_participant",
      maxQuantity: 2,
      taxable: true,
      availableFrom: null,
      availableUntil: null,
    },
    {
      code: "dinner",
      name: "Holiday dinner",
      unitAmount: 3500,
      quantityRule: "per_participant",
      maxQuantity: 1,
      taxable: true,
      availableFrom: "2026-12-01",
      availableUntil: "2026-12-31",
    },
  ],
});

const charterList = (): PriceList => ({
  productId: PRODUCT,
  version: 1,
  productKind: "private_charter",
  tickets: [],
  charter: { name: "Whole boat, half day", amount: 120000, taxable: true },
  fees: [
    { code: "fuel", name: "Fuel surcharge", unitAmount: 7500, basis: "per_booking", taxable: true },
  ],
  addOns: [
    {
      code: "lunch",
      name: "Catered lunch",
      unitAmount: 2500,
      quantityRule: "per_participant",
      maxQuantity: 1,
      taxable: true,
      availableFrom: null,
      availableUntil: null,
    },
  ],
});

const rate = (
  id: string,
  name: string,
  ratePpm: number,
  inclusive = false,
  version = 1,
): TaxRate => ({
  taxRateId: `aaaaaaaa-aaaa-4aaa-8aaa-${id.padStart(12, "0")}`,
  version,
  name,
  ratePpm,
  inclusive,
});
const SALES_7 = rate("7", "Sales tax", 70_000);
const STATE_6 = rate("6", "State sales tax", 60_000);
const COUNTY_1 = rate("1", "County surtax", 10_000, false, 2);

const promo = (overrides: Partial<PromotionTerms> = {}): PromotionTerms => ({
  promotionId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
  version: 2,
  code: "HARBOR10",
  active: true,
  discount: { kind: "percent", percentOffBp: 1000 },
  startsAtMs: Date.parse("2026-09-01T00:00:00Z"),
  endsAtMs: Date.parse("2027-06-01T00:00:00Z"),
  appliesToAllProducts: true,
  productIds: [],
  ...overrides,
});

const tickets = (...pairs: [string, number][]): QuoteSelection["party"] => ({
  kind: "tickets",
  tickets: pairs.map(([code, quantity]) => ({ code, quantity })),
});

function input(
  overrides: Omit<Partial<QuoteInput>, "selection"> & { selection?: Partial<QuoteSelection> } = {},
): QuoteInput {
  const { selection, ...rest } = overrides;
  const base: QuoteInput = {
    nowMs: NOW,
    subject: {
      productId: PRODUCT,
      productKind: "shared_seat",
      localDate: "2026-11-10",
      minPartySize: 1,
      maxPartySize: 10,
      capacityRemaining: 20,
    },
    priceList: sharedList(),
    taxRates: [],
    promotion: null,
    selection: { party: tickets(["adult", 2], ["child", 1]), addOns: [], promotionCode: null },
  };
  return { ...base, ...rest, selection: { ...base.selection, ...selection } };
}

function priced(outcome: QuoteOutcome): PricedQuote {
  if (outcome.kind !== "priced")
    throw new Error(`expected a price, got ${JSON.stringify(outcome)}`);
  return outcome.quote;
}

function problems(outcome: QuoteOutcome) {
  if (outcome.kind !== "rejected")
    throw new Error(`expected problems, got ${JSON.stringify(outcome)}`);
  return outcome.problems;
}

const brief = (q: PricedQuote) =>
  q.lines.map((l) => [
    l.lineNo,
    l.kind,
    l.code,
    l.quantity,
    l.unitAmount,
    l.amount,
    l.discountAmount,
  ]);

describe("lines and totals", () => {
  it("prices tickets, then fees, in price list order, with per-participant fees", () => {
    const q = priced(priceQuote(input()));
    expect(q.partySize).toBe(3);
    expect(brief(q)).toEqual([
      [1, "ticket", "adult", 2, 4500, 9000, 0],
      [2, "ticket", "child", 1, 2500, 2500, 0],
      [3, "fee", "harbor", 3, 250, 750, 0],
      [4, "fee", "booking", 1, 199, 199, 0],
    ]);
    expect(q.lines.map((l) => l.basis)).toEqual([null, null, "per_participant", "per_booking"]);
    expect(q.totals).toEqual({
      subtotal: 11500,
      discount: 0,
      fees: 949,
      tax: 0,
      includedTax: 0,
      total: 12449,
    });
    expect(q.discount).toBeNull();
    expect(q.taxes).toEqual([]);
  });

  it("keeps price list order whatever order the guest sends", () => {
    const q = priced(
      priceQuote(input({ selection: { party: tickets(["child", 1], ["adult", 2]) } })),
    );
    expect(q.lines.map((l) => l.code)).toEqual(["adult", "child", "harbor", "booking"]);
  });

  it("counts free tickets as participants for party size and per-participant fees", () => {
    const q = priced(
      priceQuote(input({ selection: { party: tickets(["adult", 1], ["infant", 1]) } })),
    );
    expect(q.partySize).toBe(2);
    expect(q.lines.find((l) => l.code === "infant")?.amount).toBe(0);
    expect(q.lines.find((l) => l.code === "harbor")?.quantity).toBe(2);
    expect(q.totals.total).toBe(4500 + 0 + 500 + 199);
  });

  it("adds selected add-ons after the trip price and before fees", () => {
    const q = priced(
      priceQuote(
        input({
          selection: {
            addOns: [
              { code: "drink", quantity: 2 },
              { code: "photo", quantity: 1 },
            ],
          },
        }),
      ),
    );
    expect(q.lines.map((l) => `${l.kind}:${l.code}:${l.quantity}:${l.amount}`)).toEqual([
      "ticket:adult:2:9000",
      "ticket:child:1:2500",
      "add_on:photo:1:1200",
      "add_on:drink:2:1600",
      "fee:harbor:3:750",
      "fee:booking:1:199",
    ]);
    expect(q.lines.find((l) => l.code === "drink")?.basis).toBe("per_participant");
    expect(q.totals.subtotal).toBe(9000 + 2500 + 1200 + 1600);
    expect(q.totals.total).toBe(14300 + 949);
  });

  it("prices a charter at its fixed price whatever the party size", () => {
    const charter = (guests: number) =>
      priced(
        priceQuote(
          input({
            subject: {
              productId: PRODUCT,
              productKind: "private_charter",
              localDate: "2026-11-14",
              minPartySize: 1,
              maxPartySize: 12,
              capacityRemaining: 12,
            },
            priceList: charterList(),
            selection: { party: { kind: "charter", guests } },
          }),
        ),
      );
    const two = charter(2);
    const twelve = charter(12);
    expect(brief(two)).toEqual([
      [1, "charter", "charter", 1, 120000, 120000, 0],
      [2, "fee", "fuel", 1, 7500, 7500, 0],
    ]);
    expect(two.partySize).toBe(2);
    expect(twelve.partySize).toBe(12);
    expect(twelve.totals.subtotal).toBe(two.totals.subtotal);
    expect(twelve.totals.total).toBe(127500);
  });
});

describe("tax", () => {
  it("adds an exclusive rate per taxable line, rounded half up per line", () => {
    const q = priced(priceQuote(input({ taxRates: [SALES_7] })));
    const taxOf = (code: string) => q.lines.find((l) => l.code === code)?.taxes;
    expect(taxOf("adult")).toEqual([{ ...SALES_7, taxableAmount: 9000, amount: 630 }]);
    expect(taxOf("child")?.[0]?.amount).toBe(175);
    expect(taxOf("booking")?.[0]?.amount).toBe(14); // 13.93
    expect(taxOf("harbor")).toEqual([]); // not taxable
    expect(q.taxes).toEqual([{ ...SALES_7, taxableAmount: 11699, amount: 819 }]);
    expect(q.totals).toMatchObject({ tax: 819, includedTax: 0, total: 12449 + 819 });
  });

  it("applies several exclusive rates to the same pre-tax amount, never tax on tax", () => {
    const q = priced(priceQuote(input({ taxRates: [STATE_6, COUNTY_1] })));
    const adult = q.lines.find((l) => l.code === "adult");
    expect(adult?.taxes.map((t) => [t.name, t.taxableAmount, t.amount])).toEqual([
      ["State sales tax", 9000, 540],
      ["County surtax", 9000, 90],
    ]);
    const booking = q.lines.find((l) => l.code === "booking");
    expect(booking?.taxes.map((t) => t.amount)).toEqual([12, 2]); // 11.94 and 1.99
    expect(q.taxes.map((t) => [t.name, t.version, t.taxableAmount, t.amount])).toEqual([
      ["State sales tax", 1, 11699, 702],
      ["County surtax", 2, 11699, 117],
    ]);
    expect(q.totals.tax).toBe(819);
  });

  it("rounds an exact half cent up, which half-even rounding would not", () => {
    const list = sharedList();
    list.tickets = [{ code: "adult", name: "Adult", unitAmount: 1010, taxable: true }];
    list.fees = [];
    const q = priced(
      priceQuote(
        input({
          priceList: list,
          taxRates: [rate("5", "Tax", 50_000)],
          selection: { party: tickets(["adult", 1]) },
        }),
      ),
    );
    expect(q.totals.tax).toBe(51); // 50.5
  });

  it("rounds each line separately rather than the total", () => {
    const list = sharedList();
    list.tickets = [
      { code: "adult", name: "Adult", unitAmount: 1010, taxable: true },
      { code: "child", name: "Child", unitAmount: 1010, taxable: true },
    ];
    list.fees = [];
    const q = priced(
      priceQuote(
        input({
          priceList: list,
          taxRates: [rate("5", "Tax", 50_000)],
          selection: { party: tickets(["adult", 1], ["child", 1]) },
        }),
      ),
    );
    // 50.5 + 50.5 rounds to 51 + 51 per line; the total of 2020 alone would give 101.
    expect(q.totals.tax).toBe(102);
  });

  it("extracts an inclusive rate from the price and leaves the total alone", () => {
    const list = sharedList();
    list.tickets = [{ code: "diver", name: "Certified diver", unitAmount: 16500, taxable: true }];
    list.fees = [];
    const ge = rate("4712", "General excise tax", 47_120, true);
    const q = priced(
      priceQuote(
        input({ priceList: list, taxRates: [ge], selection: { party: tickets(["diver", 2]) } }),
      ),
    );
    // 33000 / 1.04712 = 31515.01 -> pre-tax 31515, included 1485.
    expect(q.lines[0]?.taxes).toEqual([{ ...ge, taxableAmount: 31515, amount: 1485 }]);
    expect(q.totals).toEqual({
      subtotal: 33000,
      discount: 0,
      fees: 0,
      tax: 0,
      includedTax: 1485,
      total: 33000,
    });
  });

  it("splits several inclusive rates by the largest remainder so they sum exactly", () => {
    const list = sharedList();
    list.tickets = [{ code: "adult", name: "Adult", unitAmount: 10000, taxable: true }];
    list.fees = [];
    const state = rate("6", "State", 60_000, true);
    const county = rate("1", "County", 10_000, true);
    const q = priced(
      priceQuote(
        input({
          priceList: list,
          taxRates: [state, county],
          selection: { party: tickets(["adult", 1]) },
        }),
      ),
    );
    // 10000 / 1.07 = 9345.79 -> pre-tax 9346, included 654, split 560.57 : 93.43 -> 561 and 93.
    expect(q.lines[0]?.taxes.map((t) => [t.name, t.taxableAmount, t.amount])).toEqual([
      ["State", 9346, 561],
      ["County", 9346, 93],
    ]);
    expect(q.totals.includedTax).toBe(654);
    expect(q.totals.total).toBe(10000);
  });

  it("applies exclusive rates to the pre-tax amount when another rate is inclusive", () => {
    const list = sharedList();
    list.tickets = [{ code: "adult", name: "Adult", unitAmount: 10000, taxable: true }];
    list.fees = [];
    const included = rate("6", "Included", 60_000, true);
    const added = rate("1", "Added", 10_000);
    const q = priced(
      priceQuote(
        input({
          priceList: list,
          taxRates: [added, included],
          selection: { party: tickets(["adult", 1]) },
        }),
      ),
    );
    // 10000 / 1.06 = 9433.96 -> pre-tax 9434, included 566; 1% of 9434 = 94.34 -> 94.
    expect(q.lines[0]?.taxes.map((t) => [t.name, t.inclusive, t.taxableAmount, t.amount])).toEqual([
      ["Added", false, 9434, 94],
      ["Included", true, 9434, 566],
    ]);
    expect(q.totals).toMatchObject({ tax: 94, includedTax: 566, total: 10094 });
  });

  it("taxes nothing when no line is taxable", () => {
    const list = sharedList();
    list.tickets = [{ code: "adult", name: "Adult", unitAmount: 4500, taxable: false }];
    list.fees = [];
    const q = priced(
      priceQuote(
        input({
          priceList: list,
          taxRates: [SALES_7],
          selection: { party: tickets(["adult", 1]) },
        }),
      ),
    );
    expect(q.taxes).toEqual([]);
    expect(q.lines.every((l) => l.taxes.length === 0)).toBe(true);
    expect(q.totals.total).toBe(4500);
  });

  it("refuses a malformed or repeated tax rate instead of pricing with it", () => {
    expect(() => priceQuote(input({ taxRates: [rate("0", "Zero", 0)] }))).toThrow(RangeError);
    expect(() => priceQuote(input({ taxRates: [SALES_7, SALES_7] }))).toThrow(RangeError);
  });
});

describe("discount", () => {
  it("takes a percentage off the trip price only and taxes the discounted amounts", () => {
    const q = priced(
      priceQuote(
        input({
          taxRates: [SALES_7],
          promotion: promo(),
          selection: { addOns: [{ code: "photo", quantity: 1 }], promotionCode: "HARBOR10" },
        }),
      ),
    );
    // 10% of 11500 = 1150, split 9000 : 2500 -> 900 and 250. The photo is not discounted.
    expect(brief(q)).toEqual([
      [1, "ticket", "adult", 2, 4500, 9000, 900],
      [2, "ticket", "child", 1, 2500, 2500, 250],
      [3, "add_on", "photo", 1, 1200, 1200, 0],
      [4, "fee", "harbor", 3, 250, 750, 0],
      [5, "fee", "booking", 1, 199, 199, 0],
    ]);
    expect(q.discount).toMatchObject({
      lineNo: 6,
      code: "HARBOR10",
      eligibleAmount: 11500,
      amount: 1150,
    });
    // Tax on 8100, 2250, 1200, and 199: 567 + 158 (157.5) + 84 + 14.
    expect(q.lines.map((l) => l.taxes[0]?.amount ?? null)).toEqual([567, 158, 84, null, 14]);
    expect(q.totals).toEqual({
      subtotal: 12700,
      discount: 1150,
      fees: 949,
      tax: 823,
      includedTax: 0,
      total: 12700 - 1150 + 949 + 823,
    });
  });

  it("rounds a percentage discount half up", () => {
    const q = priced(
      priceQuote(
        input({
          promotion: promo({ discount: { kind: "percent", percentOffBp: 1250 } }),
          selection: { party: tickets(["adult", 1]), promotionCode: "HARBOR10" },
        }),
      ),
    );
    expect(q.discount?.amount).toBe(563); // 12.5% of 4500 = 562.5
  });

  it("splits a fixed amount by the largest remainder, ties to the earlier line", () => {
    const q = priced(
      priceQuote(
        input({
          taxRates: [SALES_7],
          promotion: promo({ code: "TAKE25", discount: { kind: "fixed_amount", amountOff: 2500 } }),
          selection: { promotionCode: "take25" },
        }),
      ),
    );
    // 2500 x 9000/11500 = 1956.52, 2500 x 2500/11500 = 543.48 -> 1957 and 543.
    expect(q.lines.slice(0, 2).map((l) => l.discountAmount)).toEqual([1957, 543]);
    expect(q.lines.slice(0, 2).map((l) => l.taxes[0]?.amount)).toEqual([493, 137]);
    expect(q.totals.discount).toBe(2500);
  });

  it("caps a fixed amount at the trip price and never discounts add-ons or fees", () => {
    const q = priced(
      priceQuote(
        input({
          promotion: promo({ code: "BIG", discount: { kind: "fixed_amount", amountOff: 50000 } }),
          selection: {
            party: tickets(["adult", 2]),
            addOns: [{ code: "photo", quantity: 1 }],
            promotionCode: "BIG",
          },
        }),
      ),
    );
    expect(q.discount?.amount).toBe(9000);
    expect(q.lines.find((l) => l.code === "photo")?.discountAmount).toBe(0);
    expect(q.totals).toMatchObject({ subtotal: 10200, discount: 9000, fees: 699, total: 1899 });
  });

  it("takes the whole trip price at 100% and gives free tickets no share", () => {
    const q = priced(
      priceQuote(
        input({
          promotion: promo({ discount: { kind: "percent", percentOffBp: 10_000 } }),
          selection: { party: tickets(["adult", 1], ["infant", 1]), promotionCode: "harbor10" },
        }),
      ),
    );
    expect(q.lines.slice(0, 2).map((l) => [l.code, l.amount, l.discountAmount])).toEqual([
      ["adult", 4500, 4500],
      ["infant", 0, 0],
    ]);
    expect(q.totals.total).toBe(500 + 199);
  });

  it("records a zero discount when the trip price is zero", () => {
    const q = priced(
      priceQuote(
        input({
          subject: {
            productId: PRODUCT,
            productKind: "shared_seat",
            localDate: "2026-11-10",
            minPartySize: 1,
            maxPartySize: 10,
            capacityRemaining: 20,
          },
          promotion: promo(),
          selection: { party: tickets(["infant", 2]), promotionCode: "HARBOR10" },
        }),
      ),
    );
    expect(q.discount).toMatchObject({ eligibleAmount: 0, amount: 0 });
    expect(q.totals.discount).toBe(0);
  });

  it("discounts a charter's single price line", () => {
    const q = priced(
      priceQuote(
        input({
          subject: {
            productId: PRODUCT,
            productKind: "private_charter",
            localDate: "2026-11-14",
            minPartySize: 1,
            maxPartySize: 12,
            capacityRemaining: 12,
          },
          priceList: charterList(),
          taxRates: [SALES_7],
          promotion: promo(),
          selection: { party: { kind: "charter", guests: 4 }, promotionCode: "HARBOR10" },
        }),
      ),
    );
    expect(q.lines[0]).toMatchObject({ kind: "charter", amount: 120000, discountAmount: 12000 });
    expect(q.lines[0]?.taxes[0]?.amount).toBe(7560); // 7% of 108000
    expect(q.totals).toEqual({
      subtotal: 120000,
      discount: 12000,
      fees: 7500,
      tax: 7560 + 525,
      includedTax: 0,
      total: 120000 - 12000 + 7500 + 8085,
    });
  });

  it("extracts inclusive tax from the discounted price", () => {
    const list = sharedList();
    list.tickets = [{ code: "diver", name: "Certified diver", unitAmount: 16500, taxable: true }];
    list.fees = [];
    const ge = rate("4712", "General excise tax", 47_120, true);
    const q = priced(
      priceQuote(
        input({
          priceList: list,
          taxRates: [ge],
          promotion: promo(),
          selection: { party: tickets(["diver", 2]), promotionCode: "HARBOR10" },
        }),
      ),
    );
    // 33000 less 3300 = 29700; 29700 / 1.04712 = 28363.5 -> 28364, included 1336.
    expect(q.lines[0]?.taxes[0]).toMatchObject({ taxableAmount: 28364, amount: 1336 });
    expect(q.totals).toMatchObject({ discount: 3300, includedTax: 1336, total: 29700 });
  });

  it("ignores a promotion that the guest did not enter", () => {
    const q = priced(priceQuote(input({ promotion: promo() })));
    expect(q.discount).toBeNull();
    expect(q.totals.discount).toBe(0);
  });
});

describe("eligibility: party", () => {
  it("names unknown, repeated, and malformed ticket types", () => {
    expect(
      problems(
        priceQuote(
          input({
            selection: {
              party: tickets(
                ["adult", 1],
                ["senior", 1],
                ["adult", 2],
                ["child", 0],
                ["infant", 1.5],
              ),
            },
          }),
        ),
      ),
    ).toEqual([
      { code: "unknown_ticket_type", subject: "senior" },
      { code: "duplicate_ticket_type", subject: "adult" },
      { code: "invalid_quantity", subject: "child" },
      { code: "invalid_quantity", subject: "infant" },
    ]);
  });

  it("refuses a party outside the product's limits and over the trip's capacity", () => {
    const subject = {
      productId: PRODUCT,
      productKind: "shared_seat" as const,
      localDate: "2026-11-10",
      minPartySize: 2,
      maxPartySize: 6,
      capacityRemaining: 4,
    };
    const run = (n: number) =>
      priceQuote(input({ subject, selection: { party: tickets(["adult", n]) } }));
    expect(problems(run(1))).toEqual([{ code: "party_size_out_of_range" }]);
    expect(problems(run(5))).toEqual([{ code: "insufficient_capacity" }]);
    expect(problems(run(7))).toEqual([
      { code: "party_size_out_of_range" },
      { code: "insufficient_capacity" },
    ]);
    expect(priceQuote(input({ subject, selection: { party: tickets(["adult", 2]) } })).kind).toBe(
      "priced",
    );
    expect(priceQuote(input({ subject, selection: { party: tickets(["adult", 4]) } })).kind).toBe(
      "priced",
    );
  });

  it("refuses a party of the wrong kind for the product", () => {
    expect(
      problems(priceQuote(input({ selection: { party: { kind: "charter", guests: 2 } } }))),
    ).toEqual([{ code: "party_kind_mismatch" }]);
    expect(
      problems(
        priceQuote(
          input({
            subject: {
              productId: PRODUCT,
              productKind: "private_charter",
              localDate: "2026-11-14",
              minPartySize: 1,
              maxPartySize: 12,
              capacityRemaining: 12,
            },
            priceList: charterList(),
            selection: { party: tickets(["adult", 2]) },
          }),
        ),
      ),
    ).toEqual([{ code: "party_kind_mismatch" }]);
  });

  it("refuses a charter guest count that is not a positive whole number", () => {
    for (const guests of [0, -1, 2.5, Number.NaN]) {
      expect(
        problems(
          priceQuote(
            input({
              subject: {
                productId: PRODUCT,
                productKind: "private_charter",
                localDate: "2026-11-14",
                minPartySize: 1,
                maxPartySize: 12,
                capacityRemaining: 12,
              },
              priceList: charterList(),
              selection: { party: { kind: "charter", guests } },
            }),
          ),
        ),
      ).toEqual([{ code: "invalid_quantity", subject: "guests" }]);
    }
  });

  it("refuses an empty party", () => {
    expect(problems(priceQuote(input({ selection: { party: tickets() } })))).toEqual([
      { code: "party_size_out_of_range" },
    ]);
  });

  it("does not report limits that depend on a party it could not count", () => {
    const outcome = priceQuote(
      input({
        selection: { party: tickets(["senior", 1]), addOns: [{ code: "drink", quantity: 40 }] },
      }),
    );
    expect(problems(outcome)).toEqual([{ code: "unknown_ticket_type", subject: "senior" }]);
  });
});

describe("eligibility: add-ons", () => {
  const addOns = (...pairs: [string, number][]) =>
    pairs.map(([code, quantity]) => ({ code, quantity }));

  it("names unknown, repeated, and malformed add-ons", () => {
    expect(
      problems(
        priceQuote(
          input({
            selection: {
              addOns: addOns(["photo", 1], ["kayak", 1], ["photo", 1], ["drink", 0]),
            },
          }),
        ),
      ),
    ).toEqual([
      { code: "unknown_add_on", subject: "kayak" },
      { code: "duplicate_add_on", subject: "photo" },
      { code: "invalid_quantity", subject: "drink" },
    ]);
  });

  it("offers a dated add-on only for trips inside its inclusive range", () => {
    const on = (localDate: string) =>
      priceQuote(
        input({
          subject: {
            productId: PRODUCT,
            productKind: "shared_seat",
            localDate,
            minPartySize: 1,
            maxPartySize: 10,
            capacityRemaining: 20,
          },
          selection: { addOns: addOns(["dinner", 1]) },
        }),
      );
    expect(problems(on("2026-11-30"))).toEqual([{ code: "add_on_unavailable", subject: "dinner" }]);
    expect(on("2026-12-01").kind).toBe("priced");
    expect(on("2026-12-31").kind).toBe("priced");
    expect(problems(on("2027-01-01"))).toEqual([{ code: "add_on_unavailable", subject: "dinner" }]);
  });

  it("limits a per-booking add-on to its maximum", () => {
    expect(priceQuote(input({ selection: { addOns: addOns(["photo", 2]) } })).kind).toBe("priced");
    expect(problems(priceQuote(input({ selection: { addOns: addOns(["photo", 3]) } })))).toEqual([
      { code: "add_on_quantity_exceeded", subject: "photo" },
    ]);
  });

  it("limits a per-participant add-on to its maximum for each participant", () => {
    // Three participants, at most two drinks each.
    expect(priceQuote(input({ selection: { addOns: addOns(["drink", 6]) } })).kind).toBe("priced");
    expect(problems(priceQuote(input({ selection: { addOns: addOns(["drink", 7]) } })))).toEqual([
      { code: "add_on_quantity_exceeded", subject: "drink" },
    ]);
  });

  it("allows one catered lunch per charter guest", () => {
    const run = (guests: number, lunches: number) =>
      priceQuote(
        input({
          subject: {
            productId: PRODUCT,
            productKind: "private_charter",
            localDate: "2026-11-14",
            minPartySize: 1,
            maxPartySize: 12,
            capacityRemaining: 12,
          },
          priceList: charterList(),
          selection: { party: { kind: "charter", guests }, addOns: addOns(["lunch", lunches]) },
        }),
      );
    expect(priced(run(6, 6)).totals.subtotal).toBe(120000 + 15000);
    expect(problems(run(6, 7))).toEqual([{ code: "add_on_quantity_exceeded", subject: "lunch" }]);
  });

  it("refuses amounts beyond the quote limit instead of overflowing", () => {
    const list = sharedList();
    list.addOns = [
      {
        code: "yacht",
        name: "Yacht upgrade",
        unitAmount: 10_000_000,
        quantityRule: "per_participant",
        maxQuantity: 100,
        taxable: true,
        availableFrom: null,
        availableUntil: null,
      },
    ];
    expect(
      problems(
        priceQuote(input({ priceList: list, selection: { addOns: addOns(["yacht", 11]) } })),
      ),
    ).toEqual([{ code: "quote_amount_too_large" }]);
    expect(MAX_QUOTE_AMOUNT).toBe(100_000_000);
  });
});

describe("eligibility: promotion", () => {
  const run = (p: PromotionTerms | null, code: string, overrides: Partial<QuoteInput> = {}) =>
    priceQuote(input({ ...overrides, promotion: p, selection: { promotionCode: code } }));
  const reasonOf = (outcome: QuoteOutcome) => problems(outcome)[0]?.reason;

  it("matches codes trimmed and in any case", () => {
    expect(normalizePromotionCode("  harBor10 ")).toBe("HARBOR10");
    expect(priced(run(promo(), " harbor10 ")).discount?.amount).toBe(1150);
  });

  it("names why a code does not apply, under one public problem code", () => {
    expect(problems(run(null, "NOPE"))).toEqual([
      { code: "promotion_not_applicable", reason: "unknown" },
    ]);
    expect(reasonOf(run(promo(), "OTHER10"))).toBe("unknown");
    expect(reasonOf(run(promo({ active: false }), "HARBOR10"))).toBe("inactive");
    expect(
      reasonOf(
        run(promo({ appliesToAllProducts: false, productIds: [OTHER_PRODUCT] }), "HARBOR10"),
      ),
    ).toBe("product_ineligible");
    expect(
      run(promo({ appliesToAllProducts: false, productIds: [OTHER_PRODUCT, PRODUCT] }), "HARBOR10")
        .kind,
    ).toBe("priced");
  });

  it("uses a half-open window: valid from its start, invalid from its end", () => {
    const window = { startsAtMs: NOW, endsAtMs: NOW + 60_000 };
    const at = (nowMs: number) => run(promo(window), "HARBOR10", { nowMs });
    expect(reasonOf(at(NOW - 1))).toBe("not_started");
    expect(at(NOW).kind).toBe("priced");
    expect(at(NOW + 59_999).kind).toBe("priced");
    expect(reasonOf(at(NOW + 60_000))).toBe("expired");
  });

  it("reports promotion problems beside other problems", () => {
    expect(
      problems(
        priceQuote(
          input({
            promotion: null,
            selection: {
              party: tickets(["senior", 1]),
              addOns: [{ code: "kayak", quantity: 1 }],
              promotionCode: "NOPE",
            },
          }),
        ),
      ).map((p) => p.code),
    ).toEqual(["unknown_ticket_type", "unknown_add_on", "promotion_not_applicable"]);
  });

  it("exposes the same rules for the offer and the API", () => {
    expect(promotionRejection(promo(), "harbor10", PRODUCT, NOW)).toBeNull();
    expect(promotionRejection(null, "harbor10", PRODUCT, NOW)).toBe("unknown");
  });
});

describe("structure", () => {
  it("refuses to price with a price list for another product or kind, or an incomplete one", () => {
    const wrongProduct = sharedList();
    wrongProduct.productId = OTHER_PRODUCT;
    const noTickets = sharedList();
    noTickets.tickets = [];
    const wrongKind = charterList();
    const noCharter = charterList();
    noCharter.charter = null;
    const charterSubject = {
      productId: PRODUCT,
      productKind: "private_charter" as const,
      localDate: "2026-11-14",
      minPartySize: 1,
      maxPartySize: 12,
      capacityRemaining: 12,
    };
    for (const outcome of [
      priceQuote(input({ priceList: wrongProduct })),
      priceQuote(input({ priceList: noTickets })),
      priceQuote(input({ priceList: wrongKind })),
      priceQuote(
        input({
          subject: charterSubject,
          priceList: noCharter,
          selection: { party: { kind: "charter", guests: 2 } },
        }),
      ),
    ]) {
      expect(problems(outcome)).toEqual([{ code: "pricing_unavailable" }]);
    }
  });

  it("is pure: the same input prices the same way and is never modified", () => {
    const frozen = input({
      taxRates: [STATE_6, COUNTY_1],
      promotion: promo(),
      selection: { addOns: [{ code: "drink", quantity: 3 }], promotionCode: "HARBOR10" },
    });
    const deepFreeze = (value: unknown): void => {
      if (value && typeof value === "object") {
        Object.freeze(value);
        for (const v of Object.values(value)) deepFreeze(v);
      }
    };
    const copy = structuredClone(frozen);
    deepFreeze(frozen);
    expect(priceQuote(frozen)).toEqual(priceQuote(copy));
    expect(frozen).toEqual(copy);
  });
});

describe("invariants over many generated quotes", () => {
  // A small deterministic generator, so a failure reproduces exactly.
  function random(seed: number) {
    let s = seed >>> 0;
    return (n: number) => {
      s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
      return s % n;
    };
  }

  it("keeps every total equal to the sum of its lines", () => {
    let pricedCount = 0;
    for (let seed = 1; seed <= 600; seed++) {
      const r = random(seed);
      const list = sharedList();
      list.tickets = [
        { code: "a", name: "A", unitAmount: r(20000), taxable: r(2) === 0 },
        { code: "b", name: "B", unitAmount: r(9000), taxable: r(2) === 0 },
        { code: "c", name: "C", unitAmount: r(3) === 0 ? 0 : r(500), taxable: true },
      ];
      list.fees = [
        {
          code: "f",
          name: "F",
          unitAmount: 1 + r(999),
          basis: "per_participant",
          taxable: r(2) === 0,
        },
        {
          code: "g",
          name: "G",
          unitAmount: 1 + r(5000),
          basis: "per_booking",
          taxable: r(2) === 0,
        },
      ];
      list.addOns = [
        {
          code: "x",
          name: "X",
          unitAmount: r(4000),
          quantityRule: "per_participant",
          maxQuantity: 3,
          taxable: r(2) === 0,
          availableFrom: null,
          availableUntil: null,
        },
      ];
      const rates: TaxRate[] = [];
      const rateCount = r(4);
      for (let i = 0; i < rateCount; i++) {
        rates.push(rate(`${seed}${i}`, `R${i}`, 1 + r(120_000), r(3) === 0));
      }
      const discount =
        r(2) === 0
          ? { kind: "percent" as const, percentOffBp: 1 + r(10_000) }
          : { kind: "fixed_amount" as const, amountOff: 1 + r(60_000) };
      const party = tickets(["a", 1 + r(3)], ["b", r(3) + 1], ["c", 1 + r(2)]);
      const outcome = priceQuote(
        input({
          subject: {
            productId: PRODUCT,
            productKind: "shared_seat",
            localDate: "2026-11-10",
            minPartySize: 1,
            maxPartySize: 20,
            capacityRemaining: 20,
          },
          priceList: list,
          taxRates: rates,
          promotion: r(3) === 0 ? null : promo({ discount }),
          selection: {
            party,
            addOns: r(2) === 0 ? [] : [{ code: "x", quantity: 1 + r(6) }],
            promotionCode: "HARBOR10",
          },
        }),
      );
      if (outcome.kind !== "priced") {
        expect(outcome.problems).toEqual([{ code: "promotion_not_applicable", reason: "unknown" }]);
        continue;
      }
      pricedCount += 1;
      const q = outcome.quote;
      const sum = (values: number[]) => values.reduce((a, b) => a + b, 0);
      const of = (kinds: string[]) => q.lines.filter((l) => kinds.includes(l.kind));
      const allTaxes = q.lines.flatMap((l) => l.taxes);
      expect(q.totals.subtotal).toBe(sum(of(["ticket", "add_on"]).map((l) => l.amount)));
      expect(q.totals.fees).toBe(sum(of(["fee"]).map((l) => l.amount)));
      expect(q.totals.discount).toBe(sum(q.lines.map((l) => l.discountAmount)));
      expect(q.totals.tax).toBe(sum(allTaxes.filter((t) => !t.inclusive).map((t) => t.amount)));
      expect(q.totals.includedTax).toBe(
        sum(allTaxes.filter((t) => t.inclusive).map((t) => t.amount)),
      );
      expect(q.totals.total).toBe(
        q.totals.subtotal - q.totals.discount + q.totals.fees + q.totals.tax,
      );
      expect(sum(q.taxes.map((t) => t.amount))).toBe(sum(allTaxes.map((t) => t.amount)));
      for (const l of q.lines) {
        expect(l.amount).toBe(l.quantity * l.unitAmount);
        expect(l.discountAmount).toBeGreaterThanOrEqual(0);
        expect(l.discountAmount).toBeLessThanOrEqual(l.amount);
        if (!["ticket", "charter"].includes(l.kind)) expect(l.discountAmount).toBe(0);
        if (!l.taxable) expect(l.taxes).toEqual([]);
        const net = l.amount - l.discountAmount;
        const included = sum(l.taxes.filter((t) => t.inclusive).map((t) => t.amount));
        for (const t of l.taxes) {
          expect(Number.isSafeInteger(t.amount) && t.amount >= 0).toBe(true);
          expect(t.taxableAmount).toBe(net - included);
          // An added tax is its exact value rounded; an included one is a
          // share of the extracted total, within two cents of exact.
          const exact = (t.taxableAmount * t.ratePpm) / 1_000_000;
          expect(Math.abs(t.amount - exact)).toBeLessThanOrEqual(t.inclusive ? 2 : 0.5);
        }
      }
      if (q.discount) {
        expect(q.discount.amount).toBeLessThanOrEqual(q.discount.eligibleAmount);
        expect(q.discount.lineNo).toBe(q.lines.length + 1);
      }
    }
    expect(pricedCount).toBeGreaterThan(300);
  });
});

describe("helpers", () => {
  it("treats add-on date bounds as inclusive and open when missing", () => {
    const item = sharedList().addOns[2];
    if (!item) throw new Error("fixture");
    expect(addOnAvailableOn(item, "2026-12-01")).toBe(true);
    expect(addOnAvailableOn(item, "2026-11-30")).toBe(false);
    expect(addOnAvailableOn({ ...item, availableFrom: null }, "2020-01-01")).toBe(true);
    expect(addOnAvailableOn({ ...item, availableUntil: null }, "2099-01-01")).toBe(true);
  });

  it("puts the change cutoff that many elapsed minutes before departure", () => {
    const policy = { changeCutoffMinutes: 1440 } as PolicyVersion;
    expect(changeCutoffAt(policy, Date.parse("2026-11-02T05:30:00Z")).toISOString()).toBe(
      "2026-11-01T05:30:00.000Z",
    );
  });
});
