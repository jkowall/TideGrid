// @vitest-environment jsdom

// Staff in Tokyo looking at a New York marina: times must stay the trip's own.
process.env.TZ = "Asia/Tokyo";

import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { FinalizationException, StaffRole } from "@tidegrid/contracts";
import { StrictMode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NavigationProvider } from "../navigation.tsx";
import { ExceptionsPage } from "./ExceptionsPage.tsx";
import {
  api,
  apiError,
  asSeenBy,
  bookerFragmentsIn,
  bookers,
  callsTo,
  deferred,
  dropped,
  exceptionIds,
  expectNoPersonalDataInAddresses,
  finalizationException,
  json,
  membership,
  route,
  strayRequests,
  tenantName,
  terms,
  text,
  tripIds,
} from "./fixtures.ts";

/** U+00A0, which the format module puts between a time and AM or PM. */
const nbsp = String.fromCharCode(0x00a0);

const noCapacity = finalizationException();
const mismatch = finalizationException({
  id: exceptionIds.mismatch,
  reason: "payment_mismatch",
  refund: null,
  checkout: { state: "open", expiresAt: "2026-10-05T15:45:00.000Z" },
  payment: {
    provider: "fake",
    providerReference: "fpay_••••e5F6",
    receivedAt: "2026-10-05T16:00:00.000Z",
    reportedAmount: 12900,
    reportedCurrency: "USD",
  },
  createdAt: "2026-10-05T16:00:00.000Z",
});
const canceled = finalizationException({
  id: exceptionIds.canceled,
  reason: "trip_canceled",
  partySize: 1,
  amount: 4500,
  refund: {
    id: "7f8091a2-3c4d-4e5f-8a61-7c8d9e0f1a02",
    state: "requested",
    amount: 4500,
    failureCode: null,
    settledAt: null,
  },
  payment: {
    provider: "fake",
    providerReference: "fpay_••••g7H8",
    receivedAt: "2026-10-04T13:00:00.000Z",
    reportedAmount: 4500,
    reportedCurrency: "USD",
  },
  createdAt: "2026-10-04T13:00:00.000Z",
});
const failedRefund = finalizationException({
  id: exceptionIds.failedRefund,
  reason: "session_failed",
  partySize: 2,
  amount: 9000,
  refund: {
    id: "7f8091a2-3c4d-4e5f-8a61-7c8d9e0f1a03",
    state: "failed",
    amount: 9000,
    failureCode: "charge_already_refunded",
    settledAt: "2026-10-03T13:05:00.000Z",
  },
  payment: {
    provider: "fake",
    providerReference: null,
    receivedAt: "2026-10-03T13:00:00.000Z",
    reportedAmount: 9000,
    reportedCurrency: "USD",
  },
  createdAt: "2026-10-03T13:00:00.000Z",
});

const body = (exceptions: FinalizationException[], nextBefore: string | null = null) => ({
  exceptions,
  nextBefore,
});

/** The page in a navigation provider, so a link's destination is recorded. */
function renderPage(role: StaffRole = "owner", options: { strict?: boolean } = {}) {
  const navigate = vi.fn();
  const page = (
    <NavigationProvider navigate={navigate}>
      <ExceptionsPage membership={membership(role)} focusHeading={false} />
    </NavigationProvider>
  );
  const view = render(options.strict ? <StrictMode>{page}</StrictMode> : page);
  return { navigate, ...view };
}

// The list's items, not the loading placeholders, which wear the same class.
const items = () => [...document.querySelectorAll<HTMLElement>("li.ex-item")];
const titleOf = (item: Element) => text(item.querySelector(".ex-item__title"));
const factsOf = (item: Element) => terms(item.querySelector("dl"));
const badgeOf = (item: Element) => text(item.querySelector(".tg-status"));
const liveText = () => text(document.querySelector('p[role="status"]'));

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-11-04T17:00:00Z"));
  window.history.replaceState(null, "", "/exceptions");
});

afterEach(() => {
  const strays = strayRequests();
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  expect(strays).toEqual([]);
});

