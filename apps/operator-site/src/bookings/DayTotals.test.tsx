// @vitest-environment jsdom

// Staff in Tokyo looking at a New York marina: when the totals were read must stay New York's.
process.env.TZ = "Asia/Tokyo";

import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { type ComponentProps, StrictMode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DayTotals } from "./DayTotals.tsx";
import {
  api,
  apiError,
  callsTo,
  csvAnswer,
  csvFileName,
  day,
  dayFigures,
  dayTotalsBody,
  deferred,
  dropped,
  json,
  marinaZone,
  route,
  strayRequests,
  stubDownload,
  tenantId,
  tenantName,
  terms,
  text,
} from "./fixtures.ts";

const nextDay = "2026-11-05";
const exportFailed = "The CSV couldn't be prepared.";

/** The day's totals answer for any date: the busy day's figures, or the ones given. */
const totalsFor =
  (over: Partial<typeof dayFigures> = {}) =>
  (call: { query: URLSearchParams }) =>
    json(dayTotalsBody(call.query.get("date") ?? "", { ...dayFigures, ...over }));

function renderTotals(
  over: Partial<ComponentProps<typeof DayTotals>> = {},
  options: { strict?: boolean } = {},
) {
  const props = { tenantId, tenantName, day, zone: marinaZone, seesGuests: true, ...over };
  const page = <DayTotals {...props} />;
  const view = render(options.strict ? <StrictMode>{page}</StrictMode> : page);
  return {
    ...view,
    /** The same section for another day, as the list moves between days. */
    showDay: (to: string) => view.rerender(<DayTotals {...props} day={to} />),
  };
}

/**
 * The figures, once they are shown. The loading placeholders share the grid's
 * class but are a div, so waiting on the class alone passes while loading.
 */
const grid = () => document.querySelector("dl.bk-totals__grid");
const figures = () => terms(grid());
const note = () => text(document.querySelector(".bk-totals__note"));
const exportButton = () => screen.getByRole("button", { name: "Export CSV" });
/** The outcome of an export, as shown. */
const outcome = () => text(document.querySelector(".bk-totals__export"));
/** What a screen reader hears of an export: focus stays on the button, so it is said here. */
const liveText = () => text(screen.getByRole("status"));
const loaded = () => screen.findByRole("heading", { level: 3, name: "Day totals" });

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-11-04T17:00:00Z"));
});

afterEach(() => {
  const strays = strayRequests();
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  expect(strays).toEqual([]);
});

