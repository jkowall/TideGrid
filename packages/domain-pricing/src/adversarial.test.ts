import { describe, expect, it } from "vitest";
import {
  MAX_QUOTE_AMOUNT,
  type PricedQuote,
  priceQuote,
  type QuoteInput,
  type QuoteOutcome,
  type QuoteSelection,
  type QuoteSubject,
} from "./compute.ts";
import { allocateLargestRemainder, mulDivHalfUp } from "./money.ts";
import type {
  AddOnItem,
  ChargeBasis,
  FeeItem,
  PriceList,
  PromotionTerms,
  TaxRate,
  TicketItem,
} from "./terms.ts";
import {
  validatePolicy,
  validatePriceList,
  validatePromotionTerms,
  validateTaxRate,
} from "./validate.ts";

// Independent adversarial checks of the pure quote computation, written from
// the accepted contract in this package's README. The oracle below restates
// the eight computation rules in exact BigInt arithmetic and shares no code
// with money.ts or compute.ts. Every fixture is synthetic.

const PRODUCT = "33333333-3333-4333-8333-333333333333";
const OTHER_PRODUCT = "44444444-4444-4444-8444-444444444444";
const NOW = Date.parse("2026-10-15T00:00:00Z");

// Oracle ------------------------------------------------------------------------

/** round(num / den), halves up, for num >= 0 and den > 0. */
function halfUp(num: bigint, den: bigint): bigint {
  return (2n * num + den) / (2n * den);
}

/**
 * Largest remainder, as the contract states it: every share starts at the
 * floor of its exact value, then the units left over go one each to the
 * largest remainders, the earlier weight first on a tie.
 */
function hamilton(total: bigint, weights: readonly bigint[]): bigint[] {
  const sum = weights.reduce((a, w) => a + w, 0n);
  if (sum === 0n) return weights.map(() => 0n);
  const parts = weights.map((w) => (total * w) / sum);
  const rest = weights.map((w) => (total * w) % sum);
  let left = total - parts.reduce((a, p) => a + p, 0n);
  const taken = new Set<number>();
  while (left > 0n) {
    let best = -1;
    for (let i = 0; i < weights.length; i++) {
      if (taken.has(i)) continue;
      if (best < 0 || (rest[i] ?? 0n) > (rest[best] ?? 0n)) best = i;
    }
    taken.add(best);
    parts[best] = (parts[best] ?? 0n) + 1n;
    left -= 1n;
  }
  return parts;
}

interface OracleLine {
  kind: string;
  code: string;
  quantity: number;
  unitAmount: number;
  amount: number;
  discountAmount: number;
  /** [taxRateId, taxableAmount, amount] in rate order. */
  taxes: Array<[string, number, number]>;
}

interface Oracle {
  lines: OracleLine[];
  totals: {
    subtotal: number;
    discount: number;
    fees: number;
    tax: number;
    includedTax: number;
    total: number;
  };
  /** A line or total above $1,000,000. */
  tooLarge: boolean;
}

/** The contract's rules 5 to 8 for a selection that passes rules 1 to 4. */
function oracle(q: QuoteInput): Oracle {
  const list = q.priceList;
  const party = q.selection.party;
  const size =
    party.kind === "tickets" ? party.tickets.reduce((a, t) => a + t.quantity, 0) : party.guests;
  const drafts: Array<{
    kind: string;
    code: string;
    quantity: number;
    unit: number;
    taxable: boolean;
  }> = [];
  if (party.kind === "tickets") {
    for (const t of list.tickets) {
      const chosen = party.tickets.find((x) => x.code === t.code);
      if (chosen) {
        drafts.push({
          kind: "ticket",
          code: t.code,
          quantity: chosen.quantity,
          unit: t.unitAmount,
          taxable: t.taxable,
        });
      }
    }
  } else if (list.charter) {
    drafts.push({
      kind: "charter",
      code: "charter",
      quantity: 1,
      unit: list.charter.amount,
      taxable: list.charter.taxable,
    });
  }
  for (const a of list.addOns) {
    const chosen = q.selection.addOns.find((x) => x.code === a.code);
    if (chosen) {
      drafts.push({
        kind: "add_on",
        code: a.code,
        quantity: chosen.quantity,
        unit: a.unitAmount,
        taxable: a.taxable,
      });
    }
  }
  for (const f of list.fees) {
    drafts.push({
      kind: "fee",
      code: f.code,
      quantity: f.basis === "per_participant" ? size : 1,
      unit: f.unitAmount,
      taxable: f.taxable,
    });
  }
  const amounts = drafts.map((d) => BigInt(d.quantity) * BigInt(d.unit));
  const tripIndexes = drafts.flatMap((d, i) =>
    d.kind === "ticket" || d.kind === "charter" ? [i] : [],
  );
  const eligible = tripIndexes.reduce((a, i) => a + (amounts[i] ?? 0n), 0n);
  const shares = drafts.map(() => 0n);
  let discount = 0n;
  const promo = q.selection.promotionCode === null ? null : q.promotion;
  if (promo) {
    discount =
      promo.discount.kind === "percent"
        ? halfUp(eligible * BigInt(promo.discount.percentOffBp), 10_000n)
        : BigInt(promo.discount.amountOff) < eligible
          ? BigInt(promo.discount.amountOff)
          : eligible;
    const split = hamilton(
      discount,
      tripIndexes.map((i) => amounts[i] ?? 0n),
    );
    tripIndexes.forEach((i, k) => {
      shares[i] = split[k] ?? 0n;
    });
  }
  const inclusive = q.taxRates.filter((r) => r.inclusive);
  const inclusivePpm = inclusive.reduce((a, r) => a + BigInt(r.ratePpm), 0n);
  let added = 0n;
  let included = 0n;
  const lines = drafts.map((d, i): OracleLine => {
    const taxes: Array<[string, number, number]> = [];
    const amount = amounts[i] ?? 0n;
    const share = shares[i] ?? 0n;
    if (d.taxable) {
      const net = amount - share;
      const base = inclusivePpm > 0n ? halfUp(net * 1_000_000n, 1_000_000n + inclusivePpm) : net;
      const extracted = hamilton(
        net - base,
        inclusive.map((r) => BigInt(r.ratePpm)),
      );
      let k = 0;
      for (const r of q.taxRates) {
        let tax: bigint;
        if (r.inclusive) {
          tax = extracted[k] ?? 0n;
          k += 1;
          included += tax;
        } else {
          tax = halfUp(base * BigInt(r.ratePpm), 1_000_000n);
          added += tax;
        }
        taxes.push([r.taxRateId, Number(base), Number(tax)]);
      }
    }
    return {
      kind: d.kind,
      code: d.code,
      quantity: d.quantity,
      unitAmount: d.unit,
      amount: Number(amount),
      discountAmount: Number(share),
      taxes,
    };
  });
  const sumOf = (kinds: readonly string[]) =>
    drafts.reduce((a, d, i) => (kinds.includes(d.kind) ? a + (amounts[i] ?? 0n) : a), 0n);
  const subtotal = sumOf(["ticket", "charter", "add_on"]);
  const fees = sumOf(["fee"]);
  const total = subtotal - discount + fees + added;
  const limit = BigInt(MAX_QUOTE_AMOUNT);
  return {
    lines,
    totals: {
      subtotal: Number(subtotal),
      discount: Number(discount),
      fees: Number(fees),
      tax: Number(added),
      includedTax: Number(included),
      total: Number(total),
    },
    tooLarge:
      amounts.some((a) => a > limit) ||
      [subtotal, fees, added, included, total].some((v) => v > limit),
  };
}

