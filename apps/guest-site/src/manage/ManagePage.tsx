import type { CancellationTerms, ManagedBooking, PublicBrand } from "@tidegrid/contracts";
import {
  Button,
  ButtonLink,
  Icon,
  Ledger,
  Notice,
  Skeleton,
  StatusBadge,
} from "@tidegrid/design-system/components";
import {
  formatDate,
  formatDuration,
  formatMoney,
  formatTripTime,
  zoneCity,
} from "@tidegrid/design-system/format";
import { type ReactNode, type Ref, useCallback, useEffect, useRef, useState } from "react";
import type { Failure } from "../booking/api.ts";
import { ConfirmDialog } from "../booking/ConfirmDialog.tsx";
import { ContactActions } from "../Contact.tsx";
import { useLinkClick } from "../navigation.tsx";
import { useTitle } from "../States.tsx";
import {
  cancel,
  emailNewLink,
  endSession,
  openWithLink,
  readBooking,
  readTerms,
  renewLink,
} from "./api.ts";
import { DemoMailboxLink } from "./DemoMailbox.tsx";
import {
  cutoffSentence,
  type LinkProblem,
  linkProblemCopy,
  linkProblemOf,
  orderRows,
  refundSentence,
  refundStateText,
  withParticipant,
} from "./model.ts";
import { PartySection } from "./PartySection.tsx";
import {
  clearSession,
  forgetLinkToken,
  loadSession,
  readLinkToken,
  type StoredSession,
  storeSession,
} from "./session.ts";

/**
 * The booking's management page (lane 1, G2.11c), at /manage. The guest
 * arrives from the link in their email, whose token is in the URL's fragment:
 * the page takes it out of the address at once and opens the booking only
 * when the guest asks, so an email scanner or a link preview that loads the
 * page never uses the link. From the session the API returns, the guest sees
 * the booking and its receipt, names the party, cancels within the policy,
 * and asks for a new link.
 */

type View =
  | { kind: "landing"; token: string; busy: boolean; trouble: string | null }
  | { kind: "link-problem"; token: string; problem: LinkProblem }
  | { kind: "no-link" }
  | { kind: "loading"; session: StoredSession }
  | { kind: "failed"; session: StoredSession; retrying: boolean }
  | { kind: "booking"; session: StoredSession; booking: ManagedBooking }
  | { kind: "ended"; reason: "expired" | "closed"; linkToken: string | null };

type Renewal = "idle" | "busy" | "sent" | "failed";

/** A failure's words when the page can only say it did not work. */
function troubleText(failure: Failure): string {
  if (failure.kind === "network") {
    return "We couldn't reach the booking site. Check your connection and try again.";
  }
  if (failure.kind === "refused" && failure.status === 429) {
    return "That was a lot of tries in a short time. Wait a minute, then try again.";
  }
  return "Something went wrong on our side. Try again in a moment.";
}

function initialView(): View {
  const token = readLinkToken();
  if (token) return { kind: "landing", token, busy: false, trouble: null };
  const session = loadSession();
  return session ? { kind: "loading", session } : { kind: "no-link" };
}

