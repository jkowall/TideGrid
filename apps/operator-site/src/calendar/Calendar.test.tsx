// @vitest-environment jsdom

// Staff in Tokyo looking at a New York marina: times must stay New York's.
process.env.TZ = "Asia/Tokyo";

import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { Membership, StaffRole, StaffTrip } from "@tidegrid/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CalendarPage } from "./Calendar.tsx";
import { actionsFor, capacityText, consequence, readWeek, weekBounds, weekOf } from "./model.ts";

const harbor = "7d1e5b3a-1c2f-4a8e-9b61-0a1c2e3f4a01";
const membership = (role: StaffRole): Membership => ({
  tenantId: harbor,
  tenantSlug: "demo-harbor",
  tenantName: "Demo Harbor Charters",
  role,
});

let n = 0;
/** A New York trip as the staff API returns it. */
function trip(
  fields: Pick<
    StaffTrip,
    | "localDate"
    | "localStartTime"
    | "startsAt"
    | "endsAt"
    | "startsAtLocal"
    | "endsAtLocal"
    | "salesCloseAt"
    | "salesState"
  > &
    Partial<StaffTrip>,
): StaffTrip {
  n += 1;
  const charter = fields.localStartTime === "08:00";
  return {
    tripId: `bc5f3492-d330-487d-8078-7221db3317${String(n).padStart(2, "0")}`,
    timeZone: "America/New_York",
    durationMinutes: charter ? 240 : 90,
    productId: charter
      ? "4f51db31-f9aa-492a-ad2b-05d7c1c3cb2b"
      : "4f51db31-f9aa-492a-ad2b-05d7c1c3cb2a",
    productName: charter ? "Private Half-Day Charter" : "Sunset Harbor Cruise",
    productKind: charter ? "private_charter" : "shared_seat",
    boatId: charter
      ? "9a0e7c55-3b1d-4f2a-8c6e-1d2f3a4b5c02"
      : "9a0e7c55-3b1d-4f2a-8c6e-1d2f3a4b5c01",
    boatName: charter ? "Blue Heron" : "Sea Lark",
    scheduleId: null,
    salesStateChangedAt: "2026-09-30T12:00:00.000Z",
    blackedOut: false,
    capacity: charter
      ? { kind: "whole_boat", total: 12, remaining: 12 }
      : { kind: "seats", total: 20, remaining: 20 },
    ...fields,
  };
}

/** Sunset cruise at 6:00 PM local on a November date (after the change: EST). */
const sunsetOn = (
  day: number,
  salesState: StaffTrip["salesState"],
  extra: Partial<StaffTrip> = {},
) => {
  const d = String(day).padStart(2, "0");
  const next = String(day + 1).padStart(2, "0");
  return trip({
    localDate: `2026-11-${d}`,
    localStartTime: "18:00",
    startsAt: `2026-11-${d}T23:00:00.000Z`,
    endsAt: `2026-11-${next}T00:30:00.000Z`,
    startsAtLocal: `2026-11-${d}T18:00:00-05:00`,
    endsAtLocal: `2026-11-${d}T19:30:00-05:00`,
    salesCloseAt: `2026-11-${d}T22:00:00.000Z`,
    salesState,
    ...extra,
  });
};

/** The week of Nov 1 to 7, 2026, seen at noon on Wednesday, Nov 4, in New York. */
const nov1Charter = trip({
  localDate: "2026-11-01",
  localStartTime: "08:00",
  startsAt: "2026-11-01T13:00:00.000Z",
  endsAt: "2026-11-01T17:00:00.000Z",
  startsAtLocal: "2026-11-01T08:00:00-05:00",
  endsAtLocal: "2026-11-01T12:00:00-05:00",
  salesCloseAt: "2026-10-31T13:00:00.000Z",
  salesState: "published",
});
const nov1Sunset = sunsetOn(1, "completed");
const nov2Sunset = sunsetOn(2, "canceled");
const nov5Sunset = sunsetOn(5, "published", { blackedOut: true });
const nov6Sunset = sunsetOn(6, "closed");
const nov7Charter = trip({
  localDate: "2026-11-07",
  localStartTime: "08:00",
  startsAt: "2026-11-07T13:00:00.000Z",
  endsAt: "2026-11-07T17:00:00.000Z",
  startsAtLocal: "2026-11-07T08:00:00-05:00",
  endsAtLocal: "2026-11-07T12:00:00-05:00",
  salesCloseAt: "2026-11-06T13:00:00.000Z",
  salesState: "draft",
});
const week = [nov1Charter, nov1Sunset, nov2Sunset, nov5Sunset, nov6Sunset, nov7Charter];

const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
const apiError = (status: number, code: string) =>
  json({ error: { code, message: "x", requestId: "r" } }, status);

/** The operator's catalog, as far as the calendar reads it: its location's zone. */
const catalog = (timeZone = "America/New_York") =>
  json({
    locations: [
      {
        id: "0f2c7a10-1b2c-4d3e-8f40-5a6b7c8d9e01",
        name: "Harbor Marina, Dock C",
        timeZone,
        meetingPoint: "Dock C, slip 14",
        status: "active",
      },
    ],
    boats: [],
    products: [],
    schedules: [],
  });

type Answer = (init: RequestInit | undefined) => Response | Promise<Response>;
interface Call {
  method: string;
  path: string;
  query: URLSearchParams;
  headers: Headers;
  body: unknown;
}

const tripsPath = (tenant = harbor) => `GET /api/v1/staff/tenants/${tenant}/trips`;
const catalogPath = (tenant = harbor) => `GET /api/v1/staff/tenants/${tenant}/catalog`;
const salesStatePath = (t: StaffTrip, tenant = harbor) =>
  `POST /api/v1/staff/tenants/${tenant}/trips/${t.tripId}/sales-state`;

/**
 * A fetch that answers "METHOD /path" from per-route queues and records every
 * call. The catalog answers with a New York marina unless a test says otherwise.
 */
