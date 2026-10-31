// @vitest-environment jsdom

// Staff in Tokyo looking at a New York marina: times must stay New York's.
process.env.TZ = "Asia/Tokyo";

import { cleanup, render, screen } from "@testing-library/react";
import type { BookingDetail, StaffRole } from "@tidegrid/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NavigationProvider } from "../navigation.tsx";
import { BookingDetailPage } from "./BookingDetail.tsx";
import {
  api,
  asSeenBy,
  bookingDetail,
  bookingIds,
  json,
  membership,
  route,
  strayRequests,
  text,
} from "./fixtures.ts";

/**
 * G2.12e fix round: a booking's lede says where it came from as its Source
 * row does, and its link back to the day's list keeps the list's source
 * filter when the address carries it. Kept apart from BookingDetail.test.tsx.
 */

const bookingId = bookingIds.maya;

function renderDetail(role: StaffRole = "owner") {
  render(
    <NavigationProvider navigate={vi.fn()}>
      <BookingDetailPage membership={membership(role)} bookingId={bookingId} focusHeading={false} />
    </NavigationProvider>,
  );
}

const answer = (role: StaffRole, booking: BookingDetail) => () => json(asSeenBy(role, { booking }));
const loaded = () => screen.findByRole("heading", { level: 1, name: /^Booking [0-9A-Z]{8}$/ });
const lede = () => text(document.querySelector(".bd-lede"));
const back = () => screen.getByRole("link", { name: "Bookings on Wed, Nov 4" });

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-11-04T17:00:00Z"));
  window.history.replaceState(null, "", `/bookings/${bookingId}`);
});

afterEach(() => {
  const strays = strayRequests();
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  expect(strays).toEqual([]);
});

describe("where a booking came from, in its lede (G2.12e)", () => {
  it.each([
    ["phone", "Staff booking, phone."],
    ["walk_up", "Staff booking, walk-up."],
    [null, "Staff booking."],
  ] as const)("says a staff booking taken by %s is one", async (channel, said) => {
    api({
      [route.booking(bookingId)]: answer(
        "finance",
        bookingDetail({ source: "staff_assisted", channel }),
      ),
    });
    renderDetail("finance");
    await loaded();
    expect(lede()).toBe(`${said} Confirmed Tue, Oct 6, 2:17 PM EDT.`);
    expect(lede()).not.toContain("online");
  });

  it("still says a guest's own booking was booked online", async () => {
    api({ [route.booking(bookingId)]: answer("owner", bookingDetail()) });
    renderDetail("owner");
    await loaded();
    expect(lede()).toBe("Booked online by the guest. Confirmed Tue, Oct 6, 2:17 PM EDT.");
  });
});

describe("the way back to a filtered list (G2.12e)", () => {
  it.each(["direct", "staff_assisted"])(
    "keeps source=%s from the address on the link back to the day",
    async (source) => {
      window.history.replaceState(null, "", `/bookings/${bookingId}?source=${source}`);
      api({ [route.booking(bookingId)]: answer("owner", bookingDetail()) });
      renderDetail("owner");
      await loaded();
      expect(back().getAttribute("href")).toBe(`/bookings?day=2026-11-04&source=${source}`);
    },
  );

  it.each(["", "?source=bogus", "?source=STAFF_ASSISTED"])(
    "links back to the whole day from %j",
    async (search) => {
      window.history.replaceState(null, "", `/bookings/${bookingId}${search}`);
      api({ [route.booking(bookingId)]: answer("owner", bookingDetail()) });
      renderDetail("owner");
      await loaded();
      expect(back().getAttribute("href")).toBe("/bookings?day=2026-11-04");
    },
  );
});
