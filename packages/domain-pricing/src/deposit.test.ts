import { describe, expect, it } from "vitest";
import { depositFor, validDepositTerms } from "./deposit.ts";

const DAY = 86_400_000;
const starts = Date.parse("2026-12-20T14:00:00Z");
const quoted = starts - 60 * DAY;

describe("depositFor", () => {
  it("pays in full without deposit terms", () => {
    expect(depositFor({ kind: "none" }, 100_000, starts, quoted)).toBeNull();
  });

  it("takes a fixed deposit, with the balance due whole days before the trip", () => {
    expect(
      depositFor({ kind: "fixed", amount: 25_000, balanceDueDays: 14 }, 100_000, starts, quoted),
    ).toEqual({
      amount: 25_000,
      balanceAmount: 75_000,
      balanceDueAt: "2026-12-06T14:00:00.000Z",
    });
  });

  it("rounds a percentage half up to the cent", () => {
    // 33.33% of $1,000.05 is 33,331.6665 cents, which rounds to 33,332.
    const d = depositFor({ kind: "percent", bp: 3333, balanceDueDays: 7 }, 100_005, starts, quoted);
    expect(d?.amount).toBe(33_332);
    expect(d?.balanceAmount).toBe(100_005 - 33_332);
  });

  it("pays in full when the deposit would be the whole total or more", () => {
    expect(
      depositFor({ kind: "fixed", amount: 50_000, balanceDueDays: 7 }, 50_000, starts, quoted),
    ).toBeNull();
    expect(
      depositFor({ kind: "fixed", amount: 60_000, balanceDueDays: 7 }, 50_000, starts, quoted),
    ).toBeNull();
  });

  it("pays in full when the percentage rounds to nothing", () => {
    expect(
      depositFor({ kind: "percent", bp: 1, balanceDueDays: 7 }, 40, starts, quoted),
    ).toBeNull();
  });

  it("pays in full once the due date has come at the quote instant", () => {
    const terms = { kind: "fixed", amount: 10_000, balanceDueDays: 30 } as const;
    expect(depositFor(terms, 100_000, starts, starts - 30 * DAY)).toBeNull();
    expect(depositFor(terms, 100_000, starts, starts - 30 * DAY - 1)).not.toBeNull();
  });

  it("counts days as 24 hours of elapsed time, across a clock change", () => {
    // US clocks fall back on 2026-11-01; the due instant keeps the trip's UTC hour.
    const trip = Date.parse("2026-11-03T16:00:00Z");
    const d = depositFor({ kind: "fixed", amount: 1_000, balanceDueDays: 5 }, 9_000, trip, 0);
    expect(d?.balanceDueAt).toBe("2026-10-29T16:00:00.000Z");
  });
});

describe("validDepositTerms", () => {
  it("accepts no deposit and well-formed terms", () => {
    expect(validDepositTerms({ kind: "none" })).toBe(true);
    expect(validDepositTerms({ kind: "fixed", amount: 1, balanceDueDays: 1 })).toBe(true);
    expect(validDepositTerms({ kind: "fixed", amount: 10_000_000, balanceDueDays: 365 })).toBe(
      true,
    );
    expect(validDepositTerms({ kind: "percent", bp: 9_999, balanceDueDays: 30 })).toBe(true);
  });

  it("refuses amounts, percentages, and days out of range", () => {
    expect(validDepositTerms({ kind: "fixed", amount: 0, balanceDueDays: 7 })).toBe(false);
    expect(validDepositTerms({ kind: "fixed", amount: 10_000_001, balanceDueDays: 7 })).toBe(false);
    expect(validDepositTerms({ kind: "fixed", amount: 1.5, balanceDueDays: 7 })).toBe(false);
    expect(validDepositTerms({ kind: "percent", bp: 0, balanceDueDays: 7 })).toBe(false);
    expect(validDepositTerms({ kind: "percent", bp: 10_000, balanceDueDays: 7 })).toBe(false);
    expect(validDepositTerms({ kind: "percent", bp: 5_000, balanceDueDays: 0 })).toBe(false);
    expect(validDepositTerms({ kind: "percent", bp: 5_000, balanceDueDays: 366 })).toBe(false);
  });
});
