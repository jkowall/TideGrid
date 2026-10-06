// @vitest-environment jsdom

// Staff in Tokyo looking at a New York marina: times must stay New York's.
process.env.TZ = "Asia/Tokyo";

import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { BookingDetail, StaffRole } from "@tidegrid/contracts";
import { ErrorBoundary } from "@tidegrid/design-system/components";
import { StrictMode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NavigationProvider } from "../navigation.tsx";
import { BookingDetailPage } from "./BookingDetail.tsx";
import {
  api,
  apiError,
  asSeenBy,
  bookerFragmentsIn,
  bookingDetail,
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
} from "./fixtures.ts";

const bookingId = bookingIds.maya;
const bookingBody = (booking: BookingDetail = bookingDetail()) => ({ booking });

/** The page in a navigation provider, so a link's destination is recorded. */
function renderDetail(
  role: StaffRole = "owner",
  id: string = bookingId,
  options: { strict?: boolean } = {},
) {
  const navigate = vi.fn();
  const page = (
    <NavigationProvider navigate={navigate}>
      <BookingDetailPage membership={membership(role)} bookingId={id} focusHeading={false} />
    </NavigationProvider>
  );
  const view = render(options.strict ? <StrictMode>{page}</StrictMode> : page);
  return { navigate, ...view };
}

/** The booking, as the API sends it to a role. */
const answer =
  (role: StaffRole, booking: BookingDetail = bookingDetail()) =>
  () =>
    json(asSeenBy(role, bookingBody(booking)));

const card = (name: string) => screen.getByRole("region", { name });
const loaded = () => screen.findByRole("heading", { level: 1, name: /^Booking [0-9A-Z]{8}$/ });
const badges = (element: Element) =>
  [...element.querySelectorAll(".tg-status")].map((badge) => text(badge));

/** The ledger's rows as [label, detail, amount]. */
const ledger = () =>
  within(card("Order"))
    .getAllByRole("row")
    .map((row) => [
      text(row.querySelector(".tg-ledger__label")),
      text(row.querySelector(".tg-ledger__detail")),
      text(row.querySelector(".tg-ledger__amount")),
    ]);

const history = () => [...card("History").querySelectorAll("ol > li")].map((item) => text(item));

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