function shape(q: PricedQuote): Omit<Oracle, "tooLarge"> {
  return {
    lines: q.lines.map((l) => ({
      kind: l.kind,
      code: l.code,
      quantity: l.quantity,
      unitAmount: l.unitAmount,
      amount: l.amount,
      discountAmount: l.discountAmount,
      taxes: l.taxes.map((t): [string, number, number] => [t.taxRateId, t.taxableAmount, t.amount]),
    })),
    totals: q.totals,
  };
}

// Fixtures ------------------------------------------------------------------------

const ticket = (code: string, unitAmount: number, taxable = true): TicketItem => ({
  code,
  name: `Ticket ${code}`,
  unitAmount,
  taxable,
});
const fee = (code: string, unitAmount: number, basis: ChargeBasis, taxable = false): FeeItem => ({
  code,
  name: `Fee ${code}`,
  unitAmount,
  basis,
  taxable,
});
const addOn = (
  code: string,
  unitAmount: number,
  quantityRule: ChargeBasis,
  maxQuantity: number,
  extra: Partial<AddOnItem> = {},
): AddOnItem => ({
  code,
  name: `Add-on ${code}`,
  unitAmount,
  quantityRule,
  maxQuantity,
  taxable: true,
  availableFrom: null,
  availableUntil: null,
  ...extra,
});
const rate = (n: number, ratePpm: number, inclusive = false): TaxRate => ({
  taxRateId: `aaaaaaaa-aaaa-4aaa-8aaa-${String(n).padStart(12, "0")}`,
  version: 1,
  name: `Rate ${n}`,
  ratePpm,
  inclusive,
});

const sharedList = (): PriceList => ({
  productId: PRODUCT,
  version: 1,
  productKind: "shared_seat",
  tickets: [ticket("adult", 4500), ticket("child", 2500), ticket("infant", 0, false)],
  charter: null,
  fees: [fee("harbor", 250, "per_participant"), fee("booking", 199, "per_booking", true)],
  addOns: [
    addOn("photo", 1200, "per_booking", 2),
    addOn("drink", 800, "per_participant", 2),
    addOn("dinner", 3500, "per_participant", 1, {
      availableFrom: "2026-12-31",
      availableUntil: "2026-12-31",
    }),
  ],
});

const charterList = (): PriceList => ({
  productId: PRODUCT,
  version: 1,
  productKind: "private_charter",
  tickets: [],
  charter: { name: "Whole boat", amount: 120_000, taxable: true },
  fees: [fee("fuel", 7500, "per_booking", true)],
  addOns: [addOn("cooler", 1500, "per_booking", 1), addOn("lunch", 2500, "per_participant", 1)],
});

const sharedSubject: QuoteSubject = {
  productId: PRODUCT,
  productKind: "shared_seat",
  localDate: "2026-11-10",
  minPartySize: 1,
  maxPartySize: 10,
  capacityRemaining: 20,
};
const charterSubject: QuoteSubject = {
  ...sharedSubject,
  productKind: "private_charter",
  maxPartySize: 12,
  capacityRemaining: 12,
};

const promotion = (overrides: Partial<PromotionTerms> = {}): PromotionTerms => ({
  promotionId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
  version: 1,
  code: "TIDE10",
  active: true,
  discount: { kind: "percent", percentOffBp: 1000 },
  startsAtMs: Date.parse("2026-09-01T00:00:00Z"),
  endsAtMs: Date.parse("2027-06-01T00:00:00Z"),
  appliesToAllProducts: true,
  productIds: [],
  ...overrides,
});

