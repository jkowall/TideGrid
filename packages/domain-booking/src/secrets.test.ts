import { describe, expect, it } from "vitest";
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
    expect(a).not.toContain("203");
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
});
