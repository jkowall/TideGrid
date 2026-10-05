import type { AvailableTrip, PublicBrand } from "@tidegrid/contracts";
import {
  Button,
  cx,
  EmptyState,
  Icon,
  Notice,
  SelectField,
  Skeleton,
  Spinner,
  VisuallyHidden,
} from "@tidegrid/design-system/components";
import {
  addDays,
  clockChanges,
  describeClockChange,
  formatCutoff,
  formatDate,
  formatDateRange,
  formatDuration,
  formatTripTime,
  type LocalDate,
  todayIn,
  zoneCity,
} from "@tidegrid/design-system/format";
import { type Ref, useEffect, useRef, useState } from "react";
import { ContactActions } from "./Contact.tsx";
import {
  clampStart,
  groupByDate,
  lastStart,
  loadTrips,
  partySizes,
  readQuery,
  type TripQuery,
  type TripsFailure,
  windowDays,
  windowOf,
  writeQuery,
} from "./trips.ts";

/**
 * Upcoming trips on an operator's branded site: four weeks at a time, for a
 * party size, grouped by the marina's local date. Discovery only. Booking and
 * checkout arrive with later goals, so a trip has no Book button; the one
 * primary action is reaching the operator.
 */

interface Loaded {
  query: TripQuery;
  trips: AvailableTrip[];
}

type State =
  /** `previous`: the list shown before this load, kept while the same dates load for another party. */
  | { kind: "loading"; previous?: Loaded | undefined }
  | { kind: "ready"; loaded: Loaded }
  /** `retrying`: "Try again" is working; the notice stays so focus stays on it. */
  | { kind: "failed"; reason: TripsFailure; retrying: boolean; failures: number };

const guests = (n: number) => (n === 1 ? "1 guest" : `${n} guests`);
const partyOptions = partySizes.map((n) => ({ value: String(n), label: guests(n) }));
const currentYear = () => new Date().getFullYear();
const sameQuery = (a: TripQuery, b: TripQuery) => a.start === b.start && a.party === b.party;