describe("a day's totals", () => {
  it("reads the day's totals for the operator once, and shows them under their own heading", async () => {
    const calls = api({ [route.dayTotals()]: totalsFor() });
    renderTotals();
    await loaded();
    await waitFor(() => expect(grid()).not.toBeNull());
    expect(calls).toHaveLength(1);
    expect(calls[0]?.method).toBe("GET");
    expect(calls[0]?.path).toBe(`/api/v1/staff/tenants/${tenantId}/booking-day-totals`);
    expect(calls[0]?.query.get("date")).toBe(day);
    // A named region, so the totals can be reached as a landmark.
    expect(screen.getByRole("region", { name: "Day totals" })).toBeTruthy();
  });

  it("says it is loading with placeholders, and shows the figures when they arrive", async () => {
    const totals = deferred();
    api({ [route.dayTotals()]: [totals.answer] });
    renderTotals();
    const region = screen.getByRole("region", { name: "Day totals" });
    expect(region.getAttribute("aria-busy")).toBe("true");
    // Placeholders for the ten figures, hidden from a screen reader; no figures yet.
    const placeholders = document.querySelector('.bk-totals__grid[aria-hidden="true"]');
    expect(placeholders?.querySelectorAll(".bk-total")).toHaveLength(10);
    expect(document.querySelector("dl")).toBeNull();
    expect(document.querySelector(".bk-totals__note")).toBeNull();
    // The export does not wait for the figures.
    expect(exportButton().getAttribute("aria-disabled")).toBeNull();

    totals.release(json(dayTotalsBody(day, dayFigures)));
    await waitFor(() => expect(document.querySelector("dl")).not.toBeNull());
    expect(region.getAttribute("aria-busy")).toBe("false");
    expect(document.querySelector('.bk-totals__grid[aria-hidden="true"]')).toBeNull();
  });

  it("shows the figures in the order the money is built, from what was booked to what is left", async () => {
    api({ [route.dayTotals()]: totalsFor() });
    renderTotals();
    await waitFor(() => expect(grid()).not.toBeNull());
    expect(Object.keys(figures())).toEqual([
      "Bookings",
      "Guests",
      "Gross",
      "Discounts",
      "Fees",
      "Added taxes",
      "Total charged",
      "Refunds",
      "Net",
      "Included tax",
    ]);
    expect(figures()).toEqual({
      Bookings: "3",
      Guests: "11",
      Gross: "$1,500.00",
      Discounts: "−$115.00",
      Fees: "$22.50",
      "Added taxes": "$80.90",
      "Total charged": "$1,488.40",
      Refunds: "−$94.50",
      Net: "$1,393.90",
      "Included tax": "$54.20",
    });
  });

  it("shows tax in the prices as its own figure, so a tax-included operator never reads as no tax", async () => {
    api({ [route.dayTotals()]: totalsFor({ taxes: 0, includedTax: 2173 }) });
    renderTotals();
    await waitFor(() => expect(grid()).not.toBeNull());
    expect(figures()["Added taxes"]).toBe("$0.00");
    expect(figures()["Included tax"]).toBe("$21.73");
    expect(figures()).not.toHaveProperty("Taxes");
    expect(note()).toContain(
      "Included tax is already in the prices, so it isn't added to the total.",
    );
  });

  it("shows deductions as minus amounts, and nothing deducted as plain zero", async () => {
    api({ [route.dayTotals()]: totalsFor({ discounts: 0, refunds: 0, net: 148840 }) });
    renderTotals();
    await waitFor(() => expect(grid()).not.toBeNull());
    expect(figures().Discounts).toBe("$0.00");
    expect(figures().Refunds).toBe("$0.00");
    expect(figures().Net).toBe("$1,488.40");
  });

  it("counts one guest and no guests", async () => {
    api({
      [route.dayTotals()]: [
        totalsFor({ bookings: 1, guests: 1 }),
        totalsFor({ bookings: 0, guests: 0 }),
      ],
    });
    renderTotals();
    await waitFor(() => expect(grid()).not.toBeNull());
    expect([figures().Bookings, figures().Guests]).toEqual(["1", "1"]);
    cleanup();
    renderTotals();
    await waitFor(() => expect(grid()).not.toBeNull());
    expect([figures().Bookings, figures().Guests]).toEqual(["0", "0"]);
  });

  it("shows a day with nothing booked as zeros, with no tax or refund to mention", async () => {
    // The stub's own answer for a day: all zero.
    api({});
    renderTotals();
    await waitFor(() => expect(grid()).not.toBeNull());
    expect(Object.values(figures())).toEqual([
      "0",
      "0",
      "$0.00",
      "$0.00",
      "$0.00",
      "$0.00",
      "$0.00",
      "$0.00",
      "$0.00",
      "$0.00",
    ]);
    expect(note()).toBe(
      "Every booking on the trips departing this day, from each booking's order and refunds, as of Wed, Nov 4, 2:03 PM EST.",
    );
  });

  it("loads the totals while React runs effects twice in development", async () => {
    // The console's entry point wraps everything in StrictMode, which starts every load twice.
    api({ [route.dayTotals()]: totalsFor() });
    renderTotals({}, { strict: true });
    await waitFor(() => expect(grid()).not.toBeNull());
    expect(figures().Net).toBe("$1,393.90");
    expect(screen.queryByRole("alert")).toBeNull();
  });
});

