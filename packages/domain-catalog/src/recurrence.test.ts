import { describe, expect, it, vi } from "vitest";
import { expandSchedule, validateScheduleRule } from "./recurrence.ts";
import type {
  BlackoutInterval,
  ExpansionWindow,
  Occurrence,
  ScheduleRule,
} from "./schedule-types.ts";
import {
  MAX_DURATION_MINUTES,
  MAX_EXPANSION_DAYS,
  MAX_START_TIMES,
  MIN_DURATION_MINUTES,
} from "./schedule-types.ts";
import type { Disambiguation, IsoWeekday, LocalDate } from "./time.ts";
import { addDays, localAt, MINUTE_MS, offsetMinutesAt } from "./time.ts";

const utc = (y: number, mo: number, d: number, h = 0, mi = 0) => Date.UTC(y, mo - 1, d, h, mi);

const NEW_YORK = "America/New_York";
const LORD_HOWE = "Australia/Lord_Howe";
const SANTIAGO = "America/Santiago";
const EVERY_DAY: readonly IsoWeekday[] = [1, 2, 3, 4, 5, 6, 7];
const CHOICES: readonly Disambiguation[] = ["reject", "earlier", "later"];
const YEAR_2026 = { startsOn: "2026-01-01", endsOn: "2026-12-31" } as const;

/** A valid New York summer rule. Each test overrides only what it cares about. */
function makeRule(overrides: Partial<ScheduleRule> = {}): ScheduleRule {
  return {
    timeZone: NEW_YORK,
    startsOn: "2026-06-01",
    endsOn: "2026-08-31",
    weekdays: EVERY_DAY,
    startTimes: ["09:00"],
    durationMinutes: 120,
    ambiguousTime: "reject",
    ...overrides,
  };
}

function between(fromDate: LocalDate, toDate: LocalDate): ExpansionWindow {
  return { fromDate, toDate };
}

/** The window that holds exactly one local day. */
function dayOf(date: LocalDate): ExpansionWindow {
  return between(date, addDays(date, 1));
}

function blackout(startsAtMs: number, endsAtMs: number): BlackoutInterval {
  return { startsAtMs, endsAtMs };
}

/** Weekday lists with values the type forbids, for the validation tests. */
function days(...values: number[]): IsoWeekday[] {
  return values as IsoWeekday[];
}

/** Distinct valid start times, half an hour apart from 00:00. */
function halfHours(count: number): string[] {
  return Array.from({ length: count }, (_, i) => {
    return `${String(Math.floor(i / 2)).padStart(2, "0")}:${i % 2 === 0 ? "00" : "30"}`;
  });
}

/** "date time" labels, so a failing list reads clearly. */
function labels(items: readonly { localDate: string; localStartTime: string }[]): string[] {
  return items.map((item) => `${item.localDate} ${item.localStartTime}`);
}

/** The one occurrence in a list, failing loudly if there is not exactly one. */
function only(items: readonly Occurrence[]): Occurrence {
  expect(items).toHaveLength(1);
  return items[0] as Occurrence;
}