export function UpcomingTrips({ brand }: { brand: PublicBrand }) {
  // The guest's own date. Trip dates are the marina's; see windowOf.
  const [today] = useState(() => todayIn());
  const [query, setQuery] = useState<TripQuery>(() => readQuery(window.location.search, today));
  const [attempt, setAttempt] = useState(0);
  const [state, setState] = useState<State>({ kind: "loading" });
  const rangeLabel = useRef<HTMLParagraphElement>(null);
  const retryRequested = useRef(false);
  const focusRangeOnLoad = useRef(false);
  const range = windowOf(query.start, today);

  useEffect(() => {
    // `attempt` is a dependency so "Try again" reruns this effect.
    void attempt;
    const controller = new AbortController();
    const retry = retryRequested.current;
    retryRequested.current = false;
    setState((current) => {
      if (retry && current.kind === "failed") return { ...current, retrying: true };
      const shown =
        current.kind === "ready"
          ? current.loaded
          : current.kind === "loading"
            ? current.previous
            : undefined;
      // The same dates for another party: keep the list while the new one loads.
      return { kind: "loading", previous: shown?.query.start === query.start ? shown : undefined };
    });
    const { from, to } = windowOf(query.start, today);
    void loadTrips({ from, to, party: query.party }, controller.signal).then((result) => {
      if (controller.signal.aborted) return;
      if (result.kind === "ok") {
        setState({ kind: "ready", loaded: { query, trips: result.trips } });
        return;
      }
      focusRangeOnLoad.current = false;
      setState((current) => ({
        kind: "failed",
        reason: result.reason,
        retrying: false,
        failures: current.kind === "failed" ? current.failures + 1 : 1,
      }));
    });
    return () => controller.abort();
  }, [query, today, attempt]);

  // The address keeps the dates and party, so a reload shows the same list.
  useEffect(() => {
    const search = writeQuery(query, today);
    if (search !== window.location.search) {
      const { pathname, hash } = window.location;
      window.history.replaceState(window.history.state, "", `${pathname}${search}${hash}`);
    }
  }, [query, today]);

  // "Try again" is gone once the list arrives, so the dates take focus, as the
  // week does in the console.
  useEffect(() => {
    if (state.kind === "ready" && focusRangeOnLoad.current) {
      focusRangeOnLoad.current = false;
      rangeLabel.current?.focus();
    }
  }, [state]);

  const retry = () => {
    retryRequested.current = true;
    focusRangeOnLoad.current = true;
    setAttempt((n) => n + 1);
  };

  /** Show another four weeks. From the foot of the list, the person goes back to the top. */
  const goTo = (start: LocalDate, fromBottom = false) => {
    setQuery((q) => ({ ...q, start: clampStart(start, today) }));
    if (fromBottom) rangeLabel.current?.focus();
  };

  // What is on screen matches the dates and party asked for, or it is the same
  // dates for the previous party while the new list loads. Nothing older: a
  // list for other dates never sits under the new dates, even for one frame.
  const loaded = state.kind === "ready" ? state.loaded : undefined;
  const current = loaded && sameQuery(loaded.query, query) ? loaded : undefined;
  const previous = state.kind === "loading" ? state.previous : loaded;
  const updating = !current && state.kind !== "failed" && previous?.query.start === query.start;
  const shown = current ?? (updating ? previous : undefined);
  const failed = state.kind === "failed";
  const label = formatDateRange(range.start, range.end, "medium", { currentYear: currentYear() });
  const canPrevious = query.start > today;
  const canNext = addDays(query.start, windowDays) <= lastStart(today);
  const status = current
    ? summary(current, range.start, range.end)
    : !failed && !updating
      ? "Loading trips…"
      : "";

  return (
    <section aria-labelledby="trips-title" className="guest-section trips">
      <div className="trips__head">
        <h2 id="trips-title" tabIndex={-1}>
          Upcoming trips
        </h2>
        {shown && shown.trips.length > 0 && (
          <TimeNote trips={shown.trips} start={range.start} end={range.end} />
        )}
      </div>

      <Notice
        tone="info"
        announce="none"
        className="trips__reserve"
        title="Online booking isn't open yet"
        actions={<ContactActions brand={brand} primary={!failed} />}
      >
        <p>Call or email {brand.name} to reserve a spot on any trip below.</p>
      </Notice>

      <div className="trips__controls">
        <SelectField
          className="trips__party"
          label="Party size"
          options={partyOptions}
          value={String(query.party)}
          onChange={(event) => setQuery((q) => ({ ...q, party: Number(event.target.value) }))}
        />
        <RangeNav
          label={label}
          labelRef={rangeLabel}
          canPrevious={canPrevious}
          canNext={canNext}
          onPrevious={() => goTo(addDays(query.start, -windowDays))}
          onNext={() => goTo(addDays(query.start, windowDays))}
        />
      </div>

      <p className="tg-visually-hidden" role="status">
        {status}
      </p>

      {updating && (
        <p className="trips__updating">
          <Spinner />
          Updating for {guests(query.party)}…
        </p>
      )}

      {state.kind === "failed" && (
        <TripsFailed
          reason={state.reason}
          failures={state.failures}
          retrying={state.retrying}
          onRetry={retry}
          onFromToday={() => goTo(today)}
        />
      )}

      {!failed && !shown && <TripListSkeleton />}

      {shown &&
        (shown.trips.length > 0 ? (
          <>
            <TripList trips={shown.trips} busy={updating} />
            <RangeNav
              bottom
              label={label}
              canPrevious={canPrevious}
              canNext={canNext}
              onPrevious={() => goTo(addDays(query.start, -windowDays), true)}
              onNext={() => goTo(addDays(query.start, windowDays), true)}
            />
          </>
        ) : (
          <EmptyState
            icon="calendar"
            headingLevel={3}
            title="No trips in these dates"
            actions={
              canPrevious ? (
                <Button icon="arrow-left" onClick={() => goTo(today)}>
                  Show from today
                </Button>
              ) : shown.query.party > 1 ? (
                <Button onClick={() => setQuery((q) => ({ ...q, party: 1 }))}>
                  Show trips for 1 guest
                </Button>
              ) : undefined
            }
          >
            <p>
              Nothing is open for {guests(shown.query.party)} from {label}. Try other dates
              {shown.query.party > 1 ? " or a smaller party" : ""}.
            </p>
          </EmptyState>
        ))}
    </section>
  );
}

function summary(loaded: Loaded, start: LocalDate, end: LocalDate): string {
  const count = loaded.trips.length;
  const trips = count === 0 ? "No trips" : count === 1 ? "1 trip" : `${count} trips`;
  return `${trips} from ${formatDateRange(start, end, "full", { currentYear: currentYear() })}, for ${guests(loaded.query.party)}.`;
}

