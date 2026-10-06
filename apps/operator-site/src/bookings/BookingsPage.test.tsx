// @vitest-environment jsdom

// Staff in Tokyo looking at a New York marina: times must stay New York's.
process.env.TZ = "Asia/Tokyo";

import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { StaffRole } from "@tidegrid/contracts";
import { StrictMode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NavigationProvider } from "../navigation.tsx";
import { BookingsPage } from "./BookingsPage.tsx";
import {
  type Answer,
  api,
  apiError,
  asSeenBy,
  bookers,
  bookingIds,
  callsTo,
  catalog,
  charterTrip,
  dayBody,
  deferred,
  dropped,
  expectNoPersonalDataInAddresses,
  honoluluTrip,
  json,
  luisBooking,
  marinaZone,
  mayaBooking,
  membership,
  personalFragments,
  priyaBooking,
  quietTrip,
  route,
  strayRequests,
  sunsetTrip,
  tenantName,
  terms,
  text,
  tripIds,
} from "./fixtures.ts";

const wednesday = "2026-11-04";
/** The quiet trip, moved to 8 PM: still to come at this noon. */
const eveningQuietTrip = {
  ...quietTrip,
  localStartTime: "20:00",
  startsAt: "2026-11-05T01:00:00.000Z",
};

/** The page in a navigation provider, so a link's destination is recorded. */
function renderPage(role: StaffRole = "owner", options: { strict?: boolean } = {}) {
  const navigate = vi.fn();
  const page = (
    <NavigationProvider navigate={navigate}>
      <BookingsPage membership={membership(role)} focusHeading={false} />
    </NavigationProvider>
  );
  const view = render(options.strict ? <StrictMode>{page}</StrictMode> : page);
  return { navigate, ...view };
}

/** An answer for the day's list for any date: the Wednesday data, or an empty day. */
const listFor =
  (role: StaffRole = "owner"): Answer =>
  (call) =>
    json(
      asSeenBy(
        role,
        call.query.get("date") === wednesday
          ? dayBody()
          : dayBody({ date: call.query.get("date") ?? "", trips: [], bookings: [] }),
      ),
    );

const dayHeading = (name: RegExp | string) => screen.findByRole("heading", { level: 2, name });
const tripSection = (name: RegExp) => screen.findByRole("region", { name });
const rowsOf = (section: HTMLElement) => within(section).queryAllByRole("listitem");
const badges = (element: Element) =>
  [...element.querySelectorAll(".tg-status")].map((badge) => text(badge));
/** A booking's facts by label; its two status badges read as one "Paid, Confirmed". */
const factsOf = (row: Element): Record<string, string> => ({
  ...terms(row.querySelector("dl")),
  ...(row.querySelector(".bk-badges") ? { Status: badges(row).join(", ") } : {}),
});
/** The texts of an element's children, for lines made of flex items with no space between. */
const parts = (element: Element | null) =>
  [...(element?.children ?? [])].map((child) => text(child));
const liveText = () => text(document.querySelector('.bk > p[role="status"]'));
/** Quick find's live region, apart from the list's. */
const findLiveText = () => text(document.querySelector('search p[role="status"]'));
/** A problem with a find, as shown under the field. */
const problemText = ".bk-find .tg-field__error span";
const dayRequests = (calls: ReturnType<typeof api>) =>
  callsTo(calls, route.day()).map((c) => c.query.toString());

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  // Wednesday noon in New York, which is already Thursday 2 AM in Tokyo.
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

describe("which day the list opens on", () => {
  it("asks for the marina's today, not the viewer's, once the catalog names its zone", async () => {
    // The premise: here it is Thursday, while at the marina it is Wednesday.
    expect(new Date().getDate()).toBe(5);
    const calls = api({ [route.day()]: () => json(dayBody()) });
    renderPage();
    const heading = await dayHeading(/^Wednesday, November 4/);
    expect(text(heading)).toBe("Wednesday, November 4 Today");
    await tripSection(/Sunset Harbor Cruise/);
    // The zone first, then the day in that zone.
    expect(calls.map((c) => c.path.split("/").pop())).toEqual(["catalog", "bookings"]);
    const [, asked] = calls;
    expect(asked?.query.get("date")).toBe(wednesday);
    expect(asked?.query.has("tripId")).toBe(false);
    expect(asked?.query.has("after")).toBe(false);
    // Today is the default, so it is not written into the address.
    expect(window.location.search).toBe("");
    expect(screen.getByRole("button", { name: "Today" }).getAttribute("aria-disabled")).toBe(
      "true",
    );
  });

  it("says it is loading, with the day's controls unavailable, until the marina's day is known", async () => {
    const zone = deferred();
    const calls = api({
      [route.catalog()]: [zone.answer],
      [route.day()]: () => json(dayBody()),
    });
    renderPage();
    expect(liveText()).toBe("Loading bookings…");
    expect(text(document.querySelector(".bk-bar__day"))).toBe("");
    expect(document.querySelector(".bk-skeleton")?.getAttribute("aria-hidden")).toBe("true");
    for (const name of ["Previous day", "Today", "Next day"]) {
      expect(screen.getByRole("button", { name }).getAttribute("aria-disabled"), name).toBe("true");
    }
    // Nothing is asked for before the zone says which day is today.
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(callsTo(calls, route.day())).toEqual([]);
    zone.release(catalog());
    await tripSection(/Sunset Harbor Cruise/);
    expect(callsTo(calls, route.day())).toHaveLength(1);
    expect(
      screen.getByRole("button", { name: "Next day" }).getAttribute("aria-disabled"),
    ).toBeNull();
  });

  it("opens the day and its bookings while React runs effects twice in development", async () => {
    // The console's entry point wraps everything in StrictMode, which starts every load twice.
    const calls = api({ [route.day()]: () => json(dayBody()) });
    renderPage("owner", { strict: true });
    await tripSection(/Sunset Harbor Cruise/);
    expect(rowsOf(await tripSection(/Private Half-Day Charter/))).toHaveLength(1);
    expect(text(document.querySelector(".bk-bar__day"))).toBe("Wednesday, November 4 Today");
    expect(new Set(dayRequests(calls))).toEqual(new Set([`date=${wednesday}`]));
    expect(window.location.search).toBe("");
  });

  it("opens on the day in the address without waiting for the catalog", async () => {
    window.history.replaceState(null, "", "/bookings?day=2026-11-10");
    // The catalog never answers; the day in the address needs no zone to be asked for.
    const calls = api({
      [route.catalog()]: [deferred().answer],
      [route.day()]: listFor(),
    });
    renderPage();
    await dayHeading("Tuesday, November 10");
    await screen.findByRole("heading", { name: "No trips on Tuesday, November 10" });
    expect(dayRequests(calls)).toEqual(["date=2026-11-10"]);
    expect(window.location.search).toBe("?day=2026-11-10");
    expect(screen.getByRole("button", { name: "Today" }).getAttribute("aria-disabled")).toBeNull();
  });

  it("falls back to the viewer's day when the catalog cannot be read", async () => {
    const calls = api({
      [route.catalog()]: [() => apiError(500, "internal_error")],
      [route.day()]: listFor(),
    });
    renderPage();
    await screen.findByRole("heading", { name: "No trips on Thursday, November 5" });
    expect(dayRequests(calls)).toEqual(["date=2026-11-05"]);
  });

  it("reads the marina's zone from the first trip when it did not come from the catalog", async () => {
    // Without a catalog the viewer's Thursday is asked for; its trips say the marina is in New York.
    const calls = api({
      [route.catalog()]: [() => apiError(500, "internal_error")],
      [route.day()]: () => json(dayBody({ date: "2026-11-05", trips: [sunsetTrip], bookings: [] })),
    });
    renderPage();
    await tripSection(/Sunset Harbor Cruise/);
    expect(dayRequests(calls)).toEqual(["date=2026-11-05"]);
    // Now the page knows it is Wednesday at the marina, so Thursday is not today.
    const heading = await dayHeading(/^Thursday, November 5/);
    expect(text(heading)).toBe("Thursday, November 5");
    expect(screen.getByRole("button", { name: "Today" }).getAttribute("aria-disabled")).toBeNull();
    expect(window.location.search).toBe("?day=2026-11-05");
  });

  it("keeps an address's day within two years of today", async () => {
    // At 5 AM UTC it is the same date in New York and Tokyo, so the bounds are exact.
    vi.setSystemTime(new Date("2026-11-04T05:00:00Z"));
    window.history.replaceState(null, "", "/bookings?day=9999-12-31");
    const calls = api({ [route.day()]: listFor() });
    renderPage();
    await screen.findByRole("heading", { name: /^No trips on / });
    expect(dayRequests(calls)).toEqual(["date=2028-11-03"]);
    // The address is written once the catalog has said where the marina is.
    await waitFor(() => expect(window.location.search).toBe("?day=2028-11-03"));
    // Another year is named.
    expect(text(document.querySelector(".bk-bar__day"))).toBe("Friday, November 3, 2028");
    expect(screen.getByRole("button", { name: "Next day" }).getAttribute("aria-disabled")).toBe(
      "true",
    );
    expect(
      screen.getByRole("button", { name: "Previous day" }).getAttribute("aria-disabled"),
    ).toBeNull();
  });

  it("opens on the marina's today when the day in the address is not a date", async () => {
    window.history.replaceState(null, "", "/bookings?day=soon");
    const calls = api({ [route.day()]: listFor() });
    renderPage();
    await waitFor(() => expect(callsTo(calls, route.day())).not.toHaveLength(0));
    expect(dayRequests(calls)).toEqual([`date=${wednesday}`]);
    await tripSection(/Sunset Harbor Cruise/);
    expect(window.location.search).toBe("");
  });
});

