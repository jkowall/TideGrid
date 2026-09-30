import { describe, expect, it } from "vitest";
import {
  addDays,
  daysBetween,
  formatOffset,
  isLocalDate,
  isLocalTime,
  isoWeekday,
  isValidTimeZone,
  localAt,
  offsetMinutesAt,
  pickInstant,
  resolveLocal,
  startOfLocalDay,
  toOffsetDateTime,
} from "./time.ts";

const utc = (y: number, mo: number, d: number, h = 0, mi = 0) => Date.UTC(y, mo - 1, d, h, mi);

describe("time zone names", () => {
  it("accepts IANA names and UTC, and rejects POSIX forms and unknown zones", () => {
    for (const z of [
      "America/New_York",
      "UTC",
      "America/Argentina/Buenos_Aires",
      "Asia/Ho_Chi_Minh",
    ]) {
      expect(isValidTimeZone(z), z).toBe(true);
    }
    for (const z of [
      "EST5EDT",
      "UTC+3",
      "Etc/GMT+5",
      "america/new_york",
      "America/new_york",
      "Mars/Olympus",
      "",
      "New_York",
    ]) {
      expect(isValidTimeZone(z), z).toBe(false);
    }
  });
});

describe("resolveLocal", () => {
  it("resolves an ordinary summer time uniquely", () => {
    expect(resolveLocal("America/New_York", "2026-07-01", "09:00")).toEqual({
      kind: "unique",
      instant: { epochMs: utc(2026, 7, 1, 13), offsetMinutes: -240 },
    });
  });

  it("reports the spring-forward gap as nonexistent and resolves both edges", () => {
    expect(resolveLocal("America/New_York", "2026-03-08", "02:30")).toEqual({
      kind: "nonexistent",
      offsetBeforeMinutes: -300,
      offsetAfterMinutes: -240,
    });
    expect(resolveLocal("America/New_York", "2026-03-08", "02:00").kind).toBe("nonexistent");
    expect(resolveLocal("America/New_York", "2026-03-08", "01:59")).toEqual({
      kind: "unique",
      instant: { epochMs: utc(2026, 3, 8, 6, 59), offsetMinutes: -300 },
    });
    expect(resolveLocal("America/New_York", "2026-03-08", "03:00")).toEqual({
      kind: "unique",
      instant: { epochMs: utc(2026, 3, 8, 7), offsetMinutes: -240 },
    });
  });

  it("reports the fall-back overlap as ambiguous with both instants in order", () => {
    expect(resolveLocal("America/New_York", "2026-11-01", "01:30")).toEqual({
      kind: "ambiguous",
      earlier: { epochMs: utc(2026, 11, 1, 5, 30), offsetMinutes: -240 },
      later: { epochMs: utc(2026, 11, 1, 6, 30), offsetMinutes: -300 },
    });
    expect(resolveLocal("America/New_York", "2026-11-01", "01:00").kind).toBe("ambiguous");
    expect(resolveLocal("America/New_York", "2026-11-01", "00:59").kind).toBe("unique");
    expect(resolveLocal("America/New_York", "2026-11-01", "02:00")).toEqual({
      kind: "unique",
      instant: { epochMs: utc(2026, 11, 1, 7), offsetMinutes: -300 },
    });
  });

  it("handles Europe/London at 01:00 UTC transitions", () => {
    expect(resolveLocal("Europe/London", "2026-03-29", "01:30").kind).toBe("nonexistent");
    expect(resolveLocal("Europe/London", "2026-10-25", "01:30")).toEqual({
      kind: "ambiguous",
      earlier: { epochMs: utc(2026, 10, 25, 0, 30), offsetMinutes: 60 },
      later: { epochMs: utc(2026, 10, 25, 1, 30), offsetMinutes: 0 },
    });
  });

  it("handles a 30-minute shift (Australia/Lord_Howe)", () => {
    expect(resolveLocal("Australia/Lord_Howe", "2026-10-04", "02:15")).toEqual({
      kind: "nonexistent",
      offsetBeforeMinutes: 630,
      offsetAfterMinutes: 660,
    });
    expect(resolveLocal("Australia/Lord_Howe", "2026-10-04", "02:30").kind).toBe("unique");
    expect(resolveLocal("Australia/Lord_Howe", "2026-04-05", "01:45")).toEqual({
      kind: "ambiguous",
      earlier: { epochMs: utc(2026, 4, 4, 14, 45), offsetMinutes: 660 },
      later: { epochMs: utc(2026, 4, 4, 15, 15), offsetMinutes: 630 },
    });
    expect(resolveLocal("Australia/Lord_Howe", "2026-04-05", "02:00").kind).toBe("unique");
  });

  it("handles the southern hemisphere (Pacific/Auckland)", () => {
    expect(resolveLocal("Pacific/Auckland", "2026-09-27", "02:30").kind).toBe("nonexistent");
    expect(resolveLocal("Pacific/Auckland", "2026-04-05", "02:30")).toEqual({
      kind: "ambiguous",
      earlier: { epochMs: utc(2026, 4, 4, 13, 30), offsetMinutes: 780 },
      later: { epochMs: utc(2026, 4, 4, 14, 30), offsetMinutes: 720 },
    });
  });

  it("handles a gap at midnight and an overlap before midnight (America/Santiago)", () => {
    expect(resolveLocal("America/Santiago", "2026-09-06", "00:00").kind).toBe("nonexistent");
    expect(resolveLocal("America/Santiago", "2026-09-06", "01:00").kind).toBe("unique");
    expect(resolveLocal("America/Santiago", "2026-04-04", "23:30").kind).toBe("ambiguous");
  });

  it("treats zones without transitions and non-hour offsets as ordinary", () => {
    expect(resolveLocal("America/Phoenix", "2026-03-08", "02:30")).toEqual({
      kind: "unique",
      instant: { epochMs: utc(2026, 3, 8, 9, 30), offsetMinutes: -420 },
    });
    expect(resolveLocal("Asia/Kathmandu", "2026-07-01", "09:00")).toEqual({
      kind: "unique",
      instant: { epochMs: utc(2026, 7, 1, 3, 15), offsetMinutes: 345 },
    });
  });

  it("rejects malformed input instead of guessing", () => {
    expect(() => resolveLocal("America/New_York", "2026-02-30", "09:00")).toThrow(RangeError);
    expect(() => resolveLocal("America/New_York", "2026-07-01", "24:00")).toThrow(RangeError);
    expect(() => resolveLocal("Mars/Olympus", "2026-07-01", "09:00")).toThrow(RangeError);
  });
});

