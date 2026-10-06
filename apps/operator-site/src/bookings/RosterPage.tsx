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
  zoneAbbreviation,
} from "@tidegrid/design-system/format";
import { useEffect, useRef, useState } from "react";
import type { ReadFailure } from "../http.ts";
import { ConsoleButtonLink, ConsoleLink } from "../navigation.tsx";
import { type FocusOnArrival, PageHeader } from "../PageHeader.tsx";
import { canSeeGuests, roleNames } from "../roles.ts";
import { loadRoster } from "./api.ts";
import {
  bookingsHref,
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
 * participants and waivers are not collected yet, and the page says so rather
 * than printing empty columns. Owners and booking staff only, as the API.
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

  useEffect(() => {
    if (load.kind !== "loading" && focusHeadingOnLoad.current) {
      focusHeadingOnLoad.current = false;
      heading.current?.focus();
    }
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
            ? `Roster for ${roster.trip.productName}, ${formatDate(roster.trip.localDate, "full")}: ${
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
      {roster && <RosterSheet roster={roster} tenantName={tenantName} />}
    </>
  );
}

function RosterSheet({ roster, tenantName }: { roster: TripRoster; tenantName: string }) {
  const { trip, location, totals } = roster;
  const zone = trip.timeZone;
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
          <span>Bookings on {formatDate(trip.localDate, "medium")}</span>
        </ConsoleLink>
        <Button variant="primary" icon="printer" onClick={() => window.print()}>
          Print roster
        </Button>
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
                  {totals.tickets.map((t) => `${t.quantity} ${t.name}`).join(", ")}
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
        title="Participants and waivers aren't collected yet"
      >
        <p>
          This roster lists each booking and the size of its party, not the names of everyone
          aboard. Participant names and waiver status arrive with a later build.
        </p>
      </Notice>

      {roster.bookings.length === 0 ? (
        <EmptyState icon="users" title="No bookings on this trip yet" headingLevel={3}>
          <p>Bookings appear here as guests book. Print again closer to departure.</p>
        </EmptyState>
      ) : (
        // On a phone the table can be wider than the screen and scrolls inside
        // this region, never the page; a keyboard reaches the scroll through it.
        <section
          className="roster-table-wrap"
          aria-label="Bookings on this trip"
          // biome-ignore lint/a11y/noNoninteractiveTabindex: a scrolling region must take keyboard focus (WCAG 2.1.1).
          tabIndex={0}
        >
          <table className="roster-table">
            <caption className="tg-visually-hidden">
              Bookings on {trip.productName}, {formatDate(trip.localDate, "full")}, {start}
            </caption>
            <thead>
              <tr>
                <th scope="col" className="roster-table__n">
                  <VisuallyHidden>Number</VisuallyHidden>
                  <span aria-hidden="true">#</span>
                </th>
                <th scope="col">Reference</th>
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
                    <th scope="row" className="roster-table__ref">
                      {b.reference}
                    </th>
                    <td>{b.booker.name}</td>
                    <td>
                      <strong>{guestsText(b.party.guests)}</strong>
                      <span className="bd-block roster-table__detail">{partyDetail(b.party)}</span>
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
      )}

      <p className="roster-foot">
        A booking roster, not a passenger manifest, check-in, or boarding record. It lists the
        confirmed bookings as of {instantText(roster.generatedAt, zone)}.
      </p>
    </div>
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