describe("validateScheduleRule", () => {
  it("accepts a valid rule and the limits themselves", () => {
    expect(validateScheduleRule(makeRule())).toEqual([]);
    expect(validateScheduleRule(makeRule({ startTimes: halfHours(MAX_START_TIMES) }))).toEqual([]);
    expect(validateScheduleRule(makeRule({ startTimes: ["00:00", "23:59"] }))).toEqual([]);
    expect(validateScheduleRule(makeRule({ durationMinutes: MIN_DURATION_MINUTES }))).toEqual([]);
    expect(validateScheduleRule(makeRule({ durationMinutes: MAX_DURATION_MINUTES }))).toEqual([]);
    expect(validateScheduleRule(makeRule({ weekdays: [7] }))).toEqual([]);
  });

  it("reports invalid_time_zone", () => {
    for (const timeZone of ["Mars/Olympus", "EST5EDT", "UTC+3", "america/new_york", ""]) {
      expect(validateScheduleRule(makeRule({ timeZone })), timeZone).toEqual(["invalid_time_zone"]);
    }
  });

  it("reports invalid_date for either end of the season, and only once", () => {
    for (const bad of [
      "2026-02-30",
      "2026-13-01",
      "2026-9-1",
      "1999-12-31",
      "2100-01-01",
      "June",
      "",
    ]) {
      expect(validateScheduleRule(makeRule({ startsOn: bad })), bad).toEqual(["invalid_date"]);
      expect(validateScheduleRule(makeRule({ endsOn: bad })), bad).toEqual(["invalid_date"]);
    }
    expect(validateScheduleRule(makeRule({ startsOn: "nope", endsOn: "nope" }))).toEqual([
      "invalid_date",
    ]);
  });

  it("reports season_ends_before_start, and allows a one-day season", () => {
    const early = { startsOn: "2026-06-01", endsOn: "2026-05-31" };
    expect(validateScheduleRule(makeRule(early))).toEqual(["season_ends_before_start"]);
    const yearApart = { startsOn: "2027-01-01", endsOn: "2026-12-31" };
    expect(validateScheduleRule(makeRule(yearApart))).toEqual(["season_ends_before_start"]);
    const oneDay = { startsOn: "2026-06-01", endsOn: "2026-06-01" };
    expect(validateScheduleRule(makeRule(oneDay))).toEqual([]);
  });

  it("does not compare the season ends when one is not a date", () => {
    // 2026-02-30 sorts before 2026-06-01 as text, but it is not a date at all.
    const rule = makeRule({ startsOn: "2026-06-01", endsOn: "2026-02-30" });
    expect(validateScheduleRule(rule)).toEqual(["invalid_date"]);
  });

  it("reports no_weekdays for an empty list and nothing else", () => {
    expect(validateScheduleRule(makeRule({ weekdays: [] }))).toEqual(["no_weekdays"]);
  });

  it("reports invalid_weekday once, however many entries are bad", () => {
    for (const bad of [0, 8, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      const rule = makeRule({ weekdays: days(1, bad) });
      expect(validateScheduleRule(rule), String(bad)).toEqual(["invalid_weekday"]);
    }
    expect(validateScheduleRule(makeRule({ weekdays: days(0, 8, 9) }))).toEqual([
      "invalid_weekday",
    ]);
  });

  it("reports duplicate_weekday once, however many entries repeat", () => {
    expect(validateScheduleRule(makeRule({ weekdays: [1, 1] }))).toEqual(["duplicate_weekday"]);
    expect(validateScheduleRule(makeRule({ weekdays: [1, 2, 1, 2, 1] }))).toEqual([
      "duplicate_weekday",
    ]);
  });

  it("reports no_start_times for an empty list and nothing else", () => {
    expect(validateScheduleRule(makeRule({ startTimes: [] }))).toEqual(["no_start_times"]);
  });

  it("reports too_many_start_times above the limit and not at it", () => {
    expect(validateScheduleRule(makeRule({ startTimes: halfHours(MAX_START_TIMES + 1) }))).toEqual([
      "too_many_start_times",
    ]);
    expect(validateScheduleRule(makeRule({ startTimes: halfHours(MAX_START_TIMES) }))).toEqual([]);
  });

  it("reports invalid_start_time once, however many entries are bad", () => {
    for (const bad of ["24:00", "9:00", "12:60", "12:00:00", "noon", ""]) {
      const rule = makeRule({ startTimes: ["09:00", bad] });
      expect(validateScheduleRule(rule), bad).toEqual(["invalid_start_time"]);
    }
    expect(validateScheduleRule(makeRule({ startTimes: ["24:00", "9:00", "noon"] }))).toEqual([
      "invalid_start_time",
    ]);
  });

  it("reports duplicate_start_time even when the copies are not adjacent", () => {
    expect(validateScheduleRule(makeRule({ startTimes: ["09:00", "09:00"] }))).toEqual([
      "duplicate_start_time",
    ]);
    expect(
      validateScheduleRule(makeRule({ startTimes: ["09:00", "13:00", "09:00", "13:00"] })),
    ).toEqual(["duplicate_start_time"]);
  });

  it("reports invalid_duration outside the limits and for non-integers", () => {
    const bad = [MIN_DURATION_MINUTES - 1, MAX_DURATION_MINUTES + 1, 0, -60, 90.5, Number.NaN];
    for (const durationMinutes of [...bad, Number.POSITIVE_INFINITY]) {
      const rule = makeRule({ durationMinutes });
      expect(validateScheduleRule(rule), String(durationMinutes)).toEqual(["invalid_duration"]);
    }
  });

  it("lists problems in the order the contract declares them", () => {
    const everythingWrong = makeRule({
      timeZone: "Mars/Olympus",
      startsOn: "nope",
      weekdays: days(0, 0),
      // 26 entries: too many, one invalid, and "00:00" repeats the first.
      startTimes: [...halfHours(MAX_START_TIMES), "24:00", "00:00"],
      durationMinutes: 5,
    });
    expect(validateScheduleRule(everythingWrong)).toEqual([
      "invalid_time_zone",
      "invalid_date",
      "invalid_weekday",
      "duplicate_weekday",
      "too_many_start_times",
      "invalid_start_time",
      "duplicate_start_time",
      "invalid_duration",
    ]);

    const emptyAndBackwards = makeRule({
      timeZone: "",
      startsOn: "2026-06-01",
      endsOn: "2026-05-01",
      weekdays: [],
      startTimes: [],
      durationMinutes: 0,
    });
    expect(validateScheduleRule(emptyAndBackwards)).toEqual([
      "invalid_time_zone",
      "season_ends_before_start",
      "no_weekdays",
      "no_start_times",
      "invalid_duration",
    ]);
  });
});

describe("expandSchedule input checks", () => {
  it("throws RangeError for an invalid rule and lists the problems", () => {
    const bad = makeRule({ timeZone: "Mars/Olympus", weekdays: [], durationMinutes: 5 });
    expect(() => expandSchedule(bad, dayOf("2026-06-01"))).toThrow(RangeError);
    expect(() => expandSchedule(bad, dayOf("2026-06-01"))).toThrow(
      "invalid_time_zone, no_weekdays, invalid_duration",
    );
  });

  it("checks the rule even when the window is empty", () => {
    const bad = makeRule({ weekdays: [] });
    expect(() => expandSchedule(bad, between("2026-06-01", "2026-06-01"))).toThrow(/no_weekdays/);
  });

  it("throws RangeError for an invalid window date at either end", () => {
    for (const bad of ["2026-02-30", "2026-6-1", "1999-12-31", "2100-01-01", ""]) {
      expect(() => expandSchedule(makeRule(), between(bad, "2026-06-10")), bad).toThrow(RangeError);
      expect(() => expandSchedule(makeRule(), between("2026-06-01", bad)), bad).toThrow(RangeError);
    }
  });

  it("throws RangeError when toDate is before fromDate", () => {
    expect(() => expandSchedule(makeRule(), between("2026-06-10", "2026-06-09"))).toThrow(
      RangeError,
    );
    expect(() => expandSchedule(makeRule(), between("2027-01-01", "2026-01-01"))).toThrow(
      RangeError,
    );
  });

  it("says which window check failed", () => {
    const run = (window: ExpansionWindow) => () => expandSchedule(makeRule(), window);
    expect(run(between("2026-6-1", "2026-06-10"))).toThrow(/^Window dates must be valid/);
    expect(run(between("2026-06-10", "2026-06-09"))).toThrow(/^Window ends before it starts/);
    const tooLong = between("2026-01-01", addDays("2026-01-01", MAX_EXPANSION_DAYS + 1));
    expect(run(tooLong)).toThrow(new RegExp(`^Window covers ${MAX_EXPANSION_DAYS + 1} days`));
  });

  it("throws RangeError for a blackout that does not end after it starts", () => {
    const at = (h: number) => utc(2026, 6, 1, h);
    const bad = [
      blackout(at(14), at(14)),
      blackout(at(15), at(14)),
      blackout(Number.NaN, at(14)),
      blackout(at(14), Number.NaN),
    ];
    for (const one of bad) {
      const run = () => expandSchedule(makeRule(), dayOf("2026-06-01"), [one]);
      expect(run).toThrow(RangeError);
      expect(run).toThrow(/^Blackout must end after it starts/);
    }
    // A bad entry fails the call even beside sound ones, and even far from the window.
    const far = blackout(utc(2030, 1, 1), utc(2030, 1, 1));
    expect(() =>
      expandSchedule(makeRule(), dayOf("2026-06-01"), [blackout(at(1), at(2)), far]),
    ).toThrow(RangeError);
    // The shortest sound blackout is one millisecond.
    expect(() =>
      expandSchedule(makeRule(), dayOf("2026-06-01"), [blackout(at(14), at(14) + 1)]),
    ).not.toThrow();
  });
});

describe("weekday filtering", () => {
  // 2026-06-01 is a Monday, so this window is one full ISO week.
  const week = between("2026-06-01", "2026-06-08");

  it("runs every day when all seven weekdays are listed", () => {
    const { occurrences, skipped } = expandSchedule(makeRule(), week);
    expect(labels(occurrences)).toEqual([
      "2026-06-01 09:00",
      "2026-06-02 09:00",
      "2026-06-03 09:00",
      "2026-06-04 09:00",
      "2026-06-05 09:00",
      "2026-06-06 09:00",
      "2026-06-07 09:00",
    ]);
    expect(skipped).toEqual([]);
  });

  it("keeps exactly the listed weekday, for each weekday in turn", () => {
    for (const day of EVERY_DAY) {
      const { occurrences } = expandSchedule(makeRule({ weekdays: [day] }), week);
      expect(
        occurrences.map((o) => o.localDate),
        `weekday ${day}`,
      ).toEqual([`2026-06-0${day}`]);
    }
  });

  it("keeps a working-week pattern and a weekend pattern apart", () => {
    const working = expandSchedule(makeRule({ weekdays: [1, 2, 3, 4, 5] }), week);
    expect(working.occurrences.map((o) => o.localDate)).toEqual([
      "2026-06-01",
      "2026-06-02",
      "2026-06-03",
      "2026-06-04",
      "2026-06-05",
    ]);
    const weekend = expandSchedule(makeRule({ weekdays: [6, 7] }), week);
    expect(weekend.occurrences.map((o) => o.localDate)).toEqual(["2026-06-06", "2026-06-07"]);
  });

  it("repeats the pattern week after week", () => {
    const { occurrences } = expandSchedule(
      makeRule({ weekdays: [3] }),
      between("2026-06-01", "2026-06-30"),
    );
    expect(occurrences.map((o) => o.localDate)).toEqual([
      "2026-06-03",
      "2026-06-10",
      "2026-06-17",
      "2026-06-24",
    ]);
  });

  it("does not depend on the order of the weekday list", () => {
    const sorted = expandSchedule(makeRule({ weekdays: [1, 3, 7] }), week);
    const shuffled = expandSchedule(makeRule({ weekdays: [7, 1, 3] }), week);
    expect(shuffled).toEqual(sorted);
    expect(sorted.occurrences.map((o) => o.localDate)).toEqual([
      "2026-06-01",
      "2026-06-03",
      "2026-06-07",
    ]);
  });
});

describe("season bounds", () => {
  // 2026-06-10 is a Wednesday and 2026-06-12 is a Friday.
  const season = { startsOn: "2026-06-10", endsOn: "2026-06-12" };
  const wide = between("2026-06-01", "2026-06-30");

  it("includes the first and last day and excludes the day before and after", () => {
    const { occurrences } = expandSchedule(makeRule(season), wide);
    expect(occurrences.map((o) => o.localDate)).toEqual(["2026-06-10", "2026-06-11", "2026-06-12"]);
  });

  it("runs a one-day season", () => {
    const oneDay = { startsOn: "2026-06-10", endsOn: "2026-06-10" };
    expect(labels(expandSchedule(makeRule(oneDay), wide).occurrences)).toEqual([
      "2026-06-10 09:00",
    ]);
  });

  it("applies the weekday filter inside the season", () => {
    // Tuesday to Monday: the Monday before the season is out, the Monday that ends it is in.
    const rule = makeRule({ startsOn: "2026-06-02", endsOn: "2026-06-15", weekdays: [1] });
    const { occurrences } = expandSchedule(rule, wide);
    expect(occurrences.map((o) => o.localDate)).toEqual(["2026-06-08", "2026-06-15"]);
  });

  it("skips a season end that is not a service weekday", () => {
    // The season ends on a Friday, the last Monday inside it is 06-08.
    const rule = makeRule({ startsOn: "2026-06-01", endsOn: "2026-06-12", weekdays: [1] });
    const { occurrences } = expandSchedule(rule, wide);
    expect(occurrences.map((o) => o.localDate)).toEqual(["2026-06-01", "2026-06-08"]);
  });
});

describe("window clipping", () => {
  const season = makeRule({ startsOn: "2026-06-10", endsOn: "2026-06-20" });
  const dates = (window: ExpansionWindow) =>
    expandSchedule(season, window).occurrences.map((o) => o.localDate);

  it("includes fromDate and excludes toDate", () => {
    expect(dates(between("2026-06-12", "2026-06-15"))).toEqual([
      "2026-06-12",
      "2026-06-13",
      "2026-06-14",
    ]);
    expect(dates(between("2026-06-12", "2026-06-13"))).toEqual(["2026-06-12"]);
  });

  it("clips a window that overlaps the start of the season", () => {
    expect(dates(between("2026-06-05", "2026-06-13"))).toEqual([
      "2026-06-10",
      "2026-06-11",
      "2026-06-12",
    ]);
  });

  it("clips a window that overlaps the end of the season", () => {
    expect(dates(between("2026-06-18", "2026-06-25"))).toEqual([
      "2026-06-18",
      "2026-06-19",
      "2026-06-20",
    ]);
  });

  it("clips a window that sits inside the season on both sides", () => {
    expect(dates(between("2026-06-14", "2026-06-16"))).toEqual(["2026-06-14", "2026-06-15"]);
  });

  it("returns the whole season for a window that contains it", () => {
    expect(dates(between("2026-01-01", "2026-12-31"))).toHaveLength(11);
  });

  it("excludes a season end that equals toDate and keeps one that equals fromDate", () => {
    expect(dates(between("2026-06-18", "2026-06-20"))).toEqual(["2026-06-18", "2026-06-19"]);
    expect(dates(between("2026-06-20", "2026-06-21"))).toEqual(["2026-06-20"]);
  });

  it("returns nothing for a window fully before the season", () => {
    const empty = { occurrences: [], skipped: [] };
    expect(expandSchedule(season, between("2026-05-01", "2026-06-01"))).toEqual(empty);
    // toDate is exclusive, so a window ending on the first day still misses it.
    expect(expandSchedule(season, between("2026-05-01", "2026-06-10"))).toEqual(empty);
  });

  it("returns nothing for a window fully after the season", () => {
    const empty = { occurrences: [], skipped: [] };
    expect(expandSchedule(season, between("2026-06-21", "2026-07-21"))).toEqual(empty);
    expect(expandSchedule(season, between("2026-09-01", "2026-10-01"))).toEqual(empty);
  });

  it("returns an empty expansion when fromDate equals toDate", () => {
    const empty = { occurrences: [], skipped: [] };
    for (const date of ["2026-06-09", "2026-06-10", "2026-06-15", "2026-06-20", "2026-06-21"]) {
      expect(expandSchedule(season, between(date, date)), date).toEqual(empty);
    }
  });

  it("expands a window of exactly MAX_EXPANSION_DAYS", () => {
    const rule = makeRule({ startsOn: "2026-01-01", endsOn: "2027-12-31" });
    const toDate = addDays("2026-01-01", MAX_EXPANSION_DAYS);
    const { occurrences, skipped } = expandSchedule(rule, between("2026-01-01", toDate));
    expect(occurrences).toHaveLength(MAX_EXPANSION_DAYS);
    expect(skipped).toEqual([]);
    expect(occurrences[0]?.localDate).toBe("2026-01-01");
    expect(occurrences.at(-1)?.localDate).toBe(addDays(toDate, -1));
  });

  it("throws one day beyond MAX_EXPANSION_DAYS", () => {
    const rule = makeRule({ startsOn: "2026-01-01", endsOn: "2027-12-31" });
    const toDate = addDays("2026-01-01", MAX_EXPANSION_DAYS + 1);
    expect(() => expandSchedule(rule, between("2026-01-01", toDate))).toThrow(RangeError);
  });

  it("limits the window, not the season", () => {
    // A short season cannot make an oversized window acceptable.
    const week = makeRule({ startsOn: "2026-06-01", endsOn: "2026-06-07" });
    const toDate = addDays("2026-01-01", MAX_EXPANSION_DAYS + 1);
    expect(() => expandSchedule(week, between("2026-01-01", toDate))).toThrow(RangeError);
  });

  it("accounts for every departure in the largest legal request", () => {
    // The season outlasts the 400-day window, so the window is what limits the run.
    const busy = makeRule({
      startsOn: "2026-01-01",
      endsOn: "2027-12-31",
      startTimes: halfHours(MAX_START_TIMES),
    });
    const toDate = addDays("2026-01-01", MAX_EXPANSION_DAYS);
    const { occurrences, skipped } = expandSchedule(busy, between("2026-01-01", toDate));
    expect(occurrences.length + skipped.length).toBe(MAX_EXPANSION_DAYS * MAX_START_TIMES);
    // 02:00 and 02:30 fall in the spring gap. 01:00 and 01:30 repeat in the fall overlap.
    expect(labels(skipped)).toEqual([
      "2026-03-08 02:00",
      "2026-03-08 02:30",
      "2026-11-01 01:00",
      "2026-11-01 01:30",
    ]);
  });
});

describe("several start times per day", () => {
  it("emits every start time each day, in time order, from an unsorted list", () => {
    const rule = makeRule({ startTimes: ["17:30", "09:00", "13:00"] });
    const { occurrences } = expandSchedule(rule, between("2026-06-01", "2026-06-03"));
    expect(labels(occurrences)).toEqual([
      "2026-06-01 09:00",
      "2026-06-01 13:00",
      "2026-06-01 17:30",
      "2026-06-02 09:00",
      "2026-06-02 13:00",
      "2026-06-02 17:30",
    ]);
    // 09:00, 13:00, and 17:30 EDT are 13:00Z, 17:00Z, and 21:30Z.
    expect(occurrences.slice(0, 3).map((o) => o.startsAtMs)).toEqual([
      utc(2026, 6, 1, 13),
      utc(2026, 6, 1, 17),
      utc(2026, 6, 1, 21, 30),
    ]);
  });

  it("gives ordinary departures the same result under every ambiguousTime setting", () => {
    const results = CHOICES.map((ambiguousTime) =>
      expandSchedule(
        makeRule({ startTimes: ["13:00", "09:00"], ambiguousTime }),
        between("2026-06-01", "2026-06-08"),
      ),
    );
    expect(results[1]).toEqual(results[0]);
    expect(results[2]).toEqual(results[0]);
    expect(results[0]?.occurrences).toHaveLength(14);
  });
});

describe("New York spring forward, 2026-03-08", () => {
  it("skips a 02:30 departure as nonexistent under every ambiguousTime setting", () => {
    for (const ambiguousTime of CHOICES) {
      const rule = makeRule({ ...YEAR_2026, startTimes: ["02:30"], ambiguousTime });
      const result = expandSchedule(rule, dayOf("2026-03-08"));
      expect(result.occurrences, ambiguousTime).toEqual([]);
      expect(result.skipped, ambiguousTime).toEqual([
        { localDate: "2026-03-08", localStartTime: "02:30", reason: "nonexistent_local_time" },
      ]);
    }
  });

  it("does not shift the skipped time, and runs it normally on the days either side", () => {
    const rule = makeRule({ ...YEAR_2026, startTimes: ["02:30"] });
    const result = expandSchedule(rule, between("2026-03-07", "2026-03-10"));
    // 02:30 EST is 07:30Z. 02:30 EDT is 06:30Z.
    expect(
      result.occurrences.map((o) => [o.localDate, o.startsAtMs, o.startOffsetMinutes]),
    ).toEqual([
      ["2026-03-07", utc(2026, 3, 7, 7, 30), -300],
      ["2026-03-09", utc(2026, 3, 9, 6, 30), -240],
    ]);
    expect(labels(result.skipped)).toEqual(["2026-03-08 02:30"]);
  });

  it("resolves 09:00 that day at the daylight offset", () => {
    const rule = makeRule({ ...YEAR_2026, startTimes: ["09:00"] });
    const trip = only(expandSchedule(rule, dayOf("2026-03-08")).occurrences);
    // 09:00 EDT is 13:00Z.
    expect(trip).toEqual({
      localDate: "2026-03-08",
      localStartTime: "09:00",
      startsAtMs: utc(2026, 3, 8, 13),
      endsAtMs: utc(2026, 3, 8, 15),
      startOffsetMinutes: -240,
      endOffsetMinutes: -240,
    });
  });

  it("keeps both edges of the gap exact", () => {
    const rule = makeRule({ ...YEAR_2026, startTimes: ["03:00", "02:59", "02:00", "01:59"] });
    const result = expandSchedule(rule, dayOf("2026-03-08"));
    expect(
      result.occurrences.map((o) => [o.localStartTime, o.startsAtMs, o.startOffsetMinutes]),
    ).toEqual([
      ["01:59", utc(2026, 3, 8, 6, 59), -300],
      ["03:00", utc(2026, 3, 8, 7), -240],
    ]);
    expect(result.skipped).toEqual([
      { localDate: "2026-03-08", localStartTime: "02:00", reason: "nonexistent_local_time" },
      { localDate: "2026-03-08", localStartTime: "02:59", reason: "nonexistent_local_time" },
    ]);
  });
});

describe("New York fall back, 2026-11-01", () => {
  const overlapDay = (ambiguousTime: Disambiguation) =>
    expandSchedule(
      makeRule({ ...YEAR_2026, startTimes: ["01:30"], ambiguousTime }),
      dayOf("2026-11-01"),
    );

  it("skips 01:30 as ambiguous when the rule says reject", () => {
    const result = overlapDay("reject");
    expect(result.occurrences).toEqual([]);
    expect(result.skipped).toEqual([
      { localDate: "2026-11-01", localStartTime: "01:30", reason: "ambiguous_local_time" },
    ]);
  });

  it("picks the first 01:30 when the rule says earlier", () => {
    const result = overlapDay("earlier");
    expect(result.skipped).toEqual([]);
    expect(only(result.occurrences)).toMatchObject({
      startsAtMs: utc(2026, 11, 1, 5, 30),
      startOffsetMinutes: -240,
      endsAtMs: utc(2026, 11, 1, 7, 30),
      endOffsetMinutes: -300,
    });
  });

  it("picks the second 01:30 when the rule says later", () => {
    const result = overlapDay("later");
    expect(result.skipped).toEqual([]);
    expect(only(result.occurrences)).toMatchObject({
      startsAtMs: utc(2026, 11, 1, 6, 30),
      startOffsetMinutes: -300,
      endsAtMs: utc(2026, 11, 1, 8, 30),
      endOffsetMinutes: -300,
    });
  });

  it("skips only the repeated hour when the rule says reject", () => {
    const rule = makeRule({ ...YEAR_2026, startTimes: ["02:00", "01:59", "01:00", "00:59"] });
    const result = expandSchedule(rule, dayOf("2026-11-01"));
    expect(
      result.occurrences.map((o) => [o.localStartTime, o.startsAtMs, o.startOffsetMinutes]),
    ).toEqual([
      ["00:59", utc(2026, 11, 1, 4, 59), -240],
      ["02:00", utc(2026, 11, 1, 7), -300],
    ]);
    expect(result.skipped).toEqual([
      { localDate: "2026-11-01", localStartTime: "01:00", reason: "ambiguous_local_time" },
      { localDate: "2026-11-01", localStartTime: "01:59", reason: "ambiguous_local_time" },
    ]);
  });

  it("keeps departures in instant order under earlier and later", () => {
    const times = ["02:00", "01:59", "01:00", "00:59"];
    const earlier = expandSchedule(
      makeRule({ ...YEAR_2026, startTimes: times, ambiguousTime: "earlier" }),
      dayOf("2026-11-01"),
    );
    expect(earlier.occurrences.map((o) => [o.localStartTime, o.startsAtMs])).toEqual([
      ["00:59", utc(2026, 11, 1, 4, 59)],
      ["01:00", utc(2026, 11, 1, 5)],
      ["01:59", utc(2026, 11, 1, 5, 59)],
      ["02:00", utc(2026, 11, 1, 7)],
    ]);
    const later = expandSchedule(
      makeRule({ ...YEAR_2026, startTimes: times, ambiguousTime: "later" }),
      dayOf("2026-11-01"),
    );
    expect(later.occurrences.map((o) => [o.localStartTime, o.startsAtMs])).toEqual([
      ["00:59", utc(2026, 11, 1, 4, 59)],
      ["01:00", utc(2026, 11, 1, 6)],
      ["01:59", utc(2026, 11, 1, 6, 59)],
      ["02:00", utc(2026, 11, 1, 7)],
    ]);
    expect(earlier.skipped).toEqual([]);
    expect(later.skipped).toEqual([]);
  });
});

describe("trips that cross a transition", () => {
  it("ends two elapsed hours after a 00:30 departure on the fall-back day", () => {
    const rule = makeRule({ ...YEAR_2026, startTimes: ["00:30"], durationMinutes: 120 });
    const trip = only(expandSchedule(rule, dayOf("2026-11-01")).occurrences);
    // 00:30 EDT is 04:30Z. Two hours on is 06:30Z, which the clocks read as 01:30 EST.
    expect(trip).toEqual({
      localDate: "2026-11-01",
      localStartTime: "00:30",
      startsAtMs: utc(2026, 11, 1, 4, 30),
      endsAtMs: utc(2026, 11, 1, 6, 30),
      startOffsetMinutes: -240,
      endOffsetMinutes: -300,
    });
    // Adding two hours to the wall clock would have ended at 02:30 EST, which is 07:30Z.
    expect(trip.endsAtMs).not.toBe(utc(2026, 11, 1, 7, 30));
    expect(localAt(NEW_YORK, trip.endsAtMs)).toEqual({
      date: "2026-11-01",
      time: "01:30",
      offsetMinutes: -300,
    });
  });

  it("reads the new offset for a trip that ends exactly when the clocks fall back", () => {
    const rule = makeRule({
      ...YEAR_2026,
      startTimes: ["01:00"],
      durationMinutes: 60,
      ambiguousTime: "earlier",
    });
    const trip = only(expandSchedule(rule, dayOf("2026-11-01")).occurrences);
    // 01:00 EDT is 05:00Z. An hour on is 06:00Z, the instant 02:00 EDT becomes 01:00 EST.
    expect(trip).toMatchObject({
      startsAtMs: utc(2026, 11, 1, 5),
      startOffsetMinutes: -240,
      endsAtMs: utc(2026, 11, 1, 6),
      endOffsetMinutes: -300,
    });
  });

  it("ends an hour later on the clock when the trip crosses spring forward", () => {
    const rule = makeRule({ ...YEAR_2026, startTimes: ["01:30"], durationMinutes: 120 });
    const trip = only(expandSchedule(rule, dayOf("2026-03-08")).occurrences);
    // 01:30 EST is 06:30Z. Two hours on is 08:30Z, which reads 04:30 EDT, not 03:30.
    expect(trip).toMatchObject({
      startsAtMs: utc(2026, 3, 8, 6, 30),
      startOffsetMinutes: -300,
      endsAtMs: utc(2026, 3, 8, 8, 30),
      endOffsetMinutes: -240,
    });
    expect(localAt(NEW_YORK, trip.endsAtMs).time).toBe("04:30");
  });

  it("keeps a full-day trip 24 elapsed hours long across fall back", () => {
    const rule = makeRule({
      ...YEAR_2026,
      startTimes: ["00:00"],
      durationMinutes: MAX_DURATION_MINUTES,
    });
    const trip = only(expandSchedule(rule, dayOf("2026-11-01")).occurrences);
    expect(trip.endsAtMs - trip.startsAtMs).toBe(MAX_DURATION_MINUTES * MINUTE_MS);
    // 00:00 EDT is 04:00Z. A day on is 04:00Z again, which reads 23:00 EST on the same local day.
    expect(trip.endsAtMs).toBe(utc(2026, 11, 2, 4));
    expect(trip.endOffsetMinutes).toBe(-300);
    expect(localAt(NEW_YORK, trip.endsAtMs)).toMatchObject({ date: "2026-11-01", time: "23:00" });
  });
});

describe("trips that cross midnight", () => {
  it("keeps the departure-local date and ends on the next local day", () => {
    const rule = makeRule({ startTimes: ["23:00"], durationMinutes: 180 });
    const trip = only(expandSchedule(rule, dayOf("2026-06-01")).occurrences);
    // 23:00 EDT is 03:00Z the next day. Three hours on is 06:00Z, which reads 02:00 on 06-02.
    expect(trip).toEqual({
      localDate: "2026-06-01",
      localStartTime: "23:00",
      startsAtMs: utc(2026, 6, 2, 3),
      endsAtMs: utc(2026, 6, 2, 6),
      startOffsetMinutes: -240,
      endOffsetMinutes: -240,
    });
    expect(localAt(NEW_YORK, trip.endsAtMs)).toMatchObject({ date: "2026-06-02", time: "02:00" });
  });

  it("crosses midnight and the spring-forward transition together", () => {
    const rule = makeRule({ ...YEAR_2026, startTimes: ["23:00"], durationMinutes: 180 });
    const trip = only(expandSchedule(rule, dayOf("2026-03-07")).occurrences);
    // 23:00 EST is 04:00Z on 03-08. Three hours on is 07:00Z, when the clocks jump to 03:00 EDT.
    expect(trip).toMatchObject({
      localDate: "2026-03-07",
      startsAtMs: utc(2026, 3, 8, 4),
      startOffsetMinutes: -300,
      endsAtMs: utc(2026, 3, 8, 7),
      endOffsetMinutes: -240,
    });
    expect(localAt(NEW_YORK, trip.endsAtMs)).toMatchObject({ date: "2026-03-08", time: "03:00" });
  });

  it("crosses midnight and the year boundary together", () => {
    const rule = makeRule({
      startsOn: "2026-12-31",
      endsOn: "2026-12-31",
      startTimes: ["23:30"],
      durationMinutes: 60,
    });
    const trip = only(expandSchedule(rule, dayOf("2026-12-31")).occurrences);
    // 23:30 EST is 04:30Z on New Year's Day.
    expect(trip).toEqual({
      localDate: "2026-12-31",
      localStartTime: "23:30",
      startsAtMs: utc(2027, 1, 1, 4, 30),
      endsAtMs: utc(2027, 1, 1, 5, 30),
      startOffsetMinutes: -300,
      endOffsetMinutes: -300,
    });
  });
});

describe("Lord Howe 30-minute shifts", () => {
  const rule = (overrides: Partial<ScheduleRule>) =>
    makeRule({ timeZone: LORD_HOWE, startsOn: "2026-01-01", endsOn: "2026-12-31", ...overrides });

  it("skips only the half-hour gap on 2026-10-04", () => {
    const times = ["02:30", "02:29", "02:15", "02:00", "01:59"];
    const result = expandSchedule(rule({ startTimes: times }), dayOf("2026-10-04"));
    // The clocks jump from 02:00 (+10:30) to 02:30 (+11:00) at 15:30Z on 10-03.
    expect(
      result.occurrences.map((o) => [o.localStartTime, o.startsAtMs, o.startOffsetMinutes]),
    ).toEqual([
      ["01:59", utc(2026, 10, 3, 15, 29), 630],
      ["02:30", utc(2026, 10, 3, 15, 30), 660],
    ]);
    expect(result.skipped).toEqual([
      { localDate: "2026-10-04", localStartTime: "02:00", reason: "nonexistent_local_time" },
      { localDate: "2026-10-04", localStartTime: "02:15", reason: "nonexistent_local_time" },
      { localDate: "2026-10-04", localStartTime: "02:29", reason: "nonexistent_local_time" },
    ]);
  });

  it("rejects only the half-hour overlap on 2026-04-05", () => {
    const times = ["02:00", "01:59", "01:45", "01:30", "01:29"];
    const result = expandSchedule(rule({ startTimes: times }), dayOf("2026-04-05"));
    // The clocks go from 02:00 (+11:00) back to 01:30 (+10:30) at 15:00Z on 04-04.
    expect(
      result.occurrences.map((o) => [o.localStartTime, o.startsAtMs, o.startOffsetMinutes]),
    ).toEqual([
      ["01:29", utc(2026, 4, 4, 14, 29), 660],
      ["02:00", utc(2026, 4, 4, 15, 30), 630],
    ]);
    expect(result.skipped).toEqual([
      { localDate: "2026-04-05", localStartTime: "01:30", reason: "ambiguous_local_time" },
      { localDate: "2026-04-05", localStartTime: "01:45", reason: "ambiguous_local_time" },
      { localDate: "2026-04-05", localStartTime: "01:59", reason: "ambiguous_local_time" },
    ]);
  });

  it("uses the earlier and later readings of 01:45 when the rule chooses", () => {
    const earlier = expandSchedule(
      rule({ startTimes: ["01:45"], ambiguousTime: "earlier" }),
      dayOf("2026-04-05"),
    );
    expect(only(earlier.occurrences)).toMatchObject({
      startsAtMs: utc(2026, 4, 4, 14, 45),
      startOffsetMinutes: 660,
    });
    const later = expandSchedule(
      rule({ startTimes: ["01:45"], ambiguousTime: "later" }),
      dayOf("2026-04-05"),
    );
    expect(only(later.occurrences)).toMatchObject({
      startsAtMs: utc(2026, 4, 4, 15, 15),
      startOffsetMinutes: 630,
    });
  });

  it("reads the end offset after a 30-minute shift", () => {
    const trip = only(
      expandSchedule(rule({ startTimes: ["01:00"], durationMinutes: 90 }), dayOf("2026-04-05"))
        .occurrences,
    );
    // 01:00 (+11:00) is 14:00Z. Ninety minutes on is 15:30Z, after the clocks went back at 15:00Z.
    expect(trip).toMatchObject({
      startsAtMs: utc(2026, 4, 4, 14),
      startOffsetMinutes: 660,
      endsAtMs: utc(2026, 4, 4, 15, 30),
      endOffsetMinutes: 630,
    });
    expect(localAt(LORD_HOWE, trip.endsAtMs)).toMatchObject({ date: "2026-04-05", time: "02:00" });
  });
});

describe("Santiago midnight transitions", () => {
  const rule = (overrides: Partial<ScheduleRule>) =>
    makeRule({ timeZone: SANTIAGO, ...YEAR_2026, ...overrides });

  it("skips 00:00 and 00:30 on 2026-09-06 and keeps 01:00", () => {
    const result = expandSchedule(
      rule({ startTimes: ["01:00", "00:30", "00:00"] }),
      dayOf("2026-09-06"),
    );
    // The day starts when the clocks jump to 01:00 (-03:00), which is 04:00Z.
    expect(
      result.occurrences.map((o) => [o.localStartTime, o.startsAtMs, o.startOffsetMinutes]),
    ).toEqual([["01:00", utc(2026, 9, 6, 4), -180]]);
    expect(result.skipped).toEqual([
      { localDate: "2026-09-06", localStartTime: "00:00", reason: "nonexistent_local_time" },
      { localDate: "2026-09-06", localStartTime: "00:30", reason: "nonexistent_local_time" },
    ]);
  });

  it("leaves the days either side of the midnight gap alone", () => {
    const result = expandSchedule(
      rule({ startTimes: ["00:00", "00:30", "01:00"] }),
      between("2026-09-05", "2026-09-08"),
    );
    expect(labels(result.occurrences)).toEqual([
      "2026-09-05 00:00",
      "2026-09-05 00:30",
      "2026-09-05 01:00",
      "2026-09-06 01:00",
      "2026-09-07 00:00",
      "2026-09-07 00:30",
      "2026-09-07 01:00",
    ]);
    expect(labels(result.skipped)).toEqual(["2026-09-06 00:00", "2026-09-06 00:30"]);
  });

  it("applies the ambiguous choice to a repeated 23:30 on 2026-04-04", () => {
    const at = (ambiguousTime: Disambiguation) =>
      expandSchedule(rule({ startTimes: ["23:30"], ambiguousTime }), dayOf("2026-04-04"));
    // The clocks go from 24:00 (-03:00) back to 23:00 (-04:00) at 03:00Z on 04-05.
    expect(at("reject").skipped).toEqual([
      { localDate: "2026-04-04", localStartTime: "23:30", reason: "ambiguous_local_time" },
    ]);
    expect(only(at("earlier").occurrences)).toMatchObject({
      startsAtMs: utc(2026, 4, 5, 2, 30),
      startOffsetMinutes: -180,
    });
    expect(only(at("later").occurrences)).toMatchObject({
      startsAtMs: utc(2026, 4, 5, 3, 30),
      startOffsetMinutes: -240,
    });
  });
});

describe("other zones", () => {
  it("handles the southern hemisphere in Auckland", () => {
    const rule = (overrides: Partial<ScheduleRule>) =>
      makeRule({ timeZone: "Pacific/Auckland", ...YEAR_2026, ...overrides });

    const gap = expandSchedule(
      rule({ startTimes: ["03:00", "02:30", "01:59"] }),
      dayOf("2026-09-27"),
    );
    // The clocks jump from 02:00 (+12:00) to 03:00 (+13:00) at 14:00Z on 09-26.
    expect(
      gap.occurrences.map((o) => [o.localStartTime, o.startsAtMs, o.startOffsetMinutes]),
    ).toEqual([
      ["01:59", utc(2026, 9, 26, 13, 59), 720],
      ["03:00", utc(2026, 9, 26, 14), 780],
    ]);
    expect(labels(gap.skipped)).toEqual(["2026-09-27 02:30"]);

    const at = (ambiguousTime: Disambiguation) =>
      expandSchedule(rule({ startTimes: ["02:30"], ambiguousTime }), dayOf("2026-04-05"));
    expect(at("reject").skipped).toEqual([
      { localDate: "2026-04-05", localStartTime: "02:30", reason: "ambiguous_local_time" },
    ]);
    expect(only(at("earlier").occurrences)).toMatchObject({
      startsAtMs: utc(2026, 4, 4, 13, 30),
      startOffsetMinutes: 780,
    });
    expect(only(at("later").occurrences)).toMatchObject({
      startsAtMs: utc(2026, 4, 4, 14, 30),
      startOffsetMinutes: 720,
    });
  });

  it("handles London, where the clocks change at 01:00 UTC", () => {
    const rule = (overrides: Partial<ScheduleRule>) =>
      makeRule({ timeZone: "Europe/London", ...YEAR_2026, ...overrides });

    const gap = expandSchedule(
      rule({ startTimes: ["02:00", "01:30", "00:59"] }),
      dayOf("2026-03-29"),
    );
    expect(
      gap.occurrences.map((o) => [o.localStartTime, o.startsAtMs, o.startOffsetMinutes]),
    ).toEqual([
      ["00:59", utc(2026, 3, 29, 0, 59), 0],
      ["02:00", utc(2026, 3, 29, 1), 60],
    ]);
    expect(labels(gap.skipped)).toEqual(["2026-03-29 01:30"]);

    const at = (ambiguousTime: Disambiguation) =>
      expandSchedule(rule({ startTimes: ["01:30"], ambiguousTime }), dayOf("2026-10-25"));
    expect(at("reject").skipped).toHaveLength(1);
    expect(only(at("earlier").occurrences)).toMatchObject({
      startsAtMs: utc(2026, 10, 25, 0, 30),
      startOffsetMinutes: 60,
    });
    expect(only(at("later").occurrences)).toMatchObject({
      startsAtMs: utc(2026, 10, 25, 1, 30),
      startOffsetMinutes: 0,
    });
  });

  it("treats zones without transitions, including non-hour offsets, as ordinary", () => {
    const rule = (timeZone: string) => makeRule({ timeZone, ...YEAR_2026, startTimes: ["02:30"] });
    const phoenix = expandSchedule(rule("America/Phoenix"), dayOf("2026-03-08"));
    expect(only(phoenix.occurrences)).toMatchObject({
      startsAtMs: utc(2026, 3, 8, 9, 30),
      startOffsetMinutes: -420,
    });
    const kathmandu = expandSchedule(rule("Asia/Kathmandu"), dayOf("2026-07-01"));
    expect(only(kathmandu.occurrences)).toMatchObject({
      startsAtMs: utc(2026, 6, 30, 20, 45),
      startOffsetMinutes: 345,
      endOffsetMinutes: 345,
    });
    const utcZone = expandSchedule(rule("UTC"), dayOf("2026-03-08"));
    expect(only(utcZone.occurrences)).toMatchObject({
      startsAtMs: utc(2026, 3, 8, 2, 30),
      startOffsetMinutes: 0,
    });
  });

  it("skips every departure on a date a zone removed outright (Samoa, 2011-12-30)", () => {
    const rule = makeRule({
      timeZone: "Pacific/Apia",
      startsOn: "2011-12-28",
      endsOn: "2012-01-02",
      startTimes: ["23:59", "09:00", "00:00"],
    });
    const result = expandSchedule(rule, between("2011-12-29", "2012-01-01"));
    // The zone went from 2011-12-29 23:59 (-10:00) to 2011-12-31 00:00 (+14:00).
    expect(labels(result.occurrences)).toEqual([
      "2011-12-29 00:00",
      "2011-12-29 09:00",
      "2011-12-29 23:59",
      "2011-12-31 00:00",
      "2011-12-31 09:00",
      "2011-12-31 23:59",
    ]);
    expect(result.skipped).toEqual([
      { localDate: "2011-12-30", localStartTime: "00:00", reason: "nonexistent_local_time" },
      { localDate: "2011-12-30", localStartTime: "09:00", reason: "nonexistent_local_time" },
      { localDate: "2011-12-30", localStartTime: "23:59", reason: "nonexistent_local_time" },
    ]);
    const before = result.occurrences.find(
      (o) => o.localDate === "2011-12-29" && o.localStartTime === "09:00",
    );
    const after = result.occurrences.find(
      (o) => o.localDate === "2011-12-31" && o.localStartTime === "09:00",
    );
    expect(before).toMatchObject({ startsAtMs: utc(2011, 12, 29, 19), startOffsetMinutes: -600 });
    expect(after).toMatchObject({ startsAtMs: utc(2011, 12, 30, 19), startOffsetMinutes: 840 });
  });
});

describe("calendar edges", () => {
  it("includes February 29 in a leap year", () => {
    const rule = makeRule({ startsOn: "2028-01-01", endsOn: "2028-12-31" });
    const { occurrences } = expandSchedule(rule, between("2028-02-27", "2028-03-03"));
    expect(labels(occurrences)).toEqual([
      "2028-02-27 09:00",
      "2028-02-28 09:00",
      "2028-02-29 09:00",
      "2028-03-01 09:00",
      "2028-03-02 09:00",
    ]);
    // 09:00 EST is 14:00Z.
    expect(occurrences[2]).toMatchObject({
      startsAtMs: utc(2028, 2, 29, 14),
      startOffsetMinutes: -300,
    });
  });

  it("has no February 29 in a common year", () => {
    const rule = makeRule({ startsOn: "2027-01-01", endsOn: "2027-12-31" });
    const { occurrences } = expandSchedule(rule, between("2027-02-27", "2027-03-03"));
    expect(labels(occurrences)).toEqual([
      "2027-02-27 09:00",
      "2027-02-28 09:00",
      "2027-03-01 09:00",
      "2027-03-02 09:00",
    ]);
  });

  it("runs a season that is only the leap day, when the weekday matches", () => {
    // 2028-02-29 is a Tuesday.
    const season = { startsOn: "2028-02-29", endsOn: "2028-02-29" };
    const window = between("2028-02-01", "2028-03-31");
    expect(
      labels(expandSchedule(makeRule({ ...season, weekdays: [2] }), window).occurrences),
    ).toEqual(["2028-02-29 09:00"]);
    expect(expandSchedule(makeRule({ ...season, weekdays: [3] }), window).occurrences).toEqual([]);
  });

  it("runs across the year boundary", () => {
    const rule = makeRule({ startsOn: "2026-12-30", endsOn: "2027-01-02" });
    const { occurrences } = expandSchedule(rule, between("2026-12-29", "2027-01-04"));
    expect(occurrences.map((o) => [o.localDate, o.startsAtMs, o.startOffsetMinutes])).toEqual([
      ["2026-12-30", utc(2026, 12, 30, 14), -300],
      ["2026-12-31", utc(2026, 12, 31, 14), -300],
      ["2027-01-01", utc(2027, 1, 1, 14), -300],
      ["2027-01-02", utc(2027, 1, 2, 14), -300],
    ]);
  });

  it("filters weekdays across the year boundary", () => {
    // Fridays: 2026-12-25 and 2027-01-01.
    const rule = makeRule({ startsOn: "2026-12-01", endsOn: "2027-01-31", weekdays: [5] });
    const { occurrences } = expandSchedule(rule, between("2026-12-21", "2027-01-04"));
    expect(labels(occurrences)).toEqual(["2026-12-25 09:00", "2027-01-01 09:00"]);
  });
});

describe("blackouts", () => {
  // On 2026-06-01, 09:00 EDT runs 13:00Z to 15:00Z and 13:00 EDT runs 17:00Z to 19:00Z.
  const both = makeRule({ startTimes: ["09:00", "13:00"] });
  const day = dayOf("2026-06-01");
  const at = (h: number, mi = 0) => utc(2026, 6, 1, h, mi);
  const kept = (blackouts: BlackoutInterval[]) =>
    labels(expandSchedule(both, day, blackouts).occurrences);
  const blocked = (blackouts: BlackoutInterval[]) => expandSchedule(both, day, blackouts).skipped;
  const morning = { localDate: "2026-06-01", localStartTime: "09:00", reason: "blackout" };
  const afternoon = { localDate: "2026-06-01", localStartTime: "13:00", reason: "blackout" };

  it("skips a departure whose trip overlaps a blackout, and keeps the others", () => {
    const hit = [blackout(at(14), at(16))];
    expect(kept(hit)).toEqual(["2026-06-01 13:00"]);
    expect(blocked(hit)).toEqual([morning]);
  });

  it("skips a trip that contains the blackout, or lies inside it", () => {
    expect(blocked([blackout(at(14), at(14, 30))])).toEqual([morning]);
    expect(blocked([blackout(at(13), at(15))])).toEqual([morning]);
    const everything = [blackout(at(12), at(20))];
    expect(kept(everything)).toEqual([]);
    expect(blocked(everything)).toEqual([morning, afternoon]);
  });

  it("counts one millisecond of overlap at either edge", () => {
    expect(blocked([blackout(at(12), at(13) + 1)])).toEqual([morning]);
    expect(blocked([blackout(at(15) - 1, at(16))])).toEqual([morning]);
  });

  it("does not skip a trip that only touches a blackout at its start", () => {
    const touching = [blackout(at(12), at(13))];
    expect(kept(touching)).toEqual(["2026-06-01 09:00", "2026-06-01 13:00"]);
    expect(blocked(touching)).toEqual([]);
  });

  it("does not skip a trip that only touches a blackout at its end", () => {
    const touching = [blackout(at(15), at(16))];
    expect(kept(touching)).toEqual(["2026-06-01 09:00", "2026-06-01 13:00"]);
    expect(blocked(touching)).toEqual([]);
  });

  it("does not skip when a blackout fills the gap between two trips exactly", () => {
    // It ends the first trip's window and starts the second, touching both.
    expect(blocked([blackout(at(15), at(17))])).toEqual([]);
  });

  it("applies several blackouts at once", () => {
    // Monday to Friday at 09:00 and 13:00. The trips run 13:00Z to 15:00Z and 17:00Z to 19:00Z.
    const rule = makeRule({ startTimes: ["13:00", "09:00"] });
    const blackouts = [
      blackout(utc(2026, 6, 5, 18), utc(2026, 6, 5, 19)), // hits Friday 13:00 only
      blackout(utc(2026, 6, 2, 14), utc(2026, 6, 2, 16)), // hits Tuesday 09:00 only
      blackout(utc(2026, 6, 3), utc(2026, 6, 4)), // covers all of Wednesday
    ];
    const result = expandSchedule(rule, between("2026-06-01", "2026-06-06"), blackouts);
    expect(labels(result.occurrences)).toEqual([
      "2026-06-01 09:00",
      "2026-06-01 13:00",
      "2026-06-02 13:00",
      "2026-06-04 09:00",
      "2026-06-04 13:00",
      "2026-06-05 09:00",
    ]);
    expect(result.skipped).toEqual([
      { localDate: "2026-06-02", localStartTime: "09:00", reason: "blackout" },
      { localDate: "2026-06-03", localStartTime: "09:00", reason: "blackout" },
      { localDate: "2026-06-03", localStartTime: "13:00", reason: "blackout" },
      { localDate: "2026-06-05", localStartTime: "13:00", reason: "blackout" },
    ]);
  });

  it("reports a departure once when several blackouts overlap it", () => {
    const hit = [
      blackout(at(13), at(14)),
      blackout(at(14), at(16)),
      blackout(at(13, 30), at(14, 30)),
    ];
    expect(blocked(hit)).toEqual([morning]);
  });

  it("ignores blackouts that do not reach any trip", () => {
    const away = [
      blackout(at(0), at(12)),
      blackout(at(20), at(23)),
      blackout(utc(2026, 5, 1), utc(2026, 5, 2)),
    ];
    expect(kept(away)).toEqual(["2026-06-01 09:00", "2026-06-01 13:00"]);
    expect(blocked(away)).toEqual([]);
  });

  it("tests the blackout against the instant the rule chose for a repeated time", () => {
    // The 01:30 trip runs 05:30Z to 07:30Z if earlier and 06:30Z to 08:30Z if later.
    // A blackout from 05:00Z to 06:00Z reaches only the earlier one.
    const hit = [blackout(utc(2026, 11, 1, 5), utc(2026, 11, 1, 6))];
    const run = (ambiguousTime: Disambiguation) =>
      expandSchedule(
        makeRule({ ...YEAR_2026, startTimes: ["01:30"], ambiguousTime }),
        dayOf("2026-11-01"),
        hit,
      );
    expect(run("earlier").skipped).toEqual([
      { localDate: "2026-11-01", localStartTime: "01:30", reason: "blackout" },
    ]);
    expect(run("earlier").occurrences).toEqual([]);
    expect(run("later").skipped).toEqual([]);
    expect(run("later").occurrences).toHaveLength(1);
  });

  it("reports a nonexistent time as nonexistent, even inside a blackout", () => {
    const wholeWeek = [blackout(utc(2026, 3, 7), utc(2026, 3, 10))];
    for (const ambiguousTime of CHOICES) {
      const rule = makeRule({ ...YEAR_2026, startTimes: ["09:00", "02:30"], ambiguousTime });
      const result = expandSchedule(rule, dayOf("2026-03-08"), wholeWeek);
      expect(result.occurrences, ambiguousTime).toEqual([]);
      expect(result.skipped, ambiguousTime).toEqual([
        { localDate: "2026-03-08", localStartTime: "02:30", reason: "nonexistent_local_time" },
        { localDate: "2026-03-08", localStartTime: "09:00", reason: "blackout" },
      ]);
    }
  });

  it("reports an unchosen repeated time as ambiguous, even inside a blackout", () => {
    const wholeDay = [blackout(utc(2026, 11, 1), utc(2026, 11, 2))];
    const rule = makeRule({ ...YEAR_2026, startTimes: ["01:30"], ambiguousTime: "reject" });
    expect(expandSchedule(rule, dayOf("2026-11-01"), wholeDay).skipped).toEqual([
      { localDate: "2026-11-01", localStartTime: "01:30", reason: "ambiguous_local_time" },
    ]);
  });
});

describe("purity", () => {
  it("returns the same expansion every time, in fresh arrays", () => {
    const rule = makeRule({ startTimes: ["13:00", "09:00"] });
    const blackouts = [blackout(utc(2026, 6, 3), utc(2026, 6, 4))];
    const first = expandSchedule(rule, between("2026-06-01", "2026-06-15"), blackouts);
    const second = expandSchedule(rule, between("2026-06-01", "2026-06-15"), blackouts);
    expect(second).toEqual(first);
    expect(second.occurrences).not.toBe(first.occurrences);
    expect(second.skipped).not.toBe(first.skipped);
    expect(first.skipped).toHaveLength(2);
  });

  it("does not read the clock", () => {
    const rule = makeRule({
      ...YEAR_2026,
      startTimes: ["09:00", "02:30", "01:30"],
      ambiguousTime: "later",
    });
    const run = () => expandSchedule(rule, between("2026-03-01", "2026-04-01"));
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date("2001-01-01T00:00:00Z"));
      const early = run();
      vi.setSystemTime(new Date("2090-12-31T23:59:59Z"));
      expect(run()).toEqual(early);
    } finally {
      vi.useRealTimers();
    }
  });

  it("leaves every input unchanged, even when the inputs are frozen", () => {
    const rule = Object.freeze({
      ...makeRule(),
      startTimes: Object.freeze(["17:30", "09:00", "13:00"]),
      weekdays: Object.freeze<IsoWeekday[]>([7, 1, 3]),
    });
    const window = Object.freeze(between("2026-06-01", "2026-06-15"));
    const blackouts = Object.freeze([
      Object.freeze(blackout(utc(2026, 6, 9), utc(2026, 6, 10))),
      Object.freeze(blackout(utc(2026, 6, 2), utc(2026, 6, 3))),
    ]);
    const before = structuredClone({ rule, window, blackouts });

    // A frozen array throws on sort, so this also proves the times are copied first.
    const result = expandSchedule(rule, window, blackouts);

    expect({ rule, window, blackouts }).toEqual(before);
    expect(rule.startTimes).toEqual(["17:30", "09:00", "13:00"]);
    expect(rule.weekdays).toEqual([7, 1, 3]);
    expect(result.occurrences.length).toBeGreaterThan(0);
  });

  it("gives one window the same result as adjacent windows joined", () => {
    // March holds the New York gap, so both result lists have entries.
    const rule = makeRule({
      ...YEAR_2026,
      startTimes: ["09:00", "02:30", "01:30"],
      ambiguousTime: "later",
    });
    const blackouts = [blackout(utc(2026, 3, 12), utc(2026, 3, 14))];
    const whole = expandSchedule(rule, between("2026-03-01", "2026-04-01"), blackouts);
    const parts = [
      between("2026-03-01", "2026-03-08"),
      between("2026-03-08", "2026-03-09"),
      between("2026-03-09", "2026-04-01"),
    ].map((window) => expandSchedule(rule, window, blackouts));
    expect(parts.flatMap((part) => part.occurrences)).toEqual(whole.occurrences);
    expect(parts.flatMap((part) => part.skipped)).toEqual(whole.skipped);
    expect(whole.skipped.map((s) => s.reason)).toContain("nonexistent_local_time");
    expect(whole.skipped.map((s) => s.reason)).toContain("blackout");
  });
});

