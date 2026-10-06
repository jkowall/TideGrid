// Staff in Tokyo looking at a New York marina: instants must read on the marina's clock.
process.env.TZ = "Asia/Tokyo";

import type {
  BookingDetail,
  BookingOrderLine,
  BookingPaymentStatus,
  FinalizationException,
  StaffTrip,
} from "@tidegrid/contracts";
import { iconNames } from "@tidegrid/design-system/components";
import { formatMoney } from "@tidegrid/design-system/format";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { capacityParts, capacityText } from "../calendar/model.ts";
import { call, errorCode, failureOf, tenantPath } from "../http.ts";
import { canSeeGuests, roleNames } from "../roles.ts";
import { findReference, loadBooking, loadDay, loadExceptions, loadRoster } from "./api.ts";
import {
  bookingDetail,
  bookingIds,
  dayBody,
  finalizationException,
  luisBooking,
  marinaZone,
  mayaBooking,
  orderLines,
  orderTotals,
  priyaBooking,
  tripIds,
  tripRoster,
} from "./fixtures.ts";
import {
  bookingHref,
  bookingsHref,
  clampDay,
  countText,
  dayBounds,
  dayText,
  exceptionRefund,
  exceptionTitle,
  extrasText,
  guestsText,
  instantText,
  isUuid,
  orderRows,
  partyDetail,
  paymentCopy,
  providerName,
  readDay,
  readTrip,
  rosterHref,
  spokenReference,
  timelineLabel,
} from "./model.ts";

/** U+00A0, which the format module puts between a time and AM or PM, and before a zone's name. */
const nbsp = String.fromCharCode(0x00a0);
const today = "2026-10-06";
const trip = tripIds.sunset;
const bookingIdsMaya = bookingIds.maya;

describe("ids", () => {
  it("accepts a UUID in either case and nothing else", () => {
    expect(isUuid(trip)).toBe(true);
    expect(isUuid(trip.toUpperCase())).toBe(true);
    for (const bad of [
      "",
      "not-a-uuid",
      `${trip}x`,
      ` ${trip}`,
      `${trip}\n`,
      trip.replaceAll("-", ""),
    ]) {
      expect(isUuid(bad), JSON.stringify(bad)).toBe(false);
    }
  });
});

describe("the day an address names", () => {
  it("reads ?day= from the address", () => {
    expect(readDay("?day=2026-11-04", today)).toBe("2026-11-04");
    expect(readDay("day=2026-11-04", today)).toBe("2026-11-04");
    expect(readDay(`?trip=${trip}&day=2026-11-04`, today)).toBe("2026-11-04");
  });

  it("keeps a day within two years either side of today", () => {
    expect(dayBounds(today)).toEqual({ first: "2024-10-06", last: "2028-10-05" });
    // The edges are reachable; one day past either is not.
    expect(readDay("?day=2028-10-05", today)).toBe("2028-10-05");
    expect(readDay("?day=2028-10-06", today)).toBe("2028-10-05");
    expect(readDay("?day=2024-10-06", today)).toBe("2024-10-06");
    expect(readDay("?day=2024-10-05", today)).toBe("2024-10-06");
    expect(readDay("?day=9999-12-31", today)).toBe("2028-10-05");
    expect(readDay("?day=0001-01-01", today)).toBe("2024-10-06");
    expect(clampDay("2099-01-01", today)).toBe("2028-10-05");
    expect(clampDay("2026-10-06", today)).toBe("2026-10-06");
  });

  it("falls back to today when the day is missing or is not a real date", () => {
    const unreadable = [
      "",
      "?",
      "?day=",
      "?day=nonsense",
      "?day=2026-02-30",
      "?day=2026-13-01",
      "?day=26-11-04",
      "?day=2026-11-4",
      "?day=2026-11-04T10:00",
      "?day=%20",
      `?trip=${trip}`,
    ];
    for (const search of unreadable) {
      expect(readDay(search, today), search).toBe(today);
    }
  });
});

describe("the trip an address names", () => {
  it("accepts a UUID, lowercased", () => {
    expect(readTrip(`?trip=${trip}`)).toBe(trip);
    expect(readTrip(`?day=2026-11-04&trip=${trip}`)).toBe(trip);
    expect(readTrip(`?trip=${trip.toUpperCase()}`)).toBe(trip);
  });

  it("accepts nothing that is not a UUID", () => {
    const unreadable = [
      "",
      "?trip=",
      "?trip=abc",
      `?trip=${trip}x`,
      `?trip=${trip.slice(1)}`,
      `?trip=%20${trip}`,
      `?trip=${trip}%0A`,
      "?trip=../../etc/passwd",
      "?trip=1;drop table trips",
      "?day=2026-11-04",
    ];
    for (const search of unreadable) {
      expect(readTrip(search), search).toBeUndefined();
    }
  });
});