function api(routes: Record<string, Answer[]>) {
  const calls: Call[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input), "http://localhost:5184");
      const method = init?.method ?? "GET";
      const key = `${method} ${url.pathname}`;
      calls.push({
        method,
        path: url.pathname,
        query: url.searchParams,
        headers: new Headers(init?.headers),
        body: init?.body ? JSON.parse(String(init.body)) : undefined,
      });
      const answer =
        routes[key]?.shift() ?? (key.endsWith("/catalog") ? () => catalog() : undefined);
      if (!answer) throw new Error(`unexpected request ${key}`);
      return answer(init);
    }),
  );
  return calls;
}

const weekCalls = (calls: Call[]) => calls.filter((c) => c.path.endsWith("/trips"));
const posts = (calls: Call[]) => calls.filter((c) => c.method === "POST");

/** A response the test releases when it chooses. */
function deferred() {
  let release: (res: Response) => void = () => {};
  const promise = new Promise<Response>((resolve) => {
    release = resolve;
  });
  return { answer: () => promise, release };
}

const text = (element: Element | null) => (element?.textContent ?? "").replace(/\s+/g, " ").trim();

/** The list item of a trip, found by its day and its heading. */
function rowOn(dayHeading: string, name: RegExp): HTMLElement {
  const day = screen.getByRole("region", { name: new RegExp(`^${dayHeading}`) });
  return within(day).getByRole("heading", { level: 4, name }).closest("li") as HTMLElement;
}

