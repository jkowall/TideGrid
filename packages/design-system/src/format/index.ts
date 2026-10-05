/**
 * Dates and times as TideGrid shows them. A trip's times are the operator's
 * wall clock in the trip's IANA zone, never the viewer's:
 *
 * - A plain local date (YYYY-MM-DD) or local time (HH:MM) from the API is the
 *   stored snapshot, so it is formatted as it is, with no zone math.
 * - An instant (such as a booking cutoff) is converted with the trip's zone.
 *
 * Output is plain text with ordinary spaces, assembled from Intl parts so it
 * reads the same in every browser. No DOM and no React: safe in Node.
 */

const locale = "en-US";

/** A local calendar date, YYYY-MM-DD. */
export type LocalDate = string;

const datePattern = /^(\d{4})-(\d{2})-(\d{2})$/;

function parts(date: LocalDate): [number, number, number] {
  const match = datePattern.exec(date);
  if (!match) throw new RangeError(`not a local date: ${date}`);
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

/** Noon UTC on a date: formatting it in UTC can never move it to another day. */
function noonUtc(date: LocalDate): Date {
  const [y, m, d] = parts(date);
  return new Date(Date.UTC(y, m - 1, d, 12));
}

function toLocalDate(value: Date): LocalDate {
  return value.toISOString().slice(0, 10);
}

/** Whether a string is a real calendar date in YYYY-MM-DD form. */
export function isLocalDate(value: string): boolean {
  if (!datePattern.test(value)) return false;
  return toLocalDate(noonUtc(value)) === value;
}

export function addDays(date: LocalDate, days: number): LocalDate {
  const at = noonUtc(date);
  at.setUTCDate(at.getUTCDate() + days);
  return toLocalDate(at);
}

/** Whole days from `from` to `to`; negative when `to` is earlier. */
export function daysBetween(from: LocalDate, to: LocalDate): number {
  return Math.round((noonUtc(to).getTime() - noonUtc(from).getTime()) / 86_400_000);
}

/** 0 is Sunday, 6 is Saturday. */
export function dayOfWeek(date: LocalDate): number {
  return noonUtc(date).getUTCDay();
}

/** The Sunday that starts the week holding `date`. Weeks run Sunday to Saturday. */
export function startOfWeek(date: LocalDate): LocalDate {
  return addDays(date, -dayOfWeek(date));
}

const zoneFormats = new Map<string, Intl.DateTimeFormat>();

/** Numeric parts of an instant on a zone's wall clock. Undefined zone: the viewer's own. */
function wallClock(instant: Date, timeZone: string | undefined) {
  const key = timeZone ?? "";
  let format = zoneFormats.get(key);
  if (!format) {
    format = new Intl.DateTimeFormat(locale, {
      timeZone,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });
    zoneFormats.set(key, format);
  }
  const out: Record<string, number> = {};
  for (const part of format.formatToParts(instant)) {
    if (part.type !== "literal") out[part.type] = Number(part.value);
  }
  return {
    year: out.year ?? 0,
    month: out.month ?? 0,
    day: out.day ?? 0,
    hour: out.hour ?? 0,
    minute: out.minute ?? 0,
    second: out.second ?? 0,
  };
}

/** Today's date on a zone's calendar, or on the viewer's own when no zone is given. */
export function todayIn(timeZone?: string, now: Date = new Date()): LocalDate {
  const c = wallClock(now, timeZone);
  return `${c.year}-${String(c.month).padStart(2, "0")}-${String(c.day).padStart(2, "0")}`;
}

/** The zone's offset from UTC at an instant, in minutes (New York in winter is -300). */
export function offsetMinutes(instant: Date, timeZone: string): number {
  const c = wallClock(instant, timeZone);
  const asUtc = Date.UTC(c.year, c.month - 1, c.day, c.hour, c.minute, c.second);
  const whole = Math.floor(instant.getTime() / 1000) * 1000;
  return Math.round((asUtc - whole) / 60_000);
}

const weekdayLong = new Intl.DateTimeFormat(locale, { weekday: "long", timeZone: "UTC" });
const weekdayShort = new Intl.DateTimeFormat(locale, { weekday: "short", timeZone: "UTC" });
const monthLong = new Intl.DateTimeFormat(locale, { month: "long", timeZone: "UTC" });
const monthShort = new Intl.DateTimeFormat(locale, { month: "short", timeZone: "UTC" });

export type DateStyle = "full" | "medium" | "short";

/**
 * A local date in words.
 * - full: "Sunday, November 1"
 * - medium: "Sun, Nov 1"
 * - short: "Nov 1"
 * With `year`, ", 2026" follows.
 */
export function formatDate(
  date: LocalDate,
  style: DateStyle = "full",
  options: { year?: boolean } = {},
): string {
  const at = noonUtc(date);
  const day = at.getUTCDate();
  const year = options.year ? `, ${at.getUTCFullYear()}` : "";
  if (style === "full") {
    return `${weekdayLong.format(at)}, ${monthLong.format(at)} ${day}${year}`;
  }
  if (style === "medium") {
    return `${weekdayShort.format(at)}, ${monthShort.format(at)} ${day}${year}`;
  }
  return `${monthShort.format(at)} ${day}${year}`;
}

/** The weekday alone: "Sunday", or "Sun" when short. */
export function formatWeekday(date: LocalDate, style: "long" | "short" = "long"): string {
  return (style === "long" ? weekdayLong : weekdayShort).format(noonUtc(date));
}

/**
 * A range of local dates with "to", never a dash, so it reads aloud as written.
 * - short: "Nov 1 to 7, 2026", "Oct 25 to Nov 1, 2026", "Dec 27, 2026 to Jan 2, 2027"
 * - medium: "Mon, Oct 5 to Sun, Nov 1" (the year only when the range leaves this year)
 * - full: "Monday, October 5 to Sunday, November 1"
 */
export function formatDateRange(
  from: LocalDate,
  to: LocalDate,
  style: DateStyle = "short",
  options: { currentYear?: number } = {},
): string {
  const [fy, fm] = parts(from);
  const [ty, tm, td] = parts(to);
  if (style === "short") {
    if (fy !== ty)
      return `${formatDate(from, "short", { year: true })} to ${formatDate(to, "short", { year: true })}`;
    if (fm === tm) return `${formatDate(from, "short")} to ${td}, ${ty}`;
    return `${formatDate(from, "short")} to ${formatDate(to, "short")}, ${ty}`;
  }
  const year = options.currentYear;
  const withYear = fy !== ty || (year !== undefined && (fy !== year || ty !== year));
  return `${formatDate(from, style, { year: withYear })} to ${formatDate(to, style, { year: withYear })}`;
}

function clock(hour: number, minute: number): string {
  const period = hour < 12 ? "AM" : "PM";
  const h = hour % 12 === 0 ? 12 : hour % 12;
  return `${h}:${String(minute).padStart(2, "0")} ${period}`;
}

/** A stored local wall-clock time: "18:00" reads "6:00 PM". */
export function formatClock(time: string): string {
  const match = /^([01]\d|2[0-3]):([0-5]\d)/.exec(time);
  if (!match) throw new RangeError(`not a local time: ${time}`);
  return clock(Number(match[1]), Number(match[2]));
}

/**
 * The local date and time an offset date-time names, read from its own text,
 * so the stored offset is kept and nothing is converted:
 * "2026-11-01T19:30:00-05:00" is 2026-11-01 and "7:30 PM".
 */
export function localPartsOf(offsetDateTime: string): { date: LocalDate; time: string } {
  const match = /^(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2})/.exec(offsetDateTime);
  if (!match) throw new RangeError(`not an offset date-time: ${offsetDateTime}`);
  return { date: match[1] as string, time: clock(Number(match[2]), Number(match[3])) };
}

