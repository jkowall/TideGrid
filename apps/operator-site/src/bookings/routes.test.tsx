// @vitest-environment jsdom

// Staff in Tokyo looking at a New York marina: times must stay New York's.
process.env.TZ = "Asia/Tokyo";

import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { MeResponse, StaffRole, StaffTrip } from "@tidegrid/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ConsoleShell, routeOf } from "../ConsoleShell.tsx";
import { ConsoleButtonLink, ConsoleLink, NavigationProvider } from "../navigation.tsx";
import {
  type Answer,
  api,
  asSeenBy,
  bookingDetail,
  bookingIds,
  type Call,
  callsTo,
  catalog,
  dayBody,
  expectNoPersonalDataInAddresses,
  finalizationException,
  json,
  mayaBooking,
  me,
  membership,
  route,
  staffTrip,
  strayRequests,
  sunsetTrip,
  tenantName,
  text,
  tripIds,
  tripRoster,
} from "./fixtures.ts";

const booking = bookingIds.maya;
const sunset = tripIds.sunset;

// Pages and their addresses -------------------------------------------------------------

describe("which page an address names", () => {
  it.each([
    ["/", { kind: "overview" }],
    ["/calendar", { kind: "calendar" }],
    ["/bookings", { kind: "bookings" }],
    [`/bookings/${booking}`, { kind: "booking", bookingId: booking }],
    ["/bookings/not-a-uuid", { kind: "not_found" }],
    ["/exceptions", { kind: "exceptions" }],
    [`/trips/${sunset}/roster`, { kind: "roster", tripId: sunset }],
  ])("reads %s", (path, expected) => {
    expect(routeOf(path)).toEqual(expected);
  });

  it("reads an id in either case, as lowercase", () => {
    expect(routeOf(`/bookings/${booking.toUpperCase()}`)).toEqual({
      kind: "booking",
      bookingId: booking,
    });
    expect(routeOf(`/trips/${sunset.toUpperCase()}/roster`)).toEqual({
      kind: "roster",
      tripId: sunset,
    });
  });

  it.each([
    `/bookings/${booking}/more`,
    `/bookings/${booking}x`,
    "/bookings/1",
    "/bookings/%20",
    "/trips/not-a-uuid/roster",
    `/trips/${sunset}`,
    `/trips/${sunset}/roster/extra`,
    "/trips//roster",
    "/roster",
    "/booking",
    "/Bookings",
    "/exceptions/1",
    "/overview",
    "",
  ])("does not take %j for a page", (path) => {
    expect(routeOf(path)).toEqual({ kind: "not_found" });
  });
});

// The shell ----------------------------------------------------------------------------

const thursdayTrip = {
  ...sunsetTrip,
  localDate: "2026-11-05",
  startsAt: "2026-11-05T23:00:00.000Z",
};

/** The list for a date: Wednesday's day, Thursday's one trip, or an empty day. */
const dayFor: Answer = (call: Call) => {
  const date = call.query.get("date") ?? "";
  if (date === "2026-11-04") return json(dayBody());
  if (date === "2026-11-05") {
    return json(
      dayBody({ date, trips: [thursdayTrip], bookings: [{ ...mayaBooking, tripId: sunset }] }),
    );
  }
  return json(dayBody({ date, trips: [], bookings: [] }));
};

/** Answers for every page the shell can open. */
function shellApi(extra: Record<string, Answer | Answer[]> = {}) {
  return api({
    [route.day()]: dayFor,
    [route.booking(booking)]: () => json({ booking: bookingDetail() }),
    [route.roster(sunset)]: () => json({ roster: tripRoster() }),
    [route.exceptions()]: () => json({ exceptions: [], nextBefore: null }),
    [route.trips()]: () => json({ trips: [] }),
    [route.reference("QKG6ERBF")]: () =>
      json({
        booking: { id: booking, reference: "QKG6ERBF", tripId: sunset, localDate: "2026-11-04" },
      }),
    ...extra,
  });
}

function renderShell(path: string, user: MeResponse = me("owner")) {
  window.history.replaceState(null, "", path);
  return render(<ConsoleShell me={user} signOut={<button type="button">Sign out</button>} />);
}

