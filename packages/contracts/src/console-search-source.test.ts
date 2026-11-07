import { describe, expect, it } from "vitest";
import { BookingSearchRequest, BookingSearchResponse } from "./console.ts";

/** Search by source (G2.12): a source narrows a search and is echoed in the answer. */

describe("the search request's source", () => {
  it.each(["direct", "staff_assisted"])("takes source %s alongside q", (source) => {
    const parsed = BookingSearchRequest.safeParse({ q: "maya", source });
    expect(parsed.success).toBe(true);
    expect(parsed.data?.source).toBe(source);
  });

  it("takes a source with dates only", () => {
    expect(BookingSearchRequest.safeParse({ from: "2026-11-01", source: "direct" }).success).toBe(
      true,
    );
  });

  it("leaves the source out when none is given", () => {
    const parsed = BookingSearchRequest.parse({ q: "maya" });
    expect("source" in parsed).toBe(false);
  });

  it.each([
    ["complimentary", "complimentary"],
    ["an empty string", ""],
    ["a different case", "STAFF_ASSISTED"],
    ["an array", ["direct"]],
    ["null", null],
  ])("refuses %s as the source", (_what, source) => {
    expect(BookingSearchRequest.safeParse({ q: "maya", source }).success).toBe(false);
  });

  it("does not take a source as a search on its own", () => {
    expect(BookingSearchRequest.safeParse({ source: "direct" }).success).toBe(false);
    expect(BookingSearchRequest.safeParse({ source: "staff_assisted" }).success).toBe(false);
  });
});

describe("the search response's source echo", () => {
  const body = { results: [], total: 0, nextAfter: null, matchedOn: [] };

  it.each([null, "direct", "staff_assisted"])("takes source %s", (source) => {
    expect(BookingSearchResponse.safeParse({ ...body, source }).success).toBe(true);
  });

  it("refuses a source it does not know, and a missing one", () => {
    expect(BookingSearchResponse.safeParse({ ...body, source: "imported" }).success).toBe(false);
    expect(BookingSearchResponse.safeParse(body).success).toBe(false);
  });
});