const tickets = (...pairs: Array<[string, number]>): QuoteSelection["party"] => ({
  kind: "tickets",
  tickets: pairs.map(([code, quantity]) => ({ code, quantity })),
});
const addOns = (...pairs: Array<[string, number]>) =>
  pairs.map(([code, quantity]) => ({ code, quantity }));

function quoteInput(
  overrides: Omit<Partial<QuoteInput>, "selection"> & { selection?: Partial<QuoteSelection> } = {},
): QuoteInput {
  const { selection, ...rest } = overrides;
  const base: QuoteInput = {
    nowMs: NOW,
    subject: sharedSubject,
    priceList: sharedList(),
    taxRates: [],
    promotion: null,
    selection: { party: tickets(["adult", 2]), addOns: [], promotionCode: null },
  };
  return { ...base, ...rest, selection: { ...base.selection, ...selection } };
}

function priced(outcome: QuoteOutcome): PricedQuote {
  if (outcome.kind !== "priced") throw new Error(`expected a price: ${JSON.stringify(outcome)}`);
  return outcome.quote;
}

function problemsOf(outcome: QuoteOutcome) {
  if (outcome.kind !== "rejected") {
    throw new Error(`expected problems: ${JSON.stringify(outcome)}`);
  }
  return outcome.problems;
}

/** Deterministic generator (mulberry32), so a failure reproduces from its seed. */
function generator(seed: number) {
  let a = seed >>> 0;
  return (n: number): number => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) % n;
  };
}

// Money primitives ------------------------------------------------------------------

describe("mulDivHalfUp against exact rounding", () => {
  it("matches round half up on every small input", () => {
    let checked = 0;
    for (let value = 0; value <= 120; value++) {
      for (let numerator = 0; numerator <= 30; numerator++) {
        for (let denominator = 1; denominator <= 40; denominator++) {
          const expected = Number(halfUp(BigInt(value) * BigInt(numerator), BigInt(denominator)));
          if (mulDivHalfUp(value, numerator, denominator) !== expected) {
            throw new Error(`mulDivHalfUp(${value}, ${numerator}, ${denominator})`);
          }
          checked += 1;
        }
      }
    }
    expect(checked).toBe(121 * 31 * 40);
  });

  it("stays exact when the product passes 2^53 and rounds an exact half up", () => {
    const max = Number.MAX_SAFE_INTEGER;
    expect(mulDivHalfUp(max, 1_000_000, 1_000_000)).toBe(max);
    expect(mulDivHalfUp(max, 1, 2)).toBe(2 ** 52);
    expect(mulDivHalfUp(max - 1, 1, 2)).toBe(2 ** 52 - 1);
    expect(mulDivHalfUp(100_000_000, 500_000, 1_000_000)).toBe(50_000_000);
    expect(mulDivHalfUp(100_000_000, 1_000_000, 1_500_000)).toBe(66_666_667);
    expect(mulDivHalfUp(1, 5_000, 10_000)).toBe(1);
    expect(mulDivHalfUp(1, 4_999, 10_000)).toBe(0);
  });

  it("refuses anything that is not a non-negative safe integer instead of guessing", () => {
    for (const bad of [Number.NaN, Number.POSITIVE_INFINITY, -1, 0.5, 2 ** 53]) {
      expect(() => mulDivHalfUp(bad, 1, 1)).toThrow(RangeError);
      expect(() => mulDivHalfUp(1, bad, 1)).toThrow(RangeError);
      expect(() => mulDivHalfUp(1, 1, bad)).toThrow(RangeError);
    }
    expect(() => mulDivHalfUp("5" as unknown as number, 1, 1)).toThrow(RangeError);
    expect(() => mulDivHalfUp(Number.MAX_SAFE_INTEGER, 3, 2)).toThrow(RangeError);
  });
});

describe("allocateLargestRemainder against the contract's definition", () => {
  it("matches the oracle on generated weights, including zeros, ties, and large values", () => {
    const r = generator(20261015);
    for (let run = 0; run < 3000; run++) {
      const count = 1 + r(6);
      const weights = Array.from({ length: count }, () => {
        switch (r(5)) {
          case 0:
            return 0;
          case 1:
            return 2599;
          case 2:
            return 1 + r(10);
          case 3:
            return 1 + r(100_000_000);
          default:
            return 1 + r(5000);
        }
      });
      const sum = weights.reduce((a, w) => a + w, 0);
      const total = sum === 0 ? 0 : r(sum + 1);
      const parts = allocateLargestRemainder(total, weights);
      const expected = hamilton(
        BigInt(total),
        weights.map((w) => BigInt(w)),
      ).map(Number);
      if (JSON.stringify(parts) !== JSON.stringify(expected)) {
        throw new Error(`run ${run}: ${total} over ${JSON.stringify(weights)}`);
      }
      expect(parts.reduce((a, p) => a + p, 0)).toBe(total);
    }
  });

  it("gives every tied unit to the earlier weights, whatever their position", () => {
    expect(allocateLargestRemainder(3, [5, 5, 5, 5, 5])).toEqual([1, 1, 1, 0, 0]);
    expect(allocateLargestRemainder(999, [2599, 2599])).toEqual([500, 499]);
    expect(allocateLargestRemainder(1, [0, 7, 7])).toEqual([0, 1, 0]);
    // A larger remainder still wins over an earlier, smaller one.
    expect(allocateLargestRemainder(2, [1, 2])).toEqual([1, 1]);
    expect(allocateLargestRemainder(1, [1, 2])).toEqual([0, 1]);
  });

  it("stays exact at the edge of the safe integer range", () => {
    const max = Number.MAX_SAFE_INTEGER;
    expect(allocateLargestRemainder(max, [max, 1])).toEqual([max - 1, 1]);
    expect(allocateLargestRemainder(max, [1, 1])).toEqual([2 ** 52, 2 ** 52 - 1]);
  });
});