const nav = () => screen.getByRole("navigation", { name: "Console" });
const navLink = (name: string) => within(nav()).getByRole("link", { name });
/** What each section's link says about the page: "page", "true", or nothing. */
const marked = () =>
  Object.fromEntries(
    ["Overview", "Calendar", "Bookings", "Exceptions"].map((label) => [
      label,
      navLink(label).getAttribute("aria-current"),
    ]),
  );
const h1 = (name: string | RegExp) => screen.findByRole("heading", { level: 1, name });
const tripSection = (name: RegExp) => screen.findByRole("region", { name });
const dayRequests = (calls: Call[]) => callsTo(calls, route.day()).map((c) => c.query.toString());
const params = () => Object.fromEntries(new URLSearchParams(window.location.search));

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  // Wednesday noon in New York, which is already Thursday 2 AM in Tokyo.
  vi.setSystemTime(new Date("2026-11-04T17:00:00Z"));
  window.history.replaceState(null, "", "/");
  // The shell remembers the chosen operator; every test starts with none.
  window.localStorage.clear();
  window.sessionStorage.clear();
});

afterEach(() => {
  const strays = strayRequests();
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  expect(strays).toEqual([]);
});

describe("the navigation", () => {
  const none = null;
  it.each([
    [
      "/",
      "Overview",
      "Overview",
      { Overview: "page", Calendar: none, Bookings: none, Exceptions: none },
    ],
    [
      "/calendar",
      "Calendar",
      "Calendar",
      { Overview: none, Calendar: "page", Bookings: none, Exceptions: none },
    ],
    [
      "/bookings",
      "Bookings",
      "Bookings",
      { Overview: none, Calendar: none, Bookings: "page", Exceptions: none },
    ],
    [
      `/bookings?day=2026-11-05&trip=${sunset}`,
      "Bookings",
      "Bookings",
      { Overview: none, Calendar: none, Bookings: "page", Exceptions: none },
    ],
    [
      `/bookings/${booking}`,
      "Booking QKG6ERBF",
      "Booking",
      { Overview: none, Calendar: none, Bookings: "true", Exceptions: none },
    ],
    [
      `/trips/${sunset}/roster`,
      "Roster",
      "Roster",
      { Overview: none, Calendar: none, Bookings: "true", Exceptions: none },
    ],
    [
      "/exceptions",
      "Payment exceptions",
      "Payment exceptions",
      { Overview: none, Calendar: none, Bookings: none, Exceptions: "page" },
    ],
    [
      "/bookings/not-a-uuid",
      "Page not found",
      "Not found",
      { Overview: none, Calendar: none, Bookings: none, Exceptions: none },
    ],
  ])("at %s: the page %j, titled %j, marks %j", async (path, heading, title, expected) => {
    shellApi();
    renderShell(path);
    await h1(heading);
    expect(marked()).toEqual(expected);
    expect(document.title).toBe(`${title} · ${tenantName} · TideGrid`);
  });

  it("marks the page itself 'page' and a page inside its section 'true', never both on one link", async () => {
    shellApi();
    renderShell("/bookings");
    await h1("Bookings");
    expect(navLink("Bookings").getAttribute("aria-current")).toBe("page");
    fireEvent.click(screen.getByRole("link", { name: "Exceptions" }));
    await h1("Payment exceptions");
    expect(marked()).toEqual({
      Overview: null,
      Calendar: null,
      Bookings: null,
      Exceptions: "page",
    });
    // The nav lists the four sections, in order.
    expect(
      within(nav())
        .getAllByRole("link")
        .map((a) => text(a)),
    ).toEqual(["Overview", "Calendar", "Bookings", "Exceptions"]);
  });

  it("shows a page that is not part of the console without asking for anything", async () => {
    const calls = shellApi();
    renderShell("/bookings/not-a-uuid");
    await h1("Page not found");
    expect(
      screen.getByRole("heading", { level: 2, name: "This page isn't part of the console" }),
    ).toBeTruthy();
    expect(screen.getByText("Choose a section from the navigation to continue.")).toBeTruthy();
    expect(calls).toEqual([]);
  });
});

