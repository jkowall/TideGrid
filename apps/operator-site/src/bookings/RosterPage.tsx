import type { Membership, TripRoster } from "@tidegrid/contracts";
import {
  Button,
  EmptyState,
  Icon,
  Notice,
  Skeleton,
  StatusBadge,
  VisuallyHidden,
} from "@tidegrid/design-system/components";
import {
  formatDate,
  formatDuration,
  formatTripTime,
  localPartsOf,
  todayIn,
  zoneAbbreviation,
} from "@tidegrid/design-system/format";
import { type RefObject, useEffect, useLayoutEffect, useRef, useState } from "react";
import { focusIsLost } from "../focus.ts";
import type { ReadFailure } from "../http.ts";
import { ConsoleButtonLink, ConsoleLink } from "../navigation.tsx";
import { newBookingHref, sourceText, takesBooking } from "../new-booking/model.ts";
import { type FocusOnArrival, PageHeader } from "../PageHeader.tsx";
import { canCreateBookings, canSeeGuests, roleNames } from "../roles.ts";
import { TripWaiversCard } from "../waivers/TripWaivers.tsx";
import { loadRoster } from "./api.ts";
import {
  bookingsHref,
  countText,
  dayText,
  extrasText,
  guestsText,
  instantText,
  partyDetail,
  paymentCopy,
} from "./model.ts";
import { canRetry, ReadFailed } from "./States.tsx";

/**
 * A trip's roster (G2.12b): every booking with its reference, booker, party,
 * extras, and payment, the guest totals, and when and where to meet, on screen
 * and on paper. It is a booking-management view, not a passenger manifest:
 * each party lists the names its guests have given so far (lane 1, G2.11c),
 * and each person's waiver status follows the roster in its own card (G2.15),
 * which the page says. Owners and booking staff only, as the API.
 */

type Load =
  | { kind: "loading" }
  | { kind: "ready"; roster: TripRoster }
  | { kind: "failed"; reason: ReadFailure; failures: number; retrying: boolean };

export function RosterPage({
  membership,
  tripId,
  focusHeading,
}: { membership: Membership; tripId: string } & FocusOnArrival) {
  const { tenantName, role } = membership;
  if (!canSeeGuests(role)) {
    return (
      <>
        <PageHeader eyebrow={tenantName} title="Roster" focusHeading={focusHeading} />
        <EmptyState
          icon="lock"
          title="Your role can't see rosters"
          actions={
            <ConsoleButtonLink href="/bookings" icon="list">
              Go to bookings
            </ConsoleButtonLink>
          }
        >
          <p>
            A roster names the guests on a trip, so it's for owners and booking staff. Your role,{" "}
            {roleNames[role]}, sees the same bookings, totals, and payments on Bookings.
          </p>
        </EmptyState>
      </>
    );
  }
  return <Roster membership={membership} tripId={tripId} focusHeading={focusHeading} />;
}