// Hand-worked amounts ----------------------------------------------------------------

describe("worked examples, computed by hand and checked in exact arithmetic", () => {
  it("extracts two inclusive rates together and adds an exclusive rate on the same pre-tax base", () => {
    // 10000 / 1.05 = 9523.81 -> 9524; 476 extracted, 4:1 is 380.8 and 95.2 -> 381 and 95;
    // 6% of 9524 = 571.44 -> 571.
    const q = priced(
      priceQuote(
        quoteInput({
          priceList: { ...sharedList(), tickets: [ticket("adult", 10_000)], fees: [] },
          taxRates: [rate(1, 40_000, true), rate(2, 10_000, true), rate(3, 60_000)],
          selection: { party: tickets(["adult", 1]) },
        }),
      ),
    );
    expect(q.lines[0]?.taxes.map((t) => [t.taxableAmount, t.amount])).toEqual([
      [9524, 381],
      [9524, 95],
      [9524, 571],
    ]);
    expect(q.totals).toEqual({
      subtotal: 10_000,
      discount: 0,
      fees: 0,
      tax: 571,
      includedTax: 476,
      total: 10_571,
    });
  });

  it("rounds an inclusive base half up when the rates sum to 100% and splits the rest evenly", () => {
    const list = { ...sharedList(), fees: [], tickets: [ticket("a", 101), ticket("b", 103)] };
    const q = priced(
      priceQuote(
        quoteInput({
          priceList: list,
          taxRates: [rate(1, 500_000, true), rate(2, 500_000, true)],
          selection: { party: tickets(["a", 1], ["b", 1]) },
        }),
      ),
    );
    // 101 / 2 = 50.5 -> 51, 50 split 25 and 25; 103 / 2 = 51.5 -> 52, 51 split 26 and 25.
    expect(q.lines.map((l) => l.taxes.map((t) => [t.taxableAmount, t.amount]))).toEqual([
      [
        [51, 25],
        [51, 25],
      ],
      [
        [52, 26],
        [52, 25],
      ],
    ]);
    expect(q.totals.total).toBe(204);
    expect(q.totals.includedTax).toBe(101);
  });

  it("rounds a percentage once on the trip price, not per line", () => {
    // 10% of 2010 is 201; per line it would be 101 + 101 = 202.
    const q = priced(
      priceQuote(
        quoteInput({
          priceList: { ...sharedList(), fees: [], tickets: [ticket("a", 1005), ticket("b", 1005)] },
          promotion: promotion(),
          selection: { party: tickets(["a", 1], ["b", 1]), promotionCode: "tide10" },
        }),
      ),
    );
    expect(q.totals.discount).toBe(201);
    expect(q.lines.map((l) => l.discountAmount)).toEqual([101, 100]);
  });

  it("gives a tied fixed discount's odd cent to the earlier price list line, whatever the request order", () => {
    // 999 over 2599 and 2599: 499.5 each -> 500 to the first line in price list order.
    const list = {
      ...sharedList(),
      fees: [],
      tickets: [ticket("child", 2599), ticket("senior", 2599)],
    };
    const q = priced(
      priceQuote(
        quoteInput({
          priceList: list,
          taxRates: [rate(1, 60_000)],
          promotion: promotion({ discount: { kind: "fixed_amount", amountOff: 999 } }),
          selection: { party: tickets(["senior", 1], ["child", 1]), promotionCode: "TIDE10" },
        }),
      ),
    );
    expect(q.lines.map((l) => [l.code, l.discountAmount, l.taxes[0]?.amount])).toEqual([
      ["child", 500, 126],
      ["senior", 499, 126],
    ]);
    expect(q.totals).toMatchObject({ subtotal: 5198, discount: 999, tax: 252, total: 4451 });
  });

  it("rounds a per-participant fee's tax once for the line, not once per participant", () => {
    // 3 x 150 = 450 at 7% is 31.5 -> 32; per participant it would be 3 x 11 = 33.
    const list = { ...sharedList(), fees: [fee("park", 150, "per_participant", true)] };
    const q = priced(
      priceQuote(
        quoteInput({
          priceList: list,
          taxRates: [rate(1, 70_000)],
          selection: { party: tickets(["infant", 3]) },
        }),
      ),
    );
    expect(q.lines.map((l) => [l.kind, l.quantity, l.amount, l.taxes[0]?.amount ?? null])).toEqual([
      ["ticket", 3, 0, null],
      ["fee", 3, 450, 32],
    ]);
    expect(q.totals).toMatchObject({ fees: 450, tax: 32, total: 482 });
  });
});

// Every rule at once, generated --------------------------------------------------------

