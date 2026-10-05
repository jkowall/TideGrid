import type { Membership, StaffTrip } from "@tidegrid/contracts";
import {
  Button,
  ButtonLink,
  EmptyState,
  Icon,
  Notice,
  Skeleton,
  StatusBadge,
  VisuallyHidden,
} from "@tidegrid/design-system/components";
import {
  addDays,
  clockChanges,
  describeClockChange,
  formatCutoff,
  formatDate,
  formatDateRange,
  formatTripTime,
  formatWeekday,
  type LocalDate,
  startOfWeek,
  todayIn,
  zoneCity,
} from "@tidegrid/design-system/format";
import { type MouseEvent, type ReactNode, useCallback, useEffect, useRef, useState } from "react";
import { type FocusOnArrival, PageHeader } from "../PageHeader.tsx";
import { canChangeTrips, roleNames } from "../roles.ts";
import { ActionDialog } from "./ActionDialog.tsx";
import { loadWeek, loadZone, type WeekFailure } from "./api.ts";
import {
  type ActionKind,
  actionCopy,
  actionsFor,
  capacityText,
  clampWeek,
  cutoffPassed,
  hasDeparted,
  readWeek,
  salesStates,
  tripLine,
  tripStart,
  weekBounds,
  weekOf,
} from "./model.ts";

/**
 * The operator's week: every trip from Sunday to Saturday in any sales
 * state, by the marina's local date. Owners and booking staff publish, close,
 * reopen, cancel, and complete trips from here; finance sees the same week
 * with no controls.
 *
 * The shell keys this page on the operator, so switching operators starts it
 * afresh: its zone, week, dialog, and last change never carry over.
 */

type Load =
  | { kind: "loading" }
  | { kind: "ready"; trips: StaffTrip[] }
  /** `retrying`: "Try again" is working; the notice stays so focus stays on it. */
  | { kind: "failed"; reason: WeekFailure; failures: number; retrying: boolean };

interface OpenDialog {
  trip: StaffTrip;
  kind: ActionKind;
}

/** The last change made here: shown on its trip, and said by the status line. */
interface Done {
  tripId: string;
  /** "Sales closed" */
  what: string;
  /** "Sales closed: Sunset Harbor Cruise, Sun, Nov 1, 6:00 PM." */
  message: string;
}

const tripHeadingId = (tripId: string) => `trip-${tripId}`;
const dayHeadingId = (date: LocalDate) => `day-${date}`;
/** Marks each change button, so focus can find it again after the dialog. */
const actionKey = (tripId: string, kind: ActionKind) => `${tripId}:${kind}`;