const abbreviations = new Map<string, Intl.DateTimeFormat>();

/** The zone's short name at an instant, such as "EDT", "EST", or "HST". */
export function zoneAbbreviation(instant: Date, timeZone: string): string {
  let format = abbreviations.get(timeZone);
  if (!format) {
    format = new Intl.DateTimeFormat(locale, { timeZone, timeZoneName: "short" });
    abbreviations.set(timeZone, format);
  }
  return format.formatToParts(instant).find((p) => p.type === "timeZoneName")?.value ?? timeZone;
}

/**
 * An instant on a zone's wall clock: its local date, its time ("9:00 AM"), and
 * the zone's short name then. Used for instants the API sends without a local
 * snapshot, such as a booking cutoff, which can fall on the other side of a
 * clock change from its trip.
 */
export function inZone(
  instant: string | Date,
  timeZone: string,
): { date: LocalDate; time: string; abbreviation: string } {
  const at = typeof instant === "string" ? new Date(instant) : instant;
  if (Number.isNaN(at.getTime())) throw new RangeError(`not an instant: ${String(instant)}`);
  const c = wallClock(at, timeZone);
  return {
    date: `${c.year}-${String(c.month).padStart(2, "0")}-${String(c.day).padStart(2, "0")}`,
    time: clock(c.hour, c.minute),
    abbreviation: zoneAbbreviation(at, timeZone),
  };
}

