import { describe, expect, it } from "vitest";
import { ServerClock } from "./clock.ts";

const minute = 60_000;
const local = Date.parse("2026-10-05T16:45:00.000Z");

describe("ServerClock", () => {
  it("uses the device's clock until it learns the server's", () => {
    const clock = new ServerClock();
    expect(clock.offset).toBeNull();
    expect(clock.now(local)).toBe(local);
  });

  it("learns from an instant the server just wrote, against when the answer arrived", () => {
    const clock = new ServerClock();
    // The device runs 45 minutes fast: the server wrote its quote at 16:00.
    clock.learn("2026-10-05T16:00:00.000Z", local);
    expect(clock.offset).toBe(-45 * minute);
    expect(clock.now(local)).toBe(Date.parse("2026-10-05T16:00:00.000Z"));
    expect(clock.now(local + 5 * minute)).toBe(Date.parse("2026-10-05T16:05:00.000Z"));
  });

  it("ignores an instant it cannot read", () => {
    const clock = new ServerClock();
    clock.learn("soon", local);
    expect(clock.offset).toBeNull();
  });

  it("takes an offset kept through a reload, but not one that is not a number", () => {
    const clock = new ServerClock();
    clock.adopt(null);
    clock.adopt(Number.NaN);
    expect(clock.offset).toBeNull();
    clock.adopt(-3 * minute);
    expect(clock.now(local)).toBe(local - 3 * minute);
  });
});