export function ManagePage({
  brand,
  focusOnArrival,
}: {
  brand: PublicBrand;
  focusOnArrival: boolean;
}) {
  const [view, setView] = useState<View>(initialView);
  const [renewal, setRenewal] = useState<Renewal>("idle");
  const heading = useRef<HTMLHeadingElement>(null);
  const linkClick = useLinkClick();
  const alive = useRef(new AbortController());
  // The page's latest read. One that finishes after a newer read started, or
  // after the page moved on to a newer link, is dropped; so is one whose own
  // signal was aborted, as development's double-run effects abort the first.
  const latestRead = useRef(0);

  // The token stays in memory only: out of the address and this history entry now.
  useEffect(() => {
    forgetLinkToken();
    const controller = new AbortController();
    alive.current = controller;
    return () => controller.abort();
  }, []);

  // A link opened in this same tab changes only the fragment, which reloads
  // nothing. Take its token the same way, and still ask before using it.
  useEffect(() => {
    const onHash = () => {
      if (!window.location.hash.startsWith("#t=")) return;
      const token = readLinkToken();
      forgetLinkToken();
      if (!token) return;
      latestRead.current += 1;
      setView({ kind: "landing", token, busy: false, trouble: null });
    };
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);

  // Focus the page's heading when what the page says changes, so a screen
  // reader hears it; a first load leaves focus where the browser put it.
  const lastKind = useRef<string | null>(null);
  useEffect(() => {
    const first = lastKind.current === null;
    if (lastKind.current !== view.kind) {
      lastKind.current = view.kind;
      if ((!first || focusOnArrival) && view.kind !== "loading") heading.current?.focus();
    }
  }, [view.kind, focusOnArrival]);

  const load = useCallback(async (session: StoredSession) => {
    const read = ++latestRead.current;
    const signal = alive.current.signal;
    const result = await readBooking(session.token, signal);
    if (signal.aborted || read !== latestRead.current) return;
    if (result.kind === "ok") {
      setView({ kind: "booking", session, booking: result.value.booking });
      return;
    }
    if (result.kind === "refused" && result.status === 401) {
      clearSession();
      setView({ kind: "ended", reason: "expired", linkToken: session.linkToken ?? null });
      return;
    }
    setView({ kind: "failed", session, retrying: false });
  }, []);

  useEffect(() => {
    if (view.kind === "loading") void load(view.session);
  }, [view, load]);

  const open = async () => {
    if (view.kind !== "landing" || view.busy) return;
    const token = view.token;
    setView({ ...view, busy: true, trouble: null });
    const result = await openWithLink(token, alive.current.signal);
    if (alive.current.signal.aborted) return;
    if (result.kind === "ok") {
      const session: StoredSession = {
        token: result.value.token,
        expiresAt: result.value.expiresAt,
        reference: result.value.reference,
        linkToken: token,
      };
      storeSession(session);
      setView({ kind: "loading", session });
      return;
    }
    const problem = result.kind === "refused" ? linkProblemOf(result.code) : null;
    if (problem) {
      setView({ kind: "link-problem", token, problem });
      return;
    }
    setView({ kind: "landing", token, busy: false, trouble: troubleText(result) });
  };

  const renew = async (token: string) => {
    if (renewal === "busy") return;
    setRenewal("busy");
    const result = await renewLink(token, alive.current.signal);
    if (alive.current.signal.aborted) return;
    setRenewal(result.kind === "ok" ? "sent" : "failed");
  };

  const operator = brand.name;
  switch (view.kind) {
    case "landing":
      return (
        <Alone title="Open your booking" heading={heading} brand={brand}>
          <p>
            This link opens your booking with {operator}: see your trip and receipt, name everyone
            coming, or cancel within the policy.
          </p>
          {view.trouble && (
            <Notice tone="error" title="Your booking didn't open">
              {view.trouble}
            </Notice>
          )}
          <div className="booking-actions">
            <Button
              variant="primary"
              icon="unlock"
              busy={view.busy}
              busyLabel="Opening…"
              onClick={() => void open()}
            >
              Open my booking
            </Button>
          </div>
          <p className="manage-quiet">
            For your security the link works once, for three days. Opening it here signs this
            browser tab in for an hour.
          </p>
        </Alone>
      );
    case "link-problem": {
      const copy = linkProblemCopy(view.problem, operator);
      const stored = loadSession();
      return (
        <Alone title={copy.title} heading={heading} brand={brand} icon="lock" tone="warning">
          <p>{copy.body}</p>
          <RenewalNotice renewal={renewal} />
          <div className="booking-actions">
            {view.problem !== "not_found" && renewal !== "sent" && (
              <Button
                variant={stored ? "secondary" : "primary"}
                icon="mail"
                busy={renewal === "busy"}
                busyLabel="Sending…"
                onClick={() => void renew(view.token)}
              >
                Email me a new link
              </Button>
            )}
            {stored && (
              <Button
                variant="primary"
                icon="arrow-left"
                onClick={() => setView({ kind: "loading", session: stored })}
              >
                Back to my booking
              </Button>
            )}
            {view.problem === "not_found" && <ContactActions brand={brand} />}
            <DemoMailboxLink />
          </div>
        </Alone>
      );
    }
    case "no-link":
      return (
        <Alone
          title="Open your booking from your email"
          heading={heading}
          brand={brand}
          icon="mail"
        >
          <p>
            Your confirmation email from {operator} has a button that opens your booking here: to
            see your receipt, name your party, or cancel within the policy. No account needed.
          </p>
          <div className="booking-actions">
            <ButtonLink variant="primary" icon="arrow-left" href="/" onClick={linkClick}>
              Back to trips
            </ButtonLink>
            <DemoMailboxLink />
          </div>
        </Alone>
      );
    case "ended":
      return (
        <Alone
          title={
            view.reason === "closed"
              ? "Your booking is closed on this device"
              : "Your session has ended"
          }
          heading={heading}
          brand={brand}
          icon="lock"
        >
          <p>
            {view.reason === "closed"
              ? "Nothing changed on your booking. To open it again, ask for a new link."
              : "For your security, a booking stays open for an hour. Nothing changed on your booking. To open it again, ask for a new link."}
          </p>
          <RenewalNotice renewal={renewal} />
          <div className="booking-actions">
            {view.linkToken && renewal !== "sent" ? (
              <Button
                variant="primary"
                icon="mail"
                busy={renewal === "busy"}
                busyLabel="Sending…"
                onClick={() => (view.linkToken ? void renew(view.linkToken) : undefined)}
              >
                Email me a new link
              </Button>
            ) : (
              !view.linkToken && (
                <p className="manage-quiet">
                  Use the button in your confirmation email from {operator}.
                </p>
              )
            )}
            <DemoMailboxLink />
          </div>
        </Alone>
      );
    case "loading":
      return <Loading />;
    case "failed":
      return (
        <Alone
          title="Your booking didn't load"
          heading={heading}
          brand={brand}
          icon="refresh"
          tone="warning"
        >
          <p>We couldn't reach the booking site. Check your connection and try again.</p>
          <div className="booking-actions">
            <Button
              variant="primary"
              icon="refresh"
              busy={view.retrying}
              busyLabel="Trying…"
              onClick={() => {
                setView({ kind: "failed", session: view.session, retrying: true });
                void load(view.session);
              }}
            >
              Try again
            </Button>
          </div>
        </Alone>
      );
    case "booking":
      return (
        <BookingView
          brand={brand}
          session={view.session}
          booking={view.booking}
          heading={heading}
          onChange={(booking) =>
            setView((current) =>
              current.kind === "booking" && current.session.token === view.session.token
                ? { ...current, booking }
                : current,
            )
          }
          onEnded={(reason) => {
            clearSession();
            setView({ kind: "ended", reason, linkToken: view.session.linkToken ?? null });
          }}
        />
      );
  }
}

function RenewalNotice({ renewal }: { renewal: Renewal }) {
  if (renewal === "sent") {
    return (
      <Notice tone="success" title="Check your email">
        If this link belongs to a booking here, we've sent a new one to the email address it was
        booked with. It can take a minute to arrive.
      </Notice>
    );
  }
  if (renewal === "failed") {
    return (
      <Notice tone="error" title="We couldn't send a new link">
        Check your connection and try again in a minute.
      </Notice>
    );
  }
  return null;
}

/** A page with no booking to show yet: a heading, what happened, what to do. */
function Alone({
  title,
  heading,
  brand,
  icon = "anchor",
  tone = "neutral",
  children,
}: {
  title: string;
  heading: Ref<HTMLHeadingElement>;
  brand: PublicBrand;
  icon?: "anchor" | "lock" | "mail" | "refresh";
  tone?: "neutral" | "warning";
  children: ReactNode;
}) {
  useTitle(`${title} · ${brand.name}`);
  return (
    <div className="guest-container booking-alone">
      <section className="booking-outcome manage-alone" aria-labelledby="manage-title">
        <div className={`booking-outcome__icon booking-outcome__icon--${tone}`} aria-hidden="true">
          <Icon name={icon} />
        </div>
        <h1 id="manage-title" className="booking-step__title" ref={heading} tabIndex={-1}>
          {title}
        </h1>
        <div className="booking-outcome__body">{children}</div>
      </section>
    </div>
  );
}

function Loading() {
  return (
    <div className="guest-container booking-alone" aria-busy="true">
      <p className="tg-visually-hidden" role="status">
        Loading your booking…
      </p>
      <div className="manage-skeleton" aria-hidden="true">
        <Skeleton width="12rem" height="2rem" />
        <Skeleton width="100%" height="6rem" />
        <Skeleton width="100%" height="10rem" />
      </div>
    </div>
  );
}

type Done = { tone: "success" | "info"; title: string; body: string; focus?: boolean } | null;

function BookingView({
  brand,
  session,
  booking,
  heading,
  onChange,
  onEnded,
}: {
  brand: PublicBrand;
  session: StoredSession;
  booking: ManagedBooking;
  heading: Ref<HTMLHeadingElement>;
  onChange: (booking: ManagedBooking) => void;
  onEnded: (reason: "expired" | "closed") => void;
}) {
  useTitle(`Booking ${booking.reference} · ${brand.name}`);
  const linkClick = useLinkClick();
  const [done, setDone] = useState<Done>(null);
  const doneRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (done?.focus) doneRef.current?.focus();
  }, [done]);
  const [linkBusy, setLinkBusy] = useState(false);
  const [closing, setClosing] = useState(false);
  const { trip, location } = booking;
  const when = `${formatDate(trip.localDate, "full")}, ${formatTripTime(trip.localStartTime, trip.startsAt, trip.timeZone)}`;
  const canceled = booking.state === "canceled";

  const reload = useCallback(async () => {
    const result = await readBooking(session.token);
    if (result.kind === "ok") onChange(result.value.booking);
    else if (result.kind === "refused" && result.status === 401) onEnded("expired");
  }, [session.token, onChange, onEnded]);

  const sendLink = async () => {
    if (linkBusy) return;
    setLinkBusy(true);
    const result = await emailNewLink(session.token);
    setLinkBusy(false);
    if (result.kind === "ok") {
      setDone({
        tone: "success",
        title: "New link sent",
        body: `We've emailed a new link to ${booking.booker.email}. Links in earlier emails no longer work.`,
      });
    } else if (result.kind === "refused" && result.status === 401) {
      onEnded("expired");
    } else if (result.kind === "refused" && result.code === "link_email_rate_limited") {
      setDone({
        tone: "info",
        title: "We've already sent three links this hour",
        body: "Check your email, including spam, or try again later.",
      });
    } else {
      setDone({ tone: "info", title: "We couldn't send a link", body: troubleText(result) });
    }
  };

  const close = async () => {
    setClosing(true);
    await endSession(session.token);
    onEnded("closed");
  };

  return (
    <>
      <section className="booking-hero" aria-labelledby="manage-title">
        <div className="guest-container booking-hero__inner">
          <a className="tap-target booking-hero__back" href="/" onClick={linkClick}>
            <Icon name="arrow-left" />
            All trips
          </a>
          <p className="booking-hero__eyebrow">Your booking</p>
          <h1 id="manage-title" ref={heading} tabIndex={-1}>
            {trip.productName}
          </h1>
          <p className="booking-hero__when">{when}</p>
        </div>
      </section>
      <div className="guest-container manage-layout">
        <div className="manage-status">
          {canceled ? (
            <StatusBadge tone="warning" icon="x-octagon">
              Canceled
            </StatusBadge>
          ) : (
            <StatusBadge tone="ready">Confirmed</StatusBadge>
          )}
          <p className="manage-status__ref">
            Reference <strong className="booking-checkout-ref">{booking.reference}</strong>
          </p>
        </div>
        {done && (
          <div ref={doneRef} tabIndex={-1} className="manage-done">
            <Notice tone={done.tone} title={done.title}>
              {done.body}
            </Notice>
          </div>
        )}

        <PartySection
          booking={booking}
          session={session.token}
          operator={brand.name}
          onSaved={async (participant) => {
            onChange(withParticipant(booking, participant));
            await reload();
          }}
          onEnded={() => onEnded("expired")}
        />

        <section className="manage-card" aria-labelledby="manage-trip">
          <h2 id="manage-trip" className="booking-section-title">
            The trip
          </h2>
          <dl className="booking-summary">
            <div>
              <dt>When</dt>
              <dd>
                {when}
                <span className="manage-quiet">
                  {" "}
                  ({formatDuration(trip.durationMinutes)}, {zoneCity(trip.timeZone)} time)
                </span>
              </dd>
            </div>
            <div>
              <dt>Meet at</dt>
              <dd>
                {location.meetingPoint || location.name}
                {location.meetingPoint && <>, {location.name}</>}
                {location.meetingInstructions && (
                  <span className="manage-block">{location.meetingInstructions}</span>
                )}
              </dd>
            </div>
            <div>
              <dt>Booked by</dt>
              <dd>
                {booking.booker.name}
                <span className="manage-block manage-quiet">{booking.booker.email}</span>
              </dd>
            </div>
          </dl>
        </section>

        <section className="manage-card" aria-labelledby="manage-receipt">
          <h2 id="manage-receipt" className="booking-section-title">
            Receipt
          </h2>
          <Ledger caption="Receipt in US dollars" hideCaption rows={orderRows(booking.order)} />
          <p className="manage-quiet">
            Paid with a test payment ({formatMoney(booking.payment.amount)}). This is a demo: no
            real card was charged.
          </p>
          {booking.refund && (
            <p className="manage-refund">
              <Icon name="receipt" />
              <span>{refundStateText(booking.refund)}</span>
            </p>
          )}
        </section>

        <CancelSection
          brand={brand}
          booking={booking}
          session={session.token}
          onCanceled={(updated) => {
            onChange(updated);
            // The dialog's opener is gone with the cancel section, so focus
            // goes to what happened, at the top.
            setDone({
              tone: "success",
              title: "Your booking is canceled",
              body: `${updated.refund ? refundStateText(updated.refund) : "There is no refund under the policy"}. We've emailed you the details.`,
              focus: true,
            });
          }}
          onEnded={() => onEnded("expired")}
        />

        <section className="manage-card manage-card--quiet" aria-labelledby="manage-later">
          <h2 id="manage-later" className="booking-section-title">
            Coming back later?
          </h2>
          <p>
            This page stays open in this tab for an hour. We can email a new link to{" "}
            {booking.booker.email} whenever you need one.
          </p>
          <div className="booking-actions">
            <Button
              variant="secondary"
              icon="mail"
              busy={linkBusy}
              busyLabel="Sending…"
              onClick={() => void sendLink()}
            >
              Email me a new link
            </Button>
            <Button
              variant="ghost"
              icon="log-out"
              busy={closing}
              busyLabel="Closing…"
              onClick={() => void close()}
            >
              Close my booking on this device
            </Button>
            <DemoMailboxLink />
          </div>
        </section>
      </div>
    </>
  );
}

