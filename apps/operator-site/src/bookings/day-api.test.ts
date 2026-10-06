// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest";
import { exportDay, exportFileName, loadDayTotals, saveFile } from "./day-api.ts";
import {
  apiError,
  csvAnswer,
  csvFileName,
  day,
  dayFigures,
  dayTotalsBody,
  dropped,
  json,
  stubDownload,
  tenantId,
} from "./fixtures.ts";

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

/** Stub fetch with one answer for every request, and read back what it was last asked. */
function ask(answer: () => Response | Promise<Response>) {
  const fetched = vi.fn(async (_path: string, _init: RequestInit) => answer());
  vi.stubGlobal("fetch", fetched);
  return () => {
    const [path, init] = fetched.mock.calls.at(-1) as [string, RequestInit];
    return { path, init };
  };
}

/** How each failed answer reads, by status and the error code the API gave. */
const failures = [
  [401, "unauthenticated", "signed_out"],
  [403, "forbidden", "forbidden"],
  [403, "tenant_suspended", "suspended"],
  [404, "not_found", "not_found"],
  [404, "tenant_not_found", "no_access"],
  [400, "validation_failed", "rejected"],
  [500, "internal_error", "unavailable"],
] as const;

const unreadable = { kind: "failed", reason: "unreadable" };

/** The day's answer with its totals replaced, for answers that are wrong in one figure. */
const withTotals = (totals: unknown) => ({ ...dayTotalsBody(day), totals });

/** The figures with one left out, as an answer that forgot it. */
function missing(key: keyof typeof dayFigures): Record<string, unknown> {
  const rest: Record<string, unknown> = { ...dayFigures };
  delete rest[key];
  return rest;
}

const figureKeys = [
  "bookings",
  "guests",
  "gross",
  "discounts",
  "fees",
  "taxes",
  "total",
  "refunds",
  "net",
  "includedTax",
] as const;

describe("a day's totals", () => {
  it("asks for the operator's day by id and date alone, as JSON, with the session", async () => {
    const asked = ask(() => json(dayTotalsBody(day, dayFigures)));
    await loadDayTotals(tenantId, day);
    expect(asked().path).toBe(`/api/v1/staff/tenants/${tenantId}/booking-day-totals?date=${day}`);
    expect(asked().init.method).toBeUndefined();
    expect(asked().init.headers).toEqual({ accept: "application/json" });
    expect(asked().init.credentials).toBe("same-origin");
    // Nothing a caller passes can change the path it sits in.
    await loadDayTotals("a/b?c", day);
    expect(asked().path).toBe(`/api/v1/staff/tenants/a%2Fb%3Fc/booking-day-totals?date=${day}`);
  });

  it("hands back the figures and when they were read, as they were sent", async () => {
    ask(() =>
      json(dayTotalsBody(day, { ...dayFigures, pendingRefunds: { count: 2, amount: 9000 } })),
    );
    expect(await loadDayTotals(tenantId, day)).toEqual({
      kind: "ok",
      value: {
        generatedAt: "2026-11-04T19:03:00.000Z",
        totals: { ...dayFigures, pendingRefunds: { count: 2, amount: 9000 } },
      },
    });
  });

  it("reads a day with nothing booked: zero is a figure", async () => {
    ask(() => json(dayTotalsBody(day)));
    const read = await loadDayTotals(tenantId, day);
    expect(read.kind).toBe("ok");
    if (read.kind === "ok") expect(read.value.totals.net).toBe(0);
  });

  it("reads a figure that is not a whole, non-negative number of cents as unreadable", async () => {
    for (const key of figureKeys) {
      for (const odd of [-1, 12.5, "12", null, 2 ** 53]) {
        ask(() => json(withTotals({ ...dayFigures, [key]: odd })));
        expect(await loadDayTotals(tenantId, day), `${key}: ${String(odd)}`).toEqual(unreadable);
      }
      ask(() => json(withTotals(missing(key))));
      expect(await loadDayTotals(tenantId, day), `no ${key}`).toEqual(unreadable);
    }
  });

  it.each([
    ["the totals of another day", dayTotalsBody("2026-11-05", dayFigures)],
    ["no day", { ...dayTotalsBody(day, dayFigures), date: undefined }],
    ["a time that is not a time", { ...dayTotalsBody(day, dayFigures), generatedAt: "recently" }],
    ["no time", { ...dayTotalsBody(day, dayFigures), generatedAt: undefined }],
    ["no totals", { date: day, generatedAt: "2026-11-04T19:03:00.000Z", currency: "USD" }],
    ["totals that are null", { ...dayTotalsBody(day, dayFigures), totals: null }],
    ["no pending refunds", withTotals(missing("pendingRefunds"))],
    [
      "a pending count that is not whole",
      dayTotalsBody(day, { ...dayFigures, pendingRefunds: { count: 1.5, amount: 0 } }),
    ],
    [
      "a pending amount that is not whole",
      dayTotalsBody(day, { ...dayFigures, pendingRefunds: { count: 1, amount: 45.5 } }),
    ],
    ["nothing", null],
  ])("reads %s as unreadable", async (_what, body) => {
    ask(() => json(body));
    expect(await loadDayTotals(tenantId, day)).toEqual(unreadable);
  });

  it("reads an answer that is not JSON as unreadable", async () => {
    ask(() => new Response("<html>gateway</html>", { status: 200 }));
    expect(await loadDayTotals(tenantId, day)).toEqual(unreadable);
  });

  it.each(failures)("reads a %i %s as %s", async (status, code, reason) => {
    ask(() => apiError(status, code));
    expect(await loadDayTotals(tenantId, day)).toEqual({ kind: "failed", reason });
  });

  it("reads a dropped connection as unreachable, and never throws", async () => {
    ask(dropped);
    expect(await loadDayTotals(tenantId, day)).toEqual({ kind: "failed", reason: "unreachable" });
  });

  it("reads a request the page itself canceled as unavailable, not a lost connection", async () => {
    ask(() => Promise.reject(new DOMException("aborted", "AbortError")));
    const controller = new AbortController();
    controller.abort();
    expect(await loadDayTotals(tenantId, day, controller.signal)).toEqual({
      kind: "failed",
      reason: "unavailable",
    });
  });
});

