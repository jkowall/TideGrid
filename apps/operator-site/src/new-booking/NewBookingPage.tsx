import type {
  BookingChannel,
  Membership,
  Quote,
  StaffCheckout,
  StaffCheckoutCreateRequest,
  StaffTestPaymentOutcome,
  TripOffer,
} from "@tidegrid/contracts";
import {
  Button,
  ButtonLink,
  CheckboxField,
  Dialog,
  EmptyState,
  Ledger,
  Notice,
  QuantityField,
  SelectField,
  Skeleton,
  Steps,
  TextField,
} from "@tidegrid/design-system/components";
import { formatDate, formatMoney, formatTripTime } from "@tidegrid/design-system/format";
import { type ReactNode, type RefObject, useEffect, useRef, useState } from "react";
import { bookingHref, instantText } from "../bookings/model.ts";
import { canRetry, ReadFailed } from "../bookings/States.tsx";
import { focusIsLost } from "../focus.ts";
import type { ReadFailure } from "../http.ts";
import { ConsoleButtonLink, ConsoleLink, hereAddress } from "../navigation.tsx";
import { type FocusOnArrival, PageHeader } from "../PageHeader.tsx";
import { canCreateBookings, roleNames } from "../roles.ts";
import {
  type CommandFailure,
  cancelCheckout,
  createQuote,
  loadOffer,
  openCheckout,
  readCheckout,
  takeTestPayment,
} from "./api.ts";
import {
  addOnLimit,
  type BookerDraft,
  bookerProblems,
  channelOptions,
  cleanBooker,
  emptyParty,
  guestsOf,
  newKey,
  type Outcome,
  outcomeOf,
  type PartyDraft,
  partyProblem,
  quoteLedger,
  quoteRequest,
  type Refusal,
  refusalOf,
} from "./model.ts";

/**
 * A staff-assisted booking (G2.12d): an owner or booking staff member books
 * a guest who phoned, emailed, or walked up. Party, guest, review, payment:
 * the server prices the party, the checkout holds the seats, and the demo's
 * test payment goes to the fake provider, whose signed event alone confirms
 * the booking. Finance sees a refusal and makes no request.
 *
 * Once the checkout has been asked for, the party, guest, and review inputs
 * are frozen and the request keeps its Idempotency-Key, so a retry after a
 * provider timeout is the same request. Changing anything cancels the open
 * checkout first, then prices the party again and opens a new one.
 */

const stepNames = ["Party", "Guest", "Review", "Payment"] as const;
type Step = 0 | 1 | 2 | 3 | 4;

/** Polls of the checkout after a test payment, about a second apart. */
const POLL_LIMIT = 20;
const POLL_MS = 1000;

type OfferLoad =
  | { kind: "loading" }
  | { kind: "ready"; offer: TripOffer }
  | { kind: "off_sale"; code: string | undefined }
  | { kind: "failed"; reason: ReadFailure; failures: number; retrying: boolean };

/** A message about the last command, with what can be done about it. */
type Problem =
  | { kind: "refusal"; refusal: Refusal }
  | { kind: "failure"; reason: ReadFailure }
  | { kind: "delivery" };

export function NewBookingPage({
  membership,
  tripId,
  focusHeading,
}: { membership: Membership; tripId: string } & FocusOnArrival) {
  const { tenantName, role } = membership;
  if (!canCreateBookings(role)) {
    return (
      <>
        <PageHeader eyebrow={tenantName} title="New booking" focusHeading={focusHeading} />
        <EmptyState
          icon="lock"
          title="Your role can't make bookings"
          actions={
            <ConsoleButtonLink href="/calendar" icon="calendar">
              Go to calendar
            </ConsoleButtonLink>
          }
        >
          <p>
            Owners and booking staff book for guests. Your role, {roleNames[role]}, reads bookings,
            totals, and payments without changing them.
          </p>
        </EmptyState>
      </>
    );
  }
  return <NewBooking membership={membership} tripId={tripId} focusHeading={focusHeading} />;
}

/** A reusable key for one request body: the same body keeps its key, another gets a new one. */
function useKeyFor() {
  const sent = useRef<{ body: string; key: string } | null>(null);
  return {
    keyFor(body: unknown): string {
      const text = JSON.stringify(body);
      if (sent.current?.body !== text) sent.current = { body: text, key: newKey() };
      return sent.current.key;
    },
    forget() {
      sent.current = null;
    },
  };
}