describe("addresses", () => {
  it("builds the list's address from a day and, optionally, a trip", () => {
    expect(bookingsHref("2026-11-04")).toBe("/bookings?day=2026-11-04");
    expect(bookingsHref("2026-11-04", trip)).toBe(`/bookings?day=2026-11-04&trip=${trip}`);
    expect(bookingsHref("2026-11-04", undefined)).toBe("/bookings?day=2026-11-04");
  });

  it("reads back what it builds", () => {
    const search = bookingsHref("2026-11-04", trip).slice("/bookings".length);
    expect(readDay(search, today)).toBe("2026-11-04");
    expect(readTrip(search)).toBe(trip);
  });

  it("builds a booking's and a roster's address from the id alone", () => {
    expect(bookingHref(mayaBooking.id)).toBe(`/bookings/${mayaBooking.id}`);
    expect(rosterHref(trip)).toBe(`/trips/${trip}/roster`);
    // An id cannot change the path it sits in.
    expect(bookingHref("a/b?c#d")).toBe("/bookings/a%2Fb%3Fc%23d");
    expect(rosterHref("a/../b")).toBe("/trips/a%2F..%2Fb/roster");
  });
});

describe("parties and extras", () => {
  it("counts guests in the singular for one", () => {
    expect(guestsText(1)).toBe("1 guest");
    expect(guestsText(2)).toBe("2 guests");
    expect(guestsText(0)).toBe("0 guests");
  });

  it("names a ticket party by its counts, in the order sold, and a charter as sold", () => {
    // A count is held to what it counts, and a range stays whole, wherever a line breaks.
    expect(partyDetail(mayaBooking.party)).toBe(
      `2${nbsp}Adult, 1${nbsp}Child (3${nbsp}to${nbsp}12)`,
    );
    expect(
      partyDetail({
        kind: "tickets",
        guests: 1,
        tickets: [{ code: "a", name: "Adult", quantity: 1 }],
      }),
    ).toBe(`1${nbsp}Adult`);
    expect(partyDetail(priyaBooking.party)).toBe("Whole boat, up to 12 guests");
  });

  it("keeps a count with its name and a bracketed range whole, and nothing else", () => {
    expect(countText(2, "Snorkel set rental")).toBe(`2${nbsp}Snorkel set rental`);
    expect(countText(1, "Child (5 to 12)")).toBe(`1${nbsp}Child (5${nbsp}to${nbsp}12)`);
    expect(countText(3, "Seat (upper deck) (no view)")).toBe(
      `3${nbsp}Seat (upper${nbsp}deck) (no${nbsp}view)`,
    );
  });

  it("lists extras with their quantities, or says None", () => {
    expect(extrasText([])).toBe("None");
    expect(extrasText(mayaBooking.extras)).toBe(`1${nbsp}Souvenir photo`);
    expect(extrasText(luisBooking.extras)).toBe(`1${nbsp}Souvenir photo, 2${nbsp}Drink voucher`);
  });
});

describe("a payment in words", () => {
  const refund = (state: "requested" | "succeeded" | "failed") => ({ state, amount: 13109 });
  const cases: Array<[string, BookingPaymentStatus, string, string, string]> = [
    ["paid", { state: "succeeded", refund: null }, "Paid", "ready", "credit-card"],
    [
      "a refund pending",
      { state: "succeeded", refund: refund("requested") },
      "Refund pending",
      "pending",
      "clock",
    ],
    [
      "a refund made",
      { state: "succeeded", refund: refund("succeeded") },
      "Refunded",
      "info",
      "receipt",
    ],
    [
      "a refund failed",
      { state: "succeeded", refund: refund("failed") },
      "Refund failed",
      "blocked",
      "receipt",
    ],
    [
      "awaiting payment",
      { state: "pending", refund: null },
      "Awaiting payment",
      "pending",
      "hourglass",
    ],
    [
      "a payment that failed",
      { state: "failed", refund: null },
      "Payment failed",
      "blocked",
      "x-octagon",
    ],
  ];

  it.each(cases)("reads %s", (_what, payment, label, tone, icon) => {
    expect(paymentCopy(payment)).toEqual({ label, tone, icon });
  });

  it("says what happened to a refund before it says what happened to the charge", () => {
    expect(paymentCopy({ state: "pending", refund: refund("requested") }).label).toBe(
      "Refund pending",
    );
    expect(paymentCopy({ state: "failed", refund: refund("succeeded") }).label).toBe("Refunded");
  });

  it("gives each state its own label, and an icon the design system draws", () => {
    const copies = cases.map(([, payment]) => paymentCopy(payment));
    expect(new Set(copies.map((c) => c.label)).size).toBe(copies.length);
    for (const c of copies) expect(iconNames).toContain(c.icon);
  });

  // A failed charge and a failed refund are both "blocked"; the refund keeps the receipt, so
  // the two differ in icon as well as words.
  it("gives each state its own tone and icon pair, not only its own label", () => {
    const pairs = cases.map(([, payment]) => {
      const c = paymentCopy(payment);
      return `${c.tone}/${c.icon}`;
    });
    expect(new Set(pairs).size).toBe(pairs.length);
  });

  it("names the payment provider as the guest's test or real payment", () => {
    expect(providerName("fake")).toBe("Test payment (demo provider)");
    expect(providerName("stripe")).toBe("Stripe");
  });

  it("says a masked provider reference without its bullets", () => {
    expect(spokenReference("fpay_••••hGvm")).toBe("fpay, ending in hGvm");
    expect(spokenReference("pi_••••9zXy")).toBe("pi, ending in 9zXy");
    expect(spokenReference("fpay_••••")).toBe("fpay, the rest hidden");
    expect(spokenReference("••••a1B2")).toBe("ending in a1B2");
    expect(spokenReference("••••")).toBe("the rest hidden");
    // Anything not masked is said as it is.
    expect(spokenReference("Not recorded")).toBe("Not recorded");
  });
});

