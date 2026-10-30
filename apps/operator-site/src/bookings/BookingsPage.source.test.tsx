// @vitest-environment jsdom

// Staff in Tokyo looking at a New York marina: times must stay New York's.
process.env.TZ = "Asia/Tokyo";

import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { StaffRole } from "@tidegrid/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NavigationProvider } from "../navigation.tsx";
import { searchBookings } from "../search/api.ts";
import { loadBooking, loadDay, loadExceptions, loadRoster } from "./api.ts";
import { BookingsPage } from "./BookingsPage.tsx";
import {
  type Answer,
  api,
  asSeenBy,
  bookingDetail,
  bookingIds,
  callsTo,
  charterTrip,
  dayBody,
  deferred,
  expectNoPersonalDataInAddresses,
  finalizationException,
  json,
  luisBooking,
  mayaBooking,
  membership,
  personalFragments,
  priyaBooking,
  route,
  searchBody,
  strayRequests,
  sunsetTrip,
  tenantId,
  text,
  tripIds,
  tripRoster,
} from "./fixtures.ts";
import {
  allSourcesBody,
  bookable,
  counted,
  directBody,
  emptyDay,
  importedBooking,
  staffBody,
  staffBooking,
} from "./source-fixtures.ts";

/**
 * G2.12e: the day list by source. A badge on staff bookings, a Source filter
 * beside Trip that lives in the address, and Book in each trip's header where
 * the trip still takes a booking.
 */

const wednesday = "2026-11-04";

function renderPage(role: StaffRole = "owner") {
  const navigate = vi.fn();
  render(
    <NavigationProvider navigate={navigate}>
      <BookingsPage membership={membership(role)} focusHeading={false} />
    </NavigationProvider>,
  );
  return { navigate };
}

/** The day's answer for the source asked: Wednesday's data, or an empty day. */
const bySource =
  (role: StaffRole = "owner"): Answer =>
  (call) => {
    const date = call.query.get("date") ?? "";
    const source = call.query.get("source");
    if (date !== wednesday) return json(emptyDay(date, source));
    const body =
      source === "staff_assisted"
        ? staffBody()
        : source === "direct"
          ? directBody()
          : allSourcesBody();
    return json(asSeenBy(role, body));
  };

const tripSection = (name: RegExp) => screen.findByRole("region", { name });
const rowsOf = (section: HTMLElement) => within(section).queryAllByRole("listitem");
const rowOf = (reference: string) =>
  screen.getByRole("link", { name: new RegExp(`^Booking\\s?${reference}$`) }).closest("li");
const sourceSelect = () => screen.getByRole("combobox", { name: "Source" }) as HTMLSelectElement;
const liveText = () => text(document.querySelector('.bk > p[role="status"]'));
const parts = (element: Element | null) =>
  [...(element?.children ?? [])].map((child) => text(child));
const dayRequests = (calls: ReturnType<typeof api>) =>
  callsTo(calls, route.day()).map((c) => c.query.toString());
/** The address's query as an object: the order of its parameters is not the point. */
const params = () => Object.fromEntries(new URLSearchParams(window.location.search));
const busy = () => document.querySelector(".bk-day")?.getAttribute("aria-busy");
/** The day's totals, read: they ask from an effect of the commit that shows the trips. */
const totalsRead = () =>
  waitFor(() =>
    expect(screen.getByRole("region", { name: "Day totals" }).getAttribute("aria-busy")).toBe(
      "false",
    ),
  );
/** The source badge of a row, if it has one. */
const sourceBadge = (row: Element | null) => row?.querySelector(".bk-row__source") ?? null;

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

