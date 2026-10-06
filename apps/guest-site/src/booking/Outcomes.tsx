import type { AvailableTrip, CheckoutSession, PublicBrand, Quote } from "@tidegrid/contracts";
import {
  Button,
  ButtonLink,
  Icon,
  type IconName,
  Notice,
  Spinner,
  StatusBadge,
} from "@tidegrid/design-system/components";
import { formatMoney } from "@tidegrid/design-system/format";
import type { ReactNode, Ref } from "react";
import { ContactActions } from "../Contact.tsx";
import { useLinkClick } from "../navigation.tsx";
import { deadlineText, describeParty, heldThing, type Stop, type TripContext } from "./model.ts";
import { tripWhen } from "./TripHeader.tsx";

type Tone = "ready" | "blocked" | "warning" | "neutral";

/** One designed outcome: an icon and a heading that say what happened, then what to do. */
function OutcomePanel({
  icon,
  tone,
  title,
  headingRef,
  asPageHeading = false,
  children,
  actions,
}: {
  icon: IconName;
  tone: Tone;
  title: string;
  headingRef: Ref<HTMLHeadingElement>;
  /** No trip is on the page, so this heading is the page's own. */
  asPageHeading?: boolean;
  children: ReactNode;
  actions?: ReactNode;
}) {
  const Heading = asPageHeading ? "h1" : "h2";
  return (
    <section className="booking-outcome" aria-labelledby="booking-step-title">
      <div className={`booking-outcome__icon booking-outcome__icon--${tone}`} aria-hidden="true">
        <Icon name={icon} />
      </div>
      <Heading
        id="booking-step-title"
        className="booking-step__title"
        ref={headingRef}
        tabIndex={-1}
      >
        {title}
      </Heading>
      <div className="booking-outcome__body">{children}</div>
      {actions && <div className="booking-actions">{actions}</div>}
    </section>
  );
}

function BackToTrips({ primary = false }: { primary?: boolean }) {
  const linkClick = useLinkClick();
  return (
    <ButtonLink
      variant={primary ? "primary" : "ghost"}
      icon="arrow-left"
      href="/"
      onClick={linkClick}
    >
      Back to trips
    </ButtonLink>
  );
}

/** After a payment button: the page reads the checkout's state until it is final. */
export function Waiting({
  expiresAt,
  timeZone,
  slow,
  unreachable,
  headingRef,
}: {
  /** The checkout's expiry: the latest its state can stay open. */
  expiresAt: string;
  timeZone: string;
  /** The payment has taken longer than a few seconds. */
  slow: boolean;
  /** The last reads got no answer. */
  unreachable: boolean;
  headingRef: Ref<HTMLHeadingElement>;
}) {
  return (
    <section className="booking-step booking-waiting" aria-labelledby="booking-step-title">
      <h2 id="booking-step-title" className="booking-step__title" ref={headingRef} tabIndex={-1}>
        Confirming your payment
      </h2>
      <p className="booking-waiting__status">
        <Spinner />
        <span>Waiting for the payment provider to confirm your booking…</span>
      </p>
      <p>This usually takes a few seconds. Keep this page open.</p>
      {slow && (
        <p>
          This is taking longer than usual. The page keeps checking until{" "}
          {deadlineText(expiresAt, timeZone)}; nothing more is needed from you.
        </p>
      )}
      {unreachable && (
        <Notice tone="warning" title="We're having trouble reaching the booking service">
          <p>The page keeps trying. Check your connection.</p>
        </Notice>
      )}
    </section>
  );
}

/** The booking reference, spelled out for screen readers, which would read it as a word. */
function Reference({ code }: { code: string }) {
  return (
    <div className="booking-reference">
      <p className="booking-reference__label">Booking reference</p>
      <p className="booking-reference__code">
        <span aria-hidden="true">{code}</span>
        <span className="tg-visually-hidden">{code.split("").join(" ")}</span>
      </p>
    </div>
  );
}

export function Confirmed({
  session,
  context,
  listing,
  quote,
  brand,
  headingRef,
}: {
  session: CheckoutSession;
  context: TripContext;
  listing: AvailableTrip | null;
  quote: Quote | null;
  brand: PublicBrand;
  headingRef: Ref<HTMLHeadingElement>;
}) {
  const reference = session.booking?.reference ?? "";
  return (
    <OutcomePanel
      icon="check-circle"
      tone="ready"
      title="You're booked"
      headingRef={headingRef}
      actions={<BackToTrips primary />}
    >
      <StatusBadge tone="ready">Confirmed</StatusBadge>
      <Reference code={reference} />
      <dl className="booking-summary">
        <div>
          <dt>Trip</dt>
          <dd>{context.productName}</dd>
        </div>
        <div>
          <dt>When</dt>
          <dd>{tripWhen(context.trip)}</dd>
        </div>
        {listing && (
          <>
            <div>
              <dt>Where</dt>
              <dd>{listing.location.name}</dd>
            </div>
            <div>
              <dt>Meet at</dt>
              <dd>{listing.location.meetingPoint}</dd>
            </div>
          </>
        )}
        <div>
          <dt>Party</dt>
          <dd>{describeParty(session.partySize, quote)}</dd>
        </div>
        <div>
          <dt>Total paid</dt>
          <dd>{formatMoney(session.amount)}</dd>
        </div>
      </dl>
      <p>
        Keep this reference, and quote it if you contact {brand.name}. This demo build doesn't send
        confirmation emails yet.
      </p>
    </OutcomePanel>
  );
}

