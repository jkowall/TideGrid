import type { AvailableTrip, PublicBrand } from "@tidegrid/contracts";
import {
  Button,
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
  formatClock,
  formatDate,
  formatDateRange,
  formatDuration,
  inZone,
  type LocalDate,
  todayIn,
  zoneCity,
} from "@tidegrid/design-system/format";
import { useEffect, useRef, useState } from "react";
import { ContactActions } from "./Contact.tsx";
import {
  groupByDate,
  loadTrips,
  partySizes,
  readQuery,
  type TripQuery,
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
  /** `previous`: the same dates for another party size, shown while the new list loads. */
  | { kind: "loading"; previous?: Loaded | undefined }
  | { kind: "ready"; loaded: Loaded }
  /** `retrying`: "Try again" is working; the notice stays so focus stays on it. */
  | { kind: "failed"; retrying: boolean; failures: number };

const guests = (n: number) => (n === 1 ? "1 guest" : `${n} guests`);
const partyOptions = partySizes.map((n) => ({ value: String(n), label: guests(n) }));
const currentYear = () => new Date().getFullYear();

export function UpcomingTrips({ brand }: { brand: PublicBrand }) {
  // The guest's own date. Trip dates are the marina's; see windowOf.
  const [today] = useState(() => todayIn());
  const [query, setQuery] = useState<TripQuery>(() => readQuery(window.location.search, today));
  const [attempt, setAttempt] = useState(0);
  const [state, setState] = useState<State>({ kind: "loading" });
  const heading = useRef<HTMLHeadingElement>(null);
  const retryRequested = useRef(false);
  const focusHeadingOnLoad = useRef(false);
  const range = windowOf(query.start, today);

  useEffect(() => {
    // `attempt` is a dependency so "Try again" reruns this effect.
    void attempt;
    const controller = new AbortController();
    const retry = retryRequested.current;
    retryRequested.current = false;
    setState((current) => {
      if (retry && current.kind === "failed") return { ...current, retrying: true };
      if (current.kind === "ready" && current.loaded.query.start === query.start) {
        return { kind: "loading", previous: current.loaded };
      }
      if (current.kind === "loading" && current.previous?.query.start === query.start) {
        return current;
      }
      return { kind: "loading" };
    });
    const { from, to } = windowOf(query.start, today);
    void loadTrips({ from, to, party: query.party }, controller.signal).then((result) => {
      if (controller.signal.aborted) return;
      if (result.kind === "ok") {
        setState({ kind: "ready", loaded: { query, trips: result.trips } });
        return;
      }
      focusHeadingOnLoad.current = false;
      setState((current) => ({
        kind: "failed",
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

  // "Try again" is gone once the list arrives, so the section heading takes focus.
  useEffect(() => {
    if (state.kind === "ready" && focusHeadingOnLoad.current) {
      focusHeadingOnLoad.current = false;
      heading.current?.focus();
    }
  }, [state]);

  const retry = () => {
    retryRequested.current = true;
    focusHeadingOnLoad.current = true;
    setAttempt((n) => n + 1);
  };

  const shown =
    state.kind === "ready" ? state.loaded : state.kind === "loading" ? state.previous : undefined;
  const failed = state.kind === "failed";

  return (
    <section aria-labelledby="trips-title" className="guest-section trips">
      <div className="trips__head">
        <h2 id="trips-title" ref={heading} tabIndex={-1}>
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
        <nav className="trips__range" aria-label="Trip dates">
          <Button
            icon="chevron-left"
            disabled={query.start <= today}
            onClick={() => {
              const back = addDays(query.start, -windowDays);
              setQuery((q) => ({ ...q, start: back < today ? today : back }));
            }}
          >
            Previous<VisuallyHidden> 4 weeks</VisuallyHidden>
          </Button>
          <p className="trips__range-label">
            {formatDateRange(range.start, range.end, "medium", { currentYear: currentYear() })}
          </p>
          <Button
            icon="chevron-right"
            iconPosition="end"
            onClick={() => setQuery((q) => ({ ...q, start: addDays(q.start, windowDays) }))}
          >
            Next<VisuallyHidden> 4 weeks</VisuallyHidden>
          </Button>
        </nav>
      </div>

      <p className="tg-visually-hidden" role="status">
        {state.kind === "ready"
          ? summary(state.loaded, range.start, range.end)
          : state.kind === "loading" && !state.previous
            ? "Loading trips…"
            : ""}
      </p>

      {state.kind === "loading" && state.previous && (
        <p className="trips__updating">
          <Spinner />
          Updating for {guests(query.party)}…
        </p>
      )}

      {state.kind === "failed" && (
        <Notice
          tone="error"
          className="trips__error"
          title={state.failures > 1 ? "Trips still aren't loading" : "We couldn't load trips"}
          actions={
            <Button
              variant="primary"
              icon="refresh"
              busy={state.retrying}
              busyLabel="Trying again…"
              onClick={retry}
            >
              Try again
            </Button>
          }
        >
          <p>
            {state.failures > 1
              ? "The booking site may be briefly unavailable. Wait a moment, then try again."
              : "Check your connection and try again."}
          </p>
        </Notice>
      )}

      {state.kind === "loading" && !state.previous && <TripListSkeleton />}

      {shown &&
        (shown.trips.length > 0 ? (
          <TripList trips={shown.trips} busy={state.kind === "loading"} />
        ) : (
          <EmptyState icon="calendar" headingLevel={3} title="No trips in these dates">
            <p>
              Nothing is open for {guests(shown.query.party)} from{" "}
              {formatDate(range.start, "medium")} to {formatDate(range.end, "medium")}. Try later
              dates{shown.query.party > 1 ? " or a smaller party" : ""}.
            </p>
          </EmptyState>
        ))}
    </section>
  );
}

function summary(loaded: Loaded, start: LocalDate, end: LocalDate): string {
  const count = loaded.trips.length;
  const trips = count === 0 ? "No trips" : count === 1 ? "1 trip" : `${count} trips`;
  return `${trips} from ${formatDateRange(start, end, "full")}, for ${guests(loaded.query.party)}.`;
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
      <p className="trips__note">
        <Icon name="clock" />
        <span>Times are local to each trip's departure point.</span>
      </p>
    );
  }
  const where = places.length === 1 ? places[0] : "the marina";
  const changes = clockChanges(start, end, zone).map(describeClockChange);
  return (
    <p className="trips__note">
      <Icon name="clock" />
      <span>
        Times are local to {where} ({zoneCity(zone)}).
        {changes.length > 0 && ` ${changes.join(" ")}`}
      </span>
    </p>
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
  if (kind === "whole_boat") return `Private charter, the whole boat for up to ${total} guests`;
  return `Shared trip, ${remaining} ${remaining === 1 ? "seat" : "seats"} left`;
}

/** When booking closes, on the marina's clock. The day is named when it is not the trip's. */
function bookBy(trip: AvailableTrip): string {
  const close = inZone(trip.salesCloseAt, trip.timeZone);
  return close.date === trip.localDate
    ? `Book by ${close.time}`
    : `Book by ${formatDate(close.date, "medium")}, ${close.time}`;
}

function TripCard({ trip, showZone }: { trip: AvailableTrip; showZone: boolean }) {
  // The stored local start, never recomputed from the instant with the
  // browser's zone data.
  const start = formatClock(trip.localStartTime);
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
            {place},{" "}
          </VisuallyHidden>
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
        // biome-ignore lint/suspicious/noArrayIndexKey: a fixed, decorative placeholder.
        <div key={day} className="trips-day">
          <Skeleton className="trips-day__skeleton-title" width="14rem" height="1.25rem" />
          <ul className="trips-day__list">
            {Array.from({ length: count }, (_, card) => (
              // biome-ignore lint/suspicious/noArrayIndexKey: a fixed, decorative placeholder.
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
