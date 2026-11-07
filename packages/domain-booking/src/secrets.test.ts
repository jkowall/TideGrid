import {
  bookingReferencePattern as contractPattern,
  isNumberShapedReference,
} from "@tidegrid/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  bookingReferencePattern,
  clientKeyFor,
  hashCheckoutSecret,
  newBookingReference,
} from "./secrets.ts";

const secret = "a".repeat(43);

describe("checkout secrets", () => {
  it("hashes a well-formed secret the same way every time, and nothing else", async () => {
    const hash = await hashCheckoutSecret(secret);
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
    expect(await hashCheckoutSecret(secret)).toBe(hash);
    expect(await hashCheckoutSecret(`${"a".repeat(42)}b`)).not.toBe(hash);
    for (const bad of [
      "",
      "a".repeat(42),
      "a".repeat(44),
      `${"a".repeat(42)}+`,
      `${"a".repeat(42)}=`,
    ]) {
      await expect(hashCheckoutSecret(bad)).rejects.toThrow(TypeError);
    }
  });

  it("keys the per-client limit by tenant and address without storing the address", async () => {
    const a = await clientKeyFor("t1", "203.0.113.7");
    expect(a).toMatch(/^[0-9a-f]{64}$/);
    expect(a).not.toContain("203.0.113.7");
    expect(await clientKeyFor("t2", "203.0.113.7")).not.toBe(a);
    expect(await clientKeyFor("t1", "203.0.113.8")).not.toBe(a);
  });
});

describe("booking references", () => {
  it("are eight Crockford characters, never I, L, O, or U", () => {
    const seen = new Set<string>();
    for (let i = 0; i < 2000; i++) {
      const ref = newBookingReference();
      expect(ref).toMatch(bookingReferencePattern);
      expect(ref).not.toMatch(/[ILOU]/);
      seen.add(ref);
    }
    expect(seen.size).toBe(2000);
  });

  afterEach(() => vi.restoreAllMocks());

  it("draws again, deterministically, when a draw is number-shaped", () => {
    // Bytes index the 32-character alphabet: 0 to 9 are digits, 14 is E, 10 to 17 are A to H.
    const draws = [
      [0, 1, 2, 3, 4, 5, 6, 7], // 01234567: digits only
      [1, 2, 3, 4, 5, 14, 6, 7], // 12345E67: scientific notation
      [10, 11, 12, 13, 14, 15, 16, 17], // ABCDEFGH
    ];
    const spy = vi
      .spyOn(crypto, "getRandomValues")
      .mockImplementation(<T extends ArrayBufferView | null>(array: T): T => {
        const next = draws.shift();
        if (!next || !(array instanceof Uint8Array)) throw new Error("unexpected draw");
        array.set(next);
        return array;
      });
    expect(newBookingReference()).toBe("ABCDEFGH");
    expect(spy).toHaveBeenCalledTimes(3);
  });

  it("are never ones a spreadsheet would read as a number", () => {
    expect(contractPattern.source).toBe(bookingReferencePattern.source);
    for (let i = 0; i < 10_000; i++) {
      expect(isNumberShapedReference(newBookingReference())).toBe(false);
    }
  });
});
