// @vitest-environment jsdom

// Staff in Tokyo looking at a New York marina: times must stay the trip's own.
process.env.TZ = "Asia/Tokyo";

import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { StaffRole, TripRoster } from "@tidegrid/contracts";
import { ErrorBoundary } from "@tidegrid/design-system/components";
import { StrictMode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NavigationProvider } from "../navigation.tsx";
import {
  api,
  apiError,
  bookers,
  bookingIds,
  deferred,
  dropped,
  expectNoPersonalDataInAddresses,
  json,
  membership,
  priyaBooking,
  route,
  strayRequests,
  tenantName,
  terms,
  text,
  tripIds,
  tripRoster,
} from "./fixtures.ts";
import { RosterPage } from "./RosterPage.tsx";

const tripId = tripIds.sunset;
const rosterBody = (roster: TripRoster = tripRoster()) => ({ roster });

/** The page in a navigation provider, so a link's destination is recorded. */
function renderPage(
  role: StaffRole = "owner",
  id: string = tripId,
  options: { strict?: boolean } = {},
) {
  const navigate = vi.fn();
  const page = (
    <NavigationProvider navigate={navigate}>
      <RosterPage membership={membership(role)} tripId={id} focusHeading={false} />
    </NavigationProvider>
  );
  const view = render(options.strict ? <StrictMode>{page}</StrictMode> : page);
  return { navigate, ...view };
}

const loaded = () => screen.findByRole("heading", { level: 2, name: /^Sunset Harbor Cruise$/ });
const sheet = () => document.querySelector(".roster") as HTMLElement;
const rows = () => [...document.querySelectorAll<HTMLElement>(".roster-table tbody tr")];
/** A table row's cells as text, the row header first. */
const cellsOf = (row: Element) => [...row.children].map((cell) => text(cell));

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-11-04T17:00:00Z"));
  window.history.replaceState(null, "", `/trips/${tripId}/roster`);
});

afterEach(() => {
  const strays = strayRequests();
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  expect(strays).toEqual([]);
});

describe("a role that cannot see guests", () => {
  it("shows finance the role empty state and makes no request at all", async () => {
    const calls = api({});
    const { navigate, container } = renderPage("finance");
    expect(screen.getByRole("heading", { level: 1, name: "Roster" })).toBeTruthy();
    const empty = screen.getByRole("heading", { level: 2, name: "Your role can't see rosters" });
    expect(text(empty.closest(".tg-empty"))).toContain(
      "A roster names the guests on a trip, so it's for owners and booking staff. Your role, finance, sees the same bookings, totals, and payments on Bookings.",
    );
    const go = screen.getByRole("link", { name: "Go to bookings" });
    expect(go.getAttribute("href")).toBe("/bookings");
    fireEvent.click(go);
    expect(navigate).toHaveBeenCalledWith("/bookings");
    // Give any request time to start; none does.
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(calls).toEqual([]);
    expect(container.querySelector(".roster")).toBeNull();
    expect(screen.queryByRole("button", { name: "Print roster" })).toBeNull();
    expect(screen.queryByRole("table")).toBeNull();
  });

  it("names the operator above the heading, as every page does", () => {
    api({});
    const { container } = renderPage("finance");
    expect(text(container.querySelector(".tg-eyebrow"))).toBe(tenantName);
  });
});

