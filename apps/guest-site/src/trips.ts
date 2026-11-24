import { type AvailableTrip, TripAvailabilityResponse } from "@tidegrid/contracts";
import {
  addDays,
  earlier,
  isKnownZone,
  isLocalDate,
  type LocalDate,
  later,
} from "@tidegrid/design-system/format";
import { apiBase } from "./bootstrap.ts";

/** Four weeks a page, today included. One request may span at most 93 days. */
export const windowDays = 28;

/**
 * Guests page up to a year ahead. The API takes dates through 2099-12-30, so
 * a window must also end by then.
 */
export const horizonDays = 364;
const apiLastDate = "2099-12-30";

/** The first date of the last page a guest can reach. */
export function lastStart(today: LocalDate): LocalDate {
  return earlier(addDays(today, horizonDays), addDays(apiLastDate, -(windowDays - 1)));
}

/** A page start kept between today and the horizon. */
export function clampStart(start: LocalDate, today: LocalDate): LocalDate {
  return later(today, earlier(start, lastStart(today)));
}

/** The party sizes a guest can pick. The API accepts more; the demo offers 1 to 12. */
export const partySizes: readonly number[] = Array.from({ length: 12 }, (_, i) => i + 1);

export const tripsTimeoutMs = 10_000;

export interface TripWindow {
  /** First date the page shows. */
  start: LocalDate;
  /** Last date the page shows, inclusive. */
  end: LocalDate;
  /** First date the request asks for. */
  from: LocalDate;
  /** Last date the request asks for. */
  to: LocalDate;
}

/**
 * The dates a page shows and the dates it asks for. Dates are the marina's
 * calendar, and the page knows only the guest's. A guest whose date is already
 * tomorrow, east of the marina, would miss the rest of the marina's today, so
 * the first page asks for one day more. The API never returns a trip whose
 * sales have closed, so that day adds nothing in the past.
 */
export function windowOf(start: LocalDate, today: LocalDate): TripWindow {
  const end = addDays(start, windowDays - 1);
  return { start, end, from: start <= today ? addDays(start, -1) : start, to: end };
}

export interface TripQuery {
  start: LocalDate;
  party: number;
}

/**
 * Read `?from=` and `?party=` from the address. A date before today or past
 * the horizon is pulled back inside it; anything unreadable falls back.
 */
export function readQuery(search: string, today: LocalDate): TripQuery {
  const params = new URLSearchParams(search);
  const from = params.get("from") ?? "";
  const party = Number(params.get("party"));
  return {
    start: isLocalDate(from) ? clampStart(from, today) : today,
    party: partySizes.includes(party) ? party : 1,
  };
}

/**
 * The address query for a page; empty for the first page for one guest.
 * `list`: the list was chosen over the calendar, so the address says so.
 */
export function writeQuery(query: TripQuery, today: LocalDate, list = false): string {
  const params = new URLSearchParams();
  if (list) params.set("view", "list");
  if (query.start > today) params.set("from", query.start);
  if (query.party !== 1) params.set("party", String(query.party));
  const text = params.toString();
  return text ? `?${text}` : "";
}

/**
 * Why trips did not load, so the page can say what to do:
 * - unreachable: no answer, or no answer in time;
 * - rejected: the API refused the dates or party (400);
 * - unavailable: any other answer that is not a list;
 * - unreadable: a list that breaks the contract, or names a time zone this
 *   browser cannot show.
 */
export type TripsFailure = "unreachable" | "rejected" | "unavailable" | "unreadable";

export type TripsResult =
  | { kind: "ok"; trips: AvailableTrip[] }
  | { kind: "failed"; reason: TripsFailure };

/**
 * Ask the API for bookable trips. The browser sends the page's Origin, and the
 * API answers for the operator published there. The response is parsed against
 * the contract. Never throws: every failure, including a timeout, is "failed".
 */
export async function loadTrips(
  request: { from: LocalDate; to: LocalDate; party: number },
  signal?: AbortSignal,
  fetchImpl: typeof fetch = (...args) => fetch(...args),
): Promise<TripsResult> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let stopListening = () => {};
  try {
    const controller = new AbortController();
    if (signal?.aborted) controller.abort();
    else if (signal) {
      const forward = () => controller.abort();
      signal.addEventListener("abort", forward, { once: true });
      stopListening = () => signal.removeEventListener("abort", forward);
    }
    timer = setTimeout(() => controller.abort(), tripsTimeoutMs);
    const params = new URLSearchParams({
      from: request.from,
      to: request.to,
      party: String(request.party),
    });
    const res = await fetchImpl(`${apiBase}/v1/public/trips?${params}`, {
      credentials: "omit",
      headers: { accept: "application/json" },
      signal: controller.signal,
    });
    if (res.status === 400) return { kind: "failed", reason: "rejected" };
    if (!res.ok) return { kind: "failed", reason: "unavailable" };
    const body: unknown = await res.json().catch(() => undefined);
    const parsed = TripAvailabilityResponse.safeParse(body);
    if (!parsed.success) return { kind: "failed", reason: "unreadable" };
    // A zone this browser does not know cannot be shown on the marina's clock.
    if (parsed.data.trips.some((t) => !isKnownZone(t.timeZone))) {
      return { kind: "failed", reason: "unreadable" };
    }
    return { kind: "ok", trips: parsed.data.trips };
  } catch {
    return { kind: "failed", reason: "unreachable" };
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    stopListening();
  }
}

export interface TripDay {
  /** The marina's local date. */
  date: LocalDate;
  trips: AvailableTrip[];
}

/**
 * Group trips by their local date at the marina, never the guest's: a trip
 * leaving at 6:00 PM on Oct 31 in New York is an Oct 31 trip wherever the
 * guest is. Days are in date order; trips in a day keep departure order.
 */