describe("the export's file name", () => {
  const fallback = `bookings-${day}.csv`;
  const name = (disposition: string | null) => exportFileName(disposition, day);

  it.each([
    [`attachment; filename="${csvFileName}"`, csvFileName],
    ['attachment; filename="bookings_2026.11.04-final.csv"', "bookings_2026.11.04-final.csv"],
    ['attachment; filename="a.csv"; size=12', "a.csv"],
    ['inline; filename="a.csv"', "a.csv"],
  ])("takes the quoted name in %j", (disposition, file) => {
    expect(name(disposition)).toBe(file);
  });

  it("takes a name of up to 120 characters, ending in .csv", () => {
    const longest = `${"a".repeat(116)}.csv`;
    expect(longest).toHaveLength(120);
    expect(name(`attachment; filename="${longest}"`)).toBe(longest);
    expect(name(`attachment; filename="${"a".repeat(117)}.csv"`)).toBe(fallback);
  });

  it("falls back to a plain name from the date when there is no header", () => {
    expect(name(null)).toBe(fallback);
    expect(name("")).toBe(fallback);
    expect(name("attachment")).toBe(fallback);
    expect(exportFileName(null, "2027-01-02")).toBe("bookings-2027-01-02.csv");
  });

  it.each([
    ["a name with no quotes", "attachment; filename=bookings.csv"],
    ["a name in single quotes", "attachment; filename='bookings.csv'"],
    ["an encoded name only", "attachment; filename*=UTF-8''bookings.csv"],
    ["an empty name", 'attachment; filename=""'],
    ["a path", 'attachment; filename="../bookings.csv"'],
    ["a windows path", 'attachment; filename="c:\\bookings.csv"'],
    ["a space", 'attachment; filename="my bookings.csv"'],
    ["an accented letter", 'attachment; filename="réservations.csv"'],
    ["an escaped quote", 'attachment; filename="a\\"b.csv"'],
  ])("falls back for %s: it is not a simple, safe name", (_what, disposition) => {
    expect(name(disposition)).toBe(fallback);
  });

  it.each(["bookings.txt", "bookings.csv.exe", "bookings.CSV", "bookings"])(
    "falls back for %j, which is not a .csv file",
    (file) => {
      expect(name(`attachment; filename="${file}"`)).toBe(fallback);
    },
  );
});