describe("a roster", () => {
  it("asks for the trip's roster, and shows the trip, when and where to meet, and the totals", async () => {
    const calls = api({ [route.roster(tripId)]: () => json(rosterBody()) });
    const { container } = renderPage("owner");
    await loaded();
    expect(calls).toHaveLength(1);
    expect(calls[0]?.path).toBe(
      `/api/v1/staff/tenants/${membership("owner").tenantId}/trips/${tripId}/roster`,
    );
    expect(text(container.querySelector("h1"))).toBe("Roster");
    expect(text(container.querySelector(".roster-head__operator"))).toBe(tenantName);
    // The trip's date with its year, its times on the marina's clock, and the zone's name.
    expect(text(container.querySelector(".roster-head__when"))).toBe(
      "Wednesday, November 4, 2026, 6:00 PM to 7:30 PM (EST, 1 h 30 min)",
    );

    const facts = terms(container.querySelector(".roster-facts"));
    expect(Object.keys(facts)).toEqual(["Meet at", "Boat", "Guests", "Extras to prepare"]);
    expect(facts["Meet at"]).toContain("Dock C, slip 14, Harbor Marina, Dock C");
    expect(text(container.querySelector(".roster-facts .bd-block"))).toBe(
      "Check in at the dock office 20 minutes before departure.",
    );
    expect(facts.Boat).toBe("Sea Lark");
    // Guests by ticket type, out of the trip's seats.
    const guests = container.querySelectorAll(".roster-facts dd")[2] as HTMLElement;
    expect(text(guests.querySelector("strong"))).toBe("5 guests");
    expect(text(guests)).toContain("5 guests in 2 bookings of 20 seats");
    expect(text(guests.querySelector(".bd-block"))).toBe("4 Adult, 1 Child (3 to 12)");
    // The extras to prepare, summed across the trip.
    expect(facts["Extras to prepare"]).toBe("2 Souvenir photo, 2 Drink voucher");

    expect(text(container.querySelector('p[role="status"]'))).toBe(
      "Roster for Sunset Harbor Cruise, Wednesday, November 4: 2 bookings, 5 guests.",
    );
    expect(text(container.querySelector(".roster-foot"))).toBe(
      "A booking roster, not a passenger manifest, check-in, or boarding record. It lists the confirmed bookings as of Wed, Nov 4, 10:00 AM EST.",
    );
    // The guests are on the page, and nowhere in an address.
    expect(text(container)).toContain("Maya Okonkwo");
    expectNoPersonalDataInAddresses();
  });

  it("says that participants and waivers are not collected yet, rather than printing empty columns", async () => {
    api({ [route.roster(tripId)]: () => json(rosterBody()) });
    const { container } = renderPage("owner");
    await loaded();
    const notice = container.querySelector(".roster-notice") as HTMLElement;
    expect(text(notice.querySelector(".tg-notice__title"))).toBe(
      "Participants and waivers aren't collected yet",
    );
    expect(text(notice)).toMatch(/Participant names and waiver status arrive with a later build\./);
    // No announcement of its own: it is part of the page from the start.
    expect(notice.getAttribute("role")).toBeNull();
    // And no column for either.
    const headers = [...document.querySelectorAll(".roster-table thead th")].map((th) => text(th));
    expect(headers.join(" ")).not.toMatch(/waiver|participant/i);
  });

  it("lists one row per booking, in the order sent, with reference, booker, party, extras, and payment", async () => {
    api({ [route.roster(tripId)]: () => json(rosterBody()) });
    renderPage("owner");
    await loaded();
    // (The time's no-break space is any space to the pattern.)
    const table = screen.getByRole("table", {
      name: /^Bookings on Sunset Harbor Cruise, Wednesday, November 4, 6:00\sPM$/,
    });
    expect(
      within(table)
        .getAllByRole("columnheader")
        .map((th) => text(th)),
    ).toEqual(["Number#", "Reference", "Booker", "Party", "Extras", "Payment"]);
    expect(rows()).toHaveLength(2);
    // Each reference is the row's header, so a cell reads with it.
    expect(
      within(table)
        .getAllByRole("rowheader")
        .map((th) => text(th)),
    ).toEqual(["QKG6ERBF", "7HM2P9TW"]);
    const [maya, luis] = rows() as [HTMLElement, HTMLElement];
    expect(cellsOf(maya)).toEqual([
      "1",
      "QKG6ERBF",
      "Maya Okonkwo",
      "3 guests2 Adult, 1 Child (3 to 12)",
      "1 Souvenir photo",
      "Paid",
    ]);
    expect(cellsOf(luis)).toEqual([
      "2",
      "7HM2P9TW",
      "Luis Fernandez",
      "2 guests2 Adult",
      "1 Souvenir photo, 2 Drink voucher",
      "Refund pending",
    ]);
    // The party's size is bold, with the ticket types beneath.
    expect(text(maya.querySelector("strong"))).toBe("3 guests");
    expect(text(maya.querySelector(".roster-table__detail"))).toBe("2 Adult, 1 Child (3 to 12)");
    // A payment is a badge with an icon, not color alone.
    expect(maya.querySelector(".tg-status svg")).not.toBeNull();
  });

  it("loads the roster while React runs effects twice in development", async () => {
    // The console's entry point wraps everything in StrictMode, which starts every load twice.
    api({ [route.roster(tripId)]: () => json(rosterBody()) });
    renderPage("owner", tripId, { strict: true });
    await loaded();
    expect(rows()).toHaveLength(2);
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("shows booking staff the same roster as an owner", async () => {
    api({ [route.roster(tripId)]: () => json(rosterBody()) });
    renderPage("booking_staff");
    await loaded();
    expect(rows()).toHaveLength(2);
    expect(screen.getByRole("button", { name: "Print roster" })).toBeTruthy();
  });

  it("names a payment by its refund, as the list does", async () => {
    const refunded = tripRoster();
    refunded.bookings = [
      {
        ...refunded.bookings[0],
        payment: { state: "succeeded", refund: { state: "succeeded", amount: 13109 } },
      },
      {
        ...refunded.bookings[1],
        payment: { state: "succeeded", refund: { state: "failed", amount: 9450 } },
      },
      {
        ...refunded.bookings[0],
        id: bookingIds.priya,
        reference: "3ZRB8N4C",
        payment: { state: "pending", refund: null },
      },
    ] as TripRoster["bookings"];
    api({ [route.roster(tripId)]: () => json(rosterBody(refunded)) });
    renderPage("owner");
    await loaded();
    expect(rows().map((row) => text(row.querySelector(".tg-status")))).toEqual([
      "Refunded",
      "Refund failed",
      "Awaiting payment",
    ]);
  });

  it("prints with the browser's print, once", async () => {
    api({ [route.roster(tripId)]: () => json(rosterBody()) });
    const print = vi.spyOn(window, "print").mockImplementation(() => {});
    renderPage("owner");
    await loaded();
    const button = screen.getByRole("button", { name: "Print roster" });
    expect(print).not.toHaveBeenCalled();
    fireEvent.click(button);
    expect(print).toHaveBeenCalledTimes(1);
  });

  it("links back to the trip's own bookings on its day, in place", async () => {
    api({ [route.roster(tripId)]: () => json(rosterBody()) });
    const { navigate } = renderPage("owner");
    await loaded();
    const back = screen.getByRole("link", { name: "Bookings on Wed, Nov 4" });
    expect(back.getAttribute("href")).toBe(`/bookings?day=2026-11-04&trip=${tripId}`);
    fireEvent.click(back);
    expect(navigate).toHaveBeenCalledWith(`/bookings?day=2026-11-04&trip=${tripId}`);
  });

  it("shows a charter by its size, with no ticket types", async () => {
    const charter = tripRoster({
      trip: {
        ...tripRoster().trip,
        tripId: tripIds.charter,
        productName: "Private Half-Day Charter",
        productKind: "private_charter",
        boatName: "Blue Heron",
        localStartTime: "08:00",
        startsAt: "2026-11-04T13:00:00.000Z",
        endsAt: "2026-11-04T17:00:00.000Z",
        endsAtLocal: "2026-11-04T12:00:00-05:00",
        durationMinutes: 240,
        seats: 12,
      },
      totals: { bookings: 1, guests: 6, tickets: [], extras: [] },
      bookings: [
        {
          id: bookingIds.priya,
          reference: priyaBooking.reference,
          booker: { name: bookers.priya.name },
          party: priyaBooking.party,
          extras: [],
          payment: { state: "succeeded", refund: null },
        },
      ],
    });
    api({ [route.roster(tripIds.charter)]: () => json(rosterBody(charter)) });
    const { container } = renderPage("owner", tripIds.charter);
    await screen.findByRole("heading", { level: 2, name: "Private Half-Day Charter" });
    const guests = container.querySelectorAll(".roster-facts dd")[2] as HTMLElement;
    expect(text(guests)).toBe("6 guests in 1 booking, private charter for up to 12");
    expect(guests.querySelector(".bd-block")).toBeNull();
    expect(text(container.querySelector(".roster-head__when"))).toBe(
      "Wednesday, November 4, 2026, 8:00 AM to 12:00 PM (EST, 4 h)",
    );
    expect(cellsOf(rows()[0] as HTMLElement)).toEqual([
      "1",
      "3ZRB8N4C",
      "Priya Raman",
      "6 guestsWhole boat, up to 12 guests",
      "None",
      "Paid",
    ]);
    expect(terms(container.querySelector(".roster-facts"))["Extras to prepare"]).toBe("None");
  });

  it("reads the trip's own zone, not the viewer's, in its header and footer", async () => {
    const dive = tripRoster({
      generatedAt: "2026-11-04T15:00:00.000Z",
      trip: {
        ...tripRoster().trip,
        tripId: tripIds.honolulu,
        productName: "Two-Tank Morning Dive",
        boatName: "Reef Runner",
        timeZone: "Pacific/Honolulu",
        localStartTime: "07:30",
        startsAt: "2026-11-04T17:30:00.000Z",
        endsAt: "2026-11-04T21:00:00.000Z",
        endsAtLocal: "2026-11-04T11:00:00-10:00",
        durationMinutes: 210,
        seats: 8,
      },
    });
    api({ [route.roster(tripIds.honolulu)]: () => json(rosterBody(dive)) });
    const { container } = renderPage("owner", tripIds.honolulu);
    await screen.findByRole("heading", { level: 2, name: "Two-Tank Morning Dive" });
    expect(text(container.querySelector(".roster-head__when"))).toBe(
      "Wednesday, November 4, 2026, 7:30 AM to 11:00 AM (HST, 3 h 30 min)",
    );
    // 15:00 UTC is 5:00 AM in Honolulu, midnight in New York, and midnight in Tokyo's next day.
    expect(text(container.querySelector(".roster-foot"))).toContain(
      "as of Wed, Nov 4, 5:00 AM HST.",
    );
  });

  it("says a trip that ends the next day does", async () => {
    const late = tripRoster({
      trip: {
        ...tripRoster().trip,
        localStartTime: "23:00",
        startsAt: "2026-11-05T04:00:00.000Z",
        endsAt: "2026-11-05T06:00:00.000Z",
        endsAtLocal: "2026-11-05T01:00:00-05:00",
        durationMinutes: 120,
      },
    });
    api({ [route.roster(tripId)]: () => json(rosterBody(late)) });
    const { container } = renderPage("owner");
    await loaded();
    expect(text(container.querySelector(".roster-head__when"))).toBe(
      "Wednesday, November 4, 2026, 11:00 PM to 1:00 AM next day (EST, 2 h)",
    );
  });
});

describe("a trip with no bookings", () => {
  const empty = () =>
    tripRoster({
      totals: { bookings: 0, guests: 0, tickets: [], extras: [] },
      bookings: [],
    });

  it("shows the empty state in place of the table, and still the header", async () => {
    api({ [route.roster(tripId)]: () => json(rosterBody(empty())) });
    const { container } = renderPage("owner");
    await loaded();
    const heading = screen.getByRole("heading", { level: 3, name: "No bookings on this trip yet" });
    expect(text(heading.closest(".tg-empty"))).toContain(
      "Bookings appear here as guests book. Print again closer to departure.",
    );
    expect(screen.queryByRole("table")).toBeNull();
    expect(rows()).toHaveLength(0);
    const guests = container.querySelectorAll(".roster-facts dd")[2] as HTMLElement;
    expect(text(guests)).toBe("0 guests in 0 bookings of 20 seats");
    expect(terms(container.querySelector(".roster-facts"))["Extras to prepare"]).toBe("None");
    // The trip is still on paper: its time, place, and the notice.
    expect(screen.getByRole("button", { name: "Print roster" })).toBeTruthy();
    expect(container.querySelector(".roster-notice")).not.toBeNull();
    expect(text(container.querySelector('p[role="status"]'))).toBe(
      "Roster for Sunset Harbor Cruise, Wednesday, November 4: 0 bookings, 0 guests.",
    );
  });
});

describe("a trip that is not there", () => {
  it("shows the designed trip-not-here state, with Go to bookings", async () => {
    api({ [route.roster(tripId)]: () => apiError(404, "not_found") });
    const { navigate, container } = renderPage("owner");
    const empty = await screen.findByRole("heading", { level: 2, name: "This trip isn't here" });
    expect(text(container.querySelector("h1"))).toBe("Roster");
    expect(text(empty.closest(".tg-empty"))).toContain(
      `${tenantName} has no trip at this address. It may belong to another operator, or the link may be incomplete.`,
    );
    const go = screen.getByRole("link", { name: "Go to bookings" });
    expect(go.getAttribute("href")).toBe("/bookings");
    fireEvent.click(go);
    expect(navigate).toHaveBeenCalledWith("/bookings");
    expect(container.querySelector(".roster")).toBeNull();
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.queryByRole("button", { name: "Print roster" })).toBeNull();
  });
});

describe("when the roster does not load", () => {
  it("shows a designed error, keeps the button while it works, and then the roster", async () => {
    const retry = deferred();
    api({ [route.roster(tripId)]: [dropped, retry.answer] });
    renderPage("owner");
    const alert = await screen.findByRole("alert");
    expect(text(alert)).toContain("The console can't reach TideGrid");
    const button = within(alert).getByRole("button", { name: "Try again" });
    button.focus();
    fireEvent.click(button);
    expect(await screen.findByRole("button", { name: "Trying again…" })).toBe(button);
    expect(document.activeElement).toBe(button);
    retry.release(json(rosterBody()));
    await loaded();
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("hands focus to the page's heading once Try again works and its button is gone", async () => {
    const retry = deferred();
    api({ [route.roster(tripId)]: [dropped, retry.answer] });
    renderPage("owner");
    const button = within(await screen.findByRole("alert")).getByRole("button", {
      name: "Try again",
    });
    button.focus();
    fireEvent.click(button);
    retry.release(json(rosterBody()));
    await loaded();
    expect(screen.queryByRole("alert")).toBeNull();
    const heading = screen.getByRole("heading", { level: 1, name: "Roster" });
    await waitFor(() => expect(document.activeElement).toBe(heading));
  });

  it("hands focus to the page's heading when Try again ends with nothing left to try", async () => {
    const retry = deferred();
    api({ [route.roster(tripId)]: [dropped, retry.answer] });
    renderPage("owner");
    const button = within(await screen.findByRole("alert")).getByRole("button", {
      name: "Try again",
    });
    button.focus();
    fireEvent.click(button);
    retry.release(apiError(404, "not_found"));
    await screen.findByRole("heading", { level: 2, name: "This trip isn't here" });
    const heading = screen.getByRole("heading", { level: 1, name: "Roster" });
    await waitFor(() => expect(document.activeElement).toBe(heading));
  });

  it("keeps focus on Try again when the second try fails too", async () => {
    api({ [route.roster(tripId)]: [dropped, dropped] });
    renderPage("owner");
    const button = within(await screen.findByRole("alert")).getByRole("button", {
      name: "Try again",
    });
    button.focus();
    fireEvent.click(button);
    await waitFor(() =>
      expect(text(screen.getByRole("alert"))).toContain("The roster still didn't load"),
    );
    expect(document.activeElement).toBe(button);
    expect(screen.getByRole("button", { name: "Try again" })).toBe(button);
  });

  it("says it still did not load after a second failure", async () => {
    api({ [route.roster(tripId)]: [dropped, dropped] });
    renderPage("owner");
    fireEvent.click(
      within(await screen.findByRole("alert")).getByRole("button", { name: "Try again" }),
    );
    await waitFor(() =>
      expect(text(screen.getByRole("alert"))).toContain("The roster still didn't load"),
    );
  });

  it.each([
    [401, "unauthenticated", "You're signed out"],
    [403, "forbidden", "Your role can't see the roster"],
    [403, "tenant_suspended", "This operator is suspended"],
    [500, "internal_error", "The roster didn't load"],
  ] as const)("reads a %i %s in plain words", async (status, code, title) => {
    api({ [route.roster(tripId)]: () => apiError(status, code) });
    renderPage("owner");
    const alert = await screen.findByRole("alert");
    expect(text(alert)).toContain(title);
    expect(text(alert)).not.toMatch(/\b[1-5]\d\d\b|_/);
  });

  const broken: Array<[string, (r: TripRoster) => unknown]> = [
    [
      "a booking with no booker",
      (r) => ({ ...r, bookings: [{ ...r.bookings[0], booker: undefined }] }),
    ],
    [
      "a booking with a payment state it does not know",
      (r) => ({
        ...r,
        bookings: [{ ...r.bookings[0], payment: { state: "settled", refund: null } }],
      }),
    ],
    ["a total that is not a count", (r) => ({ ...r, totals: { ...r.totals, guests: "five" } })],
    ["no totals", (r) => ({ ...r, totals: undefined })],
    [
      "a trip with a time zone the browser cannot show",
      (r) => ({ ...r, trip: { ...r.trip, timeZone: "Mars/Olympus_Mons" } }),
    ],
    ["no seat count", (r) => ({ ...r, trip: { ...r.trip, seats: undefined } })],
    ["a trip with no duration", (r) => ({ ...r, trip: { ...r.trip, durationMinutes: undefined } })],
    [
      "a trip end on a day that does not exist",
      (r) => ({ ...r, trip: { ...r.trip, endsAtLocal: "2026-13-45T10:00:00-05:00" } }),
    ],
    ["a time it was made that is not a time", (r) => ({ ...r, generatedAt: "now-ish" })],
    ["no bookings list", (r) => ({ ...r, bookings: undefined })],
  ];

  it.each(broken)("treats %s as an answer it can't show, not as a crash", async (_what, change) => {
    api({ [route.roster(tripId)]: () => json({ roster: change(tripRoster()) }) });
    renderPage("owner");
    const alert = await screen.findByRole("alert");
    expect(text(alert)).toContain("The roster couldn't be shown");
    expect(within(alert).getByRole("button", { name: "Try again" })).toBeTruthy();
  });

  it("treats a trip end that is not a date and time as an answer it can't show, not as a crash", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const odd = tripRoster();
    odd.trip = { ...odd.trip, endsAtLocal: "tomorrow" };
    api({ [route.roster(tripId)]: () => json(rosterBody(odd)) });
    render(
      <ErrorBoundary fallback={<p>The page crashed</p>}>
        <RosterPage membership={membership("owner")} tripId={tripId} focusHeading={false} />
      </ErrorBoundary>,
    );
    const alert = await screen.findByRole("alert");
    expect(text(alert)).toContain("The roster couldn't be shown");
  });
});

describe("the sheet", () => {
  it("keeps the roster's own layout out of the way of the console's rail when printed", async () => {
    api({ [route.roster(tripId)]: () => json(rosterBody()) });
    renderPage("owner");
    await loaded();
    // The tools (back link, Print) sit apart from the sheet's own header, so print can hide them.
    const tools = sheet().querySelector(".roster-tools") as HTMLElement;
    expect(tools.querySelector(".roster-head")).toBeNull();
    expect(sheet().querySelector(".roster-head")).not.toBeNull();
    expect(within(tools).getAllByRole("link")).toHaveLength(1);
    expect(within(tools).getAllByRole("button")).toHaveLength(1);
  });

  it("lets a keyboard reach a scrolling table", async () => {
    api({ [route.roster(tripId)]: () => json(rosterBody()) });
    renderPage("owner");
    await loaded();
    const region = screen.getByRole("region", { name: "Bookings on this trip" });
    expect(region.getAttribute("tabindex")).toBe("0");
    expect(region.querySelector("table")).not.toBeNull();
  });
});
