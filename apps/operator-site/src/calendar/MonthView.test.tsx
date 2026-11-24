// @vitest-environment jsdom

// Staff in Tokyo looking at a New York marina: dates must stay New York's.
process.env.TZ = "Asia/Tokyo";

import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { Membership, StaffTrip } from "@tidegrid/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CalendarView } from "./CalendarView.tsx";
import { addMonths, monthBounds, monthSeats, monthTone, monthWeeks, readMonth } from "./model.ts";

const harbor = "7d1e5b3a-1c2f-4a8e-9b61-0a1c2e3f4a01";
const membership: Membership = {
  tenantId: harbor,
  tenantSlug: "demo-harbor",
  tenantName: "Demo Harbor Charters",
  role: "owner",
};

let n = 0;
/** A 6:00 PM New York sunset cruise on a November date (EST). */
function sunsetOn(day: number, fields: Partial<StaffTrip> = {}): StaffTrip {
  n += 1;
  const d = String(day).padStart(2, "0");
  const next = String(day + 1).padStart(2, "0");
  return {
    tripId: `bc5f3492-d330-487d-8078-7221db3318${String(n).padStart(2, "0")}`,
    timeZone: "America/New_York",
    durationMinutes: 90,
    productId: "4f51db31-f9aa-492a-ad2b-05d7c1c3cb2a",
    productName: "Sunset Harbor Cruise",
    productKind: "shared_seat",
    boatId: "9a0e7c55-3b1d-4f2a-8c6e-1d2f3a4b5c01",
    boatName: "Sea Lark",
    scheduleId: null,
    salesState: "published",
    salesStateChangedAt: "2026-09-30T12:00:00.000Z",
    blackedOut: false,
    localDate: `2026-11-${d}`,
    localStartTime: "18:00",
    startsAt: `2026-11-${d}T23:00:00.000Z`,
    endsAt: `2026-11-${next}T00:30:00.000Z`,
    startsAtLocal: `2026-11-${d}T18:00:00-05:00`,
    endsAtLocal: `2026-11-${d}T19:30:00-05:00`,
    salesCloseAt: `2026-11-${d}T22:00:00.000Z`,
    capacity: { kind: "seats", total: 20, remaining: 7, held: 0, confirmed: 13, soldOut: false },
    ...fields,
  };
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const catalog = () =>
  json({
    locations: [
      {
        id: "0f2c7a10-1b2c-4d3e-8f40-5a6b7c8d9e01",
        name: "Harbor Marina, Dock C",
        timeZone: "America/New_York",
        meetingPoint: "Dock C, slip 14",
        status: "active",
      },
    ],
    boats: [],
    products: [],
    schedules: [],
  });

/** Answers the catalog always, and trips requests in order; records each trips query. */
function api(...trips: Array<() => Response>) {
  const queries: URLSearchParams[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(String(input), "http://localhost:5184");
      if (url.pathname.endsWith("/catalog")) return catalog();
      if (url.pathname === `/api/v1/staff/tenants/${harbor}/trips`) {
        queries.push(url.searchParams);
        const answer = trips.shift();
        if (!answer) throw new Error("no answer left");
        return answer();
      }
      throw new Error(`unexpected request ${url}`);
    }),
  );
  return queries;
}

