import type { BookingDayTrip, BookingListItem, Membership } from "@tidegrid/contracts";
import { normalizeBookingReference } from "@tidegrid/contracts/references";
import {
  Button,
  EmptyState,
  Icon,
  Notice,
  SelectField,
  Skeleton,
  StatusBadge,
  VisuallyHidden,
} from "@tidegrid/design-system/components";
import {
  addDays,
  formatMoney,
  formatTripTime,
  isLocalDate,
  type LocalDate,
  todayIn,
  zoneCity,
} from "@tidegrid/design-system/format";
import { type FormEvent, useEffect, useId, useRef, useState } from "react";
import { loadZone } from "../calendar/api.ts";
import { salesStates } from "../calendar/model.ts";
import { focusIsLost } from "../focus.ts";
import type { ReadFailure } from "../http.ts";
import { ConsoleButtonLink, ConsoleLink, useNavigate } from "../navigation.tsx";
import { type FocusOnArrival, PageHeader } from "../PageHeader.tsx";
import { canSeeGuests, roleNames } from "../roles.ts";
import { type DayPage, findReference, loadDay } from "./api.ts";
import {
  bookingHref,
  bookingStates,
  clampDay,
  dayBounds,
  dayText,
  extrasText,
  guestsText,
  partyDetail,
  paymentCopy,
  readDay,
  readTrip,
  rosterHref,
} from "./model.ts";
import { ReadFailed } from "./States.tsx";

/**
 * A day's bookings for the selected operator (G2.12b): every trip departing
 * that day on the marina's clock, each with its bookings. The day and an
 * optional trip live in the address (`?day=`, `?trip=`), so a reload, a link
 * from the calendar, and Back all show the same list. Quick find opens a
 * booking from the reference a guest quotes.
 *
 * Owners and booking staff see each booker's name. Finance sees the same
 * bookings, parties, totals, and payments without it: the API never sends it.
 *
 * The shell keys this page on the operator, so another operator's list starts
 * from nothing.
 */

type Load =
  | { kind: "loading" }
  /**
   * `refreshing`: another trip was chosen and its bookings are on the way.
   * The list stays, marked busy, so the trip control keeps focus.
   */
  | { kind: "ready"; page: DayPage; more: "idle" | "loading" | "failed"; refreshing: boolean }
  /** `retrying`: "Try again" is working; the notice stays so focus stays on it. */
  | { kind: "failed"; reason: ReadFailure; failures: number; retrying: boolean };

const tripHeadingId = (tripId: string) => `bookings-trip-${tripId}`;