describe("payment exceptions", () => {
  it("asks for the newest 50 and shows one item per exception, in the order sent", async () => {
    const calls = api({
      [route.exceptions()]: () => json(body([noCapacity, mismatch, canceled, failedRefund])),
    });
    const { container } = renderPage();
    await screen.findByRole("heading", { level: 1, name: "Payment exceptions" });
    await waitFor(() => expect(items()).toHaveLength(4));
    expect(calls).toHaveLength(1);
    expect(calls[0]?.query.get("limit")).toBe("50");
    expect(calls[0]?.query.has("before")).toBe(false);
    expect(text(container.querySelector(".tg-eyebrow"))).toBe(tenantName);
    expect(items().map(titleOf)).toEqual([
      "Paid after the checkout ran out of time, and the seats were gone",
      "A payment that didn't match its checkout",
      "Paid after the trip was canceled",
      "Paid after the payment provider had reported the payment failed",
    ]);
    // Each title is a heading under the page's one h1.
    expect(screen.getAllByRole("heading", { level: 2 })).toHaveLength(4);
    expect(liveText()).toBe("4 payment exceptions.");
    expect(text(container.querySelector(".ex-lede"))).toBe(
      "Payments that arrived but couldn't become bookings. TideGrid refunds each one in full automatically, except a payment that didn't match its checkout, which needs a check with the payment provider.",
    );
  });

  it("loads the list while React runs effects twice in development", async () => {
    // The console's entry point wraps everything in StrictMode, which starts every load twice.
    api({ [route.exceptions()]: () => json(body([noCapacity, mismatch])) });
    renderPage("owner", { strict: true });
    await waitFor(() => expect(items()).toHaveLength(2));
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("shows what happened, the refund, the trip, the amount, the times, and who paid", async () => {
    api({ [route.exceptions()]: () => json(body([noCapacity])) });
    renderPage("owner");
    const [item] = await waitFor(() => {
      expect(items()).toHaveLength(1);
      return items();
    });
    const element = item as HTMLElement;
    expect(badgeOf(element)).toBe("Refunded");
    expect(text(element.querySelector(".ex-item__detail"))).toBe(
      "$131.09 was refunded in full to the guest's payment method.",
    );
    // The trip links to its day's bookings, to see who holds the seats now.
    const trip = within(element).getByRole("link", {
      name: /^Sunset Harbor Cruise, Wed, Nov 4, 6:00\sPM$/,
    });
    expect(trip.getAttribute("href")).toBe(`/bookings?day=2026-11-04&trip=${tripIds.sunset}`);

    const facts = factsOf(element);
    expect(Object.keys(facts)).toEqual([
      "Trip",
      "Party",
      "Amount",
      "Checkout ran out",
      "Payment received",
      "Provider reference",
      "Paid by",
    ]);
    expect(facts.Party).toBe("3 guests");
    expect(facts.Amount).toBe("$131.09");
    // The checkout's hold ran out at 2:25 PM at the marina, 3:25 AM the next day in Tokyo.
    expect(facts["Checkout ran out"]).toBe("Tue, Oct 6, 2:25 PM EDT");
    expect(facts["Payment received"]).toBe("Tue, Oct 6, 2:40 PM EDT");
    expect(facts["Provider reference"]).toBe("fpay_••••c3D4");
    expect(text(element.querySelector(".bd-code"))).toBe("fpay_••••c3D4");
    // Who paid, for following up with them.
    const paidBy = element.querySelector(".console-dl__wrap") as HTMLElement;
    expect(paidBy.firstChild?.textContent).toBe("Maya Okonkwo");
    expect(text(paidBy.querySelector(".bd-block"))).toBe("maya.okonkwo@guest.example");
    expect(element.getAttribute("data-tone")).toBe("info");
    // The guest is on the page, and nowhere in an address.
    expectNoPersonalDataInAddresses();
  });

  it("shows a payment that did not match as not refunded, with what the provider reported", async () => {
    api({ [route.exceptions()]: () => json(body([mismatch])) });
    renderPage("owner");
    await waitFor(() => expect(items()).toHaveLength(1));
    const [item] = items() as [HTMLElement];
    expect(titleOf(item)).toBe("A payment that didn't match its checkout");
    expect(badgeOf(item)).toBe("Not refunded");
    expect(text(item.querySelector(".ex-item__detail"))).toBe(
      "Nothing was refunded automatically. Check this payment with the payment provider before you act.",
    );
    expect(item.getAttribute("data-tone")).toBe("warning");
    const facts = factsOf(item);
    // What the checkout charged and what the provider says it received are both shown.
    expect(facts.Amount).toBe("$131.09");
    expect(facts["Provider reported"]).toBe("$129.00");
    // Only a payment that ran out of capacity says when its checkout ran out.
    expect("Checkout ran out" in facts).toBe(false);
    expect(facts["Payment received"]).toBe("Mon, Oct 5, 12:00 PM EDT");
  });

  it("does not format an amount in another currency as dollars", async () => {
    const euros = finalizationException({
      ...mismatch,
      payment: { ...mismatch.payment, reportedAmount: 12900, reportedCurrency: "EUR" },
    });
    api({ [route.exceptions()]: () => json(body([euros])) });
    renderPage("owner");
    await waitFor(() => expect(items()).toHaveLength(1));
    expect(factsOf(items()[0] as HTMLElement)["Provider reported"]).toBe(
      "12900 minor units of EUR",
    );
  });

  it("leaves out what the provider reported when it did not say", async () => {
    const silent = finalizationException({
      ...mismatch,
      payment: { ...mismatch.payment, reportedAmount: null, reportedCurrency: null },
    });
    api({ [route.exceptions()]: () => json(body([silent])) });
    renderPage("owner");
    await waitFor(() => expect(items()).toHaveLength(1));
    expect("Provider reported" in factsOf(items()[0] as HTMLElement)).toBe(false);
  });

  it("shows a refund still on its way, and one the provider refused", async () => {
    api({ [route.exceptions()]: () => json(body([canceled, failedRefund])) });
    renderPage("owner");
    await waitFor(() => expect(items()).toHaveLength(2));
    const [pending, refused] = items() as [HTMLElement, HTMLElement];
    expect(badgeOf(pending)).toBe("Refund pending");
    expect(text(pending.querySelector(".ex-item__detail"))).toBe(
      "A full refund of $45.00 is on its way. TideGrid retries it until the provider answers.",
    );
    expect(factsOf(pending).Party).toBe("1 guest");
    expect(factsOf(pending).Amount).toBe("$45.00");
    expect(badgeOf(refused)).toBe("Refund failed");
    expect(text(refused.querySelector(".ex-item__detail"))).toBe(
      "The provider refused the $90.00 refund (charge already refunded). Refund the guest another way, or contact the provider.",
    );
    expect(refused.getAttribute("data-tone")).toBe("blocked");
    // A payment the provider never gave a reference for says so.
    expect(factsOf(refused)["Provider reference"]).toBe("Not recorded");
  });

  it("gives each refund state its own badge words", async () => {
    api({
      [route.exceptions()]: () => json(body([noCapacity, mismatch, canceled, failedRefund])),
    });
    renderPage("owner");
    await waitFor(() => expect(items()).toHaveLength(4));
    const labels = items().map(badgeOf);
    expect(labels).toEqual(["Refunded", "Not refunded", "Refund pending", "Refund failed"]);
    expect(new Set(labels).size).toBe(4);
    // Each carries an icon beside its words, so color is never the only sign.
    for (const item of items()) {
      expect(item.querySelector(".tg-status svg")).not.toBeNull();
    }
  });

  it("reads the times in the trip's own zone, not the viewer's or the operator's", async () => {
    const dive = finalizationException({
      trip: {
        tripId: tripIds.honolulu,
        productName: "Two-Tank Morning Dive",
        productKind: "shared_seat",
        boatName: "Reef Runner",
        timeZone: "Pacific/Honolulu",
        localDate: "2026-11-04",
        localStartTime: "07:30",
        startsAt: "2026-11-04T17:30:00.000Z",
        salesState: "published",
      },
      tripId: tripIds.honolulu,
    });
    api({ [route.exceptions()]: () => json(body([dive])) });
    renderPage("owner");
    await waitFor(() => expect(items()).toHaveLength(1));
    const item = items()[0] as HTMLElement;
    // 18:25 UTC is 8:25 AM in Honolulu; in Tokyo it is 3:25 AM the next day.
    expect(factsOf(item)["Checkout ran out"]).toBe("Tue, Oct 6, 8:25 AM HST");
    expect(factsOf(item)["Payment received"]).toBe("Tue, Oct 6, 8:40 AM HST");
    expect(within(item).getByRole("link").textContent).toBe(
      `Two-Tank Morning Dive, Wed, Nov 4, 7:30${nbsp}AM`,
    );
    expect(within(item).getByRole("link").getAttribute("href")).toBe(
      `/bookings?day=2026-11-04&trip=${tripIds.honolulu}`,
    );
  });

  it("follows a trip's link in place", async () => {
    api({ [route.exceptions()]: () => json(body([noCapacity])) });
    const { navigate } = renderPage("owner");
    await waitFor(() => expect(items()).toHaveLength(1));
    fireEvent.click(within(items()[0] as HTMLElement).getByRole("link"));
    expect(navigate).toHaveBeenCalledWith(`/bookings?day=2026-11-04&trip=${tripIds.sunset}`);
  });
});

describe("what each role sees", () => {
  it("shows booking staff who paid, as an owner sees it", async () => {
    api({ [route.exceptions()]: () => json(asSeenBy("booking_staff", body([noCapacity]))) });
    renderPage("booking_staff");
    await waitFor(() => expect(items()).toHaveLength(1));
    expect(Object.keys(factsOf(items()[0] as HTMLElement))).toContain("Paid by");
    expect(screen.queryByText(/aren't shown to your role/)).toBeNull();
  });

  it("shows finance the money without the person, with a note", async () => {
    api({ [route.exceptions()]: () => json(asSeenBy("finance", body([noCapacity, mismatch]))) });
    const { container } = renderPage("finance");
    await waitFor(() => expect(items()).toHaveLength(2));
    expect(text(screen.getByText(/aren't shown to your role/))).toBe(
      "Guests' names and contact details aren't shown to your role, finance.",
    );
    for (const item of items()) {
      expect("Paid by" in factsOf(item)).toBe(false);
    }
    const page = `${container.innerHTML} ${container.textContent}`.toLowerCase();
    expect(bookerFragmentsIn(page)).toEqual([]);
    expect(page).not.toContain("@guest.example");
    // Everything else is the same: what happened, the refund, the amounts, and the times.
    expect(factsOf(items()[0] as HTMLElement).Amount).toBe("$131.09");
    expect(factsOf(items()[1] as HTMLElement)["Provider reported"]).toBe("$129.00");
    expect(badgeOf(items()[0] as HTMLElement)).toBe("Refunded");
  });

  it("makes the same request for every role", async () => {
    const asked: string[][] = [];
    for (const role of ["owner", "booking_staff", "finance"] as const) {
      const calls = api({ [route.exceptions()]: () => json(asSeenBy(role, body([noCapacity]))) });
      renderPage(role);
      await waitFor(() => expect(items()).toHaveLength(1));
      asked.push(calls.map((c) => `${c.method} ${c.path}?${c.query}`));
      cleanup();
    }
    expect(asked[1]).toEqual(asked[0]);
    expect(asked[2]).toEqual(asked[0]);
  });
});

describe("when there are none", () => {
  it("shows the designed empty state", async () => {
    api({ [route.exceptions()]: () => json(body([])) });
    renderPage();
    const heading = await screen.findByRole("heading", { level: 2, name: "No payment exceptions" });
    expect(text(heading.closest(".tg-empty"))).toContain(
      `Every payment ${tenantName} received became a booking. A payment that arrives too late, or doesn't match its checkout, shows here for follow-up.`,
    );
    expect(items()).toHaveLength(0);
    expect(screen.queryByRole("button", { name: /older/ })).toBeNull();
    expect(liveText()).toBe("No payment exceptions.");
  });
});

describe("older exceptions", () => {
  it("asks for the next page with before=, appends it, and goes when the last page arrives", async () => {
    const older = deferred();
    const calls = api({
      [route.exceptions()]: [() => json(body([noCapacity, mismatch], mismatch.id)), older.answer],
    });
    renderPage();
    await waitFor(() => expect(items()).toHaveLength(2));
    expect(liveText()).toBe("2 payment exceptions shown, with older ones to load.");

    const button = screen.getByRole("button", { name: "Show older exceptions" });
    button.focus();
    fireEvent.click(button);
    expect(await screen.findByRole("button", { name: "Loading older…" })).toBe(button);
    expect(button.getAttribute("aria-busy")).toBe("true");
    expect(callsTo(calls, route.exceptions())[1]?.query.get("before")).toBe(mismatch.id);
    expect(callsTo(calls, route.exceptions())[1]?.query.get("limit")).toBe("50");
    // The first page stays while the older one loads.
    expect(items()).toHaveLength(2);

    older.release(json(body([canceled, failedRefund], null)));
    await waitFor(() => expect(items()).toHaveLength(4));
    expect(items().map(badgeOf)).toEqual([
      "Refunded",
      "Not refunded",
      "Refund pending",
      "Refund failed",
    ]);
    expect(screen.queryByRole("button", { name: /Show older|Loading older/ })).toBeNull();
    expect(liveText()).toBe("4 payment exceptions.");
  });

  it("keeps what it has when the older page fails, and tries again with the same cursor", async () => {
    const calls = api({
      [route.exceptions()]: [
        () => json(body([noCapacity], noCapacity.id)),
        dropped,
        () => json(body([mismatch], null)),
      ],
    });
    renderPage();
    await waitFor(() => expect(items()).toHaveLength(1));
    fireEvent.click(screen.getByRole("button", { name: "Show older exceptions" }));
    const notice = (await screen.findByText("Older exceptions didn't load")).closest(
      ".tg-notice",
    ) as HTMLElement;
    expect(text(notice)).toContain("Check your connection, then try again.");
    expect(items()).toHaveLength(1);
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    await waitFor(() => expect(items()).toHaveLength(2));
    expect(callsTo(calls, route.exceptions()).map((c) => c.query.get("before"))).toEqual([
      null,
      noCapacity.id,
      noCapacity.id,
    ]);
    expect(screen.queryByText("Older exceptions didn't load")).toBeNull();
  });

  it("hands focus to the first older exception when Show older exceptions goes away with the last page", async () => {
    api({
      [route.exceptions()]: [
        () => json(body([noCapacity], noCapacity.id)),
        () => json(body([mismatch], null)),
      ],
    });
    renderPage();
    await waitFor(() => expect(items()).toHaveLength(1));
    const button = screen.getByRole("button", { name: "Show older exceptions" });
    button.focus();
    fireEvent.click(button);
    await waitFor(() => expect(items()).toHaveLength(2));
    expect(screen.queryByRole("button", { name: /Show older|Loading older/ })).toBeNull();
    const first = screen.getByRole("heading", {
      level: 2,
      name: "A payment that didn't match its checkout",
    });
    await waitFor(() => expect(document.activeElement).toBe(first));
  });

  it("keeps focus on Show older exceptions while older ones remain", async () => {
    api({
      [route.exceptions()]: [
        () => json(body([noCapacity], noCapacity.id)),
        () => json(body([mismatch], mismatch.id)),
      ],
    });
    renderPage();
    await waitFor(() => expect(items()).toHaveLength(1));
    const button = screen.getByRole("button", { name: "Show older exceptions" });
    button.focus();
    fireEvent.click(button);
    await waitFor(() => expect(items()).toHaveLength(2));
    expect(screen.getByRole("button", { name: "Show older exceptions" })).toBe(button);
    expect(document.activeElement).toBe(button);
  });

  it("says one exception in the singular", async () => {
    api({ [route.exceptions()]: () => json(body([canceled])) });
    renderPage();
    await waitFor(() => expect(items()).toHaveLength(1));
    expect(liveText()).toBe("1 payment exception.");
  });
});

describe("when the exceptions do not load", () => {
  it("shows a designed error, keeps the button while it works, and then the list", async () => {
    const retry = deferred();
    api({ [route.exceptions()]: [dropped, retry.answer] });
    renderPage();
    const alert = await screen.findByRole("alert");
    expect(text(alert)).toContain("The console can't reach TideGrid");
    // The page still says what it is.
    expect(screen.getByRole("heading", { level: 1, name: "Payment exceptions" })).toBeTruthy();
    const button = within(alert).getByRole("button", { name: "Try again" });
    button.focus();
    fireEvent.click(button);
    expect(await screen.findByRole("button", { name: "Trying again…" })).toBe(button);
    expect(document.activeElement).toBe(button);
    retry.release(json(body([noCapacity])));
    await waitFor(() => expect(items()).toHaveLength(1));
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("hands focus to the page's heading once Try again works and its button is gone", async () => {
    const retry = deferred();
    api({ [route.exceptions()]: [dropped, retry.answer] });
    renderPage();
    const button = within(await screen.findByRole("alert")).getByRole("button", {
      name: "Try again",
    });
    button.focus();
    fireEvent.click(button);
    retry.release(json(body([noCapacity])));
    await waitFor(() => expect(items()).toHaveLength(1));
    expect(screen.queryByRole("alert")).toBeNull();
    const heading = screen.getByRole("heading", { level: 1, name: "Payment exceptions" });
    await waitFor(() => expect(document.activeElement).toBe(heading));
  });

  it("hands focus to the page's heading when Try again ends with nothing left to try", async () => {
    const retry = deferred();
    api({ [route.exceptions()]: [dropped, retry.answer] });
    renderPage();
    const button = within(await screen.findByRole("alert")).getByRole("button", {
      name: "Try again",
    });
    button.focus();
    fireEvent.click(button);
    retry.release(apiError(403, "forbidden"));
    await waitFor(() =>
      expect(text(screen.getByRole("alert"))).toContain("Your role can't see payment exceptions"),
    );
    const heading = screen.getByRole("heading", { level: 1, name: "Payment exceptions" });
    await waitFor(() => expect(document.activeElement).toBe(heading));
  });

  it("keeps focus on Try again when the second try fails too", async () => {
    api({ [route.exceptions()]: [dropped, dropped] });
    renderPage();
    const button = within(await screen.findByRole("alert")).getByRole("button", {
      name: "Try again",
    });
    button.focus();
    fireEvent.click(button);
    await waitFor(() =>
      expect(text(screen.getByRole("alert"))).toContain("Payment exceptions still didn't load"),
    );
    expect(document.activeElement).toBe(button);
    expect(screen.getByRole("button", { name: "Try again" })).toBe(button);
  });

  it("says it still did not load after a second failure", async () => {
    api({ [route.exceptions()]: [dropped, dropped] });
    renderPage();
    fireEvent.click(
      within(await screen.findByRole("alert")).getByRole("button", { name: "Try again" }),
    );
    await waitFor(() =>
      expect(text(screen.getByRole("alert"))).toContain("Payment exceptions still didn't load"),
    );
  });

  it.each([
    [401, "unauthenticated", "You're signed out"],
    [403, "forbidden", "Your role can't see payment exceptions"],
    [403, "tenant_suspended", "This operator is suspended"],
    [404, "not_found", "You no longer have access to this operator"],
    [500, "internal_error", "Payment exceptions didn't load"],
  ] as const)("reads a %i %s in plain words", async (status, code, title) => {
    api({ [route.exceptions()]: () => apiError(status, code) });
    renderPage();
    const alert = await screen.findByRole("alert");
    expect(text(alert)).toContain(title);
    expect(text(alert)).not.toMatch(/\b[1-5]\d\d\b|_/);
  });

  it.each([
    ["a reason it does not know", { ...noCapacity, reason: "disputed" }],
    ["an amount that is not whole cents", { ...noCapacity, amount: 131.09 }],
    [
      "a refund with a state it does not know",
      { ...noCapacity, refund: { ...noCapacity.refund, state: "reversed" } },
    ],
    [
      "a trip with a time zone the browser cannot show",
      { ...noCapacity, trip: { ...noCapacity.trip, timeZone: "Mars/Olympus_Mons" } },
    ],
    ["a party that is not a count", { ...noCapacity, partySize: "three" }],
    [
      "a payment time that is not a time",
      { ...noCapacity, payment: { ...noCapacity.payment, receivedAt: "later" } },
    ],
    ["a booker with a name and no email", { ...noCapacity, booker: { name: bookers.maya.name } }],
    ["no payment", { ...noCapacity, payment: undefined }],
    // What the page formats: a malformed one would otherwise crash it.
    [
      "a refund failure code that is not text",
      { ...noCapacity, refund: { ...noCapacity.refund, state: "failed", failureCode: 402 } },
    ],
    [
      "a reported currency that is not text",
      { ...mismatch, payment: { ...mismatch.payment, reportedCurrency: 840 } },
    ],
  ])("treats %s as an answer it can't show, not as a crash", async (_what, odd) => {
    api({ [route.exceptions()]: () => json({ exceptions: [odd], nextBefore: null }) });
    renderPage();
    const alert = await screen.findByRole("alert");
    expect(text(alert)).toContain("Payment exceptions couldn't be shown");
    expect(within(alert).getByRole("button", { name: "Try again" })).toBeTruthy();
  });

  it("treats a missing list as an answer it can't show", async () => {
    api({ [route.exceptions()]: () => json({ nextBefore: null }) });
    renderPage();
    expect(text(await screen.findByRole("alert"))).toContain(
      "Payment exceptions couldn't be shown",
    );
  });
});
