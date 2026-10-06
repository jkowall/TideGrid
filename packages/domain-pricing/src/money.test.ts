import { describe, expect, it } from "vitest";
import { allocateLargestRemainder, mulDivHalfUp } from "./money.ts";

describe("mulDivHalfUp", () => {
  it("rounds half up and everything else to the nearest cent", () => {
    expect(mulDivHalfUp(1010, 50_000, 1_000_000)).toBe(51); // 50.5
    expect(mulDivHalfUp(1030, 50_000, 1_000_000)).toBe(52); // 51.5
    expect(mulDivHalfUp(1009, 50_000, 1_000_000)).toBe(50); // 50.45
    expect(mulDivHalfUp(199, 70_000, 1_000_000)).toBe(14); // 13.93
    expect(mulDivHalfUp(4, 100_000, 1_000_000)).toBe(0); // 0.4
    expect(mulDivHalfUp(5, 100_000, 1_000_000)).toBe(1); // 0.5
    expect(mulDivHalfUp(0, 70_000, 1_000_000)).toBe(0);
    expect(mulDivHalfUp(4500, 1250, 10_000)).toBe(563); // 562.5
  });

  it("stays exact where floating point would not", () => {
    // 0.1 + 0.2 style drift: 2^53 - 1 times one millionth, then back.
    expect(mulDivHalfUp(9_007_199_254, 1_000_000, 1_000_000)).toBe(9_007_199_254);
    expect(mulDivHalfUp(100_000_000, 499_999, 1_000_000)).toBe(49_999_900);
    expect(mulDivHalfUp(33_000, 1_000_000, 1_047_120)).toBe(31_515);
  });

  it("refuses negative, fractional, or unsafe inputs and a zero denominator", () => {
    expect(() => mulDivHalfUp(-1, 1, 1)).toThrow(RangeError);
    expect(() => mulDivHalfUp(1.5, 1, 1)).toThrow(RangeError);
    expect(() => mulDivHalfUp(1, 1, 0)).toThrow(RangeError);
    expect(() => mulDivHalfUp(Number.MAX_SAFE_INTEGER + 1, 1, 1)).toThrow(RangeError);
    expect(() => mulDivHalfUp(Number.MAX_SAFE_INTEGER, 4, 1)).toThrow(RangeError);
  });
});

describe("allocateLargestRemainder", () => {
  it("sums to the total exactly and follows the weights", () => {
    expect(allocateLargestRemainder(1150, [9000, 2500])).toEqual([900, 250]);
    expect(allocateLargestRemainder(2500, [9000, 2500])).toEqual([1957, 543]);
    expect(allocateLargestRemainder(654, [60_000, 10_000])).toEqual([561, 93]);
  });

  it("gives tied remainders to the earlier weight", () => {
    expect(allocateLargestRemainder(1, [1, 1])).toEqual([1, 0]);
    expect(allocateLargestRemainder(2, [1, 1, 1])).toEqual([1, 1, 0]);
    expect(allocateLargestRemainder(5, [3, 3])).toEqual([3, 2]);
  });

  it("never gives a share to a zero weight", () => {
    expect(allocateLargestRemainder(7, [0, 3, 0, 4])).toEqual([0, 3, 0, 4]);
    expect(allocateLargestRemainder(3, [0, 1, 1, 0])).toEqual([0, 2, 1, 0]);
    expect(allocateLargestRemainder(0, [0, 0])).toEqual([0, 0]);
    expect(allocateLargestRemainder(0, [])).toEqual([]);
  });

  it("never exceeds a weight when the total is at most their sum", () => {
    for (let total = 0; total <= 60; total++) {
      const weights = [7, 0, 13, 1, 40];
      const parts = allocateLargestRemainder(total, weights);
      expect(parts.reduce((a, b) => a + b, 0)).toBe(total);
      parts.forEach((p, i) => {
        expect(p).toBeLessThanOrEqual(weights[i] ?? 0);
        expect(p).toBeGreaterThanOrEqual(0);
      });
    }
  });

  it("refuses to spread a non-zero total over nothing", () => {
    expect(() => allocateLargestRemainder(1, [0, 0])).toThrow(RangeError);
    expect(() => allocateLargestRemainder(1, [])).toThrow(RangeError);
    expect(() => allocateLargestRemainder(-1, [1])).toThrow(RangeError);
  });
});