describe("the staff booking badge (G2.12e)", () => {
  it.each(["owner", "booking_staff", "finance"] as const)(
    "shows %s which bookings staff took, with an icon, and nothing on a guest's own",
    async (role) => {
      api({ [route.day()]: bySource(role) });
      renderPage(role);
      const sunset = await tripSection(/Sunset Harbor Cruise/);
      expect(rowsOf(sunset)).toHaveLength(3);
      const badge = sourceBadge(rowOf("K7DESK42"));
      expect(text(badge)).toBe("Source: Staff booking, walk-up");
      // Said in words, with an icon beside them, never by color alone.
      expect(badge?.querySelector(".tg-status svg.tg-icon")).not.toBeNull();
      expect(text(badge?.querySelector(".tg-visually-hidden"))).toBe("Source:");
      // Outside the facts, so the columns stay as they were.
      expect(
        rowOf("K7DESK42")
          ?.querySelector("dl")
          ?.contains(badge as Node),
      ).toBe(false);
      for (const reference of ["QKG6ERBF", "7HM2P9TW", "3ZRB8N4C"]) {
        expect(sourceBadge(rowOf(reference)), reference).toBeNull();
      }
    },
  );

  it("lists a booking of a source it does not know, with no badge, and the day still loads", async () => {
    api({
      [route.day()]: () =>
        json(
          allSourcesBody({
            bookings: [priyaBooking, mayaBooking, importedBooking, staffBooking],
          }),
        ),
    });
    renderPage();
    const sunset = await tripSection(/Sunset Harbor Cruise/);
    expect(rowsOf(sunset)).toHaveLength(3);
    expect(sourceBadge(rowOf("M9TRVL3X"))).toBeNull();
    expect(text(sourceBadge(rowOf("K7DESK42")))).toBe("Source: Staff booking, walk-up");
  });
});

