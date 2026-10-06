// @vitest-environment jsdom

// Staff in Tokyo looking at a New York marina: times must stay New York's.
process.env.TZ = "Asia/Tokyo";

import { cleanup, render, screen, within } from "@testing-library/react";
import type { BookingCancellation, BookingDetail, StaffRole } from "@tidegrid/contracts";
import { iconNames } from "@tidegrid/design-system/components";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NavigationProvider } from "../navigation.tsx";
import { loadBooking } from "./api.ts";
import { BookingDetailPage } from "./BookingDetail.tsx";
import {
  api,
  asSeenBy,
  bookerFragmentsIn,
  bookingDetail,
  bookingIds,
  json,
  membership,
  route,
  strayRequests,
  tenantId,
  terms,
  text,
} from "./fixtures.ts";
import { bookingStates, cancellationRemedyText, cancelledByText, timelineLabel } from "./model.ts";

/**
 * A canceled booking in the console (lane 1, G2.11c): the Canceled badge, the
 * cancellation block with the terms the policy applied, the lede sentence, and
 * the history's "Booking canceled". The page reads the booking through its own
 * loader, as it does in the console, so a booking the loader cannot read never
 * reaches the screen.
 */

const bookingId = bookingIds.maya;

/** What the policy applied when the guest canceled: a full refund, before the cutoff. */
const applied: BookingCancellation = {
  // 10:30 AM on Mon, Nov 2 in New York, which is already the evening in Tokyo.
  canceledAt: "2026-11-02T15:30:00.000Z",
  by: "guest",
  remedy: "full_refund",
  refundBp: 10_000,
  refundAmount: 13_109,
  paidAmount: 13_109,
  // 6:00 PM on Tue, Nov 3: 24 hours before the 6:00 PM trip on Wed, Nov 4.
  cutoffAt: "2026-11-03T23:00:00.000Z",
  beforeCutoff: true,
  policyVersion: 3,
};

/**
 * The booking as the API sends it once canceled: the state, the terms applied,
 * the refund they asked for, and the history, in the order the API writes it.
 */
function canceledBooking(
  over: Partial<BookingCancellation> = {},
  refundState: "requested" | "succeeded" | null = "requested",
): BookingDetail {
  const cancellation: BookingCancellation = { ...applied, ...over };
  const asked = cancellation.refundAmount > 0 && refundState !== null;
  const settledAt = new Date(Date.parse(cancellation.canceledAt) + 2 * 60_000).toISOString();
  const refund: BookingDetail["refund"] = asked
    ? {
        state: refundState,
        amount: cancellation.refundAmount,
        failureCode: null,
        requestedAt: cancellation.canceledAt,
        settledAt: refundState === "succeeded" ? settledAt : null,
      }
    : null;
  return bookingDetail({
    state: "canceled",
    canceledAt: cancellation.canceledAt,
    cancellation,
    refund,
    timeline: [
      ...bookingDetail().timeline,
      { kind: "canceled", at: cancellation.canceledAt },
      ...(refund ? [{ kind: "refund_requested" as const, at: refund.requestedAt }] : []),
      ...(refund?.settledAt ? [{ kind: "refunded" as const, at: refund.settledAt }] : []),
    ],
  });
}

const bookingBody = (booking: BookingDetail) => ({ booking });

/** The booking, as the API sends it to a role. */
const answer = (role: StaffRole, booking: BookingDetail) => () =>
  json(asSeenBy(role, bookingBody(booking)));

function renderDetail(role: StaffRole = "owner") {
  return render(
    <NavigationProvider navigate={vi.fn()}>
      <BookingDetailPage membership={membership(role)} bookingId={bookingId} focusHeading={false} />
    </NavigationProvider>,
  );
}

const card = (name: string) => screen.getByRole("region", { name });
const loaded = () => screen.findByRole("heading", { level: 1, name: /^Booking [0-9A-Z]{8}$/ });
const badges = (element: Element) =>
  [...element.querySelectorAll(".tg-status")].map((badge) => text(badge));
const history = () => [...card("History").querySelectorAll("ol > li")].map((item) => text(item));

/** The Payment card's blocks under their own headings: Cancellation, then Refund. */
const blocks = () =>
  Object.fromEntries(
    [...card("Payment").querySelectorAll(".bd-refund")].map((block) => [
      text(block.querySelector("h3")),
      block as HTMLElement,
    ]),
  );

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

