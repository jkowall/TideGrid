import type { AvailableTrip } from "@tidegrid/contracts";
import {
  Button,
  cx,
  EmptyState,
  SelectField,
  Spinner,
  VisuallyHidden,
} from "@tidegrid/design-system/components";
import {
  addDays,
  formatDate,
  type LocalDate,
  later,
  todayIn,
} from "@tidegrid/design-system/format";
import { type ReactNode, useEffect, useRef, useState } from "react";
import {
  addMonths,
  type CalendarQuery,
  clampMonth,
  type DaySummary,
  loadTrips,
  type MonthStart,
  monthBounds,
  monthEnd,
  monthGrid,
  monthOf,
  monthWindow,
  readCalendarQuery,
  summarizeDays,
  type TripsFailure,
  writeCalendarQuery,
} from "./trips.ts";
import {
  guests,
  partyOptions,
  TimeNote,
  TripList,
  TripListSkeleton,
  TripsFailed,
} from "./UpcomingTrips.tsx";

/**
 * Upcoming trips as a month to pick a date from. Each date with a trip open
 * for the party is a button that says how many ("2 trips") and whether seats
 * are running low ("Few left"); picking one shows that day's trips below or
 * beside the month, each with the list's own card and Book link. Dates with
 * nothing open are plain text, so the keyboard visits only dates that lead
 * somewhere. The month, the date, and the party live in the address.
 *
 * Until the guest picks a date, the first date in the month with a trip is
 * shown; that choice stays out of the address, so a reload or a new month
 * picks again from what is open then.
 */

interface Loaded {
  query: CalendarQuery;
  trips: AvailableTrip[];
}

type State =
  /** `previous`: the month shown before this load, kept while the same month loads for another party. */
  | { kind: "loading"; previous?: Loaded | undefined }
  | { kind: "ready"; loaded: Loaded }
  | { kind: "failed"; reason: TripsFailure; retrying: boolean; failures: number };

const monthFormat = new Intl.DateTimeFormat("en-US", {
  month: "long",
  year: "numeric",
  timeZone: "UTC",
});
const monthName = new Intl.DateTimeFormat("en-US", { month: "long", timeZone: "UTC" });
const noon = (date: LocalDate) => new Date(`${date}T12:00:00Z`);

/** "December 2026" */
export const formatMonth = (month: MonthStart) => monthFormat.format(noon(month));

const weekdays = [
  ["Sun", "Sunday"],
  ["Mon", "Monday"],
  ["Tue", "Tuesday"],
  ["Wed", "Wednesday"],
  ["Thu", "Thursday"],
  ["Fri", "Friday"],
  ["Sat", "Saturday"],
] as const;

const tripCount = (n: number) => (n === 1 ? "1 trip" : `${n} trips`);
const sameMonth = (a: CalendarQuery, b: CalendarQuery) => a.month === b.month;

