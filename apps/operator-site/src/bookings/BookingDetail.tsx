import type { BookingDetail, Membership } from "@tidegrid/contracts";
import {
  EmptyState,
  Icon,
  Ledger,
  Skeleton,
  StatusBadge,
  VisuallyHidden,
} from "@tidegrid/design-system/components";
import {
  formatDuration,
  formatMoney,
  formatTripTime,
  localPartsOf,
  todayIn,
  zoneCity,
} from "@tidegrid/design-system/format";
import { useEffect, useRef, useState } from "react";
import { focusIsLost } from "../focus.ts";
import type { ReadFailure } from "../http.ts";
import { ConsoleButtonLink, ConsoleLink } from "../navigation.tsx";
import { type FocusOnArrival, PageHeader } from "../PageHeader.tsx";
import { canSeeGuests, roleNames } from "../roles.ts";
import { loadBooking } from "./api.ts";
import { MaskedReference } from "./MaskedReference.tsx";
import {
  bookingStates,
  bookingsHref,
  countText,
  dayText,
  extrasText,
  guestsText,
  instantText,
  orderRows,
  paymentCopy,
  providerName,
  rosterHref,
  timelineLabel,
} from "./model.ts";
import { canRetry, ReadFailed } from "./States.tsx";

/**
 * One booking (G2.12b): the trip and where to meet, the guest (for roles that
 * may see them), the party and extras, the immutable order, the payment with
 * its provider reference masked, any refund, and what happened when. Read
 * only: changes to a booking arrive with later goals.
 */

type Load =
  | { kind: "loading" }
  | { kind: "ready"; booking: BookingDetail }
  | { kind: "failed"; reason: ReadFailure; failures: number; retrying: boolean };