function CancelSection({
  brand,
  booking,
  session,
  onCanceled,
  onEnded,
}: {
  brand: PublicBrand;
  booking: ManagedBooking;
  session: string;
  onCanceled: (booking: ManagedBooking) => void;
  onEnded: () => void;
}) {
  const [asking, setAsking] = useState(false);
  const [busy, setBusy] = useState(false);
  const [terms, setTerms] = useState<CancellationTerms>(booking.cancellationTerms);
  const [changed, setChanged] = useState(false);
  const [trouble, setTrouble] = useState<string | null>(null);
  const key = useRef<string | null>(null);

  useEffect(() => setTerms(booking.cancellationTerms), [booking.cancellationTerms]);

  if (booking.state === "canceled" && booking.cancellation) return null;

  const refusal = terms.refusal;
  const confirm = async () => {
    if (busy) return;
    setBusy(true);
    setTrouble(null);
    // One key per attempt at these terms; a retry after no answer reuses it.
    key.current ??= crypto.randomUUID();
    const result = await cancel(session, terms.refundAmount, key.current);
    setBusy(false);
    if (result.kind === "ok") {
      key.current = null;
      setAsking(false);
      onCanceled(result.value);
      return;
    }
    if (result.kind === "refused") {
      key.current = null;
      if (result.status === 401) {
        onEnded();
        return;
      }
      if (result.code === "cancellation_terms_changed") {
        const fresh = await readTerms(session);
        if (fresh.kind === "ok") {
          setTerms(fresh.value);
          setChanged(true);
          if (!fresh.value.cancelable) setAsking(false);
          return;
        }
      }
      if (result.code === "trip_departed" || result.code === "remedy_requires_operator") {
        const fresh = await readTerms(session);
        if (fresh.kind === "ok") setTerms(fresh.value);
        setAsking(false);
        return;
      }
    }
    setTrouble(troubleText(result));
  };

  return (
    <section className="manage-card" aria-labelledby="manage-cancel">
      <h2 id="manage-cancel" className="booking-section-title">
        Cancel this booking
      </h2>
      {refusal === "trip_departed" ? (
        <p>This trip has already left, so it can't be canceled here.</p>
      ) : refusal === "remedy_requires_operator" ? (
        <>
          <p>
            Canceling now gives a credit for a future trip, which {brand.name} issues. Contact them
            to cancel.
          </p>
          <div className="booking-actions">
            <ContactActions brand={brand} primary={false} />
          </div>
        </>
      ) : (
        <>
          <p>
            <strong>If you cancel now:</strong> {refundSentence(terms)}{" "}
            {cutoffSentence(terms, booking.trip)}
          </p>
          <p className="manage-quiet">Policy: {booking.policy.cancellationText}</p>
          <div className="booking-actions">
            <Button variant="secondary" icon="x-octagon" onClick={() => setAsking(true)}>
              Cancel booking
            </Button>
          </div>
        </>
      )}
      {asking && (
        <ConfirmDialog
          title={`Cancel booking ${booking.reference}?`}
          confirmLabel="Cancel booking"
          busyLabel="Canceling…"
          keepLabel="Keep my booking"
          busy={busy}
          onConfirm={() => void confirm()}
          onKeep={() => {
            setAsking(false);
            setChanged(false);
            setTrouble(null);
          }}
        >
          {changed && (
            <Notice tone="warning" title="The refund changed" announce="alert">
              The policy's cutoff passed while you were deciding.
            </Notice>
          )}
          {trouble && (
            <Notice tone="error" title="Your booking wasn't canceled">
              {trouble}
            </Notice>
          )}
          <p>{refundSentence(terms)}</p>
          <p>
            Your {booking.party.guests === 1 ? "place goes" : "places go"} back on sale, and this
            can't be undone.
          </p>
        </ConfirmDialog>
      )}
    </section>
  );
}