function Roster({
  membership,
  tripId,
  focusHeading,
}: { membership: Membership; tripId: string } & FocusOnArrival) {
  const { tenantId, tenantName } = membership;
  const [load, setLoad] = useState<Load>({ kind: "loading" });
  const [attempt, setAttempt] = useState(0);
  const retryRequested = useRef(false);
  const heading = useRef<HTMLHeadingElement>(null);
  /** Try again went with its notice: the page's heading takes focus. */
  const focusHeadingOnLoad = useRef(false);

  useEffect(() => {
    void attempt;
    const controller = new AbortController();
    const retry = retryRequested.current;
    retryRequested.current = false;
    setLoad((current) =>
      retry && current.kind === "failed" ? { ...current, retrying: true } : { kind: "loading" },
    );
    void loadRoster(tenantId, tripId, controller.signal).then((result) => {
      if (controller.signal.aborted) return;
      focusHeadingOnLoad.current = retry && (result.kind === "ok" || !canRetry(result.reason));
      if (result.kind === "ok") {
        setLoad({ kind: "ready", roster: result.value });
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
  }, [tenantId, tripId, attempt]);

  // Try again went with its notice: the heading takes focus, unless the person
  // has moved it elsewhere while the page loaded.
  useEffect(() => {
    if (load.kind === "loading" || !focusHeadingOnLoad.current) return;
    focusHeadingOnLoad.current = false;
    if (focusIsLost()) heading.current?.focus();
  }, [load]);

  const roster = load.kind === "ready" ? load.roster : null;
  return (
    <>
      <PageHeader
        eyebrow={tenantName}
        title="Roster"
        focusHeading={focusHeading}
        headingRef={heading}
      />
      <p className="tg-visually-hidden" role="status">
        {load.kind === "loading"
          ? "Loading the roster…"
          : roster
            ? `Roster for ${roster.trip.productName}, ${dayText(
                roster.trip.localDate,
                "full",
                todayIn(roster.trip.timeZone),
              )}: ${
                roster.totals.bookings === 1 ? "1 booking" : `${roster.totals.bookings} bookings`
              }, ${guestsText(roster.totals.guests)}.`
            : ""}
      </p>
      {load.kind === "loading" && <RosterSkeleton />}
      {load.kind === "failed" &&
        (load.reason === "not_found" ? (
          <EmptyState
            icon="compass"
            title="This trip isn't here"
            actions={
              <ConsoleButtonLink href="/bookings" icon="list">
                Go to bookings
              </ConsoleButtonLink>
            }
          >
            <p>
              {tenantName} has no trip at this address. It may belong to another operator, or the
              link may be incomplete.
            </p>
          </EmptyState>
        ) : (
          <ReadFailed
            className="bk-notice"
            reason={load.reason}
            noun="the roster"
            tenantName={tenantName}
            failures={load.failures}
            retrying={load.retrying}
            onRetry={() => {
              retryRequested.current = true;
              setAttempt((n) => n + 1);
            }}
          />
        ))}
      {roster && (
        <RosterSheet
          roster={roster}
          tenantName={tenantName}
          canBook={canCreateBookings(membership.role)}
        />
      )}
      {/* Waivers (G2.15): a self-contained card; this line is its only placement. */}
      {roster && <TripWaiversCard tenantId={tenantId} tripId={tripId} />}
    </>
  );
}

function RosterSheet({
  roster,
  tenantName,
  canBook,
}: {
  roster: TripRoster;
  tenantName: string;
  /** Owners and booking staff book a guest onto this trip from here (G2.12d). */
  canBook: boolean;
}) {
  const { trip, location, totals } = roster;
  const zone = trip.timeZone;
  const today = todayIn(zone);
  const start = formatTripTime(trip.localStartTime, trip.startsAt, zone);
  const end = localPartsOf(trip.endsAtLocal);
  const endText = end.date === trip.localDate ? end.time : `${end.time} next day`;
  const abbreviation = zoneAbbreviation(new Date(trip.startsAt), zone);
  return (
    <div className="roster">
      <div className="roster-tools">
        <ConsoleLink
          href={bookingsHref(trip.localDate, trip.tripId)}
          className="bd-back tap-target"
        >
          <Icon name="arrow-left" />
          <span>Bookings on {dayText(trip.localDate, "medium", today)}</span>
        </ConsoleLink>
        <div className="roster-tools__actions">
          {canBook && takesBooking(trip, new Date()) && (
            <ConsoleButtonLink
              href={newBookingHref(trip.tripId)}
              icon="plus"
              className="roster-tools__book"
            >
              New booking
            </ConsoleButtonLink>
          )}
          <Button variant="primary" icon="printer" onClick={() => window.print()}>
            Print roster
          </Button>
        </div>
      </div>

      <header className="roster-head">
        <p className="roster-head__operator">{tenantName}</p>
        <h2 className="roster-head__trip">{trip.productName}</h2>
        <p className="roster-head__when">
          {formatDate(trip.localDate, "full", { year: true })}, {start} to {endText}{" "}
          <span className="roster-head__zone">
            ({abbreviation}, {formatDuration(trip.durationMinutes)})
          </span>
        </p>
        <dl className="roster-facts">
          <div>
            <dt>Meet at</dt>
            <dd>
              {location.meetingPoint || location.name}
              {location.meetingPoint && `, ${location.name}`}
              {location.meetingInstructions && (
                <span className="bd-block">{location.meetingInstructions}</span>
              )}
            </dd>
          </div>
          <div>
            <dt>Boat</dt>
            <dd>{trip.boatName}</dd>
          </div>
          <div>
            <dt>Guests</dt>
            <dd>
              <strong>{guestsText(totals.guests)}</strong> in{" "}
              {totals.bookings === 1 ? "1 booking" : `${totals.bookings} bookings`}
              {trip.productKind === "shared_seat"
                ? ` of ${trip.seats} seats`
                : `, private charter for up to ${trip.seats}`}
              {totals.tickets.length > 0 && (
                <span className="bd-block">
                  {totals.tickets.map((t) => countText(t.quantity, t.name)).join(", ")}
                </span>
              )}
            </dd>
          </div>
          <div>
            <dt>Extras to prepare</dt>
            <dd>{extrasText(totals.extras)}</dd>
          </div>
        </dl>
      </header>

      <Notice
        tone="info"
        announce="none"
        className="roster-notice"
        title="Names as guests give them; waivers follow the roster"
      >
        <p>
          Each party lists the names its guests have added on their booking page so far. A place not
          named yet counts in the party only. Each person's waiver status is under Waivers, after
          the roster, and prints with it.
        </p>
      </Notice>

      {roster.bookings.length === 0 ? (
        <EmptyState icon="users" title="No bookings on this trip yet" headingLevel={3}>
          <p>Bookings appear here as guests book. Print again closer to departure.</p>
        </EmptyState>
      ) : (
        <RosterTable roster={roster} today={today} start={start} />
      )}

      <p className="roster-foot">
        A booking roster, not a passenger manifest, check-in, or boarding record. It lists the
        confirmed bookings as of {instantText(roster.generatedAt, zone)}.
      </p>
    </div>
  );
}

/**
 * Whether an element's content is wider than the element, kept current as
 * either resizes. Without ResizeObserver it measures once.
 */
export function useOverflows(ref: RefObject<HTMLElement | null>): boolean {
  const [overflows, setOverflows] = useState(false);
  useLayoutEffect(() => {
    const element = ref.current;
    if (!element) return;
    const measure = () => setOverflows(element.scrollWidth > element.clientWidth + 1);
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    if (element.firstElementChild) observer.observe(element.firstElementChild);
    return () => observer.disconnect();
  }, [ref]);
  return overflows;
}

/**
 * The roster's table. On a phone it can be wider than the screen and scrolls
 * inside its region, never the page; while it scrolls, a keyboard reaches
 * the scroll through the region (WCAG 2.1.1). When it fits, as on a desktop,
 * the region is not a tab stop (G2.12c).
 *
 * Each booking's party is one cell (PartyCell): the guest count, the tickets
 * or the charter, and the names given so far.
 */
function RosterTable({
  roster,
  today,
  start,
}: {
  roster: TripRoster;
  today: string;
  start: string;
}) {
  const { trip } = roster;
  const region = useRef<HTMLElement>(null);
  const scrolls = useOverflows(region);
  return (
    <section
      ref={region}
      className="roster-table-wrap"
      aria-label="Bookings on this trip"
      // A scrolling region takes keyboard focus while it scrolls (WCAG 2.1.1).
      tabIndex={scrolls ? 0 : undefined}
    >
      <table className="roster-table">
        <caption className="tg-visually-hidden">
          Bookings on {trip.productName}, {dayText(trip.localDate, "full", today)}, {start}
        </caption>
        <thead>
          <tr>
            <th scope="col" className="roster-table__n">
              <VisuallyHidden>Number</VisuallyHidden>
              <span aria-hidden="true">#</span>
            </th>
            <th scope="col" className="roster-table__pin">
              Reference
            </th>
            <th scope="col">Booker</th>
            <th scope="col">Party</th>
            <th scope="col">Extras</th>
            <th scope="col">Payment</th>
          </tr>
        </thead>
        <tbody>
          {roster.bookings.map((b, i) => {
            const payment = paymentCopy(b.payment);
            return (
              <tr key={b.id}>
                <td className="roster-table__n">{i + 1}</td>
                <th scope="row" className="roster-table__ref roster-table__pin">
                  {b.reference}
                </th>
                <td>
                  {b.booker.name}
                  {b.source === "staff_assisted" && (
                    <span className="bd-block roster-table__detail">
                      {sourceText(b.source, b.channel)}
                    </span>
                  )}
                </td>
                <td>
                  <PartyCell booking={b} />
                </td>
                <td>{extrasText(b.extras)}</td>
                <td>
                  <StatusBadge tone={payment.tone} icon={payment.icon}>
                    {payment.label}
                  </StatusBadge>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </section>
  );
}

/**
 * A booking's party on the roster: the guest count, the tickets or the
 * charter, and the names its guests have given so far, by place.
 */
function PartyCell({ booking }: { booking: TripRoster["bookings"][number] }) {
  const { participants } = booking;
  return (
    <>
      <strong>{guestsText(booking.party.guests)}</strong>
      <span className="bd-block roster-table__detail">{partyDetail(booking.party)}</span>
      {participants.length > 0 && (
        <ul className="roster-table__names" aria-label="Named so far">
          {participants.map((p) => (
            <li key={p.position}>
              {p.name}
              {p.minor && <span className="roster-table__detail"> (under 18)</span>}
            </li>
          ))}
        </ul>
      )}
      <span className="bd-block roster-table__detail">
        {participants.length === booking.party.guests
          ? "Everyone named"
          : `${participants.length} of ${booking.party.guests} named`}
      </span>
    </>
  );
}

function RosterSkeleton() {
  return (
    <div className="roster roster--skeleton" aria-hidden="true">
      <Skeleton width="min(22rem, 80%)" height="2rem" />
      <Skeleton variant="text" width="min(30rem, 90%)" />
      {Array.from({ length: 4 }, (_, i) => (
        <Skeleton key={i} height="2.75rem" />
      ))}
    </div>
  );
}