export function groupByDate(trips: readonly AvailableTrip[]): TripDay[] {
  const days = new Map<LocalDate, AvailableTrip[]>();
  for (const trip of trips) {
    const day = days.get(trip.localDate);
    if (day) day.push(trip);
    else days.set(trip.localDate, [trip]);
  }
  return [...days.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([date, list]) => ({
      date,
      trips: list.sort((a, b) => Date.parse(a.startsAt) - Date.parse(b.startsAt)),
    }));
}

// The calendar ---------------------------------------------------------------------

/** How the home page shows trips: a month to pick a date from, or the four-week list. */
export type TripView = "calendar" | "list";

/** `?view=list` opens the list; anything else, the calendar. */
export function readView(search: string): TripView {
  return new URLSearchParams(search).get("view") === "list" ? "list" : "calendar";
}

/** A month as its first date, YYYY-MM-01. */
export type MonthStart = LocalDate;

/** The month holding `date`, as its first date. */
export function monthOf(date: LocalDate): MonthStart {
  return `${date.slice(0, 7)}-01`;
}

/** The first date of the month `months` after (or before) `month`. */
export function addMonths(month: MonthStart, months: number): MonthStart {
  const year = Number(month.slice(0, 4));
  const index = Number(month.slice(5, 7)) - 1 + months;
  const y = year + Math.floor(index / 12);
  const m = ((index % 12) + 12) % 12;
  return `${String(y).padStart(4, "0")}-${String(m + 1).padStart(2, "0")}-01`;
}

/** The last date of a month. */
export function monthEnd(month: MonthStart): LocalDate {
  return addDays(addMonths(month, 1), -1);
}

/** The first month a guest can see, and the last: today's, through the horizon's. */
export function monthBounds(today: LocalDate): { first: MonthStart; last: MonthStart } {
  return { first: monthOf(today), last: monthOf(addDays(today, horizonDays)) };
}

/** A month kept between today's and the horizon's. */
export function clampMonth(month: MonthStart, today: LocalDate): MonthStart {
  const { first, last } = monthBounds(today);
  return later(first, earlier(month, last));
}

/**
 * The dates a month asks the API for: the whole month, from today on. As the
 * list does (see windowOf), a month holding today asks for the day before
 * too, so a guest east of the marina still sees the marina's today.
 */
export function monthWindow(
  month: MonthStart,
  today: LocalDate,
): { from: LocalDate; to: LocalDate } {
  const end = monthEnd(month);
  return { from: month <= today ? later(month, addDays(today, -1)) : month, to: end };
}

/**
 * The calendar's weeks: Sunday to Saturday, from the week holding the 1st to
 * the week holding the last day. Dates outside the month are null.
 */
export function monthGrid(month: MonthStart): Array<Array<LocalDate | null>> {
  const end = monthEnd(month);
  const weeks: Array<Array<LocalDate | null>> = [];
  let day = addDays(month, -new Date(`${month}T12:00:00Z`).getUTCDay());
  while (day <= end) {
    const week: Array<LocalDate | null> = [];
    for (let i = 0; i < 7; i++) {
      week.push(day >= month && day <= end ? day : null);
      day = addDays(day, 1);
    }
    weeks.push(week);
  }
  return weeks;
}

export interface CalendarQuery {
  month: MonthStart;
  party: number;
  /** The date picked, if any; it may sit in another month only until the month loads. */
  date: LocalDate | null;
}

/**
 * Read `?month=YYYY-MM`, `?date=YYYY-MM-DD`, and `?party=` from the address. A
 * date picks its own month. An old list address (`?from=`) opens the month
 * holding that date. Anything unreadable falls back to this month.
 */
export function readCalendarQuery(search: string, today: LocalDate): CalendarQuery {
  const params = new URLSearchParams(search);
  const party = Number(params.get("party"));
  const date = params.get("date") ?? "";
  const monthParam = params.get("month") ?? "";
  const from = params.get("from") ?? "";
  const picked = isLocalDate(date) && date >= addDays(today, -1) ? date : null;
  const month = picked
    ? monthOf(picked)
    : /^\d{4}-\d{2}$/.test(monthParam) && isLocalDate(`${monthParam}-01`)
      ? `${monthParam}-01`
      : isLocalDate(from)
        ? monthOf(from)
        : monthOf(today);
  const clamped = clampMonth(month, today);
  return {
    month: clamped,
    party: partySizes.includes(party) ? party : 1,
    date: picked && monthOf(picked) === clamped ? picked : null,
  };
}

/** The address query for the calendar; empty for this month, one guest, no date picked. */
export function writeCalendarQuery(query: CalendarQuery, today: LocalDate): string {
  const params = new URLSearchParams();
  if (query.date) params.set("date", query.date);
  else if (query.month !== monthOf(today)) params.set("month", query.month.slice(0, 7));
  if (query.party !== 1) params.set("party", String(query.party));
  const text = params.toString();
  return text ? `?${text}` : "";
}

/** Seats left at or under this on a shared trip read as "few left". */
export const fewSeats = 4;

/** What a day in the calendar says about its trips. */
export interface DaySummary {
  count: number;
  /** A shared trip that day has `fewSeats` or fewer seats left. */
  few: boolean;
}

export function summarizeDays(trips: readonly AvailableTrip[]): Map<LocalDate, DaySummary> {
  const days = new Map<LocalDate, DaySummary>();
  for (const trip of trips) {
    const day = days.get(trip.localDate) ?? { count: 0, few: false };
    day.count += 1;
    if (trip.capacity.kind === "seats" && trip.capacity.remaining <= fewSeats) day.few = true;
    days.set(trip.localDate, day);
  }
  return days;
}
