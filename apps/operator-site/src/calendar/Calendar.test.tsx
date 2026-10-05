// @vitest-environment jsdom

// Staff in Tokyo looking at a New York marina: times must stay New York's.
process.env.TZ = "Asia/Tokyo";

import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { Membership, StaffRole, StaffTrip } from "@tidegrid/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CalendarPage } from "./Calendar.tsx";
import { actionsFor, readWeek, weekOf } from "./model.ts";

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

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const apiError = (status: number, code: string) =>
  json({ error: { code, message: "x", requestId: "r" } }, status);

type Answer = (init: RequestInit | undefined) => Response | Promise<Response>;
interface Call {
  method: string;
  path: string;
  query: URLSearchParams;
  headers: Headers;
  body: unknown;
}

/** A fetch that answers "METHOD /path" from per-route queues and records every call. */
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
      const answer = routes[key]?.shift();
      if (!answer) throw new Error(`unexpected request ${key}`);
      return answer(init);
    }),
  );
  return calls;
}

const tripsPath = (tenant = harbor) => `GET /api/v1/staff/tenants/${tenant}/trips`;
const salesStatePath = (t: StaffTrip, tenant = harbor) =>
  `POST /api/v1/staff/tenants/${tenant}/trips/${t.tripId}/sales-state`;

const text = (element: Element | null) => (element?.textContent ?? "").replace(/\s+/g, " ").trim();

/** The list item of a trip, found by its day and its heading. */
function rowOn(dayHeading: string, name: RegExp): HTMLElement {
  const day = screen.getByRole("region", { name: new RegExp(`^${dayHeading}`) });
  return within(day).getByRole("heading", { level: 4, name }).closest("li") as HTMLElement;
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
    expect(calls[0]?.query.get("from")).toBe("2026-11-01");
    expect(calls[0]?.query.get("to")).toBe("2026-11-07");
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
    await screen.findByRole("heading", { name: "No trips this week" });
    expect(calls[1]?.query.get("from")).toBe("2026-11-08");
    expect(calls[1]?.query.get("to")).toBe("2026-11-14");
    expect(window.location.search).toBe("?week=2026-11-08");

    fireEvent.click(screen.getByRole("button", { name: "Next week" }));
    await waitFor(() => expect(calls).toHaveLength(3));
    expect(calls[2]?.query.get("from")).toBe("2026-11-15");

    fireEvent.click(screen.getByRole("button", { name: "This week" }));
    await screen.findByRole("region", { name: /^Sunday, November 1/ });
    expect(calls[3]?.query.get("from")).toBe("2026-11-01");
    expect(window.location.search).toBe("");
  });

  it("opens on the week in the address, and Previous crosses the clock change", async () => {
    window.history.replaceState(null, "", "/calendar?week=2026-11-04");
    const calls = api({
      [tripsPath()]: [() => json({ trips: week }), () => json({ trips: [] })],
    });
    render(<CalendarPage membership={membership("owner")} focusHeading={false} />);
    await screen.findByRole("region", { name: /^Sunday, November 1/ });
    expect(calls[0]?.query.get("from")).toBe("2026-11-01");
    fireEvent.click(screen.getByRole("button", { name: "Previous week" }));
    await screen.findByRole("heading", { name: "No trips this week" });
    expect(calls[1]?.query.get("from")).toBe("2026-10-25");
    expect(calls[1]?.query.get("to")).toBe("2026-10-31");
  });

  it("shows a designed error, keeps focus on Try again while it works, then focuses the week", async () => {
    let release: (res: Response) => void = () => {};
    api({
      [tripsPath()]: [
        () => {
          throw new TypeError("Failed to fetch");
        },
        () =>
          new Promise<Response>((resolve) => {
            release = resolve;
          }),
      ],
    });
    render(<CalendarPage membership={membership("owner")} focusHeading={false} />);
    const alert = await screen.findByRole("alert");
    expect(text(alert)).toContain("The calendar can't reach TideGrid");
    const retry = screen.getByRole("button", { name: "Try again" });
    retry.focus();
    fireEvent.click(retry);
    expect(await screen.findByRole("button", { name: "Trying again…" })).toBe(retry);
    expect(document.activeElement).toBe(retry);
    release(json({ trips: week }));
    const range = await screen.findByRole("heading", { level: 2, name: "Nov 1 to 7, 2026" });
    await waitFor(() => expect(document.activeElement).toBe(range));
  });

  it("sends a signed-out person to sign in again", async () => {
    api({ [tripsPath()]: [() => apiError(401, "unauthenticated")] });
    render(<CalendarPage membership={membership("owner")} focusHeading={false} />);
    expect(text(await screen.findByRole("alert"))).toContain("You're signed out");
    expect(screen.getByRole("link", { name: "Sign in again" }).getAttribute("href")).toBe("/");
  });
});