/**
 * Previous, the dates shown, and Next. The list ends with a second copy, so a
 * guest at the foot of a long list need not scroll back to page on.
 */
function RangeNav({
  label,
  labelRef,
  bottom = false,
  canPrevious,
  canNext,
  onPrevious,
  onNext,
}: {
  label: string;
  /** The top copy's dates take focus after paging from the bottom, or after "Try again". */
  labelRef?: Ref<HTMLParagraphElement>;
  bottom?: boolean;
  canPrevious: boolean;
  canNext: boolean;
  onPrevious: () => void;
  onNext: () => void;
}) {
  return (
    <nav
      className={cx("trips__range", bottom && "trips__range--bottom")}
      aria-label={bottom ? "Trip dates, after the list" : "Trip dates"}
    >
      <Button icon="chevron-left" disabled={!canPrevious} onClick={onPrevious}>
        Previous <VisuallyHidden>4 weeks</VisuallyHidden>
      </Button>
      <p className="trips__range-label" ref={labelRef} tabIndex={labelRef ? -1 : undefined}>
        {label}
      </p>
      <Button icon="chevron-right" iconPosition="end" disabled={!canNext} onClick={onNext}>
        Next <VisuallyHidden>4 weeks</VisuallyHidden>
      </Button>
    </nav>
  );
}

const failureCopy: Record<TripsFailure, { title: string; body: string }> = {
  unreachable: {
    title: "We couldn't load trips",
    body: "Check your connection and try again.",
  },
  rejected: {
    title: "These dates can't be shown",
    body: "Trips are listed from today to a year ahead.",
  },
  unavailable: {
    title: "We couldn't load trips",
    body: "The booking site may be briefly unavailable. Wait a moment, then try again.",
  },
  unreadable: {
    title: "We couldn't show these trips",
    body: "The booking site sent something this page can't read. Wait a moment, then try again.",
  },
};

function TripsFailed({
  reason,
  failures,
  retrying,
  onRetry,
  onFromToday,
}: {
  reason: TripsFailure;
  failures: number;
  retrying: boolean;
  onRetry: () => void;
  onFromToday: () => void;
}) {
  const copy = failureCopy[reason];
  if (reason === "rejected") {
    return (
      <Notice
        tone="error"
        className="trips__error"
        title={copy.title}
        actions={
          <Button variant="primary" icon="arrow-left" onClick={onFromToday}>
            Show from today
          </Button>
        }
      >
        <p>{copy.body}</p>
      </Notice>
    );
  }
  return (
    <Notice
      tone="error"
      className="trips__error"
      title={failures > 1 ? "Trips still aren't loading" : copy.title}
      actions={
        <Button
          variant="primary"
          icon="refresh"
          busy={retrying}
          busyLabel="Trying again…"
          onClick={onRetry}
        >
          Try again
        </Button>
      }
    >
      <p>{failures > 1 ? failureCopy.unavailable.body : copy.body}</p>
    </Notice>
  );
}

/**
 * Says plainly whose clock the times use, and warns of a clock change in the
 * dates shown. Trips at one place share one note; trips in several zones each
 * carry their place instead.
 */
function TimeNote({
  trips,
  start,
  end,
}: {
  trips: readonly AvailableTrip[];
  start: LocalDate;
  end: LocalDate;
}) {
  const zones = [...new Set(trips.map((t) => t.timeZone))];
  const places = [...new Set(trips.map((t) => t.location.name))];
  const [zone] = zones;
  if (zones.length !== 1 || !zone) {
    return (
      <ul className="trips__notes">
        <li>
          <Icon name="clock" />
          <span>Times are local to each trip's departure point.</span>
        </li>
      </ul>
    );
  }
  const where = places.length === 1 ? places[0] : "the marina";
  return (
    <ul className="trips__notes">
      <li>
        <Icon name="clock" />
        <span>
          Times are local to {where} ({zoneCity(zone)}).
        </span>
      </li>
      {clockChanges(start, end, zone).map((change) => (
        <li key={change.date}>
          <Icon name="info" />
          <span>{describeClockChange(change)}</span>
        </li>
      ))}
    </ul>
  );
}