export function CalendarPage({
  membership,
  focusHeading,
}: { membership: Membership } & FocusOnArrival) {
  const { tenantId, tenantName, role } = membership;
  const canChange = canChangeTrips(role);
  /**
   * The marina's zone, read from the operator's catalog before the first week
   * loads, so "this week" and "today" are the marina's, not the viewer's. If
   * the catalog cannot be read, the first week of trips names it instead.
   */
  const [zone, setZone] = useState<string | undefined>();
  // A week in the address is known at once; otherwise it waits for the zone.
  const [weekStart, setWeekStart] = useState<LocalDate | null>(() =>
    new URLSearchParams(window.location.search).has("week")
      ? readWeek(window.location.search, todayIn())
      : null,
  );
  const [load, setLoad] = useState<Load>({ kind: "loading" });
  const [attempt, setAttempt] = useState(0);
  const [dialog, setDialog] = useState<OpenDialog | null>(null);
  const [done, setDone] = useState<Done | null>(null);
  const retryRequested = useRef(false);
  const focusRangeOnLoad = useRef(false);
  /** The week's heading takes focus once the new week renders; see goToWeek. */
  const focusRangeOnWeek = useRef(false);
  /**
   * Where focus goes once the dialog is gone. After a change, the trip's
   * heading: its buttons are different now. After a dismissal, the button that
   * opened the dialog, or the heading if that button no longer exists. The
   * calendar decides this itself rather than trusting "the element focused
   * before the dialog": Safari does not focus a button on click.
   */
  const focusAfterDialog = useRef<{ tripId: string; kind: ActionKind; changed: boolean } | null>(
    null,
  );
  const range = useRef<HTMLHeadingElement>(null);
  const today = todayIn(zone);
  const thisWeek = startOfWeek(today);
  const bounds = weekBounds(today);
  const week = weekStart ? weekOf(weekStart) : undefined;

  useEffect(() => {
    const controller = new AbortController();
    void loadZone(tenantId, controller.signal).then((found) => {
      if (controller.signal.aborted) return;
      if (found) setZone(found);
      setWeekStart((current) => current ?? startOfWeek(todayIn(found)));
    });
    return () => controller.abort();
  }, [tenantId]);

  useEffect(() => {
    // `attempt` is a dependency so "Try again" reruns this effect.
    void attempt;
    if (!weekStart) return;
    const controller = new AbortController();
    const retry = retryRequested.current;
    retryRequested.current = false;
    setLoad((current) =>
      retry && current.kind === "failed" ? { ...current, retrying: true } : { kind: "loading" },
    );
    const { start, end } = weekOf(weekStart);
    void loadWeek(tenantId, { from: start, to: end }, controller.signal).then((result) => {
      if (controller.signal.aborted) return;
      if (result.kind === "ok") {
        setLoad({ kind: "ready", trips: result.trips });
        const named = result.trips[0]?.timeZone;
        if (named) setZone((known) => known ?? named);
        return;
      }
      focusRangeOnLoad.current = false;
      setLoad((current) => ({
        kind: "failed",
        reason: result.reason,
        failures: current.kind === "failed" ? current.failures + 1 : 1,
        retrying: false,
      }));
    });
    return () => controller.abort();
  }, [tenantId, weekStart, attempt]);

  // A new week starts without the last change's confirmation.
  useEffect(() => {
    void weekStart;
    setDone(null);
    if (focusRangeOnWeek.current) {
      focusRangeOnWeek.current = false;
      range.current?.focus();
    }
  }, [weekStart]);

  // The address keeps the week, so a reload shows the same one.
  useEffect(() => {
    if (!weekStart) return;
    const params = new URLSearchParams(window.location.search);
    if (weekStart === thisWeek) params.delete("week");
    else params.set("week", weekStart);
    const search = params.toString() ? `?${params}` : "";
    if (search !== window.location.search) {
      const { pathname, hash } = window.location;
      window.history.replaceState(window.history.state, "", `${pathname}${search}${hash}`);
    }
  }, [weekStart, thisWeek]);

  // "Try again" is gone once the week arrives, so the week's heading takes focus.
  useEffect(() => {
    if (load.kind === "ready" && focusRangeOnLoad.current) {
      focusRangeOnLoad.current = false;
      range.current?.focus();
    }
  }, [load]);

  // After the dialog closes, the trip it was about keeps the person's place.
  useEffect(() => {
    const target = focusAfterDialog.current;
    if (dialog || !target) return;
    focusAfterDialog.current = null;
    const opener = target.changed
      ? null
      : document.querySelector<HTMLElement>(
          `[data-trip-action="${actionKey(target.tripId, target.kind)}"]`,
        );
    (opener ?? document.getElementById(tripHeadingId(target.tripId)))?.focus();
  }, [dialog]);

  /** Reload the week without the loading screen, after a trip changed under the person. */
  const refresh = useCallback(async () => {
    if (!weekStart) return undefined;
    const { start, end } = weekOf(weekStart);
    const result = await loadWeek(tenantId, { from: start, to: end });
    if (result.kind !== "ok") return undefined;
    setLoad({ kind: "ready", trips: result.trips });
    return result.trips;
  }, [tenantId, weekStart]);

  const retry = () => {
    retryRequested.current = true;
    focusRangeOnLoad.current = true;
    setAttempt((n) => n + 1);
  };

  /**
   * Show another week. `moveFocus`: the control pressed goes away with the
   * change, such as an empty week's "Go to this week", so the week's heading
   * takes focus and the person keeps their place.
   */
  const goToWeek = (start: LocalDate, moveFocus = false) => {
    const next = clampWeek(start, today);
    if (moveFocus) {
      if (next === weekStart) range.current?.focus();
      else focusRangeOnWeek.current = true;
    }
    setWeekStart(next);
  };

  const close = () => {
    if (dialog) {
      focusAfterDialog.current = { tripId: dialog.trip.tripId, kind: dialog.kind, changed: false };
    }
    setDialog(null);
  };

  const finish = (trip: StaffTrip, replayed: boolean) => {
    if (!dialog) return;
    const copy = actionCopy[dialog.kind];
    setLoad((current) =>
      current.kind === "ready"
        ? { kind: "ready", trips: current.trips.map((t) => (t.tripId === trip.tripId ? trip : t)) }
        : current,
    );
    setDone({
      tripId: trip.tripId,
      what: copy.done,
      message: `${copy.done}: ${tripLine(trip)}.`,
    });
    focusAfterDialog.current = { tripId: trip.tripId, kind: dialog.kind, changed: true };
    setDialog(null);
    // A replayed answer is the trip as it was when the change was first made;
    // reload the week to show it as it is now.
    if (replayed) void refresh();
  };

  const trips = load.kind === "ready" ? load.trips : [];
  const announcement = !week
    ? "Loading the calendar…"
    : load.kind === "loading"
      ? `Loading trips for ${formatDateRange(week.start, week.end)}…`
      : load.kind === "ready"
        ? (done?.message ?? weekSummary(trips, week.start, week.end))
        : "";

  return (
    <>
      <PageHeader eyebrow={tenantName} title="Calendar" focusHeading={focusHeading} />
      <div className="cal">
        <div className="cal-bar">
          <h2 className="cal-bar__range" ref={range} tabIndex={-1}>
            {week ? (
              formatDateRange(week.start, week.end)
            ) : (
              <Skeleton width="12rem" height="1.5rem" />
            )}
          </h2>
          <nav className="cal-bar__nav" aria-label="Weeks">
            <Button
              icon="chevron-left"
              disabled={!weekStart || weekStart <= bounds.first}
              onClick={() => weekStart && goToWeek(addDays(weekStart, -7))}
            >
              <span className="cal-bar__word">Previous</span> <VisuallyHidden>week</VisuallyHidden>
            </Button>
            <Button disabled={!weekStart || weekStart === thisWeek} onClick={() => goToWeek(today)}>
              This week
            </Button>
            <Button
              icon="chevron-right"
              iconPosition="end"
              disabled={!weekStart || weekStart >= bounds.last}
              onClick={() => weekStart && goToWeek(addDays(weekStart, 7))}
            >
              <span className="cal-bar__word">Next</span> <VisuallyHidden>week</VisuallyHidden>
            </Button>
          </nav>
        </div>

        {!canChange && (
          <p className="cal-readonly">
            <Icon name="lock" />
            <span>
              View only. Your role here, {roleNames[role]}, can see trips but not change them.
            </span>
          </p>
        )}

        <p className="tg-visually-hidden" role="status">
          {announcement}
        </p>

        {(!week || load.kind === "loading") && <WeekSkeleton />}

        {week && load.kind === "failed" && (
          <WeekFailed
            reason={load.reason}
            tenantName={tenantName}
            failures={load.failures}
            retrying={load.retrying}
            onRetry={retry}
            onThisWeek={() => goToWeek(today, true)}
          />
        )}

        {week &&
          load.kind === "ready" &&
          (trips.length === 0 ? (
            <EmptyState
              icon="calendar"
              title="No trips this week"
              actions={
                weekStart !== thisWeek ? (
                  <Button icon="calendar" onClick={() => goToWeek(today, true)}>
                    Go to this week
                  </Button>
                ) : undefined
              }
            >
              <p>
                Nothing is scheduled for {tenantName} from{" "}
                {formatDateRange(week.start, week.end, "medium", { year: "always" })}. Trips appear
                here once a schedule creates them.
              </p>
            </EmptyState>
          ) : (
            <Week
              days={week.days}
              trips={trips}
              today={today}
              canChange={canChange}
              done={done}
              onAction={(trip, kind) => setDialog({ trip, kind })}
            />
          ))}
      </div>
      {dialog && (
        <ActionDialog
          // One dialog per trip and change: no reason or key carries over.
          key={actionKey(dialog.trip.tripId, dialog.kind)}
          membership={membership}
          trip={dialog.trip}
          kind={dialog.kind}
          onClose={close}
          onDone={finish}
          onStale={async () => {
            const reloaded = await refresh();
            return reloaded
              ? { reloaded: true, trip: reloaded.find((t) => t.tripId === dialog.trip.tripId) }
              : { reloaded: false };
          }}
        />
      )}
    </>
  );
}