describe("one booking", () => {
  it("shows an owner the reference, state, trip, where to meet, and the guest", async () => {
    const calls = api({ [route.booking(bookingId)]: answer("owner") });
    const { container } = renderDetail("owner");
    const heading = await loaded();
    expect(text(heading)).toBe("Booking QKG6ERBF");
    expect(text(container.querySelector(".tg-eyebrow"))).toBe(tenantName);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.path).toBe(
      `/api/v1/staff/tenants/${membership("owner").tenantId}/bookings/${bookingId}`,
    );

    // Confirmed and paid, as words and badges.
    expect(badges(container.querySelector(".bd-badges") as Element)).toEqual(["Confirmed", "Paid"]);
    // When it was confirmed, on the marina's clock and named: 2:17 PM there, 3:17 AM the next day in Tokyo.
    expect(text(container.querySelector(".bd-lede"))).toBe(
      "Booked online by the guest. Confirmed Tue, Oct 6, 2:17 PM EDT.",
    );

    const trip = card("Trip");
    expect(text(trip.querySelector(".bd-trip__name"))).toBe("Sunset Harbor Cruise");
    const when = terms(trip);
    expect(when.When).toBe("Wednesday, November 4, 6:00 PM to 7:30 PM (1 h 30 min, New York time)");
    expect(when.Boat).toBe("Sea Lark");
    expect(when["Meet at"]).toContain("Dock C, slip 14, Harbor Marina, Dock C");
    expect(text(trip.querySelector(".bd-block"))).toBe(
      "Check in at the dock office 20 minutes before departure.",
    );

    const guest = card("Guest");
    const facts = terms(guest);
    expect(facts["Booked by"]).toBe("Maya Okonkwo");
    expect(facts.Email).toBe("maya.okonkwo@guest.example");
    expect([...guest.querySelectorAll(".bd-tickets li")].map((li) => text(li))).toEqual([
      "2 Adult",
      "1 Child (3 to 12)",
    ]);
    expect(facts.Extras).toBe("1 Souvenir photo");
    expect(guest.textContent).toContain("3 guests");

    // What a screen reader hears when it loads.
    expect(text(container.querySelector('p[role="status"]'))).toBe(
      "Booking QKG6ERBF, Sunset Harbor Cruise, Wednesday, November 4.",
    );
    // The guest is on the page, and nowhere in an address.
    expectNoPersonalDataInAddresses();
  });

  it("names the year of a trip in another year than this one at the marina", async () => {
    const nextYear = bookingDetail();
    nextYear.trip = {
      ...nextYear.trip,
      localDate: "2027-11-04",
      startsAt: "2027-11-04T22:00:00.000Z",
      endsAtLocal: "2027-11-04T19:30:00-04:00",
    };
    api({ [route.booking(bookingId)]: answer("owner", nextYear) });
    const { container } = renderDetail("owner");
    await loaded();
    expect(terms(card("Trip")).When).toBe(
      "Thursday, November 4, 2027, 6:00 PM to 7:30 PM (1 h 30 min, New York time)",
    );
    expect(screen.getByRole("link", { name: "Bookings on Thu, Nov 4, 2027" })).toBeTruthy();
    expect(text(container.querySelector('p[role="status"]'))).toBe(
      "Booking QKG6ERBF, Sunset Harbor Cruise, Thursday, November 4, 2027.",
    );
  });

  it("loads the booking while React runs effects twice in development", async () => {
    // The console's entry point wraps everything in StrictMode, which starts every load twice.
    api({ [route.booking(bookingId)]: answer("owner") });
    renderDetail("owner", bookingId, { strict: true });
    await loaded();
    expect(terms(card("Guest")).Email).toBe("maya.okonkwo@guest.example");
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("shows booking staff the guest and the roster, as an owner sees them", async () => {
    api({ [route.booking(bookingId)]: answer("booking_staff") });
    renderDetail("booking_staff");
    await loaded();
    expect(terms(card("Guest")).Email).toBe("maya.okonkwo@guest.example");
    const roster = within(card("Trip")).getByRole("link", { name: "Roster" });
    expect(roster.getAttribute("href")).toBe(`/trips/${tripIds.sunset}/roster`);
  });

  it("shows finance the booking without the guest: a note in place of a name and email, and no roster", async () => {
    api({ [route.booking(bookingId)]: answer("finance") });
    const { container } = renderDetail("finance");
    await loaded();
    // The note takes the guest's place, and says why.
    const guest = card("Guest");
    expect(text(guest.querySelector(".bd-hidden"))).toBe(
      "Not shown to your role, finance. Owners and booking staff see the guest's name and email.",
    );
    expect(Object.keys(terms(guest))).toEqual(["Party", "Extras"]);
    expect(screen.queryByText("Booked by")).toBeNull();
    // No part of the guest is anywhere on the page, in text or in markup.
    const page = `${container.innerHTML} ${container.textContent}`.toLowerCase();
    expect(bookerFragmentsIn(page)).toEqual([]);
    expect(page).not.toContain("@guest.example");
    // The rest of the booking is the same, and the roster link is gone.
    expect(terms(card("Payment")).Amount).toBe("$131.09");
    expect(ledger().at(-2)).toEqual(["Total", "", "$131.09"]);
    expect(within(card("Trip")).queryByRole("link", { name: "Roster" })).toBeNull();
    expect(within(card("Trip")).getByRole("link", { name: "Bookings on this trip" })).toBeTruthy();
  });

  it("shows a charter's guests and what was sold, with no ticket list", async () => {
    const charter = bookingDetail({
      id: bookingIds.priya,
      reference: priyaBooking.reference,
      party: priyaBooking.party,
      extras: [],
    });
    api({ [route.booking(bookingIds.priya)]: answer("owner", charter) });
    renderDetail("owner", bookingIds.priya);
    await loaded();
    const guest = card("Guest");
    expect(guest.querySelector(".bd-tickets")).toBeNull();
    expect(text(guest.querySelector(".bd-block"))).toBe("Whole boat, up to 12 guests");
    expect(guest.textContent).toContain("6 guests");
    expect(terms(guest).Extras).toBe("None");
  });

  it("says when a trip ends the next day", async () => {
    const late = bookingDetail({
      trip: {
        ...bookingDetail().trip,
        localStartTime: "23:00",
        startsAt: "2026-11-05T04:00:00.000Z",
        endsAt: "2026-11-05T06:00:00.000Z",
        endsAtLocal: "2026-11-05T01:00:00-05:00",
        durationMinutes: 120,
      },
    });
    api({ [route.booking(bookingId)]: answer("owner", late) });
    renderDetail("owner");
    await loaded();
    expect(terms(card("Trip")).When).toBe(
      "Wednesday, November 4, 11:00 PM to 1:00 AM next day (2 h, New York time)",
    );
  });

  it("leaves out the meeting point's parts that the operator did not give", async () => {
    const plain = bookingDetail({
      location: { name: "Harbor Marina, Dock C", meetingPoint: "", meetingInstructions: "" },
    });
    api({ [route.booking(bookingId)]: answer("owner", plain) });
    renderDetail("owner");
    await loaded();
    const meet = card("Trip").querySelectorAll("dd")[2];
    expect(text(meet)).toBe("Harbor Marina, Dock C");
    expect(meet?.querySelector(".bd-block")).toBeNull();
  });
});

describe("the order", () => {
  it("lists the order as a ledger, in the order its totals are built", async () => {
    api({ [route.booking(bookingId)]: answer("owner") });
    renderDetail("owner");
    await loaded();
    const table = within(card("Order")).getByRole("table", { name: "Order in US dollars" });
    expect(table).toBeTruthy();
    expect(ledger()).toEqual([
      ["Adult", "2 × $45.00", "$90.00"],
      ["Child (3 to 12)", "1 × $25.00", "$25.00"],
      ["Souvenir photo", "1 × $12.00", "$12.00"],
      ["Subtotal", "", "$127.00"],
      ["HARBOR10, 10% off", "On the trip price, not extras", "−$11.50"],
      ["Harbor fee", "3 × $2.50", "$7.50"],
      ["State sales tax (6%)", "", "$6.93"],
      ["County surtax (1%)", "", "$1.16"],
      ["Total", "", "$131.09"],
      ["Includes Harbor levy (4.712%)", "", "$5.42"],
    ]);
    // Each kind of row is marked, so the sum reads as one.
    const kinds = [...table.querySelectorAll("tr")].map(
      (row) => /tg-ledger__row--(\w+)/.exec(row.className)?.[1],
    );
    expect(kinds).toEqual([
      "item",
      "item",
      "item",
      "subtotal",
      "adjustment",
      "item",
      "item",
      "item",
      "total",
      "note",
    ]);
    expect(text(card("Order").querySelector(".bd-small"))).toBe(
      "The order was fixed when the guest checked out. They accepted cancellation policy version 3.",
    );
  });

  it("shows the order's own numbers even when they do not add up", async () => {
    const odd = bookingDetail();
    odd.order = {
      ...odd.order,
      totals: { ...odd.order.totals, subtotal: 100, total: 777700 },
    };
    api({ [route.booking(bookingId)]: answer("owner", odd) });
    renderDetail("owner");
    await loaded();
    const rows = ledger();
    expect(rows.find((r) => r[0] === "Subtotal")?.[2]).toBe("$1.00");
    expect(rows.find((r) => r[0] === "Total")?.[2]).toBe("$7,777.00");
  });
});

describe("the payment", () => {
  it("shows the status, amount, method, and the provider's reference as the API sent it", async () => {
    api({ [route.booking(bookingId)]: answer("owner") });
    renderDetail("owner");
    await loaded();
    const payment = card("Payment");
    const facts = terms(payment);
    expect(facts.Status).toBe("Paid");
    expect(facts.Amount).toBe("$131.09");
    expect(facts.Method).toBe("Test payment (demo provider)");
    // Masked by the API; the console shows what it was given, and says what it is. A screen
    // reader hears the ending rather than four bullets.
    const code = payment.querySelector(".bd-code");
    expect(text(code)).toBe("fpay_••••a1B2");
    expect(code?.getAttribute("aria-hidden")).toBe("true");
    expect(code?.nextElementSibling?.className).toBe("tg-visually-hidden");
    expect(text(code?.nextElementSibling)).toBe("fpay, ending in a1B2");
    expect(text(code?.parentElement?.querySelector(".bd-block"))).toBe(
      "Shortened: the start and the last four characters.",
    );
    // Received on the marina's clock: 2:16 PM there.
    expect(facts.Received).toBe("Tue, Oct 6, 2:16 PM EDT");
    expect(payment.querySelector(".bd-refund")).toBeNull();
    expect(screen.queryByRole("heading", { name: "Refund" })).toBeNull();
  });

  it("names Stripe when Stripe took the payment", async () => {
    const stripe = bookingDetail();
    stripe.payment = { ...stripe.payment, provider: "stripe", providerReference: "pi_••••9zXy" };
    api({ [route.booking(bookingId)]: answer("owner", stripe) });
    renderDetail("owner");
    await loaded();
    expect(terms(card("Payment")).Method).toBe("Stripe");
    expect(text(card("Payment").querySelector(".bd-code"))).toBe("pi_••••9zXy");
    expect(text(card("Payment").querySelector(".bd-code + .tg-visually-hidden"))).toBe(
      "pi, ending in 9zXy",
    );
  });

  it("says when a payment has no reference or time yet", async () => {
    const waiting = bookingDetail();
    waiting.payment = {
      ...waiting.payment,
      state: "pending",
      providerReference: null,
      succeededAt: null,
    };
    api({ [route.booking(bookingId)]: answer("owner", waiting) });
    renderDetail("owner");
    await loaded();
    const facts = terms(card("Payment"));
    expect(facts.Status).toBe("Awaiting payment");
    expect(facts["Provider reference"]).toBe("Not recorded yet");
    expect("Received" in facts).toBe(false);
    expect(card("Payment").querySelector(".bd-code")).toBeNull();
  });

  it("shows a refund that was made: its status, amount, and when it was asked for and settled", async () => {
    const refunded = bookingDetail({
      refund: {
        state: "succeeded",
        amount: 13109,
        failureCode: null,
        requestedAt: "2026-10-20T15:00:00.000Z",
        settledAt: "2026-10-20T15:02:00.000Z",
      },
    });
    api({ [route.booking(bookingId)]: answer("owner", refunded) });
    const { container } = renderDetail("owner");
    await loaded();
    const refund = card("Payment").querySelector(".bd-refund") as HTMLElement;
    expect(text(within(refund).getByRole("heading", { level: 3 }))).toBe("Refund");
    expect(terms(refund)).toEqual({
      Status: "Refunded",
      Amount: "$131.09",
      Requested: "Tue, Oct 20, 11:00 AM EDT",
      Settled: "Tue, Oct 20, 11:02 AM EDT",
    });
    // The refund speaks for the payment, at the top and in the card.
    expect(badges(container.querySelector(".bd-badges") as Element)).toEqual([
      "Confirmed",
      "Refunded",
    ]);
    expect(terms(card("Payment")).Status).toBe("Refunded");
  });

  it("shows a refund that is still on its way, with nothing settled", async () => {
    const pending = bookingDetail({
      refund: {
        state: "requested",
        amount: 13109,
        failureCode: null,
        requestedAt: "2026-10-20T15:00:00.000Z",
        settledAt: null,
      },
    });
    api({ [route.booking(bookingId)]: answer("owner", pending) });
    renderDetail("owner");
    await loaded();
    const refund = card("Payment").querySelector(".bd-refund") as HTMLElement;
    expect(terms(refund)).toEqual({
      Status: "Refund pending",
      Amount: "$131.09",
      Requested: "Tue, Oct 20, 11:00 AM EDT",
    });
  });

  it("shows a refund the provider refused, with its code in words", async () => {
    const failed = bookingDetail({
      refund: {
        state: "failed",
        amount: 13109,
        failureCode: "charge_already_refunded",
        requestedAt: "2026-10-20T15:00:00.000Z",
        settledAt: "2026-10-20T15:03:00.000Z",
      },
    });
    api({ [route.booking(bookingId)]: answer("owner", failed) });
    renderDetail("owner");
    await loaded();
    const refund = card("Payment").querySelector(".bd-refund") as HTMLElement;
    expect(terms(refund)).toEqual({
      Status: "Refund failed",
      Amount: "$131.09",
      Requested: "Tue, Oct 20, 11:00 AM EDT",
      Refused: "Tue, Oct 20, 11:03 AM EDT",
      "Provider said": "charge already refunded",
    });
  });
});

describe("what happened, and when", () => {
  it("lists the history oldest first, each event with the marina's time and zone", async () => {
    api({ [route.booking(bookingId)]: answer("owner") });
    renderDetail("owner");
    await loaded();
    // The first event is 2:05 PM in New York; it is already the next morning in Tokyo.
    expect(history()).toEqual([
      "Checkout opened, Tue, Oct 6, 2:05 PM EDT",
      "Payment received, Tue, Oct 6, 2:16 PM EDT",
      "Booking confirmed, Tue, Oct 6, 2:17 PM EDT",
    ]);
    expect(card("History").querySelectorAll("ol")).toHaveLength(1);
  });

  it("labels every kind of event, and tells the same time apart across the clock change", async () => {
    const eventful = bookingDetail({
      timeline: [
        { kind: "checkout_opened", at: "2026-10-31T14:00:00.000Z" },
        { kind: "paid", at: "2026-10-31T14:05:00.000Z" },
        { kind: "confirmed", at: "2026-10-31T14:05:30.000Z" },
        // 1:30 AM happens twice on Sunday, Nov 1: once in EDT, once an hour later in EST.
        { kind: "refund_requested", at: "2026-11-01T05:30:00.000Z" },
        { kind: "refund_failed", at: "2026-11-01T06:30:00.000Z" },
        { kind: "refunded", at: "2026-11-01T14:00:00.000Z" },
      ],
    });
    api({ [route.booking(bookingId)]: answer("owner", eventful) });
    renderDetail("owner");
    await loaded();
    expect(history()).toEqual([
      "Checkout opened, Sat, Oct 31, 10:00 AM EDT",
      "Payment received, Sat, Oct 31, 10:05 AM EDT",
      "Booking confirmed, Sat, Oct 31, 10:05 AM EDT",
      "Refund requested, Sun, Nov 1, 1:30 AM EDT",
      "Refund failed, Sun, Nov 1, 1:30 AM EST",
      "Refunded, Sun, Nov 1, 9:00 AM EST",
    ]);
  });

  it("says when the payment arrived after the checkout's hold ran out", async () => {
    api({
      [route.booking(bookingId)]: answer("owner", bookingDetail({ reacquired: true })),
    });
    const { container } = renderDetail("owner");
    await loaded();
    expect(text(container.querySelector(".bd-lede"))).toBe(
      "Booked online by the guest. Confirmed Tue, Oct 6, 2:17 PM EDT. The payment arrived after the checkout's hold ran out, and the seats were still free.",
    );
  });

  it("does not say it for a booking made in time", async () => {
    api({ [route.booking(bookingId)]: answer("owner") });
    const { container } = renderDetail("owner");
    await loaded();
    expect(container.textContent).not.toContain("hold ran out");
  });
});

describe("getting around", () => {
  it("links back to the trip's day, and to the trip's own bookings and roster", async () => {
    api({ [route.booking(bookingId)]: answer("owner") });
    const { navigate } = renderDetail("owner");
    await loaded();
    const back = screen.getByRole("link", { name: "Bookings on Wed, Nov 4" });
    // The trip's day, not today and not the viewer's day.
    expect(back.getAttribute("href")).toBe("/bookings?day=2026-11-04");
    fireEvent.click(back);
    expect(navigate).toHaveBeenLastCalledWith("/bookings?day=2026-11-04");

    const trip = screen.getByRole("link", { name: "Bookings on this trip" });
    expect(trip.getAttribute("href")).toBe(`/bookings?day=2026-11-04&trip=${tripIds.sunset}`);
    fireEvent.click(trip);
    expect(navigate).toHaveBeenLastCalledWith(`/bookings?day=2026-11-04&trip=${tripIds.sunset}`);

    fireEvent.click(screen.getByRole("link", { name: "Roster" }));
    expect(navigate).toHaveBeenLastCalledWith(`/trips/${tripIds.sunset}/roster`);
    expect(navigate).toHaveBeenCalledTimes(3);
  });

  it("leaves a modified click to the browser", async () => {
    api({ [route.booking(bookingId)]: answer("owner") });
    const { navigate } = renderDetail("owner");
    await loaded();
    // The browser's own handling is left alone; the test stops it, as the test DOM cannot navigate.
    let leftAlone = false;
    const listener = (event: Event) => {
      leftAlone = !event.defaultPrevented;
      event.preventDefault();
    };
    document.addEventListener("click", listener);
    fireEvent.click(screen.getByRole("link", { name: "Bookings on Wed, Nov 4" }), {
      ctrlKey: true,
    });
    document.removeEventListener("click", listener);
    expect(navigate).not.toHaveBeenCalled();
    expect(leftAlone).toBe(true);
  });
});

describe("a booking that is not there", () => {
  it("shows the designed not-here state, with Go to bookings", async () => {
    api({ [route.booking(bookingId)]: () => apiError(404, "not_found") });
    const { navigate, container } = renderDetail("owner");
    const empty = await screen.findByRole("heading", { level: 2, name: "This booking isn't here" });
    expect(text(container.querySelector("h1"))).toBe("Booking");
    expect(text(empty.closest(".tg-empty"))).toContain(
      `${tenantName} has no booking at this address. It may belong to another operator, or the link may be incomplete.`,
    );
    expect(text(empty.closest(".tg-empty"))).toContain("Quick find on Bookings");
    const go = screen.getByRole("link", { name: "Go to bookings" });
    expect(go.getAttribute("href")).toBe("/bookings");
    fireEvent.click(go);
    expect(navigate).toHaveBeenCalledWith("/bookings");
    // Nothing about a booking is shown for it.
    expect(screen.queryByRole("region", { name: "Guest" })).toBeNull();
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("says the same for finance", async () => {
    api({ [route.booking(bookingId)]: () => apiError(404, "not_found") });
    renderDetail("finance");
    expect(await screen.findByRole("heading", { name: "This booking isn't here" })).toBeTruthy();
  });
});

describe("when the booking does not load", () => {
  it("shows a designed error, keeps the button while it works, and then the booking", async () => {
    const retry = deferred();
    api({ [route.booking(bookingId)]: [dropped, retry.answer] });
    renderDetail("owner");
    const alert = await screen.findByRole("alert");
    expect(text(alert)).toContain("The console can't reach TideGrid");
    const button = within(alert).getByRole("button", { name: "Try again" });
    button.focus();
    fireEvent.click(button);
    expect(await screen.findByRole("button", { name: "Trying again…" })).toBe(button);
    expect(document.activeElement).toBe(button);
    retry.release(json(bookingBody()));
    await loaded();
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("hands focus to the page's heading once Try again works and its button is gone", async () => {
    const retry = deferred();
    api({ [route.booking(bookingId)]: [dropped, retry.answer] });
    renderDetail("owner");
    const button = within(await screen.findByRole("alert")).getByRole("button", {
      name: "Try again",
    });
    button.focus();
    fireEvent.click(button);
    retry.release(json(bookingBody()));
    const heading = await loaded();
    expect(screen.queryByRole("alert")).toBeNull();
    await waitFor(() => expect(document.activeElement).toBe(heading));
  });

  it("leaves focus where the person moved it while Try again worked", async () => {
    const retry = deferred();
    api({ [route.booking(bookingId)]: [dropped, retry.answer] });
    renderDetail("owner");
    const button = within(await screen.findByRole("alert")).getByRole("button", {
      name: "Try again",
    });
    button.focus();
    fireEvent.click(button);
    // Somewhere else on the page, such as the console's navigation.
    const elsewhere = document.body.appendChild(document.createElement("button"));
    elsewhere.focus();
    retry.release(json(bookingBody()));
    await loaded();
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(document.activeElement).toBe(elsewhere);
    elsewhere.remove();
  });

  it("hands focus to the page's heading when Try again ends with nothing left to try", async () => {
    const retry = deferred();
    api({ [route.booking(bookingId)]: [dropped, retry.answer] });
    renderDetail("owner");
    const button = within(await screen.findByRole("alert")).getByRole("button", {
      name: "Try again",
    });
    button.focus();
    fireEvent.click(button);
    retry.release(apiError(404, "not_found"));
    await screen.findByRole("heading", { level: 2, name: "This booking isn't here" });
    const heading = screen.getByRole("heading", { level: 1, name: "Booking" });
    await waitFor(() => expect(document.activeElement).toBe(heading));
  });

  it("keeps focus on Try again when the second try fails too", async () => {
    api({ [route.booking(bookingId)]: [dropped, dropped] });
    renderDetail("owner");
    const button = within(await screen.findByRole("alert")).getByRole("button", {
      name: "Try again",
    });
    button.focus();
    fireEvent.click(button);
    await waitFor(() =>
      expect(text(screen.getByRole("alert"))).toContain("This booking still didn't load"),
    );
    expect(document.activeElement).toBe(button);
    expect(screen.getByRole("button", { name: "Try again" })).toBe(button);
  });

  it("says it still did not load after a second failure", async () => {
    api({ [route.booking(bookingId)]: [dropped, dropped] });
    renderDetail("owner");
    fireEvent.click(
      within(await screen.findByRole("alert")).getByRole("button", { name: "Try again" }),
    );
    await waitFor(() =>
      expect(text(screen.getByRole("alert"))).toContain("This booking still didn't load"),
    );
  });

  it.each([
    [401, "unauthenticated", "You're signed out"],
    [403, "forbidden", "Your role can't see this booking"],
    [403, "tenant_suspended", "This operator is suspended"],
    [500, "internal_error", "This booking didn't load"],
  ] as const)("reads a %i %s in plain words", async (status, code, title) => {
    api({ [route.booking(bookingId)]: () => apiError(status, code) });
    renderDetail("owner");
    const alert = await screen.findByRole("alert");
    expect(text(alert)).toContain(title);
    expect(text(alert)).not.toMatch(/\b[1-5]\d\d\b|_/);
  });

  const broken: Array<[string, (b: BookingDetail) => unknown]> = [
    [
      "a total that is not whole cents",
      (b) => ({ ...b, payment: { ...b.payment, amount: 131.09 } }),
    ],
    [
      "a payment state it does not know",
      (b) => ({ ...b, payment: { ...b.payment, state: "settled" } }),
    ],
    [
      "a payment provider it does not know",
      (b) => ({ ...b, payment: { ...b.payment, provider: "paypal" } }),
    ],
    [
      "an order line kind it does not know",
      (b) => ({
        ...b,
        order: { ...b.order, lines: [{ ...b.order.lines[0], kind: "rebate" }] },
      }),
    ],
    [
      "a time zone the browser cannot show",
      (b) => ({ ...b, trip: { ...b.trip, timeZone: "Mars/Olympus_Mons" } }),
    ],
    ["a booker with a name and no email", (b) => ({ ...b, booker: { name: "Maya Okonkwo" } })],
    ["no order", (b) => ({ ...b, order: undefined })],
    ["no timeline", (b) => ({ ...b, timeline: undefined })],
    [
      "a refund with no amount",
      (b) => ({ ...b, refund: { state: "requested", requestedAt: b.confirmedAt } }),
    ],
    ["a confirmation time that is not a time", (b) => ({ ...b, confirmedAt: "recently" })],
    // What the page formats, not only what it adds up: a malformed one would otherwise crash it.
    [
      "a trip end that is not a date and time",
      (b) => ({ ...b, trip: { ...b.trip, endsAtLocal: "tomorrow" } }),
    ],
    [
      "a trip end on a day that does not exist",
      (b) => ({ ...b, trip: { ...b.trip, endsAtLocal: "2026-13-45T10:00:00-05:00" } }),
    ],
    ["a trip with no duration", (b) => ({ ...b, trip: { ...b.trip, durationMinutes: undefined } })],
    [
      "a payment time that is not a time",
      (b) => ({ ...b, payment: { ...b.payment, succeededAt: "yesterday" } }),
    ],
    [
      "a refund settled at a time that is not a time",
      (b) => ({
        ...b,
        refund: {
          state: "succeeded",
          amount: 1,
          failureCode: null,
          requestedAt: b.confirmedAt,
          settledAt: "soon",
        },
      }),
    ],
    [
      "a refund with a failure code that is not text",
      (b) => ({
        ...b,
        refund: {
          state: "failed",
          amount: 1,
          failureCode: 402,
          requestedAt: b.confirmedAt,
          settledAt: null,
        },
      }),
    ],
    [
      "a history event it has no label for",
      (b) => ({ ...b, timeline: [...b.timeline, { kind: "voided", at: b.confirmedAt }] }),
    ],
  ];

  it.each(broken)("treats %s as an answer it can't show, not as a crash", async (_what, change) => {
    // React reports a render error it catches; keep the test output clean.
    vi.spyOn(console, "error").mockImplementation(() => {});
    api({ [route.booking(bookingId)]: () => json({ booking: change(bookingDetail()) }) });
    render(
      <ErrorBoundary fallback={<p>The page crashed</p>}>
        <BookingDetailPage
          membership={membership("owner")}
          bookingId={bookingId}
          focusHeading={false}
        />
      </ErrorBoundary>,
    );
    const alert = await screen.findByRole("alert");
    expect(text(alert)).toContain("This booking couldn't be shown");
    expect(within(alert).getByRole("button", { name: "Try again" })).toBeTruthy();
    expect(screen.queryByText("The page crashed")).toBeNull();
  });
});