describe("generated quotes against the oracle", () => {
  it("prices every line, share, tax, and total exactly as the contract's rules do", () => {
    let pricedCount = 0;
    let refusedCount = 0;
    let nearLimit = 0;
    let discounted = 0;
    let withInclusive = 0;
    for (let seed = 1; seed <= 2500; seed++) {
      const r = generator(seed);
      // One seed in ten prices large items, so the $1,000,000 limit is reached
      // from lines, from totals, and not at all.
      const large = r(10) === 0;
      const amount = (max: number) => {
        if (large) return r(2) === 0 ? 10_000_000 : 1 + r(max);
        switch (r(6)) {
          case 0:
            return 0;
          case 1:
            return 2599;
          case 2:
            return 1 + r(999);
          case 3:
            return r(6) === 0 ? 10_000_000 : 1 + r(max);
          default:
            return 1 + r(50_000);
        }
      };
      const charter = r(5) === 0;
      const ticketTypes = Array.from({ length: 1 + r(4) }, (_, i) =>
        ticket(`t${i}`, amount(2_000_000), r(3) !== 0),
      );
      const fees = Array.from({ length: r(4) }, (_, i) =>
        fee(`f${i}`, 1 + r(30_000), r(2) === 0 ? "per_booking" : "per_participant", r(2) === 0),
      );
      const offered = Array.from({ length: r(4) }, (_, i) =>
        addOn(`a${i}`, amount(200_000), r(2) === 0 ? "per_booking" : "per_participant", 1 + r(4), {
          taxable: r(3) !== 0,
        }),
      );
      const list: PriceList = charter
        ? {
            productId: PRODUCT,
            version: 1,
            productKind: "private_charter",
            tickets: [],
            charter: { name: "Whole boat", amount: amount(5_000_000), taxable: r(4) !== 0 },
            fees,
            addOns: offered,
          }
        : {
            productId: PRODUCT,
            version: 1,
            productKind: "shared_seat",
            tickets: ticketTypes,
            charter: null,
            fees,
            addOns: offered,
          };
      const ppm = () => [1, 5_000, 10_000, 47_120, 60_000, 500_000, 1 + r(500_000)][r(7)] ?? 1;
      const rates = Array.from({ length: r(5) }, (_, i) => rate(seed * 10 + i, ppm(), r(3) === 0));
      if (rates.some((x) => x.inclusive)) withInclusive += 1;
      let party: QuoteSelection["party"];
      let size: number;
      if (charter) {
        size = 1 + r(12);
        party = { kind: "charter", guests: size };
      } else {
        const chosen = ticketTypes.filter(() => r(3) !== 0);
        const picked = chosen.length > 0 ? chosen : ticketTypes.slice(0, 1);
        const pairs = picked.map((t): [string, number] => [t.code, 1 + r(5)]);
        // Send them in reverse sometimes; lines must follow the price list anyway.
        if (r(2) === 0) pairs.reverse();
        size = pairs.reduce((a, [, n]) => a + n, 0);
        party = tickets(...pairs);
      }
      const selectedAddOns = offered
        .filter(() => r(2) === 0)
        .map((a) => {
          const limit = a.maxQuantity * (a.quantityRule === "per_participant" ? size : 1);
          return { code: a.code, quantity: 1 + r(limit) };
        });
      const kind = r(4);
      const terms =
        kind === 0
          ? null
          : promotion({
              discount:
                kind === 1
                  ? { kind: "percent", percentOffBp: [1, 1000, 1250, 3333, 10_000][r(5)] ?? 1 }
                  : kind === 2
                    ? { kind: "fixed_amount", amountOff: [1, 999, 2500, 10_000_000][r(4)] ?? 1 }
                    : { kind: "percent", percentOffBp: 1 + r(10_000) },
            });
      const input: QuoteInput = {
        nowMs: NOW,
        subject: {
          productId: PRODUCT,
          productKind: charter ? "private_charter" : "shared_seat",
          localDate: "2026-11-10",
          minPartySize: 1,
          maxPartySize: 500,
          capacityRemaining: 500,
        },
        priceList: list,
        taxRates: rates,
        promotion: terms,
        selection: {
          party,
          addOns: selectedAddOns,
          promotionCode: terms ? " tide10 " : null,
        },
      };
      const expected = oracle(input);
      const outcome = priceQuote(input);
      if (expected.tooLarge) {
        expect({ seed, outcome }).toEqual({
          seed,
          outcome: { kind: "rejected", problems: [{ code: "quote_amount_too_large" }] },
        });
        refusedCount += 1;
        continue;
      }
      if (outcome.kind !== "priced") throw new Error(`seed ${seed}: ${JSON.stringify(outcome)}`);
      expect({ seed, ...shape(outcome.quote) }).toEqual({
        seed,
        lines: expected.lines,
        totals: expected.totals,
      });
      if (terms) {
        discounted += 1;
        expect(outcome.quote.discount).toMatchObject({
          lineNo: outcome.quote.lines.length + 1,
          amount: expected.totals.discount,
          code: "TIDE10",
        });
      } else {
        expect(outcome.quote.discount).toBeNull();
      }
      pricedCount += 1;
      if (outcome.quote.totals.total > MAX_QUOTE_AMOUNT / 2) nearLimit += 1;
    }
    // The generator must reach every branch, or the comparison proves little.
    expect(pricedCount).toBeGreaterThan(1500);
    expect(refusedCount).toBeGreaterThan(20);
    expect(nearLimit).toBeGreaterThan(10);
    expect(discounted).toBeGreaterThan(1000);
    expect(withInclusive).toBeGreaterThan(500);
  });
});

// Limits ------------------------------------------------------------------------------------