export function TripCalendar({ viewSwitch }: { viewSwitch?: ReactNode }) {
  const [today] = useState(() => todayIn());
  const [query, setQuery] = useState<CalendarQuery>(() =>
    readCalendarQuery(window.location.search, today),
  );
  const [attempt, setAttempt] = useState(0);
  const [state, setState] = useState<State>({ kind: "loading" });
  const [announce, setAnnounce] = useState("");
  const monthLabel = useRef<HTMLHeadingElement>(null);
  const dayPanel = useRef<HTMLDivElement>(null);
  const retryRequested = useRef(false);
  /** The month's name takes focus once a new month renders from a control that goes away. */
  const focusMonth = useRef(false);
  /** After "Try again" or a jump back to today, the month's name takes focus once it loads. */
  const focusMonthOnLoad = useRef(false);
  /**
   * Opened with nothing in the address: if this month has nothing left open,
   * such as on its last day, show the next month once instead.
   */
  const advanceIfEmpty = useRef(window.location.search === "");

  const { month, party } = query;
  useEffect(() => {
    void attempt;
    const controller = new AbortController();
    const retry = retryRequested.current;
    retryRequested.current = false;
    const asked: CalendarQuery = { month, party, date: null };
    setState((current) => {
      if (retry && current.kind === "failed") return { ...current, retrying: true };
      const shown =
        current.kind === "ready"
          ? current.loaded
          : current.kind === "loading"
            ? current.previous
            : undefined;
      // The same month for another party: keep it while the new one loads.
      return {
        kind: "loading",
        previous: shown && sameMonth(shown.query, asked) ? shown : undefined,
      };
    });
    const { from, to } = monthWindow(month, today);
    void loadTrips({ from, to, party }, controller.signal).then((result) => {
      if (controller.signal.aborted) return;
      if (result.kind === "ok") {
        setState({ kind: "ready", loaded: { query: asked, trips: result.trips } });
        return;
      }
      // A failed retry gives up its claim on focus, so a later load for
      // another reason never pulls focus from the control in use.
      focusMonthOnLoad.current = false;
      setState((current) => ({
        kind: "failed",
        reason: result.reason,
        retrying: false,
        failures: current.kind === "failed" ? current.failures + 1 : 1,
      }));
    });
    return () => controller.abort();
  }, [month, party, today, attempt]);

  // The address keeps the month, the date, and the party.
  useEffect(() => {
    const search = writeCalendarQuery(query, today);
    if (search !== window.location.search) {
      const { pathname, hash } = window.location;
      window.history.replaceState(window.history.state, "", `${pathname}${search}${hash}`);
    }
  }, [query, today]);

  useEffect(() => {
    void month;
    if (focusMonth.current) {
      focusMonth.current = false;
      monthLabel.current?.focus();
    }
  }, [month]);

  useEffect(() => {
    if (state.kind !== "ready") return;
    if (focusMonthOnLoad.current) {
      focusMonthOnLoad.current = false;
      monthLabel.current?.focus();
    }
    const shouldAdvance = advanceIfEmpty.current;
    advanceIfEmpty.current = false;
    if (shouldAdvance && state.loaded.trips.length === 0) {
      setQuery((q) =>
        q.month === state.loaded.query.month
          ? { ...q, month: clampMonth(addMonths(q.month, 1), today) }
          : q,
      );
    }
  }, [state, today]);

  const { first, last } = monthBounds(today);
  const canPrevious = month > first;
  const canNext = month < last;
  const goToMonth = (next: MonthStart, moveFocus = false) => {
    advanceIfEmpty.current = false;
    setQuery((q) => ({ ...q, month: clampMonth(next, today), date: null }));
    setAnnounce("");
    if (moveFocus) focusMonth.current = true;
  };
  const setParty = (next: number, moveFocus = false) => {
    advanceIfEmpty.current = false;
    setQuery((q) => ({ ...q, party: next }));
    setAnnounce("");
    if (moveFocus) focusMonthOnLoad.current = true;
  };
  const retry = () => {
    retryRequested.current = true;
    focusMonthOnLoad.current = true;
    setAttempt((n) => n + 1);
  };

  const loaded = state.kind === "ready" ? state.loaded : undefined;
  const previous = state.kind === "loading" ? state.previous : undefined;
  const current = loaded && loaded.query.month === month && loaded.query.party === party;
  const updating = !current && state.kind === "loading" && previous !== undefined;
  const shown = current ? loaded : updating ? previous : undefined;
  const days = shown ? summarizeDays(shown.trips) : new Map<LocalDate, DaySummary>();
  const tripDates = [...days.keys()].sort();
  // The window starts at the marina's today at the earliest, so the first date
  // with a trip is the soonest a guest can book.
  const picked = query.date && days.has(query.date) ? query.date : (tripDates[0] ?? null);
  const dayTrips = shown && picked ? shown.trips.filter((t) => t.localDate === picked) : [];

  // A date picked for another party that has nothing open now leaves the address.
  const staleDate = current && query.date !== null && !days.has(query.date);
  useEffect(() => {
    if (staleDate) setQuery((q) => ({ ...q, date: null }));
  }, [staleDate]);

  const pick = (date: LocalDate) => {
    setQuery((q) => ({ ...q, date }));
    const summary = days.get(date);
    setAnnounce(`${formatDate(date, "full")}: ${tripCount(summary?.count ?? 0)}.`);
    // On a phone the day's trips sit under the month: bring them up.
    if (window.matchMedia?.("(max-width: 47.99rem)").matches) {
      const still = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
      dayPanel.current?.scrollIntoView?.({ block: "start", behavior: still ? "auto" : "smooth" });
    }
  };

  const status = current
    ? `${tripCount(shown?.trips.length ?? 0)} in ${formatMonth(month)}, on ${tripDates.length} ${tripDates.length === 1 ? "date" : "dates"}, for ${guests(party)}.`
    : state.kind === "loading" && !updating
      ? "Loading trips…"
      : "";

  return (
    <section aria-labelledby="trips-title" className="guest-section trips">
      <div className="trips__head">
        <div className="trips__title-row">
          <h2 id="trips-title" tabIndex={-1}>
            Upcoming trips
          </h2>
          {viewSwitch}
        </div>
        {shown && shown.trips.length > 0 && (
          <TimeNote trips={shown.trips} start={later(month, today)} end={monthEnd(month)} />
        )}
      </div>

      <div className="trips__controls trips__controls--calendar">
        <SelectField
          className="trips__party"
          label="Party size"
          options={partyOptions}
          value={String(party)}
          onChange={(event) => setParty(Number(event.target.value))}
        />
      </div>

      <p className="tg-visually-hidden" role="status">
        {announce || status}
      </p>

      {
        <div className="trip-calendar">
          <div className="trip-calendar__month" aria-busy={!current || undefined}>
            <div className="trip-calendar__nav">
              <Button
                icon="chevron-left"
                className="trip-calendar__step"
                disabled={!canPrevious}
                onClick={() => goToMonth(addMonths(month, -1))}
              >
                <VisuallyHidden>Previous month, {formatMonth(addMonths(month, -1))}</VisuallyHidden>
              </Button>
              <h3 className="trip-calendar__title" ref={monthLabel} tabIndex={-1}>
                {formatMonth(month)}
              </h3>
              <Button
                icon="chevron-right"
                className="trip-calendar__step"
                disabled={!canNext}
                onClick={() => goToMonth(addMonths(month, 1))}
              >
                <VisuallyHidden>Next month, {formatMonth(addMonths(month, 1))}</VisuallyHidden>
              </Button>
            </div>
            <MonthGrid
              month={month}
              today={today}
              days={days}
              picked={picked}
              loading={!shown && state.kind !== "failed"}
              onPick={pick}
            />
            {updating && (
              <p className="trips__updating">
                <Spinner />
                Updating for {guests(party)}…
              </p>
            )}
            <ul className="trip-calendar__legend" aria-hidden="true">
              <li>
                <span className="trip-calendar__swatch trip-calendar__swatch--open" />
                Trips open
              </li>
              <li>
                <span className="trip-calendar__swatch" />
                Nothing open
              </li>
              <li className="trip-calendar__legend-few">"Few left": 4 seats or fewer</li>
            </ul>
          </div>

          <div className="trip-calendar__day" ref={dayPanel}>
            {state.kind === "failed" && (
              <TripsFailed
                reason={state.reason}
                failures={state.failures}
                retrying={state.retrying}
                onRetry={retry}
                onFromToday={() => {
                  if (month === first) retry();
                  else {
                    focusMonthOnLoad.current = true;
                    goToMonth(first);
                  }
                }}
              />
            )}
            {!shown && state.kind !== "failed" && <TripListSkeleton />}
            {shown && picked && (
              <TripList trips={dayTrips} busy={updating} party={shown.query.party} />
            )}
            {shown && shown.trips.length === 0 && (
              <EmptyState
                icon="calendar"
                headingLevel={3}
                title={`Nothing open in ${monthName.format(noon(month))}`}
                actions={
                  canNext ? (
                    <Button
                      icon="chevron-right"
                      iconPosition="end"
                      onClick={() => goToMonth(addMonths(month, 1), true)}
                    >
                      Try {monthName.format(noon(addMonths(month, 1)))}
                    </Button>
                  ) : party > 1 ? (
                    <Button onClick={() => setParty(1, true)}>Show trips for 1 guest</Button>
                  ) : undefined
                }
              >
                <p>
                  No trips are open for {guests(party)} in {formatMonth(month)}. Try another month
                  {party > 1 ? " or a smaller party" : ""}.
                </p>
              </EmptyState>
            )}
          </div>
        </div>
      }
    </section>
  );
}