export function BookingsPage({
  membership,
  focusHeading,
}: { membership: Membership } & FocusOnArrival) {
  const { tenantId, tenantName, role } = membership;
  const seesGuests = canSeeGuests(role);
  // The marina's zone, from the catalog, so "today" is the marina's.
  const [zone, setZone] = useState<string | undefined>();
  // The catalog has answered, with a zone or without one. Until then "today"
  // is the viewer's, so the address waits rather than rewrite the day twice.
  const [zoneSettled, setZoneSettled] = useState(false);
  // A day in the address is known at once; otherwise it waits for the zone.
  const [day, setDay] = useState<LocalDate | null>(() =>
    isLocalDate(new URLSearchParams(window.location.search).get("day") ?? "")
      ? readDay(window.location.search, todayIn())
      : null,
  );
  const [tripId, setTripId] = useState<string | undefined>(() => readTrip(window.location.search));
  const [load, setLoad] = useState<Load>({ kind: "loading" });
  const [attempt, setAttempt] = useState(0);
  const retryRequested = useRef(false);
  const keepList = useRef(false);
  const dayHeading = useRef<HTMLHeadingElement>(null);
  const focusDayOnLoad = useRef(false);
  /** The last page took Show more bookings with it: its first booking takes focus. */
  const focusBookingId = useRef<string | null>(null);
  const today = todayIn(zone);
  const bounds = dayBounds(today);

  useEffect(() => {
    const controller = new AbortController();
    void loadZone(tenantId, controller.signal).then((found) => {
      if (controller.signal.aborted) return;
      if (found) setZone(found);
      setZoneSettled(true);
      setDay((current) => current ?? todayIn(found));
    });
    return () => controller.abort();
  }, [tenantId]);

  useEffect(() => {
    void attempt;
    if (!day) return;
    const controller = new AbortController();
    const retry = retryRequested.current;
    const keep = keepList.current;
    retryRequested.current = false;
    keepList.current = false;
    setLoad((current) => {
      if (retry && current.kind === "failed") return { ...current, retrying: true };
      if (keep && current.kind === "ready") return { ...current, refreshing: true };
      return { kind: "loading" };
    });
    void loadDay(tenantId, { date: day, tripId }, controller.signal).then((result) => {
      if (controller.signal.aborted) return;
      if (result.kind === "ok") {
        setLoad({ kind: "ready", page: result.value, more: "idle", refreshing: false });
        const named = result.value.trips[0]?.timeZone;
        if (named) setZone((known) => known ?? named);
        return;
      }
      // The list and the trip control the person was on go with a failed
      // refresh, so the day's heading takes focus, as it does for a control
      // that went with the change; a failed Try again keeps its button, and
      // focus stays there.
      focusDayOnLoad.current = keep || (focusDayOnLoad.current && !retry);
      setLoad((current) => ({
        kind: "failed",
        reason: result.reason,
        failures: current.kind === "failed" ? current.failures + 1 : 1,
        retrying: false,
      }));
    });
    return () => controller.abort();
  }, [tenantId, day, tripId, attempt]);

  // The address keeps the day and the trip, so a reload shows the same list.
  // Today's list alone goes without a day, so its address always opens today;
  // a trip departs on one day, so it always travels with its day.
  useEffect(() => {
    if (!day || !zoneSettled) return;
    const params = new URLSearchParams(window.location.search);
    if (day === today && !tripId) params.delete("day");
    else params.set("day", day);
    if (tripId) params.set("trip", tripId);
    else params.delete("trip");
    const search = params.toString() ? `?${params}` : "";
    if (search !== window.location.search) {
      const { pathname, hash } = window.location;
      window.history.replaceState(window.history.state, "", `${pathname}${search}${hash}`);
    }
  }, [day, tripId, today, zoneSettled]);

  // A control that goes away with the change hands focus on: to the first
  // booking of a last page, or to the day's heading. Only a settled answer
  // moves focus, never while Try again is still working, and only when focus
  // went with the control: the person may have moved on while it loaded.
  useEffect(() => {
    if (load.kind === "loading" || (load.kind === "failed" && load.retrying)) return;
    let first: string | null = null;
    if (load.kind === "ready") {
      first = focusBookingId.current;
      focusBookingId.current = null;
    }
    const toDay = focusDayOnLoad.current;
    focusDayOnLoad.current = false;
    if ((first === null && !toDay) || !focusIsLost()) return;
    const link = first ? document.querySelector<HTMLElement>(`[data-booking="${first}"]`) : null;
    (link ?? dayHeading.current)?.focus();
  }, [load]);

  const retry = () => {
    retryRequested.current = true;
    focusDayOnLoad.current = true;
    setAttempt((n) => n + 1);
  };

  const goToDay = (next: LocalDate, moveFocus = false) => {
    const target = clampDay(next, today);
    if (moveFocus) focusDayOnLoad.current = true;
    // A trip departs on one day only, so a new day shows every trip.
    setTripId(undefined);
    setDay(target);
  };

  const chooseTrip = (next: string | undefined, moveFocus = false) => {
    if (moveFocus) focusDayOnLoad.current = true;
    else keepList.current = true;
    setTripId(next);
  };

  const loadMore = () => {
    if (load.kind !== "ready" || load.refreshing || !load.page.nextAfter || !day) return;
    const after = load.page.nextAfter;
    setLoad({ ...load, more: "loading" });
    void loadDay(tenantId, { date: day, tripId, after }).then((result) => {
      setLoad((current) => {
        if (current.kind !== "ready" || current.refreshing || current.page.nextAfter !== after) {
          return current;
        }
        if (result.kind !== "ok") return { ...current, more: "failed" };
        if (result.value.nextAfter === null) {
          focusBookingId.current = result.value.bookings[0]?.id ?? "";
        }
        return {
          kind: "ready",
          more: "idle",
          refreshing: false,
          page: {
            trips: result.value.trips,
            bookings: [...current.page.bookings, ...result.value.bookings],
            nextAfter: result.value.nextAfter,
          },
        };
      });
    });
  };

  const page = load.kind === "ready" ? load.page : null;
  const selected = page && tripId ? page.trips.find((t) => t.tripId === tripId) : undefined;
  const announcement = !day
    ? "Loading bookings…"
    : load.kind === "loading" || (load.kind === "ready" && load.refreshing)
      ? `Loading bookings for ${dayText(day, "full", today)}…`
      : page
        ? summary(page, dayText(day, "full", today), tripId, selected)
        : "";

  return (
    <>
      <PageHeader eyebrow={tenantName} title="Bookings" focusHeading={focusHeading} />
      <div className="bk">
        <QuickFind tenantId={tenantId} tenantName={tenantName} />

        <div className="bk-bar">
          <h2 className="bk-bar__day" ref={dayHeading} tabIndex={-1}>
            {day ? (
              <>
                {dayText(day, "full", today)}
                {day === today && (
                  <>
                    {" "}
                    <span className="bk-today">Today</span>
                  </>
                )}
              </>
            ) : (
              <Skeleton width="14rem" height="1.5rem" />
            )}
          </h2>
          <nav className="bk-bar__nav" aria-label="Days">
            <Button
              icon="chevron-left"
              disabled={!day || day <= bounds.first}
              onClick={() => day && goToDay(addDays(day, -1))}
            >
              <span className="bk-bar__word">Previous</span> <VisuallyHidden>day</VisuallyHidden>
            </Button>
            <Button disabled={!day || day === today} onClick={() => goToDay(today)}>
              Today
            </Button>
            <Button
              icon="chevron-right"
              iconPosition="end"
              disabled={!day || day >= bounds.last}
              onClick={() => day && goToDay(addDays(day, 1))}
            >
              <span className="bk-bar__word">Next</span> <VisuallyHidden>day</VisuallyHidden>
            </Button>
          </nav>
        </div>

        {!seesGuests && (
          <p className="bk-note">
            <Icon name="eye-off" />
            <span>
              Guests' names and contact details aren't shown to your role, {roleNames[role]}. You
              see each booking's party, extras, total, and payment.
            </span>
          </p>
        )}

        <p className="tg-visually-hidden" role="status">
          {announcement}
        </p>

        {(!day || load.kind === "loading") && <ListSkeleton />}

        {day && load.kind === "failed" && (
          <ReadFailed
            className="bk-notice"
            reason={load.reason}
            noun="bookings"
            tenantName={tenantName}
            failures={load.failures}
            retrying={load.retrying}
            onRetry={retry}
            otherAction={
              load.reason === "rejected" ? (
                <Button variant="primary" icon="calendar" onClick={() => goToDay(today, true)}>
                  Go to today
                </Button>
              ) : undefined
            }
          />
        )}

        {day && page && (
          <Day
            day={day}
            today={today}
            page={page}
            tripId={tripId}
            selected={selected}
            seesGuests={seesGuests}
            more={load.kind === "ready" ? load.more : "idle"}
            refreshing={load.kind === "ready" && load.refreshing}
            onTrip={chooseTrip}
            onToday={() => goToDay(today, true)}
            onMore={loadMore}
          />
        )}
      </div>
    </>
  );
}