describe("what the figures cover, and what they leave out", () => {
  it("says what they cover and when they were read, on the marina's clock", async () => {
    // The premise: 2:03 PM in New York is already the next morning in Tokyo.
    expect(new Date("2026-11-04T19:03:00.000Z").getDate()).toBe(5);
    api({ [route.dayTotals()]: totalsFor({ includedTax: 0 }) });
    renderTotals();
    await waitFor(() => expect(note()).not.toBe(""));
    expect(note()).toBe(
      "Every booking on the trips departing this day, from each booking's order and refunds, as of Wed, Nov 4, 2:03 PM EST.",
    );
  });

  it("reads the time in the zone it is given, not the viewer's", async () => {
    api({ [route.dayTotals()]: totalsFor({ includedTax: 0 }) });
    renderTotals({ zone: "Pacific/Honolulu" });
    await waitFor(() => expect(note()).not.toBe(""));
    expect(note()).toContain("as of Wed, Nov 4, 9:03 AM HST.");
  });

  it("leaves out when it was read while the marina's zone is not known", async () => {
    api({ [route.dayTotals()]: totalsFor({ includedTax: 0 }) });
    renderTotals({ zone: undefined });
    await waitFor(() => expect(note()).not.toBe(""));
    expect(note()).toBe(
      "Every booking on the trips departing this day, from each booking's order and refunds.",
    );
  });

  it("mentions the tax already in the prices only when there is some", async () => {
    api({ [route.dayTotals()]: [totalsFor({ includedTax: 5420 }), totalsFor({ includedTax: 0 })] });
    renderTotals();
    await waitFor(() => expect(note()).not.toBe(""));
    expect(note()).toBe(
      "Every booking on the trips departing this day, from each booking's order and refunds, as of Wed, Nov 4, 2:03 PM EST. Included tax is already in the prices, so it isn't added to the total.",
    );
    cleanup();
    renderTotals();
    await waitFor(() => expect(note()).not.toBe(""));
    expect(note()).not.toContain("Included tax");
    expect(note()).not.toContain("tax");
  });

  it.each([
    [1, 4500, "A refund of $45.00 is pending and not counted until it settles."],
    [2, 9000, "2 refunds of $90.00 in all are pending and not counted until it settles."],
    [12, 123456, "12 refunds of $1,234.56 in all are pending and not counted until it settles."],
  ])("says what a pending refund means, for %i of them", async (count, amount, sentence) => {
    api({ [route.dayTotals()]: totalsFor({ pendingRefunds: { count, amount } }) });
    renderTotals();
    await waitFor(() => expect(note()).toContain("pending"));
    expect(note()).toBe(
      `Every booking on the trips departing this day, from each booking's order and refunds, as of Wed, Nov 4, 2:03 PM EST. Included tax is already in the prices, so it isn't added to the total. ${sentence}`,
    );
  });

  it("does not mention a refund when none is pending", async () => {
    api({ [route.dayTotals()]: totalsFor() });
    renderTotals();
    await waitFor(() => expect(note()).not.toBe(""));
    expect(note()).not.toContain("pending");
    expect(note()).not.toContain("refund of");
  });

  it("says a pending refund without the tax sentence when no tax is included", async () => {
    api({
      [route.dayTotals()]: totalsFor({
        includedTax: 0,
        pendingRefunds: { count: 1, amount: 4500 },
      }),
    });
    renderTotals();
    await waitFor(() => expect(note()).toContain("pending"));
    expect(note()).toBe(
      "Every booking on the trips departing this day, from each booking's order and refunds, as of Wed, Nov 4, 2:03 PM EST. A refund of $45.00 is pending and not counted until it settles.",
    );
  });
});