function TripList({ trips, busy }: { trips: readonly AvailableTrip[]; busy: boolean }) {
  const days = groupByDate(trips);
  const showZone = new Set(trips.map((t) => t.timeZone)).size > 1;
  return (
    <div className="trips__list" aria-busy={busy || undefined}>
      {days.map((day) => {
        const zone = day.trips[0]?.timeZone;
        const marinaToday = todayIn(zone);
        const relative =
          day.date === marinaToday
            ? "Today"
            : day.date === addDays(marinaToday, 1)
              ? "Tomorrow"
              : undefined;
        const id = `trips-day-${day.date}`;
        return (
          <section key={day.date} className="trips-day" aria-labelledby={id}>
            <h3 id={id} className="trips-day__title">
              {relative && (
                <>
                  <span className="trips-day__relative">{relative}</span>{" "}
                </>
              )}
              {formatDate(day.date, "full")}
            </h3>
            <ul className="trips-day__list">
              {day.trips.map((trip) => (
                <TripCard key={trip.tripId} trip={trip} showZone={showZone} />
              ))}
            </ul>
          </section>
        );
      })}
    </div>
  );
}

function capacityText(trip: AvailableTrip): string {
  const { kind, total, remaining } = trip.capacity;
  if (kind === "whole_boat") return `Whole boat, up to ${total} guests`;
  return `Shared trip, ${remaining} ${remaining === 1 ? "seat" : "seats"} left`;
}

/** When booking closes, on the marina's clock. See formatCutoff. */
function bookBy(trip: AvailableTrip): string {
  return `Book by ${formatCutoff(trip.salesCloseAt, trip)}`;
}

function TripCard({ trip, showZone }: { trip: AvailableTrip; showZone: boolean }) {
  // The stored local start, never recomputed from the instant with the
  // browser's zone data. In the hour clocks go back, it names its zone.
  const start = formatTripTime(trip.localStartTime, trip.startsAt, trip.timeZone);
  const place = showZone ? ` ${zoneCity(trip.timeZone)} time` : "";
  return (
    <li className="trip-card">
      {/* Said once, inside the heading and the facts, for screen readers. */}
      <div className="trip-card__when" aria-hidden="true">
        <span className="trip-card__time">{start}</span>
        {showZone && <span className="trip-card__zone">{zoneCity(trip.timeZone)}</span>}
        <span className="trip-card__duration">{formatDuration(trip.durationMinutes)}</span>
      </div>
      <div className="trip-card__main">
        <h4 className="trip-card__title">
          <VisuallyHidden>
            {start}
            {place},
          </VisuallyHidden>{" "}
          {trip.product.name}
        </h4>
        <p className="trip-card__summary">{trip.product.summary}</p>
      </div>
      <ul className="trip-card__facts">
        <li className="tg-visually-hidden">{formatDuration(trip.durationMinutes, "long")}</li>
        <li>
          <Icon name="map-pin" />
          <span>Meet at {trip.location.meetingPoint}</span>
        </li>
        <li>
          <Icon name={trip.capacity.kind === "seats" ? "users" : "boat"} />
          <span>{capacityText(trip)}</span>
        </li>
        <li>
          <Icon name="hourglass" />
          <span>{bookBy(trip)}</span>
        </li>
      </ul>
    </li>
  );
}

/** Placeholder in the shape of the loaded list. Decorative; the page says "Loading" in text. */
export function TripListSkeleton() {
  return (
    <div className="trips__list trips__list--skeleton" aria-hidden="true">
      {[2, 1].map((count, day) => (
        <div key={day} className="trips-day">
          <Skeleton className="trips-day__skeleton-title" width="14rem" height="1.25rem" />
          <ul className="trips-day__list">
            {Array.from({ length: count }, (_, card) => (
              <li key={card} className="trip-card">
                <div className="trip-card__when">
                  <Skeleton width="5rem" height="1.5rem" />
                  <Skeleton variant="text" width="4rem" />
                </div>
                <div className="trip-card__main">
                  <Skeleton width="min(16rem, 80%)" height="1.25rem" />
                  <Skeleton variant="text" width="90%" />
                </div>
                <div className="trip-card__facts">
                  <Skeleton variant="text" width="10rem" />
                  <Skeleton variant="text" width="12rem" />
                  <Skeleton variant="text" width="8rem" />
                </div>
              </li>
            ))}
          </ul>
        </div>
      ))}
    </div>
  );
}