describe("filtering by source (G2.12e)", () => {
  it("offers every source, asks for the one chosen, writes it into the address, and keeps the control focused while the list refreshes", async () => {
    const refresh = deferred();
    const calls = api({
      [route.day()]: [() => json(allSourcesBody()), refresh.answer, () => json(allSourcesBody())],
    });
    renderPage();
    await tripSection(/Sunset Harbor Cruise/);
    const select = sourceSelect();
    expect(
      within(select)
        .getAllByRole("option")
        .map((o) => text(o)),
    ).toEqual(["All sources", "Online, by the guest", "Staff bookings"]);
    expect(select.value).toBe("");

    select.focus();
    fireEvent.change(select, { target: { value: "staff_assisted" } });
    await waitFor(() => expect(callsTo(calls, route.day())).toHaveLength(2));
    expect(callsTo(calls, route.day())[1]?.query.get("source")).toBe("staff_assisted");
    expect(callsTo(calls, route.day())[1]?.query.get("date")).toBe(wednesday);
    // Today with a source: the address keeps the source and leaves the day out.
    await waitFor(() => expect(window.location.search).toBe("?source=staff_assisted"));
    // While it works: the list stays, marked busy, and the control keeps its place.
    await waitFor(() => expect(busy()).toBe("true"));
    expect(sourceSelect()).toBe(select);
    expect(document.activeElement).toBe(select);
    expect(rowsOf(await tripSection(/Sunset Harbor Cruise/))).toHaveLength(3);

    refresh.release(json(staffBody()));
    await waitFor(() => expect(busy()).toBeNull());
    expect(sourceSelect()).toBe(select);
    expect(document.activeElement).toBe(select);
    expect(select.value).toBe("staff_assisted");
    const sunset = await tripSection(/Sunset Harbor Cruise/);
    expect(rowsOf(sunset).map((row) => text(row.querySelector(".bk-row__ref")))).toEqual([
      "Booking K7DESK42",
    ]);

    // All sources again: no source in the request or the address.
    fireEvent.change(select, { target: { value: "" } });
    await waitFor(() => expect(callsTo(calls, route.day())).toHaveLength(3));
    expect(callsTo(calls, route.day())[2]?.query.has("source")).toBe(false);
    await waitFor(() => expect(rowsOf(sunset)).toHaveLength(3));
    expect(window.location.search).toBe("");
  });

  it("keeps the source and drops the trip on Previous, Today, and Next", async () => {
    window.history.replaceState(
      null,
      "",
      `/bookings?day=${wednesday}&trip=${tripIds.sunset}&source=staff_assisted`,
    );
    const calls = api({ [route.day()]: bySource() });
    renderPage();
    await tripSection(/Sunset Harbor Cruise/);
    expect(sourceSelect().value).toBe("staff_assisted");

    fireEvent.click(screen.getByRole("button", { name: "Next day" }));
    await screen.findByRole("heading", { name: "No trips on Thursday, November 5" });
    expect(params()).toEqual({ day: "2026-11-05", source: "staff_assisted" });
    fireEvent.click(screen.getByRole("button", { name: "Today" }));
    await tripSection(/Sunset Harbor Cruise/);
    expect(window.location.search).toBe("?source=staff_assisted");
    fireEvent.click(screen.getByRole("button", { name: "Previous day" }));
    await screen.findByRole("heading", { name: "No trips on Tuesday, November 3" });
    expect(params()).toEqual({ day: "2026-11-03", source: "staff_assisted" });

    expect(dayRequests(calls)).toEqual([
      `date=${wednesday}&tripId=${tripIds.sunset}&source=staff_assisted`,
      "date=2026-11-05&source=staff_assisted",
      `date=${wednesday}&source=staff_assisted`,
      "date=2026-11-03&source=staff_assisted",
    ]);
  });

  it("opens filtered from the address, and ignores and drops a source it does not know", async () => {
    window.history.replaceState(null, "", "/bookings?source=staff_assisted");
    const calls = api({ [route.day()]: bySource() });
    renderPage();
    const sunset = await tripSection(/Sunset Harbor Cruise/);
    expect(rowsOf(sunset)).toHaveLength(1);
    expect(sourceSelect().value).toBe("staff_assisted");
    expect(dayRequests(calls)).toEqual([`date=${wednesday}&source=staff_assisted`]);
    expect(window.location.search).toBe("?source=staff_assisted");
    cleanup();

    window.history.replaceState(null, "", `/bookings?day=${wednesday}&source=bogus`);
    const again = api({ [route.day()]: bySource() });
    renderPage();
    await tripSection(/Sunset Harbor Cruise/);
    expect(sourceSelect().value).toBe("");
    expect(dayRequests(again)).toEqual([`date=${wednesday}`]);
    await waitFor(() => expect(window.location.search).toBe(""));
  });

  it("asks for more of the filtered list with the cursor, the trip, and the source", async () => {
    window.history.replaceState(
      null,
      "",
      `/bookings?day=${wednesday}&trip=${tripIds.sunset}&source=direct`,
    );
    const calls = api({
      [route.day()]: [
        () => json(directBody({ bookings: [mayaBooking], nextAfter: bookingIds.maya })),
        () => json(directBody({ bookings: [luisBooking], nextAfter: null })),
      ],
    });
    renderPage();
    const sunset = await tripSection(/Sunset Harbor Cruise/);
    fireEvent.click(screen.getByRole("button", { name: "Show more bookings" }));
    await waitFor(() => expect(rowsOf(sunset)).toHaveLength(2));
    const more = callsTo(calls, route.day())[1]?.query;
    expect(Object.fromEntries(more ?? [])).toEqual({
      date: wednesday,
      tripId: tripIds.sunset,
      source: "direct",
      after: bookingIds.maya,
    });
    expectNoPersonalDataInAddresses();
  });
});