describe("days in words", () => {
  it("names the year only when it is not this year at the marina", () => {
    expect(dayText("2026-11-04", "full", "2026-11-04")).toBe("Wednesday, November 4");
    expect(dayText("2026-01-01", "medium", "2026-12-31")).toBe("Thu, Jan 1");
    expect(dayText("2027-10-06", "full", "2026-11-04")).toBe("Wednesday, October 6, 2027");
    expect(dayText("2025-12-31", "medium", "2026-01-01")).toBe("Wed, Dec 31, 2025");
  });
});

describe("instants on the marina's clock", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-11-04T17:00:00Z"));
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("names the year of an instant in another year there", () => {
    expect(instantText("2025-12-31T23:30:00.000Z", marinaZone)).toBe(
      `Wed, Dec 31, 2025, 6:30${nbsp}PM${nbsp}EST`,
    );
    // Already January 1, 2026 in Tokyo, but still December 31, 2025 at the marina.
    expect(instantText("2026-01-01T04:30:00.000Z", marinaZone)).toBe(
      `Wed, Dec 31, 2025, 11:30${nbsp}PM${nbsp}EST`,
    );
    expect(instantText("2026-01-01T05:30:00.000Z", marinaZone)).toBe(
      `Thu, Jan 1, 12:30${nbsp}AM${nbsp}EST`,
    );
  });

  it("names the zone and reads the marina's clock, not the viewer's", () => {
    expect(instantText("2026-10-06T12:17:00.000Z", marinaZone)).toBe(
      `Tue, Oct 6, 8:17${nbsp}AM${nbsp}EDT`,
    );
    // The premise: this process is in Tokyo, where the next instant is already Oct 7.
    expect(new Date("2026-10-06T18:17:00.000Z").getDate()).toBe(7);
    expect(instantText("2026-10-06T18:17:00.000Z", marinaZone)).toBe(
      `Tue, Oct 6, 2:17${nbsp}PM${nbsp}EDT`,
    );
  });

  it("tells the same wall-clock time apart on the night clocks go back", () => {
    expect(instantText("2026-11-01T05:30:00.000Z", marinaZone)).toBe(
      `Sun, Nov 1, 1:30${nbsp}AM${nbsp}EDT`,
    );
    expect(instantText("2026-11-01T06:30:00.000Z", marinaZone)).toBe(
      `Sun, Nov 1, 1:30${nbsp}AM${nbsp}EST`,
    );
  });

  it("uses the zone it is given, whichever that is", () => {
    expect(instantText("2026-11-04T17:30:00.000Z", "Pacific/Honolulu")).toBe(
      `Wed, Nov 4, 7:30${nbsp}AM${nbsp}HST`,
    );
    expect(instantText("2026-11-04T17:30:00.000Z", "UTC")).toMatch(
      new RegExp(`^Wed, Nov 4, 5:30${nbsp}PM${nbsp}UTC$`),
    );
  });
});

describe("the history", () => {
  it("labels each kind of event", () => {
    expect(
      (
        [
          "checkout_opened",
          "paid",
          "confirmed",
          "refund_requested",
          "refunded",
          "refund_failed",
        ] as const
      ).map(timelineLabel),
    ).toEqual([
      "Checkout opened",
      "Payment received",
      "Booking confirmed",
      "Refund requested",
      "Refunded",
      "Refund failed",
    ]);
  });
});