const text = (element: Element | null) => (element?.textContent ?? "").replace(/\s+/g, " ").trim();

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  // Noon on Wednesday, Nov 4, in New York.
  vi.setSystemTime(new Date("2026-11-04T17:00:00Z"));
  window.history.replaceState(null, "", "/calendar?view=month");
  n = 0;
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("the month view", () => {
  it("asks for the whole grid and shows each trip as a tag with its seats and state", async () => {
    const queries = api(() =>
      json({
        trips: [
          sunsetOn(10),
          sunsetOn(11, {
            capacity: { kind: "seats", total: 20, remaining: 0, confirmed: 20, soldOut: true },
          }),
          sunsetOn(12, { salesState: "closed" }),
          sunsetOn(3, { salesState: "completed" }),
        ],
      }),
    );
    render(<CalendarView membership={membership} focusHeading={false} />);

    const month = await screen.findByRole("table", { name: "Trips in November 2026" });
    // Nov 2026 starts on a Sunday and ends on a Monday: Nov 1 to Dec 5.
    expect(queries[0]?.get("from")).toBe("2026-11-01");
    expect(queries[0]?.get("to")).toBe("2026-12-05");

    // Role queries over a whole month are slow in jsdom: allow a cold run time.
    const tag = await within(month).findByRole(
      "link",
      { name: /^6:00\sPM, Sunset Harbor Cruise, Sea Lark: on sale, 13 of 20 seats booked/ },
      { timeout: 5000 },
    );
    expect(tag.getAttribute("href")).toMatch(/^\/bookings\?day=2026-11-10&trip=bc5f3492-/);
    expect(text(tag)).toContain("6p");
    expect(text(tag)).toContain("13/20");
    expect(tag.className).toContain("cal-month__tag--on-sale");
    expect(
      within(month).getByRole("link", { name: /Sunset Harbor Cruise, Sea Lark: sold out/ }),
    ).toBeTruthy();
    expect(
      within(month).getByRole("link", { name: /Sunset Harbor Cruise, Sea Lark: not selling/ }),
    ).toBeTruthy();
    expect(
      within(month).getByRole("link", { name: /Sunset Harbor Cruise, Sea Lark: departed/ }),
    ).toBeTruthy();
    expect(screen.getByRole("status").textContent).toBe("4 trips in November 2026.");
    expect(
      within(month).getByRole("button", { name: /^Wednesday, November 4, today, no trips/ }),
    ).toBeTruthy();
    expect(screen.getByRole("button", { name: "Month" }).getAttribute("aria-pressed")).toBe("true");
  });

  it("moves a month at a time and keeps the month in the address", async () => {
    const queries = api(
      () => json({ trips: [] }),
      () => json({ trips: [] }),
    );
    render(<CalendarView membership={membership} focusHeading={false} />);
    await screen.findByRole("heading", { name: "No trips in November 2026" });
    fireEvent.click(screen.getByRole("button", { name: /Next/ }));
    await screen.findByRole("heading", { name: "No trips in December 2026" });
    // December's grid: Sunday Nov 29 to Saturday Jan 2.
    expect(queries[1]?.get("from")).toBe("2026-11-29");
    expect(queries[1]?.get("to")).toBe("2027-01-02");
    expect(window.location.search).toBe("?view=month&month=2026-12");
    fireEvent.click(screen.getByRole("button", { name: "Go to this month" }));
    await waitFor(() => expect(window.location.search).toBe("?view=month"));
  });

  it("opens a date's week in the week view, and the week returns to its month", async () => {
    api(
      () => json({ trips: [sunsetOn(18)] }),
      () => json({ trips: [sunsetOn(18)] }),
      () => json({ trips: [sunsetOn(18)] }),
    );
    render(<CalendarView membership={membership} focusHeading={false} />);
    const month = await screen.findByRole("table", { name: "Trips in November 2026" });
    fireEvent.click(
      await within(month).findByRole("button", { name: /^Wednesday, November 18, 1 trip/ }),
    );

    // The week of Nov 15 to 21, with Nov 18 taking focus once it loads.
    const day = await screen.findByRole("heading", { name: /^Wednesday, November 18/ });
    await waitFor(() => expect(document.activeElement).toBe(day));
    expect(window.location.search).toBe("?week=2026-11-15");
    expect(screen.getByRole("button", { name: "Week" }).getAttribute("aria-pressed")).toBe("true");

    fireEvent.click(screen.getByRole("button", { name: "Month" }));
    await screen.findByRole("table", { name: "Trips in November 2026" });
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Month" }));
  });

  it("says when trips can't load, and tries again", async () => {
    api(
      () => json({ error: { code: "internal", message: "x", requestId: "r" } }, 500),
      () => json({ trips: [sunsetOn(10)] }),
    );
    render(<CalendarView membership={membership} focusHeading={false} />);
    fireEvent.click(await screen.findByRole("button", { name: "Try again" }));
    expect(await screen.findByRole("table", { name: "Trips in November 2026" })).toBeTruthy();
    await waitFor(() =>
      expect(document.activeElement).toBe(screen.getByRole("heading", { name: "November 2026" })),
    );
  });

  it("returns to the month a date was picked in, even when its week starts the month before", async () => {
    window.history.replaceState(null, "", "/calendar?view=month&month=2026-12");
    api(
      () => json({ trips: [] }),
      () => json({ trips: [] }),
      () => json({ trips: [] }),
    );
    render(<CalendarView membership={membership} focusHeading={false} />);
    const month = await screen.findByRole("table", { name: "Trips in December 2026" });
    fireEvent.click(
      await within(month).findByRole("button", { name: /^Thursday, December 3, no trips/ }),
    );
    // The week of Nov 29 to Dec 5 has no trips: its dates take focus.
    await screen.findByRole("heading", { name: "No trips this week" });
    await waitFor(() =>
      expect(document.activeElement).toBe(
        screen.getByRole("heading", { name: /^Nov 29 to Dec 5/ }),
      ),
    );
    fireEvent.click(screen.getByRole("button", { name: "Month" }));
    expect(await screen.findByRole("table", { name: "Trips in December 2026" })).toBeTruthy();
    expect(window.location.search).toBe("?view=month&month=2026-12");
  });

  it("opens the month's first week when Week is pressed in another month", async () => {
    window.history.replaceState(null, "", "/calendar?view=month&month=2027-03&source=direct");
    api(
      () => json({ trips: [] }),
      () => json({ trips: [] }),
    );
    render(<CalendarView membership={membership} focusHeading={false} />);
    await screen.findByRole("heading", { name: "No trips in March 2027" });
    fireEvent.click(screen.getByRole("button", { name: "Week" }));
    await screen.findByRole("heading", { name: "No trips this week" });
    expect(window.location.search).toBe("?source=direct&week=2027-02-28");
  });
});