describe("the day's trips and bookings", () => {
  it("groups each trip's bookings under its time, product, boat, and counts", async () => {
    api({ [route.day()]: () => json(dayBody()) });
    renderPage();
    const charter = await tripSection(/Private Half-Day Charter/);
    const sunset = await tripSection(/Sunset Harbor Cruise/);

    // The marina's clock, not Tokyo's, in departure order.
    expect(text(within(charter).getByRole("heading", { level: 3 }))).toBe(
      "8:00 AM, Private Half-Day Charter",
    );
    expect(text(within(sunset).getByRole("heading", { level: 3 }))).toBe(
      "6:00 PM, Sunset Harbor Cruise",
    );
    const order = screen.getAllByRole("heading", { level: 3 }).map((h) => text(h));
    expect(order).toEqual(["8:00 AM, Private Half-Day Charter", "6:00 PM, Sunset Harbor Cruise"]);

    expect(parts(charter.querySelector(".bk-trip__meta"))).toEqual([
      "Boat: Blue Heron",
      "1 booking, 6 guests",
    ]);
    expect(parts(sunset.querySelector(".bk-trip__meta"))).toEqual([
      "Boat: Sea Lark",
      "2 bookings, 5 guests",
    ]);

    // Each booking sits under its own trip, in the API's order.
    expect(rowsOf(charter).map((row) => text(row.querySelector(".bk-row__ref")))).toEqual([
      "Booking 3ZRB8N4C",
    ]);
    expect(rowsOf(sunset).map((row) => text(row.querySelector(".bk-row__ref")))).toEqual([
      "Booking QKG6ERBF",
      "Booking 7HM2P9TW",
    ]);
    const [maya, luis] = rowsOf(sunset);
    expect(factsOf(maya as HTMLElement)).toEqual({
      Booker: "Maya Okonkwo",
      Party: "3 guests 2 Adult, 1 Child (3 to 12)",
      Extras: "1 Souvenir photo",
      Total: "$131.09",
      Status: "Paid, Confirmed",
    });
    expect(badges(maya as HTMLElement)).toEqual(["Paid", "Confirmed"]);
    expect(factsOf(luis as HTMLElement)).toMatchObject({
      Party: "2 guests 2 Adult",
      Extras: "1 Souvenir photo, 2 Drink voucher",
      Total: "$94.50",
    });
    expect(badges(luis as HTMLElement)).toEqual(["Refunded", "Confirmed"]);
    expect(factsOf(rowsOf(charter)[0] as HTMLElement)).toMatchObject({
      Booker: "Priya Raman",
      Party: "6 guests Whole boat, up to 12 guests",
      Extras: "None",
      Total: "$1,265.00",
    });

    // A booking's link is its id, read as "Booking" and its reference.
    // (The hidden word and the reference are joined by a space the test tool's name
    // computation trims; a browser keeps it.)
    const link = within(sunset).getByRole("link", { name: /^Booking\s?QKG6ERBF$/ });
    expect(link.getAttribute("href")).toBe(`/bookings/${bookingIds.maya}`);

    // The day as a whole, and what a screen reader hears once it loads.
    expect(text(document.querySelector(".bk-filters__totals"))).toBe("3 bookings, 11 guests");
    expect(text(document.querySelector(".bk-zone"))).toBe(
      "Times are local to New York, where these trips depart.",
    );
    expect(liveText()).toBe("3 bookings, 11 guests on Wednesday, November 4.");
  });

  it("says a published trip needs no badge, and a canceled one with bookings is marked", async () => {
    api({
      [route.day()]: () =>
        json(dayBody({ trips: [charterTrip, { ...sunsetTrip, salesState: "canceled" }] })),
    });
    renderPage();
    const charter = await tripSection(/Private Half-Day Charter/);
    const sunset = await tripSection(/Sunset Harbor Cruise/);
    expect(badges(charter.querySelector(".bk-trip__head") as Element)).toEqual([]);
    expect(badges(sunset.querySelector(".bk-trip__head") as Element)).toEqual(["Canceled"]);
    // Its bookings are still listed: guests hold them.
    expect(rowsOf(sunset)).toHaveLength(2);
  });

  it("offers each trip's roster to roles that can see guests, and only where there are bookings", async () => {
    api({
      [route.day()]: () => json(dayBody({ trips: [honoluluTrip, charterTrip, sunsetTrip] })),
    });
    renderPage();
    const sunset = await tripSection(/Sunset Harbor Cruise/);
    const roster = within(sunset).getByRole("link", {
      name: /^Roster for Sunset Harbor Cruise, Wed, Nov 4, 6:00\sPM$/,
    });
    expect(roster.getAttribute("href")).toBe(`/trips/${tripIds.sunset}/roster`);
    expect(screen.getAllByRole("link", { name: /^Roster/ })).toHaveLength(2);
    const dive = await tripSection(/Two-Tank Morning Dive/);
    expect(within(dive).queryByRole("link", { name: /^Roster/ })).toBeNull();
  });

  it("says a trip with nothing booked has no bookings in its own line, with no table or roster", async () => {
    api({
      [route.day()]: () =>
        json(dayBody({ trips: [quietTrip, charterTrip], bookings: [priyaBooking] })),
    });
    renderPage();
    const quiet = await tripSection(/Early Harbor Tour/);
    // It left at 7 AM, before this noon, so it takes no more: not "yet".
    expect(parts(quiet.querySelector(".bk-trip__meta"))).toEqual(["Boat: Gull", "No bookings"]);
    expect(quiet.textContent).not.toContain("0 bookings");
    expect(quiet.textContent).not.toContain("0 guests");
    expect(quiet.querySelector(".bk-trip__none")).toBeNull();
    expect(quiet.querySelector(".bk-table")).toBeNull();
    expect(within(quiet).queryByRole("link", { name: /^Roster/ })).toBeNull();
    expect(text(document.querySelector(".bk-filters__totals"))).toBe("1 booking, 6 guests");
  });

  it("still says nothing is booked for a trip with none while more bookings are on a later page", async () => {
    api({
      [route.day()]: () =>
        json(
          dayBody({
            trips: [quietTrip, charterTrip],
            bookings: [priyaBooking],
            nextAfter: bookingIds.priya,
          }),
        ),
    });
    renderPage();
    const quiet = await tripSection(/Early Harbor Tour/);
    expect(parts(quiet.querySelector(".bk-trip__meta"))).toEqual(["Boat: Gull", "No bookings"]);
    expect(quiet.textContent).not.toContain("Not loaded yet");
    expect(quiet.querySelector(".bk-trip__none")).toBeNull();
  });

  it("says no bookings yet for a trip with nothing booked that has not left", async () => {
    api({
      [route.day()]: () =>
        json(dayBody({ trips: [charterTrip, eveningQuietTrip], bookings: [priyaBooking] })),
    });
    renderPage();
    const quiet = await tripSection(/Early Harbor Tour/);
    expect(parts(quiet.querySelector(".bk-trip__meta"))).toEqual(["Boat: Gull", "No bookings yet"]);
    // Among other trips, its line says it all.
    expect(quiet.querySelector(".tg-empty")).toBeNull();
  });

  it.each([
    [
      "has not left",
      () => eveningQuietTrip,
      "No bookings on this trip yet",
      "Bookings appear here",
    ],
    ["has left", () => quietTrip, "No one booked this trip", "The trip has departed."],
  ])(
    "shows a designed empty state for a trip chosen alone that %s with nothing booked",
    async (_when, trip, title, body) => {
      window.history.replaceState(null, "", `/bookings?day=${wednesday}&trip=${tripIds.quiet}`);
      api({ [route.day()]: () => json(dayBody({ trips: [charterTrip, trip()], bookings: [] })) });
      renderPage();
      const quiet = await tripSection(/Early Harbor Tour/);
      const heading = within(quiet).getByRole("heading", { level: 4, name: title });
      expect(text(heading.closest(".tg-empty"))).toContain(body);
      expect(quiet.querySelector(".bk-table")).toBeNull();
      expect(text(document.querySelector(".bk-filters__totals"))).toBe("0 bookings, 0 guests");
    },
  );

  it("names the place of each trip when a day's trips are in several zones", async () => {
    api({
      [route.day()]: () =>
        json(dayBody({ trips: [honoluluTrip, charterTrip, sunsetTrip], bookings: [priyaBooking] })),
    });
    renderPage();
    const dive = await tripSection(/Two-Tank Morning Dive/);
    expect(text(document.querySelector(".bk-zone"))).toBe(
      "Times are local to each trip's departure point.",
    );
    expect(text(within(dive).getByRole("heading", { level: 3 }))).toBe(
      "7:30 AM, Honolulu time, Two-Tank Morning Dive",
    );
    expect(parts(dive.querySelector(".bk-trip__meta"))).toEqual([
      "Boat: Reef Runner",
      "No bookings yet",
      "Honolulu",
    ]);
    const charter = await tripSection(/Private Half-Day Charter/);
    expect(text(within(charter).getByRole("heading", { level: 3 }))).toBe(
      "8:00 AM, New York time, Private Half-Day Charter",
    );
  });

  it("names the zone of two departures at the same wall-clock time on the night clocks go back", async () => {
    // 1:30 AM happens twice in New York on Sunday, Nov 1: once in EDT, then an hour later in EST.
    const early = {
      ...quietTrip,
      localDate: "2026-11-01",
      localStartTime: "01:30",
      startsAt: "2026-11-01T05:30:00.000Z",
      productName: "Moonlight Cruise",
    };
    const later = {
      ...early,
      tripId: tripIds.charter,
      startsAt: "2026-11-01T06:30:00.000Z",
      productName: "Late Moonlight Cruise",
    };
    window.history.replaceState(null, "", "/bookings?day=2026-11-01");
    api({
      [route.day()]: () =>
        json(dayBody({ date: "2026-11-01", trips: [early, later], bookings: [] })),
    });
    renderPage();
    const first = await tripSection(/EDT, Moonlight Cruise$/);
    const second = await tripSection(/EST, Late Moonlight Cruise$/);
    expect(text(within(first).getByRole("heading", { level: 3 }))).toBe(
      "1:30 AM EDT, Moonlight Cruise",
    );
    expect(text(within(second).getByRole("heading", { level: 3 }))).toBe(
      "1:30 AM EST, Late Moonlight Cruise",
    );
    // The trip control tells them apart as well.
    const select = screen.getByRole("combobox", { name: "Trip" });
    expect(
      within(select)
        .getAllByRole("option")
        .map((option) => text(option)),
    ).toEqual(["All trips", "1:30 AM EDT, Moonlight Cruise", "1:30 AM EST, Late Moonlight Cruise"]);
  });
});