describe("changing a trip", () => {
  it("requires a reason before sending anything", async () => {
    const calls = api({ [tripsPath()]: [() => json({ trips: week })] });
    render(<CalendarPage membership={membership("booking_staff")} focusHeading={false} />);
    await screen.findByRole("region", { name: /^Thursday, November 5/ });
    fireEvent.click(
      within(rowOn("Thursday, November 5", /Sunset/)).getByRole("button", { name: /^Close sales/ }),
    );
    const dialog = await screen.findByRole("dialog", { name: "Close sales?" });
    const reason = within(dialog).getByRole("textbox", { name: "Reason" });
    expect(document.activeElement).toBe(reason);

    fireEvent.click(within(dialog).getByRole("button", { name: "Close sales" }));
    expect(text(dialog)).toContain("Enter a reason. It's saved in the audit history.");
    expect(reason.getAttribute("aria-invalid")).toBe("true");
    fireEvent.change(reason, { target: { value: "   " } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Close sales" }));
    expect(calls.filter((c) => c.method === "POST")).toEqual([]);
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

    fireEvent.click(
      within(rowOn("Thursday, November 5", /Sunset/)).getByRole("button", { name: /^Close sales/ }),
    );
    let dialog = await screen.findByRole("dialog", { name: "Close sales?" });
    fireEvent.change(within(dialog).getByRole("textbox", { name: "Reason" }), {
      target: { value: "Small craft advisory" },
    });
    fireEvent.click(within(dialog).getByRole("button", { name: "Close sales" }));
    expect(text(await within(dialog).findByRole("alert"))).toContain(
      "The change didn't reach TideGrid",
    );
    // The same change again: the same key, so the API applies it once.
    fireEvent.click(within(dialog).getByRole("button", { name: "Close sales" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());

    const posts = calls.filter((c) => c.method === "POST");
    expect(posts).toHaveLength(2);
    const firstKey = posts[0]?.headers.get("idempotency-key") ?? "";
    expect(firstKey).toMatch(uuid);
    expect(posts[1]?.headers.get("idempotency-key")).toBe(firstKey);
    expect(posts[0]?.headers.get("content-type")).toBe("application/json");
    expect(posts[0]?.body).toEqual({ to: "closed", reason: "Small craft advisory" });

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
    fireEvent.click(within(updated).getByRole("button", { name: /^Reopen sales/ }));
    dialog = await screen.findByRole("dialog", { name: "Reopen sales?" });
    fireEvent.change(within(dialog).getByRole("textbox", { name: "Reason" }), {
      target: { value: "Advisory lifted" },
    });
    fireEvent.click(within(dialog).getByRole("button", { name: "Reopen sales" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    const third = calls.filter((c) => c.method === "POST")[2];
    expect(third?.headers.get("idempotency-key")).toMatch(uuid);
    expect(third?.headers.get("idempotency-key")).not.toBe(firstKey);
    expect(third?.body).toEqual({ to: "published", reason: "Advisory lifted" });
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
    expect(text(dialog)).toContain("Canceling is final.");
    expect(within(dialog).getByRole("button", { name: "Cancel trip" }).className).toContain(
      "tg-button--danger",
    );
    // The danger button is the dialog's only primary action.
    expect(dialog.querySelectorAll(".tg-button--primary")).toHaveLength(0);

    fireEvent.click(within(dialog).getByRole("button", { name: "Keep trip" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(document.activeElement).toBe(opener);
    expect(calls.filter((c) => c.method === "POST")).toEqual([]);

    fireEvent.click(opener);
    dialog = await screen.findByRole("dialog", { name: "Cancel this trip?" });
    fireEvent.change(within(dialog).getByRole("textbox", { name: "Reason" }), {
      target: { value: "Boat in the yard" },
    });
    fireEvent.click(within(dialog).getByRole("button", { name: "Cancel trip" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(calls.filter((c) => c.method === "POST")[0]?.body).toEqual({
      to: "canceled",
      reason: "Boat in the yard",
    });
    const canceled = rowOn("Friday, November 6", /Sunset/);
    expect(text(canceled)).toContain("Canceled");
    expect(within(canceled).queryAllByRole("button")).toEqual([]);
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
    fireEvent.click(
      within(rowOn("Saturday, November 7", /Charter/)).getByRole("button", { name: /^Publish/ }),
    );
    const dialog = await screen.findByRole("dialog", { name: "Publish this trip?" });
    expect(text(dialog)).toContain(
      "Guests can book this trip until the booking cutoff, Fri, Nov 6, 8:00 AM.",
    );
    fireEvent.keyDown(dialog, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(calls.filter((c) => c.method === "POST")).toEqual([]);
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
    fireEvent.click(
      within(rowOn("Thursday, November 5", /Sunset/)).getByRole("button", { name: /^Close sales/ }),
    );
    const dialog = await screen.findByRole("dialog", { name: "Close sales?" });
    fireEvent.change(within(dialog).getByRole("textbox", { name: "Reason" }), {
      target: { value: "Weather" },
    });
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

  it("explains trip_not_departed in plain words", async () => {
    // The API's clock is ahead of the browser's: it says the trip has not left yet.
    api({
      [tripsPath()]: [() => json({ trips: week })],
      [salesStatePath(nov1Charter)]: [() => apiError(409, "trip_not_departed")],
    });
    render(<CalendarPage membership={membership("owner")} focusHeading={false} />);
    await screen.findByRole("region", { name: /^Sunday, November 1/ });
    fireEvent.click(
      within(rowOn("Sunday, November 1", /Charter/)).getByRole("button", {
        name: /^Mark completed/,
      }),
    );
    const dialog = await screen.findByRole("dialog", { name: "Mark this trip completed?" });
    fireEvent.change(within(dialog).getByRole("textbox", { name: "Reason" }), {
      target: { value: "Ran as scheduled" },
    });
    fireEvent.click(within(dialog).getByRole("button", { name: "Mark completed" }));
    const alert = await within(dialog).findByRole("alert");
    expect(text(alert)).toContain("This trip hasn't departed yet");
    expect(text(alert)).toContain(
      "You can mark it completed after it leaves at 8:00 AM on Sun, Nov 1.",
    );
    expect(text(alert)).not.toMatch(/409|trip_not_departed/);
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

  it("completes only after departure and never changes a final trip", () => {
    const at = (iso: string) => new Date(iso);
    const t = { startsAt: "2026-11-05T23:00:00.000Z" };
    expect(actionsFor({ ...t, salesState: "published" }, at("2026-11-05T22:59:00Z"))).toEqual([
      "close",
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
});