// The words ------------------------------------------------------------------------------------

describe("bookingStates", () => {
  it("gives a confirmed booking a ready badge and a canceled one a warning badge", () => {
    expect(bookingStates.confirmed).toEqual({ label: "Confirmed", tone: "ready", icon: "check" });
    expect(bookingStates.canceled).toEqual({
      label: "Canceled",
      tone: "warning",
      icon: "x-octagon",
    });
  });

  it("tells the two states apart by label, tone, and icon, with icons the design system draws", () => {
    const copies = Object.values(bookingStates);
    expect(copies).toHaveLength(2);
    for (const field of ["label", "tone", "icon"] as const) {
      expect(new Set(copies.map((c) => c[field])).size, field).toBe(copies.length);
    }
    for (const c of copies) expect(iconNames).toContain(c.icon);
  });
});

describe("cancellationRemedyText", () => {
  const worded = (over: Partial<BookingCancellation>) =>
    cancellationRemedyText({ ...applied, ...over });

  it("words each remedy on the side of the cutoff the cancellation fell", () => {
    expect(worded({ remedy: "full_refund", beforeCutoff: true })).toBe(
      "Before the cutoff: full refund",
    );
    expect(worded({ remedy: "full_refund", beforeCutoff: false })).toBe(
      "After the cutoff: full refund",
    );
    expect(worded({ remedy: "percent_refund", refundBp: 5000, beforeCutoff: true })).toBe(
      "Before the cutoff: 50% refund",
    );
    expect(worded({ remedy: "percent_refund", refundBp: 5000, beforeCutoff: false })).toBe(
      "After the cutoff: 50% refund",
    );
    expect(worded({ remedy: "none", refundBp: 0, beforeCutoff: true })).toBe(
      "Before the cutoff: no refund",
    );
    expect(worded({ remedy: "none", refundBp: 0, beforeCutoff: false })).toBe(
      "After the cutoff: no refund",
    );
  });

  it.each([
    [10_000, "100%"],
    [5000, "50%"],
    [2500, "25%"],
    [1250, "12.5%"],
    [3333, "33.33%"],
    [100, "1%"],
    [1, "0.01%"],
  ])("states a percent refund of %i basis points as %s", (refundBp, percent) => {
    expect(worded({ remedy: "percent_refund", refundBp, beforeCutoff: false })).toBe(
      `After the cutoff: ${percent} refund`,
    );
  });

  it("says no percentage for a full refund or for none, whatever basis points they carry", () => {
    expect(worded({ remedy: "full_refund", refundBp: 10_000 })).not.toContain("%");
    expect(worded({ remedy: "none", refundBp: 0 })).not.toContain("%");
  });
});

describe("who canceled and what the history calls it", () => {
  it.each([
    ["guest", "the guest, online"],
    ["staff", "staff"],
    ["support", "TideGrid support"],
    ["system", "TideGrid"],
  ] as const)("says a cancellation by %s as %s", (by, words) => {
    expect(cancelledByText(by)).toBe(words);
  });

  it("labels the cancellation in the history", () => {
    expect(timelineLabel("canceled")).toBe("Booking canceled");
  });
});

// The console reads it --------------------------------------------------------------------------

describe("reading a canceled booking", () => {
  it("hands back a canceled booking as the API sent it", async () => {
    const booking = canceledBooking();
    const calls = api({ [route.booking(bookingId)]: () => json(bookingBody(booking)) });
    expect(await loadBooking(tenantId, bookingId)).toEqual({ kind: "ok", value: booking });
    expect(calls).toHaveLength(1);
  });

  it.each([
    ["a full refund", canceledBooking()],
    ["a partial refund", canceledBooking({ remedy: "percent_refund", refundBp: 5000 })],
    ["no refund", canceledBooking({ remedy: "none", refundBp: 0, refundAmount: 0 })],
    ["a refund that was made", canceledBooking({}, "succeeded")],
  ])("hands back a booking canceled with %s", async (_what, booking) => {
    api({ [route.booking(bookingId)]: () => json(bookingBody(booking)) });
    expect(await loadBooking(tenantId, bookingId)).toEqual({ kind: "ok", value: booking });
  });
});

// The page --------------------------------------------------------------------------------------