describe("the $1,000,000 limit", () => {
  const yacht = (taxable: boolean, fees: FeeItem[] = []): PriceList => ({
    productId: PRODUCT,
    version: 1,
    productKind: "shared_seat",
    tickets: [ticket("berth", 10_000_000, taxable), ticket("deck", 10_000_000, taxable)],
    charter: null,
    fees,
    addOns: [],
  });
  const subject = { ...sharedSubject, maxPartySize: 50, capacityRemaining: 50 };
  const run = (list: PriceList, party: QuoteSelection["party"], taxRates: TaxRate[] = []) =>
    priceQuote(quoteInput({ subject, priceList: list, taxRates, selection: { party } }));
  const tooLarge = [{ code: "quote_amount_too_large" }];

  it("accepts a line and a total of exactly $1,000,000", () => {
    const q = priced(run(yacht(false), tickets(["berth", 10])));
    expect(q.totals.total).toBe(MAX_QUOTE_AMOUNT);
    // Inclusive tax is reported inside the price, so it never pushes the total over.
    const inclusive = priced(run(yacht(true), tickets(["berth", 10]), [rate(1, 500_000, true)]));
    expect(inclusive.totals).toMatchObject({ total: MAX_QUOTE_AMOUNT, includedTax: 33_333_333 });
  });

  it("refuses one cent more, whether it comes from a line, a fee, an added tax, or a second line", () => {
    expect(problemsOf(run(yacht(false), tickets(["berth", 11])))).toEqual(tooLarge);
    expect(
      problemsOf(run(yacht(false, [fee("dock", 1, "per_booking")]), tickets(["berth", 10]))),
    ).toEqual(tooLarge);
    expect(problemsOf(run(yacht(true), tickets(["berth", 10]), [rate(1, 1)]))).toEqual(tooLarge);
    expect(problemsOf(run(yacht(false), tickets(["berth", 6], ["deck", 6])))).toEqual(tooLarge);
  });

  it("refuses a subtotal over the limit even when the discount would bring the total under it", () => {
    const outcome = priceQuote(
      quoteInput({
        subject,
        priceList: yacht(false),
        promotion: promotion({ discount: { kind: "percent", percentOffBp: 5000 } }),
        selection: { party: tickets(["berth", 6], ["deck", 6]), promotionCode: "TIDE10" },
      }),
    );
    expect(problemsOf(outcome)).toEqual(tooLarge);
  });
});

// Eligibility ---------------------------------------------------------------------------------

