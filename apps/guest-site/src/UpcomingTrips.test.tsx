// @vitest-environment jsdom

// The guest is in Tokyo and the marina in New York, so a list that converted
// trip times to the viewer's zone would fail every time assertion below.
process.env.TZ = "Asia/Tokyo";

import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { AvailableTrip, PublicBrand } from "@tidegrid/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { groupByDate, readQuery, windowOf, writeQuery } from "./trips.ts";
import { UpcomingTrips } from "./UpcomingTrips.tsx";

const brand: PublicBrand = {
  version: 1,
  name: "Demo Harbor Charters",
  colors: { primary: "#0b3c5d", accent: "#e0a526" },
  fonts: { display: "fraunces", body: "source-sans-3" },
  contact: { phone: "+13055550142", email: "hello@demo-harbor.test" },
  legal: { terms: "/legal/terms", privacy: "/legal/privacy" },
  locale: "en-US",
  capabilities: [],
};

const location = { name: "Harbor Marina, Dock C", meetingPoint: "Dock C, slip 14" };
const sunset = {
  id: "4f51db31-f9aa-492a-ad2b-05d7c1c3cb2a",
  name: "Sunset Harbor Cruise",
  kind: "shared_seat" as const,
  summary: "Ninety minutes along the harbor at golden hour.",
  minPartySize: 1,
  maxPartySize: 10,
};
const charter = {
  id: "4f51db31-f9aa-492a-ad2b-05d7c1c3cb2b",
  name: "Private Half-Day Charter",
  kind: "private_charter" as const,
  summary: "The whole boat for your group, with a captain, for four hours.",
  minPartySize: 1,
  maxPartySize: 12,
};

/** A New York trip, shaped as the API returns it. */
function trip(
  n: number,
  fields: Pick<
    AvailableTrip,
    | "localDate"
    | "localStartTime"
    | "startsAt"
    | "endsAt"
    | "startsAtLocal"
    | "endsAtLocal"
    | "durationMinutes"
    | "salesCloseAt"
    | "product"
    | "capacity"
  >,
): AvailableTrip {
  return {
    tripId: `bc5f3492-d330-487d-8078-7221db3316${String(n).padStart(2, "0")}`,
    timeZone: "America/New_York",
    location,
    ...fields,
  };
}

const seats = { kind: "seats" as const, total: 20, remaining: 20 };
const wholeBoat = { kind: "whole_boat" as const, total: 12, remaining: 12 };

/** Both sides of the 2026-11-01 clock change in New York. */
const oct31Sunset = trip(1, {
  localDate: "2026-10-31",
  localStartTime: "18:00",
  startsAt: "2026-10-31T22:00:00.000Z",
  endsAt: "2026-10-31T23:30:00.000Z",
  startsAtLocal: "2026-10-31T18:00:00-04:00",
  endsAtLocal: "2026-10-31T19:30:00-04:00",
  durationMinutes: 90,
  salesCloseAt: "2026-10-31T21:00:00.000Z",
  product: sunset,
  capacity: seats,
});
const nov1Charter = trip(2, {
  localDate: "2026-11-01",
  localStartTime: "08:00",
  startsAt: "2026-11-01T13:00:00.000Z",
  endsAt: "2026-11-01T17:00:00.000Z",
  startsAtLocal: "2026-11-01T08:00:00-05:00",
  endsAtLocal: "2026-11-01T12:00:00-05:00",
  durationMinutes: 240,
  // 24 elapsed hours earlier: 9:00 AM EDT, not 8:00 AM.
  salesCloseAt: "2026-10-31T13:00:00.000Z",
  product: charter,
  capacity: wholeBoat,
});
const nov1Sunset = trip(3, {
  localDate: "2026-11-01",
  localStartTime: "18:00",
  startsAt: "2026-11-01T23:00:00.000Z",
  endsAt: "2026-11-02T00:30:00.000Z",
  startsAtLocal: "2026-11-01T18:00:00-05:00",
  endsAtLocal: "2026-11-01T19:30:00-05:00",
  durationMinutes: 90,
  salesCloseAt: "2026-11-01T22:00:00.000Z",
  product: sunset,
  capacity: { kind: "seats", total: 20, remaining: 1 },
});
/** The marina's today: Oct 5 in New York while it is already Oct 6 in Tokyo. */
const oct5Sunset = trip(4, {
  localDate: "2026-10-05",
  localStartTime: "18:00",
  startsAt: "2026-10-05T22:00:00.000Z",
  endsAt: "2026-10-05T23:30:00.000Z",
  startsAtLocal: "2026-10-05T18:00:00-04:00",
  endsAtLocal: "2026-10-05T19:30:00-04:00",
  durationMinutes: 90,
  salesCloseAt: "2026-10-05T21:00:00.000Z",
  product: sunset,
  capacity: seats,
});

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

