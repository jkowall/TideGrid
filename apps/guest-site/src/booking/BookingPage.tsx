import {
  type AvailableTrip,
  BookerDetails,
  type CheckoutPayment,
  type CheckoutSession,
  PromotionCodeInput,
  type PublicBrand,
  type Quote,
  type TripOffer,
} from "@tidegrid/contracts";
import { Notice, Skeleton, Steps } from "@tidegrid/design-system/components";
import { formatMoney, isKnownZone } from "@tidegrid/design-system/format";
import {
  type ReactNode,
  type Ref,
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { type LeaveGuard, useLeaveGuard, useNavigate } from "../navigation.tsx";
import { useTitle } from "../States.tsx";
import { type BookingStep, readAddress, restartHref, writeAddress } from "./address.ts";
import {
  CheckoutAttempt,
  CommandKey,
  cancelCheckout,
  createQuote,
  type Failure,
  getListing,
  getOffer,
  getQuote,
  newIdempotencyKey,
  openCheckout,
  outcomeUnknown,
  readCheckout,
  settleTestPayment,
  type TestPaymentOutcome,
} from "./api.ts";
import { ConfirmDialog } from "./ConfirmDialog.tsx";
import { ServerClock } from "./clock.ts";
import {
  type BookerDraft,
  type DetailsBusy,
  type DetailsErrors,
  DetailsStep,
} from "./DetailsStep.tsx";
import {
  addOnProblems,
  checkoutTrouble,
  contextOfOffer,
  contextOfQuote,
  describeExtras,
  describeParty,
  heldThing,
  initialSelection,
  isCharter,
  isFinal,
  keepSelection,
  type PartyLimits,
  partyLimits,
  partyProblem,
  pollDelay,
  quoteBody,
  quoteMatches,
  quoteTrouble,
  type Selection,
  type Stop,
  type TripContext,
  type Trouble,
  timing,
} from "./model.ts";
import {
  type BookingSummary,
  Canceled,
  Confirmed,
  Declined,
  Expired,
  Gone,
  Interrupted,
  LoadFailed,
  Stopped,
  stopTitle,
  Unfulfilled,
  Waiting,
} from "./Outcomes.tsx";
import { PartyStep, partyFieldId } from "./PartyStep.tsx";
import { type PayBusy, PayStep } from "./PayStep.tsx";
import {
  type BookedRecord,
  clearBooked,
  clearResume,
  type ResumeRecord,
  readBooked,
  readResume,
  saveBooked,
  saveResume,
} from "./resume.ts";
import { BookedHeader, TripFacts, TripHeader, tripWhen } from "./TripHeader.tsx";

/**
 * The guest checkout (G2.11b): party, details, payment, outcome. The page
 * never decides that anything is paid. It shows a confirmation only when the
 * checkout's own state, read from the API, says confirmed; a payment button
 * only asks the provider to settle.
 *
 * Secrets: the checkout secret and the payment's client secret live in this
 * component's memory. The checkout secret and id also go to sessionStorage
 * while the checkout is open (see resume.ts). The booker's name and email
 * live only in memory and in the POST that opens the checkout.
 *
 * History: moving on from the party and from the details adds a history
 * entry, so Back returns one step. Back from the payment asks to cancel the
 * checkout first, as Cancel checkout does; Back while a payment is being
 * confirmed, or while a checkout may have started, stays.
 */

type Load =
  | { kind: "loading" }
  | { kind: "failed"; retrying: boolean }
  | { kind: "stopped"; stop: Stop }
  /** A reload asked for a checkout this tab no longer has, and the trip is off sale. */
  | { kind: "gone" }
  /** A reload of a confirmation: shown again from what it said. */
  | { kind: "booked"; record: BookedRecord }
  | { kind: "ready"; offer: TripOffer; listing: AvailableTrip | null }
  /**
   * A reload during a checkout whose trip is off sale, often because the
   * checkout's own hold took the last seats or the whole boat. The quote
   * names the trip; only the checkout's outcome can be shown.
   */
  | { kind: "checkout"; quote: Quote };

/** The open checkout this page is working with. */
interface Live {
  sessionId: string;
  quoteId: string;
  secret: string;
  expiresAt: string;
  /** The last state read. Null after a reload until the first read answers. */
  session: CheckoutSession | null;
  /** What pays it. Never stored, so null after a reload. */
  payment: CheckoutPayment | null;
  /** A payment button was pressed for it, and the payment may have gone through. */
  paymentTried: boolean;
}

type Stage =
  | { kind: "restoring" }
  | { kind: "party" }
  | { kind: "details" }
  | { kind: "pay" }
  | { kind: "waiting" }
  | { kind: "outcome"; session: CheckoutSession }
  | { kind: "interrupted" }
  | { kind: "gone" }
  | { kind: "stopped"; stop: Stop };

type Busy = "quote" | DetailsBusy | PayBusy | "retry" | "release";

/** A question before a final step, asked in a dialog. */
type Confirm =
  /** Cancel the open checkout: Cancel checkout, or Back from the payment. */
  | { kind: "cancel" }
  /** Release an interrupted checkout and start over. */
  | { kind: "release" }
  /** Leave the page with an open, unpaid checkout. */
  | { kind: "leave"; proceed: () => void }
  /** Leave while a checkout may have started. */
  | { kind: "leave-in-doubt"; proceed: () => void };

/** The history entries this page made, so Back and Forward move between its steps. */
interface Trail {
  /** Marks this page's entries apart from any a reload left behind. */
  mount: string;
  steps: BookingStep[];
  pos: number;
}

interface EntryState {
  tidegrid: "booking";
  mount: string;
  pos: number;
}

const entryState = (trail: Trail): EntryState => ({
  tidegrid: "booking",
  mount: trail.mount,
  pos: trail.pos,
});

function isEntry(state: unknown, mount: string): state is EntryState {
  if (typeof state !== "object" || state === null) return false;
  const entry = state as Partial<EntryState>;
  return entry.tidegrid === "booking" && entry.mount === mount && typeof entry.pos === "number";
}

const stepNames = ["Party", "Details", "Payment"] as const;

function stepOf(stage: Stage): BookingStep | null {
  switch (stage.kind) {
    case "restoring":
      return null;
    case "party":
    case "stopped":
      return "party";
    case "details":
      return "details";
    case "pay":
      return "pay";
    default:
      return "status";
  }
}

function stageTitle(stage: Stage): string {
  switch (stage.kind) {
    case "restoring":
      return "Loading your checkout";
    case "party":
      return "Choose your party";
    case "details":
      return "Your details";
    case "pay":
      return "Payment";
    case "waiting":
      return "Confirming your payment";
    case "interrupted":
      return "Checkout interrupted";
    case "gone":
      return "Checkout not open";
    case "stopped":
      return "Not available";
    case "outcome":
      return {
        confirmed: "Booking confirmed",
        failed: "Payment declined",
        expired: "Checkout expired",
        unfulfilled: "Booking not possible",
        canceled: "Checkout canceled",
        open: "Payment",
      }[stage.session.state];
  }
}

/** Re-renders every few seconds while a deadline is on screen; the device's time. */
function useClock(active: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), timing.clockTickMs);
    return () => clearInterval(timer);
  }, [active]);
  return now;
}

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const isProviderUnavailable = (result: { kind: string; code?: string }) =>
  result.kind === "refused" && result.code === "payment_provider_unavailable";

const capitalized = (text: string) => `${text.charAt(0).toUpperCase()}${text.slice(1)}`;

/** "your seats were released", "the boat was released". */
const releasedText = (charter: boolean) =>
  `${heldThing(charter)} ${charter ? "was" : "were"} released`;

