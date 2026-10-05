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
  formatClock,
  formatCutoff,
  formatDate,
  formatDateRange,
  formatWeekday,
  type LocalDate,
  localPartsOf,
  startOfWeek,
  todayIn,
  zoneCity,
} from "@tidegrid/design-system/format";
import { type MouseEvent, useCallback, useEffect, useRef, useState } from "react";
import { type FocusOnArrival, PageHeader } from "../PageHeader.tsx";
import { canChangeTrips, roleNames } from "../roles.ts";
import { ActionDialog } from "./ActionDialog.tsx";
import { loadWeek, type WeekFailure } from "./api.ts";
import {
  type ActionKind,
  actionCopy,
  actionsFor,
  hasDeparted,
  readWeek,
  salesStates,
  tripLine,
  weekOf,
} from "./model.ts";

/**
 * The operator's week: every trip from Sunday to Saturday in any sales
 * state, by the marina's local date. Owners and booking staff publish, close,
 * reopen, cancel, and complete trips from here; finance sees the same week
 * with no controls.
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

export function CalendarPage({
  membership,
  focusHeading,
}: { membership: Membership } & FocusOnArrival) {
  const { tenantId, tenantName, role } = membership;
  const canChange = canChangeTrips(role);
  // The marina's zone, once a week of trips has named it; until then the
  // device's own calendar decides what "this week" is.
  const [zone, setZone] = useState<string | undefined>();
  const [weekStart, setWeekStart] = useState(() => readWeek(window.location.search, todayIn()));
  const [load, setLoad] = useState<Load>({ kind: "loading" });
  const [attempt, setAttempt] = useState(0);
  const [dialog, setDialog] = useState<OpenDialog | null>(null);
  const [done, setDone] = useState<Done | null>(null);
  const retryRequested = useRef(false);
  const focusRangeOnLoad = useRef(false);
  /**
   * The trip whose heading takes focus once the dialog is gone: always after
   * a change (its buttons are different now), and after a dismissal only when
   * the button that opened the dialog no longer exists.
   */
  const focusTrip = useRef<{ tripId: string; always: boolean } | null>(null);
  const range = useRef<HTMLHeadingElement>(null);
  const week = weekOf(weekStart);
  const today = todayIn(zone);
  const isThisWeek = weekStart === startOfWeek(today);

  useEffect(() => {
    // `attempt` is a dependency so "Try again" reruns this effect.
    void attempt;
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
        if (named) setZone(named);
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

  // A new week or operator starts without the last change's confirmation.
  useEffect(() => {
    void tenantId;
    void weekStart;
    setDone(null);
  }, [tenantId, weekStart]);

  // The address keeps the week, so a reload shows the same one.
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    if (weekStart === startOfWeek(todayIn())) params.delete("week");
    else params.set("week", weekStart);
    const search = params.toString() ? `?${params}` : "";
    if (search !== window.location.search) {
      const { pathname, hash } = window.location;
      window.history.replaceState(window.history.state, "", `${pathname}${search}${hash}`);
    }
  }, [weekStart]);

  // "Try again" is gone once the week arrives, so the week's heading takes focus.
  useEffect(() => {
    if (load.kind === "ready" && focusRangeOnLoad.current) {
      focusRangeOnLoad.current = false;
      range.current?.focus();
    }
  }, [load]);

  // After the dialog closes, the trip it was about keeps the person's place.
  // The dialog has already returned focus to the button that opened it, if
  // that button still exists.
  useEffect(() => {
    const target = focusTrip.current;
    if (dialog || !target) return;
    focusTrip.current = null;
    const active = document.activeElement;
    const lost = !active || active === document.body;
    if (target.always || lost) document.getElementById(tripHeadingId(target.tripId))?.focus();
  }, [dialog]);

  /** Reload the week without the loading screen, after a trip changed under the person. */
  const refresh = useCallback(async () => {
    const result = await loadWeek(tenantId, { from: week.start, to: week.end });
    if (result.kind !== "ok") return undefined;
    setLoad({ kind: "ready", trips: result.trips });
    return result.trips;
  }, [tenantId, week.start, week.end]);

  const retry = () => {
    retryRequested.current = true;
    focusRangeOnLoad.current = true;
    setAttempt((n) => n + 1);
  };

  const open = (trip: StaffTrip, kind: ActionKind) => {
    setDialog({ trip, kind });
  };

  const close = () => {
    if (dialog) focusTrip.current = { tripId: dialog.trip.tripId, always: false };
    setDialog(null);
  };

  const finish = (trip: StaffTrip) => {
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
    focusTrip.current = { tripId: trip.tripId, always: true };
    setDialog(null);
  };

  const trips = load.kind === "ready" ? load.trips : [];
  const announcement =
    load.kind === "loading"
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
            {formatDateRange(week.start, week.end)}
          </h2>
          <nav className="cal-bar__nav" aria-label="Weeks">
            <Button icon="chevron-left" onClick={() => setWeekStart((start) => addDays(start, -7))}>
              Previous <VisuallyHidden>week</VisuallyHidden>
            </Button>
            <Button disabled={isThisWeek} onClick={() => setWeekStart(startOfWeek(today))}>
              This week
            </Button>
            <Button
              icon="chevron-right"
              iconPosition="end"
              onClick={() => setWeekStart((start) => addDays(start, 7))}
            >
              Next <VisuallyHidden>week</VisuallyHidden>
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

        {load.kind === "loading" && <WeekSkeleton />}

        {load.kind === "failed" && (
          <WeekFailed
            reason={load.reason}
            tenantName={tenantName}
            failures={load.failures}
            retrying={load.retrying}
            onRetry={retry}
          />
        )}

        {load.kind === "ready" &&
          (trips.length === 0 ? (
            <EmptyState icon="calendar" title="No trips this week">
              <p>
                Nothing is scheduled for {tenantName} from {formatDate(week.start, "medium")} to{" "}
                {formatDate(week.end, "medium")}. Trips appear here once a schedule creates them.
              </p>
            </EmptyState>
          ) : (
            <Week
              days={week.days}
              trips={trips}
              today={today}
              canChange={canChange}
              done={done}
              onAction={open}
            />
          ))}
      </div>
      {dialog && (
        <ActionDialog
          membership={membership}
          trip={dialog.trip}
          kind={dialog.kind}
          onClose={close}
          onDone={finish}
          onStale={async () => (await refresh())?.find((t) => t.tripId === dialog.trip.tripId)}
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
  not_found: {
    title: "You no longer have access to this operator",
    body: (tenant) => `Your membership of ${tenant} may have ended. Ask one of its owners.`,
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
}: {
  reason: WeekFailure;
  tenantName: string;
  failures: number;
  retrying: boolean;
  onRetry: () => void;
}) {
  const text = failureText[reason];
  const canRetry = reason === "unreachable" || reason === "unavailable";
  return (
    <Notice
      tone="error"
      className="cal-notice"
      title={canRetry && failures > 1 ? "Trips still aren't loading" : text.title}
      actions={
        reason === "signed_out" ? (
          <ButtonLink variant="primary" icon="arrow-left" href="/">
            Sign in again
          </ButtonLink>
        ) : canRetry ? (
          <Button
            variant="primary"
            icon="refresh"
            busy={retrying}
            busyLabel="Trying again…"
            onClick={onRetry}
          >
            Try again
          </Button>
        ) : undefined
      }
    >
      <p>{text.body(tenantName)}</p>
    </Notice>
  );
}

function WeekSkeleton() {
  return (
    <div className="cal-week" aria-hidden="true">
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
      <nav aria-label="Days this week">
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

function capacityText(trip: StaffTrip): string {
  const { kind, total, remaining } = trip.capacity;
  if (kind === "whole_boat") {
    return remaining > 0 ? `Whole boat, up to ${total} guests` : "Whole boat, booked";
  }
  return `${remaining} of ${total} seats left`;
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
  // The stored wall clock at the marina, never recomputed with the browser's zone data.
  const start = formatClock(trip.localStartTime);
  const end = localPartsOf(trip.endsAtLocal);
  const endText = end.date === trip.localDate ? end.time : `${end.time} next day`;
  const departed = hasDeparted(trip, now);
  const cutoffPassed = Date.parse(trip.salesCloseAt) <= now.getTime();
  const actions = canChange ? actionsFor(trip, now) : [];
  const place = showZone ? ` ${zoneCity(trip.timeZone)} time` : "";
  return (
    <li className="cal-trip" data-state={trip.salesState}>
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
            <span>{capacityText(trip)}</span>
          </li>
          <li>
            <Icon name="hourglass" />
            <span>
              Booking cutoff {formatCutoff(trip.salesCloseAt, trip)}
              {cutoffPassed && trip.salesState !== "canceled" && trip.salesState !== "completed"
                ? " (passed)"
                : ""}
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