describe("the order as ledger rows", () => {
  const order = (
    lines: BookingOrderLine[] = orderLines,
    totals: BookingDetail["order"]["totals"] = orderTotals,
  ): BookingDetail["order"] => ({
    id: "8f2d4c6e-1a3b-4c5d-9e7f-0a1b2c3d4e5f",
    status: "paid",
    currency: "USD",
    lines,
    totals,
  });
  const summary = (rows: ReturnType<typeof orderRows>) =>
    rows.map((r) => [r.id, r.kind ?? "item", r.label, r.detail ?? null, r.amount]);

  it("puts the trip price and extras, the subtotal, the discount, fees, added taxes, the total, then included tax", () => {
    // The API sends fees before the discount; the rows follow the order's own totals.
    expect(summary(orderRows(order()))).toEqual([
      ["line-1", "item", "Adult", "2 × $45.00", "$90.00"],
      ["line-2", "item", "Child (3 to 12)", "1 × $25.00", "$25.00"],
      ["line-3", "item", "Souvenir photo", "1 × $12.00", "$12.00"],
      ["subtotal", "subtotal", "Subtotal", null, "$127.00"],
      ["line-5", "adjustment", "HARBOR10, 10% off", "On the trip price, not extras", "−$11.50"],
      ["line-4", "item", "Harbor fee", "3 × $2.50", "$7.50"],
      ["line-6", "item", "State sales tax (6%)", null, "$6.93"],
      ["line-7", "item", "County surtax (1%)", null, "$1.16"],
      ["total", "total", "Total", null, "$131.09"],
      ["line-8", "note", "Includes Harbor levy (4.712%)", null, "$5.42"],
    ]);
  });

  it("keeps rows in order whatever order the lines arrive in", () => {
    const shuffled = [...orderLines].reverse();
    const ids = orderRows(order(shuffled)).map((r) => r.id);
    // Within a kind the API's order holds; the groups are the ledger's own.
    expect(ids).toEqual([
      "line-2",
      "line-1",
      "line-3",
      "subtotal",
      "line-5",
      "line-4",
      "line-7",
      "line-6",
      "total",
      "line-8",
    ]);
  });

  it("formats every amount from the order's own cents and adds nothing up", () => {
    // Numbers that do not add up on purpose: whatever the order says, the rows say.
    const odd = {
      subtotal: 111,
      discount: 222,
      fees: 333,
      tax: 444,
      includedTax: 555,
      total: 99999999,
    };
    const rows = orderRows(order(orderLines, odd));
    const byId = new Map(rows.map((r) => [r.id, r.amount]));
    expect(byId.get("subtotal")).toBe(formatMoney(111));
    expect(byId.get("total")).toBe("$999,999.99");
    for (const l of orderLines) {
      expect(byId.get(`line-${l.lineNo}`), l.name).toBe(formatMoney(l.amount));
    }
    // Its discount, fees, tax, and included tax totals are never shown or summed.
    const shown = rows.map((r) => r.amount).join(" ");
    for (const unused of [222, 333, 444, 555]) expect(shown).not.toContain(formatMoney(unused));
  });

  it("names a free line and leaves a charter's single line without a quantity", () => {
    const lines: BookingOrderLine[] = [
      {
        lineNo: 1,
        kind: "service",
        code: "charter",
        name: "Whole boat, up to 12 guests",
        basis: null,
        quantity: 1,
        unitAmount: 120000,
        amount: 120000,
        taxInclusive: null,
        taxRatePpm: null,
      },
      {
        lineNo: 2,
        kind: "service",
        code: "infant",
        name: "Infant (under 3)",
        basis: null,
        quantity: 2,
        unitAmount: 0,
        amount: 0,
        taxInclusive: null,
        taxRatePpm: null,
      },
    ];
    const rows = orderRows(order(lines, { ...orderTotals, subtotal: 120000, total: 120000 }));
    expect(summary(rows).slice(0, 2)).toEqual([
      ["line-1", "item", "Whole boat, up to 12 guests", null, "$1,200.00"],
      ["line-2", "item", "Infant (under 3)", "2 at no charge", "$0.00"],
    ]);
    // A charter row has no `detail` key at all, not an empty one.
    expect("detail" in (rows[0] ?? {})).toBe(false);
  });

  it("names a tax without a rate by its name alone, and shows no tax rows when there are none", () => {
    const noRate: BookingOrderLine = {
      ...(orderLines[5] as BookingOrderLine),
      taxRatePpm: null,
    };
    const labels = orderRows(order([noRate])).map((r) => r.label);
    expect(labels).toEqual(["Subtotal", "State sales tax", "Total"]);
    const withoutTaxes = orderLines.filter((l) => l.kind !== "tax");
    expect(orderRows(order(withoutTaxes)).map((r) => r.id)).toEqual([
      "line-1",
      "line-2",
      "line-3",
      "subtotal",
      "line-5",
      "line-4",
      "total",
    ]);
  });

  it("shows an included tax as a note after the total, with its rate", () => {
    const rows = orderRows(order());
    const total = rows.findIndex((r) => r.id === "total");
    const note = rows.findIndex((r) => r.kind === "note");
    expect(note).toBeGreaterThan(total);
    expect(rows[note]).toMatchObject({ label: "Includes Harbor levy (4.712%)", amount: "$5.42" });
    // Added taxes come before the total, and are rows of the sum.
    expect(rows.findIndex((r) => r.id === "line-6")).toBeLessThan(total);
  });
});