describe("counts under a source filter (G2.12e)", () => {
  it("names the source in each trip's line, the totals, and what a screen reader hears, and says the day's totals cover every source", async () => {
    window.history.replaceState(null, "", "/bookings?source=staff_assisted");
    api({ [route.day()]: bySource() });
    renderPage();
    const sunset = await tripSection(/Sunset Harbor Cruise/);
    const charter = await tripSection(/Private Half-Day Charter/);
    expect(parts(sunset.querySelector(".bk-trip__meta"))).toEqual([
      "Boat: Sea Lark",
      "1 staff booking, 2 guests",
    ]);
    // The charter has departed: no staff booking, and no "yet".
    expect(parts(charter.querySelector(".bk-trip__meta"))).toEqual([
      "Boat: Blue Heron",
      "No staff bookings",
    ]);
    expect(text(document.querySelector(".bk-filters__totals"))).toBe("1 staff booking, 2 guests");
    await waitFor(() =>
      expect(liveText()).toBe("1 staff booking, 2 guests on Wednesday, November 4."),
    );
    expect(text(document.querySelector(".bk-filters__note"))).toBe(
      "Day totals and the export cover bookings from every source.",
    );
    await totalsRead();
  });

  it("says no online bookings where a trip has only staff ones", async () => {
    window.history.replaceState(null, "", "/bookings?source=direct");
    api({
      [route.day()]: () =>
        json(
          directBody({
            trips: [counted(bookable(charterTrip), 0, 0), counted(bookable(sunsetTrip), 0, 0)],
            bookings: [],
          }),
        ),
    });
    renderPage();
    const sunset = await tripSection(/Sunset Harbor Cruise/);
    expect(parts(sunset.querySelector(".bk-trip__meta"))).toEqual([
      "Boat: Sea Lark",
      "No online bookings yet",
    ]);
    expect(text(document.querySelector(".bk-filters__totals"))).toBe("No online bookings");
    await waitFor(() => expect(liveText()).toBe("No online bookings on Wednesday, November 4."));
  });

  it("gives a trip shown alone with none of the source a designed empty state that offers every source", async () => {
    window.history.replaceState(
      null,
      "",
      `/bookings?day=${wednesday}&trip=${tripIds.charter}&source=staff_assisted`,
    );
    const calls = api({ [route.day()]: bySource() });
    renderPage();
    const charter = await tripSection(/Private Half-Day Charter/);
    const empty = within(charter).getByRole("heading", { level: 4 });
    expect(text(empty)).toBe("No staff bookings on this trip");
    expect(text(empty.closest(".tg-empty"))).toContain(
      "Choose All sources to see every booking on it.",
    );
    expect(liveText()).toBe(
      "No staff bookings on Private Half-Day Charter, Wednesday, November 4.",
    );
    const all = within(charter).getByRole("button", { name: "Show all sources" });
    all.focus();
    fireEvent.click(all);
    await waitFor(() => expect(callsTo(calls, route.day())).toHaveLength(2));
    await waitFor(async () =>
      expect(rowsOf(await tripSection(/Private Half-Day Charter/))).toHaveLength(1),
    );
    expect(dayRequests(calls).at(-1)).toBe(`date=${wednesday}&tripId=${tripIds.charter}`);
    expect(window.location.search).toBe(`?day=${wednesday}&trip=${tripIds.charter}`);
    // The button went with the empty state: the day's heading keeps the person's place.
    await waitFor(() =>
      expect(document.activeElement).toBe(
        screen.getByRole("heading", { level: 2, name: /^Wednesday, November 4/ }),
      ),
    );
    expect(document.querySelector(".bk-filters__note")).toBeNull();
  });
});

describe("the answer must be for the source asked (G2.12e)", () => {
  it.each([
    ["a filtered answer for another source", "?source=staff_assisted", directBody()],
    ["a filtered answer for every source", "?source=staff_assisted", allSourcesBody()],
    [
      "a filtered answer with no source",
      "?source=staff_assisted",
      { ...staffBody(), source: undefined },
    ],
    ["an unfiltered answer for one source", "", staffBody()],
  ])("shows %s as one it can't read", async (_label, search, body) => {
    window.history.replaceState(null, "", `/bookings${search}`);
    api({ [route.day()]: () => json(body) });
    renderPage();
    expect(text(await screen.findByRole("alert"))).toContain("Bookings couldn't be shown");
  });

  it("reads an unfiltered answer with no source, as before G2.12e", async () => {
    api({ [route.day()]: () => json(dayBody()) });
    renderPage();
    expect(rowsOf(await tripSection(/Sunset Harbor Cruise/))).toHaveLength(2);
  });
});