describe("following a link with a query string", () => {
  it("opens the trip's bookings from the calendar's booked count, afresh, with the day and trip kept", async () => {
    const push = vi.spyOn(window.history, "pushState");
    const calls = shellApi({
      [route.trips()]: () =>
        json({
          trips: [
            staffTrip({
              capacity: { kind: "seats", total: 20, remaining: 17, held: 0, confirmed: 3 },
            }),
          ],
        }),
    });
    renderShell("/calendar");
    const link = await screen.findByRole("link", { name: /^3 booked: see the bookings for/ });
    expect(link.getAttribute("href")).toBe(`/bookings?day=2026-11-05&trip=${sunset}`);
    link.focus();
    fireEvent.click(link);

    // The page changed in place: one history entry, no reload, and the new page's heading has focus.
    expect(push).toHaveBeenCalledTimes(1);
    const heading = await h1("Bookings");
    await waitFor(() => expect(document.activeElement).toBe(heading));
    expect(window.location.pathname).toBe("/bookings");
    // The query is kept. (With the viewer in Tokyo the page first takes the viewer's Thursday
    // for today and drops the day, then writes it back, in its own order, once the catalog has
    // said where the marina is.)
    await waitFor(() => expect(params()).toEqual({ day: "2026-11-05", trip: sunset }));

    // The new list is for that day and that trip alone.
    await tripSection(/Sunset Harbor Cruise/);
    expect(dayRequests(calls)).toEqual([`date=2026-11-05&tripId=${sunset}`]);
    expect((screen.getByRole("combobox", { name: "Trip" }) as HTMLSelectElement).value).toBe(
      sunset,
    );
    expect(text(screen.getByRole("heading", { level: 2, name: /^Thursday, November 5/ }))).toBe(
      "Thursday, November 5",
    );
    expect(marked()).toMatchObject({ Bookings: "page", Calendar: null });
    // A calendar page's week is not asked for again.
    expect(callsTo(calls, route.trips())).toHaveLength(1);
  });

  it("opens the same list afresh when the link names the same path with another query", async () => {
    const calls = shellApi();
    renderShell(`/bookings?day=2026-11-05&trip=${sunset}`);
    await tripSection(/Sunset Harbor Cruise/);
    expect((screen.getByRole("combobox", { name: "Trip" }) as HTMLSelectElement).value).toBe(
      sunset,
    );

    navLink("Bookings").focus();
    fireEvent.click(navLink("Bookings"));
    // Nothing of the last query is left: today, every trip, and the address says so.
    await tripSection(/Private Half-Day Charter/);
    expect(dayRequests(calls)).toEqual([`date=2026-11-05&tripId=${sunset}`, "date=2026-11-04"]);
    expect(window.location.pathname + window.location.search).toBe("/bookings");
    expect((screen.getByRole("combobox", { name: "Trip" }) as HTMLSelectElement).value).toBe("");
    const heading = await h1("Bookings");
    await waitFor(() => expect(document.activeElement).toBe(heading));
  });

  // A page may move its own address within itself (the list's day, with replaceState). A link
  // to the address it was opened at is another address then, and opens the page afresh.
  it("returns to today when the Bookings link is chosen after the list moved to another day", async () => {
    const calls = shellApi();
    renderShell("/bookings");
    await tripSection(/Sunset Harbor Cruise/);
    fireEvent.click(screen.getByRole("button", { name: "Next day" }));
    await waitFor(() => expect(window.location.search).toBe("?day=2026-11-05"));
    await tripSection(/Sunset Harbor Cruise/);

    navLink("Bookings").focus();
    fireEvent.click(navLink("Bookings"));
    // The address is /bookings now, so the page must show what /bookings shows: today.
    expect(window.location.pathname + window.location.search).toBe("/bookings");
    await waitFor(() =>
      expect(text(document.querySelector(".bk-bar__day"))).toBe("Wednesday, November 4 Today"),
    );
    await tripSection(/Private Half-Day Charter/);
    expect(dayRequests(calls).at(-1)).toBe("date=2026-11-04");
    expect(window.location.pathname + window.location.search).toBe("/bookings");
    // A page that opens afresh takes focus, as any page change does.
    const heading = await h1("Bookings");
    await waitFor(() => expect(document.activeElement).toBe(heading));
  });

  it("does nothing for a link to the very address already showing", async () => {
    const push = vi.spyOn(window.history, "pushState");
    const calls = shellApi();
    renderShell("/bookings");
    const list = await tripSection(/Sunset Harbor Cruise/);
    const asked = dayRequests(calls).length;

    navLink("Bookings").focus();
    fireEvent.click(navLink("Bookings"));
    await new Promise((resolve) => setTimeout(resolve, 30));
    // No history entry, no new page, no new request, and focus stays where the person put it.
    expect(push).not.toHaveBeenCalled();
    expect(dayRequests(calls)).toHaveLength(asked);
    expect(screen.getByRole("region", { name: /Sunset Harbor Cruise/ })).toBe(list);
    expect(document.activeElement).toBe(navLink("Bookings"));
  });

  it("goes from a booking back to its day's list, which reads the day from the address", async () => {
    const calls = shellApi();
    renderShell(`/bookings/${booking}`);
    await h1("Booking QKG6ERBF");
    fireEvent.click(screen.getByRole("link", { name: "Bookings on Wed, Nov 4" }));
    await tripSection(/Sunset Harbor Cruise/);
    expect(dayRequests(calls)).toEqual(["date=2026-11-04"]);
    // The trip's day is today at the marina, so the page leaves it out of the address once the
    // catalog has said where the marina is.
    await waitFor(() =>
      expect(window.location.pathname + window.location.search).toBe("/bookings"),
    );
    expect(marked()).toMatchObject({ Bookings: "page" });
  });

  it("goes from a booking to the trip's own bookings and to its roster", async () => {
    const calls = shellApi();
    renderShell(`/bookings/${booking}`);
    await h1("Booking QKG6ERBF");
    fireEvent.click(screen.getByRole("link", { name: "Bookings on this trip" }));
    await tripSection(/Sunset Harbor Cruise/);
    expect(dayRequests(calls)).toEqual([`date=2026-11-04&tripId=${sunset}`]);
    // A trip travels with its day in the address, so the address still works tomorrow.
    await waitFor(() => expect(params()).toEqual({ day: "2026-11-04", trip: sunset }));
    expect(window.location.pathname).toBe("/bookings");
  });

  it("opens a roster from a trip on the list, and the list again from the roster's back link", async () => {
    const calls = shellApi();
    renderShell("/bookings");
    await tripSection(/Sunset Harbor Cruise/);
    fireEvent.click(screen.getByRole("link", { name: /^Roster for Sunset Harbor Cruise/ }));
    await h1("Roster");
    await screen.findByRole("heading", { level: 2, name: "Sunset Harbor Cruise" });
    expect(window.location.pathname).toBe(`/trips/${sunset}/roster`);
    expect(marked()).toMatchObject({ Bookings: "true" });

    fireEvent.click(screen.getByRole("link", { name: "Bookings on Wed, Nov 4" }));
    await tripSection(/Sunset Harbor Cruise/);
    expect(dayRequests(calls)).toEqual(["date=2026-11-04", `date=2026-11-04&tripId=${sunset}`]);
    await waitFor(() => expect(params()).toEqual({ day: "2026-11-04", trip: sunset }));
  });

  it("opens a trip's bookings from a payment exception", async () => {
    const calls = shellApi({
      [route.exceptions()]: () => json({ exceptions: [finalizationException()], nextBefore: null }),
    });
    renderShell("/exceptions");
    const link = await screen.findByRole("link", { name: /^Sunset Harbor Cruise, Wed, Nov 4/ });
    fireEvent.click(link);
    await tripSection(/Sunset Harbor Cruise/);
    expect(dayRequests(calls)).toEqual([`date=2026-11-04&tripId=${sunset}`]);
    await h1("Bookings");
  });

  it("restores the list's day and trip from the address on the browser's Back button", async () => {
    const calls = shellApi();
    renderShell(`/bookings?day=2026-11-05&trip=${sunset}`);
    await tripSection(/Sunset Harbor Cruise/);
    fireEvent.click(screen.getByRole("link", { name: /^Booking\s?QKG6ERBF$/ }));
    await h1("Booking QKG6ERBF");
    // Back: the browser restores the address, and the shell reads it.
    window.history.replaceState(null, "", `/bookings?day=2026-11-05&trip=${sunset}`);
    fireEvent.popState(window);
    await tripSection(/Sunset Harbor Cruise/);
    expect(dayRequests(calls)).toEqual([
      `date=2026-11-05&tripId=${sunset}`,
      `date=2026-11-05&tripId=${sunset}`,
    ]);
    await waitFor(() => expect(params()).toEqual({ day: "2026-11-05", trip: sunset }));
    const heading = await h1("Bookings");
    await waitFor(() => expect(document.activeElement).toBe(heading));
  });

  it("opens a booking found by its reference, with nothing of the guest in the address", async () => {
    shellApi();
    renderShell("/bookings");
    await tripSection(/Sunset Harbor Cruise/);
    fireEvent.change(screen.getByRole("textbox", { name: "Find by booking reference" }), {
      target: { value: "qkg6-erbf" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Find" }));
    await h1("Booking QKG6ERBF");
    expect(window.location.pathname).toBe(`/bookings/${booking}`);
    expect(window.location.search).toBe("");
    expect(marked()).toMatchObject({ Bookings: "true" });
    expectNoPersonalDataInAddresses();
  });
});

describe("one operator's page never carries over to another", () => {
  const reef = "7d1e5b3a-1c2f-4a8e-9b61-0a1c2e3f4a02";
  const both = (): MeResponse => {
    const base = me("owner");
    return {
      ...base,
      memberships: [
        membership("owner"),
        {
          tenantId: reef,
          tenantSlug: "demo-reef",
          tenantName: "Demo Reef Divers",
          role: "finance",
        },
      ],
    };
  };

  /** Two operators in two zones: at 5 AM UTC it is Wednesday in New York, Tuesday in Honolulu. */
  function twoOperators(extra: Record<string, Answer | Answer[]> = {}) {
    vi.setSystemTime(new Date("2026-11-04T05:00:00Z"));
    const harborDays: string[] = [];
    const reefDays: string[] = [];
    api({
      ...extra,
      [route.catalog()]: () => catalog("America/New_York"),
      [route.catalog(reef)]: () => catalog("Pacific/Honolulu"),
      [route.day()]: (call) => {
        harborDays.push(call.query.toString());
        return json(dayBody());
      },
      [route.day(reef)]: (call) => {
        reefDays.push(call.query.toString());
        return json({
          date: call.query.get("date"),
          trips: [
            {
              ...sunsetTrip,
              timeZone: "Pacific/Honolulu",
              localDate: "2026-11-03",
              bookings: 1,
              guests: 3,
            },
          ],
          // Finance: no booker key.
          bookings: [{ ...mayaBooking, booker: undefined }],
          nextAfter: null,
        });
      },
    });
    return { harborDays, reefDays };
  }

  it("opens another operator's list in its own zone and with its own role", async () => {
    const { harborDays, reefDays } = twoOperators();
    renderShell("/bookings", both());
    await tripSection(/Sunset Harbor Cruise/);
    // An owner sees who booked.
    expect(screen.getByText("Maya Okonkwo")).toBeTruthy();
    expect(harborDays).toEqual(["date=2026-11-04"]);

    const picker = screen.getByRole("combobox", { name: "Operator" });
    picker.focus();
    fireEvent.change(picker, { target: { value: reef } });
    await waitFor(() => expect(reefDays).toHaveLength(1));
    // The other operator's own today.
    expect(reefDays).toEqual(["date=2026-11-03"]);
    await screen.findByRole("heading", { level: 2, name: /^Tuesday, November 3/ });
    await tripSection(/Sunset Harbor Cruise/);
    // Finance there: no names, and the note says so.
    expect(screen.queryByText("Maya Okonkwo")).toBeNull();
    expect(screen.getByText(/aren't shown to your role/)).toBeTruthy();
    expect(screen.queryByRole("link", { name: /^Roster/ })).toBeNull();
    // The person is still choosing an operator, so focus stays with the picker.
    expect(document.activeElement).toBe(picker);
  });

  // A trip filter names one operator's trip, and its day is one marina's; both live in the address.
  // An operator switch drops them, so the next operator's list does not ask for a trip that is
  // not its own, or for a day that is another marina's today.
  it("drops the first operator's trip filter and its day when another operator is chosen", async () => {
    const { reefDays } = twoOperators();
    renderShell("/bookings", both());
    await tripSection(/Sunset Harbor Cruise/);
    fireEvent.change(screen.getByRole("combobox", { name: "Trip" }), { target: { value: sunset } });
    await waitFor(() => expect(params()).toEqual({ day: "2026-11-04", trip: sunset }));

    fireEvent.change(screen.getByRole("combobox", { name: "Operator" }), {
      target: { value: reef },
    });
    await waitFor(() => expect(reefDays).toHaveLength(1));
    // Another operator's list starts from nothing: today, every trip.
    expect(reefDays).toEqual(["date=2026-11-03"]);
    await tripSection(/Sunset Harbor Cruise/);
    expect(screen.queryByText(/doesn't depart on/)).toBeNull();
    expect((screen.getByRole("combobox", { name: "Trip" }) as HTMLSelectElement).value).toBe("");
    expect(window.location.search).toBe("");
  });

  it("remembers the operator chosen, so a reload opens a booking's address with it", async () => {
    twoOperators({
      [route.booking(booking, reef)]: () => json({ booking: asSeenBy("finance", bookingDetail()) }),
    });
    const first = renderShell("/bookings", both());
    await tripSection(/Sunset Harbor Cruise/);
    fireEvent.change(screen.getByRole("combobox", { name: "Operator" }), {
      target: { value: reef },
    });
    await screen.findByRole("heading", { level: 2, name: /^Tuesday, November 3/ });
    first.unmount();

    // The same tab, loaded again at a Reef booking's address.
    renderShell(`/bookings/${booking}`, both());
    await h1("Booking QKG6ERBF");
    expect((screen.getByRole("combobox", { name: "Operator" }) as HTMLSelectElement).value).toBe(
      reef,
    );
    expect(screen.queryByText("This booking isn't here")).toBeNull();
  });

  it("opens a new tab with the operator chosen last in any tab", async () => {
    twoOperators();
    window.localStorage.setItem("tidegrid.console.operator", reef);
    renderShell("/bookings", both());
    await screen.findByRole("heading", { level: 2, name: /^Tuesday, November 3/ });
    expect((screen.getByRole("combobox", { name: "Operator" }) as HTMLSelectElement).value).toBe(
      reef,
    );
  });

  it("starts with the first operator when the one remembered is not the person's", async () => {
    const { harborDays } = twoOperators();
    window.sessionStorage.setItem(
      "tidegrid.console.operator",
      "7d1e5b3a-1c2f-4a8e-9b61-0a1c2e3f4a99",
    );
    renderShell("/bookings", both());
    await tripSection(/Sunset Harbor Cruise/);
    expect(harborDays).toEqual(["date=2026-11-04"]);
    expect((screen.getByRole("combobox", { name: "Operator" }) as HTMLSelectElement).value).toBe(
      membership("owner").tenantId,
    );
  });

  it("still switches operators when the browser blocks storage", async () => {
    const { reefDays } = twoOperators();
    const blocked = () => {
      throw new DOMException("The operation is insecure.", "SecurityError");
    };
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(blocked);
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(blocked);
    renderShell("/bookings", both());
    await tripSection(/Sunset Harbor Cruise/);
    fireEvent.change(screen.getByRole("combobox", { name: "Operator" }), {
      target: { value: reef },
    });
    await waitFor(() => expect(reefDays).toEqual(["date=2026-11-03"]));
  });

  it("lets the next page change take focus again after an operator switch", async () => {
    twoOperators({ [route.exceptions(reef)]: () => json({ exceptions: [], nextBefore: null }) });
    renderShell("/bookings", both());
    await tripSection(/Sunset Harbor Cruise/);
    const picker = screen.getByRole("combobox", { name: "Operator" });
    picker.focus();
    fireEvent.change(picker, { target: { value: reef } });
    await tripSection(/Sunset Harbor Cruise/);
    // The picker keeps focus through the switch; the next page change moves it, as any does.
    expect(document.activeElement).toBe(picker);
    fireEvent.click(navLink("Exceptions"));
    const heading = await h1("Payment exceptions");
    await waitFor(() => expect(document.activeElement).toBe(heading));
  });

  it("reads the next operator's role for a roster too", async () => {
    api({
      [route.roster(sunset)]: () => json({ roster: tripRoster() }),
    });
    renderShell(`/trips/${sunset}/roster`, both());
    await screen.findByRole("heading", { level: 2, name: "Sunset Harbor Cruise" });
    const picker = screen.getByRole("combobox", { name: "Operator" });
    fireEvent.change(picker, { target: { value: reef } });
    // Finance at the other operator: the role empty state, and no request for its roster.
    expect(
      await screen.findByRole("heading", { level: 2, name: "Your role can't see rosters" }),
    ).toBeTruthy();
    expect(screen.queryByRole("table")).toBeNull();
  });
});

describe("links", () => {
  /** Clicks as they bubble to the document: whether the console took them, then let go. */
  function watchClicks() {
    const intercepted: boolean[] = [];
    const listener = (event: Event) => {
      intercepted.push(event.defaultPrevented);
      event.preventDefault();
    };
    document.addEventListener("click", listener);
    return { intercepted, stop: () => document.removeEventListener("click", listener) };
  }

  function renderLinks(onClick?: (event: { preventDefault: () => void }) => void) {
    const navigate = vi.fn();
    render(
      <NavigationProvider navigate={navigate}>
        <ConsoleLink href="/bookings?day=2026-11-05" aria-current="page" onClick={onClick}>
          List
        </ConsoleLink>
        <ConsoleButtonLink href="/exceptions" icon="alert-triangle">
          Exceptions
        </ConsoleButtonLink>
      </NavigationProvider>,
    );
    return navigate;
  }

  it("moves in place on a plain click, query included, and stops the browser's own navigation", () => {
    const watch = watchClicks();
    const navigate = renderLinks();
    const list = screen.getByRole("link", { name: "List" });
    expect(list.getAttribute("href")).toBe("/bookings?day=2026-11-05");
    expect(list.getAttribute("aria-current")).toBe("page");
    fireEvent.click(list);
    expect(navigate).toHaveBeenLastCalledWith("/bookings?day=2026-11-05");
    fireEvent.click(screen.getByRole("link", { name: "Exceptions" }));
    expect(navigate).toHaveBeenLastCalledWith("/exceptions");
    expect(navigate).toHaveBeenCalledTimes(2);
    // The console stopped the browser's own navigation both times.
    expect(watch.intercepted).toEqual([true, true]);
    watch.stop();
  });

  it.each([
    ["control", { ctrlKey: true }],
    ["command", { metaKey: true }],
    ["shift", { shiftKey: true }],
    ["alt", { altKey: true }],
    ["middle", { button: 1 }],
  ])("leaves a %s click to the browser", (_what, init) => {
    const watch = watchClicks();
    const navigate = renderLinks();
    fireEvent.click(screen.getByRole("link", { name: "List" }), init);
    fireEvent.click(screen.getByRole("link", { name: "Exceptions" }), init);
    expect(navigate).not.toHaveBeenCalled();
    // The browser's own handling was left alone.
    expect(watch.intercepted).toEqual([false, false]);
    watch.stop();
  });

  it("lets a link's own handler stop the move", () => {
    const watch = watchClicks();
    const navigate = renderLinks((event) => event.preventDefault());
    fireEvent.click(screen.getByRole("link", { name: "List" }));
    expect(navigate).not.toHaveBeenCalled();
    watch.stop();
  });
});

// The calendar's booked count ----------------------------------------------------------------

describe("the calendar's booked count", () => {
  /** The text a person sees: what is on screen, less what is only for a screen reader. */
  const visibleText = (element: Element) => {
    const copy = element.cloneNode(true) as Element;
    for (const hidden of copy.querySelectorAll(".tg-visually-hidden")) hidden.remove();
    return text(copy);
  };

  const seats = (capacity: StaffTrip["capacity"], over: Partial<StaffTrip> = {}) =>
    staffTrip({ capacity, ...over });

  async function showWeek(trips: StaffTrip[], role: StaffRole = "owner") {
    shellApi({ [route.trips()]: () => json({ trips }) });
    renderShell("/calendar", me(role));
    await screen.findByRole("heading", { level: 2, name: "Nov 1 to 7, 2026" });
    await screen.findAllByRole("heading", { level: 4 });
  }
  const seatsLine = (heading: RegExp) => {
    const row = screen
      .getByRole("heading", { level: 4, name: heading })
      .closest("li") as HTMLElement;
    return row.querySelector(".cal-trip__facts li:nth-child(2)") as HTMLElement;
  };

  it("links the booked count of seats to the trip's bookings, named for the trip", async () => {
    await showWeek([seats({ kind: "seats", total: 20, remaining: 15, held: 2, confirmed: 3 })]);
    const line = seatsLine(/Sunset Harbor Cruise/);
    const link = within(line).getByRole("link");
    // The visible words are the count; the name starts with them and names the trip.
    expect(link.firstChild?.textContent).toBe("3 booked");
    expect(link.querySelector(".tg-visually-hidden")).not.toBeNull();
    expect(
      within(line).getByRole("link", {
        name: /^3 booked: see the bookings for Sunset Harbor Cruise, Thu, Nov 5, 6:00\sPM$/,
      }),
    ).toBe(link);
    expect(link.getAttribute("href")).toBe(`/bookings?day=2026-11-05&trip=${sunset}`);
    // What is on screen is the calendar's own text, whole.
    expect(visibleText(line)).toBe("15 of 20 seats left: 3 booked, 2 held");
    expect(visibleText(link)).toBe("3 booked");
  });

  it("links a booked whole boat by its last word", async () => {
    const charter = staffTrip({
      tripId: tripIds.charter,
      localStartTime: "08:00",
      startsAt: "2026-11-05T13:00:00.000Z",
      endsAt: "2026-11-05T17:00:00.000Z",
      startsAtLocal: "2026-11-05T08:00:00-05:00",
      endsAtLocal: "2026-11-05T12:00:00-05:00",
      durationMinutes: 240,
      productName: "Private Half-Day Charter",
      productKind: "private_charter",
      boatName: "Blue Heron",
      capacity: { kind: "whole_boat", total: 12, remaining: 0, held: 0, confirmed: 12 },
    });
    await showWeek([charter]);
    const line = seatsLine(/Private Half-Day Charter/);
    const link = within(line).getByRole("link");
    expect(visibleText(line)).toBe("Whole boat, booked");
    expect(link.firstChild?.textContent).toBe("booked");
    expect(
      within(line).getByRole("link", {
        name: /^booked: see the bookings for Private Half-Day Charter, Thu, Nov 5, 8:00\sAM$/,
      }),
    ).toBe(link);
    expect(link.getAttribute("href")).toBe(`/bookings?day=2026-11-05&trip=${tripIds.charter}`);
  });

  it("links a departed trip's booked count as well, since its bookings are still there", async () => {
    await showWeek([
      seats(
        { kind: "seats", total: 20, remaining: 17, held: 0, confirmed: 3 },
        {
          salesState: "completed",
          localDate: "2026-11-02",
          startsAt: "2026-11-02T23:00:00.000Z",
          endsAt: "2026-11-03T00:30:00.000Z",
          startsAtLocal: "2026-11-02T18:00:00-05:00",
          endsAtLocal: "2026-11-02T19:30:00-05:00",
          salesCloseAt: "2026-11-02T22:00:00.000Z",
        },
      ),
    ]);
    const line = seatsLine(/Sunset Harbor Cruise/);
    expect(visibleText(line)).toBe("20 seats: 3 booked");
    expect(within(line).getByRole("link").getAttribute("href")).toBe(
      `/bookings?day=2026-11-02&trip=${sunset}`,
    );
  });

  it("has no link when nothing is booked", async () => {
    await showWeek([
      seats({ kind: "seats", total: 20, remaining: 18, held: 2, confirmed: 0 }),
      seats(
        { kind: "seats", total: 20, remaining: 20 },
        { tripId: tripIds.charter, productName: "Evening Cruise" },
      ),
    ]);
    const held = seatsLine(/Sunset Harbor Cruise$/);
    expect(visibleText(held)).toBe("18 of 20 seats left: 2 held");
    expect(within(held).queryByRole("link")).toBeNull();
    const none = seatsLine(/Evening Cruise$/);
    expect(visibleText(none)).toBe("20 of 20 seats left");
    expect(within(none).queryByRole("link")).toBeNull();
    // No link to the bookings anywhere in the week (the navigation's own is outside it).
    expect(document.querySelector('.cal a[href^="/bookings"]')).toBeNull();
  });

  it("offers the link to every role, since the API decides what the list shows each", async () => {
    for (const role of ["owner", "booking_staff", "finance"] as const) {
      await showWeek(
        [seats({ kind: "seats", total: 20, remaining: 17, held: 0, confirmed: 3 })],
        role,
      );
      expect(
        within(seatsLine(/Sunset Harbor Cruise/))
          .getByRole("link")
          .getAttribute("href"),
        role,
      ).toBe(`/bookings?day=2026-11-05&trip=${sunset}`);
      cleanup();
    }
  });
});