describe("what each role sees", () => {
  it("shows an owner who booked, in a Booker column and on each booking", async () => {
    api({ [route.day()]: () => json(asSeenBy("owner", dayBody())) });
    const { container } = renderPage("owner");
    const sunset = await tripSection(/Sunset Harbor Cruise/);
    const columns = sunset.querySelector(".bk-cols") as Element;
    expect(parts(columns)).toEqual(["Reference", "Booker", "Party", "Extras", "Total", "Status"]);
    expect(text(sunset)).toContain("Maya Okonkwo");
    expect(text(sunset)).toContain("Luis Fernandez");
    expect(factsOf(rowsOf(sunset)[1] as HTMLElement).Booker).toBe("Luis Fernandez");
    expect(container.querySelector(".bk-table--no-booker")).toBeNull();
    expect(screen.queryByText(/aren't shown to your role/)).toBeNull();
    expect(screen.getAllByRole("link", { name: /^Roster/ })).toHaveLength(2);
  });

  it("shows booking staff the same as an owner", async () => {
    api({ [route.day()]: () => json(asSeenBy("booking_staff", dayBody())) });
    renderPage("booking_staff");
    const sunset = await tripSection(/Sunset Harbor Cruise/);
    expect(text(sunset)).toContain("Maya Okonkwo");
    expect(screen.getAllByRole("link", { name: /^Roster/ })).toHaveLength(2);
  });

  it("shows finance the bookings without who made them, with a note and no roster, from the same requests", async () => {
    const ownerCalls = api({ [route.day()]: () => json(asSeenBy("owner", dayBody())) });
    renderPage("owner");
    await tripSection(/Sunset Harbor Cruise/);
    const ownerAsked = ownerCalls.map((c) => `${c.method} ${c.path}?${c.query}`);
    cleanup();

    const calls = api({ [route.day()]: () => json(asSeenBy("finance", dayBody())) });
    const { container } = renderPage("finance");
    const sunset = await tripSection(/Sunset Harbor Cruise/);
    expect(calls.map((c) => `${c.method} ${c.path}?${c.query}`)).toEqual(ownerAsked);

    // No Booker column, no name, no row fact for who booked.
    expect(parts(sunset.querySelector(".bk-cols"))).toEqual([
      "Reference",
      "Party",
      "Extras",
      "Total",
      "Status",
    ]);
    expect(container.querySelector(".bk-table--no-booker")).not.toBeNull();
    expect(container.querySelector(".bk-fact--booker")).toBeNull();
    expect(screen.queryByText("Booker")).toBeNull();
    for (const fragment of personalFragments) {
      expect(container.textContent?.toLowerCase(), fragment).not.toContain(fragment);
    }
    expect(text(screen.getByText(/aren't shown to your role/))).toBe(
      "Guests' names and contact details aren't shown to your role, finance. You see each booking's party, extras, total, and payment.",
    );
    // The rest of each booking is there.
    const [maya] = rowsOf(sunset);
    expect(factsOf(maya as HTMLElement)).toEqual({
      Party: "3 guests 2 Adult, 1 Child (3 to 12)",
      Extras: "1 Souvenir photo",
      Total: "$131.09",
      Status: "Paid, Confirmed",
    });
    expect(screen.queryByRole("link", { name: /^Roster/ })).toBeNull();
    // The trips' own counts still show.
    expect(parts(sunset.querySelector(".bk-trip__meta"))).toEqual([
      "Boat: Sea Lark",
      "2 bookings, 5 guests",
    ]);
  });
});

describe("moving between days", () => {
  it("asks for the adjacent day, writes it into the address with replaceState, and drops it on today", async () => {
    const replace = vi.spyOn(window.history, "replaceState");
    const push = vi.spyOn(window.history, "pushState");
    const calls = api({ [route.day()]: listFor() });
    renderPage();
    await tripSection(/Sunset Harbor Cruise/);

    const next = screen.getByRole("button", { name: "Next day" });
    next.focus();
    fireEvent.click(next);
    await screen.findByRole("heading", { name: "No trips on Thursday, November 5" });
    expect(text(screen.getByRole("heading", { level: 2, name: /^Thursday, November 5/ }))).toBe(
      "Thursday, November 5",
    );
    expect(window.location.search).toBe("?day=2026-11-05");
    // The button that was pressed is still there, so it keeps focus.
    expect(document.activeElement).toBe(next);
    expect(screen.getByRole("button", { name: "Today" }).getAttribute("aria-disabled")).toBeNull();

    const previous = screen.getByRole("button", { name: "Previous day" });
    fireEvent.click(previous);
    await tripSection(/Sunset Harbor Cruise/);
    // Back on today, the day leaves the address.
    expect(window.location.search).toBe("");
    expect(text(screen.getByRole("heading", { level: 2, name: /^Wednesday, November 4/ }))).toBe(
      "Wednesday, November 4 Today",
    );

    fireEvent.click(previous);
    await screen.findByRole("heading", { name: "No trips on Tuesday, November 3" });
    expect(window.location.search).toBe("?day=2026-11-03");
    fireEvent.click(screen.getByRole("button", { name: "Today" }));
    await tripSection(/Sunset Harbor Cruise/);
    expect(window.location.search).toBe("");

    expect(dayRequests(calls)).toEqual([
      "date=2026-11-04",
      "date=2026-11-05",
      "date=2026-11-04",
      "date=2026-11-03",
      "date=2026-11-04",
    ]);
    // Every change replaced the address; none added a history entry.
    expect(replace.mock.calls.map((args) => args[2])).toEqual([
      "/bookings?day=2026-11-05",
      "/bookings",
      "/bookings?day=2026-11-03",
      "/bookings",
    ]);
    expect(push).not.toHaveBeenCalled();
  });

  it("starts the new day from nothing and says it is loading", async () => {
    const next = deferred();
    api({ [route.day()]: [() => json(dayBody()), next.answer] });
    renderPage();
    await tripSection(/Sunset Harbor Cruise/);
    fireEvent.click(screen.getByRole("button", { name: "Next day" }));
    await waitFor(() => expect(liveText()).toBe("Loading bookings for Thursday, November 5…"));
    // The last day's trips are gone while the next day's load.
    expect(screen.queryByRole("region", { name: /Sunset Harbor Cruise/ })).toBeNull();
    next.release(json(dayBody({ date: "2026-11-05", trips: [], bookings: [] })));
    await screen.findByRole("heading", { name: "No trips on Thursday, November 5" });
    expect(liveText()).toBe("No bookings on Thursday, November 5.");
  });

  it("ignores a late answer for a day the person has already left", async () => {
    const thursday = deferred();
    const friday = deferred();
    api({ [route.day()]: [() => json(dayBody()), thursday.answer, friday.answer] });
    renderPage();
    await tripSection(/Sunset Harbor Cruise/);
    const next = screen.getByRole("button", { name: "Next day" });
    fireEvent.click(next);
    await waitFor(() => expect(liveText()).toBe("Loading bookings for Thursday, November 5…"));
    fireEvent.click(next);
    await waitFor(() => expect(liveText()).toBe("Loading bookings for Friday, November 6…"));

    // Friday answers, then Thursday's answer arrives too late, with trips in it.
    friday.release(json(dayBody({ date: "2026-11-06", trips: [], bookings: [] })));
    await screen.findByRole("heading", { name: "No trips on Friday, November 6" });
    thursday.release(json(dayBody({ date: "2026-11-05" })));
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(screen.queryByRole("region", { name: /Sunset Harbor Cruise/ })).toBeNull();
    expect(text(document.querySelector(".bk-bar__day"))).toBe("Friday, November 6");
    expect(liveText()).toBe("No bookings on Friday, November 6.");
    expect(window.location.search).toBe("?day=2026-11-06");
  });

  it("drops the chosen trip when the day changes, since a trip departs on one day", async () => {
    window.history.replaceState(null, "", `/bookings?trip=${tripIds.sunset}`);
    const calls = api({
      [route.day()]: (call) =>
        json(
          call.query.get("date") === wednesday
            ? dayBody({ bookings: [mayaBooking, luisBooking] })
            : dayBody({ date: "2026-11-05", trips: [], bookings: [] }),
        ),
    });
    renderPage();
    await tripSection(/Sunset Harbor Cruise/);
    fireEvent.click(screen.getByRole("button", { name: "Next day" }));
    await screen.findByRole("heading", { name: "No trips on Thursday, November 5" });
    expect(dayRequests(calls)).toEqual([
      `date=${wednesday}&tripId=${tripIds.sunset}`,
      "date=2026-11-05",
    ]);
    expect(window.location.search).toBe("?day=2026-11-05");
  });
});

describe("choosing a trip", () => {
  it("asks for that trip, writes it into the address, and keeps the control focused while the list refreshes", async () => {
    const refresh = deferred();
    const calls = api({
      [route.day()]: [() => json(dayBody()), refresh.answer, () => json(dayBody())],
    });
    renderPage();
    await tripSection(/Sunset Harbor Cruise/);

    const select = screen.getByRole("combobox", { name: "Trip" }) as HTMLSelectElement;
    expect(
      within(select)
        .getAllByRole("option")
        .map((o) => text(o)),
    ).toEqual(["All trips", "8:00 AM, Private Half-Day Charter", "6:00 PM, Sunset Harbor Cruise"]);
    // No count in an option: on a phone it would cut the trip's name short. The totals beside
    // the control give it.
    expect(select.value).toBe("");

    select.focus();
    fireEvent.change(select, { target: { value: tripIds.sunset } });

    // The request is for the one trip, and the address says so.
    await waitFor(() => expect(callsTo(calls, route.day())).toHaveLength(2));
    expect(callsTo(calls, route.day())[1]?.query.get("tripId")).toBe(tripIds.sunset);
    expect(callsTo(calls, route.day())[1]?.query.get("date")).toBe(wednesday);
    // A trip travels with its day, so the address still names this list tomorrow.
    expect(window.location.search).toBe(`?day=${wednesday}&trip=${tripIds.sunset}`);

    // While it works: the list stays, marked busy, and the control keeps its place.
    await waitFor(() =>
      expect(document.querySelector(".bk-day")?.getAttribute("aria-busy")).toBe("true"),
    );
    expect(screen.getByRole("combobox", { name: "Trip" })).toBe(select);
    expect(document.activeElement).toBe(select);
    expect(select.value).toBe(tripIds.sunset);
    expect(rowsOf(await tripSection(/Sunset Harbor Cruise/))).toHaveLength(2);
    expect(screen.queryByRole("region", { name: /Private Half-Day Charter/ })).toBeNull();
    expect(liveText()).toBe("Loading bookings for Wednesday, November 4…");

    refresh.release(json(dayBody({ bookings: [mayaBooking, luisBooking] })));
    await waitFor(() =>
      expect(document.querySelector(".bk-day")?.getAttribute("aria-busy")).toBeNull(),
    );
    expect(screen.getByRole("combobox", { name: "Trip" })).toBe(select);
    expect(document.activeElement).toBe(select);
    expect(rowsOf(await tripSection(/Sunset Harbor Cruise/))).toHaveLength(2);
    expect(screen.queryByRole("region", { name: /Private Half-Day Charter/ })).toBeNull();
    // The totals and the announcement are for the one trip.
    expect(text(document.querySelector(".bk-filters__totals"))).toBe("2 bookings, 5 guests");
    expect(liveText()).toBe("2 bookings, 5 guests on Sunset Harbor Cruise, Wednesday, November 4.");

    // All trips again: no trip in the request or the address.
    fireEvent.change(select, { target: { value: "" } });
    await tripSection(/Private Half-Day Charter/);
    expect(callsTo(calls, route.day())).toHaveLength(3);
    expect(callsTo(calls, route.day())[2]?.query.has("tripId")).toBe(false);
    expect(window.location.search).toBe("");
  });

  it("hands focus to the day's heading when the list they chose a trip for does not load", async () => {
    api({ [route.day()]: [() => json(dayBody()), dropped] });
    renderPage();
    await tripSection(/Sunset Harbor Cruise/);
    const select = screen.getByRole("combobox", { name: "Trip" });
    select.focus();
    fireEvent.change(select, { target: { value: tripIds.sunset } });
    const alert = await screen.findByRole("alert");
    expect(text(alert)).toContain("The console can't reach TideGrid");
    // The control they were on went with the list, so the day's heading keeps their place.
    const heading = screen.getByRole("heading", { level: 2, name: /^Wednesday, November 4/ });
    await waitFor(() => expect(document.activeElement).toBe(heading));
  });

  it("leaves focus where the person moved it while a trip's list was on its way", async () => {
    const refresh = deferred();
    api({ [route.day()]: [() => json(dayBody()), refresh.answer] });
    renderPage();
    await tripSection(/Sunset Harbor Cruise/);
    fireEvent.change(screen.getByRole("combobox", { name: "Trip" }), {
      target: { value: tripIds.sunset },
    });
    // The person goes on to find a booking while the trip's list loads; then it fails.
    const field = screen.getByRole("textbox", { name: "Find by booking reference" });
    field.focus();
    refresh.release(apiError(500, "internal_error"));
    await screen.findByRole("alert");
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(document.activeElement).toBe(field);
  });

  it("hands focus on to the day's heading once Try again works after a failed refresh", async () => {
    const retry = deferred();
    api({ [route.day()]: [() => json(dayBody()), dropped, retry.answer] });
    renderPage();
    await tripSection(/Sunset Harbor Cruise/);
    fireEvent.change(screen.getByRole("combobox", { name: "Trip" }), {
      target: { value: tripIds.sunset },
    });
    const button = within(await screen.findByRole("alert")).getByRole("button", {
      name: "Try again",
    });
    button.focus();
    fireEvent.click(button);
    expect(await screen.findByRole("button", { name: "Trying again…" })).toBe(button);
    expect(document.activeElement).toBe(button);
    retry.release(json(dayBody({ bookings: [mayaBooking, luisBooking] })));
    const heading = screen.getByRole("heading", { level: 2, name: /^Wednesday, November 4/ });
    await tripSection(/Sunset Harbor Cruise/);
    await waitFor(() => expect(document.activeElement).toBe(heading));
  });

  it("returns to every trip with no trip in the request or the address", async () => {
    window.history.replaceState(null, "", `/bookings?trip=${tripIds.sunset}`);
    const calls = api({
      [route.day()]: [
        () => json(dayBody({ bookings: [mayaBooking, luisBooking] })),
        () => json(dayBody()),
      ],
    });
    renderPage();
    await tripSection(/Sunset Harbor Cruise/);
    const select = screen.getByRole("combobox", { name: "Trip" }) as HTMLSelectElement;
    expect(select.value).toBe(tripIds.sunset);
    select.focus();
    fireEvent.change(select, { target: { value: "" } });
    await tripSection(/Private Half-Day Charter/);
    expect(callsTo(calls, route.day())[1]?.query.has("tripId")).toBe(false);
    expect(window.location.search).toBe("");
    expect(document.activeElement).toBe(select);
  });

  it("warns when the trip in the address is not on the day, and Show all trips lists every trip", async () => {
    window.history.replaceState(null, "", `/bookings?trip=${tripIds.honolulu}`);
    const calls = api({
      [route.day()]: [() => json(dayBody({ bookings: [] })), () => json(dayBody())],
    });
    renderPage();
    const warning = (
      await screen.findByText("That trip doesn't depart on Wednesday, November 4")
    ).closest(".tg-notice") as HTMLElement;
    expect(text(warning)).toContain("The address named a trip that isn't on this day's list.");
    // No trip is shown for it, and the control reads all trips.
    expect(screen.queryByRole("region", { name: /Sunset Harbor Cruise/ })).toBeNull();
    expect((screen.getByRole("combobox", { name: "Trip" }) as HTMLSelectElement).value).toBe("");
    // Nothing is listed, so no count says otherwise, on screen or aloud.
    expect(document.querySelector(".bk-filters__totals")).toBeNull();
    expect(liveText()).toBe("That trip doesn't depart on Wednesday, November 4.");
    // A trip always travels with its day in the address.
    await waitFor(() =>
      expect(Object.fromEntries(new URLSearchParams(window.location.search))).toEqual({
        trip: tripIds.honolulu,
        day: wednesday,
      }),
    );
    expect(callsTo(calls, route.day())[0]?.query.get("tripId")).toBe(tripIds.honolulu);

    const showAll = within(warning).getByRole("button", { name: "Show all trips" });
    showAll.focus();
    fireEvent.click(showAll);
    await tripSection(/Sunset Harbor Cruise/);
    expect(callsTo(calls, route.day())[1]?.query.has("tripId")).toBe(false);
    expect(window.location.search).toBe("");
    expect(screen.queryByText("That trip doesn't depart on Wednesday, November 4")).toBeNull();
    // The button went away with the warning, so the day's heading takes focus.
    await waitFor(() =>
      expect(document.activeElement).toBe(
        screen.getByRole("heading", { level: 2, name: /^Wednesday, November 4/ }),
      ),
    );
  });

  it("ignores a trip in the address that is not an id", async () => {
    window.history.replaceState(null, "", "/bookings?trip=sunset");
    const calls = api({ [route.day()]: () => json(dayBody()) });
    renderPage();
    await tripSection(/Sunset Harbor Cruise/);
    expect(callsTo(calls, route.day())[0]?.query.has("tripId")).toBe(false);
    expect(screen.queryByText(/doesn't depart on/)).toBeNull();
    // It is dropped from the address too.
    expect(window.location.search).toBe("");
  });
});

describe("a day with no trips", () => {
  it("says so on today, with nowhere else to go", async () => {
    api({ [route.day()]: () => json(dayBody({ trips: [], bookings: [] })) });
    renderPage();
    await screen.findByRole("heading", { level: 2, name: "No trips on Wednesday, November 4" });
    expect(
      screen.getByText("Nothing departs that day, so there are no bookings to show."),
    ).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Go to today" })).toBeNull();
    expect(screen.queryByRole("combobox", { name: "Trip" })).toBeNull();
    expect(liveText()).toBe("No bookings on Wednesday, November 4.");
  });

  it("offers Go to today on another day, and moves focus to the day's heading when it works", async () => {
    // A day in the address is asked for at once, before the catalog says which day is today at
    // the marina. Make it the same date here and in Tokyo, so what "today" means is not a race.
    vi.setSystemTime(new Date("2026-11-04T05:00:00Z"));
    window.history.replaceState(null, "", "/bookings?day=2026-11-10");
    const calls = api({ [route.day()]: listFor() });
    renderPage();
    const goToday = await screen.findByRole("button", { name: "Go to today" });
    goToday.focus();
    fireEvent.click(goToday);
    await tripSection(/Sunset Harbor Cruise/);
    expect(dayRequests(calls)).toEqual(["date=2026-11-10", `date=${wednesday}`]);
    expect(window.location.search).toBe("");
    // The empty state's button is gone, so the heading keeps the person's place.
    const heading = screen.getByRole("heading", { level: 2, name: /^Wednesday, November 4/ });
    await waitFor(() => expect(document.activeElement).toBe(heading));
  });
});

describe("when the list does not load", () => {
  it("shows a designed error, keeps focus on Try again while it works, then focuses the day", async () => {
    const retry = deferred();
    const calls = api({ [route.day()]: [dropped, retry.answer] });
    renderPage();
    const alert = await screen.findByRole("alert");
    expect(text(alert)).toContain("The console can't reach TideGrid");
    expect(text(alert)).toContain("Check your connection, then try again.");
    expect(text(alert)).not.toMatch(/TypeError|Failed to fetch/);
    // Finding a booking and moving between days still work around the error.
    expect(screen.getByRole("textbox", { name: "Find by booking reference" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Next day" })).toBeTruthy();

    const button = within(alert).getByRole("button", { name: "Try again" });
    button.focus();
    fireEvent.click(button);
    expect(await screen.findByRole("button", { name: "Trying again…" })).toBe(button);
    expect(button.getAttribute("aria-busy")).toBe("true");
    expect(document.activeElement).toBe(button);

    retry.release(json(dayBody()));
    const heading = await dayHeading(/^Wednesday, November 4/);
    await tripSection(/Sunset Harbor Cruise/);
    await waitFor(() => expect(document.activeElement).toBe(heading));
    expect(screen.queryByRole("alert")).toBeNull();
    expect(dayRequests(calls)).toEqual([`date=${wednesday}`, `date=${wednesday}`]);
  });

  it("says it still did not load after a second failure", async () => {
    api({ [route.day()]: [dropped, dropped] });
    renderPage();
    const first = await screen.findByRole("alert");
    expect(text(first)).toContain("The console can't reach TideGrid");
    fireEvent.click(within(first).getByRole("button", { name: "Try again" }));
    await waitFor(() =>
      expect(text(screen.getByRole("alert"))).toContain("Bookings still didn't load"),
    );
  });

  it.each([
    [401, "unauthenticated", "You're signed out", "link", "Sign in again"],
    [403, "forbidden", "Your role can't see bookings", null, null],
    [403, "tenant_suspended", "This operator is suspended", null, null],
    [404, "tenant_not_found", "You no longer have access to this operator", null, null],
    [404, "not_found", "Bookings couldn't be found", null, null],
    [400, "validation_failed", "Bookings can't be shown for this address", "button", "Go to today"],
    [500, "internal_error", "Bookings didn't load", "button", "Try again"],
  ] as const)(
    "reads a %i %s in plain words, with its way forward",
    async (status, code, title, role, name) => {
      api({ [route.day()]: () => apiError(status, code) });
      renderPage();
      const alert = await screen.findByRole("alert");
      expect(text(alert)).toContain(title);
      expect(text(alert)).not.toMatch(/\b[1-5]\d\d\b|_/);
      const actions = alert.querySelector(".tg-notice__actions");
      if (role === null || name === null) {
        expect(actions).toBeNull();
      } else {
        expect(within(alert).getByRole(role, { name })).toBeTruthy();
      }
      if (status === 401) {
        expect(screen.getByRole("link", { name: "Sign in again" }).getAttribute("href")).toBe("/");
      }
    },
  );

  it("goes to today from a request the API refused", async () => {
    // A day in the address is asked for at once, before the catalog says which day is today at
    // the marina. Make it the same date here and in Tokyo, so what "today" means is not a race.
    vi.setSystemTime(new Date("2026-11-04T05:00:00Z"));
    window.history.replaceState(null, "", "/bookings?day=2026-11-10");
    const calls = api({
      [route.day()]: [() => apiError(400, "validation_failed"), () => json(dayBody())],
    });
    renderPage();
    const alert = await screen.findByRole("alert");
    fireEvent.click(within(alert).getByRole("button", { name: "Go to today" }));
    await tripSection(/Sunset Harbor Cruise/);
    expect(dayRequests(calls)).toEqual(["date=2026-11-10", `date=${wednesday}`]);
    expect(window.location.search).toBe("");
  });

  it.each([
    [
      "a sales state it does not know",
      dayBody({ trips: [{ ...sunsetTrip, salesState: "delayed" as never }] }),
    ],
    [
      "a time zone the browser cannot show",
      dayBody({ trips: [{ ...sunsetTrip, timeZone: "Mars/Olympus_Mons" }] }),
    ],
    [
      "a start time that is not a time",
      dayBody({ trips: [{ ...sunsetTrip, localStartTime: "6pm" }] }),
    ],
    ["a count that is not a whole number", dayBody({ trips: [{ ...sunsetTrip, bookings: 2.5 }] })],
    ["a total that is not whole cents", dayBody({ bookings: [{ ...mayaBooking, total: 131.09 }] })],
    [
      "a payment state it does not know",
      dayBody({
        bookings: [{ ...mayaBooking, payment: { state: "refunded" as never, refund: null } }],
      }),
    ],
    [
      "a refund state it does not know",
      dayBody({
        bookings: [
          {
            ...mayaBooking,
            payment: { state: "succeeded", refund: { state: "reversed" as never, amount: 1 } },
          },
        ],
      }),
    ],
    [
      "a party it cannot read",
      dayBody({ bookings: [{ ...mayaBooking, party: { kind: "group" } as never }] }),
    ],
    ["a booker with no name", dayBody({ bookings: [{ ...mayaBooking, booker: {} as never }] })],
    ["no bookings list", { date: wednesday, trips: [], nextAfter: null }],
    ["a cursor that is not text", dayBody({ nextAfter: 7 as never })],
  ])("treats %s as an answer it can't show, not as a crash", async (_what, body) => {
    api({ [route.day()]: () => json(body) });
    renderPage();
    const alert = await screen.findByRole("alert");
    expect(text(alert)).toContain("Bookings couldn't be shown");
    expect(within(alert).getByRole("button", { name: "Try again" })).toBeTruthy();
  });

  it("treats an answer that is not JSON as one it can't show", async () => {
    api({ [route.day()]: () => new Response("<html>gateway</html>", { status: 200 }) });
    renderPage();
    expect(text(await screen.findByRole("alert"))).toContain("Bookings couldn't be shown");
  });
});

describe("more bookings than one page", () => {
  const firstPage = () =>
    dayBody({
      bookings: [priyaBooking, mayaBooking],
      // The cursor is the last booking of the page.
      nextAfter: bookingIds.maya,
    });

  it("asks for the next page with after=, appends it, and goes when the last page arrives", async () => {
    const more = deferred();
    const calls = api({
      [route.day()]: [() => json(firstPage()), more.answer],
    });
    renderPage();
    const sunset = await tripSection(/Sunset Harbor Cruise/);
    // The trip's counts are for the whole day; one of its two bookings is loaded.
    expect(parts(sunset.querySelector(".bk-trip__meta"))).toEqual([
      "Boat: Sea Lark",
      "2 bookings, 5 guests",
    ]);
    expect(rowsOf(sunset)).toHaveLength(1);

    const button = screen.getByRole("button", { name: "Show more bookings" });
    button.focus();
    fireEvent.click(button);
    expect(await screen.findByRole("button", { name: "Loading more…" })).toBe(button);
    expect(button.getAttribute("aria-busy")).toBe("true");
    expect(callsTo(calls, route.day())[1]?.query.get("after")).toBe(bookingIds.maya);
    expect(callsTo(calls, route.day())[1]?.query.get("date")).toBe(wednesday);
    // The first page stays while the next loads.
    expect(rowsOf(sunset)).toHaveLength(1);

    more.release(json(dayBody({ bookings: [luisBooking], nextAfter: null })));
    await waitFor(() => expect(rowsOf(sunset)).toHaveLength(2));
    // Appended after what was there, under its own trip.
    expect(rowsOf(sunset).map((row) => text(row.querySelector(".bk-row__ref")))).toEqual([
      "Booking QKG6ERBF",
      "Booking 7HM2P9TW",
    ]);
    expect(rowsOf(await tripSection(/Private Half-Day Charter/))).toHaveLength(1);
    expect(screen.queryByRole("button", { name: /Show more bookings|Loading more/ })).toBeNull();
    expect(screen.queryByText("More bookings didn't load")).toBeNull();
  });

  it("hands focus to the first booking of the last page when Show more bookings goes away with it", async () => {
    api({
      [route.day()]: [
        () => json(firstPage()),
        () => json(dayBody({ bookings: [luisBooking], nextAfter: null })),
      ],
    });
    renderPage();
    await tripSection(/Sunset Harbor Cruise/);
    const button = screen.getByRole("button", { name: "Show more bookings" });
    button.focus();
    fireEvent.click(button);
    await waitFor(() =>
      expect(screen.queryByRole("button", { name: /Show more bookings|Loading more/ })).toBeNull(),
    );
    const first = screen.getByRole("link", { name: /^Booking\s?7HM2P9TW$/ });
    await waitFor(() => expect(document.activeElement).toBe(first));
  });

  it("keeps focus on Show more bookings while more pages remain", async () => {
    api({
      [route.day()]: [
        () => json(firstPage()),
        () => json(dayBody({ bookings: [luisBooking], nextAfter: bookingIds.luis })),
      ],
    });
    renderPage();
    await tripSection(/Sunset Harbor Cruise/);
    const button = screen.getByRole("button", { name: "Show more bookings" });
    button.focus();
    fireEvent.click(button);
    await waitFor(() =>
      expect(rowsOf(screen.getByRole("region", { name: /Sunset/ }))).toHaveLength(2),
    );
    expect(screen.getByRole("button", { name: "Show more bookings" })).toBe(button);
    expect(document.activeElement).toBe(button);
  });

  it("says where a trip's bookings are when they are all on a later page", async () => {
    const calls = api({
      [route.day()]: [
        () => json(dayBody({ bookings: [priyaBooking], nextAfter: bookingIds.priya })),
        () => json(dayBody({ bookings: [mayaBooking, luisBooking], nextAfter: null })),
      ],
    });
    renderPage();
    const sunset = await tripSection(/Sunset Harbor Cruise/);
    expect(parts(sunset.querySelector(".bk-trip__meta"))).toEqual([
      "Boat: Sea Lark",
      "2 bookings, 5 guests",
    ]);
    expect(rowsOf(sunset)).toHaveLength(0);
    expect(text(sunset.querySelector(".bk-trip__none"))).toBe(
      "Not loaded yet. Choose Show more bookings below.",
    );
    expect(sunset.textContent).not.toContain("No bookings yet");

    fireEvent.click(screen.getByRole("button", { name: "Show more bookings" }));
    await waitFor(() => expect(rowsOf(sunset)).toHaveLength(2));
    expect(sunset.querySelector(".bk-trip__none")).toBeNull();
    expect(callsTo(calls, route.day())[1]?.query.get("after")).toBe(bookingIds.priya);
  });

  it("keeps the page it has when the next one fails, and tries again with the same cursor", async () => {
    const calls = api({
      [route.day()]: [
        () => json(firstPage()),
        dropped,
        () => json(dayBody({ bookings: [luisBooking], nextAfter: null })),
      ],
    });
    renderPage();
    const sunset = await tripSection(/Sunset Harbor Cruise/);
    fireEvent.click(screen.getByRole("button", { name: "Show more bookings" }));
    const notice = (await screen.findByText("More bookings didn't load")).closest(
      ".tg-notice",
    ) as HTMLElement;
    expect(text(notice)).toContain("Check your connection, then try again.");
    expect(rowsOf(sunset)).toHaveLength(1);
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    await waitFor(() => expect(rowsOf(sunset)).toHaveLength(2));
    expect(callsTo(calls, route.day()).map((c) => c.query.get("after"))).toEqual([
      null,
      bookingIds.maya,
      bookingIds.maya,
    ]);
    expect(screen.queryByText("More bookings didn't load")).toBeNull();
  });

  it("asks for more of the chosen trip with the trip in the request", async () => {
    window.history.replaceState(null, "", `/bookings?trip=${tripIds.sunset}`);
    const calls = api({
      [route.day()]: [
        () => json(dayBody({ bookings: [mayaBooking], nextAfter: bookingIds.maya })),
        () => json(dayBody({ bookings: [luisBooking], nextAfter: null })),
      ],
    });
    renderPage();
    await tripSection(/Sunset Harbor Cruise/);
    fireEvent.click(screen.getByRole("button", { name: "Show more bookings" }));
    await waitFor(() =>
      expect(rowsOf(screen.getByRole("region", { name: /Sunset/ }))).toHaveLength(2),
    );
    expect(dayRequests(calls)).toEqual([
      `date=${wednesday}&tripId=${tripIds.sunset}`,
      `date=${wednesday}&tripId=${tripIds.sunset}&after=${bookingIds.maya}`,
    ]);
  });

  it("does not offer the old list's next page while a newly chosen trip's list loads", async () => {
    // The API refuses a cursor that is not in the listing asked for (cursor_invalid), so the old
    // list's cursor must never be sent with the new trip.
    const refresh = deferred();
    const calls = api({
      [route.day()]: [
        () => json(dayBody({ bookings: [priyaBooking, mayaBooking], nextAfter: bookingIds.maya })),
        refresh.answer,
        () => apiError(400, "cursor_invalid"),
      ],
    });
    renderPage();
    await tripSection(/Sunset Harbor Cruise/);
    expect(screen.getByRole("button", { name: "Show more bookings" })).toBeTruthy();
    fireEvent.change(screen.getByRole("combobox", { name: "Trip" }), {
      target: { value: tripIds.sunset },
    });
    await waitFor(() =>
      expect(document.querySelector(".bk-day")?.getAttribute("aria-busy")).toBe("true"),
    );
    expect(screen.queryByRole("button", { name: /Show more bookings|Loading more/ })).toBeNull();
    await new Promise((resolve) => setTimeout(resolve, 30));
    // No request pairs the new trip with the old list's cursor.
    expect(dayRequests(calls)).toEqual([
      `date=${wednesday}`,
      `date=${wednesday}&tripId=${tripIds.sunset}`,
    ]);
    // The new trip's own list brings its own next page.
    refresh.release(json(dayBody({ bookings: [mayaBooking], nextAfter: bookingIds.maya })));
    expect(await screen.findByRole("button", { name: "Show more bookings" })).toBeTruthy();
  });
});

describe("a booker's name and email stay out of addresses", () => {
  it("keeps them out of the address bar and every link through finding, moving, choosing, and paging", async () => {
    window.history.replaceState(null, "", "/bookings");
    api({
      [route.day()]: (call) =>
        json(
          call.query.get("date") === wednesday
            ? dayBody({
                bookings: call.query.has("after") ? [luisBooking] : [priyaBooking, mayaBooking],
                nextAfter: call.query.has("after") ? null : bookingIds.maya,
              })
            : dayBody({ date: "2026-11-05", trips: [], bookings: [] }),
        ),
      [route.reference("QKG6ERBF")]: () =>
        json({
          booking: {
            id: bookingIds.maya,
            reference: "QKG6ERBF",
            tripId: tripIds.sunset,
            localDate: wednesday,
          },
        }),
    });
    const { navigate } = renderPage("owner");
    await tripSection(/Sunset Harbor Cruise/);
    // The people are on the page, so the check has something to catch.
    expect(text(document.body)).toContain(bookers.priya.name);
    expectNoPersonalDataInAddresses();

    fireEvent.click(screen.getByRole("button", { name: "Show more bookings" }));
    await waitFor(() => expect(text(document.body)).toContain(bookers.luis.name));
    expectNoPersonalDataInAddresses();

    fireEvent.change(screen.getByRole("combobox", { name: "Trip" }), {
      target: { value: tripIds.sunset },
    });
    await waitFor(() => expect(window.location.search).toContain("trip="));
    expectNoPersonalDataInAddresses();

    fireEvent.change(screen.getByRole("textbox", { name: "Find by booking reference" }), {
      target: { value: "qkg6 erbf" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Find" }));
    await waitFor(() => expect(navigate).toHaveBeenCalled());
    expect(navigate).toHaveBeenCalledWith(`/bookings/${bookingIds.maya}`);
    expectNoPersonalDataInAddresses();

    fireEvent.click(screen.getByRole("button", { name: "Next day" }));
    await screen.findByRole("heading", { name: "No trips on Thursday, November 5" });
    expect(window.location.search).toBe("?day=2026-11-05");
    expectNoPersonalDataInAddresses();
  });
});

describe("find a booking by its reference", () => {
  const field = () => screen.getByRole("textbox", { name: "Find by booking reference" });
  const find = () => screen.getByRole("button", { name: "Find" });
  const hit = (reference = "QKG6ERBF") =>
    json({
      booking: { id: bookingIds.maya, reference, tripId: tripIds.sunset, localDate: wednesday },
    });
  const type = (value: string) => fireEvent.change(field(), { target: { value } });

  it("has a labeled field with a hint, and a Find button beside it", async () => {
    api({ [route.day()]: () => json(dayBody()) });
    renderPage();
    await tripSection(/Sunset Harbor Cruise/);
    const input = field();
    expect(input.getAttribute("aria-describedby")).toBe(
      input.getAttribute("id")?.concat("-hint") ?? "",
    );
    expect(text(document.getElementById(`${input.id}-hint`))).toBe(
      "The 8 letters and numbers the guest quotes",
    );
    expect(input.getAttribute("aria-invalid")).toBeNull();
    expect(find().getAttribute("type")).toBe("submit");
    // The search landmark, named for what it finds.
    expect(input.closest("search")?.getAttribute("aria-label")).toBe("Find a booking");
  });

  it.each([
    ["nothing", ""],
    ["spaces only", "   "],
    ["too few characters", "QKG6"],
    ["too many characters", "QKG6ERBFX"],
    ["a letter a reference never holds", "QKG6ERBU"],
    ["punctuation", "QKG6!RBF"],
  ])("refuses %s without asking, and puts focus on the field", async (_what, value) => {
    const calls = api({ [route.day()]: () => json(dayBody()) });
    renderPage();
    await tripSection(/Sunset Harbor Cruise/);
    type(value);
    find().focus();
    fireEvent.click(find());
    const error = await screen.findByText(
      "Enter the 8 letters and numbers of a booking reference, such as QKG6ERBF.",
      { selector: problemText },
    );
    // Focus stays in the field, so the problem is also said aloud.
    expect(findLiveText()).toBe(
      "Enter the 8 letters and numbers of a booking reference, such as QKG6ERBF.",
    );
    expect(document.activeElement).toBe(field());
    expect(field().getAttribute("aria-invalid")).toBe("true");
    // The problem is read with the field, after its hint.
    const describedBy = (field().getAttribute("aria-describedby") ?? "").split(" ");
    expect(describedBy).toHaveLength(2);
    expect(document.getElementById(describedBy[1] ?? "")).toBe(error.closest(".tg-field__error"));
    expect(calls.filter((c) => c.path.includes("booking-references"))).toEqual([]);
    // Typing again clears it.
    type("QKG6ERB");
    expect(screen.queryByText(/Enter the 8 letters/)).toBeNull();
    expect(findLiveText()).toBe("");
    expect(field().getAttribute("aria-invalid")).toBeNull();
  });

  it.each([
    ["qkg6-erbf", "QKG6ERBF"],
    ["qkg6 erbo", "QKG6ERB0"],
    ["  QKG6 ERBF  ", "QKG6ERBF"],
    ["qkg6erbi", "QKG6ERB1"],
    ["qkg6erbl", "QKG6ERB1"],
    ["Qkg6-Erb-F", "QKG6ERBF"],
  ])("reads %j as %s before asking", async (typed, asked) => {
    const calls = api({
      [route.day()]: () => json(dayBody()),
      [route.reference(asked)]: () => hit(asked),
    });
    const { navigate } = renderPage();
    await tripSection(/Sunset Harbor Cruise/);
    type(typed);
    fireEvent.click(find());
    await waitFor(() => expect(navigate).toHaveBeenCalledTimes(1));
    const lookups = calls.filter((c) => c.path.includes("booking-references"));
    expect(lookups.map((c) => c.path)).toEqual([
      `/api/v1/staff/tenants/${membership("owner").tenantId}/booking-references/${asked}`,
    ]);
    expect(lookups[0]?.method).toBe("GET");
  });

  it("opens the booking it found through the page's own navigation", async () => {
    api({
      [route.day()]: () => json(dayBody()),
      [route.reference("QKG6ERBF")]: () => hit(),
    });
    const { navigate } = renderPage();
    await tripSection(/Sunset Harbor Cruise/);
    type("qkg6-erbf");
    fireEvent.click(find());
    await waitFor(() => expect(navigate).toHaveBeenCalledWith(`/bookings/${bookingIds.maya}`));
    expect(navigate).toHaveBeenCalledTimes(1);
    expect(screen.queryByText(/No booking/)).toBeNull();
    // The window itself did not move: the shell does that.
    expect(window.location.pathname).toBe("/bookings");
  });

  it("works while the list is still loading", async () => {
    const list = deferred();
    api({
      [route.day()]: [list.answer],
      [route.reference("QKG6ERBF")]: () => hit(),
    });
    const { navigate } = renderPage();
    type("QKG6ERBF");
    fireEvent.click(find());
    await waitFor(() => expect(navigate).toHaveBeenCalledWith(`/bookings/${bookingIds.maya}`));
    list.release(json(dayBody()));
  });

  it("does nothing for a lookup that finishes after the page is gone", async () => {
    const lookup = deferred();
    api({
      [route.day()]: () => json(dayBody()),
      [route.reference("QKG6ERBF")]: [lookup.answer],
    });
    const { navigate, unmount } = renderPage();
    await tripSection(/Sunset Harbor Cruise/);
    type("QKG6ERBF");
    fireEvent.click(find());
    await screen.findByRole("button", { name: "Finding…" });
    unmount();
    lookup.release(hit());
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(navigate).not.toHaveBeenCalled();
  });

  it("says aloud that it is finding, then what it found, while focus stays in the field", async () => {
    const lookup = deferred();
    api({
      [route.day()]: () => json(dayBody()),
      [route.reference("QKG6ERB0")]: [lookup.answer],
    });
    renderPage();
    await tripSection(/Sunset Harbor Cruise/);
    expect(findLiveText()).toBe("");
    type("qkg6 erbo");
    field().focus();
    fireEvent.submit(field().closest("form") as HTMLFormElement);
    await waitFor(() => expect(findLiveText()).toBe("Finding the booking…"));
    lookup.release(apiError(404, "not_found"));
    const message = `No booking QKG6ERB0 at ${tenantName}. Check the reference with the guest.`;
    await waitFor(() => expect(findLiveText()).toBe(message));
    expect(document.activeElement).toBe(field());
    // The list's own live region is left alone.
    expect(liveText()).toBe("3 bookings, 11 guests on Wednesday, November 4.");
  });

  it("shows Finding… and ignores a second press while it asks", async () => {
    const lookup = deferred();
    const calls = api({
      [route.day()]: () => json(dayBody()),
      [route.reference("QKG6ERBF")]: [lookup.answer],
    });
    const { navigate } = renderPage();
    await tripSection(/Sunset Harbor Cruise/);
    type("QKG6ERBF");
    fireEvent.click(find());
    const busy = await screen.findByRole("button", { name: "Finding…" });
    expect(busy.getAttribute("aria-busy")).toBe("true");
    fireEvent.click(busy);
    fireEvent.submit(field().closest("form") as HTMLFormElement);
    expect(calls.filter((c) => c.path.includes("booking-references"))).toHaveLength(1);
    lookup.release(hit());
    await waitFor(() => expect(navigate).toHaveBeenCalledTimes(1));
    expect(screen.getByRole("button", { name: "Find" }).getAttribute("aria-busy")).toBeNull();
  });

  it("says there is no booking with that reference at the operator, and puts focus on the field", async () => {
    api({
      [route.day()]: () => json(dayBody()),
      [route.reference("QKG6ERB0")]: () => apiError(404, "not_found"),
    });
    const { navigate } = renderPage();
    await tripSection(/Sunset Harbor Cruise/);
    type("qkg6 erbo");
    find().focus();
    fireEvent.click(find());
    // The reference is read back the way it was asked, not as typed.
    const message = `No booking QKG6ERB0 at ${tenantName}. Check the reference with the guest.`;
    expect(await screen.findByText(message, { selector: problemText })).toBeTruthy();
    expect(document.activeElement).toBe(field());
    expect(field().getAttribute("aria-invalid")).toBe("true");
    expect(navigate).not.toHaveBeenCalled();
    // The button is ready for another try.
    expect(screen.getByRole("button", { name: "Find" }).getAttribute("aria-busy")).toBeNull();
    // What was typed stays, for another try.
    expect((field() as HTMLInputElement).value).toBe("qkg6 erbo");
  });

  it("says so when the console cannot reach TideGrid", async () => {
    api({
      [route.day()]: () => json(dayBody()),
      [route.reference("QKG6ERBF")]: [dropped],
    });
    const { navigate } = renderPage();
    await tripSection(/Sunset Harbor Cruise/);
    type("QKG6ERBF");
    fireEvent.click(find());
    expect(
      await screen.findByText(
        "The console can't reach TideGrid. Check your connection, then try again.",
        { selector: problemText },
      ),
    ).toBeTruthy();
    expect(document.activeElement).toBe(field());
    expect(navigate).not.toHaveBeenCalled();
  });

  it.each([
    [401, "unauthenticated", "You're signed out. Sign in again, then find the booking."],
    [403, "forbidden", "Your role can't look up bookings."],
    [403, "tenant_suspended", `While ${tenantName} is suspended, bookings can't be shown.`],
    [400, "validation_failed", "That reference couldn't be looked up. Check it and try again."],
    [500, "internal_error", "TideGrid isn't responding right now. Try again in a moment."],
  ] as const)("reads a %i %s in plain words", async (status, code, message) => {
    api({
      [route.day()]: () => json(dayBody()),
      [route.reference("QKG6ERBF")]: [() => apiError(status, code)],
    });
    const { navigate } = renderPage();
    await tripSection(/Sunset Harbor Cruise/);
    type("QKG6ERBF");
    fireEvent.click(find());
    expect(await screen.findByText(message, { selector: problemText })).toBeTruthy();
    expect(navigate).not.toHaveBeenCalled();
  });

  it("says the person no longer has access, not that the booking is missing, when their membership ended", async () => {
    api({
      [route.day()]: () => json(dayBody()),
      [route.reference("QKG6ERBF")]: [() => apiError(404, "tenant_not_found")],
    });
    const { navigate } = renderPage();
    await tripSection(/Sunset Harbor Cruise/);
    type("QKG6ERBF");
    fireEvent.click(find());
    expect(
      await screen.findByText(
        `You no longer have access to ${tenantName}. Ask one of its owners.`,
        { selector: problemText },
      ),
    ).toBeTruthy();
    expect(navigate).not.toHaveBeenCalled();
  });

  it("says when TideGrid's answer is one it can't read", async () => {
    api({
      [route.day()]: () => json(dayBody()),
      [route.reference("QKG6ERBF")]: [() => json({ booking: { id: 7 } })],
    });
    const { navigate } = renderPage();
    await tripSection(/Sunset Harbor Cruise/);
    type("QKG6ERBF");
    fireEvent.click(find());
    expect(
      await screen.findByText(
        "TideGrid sent an answer this console can't read. Try again in a moment.",
        { selector: problemText },
      ),
    ).toBeTruthy();
    expect(navigate).not.toHaveBeenCalled();
  });

  it("finds a booking while React runs effects twice in development, as the console's entry point does", async () => {
    api({
      [route.day()]: () => json(dayBody()),
      [route.reference("QKG6ERBF")]: () => hit(),
    });
    const { navigate } = renderPage("owner", { strict: true });
    await tripSection(/Sunset Harbor Cruise/);
    type("QKG6ERBF");
    fireEvent.click(find());
    await waitFor(() => expect(navigate).toHaveBeenCalledWith(`/bookings/${bookingIds.maya}`));
    expect(screen.getByRole("button", { name: "Find" }).getAttribute("aria-busy")).toBeNull();
  });
});

describe("the page's own headings and landmarks", () => {
  it("names the operator above the page's one h1, and the day below it as an h2", async () => {
    api({ [route.day()]: () => json(dayBody()), [route.catalog()]: () => catalog(marinaZone) });
    const { container } = renderPage();
    await tripSection(/Sunset Harbor Cruise/);
    expect(screen.getAllByRole("heading", { level: 1 }).map((h) => text(h))).toEqual(["Bookings"]);
    expect(text(container.querySelector(".tg-eyebrow"))).toBe(tenantName);
    // The day is the one h2, with each trip an h3 beneath it.
    expect(screen.getAllByRole("heading", { level: 2 }).map((h) => text(h))).toEqual([
      "Wednesday, November 4 Today",
    ]);
    expect(screen.getAllByRole("heading", { level: 3 })).toHaveLength(2);
    expect(screen.getByRole("navigation", { name: "Days" })).toBeTruthy();
  });
});