describe("month rules", () => {
  it("lays a month out in whole weeks, with neighboring dates filling them", () => {
    const weeks = monthWeeks("2026-11-01");
    expect(weeks).toHaveLength(5);
    expect(weeks[0]?.[0]).toBe("2026-11-01");
    expect(weeks[4]?.[6]).toBe("2026-12-05");
    expect(monthWeeks("2026-08-01")).toHaveLength(6);
    expect(monthWeeks("2026-08-01")[0]?.[0]).toBe("2026-07-26");
  });

  it("reaches about two years each way and reads the address", () => {
    const { first, last } = monthBounds("2026-11-04");
    expect(first >= "2024-11-01" && first <= "2024-12-01").toBe(true);
    expect(last >= "2028-10-01" && last <= "2028-11-01").toBe(true);
    expect(readMonth("?month=2027-02", "2026-11-04")).toBe("2027-02-01");
    expect(readMonth("?month=2040-02", "2026-11-04")).toBe(last);
    expect(readMonth("?month=oops", "2026-11-04")).toBe("2026-11-01");
    expect(addMonths("2026-12-01", 1)).toBe("2027-01-01");
  });

  it("reads a trip's state and seats at a glance", () => {
    const now = new Date("2026-11-04T17:00:00Z");
    expect(monthTone(sunsetOn(10), now)).toBe("on-sale");
    expect(monthTone(sunsetOn(10, { salesState: "draft" }), now)).toBe("draft");
    expect(monthTone(sunsetOn(10, { salesState: "canceled" }), now)).toBe("canceled");
    expect(monthTone(sunsetOn(10, { blackedOut: true }), now)).toBe("closed");
    expect(monthTone(sunsetOn(3), now)).toBe("done");
    expect(monthSeats(sunsetOn(10))).toEqual({ short: "13/20", long: "13 of 20 seats booked" });
    const booked = sunsetOn(10, {
      capacity: { kind: "whole_boat", total: 12, remaining: 0, confirmed: 12, held: 0 },
    });
    expect(monthTone(booked, now)).toBe("sold-out");
    expect(monthSeats(booked, "sold-out")).toEqual({ short: "Booked", long: "whole boat booked" });
    // A checkout holding the boat may still let go: held, not booked.
    const held = sunsetOn(10, {
      capacity: { kind: "whole_boat", total: 12, remaining: 0, confirmed: 0, held: 12 },
    });
    expect(monthTone(held, now)).toBe("held");
    expect(monthSeats(held, "held")).toEqual({ short: "Held", long: "whole boat held" });
    // Past its booking cutoff but not yet departed: not selling.
    expect(monthTone(sunsetOn(4), new Date("2026-11-04T22:30:00Z"))).toBe("closed");
    expect(monthSeats(sunsetOn(4), "closed").short).toBe("Closed");
  });
});
