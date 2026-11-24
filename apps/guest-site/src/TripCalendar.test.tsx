// @vitest-environment jsdom

// The guest is in Tokyo and the marina in New York, as in UpcomingTrips.test:
// the calendar must group by the marina's dates, never the viewer's.
process.env.TZ = "Asia/Tokyo";

import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { AvailableTrip } from "@tidegrid/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TripCalendar } from "./TripCalendar.tsx";
import { TripsSection } from "./TripsSection.tsx";
import {
  addMonths,
  monthGrid,
  monthWindow,
  readCalendarQuery,
  readView,
  summarizeDays,
  writeCalendarQuery,
} from "./trips.ts";

const location = { name: "Harbor Marina, Dock C", meetingPoint: "Dock C, slip 14" };
const sunset = {
  id: "4f51db31-f9aa-492a-ad2b-05d7c1c3cb2a",
  name: "Sunset Harbor Cruise",
  kind: "shared_seat" as const,
  summary: "Ninety minutes along the harbor at golden hour.",
  minPartySize: 1,
  maxPartySize: 10,
};

/** A 6:00 PM New York sunset trip on an October or November date (EDT before Nov 1). */
function sunsetOn(n: number, date: string, remaining = 20): AvailableTrip {
  const edt = date < "2026-11-01";
  const offset = edt ? "-04:00" : "-05:00";
  const startsAt = new Date(`${date}T18:00:00${offset}`);
  const endsAt = new Date(startsAt.getTime() + 90 * 60_000);
  const local = (d: Date) => {
    const shifted = new Date(d.getTime() + (edt ? -4 : -5) * 3_600_000);
    return `${shifted.toISOString().slice(0, 19)}${offset}`;
  };
  return {
    tripId: `bc5f3492-d330-487d-8078-7221db3316${String(n).padStart(2, "0")}`,
    timeZone: "America/New_York",
    location,
    localDate: date,
    localStartTime: "18:00",
    startsAt: startsAt.toISOString(),
    endsAt: endsAt.toISOString(),
    startsAtLocal: local(startsAt),
    endsAtLocal: local(endsAt),
    durationMinutes: 90,
    salesCloseAt: new Date(startsAt.getTime() - 3_600_000).toISOString(),
    product: sunset,
    capacity: { kind: "seats", total: 20, remaining },
  };
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

function tripsApi(...answers: Array<() => Response | Promise<Response>>) {
  const queries: URLSearchParams[] = [];
  const fetch = vi.fn(async (input: RequestInfo | URL) => {
    const url = new URL(String(input));
    if (url.pathname !== "/v1/public/trips") throw new Error(`unexpected request ${url}`);
    queries.push(url.searchParams);
    const answer = answers.shift();
    if (!answer) throw new Error("no answer left");
    return answer();
  });
  vi.stubGlobal("fetch", fetch);
  return queries;
}

const text = (element: Element | null) => (element?.textContent ?? "").replace(/\s+/g, " ").trim();

beforeEach(() => {
  // 12:00 noon in New York on Oct 5; already 01:00 on Oct 6 in Tokyo.
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-10-05T16:00:00Z"));
  window.history.replaceState(null, "", "/");
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("the trip calendar", () => {
  it("asks for the month, picks the first open date, and shows that day's trips", async () => {
    const queries = tripsApi(() =>
      json({
        trips: [sunsetOn(1, "2026-10-09"), sunsetOn(2, "2026-10-10", 3), sunsetOn(3, "2026-10-10")],
      }),
    );
    render(<TripCalendar />);

    const month = await screen.findByRole("table", { name: /October 2026/ });
    // The guest's today is Oct 6, so the month asks from the marina's Oct 5.
    expect(queries[0]?.get("from")).toBe("2026-10-05");
    expect(queries[0]?.get("to")).toBe("2026-10-31");
    expect(queries[0]?.get("party")).toBe("1");

    // Only dates with trips are buttons, each saying what it holds.
    const dates = within(month).getAllByRole("button");
    expect(dates.map((b) => b.getAttribute("aria-pressed"))).toEqual(["true", "false"]);
    expect(text(dates[0] ?? null)).toContain("Friday, October 9, 1 trip");
    expect(text(dates[1] ?? null)).toContain("Saturday, October 10, 2 trips, few seats left");
    expect(within(month).queryByRole("button", { name: /October 8/ })).toBeNull();

    // The first open date is shown until the guest picks, and stays out of the address.
    expect(
      await screen.findByRole("heading", { level: 3, name: "Friday, October 9" }),
    ).toBeTruthy();
    expect(window.location.search).toBe("");

    fireEvent.click(dates[1] as HTMLElement);
    const day = await screen.findByRole("region", { name: "Saturday, October 10" });
    expect(within(day).getAllByRole("link", { name: /^Book Sunset Harbor Cruise/ })).toHaveLength(
      2,
    );
    expect(dates[1]?.getAttribute("aria-pressed")).toBe("true");
    expect(window.location.search).toBe("?date=2026-10-10");
    expect(screen.getByRole("status").textContent).toBe("Saturday, October 10: 2 trips.");
  });

  it("moves between months within the year ahead, and offers the next month when one is empty", async () => {
    const queries = tripsApi(
      () => json({ trips: [] }),
      () => json({ trips: [sunsetOn(4, "2026-11-03")] }),
    );
    // A month asked for in the address stays, even when empty.
    window.history.replaceState(null, "", "/?month=2026-10");
    render(<TripCalendar />);
    expect(await screen.findByRole("heading", { name: "Nothing open in October" })).toBeTruthy();
    const previous = screen.getByRole("button", { name: /^Previous month/ });
    expect(previous.getAttribute("aria-disabled")).toBe("true");

    fireEvent.click(screen.getByRole("button", { name: "Try November" }));
    expect(await screen.findByRole("table", { name: /November 2026/ })).toBeTruthy();
    expect(queries[1]?.get("from")).toBe("2026-11-01");
    expect(queries[1]?.get("to")).toBe("2026-11-30");
    expect(
      await screen.findByRole("heading", { level: 3, name: "Tuesday, November 3" }),
    ).toBeTruthy();
    expect(window.location.search).toBe("?month=2026-11");
    await waitFor(() =>
      expect(document.activeElement).toBe(screen.getByRole("heading", { name: "November 2026" })),
    );
  });

  it("opens the date and party in the address, and asks again for a new party", async () => {
    window.history.replaceState(null, "", "/?date=2026-11-03&party=3");
    const queries = tripsApi(
      () => json({ trips: [sunsetOn(4, "2026-11-03"), sunsetOn(5, "2026-11-04")] }),
      () => json({ trips: [sunsetOn(5, "2026-11-04")] }),
    );
    render(<TripCalendar />);
    expect(
      await screen.findByRole("heading", { level: 3, name: "Tuesday, November 3" }),
    ).toBeTruthy();
    expect(queries[0]?.get("party")).toBe("3");
    const book = screen.getByRole("link", { name: /^Book Sunset Harbor Cruise/ });
    expect(book.getAttribute("href")).toContain("party=3");

    // Nov 3 has nothing for 6 guests: the first open date shows instead.
    fireEvent.change(screen.getByRole("combobox", { name: "Party size" }), {
      target: { value: "6" },
    });
    expect(
      await screen.findByRole("heading", { level: 3, name: "Wednesday, November 4" }),
    ).toBeTruthy();
    expect(queries[1]?.get("party")).toBe("6");
  });

  it("says when trips can't load, and tries again", async () => {
    tripsApi(
      () => json({ error: { code: "internal" } }, 500),
      () => json({ trips: [sunsetOn(1, "2026-10-09")] }),
    );
    render(<TripCalendar />);
    // The month's own controls stay while it is failed.
    expect(await screen.findByRole("button", { name: "Try again" })).toBeTruthy();
    expect(screen.getByRole("button", { name: /^Next month/ })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(
      await screen.findByRole("heading", { level: 3, name: "Friday, October 9" }),
    ).toBeTruthy();
    await waitFor(() =>
      expect(document.activeElement).toBe(screen.getByRole("heading", { name: "October 2026" })),
    );
  });

  it("opens the next month by itself when this one has nothing left", async () => {
    const queries = tripsApi(
      () => json({ trips: [] }),
      () => json({ trips: [sunsetOn(4, "2026-11-03")] }),
    );
    render(<TripCalendar />);
    expect(
      await screen.findByRole("heading", { level: 3, name: "Tuesday, November 3" }),
    ).toBeTruthy();
    expect(queries).toHaveLength(2);
    expect(queries[1]?.get("from")).toBe("2026-11-01");
  });

  it("shows the marina's today to a guest whose month has already turned", async () => {
    // 01:00 on Dec 1 in Tokyo; 11:00 on Nov 30 in New York.
    vi.setSystemTime(new Date("2026-11-30T16:00:00Z"));
    const queries = tripsApi(() =>
      json({ trips: [sunsetOn(1, "2026-11-30"), sunsetOn(2, "2026-12-03")] }),
    );
    render(<TripCalendar />);
    const month = await screen.findByRole("table", { name: /December 2026/ });
    expect(queries[0]?.get("from")).toBe("2026-11-30");
    // Nov 30 is shown in December's first week, and picked first.
    expect(
      await within(month).findByRole("button", { name: /^Monday, November 30, 1 trip/ }),
    ).toBeTruthy();
    expect(
      await screen.findByRole("heading", { level: 3, name: /Monday, November 30$/ }),
    ).toBeTruthy();
  });

  it("adds the week before when the marina's today falls in it", async () => {
    // 01:00 on Sunday, Nov 1 in Tokyo; noon on Saturday, Oct 31 in New York.
    vi.setSystemTime(new Date("2026-10-31T16:00:00Z"));
    tripsApi(() => json({ trips: [sunsetOn(1, "2026-10-31"), sunsetOn(2, "2026-11-03")] }));
    render(<TripCalendar />);
    const month = await screen.findByRole("table", { name: /November 2026/ });
    const oct31 = await within(month).findByRole("button", {
      name: /^Saturday, October 31, 1 trip/,
    });
    fireEvent.click(within(month).getByRole("button", { name: /^Tuesday, November 3/ }));
    fireEvent.click(oct31);
    expect(
      await screen.findByRole("heading", { level: 3, name: /Saturday, October 31$/ }),
    ).toBeTruthy();
  });

  it("keeps the day's trips while another party loads, and drops a date with nothing for it", async () => {
    window.history.replaceState(null, "", "/?date=2026-10-10");
    let release: (res: Response) => void = () => {};
    tripsApi(
      () => json({ trips: [sunsetOn(1, "2026-10-09"), sunsetOn(2, "2026-10-10", 3)] }),
      () =>
        new Promise<Response>((resolve) => {
          release = resolve;
        }),
    );
    render(<TripCalendar />);
    await screen.findByRole("heading", { level: 3, name: "Saturday, October 10" });
    fireEvent.change(screen.getByRole("combobox", { name: "Party size" }), {
      target: { value: "8" },
    });
    // While 8 guests load, the day stays, its Book link still for the party it was loaded for.
    expect(await screen.findByText("Updating for 8 guests…")).toBeTruthy();
    const book = screen.getByRole("link", { name: /^Book Sunset Harbor Cruise/ });
    expect(book.getAttribute("href")).not.toContain("party=8");
    release(json({ trips: [sunsetOn(1, "2026-10-09")] }));
    expect(
      await screen.findByRole("heading", { level: 3, name: "Friday, October 9" }),
    ).toBeTruthy();
    await waitFor(() => expect(window.location.search).toBe("?party=8"));
    expect(screen.getByRole("status").textContent).toContain("for 8 guests");
  });
});

describe("calendar and list", () => {
  it("opens the calendar by default and switches to the list, keeping the party", async () => {
    window.history.replaceState(null, "", "/?month=2026-11&party=2");
    const queries = tripsApi(
      () => json({ trips: [sunsetOn(4, "2026-11-03")] }),
      () => json({ trips: [sunsetOn(4, "2026-11-03")] }),
    );
    render(<TripsSection />);
    await screen.findByRole("table", { name: /November 2026/ });
    const list = screen.getByRole("button", { name: "List" });
    expect(screen.getByRole("button", { name: "Calendar" }).getAttribute("aria-pressed")).toBe(
      "true",
    );

    fireEvent.click(list);
    expect(await screen.findByRole("region", { name: "Tuesday, November 3" })).toBeTruthy();
    expect(screen.queryByRole("table")).toBeNull();
    // The list starts at the month shown, for the same party, and says it is the list.
    expect(queries[1]?.get("from")).toBe("2026-11-01");
    expect(queries[1]?.get("party")).toBe("2");
    expect(window.location.search).toBe("?view=list&from=2026-11-01&party=2");
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "List" }));
  });

  it("opens the list from the address and switches back to the calendar", async () => {
    window.history.replaceState(null, "", "/?view=list&from=2026-11-01&party=2");
    tripsApi(
      () => json({ trips: [sunsetOn(4, "2026-11-03")] }),
      () => json({ trips: [sunsetOn(4, "2026-11-03")] }),
    );
    render(<TripsSection />);
    await screen.findByRole("region", { name: "Tuesday, November 3" });
    fireEvent.click(screen.getByRole("button", { name: "Calendar" }));
    expect(await screen.findByRole("table", { name: /November 2026/ })).toBeTruthy();
    expect(window.location.search).toBe("?month=2026-11&party=2");
  });
});

describe("calendar dates", () => {
  const today = "2026-10-06";

  it("lays a month out in Sunday-to-Saturday weeks", () => {
    const weeks = monthGrid("2026-11-01");
    expect(weeks).toHaveLength(5);
    expect(weeks[0]?.[0]).toBe("2026-11-01");
    expect(weeks[4]?.[1]).toBe("2026-11-30");
    // The neighbors' dates fill the last week.
    expect(weeks[4]?.[2]).toBe("2026-12-01");
    const feb = monthGrid("2026-02-01");
    expect(feb).toHaveLength(4);
    expect(monthGrid("2026-08-01")).toHaveLength(6);
  });

  it("adds months across years", () => {
    expect(addMonths("2026-12-01", 1)).toBe("2027-01-01");
    expect(addMonths("2026-01-01", -1)).toBe("2025-12-01");
    expect(addMonths("2026-10-01", 14)).toBe("2027-12-01");
  });

  it("asks for the whole month from today on", () => {
    expect(monthWindow("2026-10-01", today)).toEqual({ from: "2026-10-05", to: "2026-10-31" });
    expect(monthWindow("2026-12-01", today)).toEqual({ from: "2026-12-01", to: "2026-12-31" });
  });

  it("reads and writes the address, keeping months inside the year ahead", () => {
    expect(readCalendarQuery("", today)).toEqual({ month: "2026-10-01", party: 1, date: null });
    expect(readCalendarQuery("?date=2026-12-05&party=4", today)).toEqual({
      month: "2026-12-01",
      party: 4,
      date: "2026-12-05",
    });
    expect(readCalendarQuery("?month=2026-12", today).month).toBe("2026-12-01");
    // An old list address opens the month it starts in.
    expect(readCalendarQuery("?from=2026-11-20", today).month).toBe("2026-11-01");
    // Too early, too late, and nonsense.
    expect(readCalendarQuery("?month=2025-01", today).month).toBe("2026-10-01");
    expect(readCalendarQuery("?month=2030-01", today).month).toBe("2027-10-01");
    expect(readCalendarQuery("?date=2026-09-01&month=nope&party=99", today)).toEqual({
      month: "2026-10-01",
      party: 1,
      date: null,
    });
    expect(writeCalendarQuery({ month: "2026-10-01", party: 1, date: null }, today)).toBe("");
    expect(writeCalendarQuery({ month: "2026-11-01", party: 2, date: null }, today)).toBe(
      "?month=2026-11&party=2",
    );
    expect(writeCalendarQuery({ month: "2026-11-01", party: 1, date: "2026-11-03" }, today)).toBe(
      "?date=2026-11-03",
    );
    expect(readView("?view=list")).toBe("list");
    expect(readView("?view=other")).toBe("calendar");
  });

  it("counts trips per day and flags few seats", () => {
    const days = summarizeDays([
      sunsetOn(1, "2026-10-09", 5),
      sunsetOn(2, "2026-10-09", 4),
      sunsetOn(3, "2026-10-10", 12),
    ]);
    expect(days.get("2026-10-09")).toEqual({ count: 2, few: true });
    expect(days.get("2026-10-10")).toEqual({ count: 1, few: false });
  });
});
