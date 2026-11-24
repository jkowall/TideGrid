import type { Membership, StaffTrip } from "@tidegrid/contracts";
import {
  Button,
  cx,
  EmptyState,
  Skeleton,
  VisuallyHidden,
} from "@tidegrid/design-system/components";
import { formatDate, type LocalDate, todayIn } from "@tidegrid/design-system/format";
import { type ReactNode, useEffect, useRef, useState } from "react";
import { bookingsHref, type ListSource, readSource } from "../bookings/model.ts";
import { ConsoleLink } from "../navigation.tsx";
import { type FocusOnArrival, PageHeader } from "../PageHeader.tsx";
import { loadWeek, loadZone, type WeekFailure } from "./api.ts";
import { WeekFailed } from "./Calendar.tsx";
import {
  addMonths,
  clampMonth,
  type MonthStart,
  type MonthTone,
  monthBounds,
  monthOf,
  monthSeats,
  monthTone,
  monthToneLabels,
  monthWeeks,
  readMonth,
  tripStart,
} from "./model.ts";

/**
 * The operator's month at a glance (2026-11-24): every trip in a wall-calendar
 * grid, each as a short tag with its time, its name, and its seats, colored by
 * whether it is on sale, sold out, or not selling. A tag opens that trip's
 * bookings; a date opens its week in the week view, where trips are changed
 * and booked. Every role sees the same month; nothing changes here.
 *
 * One request covers the whole grid (at most six weeks, inside the API's 92
 * days). The month lives in the address as `?view=month&month=YYYY-MM`.
 */

type Load =
  | { kind: "loading" }
  | { kind: "ready"; trips: StaffTrip[] }
  | { kind: "failed"; reason: WeekFailure; failures: number; retrying: boolean };

/** A date shows this many trips; the rest are counted, and the date opens them all. */
const tagsPerDay = 4;

const monthFormat = new Intl.DateTimeFormat("en-US", {
  month: "long",
  year: "numeric",
  timeZone: "UTC",
});
const formatMonth = (month: MonthStart) => monthFormat.format(new Date(`${month}T12:00:00Z`));
const weekdays = [
  ["Sun", "Sunday"],
  ["Mon", "Monday"],
  ["Tue", "Tuesday"],
  ["Wed", "Wednesday"],
  ["Thu", "Thursday"],
  ["Fri", "Friday"],
  ["Sat", "Saturday"],
] as const;
const tones: MonthTone[] = ["on-sale", "held", "sold-out", "closed", "draft", "canceled", "done"];
const tripCount = (n: number) => (n === 1 ? "1 trip" : `${n} trips`);