describe("what happened to a payment that could not become a booking", () => {
  it("titles each reason in the operator's words", () => {
    const titles: Record<FinalizationException["reason"], string> = {
      no_capacity: "Paid after the checkout ran out of time, and the seats were gone",
      trip_canceled: "Paid after the trip was canceled",
      trip_unavailable: "Paid after the trip stopped taking bookings",
      sales_closed: "Paid after sales closed for the trip",
      party_size_out_of_range: "Paid for a party the trip no longer takes",
      session_failed: "Paid after the payment provider had reported the payment failed",
      session_canceled: "Paid after the guest canceled the checkout",
      payment_mismatch: "A payment that didn't match its checkout",
    };
    for (const [reason, title] of Object.entries(titles)) {
      expect(exceptionTitle(reason as FinalizationException["reason"]), reason).toBe(title);
    }
    expect(new Set(Object.values(titles)).size).toBe(8);
  });

  const refund = (
    state: "requested" | "succeeded" | "failed",
    failureCode: string | null = null,
  ): NonNullable<FinalizationException["refund"]> => ({
    id: "7f8091a2-3c4d-4e5f-8a61-7c8d9e0f1a01",
    state,
    amount: 13109,
    failureCode,
    settledAt: null,
  });

  it("says a refund was made, with its amount", () => {
    expect(exceptionRefund({ reason: "no_capacity", refund: refund("succeeded") })).toEqual({
      label: "Refunded",
      tone: "info",
      icon: "receipt",
      detail: "$131.09 was refunded in full to the guest's payment method.",
    });
  });

  it("says a refund is on its way, and that TideGrid keeps trying", () => {
    expect(exceptionRefund({ reason: "trip_canceled", refund: refund("requested") })).toEqual({
      label: "Refund pending",
      tone: "pending",
      icon: "clock",
      detail:
        "A full refund of $131.09 is on its way. TideGrid retries it until the provider answers.",
    });
  });

  it("says a refund failed, with the provider's code in words when it gave one", () => {
    expect(
      exceptionRefund({
        reason: "session_failed",
        refund: refund("failed", "charge_already_refunded"),
      }),
    ).toEqual({
      label: "Refund failed",
      tone: "blocked",
      icon: "receipt",
      detail:
        "The provider refused the $131.09 refund (charge already refunded). Refund the guest another way, or contact the provider.",
    });
    expect(exceptionRefund({ reason: "session_failed", refund: refund("failed") }).detail).toBe(
      "The provider refused the $131.09 refund. Refund the guest another way, or contact the provider.",
    );
  });

  it("says nothing was refunded for a payment that did not match, and what to do", () => {
    expect(exceptionRefund({ reason: "payment_mismatch", refund: null })).toEqual({
      label: "Not refunded",
      tone: "warning",
      icon: "alert-triangle",
      detail:
        "Nothing was refunded automatically. Check this payment with the payment provider before you act.",
    });
  });

  it("gives each refund state its own label, tone, and icon", () => {
    const copies = [
      exceptionRefund({ reason: "no_capacity", refund: refund("succeeded") }),
      exceptionRefund({ reason: "no_capacity", refund: refund("requested") }),
      exceptionRefund({ reason: "no_capacity", refund: refund("failed") }),
      exceptionRefund({ reason: "payment_mismatch", refund: null }),
    ];
    for (const key of ["label", "tone"] as const) {
      expect(new Set(copies.map((c) => c[key])).size, key).toBe(copies.length);
    }
    // A refund's states can share the receipt; the tone tells them apart.
    expect(new Set(copies.map((c) => `${c.tone}/${c.icon}`)).size).toBe(copies.length);
  });
});

