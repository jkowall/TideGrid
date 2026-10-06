import { describe, expect, it } from "vitest";
import {
  addDays,
  clockChanges,
  dayOfWeek,
  daysBetween,
  describeClockChange,
  earlier,
  formatClock,
  formatCutoff,
  formatDate,
  formatDateRange,
  formatDuration,
  formatTripTime,
  inZone,
  isKnownZone,
  isLocalDate,
  isRepeatedLocalTime,
  later,
  localPartsOf,
  offsetMinutes,
  startOfWeek,
  todayIn,
  zoneCity,
} from "./index.ts";

/** Times keep their parts together with U+00A0, so they never wrap. */
const nb = " ";

describe("local dates", () => {
  it("does calendar arithmetic on plain dates, across months and years", () => {
    expect(addDays("2026-10-31", 1)).toBe("2026-11-01");
    expect(addDays("2026-12-31", 1)).toBe("2027-01-01");
    expect(addDays("2026-11-01", -28)).toBe("2026-10-04");
    expect(daysBetween("2026-10-05", "2026-11-01")).toBe(27);
    expect(isLocalDate("2026-02-29")).toBe(false);
    expect(isLocalDate("2028-02-29")).toBe(true);
    expect(isLocalDate("2026-1-5")).toBe(false);
    expect(earlier("2026-10-05", "2026-11-01")).toBe("2026-10-05");
    expect(later("2026-10-05", "2026-11-01")).toBe("2026-11-01");
  });

  it("stays within four-digit years and says so when arithmetic leaves them", () => {
    expect(isLocalDate("9999-12-31")).toBe(true);
    expect(isLocalDate("0000-01-01")).toBe(false);
    expect(addDays("0099-12-31", 1)).toBe("0100-01-01");
    // An ISO string past 9999 reads "+010000-01-01", which is not a local date.
    expect(() => addDays("9999-12-31", 1)).toThrow(RangeError);
    expect(() => startOfWeek("0001-01-01")).toThrow(RangeError);
  });

  it("starts weeks on Sunday, so Nov 1 to 7, 2026 is one week", () => {
    expect(dayOfWeek("2026-11-01")).toBe(0);
    expect(startOfWeek("2026-11-07")).toBe("2026-11-01");
    expect(startOfWeek("2026-11-01")).toBe("2026-11-01");
    expect(startOfWeek("2026-10-05")).toBe("2026-10-04");
  });

  it("formats a local date without shifting it, whatever the viewer's zone", () => {
    expect(formatDate("2026-11-01")).toBe("Sunday, November 1");
    expect(formatDate("2026-11-01", "medium")).toBe("Sun, Nov 1");
    expect(formatDate("2026-11-01", "short", { year: true })).toBe("Nov 1, 2026");
  });

  it("writes ranges with 'to', never a dash, naming the year once when it is not this one", () => {
    expect(formatDateRange("2026-11-01", "2026-11-07")).toBe("Nov 1 to 7, 2026");
    expect(formatDateRange("2026-10-25", "2026-10-31")).toBe("Oct 25 to 31, 2026");
    expect(formatDateRange("2026-09-27", "2026-10-03")).toBe("Sep 27 to Oct 3, 2026");
    expect(formatDateRange("2026-12-27", "2027-01-02")).toBe("Dec 27, 2026 to Jan 2, 2027");
    expect(formatDateRange("2026-10-05", "2026-11-01", "medium", { currentYear: 2026 })).toBe(
      "Mon, Oct 5 to Sun, Nov 1",
    );
    expect(formatDateRange("2027-06-07", "2027-07-04", "medium", { currentYear: 2026 })).toBe(
      "Mon, Jun 7 to Sun, Jul 4, 2027",
    );
    expect(formatDateRange("2026-12-28", "2027-01-24", "medium", { currentYear: 2026 })).toBe(
      "Mon, Dec 28, 2026 to Sun, Jan 24, 2027",
    );
    expect(formatDateRange("2026-11-08", "2026-11-14", "medium", { year: "always" })).toBe(
      "Sun, Nov 8 to Sat, Nov 14, 2026",
    );
  });

  it("finds today on a zone's calendar", () => {
    // 03:30 UTC on Oct 6 is still Oct 5 in New York and in Honolulu.
    const now = new Date("2026-10-06T03:30:00Z");
    expect(todayIn("America/New_York", now)).toBe("2026-10-05");
    expect(todayIn("Pacific/Honolulu", now)).toBe("2026-10-05");
    expect(todayIn("Asia/Tokyo", now)).toBe("2026-10-06");
  });

  it("knows which zones this browser can show", () => {
    expect(isKnownZone("America/New_York")).toBe(true);
    expect(isKnownZone("UTC")).toBe(true);
    expect(isKnownZone("Mars/Olympus_Mons")).toBe(false);
  });
});