describe("eligibility edges", () => {
  it("refuses every quantity that is not a whole number from 1 to 1,000,000, by name", () => {
    const bad = [
      0,
      -1,
      -0,
      0.5,
      1.000001,
      Number.NaN,
      Number.POSITIVE_INFINITY,
      Number.NEGATIVE_INFINITY,
      2 ** 53,
      1_000_001,
      "2" as unknown as number,
      null as unknown as number,
    ];
    for (const quantity of bad) {
      expect({
        quantity,
        problems: problemsOf(
          priceQuote(quoteInput({ selection: { party: tickets(["adult", quantity]) } })),
        ),
      }).toEqual({
        quantity,
        problems: [{ code: "invalid_quantity", subject: "adult" }],
      });
      expect({
        quantity,
        problems: problemsOf(
          priceQuote(quoteInput({ selection: { addOns: addOns(["photo", quantity]) } })),
        ),
      }).toEqual({ quantity, problems: [{ code: "invalid_quantity", subject: "photo" }] });
      expect({
        quantity,
        problems: problemsOf(
          priceQuote(
            quoteInput({
              subject: charterSubject,
              priceList: charterList(),
              selection: { party: { kind: "charter", guests: quantity } },
            }),
          ),
        ),
      }).toEqual({ quantity, problems: [{ code: "invalid_quantity", subject: "guests" }] });
    }
    // The largest whole quantity is counted, then refused as a party that does not fit.
    expect(
      problemsOf(priceQuote(quoteInput({ selection: { party: tickets(["adult", 1_000_000]) } }))),
    ).toEqual([{ code: "party_size_out_of_range" }, { code: "insufficient_capacity" }]);
  });

  it("prices a party of exactly the remaining seats and refuses one more, for seats and charters", () => {
    const full = { ...sharedSubject, minPartySize: 3, maxPartySize: 3, capacityRemaining: 3 };
    expect(
      priced(priceQuote(quoteInput({ subject: full, selection: { party: tickets(["adult", 3]) } })))
        .totals.subtotal,
    ).toBe(13_500);
    expect(
      problemsOf(
        priceQuote(
          quoteInput({
            subject: { ...full, maxPartySize: 4 },
            selection: { party: tickets(["adult", 4]) },
          }),
        ),
      ),
    ).toEqual([{ code: "insufficient_capacity" }]);
    expect(
      problemsOf(
        priceQuote(
          quoteInput({
            subject: { ...sharedSubject, capacityRemaining: 0 },
            selection: { party: tickets(["adult", 1]) },
          }),
        ),
      ),
    ).toEqual([{ code: "insufficient_capacity" }]);
    const boat = { ...charterSubject, maxPartySize: 12, capacityRemaining: 6 };
    const charter = (guests: number) =>
      priceQuote(
        quoteInput({
          subject: boat,
          priceList: charterList(),
          selection: { party: { kind: "charter", guests } },
        }),
      );
    expect(priced(charter(6)).lines[0]).toMatchObject({ kind: "charter", amount: 120_000 });
    expect(problemsOf(charter(7))).toEqual([{ code: "insufficient_capacity" }]);
    expect(problemsOf(charter(13))).toEqual([
      { code: "party_size_out_of_range" },
      { code: "insufficient_capacity" },
    ]);
  });

  it("offers a one-day add-on on that local date only, across a year boundary", () => {
    const on = (localDate: string) =>
      priceQuote(
        quoteInput({
          subject: { ...sharedSubject, localDate },
          selection: { addOns: addOns(["dinner", 1]) },
        }),
      );
    expect(priced(on("2026-12-31")).lines.map((l) => l.code)).toContain("dinner");
    for (const day of ["2026-12-30", "2027-01-01", "2027-12-31"]) {
      expect({ day, problems: problemsOf(on(day)) }).toEqual({
        day,
        problems: [{ code: "add_on_unavailable", subject: "dinner" }],
      });
    }
  });

  it("applies a promotion for exactly the instants of a one-millisecond window", () => {
    const window = promotion({ startsAtMs: NOW, endsAtMs: NOW + 1 });
    const at = (nowMs: number) =>
      priceQuote(quoteInput({ nowMs, promotion: window, selection: { promotionCode: "tide10" } }));
    expect(priced(at(NOW)).totals.discount).toBe(900);
    expect(problemsOf(at(NOW - 1))).toEqual([
      { code: "promotion_not_applicable", reason: "not_started" },
    ]);
    expect(problemsOf(at(NOW + 1))).toEqual([
      { code: "promotion_not_applicable", reason: "expired" },
    ]);
  });

  it("compares codes trimmed and in any case, and nothing looser", () => {
    const terms = promotion();
    const code = (entered: string) =>
      priceQuote(quoteInput({ promotion: terms, selection: { promotionCode: entered } }));
    for (const entered of ["TIDE10", "tide10", " TiDe10 ", "\ttide10\n"]) {
      expect({ entered, discount: priced(code(entered)).totals.discount }).toEqual({
        entered,
        discount: 900,
      });
    }
    for (const entered of ["TIDE 10", "TIDE10X", "TIDE1", "TIDE10​", "TIDE-10"]) {
      expect({ entered, problems: problemsOf(code(entered)) }).toEqual({
        entered,
        problems: [{ code: "promotion_not_applicable", reason: "unknown" }],
      });
    }
  });

  it("refuses a code for a product it does not list even when it lists others", () => {
    const listed = promotion({ appliesToAllProducts: false, productIds: [OTHER_PRODUCT] });
    expect(
      problemsOf(
        priceQuote(quoteInput({ promotion: listed, selection: { promotionCode: "TIDE10" } })),
      ),
    ).toEqual([{ code: "promotion_not_applicable", reason: "product_ineligible" }]);
  });

  it("reports every independent problem in rule order: party, add-ons, then the code", () => {
    const outcome = priceQuote(
      quoteInput({
        promotion: promotion({ active: false }),
        selection: {
          party: tickets(["adult", 1], ["senior", 1], ["adult", 1], ["child", 0]),
          addOns: addOns(["kayak", 1], ["dinner", 1], ["photo", 1], ["photo", 1]),
          promotionCode: "TIDE10",
        },
      }),
    );
    expect(problemsOf(outcome)).toEqual([
      { code: "unknown_ticket_type", subject: "senior" },
      { code: "duplicate_ticket_type", subject: "adult" },
      { code: "invalid_quantity", subject: "child" },
      { code: "unknown_add_on", subject: "kayak" },
      { code: "add_on_unavailable", subject: "dinner" },
      { code: "duplicate_add_on", subject: "photo" },
      { code: "promotion_not_applicable", reason: "inactive" },
    ]);
  });

  it("reports a per-booking add-on over its limit beside a party it could not count", () => {
    // The contract skips only checks that depend on an uncountable party size. A
    // per-booking limit does not depend on the party, so it is an independent
    // problem and must be reported with the party's.
    const shared = priceQuote(
      quoteInput({
        selection: { party: tickets(["senior", 2]), addOns: addOns(["photo", 3]) },
      }),
    );
    expect(problemsOf(shared)).toEqual([
      { code: "unknown_ticket_type", subject: "senior" },
      { code: "add_on_quantity_exceeded", subject: "photo" },
    ]);
    const charter = priceQuote(
      quoteInput({
        subject: charterSubject,
        priceList: charterList(),
        selection: { party: { kind: "charter", guests: 0 }, addOns: addOns(["cooler", 2]) },
      }),
    );
    expect(problemsOf(charter)).toEqual([
      { code: "invalid_quantity", subject: "guests" },
      { code: "add_on_quantity_exceeded", subject: "cooler" },
    ]);
  });
});

// Validation -------------------------------------------------------------------------------