export function BookingPage({
  brand,
  tripId,
  focusOnArrival,
}: {
  brand: PublicBrand;
  tripId: string;
  /** Arrived from another page of the site: move focus to this page's heading once it loads. */
  focusOnArrival: boolean;
}) {
  const [address] = useState(() => readAddress(tripId, window.location.search));
  const [arrivalUrl] = useState(() => `${window.location.pathname}${window.location.search}`);
  const [load, setLoad] = useState<Load>({ kind: "loading" });
  const [loadAttempt, setLoadAttempt] = useState(0);
  const [stage, setStage] = useState<Stage>({ kind: "restoring" });
  const [selection, setSelection] = useState<Selection | null>(null);
  const [quote, setQuote] = useState<Quote | null>(null);
  /** The promotion code the last quote applied. Kept when the guest changes the party. */
  const [code, setCode] = useState<string | null>(null);
  const [busy, setBusy] = useState<Busy | null>(null);
  const [trouble, setTrouble] = useState<Trouble | null>(null);
  const [partyNotice, setPartyNotice] = useState<ReactNode>(null);
  const [promoDraft, setPromoDraft] = useState("");
  const [booker, setBooker] = useState<BookerDraft>({ name: "", email: "" });
  const [errors, setErrors] = useState<DetailsErrors>({});
  const [accepted, setAccepted] = useState<number | null>(null);
  const [live, setLiveState] = useState<Live | null>(null);
  const [inDoubt, setInDoubtState] = useState(false);
  const [priceChange, setPriceChange] = useState<string | null>(null);
  const [slow, setSlow] = useState(false);
  const [unreachable, setUnreachable] = useState(false);
  const [releaseTrouble, setReleaseTrouble] = useState<string | null>(null);
  const [announcement, setAnnouncement] = useState("");
  const [confirm, setConfirm] = useState<Confirm | null>(null);

  // The stage, the checkout, and the doubt as they are now, for work that
  // resumes after an answer: it goes on only if the page is still there.
  const stageRef = useRef<Stage>(stage);
  const liveRef = useRef<Live | null>(live);
  const inDoubtRef = useRef(false);
  const go = (next: Stage) => {
    stageRef.current = next;
    setStage(next);
  };
  const setLive = (next: Live | null) => {
    liveRef.current = next;
    setLiveState(next);
  };
  const setInDoubt = (value: boolean) => {
    inDoubtRef.current = value;
    setInDoubtState(value);
  };

  const quoteKey = useRef(new CommandKey());
  const checkoutAttempt = useRef(new CheckoutAttempt());
  const clock = useRef(new ServerClock());
  /** Aborted when the page goes, so no answer acts on a page that is gone. */
  const page = useRef<AbortController | null>(null);
  const lock = useRef(false);
  /** A request to open a checkout is out: until it answers, the checkout may be opening. */
  const opening = useRef(false);
  const initialized = useRef(false);
  /** The offer the selection was last fitted to; a new listing alone changes nothing. */
  const fittedOffer = useRef<TripOffer | null>(null);
  /** The ticket type the guest changed last, which takes focus if the party needs attention. */
  const lastTicket = useRef<string | null>(null);
  const trail = useRef<Trail>({ mount: newIdempotencyKey(), steps: [], pos: 0 });
  /** The step whose arrival adds a history entry instead of replacing this one. */
  const pendingPush = useRef<BookingStep | null>(null);
  const historyHandler = useRef<(target: BookingStep) => void>(() => {});
  const titleRef = useRef<HTMLHeadingElement>(null);
  const stepRef = useRef<HTMLHeadingElement>(null);
  const partyFieldRef = useRef<HTMLInputElement>(null);
  const fieldRefs = {
    name: useRef<HTMLInputElement>(null),
    email: useRef<HTMLInputElement>(null),
    policy: useRef<HTMLInputElement>(null),
    promo: useRef<HTMLInputElement>(null),
    promoApplied: useRef<HTMLParagraphElement>(null),
  };
  /**
   * Where focus goes after the next render: a named place, which may not be on
   * screen yet, or an element that is.
   */
  const focusTarget = useRef<"title" | "step" | "promo" | "promo-applied" | HTMLElement | null>(
    focusOnArrival ? "title" : null,
  );

  const navigate = useNavigate();
  const ready = load.kind === "ready" ? load : null;
  const offer = ready?.offer ?? null;
  const limits: PartyLimits | null = ready ? partyLimits(ready.offer, ready.listing) : null;
  const context: TripContext | null =
    load.kind === "ready"
      ? contextOfOffer(load.offer)
      : load.kind === "checkout"
        ? contextOfQuote(load.quote)
        : null;
  const tick = useClock(stage.kind === "details" || stage.kind === "pay" || stage.kind === "party");
  /** The server's time, as the page estimates it. */
  const now = clock.current.now(tick);

  // What answers read when they arrive, which may be renders later.
  const latest = useRef({ load, quote, context });
  useLayoutEffect(() => {
    latest.current = { load, quote, context };
  });

  const signal = () => page.current?.signal;
  const alive = () => page.current !== null && !page.current.signal.aborted;

  const pageTitle =
    load.kind === "booked"
      ? `Booking confirmed · ${load.record.productName} · ${brand.name}`
      : context
        ? `${stageTitle(stage)} · ${context.productName} · ${brand.name}`
        : load.kind === "gone"
          ? `Checkout not open · ${brand.name}`
          : load.kind === "stopped"
            ? `${stopTitle(load.stop, brand.name)} · ${brand.name}`
            : load.kind === "failed"
              ? `Trip unavailable · ${brand.name}`
              : `Book a trip · ${brand.name}`;

  // The page's life: commands stop when it goes, and a checkout left open and
  // unpaid is released at once rather than when its hold runs out.
  useEffect(() => {
    const controller = new AbortController();
    page.current = controller;
    return () => {
      controller.abort();
      const left = liveRef.current;
      const at = stageRef.current.kind;
      if (left && !left.paymentTried && (at === "pay" || at === "interrupted")) {
        void cancelCheckout(left.sessionId, left.secret, { keepalive: true });
        clearResume();
      }
    };
  }, []);

  // A link away from an open checkout, or from one that may have started, asks first.
  const leaveGuard = useCallback<LeaveGuard>((proceed) => {
    const at = stageRef.current.kind;
    const open = liveRef.current;
    if (open && !open.paymentTried && (at === "pay" || at === "interrupted")) {
      setConfirm({ kind: "leave", proceed });
      return true;
    }
    // A checkout that may have started, or may be starting now, could hold the
    // seats with no way back to it from another page.
    if (at === "details" && (inDoubtRef.current || opening.current)) {
      setConfirm({ kind: "leave-in-doubt", proceed });
      return true;
    }
    return false;
  }, []);
  useLeaveGuard(leaveGuard);

  // Focus moves to each new step's heading, once it is on screen. Not while
  // the trip is loading again: the place asked for is not drawn yet.
  useEffect(() => {
    const target = focusTarget.current;
    if (!target || load.kind === "loading" || (load.kind === "failed" && load.retrying)) return;
    const named: Record<string, HTMLElement | null> = {
      title: titleRef.current ?? stepRef.current,
      step: stepRef.current,
      promo: fieldRefs.promo.current,
      "promo-applied": fieldRefs.promoApplied.current,
    };
    const element = typeof target === "string" ? named[target] : target;
    if (!element) return;
    focusTarget.current = null;
    element.focus();
  });
  const focusStep = () => {
    focusTarget.current = "step";
  };

  // Load the offer, then the trip's listing for its facts and seats left.
  useEffect(() => {
    void loadAttempt;
    // A reload of a confirmation shows it again, from what it said.
    if (!initialized.current && address.step === "status" && !readResume(tripId)) {
      const record = readBooked(tripId);
      if (record) {
        setLoad({ kind: "booked", record });
        return;
      }
    }
    const controller = new AbortController();
    void (async () => {
      const result = await getOffer(tripId, controller.signal);
      if (controller.signal.aborted) return;
      if (result.kind !== "ok") {
        // A checkout outlives its trip's sale: its own hold can take the last
        // seats. A reload during one shows the checkout from its quote.
        const resuming =
          !initialized.current &&
          (address.step === "pay" || address.step === "status") &&
          result.kind === "refused" &&
          result.status < 500;
        if (resuming) {
          const record = readResume(tripId);
          if (!record) {
            setLoad({ kind: "gone" });
            return;
          }
          const stored = await getQuote(record.quoteId, controller.signal);
          if (controller.signal.aborted) return;
          if (stored.kind === "ok" && stored.value.tripId === tripId) {
            setLoad(
              isKnownZone(stored.value.trip.timeZone)
                ? { kind: "checkout", quote: stored.value }
                : { kind: "failed", retrying: false },
            );
            return;
          }
        }
        setLoad(offerFailure(result));
        return;
      }
      if (!isKnownZone(result.value.trip.timeZone)) {
        setLoad({ kind: "failed", retrying: false });
        return;
      }
      const listing = await getListing(result.value, controller.signal);
      if (controller.signal.aborted) return;
      setLoad({
        kind: "ready",
        offer: result.value,
        listing: listing.kind === "ok" ? listing.value : null,
      });
    })();
    return () => controller.abort();
  }, [tripId, loadAttempt]);

  // The first time the trip is ready, start where the address says.
  useEffect(() => {
    if (load.kind === "checkout" && !initialized.current) {
      initialized.current = true;
      setQuote(load.quote);
      void restoreCheckout();
      return;
    }
    if (load.kind !== "ready") return;
    const productLimits = partyLimits(load.offer, null);
    if (initialized.current) {
      // A fresh listing alone changes no choice: a party past the seats left
      // stays, and the party step says so beside it.
      if (fittedOffer.current === load.offer) return;
      // The options were loaded again: keep the guest's choices it still sells.
      fittedOffer.current = load.offer;
      setSelection((current) =>
        current
          ? keepSelection(load.offer, current)
          : initialSelection(load.offer, address, productLimits),
      );
      return;
    }
    initialized.current = true;
    fittedOffer.current = load.offer;
    // Within the product's own limits only, so a restored checkout keeps its
    // party even when its hold left fewer seats on the list.
    const first = initialSelection(load.offer, address, productLimits);
    setSelection(first);
    if (address.step === "details") {
      void restoreDetails(load.offer, partyLimits(load.offer, load.listing), first);
    } else if (address.step === "pay" || address.step === "status") void restoreCheckout();
    else go({ kind: "party" });
    // Runs when the trip loads; the handlers it starts read the state they need.
  }, [load]);

  /** The address for a step of this page, with the guest's choices. */
  const urlFor = (step: BookingStep): string => {
    if (!offer || !selection) return arrivalUrl;
    const search = writeAddress({
      kind: isCharter(offer) ? "charter" : "tickets",
      tickets: selection.tickets,
      guests: selection.guests,
      addOns: selection.addOns,
      step,
      quoteId: quote?.quoteId ?? null,
    });
    return `${window.location.pathname}${search}`;
  };

  // The address follows the page, so a reload comes back to the same place.
  // Moving on to the details or the payment adds an entry; anything else
  // replaces this one.
  useEffect(() => {
    if (!offer || !selection) return;
    const step = stepOf(stage);
    if (!step) return;
    const url = urlFor(step);
    const t = trail.current;
    if (pendingPush.current === step && t.steps.length > 0) {
      pendingPush.current = null;
      t.steps = [...t.steps.slice(0, t.pos + 1), step];
      t.pos += 1;
      window.history.pushState(entryState(t), "", url);
      return;
    }
    if (t.steps.length === 0) t.steps = [step];
    t.steps[t.pos] = step;
    const here = `${window.location.pathname}${window.location.search}`;
    if (url !== here || !isEntry(window.history.state, t.mount)) {
      window.history.replaceState(entryState(t), "", url);
    }
  }, [offer, selection, stage, quote]);

  // After the address: a browser names each history entry by the title it
  // had while current, so a new step's entry must exist before its title is set.
  useTitle(pageTitle);

  // Back and Forward within this page move between its steps.
  useLayoutEffect(() => {
    historyHandler.current = onHistory;
  });
  useEffect(() => {
    const path = window.location.pathname;
    const onPop = (event: PopStateEvent) => {
      if (window.location.pathname !== path) return;
      const t = trail.current;
      const target = readAddress(tripId, window.location.search).step;
      if (isEntry(event.state, t.mount)) {
        t.pos = Math.max(0, Math.min(event.state.pos, t.steps.length - 1));
      } else {
        // An entry this page did not make: one from before a reload, or the
        // skip link's. Start this page's own entries from it.
        if (target === stepOf(stageRef.current)) return;
        t.steps = [target];
        t.pos = 0;
        window.history.replaceState(entryState(t), "", window.location.href);
      }
      historyHandler.current(target);
    };
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, [tripId]);

  /** Show a quote, and remember the code it applied. */
  const adopt = (next: Quote) => {
    setQuote(next);
    setCode(next.promotion?.code ?? null);
  };

  /** What the confirmation says, from what the page knows when the answer arrives. */
  function summaryNow(session: CheckoutSession): BookingSummary | null {
    const { load: current, quote: priced, context: trip } = latest.current;
    return summarize(session, trip, current.kind === "ready" ? current.listing : null, priced);
  }

  const recordOf = (open: Live, paymentSent: boolean): ResumeRecord => ({
    tripId,
    sessionId: open.sessionId,
    quoteId: open.quoteId,
    secret: open.secret,
    paymentSent,
    paymentTried: open.paymentTried || paymentSent,
    expiresAt: open.expiresAt,
    clockOffsetMs: clock.current.offset,
  });

  /** A final state: show it. An expiry after a payment may still turn into a booking. */
  const finish = (session: CheckoutSession, options: { focus?: boolean } = {}) => {
    const open = liveRef.current;
    if (session.state === "expired" && open?.paymentTried && stageRef.current.kind !== "waiting") {
      // A payment was sent, or may have been: a late success can still book
      // or refund this checkout, so watch it a little longer first.
      setLive({ ...open, session });
      go({ kind: "waiting" });
      if (options.focus !== false) focusStep();
      return;
    }
    clearResume();
    if (open) setLive({ ...open, session });
    go({ kind: "outcome", session });
    setSlow(false);
    setUnreachable(false);
    if (options.focus !== false) focusStep();
    if (session.state === "confirmed") {
      const summary = summaryNow(session);
      if (summary) saveBooked({ tripId, ...summary });
    }
    // The seats left beside the outcome include this checkout's own now.
    void refreshListing();
  };

  // While waiting: read the checkout with a gentle backoff until it is final.
  useEffect(() => {
    if (stage.kind !== "waiting" || !live) return;
    const controller = new AbortController();
    const started = Date.now();
    let expiredSince: number | null = null;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let attempt = 0;
    let misses = 0;
    const tick = async () => {
      const result = await readCheckout(live.sessionId, live.secret, controller.signal);
      if (controller.signal.aborted) return;
      if (result.kind === "ok") {
        misses = 0;
        setUnreachable(false);
        if (isFinal(result.value)) {
          // Expired while a payment was on its way: a late success still books
          // or refunds it, so keep reading for a short grace.
          const late = result.value.state === "expired" && liveRef.current?.paymentTried;
          if (late) expiredSince ??= Date.now();
          if (!late || Date.now() - (expiredSince ?? 0) >= timing.lateSuccessGraceMs) {
            finish(result.value);
            return;
          }
        }
        if (Date.now() - started > timing.slowAfterMs) setSlow(true);
      } else if (result.kind === "refused" && (result.status === 401 || result.status === 404)) {
        clearResume();
        go({ kind: "gone" });
        focusStep();
        return;
      } else {
        misses += 1;
        if (misses >= 3) setUnreachable(true);
      }
      timer = setTimeout(() => void tick(), pollDelay(attempt++));
    };
    void tick();
    return () => {
      controller.abort();
      if (timer !== undefined) clearTimeout(timer);
    };
  }, [stage.kind, live?.sessionId, live?.secret]);

  // A refund that is still on its way: look again a few times, then let it be.
  const refundPending =
    stage.kind === "outcome" &&
    stage.session.state === "unfulfilled" &&
    stage.session.refund?.state === "requested";
  useEffect(() => {
    if (!refundPending || !live) return;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    let tries = 0;
    const tick = async () => {
      const result = await readCheckout(live.sessionId, live.secret, controller.signal);
      if (controller.signal.aborted) return;
      if (result.kind === "ok" && result.value.refund?.state !== "requested") {
        go({ kind: "outcome", session: result.value });
        setAnnouncement(
          result.value.refund?.state === "succeeded"
            ? "Your refund has gone through."
            : "Your refund hasn't gone through.",
        );
        return;
      }
      if (++tries < 20) timer = setTimeout(() => void tick(), 3000);
    };
    timer = setTimeout(() => void tick(), 2000);
    return () => {
      controller.abort();
      if (timer !== undefined) clearTimeout(timer);
    };
  }, [refundPending, live?.sessionId, live?.secret]);

  // On the payment step, the hold's expiry on the server's clock ends the
  // checkout: read it then.
  useEffect(() => {
    if (stage.kind !== "pay" || !live) return;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const check = async () => {
      const result = await readCheckout(live.sessionId, live.secret, controller.signal);
      if (controller.signal.aborted) return;
      if (result.kind === "ok" && isFinal(result.value)) {
        finish(result.value);
        return;
      }
      timer = setTimeout(() => void check(), 5000);
    };
    const due = Date.parse(live.expiresAt) - clock.current.now();
    timer = setTimeout(() => void check(), Math.max(0, due) + timing.expiryGraceMs);
    return () => {
      controller.abort();
      if (timer !== undefined) clearTimeout(timer);
    };
  }, [stage.kind, live?.sessionId, live?.secret, live?.expiresAt]);

  // Commands ------------------------------------------------------------------------

  /** Run one command at a time: a second press while one is working does nothing. */
  const exclusive =
    <A extends unknown[]>(run: (...args: A) => Promise<void>) =>
    async (...args: A) => {
      if (lock.current) return;
      lock.current = true;
      try {
        await run(...args);
      } finally {
        lock.current = false;
      }
    };

  /**
   * Price a selection. With `fallback`, a promotion code that stopped
   * applying is dropped and the party priced without it, with a note on the
   * code field; the guest is never stuck on a code they cannot change here.
   */
  async function price(
    trip: TripOffer,
    fit: PartyLimits,
    chosen: Selection,
    promotion: string | null,
    fallback: boolean,
  ): Promise<{ quote: Quote; note?: string } | { trouble: Trouble }> {
    const body = quoteBody(trip, chosen, promotion);
    const result = await createQuote(body, quoteKey.current.for(JSON.stringify(body)), signal());
    if (result.kind === "ok") {
      quoteKey.current.done();
      // A new quote says when the server wrote it; a replay is old news.
      if (!result.replayed) clock.current.learn(result.value.quotedAt);
      return { quote: result.value };
    }
    const found = quoteTrouble(result, trip, fit);
    const onlyPromo =
      found.promo && !found.party && !found.addOns && !found.stale && !found.stop && !found.notice;
    if (promotion && fallback && onlyPromo && alive()) {
      const again = await price(trip, fit, chosen, null, false);
      if ("quote" in again) {
        return {
          quote: again.quote,
          note: `${promotion} can't be used anymore, so it was removed.`,
        };
      }
      return again;
    }
    return { trouble: found };
  }

  /** Show a quote trouble where it belongs. */
  function showQuoteTrouble(found: Trouble, where: "party" | "details") {
    if (found.stop) {
      go({ kind: "stopped", stop: found.stop });
      focusStep();
      return;
    }
    setTrouble(found);
    if (found.party || found.addOns || found.stale) {
      if (where === "details") {
        setQuote(null);
        go({ kind: "party" });
        focusStep();
        returnTo("party");
      } else if (found.party) {
        focusTarget.current = partyFieldRef.current;
      }
      // The guest's party stays as it is; the fresh seats left say why it can't go.
      if (found.party) void refreshListing();
    }
  }

  /**
   * Ask again how many seats are left. A trip that no longer lists, because
   * it is full, keeps the facts it had: the meeting point and cutoff still hold.
   */
  async function refreshListing() {
    const current = latest.current.load;
    if (current.kind !== "ready") return;
    const listing = await getListing(current.offer, signal());
    if (!alive()) return;
    if (listing.kind === "ok" && listing.value) {
      const fresh = listing.value;
      setLoad((was) => (was.kind === "ready" ? { ...was, listing: fresh } : was));
    }
  }

  /** The count that needs attention for a party problem: the one the guest changed last. */
  function partyFieldFor(trip: TripOffer, chosen: Selection): string {
    if (isCharter(trip)) return partyFieldId.guests;
    const counted = trip.tickets
      .filter((t) => (chosen.tickets[t.code] ?? 0) > 0)
      .map((t) => t.code);
    const last = lastTicket.current;
    const pick = last && counted.includes(last) ? last : (counted[0] ?? trip.tickets[0]?.code);
    return pick ? partyFieldId.ticket(pick) : partyFieldId.guests;
  }

  const continueFromParty = exclusive(async (committed: Selection) => {
    if (!ready || !limits) return;
    // The counts as the form held them, even one still being typed.
    setSelection(committed);
    const problem = partyProblem(ready.offer, committed, limits);
    const addOnTrouble = addOnProblems(ready.offer, committed);
    const firstAddOn = Object.keys(addOnTrouble)[0];
    if (problem || firstAddOn) {
      setTrouble({
        ...(problem ? { party: problem } : {}),
        ...(firstAddOn ? { addOns: addOnTrouble } : {}),
      });
      const field = document.getElementById(
        problem ? partyFieldFor(ready.offer, committed) : partyFieldId.addOn(firstAddOn ?? ""),
      );
      if (field) focusTarget.current = field;
      return;
    }
    setTrouble(null);
    setPartyNotice(null);
    setBusy("quote");
    const priced = await price(ready.offer, limits, committed, code, true);
    if (!alive()) return;
    setBusy(null);
    if ("trouble" in priced) {
      showQuoteTrouble(priced.trouble, "party");
      return;
    }
    adopt(priced.quote);
    if (priced.note) setTrouble({ promo: priced.note });
    pendingPush.current = "details";
    go({ kind: "details" });
    focusStep();
  });

  async function restoreDetails(trip: TripOffer, fit: PartyLimits, chosen: Selection) {
    go({ kind: "details" });
    setBusy("restore");
    let storedCode: string | null = null;
    if (address.quoteId) {
      const stored = await getQuote(address.quoteId, signal());
      if (!alive()) return;
      if (stored.kind === "ok" && stored.value.tripId === trip.tripId) {
        // Only a quote that still prices this party, within its validity.
        if (
          Date.parse(stored.value.expiresAt) > clock.current.now() &&
          quoteMatches(trip, chosen, stored.value)
        ) {
          adopt(stored.value);
          setBusy(null);
          return;
        }
        storedCode = stored.value.promotion?.code ?? null;
      }
    }
    const priced = await price(trip, fit, chosen, storedCode, true);
    if (!alive()) return;
    setBusy(null);
    if ("trouble" in priced) {
      showQuoteTrouble(priced.trouble, "details");
      return;
    }
    adopt(priced.quote);
    if (priced.note) setTrouble({ promo: priced.note });
  }

  const changePromo = exclusive(async (entered: string | null) => {
    // A new price while a checkout may exist would start a second one.
    if (!ready || !selection || !limits || inDoubtRef.current) return;
    let next = entered;
    if (next !== null) {
      const parsed = PromotionCodeInput.safeParse(next);
      if (!parsed.success) {
        setTrouble({ promo: "Enter the code as you were given it: 3 to 32 letters or numbers." });
        focusTarget.current = "promo";
        return;
      }
      next = parsed.data;
    }
    setTrouble(null);
    setBusy("promo");
    const priced = await price(ready.offer, limits, selection, next, false);
    if (!alive()) return;
    setBusy(null);
    if ("trouble" in priced) {
      if (priced.trouble.promo) {
        setTrouble({ promo: priced.trouble.promo });
        focusTarget.current = "promo";
        return;
      }
      showQuoteTrouble(priced.trouble, "details");
      return;
    }
    adopt(priced.quote);
    setPromoDraft("");
    // The control pressed is replaced: the code's new state takes focus.
    focusTarget.current = priced.quote.promotion ? "promo-applied" : "promo";
    const total = formatMoney(priced.quote.totals.total);
    setAnnouncement(
      next
        ? `Code ${priced.quote.promotion?.code ?? next} applied. The total is now ${total}.`
        : `Code removed. The total is now ${total}.`,
    );
  });

  /** Price the same party again, as a new command: the old price has expired. */
  async function repriceNow() {
    if (!ready || !selection || !limits || inDoubtRef.current) return;
    setTrouble(null);
    setBusy("refresh");
    const priced = await price(ready.offer, limits, selection, code, true);
    if (!alive()) return;
    setBusy(null);
    if ("trouble" in priced) {
      showQuoteTrouble(priced.trouble, "details");
      return;
    }
    adopt(priced.quote);
    if (priced.note) setTrouble({ promo: priced.note });
    setAnnouncement(`Price updated. The total is ${formatMoney(priced.quote.totals.total)}.`);
  }

  const refreshPrice = exclusive(repriceNow);

  /** Check the booker and the policy; on a problem, mark the fields and focus the first. */
  function checkDetails(forQuote: Quote): { name: string; email: string } | null {
    const next: DetailsErrors = {};
    const parsed = BookerDetails.safeParse({ name: booker.name, email: booker.email.trim() });
    if (!parsed.success) {
      for (const issue of parsed.error.issues) {
        const field = issue.path[0];
        if (field === "name" && !next.name) {
          // As the contract has it: 1 to 120 characters, with no control characters.
          next.name = !booker.name.trim()
            ? "Enter the name of the person booking."
            : issue.code === "too_big"
              ? "Use 120 characters or fewer."
              : "Remove tabs and other hidden characters from the name.";
        }
        if (field === "email" && !next.email) {
          next.email = booker.email.trim()
            ? "Enter an email address like name@example.com, without accents."
            : "Enter an email address.";
        }
      }
    }
    if (accepted !== forQuote.policy.version) {
      next.policy = "Accept the cancellation policy to continue.";
    }
    setErrors(next);
    const first = next.name
      ? fieldRefs.name.current
      : next.email
        ? fieldRefs.email.current
        : next.policy
          ? fieldRefs.policy.current
          : null;
    if (first) {
      focusTarget.current = first;
      return null;
    }
    return parsed.success ? parsed.data : null;
  }

  /**
   * Open the checkout for a quote. A 503 from the provider is sent again with
   * the same key, as the API asks. Returns the opened checkout, or null with
   * the trouble shown.
   */
  async function open(
    forQuote: Quote,
    who: { name: string; email: string },
  ): Promise<CheckoutSession | null> {
    if (!ready) return null;
    const from = stageRef.current.kind;
    // An earlier request under this key may have opened the checkout: its answer was lost.
    const doubted = inDoubtRef.current;
    const fingerprint = JSON.stringify([forQuote.quoteId, forQuote.policy.version, who]);
    const { key, secret } = checkoutAttempt.current.for(fingerprint);
    const body = {
      quoteId: forQuote.quoteId,
      acceptedPolicyVersion: forQuote.policy.version,
      booker: who,
      checkoutSecret: secret,
    };
    // While the request is out, the checkout may be opening: leaving asks first.
    opening.current = true;
    let result: Awaited<ReturnType<typeof openCheckout>>;
    try {
      result = await openCheckout(body, key, signal());
      for (const delay of timing.providerRetryDelaysMs) {
        if (!alive() || !isProviderUnavailable(result)) break;
        await wait(delay);
        if (!alive()) break;
        result = await openCheckout(body, key, signal());
      }
    } finally {
      opening.current = false;
    }
    if (!alive()) return null;
    if (result.kind === "ok") {
      checkoutAttempt.current.done();
      setInDoubt(false);
      const { session, payment } = result.value;
      if (!result.replayed) clock.current.learn(session.createdAt);
      const opened: Live = {
        sessionId: session.id,
        quoteId: forQuote.quoteId,
        secret,
        expiresAt: session.expiresAt,
        session,
        payment,
        paymentTried: false,
      };
      setLive(opened);
      if (session.state !== "open" || !payment) {
        // No longer payable: show what the checkout's own state says.
        const current = await readCheckout(session.id, secret, signal());
        if (!alive()) return null;
        if (current.kind === "ok" && isFinal(current.value)) {
          finish(current.value);
          return null;
        }
        setTrouble({
          notice: {
            title: "The payment couldn't start",
            body: "Wait a moment, then continue again.",
          },
        });
        go({ kind: "details" });
        return null;
      }
      saveResume(recordOf(opened, false));
      // A confirmation kept for this trip belongs to an earlier checkout: a
      // reload must never show it for this one.
      clearBooked(tripId);
      // From the details, the payment is a new step in the history; a retry
      // after a decline takes the outcome's place.
      pendingPush.current = from === "details" ? "pay" : null;
      go({ kind: "pay" });
      focusStep();
      // The seats left now count this checkout's own hold.
      void refreshListing();
      return session;
    }
    if (outcomeUnknown(result) || isProviderUnavailable(result)) {
      setInDoubt(true);
      go({ kind: "details" });
      return null;
    }
    // The rate limit refuses before the API reads the key, so after a lost
    // answer the checkout may still exist: the doubt and the attempt stand.
    if (doubted && result.kind === "refused" && result.code === "rate_limited") {
      setTrouble({
        notice: {
          title: "Too many tries in a short time",
          body: "Wait a minute, then press Try again.",
        },
      });
      go({ kind: "details" });
      return null;
    }
    // Any other refusal is definite: nothing was written under this key.
    checkoutAttempt.current.done();
    setInDoubt(false);
    const found = checkoutTrouble(result, brand.name, isCharter(ready.offer));
    if (result.kind === "refused" && result.code === "idempotency_key_reused") {
      setTrouble(found);
      go({ kind: "details" });
      return null;
    }
    if (found.stop) {
      go({ kind: "stopped", stop: found.stop });
      focusStep();
      return null;
    }
    if (found.party) {
      // The party stays as chosen, with the seats left beside it.
      setTrouble({ party: found.party });
      setQuote(null);
      go({ kind: "party" });
      focusStep();
      returnTo("party");
      void refreshListing();
      return null;
    }
    if (found.requote && selection && limits) {
      const priced = await price(
        ready.offer,
        limits,
        selection,
        forQuote.promotion?.code ?? null,
        true,
      );
      if (!alive()) return null;
      if ("trouble" in priced) {
        showQuoteTrouble(priced.trouble, "details");
        return null;
      }
      adopt(priced.quote);
      go({ kind: "details" });
      setTrouble({
        notice: {
          title: "Your price was updated",
          body: "The earlier price could no longer be used. Check the new total, then continue.",
        },
        ...(priced.note ? { promo: priced.note } : {}),
      });
      return null;
    }
    setTrouble(found);
    go({ kind: "details" });
    return null;
  }

  const startCheckout = exclusive(async () => {
    if (!quote) return;
    // An expired price is fetched again, except while a checkout may exist:
    // then only the same request may go, and the server answers it.
    if (!inDoubtRef.current && clock.current.now() >= Date.parse(quote.expiresAt)) {
      await repriceNow();
      return;
    }
    const who = checkDetails(quote);
    if (!who) return;
    setTrouble(null);
    setBusy("checkout");
    await open(quote, who);
    if (alive()) setBusy(null);
  });

  const pay = exclusive(async (outcome: TestPaymentOutcome) => {
    const current = liveRef.current;
    if (!current?.payment || stageRef.current.kind !== "pay") return;
    const { sessionId } = current;
    setTrouble(null);
    setBusy(outcome);
    // From here the payment may go through, even if its answer never arrives.
    const tried: Live = { ...current, paymentTried: true };
    setLive(tried);
    saveResume(recordOf(tried, false));
    const result = await settleTestPayment(current.payment, outcome, signal());
    if (!alive()) return;
    setBusy(null);
    // The checkout may have ended while the provider answered: leave it be.
    const still = () => stageRef.current.kind === "pay" && liveRef.current?.sessionId === sessionId;
    if (!still()) return;
    if (result.kind === "ok") {
      // Sent. A reload from here waits for the outcome instead of offering to pay.
      saveResume(recordOf(tried, true));
      go({ kind: "waiting" });
      focusStep();
      return;
    }
    // The provider did not say. The checkout's own state may: read it once.
    const read = await readCheckout(sessionId, tried.secret, signal());
    if (!alive() || !still()) return;
    if (read.kind === "ok" && isFinal(read.value)) {
      finish(read.value);
      return;
    }
    setTrouble({ notice: payNotice(result) });
  });

  /**
   * Cancel the open checkout. "canceled": released. "ended": it had ended
   * first, and the page now shows how. "limited" or "failed": still open.
   * "gone": the page went meanwhile.
   */
  async function cancelOpen(): Promise<"canceled" | "ended" | "limited" | "failed" | "gone"> {
    const open = liveRef.current;
    if (!open) return "canceled";
    const result = await cancelCheckout(open.sessionId, open.secret, { signal: signal() });
    if (!alive()) return "gone";
    if (result.kind === "ok" || (result.kind === "refused" && [401, 404].includes(result.status))) {
      clearResume();
      setLive(null);
      return "canceled";
    }
    if (result.kind === "refused" && result.code === "checkout_not_cancelable") {
      // It ended first, perhaps paid: show how.
      const current = await readCheckout(open.sessionId, open.secret, signal());
      if (!alive()) return "gone";
      if (current.kind === "ok") {
        finish(current.value);
        return "ended";
      }
    }
    return result.kind === "refused" && result.status === 429 ? "limited" : "failed";
  }

  const confirmCancel = exclusive(async () => {
    const open = liveRef.current;
    if (!open) {
      setConfirm(null);
      return;
    }
    const charter = latest.current.context?.charter ?? false;
    setTrouble(null);
    setBusy("cancel");
    const outcome = await cancelOpen();
    if (outcome === "gone") return;
    if (outcome === "canceled") {
      // The released seats are free again before the party step counts them.
      await refreshListing();
      if (!alive()) return;
    }
    setBusy(null);
    setConfirm(null);
    if (outcome === "canceled") {
      toParty(
        <Notice tone="success" title="Checkout canceled">
          <p>
            {open.paymentTried
              ? `Your checkout was canceled, and ${releasedText(charter)}. If your test payment went through, it is refunded in full.`
              : `Nothing was charged, and ${releasedText(charter)}.`}{" "}
            Change anything, then continue.
          </p>
        </Notice>,
      );
      returnTo("party");
      return;
    }
    if (outcome === "ended") return;
    setTrouble({
      notice:
        outcome === "limited"
          ? { title: "Too many tries in a short time", body: "Wait a minute, then try again." }
          : {
              title: "We couldn't cancel the checkout",
              body: `Check your connection, then try again. If you leave it, ${heldThing(charter)} ${charter ? "is" : "are"} released when the hold runs out.`,
            },
    });
  });

  /** Leave the page: cancel the open checkout first, if there is one. */
  const confirmLeave = exclusive(async (proceed: () => void) => {
    setBusy("cancel");
    const outcome = await cancelOpen();
    if (outcome === "gone") return;
    setBusy(null);
    setConfirm(null);
    // It ended first, perhaps paid: the page shows how instead of leaving.
    if (outcome === "ended") return;
    // Not released: the page releases it once more as it goes.
    proceed();
  });

  function toParty(notice: ReactNode = null) {
    setQuote(null);
    setTrouble(null);
    setPriceChange(null);
    setPartyNotice(notice);
    go({ kind: "party" });
    focusStep();
  }

  /**
   * Back to an earlier step through the history, when this page made that
   * entry, so Back then leaves the checkout instead of stepping through
   * entries for steps that are gone. Otherwise the address effect replaces
   * this entry.
   */
  function returnTo(step: BookingStep) {
    const t = trail.current;
    if (t.pos === 0) return;
    const back = t.steps.lastIndexOf(step, t.pos - 1);
    if (back < 0) return;
    window.history.go(back - t.pos);
  }

  const retryAfterDecline = exclusive(async () => {
    if (!ready || !selection || !limits) return;
    const before = liveRef.current?.session?.amount ?? null;
    setTrouble(null);
    setBusy("retry");
    const priced = await price(ready.offer, limits, selection, code, true);
    if (!alive()) return;
    if ("trouble" in priced) {
      setBusy(null);
      showQuoteTrouble(priced.trouble, "details");
      if (!priced.trouble.stop && !priced.trouble.party) {
        go({ kind: "details" });
        focusStep();
      }
      return;
    }
    adopt(priced.quote);
    if (priced.note) setTrouble({ promo: priced.note });
    const who = BookerDetails.safeParse({ name: booker.name, email: booker.email.trim() });
    if (accepted !== priced.quote.policy.version || !who.success) {
      // Something needs the guest's eyes first.
      setBusy(null);
      go({ kind: "details" });
      focusStep();
      return;
    }
    const opened = await open(priced.quote, who.data);
    if (!alive()) return;
    setBusy(null);
    if (opened && before !== null && opened.amount !== before) {
      setPriceChange(
        `This checkout's total is ${formatMoney(opened.amount)}. Your last try was ${formatMoney(before)}.`,
      );
    } else {
      setPriceChange(null);
    }
    if (!opened) focusStep();
  });

  /**
   * Back to the first step with the same party. With the trip's offer on the
   * page that happens in place; after a reload that found the trip off sale,
   * the page loads afresh and says whether the trip can be booked now.
   */
  const startOver = () => {
    setLive(null);
    clearResume();
    if (latest.current.load.kind === "ready") {
      toParty();
      returnTo("party");
    } else navigate(restartHref(address));
  };

  const releaseAndStartOver = exclusive(async () => {
    if (!liveRef.current) {
      setConfirm(null);
      startOver();
      return;
    }
    setReleaseTrouble(null);
    setBusy("release");
    const outcome = await cancelOpen();
    if (outcome === "gone") return;
    if (outcome === "canceled") {
      // Count the seats this checkout held as free again before the party step.
      await refreshListing();
      if (!alive()) return;
    }
    setBusy(null);
    setConfirm(null);
    if (outcome === "canceled") {
      startOver();
      return;
    }
    if (outcome === "ended") return;
    setReleaseTrouble("Check your connection, then try again.");
  });

  async function restoreCheckout() {
    const record = readResume(tripId);
    if (!record) {
      go({ kind: "gone" });
      return;
    }
    clock.current.adopt(record.clockOffsetMs);
    const restored: Live = {
      sessionId: record.sessionId,
      quoteId: record.quoteId,
      secret: record.secret,
      expiresAt: record.expiresAt,
      session: null,
      payment: null,
      paymentTried: record.paymentTried,
    };
    setLive(restored);
    // The quote says who is coming and what extras, for the outcome. A page
    // restored from its quote has it already.
    if (latest.current.load.kind !== "checkout" && !latest.current.quote) {
      const stored = await getQuote(record.quoteId, signal());
      if (!alive()) return;
      if (stored.kind === "ok" && stored.value.tripId === tripId) setQuote(stored.value);
    }
    const result = await readCheckout(record.sessionId, record.secret, signal());
    if (!alive()) return;
    if (result.kind === "ok") {
      setLive({ ...restored, session: result.value, expiresAt: result.value.expiresAt });
      if (isFinal(result.value)) {
        finish(result.value, { focus: false });
        return;
      }
      go({ kind: record.paymentSent ? "waiting" : "interrupted" });
      return;
    }
    if (result.kind === "refused" && (result.status === 401 || result.status === 404)) {
      clearResume();
      setLive(null);
      go({ kind: "gone" });
      return;
    }
    // No answer yet: keep waiting for a payment that was sent; otherwise offer to start over.
    go({ kind: record.paymentSent ? "waiting" : "interrupted" });
  }

  /**
   * Back or Forward arrived at another of this page's entries. Steps that can
   * be shown are; a step that is gone keeps the page where it is.
   */
  function onHistory(target: BookingStep) {
    const at = stageRef.current;
    const here = stepOf(at);
    if (!here || target === here) return;
    const t = trail.current;
    // A browser names an entry by the title it last had, so an entry this
    // page puts back or renames takes the page's title again.
    const retitle = () => {
      const title = document.title;
      document.title = "";
      document.title = title;
    };
    /** Put this step's entry back after the one Back reached, and say why when it helps. */
    const stay = (message?: string) => {
      t.steps = [...t.steps.slice(0, t.pos + 1), here];
      t.pos += 1;
      window.history.pushState(entryState(t), "", urlFor(here));
      retitle();
      if (message) setAnnouncement(message);
    };
    /** The entry names a step the page can't show now: it names this one instead. */
    const settle = () => {
      t.steps[t.pos] = here;
      window.history.replaceState(entryState(t), "", urlFor(here));
      retitle();
    };
    if (lock.current) {
      stay("Wait a moment: the page is still working.");
      return;
    }
    switch (at.kind) {
      case "party": {
        const current = latest.current.quote;
        if (
          target === "details" &&
          current &&
          offer &&
          selection &&
          quoteMatches(offer, selection, current) &&
          clock.current.now() < Date.parse(current.expiresAt)
        ) {
          go({ kind: "details" });
          focusStep();
          return;
        }
        settle();
        return;
      }
      case "details":
        if (inDoubtRef.current) {
          stay("Your checkout may have started. Press Try again to find out.");
          return;
        }
        if (target === "party") {
          setTrouble(null);
          go({ kind: "party" });
          focusStep();
          return;
        }
        settle();
        return;
      case "pay":
        // As Cancel checkout does: ask first, then release the seats.
        stay();
        setConfirm({ kind: "cancel" });
        return;
      case "waiting":
        stay("Your payment is being confirmed. Keep this page open until it finishes.");
        return;
      case "interrupted":
        stay();
        setConfirm({ kind: "release" });
        return;
      case "outcome":
        if ((target === "party" || target === "details") && latest.current.load.kind === "ready") {
          setLive(null);
          clearResume();
          toParty();
          if (target !== "party") returnTo("party");
          return;
        }
        settle();
        return;
      default:
        settle();
    }
  }

  // Render ---------------------------------------------------------------------------

  const announcer = (
    <p className="tg-visually-hidden" role="status">
      {load.kind === "loading" ? "Loading the trip…" : announcement}
    </p>
  );

  if (load.kind === "loading") {
    return (
      <div aria-busy="true">
        {announcer}
        <BookingSkeleton />
      </div>
    );
  }
  if (load.kind === "failed") {
    return (
      <div className="guest-container booking-alone">
        <LoadFailed
          retrying={load.retrying}
          onRetry={() => {
            // "Try again" goes away with the failure, so the trip's heading takes focus.
            focusTarget.current = "title";
            setLoad({ kind: "failed", retrying: true });
            setLoadAttempt((n) => n + 1);
          }}
          headingRef={stepRef}
        />
      </div>
    );
  }
  if (load.kind === "stopped") {
    return (
      <div className="guest-container booking-alone">
        <Stopped stop={load.stop} brand={brand} headingRef={stepRef} asPageHeading />
      </div>
    );
  }
  if (load.kind === "gone") {
    return (
      <div className="guest-container booking-alone">
        <Gone onStartOver={startOver} headingRef={stepRef} asPageHeading />
      </div>
    );
  }
  if (load.kind === "booked") {
    return (
      <>
        {announcer}
        <BookedHeader name={load.record.productName} when={load.record.when} titleRef={titleRef} />
        <div className="guest-container booking-alone">
          <Confirmed summary={load.record} brand={brand} headingRef={stepRef} />
        </div>
      </>
    );
  }

  const listing = load.kind === "ready" ? load.listing : null;
  const trip = load.kind === "ready" ? contextOfOffer(load.offer) : contextOfQuote(load.quote);
  const stepIndex = stage.kind === "party" ? 0 : stage.kind === "details" ? 1 : 2;
  const showSteps =
    stage.kind === "party" ||
    stage.kind === "details" ||
    stage.kind === "pay" ||
    stage.kind === "waiting";
  const held =
    (stage.kind === "pay" || stage.kind === "waiting") && live?.session
      ? { charter: trip.charter, seats: live.session.partySize }
      : null;

  return (
    <>
      {announcer}
      <TripHeader context={trip} listing={listing} titleRef={titleRef} />
      <div className="guest-container booking-layout">
        <aside className="booking-layout__facts" aria-label="Trip details">
          <TripFacts context={trip} listing={listing} held={held} />
        </aside>
        <div className="booking-layout__main">
          {showSteps && (
            <Steps
              className="booking-steps"
              steps={stepNames}
              current={stepIndex}
              label="Booking steps"
            />
          )}
          {stage.kind === "restoring" && (
            <div className="booking-step">
              <p className="tg-muted">Loading your checkout…</p>
              <Skeleton width="100%" height="10rem" />
            </div>
          )}
          {stage.kind === "party" && offer && selection && limits && (
            <PartyStep
              offer={offer}
              limits={limits}
              selection={selection}
              onSelection={(next) => {
                const changed = offer.tickets.find(
                  (t) => (next.tickets[t.code] ?? 0) !== (selection.tickets[t.code] ?? 0),
                );
                if (changed) lastTicket.current = changed.code;
                setSelection(next);
                if (trouble?.party || trouble?.addOns) setTrouble(null);
              }}
              onAnnounce={setAnnouncement}
              trouble={trouble}
              notice={partyNotice}
              busy={busy === "quote"}
              now={now}
              onContinue={(committed) => void continueFromParty(committed)}
              onReloadOptions={() => {
                setTrouble(null);
                setLoadAttempt((n) => n + 1);
              }}
              headingRef={stepRef}
              partyFieldRef={partyFieldRef}
            />
          )}
          {stage.kind === "details" && offer && (
            <DetailsStep
              offer={offer}
              quote={quote}
              now={now}
              busy={
                busy === "checkout" || busy === "refresh" || busy === "promo" || busy === "restore"
                  ? busy
                  : null
              }
              trouble={trouble}
              promoDraft={promoDraft}
              onPromoDraft={(value) => {
                setPromoDraft(value);
                if (trouble?.promo) setTrouble(null);
              }}
              onApplyPromo={() => void changePromo(promoDraft.trim())}
              onRemovePromo={() => void changePromo(null)}
              booker={booker}
              onBooker={(next) => {
                setBooker(next);
                if (errors.name || errors.email) {
                  setErrors((e) => ({ ...e, name: undefined, email: undefined }));
                }
              }}
              errors={errors}
              accepted={accepted}
              onAccept={(version) => {
                setAccepted(version);
                if (errors.policy) setErrors((e) => ({ ...e, policy: undefined }));
              }}
              inDoubt={inDoubt}
              onContinue={() => void startCheckout()}
              onRefresh={() => void refreshPrice()}
              onChangeParty={() => {
                // Unavailable while a checkout may have started.
                if (inDoubtRef.current) return;
                toParty();
                returnTo("party");
              }}
              headingRef={stepRef}
              fieldRefs={fieldRefs}
            />
          )}
          {stage.kind === "pay" && live?.session && (
            <PayStep
              session={live.session}
              timeZone={trip.trip.timeZone}
              charter={trip.charter}
              now={now}
              busy={busy === "succeed" || busy === "fail" || busy === "cancel" ? busy : null}
              trouble={trouble}
              priceChange={priceChange}
              onPay={(outcome) => void pay(outcome)}
              onCancel={() => setConfirm({ kind: "cancel" })}
              headingRef={stepRef}
            />
          )}
          {stage.kind === "waiting" && live && (
            <Waiting
              expiresAt={live.expiresAt}
              timeZone={trip.trip.timeZone}
              now={now}
              slow={slow}
              unreachable={unreachable}
              headingRef={stepRef}
            />
          )}
          {stage.kind === "outcome" && (
            <OutcomeFor
              session={stage.session}
              summary={summarize(stage.session, trip, listing, quote)}
              charter={trip.charter}
              paymentTried={live?.paymentTried ?? false}
              brand={brand}
              busy={busy === "retry"}
              onRetry={() => {
                if (load.kind === "ready") void retryAfterDecline();
                else startOver();
              }}
              onChangeParty={() => {
                if (load.kind !== "ready") {
                  startOver();
                  return;
                }
                setLive(null);
                toParty();
                returnTo("party");
              }}
              onStartOver={startOver}
              headingRef={stepRef}
            />
          )}
          {stage.kind === "interrupted" && (
            <Interrupted
              charter={trip.charter}
              paymentTried={live?.paymentTried ?? false}
              busy={busy === "release"}
              trouble={releaseTrouble}
              onStartOver={() => setConfirm({ kind: "release" })}
              headingRef={stepRef}
            />
          )}
          {stage.kind === "gone" && <Gone onStartOver={startOver} headingRef={stepRef} />}
          {stage.kind === "stopped" && (
            <Stopped stop={stage.stop} brand={brand} headingRef={stepRef} />
          )}
        </div>
      </div>
      {confirm && (
        <ConfirmQuestion
          confirm={confirm}
          charter={trip.charter}
          paymentTried={live?.paymentTried ?? false}
          busy={busy === "cancel" || busy === "release"}
          onCancelCheckout={() => void confirmCancel()}
          onRelease={() => void releaseAndStartOver()}
          onLeave={(proceed) => void confirmLeave(proceed)}
          onKeep={() => setConfirm(null)}
        />
      )}
    </>
  );
}

/** The question each final step asks before it goes ahead. */
function ConfirmQuestion({
  confirm,
  charter,
  paymentTried,
  busy,
  onCancelCheckout,
  onRelease,
  onLeave,
  onKeep,
}: {
  confirm: Confirm;
  charter: boolean;
  paymentTried: boolean;
  busy: boolean;
  onCancelCheckout: () => void;
  onRelease: () => void;
  onLeave: (proceed: () => void) => void;
  onKeep: () => void;
}) {
  const held = heldThing(charter);
  const are = charter ? "is" : "are";
  const refunded = paymentTried
    ? " If your test payment went through, it is refunded in full."
    : "";
  switch (confirm.kind) {
    case "cancel":
      return (
        <ConfirmDialog
          title="Cancel this checkout?"
          confirmLabel="Cancel checkout"
          busyLabel="Canceling…"
          keepLabel="Keep my checkout"
          busy={busy}
          onConfirm={onCancelCheckout}
          onKeep={onKeep}
        >
          <p>
            {capitalized(held)} {are} released at once, and you go back to choose your party.
            {refunded}
          </p>
        </ConfirmDialog>
      );
    case "release":
      return (
        <ConfirmDialog
          title="Release and start over?"
          confirmLabel="Release and start over"
          busyLabel="Releasing…"
          keepLabel="Not now"
          busy={busy}
          onConfirm={onRelease}
          onKeep={onKeep}
        >
          <p>
            This checkout can't be paid after the reload. Starting over releases {held} at once.
            {refunded}
          </p>
        </ConfirmDialog>
      );
    case "leave":
      return (
        <ConfirmDialog
          title="Leave this checkout?"
          confirmLabel="Cancel checkout and leave"
          busyLabel="Canceling…"
          keepLabel="Stay"
          busy={busy}
          onConfirm={() => onLeave(confirm.proceed)}
          onKeep={onKeep}
        >
          <p>Leaving cancels this checkout and releases {held} at once.</p>
        </ConfirmDialog>
      );
    case "leave-in-doubt":
      return (
        <ConfirmDialog
          title="Leave before your checkout is confirmed?"
          confirmLabel="Leave anyway"
          busyLabel="Leaving…"
          keepLabel="Stay"
          busy={false}
          onConfirm={() => {
            onKeep();
            confirm.proceed();
          }}
          onKeep={onKeep}
        >
          <p>
            We don't know yet whether your checkout started. If it did, it holds {held} until it
            runs out, up to 15 minutes. Stay and press Try again to find out.
          </p>
        </ConfirmDialog>
      );
  }
}

function OutcomeFor({
  session,
  summary,
  charter,
  paymentTried,
  brand,
  busy,
  onRetry,
  onChangeParty,
  onStartOver,
  headingRef,
}: {
  session: CheckoutSession;
  summary: BookingSummary | null;
  charter: boolean;
  paymentTried: boolean;
  brand: PublicBrand;
  busy: boolean;
  onRetry: () => void;
  onChangeParty: () => void;
  onStartOver: () => void;
  headingRef: Ref<HTMLHeadingElement>;
}) {
  switch (session.state) {
    case "confirmed":
      return summary ? <Confirmed summary={summary} brand={brand} headingRef={headingRef} /> : null;
    case "failed":
      return (
        <Declined
          charter={charter}
          busy={busy}
          onRetry={onRetry}
          onChangeParty={onChangeParty}
          headingRef={headingRef}
        />
      );
    case "expired":
      return (
        <Expired
          charter={charter}
          paymentTried={paymentTried}
          brand={brand}
          onStartOver={onStartOver}
          headingRef={headingRef}
        />
      );
    case "unfulfilled":
      return (
        <Unfulfilled session={session} charter={charter} brand={brand} headingRef={headingRef} />
      );
    case "canceled":
      return (
        <Canceled
          charter={charter}
          paymentTried={paymentTried}
          onStartOver={onStartOver}
          headingRef={headingRef}
        />
      );
    case "open":
      // Not an outcome; never shown.
      return null;
  }
}

/** What a confirmation says: the reference, the trip, the party, the extras, and the total. */
function summarize(
  session: CheckoutSession,
  trip: TripContext | null,
  listing: AvailableTrip | null,
  priced: Quote | null,
): BookingSummary | null {
  const reference = session.booking?.reference;
  if (!reference || !trip) return null;
  return {
    reference,
    productName: trip.productName,
    when: tripWhen(trip.trip),
    where: listing?.location.name ?? null,
    meetAt: listing?.location.meetingPoint ?? null,
    party: describeParty(session.partySize, priced),
    extras: describeExtras(priced),
    total: session.amount,
  };
}

function offerFailure(failure: Failure): Load {
  if (failure.kind === "refused") {
    if (failure.status === 404) return { kind: "stopped", stop: "not_found" };
    if (failure.code === "trip_not_bookable") return { kind: "stopped", stop: "not_bookable" };
    if (failure.code === "pricing_unavailable") return { kind: "stopped", stop: "pricing" };
  }
  return { kind: "failed", retrying: false };
}

function payNotice(failure: Failure): { title: string; body: string } {
  if (failure.kind === "refused" && failure.status === 429) {
    return { title: "Too many tries in a short time", body: "Wait a minute, then try again." };
  }
  if (failure.kind === "refused" && (failure.status === 401 || failure.status === 404)) {
    return {
      title: "The test payment couldn't be found",
      body: "Cancel this checkout and start again.",
    };
  }
  // The request may have reached the provider: say nothing about whether it paid.
  return {
    title: "We couldn't confirm your test payment",
    body: "The connection dropped before the payment service answered, so it may have gone through. Press the same button again: a payment that went through stands, and nothing is paid twice.",
  };
}

/** The shape of the booking page while the trip loads, so nothing jumps. */
function BookingSkeleton() {
  return (
    <>
      <div className="booking-hero booking-hero--skeleton" aria-hidden="true">
        <div className="guest-container booking-hero__inner">
          <Skeleton width="6rem" height="1rem" />
          <Skeleton width="min(24rem, 80%)" height="2.5rem" />
          <Skeleton width="min(18rem, 70%)" height="1.25rem" />
        </div>
      </div>
      <div className="guest-container booking-layout" aria-hidden="true">
        <div className="booking-layout__facts">
          <Skeleton width="100%" height="9rem" />
        </div>
        <div className="booking-layout__main">
          <Skeleton width="16rem" height="2rem" />
          <Skeleton width="100%" height="4rem" />
          <Skeleton width="100%" height="4rem" />
          <Skeleton width="100%" height="6rem" />
        </div>
      </div>
    </>
  );
}