function summary(
  page: DayPage,
  dayName: string,
  tripId: string | undefined,
  selected: BookingDayTrip | undefined,
): string {
  if (tripId && !selected && page.trips.length > 0) {
    return `That trip doesn't depart on ${dayName}.`;
  }
  const trips = selected ? [selected] : page.trips;
  const bookings = trips.reduce((n, t) => n + t.bookings, 0);
  const guests = trips.reduce((n, t) => n + t.guests, 0);
  const on = selected ? `on ${selected.productName}, ${dayName}` : `on ${dayName}`;
  if (bookings === 0) return `No bookings ${on}.`;
  return `${bookings === 1 ? "1 booking" : `${bookings} bookings`}, ${guestsText(guests)} ${on}.`;
}

function tripTime(trip: BookingDayTrip): string {
  return formatTripTime(trip.localStartTime, trip.startsAt, trip.timeZone);
}

function Day({
  day,
  today,
  page,
  tripId,
  selected,
  seesGuests,
  more,
  refreshing,
  onTrip,
  onToday,
  onMore,
}: {
  day: LocalDate;
  today: LocalDate;
  page: DayPage;
  tripId: string | undefined;
  selected: BookingDayTrip | undefined;
  seesGuests: boolean;
  more: "idle" | "loading" | "failed";
  refreshing: boolean;
  onTrip: (tripId: string | undefined, moveFocus?: boolean) => void;
  onToday: () => void;
  onMore: () => void;
}) {
  const dayName = dayText(day, "full", today);
  if (page.trips.length === 0) {
    return (
      <EmptyState
        icon="calendar"
        title={`No trips on ${dayName}`}
        actions={
          day !== today ? (
            <Button icon="calendar" onClick={onToday}>
              Go to today
            </Button>
          ) : undefined
        }
      >
        <p>Nothing departs that day, so there are no bookings to show.</p>
      </EmptyState>
    );
  }
  const zones = [...new Set(page.trips.map((t) => t.timeZone))];
  const [zone] = zones;
  const shown = selected ? [selected] : tripId ? [] : page.trips;
  // The address named a trip this day does not have: nothing is listed, so
  // no count is shown either.
  const unknownTrip = Boolean(tripId && !selected);
  const totals = (selected ? [selected] : page.trips).reduce(
    (sum, t) => ({ bookings: sum.bookings + t.bookings, guests: sum.guests + t.guests }),
    { bookings: 0, guests: 0 },
  );
  return (
    <div className="bk-day" aria-busy={refreshing || undefined}>
      <div className="bk-filters">
        <SelectField
          label="Trip"
          className="bk-filters__trip"
          value={selected?.tripId ?? ""}
          onChange={(e) => onTrip(e.target.value || undefined)}
          options={[
            { value: "", label: "All trips" },
            ...page.trips.map((t) => ({
              value: t.tripId,
              label: `${tripTime(t)}, ${t.productName}`,
            })),
          ]}
        />
        {!unknownTrip && (
          <p className="bk-filters__totals">
            {totals.bookings === 1 ? "1 booking" : `${totals.bookings} bookings`},{" "}
            {guestsText(totals.guests)}
          </p>
        )}
      </div>

      <p className="bk-zone">
        <Icon name="clock" />
        <span>
          {zones.length === 1 && zone
            ? `Times are local to ${zoneCity(zone)}, where these trips depart.`
            : "Times are local to each trip's departure point."}
        </span>
      </p>

      {tripId && !selected && (
        <Notice
          tone="warning"
          className="bk-notice"
          title={`That trip doesn't depart on ${dayName}`}
          actions={
            <Button icon="list" onClick={() => onTrip(undefined, true)}>
              Show all trips
            </Button>
          }
        >
          <p>The address named a trip that isn't on this day's list.</p>
        </Notice>
      )}

      {shown.map((trip) => (
        <TripBookings
          key={trip.tripId}
          trip={trip}
          alone={Boolean(selected)}
          today={today}
          showZone={zones.length > 1}
          bookings={page.bookings.filter((b) => b.tripId === trip.tripId)}
          complete={page.nextAfter === null}
          seesGuests={seesGuests}
        />
      ))}

      {page.nextAfter && !refreshing && (
        <div className="bk-more">
          {more === "failed" && (
            <Notice tone="error" className="bk-notice" title="More bookings didn't load">
              <p>Check your connection, then try again.</p>
            </Notice>
          )}
          <Button busy={more === "loading"} busyLabel="Loading more…" onClick={onMore}>
            {more === "failed" ? "Try again" : "Show more bookings"}
          </Button>
        </div>
      )}
    </div>
  );
}