export function Declined({
  charter,
  busy,
  onRetry,
  onChangeParty,
  headingRef,
}: {
  charter: boolean;
  busy: boolean;
  onRetry: () => void;
  onChangeParty: () => void;
  headingRef: Ref<HTMLHeadingElement>;
}) {
  return (
    <OutcomePanel
      icon="x-octagon"
      tone="blocked"
      title="Your payment was declined"
      headingRef={headingRef}
      actions={
        <>
          <Button
            variant="primary"
            icon="refresh"
            busy={busy}
            busyLabel="Starting a new checkout…"
            onClick={onRetry}
          >
            Try again
          </Button>
          <Button icon="arrow-left" disabled={busy} onClick={onChangeParty}>
            Change party or extras
          </Button>
        </>
      }
    >
      <p>
        Nothing was charged, and{" "}
        {charter ? "the boat held for you was" : "the seats held for you were"} released. Try again
        with the same party and details, or change them first.
      </p>
    </OutcomePanel>
  );
}

export function Expired({
  charter,
  onStartOver,
  headingRef,
}: {
  charter: boolean;
  onStartOver: () => void;
  headingRef: Ref<HTMLHeadingElement>;
}) {
  return (
    <OutcomePanel
      icon="hourglass"
      tone="warning"
      title="Your checkout expired"
      headingRef={headingRef}
      actions={
        <Button variant="primary" icon="refresh" onClick={onStartOver}>
          Start over
        </Button>
      }
    >
      <p>
        Time ran out before a payment arrived. Nothing was charged, and {heldThing(charter)}{" "}
        {charter ? "was" : "were"} released. Start over to book again: your party is kept.
      </p>
    </OutcomePanel>
  );
}

export function Canceled({
  charter,
  onStartOver,
  headingRef,
}: {
  charter: boolean;
  onStartOver: () => void;
  headingRef: Ref<HTMLHeadingElement>;
}) {
  return (
    <OutcomePanel
      icon="x-octagon"
      tone="neutral"
      title="This checkout was canceled"
      headingRef={headingRef}
      actions={
        <Button variant="primary" icon="refresh" onClick={onStartOver}>
          Start over
        </Button>
      }
    >
      <p>
        Nothing was charged, and {heldThing(charter)} {charter ? "was" : "were"} released.
      </p>
    </OutcomePanel>
  );
}

/** A payment arrived after the seats were gone: it is refunded in full, never booked. */
export function Unfulfilled({
  session,
  brand,
  headingRef,
}: {
  session: CheckoutSession;
  brand: PublicBrand;
  headingRef: Ref<HTMLHeadingElement>;
}) {
  const amount = formatMoney(session.refund?.amount ?? session.amount);
  const refund = session.refund?.state ?? "requested";
  return (
    <OutcomePanel
      icon="alert-triangle"
      tone="warning"
      title="We couldn't book this trip"
      headingRef={headingRef}
      actions={<BackToTrips primary />}
    >
      <p>
        Your payment arrived after the last seats were taken, so no booking was made.{" "}
        {refund === "succeeded" && `It has been refunded in full: ${amount}.`}
        {refund === "requested" && `It is being refunded in full: ${amount}.`}
        {refund === "failed" &&
          `The refund of ${amount} hasn't gone through yet. Contact ${brand.name} to put it right.`}
      </p>
      <StatusBadge
        tone={refund === "succeeded" ? "ready" : refund === "failed" ? "blocked" : "pending"}
      >
        {refund === "succeeded"
          ? "Refunded"
          : refund === "failed"
            ? "Refund not completed"
            : "Refund in progress"}
      </StatusBadge>
      <p>Questions? Contact {brand.name}.</p>
      <div className="booking-outcome__contact">
        <ContactActions brand={brand} primary={false} />
      </div>
    </OutcomePanel>
  );
}