describe("Book in a trip's header (G2.12e)", () => {
  const bookLinks = () => screen.queryAllByRole("link", { name: /^Book\b/ });

  it.each(["owner", "booking_staff"] as const)(
    "offers %s Book on a published trip still on sale, as a 44 px target that names the trip",
    async (role) => {
      api({ [route.day()]: bySource(role) });
      renderPage(role);
      const sunset = await tripSection(/Sunset Harbor Cruise/);
      const book = within(sunset).getByRole("link", {
        name: /^Book Sunset Harbor Cruise, Wed, Nov 4, 6:00\sPM$/,
      });
      expect(book.getAttribute("href")).toBe(`/trips/${tripIds.sunset}/book`);
      // The design system's button: at least --tap-min (44 px) each way.
      expect(book.classList.contains("tg-button")).toBe(true);
      expect(book.closest(".bk-trip__side")).not.toBeNull();
      // The charter has departed.
      const charter = await tripSection(/Private Half-Day Charter/);
      expect(within(charter).queryByRole("link", { name: /^Book\b/ })).toBeNull();
      expect(bookLinks()).toHaveLength(1);
    },
  );

  it.each([
    ["closed", { salesState: "closed" as const }],
    ["blacked out", { blackedOut: true }],
    ["past its cutoff", { salesCloseAt: "2026-11-04T16:30:00.000Z" }],
    ["without when sales close", { salesCloseAt: undefined }],
    ["without whether it is blacked out", { blackedOut: undefined }],
  ])("offers no Book on a trip %s", async (_label, change) => {
    const sunset = { ...bookable(sunsetTrip), ...change };
    api({ [route.day()]: () => json(allSourcesBody({ trips: [bookable(charterTrip), sunset] })) });
    renderPage();
    await tripSection(/Sunset Harbor Cruise/);
    expect(bookLinks()).toHaveLength(0);
  });

  it("never offers finance Book or a roster, filtered or not", async () => {
    window.history.replaceState(null, "", "/bookings?source=staff_assisted");
    api({ [route.day()]: bySource("finance") });
    renderPage("finance");
    await tripSection(/Sunset Harbor Cruise/);
    expect(bookLinks()).toHaveLength(0);
    expect(screen.queryByRole("link", { name: /^Roster/ })).toBeNull();
  });

  it("keeps a trip's roster under a filter that counts none of its bookings, for roles that see guests", async () => {
    window.history.replaceState(null, "", "/bookings?source=staff_assisted");
    // The answer is the staff filter's, whatever was asked, so the counts are the filter's.
    api({ [route.day()]: () => json(asSeenBy("booking_staff", staffBody())) });
    renderPage("booking_staff");
    // The charter has one guest booking and no staff one: its roster still lists the guest.
    const charter = await tripSection(/Private Half-Day Charter/);
    expect(
      within(charter)
        .getByRole("link", { name: /^Roster for Private Half-Day Charter/ })
        .getAttribute("href"),
    ).toBe(`/trips/${tripIds.charter}/roster`);
    expect(screen.getAllByRole("link", { name: /^Roster/ })).toHaveLength(2);
  });
});