describe("occurrence invariants around real transitions", () => {
  const transitions: [string, LocalDate, LocalDate][] = [
    [NEW_YORK, "2026-03-08", "2026-11-01"],
    ["Europe/London", "2026-03-29", "2026-10-25"],
    [LORD_HOWE, "2026-10-04", "2026-04-05"],
    ["Pacific/Auckland", "2026-09-27", "2026-04-05"],
    [SANTIAGO, "2026-09-06", "2026-04-04"],
  ];
  const startTimes = [
    "00:00",
    "00:30",
    "01:00",
    "01:30",
    "02:00",
    "02:30",
    "03:00",
    "03:30",
    "22:30",
    "23:00",
    "23:30",
    "23:59",
  ];
  const durationMinutes = 90;

  it("reads every occurrence back as its local time, and accounts for every departure", () => {
    for (const [timeZone, ...dates] of transitions) {
      for (const date of dates) {
        for (const ambiguousTime of CHOICES) {
          const rule = makeRule({
            timeZone,
            ...YEAR_2026,
            startTimes,
            durationMinutes,
            ambiguousTime,
          });
          const from = addDays(date, -2);
          const to = addDays(date, 3);
          const { occurrences, skipped } = expandSchedule(rule, between(from, to));
          const context = `${timeZone} ${date} ${ambiguousTime}`;

          // Each requested (date, time) pair is an occurrence or a skip, never shifted or lost.
          const expected: string[] = [];
          for (let d = from; d < to; d = addDays(d, 1)) {
            for (const t of startTimes) expected.push(`${d} ${t}`);
          }
          expect([...labels(occurrences), ...labels(skipped)].sort(), context).toEqual(
            expected.sort(),
          );

          for (const o of occurrences) {
            expect(localAt(timeZone, o.startsAtMs), context).toEqual({
              date: o.localDate,
              time: o.localStartTime,
              offsetMinutes: o.startOffsetMinutes,
            });
            expect(o.endsAtMs - o.startsAtMs, context).toBe(durationMinutes * MINUTE_MS);
            expect(o.endOffsetMinutes, context).toBe(offsetMinutesAt(timeZone, o.endsAtMs));
          }
          const starts = occurrences.map((o) => o.startsAtMs);
          expect(starts, context).toEqual([...starts].sort((a, b) => a - b));
          expect(new Set(starts).size, context).toBe(starts.length);
        }
      }
    }
  });
});