describe("a canceled booking", () => {
  it("shows the Canceled badge in place of Confirmed, beside the refund's own status", async () => {
    api({ [route.booking(bookingId)]: answer("owner", canceledBooking()) });
    const { container } = renderDetail("owner");
    await loaded();
    expect(badges(container.querySelector(".bd-badges") as Element)).toEqual([
      "Canceled",
      "Refund pending",
    ]);
    expect(screen.queryByText("Confirmed")).toBeNull();
  });

  it("says Refunded beside Canceled once the refund was made", async () => {
    api({ [route.booking(bookingId)]: answer("owner", canceledBooking({}, "succeeded")) });
    const { container } = renderDetail("owner");
    await loaded();
    expect(badges(container.querySelector(".bd-badges") as Element)).toEqual([
      "Canceled",
      "Refunded",
    ]);
  });

  it("says Paid beside Canceled when the policy gave nothing back, because no refund was asked for", async () => {
    const none = canceledBooking({ remedy: "none", refundBp: 0, refundAmount: 0 });
    expect(none.refund).toBeNull();
    api({ [route.booking(bookingId)]: answer("owner", none) });
    const { container } = renderDetail("owner");
    await loaded();
    expect(badges(container.querySelector(".bd-badges") as Element)).toEqual(["Canceled", "Paid"]);
  });

  it("says who canceled and when, on the marina's clock, and that the seats went back on sale", async () => {
    api({ [route.booking(bookingId)]: answer("owner", canceledBooking()) });
    const { container } = renderDetail("owner");
    await loaded();
    // 10:30 AM in New York on Mon, Nov 2; the clock changed back the day before.
    expect(text(container.querySelector(".bd-lede"))).toBe(
      "Booked online by the guest. Confirmed Tue, Oct 6, 2:17 PM EDT. Canceled by the guest, online Mon, Nov 2, 10:30 AM EST; the seats went back on sale.",
    );
  });

  it("puts the cancellation after the late-payment note in the lede", async () => {
    api({
      [route.booking(bookingId)]: answer("owner", { ...canceledBooking(), reacquired: true }),
    });
    const { container } = renderDetail("owner");
    await loaded();
    expect(text(container.querySelector(".bd-lede"))).toBe(
      "Booked online by the guest. Confirmed Tue, Oct 6, 2:17 PM EDT. The payment arrived after the checkout's hold ran out, and the seats were still free. Canceled by the guest, online Mon, Nov 2, 10:30 AM EST; the seats went back on sale.",
    );
  });

  it("shows the terms the policy applied: the remedy, the version and cutoff, and the refund due", async () => {
    api({ [route.booking(bookingId)]: answer("owner", canceledBooking()) });
    renderDetail("owner");
    await loaded();
    const { Cancellation: cancellation } = blocks();
    expect(cancellation).toBeTruthy();
    expect(within(cancellation as HTMLElement).getByRole("heading", { level: 3 }).textContent).toBe(
      "Cancellation",
    );
    const facts = terms(cancellation);
    expect(Object.keys(facts)).toEqual(["Canceled", "By", "Policy", "Refund due"]);
    expect(facts.Canceled).toBe("Mon, Nov 2, 10:30 AM EST");
    expect(facts.By).toBe("the guest, online");
    expect(facts["Refund due"]).toBe("$131.09 of $131.09");
    // The remedy in words, then the policy's version and its cutoff on the marina's clock.
    const policy = cancellation?.querySelector("dd .bd-block");
    expect(text(policy)).toBe("Version 3, cutoff Tue, Nov 3, 6:00 PM EST");
    expect(policy?.parentElement?.firstChild?.textContent).toBe("Before the cutoff: full refund");
  });

  it.each([
    {
      what: "a full refund before the cutoff",
      over: {},
      remedy: "Before the cutoff: full refund",
      due: "$131.09 of $131.09",
    },
    {
      what: "a half refund after the cutoff, with an odd cent rounded half up",
      over: {
        remedy: "percent_refund",
        refundBp: 5000,
        refundAmount: 6555,
        beforeCutoff: false,
        canceledAt: "2026-11-04T14:00:00.000Z",
      },
      remedy: "After the cutoff: 50% refund",
      due: "$65.55 of $131.09",
    },
    {
      what: "no refund after the cutoff",
      over: {
        remedy: "none",
        refundBp: 0,
        refundAmount: 0,
        beforeCutoff: false,
        canceledAt: "2026-11-04T14:00:00.000Z",
      },
      remedy: "After the cutoff: no refund",
      due: "$0.00 of $131.09",
    },
  ] as const)("words $what in the block", async ({ over, remedy, due }) => {
    api({ [route.booking(bookingId)]: answer("owner", canceledBooking(over)) });
    renderDetail("owner");
    await loaded();
    const { Cancellation: cancellation } = blocks();
    const policy = cancellation?.querySelector("dd .bd-block");
    expect(policy?.parentElement?.firstChild?.textContent).toBe(remedy);
    expect(terms(cancellation)["Refund due"]).toBe(due);
    // The cutoff is the policy's, whichever side of it the guest canceled.
    expect(text(policy)).toBe("Version 3, cutoff Tue, Nov 3, 6:00 PM EST");
  });

  it("shows the refund the cancellation asked for in its own block, after the cancellation's", async () => {
    api({ [route.booking(bookingId)]: answer("owner", canceledBooking()) });
    renderDetail("owner");
    await loaded();
    expect(Object.keys(blocks())).toEqual(["Cancellation", "Refund"]);
    expect(terms(blocks().Refund)).toEqual({
      Status: "Refund pending",
      Amount: "$131.09",
      Requested: "Mon, Nov 2, 10:30 AM EST",
    });
  });

  it("shows no refund block when nothing was refunded", async () => {
    const none = canceledBooking({ remedy: "none", refundBp: 0, refundAmount: 0 });
    api({ [route.booking(bookingId)]: answer("owner", none) });
    renderDetail("owner");
    await loaded();
    expect(Object.keys(blocks())).toEqual(["Cancellation"]);
    expect(screen.queryByRole("heading", { name: "Refund" })).toBeNull();
  });

  it("lists Booking canceled in the history, between the confirmation and the refund", async () => {
    api({ [route.booking(bookingId)]: answer("owner", canceledBooking({}, "succeeded")) });
    renderDetail("owner");
    await loaded();
    expect(history()).toEqual([
      "Checkout opened, Tue, Oct 6, 2:05 PM EDT",
      "Payment received, Tue, Oct 6, 2:16 PM EDT",
      "Booking confirmed, Tue, Oct 6, 2:17 PM EDT",
      "Booking canceled, Mon, Nov 2, 10:30 AM EST",
      "Refund requested, Mon, Nov 2, 10:30 AM EST",
      "Refunded, Mon, Nov 2, 10:32 AM EST",
    ]);
  });

  it.each([
    ["guest", "the guest, online"],
    ["staff", "staff"],
    ["support", "TideGrid support"],
    ["system", "TideGrid"],
  ] as const)("says a cancellation by %s in the lede and the block", async (by, words) => {
    api({ [route.booking(bookingId)]: answer("owner", canceledBooking({ by })) });
    const { container } = renderDetail("owner");
    await loaded();
    expect(text(container.querySelector(".bd-lede"))).toContain(
      `Canceled by ${words} Mon, Nov 2, 10:30 AM EST; the seats went back on sale.`,
    );
    expect(terms(blocks().Cancellation).By).toBe(words);
  });

  it("shows finance the cancellation and the refund, with no part of the guest", async () => {
    api({ [route.booking(bookingId)]: answer("finance", canceledBooking({}, "succeeded")) });
    const { container } = renderDetail("finance");
    await loaded();
    expect(badges(container.querySelector(".bd-badges") as Element)).toEqual([
      "Canceled",
      "Refunded",
    ]);
    expect(terms(blocks().Cancellation)["Refund due"]).toBe("$131.09 of $131.09");
    expect(history()).toContain("Booking canceled, Mon, Nov 2, 10:30 AM EST");
    const page = `${container.innerHTML} ${container.textContent}`.toLowerCase();
    expect(bookerFragmentsIn(page)).toEqual([]);
  });

  it("says nothing of a cancellation for a booking that is confirmed", async () => {
    api({ [route.booking(bookingId)]: answer("owner", bookingDetail()) });
    const { container } = renderDetail("owner");
    await loaded();
    expect(badges(container.querySelector(".bd-badges") as Element)).toEqual(["Confirmed", "Paid"]);
    expect(blocks()).toEqual({});
    expect(container.textContent).not.toContain("went back on sale");
    expect(history().join(" ")).not.toContain("Booking canceled");
  });
});