export function MonthPage({
  membership,
  focusHeading,
  viewSwitch,
  onOpenWeek,
}: {
  membership: Membership;
  viewSwitch?: ReactNode;
  /** Open the week holding a date in the week view. */
  onOpenWeek: (date: LocalDate, month: string) => void;
} & FocusOnArrival) {
  const { tenantId, tenantName } = membership;
  const [zone, setZone] = useState<string | undefined>();
  const [month, setMonth] = useState<MonthStart | null>(() =>
    new URLSearchParams(window.location.search).has("month")
      ? readMonth(window.location.search, todayIn())
      : null,
  );
  const [load, setLoad] = useState<Load>({ kind: "loading" });
  const [attempt, setAttempt] = useState(0);
  const retryRequested = useRef(false);
  const heading = useRef<HTMLHeadingElement>(null);
  const focusOnMonth = useRef(false);
  /** After "Try again", the month's heading takes focus once trips arrive. */
  const focusOnLoad = useRef(false);
  // A source chosen in the week carries into each trip's bookings link.
  const [source] = useState<ListSource | undefined>(() => readSource(window.location.search));
  const today = todayIn(zone);
  const thisMonth = monthOf(today);
  const bounds = monthBounds(today);

  useEffect(() => {
    const controller = new AbortController();
    void loadZone(tenantId, controller.signal).then((found) => {
      if (controller.signal.aborted) return;
      if (found) setZone(found);
      setMonth((current) => current ?? clampMonth(todayIn(found), todayIn(found)));
    });
    return () => controller.abort();
  }, [tenantId]);

  const weeks = month ? monthWeeks(month) : [];
  const gridStart = weeks[0]?.[0];
  const gridEnd = weeks.at(-1)?.[6];

  useEffect(() => {
    void attempt;
    if (!gridStart || !gridEnd) return;
    const controller = new AbortController();
    const retry = retryRequested.current;
    retryRequested.current = false;
    setLoad((current) =>
      retry && current.kind === "failed" ? { ...current, retrying: true } : { kind: "loading" },
    );
    void loadWeek(tenantId, { from: gridStart, to: gridEnd }, controller.signal).then((result) => {
      if (controller.signal.aborted) return;
      if (result.kind === "ok") {
        setLoad({ kind: "ready", trips: result.trips });
        const named = result.trips[0]?.timeZone;
        if (named) setZone((known) => known ?? named);
        return;
      }
      setLoad((current) => ({
        kind: "failed",
        reason: result.reason,
        failures: current.kind === "failed" ? current.failures + 1 : 1,
        retrying: false,
      }));
    });
    return () => controller.abort();
  }, [tenantId, gridStart, gridEnd, attempt]);

  // The address keeps the month; this month leaves it out.
  useEffect(() => {
    if (!month) return;
    const params = new URLSearchParams(window.location.search);
    params.set("view", "month");
    // The week view's own place does not belong to the month.
    params.delete("week");
    if (month === thisMonth) params.delete("month");
    else params.set("month", month.slice(0, 7));
    const search = `?${params}`;
    if (search !== window.location.search) {
      const { pathname, hash } = window.location;
      window.history.replaceState(window.history.state, "", `${pathname}${search}${hash}`);
    }
  }, [month, thisMonth]);

  useEffect(() => {
    void month;
    if (focusOnMonth.current) {
      focusOnMonth.current = false;
      heading.current?.focus();
    }
  }, [month]);

  const retry = () => {
    retryRequested.current = true;
    focusOnLoad.current = true;
    setAttempt((n) => n + 1);
  };
  const goTo = (next: MonthStart, moveFocus = false) => {
    const target = clampMonth(next, today);
    if (target === month) {
      // The same month: ask again, and keep focus with it.
      if (moveFocus) heading.current?.focus();
      if (load.kind === "failed") retry();
      return;
    }
    // A new month drops a pending focus claim from Try again.
    focusOnLoad.current = false;
    if (moveFocus) focusOnMonth.current = true;
    setMonth(target);
  };

  useEffect(() => {
    if (load.kind === "ready" && focusOnLoad.current) {
      focusOnLoad.current = false;
      heading.current?.focus();
    }
  }, [load]);

  const trips = load.kind === "ready" ? load.trips : [];
  const inMonth = month ? trips.filter((t) => monthOf(t.localDate) === month) : [];
  const announcement = !month
    ? "Loading the calendar…"
    : load.kind === "loading"
      ? `Loading trips for ${formatMonth(month)}…`
      : load.kind === "ready"
        ? `${tripCount(inMonth.length)} in ${formatMonth(month)}.`
        : "";

  return (
    <>
      <PageHeader eyebrow={tenantName} title="Calendar" focusHeading={focusHeading} />
      <div className="cal cal--month">
        <div className="cal-bar">
          <h2 className="cal-bar__range" ref={heading} tabIndex={-1}>
            {month ? formatMonth(month) : <Skeleton width="12rem" height="1.5rem" />}
          </h2>
          <nav className="cal-bar__nav" aria-label="Months">
            <Button
              icon="chevron-left"
              disabled={!month || month <= bounds.first}
              onClick={() => month && goTo(addMonths(month, -1))}
            >
              <span className="cal-bar__word">Previous</span> <VisuallyHidden>month</VisuallyHidden>
            </Button>
            <Button disabled={!month || month === thisMonth} onClick={() => goTo(thisMonth)}>
              This month
            </Button>
            <Button
              icon="chevron-right"
              iconPosition="end"
              disabled={!month || month >= bounds.last}
              onClick={() => month && goTo(addMonths(month, 1))}
            >
              <span className="cal-bar__word">Next</span> <VisuallyHidden>month</VisuallyHidden>
            </Button>
          </nav>
          {viewSwitch}
        </div>

        <p className="tg-visually-hidden" role="status">
          {announcement}
        </p>

        {month && load.kind === "failed" && (
          <WeekFailed
            period="month"
            reason={load.reason}
            tenantName={tenantName}
            failures={load.failures}
            retrying={load.retrying}
            onRetry={retry}
            onThisWeek={() => goTo(thisMonth, true)}
          />
        )}

        {month && load.kind !== "failed" && (
          <>
            <MonthGrid
              month={month}
              weeks={weeks}
              today={today}
              trips={load.kind === "ready" ? trips : null}
              source={source}
              onOpenWeek={(date) => onOpenWeek(date, (month ?? thisMonth).slice(0, 7))}
            />
            <ul className="cal-month__legend">
              {tones.map((tone) => (
                <li key={tone}>
                  <span className={cx("cal-month__swatch", `cal-month__tag--${tone}`)} />
                  {monthToneLabels[tone]}
                </li>
              ))}
            </ul>
            <p className="cal-month__hint">
              Pick a date to open its week, where you book, close sales, and cancel. Pick a trip to
              see its bookings.
            </p>
            {load.kind === "ready" && inMonth.length === 0 && (
              <EmptyState
                icon="calendar"
                title={`No trips in ${formatMonth(month)}`}
                actions={
                  month !== thisMonth ? (
                    <Button icon="calendar" onClick={() => goTo(thisMonth, true)}>
                      Go to this month
                    </Button>
                  ) : undefined
                }
              >
                <p>Trips appear here once a schedule creates them.</p>
              </EmptyState>
            )}
          </>
        )}
      </div>
    </>
  );
}