describe("when the totals do not load", () => {
  it("shows a designed error, keeps the button while it works, and then the figures", async () => {
    const retry = deferred();
    const calls = api({ [route.dayTotals()]: [dropped, retry.answer] });
    renderTotals();
    const alert = await screen.findByRole("alert");
    expect(text(alert)).toContain("The console can't reach TideGrid");
    expect(text(alert)).toContain("Check your connection, then try again.");
    expect(text(alert)).not.toMatch(/TypeError|Failed to fetch/);
    expect(grid()).toBeNull();
    // The export is still offered.
    expect(exportButton()).toBeTruthy();

    const button = within(alert).getByRole("button", { name: "Try again" });
    button.focus();
    fireEvent.click(button);
    expect(await screen.findByRole("button", { name: "Trying again…" })).toBe(button);
    expect(button.getAttribute("aria-busy")).toBe("true");
    expect(document.activeElement).toBe(button);
    expect(screen.getByRole("alert")).toBe(alert);

    retry.release(json(dayTotalsBody(day, dayFigures)));
    await waitFor(() => expect(grid()).not.toBeNull());
    expect(screen.queryByRole("alert")).toBeNull();
    expect(callsTo(calls, route.dayTotals())).toHaveLength(2);
  });

  it("keeps the notice and its button when the second try fails too", async () => {
    api({ [route.dayTotals()]: [dropped, dropped] });
    renderTotals();
    const button = within(await screen.findByRole("alert")).getByRole("button", {
      name: "Try again",
    });
    button.focus();
    fireEvent.click(button);
    await waitFor(() => expect(button.getAttribute("aria-busy")).toBeNull());
    expect(text(screen.getByRole("alert"))).toContain("The console can't reach TideGrid");
    expect(screen.getByRole("button", { name: "Try again" })).toBe(button);
    expect(document.activeElement).toBe(button);
  });

  it("hands focus to the panel's heading when Try again works and its button goes away", async () => {
    const retry = deferred();
    api({ [route.dayTotals()]: [dropped, retry.answer] });
    renderTotals();
    const button = within(await screen.findByRole("alert")).getByRole("button", {
      name: "Try again",
    });
    button.focus();
    fireEvent.click(button);
    retry.release(json(dayTotalsBody(day, dayFigures)));
    await waitFor(() => expect(grid()).not.toBeNull());
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(document.activeElement).not.toBe(document.body);
  });

  it("reads a 500 in plain words, with Try again", async () => {
    api({ [route.dayTotals()]: () => apiError(500, "internal_error") });
    renderTotals();
    const alert = await screen.findByRole("alert");
    expect(text(alert)).toContain("The day's totals didn't load");
    expect(text(alert)).toContain("TideGrid isn't responding right now. Try again in a moment.");
    expect(text(alert)).not.toMatch(/\b[1-5]\d\d\b|_/);
    expect(within(alert).getByRole("button", { name: "Try again" })).toBeTruthy();
  });

  it("says a day too large for one report is too large, with what to do and no Try again", async () => {
    const calls = api({ [route.dayTotals()]: () => apiError(422, "day_too_large") });
    renderTotals();
    const alert = await screen.findByRole("alert");
    expect(text(alert)).toContain("This day is too large for one report");
    expect(text(alert)).toContain(
      "This day has more than 5,000 bookings, more than one report holds. Ask TideGrid for a split export.",
    );
    expect(text(alert)).not.toContain("isn't responding");
    expect(within(alert).queryByRole("button")).toBeNull();
    expect(callsTo(calls, route.dayTotals())).toHaveLength(1);
  });

  it("reads an answer it can't show as a failure with Try again", async () => {
    // The totals of another day are not this day's.
    api({ [route.dayTotals()]: () => json(dayTotalsBody(nextDay, dayFigures)) });
    renderTotals();
    const alert = await screen.findByRole("alert");
    expect(text(alert)).toContain("The day's totals couldn't be shown");
    expect(text(alert)).toContain("TideGrid sent something this console can't read.");
    expect(within(alert).getByRole("button", { name: "Try again" })).toBeTruthy();
  });

  it.each([
    [401, "unauthenticated", "You're signed out", "Sign in again to see the day's totals."],
    [
      403,
      "forbidden",
      "Your role can't see the day's totals",
      `Ask an owner of ${tenantName} if you need access.`,
    ],
    [
      403,
      "tenant_suspended",
      "This operator is suspended",
      `While ${tenantName} is suspended, the day's totals can't be shown.`,
    ],
    [
      404,
      "tenant_not_found",
      "You no longer have access to this operator",
      `Your membership of ${tenantName} may have ended. Ask one of its owners.`,
    ],
  ] as const)(
    "reads a %i %s without Try again, as trying again cannot help",
    async (status, code, title, body) => {
      api({ [route.dayTotals()]: () => apiError(status, code) });
      renderTotals();
      const alert = await screen.findByRole("alert");
      expect(text(alert)).toContain(title);
      expect(text(alert)).toContain(body);
      expect(within(alert).queryByRole("button")).toBeNull();
      expect(alert.querySelector(".tg-notice__actions")).toBeNull();
    },
  );
});

