// @vitest-environment jsdom

// Staff in Tokyo looking at a New York marina: times must stay New York's.
process.env.TZ = "Asia/Tokyo";

import { cleanup, render, screen, within } from "@testing-library/react";
import type { BookingListItem } from "@tidegrid/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NavigationProvider } from "../navigation.tsx";
import { BookingsPage } from "./BookingsPage.tsx";
import {
  api,
  dayBody,
  json,
  luisBooking,
  mayaBooking,
  membership,
  route,
  strayRequests,
  sunsetTrip,
  text,
} from "./fixtures.ts";

/**
 * A day's list once guests can cancel (lane 1, G2.11c). A canceled booking
 * still lists under its trip, with its badge, while the counts are of active
 * bookings, the ones holding seats. A count of none says "active" when a
 * canceled booking shows below it, so the line never contradicts the list.
 */

/** Maya's booking, canceled before the cutoff and refunded in full. */
const canceledMaya: BookingListItem = {
  ...mayaBooking,
  state: "canceled",
  payment: { state: "succeeded", refund: { state: "succeeded", amount: mayaBooking.total } },
};

function renderPage() {
  return render(
    <NavigationProvider navigate={vi.fn()}>
      <BookingsPage membership={membership("owner")} focusHeading={false} />
    </NavigationProvider>,
  );
}

const tripSection = (name: RegExp) => screen.findByRole("region", { name });
const rowsOf = (section: HTMLElement) => within(section).queryAllByRole("listitem");
const badges = (element: Element) =>
  [...element.querySelectorAll(".tg-status")].map((badge) => text(badge));
const parts = (element: Element | null) =>
  [...(element?.children ?? [])].map((child) => text(child));
const liveText = () => text(document.querySelector('.bk > p[role="status"]'));
const totalsText = () => text(document.querySelector(".bk-filters__totals"));

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  // Wednesday noon in New York: the sunset cruise is still to come.
  vi.setSystemTime(new Date("2026-11-04T17:00:00Z"));
  window.history.replaceState(null, "", "/bookings");
});

afterEach(() => {
  const strays = strayRequests();
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  expect(strays).toEqual([]);
});

describe("a canceled booking in the day's list", () => {
  it("lists beside the active ones with its own badge, and only the active ones count", async () => {
    api({
      [route.day()]: () =>
        json(
          dayBody({
            // The API counts Luis's party alone: Maya's seats went back on sale.
            trips: [{ ...sunsetTrip, bookings: 1, guests: 2 }],
            bookings: [canceledMaya, luisBooking],
          }),
        ),
    });
    renderPage();
    const sunset = await tripSection(/Sunset Harbor Cruise/);

    const [maya, luis] = rowsOf(sunset);
    expect(rowsOf(sunset)).toHaveLength(2);
    expect(badges(maya as HTMLElement)).toEqual(["Refunded", "Canceled"]);
    expect(badges(luis as HTMLElement)).toEqual(["Refunded", "Confirmed"]);

    expect(parts(sunset.querySelector(".bk-trip__meta"))).toEqual([
      "Boat: Sea Lark",
      "1 booking, 2 guests",
    ]);
    expect(totalsText()).toBe("1 booking, 2 guests");
    expect(liveText()).toBe("1 booking, 2 guests on Wednesday, November 4.");
    // The roster is of the active booking.
    expect(within(sunset).getByRole("link", { name: /^Roster/ })).toBeTruthy();
  });

  it("says no active bookings, not none yet, when every booking on the trip is canceled", async () => {
    api({
      [route.day()]: () =>
        json(
          dayBody({
            trips: [{ ...sunsetTrip, bookings: 0, guests: 0 }],
            bookings: [canceledMaya],
          }),
        ),
    });
    renderPage();
    const sunset = await tripSection(/Sunset Harbor Cruise/);

    expect(rowsOf(sunset)).toHaveLength(1);
    expect(badges(rowsOf(sunset)[0] as HTMLElement)).toEqual(["Refunded", "Canceled"]);
    expect(parts(sunset.querySelector(".bk-trip__meta"))).toEqual([
      "Boat: Sea Lark",
      "No active bookings",
    ]);
    expect(sunset.textContent).not.toContain("No bookings yet");
    expect(sunset.querySelector(".tg-empty")).toBeNull();
    expect(within(sunset).queryByRole("link", { name: /^Roster/ })).toBeNull();
    expect(totalsText()).toBe("No active bookings");
    expect(liveText()).toBe("No active bookings on Wednesday, November 4.");
  });

  it("keeps the plain words for a day with nothing canceled", async () => {
    api({
      [route.day()]: () =>
        json(dayBody({ trips: [{ ...sunsetTrip, bookings: 0, guests: 0 }], bookings: [] })),
    });
    renderPage();
    const sunset = await tripSection(/Sunset Harbor Cruise/);
    expect(parts(sunset.querySelector(".bk-trip__meta"))).toEqual([
      "Boat: Sea Lark",
      "No bookings yet",
    ]);
    expect(totalsText()).toBe("0 bookings, 0 guests");
    expect(liveText()).toBe("No bookings on Wednesday, November 4.");
  });

  it("still refuses a booking state it does not know", async () => {
    api({
      [route.day()]: () =>
        json(dayBody({ bookings: [{ ...luisBooking, state: "deleted" as "canceled" }] })),
    });
    renderPage();
    expect(
      await screen.findByText(
        "TideGrid sent something this console can't read. Try again in a moment.",
      ),
    ).toBeTruthy();
  });
});