export function Interrupted({
  charter,
  busy,
  trouble,
  onStartOver,
  headingRef,
}: {
  charter: boolean;
  busy: boolean;
  trouble: string | null;
  onStartOver: () => void;
  headingRef: Ref<HTMLHeadingElement>;
}) {
  return (
    <OutcomePanel
      icon="alert-triangle"
      tone="warning"
      title="Your checkout was interrupted"
      headingRef={headingRef}
      actions={
        <Button
          variant="primary"
          icon="refresh"
          busy={busy}
          busyLabel="Releasing your seats…"
          onClick={onStartOver}
        >
          Start over
        </Button>
      }
    >
      <p>
        The page reloaded before you paid. The page doesn't keep payment details through a reload,
        so this checkout can't be paid here, and nothing was charged. Start over:{" "}
        {charter ? "the boat" : "the seats"} this checkout held {charter ? "is" : "are"} released
        first.
      </p>
      {trouble && (
        <Notice
          tone="error"
          title={
            charter ? "The boat couldn't be released yet" : "The seats couldn't be released yet"
          }
        >
          <p>{trouble}</p>
        </Notice>
      )}
    </OutcomePanel>
  );
}

export function Gone({
  onStartOver,
  headingRef,
  asPageHeading = false,
}: {
  onStartOver: () => void;
  headingRef: Ref<HTMLHeadingElement>;
  /** No trip is on the page, so this heading is the page's own. */
  asPageHeading?: boolean;
}) {
  return (
    <OutcomePanel
      icon="compass"
      tone="neutral"
      title="This checkout isn't open in this tab"
      headingRef={headingRef}
      asPageHeading={asPageHeading}
      actions={
        <>
          <Button variant="primary" icon="refresh" onClick={onStartOver}>
            Start a new booking
          </Button>
          <BackToTrips />
        </>
      }
    >
      <p>
        A checkout stays with the browser tab that started it, until it ends. If you finished a
        booking, its reference was on the confirmation screen.
      </p>
    </OutcomePanel>
  );
}

const stopCopy: Record<Stop, (operator: string) => { title: string; body: string }> = {
  not_found: () => ({
    title: "We can't find this trip",
    body: "The link may be out of date. Choose a trip from the list.",
  }),
  not_bookable: (operator) => ({
    title: "This trip isn't taking bookings now",
    body: `It may be full, closed, or past its booking cutoff. Choose another trip, or contact ${operator}.`,
  }),
  pricing: (operator) => ({
    title: "This trip can't be booked online yet",
    body: `${operator} hasn't put its prices online. Call or email to book.`,
  }),
  payments: (operator) => ({
    title: "Online payment isn't available",
    body: `${operator} can't take payments online right now, and nothing was charged. Call or email to book.`,
  }),
};

/** The trip cannot be booked here now. */
export function Stopped({
  stop,
  brand,
  headingRef,
  asPageHeading = false,
}: {
  stop: Stop;
  brand: PublicBrand;
  headingRef: Ref<HTMLHeadingElement>;
  /** No trip loaded, so this is the page's own heading. */
  asPageHeading?: boolean;
}) {
  const copy = stopCopy[stop](brand.name);
  const Heading = asPageHeading ? "h1" : "h2";
  return (
    <section className="booking-outcome" aria-labelledby="booking-step-title">
      <div className="booking-outcome__icon booking-outcome__icon--neutral" aria-hidden="true">
        <Icon name={stop === "not_found" ? "compass" : "calendar"} />
      </div>
      <Heading
        id="booking-step-title"
        className="booking-step__title"
        ref={headingRef}
        tabIndex={-1}
      >
        {copy.title}
      </Heading>
      <div className="booking-outcome__body">
        <p>{copy.body}</p>
      </div>
      <div className="booking-actions">
        <BackToTrips primary />
        {stop !== "not_found" && <ContactActions brand={brand} primary={false} />}
      </div>
    </section>
  );
}

/** The trip did not load. */
export function LoadFailed({
  retrying,
  onRetry,
  headingRef,
}: {
  retrying: boolean;
  onRetry: () => void;
  headingRef: Ref<HTMLHeadingElement>;
}) {
  return (
    <section className="booking-outcome" aria-labelledby="booking-step-title">
      <div className="booking-outcome__icon booking-outcome__icon--warning" aria-hidden="true">
        <Icon name="alert-triangle" />
      </div>
      <h1 id="booking-step-title" className="booking-step__title" ref={headingRef} tabIndex={-1}>
        We couldn't load this trip
      </h1>
      <div className="booking-outcome__body">
        <p role="status">
          {retrying
            ? "Loading the trip…"
            : "Check your connection and try again. If it keeps happening, the booking site may be briefly unavailable."}
        </p>
      </div>
      <div className="booking-actions">
        <Button
          variant="primary"
          icon="refresh"
          busy={retrying}
          busyLabel="Trying again…"
          onClick={onRetry}
        >
          Try again
        </Button>
        <BackToTrips />
      </div>
    </section>
  );
}
