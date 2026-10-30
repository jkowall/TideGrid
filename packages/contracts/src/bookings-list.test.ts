import { describe, expect, it } from "vitest";
import { BookingDayTrip, BookingListQuery, BookingListResponse } from "./bookings.ts";

/** G2.12e: a day's bookings by source, and the Book rule's inputs on each day trip. */

const date = "2026-11-04";
const trip = {
  tripId: "bc5f3492-d330-487d-8078-7221db331801",
  productName: "Sunset Harbor Cruise",
  productKind: "shared_seat",
  boatName: "Sea Lark",
  timeZone: "America/New_York",
  localDate: date,
  localStartTime: "18:00",
  startsAt: "2026-11-04T23:00:00.000Z",
  salesState: "published",
  bookings: 2,
  guests: 5,
};

describe("the day list's source filter (G2.12e)", () => {
  it.each(["direct", "staff_assisted"])("takes source=%s", (source) => {
    const parsed = BookingListQuery.safeParse({ date, source });
    expect(parsed.success).toBe(true);
    expect(parsed.data?.source).toBe(source);
  });

  it("leaves the source out when none is asked for", () => {
    const parsed = BookingListQuery.parse({ date });
    expect("source" in parsed ? parsed.source : undefined).toBeUndefined();
  });

  it.each([
    ["a source the API does not have", "complimentary"],
    ["an empty value", ""],
    ["another case", "STAFF_ASSISTED"],
    ["two values", ["direct", "staff_assisted"]],
  ])("refuses %s", (_label, source) => {
    expect(BookingListQuery.safeParse({ date, source }).success).toBe(false);
  });

  it("echoes the source the page is filtered to, or null for every source", () => {
    const body = { date, trips: [trip], bookings: [], nextAfter: null };
    expect(BookingListResponse.safeParse({ ...body, source: "staff_assisted" }).success).toBe(true);
    expect(BookingListResponse.safeParse({ ...body, source: null }).success).toBe(true);
    expect(BookingListResponse.safeParse({ ...body, source: "imported" }).success).toBe(false);
    expect(BookingListResponse.shape.source).toBeDefined();
  });
});

describe("the Book rule's inputs on a day trip (G2.12e)", () => {
  it("carries when sales close and whether a blackout covers the trip", () => {
    const parsed = BookingDayTrip.parse({
      ...trip,
      salesCloseAt: "2026-11-04T22:00:00.000Z",
      blackedOut: false,
    });
    expect(parsed).toMatchObject({ salesCloseAt: "2026-11-04T22:00:00.000Z", blackedOut: false });
  });

  it("refuses a close that is not an instant or a blackout that is not a boolean", () => {
    expect(BookingDayTrip.safeParse({ ...trip, salesCloseAt: "x" }).success).toBe(false);
    expect(BookingDayTrip.safeParse({ ...trip, blackedOut: "no" }).success).toBe(false);
  });

  it("keeps both optional, so a trip read before G2.12e still parses", () => {
    expect(BookingDayTrip.safeParse(trip).success).toBe(true);
    expect(BookingDayTrip.shape.salesCloseAt).toBeDefined();
    expect(BookingDayTrip.shape.blackedOut).toBeDefined();
  });
});