describe("another day", () => {
  it("reads the new day afresh and drops the old figures and the export's message", async () => {
    stubDownload();
    const calls = api({
      [route.dayTotals()]: [totalsFor(), totalsFor({ bookings: 1, guests: 2, net: 4500 })],
      [route.dayExport()]: () => csvAnswer(),
    });
    const { showDay } = renderTotals();
    await waitFor(() => expect(grid()).not.toBeNull());
    fireEvent.click(exportButton());
    await waitFor(() => expect(outcome()).toContain(`Exported ${csvFileName}.`));

    showDay(nextDay);
    await waitFor(() => expect(figures().Bookings).toBe("1"));
    expect(figures().Net).toBe("$45.00");
    expect(outcome()).toBe("");
    expect(callsTo(calls, route.dayTotals()).map((c) => c.query.get("date"))).toEqual([
      day,
      nextDay,
    ]);
  });

  it("ignores a late answer for a day the person has already left", async () => {
    const late = deferred();
    api({ [route.dayTotals()]: [late.answer, totalsFor({ bookings: 1, guests: 2, net: 4500 })] });
    const { showDay } = renderTotals();
    await waitFor(() =>
      expect(document.querySelector('.bk-totals__grid[aria-hidden="true"]')).not.toBeNull(),
    );
    showDay(nextDay);
    await waitFor(() => expect(figures().Bookings).toBe("1"));
    late.release(json(dayTotalsBody(day, dayFigures)));
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(figures().Bookings).toBe("1");
    expect(figures().Net).toBe("$45.00");
  });
});