describe("seats and the booked count the calendar links", () => {
  const seats = (
    capacity: Partial<StaffTrip["capacity"]>,
    salesState: StaffTrip["salesState"],
  ) => ({
    salesState,
    capacity: { kind: "seats" as const, total: 20, remaining: 20, ...capacity },
  });
  const boat = (capacity: Partial<StaffTrip["capacity"]>, salesState: StaffTrip["salesState"]) => ({
    salesState,
    capacity: { kind: "whole_boat" as const, total: 12, remaining: 12, ...capacity },
  });

  it("splits a seat count around what is booked", () => {
    expect(
      capacityParts(seats({ remaining: 15, held: 2, confirmed: 3 }, "published"), false),
    ).toEqual({
      before: "15 of 20 seats left: ",
      booked: "3 booked",
      after: ", 2 held",
    });
    expect(
      capacityParts(seats({ remaining: 17, held: 0, confirmed: 3 }, "published"), false),
    ).toEqual({
      before: "17 of 20 seats left: ",
      booked: "3 booked",
      after: "",
    });
  });

  it("splits a departed or final trip's size around what was booked, and drops its holds", () => {
    const expected = { before: "20 seats: ", booked: "3 booked", after: "" };
    expect(
      capacityParts(seats({ remaining: 15, held: 2, confirmed: 3 }, "published"), true),
    ).toEqual(expected);
    expect(
      capacityParts(seats({ remaining: 15, held: 2, confirmed: 3 }, "canceled"), false),
    ).toEqual(expected);
    expect(
      capacityParts(seats({ remaining: 15, held: 2, confirmed: 3 }, "completed"), false),
    ).toEqual(expected);
    expect(
      capacityParts(seats({ total: 1, remaining: 0, confirmed: 1 }, "completed"), false),
    ).toEqual({
      before: "1 seat: ",
      booked: "1 booked",
      after: "",
    });
  });

  it("splits a booked whole boat before its last word", () => {
    expect(
      capacityParts(boat({ remaining: 0, confirmed: 12, held: 0 }, "published"), false),
    ).toEqual({
      before: "Whole boat, ",
      booked: "booked",
      after: "",
    });
  });

  it("has no booked part, so no link, when nothing is booked", () => {
    for (const trip of [
      seats({ remaining: 18, held: 2, confirmed: 0 }, "published"),
      seats({ remaining: 20 }, "published"),
      seats({ remaining: 20, confirmed: 0 }, "completed"),
      boat({ remaining: 0, held: 12, confirmed: 0 }, "published"),
      boat({ remaining: 12 }, "published"),
    ]) {
      const parts = capacityParts(trip, false);
      expect(parts.booked).toBeNull();
      expect(parts.after).toBe("");
      expect(parts.before).toBe(capacityText(trip, false));
    }
  });

  it("reassembles to exactly the calendar's text in every case", () => {
    const states: StaffTrip["salesState"][] = [
      "draft",
      "published",
      "closed",
      "canceled",
      "completed",
    ];
    let checked = 0;
    let withBooked = 0;
    for (const kind of ["seats", "whole_boat"] as const) {
      for (const salesState of states) {
        for (const departed of [false, true]) {
          for (const held of [undefined, 0, 2]) {
            for (const confirmed of [undefined, 0, 1, 3]) {
              for (const remaining of kind === "seats" ? [0, 5, 20] : [0, 12]) {
                const total = kind === "seats" ? 20 : 12;
                const capacity: StaffTrip["capacity"] = {
                  kind,
                  total,
                  remaining,
                  ...(held === undefined ? {} : { held }),
                  ...(confirmed === undefined ? {} : { confirmed }),
                };
                const trip = { salesState, capacity };
                const parts = capacityParts(trip, departed);
                const label = JSON.stringify({
                  kind,
                  salesState,
                  departed,
                  held,
                  confirmed,
                  remaining,
                });
                expect(parts.before + (parts.booked ?? "") + parts.after, label).toBe(
                  capacityText(trip, departed),
                );
                // A link exists exactly when something is booked.
                expect(parts.booked === null, label).toBe((confirmed ?? 0) === 0);
                if (parts.booked !== null) {
                  withBooked += 1;
                  expect(parts.booked, label).toBe(
                    kind === "seats" ? `${confirmed} booked` : "booked",
                  );
                }
                checked += 1;
              }
            }
          }
        }
      }
    }
    // The grid is real: both kinds, both ends of every flag.
    // Five sales states, two departed flags, three holds, four confirmed counts, and five
    // remaining counts across both kinds.
    expect(checked).toBe(5 * 2 * 3 * 4 * (3 + 2));
    expect(withBooked).toBeGreaterThan(100);
  });
});

describe("who sees guests", () => {
  it("lets owners and booking staff see them, and not finance", () => {
    expect(canSeeGuests("owner")).toBe(true);
    expect(canSeeGuests("booking_staff")).toBe(true);
    expect(canSeeGuests("finance")).toBe(false);
  });

  it("names each role as a noun in a sentence", () => {
    expect(roleNames).toEqual({
      owner: "owner",
      booking_staff: "booking staff",
      finance: "finance",
    });
  });
});

describe("how a failed answer reads", () => {
  const answer = (status: number, code?: string) =>
    new Response(code ? JSON.stringify({ error: { code, message: "x", requestId: "r" } }) : null, {
      status,
    });

  it.each([
    [401, undefined, "signed_out"],
    [403, "tenant_suspended", "suspended"],
    [403, "forbidden", "forbidden"],
    [403, undefined, "forbidden"],
    [404, undefined, "not_found"],
    [400, "validation_failed", "rejected"],
    [409, "conflict", "unavailable"],
    [429, undefined, "unavailable"],
    [500, "internal_error", "unavailable"],
    [502, undefined, "unavailable"],
    [503, undefined, "unavailable"],
  ] as const)("reads a %i %s as %s", async (status, code, reason) => {
    expect(await failureOf(answer(status, code))).toBe(reason);
  });

  it("reads an error code only from a body that has one", async () => {
    expect(await errorCode(answer(403, "tenant_suspended"))).toBe("tenant_suspended");
    expect(await errorCode(new Response("<html>", { status: 403 }))).toBeUndefined();
    expect(await errorCode(new Response(JSON.stringify({ error: { code: 7 } })))).toBeUndefined();
    expect(await errorCode(new Response(JSON.stringify({})))).toBeUndefined();
  });

  it("writes an operator's path with its id encoded", () => {
    expect(tenantPath(tripIds.sunset)).toBe(`/api/v1/staff/tenants/${tripIds.sunset}`);
    expect(tenantPath("a/b?c")).toBe("/api/v1/staff/tenants/a%2Fb%3Fc");
  });
});