describe("terms validation boundaries", () => {
  const base = { tickets: [ticket("adult", 4500)] };

  it("accepts every documented maximum and refuses one past it", () => {
    const code32 = `a${"b".repeat(31)}`;
    expect(validatePriceList("shared_seat", { tickets: [ticket(code32, 10_000_000)] })).toEqual([]);
    expect(validatePriceList("shared_seat", { tickets: [ticket(`${code32}c`, 1)] })).toEqual([
      "invalid_code",
    ]);
    expect(
      validatePriceList("shared_seat", {
        tickets: [{ ...ticket("adult", 1), name: "N".repeat(80) }],
      }),
    ).toEqual([]);
    expect(
      validatePriceList("shared_seat", {
        tickets: [{ ...ticket("adult", 1), name: "N".repeat(81) }],
      }),
    ).toEqual(["invalid_name"]);
    expect(validatePriceList("shared_seat", { tickets: [ticket("adult", 10_000_001)] })).toEqual([
      "invalid_amount",
    ]);
    expect(
      validatePriceList("shared_seat", {
        ...base,
        addOns: [addOn("photo", 1, "per_booking", 100)],
      }),
    ).toEqual([]);
    expect(
      validatePriceList("shared_seat", {
        ...base,
        addOns: [addOn("photo", 1, "per_booking", 101)],
      }),
    ).toEqual(["invalid_max_quantity"]);
    const many = (n: number, make: (i: number) => AddOnItem) =>
      Array.from({ length: n }, (_, i) => make(i));
    expect(
      validatePriceList("shared_seat", {
        ...base,
        addOns: many(30, (i) => addOn(`a${i}`, 1, "per_booking", 1)),
        fees: Array.from({ length: 20 }, (_, i) => fee(`f${i}`, 1, "per_booking")),
      }),
    ).toEqual([]);
    expect(
      validatePriceList("shared_seat", {
        ...base,
        addOns: many(31, (i) => addOn(`a${i}`, 1, "per_booking", 1)),
      }),
    ).toEqual(["too_many_items"]);
    expect(validateTaxRate({ name: "Max", ratePpm: 500_000, inclusive: true })).toEqual([]);
    expect(validateTaxRate({ name: "Min", ratePpm: 1, inclusive: false })).toEqual([]);
    expect(validateTaxRate({ name: "Half", ratePpm: 1.5, inclusive: false })).toEqual([
      "invalid_rate",
    ]);
  });

  it("checks add-on dates as real calendar dates", () => {
    const dated = (availableFrom: string, availableUntil: string) =>
      validatePriceList("shared_seat", {
        ...base,
        addOns: [addOn("toast", 1, "per_booking", 1, { availableFrom, availableUntil })],
      });
    expect(dated("2028-02-29", "2028-02-29")).toEqual([]);
    expect(dated("2027-02-29", "2027-03-01")).toEqual(["invalid_date_range"]);
    expect(dated("2026-12-31", "2026-12-30")).toEqual(["invalid_date_range"]);
    expect(dated("2026-1-01", "2026-12-31")).toEqual(["invalid_date_range"]);
  });

  it("bounds promotions and policies at their documented limits", () => {
    const window = {
      startsAt: new Date("2026-10-15T00:00:00.000Z"),
      endsAt: new Date("2026-10-15T00:00:00.001Z"),
      products: { all: true as const },
    };
    expect(
      validatePromotionTerms({ ...window, discount: { kind: "percent", percentOffBp: 10_000 } }),
    ).toEqual([]);
    expect(
      validatePromotionTerms({
        ...window,
        discount: { kind: "fixed_amount", amountOff: 10_000_000 },
      }),
    ).toEqual([]);
    expect(
      validatePromotionTerms({
        ...window,
        discount: { kind: "fixed_amount", amountOff: 10_000_001 },
      }),
    ).toEqual(["invalid_discount"]);
    expect(
      validatePromotionTerms({
        ...window,
        startsAt: new Date("not a date"),
        discount: { kind: "percent", percentOffBp: 1 },
      }),
    ).toEqual(["invalid_window"]);
    const ids = (n: number) =>
      Array.from({ length: n }, (_, i) => `55555555-5555-4555-8555-${String(i).padStart(12, "0")}`);
    const promo = (productIds: string[]) =>
      validatePromotionTerms({
        ...window,
        discount: { kind: "percent", percentOffBp: 1 },
        products: { productIds },
      });
    expect(promo(ids(100))).toEqual([]);
    expect(promo(ids(101))).toEqual(["invalid_products"]);
    expect(promo([PRODUCT, PRODUCT])).toEqual(["invalid_products"]);
    const text = {
      cancellation: "x".repeat(2000),
      reschedule: "Move before the cutoff.",
      noShow: "No refund.",
      operatorCancellation: "Refund or credit.",
      weather: "Captain decides.",
    };
    const policy = {
      changeCutoffMinutes: 43_200,
      beforeCutoff: { remedy: "percent_refund" as const, refundBp: 9999 },
      afterCutoff: { remedy: "percent_refund" as const, refundBp: 1 },
      noShow: { remedy: "credit" as const },
      text,
    };
    expect(validatePolicy(policy)).toEqual([]);
    expect(
      validatePolicy({ ...policy, text: { ...text, cancellation: "x".repeat(2001) } }),
    ).toEqual(["invalid_text"]);
    expect(validatePolicy({ ...policy, changeCutoffMinutes: 0.5 })).toEqual(["invalid_cutoff"]);
  });

  it("names a C1 control character in a name, which the database refuses as [[:cntrl:]]", () => {
    // PostgreSQL's [[:cntrl:]] (checked on price_list_items.name and
    // tax_rate_versions.name) matches U+0080 to U+009F as well as U+0000 to
    // U+001F and U+007F. Validation must name the problem rather than let the
    // insert fail with a raw 23514.
    expect(
      validatePriceList("shared_seat", {
        tickets: [{ ...ticket("adult", 4500), name: "Adult\u0085" }],
      }),
    ).toEqual(["invalid_name"]);
    expect(validateTaxRate({ name: "Sales\u009btax", ratePpm: 70_000, inclusive: false })).toEqual([
      "invalid_name",
    ]);
  });
});