describe("a realistic season", () => {
  const season = makeRule({
    startsOn: "2026-06-01",
    endsOn: "2026-08-31",
    startTimes: ["09:00", "13:00"],
  });

  it("gives 184 occurrences for 09:00 and 13:00 daily, June 1 to August 31", () => {
    const { occurrences, skipped } = expandSchedule(season, between("2026-06-01", "2026-09-01"));
    expect(occurrences).toHaveLength(184);
    expect(skipped).toEqual([]);
    expect(occurrences[0]).toMatchObject({
      localDate: "2026-06-01",
      localStartTime: "09:00",
      startsAtMs: utc(2026, 6, 1, 13),
    });
    expect(occurrences.at(-1)).toMatchObject({
      localDate: "2026-08-31",
      localStartTime: "13:00",
      startsAtMs: utc(2026, 8, 31, 17),
    });
    for (const o of occurrences) {
      expect(o.startOffsetMinutes).toBe(-240);
      expect(o.endOffsetMinutes).toBe(-240);
      expect(o.endsAtMs - o.startsAtMs).toBe(120 * MINUTE_MS);
    }
    const starts = occurrences.map((o) => o.startsAtMs);
    expect(starts).toEqual([...starts].sort((a, b) => a - b));
  });

  it("gives the same 184 from any window that contains the season", () => {
    const exact = expandSchedule(season, between("2026-06-01", "2026-09-01"));
    expect(expandSchedule(season, between("2026-05-01", "2026-10-01"))).toEqual(exact);
    expect(expandSchedule(season, between("2026-01-01", "2026-12-31"))).toEqual(exact);
  });

  it("gives the same 184 when generated month by month", () => {
    const exact = expandSchedule(season, between("2026-06-01", "2026-09-01"));
    const months = [
      between("2026-06-01", "2026-07-01"),
      between("2026-07-01", "2026-08-01"),
      between("2026-08-01", "2026-09-01"),
    ].map((window) => expandSchedule(season, window));
    expect(months.map((m) => m.occurrences.length)).toEqual([60, 62, 62]);
    expect(months.flatMap((m) => m.occurrences)).toEqual(exact.occurrences);
  });
});