describe("a call", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  /** A fetch that never answers, and fails the way a browser's does when its signal aborts. */
  function silentFetch() {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        (_path: string, init: RequestInit) =>
          new Promise<Response>((_resolve, reject) => {
            const abort = () =>
              reject(new DOMException("The operation was aborted.", "AbortError"));
            if (init.signal?.aborted) abort();
            else init.signal?.addEventListener("abort", abort);
          }),
      ),
    );
  }

  it("is same-origin, and returns the answer", async () => {
    const fetched = vi.fn(async () => new Response("{}"));
    vi.stubGlobal("fetch", fetched);
    const res = await call("/api/v1/me", { headers: { accept: "application/json" } });
    expect(res.ok).toBe(true);
    const [path, init] = fetched.mock.calls[0] as unknown as [string, RequestInit];
    expect(path).toBe("/api/v1/me");
    expect(init.credentials).toBe("same-origin");
    expect(init.headers).toEqual({ accept: "application/json" });
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });

  it("gives up after 15 seconds", async () => {
    vi.useFakeTimers();
    silentFetch();
    const pending = call("/slow", {});
    const outcome = pending.then(
      () => "answered",
      (error: Error) => error.name,
    );
    await vi.advanceTimersByTimeAsync(14_999);
    expect(vi.getTimerCount()).toBe(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(await outcome).toBe("AbortError");
    expect(vi.getTimerCount()).toBe(0);
  });

  it("leaves no timer behind once it has an answer", async () => {
    vi.useFakeTimers();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("{}")),
    );
    await call("/quick", {});
    expect(vi.getTimerCount()).toBe(0);
  });

  it("gives up when the caller's signal aborts, or already has", async () => {
    silentFetch();
    const controller = new AbortController();
    const pending = call("/page", {}, controller.signal);
    const outcome = pending.then(
      () => "answered",
      (error: Error) => error.name,
    );
    controller.abort();
    expect(await outcome).toBe("AbortError");
    // A signal that has already aborted never starts a request that can finish.
    const gone = await call("/gone", {}, AbortSignal.abort()).then(
      () => "answered",
      (error: Error) => error.name,
    );
    expect(gone).toBe("AbortError");
  });
});