describe("the CSV export", () => {
  let download: ReturnType<typeof stubDownload>;
  beforeEach(() => {
    download = stubDownload();
  });

  it("asks for the day's CSV and saves it under the name the server gave, as a hidden download link", async () => {
    const calls = api({
      [route.dayTotals()]: totalsFor(),
      [route.dayExport()]: () => csvAnswer(),
    });
    renderTotals();
    await waitFor(() => expect(grid()).not.toBeNull());
    fireEvent.click(exportButton());
    await waitFor(() => expect(outcome()).not.toBe(""));

    const asked = callsTo(calls, route.dayExport());
    expect(asked).toHaveLength(1);
    expect(asked[0]?.path).toBe(`/api/v1/staff/tenants/${tenantId}/booking-day-export`);
    expect(asked[0]?.query.get("date")).toBe(day);
    // Only the operator's id and the date are in the address.
    expect(asked[0]?.query.toString()).toBe(`date=${day}`);

    expect(download.clicked).toEqual([
      { download: csvFileName, href: "blob:tidegrid-test", hidden: true, connected: true },
    ]);
    expect(download.blobs).toHaveLength(1);
    expect(await download.blobs[0]?.text()).toBe("Row,Operator\r\n1,Demo Harbor Charters\r\n");
    // The link is gone from the page once it was used.
    expect(document.querySelector("a[download]")).toBeNull();
  });

  it("says what was exported, and that it holds guests' names and emails, to an owner or booking staff", async () => {
    api({ [route.dayTotals()]: totalsFor(), [route.dayExport()]: () => csvAnswer() });
    renderTotals({ seesGuests: true });
    await waitFor(() => expect(grid()).not.toBeNull());
    expect(outcome()).toBe("");
    expect(liveText()).toBe("");
    fireEvent.click(exportButton());
    const message = `Exported ${csvFileName}. It includes guests' names and emails, so keep it somewhere private.`;
    await waitFor(() => expect(outcome()).toBe(message));
    expect(liveText()).toBe(message);
    expect(document.querySelector(".bk-totals__export--done")).not.toBeNull();
    expect(document.querySelector(".bk-totals__export--failed")).toBeNull();
  });

  it("says that finance's file has the money only", async () => {
    api({ [route.dayTotals()]: totalsFor(), [route.dayExport()]: () => csvAnswer() });
    renderTotals({ seesGuests: false });
    await waitFor(() => expect(grid()).not.toBeNull());
    fireEvent.click(exportButton());
    const message = `Exported ${csvFileName}. It has the money only, without guests' details.`;
    await waitFor(() => expect(outcome()).toBe(message));
    expect(liveText()).toBe(message);
    expect(outcome()).not.toContain("names and emails");
  });

  it("names the file for the day when the server gave no usable name", async () => {
    api({
      [route.dayTotals()]: totalsFor(),
      [route.dayExport()]: () => csvAnswer({ disposition: null }),
    });
    renderTotals();
    await waitFor(() => expect(grid()).not.toBeNull());
    fireEvent.click(exportButton());
    await waitFor(() => expect(outcome()).toContain(`Exported bookings-${day}.csv.`));
    expect(download.clicked[0]?.download).toBe(`bookings-${day}.csv`);
  });

  it("shows Preparing CSV… while it works, keeps focus on the button, and ignores another press", async () => {
    const file = deferred();
    const calls = api({ [route.dayTotals()]: totalsFor(), [route.dayExport()]: [file.answer] });
    renderTotals();
    await waitFor(() => expect(grid()).not.toBeNull());
    const button = exportButton();
    button.focus();
    fireEvent.click(button);
    expect(await screen.findByRole("button", { name: "Preparing CSV…" })).toBe(button);
    expect(button.getAttribute("aria-busy")).toBe("true");
    expect(document.activeElement).toBe(button);
    expect(liveText()).toBe("Preparing the CSV…");
    expect(outcome()).toBe("");
    // Neither a second press nor a second try asks again.
    fireEvent.click(button);
    expect(callsTo(calls, route.dayExport())).toHaveLength(1);

    file.release(csvAnswer());
    await waitFor(() => expect(outcome()).toContain(`Exported ${csvFileName}.`));
    expect(callsTo(calls, route.dayExport())).toHaveLength(1);
    // The same button, ready again, with focus where it was.
    expect(screen.getByRole("button", { name: "Export CSV" })).toBe(button);
    expect(button.getAttribute("aria-busy")).toBeNull();
    expect(document.activeElement).toBe(button);
    expect(download.clicked).toHaveLength(1);
  });

  it("exports again, as often as asked, each time as a new file", async () => {
    const calls = api({
      [route.dayTotals()]: totalsFor(),
      [route.dayExport()]: [() => csvAnswer(), () => csvAnswer()],
    });
    renderTotals();
    await waitFor(() => expect(grid()).not.toBeNull());
    fireEvent.click(exportButton());
    await waitFor(() => expect(download.clicked).toHaveLength(1));
    await waitFor(() => expect(outcome()).not.toBe(""));
    fireEvent.click(exportButton());
    await waitFor(() => expect(download.clicked).toHaveLength(2));
    await waitFor(() => expect(outcome()).toContain("Exported"));
    expect(callsTo(calls, route.dayExport())).toHaveLength(2);
  });

  it("exports even while the totals are loading, and after they failed", async () => {
    const totals = deferred();
    api({ [route.dayTotals()]: [totals.answer], [route.dayExport()]: () => csvAnswer() });
    renderTotals();
    fireEvent.click(exportButton());
    await waitFor(() => expect(outcome()).toContain(`Exported ${csvFileName}.`));
    cleanup();

    api({
      [route.dayTotals()]: () => apiError(500, "internal_error"),
      [route.dayExport()]: () => csvAnswer(),
    });
    renderTotals();
    await screen.findByRole("alert");
    fireEvent.click(exportButton());
    await waitFor(() => expect(outcome()).toContain(`Exported ${csvFileName}.`));
    expect(download.clicked).toHaveLength(2);
  });

  it("exports while React runs effects twice in development", async () => {
    api({ [route.dayTotals()]: totalsFor(), [route.dayExport()]: () => csvAnswer() });
    renderTotals({}, { strict: true });
    await waitFor(() => expect(grid()).not.toBeNull());
    fireEvent.click(exportButton());
    await waitFor(() => expect(outcome()).toContain(`Exported ${csvFileName}.`));
    expect(download.clicked).toHaveLength(1);
  });

  it.each([
    ["a dropped connection", dropped, "Check your connection, then try again."],
    [
      "a server that is not responding",
      () => apiError(500, "internal_error"),
      "TideGrid isn't responding right now. Try again in a moment.",
    ],
    [
      "a role that may not export",
      () => apiError(403, "forbidden"),
      `Ask an owner of ${tenantName} if you need access.`,
    ],
    [
      "a suspended operator",
      () => apiError(403, "tenant_suspended"),
      `While ${tenantName} is suspended, the export can't be shown.`,
    ],
    [
      "an ended membership",
      () => apiError(404, "tenant_not_found"),
      `Your membership of ${tenantName} may have ended. Ask one of its owners.`,
    ],
    [
      "a person who is signed out",
      () => apiError(401, "unauthenticated"),
      "You're signed out. Sign in again, then export.",
    ],
    [
      "a file that is not a CSV",
      () => csvAnswer({ type: "text/html; charset=utf-8" }),
      "TideGrid sent something this console can't read. Try again in a moment.",
    ],
    [
      "a day too large for one report",
      () => apiError(422, "day_too_large"),
      "This day has more than 5,000 bookings, more than one report holds. Ask TideGrid for a split export.",
    ],
  ])("says so after %s, and keeps the button", async (_what, answer, reason) => {
    api({ [route.dayTotals()]: totalsFor(), [route.dayExport()]: answer });
    renderTotals();
    await waitFor(() => expect(grid()).not.toBeNull());
    const button = exportButton();
    button.focus();
    fireEvent.click(button);
    const message = `${exportFailed} ${reason}`;
    await waitFor(() => expect(outcome()).toBe(message));
    expect(liveText()).toBe(message);
    expect(document.querySelector(".bk-totals__export--failed")).not.toBeNull();
    expect(document.querySelector(".bk-totals__export--done")).toBeNull();
    // Nothing was saved, and the same button is ready for another try.
    expect(download.blobs).toEqual([]);
    expect(download.clicked).toEqual([]);
    expect(screen.getByRole("button", { name: "Export CSV" })).toBe(button);
    expect(button.getAttribute("aria-busy")).toBeNull();
    expect(button.getAttribute("aria-disabled")).toBeNull();
    expect(document.activeElement).toBe(button);
  });

  it("tries again after a failure, and the file's message takes the failure's place", async () => {
    const calls = api({
      [route.dayTotals()]: totalsFor(),
      [route.dayExport()]: [dropped, () => csvAnswer()],
    });
    renderTotals();
    await waitFor(() => expect(grid()).not.toBeNull());
    fireEvent.click(exportButton());
    await waitFor(() => expect(outcome()).toContain(exportFailed));
    fireEvent.click(exportButton());
    await waitFor(() => expect(outcome()).toContain(`Exported ${csvFileName}.`));
    expect(outcome()).not.toContain(exportFailed);
    expect(liveText()).toContain(`Exported ${csvFileName}.`);
    expect(callsTo(calls, route.dayExport())).toHaveLength(2);
    expect(download.clicked).toHaveLength(1);
  });
});