/** A fetch that answers trips requests in order and records each query. */
function tripsApi(...answers: Array<() => Response | Promise<Response>>) {
  const queries: URLSearchParams[] = [];
  const fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    if (url.pathname !== "/v1/public/trips") throw new Error(`unexpected request ${url}`);
    expect(init?.credentials).toBe("omit");
    queries.push(url.searchParams);
    const answer = answers.shift();
    if (!answer) throw new Error("no answer left");
    return answer();
  });
  vi.stubGlobal("fetch", fetch);
  return queries;
}

/** A response the test releases when it chooses. */
function deferred() {
  let release: (res: Response) => void = () => {};
  const promise = new Promise<Response>((resolve) => {
    release = resolve;
  });
  return { answer: () => promise, release };
}

/** Text with every kind of space as a plain space. */
const text = (element: Element | null) => (element?.textContent ?? "").replace(/\s+/g, " ").trim();

const cardTitled = (day: HTMLElement, name: RegExp) =>
  within(day).getByRole("heading", { level: 4, name }).closest("li") as HTMLElement;

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

describe("upcoming trips on a branded site", () => {
  it("groups trips by the marina's date and keeps its clock across the Nov 1 change", async () => {
    const queries = tripsApi(() => json({ trips: [oct31Sunset, nov1Charter, nov1Sunset] }));
    render(<UpcomingTrips brand={brand} />);

    const oct31 = await screen.findByRole("region", { name: "Saturday, October 31" });
    const nov1 = screen.getByRole("region", { name: "Sunday, November 1" });
    const days = screen.getAllByRole("heading", { level: 3 }).map((h) => text(h));
    expect(days).toEqual(["Saturday, October 31", "Sunday, November 1"]);

    // 6:00 PM on both sides of the change, though the UTC instants differ by an hour.
    expect(text(cardTitled(oct31, /Sunset Harbor Cruise/))).toContain("6:00 PM");
    const sundayCharter = cardTitled(nov1, /Private Half-Day Charter/);
    expect(text(sundayCharter)).toContain("8:00 AM");
    expect(text(sundayCharter)).toContain("4 h");
    expect(text(sundayCharter)).toContain("Whole boat, up to 12 guests");
    expect(text(sundayCharter)).toContain("Meet at Dock C, slip 14");
    // The cutoff is on the other side of the change: 9:00 AM EDT the day before.
    expect(text(sundayCharter)).toContain("Book by Sat, Oct 31, 9:00 AM EDT");
    const sundaySunset = cardTitled(nov1, /Sunset Harbor Cruise/);
    expect(text(sundaySunset)).toContain("6:00 PM");
    expect(text(sundaySunset)).toContain("Book by 5:00 PM");
    expect(text(sundaySunset)).toContain("Shared trip, 1 seat left");
    // The heading carries the time, so a screen reader's heading list is not a list of names.
    expect(
      within(nov1)
        .getAllByRole("heading", { level: 4 })
        .map((h) => text(h)),
    ).toEqual(["8:00 AM, Private Half-Day Charter", "6:00 PM, Sunset Harbor Cruise"]);
    expect(
      within(nov1).getByRole("heading", { level: 4, name: "8:00 AM, Private Half-Day Charter" }),
    ).toBeTruthy();

    expect(screen.getByText("Times are local to Harbor Marina, Dock C (New York).")).toBeTruthy();
    expect(screen.getByText("Clocks go back 1 hour on Sun, Nov 1.")).toBeTruthy();
    // Four weeks from the guest's today (Oct 6 in Tokyo), plus the marina's today.
    expect(queries[0]?.get("from")).toBe("2026-10-05");
    expect(queries[0]?.get("to")).toBe("2026-11-02");
    expect(queries[0]?.get("party")).toBe("1");
    expect(screen.getByText("Tue, Oct 6 to Mon, Nov 2")).toBeTruthy();
  });

  it("labels the marina's today, even when the guest's calendar is a day ahead", async () => {
    tripsApi(() => json({ trips: [oct5Sunset] }));
    render(<UpcomingTrips brand={brand} />);
    const today = await screen.findByRole("heading", { level: 3 });
    expect(text(today)).toBe("Today Monday, October 5");
  });

  it("asks again for the same dates when the party changes, keeping the list meanwhile", async () => {
    const second = deferred();
    const queries = tripsApi(
      () => json({ trips: [oct31Sunset, nov1Charter, nov1Sunset] }),
      second.answer,
    );
    render(<UpcomingTrips brand={brand} />);
    await screen.findByRole("region", { name: "Sunday, November 1" });

    const party = screen.getByRole("combobox", { name: "Party size" });
    expect(
      within(party)
        .getAllByRole("option")
        .map((o) => o.textContent),
    ).toEqual(["1 guest", ...Array.from({ length: 11 }, (_, i) => `${i + 2} guests`)]);
    fireEvent.change(party, { target: { value: "11" } });

    await waitFor(() => expect(queries).toHaveLength(2));
    expect(queries[1]?.get("party")).toBe("11");
    expect(queries[1]?.get("from")).toBe(queries[0]?.get("from"));
    expect(queries[1]?.get("to")).toBe(queries[0]?.get("to"));
    // The old list stays while the new one loads.
    expect(screen.getByText("Updating for 11 guests…")).toBeTruthy();
    expect(screen.getByRole("region", { name: "Sunday, November 1" })).toBeTruthy();

    second.release(json({ trips: [nov1Charter] }));
    await waitFor(() => expect(screen.queryByText("Updating for 11 guests…")).toBeNull());
    expect(screen.queryByRole("region", { name: "Saturday, October 31" })).toBeNull();
    expect(window.location.search).toBe("?party=11");
    expect(text(screen.getByRole("status"))).toBe(
      "1 trip from Tuesday, October 6 to Monday, November 2, for 11 guests.",
    );
  });

  it("moves four weeks at a time and never before today", async () => {
    const queries = tripsApi(
      () => json({ trips: [] }),
      () => json({ trips: [] }),
      () => json({ trips: [] }),
    );
    render(<UpcomingTrips brand={brand} />);
    await screen.findByRole("heading", { name: "No trips in these dates" });

    const previous = screen.getByRole("button", { name: "Previous 4 weeks" });
    expect(previous.getAttribute("aria-disabled")).toBe("true");
    fireEvent.click(previous);
    expect(queries).toHaveLength(1);

    const next = screen.getByRole("button", { name: "Next 4 weeks" });
    next.focus();
    fireEvent.click(next);
    await waitFor(() => expect(queries).toHaveLength(2));
    expect(queries[1]?.get("from")).toBe("2026-11-03");
    expect(queries[1]?.get("to")).toBe("2026-11-30");
    expect(window.location.search).toBe("?from=2026-11-03");
    expect(screen.getByText("Tue, Nov 3 to Mon, Nov 30")).toBeTruthy();
    // The control the guest pressed keeps focus.
    expect(document.activeElement).toBe(next);

    await screen.findByRole("heading", { name: "No trips in these dates" });
    fireEvent.click(screen.getByRole("button", { name: "Previous 4 weeks" }));
    await waitFor(() => expect(queries).toHaveLength(3));
    expect(queries[2]?.get("from")).toBe("2026-10-05");
    expect(window.location.search).toBe("");
  });

  it("says plainly when no trips match, naming the party and the dates", async () => {
    window.history.replaceState(null, "", "/?party=12");
    tripsApi(() => json({ trips: [] }));
    render(<UpcomingTrips brand={brand} />);
    const empty = await screen.findByRole("region", { name: "No trips in these dates" });
    expect(text(empty)).toContain(
      "Nothing is open for 12 guests from Tue, Oct 6 to Mon, Nov 2. Try later dates or a smaller party.",
    );
    expect(screen.queryByText(/Times are local/)).toBeNull();
  });

  it("shows an error with Try again, keeps focus there while it works, then focuses the list", async () => {
    const retry = deferred();
    tripsApi(() => {
      throw new TypeError("Failed to fetch");
    }, retry.answer);
    render(<UpcomingTrips brand={brand} />);
    const alert = await screen.findByRole("alert");
    expect(text(alert)).toContain("We couldn't load trips");
    // "Try again" is the screen's one primary action; the call link steps down.
    const primaries = document.querySelectorAll(".tg-button--primary");
    expect([...primaries].map((p) => text(p))).toEqual(["Try again"]);

    const button = screen.getByRole("button", { name: "Try again" });
    button.focus();
    fireEvent.click(button);
    expect(await screen.findByRole("button", { name: "Trying again…" })).toBe(button);
    expect(document.activeElement).toBe(button);

    retry.release(json({ trips: [oct31Sunset] }));
    const heading = screen.getByRole("heading", { level: 2, name: "Upcoming trips" });
    await waitFor(() => expect(document.activeElement).toBe(heading));
    expect(screen.queryByRole("alert")).toBeNull();
    expect([...document.querySelectorAll(".tg-button--primary")].map((p) => text(p))).toEqual([
      "Call (305) 555-0142",
    ]);
  });

  it("says so when a second try fails too", async () => {
    tripsApi(
      () => json({ error: { code: "internal_error", message: "x", requestId: "r" } }, 500),
      () => json({ error: { code: "internal_error", message: "x", requestId: "r" } }, 500),
    );
    render(<UpcomingTrips brand={brand} />);
    fireEvent.click(await screen.findByRole("button", { name: "Try again" }));
    await screen.findByText("Trips still aren't loading");
    expect(text(screen.getByRole("alert"))).not.toMatch(/\b500\b|internal/);
  });

  it("treats a response that breaks the contract as an error, not an empty list", async () => {
    tripsApi(() => json({ trips: [{ ...oct31Sunset, salesCloseAt: "soon" }] }));
    render(<UpcomingTrips brand={brand} />);
    expect(text(await screen.findByRole("alert"))).toContain("We couldn't load trips");
    expect(screen.queryByText("No trips in these dates")).toBeNull();
  });

  it("starts from the dates and party in the address", async () => {
    window.history.replaceState(null, "", "/?from=2026-11-03&party=3");
    const queries = tripsApi(() => json({ trips: [] }));
    render(<UpcomingTrips brand={brand} />);
    await screen.findByRole("heading", { name: "No trips in these dates" });
    expect(queries[0]?.get("from")).toBe("2026-11-03");
    expect(queries[0]?.get("party")).toBe("3");
    expect((screen.getByRole("combobox", { name: "Party size" }) as HTMLSelectElement).value).toBe(
      "3",
    );
  });
});