describe("pickInstant", () => {
  const overlap = resolveLocal("America/New_York", "2026-11-01", "01:30");
  const gap = resolveLocal("America/New_York", "2026-03-08", "02:30");

  it("needs an explicit choice for an overlap and always rejects a gap", () => {
    expect(pickInstant(overlap, "reject")).toEqual({ ok: false, reason: "ambiguous_local_time" });
    expect(pickInstant(overlap, "earlier")).toMatchObject({
      ok: true,
      instant: { offsetMinutes: -240 },
    });
    expect(pickInstant(overlap, "later")).toMatchObject({
      ok: true,
      instant: { offsetMinutes: -300 },
    });
    for (const choice of ["earlier", "later", "reject"] as const) {
      expect(pickInstant(gap, choice)).toEqual({ ok: false, reason: "nonexistent_local_time" });
    }
  });
});

describe("startOfLocalDay and localAt", () => {
  it("starts an ordinary day at local midnight", () => {
    expect(startOfLocalDay("America/New_York", "2026-07-04")).toEqual({
      epochMs: utc(2026, 7, 4, 4),
      offsetMinutes: -240,
    });
  });

  it("starts a day whose midnight is skipped when the clocks jump", () => {
    const start = startOfLocalDay("America/Santiago", "2026-09-06");
    expect(start.epochMs).toBe(utc(2026, 9, 6, 4));
    expect(localAt("America/Santiago", start.epochMs)).toEqual({
      date: "2026-09-06",
      time: "01:00",
      offsetMinutes: -180,
    });
  });

  it("starts a day with a repeated midnight at the first one", () => {
    // Santiago falls back from 00:00 to 23:00 on April 5, 2026, so the 4th has two 23:00s
    // and the 5th begins once.
    expect(startOfLocalDay("America/Santiago", "2026-04-05").epochMs).toBe(utc(2026, 4, 5, 4));
  });

  it("reads local date, time, and offset back from an instant", () => {
    expect(localAt("America/New_York", utc(2026, 11, 1, 5, 30))).toEqual({
      date: "2026-11-01",
      time: "01:30",
      offsetMinutes: -240,
    });
    expect(localAt("America/New_York", utc(2026, 11, 1, 6, 30))).toEqual({
      date: "2026-11-01",
      time: "01:30",
      offsetMinutes: -300,
    });
    expect(offsetMinutesAt("America/New_York", utc(2026, 11, 1, 6, 30) + 999)).toBe(-300);
  });
});

describe("calendar helpers", () => {
  it("validates service dates and times", () => {
    expect(isLocalDate("2028-02-29")).toBe(true);
    for (const d of ["2026-02-29", "1999-12-31", "2100-01-01", "2026-9-1", "2026-13-01"]) {
      expect(isLocalDate(d), d).toBe(false);
    }
    expect(isLocalTime("23:59")).toBe(true);
    for (const t of ["24:00", "9:00", "12:60", "12:00:00"]) expect(isLocalTime(t), t).toBe(false);
  });

  it("adds days across months, years, and leap days", () => {
    expect(addDays("2026-12-31", 1)).toBe("2027-01-01");
    expect(addDays("2028-02-28", 1)).toBe("2028-02-29");
    expect(addDays("2026-03-01", -1)).toBe("2026-02-28");
    expect(daysBetween("2026-09-30", "2027-09-30")).toBe(365);
    expect(daysBetween("2027-09-30", "2026-09-30")).toBe(-365);
  });

  it("numbers weekdays from Monday", () => {
    expect(isoWeekday("2026-09-28")).toBe(1);
    expect(isoWeekday("2026-09-30")).toBe(3);
    expect(isoWeekday("2026-10-04")).toBe(7);
  });

  it("formats offsets and offset date-times", () => {
    expect(formatOffset(-240)).toBe("-04:00");
    expect(formatOffset(345)).toBe("+05:45");
    expect(formatOffset(0)).toBe("+00:00");
    expect(toOffsetDateTime("2026-11-01", "01:30", -300)).toBe("2026-11-01T01:30:00-05:00");
  });
});