function MonthGrid({
  month,
  weeks,
  today,
  trips,
  source,
  onOpenWeek,
}: {
  month: MonthStart;
  source: ListSource | undefined;
  weeks: LocalDate[][];
  today: LocalDate;
  /** Null while loading. */
  trips: readonly StaffTrip[] | null;
  onOpenWeek: (date: LocalDate) => void;
}) {
  const now = new Date();
  const byDay = new Map<LocalDate, StaffTrip[]>();
  for (const trip of trips ?? []) {
    const list = byDay.get(trip.localDate);
    if (list) list.push(trip);
    else byDay.set(trip.localDate, [trip]);
  }
  for (const list of byDay.values())
    list.sort((a, b) => Date.parse(a.startsAt) - Date.parse(b.startsAt));

  return (
    <table className="cal-month" aria-busy={trips === null || undefined}>
      <caption className="tg-visually-hidden">Trips in {formatMonth(month)}</caption>
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
        {weeks.map((week) => (
          <tr key={week[0]}>
            {week.map((date) => {
              const dayTrips = byDay.get(date) ?? [];
              const outside = monthOf(date) !== month;
              const isToday = date === today;
              const shown = dayTrips.slice(0, tagsPerDay);
              const more = dayTrips.length - shown.length;
              return (
                <td
                  key={date}
                  className={cx(
                    "cal-month__day",
                    outside && "cal-month__day--outside",
                    isToday && "cal-month__day--today",
                  )}
                >
                  <button
                    type="button"
                    className="cal-month__date"
                    onClick={() => onOpenWeek(date)}
                    aria-current={isToday ? "date" : undefined}
                  >
                    <span aria-hidden="true">{Number(date.slice(8))}</span>
                    {dayTrips.length > 0 && (
                      <span className="cal-month__count" aria-hidden="true">
                        {tripCount(dayTrips.length)}
                      </span>
                    )}
                    <VisuallyHidden>
                      {formatDate(date, "full")}
                      {isToday ? ", today" : ""}
                      {trips
                        ? `, ${dayTrips.length === 0 ? "no trips" : tripCount(dayTrips.length)}`
                        : ""}
                      . Open its week
                    </VisuallyHidden>
                  </button>
                  {trips === null && !outside && (
                    <Skeleton className="cal-month__skeleton" height="1rem" />
                  )}
                  {shown.length > 0 && (
                    <ul className="cal-month__tags">
                      {shown.map((trip) => (
                        <MonthTag key={trip.tripId} trip={trip} now={now} source={source} />
                      ))}
                      {more > 0 && (
                        <li>
                          <button
                            type="button"
                            className="cal-month__more"
                            onClick={() => onOpenWeek(date)}
                          >
                            {more} more{" "}
                            <VisuallyHidden>on {formatDate(date, "full")}</VisuallyHidden>
                          </button>
                        </li>
                      )}
                    </ul>
                  )}
                </td>
              );
            })}
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function MonthTag({
  trip,
  now,
  source,
}: {
  trip: StaffTrip;
  now: Date;
  source: ListSource | undefined;
}) {
  const tone = monthTone(trip, now);
  const seats = monthSeats(trip, tone);
  const start = tripStart(trip);
  return (
    <li>
      <ConsoleLink
        className={cx("cal-month__tag", `cal-month__tag--${tone}`)}
        href={bookingsHref(trip.localDate, trip.tripId, source)}
        title={`${trip.productName}: ${monthToneLabels[tone]}, ${seats.long}`}
      >
        <span className="cal-month__tag-time" aria-hidden="true">
          {start
            .replace(/:00(?=\s?[AP]M)/, "")
            .replace(/\s?([AP])M/, (_, p: string) => p.toLowerCase())}
        </span>
        <span className="cal-month__tag-name" aria-hidden="true">
          {trip.productName}
        </span>
        <span className="cal-month__tag-seats" aria-hidden="true">
          {seats.short}
        </span>
        <VisuallyHidden>
          {`${start}, ${trip.productName}, ${trip.boatName}: ${monthToneLabels[tone].toLowerCase()}, ${seats.long}. Open its bookings`}
        </VisuallyHidden>
      </ConsoleLink>
    </li>
  );
}
