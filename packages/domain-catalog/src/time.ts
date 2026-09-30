/**
 * Local schedule time, resolved against the IANA time zone data that ships with
 * the runtime. ADR 0016: a scheduled trip stores its zone, local date and time,
 * resolved UTC instants, and offset snapshots. A local time that does not exist
 * (the spring-forward gap) is rejected. A local time that occurs twice (the
 * fall-back overlap) needs an explicit earlier or later choice. Nothing here
 * shifts or picks silently.
 */

/** "YYYY-MM-DD": a calendar date with no zone. */
export type LocalDate = string;
/** "HH:MM": a 24-hour wall-clock time with no zone. */
export type LocalTime = string;
/** ISO 8601 weekday: 1 is Monday, 7 is Sunday. */
export type IsoWeekday = 1 | 2 | 3 | 4 | 5 | 6 | 7;
/** How to treat a local time that occurs twice. Gaps are always rejected. */
export type Disambiguation = "earlier" | "later" | "reject";

export interface ResolvedInstant {
  /** Milliseconds since the Unix epoch. */
  epochMs: number;
  /** Local minus UTC in minutes at that instant: -240 for New York in summer. */
  offsetMinutes: number;
}

export type LocalResolution =
  | { kind: "unique"; instant: ResolvedInstant }
  | { kind: "ambiguous"; earlier: ResolvedInstant; later: ResolvedInstant }
  | { kind: "nonexistent"; offsetBeforeMinutes: number; offsetAfterMinutes: number };

export type LocalTimeProblem = "nonexistent_local_time" | "ambiguous_local_time";

export type PickResult =
  | { ok: true; instant: ResolvedInstant }
  | { ok: false; reason: LocalTimeProblem };

export const MINUTE_MS = 60_000;
const DAY_MS = 86_400_000;

/** Service dates stay in a range where every zone has whole-minute offsets. */
const MIN_YEAR = 2000;
const MAX_YEAR = 2099;

const DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
const TIME = /^([01]\d|2[0-3]):([0-5]\d)$/;
/** IANA Area/Location names and UTC. Excludes POSIX forms such as EST5EDT or UTC+3. */
const ZONE = /^(?:UTC|[A-Z][A-Za-z_]+(?:\/[A-Za-z0-9_+-]+)+)$/;

const formatters = new Map<string, Intl.DateTimeFormat>();

function formatterFor(zone: string): Intl.DateTimeFormat {
  let formatter = formatters.get(zone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat("en-US", {
      timeZone: zone,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });
    formatters.set(zone, formatter);
  }
  return formatter;
}

/** True for an IANA zone name the runtime knows, spelled as the database stores it. */
export function isValidTimeZone(zone: string): boolean {
  if (!ZONE.test(zone)) return false;
  try {
    formatterFor(zone);
    return true;
  } catch {
    return false;
  }
}

function assertZone(zone: string): void {
  if (!isValidTimeZone(zone)) throw new RangeError(`Unknown time zone: ${zone}`);
}

interface Parts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
}

function partsAt(zone: string, epochMs: number): Parts {
  const parts: Parts = { year: 0, month: 0, day: 0, hour: 0, minute: 0, second: 0 };
  for (const part of formatterFor(zone).formatToParts(new Date(epochMs))) {
    if (part.type in parts) parts[part.type as keyof Parts] = Number(part.value);
  }
  return parts;
}

/** The zone's offset from UTC, in minutes, at an instant. */
export function offsetMinutesAt(zone: string, epochMs: number): number {
  assertZone(zone);
  const whole = Math.floor(epochMs / 1000) * 1000;
  const p = partsAt(zone, whole);
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  return Math.round((asUtc - whole) / MINUTE_MS);
}

function pad(n: number, width = 2): string {
  return String(n).padStart(width, "0");
}

/** Parse and validate a calendar date. Throws RangeError for impossible dates. */
export function parseLocalDate(date: LocalDate): { year: number; month: number; day: number } {
  const m = DATE.exec(date);
  if (!m) throw new RangeError(`Not a YYYY-MM-DD date: ${date}`);
  const year = Number(m[1]);
  const month = Number(m[2]);
  const day = Number(m[3]);
  const probe = new Date(Date.UTC(year, month - 1, day));
  if (
    year < MIN_YEAR ||
    year > MAX_YEAR ||
    probe.getUTCFullYear() !== year ||
    probe.getUTCMonth() !== month - 1 ||
    probe.getUTCDate() !== day
  ) {
    throw new RangeError(`Not a valid service date: ${date}`);
  }
  return { year, month, day };
}

export function isLocalDate(value: string): boolean {
  try {
    parseLocalDate(value);
    return true;
  } catch {
    return false;
  }
}

export function isLocalTime(value: string): boolean {
  return TIME.test(value);
}

function parseLocalTime(time: LocalTime): { hour: number; minute: number } {
  const m = TIME.exec(time);
  if (!m) throw new RangeError(`Not an HH:MM time: ${time}`);
  return { hour: Number(m[1]), minute: Number(m[2]) };
}

