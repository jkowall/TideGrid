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
import type { Read } from "../bookings/api.ts";
import { bookingHref, guestsText, instantText } from "../bookings/model.ts";
import { canRetry, failureText, ReadFailed } from "../bookings/States.tsx";
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
  type BookingCommand,
  bookerProblems,
  channelOptions,
  cleanBooker,
  commandFailureTitles,
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

/**
 * A message about the last command, with what can be done about it. Each
 * carries the command it came from, so Try again repeats that command and
 * nothing else: a failed cancel is never retried as a payment.
 */
type Problem =
  | { kind: "refusal"; command: BookingCommand; refusal: Refusal }
  | { kind: "failure"; command: BookingCommand; reason: ReadFailure }
  /**
   * The provider settled the payment and its result did not reach TideGrid.
   * On the outcome (`check`), `declined` says it was a decline: nothing was
   * charged, and only its record is missing.
   */
  | { kind: "delivery"; command: "pay" | "check"; declined?: boolean };

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
/**
 * Keys for several request bodies at once: each body keeps its own key, so
 * asking for one test payment outcome never loses the other's (recheck 1).
 */
function useKeysFor() {
  const sent = useRef(new Map<string, string>());
  return {
    keyFor(body: unknown): string {
      const text = JSON.stringify(body);
      const known = sent.current.get(text);
      if (known) return known;
      const key = newKey();
      sent.current.set(text, key);
      return key;
    },
    forget() {
      sent.current.clear();
    },
  };
}

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

function problemOf(failure: CommandFailure, command: BookingCommand): Problem {
  if (failure.reason === "refused" || failure.reason === "key_reused") {
    return { kind: "refusal", command, refusal: refusalOf(failure.code, command) };
  }
  return { kind: "failure", command, reason: failure.reason };
}