describe("the booking views' reads", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  const tenant = "7d1e5b3a-1c2f-4a8e-9b61-0a1c2e3f4a01";
  const reply = (status: number, body: unknown) => () =>
    Promise.resolve(new Response(JSON.stringify(body), { status }));
  /** Stub fetch with one answer, and return what it was asked. */
  function ask(answer: () => Promise<Response>) {
    const fetched = vi.fn((_path: string, _init: RequestInit) => answer());
    vi.stubGlobal("fetch", fetched);
    return () => {
      const [path, init] = fetched.mock.calls.at(-1) as [string, RequestInit];
      return { path, init };
    };
  }

  it("builds each request from ids and dates alone, and asks for JSON", async () => {
    const asked = ask(reply(404, {}));
    await loadDay(tenant, { date: "2026-11-04" });
    expect(asked().path).toBe(`/api/v1/staff/tenants/${tenant}/bookings?date=2026-11-04`);
    expect(asked().init.headers).toEqual({ accept: "application/json" });
    await loadDay(tenant, { date: "2026-11-04", tripId: tripIds.sunset, after: bookingIdsMaya });
    expect(asked().path).toBe(
      `/api/v1/staff/tenants/${tenant}/bookings?date=2026-11-04&tripId=${tripIds.sunset}&after=${bookingIdsMaya}`,
    );
    await loadBooking(tenant, bookingIdsMaya);
    expect(asked().path).toBe(`/api/v1/staff/tenants/${tenant}/bookings/${bookingIdsMaya}`);
    await loadRoster(tenant, tripIds.sunset);
    expect(asked().path).toBe(`/api/v1/staff/tenants/${tenant}/trips/${tripIds.sunset}/roster`);
    await loadExceptions(tenant, {});
    expect(asked().path).toBe(`/api/v1/staff/tenants/${tenant}/finalization-exceptions?limit=50`);
    await loadExceptions(tenant, { before: bookingIdsMaya });
    expect(asked().path).toBe(
      `/api/v1/staff/tenants/${tenant}/finalization-exceptions?limit=50&before=${bookingIdsMaya}`,
    );
    await findReference(tenant, "QKG6ERBF");
    expect(asked().path).toBe(`/api/v1/staff/tenants/${tenant}/booking-references/QKG6ERBF`);
    // Nothing a person typed can change the path it sits in.
    await findReference(tenant, "a/b?c#d");
    expect(asked().path).toBe(`/api/v1/staff/tenants/${tenant}/booking-references/a%2Fb%3Fc%23d`);
    await loadBooking(tenant, "../x");
    expect(asked().path).toBe(`/api/v1/staff/tenants/${tenant}/bookings/..%2Fx`);
  });

  it("leaves empty cursors out of the request", async () => {
    const asked = ask(reply(404, {}));
    await loadDay(tenant, { date: "2026-11-04", tripId: undefined, after: undefined });
    expect(asked().path).toBe(`/api/v1/staff/tenants/${tenant}/bookings?date=2026-11-04`);
    await loadExceptions(tenant, { before: undefined });
    expect(asked().path).toBe(`/api/v1/staff/tenants/${tenant}/finalization-exceptions?limit=50`);
  });

  it("answers with why it could not, and never throws", async () => {
    ask(() => Promise.reject(new TypeError("Failed to fetch")));
    expect(await loadDay(tenant, { date: "2026-11-04" })).toEqual({
      kind: "failed",
      reason: "unreachable",
    });
    expect(await loadBooking(tenant, bookingIdsMaya)).toEqual({
      kind: "failed",
      reason: "unreachable",
    });
    expect(await loadRoster(tenant, tripIds.sunset)).toEqual({
      kind: "failed",
      reason: "unreachable",
    });
    expect(await loadExceptions(tenant, {})).toEqual({ kind: "failed", reason: "unreachable" });
    expect(await findReference(tenant, "QKG6ERBF")).toEqual({
      kind: "failed",
      reason: "unreachable",
    });
  });

  it("calls a request the page itself canceled unavailable, not a lost connection", async () => {
    ask(() => Promise.reject(new DOMException("aborted", "AbortError")));
    const controller = new AbortController();
    controller.abort();
    expect(await loadDay(tenant, { date: "2026-11-04" }, controller.signal)).toEqual({
      kind: "failed",
      reason: "unavailable",
    });
  });

  it.each([
    [401, "signed_out"],
    [403, "forbidden"],
    [404, "not_found"],
    [400, "rejected"],
    [500, "unavailable"],
  ] as const)("reads a %i answer as %s", async (status, reason) => {
    ask(reply(status, { error: { code: "x", message: "x", requestId: "r" } }));
    expect(await loadDay(tenant, { date: "2026-11-04" })).toEqual({ kind: "failed", reason });
  });

  it("reads an answer that is not JSON, or has nothing the screen needs, as unreadable", async () => {
    ask(() => Promise.resolve(new Response("<html>", { status: 200 })));
    expect(await loadDay(tenant, { date: "2026-11-04" })).toEqual({
      kind: "failed",
      reason: "unreadable",
    });
    ask(reply(200, null));
    expect(await loadBooking(tenant, bookingIdsMaya)).toEqual({
      kind: "failed",
      reason: "unreadable",
    });
    ask(reply(200, {}));
    expect(await loadRoster(tenant, tripIds.sunset)).toEqual({
      kind: "failed",
      reason: "unreadable",
    });
    expect(await loadExceptions(tenant, {})).toEqual({ kind: "failed", reason: "unreadable" });
    expect(await findReference(tenant, "QKG6ERBF")).toEqual({
      kind: "failed",
      reason: "unreadable",
    });
  });

  it("hands back what it read, as it was sent", async () => {
    const body = dayBody();
    ask(reply(200, body));
    const read = await loadDay(tenant, { date: "2026-11-04" });
    expect(read).toEqual({
      kind: "ok",
      value: { trips: body.trips, bookings: body.bookings, nextAfter: null },
    });
    ask(reply(200, { booking: bookingDetail() }));
    expect(await loadBooking(tenant, bookingIdsMaya)).toEqual({
      kind: "ok",
      value: bookingDetail(),
    });
    ask(reply(200, { roster: tripRoster() }));
    expect(await loadRoster(tenant, tripIds.sunset)).toEqual({ kind: "ok", value: tripRoster() });
    ask(reply(200, { exceptions: [finalizationException()], nextBefore: null }));
    expect(await loadExceptions(tenant, {})).toEqual({
      kind: "ok",
      value: { exceptions: [finalizationException()], nextBefore: null },
    });
    ask(
      reply(200, {
        booking: { id: bookingIdsMaya, reference: "QKG6ERBF", localDate: "2026-11-04" },
      }),
    );
    expect(await findReference(tenant, "QKG6ERBF")).toEqual({
      kind: "ok",
      value: { id: bookingIdsMaya, reference: "QKG6ERBF", localDate: "2026-11-04" },
    });
  });
});
