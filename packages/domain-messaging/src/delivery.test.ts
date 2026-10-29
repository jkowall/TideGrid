import { describe, expect, it } from "vitest";
import {
  DEADLINE_MARGIN_MS,
  deliveryEnvironment,
  providerDeduplicates,
  sweepWindow,
} from "./delivery.ts";

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

// D9 B (pre-pilot hardening, Part C): turns start only while a claim can fit.
describe("the email sweep's window", () => {
  it("starts turns only while a claim, with its send bound and margin, fits before the deadline", () => {
    // The cron's case: a 20 s budget and a 10 s send bound leave 8 s for turns.
    expect(sweepWindow({ started: 1_000, budgetMs: 20_000, sendTimeoutMs: 10_000 })).toEqual({
      deadline: 21_000,
      budgetMs: 20_000 - 10_000 - DEADLINE_MARGIN_MS,
    });
    // A provider without a bound reserves the margin only.
    expect(sweepWindow({ started: 0, budgetMs: 20_000 })).toEqual({
      deadline: 20_000,
      budgetMs: 20_000 - DEADLINE_MARGIN_MS,
    });
  });

  it("takes the caller's deadline when it is earlier, and never a negative window", () => {
    expect(
      sweepWindow({ started: 0, budgetMs: 20_000, deadline: 15_000, sendTimeoutMs: 1_000 }),
    ).toEqual({ deadline: 15_000, budgetMs: 15_000 - 1_000 - DEADLINE_MARGIN_MS });
    // No room for one send: no turn starts, so no tenant is stamped or counted.
    expect(sweepWindow({ started: 0, budgetMs: 5_000, sendTimeoutMs: 10_000 })).toEqual({
      deadline: 5_000,
      budgetMs: 0,
    });
  });
});