/**
 * The month's weeks, with the week before when a trip falls in it: the
 * marina's today, seen by a guest whose month began on a Sunday.
 */
function weeksFor(month: MonthStart, days: Map<LocalDate, DaySummary>): LocalDate[][] {
  const weeks = monthGrid(month);
  const first = weeks[0]?.[0];
  if (first && [...days.keys()].some((date) => date < first)) {
    const before = addDays(first, -7);
    weeks.unshift(Array.from({ length: 7 }, (_, i) => addDays(before, i)));
  }
  return weeks;
}

function MonthGrid({
  month,
  today,
  days,
  picked,
  loading,
  onPick,
}: {
  month: MonthStart;
  today: LocalDate;
  days: Map<LocalDate, DaySummary>;
  picked: LocalDate | null;
  loading: boolean;
  onPick: (date: LocalDate) => void;
}) {
  return (
    <table className="trip-calendar__grid">
      <caption className="tg-visually-hidden">
        {formatMonth(month)}. Dates with trips open can be picked.
      </caption>
      <thead>
        <tr>
          {weekdays.map(([short, long]) => (
            <th key={short} scope="col" abbr={long}>
              {short}
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {weeksFor(month, days).map((week) => (
          <tr key={week[0]}>
            {week.map((date) => {
              const day = days.get(date);
              // Another month's date shows only when it holds a trip: the
              // marina's today, seen from a guest whose month has turned.
              if (!day && monthOf(date) !== month) return <td key={date} />;
              const number = Number(date.slice(8));
              const isToday = date === today;
              if (!day) {
                return (
                  <td key={date}>
                    <span
                      className={cx(
                        "trip-calendar__date",
                        date < today && "trip-calendar__date--past",
                        isToday && "trip-calendar__date--today",
                        loading && "trip-calendar__date--loading",
                      )}
                    >
                      <span aria-hidden="true">{number}</span>
                      <VisuallyHidden>
                        {formatDate(date, "full")}
                        {loading ? "" : ", nothing open"}
                      </VisuallyHidden>
                    </span>
                  </td>
                );
              }
              const isPicked = date === picked;
              return (
                <td key={date}>
                  <button
                    type="button"
                    className={cx(
                      "trip-calendar__date",
                      "trip-calendar__date--open",
                      day.few && "trip-calendar__date--few",
                      isPicked && "trip-calendar__date--picked",
                      isToday && "trip-calendar__date--today",
                    )}
                    aria-pressed={isPicked}
                    onClick={() => onPick(date)}
                  >
                    <span className="trip-calendar__number" aria-hidden="true">
                      {number}
                    </span>
                    <span className="trip-calendar__count" aria-hidden="true">
                      <span className="trip-calendar__count-long">
                        {day.few ? "Few left" : tripCount(day.count)}
                      </span>
                      <span className="trip-calendar__count-short">
                        {day.few ? "Few" : day.count}
                      </span>
                    </span>
                    <VisuallyHidden>
                      {formatDate(date, "full")}
                      {isToday ? ", today" : ""}, {tripCount(day.count)}
                      {day.few ? ", few seats left" : ""}
                    </VisuallyHidden>
                  </button>
                </td>
              );
            })}
          </tr>
        ))}
      </tbody>
    </table>
  );
}