/** Open a change from a trip's row and give it a reason. */
async function openChange(dayHeading: string, name: RegExp, button: RegExp, reason?: string) {
  fireEvent.click(within(rowOn(dayHeading, name)).getByRole("button", { name: button }));
  const dialog = await screen.findByRole("dialog");
  if (reason !== undefined) {
    fireEvent.change(within(dialog).getByRole("textbox", { name: "Reason" }), {
      target: { value: reason },
    });
  }
  return dialog;
}

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-11-04T17:00:00Z"));
  window.history.replaceState(null, "", "/calendar");
  n = 0;
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("the week", () => {
  it("shows each trip's time, product, boat, state, blackout, capacity, and cutoff", async () => {
    const calls = api({ [tripsPath()]: [() => json({ trips: week })] });
    render(<CalendarPage membership={membership("owner")} focusHeading={false} />);
    await screen.findByRole("region", { name: /^Sunday, November 1/ });

    // Sunday to Saturday, as the marina's local dates.
    expect(weekCalls(calls)[0]?.query.get("from")).toBe("2026-11-01");
    expect(weekCalls(calls)[0]?.query.get("to")).toBe("2026-11-07");
    expect(screen.getByRole("heading", { level: 2, name: "Nov 1 to 7, 2026" })).toBeTruthy();
    expect(screen.getByText("Clocks go back 1 hour on Sun, Nov 1. EDT becomes EST.")).toBeTruthy();

    const charter = rowOn("Sunday, November 1", /Private Half-Day Charter/);
    expect(text(charter)).toContain("8:00 AM");
    expect(text(charter)).toContain("to 12:00 PM");
    expect(text(charter)).toContain("Blue Heron");
    expect(text(charter)).toContain("Whole boat, up to 12 guests");
    // 24 elapsed hours before 8:00 AM EST is 9:00 AM EDT the day before.
    expect(text(charter)).toContain("Booking cutoff Sat, Oct 31, 9:00 AM EDT (passed)");
    expect(text(charter)).toContain("Published");
    expect(text(charter)).toContain("Departed");

    const blackedOut = rowOn("Thursday, November 5", /Sunset Harbor Cruise/);
    expect(text(blackedOut)).toContain("6:00 PM");
    expect(text(blackedOut)).toContain("20 of 20 seats left");
    expect(text(blackedOut)).toContain("Booking cutoff 5:00 PM");
    expect(within(blackedOut).getByText("Blacked out").closest(".tg-status")).not.toBeNull();
    // A trip that ran shows its size, not seats left.
    expect(text(rowOn("Sunday, November 1", /Sunset Harbor Cruise/))).toContain("20 seats");
    expect(text(rowOn("Sunday, November 1", /Sunset Harbor Cruise/))).not.toContain("left");

    // Every sales state as a badge with an icon and a label.
    const badges = [...document.querySelectorAll(".cal-trip__status .tg-status")].map((b) => ({
      label: text(b),
      icon: b.querySelector("svg") !== null,
    }));
    expect(badges.map((b) => b.label)).toEqual([
      "Published",
      "Completed",
      "Canceled",
      "Published",
      "Blacked out",
      "Closed",
      "Draft",
    ]);
    expect(badges.every((b) => b.icon)).toBe(true);
    // Days without trips say so.
    expect(text(screen.getByRole("region", { name: /^Tuesday, November 3/ }))).toContain(
      "No trips",
    );
  });

  it("offers each change only where the API allows it", async () => {
    api({ [tripsPath()]: [() => json({ trips: week })] });
    render(<CalendarPage membership={membership("owner")} focusHeading={false} />);
    await screen.findByRole("region", { name: /^Sunday, November 1/ });
    const buttons = (li: HTMLElement) =>
      within(li)
        .queryAllByRole("button")
        .map((b) => text(b).replace(/ Private.*| Sunset.*/, ""));
    expect(buttons(rowOn("Sunday, November 1", /Charter/))).toEqual([
      "Mark completed",
      "Cancel trip",
    ]);
    expect(buttons(rowOn("Sunday, November 1", /Sunset/))).toEqual([]);
    expect(buttons(rowOn("Monday, November 2", /Sunset/))).toEqual([]);
    expect(buttons(rowOn("Thursday, November 5", /Sunset/))).toEqual([
      "Close sales",
      "Cancel trip",
    ]);
    expect(buttons(rowOn("Friday, November 6", /Sunset/))).toEqual(["Reopen sales", "Cancel trip"]);
    expect(buttons(rowOn("Saturday, November 7", /Charter/))).toEqual(["Publish", "Cancel trip"]);
  });

  it("moves a week at a time and back to this week, keeping the week in the address", async () => {
    const calls = api({
      [tripsPath()]: [
        () => json({ trips: week }),
        () => json({ trips: [] }),
        () => json({ trips: [] }),
        () => json({ trips: week }),
      ],
    });
    render(<CalendarPage membership={membership("owner")} focusHeading={false} />);
    await screen.findByRole("region", { name: /^Sunday, November 1/ });
    const thisWeek = screen.getByRole("button", { name: "This week" });
    expect(thisWeek.getAttribute("aria-disabled")).toBe("true");

    fireEvent.click(screen.getByRole("button", { name: "Next week" }));
    const empty = await screen.findByRole("region", { name: "No trips this week" });
    expect(weekCalls(calls)[1]?.query.get("from")).toBe("2026-11-08");
    expect(weekCalls(calls)[1]?.query.get("to")).toBe("2026-11-14");
    expect(window.location.search).toBe("?week=2026-11-08");
    // The empty week names its year, as the heading does, and offers a way back.
    expect(text(empty)).toContain("from Sun, Nov 8 to Sat, Nov 14, 2026.");
    expect(within(empty).getByRole("button", { name: "Go to this week" })).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Next week" }));
    await waitFor(() => expect(weekCalls(calls)).toHaveLength(3));
    expect(weekCalls(calls)[2]?.query.get("from")).toBe("2026-11-15");

    // The empty week's button goes with it, so the week's heading takes focus.
    const back = within(
      await screen.findByRole("region", { name: "No trips this week" }),
    ).getByRole("button", { name: "Go to this week" });
    back.focus();
    fireEvent.click(back);
    const range = screen.getByRole("heading", { level: 2, name: "Nov 1 to 7, 2026" });
    expect(document.activeElement).toBe(range);
    await screen.findByRole("region", { name: /^Sunday, November 1/ });
    expect(weekCalls(calls)[3]?.query.get("from")).toBe("2026-11-01");
    expect(window.location.search).toBe("");
    expect(document.activeElement).toBe(range);
  });

  it("opens on the week in the address, and Previous crosses the clock change", async () => {
    window.history.replaceState(null, "", "/calendar?week=2026-11-04");
    const calls = api({
      [tripsPath()]: [
        () => json({ trips: week }),
        () => json({ trips: [] }),
        () => json({ trips: week }),
      ],
    });
    render(<CalendarPage membership={membership("owner")} focusHeading={false} />);
    await screen.findByRole("region", { name: /^Sunday, November 1/ });
    expect(weekCalls(calls)[0]?.query.get("from")).toBe("2026-11-01");
    fireEvent.click(screen.getByRole("button", { name: "Previous week" }));
    await screen.findByRole("heading", { name: "No trips this week" });
    expect(weekCalls(calls)[1]?.query.get("from")).toBe("2026-10-25");
    expect(weekCalls(calls)[1]?.query.get("to")).toBe("2026-10-31");

    // This week in the bar stays put once pressed: unavailable, still focused.
    const thisWeek = screen.getByRole("button", { name: "This week" });
    thisWeek.focus();
    fireEvent.click(thisWeek);
    await screen.findByRole("region", { name: /^Sunday, November 1/ });
    expect(weekCalls(calls)[2]?.query.get("from")).toBe("2026-11-01");
    expect(thisWeek.getAttribute("aria-disabled")).toBe("true");
    expect(document.activeElement).toBe(thisWeek);
  });

  it("opens on the marina's week, not the viewer's, once the catalog names its zone", async () => {
    // Saturday 6:30 PM in New York is already Sunday morning in Tokyo.
    vi.setSystemTime(new Date("2026-11-07T23:30:00Z"));
    const calls = api({ [tripsPath()]: [() => json({ trips: week })] });
    render(<CalendarPage membership={membership("owner")} focusHeading={false} />);
    await screen.findByRole("region", { name: /^Saturday, November 7/ });
    expect(weekCalls(calls)[0]?.query.get("from")).toBe("2026-11-01");
    // Today is the marina's Saturday.
    expect(
      text(screen.getByRole("region", { name: /^Saturday, November 7/ }).querySelector("h3")),
    ).toBe("Saturday, November 7 Today");
  });

  it("falls back to the viewer's week when the catalog cannot be read", async () => {
    vi.setSystemTime(new Date("2026-11-07T23:30:00Z"));
    const calls = api({
      [catalogPath()]: [() => apiError(500, "internal_error")],
      [tripsPath()]: [() => json({ trips: [] })],
    });
    render(<CalendarPage membership={membership("owner")} focusHeading={false} />);
    await screen.findByRole("heading", { name: "No trips this week" });
    expect(weekCalls(calls)[0]?.query.get("from")).toBe("2026-11-08");
  });

  it("keeps the week within two years, so a far-off address cannot break the page", async () => {
    window.history.replaceState(null, "", "/calendar?week=9999-12-27");
    const calls = api({ [tripsPath()]: [() => json({ trips: [] })] });
    render(<CalendarPage membership={membership("owner")} focusHeading={false} />);
    await screen.findByRole("heading", { name: "No trips this week" });
    // The viewer's today in Tokyo is Nov 5; the last week starts two years on.
    const { last } = weekBounds("2026-11-05");
    expect(weekCalls(calls)[0]?.query.get("from")).toBe(last);
    expect(screen.getByRole("button", { name: "Next week" }).getAttribute("aria-disabled")).toBe(
      "true",
    );
  });

  it("shows a designed error, keeps focus on Try again while it works, then focuses the week", async () => {
    const retry = deferred();
    api({
      [tripsPath()]: [
        () => {
          throw new TypeError("Failed to fetch");
        },
        retry.answer,
      ],
    });
    render(<CalendarPage membership={membership("owner")} focusHeading={false} />);
    const alert = await screen.findByRole("alert");
    expect(text(alert)).toContain("The calendar can't reach TideGrid");
    const button = screen.getByRole("button", { name: "Try again" });
    button.focus();
    fireEvent.click(button);
    expect(await screen.findByRole("button", { name: "Trying again…" })).toBe(button);
    expect(document.activeElement).toBe(button);
    retry.release(json({ trips: week }));
    const range = await screen.findByRole("heading", { level: 2, name: "Nov 1 to 7, 2026" });
    await waitFor(() => expect(document.activeElement).toBe(range));
  });

  it("sends a signed-out person to sign in again", async () => {
    api({ [tripsPath()]: [() => apiError(401, "unauthenticated")] });
    render(<CalendarPage membership={membership("owner")} focusHeading={false} />);
    expect(text(await screen.findByRole("alert"))).toContain("You're signed out");
    expect(screen.getByRole("link", { name: "Sign in again" }).getAttribute("href")).toBe("/");
  });

  it("says when the operator is suspended, not that the role is wrong", async () => {
    api({ [tripsPath()]: [() => apiError(403, "tenant_suspended")] });
    render(<CalendarPage membership={membership("owner")} focusHeading={false} />);
    const alert = await screen.findByRole("alert");
    expect(text(alert)).toContain("This operator is suspended");
    expect(text(alert)).not.toMatch(/role/i);
  });

  it("says when the API refuses the dates, and offers this week", async () => {
    window.history.replaceState(null, "", "/calendar?week=2026-12-06");
    const calls = api({
      [tripsPath()]: [() => apiError(400, "range_too_large"), () => json({ trips: week })],
    });
    render(<CalendarPage membership={membership("owner")} focusHeading={false} />);
    const alert = await screen.findByRole("alert");
    expect(text(alert)).toContain("This week can't be shown");
    expect(text(alert)).not.toMatch(/connection/);
    fireEvent.click(within(alert).getByRole("button", { name: "Go to this week" }));
    await screen.findByRole("region", { name: /^Sunday, November 1/ });
    expect(weekCalls(calls)[1]?.query.get("from")).toBe("2026-11-01");
    expect(document.activeElement).toBe(
      screen.getByRole("heading", { level: 2, name: "Nov 1 to 7, 2026" }),
    );
  });

  it.each([
    ["a sales state it does not know", { ...nov5Sunset, salesState: "delayed" }],
    ["a time zone the browser cannot show", { ...nov5Sunset, timeZone: "Mars/Olympus_Mons" }],
  ])("treats %s as trips it can't show, not as a crash", async (_what, odd) => {
    api({ [tripsPath()]: [() => json({ trips: [odd] })] });
    render(<CalendarPage membership={membership("owner")} focusHeading={false} />);
    expect(text(await screen.findByRole("alert"))).toContain("Trips couldn't be shown");
  });

  it("names each trip's place when the week has trips in several zones", async () => {
    const reefDive = trip({
      localDate: "2026-11-05",
      localStartTime: "07:30",
      startsAt: "2026-11-05T17:30:00.000Z",
      endsAt: "2026-11-05T21:30:00.000Z",
      startsAtLocal: "2026-11-05T07:30:00-10:00",
      endsAtLocal: "2026-11-05T11:30:00-10:00",
      salesCloseAt: "2026-11-05T05:30:00.000Z",
      salesState: "published",
      timeZone: "Pacific/Honolulu",
      productName: "Two-Tank Morning Dive",
    });
    api({ [tripsPath()]: [() => json({ trips: [reefDive, nov5Sunset] })] });
    render(<CalendarPage membership={membership("owner")} focusHeading={false} />);
    await screen.findByRole("region", { name: /^Thursday, November 5/ });
    expect(screen.getByText("Times are local to each trip's departure point.")).toBeTruthy();
    expect(text(rowOn("Thursday, November 5", /Honolulu time, Two-Tank/))).toContain("Honolulu");
    expect(text(rowOn("Thursday, November 5", /New York time, Sunset/))).toContain("New York");
  });

  it("names the zone of a departure in the hour clocks go back", async () => {
    const early = trip({
      localDate: "2026-11-01",
      localStartTime: "01:30",
      startsAt: "2026-11-01T06:30:00.000Z",
      endsAt: "2026-11-01T08:00:00.000Z",
      startsAtLocal: "2026-11-01T01:30:00-05:00",
      endsAtLocal: "2026-11-01T03:00:00-05:00",
      salesCloseAt: "2026-11-01T05:30:00.000Z",
      salesState: "completed",
    });
    api({ [tripsPath()]: [() => json({ trips: [early] })] });
    render(<CalendarPage membership={membership("owner")} focusHeading={false} />);
    await screen.findByRole("region", { name: /^Sunday, November 1/ });
    expect(text(rowOn("Sunday, November 1", /Sunset/))).toContain("1:30 AM EST to 3:00 AM");
  });
});