export function BookingDetailPage({
  membership,
  bookingId,
  focusHeading,
}: { membership: Membership; bookingId: string } & FocusOnArrival) {
  const { tenantId, tenantName, role } = membership;
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
    void loadBooking(tenantId, bookingId, controller.signal).then((result) => {
      if (controller.signal.aborted) return;
      focusHeadingOnLoad.current = retry && (result.kind === "ok" || !canRetry(result.reason));
      if (result.kind === "ok") {
        setLoad({ kind: "ready", booking: result.value });
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
  }, [tenantId, bookingId, attempt]);

  // Try again went with its notice: the heading takes focus, unless the person
  // has moved it elsewhere while the page loaded.
  useEffect(() => {
    if (load.kind === "loading" || !focusHeadingOnLoad.current) return;
    focusHeadingOnLoad.current = false;
    if (focusIsLost()) heading.current?.focus();
  }, [load]);

  const retry = () => {
    retryRequested.current = true;
    setAttempt((n) => n + 1);
  };

  const booking = load.kind === "ready" ? load.booking : null;
  return (
    <>
      <PageHeader
        eyebrow={tenantName}
        title={booking ? `Booking ${booking.reference}` : "Booking"}
        focusHeading={focusHeading}
        headingRef={heading}
      />
      <p className="tg-visually-hidden" role="status">
        {load.kind === "loading"
          ? "Loading the booking…"
          : booking
            ? `Booking ${booking.reference}, ${booking.trip.productName}, ${dayText(
                booking.trip.localDate,
                "full",
                todayIn(booking.trip.timeZone),
              )}.`
            : ""}
      </p>
      {load.kind === "loading" && <DetailSkeleton />}
      {load.kind === "failed" &&
        (load.reason === "not_found" ? (
          <EmptyState
            icon="compass"
            title="This booking isn't here"
            actions={
              <ConsoleButtonLink href="/bookings" icon="list">
                Go to bookings
              </ConsoleButtonLink>
            }
          >
            <p>
              {tenantName} has no booking at this address. It may belong to another operator, or the
              link may be incomplete. Quick find on Bookings opens a booking from its reference.
            </p>
          </EmptyState>
        ) : (
          <ReadFailed
            className="bk-notice"
            reason={load.reason}
            noun="this booking"
            tenantName={tenantName}
            failures={load.failures}
            retrying={load.retrying}
            onRetry={retry}
          />
        ))}
      {booking && (
        <Detail booking={booking} seesGuests={canSeeGuests(role)} roleName={roleNames[role]} />
      )}
    </>
  );
}

function Detail({
  booking,
  seesGuests,
  roleName,
}: {
  booking: BookingDetail;
  seesGuests: boolean;
  roleName: string;
}) {
  const { trip, location } = booking;
  const zone = trip.timeZone;
  const today = todayIn(zone);
  const start = formatTripTime(trip.localStartTime, trip.startsAt, zone);
  const end = localPartsOf(trip.endsAtLocal);
  const endText = end.date === trip.localDate ? end.time : `${end.time} next day`;
  const payment = paymentCopy({
    state: booking.payment.state,
    refund: booking.refund ? { state: booking.refund.state, amount: booking.refund.amount } : null,
  });
  const state = bookingStates[booking.state];
  return (
    <div className="bd">
      <div className="bd-top">
        <ConsoleLink href={bookingsHref(trip.localDate)} className="bd-back tap-target">
          <Icon name="arrow-left" />
          <span>Bookings on {dayText(trip.localDate, "medium", today)}</span>
        </ConsoleLink>
        <div className="bd-badges">
          <StatusBadge tone={state.tone} icon={state.icon}>
            {state.label}
          </StatusBadge>
          <StatusBadge tone={payment.tone} icon={payment.icon}>
            {payment.label}
          </StatusBadge>
        </div>
      </div>
      <p className="bd-lede">
        Booked online by the guest. Confirmed {instantText(booking.confirmedAt, zone)}.
        {booking.reacquired &&
          " The payment arrived after the checkout's hold ran out, and the seats were still free."}
      </p>

      <div className="bd-grid">
        <section className="console-card bd-card" aria-labelledby="bd-trip">
          <h2 id="bd-trip">Trip</h2>
          <p className="bd-trip__name">{trip.productName}</p>
          <dl className="console-dl">
            <dt>When</dt>
            <dd>
              {dayText(trip.localDate, "full", today)}, {start} to {endText}
              <span className="bd-muted">
                {" "}
                ({formatDuration(trip.durationMinutes)}, {zoneCity(zone)} time)
              </span>
            </dd>
            <dt>Boat</dt>
            <dd>{trip.boatName}</dd>
            <dt>Meet at</dt>
            <dd>
              {location.meetingPoint || location.name}
              {location.meetingPoint && <span className="bd-muted">, {location.name}</span>}
              {location.meetingInstructions && (
                <span className="bd-block">{location.meetingInstructions}</span>
              )}
            </dd>
          </dl>
          <div className="bd-actions">
            <ConsoleButtonLink href={bookingsHref(trip.localDate, trip.tripId)} icon="list">
              Bookings on this trip
            </ConsoleButtonLink>
            {seesGuests && (
              <ConsoleButtonLink href={rosterHref(trip.tripId)} icon="printer">
                Roster
              </ConsoleButtonLink>
            )}
          </div>
        </section>

        <section className="console-card bd-card" aria-labelledby="bd-guest">
          <h2 id="bd-guest">Guest</h2>
          {seesGuests && booking.booker ? (
            <dl className="console-dl">
              <dt>Booked by</dt>
              <dd>{booking.booker.name}</dd>
              <dt>Email</dt>
              <dd className="console-dl__wrap">{booking.booker.email}</dd>
            </dl>
          ) : (
            <p className="bd-hidden">
              <Icon name="eye-off" />
              <span>
                Not shown to your role, {roleName}. Owners and booking staff see the guest's name
                and email.
              </span>
            </p>
          )}
          <dl className="console-dl">
            <dt>Party</dt>
            <dd>
              {guestsText(booking.party.guests)}
              {booking.party.kind === "charter" ? (
                <span className="bd-block">{booking.party.charter}</span>
              ) : (
                <ul className="bd-tickets">
                  {booking.party.tickets.map((t) => (
                    <li key={t.code}>{countText(t.quantity, t.name)}</li>
                  ))}
                </ul>
              )}
            </dd>
            <dt>Extras</dt>
            <dd>{extrasText(booking.extras)}</dd>
          </dl>
        </section>

        <section className="console-card bd-card" aria-labelledby="bd-order">
          <h2 id="bd-order">Order</h2>
          <Ledger caption="Order in US dollars" hideCaption rows={orderRows(booking.order)} />
          <p className="bd-muted bd-small">
            The order was fixed when the guest checked out. They accepted cancellation policy
            version {booking.policyVersion}.
          </p>
        </section>

        <section className="console-card bd-card" aria-labelledby="bd-payment">
          <h2 id="bd-payment">Payment</h2>
          <dl className="console-dl">
            <dt>Status</dt>
            <dd>
              <StatusBadge tone={payment.tone} icon={payment.icon}>
                {payment.label}
              </StatusBadge>
            </dd>
            <dt>Amount</dt>
            <dd className="bk-money">
              {formatMoney(booking.payment.amount, booking.payment.currency)}
            </dd>
            <dt>Method</dt>
            <dd>{providerName(booking.payment.provider)}</dd>
            <dt>Provider reference</dt>
            <dd>
              {booking.payment.providerReference ? (
                <>
                  <MaskedReference value={booking.payment.providerReference} />
                  <span className="bd-block bd-muted bd-small">
                    Shortened: the start and the last four characters.
                  </span>
                </>
              ) : (
                "Not recorded yet"
              )}
            </dd>
            {booking.payment.succeededAt && (
              <>
                <dt>Received</dt>
                <dd>{instantText(booking.payment.succeededAt, zone)}</dd>
              </>
            )}
          </dl>
          {booking.refund && (
            <div className="bd-refund">
              <h3>Refund</h3>
              <dl className="console-dl">
                <dt>Status</dt>
                <dd>{payment.label}</dd>
                <dt>Amount</dt>
                <dd className="bk-money">{formatMoney(booking.refund.amount)}</dd>
                <dt>Requested</dt>
                <dd>{instantText(booking.refund.requestedAt, zone)}</dd>
                {booking.refund.settledAt && (
                  <>
                    <dt>{booking.refund.state === "failed" ? "Refused" : "Settled"}</dt>
                    <dd>{instantText(booking.refund.settledAt, zone)}</dd>
                  </>
                )}
                {booking.refund.failureCode && (
                  <>
                    <dt>Provider said</dt>
                    <dd>{booking.refund.failureCode.replaceAll("_", " ")}</dd>
                  </>
                )}
              </dl>
            </div>
          )}
        </section>

        <section className="console-card bd-card" aria-labelledby="bd-history">
          <h2 id="bd-history">History</h2>
          <ol className="bd-timeline">
            {booking.timeline.map((event) => (
              <li key={`${event.kind}-${event.at}`}>
                <span className="bd-timeline__what">{timelineLabel(event.kind)}</span>
                <span className="bd-timeline__when">
                  <VisuallyHidden>, </VisuallyHidden>
                  {instantText(event.at, zone)}
                </span>
              </li>
            ))}
          </ol>
        </section>
      </div>
    </div>
  );
}

function DetailSkeleton() {
  return (
    <div className="bd bd--skeleton" aria-hidden="true">
      <Skeleton width="12rem" height="1.5rem" />
      <div className="bd-grid">
        {[5, 4, 6, 4].map((lines, i) => (
          <div key={i} className="console-card bd-card">
            <Skeleton width="8rem" height="1.25rem" />
            {Array.from({ length: lines }, (_, j) => (
              <Skeleton key={j} variant="text" width="min(20rem, 90%)" />
            ))}
          </div>
        ))}
      </div>
    </div>
  );
}
