import { describe, expect, it } from "vitest";
import { formatBasisPoints, formatMoney, formatRatePpm, formatTimeLeft } from "./index.ts";

describe("money", () => {
  it("formats integer cents as dollars with grouping", () => {
    expect(formatMoney(0)).toBe("$0.00");
    expect(formatMoney(5)).toBe("$0.05");
    expect(formatMoney(250)).toBe("$2.50");
    expect(formatMoney(4500)).toBe("$45.00");
    expect(formatMoney(120_000)).toBe("$1,200.00");
    expect(formatMoney(123_456_789)).toBe("$1,234,567.89");
    expect(formatMoney(100_000_000)).toBe("$1,000,000.00");
  });

  it("marks a negative amount with a real minus sign", () => {
    expect(formatMoney(-1150)).toBe("−$11.50");
    expect(formatMoney(-1150).codePointAt(0)).toBe(0x2212);
    expect(formatMoney(-0)).toBe("$0.00");
  });

  it("keeps every cent, even where a float would drift", () => {
    // 0.1 + 0.2 style drift: 1005 cents is $10.05 exactly, not $10.04.
    expect(formatMoney(1005)).toBe("$10.05");
    expect(formatMoney(Number.MAX_SAFE_INTEGER)).toBe("$90,071,992,547,409.91");
  });

  it("refuses anything that is not integer cents", () => {
    for (const bad of [12.5, Number.NaN, Number.POSITIVE_INFINITY, 2 ** 53]) {
      expect(() => formatMoney(bad)).toThrow(RangeError);
    }
    expect(() => formatMoney(100, "EUR" as "USD")).toThrow(RangeError);
  });
});

describe("rates", () => {
  it("reads parts per million as a percentage, trimming zeros", () => {
    expect(formatRatePpm(60_000)).toBe("6%");
    expect(formatRatePpm(10_000)).toBe("1%");
    expect(formatRatePpm(47_120)).toBe("4.712%");
    expect(formatRatePpm(70_500)).toBe("7.05%");
    expect(formatRatePpm(1)).toBe("0.0001%");
  });

  it("reads basis points as a percentage", () => {
    expect(formatBasisPoints(1000)).toBe("10%");
    expect(formatBasisPoints(5000)).toBe("50%");
    expect(formatBasisPoints(1250)).toBe("12.5%");
    expect(formatBasisPoints(5)).toBe("0.05%");
  });

  it("refuses fractions and negatives", () => {
    expect(() => formatRatePpm(1.5)).toThrow(RangeError);
    expect(() => formatBasisPoints(-100)).toThrow(RangeError);
  });
});

describe("time left", () => {
  it("rounds down and never promises more time than there is", () => {
    expect(formatTimeLeft(0)).toBe("no time");
    expect(formatTimeLeft(-5000)).toBe("no time");
    expect(formatTimeLeft(59_999)).toBe("less than a minute");
    expect(formatTimeLeft(60_000)).toBe("about 1 minute");
    expect(formatTimeLeft(14 * 60_000 + 59_000)).toBe("about 14 minutes");
    expect(formatTimeLeft(30 * 60_000)).toBe("about 30 minutes");
    expect(formatTimeLeft(125 * 60_000)).toBe("about 2 hours");
  });
});
