import { describe, expect, it } from "vitest";
import { deliveryEnvironment, providerDeduplicates } from "./delivery.ts";

describe("delivery host rules (G2.14b)", () => {
  it("uses the strict deployed rules when the caller names no environment", () => {
    expect(deliveryEnvironment({})).toBe("production");
    expect(deliveryEnvironment({ environment: "local" })).toBe("local");
    expect(deliveryEnvironment({ environment: "preview" })).toBe("preview");
  });
});

describe("provider deduplication (G2.16a, review note S2)", () => {
  it("treats a provider as deduplicating only when it says so, so a new one fails safe", () => {
    expect(providerDeduplicates({ deduplicates: true })).toBe(true);
    expect(providerDeduplicates({ deduplicates: false })).toBe(false);
    expect(providerDeduplicates({})).toBe(false);
  });
});