describe("what each role asks for under a filter (G2.12e)", () => {
  it("sends finance's requests exactly as an owner's", async () => {
    window.history.replaceState(null, "", "/bookings?source=direct");
    const ownerCalls = api({ [route.day()]: bySource("owner") });
    renderPage("owner");
    await tripSection(/Sunset Harbor Cruise/);
    await totalsRead();
    const ownerAsked = ownerCalls.map((c) => `${c.method} ${c.path}?${c.query}`);
    cleanup();

    window.history.replaceState(null, "", "/bookings?source=direct");
    const calls = api({ [route.day()]: bySource("finance") });
    renderPage("finance");
    await tripSection(/Sunset Harbor Cruise/);
    await totalsRead();
    expect(calls.map((c) => `${c.method} ${c.path}?${c.query}`)).toEqual(ownerAsked);
    expect(ownerAsked).toContain(`GET ${route.day().slice(4)}?date=${wednesday}&source=direct`);
    // No booker reaches finance's screen.
    for (const fragment of personalFragments) {
      expect(document.body.textContent?.toLowerCase(), fragment).not.toContain(fragment);
    }
  });

  it("keeps every booker's name out of the address through filter, day, trip, and paging changes", async () => {
    const calls = api({
      [route.day()]: (call) =>
        call.query.get("after")
          ? json(staffBody({ bookings: [], nextAfter: null }))
          : call.query.get("source") === "staff_assisted" &&
              call.query.get("date") === wednesday &&
              !call.query.get("tripId")
            ? json(staffBody({ nextAfter: staffBooking.id }))
            : bySource()(call),
    });
    renderPage();
    await tripSection(/Sunset Harbor Cruise/);
    expectNoPersonalDataInAddresses();
    fireEvent.change(sourceSelect(), { target: { value: "staff_assisted" } });
    await screen.findByRole("button", { name: "Show more bookings" });
    expectNoPersonalDataInAddresses();
    fireEvent.click(screen.getByRole("button", { name: "Show more bookings" }));
    await waitFor(() =>
      expect(screen.queryByRole("button", { name: /Show more bookings|Loading more/ })).toBeNull(),
    );
    expectNoPersonalDataInAddresses();
    fireEvent.change(screen.getByRole("combobox", { name: "Trip" }), {
      target: { value: tripIds.sunset },
    });
    await waitFor(() => expect(window.location.search).toContain(`trip=${tripIds.sunset}`));
    expectNoPersonalDataInAddresses();
    fireEvent.click(screen.getByRole("button", { name: "Next day" }));
    await screen.findByRole("heading", { name: "No trips on Thursday, November 5" });
    expectNoPersonalDataInAddresses();
    expect(params()).toEqual({ day: "2026-11-05", source: "staff_assisted" });
    expect(callsTo(calls, route.day()).length).toBeGreaterThanOrEqual(5);
  });
});

describe("the other booking reads keep their own checks (G2.12e)", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("still reads a booking, a roster, the exceptions, and a search without the Book rule inputs", async () => {
    api({
      [route.booking(bookingIds.maya)]: () => json({ booking: bookingDetail() }),
      [route.roster(tripIds.sunset)]: () => json({ roster: tripRoster() }),
      [route.exceptions()]: () => json({ exceptions: [finalizationException()], nextBefore: null }),
      [route.search()]: () => json(searchBody()),
    });
    expect((await loadBooking(tenantId, bookingIds.maya)).kind).toBe("ok");
    expect((await loadRoster(tenantId, tripIds.sunset)).kind).toBe("ok");
    expect((await loadExceptions(tenantId, {})).kind).toBe("ok");
    expect((await searchBookings(tenantId, { q: "maya" })).kind).toBe("ok");
  });

  it.each([
    ["sales close that is not an instant", { salesCloseAt: "x" }],
    ["a blackout that is not a boolean", { blackedOut: "no" }],
  ])("reads a day trip with %s as unreadable", async (_label, change) => {
    api({
      [route.day()]: () =>
        json({ ...dayBody({ trips: [charterTrip, { ...sunsetTrip, ...change } as never] }) }),
    });
    const read = await loadDay(tenantId, { date: wednesday });
    expect(read).toEqual({ kind: "failed", reason: "unreadable" });
  });

  it("asks for a source and checks the answer is for it", async () => {
    const calls = api({ [route.day()]: [() => json(staffBody()), () => json(directBody())] });
    expect((await loadDay(tenantId, { date: wednesday, source: "staff_assisted" })).kind).toBe(
      "ok",
    );
    expect(callsTo(calls, route.day())[0]?.query.toString()).toBe(
      `date=${wednesday}&source=staff_assisted`,
    );
    expect(await loadDay(tenantId, { date: wednesday, source: "staff_assisted" })).toEqual({
      kind: "failed",
      reason: "unreadable",
    });
  });
});