describe("trip windows and grouping", () => {
  it("asks for one extra day only on the first page", () => {
    expect(windowOf("2026-10-06", "2026-10-06")).toEqual({
      start: "2026-10-06",
      end: "2026-11-02",
      from: "2026-10-05",
      to: "2026-11-02",
    });
    expect(windowOf("2026-11-03", "2026-10-06").from).toBe("2026-11-03");
  });

  it("refuses dates in the past, impossible dates, and party sizes out of range", () => {
    const today = "2026-10-06";
    expect(readQuery("?from=2026-09-01&party=0", today)).toEqual({ start: today, party: 1 });
    expect(readQuery("?from=2026-02-30&party=13", today)).toEqual({ start: today, party: 1 });
    expect(readQuery("?from=2026-12-01&party=12", today)).toEqual({
      start: "2026-12-01",
      party: 12,
    });
    expect(writeQuery({ start: today, party: 1 }, today)).toBe("");
    expect(writeQuery({ start: "2026-11-03", party: 4 }, today)).toBe("?from=2026-11-03&party=4");
  });

  it("groups by local date, not by the UTC date of the instant", () => {
    // 6:00 PM on Nov 1 in New York is 2026-11-01T23:00Z, and its end is Nov 2 in UTC.
    const days = groupByDate([nov1Sunset, oct31Sunset, nov1Charter]);
    expect(days.map((d) => [d.date, d.trips.map((t) => t.localStartTime)])).toEqual([
      ["2026-10-31", ["18:00"]],
      ["2026-11-01", ["08:00", "18:00"]],
    ]);
  });
});