function weekSummary(trips: readonly StaffTrip[], start: LocalDate, end: LocalDate): string {
  const count = trips.length === 1 ? "1 trip" : `${trips.length} trips`;
  return `${count} from ${formatDateRange(start, end, "full")}.`;
}

const failureText: Record<WeekFailure, { title: string; body: (tenant: string) => string }> = {
  signed_out: {
    title: "You're signed out",
    body: () => "Sign in again to see the calendar.",
  },
  forbidden: {
    title: "Your role can't see these trips",
    body: (tenant) => `Ask an owner of ${tenant} for access to the calendar.`,
  },
  suspended: {
    title: "This operator is suspended",
    body: (tenant) => `The calendar for ${tenant} is unavailable while it is suspended.`,
  },
  not_found: {
    title: "You no longer have access to this operator",
    body: (tenant) => `Your membership of ${tenant} may have ended. Ask one of its owners.`,
  },
  rejected: {
    title: "This week can't be shown",
    body: () => "The calendar shows weeks within two years of today.",
  },
  unreadable: {
    title: "Trips couldn't be shown",
    body: () => "TideGrid sent trips this console can't read. Try again in a moment.",
  },
  unreachable: {
    title: "The calendar can't reach TideGrid",
    body: () => "Check your connection, then try again.",
  },
  unavailable: {
    title: "Trips didn't load",
    body: () => "TideGrid isn't responding right now. Try again in a moment.",
  },
};