function problemOf(failure: CommandFailure): Problem {
  if (failure.reason === "refused" || failure.reason === "key_reused") {
    return { kind: "refusal", refusal: refusalOf(failure.code) };
  }
  return { kind: "failure", reason: failure.reason };
}

function NewBooking({
  membership,
  tripId,
  focusHeading,
}: { membership: Membership; tripId: string } & FocusOnArrival) {
  const { tenantId, tenantName } = membership;
  const [load, setLoad] = useState<OfferLoad>({ kind: "loading" });
  const [attempt, setAttempt] = useState(0);
  const retryRequested = useRef(false);

  const [step, setStep] = useState<Step>(0);
  const [party, setParty] = useState<PartyDraft | null>(null);
  const [partyError, setPartyError] = useState<string | null>(null);
  const [quote, setQuote] = useState<Quote | null>(null);
  const [booker, setBooker] = useState<BookerDraft>({ name: "", email: "" });
  const [bookerErrors, setBookerErrors] = useState<{ name?: string; email?: string }>({});
  const [channel, setChannel] = useState<BookingChannel>("phone");
  const [attest, setAttest] = useState({ email: false, policy: false });
  const [attestErrors, setAttestErrors] = useState({ email: false, policy: false });
  const [checkout, setCheckout] = useState<StaffCheckout | null>(null);
  /** The checkout was asked for: inputs are frozen until it is canceled. */
  const [frozen, setFrozen] = useState(false);
  /** An open request whose answer did not arrive: a checkout may exist that the page has no id for. */
  const [openUnknown, setOpenUnknown] = useState(false);
  const [busy, setBusy] = useState<
    null | "quote" | "open" | "edit" | "cancel" | StaffTestPaymentOutcome
  >(null);
  const [problem, setProblem] = useState<Problem | null>(null);
  const [confirmCancel, setConfirmCancel] = useState(false);
  const [polls, setPolls] = useState(0);
  /** The outcome the last test payment asked for, so a retry sends the same request. */
  const [lastPay, setLastPay] = useState<StaffTestPaymentOutcome>("succeed");

  const quoteKey = useKeyFor();
  const openKey = useKeyFor();
  const payKey = useKeyFor();
  const stepHeading = useRef<HTMLHeadingElement>(null);
  const nameField = useRef<HTMLInputElement>(null);
  const emailField = useRef<HTMLInputElement>(null);
  const emailCheck = useRef<HTMLInputElement>(null);
  const policyCheck = useRef<HTMLInputElement>(null);
  const firstStep = useRef(true);

  // The trip's offer ----------------------------------------------------------------------
  useEffect(() => {
    void attempt;
    const controller = new AbortController();
    const retry = retryRequested.current;
    retryRequested.current = false;
    setLoad((current) =>
      retry && current.kind === "failed" ? { ...current, retrying: true } : { kind: "loading" },
    );
    void loadOffer(tenantId, tripId, controller.signal).then((result) => {
      if (controller.signal.aborted) return;
      if (result.kind === "ok") {
        setLoad({ kind: "ready", offer: result.value });
        setParty((current) => current ?? emptyParty(result.value));
        return;
      }
      if (result.reason === "refused") {
        setLoad({ kind: "off_sale", code: result.code });
        return;
      }
      const reason = result.reason === "key_reused" ? "unavailable" : result.reason;
      setLoad((current) => ({
        kind: "failed",
        reason,
        failures: current.kind === "failed" ? current.failures + 1 : 1,
        retrying: false,
      }));
    });
    return () => controller.abort();
  }, [tenantId, tripId, attempt]);

  // Each new step's heading takes focus when the control that moved there is gone.
  useEffect(() => {
    void step;
    if (firstStep.current) {
      firstStep.current = false;
      return;
    }
    if (focusIsLost()) stepHeading.current?.focus();
  }, [step]);

  // After a test payment, read the checkout until it is decided.
  useEffect(() => {
    if (step !== 4 || !checkout || checkout.state !== "open" || polls >= POLL_LIMIT) return;
    const controller = new AbortController();
    const timer = setTimeout(
      () => {
        void readCheckout(tenantId, checkout.id, controller.signal).then((result) => {
          if (controller.signal.aborted) return;
          if (result.kind === "ok") setCheckout(result.value);
          setPolls((n) => n + 1);
        });
      },
      polls === 0 ? 0 : POLL_MS,
    );
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [step, checkout, polls, tenantId]);

  const offer = load.kind === "ready" ? load.offer : null;

  // Commands -------------------------------------------------------------------------------

  const priceParty = async (andThen: Step) => {
    if (!offer || !party) return;
    const wrong = partyProblem(offer, party);
    setPartyError(wrong);
    if (wrong) return;
    const body = quoteRequest(offer, party);
    setBusy("quote");
    setProblem(null);
    const result = await createQuote(tenantId, body, quoteKey.keyFor(body));
    setBusy(null);
    if (result.kind === "ok") {
      setQuote(result.value);
      setStep(andThen);
      return;
    }
    if (result.reason === "key_reused") quoteKey.forget();
    setProblem(problemOf(result));
  };

  const toReview = () => {
    const problems = bookerProblems(booker);
    setBookerErrors(problems);
    if (problems.name) nameField.current?.focus();
    else if (problems.email) emailField.current?.focus();
    if (problems.name || problems.email) return;
    setBooker(cleanBooker(booker));
    setProblem(null);
    setStep(2);
  };

  const openBody = (q: Quote): StaffCheckoutCreateRequest => ({
    quoteId: q.quoteId,
    acceptedPolicyVersion: q.policy.version,
    booker: cleanBooker(booker),
    channel,
    attestations: { policyToldToGuest: true, emailReadBack: true },
  });

  /** Ask for the checkout, or ask again with the same key. */
  const sendOpen = async (q: Quote) => {
    const body = openBody(q);
    setFrozen(true);
    setOpenUnknown(true);
    const result = await openCheckout(tenantId, body, openKey.keyFor(body));
    if (result.kind === "ok") setOpenUnknown(false);
    else if (
      result.reason === "refused" &&
      result.code !== "payment_provider_unavailable" &&
      result.code !== undefined
    ) {
      // A refusal with a reason: nothing was held.
      setOpenUnknown(false);
    }
    return result;
  };

  const holdSeats = async () => {
    if (!quote) return;
    const missing = { email: !attest.email, policy: !attest.policy };
    setAttestErrors(missing);
    if (missing.email) emailCheck.current?.focus();
    else if (missing.policy) policyCheck.current?.focus();
    if (missing.email || missing.policy) return;
    setBusy("open");
    setProblem(null);
    const result = await sendOpen(quote);
    setBusy(null);
    if (result.kind === "ok") {
      setCheckout(result.value.checkout);
      setStep(3);
      return;
    }
    const failed = problemOf(result);
    setProblem(failed);
    // Refused with a reason: nothing is held, and the details can change again.
    if (failed.kind === "refusal" && failed.refusal.next !== "retry") setFrozen(false);
  };

  /** Back to the party, canceling whatever is held first. */
  const startOver = async () => {
    setBusy("edit");
    setProblem(null);
    let held = checkout;
    if (!held && openUnknown && quote) {
      // The checkout may exist without its id reaching here: ask again with the same key.
      const again = await sendOpen(quote);
      if (again.kind === "ok") held = again.value.checkout;
    }
    if (held && held.state === "open") {
      const canceled = await cancelCheckout(tenantId, held.id, newKey());
      if (canceled.kind === "failed" && !(canceled.reason === "refused")) {
        setBusy(null);
        setProblem(problemOf(canceled));
        return;
      }
    }
    setBusy(null);
    setCheckout(null);
    setFrozen(false);
    setOpenUnknown(false);
    setQuote(null);
    setAttest({ email: false, policy: false });
    openKey.forget();
    payKey.forget();
    setStep(0);
  };

  const pay = async (outcome: StaffTestPaymentOutcome) => {
    if (!checkout) return;
    setBusy(outcome);
    setLastPay(outcome);
    setProblem(null);
    const result = await takeTestPayment(tenantId, checkout.id, outcome, payKey.keyFor(outcome));
    if (result.kind === "ok") {
      setBusy(null);
      if (result.value.delivery.status !== 200) {
        // The provider has the payment; its result did not reach TideGrid. Same key again.
        setProblem({ kind: "delivery" });
        return;
      }
      setPolls(0);
      setStep(4);
      return;
    }
    if (result.reason === "refused" && result.code === "checkout_not_open") {
      const now = await readCheckout(tenantId, checkout.id);
      setBusy(null);
      if (now.kind === "ok") {
        setCheckout(now.value);
        setStep(4);
        return;
      }
    }
    setBusy(null);
    if (result.reason === "key_reused") payKey.forget();
    setProblem(problemOf(result));
  };

  const cancelBooking = async () => {
    if (!checkout) return;
    setBusy("cancel");
    const result = await cancelCheckout(tenantId, checkout.id, newKey());
    setBusy(null);
    setConfirmCancel(false);
    if (result.kind === "ok") {
      setCheckout(result.value);
      setStep(4);
      return;
    }
    setProblem(problemOf(result));
  };

  // Rendering ------------------------------------------------------------------------------

  const header = (
    <PageHeader eyebrow={tenantName} title="New booking" focusHeading={focusHeading} />
  );
  if (load.kind === "loading") {
    return (
      <>
        {header}
        <p className="tg-visually-hidden" role="status">
          Loading the trip…
        </p>
        <div className="nb-page" aria-hidden="true">
          <Skeleton width="min(22rem, 80%)" height="2rem" />
          <Skeleton height="5rem" />
          <Skeleton height="5rem" />
        </div>
      </>
    );
  }
  if (load.kind === "off_sale") {
    return (
      <>
        {header}
        <EmptyState
          icon="hourglass"
          title={refusalOf(load.code).title}
          actions={
            <ConsoleButtonLink href="/calendar" icon="calendar">
              Go to calendar
            </ConsoleButtonLink>
          }
        >
          <p>{refusalOf(load.code).body}</p>
        </EmptyState>
      </>
    );
  }
  if (load.kind === "failed") {
    return (
      <>
        {header}
        {load.reason === "not_found" ? (
          <EmptyState
            icon="compass"
            title="This trip isn't here"
            actions={
              <ConsoleButtonLink href="/calendar" icon="calendar">
                Go to calendar
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
            className="nb-notice"
            reason={load.reason}
            noun="the trip"
            tenantName={tenantName}
            failures={load.failures}
            retrying={load.retrying}
            onRetry={() => {
              retryRequested.current = true;
              setAttempt((n) => n + 1);
            }}
          />
        )}
      </>
    );
  }

  const trip = load.offer;
  const when = `${formatDate(trip.trip.localDate, "full", { year: true })}, ${formatTripTime(
    trip.trip.localStartTime,
    trip.trip.startsAt,
    trip.trip.timeZone,
  )}`;
  const draft = party ?? emptyParty(trip);
  const locked = frozen || busy !== null;

  return (
    <>
      {header}
      <div className="nb-page">
        <section className="nb-trip" aria-label="Trip">
          <p className="nb-trip__name">{trip.product.name}</p>
          <p className="nb-trip__when">{when}</p>
        </section>
        <Steps steps={stepNames} current={step} label="Booking steps" className="nb-steps" />
        {problem && (
          <ProblemNotice
            problem={problem}
            tenantName={tenantName}
            busy={busy !== null}
            onRetry={retryFor(problem)}
          />
        )}

        {step === 0 && (
          <section className="nb-step" aria-labelledby="nb-step-title">
            <StepHeading headingRef={stepHeading}>Who is coming</StepHeading>
            {trip.product.kind === "private_charter" ? (
              <QuantityField
                label="Guests aboard"
                hint={`${trip.charter ? `${trip.charter.name}, ${formatMoney(trip.charter.amount)}. ` : ""}Parties of ${trip.product.minPartySize} to ${trip.product.maxPartySize}.`}
                value={draft.guests}
                min={trip.product.minPartySize}
                max={trip.product.maxPartySize}
                onChange={(value) => setParty({ ...draft, guests: value })}
                decrementLabel="One guest fewer"
                incrementLabel="One guest more"
                describe={(n) => `${n} aboard`}
                disabled={locked}
              />
            ) : (
              trip.tickets.map((t) => (
                <QuantityField
                  key={t.code}
                  label={t.name}
                  hint={`${formatMoney(t.unitAmount)} each`}
                  value={draft.tickets[t.code] ?? 0}
                  max={trip.product.maxPartySize}
                  onChange={(value) =>
                    setParty({ ...draft, tickets: { ...draft.tickets, [t.code]: value } })
                  }
                  decrementLabel={`Remove one ${t.name}`}
                  incrementLabel={`Add one ${t.name}`}
                  describe={(n) => `${n} ${t.name}`}
                  disabled={locked}
                />
              ))
            )}
            {trip.addOns.length > 0 && (
              <fieldset className="nb-extras">
                <legend>Extras</legend>
                {trip.addOns.map((a) => (
                  <QuantityField
                    key={a.code}
                    label={a.name}
                    hint={`${formatMoney(a.unitAmount)} ${a.quantityRule === "per_participant" ? "per guest" : "per booking"}`}
                    value={draft.addOns[a.code] ?? 0}
                    max={addOnLimit(trip, a.code, draft)}
                    onChange={(value) =>
                      setParty({ ...draft, addOns: { ...draft.addOns, [a.code]: value } })
                    }
                    decrementLabel={`Remove one ${a.name}`}
                    incrementLabel={`Add one ${a.name}`}
                    disabled={locked}
                  />
                ))}
              </fieldset>
            )}
            <TextField
              label="Promotion code (optional)"
              value={draft.promotionCode}
              onChange={(e) => setParty({ ...draft, promotionCode: e.target.value })}
              autoComplete="off"
              disabled={locked}
            />
            <p className="nb-status" role="status">
              {partyError ?? `${guestsOf(trip, draft)} guests`}
            </p>
            <div className="nb-actions">
              <Button
                variant="primary"
                icon="chevron-right"
                iconPosition="end"
                busy={busy === "quote"}
                busyLabel="Pricing…"
                onClick={() => void priceParty(1)}
              >
                Price and continue
              </Button>
            </div>
          </section>
        )}

        {step === 1 && (
          <section className="nb-step" aria-labelledby="nb-step-title">
            <StepHeading headingRef={stepHeading}>The guest</StepHeading>
            <TextField
              ref={nameField}
              label="Booker's name"
              value={booker.name}
              onChange={(e) => setBooker({ ...booker, name: e.target.value })}
              error={bookerErrors.name}
              autoComplete="off"
              maxLength={200}
              disabled={locked}
            />
            <TextField
              ref={emailField}
              label="Booker's email"
              type="email"
              hint="The confirmation, management link, and waiver requests go here."
              value={booker.email}
              onChange={(e) => setBooker({ ...booker, email: e.target.value })}
              error={bookerErrors.email}
              autoComplete="off"
              spellCheck={false}
              disabled={locked}
            />
            <SelectField
              label="How the guest reached you"
              options={channelOptions}
              value={channel}
              onChange={(e) => setChannel(e.target.value as BookingChannel)}
              disabled={locked}
            />
            <div className="nb-actions">
              <Button variant="primary" icon="chevron-right" iconPosition="end" onClick={toReview}>
                Review
              </Button>
              <Button icon="chevron-left" onClick={() => setStep(0)} disabled={locked}>
                Back to party
              </Button>
            </div>
          </section>
        )}

        {step === 2 && quote && (
          <section className="nb-step" aria-labelledby="nb-step-title">
            <StepHeading headingRef={stepHeading}>Review with the guest</StepHeading>
            <Ledger caption="Price in US dollars" rows={quoteLedger(quote)} />
            <div className="nb-policy">
              <h3>Cancellation policy (version {quote.policy.version})</h3>
              <p>{quote.policy.text.cancellation}</p>
            </div>
            <div className="nb-readback">
              <p className="nb-readback__label">Read this address back to the guest</p>
              <p className="nb-readback__email">{cleanBooker(booker).email}</p>
              <p className="nb-readback__hint">It cannot be changed after booking.</p>
            </div>
            <CheckboxField
              ref={emailCheck}
              label="I read the email address back to the guest"
              checked={attest.email}
              onChange={(e) => setAttest({ ...attest, email: e.target.checked })}
              error={attestErrors.email ? "Read the address back first." : undefined}
              disabled={locked}
            />
            <CheckboxField
              ref={policyCheck}
              label={`I told the guest the cancellation policy (version ${quote.policy.version})`}
              checked={attest.policy}
              onChange={(e) => setAttest({ ...attest, policy: e.target.checked })}
              error={attestErrors.policy ? "Tell the guest the policy first." : undefined}
              disabled={locked}
            />
            <p className="nb-note">
              The seats are held for 15 minutes once you continue, for the payment.
            </p>
            <div className="nb-actions">
              <Button
                variant="primary"
                icon="lock"
                busy={busy === "open"}
                busyLabel="Holding seats…"
                onClick={() => void holdSeats()}
              >
                Hold seats and take payment
              </Button>
              <Button
                icon="pencil"
                busy={busy === "edit"}
                busyLabel="Releasing…"
                disabled={busy !== null && busy !== "edit"}
                onClick={() => void (frozen ? startOver() : setStep(0))}
              >
                Change details
              </Button>
            </div>
          </section>
        )}

        {step === 3 && checkout && (
          <section className="nb-step" aria-labelledby="nb-step-title">
            <StepHeading headingRef={stepHeading}>Payment</StepHeading>
            <Notice tone="info" title="This is a demo test payment" announce="none">
              <p>
                No real card is charged and no money moves. Choose how the test payment ends: it
                succeeds, or the card is declined.
              </p>
            </Notice>
            <dl className="nb-facts">
              <div>
                <dt>Amount</dt>
                <dd className="nb-facts__amount">{formatMoney(checkout.amount)}</dd>
              </div>
              <div>
                <dt>Seats held until</dt>
                <dd>{instantText(checkout.expiresAt, trip.trip.timeZone)}</dd>
              </div>
            </dl>
            <div className="nb-actions">
              <Button
                variant="primary"
                icon="credit-card"
                busy={busy === "succeed"}
                busyLabel="Taking payment…"
                disabled={busy !== null && busy !== "succeed"}
                onClick={() => void pay("succeed")}
              >
                Take test payment
              </Button>
              <Button
                icon="x-octagon"
                busy={busy === "fail"}
                busyLabel="Declining…"
                disabled={busy !== null && busy !== "fail"}
                onClick={() => void pay("fail")}
              >
                Decline
              </Button>
            </div>
            <div className="nb-actions nb-actions--quiet">
              <Button
                variant="ghost"
                disabled={busy !== null}
                onClick={() => setConfirmCancel(true)}
              >
                Cancel booking
              </Button>
              <Button
                variant="ghost"
                icon="pencil"
                busy={busy === "edit"}
                busyLabel="Releasing…"
                disabled={busy !== null && busy !== "edit"}
                onClick={() => void startOver()}
              >
                Change details
              </Button>
            </div>
          </section>
        )}

        {step === 4 && checkout && (
          <section className="nb-step" aria-labelledby="nb-step-title">
            <StepHeading headingRef={stepHeading}>
              {outcomeTitle(outcomeOf(checkout), polls >= POLL_LIMIT)}
            </StepHeading>
            <OutcomeBody
              checkout={checkout}
              outcome={outcomeOf(checkout)}
              stalled={polls >= POLL_LIMIT}
              onCheck={() => setPolls(0)}
            />
          </section>
        )}
      </div>
      {confirmCancel && checkout && (
        <Dialog
          title="Cancel this booking?"
          tone="danger"
          onClose={() => setConfirmCancel(false)}
          dismissible={busy !== "cancel"}
          footer={
            <>
              <Button
                variant="danger"
                busy={busy === "cancel"}
                busyLabel="Canceling…"
                onClick={() => void cancelBooking()}
              >
                Cancel booking
              </Button>
              <Button disabled={busy === "cancel"} onClick={() => setConfirmCancel(false)}>
                Keep booking
              </Button>
            </>
          }
        >
          <p>The held seats go back on sale at once. Nothing has been charged.</p>
        </Dialog>
      )}
    </>
  );

  /** What trying again means for a problem on this step, if anything. */
  function retryFor(p: Problem): (() => void) | undefined {
    const again =
      p.kind === "delivery" ||
      (p.kind === "refusal" && p.refusal.next === "retry") ||
      (p.kind === "failure" && canRetry(p.reason));
    if (step === 0 && again) return () => void priceParty(1);
    if (step === 2 && p.kind === "refusal" && p.refusal.next === "requote") {
      return () => void requote();
    }
    if (step === 2 && again) return () => void holdSeats();
    if (step === 3 && again) return () => void pay(lastPay);
    return undefined;
  }

  async function requote() {
    // The quote lapsed before the checkout: price the same party again and stay on review.
    quoteKey.forget();
    openKey.forget();
    setFrozen(false);
    await priceParty(2);
  }
}

function StepHeading({
  children,
  headingRef,
}: {
  children: ReactNode;
  headingRef: RefObject<HTMLHeadingElement | null>;
}) {
  return (
    <h2 id="nb-step-title" className="nb-step__title" ref={headingRef} tabIndex={-1}>
      {children}
    </h2>
  );
}

function ProblemNotice({
  problem,
  tenantName,
  busy,
  onRetry,
}: {
  problem: Problem;
  tenantName: string;
  busy: boolean;
  onRetry: (() => void) | undefined;
}) {
  if (problem.kind === "failure") {
    return (
      <ReadFailed
        className="nb-notice"
        reason={problem.reason}
        noun="this booking"
        tenantName={tenantName}
        retrying={busy}
        {...(onRetry ? { onRetry } : {})}
      />
    );
  }
  const { title, body } =
    problem.kind === "delivery"
      ? {
          title: "The payment's result didn't reach TideGrid",
          body: "The provider has the payment, but nothing is decided yet. Try again: the same payment is sent again, never a second one.",
        }
      : problem.refusal;
  const action =
    onRetry && problem.kind === "refusal" && problem.refusal.next === "requote" ? (
      <Button variant="primary" icon="refresh" busy={busy} busyLabel="Pricing…" onClick={onRetry}>
        Price again
      </Button>
    ) : onRetry ? (
      <Button
        variant="primary"
        icon="refresh"
        busy={busy}
        busyLabel="Trying again…"
        onClick={onRetry}
      >
        Try again
      </Button>
    ) : undefined;
  return (
    <Notice tone="error" className="nb-notice" title={title} actions={action}>
      <p>{body}</p>
    </Notice>
  );
}

function outcomeTitle(outcome: Outcome, stalled: boolean): string {
  switch (outcome) {
    case "waiting":
      return stalled
        ? "Still waiting for the payment's result"
        : "Waiting for the payment's result";
    case "confirmed":
      return "Booked";
    case "declined":
      return "The test payment was declined";
    case "unfulfilled":
      return "The payment came too late";
    case "expired":
      return "The hold ended";
    case "canceled":
      return "Booking canceled";
  }
}

function OutcomeBody({
  checkout,
  outcome,
  stalled,
  onCheck,
}: {
  checkout: StaffCheckout;
  outcome: Outcome;
  stalled: boolean;
  onCheck: () => void;
}) {
  const again = (
    <ButtonLink href={hereAddress()} icon="refresh">
      Start a new booking
    </ButtonLink>
  );
  switch (outcome) {
    case "waiting":
      return stalled ? (
        <Notice
          tone="warning"
          title="TideGrid hasn't confirmed this payment yet"
          actions={
            <Button variant="primary" icon="refresh" onClick={onCheck}>
              Check again
            </Button>
          }
        >
          <p>
            The booking is confirmed only once the payment's result arrives. Check again shortly.
          </p>
        </Notice>
      ) : (
        <p className="nb-status" role="status">
          Waiting for the payment's result…
        </p>
      );
    case "confirmed":
      return (
        <Notice
          tone="success"
          title={`Booking ${checkout.booking?.reference ?? ""} is confirmed`}
          actions={
            checkout.booking ? (
              <ConsoleButtonLink
                variant="primary"
                href={bookingHref(checkout.booking.id)}
                icon="receipt"
              >
                Open the booking
              </ConsoleButtonLink>
            ) : undefined
          }
        >
          <p>
            Give the guest the reference. The confirmation, with the management link and any waiver
            requests, goes to the email address you read back.
          </p>
        </Notice>
      );
    case "declined":
      return (
        <Notice tone="warning" title="Nothing was booked" actions={again}>
          <p>The test card was declined, and the held seats went back on sale.</p>
        </Notice>
      );
    case "unfulfilled":
      return (
        <Notice tone="warning" title="Refunded in full" actions={again}>
          <p>
            The payment came through after the hold ended. It is refunded in full. Tell the guest.
          </p>
        </Notice>
      );
    case "expired":
      return (
        <Notice tone="warning" title="The seats were released" actions={again}>
          <p>The payment wasn't taken before the hold ended. Start again to book the guest.</p>
        </Notice>
      );
    case "canceled":
      return (
        <Notice tone="info" title="The held seats went back on sale" actions={again}>
          <p>Nothing was charged.</p>
          <p>
            <ConsoleLink href="/calendar" className="tap-target">
              Back to calendar
            </ConsoleLink>
          </p>
        </Notice>
      );
  }
}