function TripBookings({
  trip,
  alone,
  today,
  bookings,
  complete,
  showZone,
  seesGuests,
}: {
  trip: BookingDayTrip;
  /** The list is filtered to this trip. */
  alone: boolean;
  today: LocalDate;
  bookings: BookingListItem[];
  /** Every page is loaded, so an empty trip really has no bookings. */
  complete: boolean;
  showZone: boolean;
  seesGuests: boolean;
}) {
  const time = tripTime(trip);
  const state = salesStates[trip.salesState];
  const where = showZone ? `, ${zoneCity(trip.timeZone)} time` : "";
  // A trip that has left will not take more bookings, so "yet" would mislead.
  const departed = Date.parse(trip.startsAt) <= Date.now();
  return (
    <section className="bk-trip" aria-labelledby={tripHeadingId(trip.tripId)}>
      <div className="bk-trip__head">
        <h3 className="bk-trip__title" id={tripHeadingId(trip.tripId)}>
          <span className="bk-trip__time">{time}</span>
          <VisuallyHidden>{where}, </VisuallyHidden> {trip.productName}
        </h3>
        <p className="bk-trip__meta">
          <span>
            <Icon name="boat" />
            <VisuallyHidden>Boat: </VisuallyHidden>
            {trip.boatName}
          </span>
          <span>
            <Icon name="users" />
            {trip.bookings === 0
              ? departed
                ? "No bookings"
                : "No bookings yet"
              : `${trip.bookings === 1 ? "1 booking" : `${trip.bookings} bookings`}, ${guestsText(trip.guests)}`}
          </span>
          {showZone && (
            <span>
              <Icon name="clock" />
              {zoneCity(trip.timeZone)}
            </span>
          )}
        </p>
        <div className="bk-trip__side">
          {trip.salesState !== "published" && (
            <StatusBadge tone={state.tone} icon={state.icon}>
              {state.label}
            </StatusBadge>
          )}
          {seesGuests && trip.bookings > 0 && (
            <ConsoleButtonLink
              href={rosterHref(trip.tripId)}
              icon="printer"
              className="bk-trip__roster"
            >
              Roster{" "}
              <VisuallyHidden>
                for {trip.productName}, {dayText(trip.localDate, "medium", today)}, {time}
              </VisuallyHidden>
            </ConsoleButtonLink>
          )}
        </div>
      </div>
      {/* A trip with nothing booked says so in its line above, and with a
          designed empty state when the list shows it alone; one whose bookings
          are on a later page says where they are. */}
      {bookings.length > 0 ? (
        <BookingRows bookings={bookings} seesGuests={seesGuests} />
      ) : !complete && trip.bookings > 0 ? (
        <p className="bk-trip__none">Not loaded yet. Choose Show more bookings below.</p>
      ) : alone && trip.bookings === 0 ? (
        <EmptyState
          icon="users"
          headingLevel={4}
          className="bk-trip__empty"
          title={departed ? "No one booked this trip" : "No bookings on this trip yet"}
        >
          <p>
            {departed
              ? "The trip has departed."
              : "Bookings appear here as guests book. Choose All trips to see the rest of the day."}
          </p>
        </EmptyState>
      ) : null}
    </section>
  );
}