describe("the export", () => {
  it("asks for the day's CSV by id and date alone, and hands the file to save", async () => {
    const asked = ask(() => csvAnswer());
    const save = vi.fn();
    expect(await exportDay(tenantId, day, save)).toEqual({ kind: "saved", fileName: csvFileName });
    expect(asked().path).toBe(`/api/v1/staff/tenants/${tenantId}/booking-day-export?date=${day}`);
    expect(asked().init.method).toBeUndefined();
    expect(asked().init.headers).toEqual({ accept: "text/csv" });
    expect(asked().init.credentials).toBe("same-origin");
    expect(save).toHaveBeenCalledTimes(1);
    const [blob, fileName] = save.mock.calls[0] as [Blob, string];
    expect(fileName).toBe(csvFileName);
    expect(blob).toBeInstanceOf(Blob);
    // The browser may normalize the parameters' spacing; it is still a CSV file.
    expect(blob.type).toMatch(/^text\/csv;\s?charset=utf-8$/);
    expect(await blob.text()).toBe("Row,Operator\r\n1,Demo Harbor Charters\r\n");
  });

  it("names the file for the day when the server gave no usable name", async () => {
    for (const disposition of [
      null,
      'attachment; filename="../x.csv"',
      'attachment; filename="x.txt"',
    ]) {
      ask(() => csvAnswer({ disposition }));
      const save = vi.fn();
      expect(await exportDay(tenantId, day, save)).toEqual({
        kind: "saved",
        fileName: `bookings-${day}.csv`,
      });
      expect(save.mock.calls[0]?.[1]).toBe(`bookings-${day}.csv`);
    }
  });

  it("takes text/csv with or without a charset", async () => {
    for (const type of ["text/csv", "text/csv; charset=utf-8"]) {
      ask(() => csvAnswer({ type }));
      const save = vi.fn();
      expect((await exportDay(tenantId, day, save)).kind).toBe("saved");
      expect(save).toHaveBeenCalledTimes(1);
    }
  });

  it.each([
    ["JSON", "application/json"],
    ["a web page, as a gateway sends", "text/html; charset=utf-8"],
    ["plain text", "text/plain"],
    ["a download of no kind", "application/octet-stream"],
  ])("refuses %s as the file: unreadable, and nothing is saved", async (_what, type) => {
    ask(() => csvAnswer({ type }));
    const save = vi.fn();
    expect(await exportDay(tenantId, day, save)).toEqual(unreadable);
    expect(save).not.toHaveBeenCalled();
  });

  it("refuses an answer that says nothing of its kind", async () => {
    ask(() => new Response("Row\r\n", { status: 200 }));
    const save = vi.fn();
    const answered = await exportDay(tenantId, day, save);
    // A plain string body is labeled text/plain by the Response itself.
    expect(answered).toEqual(unreadable);
    ask(() => new Response(null, { status: 200 }));
    expect(await exportDay(tenantId, day, save)).toEqual(unreadable);
    expect(save).not.toHaveBeenCalled();
  });

  it.each(failures)("reads a %i %s as %s, and saves nothing", async (status, code, reason) => {
    ask(() => apiError(status, code));
    const save = vi.fn();
    expect(await exportDay(tenantId, day, save)).toEqual({ kind: "failed", reason });
    expect(save).not.toHaveBeenCalled();
  });

  it("reads a dropped connection as unreachable, and never throws", async () => {
    ask(dropped);
    const save = vi.fn();
    expect(await exportDay(tenantId, day, save)).toEqual({ kind: "failed", reason: "unreachable" });
    expect(save).not.toHaveBeenCalled();
  });
});

describe("saving a file", () => {
  it("hands the browser a hidden link to download, clicks it once, and takes it away", () => {
    vi.useFakeTimers();
    const { blobs, clicked, revoked } = stubDownload();
    const blob = new Blob(["Row\r\n"], { type: "text/csv" });
    saveFile(blob, csvFileName);
    expect(blobs).toEqual([blob]);
    // The link is on the page while it is clicked, as some browsers need, and gone after.
    expect(clicked).toEqual([
      { download: csvFileName, href: "blob:tidegrid-test", hidden: true, connected: true },
    ]);
    expect(document.querySelector("a")).toBeNull();
    expect(revoked).toEqual([]);
  });

  it("lets the object URL go after ten seconds, so the download has started", () => {
    vi.useFakeTimers();
    const { revoked } = stubDownload();
    saveFile(new Blob(["Row\r\n"], { type: "text/csv" }), csvFileName);
    vi.advanceTimersByTime(9_999);
    expect(revoked).toEqual([]);
    vi.advanceTimersByTime(1);
    expect(revoked).toEqual(["blob:tidegrid-test"]);
  });
});