/** An address with a break opportunity after each @ and dot, so it never wraps mid-word. */
function breakable(email: string): ReactNode[] {
  return email
    .split(/(?<=[@.])/)
    .flatMap((part, i) => (i === 0 ? [part] : [<wbr key={i} />, part]));
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
  /**
   * The id of a quote the checkout refused, asking for a new one: Hold waits
   * for a quote with another id, so a press never sends the refused one again.
   */
  const [refusedQuote, setRefusedQuote] = useState<string | null>(null);
  const quoteStale = refusedQuote !== null;
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
    null | "quote" | "open" | "edit" | "cancel" | "recheck" | StaffTestPaymentOutcome
  >(null);
  const [problem, setProblem] = useState<Problem | null>(null);
  const [confirmCancel, setConfirmCancel] = useState(false);
  const [polls, setPolls] = useState(0);
  /** The outcome the last test payment asked for, so a retry sends the same request. */
  const [lastPay, setLastPay] = useState<StaffTestPaymentOutcome>("succeed");
  /**
   * The provider settled the payment but its result did not reach TideGrid:
   * only Try again, on the same request, is offered until it does.
   */
  const [settledUndelivered, setSettledUndelivered] = useState(false);
  /** A test payment got no answer: it may have gone through. */
  const [payUncertain, setPayUncertain] = useState(false);

  const quoteKey = useKeyFor();
  const openKey = useKeyFor();
  const payKey = useKeysFor();
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

  // An attestation is for one address, one channel, and one quote's policy, on
  // the review in front of the guest: leaving the review, or a new quote,
  // clears both boxes, so they are checked again for what is shown. A new
  // quote clears them in the same update that shows it (see priceParty), so
  // no press can send it with the boxes checked for the one before.
  useEffect(() => {
    if (step === 2) return;
    setAttest({ email: false, policy: false });
    setAttestErrors({ email: false, policy: false });
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
      if (result.value.quoteId === refusedQuote) {
        // The refused quote came back, as a replayed answer would: it is still
        // refused. Say so, keep Hold waiting, and ask with a new key next time.
        quoteKey.forget();
        setProblem({ kind: "refusal", command: "quote", refusal: refusalOf("quote_expired") });
        return;
      }
      if (
        result.value.quoteId !== quote?.quoteId ||
        result.value.policy.version !== quote?.policy.version
      ) {
        setAttest({ email: false, policy: false });
        setAttestErrors({ email: false, policy: false });
      }
      setQuote(result.value);
      setRefusedQuote(null);
      setStep(andThen);
      return;
    }
    if (result.reason === "key_reused") quoteKey.forget();
    setProblem(problemOf(result, "quote"));
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
    // One command at a time: not while Price again, an edit, or a cancel is working.
    // Not with a quote the checkout refused. Defense in depth, untested: Hold is
    // unavailable in every render where quoteStale is true, so no press gets here.
    if (!quote || quoteStale || busy !== null) return;
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
    const failed = problemOf(result, "open");
    setProblem(failed);
    if (failed.kind === "refusal" && failed.refusal.next === "requote") {
      // Only a new quote helps. New keys for both requests, so pricing the same
      // party again from any step never replays the refused quote, and the next
      // hold is a new request.
      quoteKey.forget();
      openKey.forget();
      setRefusedQuote(quote.quoteId);
    }
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
      if (again.kind === "ok") {
        // Keep it, so a retry of this edit cancels the same checkout (recheck 2).
        held = again.value.checkout;
        setCheckout(held);
      } else if (
        again.reason !== "refused" ||
        again.code === undefined ||
        again.code === "payment_provider_unavailable"
      ) {
        // Still no answer: the seats may be held. Say so, and keep the request to retry.
        setBusy(null);
        setProblem({
          kind: "refusal",
          command: "edit",
          refusal: {
            title: "The earlier hold couldn't be released yet",
            body: "TideGrid hasn't confirmed whether the seats were held. Try again to release them before changing anything. If you leave this page, any held seats are released within 15 minutes.",
            next: "retry",
          },
        });
        return;
      }
    }
    if (held && held.state === "open") {
      const canceled = await cancelCheckout(tenantId, held.id, newKey());
      if (canceled.kind === "failed") {
        if (canceled.reason === "refused" && canceled.code === "checkout_not_cancelable") {
          // Its payment was decided first: show where it stands, not a fresh start.
          await showCheckout(held.id);
          return;
        }
        setBusy(null);
        setProblem(problemOf(canceled, "edit"));
        return;
      }
    }
    setBusy(null);
    setCheckout(null);
    setFrozen(false);
    setOpenUnknown(false);
    setPayUncertain(false);
    setSettledUndelivered(false);
    setQuote(null);
    setRefusedQuote(null);
    setAttest({ email: false, policy: false });
    // A new checkout needs a new quote, even for the same party: the old one is used.
    quoteKey.forget();
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
      setPayUncertain(false);
      if (result.value.delivery.status !== 200) {
        // The provider has the payment; its result did not reach TideGrid. Same key again.
        setSettledUndelivered(true);
        setProblem({ kind: "delivery", command: "pay" });
        return;
      }
      setSettledUndelivered(false);
      setPolls(0);
      setStep(4);
      return;
    }
    if (result.reason === "refused" && result.code === "test_payment_settled") {
      // The provider settled it the other way, and its result may not have
      // reached TideGrid. Keep that payment's own request, and offer only it.
      const settledAs: StaffTestPaymentOutcome = outcome === "succeed" ? "fail" : "succeed";
      setBusy(null);
      setLastPay(settledAs);
      setSettledUndelivered(true);
      setProblem({
        kind: "refusal",
        command: "pay",
        refusal: {
          title:
            settledAs === "succeed"
              ? "The test payment already went through"
              : "The test payment was already declined",
          body: "It was decided before this request, so this one was refused. Try again to make sure TideGrid has that result.",
          next: "retry",
        },
      });
      return;
    }
    if (result.reason === "refused" && result.code === "checkout_not_open") {
      // Refused on this payment's own key: a replay that found no settled
      // event, or a first try that recorded nothing. Nothing settled for this
      // request, so nothing was charged, as cancelBooking concludes from the
      // same answer.
      setPayUncertain(false);
      if ((await showCheckout(checkout.id)).kind === "ok") return;
    }
    setBusy(null);
    if (result.reason === "key_reused") payKey.forget();
    // No answer, or the provider's: the payment may have gone through.
    if (result.reason !== "refused" || result.code === "payment_provider_unavailable") {
      setPayUncertain(true);
    }
    setProblem(problemOf(result, "pay"));
  };

  /**
   * Read the checkout and show where it stands on the outcome step; the read
   * says whether it could. `after` is a problem from the request just before
   * the read, shown only while it still matters: the checkout is canceled and
   * its payment is undecided. A payment the provider declined charged nothing.
   */
  async function showCheckout(
    id: string,
    after: Problem | null = null,
  ): Promise<Read<StaffCheckout>> {
    const now = await readCheckout(tenantId, id);
    setBusy(null);
    if (now.kind !== "ok") return now;
    if (now.value.paymentState === "failed") setPayUncertain(false);
    setProblem(
      after && now.value.state === "canceled" && now.value.paymentState === "pending"
        ? after
        : null,
    );
    setCheckout(now.value);
    setPolls(0);
    setStep(4);
    return now;
  }

  /**
   * A test payment got no answer and its checkout is canceled now: send that
   * payment's own request again, on its key, so a result the provider settled
   * reaches TideGrid. On the API, a replay posts the settled event again
   * whatever the checkout's state and settles nothing new on a checkout that
   * is not open, and the fake settles a payment once. A first try that
   * recorded nothing makes this a new request, which is refused as not open.
   * A success delivered on a canceled checkout is refunded in full with an
   * exception, never booked. Answers the problem to show beside the outcome.
   */
  async function resendUncertainPayment(id: string): Promise<Problem | null> {
    const sent = await takeTestPayment(tenantId, id, lastPay, payKey.keyFor(lastPay));
    if (sent.kind === "ok") {
      // A decline charged nothing, delivered or not.
      const declined = sent.value.event.type === "payment.failed";
      if (declined) setPayUncertain(false);
      // The provider has the payment, but its result did not land: the same request again.
      if (sent.value.delivery.status !== 200)
        return { kind: "delivery", command: "check", declined };
      return null;
    }
    if (sent.reason === "refused" && sent.code === "checkout_not_open") {
      // Refused as no longer open: nothing had settled, so nothing was charged.
      setPayUncertain(false);
      return null;
    }
    return problemOf(sent, "check");
  }

  /**
   * Check again, after a test payment that got no answer. With `resend`, on a
   * canceled checkout, that payment's own request goes again before the read.
   * On a hold that ended instead, which the page reaches only when staff asked
   * to cancel and the cancel was refused because the hold had already ended,
   * only the read (owner decision, 2026-10-29): a success delivered there
   * books the guest when the seats are still free, against the cancel staff
   * asked for. A read that fails says so.
   */
  const checkAgain = async (resend: boolean) => {
    if (!checkout) return;
    setBusy("recheck");
    setProblem(null);
    const after =
      resend && outcomeOf(checkout) === "canceled"
        ? await resendUncertainPayment(checkout.id)
        : null;
    const read = await showCheckout(checkout.id, after);
    if (read.kind !== "ok")
      setProblem(after ?? { kind: "failure", command: "check", reason: read.reason });
  };

  const cancelBooking = async () => {
    if (!checkout) return;
    setBusy("cancel");
    setProblem(null);
    const result = await cancelCheckout(tenantId, checkout.id, newKey());
    setConfirmCancel(false);
    if (result.kind === "ok") {
      let after: Problem | null = null;
      if (payUncertain) {
        // The payment may have gone through: deliver whatever settled (recheck 3).
        after = await resendUncertainPayment(checkout.id);
        if ((await showCheckout(checkout.id, after)).kind === "ok") return;
      }
      setBusy(null);
      setProblem(after);
      setCheckout(result.value);
      setStep(4);
      return;
    }
    if (result.reason === "refused" && result.code === "checkout_not_cancelable") {
      // Its payment was decided first: show where it stands.
      if ((await showCheckout(checkout.id)).kind === "ok") return;
    }
    setBusy(null);
    setProblem(problemOf(result, "cancel"));
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
  /** The outcome offers Check again: an uncertain payment on a closed checkout. */
  const recheckShown =
    step === 4 &&
    checkout !== null &&
    payUncertain &&
    (outcomeOf(checkout) === "canceled" || outcomeOf(checkout) === "expired");

  return (
    <>
      {header}
      <div className="nb-page">
        <section className="nb-trip" aria-label="Trip">
          <p className="nb-trip__name">{trip.product.name}</p>
          <p className="nb-trip__when">{when}</p>
        </section>
        <Steps
          steps={stepNames}
          // Payment shows as done only for a confirmed booking.
          current={step === 4 && checkout && outcomeOf(checkout) !== "confirmed" ? 3 : step}
          label="Booking steps"
          className="nb-steps"
        />
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
              {partyError ?? guestsText(guestsOf(trip, draft))}
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
              <p className="nb-readback__email">{breakable(cleanBooker(booker).email)}</p>
              <p className="nb-readback__hint">It cannot be changed after booking.</p>
            </div>
            <CheckboxField
              ref={emailCheck}
              label="I read the email address back to the guest"
              checked={attest.email}
              onChange={(e) => {
                setAttest({ ...attest, email: e.target.checked });
                if (e.target.checked) setAttestErrors({ ...attestErrors, email: false });
              }}
              error={attestErrors.email ? "Read the address back first." : undefined}
              disabled={locked}
            />
            <CheckboxField
              ref={policyCheck}
              label={`I told the guest the cancellation policy (version ${quote.policy.version})`}
              checked={attest.policy}
              onChange={(e) => {
                setAttest({ ...attest, policy: e.target.checked });
                if (e.target.checked) setAttestErrors({ ...attestErrors, policy: false });
              }}
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
                disabled={quoteStale || (busy !== null && busy !== "open")}
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
                disabled={
                  settledUndelivered ||
                  (payUncertain && lastPay !== "succeed") ||
                  (busy !== null && busy !== "succeed")
                }
                onClick={() => void pay("succeed")}
              >
                Take test payment
              </Button>
              <Button
                icon="x-octagon"
                busy={busy === "fail"}
                busyLabel="Declining…"
                disabled={
                  settledUndelivered ||
                  (payUncertain && lastPay !== "fail") ||
                  (busy !== null && busy !== "fail")
                }
                onClick={() => void pay("fail")}
              >
                Decline
              </Button>
            </div>
            <div className="nb-actions nb-actions--quiet">
              <Button
                variant="ghost"
                disabled={settledUndelivered || busy !== null}
                onClick={() => setConfirmCancel(true)}
              >
                Cancel booking
              </Button>
              <Button
                variant="ghost"
                icon="pencil"
                busy={busy === "edit"}
                busyLabel="Releasing…"
                disabled={settledUndelivered || payUncertain || (busy !== null && busy !== "edit")}
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
              uncertain={payUncertain ? lastPay : null}
              checking={busy === "recheck"}
              onCheck={() => setPolls(0)}
              onRecheck={() => void checkAgain(payUncertain)}
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
          <p>
            {!payUncertain
              ? "The held seats go back on sale at once. Nothing has been charged."
              : lastPay === "fail"
                ? "The held seats go back on sale at once. Nothing has been charged: only a decline was asked for."
                : "The held seats go back on sale at once. The test payment may already have gone through; if it did, it is refunded in full and the operator sees an exception."}
          </p>
        </Dialog>
      )}
    </>
  );

  /** What trying again means for a problem on this step, if anything. */
  function retryFor(p: Problem): (() => void) | undefined {
    if (p.kind === "refusal" && p.refusal.next === "requote") {
      return () => void requote();
    }
    const again =
      p.kind === "delivery" ||
      (p.kind === "refusal" && p.refusal.next === "retry") ||
      (p.kind === "failure" && canRetry(p.reason));
    if (!again) return undefined;
    switch (p.command) {
      case "quote":
        return () => void priceParty(step === 2 ? 2 : 1);
      case "open":
        return () => void holdSeats();
      case "pay":
        return () => void pay(lastPay);
      case "check":
        // One control at a time: where the outcome offers Check again, that is the retry.
        if (recheckShown) return undefined;
        return () => void checkAgain(payUncertain || p.kind === "delivery");
      case "cancel":
        return () => void cancelBooking();
      case "edit":
        return () => void startOver();
    }
  }

  async function requote() {
    // The quote lapsed before the checkout: price the same party again and stay
    // on this step's way forward (review, or the guest after the party).
    quoteKey.forget();
    openKey.forget();
    setFrozen(false);
    await priceParty(step === 2 ? 2 : 1);
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
  if (problem.kind === "failure" && problem.reason === "signed_out") {
    // Sign in again, here.
    return (
      <ReadFailed
        className="nb-notice"
        reason={problem.reason}
        noun="this booking"
        tenantName={tenantName}
      />
    );
  }
  const { title, body } =
    problem.kind === "failure"
      ? {
          title: commandFailureTitles[problem.command],
          body: failureText(problem.reason, { noun: "this booking", tenantName }).body,
        }
      : problem.kind === "delivery"
        ? deliveryText(problem)
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

/** A settled payment whose result did not reach TideGrid, on the payment step or the outcome. */
function deliveryText(problem: { command: "pay" | "check"; declined?: boolean }) {
  if (problem.command === "pay") {
    return {
      title: "The payment's result didn't reach TideGrid",
      body: "The provider has the payment, but nothing is decided yet. Try again: the same payment is sent again, never a second one.",
    };
  }
  return problem.declined
    ? {
        title: "The decline didn't reach TideGrid",
        body: "Nothing was charged. Sending the same decline again records it.",
      }
    : {
        title: "The payment's result didn't reach TideGrid",
        body: "The provider has the payment. It is refunded in full once its result lands, and sending it again never charges twice.",
      };
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
  uncertain,
  checking,
  onCheck,
  onRecheck,
}: {
  checkout: StaffCheckout;
  outcome: Outcome;
  stalled: boolean;
  /**
   * A test payment got no answer before this outcome, and what it asked for.
   * A success may have gone through; a decline charged nothing either way.
   */
  uncertain: StaffTestPaymentOutcome | null;
  /** Check again is working. */
  checking: boolean;
  onCheck: () => void;
  onRecheck: () => void;
}) {
  const recheck = (
    <Button
      variant="primary"
      icon="refresh"
      busy={checking}
      busyLabel="Checking…"
      onClick={onRecheck}
    >
      Check again
    </Button>
  );
  const again = (
    <ButtonLink href={hereAddress()} icon="refresh">
      Start a new booking
    </ButtonLink>
  );
  const toCalendar = (
    <p>
      <ConsoleLink href="/calendar" className="tap-target">
        Back to calendar
      </ConsoleLink>
    </p>
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
            The payment came through after the hold ended or the booking was canceled. It is
            refunded in full. Tell the guest.
          </p>
        </Notice>
      );
    case "expired":
      return (
        <Notice
          tone="warning"
          title="The seats were released"
          actions={
            uncertain === "succeed" ? (
              recheck
            ) : uncertain === "fail" ? (
              <>
                {recheck}
                {again}
              </>
            ) : (
              again
            )
          }
        >
          <p>
            {uncertain === "succeed"
              ? "The hold ended before the test payment's result arrived. It may have gone through. If its result reaches TideGrid, the guest is booked if the seats are still free, or refunded in full. Check again shows where it stands."
              : uncertain === "fail"
                ? "The hold ended before the decline's result arrived. Nothing was charged: only a decline was asked for. Check again shows where it stands."
                : "The payment wasn't taken before the hold ended. Start again to book the guest."}
          </p>
          {uncertain === "succeed" && toCalendar}
        </Notice>
      );
    case "canceled":
      return (
        <Notice
          tone="info"
          title="The held seats went back on sale"
          actions={
            uncertain === "succeed" ? (
              recheck
            ) : uncertain === "fail" ? (
              <>
                {recheck}
                {again}
              </>
            ) : (
              again
            )
          }
        >
          <p>
            {uncertain === "succeed"
              ? "The test payment may have gone through before the cancel. If it did, it is refunded in full, and Check again shows the refund here; the operator also sees an exception."
              : uncertain === "fail"
                ? "Nothing was charged: only a decline was asked for. The decline may not have reached TideGrid yet, and Check again sends it again."
                : "Nothing was charged."}
          </p>
          {toCalendar}
        </Notice>
      );
  }
}