function BookingRows({
  bookings,
  seesGuests,
}: {
  bookings: BookingListItem[];
  seesGuests: boolean;
}) {
  return (
    <div className={seesGuests ? "bk-table" : "bk-table bk-table--no-booker"}>
      {/* Column names for the eye on wide screens; each row names its own facts for the ear. */}
      <div className="bk-cols" aria-hidden="true">
        <span>Reference</span>
        {seesGuests && <span>Booker</span>}
        <span>Party</span>
        <span>Extras</span>
        <span className="bk-cols__money">Total</span>
        <span>Status</span>
      </div>
      <ul className="bk-rows">
        {bookings.map((b) => {
          const payment = paymentCopy(b.payment);
          const state = bookingStates[b.state];
          return (
            <li key={b.id} className="bk-row">
              <ConsoleLink
                href={bookingHref(b.id)}
                className="bk-row__ref tap-target"
                data-booking={b.id}
              >
                <VisuallyHidden>Booking </VisuallyHidden>
                {b.reference}
              </ConsoleLink>
              <dl className="bk-row__facts">
                {seesGuests && (
                  <div className="bk-fact bk-fact--booker">
                    <dt className="bk-fact__label">Booker</dt>
                    <dd>{b.booker?.name ?? "Not given"}</dd>
                  </div>
                )}
                <div className="bk-fact">
                  <dt className="bk-fact__label">Party</dt>
                  <dd>
                    <span className="bk-fact__strong">{guestsText(b.party.guests)}</span>{" "}
                    <span className="bk-fact__detail">{partyDetail(b.party)}</span>
                  </dd>
                </div>
                <div className="bk-fact">
                  <dt className="bk-fact__label">Extras</dt>
                  <dd>{extrasText(b.extras)}</dd>
                </div>
                <div className="bk-fact bk-fact--money">
                  <dt className="bk-fact__label">Total</dt>
                  <dd className="bk-money">{formatMoney(b.total, b.currency)}</dd>
                </div>
                <div className="bk-fact bk-fact--status">
                  <dt className="bk-fact__label">Status</dt>
                  <dd className="bk-badges">
                    <StatusBadge tone={payment.tone} icon={payment.icon}>
                      {payment.label}
                    </StatusBadge>
                    <StatusBadge tone={state.tone} icon={state.icon}>
                      {state.label}
                    </StatusBadge>
                  </dd>
                </div>
              </dl>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

function ListSkeleton() {
  return (
    <div className="bk-skeleton" aria-hidden="true">
      {[3, 2].map((rows, i) => (
        <div key={i} className="bk-trip">
          <Skeleton width="min(20rem, 80%)" height="1.5rem" />
          {Array.from({ length: rows }, (_, row) => (
            <div key={row} className="bk-row bk-row--skeleton">
              <Skeleton width="6rem" height="1.25rem" />
              <Skeleton variant="text" width="min(28rem, 90%)" />
            </div>
          ))}
        </div>
      ))}
    </div>
  );
}

/**
 * Find a booking by the reference a guest quotes. The reference is read the
 * way people say it (case, spaces, and hyphens ignored; O, I, and L as 0, 1,
 * and 1). A match opens the booking; anything else says why in the field.
 */
function QuickFind({ tenantId, tenantName }: { tenantId: string; tenantName: string }) {
  const navigate = useNavigate();
  const [value, setValue] = useState("");
  const [problem, setProblem] = useState<string | undefined>();
  const [busy, setBusy] = useState(false);
  const field = useRef<HTMLInputElement>(null);
  const inputId = useId();
  const live = useRef(true);
  useEffect(() => {
    live.current = true;
    return () => {
      live.current = false;
    };
  }, []);

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (busy) return;
    const reference = normalizeBookingReference(value.trim());
    if (!reference) {
      setProblem("Enter the 8 letters and numbers of a booking reference, such as QKG6ERBF.");
      field.current?.focus();
      return;
    }
    setBusy(true);
    setProblem(undefined);
    const found = await findReference(tenantId, reference);
    if (!live.current) return;
    setBusy(false);
    if (found.kind === "ok") {
      navigate(bookingHref(found.value.id));
      return;
    }
    const why: Record<ReadFailure, string> = {
      not_found: `No booking ${reference} at ${tenantName}. Check the reference with the guest.`,
      signed_out: "You're signed out. Sign in again, then find the booking.",
      forbidden: "Your role can't look up bookings.",
      suspended: `While ${tenantName} is suspended, bookings can't be shown.`,
      no_access: `You no longer have access to ${tenantName}. Ask one of its owners.`,
      rejected: "That reference couldn't be looked up. Check it and try again.",
      unreadable: "TideGrid sent an answer this console can't read. Try again in a moment.",
      unreachable: "The console can't reach TideGrid. Check your connection, then try again.",
      unavailable: "TideGrid isn't responding right now. Try again in a moment.",
    };
    setProblem(why[found.reason]);
    field.current?.focus();
  };

  // The design system's field parts, laid out so the button always sits
  // beside the input, whatever the hint or an error makes of the height.
  return (
    <search className="bk-find" aria-label="Find a booking">
      <form className="bk-find__form tg-field" onSubmit={submit} noValidate>
        <label className="tg-field__label" htmlFor={inputId}>
          Find by booking reference
        </label>
        <p className="tg-field__hint" id={`${inputId}-hint`}>
          The 8 letters and numbers the guest quotes
        </p>
        <div className="bk-find__row">
          <input
            ref={field}
            id={inputId}
            className="tg-field__input bk-find__input"
            name="reference"
            value={value}
            aria-invalid={problem ? true : undefined}
            aria-describedby={`${inputId}-hint${problem ? ` ${inputId}-error` : ""}`}
            autoComplete="off"
            autoCapitalize="characters"
            spellCheck={false}
            maxLength={20}
            onChange={(e) => {
              setValue(e.target.value);
              if (problem) setProblem(undefined);
            }}
          />
          <Button type="submit" icon="search" busy={busy} busyLabel="Finding…">
            Find
          </Button>
        </div>
        {problem && (
          <p className="tg-field__error" id={`${inputId}-error`}>
            <Icon name="x-octagon" />
            <span>{problem}</span>
          </p>
        )}
      </form>
      {/* Focus stays in the field, so the find's progress and any problem are
          said here as they change (WCAG 4.1.3). */}
      <p className="tg-visually-hidden" role="status">
        {busy ? "Finding the booking…" : (problem ?? "")}
      </p>
    </search>
  );
}