/** The local wall-clock reading as if it were UTC, in epoch milliseconds. */
function wallMs(date: LocalDate, time: LocalTime): number {
  const d = parseLocalDate(date);
  const t = parseLocalTime(time);
  return Date.UTC(d.year, d.month - 1, d.day, t.hour, t.minute);
}

/**
 * Every instant at which the zone's clocks read `date` `time`. Zero instants
 * means the time falls in a gap; two means it falls in an overlap. The offsets
 * a day either side bracket any real transition, and a candidate counts only
 * if the zone's offset at that instant agrees with it.
 */
export function resolveLocal(zone: string, date: LocalDate, time: LocalTime): LocalResolution {
  assertZone(zone);
  const wall = wallMs(date, time);
  const before = offsetMinutesAt(zone, wall - DAY_MS);
  const after = offsetMinutesAt(zone, wall + DAY_MS);
  const found: ResolvedInstant[] = [];
  for (const offsetMinutes of new Set([before, after])) {
    const epochMs = wall - offsetMinutes * MINUTE_MS;
    if (offsetMinutesAt(zone, epochMs) === offsetMinutes) found.push({ epochMs, offsetMinutes });
  }
  found.sort((a, b) => a.epochMs - b.epochMs);
  const [first, second] = found;
  if (first && second) return { kind: "ambiguous", earlier: first, later: second };
  if (first) return { kind: "unique", instant: first };
  return { kind: "nonexistent", offsetBeforeMinutes: before, offsetAfterMinutes: after };
}

export function pickInstant(resolution: LocalResolution, choice: Disambiguation): PickResult {
  switch (resolution.kind) {
    case "unique":
      return { ok: true, instant: resolution.instant };
    case "ambiguous":
      if (choice === "earlier") return { ok: true, instant: resolution.earlier };
      if (choice === "later") return { ok: true, instant: resolution.later };
      return { ok: false, reason: "ambiguous_local_time" };
    case "nonexistent":
      return { ok: false, reason: "nonexistent_local_time" };
  }
}

/**
 * The first instant of a local calendar day. Midnight can fall in a gap (some
 * zones change at 24:00); the day then starts when the clocks jump, which is
 * the gap's start read with the earlier offset. In an overlap the day starts at
 * the first midnight.
 */
export function startOfLocalDay(zone: string, date: LocalDate): ResolvedInstant {
  const resolution = resolveLocal(zone, date, "00:00");
  if (resolution.kind === "unique") return resolution.instant;
  if (resolution.kind === "ambiguous") return resolution.earlier;
  const epochMs = wallMs(date, "00:00") - resolution.offsetBeforeMinutes * MINUTE_MS;
  return { epochMs, offsetMinutes: offsetMinutesAt(zone, epochMs) };
}

/** The local date, time (to the minute), and offset at an instant. */
export function localAt(
  zone: string,
  epochMs: number,
): { date: LocalDate; time: LocalTime; offsetMinutes: number } {
  assertZone(zone);
  const p = partsAt(zone, Math.floor(epochMs / 1000) * 1000);
  return {
    date: `${pad(p.year, 4)}-${pad(p.month)}-${pad(p.day)}`,
    time: `${pad(p.hour)}:${pad(p.minute)}`,
    offsetMinutes: offsetMinutesAt(zone, epochMs),
  };
}

export function addDays(date: LocalDate, days: number): LocalDate {
  const d = parseLocalDate(date);
  const next = new Date(Date.UTC(d.year, d.month - 1, d.day + days));
  return `${pad(next.getUTCFullYear(), 4)}-${pad(next.getUTCMonth() + 1)}-${pad(next.getUTCDate())}`;
}

/** Whole calendar days from `from` to `to`; negative when `to` is earlier. */
export function daysBetween(from: LocalDate, to: LocalDate): number {
  const a = parseLocalDate(from);
  const b = parseLocalDate(to);
  return Math.round(
    (Date.UTC(b.year, b.month - 1, b.day) - Date.UTC(a.year, a.month - 1, a.day)) / DAY_MS,
  );
}

export function isoWeekday(date: LocalDate): IsoWeekday {
  const d = parseLocalDate(date);
  const day = new Date(Date.UTC(d.year, d.month - 1, d.day)).getUTCDay();
  return (day === 0 ? 7 : day) as IsoWeekday;
}

/** "+05:45", "-04:00", "+00:00". */
export function formatOffset(offsetMinutes: number): string {
  const sign = offsetMinutes < 0 ? "-" : "+";
  const abs = Math.abs(offsetMinutes);
  return `${sign}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`;
}

/** RFC 3339 local time with its offset: "2026-11-01T01:30:00-04:00". */
export function toOffsetDateTime(date: LocalDate, time: LocalTime, offsetMinutes: number): string {
  return `${date}T${time}:00${formatOffset(offsetMinutes)}`;
}