/**
 * A trip's booking cutoff on the trip zone's clock: "5:00 PM" on the trip's
 * own day, "Sat, Oct 31, 9:00 AM" on another. When the clock changes between
 * the cutoff and the departure, the zone's short name follows ("9:00 AM EDT"),
 * so a cutoff 24 elapsed hours before an 8:00 AM departure does not look wrong.
 */
export function formatCutoff(
  cutoff: string,
  trip: { timeZone: string; localDate: LocalDate; startsAt: string },
): string {
  const close = inZone(cutoff, trip.timeZone);
  const departs = zoneAbbreviation(new Date(trip.startsAt), trip.timeZone);
  const day = close.date === trip.localDate ? "" : `${formatDate(close.date, "medium")}, `;
  const zone = close.abbreviation === departs ? "" : ` ${close.abbreviation}`;
  return `${day}${close.time}${zone}`;
}

/**
 * Elapsed time.
 * - short: "45 min", "1 h 30 min", "4 h"
 * - long, for screen readers: "45 minutes", "1 hour 30 minutes", "4 hours"
 */
export function formatDuration(minutes: number, style: "short" | "long" = "short"): string {
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  const out: string[] = [];
  if (style === "short") {
    if (h > 0) out.push(`${h} h`);
    if (m > 0 || h === 0) out.push(`${m} min`);
  } else {
    if (h > 0) out.push(`${h} ${h === 1 ? "hour" : "hours"}`);
    if (m > 0 || h === 0) out.push(`${m} ${m === 1 ? "minute" : "minutes"}`);
  }
  return out.join(" ");
}

/** The place an IANA zone is named for: "America/New_York" reads "New York". */
export function zoneCity(timeZone: string): string {
  const last = timeZone.split("/").at(-1) ?? timeZone;
  return last.replaceAll("_", " ");
}

export interface ClockChange {
  /** The local date the clocks change on. */
  date: LocalDate;
  /** "back" in autumn, "forward" in spring. */
  direction: "back" | "forward";
  /** Size of the change, usually 60. */
  minutes: number;
  /** The zone's short name before and after, such as "EDT" and "EST". */
  before: string;
  after: string;
}

/** The instant of local noon on a date in a zone. Clocks never change at noon. */
function localNoon(date: LocalDate, timeZone: string): Date {
  const guess = noonUtc(date);
  const first = new Date(guess.getTime() - offsetMinutes(guess, timeZone) * 60_000);
  return new Date(guess.getTime() - offsetMinutes(first, timeZone) * 60_000);
}

/**
 * Clock changes in a zone on the local dates from `from` to `to`, inclusive.
 * A change between two noons is reported on the later date, the day it takes
 * effect.
 */
export function clockChanges(from: LocalDate, to: LocalDate, timeZone: string): ClockChange[] {
  const changes: ClockChange[] = [];
  let previousNoon = localNoon(addDays(from, -1), timeZone);
  let previous = offsetMinutes(previousNoon, timeZone);
  for (let date = from; date <= to; date = addDays(date, 1)) {
    const noon = localNoon(date, timeZone);
    const offset = offsetMinutes(noon, timeZone);
    if (offset !== previous) {
      changes.push({
        date,
        direction: offset < previous ? "back" : "forward",
        minutes: Math.abs(offset - previous),
        before: zoneAbbreviation(previousNoon, timeZone),
        after: zoneAbbreviation(noon, timeZone),
      });
    }
    previous = offset;
    previousNoon = noon;
  }
  return changes;
}

/** "Clocks go back 1 hour on Sun, Nov 1." */
export function describeClockChange(change: ClockChange): string {
  const amount =
    change.minutes % 60 === 0
      ? `${change.minutes / 60} ${change.minutes === 60 ? "hour" : "hours"}`
      : `${change.minutes} minutes`;
  return `Clocks go ${change.direction} ${amount} on ${formatDate(change.date, "medium")}.`;
}