describe("times", () => {
  it("reads stored wall-clock times as they are, never splitting AM or PM off", () => {
    expect(formatClock("18:00")).toBe(`6:00${nb}PM`);
    expect(formatClock("08:00")).toBe(`8:00${nb}AM`);
    expect(formatClock("00:30")).toBe(`12:30${nb}AM`);
    expect(formatClock("12:05")).toBe(`12:05${nb}PM`);
    expect(localPartsOf("2026-11-01T19:30:00-05:00")).toEqual({
      date: "2026-11-01",
      time: `7:30${nb}PM`,
    });
  });

  it("puts a cutoff on the trip zone's clock, across the 2026-11-01 change", () => {
    // The Nov 1 08:00 EST charter closes 24 elapsed hours earlier: 9:00 AM EDT on Oct 31.
    expect(inZone("2026-10-31T13:00:00.000Z", "America/New_York")).toEqual({
      date: "2026-10-31",
      time: `9:00${nb}AM`,
      abbreviation: "EDT",
    });
    expect(inZone("2026-11-01T22:00:00.000Z", "America/New_York")).toEqual({
      date: "2026-11-01",
      time: `5:00${nb}PM`,
      abbreviation: "EST",
    });
    // Honolulu has no daylight saving time.
    expect(inZone("2026-11-01T05:30:00.000Z", "Pacific/Honolulu").time).toBe(`7:30${nb}PM`);
  });

  it("names the cutoff's day and, across a clock change, its zone", () => {
    const nov1Charter = {
      timeZone: "America/New_York",
      localDate: "2026-11-01",
      startsAt: "2026-11-01T13:00:00.000Z",
    };
    expect(formatCutoff("2026-10-31T13:00:00.000Z", nov1Charter)).toBe(
      `Sat, Oct 31, 9:00${nb}AM${nb}EDT`,
    );
    const nov1Sunset = {
      timeZone: "America/New_York",
      localDate: "2026-11-01",
      startsAt: "2026-11-01T23:00:00.000Z",
    };
    expect(formatCutoff("2026-11-01T22:00:00.000Z", nov1Sunset)).toBe(`5:00${nb}PM`);
    const oct31Charter = {
      timeZone: "America/New_York",
      localDate: "2026-10-31",
      startsAt: "2026-10-31T12:00:00.000Z",
    };
    expect(formatCutoff("2026-10-30T12:00:00.000Z", oct31Charter)).toBe(`Fri, Oct 30, 8:00${nb}AM`);
  });

  it("tells apart the two 1:30 AMs of the night clocks go back", () => {
    // 1:30 AM EDT is 05:30Z; 1:30 AM EST, an hour later, is 06:30Z.
    expect(isRepeatedLocalTime("2026-11-01T05:30:00.000Z", "America/New_York")).toBe(true);
    expect(isRepeatedLocalTime("2026-11-01T06:30:00.000Z", "America/New_York")).toBe(true);
    // 12:30 AM and 2:30 AM happen once.
    expect(isRepeatedLocalTime("2026-11-01T04:30:00.000Z", "America/New_York")).toBe(false);
    expect(isRepeatedLocalTime("2026-11-01T07:30:00.000Z", "America/New_York")).toBe(false);
    expect(isRepeatedLocalTime("2026-11-01T23:00:00.000Z", "America/New_York")).toBe(false);
    expect(isRepeatedLocalTime("2026-11-01T11:30:00.000Z", "Pacific/Honolulu")).toBe(false);
    expect(formatTripTime("01:30", "2026-11-01T05:30:00.000Z", "America/New_York")).toBe(
      `1:30${nb}AM${nb}EDT`,
    );
    expect(formatTripTime("01:30", "2026-11-01T06:30:00.000Z", "America/New_York")).toBe(
      `1:30${nb}AM${nb}EST`,
    );
    expect(formatTripTime("18:00", "2026-11-01T23:00:00.000Z", "America/New_York")).toBe(
      `6:00${nb}PM`,
    );
    // A cutoff in the repeated hour names its zone too.
    expect(
      formatCutoff("2026-11-01T05:30:00.000Z", {
        timeZone: "America/New_York",
        localDate: "2026-11-01",
        startsAt: "2026-11-01T06:30:00.000Z",
      }),
    ).toBe(`1:30${nb}AM${nb}EDT`);
  });

  it("measures offsets on both sides of the change", () => {
    expect(offsetMinutes(new Date("2026-10-31T12:00:00Z"), "America/New_York")).toBe(-240);
    expect(offsetMinutes(new Date("2026-11-01T13:00:00Z"), "America/New_York")).toBe(-300);
    expect(offsetMinutes(new Date("2026-11-01T13:00:00Z"), "UTC")).toBe(0);
  });

  it("reports the clock change on the day it takes effect", () => {
    const [change, ...rest] = clockChanges("2026-10-05", "2026-11-01", "America/New_York");
    expect(rest).toEqual([]);
    expect(change).toEqual({
      date: "2026-11-01",
      direction: "back",
      minutes: 60,
      before: "EDT",
      after: "EST",
    });
    if (!change) throw new Error("no change");
    expect(describeClockChange(change)).toBe("Clocks go back 1 hour on Sun, Nov 1.");
    expect(clockChanges("2026-11-02", "2026-11-29", "America/New_York")).toEqual([]);
    expect(clockChanges("2026-10-05", "2026-11-01", "Pacific/Honolulu")).toEqual([]);
    // Spring forward is Sunday, March 14, 2027: a one-day range on it finds it.
    expect(clockChanges("2027-03-07", "2027-03-13", "America/New_York")).toEqual([]);
    const [spring] = clockChanges("2027-03-14", "2027-03-14", "America/New_York");
    expect(spring).toMatchObject({ date: "2027-03-14", direction: "forward", after: "EDT" });
  });

  it("writes durations short and long, the short one in a single unbreakable piece", () => {
    // U+00A0 throughout: "1 h 30 min" must never wrap as "1 h" over "30 min".
    const nb = String.fromCharCode(0x00a0);
    expect(formatDuration(90)).toBe(`1${nb}h${nb}30${nb}min`);
    expect(formatDuration(240)).toBe(`4${nb}h`);
    expect(formatDuration(45)).toBe(`45${nb}min`);
    expect(formatDuration(150, "long")).toBe("2 hours 30 minutes");
    expect(formatDuration(61, "long")).toBe("1 hour 1 minute");
  });

  it("names a zone by its place", () => {
    expect(zoneCity("America/New_York")).toBe("New York");
    expect(zoneCity("Pacific/Honolulu")).toBe("Honolulu");
    expect(zoneCity("America/Argentina/Buenos_Aires")).toBe("Buenos Aires");
    expect(zoneCity("UTC")).toBe("UTC");
  });
});