describe("changing a trip", () => {
  it("requires a reason before sending anything", async () => {
    const calls = api({ [tripsPath()]: [() => json({ trips: week })] });
    render(<CalendarPage membership={membership("booking_staff")} focusHeading={false} />);
    await screen.findByRole("region", { name: /^Thursday, November 5/ });
    const dialog = await openChange("Thursday, November 5", /Sunset/, /^Close sales/);
    expect(dialog.getAttribute("aria-labelledby")).toBeTruthy();
    const reason = within(dialog).getByRole("textbox", { name: "Reason" });
    expect(document.activeElement).toBe(reason);

    fireEvent.click(within(dialog).getByRole("button", { name: "Close sales" }));
    expect(text(dialog)).toContain("Enter a reason. It's saved in the audit history.");
    expect(reason.getAttribute("aria-invalid")).toBe("true");
    fireEvent.change(reason, { target: { value: "   " } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Close sales" }));
    expect(posts(calls)).toEqual([]);
    expect(document.activeElement).toBe(reason);
  });

  it("sends a fresh Idempotency-Key per change, reuses it to retry, and updates the trip", async () => {
    const closed = { ...nov5Sunset, salesState: "closed" as const };
    const reopened = { ...nov5Sunset, salesState: "published" as const };
    const calls = api({
      [tripsPath()]: [() => json({ trips: week })],
      [salesStatePath(nov5Sunset)]: [
        () => {
          throw new TypeError("Failed to fetch");
        },
        () => json({ trip: closed }),
        () => json({ trip: reopened }),
      ],
    });
    render(<CalendarPage membership={membership("owner")} focusHeading={false} />);
    await screen.findByRole("region", { name: /^Thursday, November 5/ });

    let dialog = await openChange(
      "Thursday, November 5",
      /Sunset/,
      /^Close sales/,
      "Small craft advisory",
    );
    fireEvent.click(within(dialog).getByRole("button", { name: "Close sales" }));
    expect(text(await within(dialog).findByRole("alert"))).toContain(
      "The change didn't reach TideGrid",
    );
    // The same change again: the same key, so the API applies it once.
    fireEvent.click(within(dialog).getByRole("button", { name: "Close sales" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());

    expect(posts(calls)).toHaveLength(2);
    const firstKey = posts(calls)[0]?.headers.get("idempotency-key") ?? "";
    expect(firstKey).toMatch(uuid);
    expect(posts(calls)[1]?.headers.get("idempotency-key")).toBe(firstKey);
    expect(posts(calls)[0]?.headers.get("content-type")).toBe("application/json");
    expect(posts(calls)[0]?.body).toEqual({ to: "closed", reason: "Small craft advisory" });

    // The trip shows its new state, and focus marks it.
    const updated = rowOn("Thursday, November 5", /Sunset/);
    expect(text(updated)).toContain("Closed");
    expect(text(updated)).toContain("Sales closed. The reason is in the audit history.");
    await waitFor(() =>
      expect(document.activeElement).toBe(within(updated).getByRole("heading", { level: 4 })),
    );
    expect(text(screen.getByRole("status"))).toBe(
      "Sales closed: Sunset Harbor Cruise, Thu, Nov 5, 6:00 PM.",
    );

    // A new change, even on the same trip, gets a new key.
    dialog = await openChange("Thursday, November 5", /Sunset/, /^Reopen sales/, "Advisory lifted");
    fireEvent.click(within(dialog).getByRole("button", { name: "Reopen sales" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    const third = posts(calls)[2];
    expect(third?.headers.get("idempotency-key")).toMatch(uuid);
    expect(third?.headers.get("idempotency-key")).not.toBe(firstKey);
    expect(third?.body).toEqual({ to: "published", reason: "Advisory lifted" });
  });

  it("sends a new key once the reason is edited after a failure", async () => {
    const calls = api({
      [tripsPath()]: [() => json({ trips: week })],
      [salesStatePath(nov5Sunset)]: [
        () => {
          throw new TypeError("Failed to fetch");
        },
        () => json({ trip: { ...nov5Sunset, salesState: "closed" } }),
      ],
    });
    render(<CalendarPage membership={membership("owner")} focusHeading={false} />);
    await screen.findByRole("region", { name: /^Thursday, November 5/ });
    const dialog = await openChange("Thursday, November 5", /Sunset/, /^Close sales/, "Weather");
    fireEvent.click(within(dialog).getByRole("button", { name: "Close sales" }));
    await within(dialog).findByRole("alert");
    // A different body is a different change: it must not reuse the key.
    fireEvent.change(within(dialog).getByRole("textbox", { name: "Reason" }), {
      target: { value: "Weather: small craft advisory" },
    });
    fireEvent.click(within(dialog).getByRole("button", { name: "Close sales" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    const [first, second] = posts(calls);
    expect(second?.headers.get("idempotency-key")).not.toBe(first?.headers.get("idempotency-key"));
    expect(second?.body).toEqual({ to: "closed", reason: "Weather: small craft advisory" });
  });

  it("starts a new key after the API refuses one as reused (422)", async () => {
    const calls = api({
      [tripsPath()]: [() => json({ trips: week })],
      [salesStatePath(nov5Sunset)]: [
        () => apiError(422, "idempotency_key_reused"),
        () => json({ trip: { ...nov5Sunset, salesState: "closed" } }),
      ],
    });
    render(<CalendarPage membership={membership("owner")} focusHeading={false} />);
    await screen.findByRole("region", { name: /^Thursday, November 5/ });
    const dialog = await openChange("Thursday, November 5", /Sunset/, /^Close sales/, "Weather");
    fireEvent.click(within(dialog).getByRole("button", { name: "Close sales" }));
    expect(text(await within(dialog).findByRole("alert"))).toContain(
      "That change couldn't be confirmed",
    );
    fireEvent.click(within(dialog).getByRole("button", { name: "Close sales" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    const [first, second] = posts(calls);
    expect(first?.body).toEqual(second?.body);
    expect(second?.headers.get("idempotency-key")).toMatch(uuid);
    expect(second?.headers.get("idempotency-key")).not.toBe(first?.headers.get("idempotency-key"));
  });

  it.each([
    [401, "unauthenticated", "You're signed out", "Back to calendar"],
    [403, "forbidden", "Your role can't change trips", "Back to calendar"],
    [403, "tenant_suspended", "This operator is suspended", "Back to calendar"],
    [400, "validation_failed", "Check the reason", "Close sales"],
  ] as const)("reads a %i %s on a change in plain words", async (status, code, title, button) => {
    api({
      [tripsPath()]: [() => json({ trips: week })],
      [salesStatePath(nov5Sunset)]: [() => apiError(status, code)],
    });
    render(<CalendarPage membership={membership("owner")} focusHeading={false} />);
    await screen.findByRole("region", { name: /^Thursday, November 5/ });
    const dialog = await openChange("Thursday, November 5", /Sunset/, /^Close sales/, "Weather");
    fireEvent.click(within(dialog).getByRole("button", { name: "Close sales" }));
    const alert = await within(dialog).findByRole("alert");
    expect(text(alert)).toContain(title);
    expect(text(alert)).not.toMatch(/\b40[0-3]\b|_/);
    expect(within(dialog).getByRole("button", { name: button })).toBeTruthy();
    if (status === 401) {
      const signIn = within(dialog).getByRole("link", { name: "Sign in again" });
      expect(signIn.getAttribute("href")).toBe("/");
      await waitFor(() => expect(document.activeElement).toBe(signIn));
    }
  });

  it("confirms canceling in a danger dialog, and Keep trip changes nothing", async () => {
    const calls = api({
      [tripsPath()]: [() => json({ trips: week })],
      [salesStatePath(nov6Sunset)]: [
        () => json({ trip: { ...nov6Sunset, salesState: "canceled" } }),
      ],
    });
    render(<CalendarPage membership={membership("owner")} focusHeading={false} />);
    await screen.findByRole("region", { name: /^Friday, November 6/ });
    const opener = within(rowOn("Friday, November 6", /Sunset/)).getByRole("button", {
      name: /^Cancel trip/,
    });
    opener.focus();
    fireEvent.click(opener);
    let dialog = await screen.findByRole("dialog", { name: "Cancel this trip?" });
    expect(dialog.className).toContain("tg-dialog--danger");
    expect(text(dialog)).toContain("This can't be undone");
    expect(text(dialog)).toContain("Canceling is final. Guests can't book the trip from now on");
    expect(within(dialog).getByRole("button", { name: "Cancel trip" }).className).toContain(
      "tg-button--danger",
    );
    // The danger button is the dialog's only primary action.
    expect(dialog.querySelectorAll(".tg-button--primary")).toHaveLength(0);

    fireEvent.click(within(dialog).getByRole("button", { name: "Keep trip" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(document.activeElement).toBe(opener);
    expect(posts(calls)).toEqual([]);

    fireEvent.click(opener);
    dialog = await screen.findByRole("dialog", { name: "Cancel this trip?" });
    fireEvent.change(within(dialog).getByRole("textbox", { name: "Reason" }), {
      target: { value: "Boat in the yard" },
    });
    fireEvent.click(within(dialog).getByRole("button", { name: "Cancel trip" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(posts(calls)[0]?.body).toEqual({ to: "canceled", reason: "Boat in the yard" });
    const canceled = rowOn("Friday, November 6", /Sunset/);
    expect(text(canceled)).toContain("Canceled");
    expect(within(canceled).queryAllByRole("button")).toEqual([]);
  });

  it("says plainly what canceling a departed trip, or closing a blacked-out one, means", async () => {
    api({ [tripsPath()]: [() => json({ trips: week })] });
    render(<CalendarPage membership={membership("owner")} focusHeading={false} />);
    await screen.findByRole("region", { name: /^Sunday, November 1/ });
    let dialog = await openChange("Sunday, November 1", /Charter/, /^Cancel trip/);
    expect(text(dialog)).toContain("It records that this trip did not run");
    expect(text(dialog)).not.toContain("stops selling");
    fireEvent.click(within(dialog).getByRole("button", { name: "Keep trip" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());

    dialog = await openChange("Thursday, November 5", /Sunset/, /^Close sales/);
    expect(text(dialog)).toContain("A blackout covers this trip");
    expect(within(dialog).getByText("Blacked out").closest(".tg-status")).not.toBeNull();
  });

  it("returns focus to the trip's own button, even when a click did not focus it", async () => {
    api({ [tripsPath()]: [() => json({ trips: week })] });
    render(<CalendarPage membership={membership("owner")} focusHeading={false} />);
    await screen.findByRole("region", { name: /^Thursday, November 5/ });
    // As in Safari: focus sits elsewhere, and clicking a button does not move it.
    const elsewhere = within(rowOn("Sunday, November 1", /Charter/)).getByRole("heading", {
      level: 4,
    });
    elsewhere.focus();
    const opener = within(rowOn("Thursday, November 5", /Sunset/)).getByRole("button", {
      name: /^Close sales/,
    });
    fireEvent.click(opener);
    const dialog = await screen.findByRole("dialog", { name: "Close sales?" });
    fireEvent.click(within(dialog).getByRole("button", { name: "Keep selling" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    await waitFor(() => expect(document.activeElement).toBe(opener));
  });

  it("closes on Escape without a change", async () => {
    const calls = api({ [tripsPath()]: [() => json({ trips: week })] });
    render(<CalendarPage membership={membership("owner")} focusHeading={false} />);
    await screen.findByRole("region", { name: /^Saturday, November 7/ });
    const dialog = await openChange("Saturday, November 7", /Charter/, /^Publish/);
    expect(text(dialog)).toContain(
      "Guests can book this trip until the booking cutoff, Fri, Nov 6, 8:00 AM.",
    );
    fireEvent.keyDown(dialog, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(posts(calls)).toEqual([]);
  });

  it("explains a trip_state_conflict in plain words and shows the trip as it is now", async () => {
    const nowClosed = { ...nov5Sunset, salesState: "closed" as const };
    api({
      [tripsPath()]: [
        () => json({ trips: week }),
        () => json({ trips: week.map((t) => (t.tripId === nov5Sunset.tripId ? nowClosed : t)) }),
      ],
      [salesStatePath(nov5Sunset)]: [() => apiError(409, "trip_state_conflict")],
    });
    render(<CalendarPage membership={membership("owner")} focusHeading={false} />);
    await screen.findByRole("region", { name: /^Thursday, November 5/ });
    const dialog = await openChange("Thursday, November 5", /Sunset/, /^Close sales/, "Weather");
    fireEvent.click(within(dialog).getByRole("button", { name: "Close sales" }));

    const alert = await within(dialog).findByRole("alert");
    expect(text(alert)).toContain("Someone changed this trip first");
    expect(text(alert)).toContain("It's closed now, so nothing was changed.");
    expect(text(alert)).not.toMatch(/409|trip_state_conflict/);
    // The dialog's badge now shows the state the trip is really in.
    expect(text(dialog.querySelector(".cal-dialog__trip .tg-status"))).toBe("Closed");
    // Nothing left to send: one way out, and it has focus.
    expect(within(dialog).queryByRole("button", { name: "Close sales" })).toBeNull();
    const back = within(dialog).getByRole("button", { name: "Back to calendar" });
    await waitFor(() => expect(document.activeElement).toBe(back));

    fireEvent.click(back);
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    const current = rowOn("Thursday, November 5", /Sunset/);
    expect(text(current)).toContain("Closed");
    // The button that opened the dialog is gone, so the trip keeps the place.
    expect(document.activeElement).toBe(within(current).getByRole("heading", { level: 4 }));
  });

  it("does not claim the calendar is current when the reload after a conflict fails", async () => {
    api({
      [tripsPath()]: [() => json({ trips: week }), () => apiError(500, "internal_error")],
      [salesStatePath(nov5Sunset)]: [() => apiError(409, "trip_state_conflict")],
    });
    render(<CalendarPage membership={membership("owner")} focusHeading={false} />);
    await screen.findByRole("region", { name: /^Thursday, November 5/ });
    const dialog = await openChange("Thursday, November 5", /Sunset/, /^Close sales/, "Weather");
    fireEvent.click(within(dialog).getByRole("button", { name: "Close sales" }));
    const alert = await within(dialog).findByRole("alert");
    expect(text(alert)).toContain("Reload the calendar to see the trip as it is now.");
    expect(text(alert)).not.toContain("now shows");
  });

  it("reloads the week when the API answers from an earlier, identical request", async () => {
    const calls = api({
      [tripsPath()]: [
        () => json({ trips: week }),
        () =>
          json({
            trips: week.map((t) =>
              t.tripId === nov5Sunset.tripId ? { ...nov5Sunset, salesState: "canceled" } : t,
            ),
          }),
      ],
      [salesStatePath(nov5Sunset)]: [
        // The first try's answer, stored by the API: the trip as it was then.
        () =>
          json({ trip: { ...nov5Sunset, salesState: "closed" } }, 200, {
            "Idempotent-Replayed": "true",
          }),
      ],
    });
    render(<CalendarPage membership={membership("owner")} focusHeading={false} />);
    await screen.findByRole("region", { name: /^Thursday, November 5/ });
    const dialog = await openChange("Thursday, November 5", /Sunset/, /^Close sales/, "Weather");
    fireEvent.click(within(dialog).getByRole("button", { name: "Close sales" }));
    await waitFor(() => expect(weekCalls(calls)).toHaveLength(2));
    await waitFor(() =>
      expect(text(rowOn("Thursday, November 5", /Sunset/))).toContain("Canceled"),
    );
  });

  it("explains trip_not_departed in plain words", async () => {
    // The API's clock is ahead of the browser's: it says the trip has not left yet.
    api({
      [tripsPath()]: [() => json({ trips: week })],
      [salesStatePath(nov1Charter)]: [() => apiError(409, "trip_not_departed")],
    });
    render(<CalendarPage membership={membership("owner")} focusHeading={false} />);
    await screen.findByRole("region", { name: /^Sunday, November 1/ });
    const dialog = await openChange(
      "Sunday, November 1",
      /Charter/,
      /^Mark completed/,
      "Ran as scheduled",
    );
    fireEvent.click(within(dialog).getByRole("button", { name: "Mark completed" }));
    const alert = await within(dialog).findByRole("alert");
    expect(text(alert)).toContain("This trip hasn't departed yet");
    expect(text(alert)).toContain(
      "You can mark it completed after it leaves at 8:00 AM on Sun, Nov 1.",
    );
    expect(text(alert)).not.toMatch(/409|trip_not_departed/);
  });
});

describe("a busy dialog and the browser's close requests", () => {
  /** showModal and close as a browser has them, for jsdom, which lacks both. */
  function nativeDialogs() {
    const proto = HTMLDialogElement.prototype as unknown as Record<string, unknown>;
    proto.showModal = function showModal(this: HTMLDialogElement) {
      this.setAttribute("open", "");
    };
    proto.close = function close(this: HTMLDialogElement) {
      if (!this.hasAttribute("open")) return;
      this.removeAttribute("open");
      this.dispatchEvent(new Event("close"));
    };
    return () => {
      delete proto.showModal;
      delete proto.close;
    };
  }

  it("stays open through a second Escape while busy, then closes once it is not", async () => {
    const restore = nativeDialogs();
    try {
      const post = deferred();
      api({
        [tripsPath()]: [() => json({ trips: week })],
        [salesStatePath(nov5Sunset)]: [post.answer],
      });
      render(<CalendarPage membership={membership("owner")} focusHeading={false} />);
      await screen.findByRole("region", { name: /^Thursday, November 5/ });
      const dialog = (await openChange(
        "Thursday, November 5",
        /Sunset/,
        /^Close sales/,
        "Weather",
      )) as HTMLDialogElement;
      expect(dialog.getAttribute("closedby")).toBe("closerequest");
      fireEvent.click(within(dialog).getByRole("button", { name: "Close sales" }));
      await within(dialog).findByRole("button", { name: "Closing sales…" });
      // Busy: the browser is told to ignore close requests.
      expect(dialog.getAttribute("closedby")).toBe("none");

      // An engine without closedby: a second Escape with no user activation
      // fires a cancel the page may not prevent, and the dialog closes.
      dialog.dispatchEvent(new Event("cancel", { cancelable: false }));
      dialog.close();
      expect(dialog.open).toBe(false);
      // It opens again, still showing the change in flight.
      await waitFor(() => expect(dialog.open).toBe(true));
      expect(screen.getByRole("dialog", { name: "Close sales?" })).toBe(dialog);

      // The result lands in the dialog the person can see.
      post.release(apiError(500, "internal_error"));
      const alert = await within(dialog).findByRole("alert");
      expect(text(alert)).toContain("TideGrid couldn't save the change");
      expect(dialog.open).toBe(true);
      expect(dialog.getAttribute("closedby")).toBe("closerequest");

      // Not busy any more: the same close request now closes it for good.
      dialog.dispatchEvent(new Event("cancel", { cancelable: false }));
      dialog.close();
      await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    } finally {
      restore();
    }
  });

  it("opens a fresh dialog for another trip, with no reason or key carried over", async () => {
    const calls = api({
      [tripsPath()]: [() => json({ trips: week })],
      [salesStatePath(nov6Sunset)]: [
        () => json({ trip: { ...nov6Sunset, salesState: "canceled" } }),
      ],
    });
    render(<CalendarPage membership={membership("owner")} focusHeading={false} />);
    await screen.findByRole("region", { name: /^Thursday, November 5/ });
    let dialog = await openChange("Thursday, November 5", /Sunset/, /^Cancel trip/, "Old reason");
    fireEvent.click(within(dialog).getByRole("button", { name: "Keep trip" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    dialog = await openChange("Friday, November 6", /Sunset/, /^Cancel trip/);
    expect(
      (within(dialog).getByRole("textbox", { name: "Reason" }) as HTMLInputElement).value,
    ).toBe("");
    expect(text(dialog)).toContain("Friday, November 6");
    fireEvent.change(within(dialog).getByRole("textbox", { name: "Reason" }), {
      target: { value: "New reason" },
    });
    fireEvent.click(within(dialog).getByRole("button", { name: "Cancel trip" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(posts(calls)[0]?.path).toContain(nov6Sunset.tripId);
  });
});

describe("roles", () => {
  it("gives finance the same week with no way to change a trip", async () => {
    api({ [tripsPath()]: [() => json({ trips: week })] });
    render(<CalendarPage membership={membership("finance")} focusHeading={false} />);
    await screen.findByRole("region", { name: /^Sunday, November 1/ });
    expect(document.querySelectorAll(".cal-trip")).toHaveLength(week.length);
    expect(document.querySelectorAll(".cal-trip__actions")).toHaveLength(0);
    for (const name of [
      /^Publish/,
      /^Close sales/,
      /^Reopen sales/,
      /^Cancel trip/,
      /^Mark completed/,
    ]) {
      expect(screen.queryByRole("button", { name })).toBeNull();
    }
    expect(
      screen.getByText(/View only\. Your role here, finance, can see trips but not change them\./),
    ).toBeTruthy();
  });

  it.each(["owner", "booking_staff"] as const)("lets %s change trips", async (role) => {
    api({ [tripsPath()]: [() => json({ trips: week })] });
    render(<CalendarPage membership={membership(role)} focusHeading={false} />);
    await screen.findByRole("region", { name: /^Sunday, November 1/ });
    expect(screen.getAllByRole("button", { name: /^Cancel trip/ })).toHaveLength(4);
    expect(screen.queryByText(/View only/)).toBeNull();
  });
});

describe("week rules", () => {
  it("runs weeks Sunday to Saturday and reads a week from the address", () => {
    expect(weekOf("2026-11-04")).toMatchObject({ start: "2026-11-01", end: "2026-11-07" });
    expect(readWeek("?week=2026-11-07", "2026-10-05")).toBe("2026-11-01");
    expect(readWeek("?week=nonsense", "2026-10-05")).toBe("2026-10-04");
    expect(readWeek("", "2026-10-05")).toBe("2026-10-04");
  });

  it("keeps weeks within two years of today and inside the API's dates", () => {
    const { first, last } = weekBounds("2026-10-05");
    // 730 days back is Saturday, Oct 5, 2024: its week is the first.
    expect(first).toBe("2024-09-29");
    expect(last).toBe("2028-10-01");
    expect(readWeek("?week=9999-12-27", "2026-10-05")).toBe(last);
    expect(readWeek("?week=0001-01-07", "2026-10-05")).toBe(first);
    // Near the API's last date, its own limit wins.
    expect(weekBounds("2099-06-01").last).toBe("2099-12-20");
  });

  it("offers sales changes only until the cutoff, completion after departure, nothing when final", () => {
    const at = (iso: string) => new Date(iso);
    const t = { startsAt: "2026-11-05T23:00:00.000Z", salesCloseAt: "2026-11-05T22:00:00.000Z" };
    expect(actionsFor({ ...t, salesState: "published" }, at("2026-11-05T21:59:00Z"))).toEqual([
      "close",
      "cancel",
    ]);
    // Past the cutoff, before departure: guests can't book either way, so only cancel.
    expect(actionsFor({ ...t, salesState: "published" }, at("2026-11-05T22:00:00Z"))).toEqual([
      "cancel",
    ]);
    expect(actionsFor({ ...t, salesState: "closed" }, at("2026-11-05T22:30:00Z"))).toEqual([
      "cancel",
    ]);
    expect(actionsFor({ ...t, salesState: "published" }, at("2026-11-05T23:00:00Z"))).toEqual([
      "complete",
      "cancel",
    ]);
    expect(actionsFor({ ...t, salesState: "draft" }, at("2026-11-05T23:00:00Z"))).toEqual([
      "cancel",
    ]);
    expect(actionsFor({ ...t, salesState: "canceled" }, at("2026-11-01T00:00:00Z"))).toEqual([]);
    expect(actionsFor({ ...t, salesState: "completed" }, at("2026-12-01T00:00:00Z"))).toEqual([]);
  });

  it("words each change for the trip as it is", () => {
    const open = { cutoff: "5:00 PM", cutoffPassed: false, departed: false, blackedOut: false };
    expect(consequence("reopen", open)).toBe(
      "Guests can book this trip again until the booking cutoff, 5:00 PM.",
    );
    expect(consequence("publish", { ...open, blackedOut: true })).toContain(
      "guests can't see or book it while the blackout applies",
    );
    expect(consequence("cancel", { ...open, cutoffPassed: true })).toContain(
      "Online booking for this trip has already closed",
    );
    expect(consequence("cancel", { ...open, cutoffPassed: true, departed: true })).toContain(
      "did not run",
    );
    expect(capacityText(nov5Sunset, false)).toBe("20 of 20 seats left");
    expect(capacityText(nov5Sunset, true)).toBe("20 seats");
    expect(capacityText(nov2Sunset, false)).toBe("20 seats");
  });
});