function WeekFailed({
  reason,
  tenantName,
  failures,
  retrying,
  onRetry,
  onThisWeek,
}: {
  reason: WeekFailure;
  tenantName: string;
  failures: number;
  retrying: boolean;
  onRetry: () => void;
  onThisWeek: () => void;
}) {
  const text = failureText[reason];
  const canRetry = reason === "unreachable" || reason === "unavailable" || reason === "unreadable";
  let action: ReactNode;
  if (reason === "signed_out") {
    action = (
      <ButtonLink variant="primary" icon="arrow-left" href="/">
        Sign in again
      </ButtonLink>
    );
  } else if (reason === "rejected") {
    action = (
      <Button variant="primary" icon="calendar" onClick={onThisWeek}>
        Go to this week
      </Button>
    );
  } else if (canRetry) {
    action = (
      <Button
        variant="primary"
        icon="refresh"
        busy={retrying}
        busyLabel="Trying again…"
        onClick={onRetry}
      >
        Try again
      </Button>
    );
  }
  return (
    <Notice
      tone="error"
      className="cal-notice"
      title={canRetry && failures > 1 ? "Trips still aren't loading" : text.title}
      actions={action}
    >
      <p>{text.body(tenantName)}</p>
    </Notice>
  );
}

function WeekSkeleton() {
  return (
    <div className="cal-week cal-week--skeleton" aria-hidden="true">
      <div className="cal-strip cal-strip--skeleton">
        {Array.from({ length: 7 }, (_, i) => (
          <Skeleton key={i} height="4rem" />
        ))}
      </div>
      {[2, 1].map((count, day) => (
        <div key={day} className="cal-day">
          <Skeleton width="14rem" height="1.25rem" />
          <div className="cal-day__trips">
            {Array.from({ length: count }, (_, row) => (
              <div key={row} className="cal-trip cal-trip--skeleton">
                <Skeleton width="5rem" height="1.25rem" />
                <div className="cal-trip__main">
                  <Skeleton width="min(16rem, 70%)" height="1.25rem" />
                  <Skeleton variant="text" width="min(22rem, 90%)" />
                </div>
              </div>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}

/** Whose clock the times are on, and any clock change this week. */
function ZoneNotes({
  trips,
  start,
  end,
}: {
  trips: readonly StaffTrip[];
  start: LocalDate;
  end: LocalDate;
}) {
  const zones = [...new Set(trips.map((t) => t.timeZone))];
  const [zone] = zones;
  return (
    <ul className="cal-notes">
      <li>
        <Icon name="clock" />
        <span>
          {zones.length === 1 && zone
            ? `Times are local to ${zoneCity(zone)}, where these trips depart.`
            : "Times are local to each trip's departure point."}
        </span>
      </li>
      {zones.length === 1 &&
        zone &&
        clockChanges(start, end, zone).map((change) => (
          <li key={change.date}>
            <Icon name="info" />
            <span>
              {describeClockChange(change)} {change.before} becomes {change.after}.
            </span>
          </li>
        ))}
    </ul>
  );
}

function Week({
  days,
  trips,
  today,
  canChange,
  done,
  onAction,
}: {
  days: LocalDate[];
  trips: readonly StaffTrip[];
  today: LocalDate;
  canChange: boolean;
  done: Done | null;
  onAction: (trip: StaffTrip, kind: ActionKind) => void;
}) {
  const now = new Date();
  const byDay = new Map<LocalDate, StaffTrip[]>(days.map((d) => [d, []]));
  for (const trip of trips) byDay.get(trip.localDate)?.push(trip);
  const showZone = new Set(trips.map((t) => t.timeZone)).size > 1;
  const first = days[0] as LocalDate;
  const last = days[6] as LocalDate;

  const jump = (event: MouseEvent<HTMLAnchorElement>, date: LocalDate) => {
    // Move to the day without changing the address, which the console routes on.
    event.preventDefault();
    const heading = document.getElementById(dayHeadingId(date));
    heading?.scrollIntoView({ block: "start" });
    heading?.focus({ preventScroll: true });
  };

  return (
    <div className="cal-week">
      <ZoneNotes trips={trips} start={first} end={last} />
      <nav aria-label="Days this week" className="cal-strip-nav">
        <ol className="cal-strip">
          {days.map((date) => {
            const count = byDay.get(date)?.length ?? 0;
            const isToday = date === today;
            return (
              <li key={date}>
                <a
                  className="cal-strip__day"
                  href={`#${dayHeadingId(date)}`}
                  aria-current={isToday ? "date" : undefined}
                  onClick={(e) => jump(e, date)}
                >
                  {/* Short marks for the eye; one full sentence for the ear. */}
                  <span className="cal-strip__weekday" aria-hidden="true">
                    {formatWeekday(date, "short")}
                  </span>
                  <span className="cal-strip__date" aria-hidden="true">
                    {Number(date.slice(8))}
                  </span>
                  <span className="cal-strip__count" aria-hidden="true">
                    {count === 0 ? "None" : count}
                    <span className="cal-strip__unit">
                      {count === 0 ? "" : count === 1 ? " trip" : " trips"}
                    </span>
                  </span>
                  <VisuallyHidden>
                    {`${formatDate(date, "full")}${isToday ? ", today" : ""}: ${
                      count === 0 ? "no trips" : count === 1 ? "1 trip" : `${count} trips`
                    }`}
                  </VisuallyHidden>
                </a>
              </li>
            );
          })}
        </ol>
      </nav>
      {days.map((date) => {
        const dayTrips = byDay.get(date) ?? [];
        return (
          <section key={date} className="cal-day" aria-labelledby={dayHeadingId(date)}>
            <h3 className="cal-day__title" id={dayHeadingId(date)} tabIndex={-1}>
              {formatDate(date, "full")}
              {date === today && (
                <>
                  {" "}
                  <span className="cal-day__today">Today</span>
                </>
              )}
            </h3>
            {dayTrips.length === 0 ? (
              <p className="cal-day__none">No trips</p>
            ) : (
              <ul className="cal-day__trips">
                {dayTrips.map((trip) => (
                  <TripRow
                    key={trip.tripId}
                    trip={trip}
                    now={now}
                    showZone={showZone}
                    canChange={canChange}
                    done={done?.tripId === trip.tripId ? done.what : undefined}
                    onAction={onAction}
                  />
                ))}
              </ul>
            )}
          </section>
        );
      })}
    </div>
  );
}

function TripRow({
  trip,
  now,
  showZone,
  canChange,
  done,
  onAction,
}: {
  trip: StaffTrip;
  now: Date;
  showZone: boolean;
  canChange: boolean;
  done: string | undefined;
  onAction: (trip: StaffTrip, kind: ActionKind) => void;
}) {
  const state = salesStates[trip.salesState];
  // The stored wall clock at the marina, never recomputed with the browser's
  // zone data. In the hour clocks go back, each time names its zone.
  const start = tripStart(trip);
  const endDate = trip.endsAtLocal.slice(0, 10);
  const end = formatTripTime(trip.endsAtLocal.slice(11, 16), trip.endsAt, trip.timeZone);
  const endText = endDate === trip.localDate ? end : `${end} next day`;
  const departed = hasDeparted(trip, now);
  const final = trip.salesState === "canceled" || trip.salesState === "completed";
  const actions = canChange ? actionsFor(trip, now) : [];
  const place = showZone ? ` ${zoneCity(trip.timeZone)} time` : "";
  return (
    <li
      className={actions.length > 0 ? "cal-trip" : "cal-trip cal-trip--no-actions"}
      data-state={trip.salesState}
    >
      {/* Read once, inside the heading. */}
      <div className="cal-trip__time" aria-hidden="true">
        <span className="cal-trip__start">{start}</span>
        <span className="cal-trip__end">to {endText}</span>
        {showZone && <span className="cal-trip__zone">{zoneCity(trip.timeZone)}</span>}
        {departed && <span className="cal-trip__departed">Departed</span>}
      </div>
      <div className="cal-trip__main">
        <h4 className="cal-trip__title" id={tripHeadingId(trip.tripId)} tabIndex={-1}>
          <VisuallyHidden>
            {start} to {endText}
            {place}
            {departed ? ", departed" : ""},
          </VisuallyHidden>{" "}
          {trip.productName}
        </h4>
        <ul className="cal-trip__facts">
          <li>
            <Icon name="boat" />
            <span>
              <VisuallyHidden>Boat: </VisuallyHidden>
              {trip.boatName}
            </span>
          </li>
          <li>
            <Icon name="users" />
            <span>{capacityText(trip, departed)}</span>
          </li>
          <li>
            <Icon name="hourglass" />
            <span>
              Booking cutoff {formatCutoff(trip.salesCloseAt, trip)}
              {!final && cutoffPassed(trip, now) ? " (passed)" : ""}
            </span>
          </li>
        </ul>
        {done && (
          <p className="cal-trip__done">
            <Icon name="check-circle" />
            <span>{done}. The reason is in the audit history.</span>
          </p>
        )}
      </div>
      <div className="cal-trip__status">
        <StatusBadge tone={state.tone} icon={state.icon}>
          {state.label}
        </StatusBadge>
        {trip.blackedOut && (
          <StatusBadge tone="info" icon="eye-off">
            Blacked out
          </StatusBadge>
        )}
      </div>
      {actions.length > 0 && (
        <div className="cal-trip__actions">
          {actions.map((kind) => {
            const copy = actionCopy[kind];
            return (
              <Button
                key={kind}
                icon={copy.icon}
                className={kind === "cancel" ? "cal-trip__cancel" : undefined}
                data-trip-action={actionKey(trip.tripId, kind)}
                onClick={() => onAction(trip, kind)}
              >
                {copy.button} <VisuallyHidden>{tripLine(trip)}</VisuallyHidden>
              </Button>
            );
          })}
        </div>
      )}
    </li>
  );
}
