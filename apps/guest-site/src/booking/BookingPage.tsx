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
import { type ReactNode, type Ref, useEffect, useRef, useState } from "react";
import { useNavigate } from "../navigation.tsx";
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
  openCheckout,
  outcomeUnknown,
  readCheckout,
  settleTestPayment,
  type TestPaymentOutcome,
} from "./api.ts";
import {
  type BookerDraft,
  type DetailsBusy,
  type DetailsErrors,
  DetailsStep,
} from "./DetailsStep.tsx";
import {
  checkoutTrouble,
  contextOfOffer,
  contextOfQuote,
  initialSelection,
  isCharter,
  isFinal,
  type PartyLimits,
  partyLimits,
  partyProblem,
  pollDelay,
  quoteBody,
  quoteTrouble,
  type Selection,
  type Stop,
  type TripContext,
  type Trouble,
  timing,
} from "./model.ts";
import {
  Canceled,
  Confirmed,
  Declined,
  Expired,
  Gone,
  Interrupted,
  LoadFailed,
  Stopped,
  Unfulfilled,
  Waiting,
} from "./Outcomes.tsx";
import { PartyStep } from "./PartyStep.tsx";
import { type PayBusy, PayStep } from "./PayStep.tsx";
import { clearResume, readResume, saveResume } from "./resume.ts";
import { TripFacts, TripHeader } from "./TripHeader.tsx";

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
 */

type Load =
  | { kind: "loading" }
  | { kind: "failed"; retrying: boolean }
  | { kind: "stopped"; stop: Stop }
  /** A reload asked for a checkout this tab no longer has, and the trip is off sale. */
  | { kind: "gone" }
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

/** Re-renders every few seconds while a deadline is on screen. */
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
  const [live, setLive] = useState<Live | null>(null);
  const [inDoubt, setInDoubt] = useState(false);
  const [priceChange, setPriceChange] = useState<string | null>(null);
  const [slow, setSlow] = useState(false);
  const [unreachable, setUnreachable] = useState(false);
  const [releaseTrouble, setReleaseTrouble] = useState<string | null>(null);
  const [announcement, setAnnouncement] = useState("");

  const quoteKey = useRef(new CommandKey());
  const checkoutAttempt = useRef(new CheckoutAttempt());
  const lock = useRef(false);
  const initialized = useRef(false);
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
  const now = useClock(stage.kind === "details" || stage.kind === "pay" || stage.kind === "party");

  useTitle(
    context
      ? `${stageTitle(stage)} · ${context.productName} · ${brand.name}`
      : load.kind === "gone"
        ? `Checkout not open · ${brand.name}`
        : `Book a trip · ${brand.name}`,
  );

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
            setLoad({ kind: "checkout", quote: stored.value });
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
    const fitted = partyLimits(load.offer, load.listing);
    if (initialized.current) {
      // The options were loaded again: keep the guest's choices that still fit.
      setSelection((current) =>
        current
          ? initialSelection(load.offer, { party: null, ...current }, fitted)
          : initialSelection(load.offer, address, fitted),
      );
      return;
    }
    initialized.current = true;
    const first = initialSelection(load.offer, address, fitted);
    setSelection(first);
    if (address.step === "details") void restoreDetails(load.offer, fitted, first);
    else if (address.step === "pay" || address.step === "status") void restoreCheckout();
    else setStage({ kind: "party" });
    // Runs when the trip loads; the handlers it starts read the state they need.
  }, [load]);

  // The address follows the page, so a reload comes back to the same place.
  useEffect(() => {
    if (!offer || !selection) return;
    const step = stepOf(stage);
    if (!step) return;
    const search = writeAddress({
      kind: isCharter(offer) ? "charter" : "tickets",
      tickets: selection.tickets,
      guests: selection.guests,
      addOns: selection.addOns,
      step,
      quoteId: quote?.quoteId ?? null,
    });
    if (search !== window.location.search) {
      window.history.replaceState(window.history.state, "", `${window.location.pathname}${search}`);
    }
  }, [offer, selection, stage, quote]);

  /** Show a quote, and remember the code it applied. */
  const adopt = (next: Quote) => {
    setQuote(next);
    setCode(next.promotion?.code ?? null);
  };

  const finish = (session: CheckoutSession) => {
    clearResume();
    setLive((current) => (current ? { ...current, session } : current));
    setStage({ kind: "outcome", session });
    setSlow(false);
    setUnreachable(false);
    focusStep();
  };

  // While waiting: read the checkout with a gentle backoff until it is final.
  useEffect(() => {
    if (stage.kind !== "waiting" || !live) return;
    const controller = new AbortController();
    const started = Date.now();
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
          finish(result.value);
          return;
        }
        if (Date.now() - started > timing.slowAfterMs) setSlow(true);
      } else if (result.kind === "refused" && (result.status === 401 || result.status === 404)) {
        clearResume();
        setStage({ kind: "gone" });
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
        setStage({ kind: "outcome", session: result.value });
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

  // On the payment step, the hold's expiry ends the checkout: read it then.
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
    const due = Date.parse(live.expiresAt) - Date.now();
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
    code: string | null,
    fallback: boolean,
  ): Promise<{ quote: Quote; note?: string } | { trouble: Trouble }> {
    const body = quoteBody(trip, chosen, code);
    const result = await createQuote(body, quoteKey.current.for(JSON.stringify(body)));
    if (result.kind === "ok") {
      quoteKey.current.done();
      return { quote: result.value };
    }
    const found = quoteTrouble(result, trip, fit);
    const onlyPromo =
      found.promo && !found.party && !found.addOns && !found.stale && !found.stop && !found.notice;
    if (code && fallback && onlyPromo) {
      const again = await price(trip, fit, chosen, null, false);
      if ("quote" in again) {
        return { quote: again.quote, note: `${code} can't be used anymore, so it was removed.` };
      }
      return again;
    }
    return { trouble: found };
  }

  /** Show a quote trouble where it belongs. */
  function showQuoteTrouble(found: Trouble, where: "party" | "details") {
    if (found.stop) {
      setStage({ kind: "stopped", stop: found.stop });
      focusStep();
      return;
    }
    setTrouble(found);
    if (found.party || found.addOns || found.stale) {
      if (where === "details") {
        setStage({ kind: "party" });
        setQuote(null);
        focusStep();
      } else if (found.party) {
        focusTarget.current = partyFieldRef.current;
      }
      if (found.party) void refreshListing();
    }
  }

  async function refreshListing() {
    if (!ready) return;
    const listing = await getListing(ready.offer);
    if (listing.kind === "ok") {
      setLoad((current) =>
        current.kind === "ready" ? { ...current, listing: listing.value } : current,
      );
    }
  }

  const continueFromParty = exclusive(async () => {
    if (!ready || !selection || !limits) return;
    const problem = partyProblem(ready.offer, selection, limits);
    if (problem) {
      setTrouble({ party: problem });
      focusTarget.current = partyFieldRef.current;
      return;
    }
    setTrouble(null);
    setPartyNotice(null);
    setBusy("quote");
    const priced = await price(ready.offer, limits, selection, code, true);
    setBusy(null);
    if ("trouble" in priced) {
      showQuoteTrouble(priced.trouble, "party");
      return;
    }
    adopt(priced.quote);
    if (priced.note) setTrouble({ promo: priced.note });
    setStage({ kind: "details" });
    focusStep();
  });

  async function restoreDetails(trip: TripOffer, fit: PartyLimits, chosen: Selection) {
    setStage({ kind: "details" });
    setBusy("restore");
    let storedCode: string | null = null;
    if (address.quoteId) {
      const stored = await getQuote(address.quoteId);
      if (stored.kind === "ok" && stored.value.tripId === trip.tripId) {
        if (Date.parse(stored.value.expiresAt) > Date.now()) {
          adopt(stored.value);
          setBusy(null);
          return;
        }
        storedCode = stored.value.promotion?.code ?? null;
      }
    }
    const priced = await price(trip, fit, chosen, storedCode, true);
    setBusy(null);
    if ("trouble" in priced) {
      showQuoteTrouble(priced.trouble, "details");
      return;
    }
    adopt(priced.quote);
    if (priced.note) setTrouble({ promo: priced.note });
  }

  const changePromo = exclusive(async (entered: string | null) => {
    if (!ready || !selection || !limits) return;
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
    if (!ready || !selection || !limits) return;
    setTrouble(null);
    setBusy("refresh");
    const priced = await price(ready.offer, limits, selection, code, true);
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
          next.name = booker.name.trim()
            ? "Use letters and spaces only, up to 120 characters."
            : "Enter the name of the person booking.";
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
    const fingerprint = JSON.stringify([forQuote.quoteId, forQuote.policy.version, who]);
    const { key, secret } = checkoutAttempt.current.for(fingerprint);
    const body = {
      quoteId: forQuote.quoteId,
      acceptedPolicyVersion: forQuote.policy.version,
      booker: who,
      checkoutSecret: secret,
    };
    let result = await openCheckout(body, key);
    for (const delay of timing.providerRetryDelaysMs) {
      if (!isProviderUnavailable(result)) break;
      await wait(delay);
      result = await openCheckout(body, key);
    }
    if (result.kind === "ok") {
      checkoutAttempt.current.done();
      setInDoubt(false);
      const { session, payment } = result.value;
      const opened: Live = {
        sessionId: session.id,
        quoteId: forQuote.quoteId,
        secret,
        expiresAt: session.expiresAt,
        session,
        payment,
      };
      setLive(opened);
      if (session.state !== "open" || !payment) {
        // No longer payable: show what the checkout's own state says.
        const current = await readCheckout(session.id, secret);
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
        setStage({ kind: "details" });
        return null;
      }
      saveResume({
        tripId: ready.offer.tripId,
        sessionId: session.id,
        quoteId: forQuote.quoteId,
        secret,
        paymentSent: false,
        expiresAt: session.expiresAt,
      });
      setStage({ kind: "pay" });
      focusStep();
      return session;
    }
    if (outcomeUnknown(result) || isProviderUnavailable(result)) {
      setInDoubt(true);
      setStage({ kind: "details" });
      return null;
    }
    checkoutAttempt.current.done();
    const found = checkoutTrouble(result, brand.name);
    if (result.kind === "refused" && result.code === "idempotency_key_reused") {
      setTrouble(found);
      setStage({ kind: "details" });
      return null;
    }
    if (found.stop) {
      setStage({ kind: "stopped", stop: found.stop });
      focusStep();
      return null;
    }
    if (found.party) {
      setTrouble({ party: found.party });
      setQuote(null);
      setStage({ kind: "party" });
      focusStep();
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
      if ("trouble" in priced) {
        showQuoteTrouble(priced.trouble, "details");
        return null;
      }
      adopt(priced.quote);
      setStage({ kind: "details" });
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
    setStage({ kind: "details" });
    return null;
  }

  const startCheckout = exclusive(async () => {
    if (!quote) return;
    if (Date.now() >= Date.parse(quote.expiresAt)) {
      await repriceNow();
      return;
    }
    const who = checkDetails(quote);
    if (!who) return;
    setTrouble(null);
    setBusy("checkout");
    await open(quote, who);
    setBusy(null);
  });

  const pay = exclusive(async (outcome: TestPaymentOutcome) => {
    if (!live?.payment || !ready) return;
    setTrouble(null);
    setBusy(outcome);
    const result = await settleTestPayment(live.payment, outcome);
    setBusy(null);
    if (result.kind === "ok") {
      // Sent. A reload from here waits for the outcome instead of offering to pay.
      saveResume({
        tripId: ready.offer.tripId,
        sessionId: live.sessionId,
        quoteId: live.quoteId,
        secret: live.secret,
        paymentSent: true,
        expiresAt: live.expiresAt,
      });
      setStage({ kind: "waiting" });
      focusStep();
      return;
    }
    // The provider did not say. The checkout's own state may: read it once.
    const current = await readCheckout(live.sessionId, live.secret);
    if (current.kind === "ok" && isFinal(current.value)) {
      finish(current.value);
      return;
    }
    setTrouble({ notice: payNotice(result) });
  });

  const cancel = exclusive(async () => {
    if (!live) return;
    setTrouble(null);
    setBusy("cancel");
    const result = await cancelCheckout(live.sessionId, live.secret);
    setBusy(null);
    if (result.kind === "ok" || (result.kind === "refused" && [401, 404].includes(result.status))) {
      clearResume();
      setLive(null);
      toParty(
        <Notice tone="success" title="Checkout canceled">
          <p>Nothing was charged, and your seats were released. Change anything, then continue.</p>
        </Notice>,
      );
      return;
    }
    if (result.kind === "refused" && result.code === "checkout_not_cancelable") {
      // It ended first, perhaps paid: show how.
      const current = await readCheckout(live.sessionId, live.secret);
      if (current.kind === "ok") {
        finish(current.value);
        return;
      }
    }
    setTrouble({
      notice:
        result.kind === "refused" && result.status === 429
          ? { title: "Too many tries in a short time", body: "Wait a minute, then try again." }
          : {
              title: "We couldn't cancel the checkout",
              body: "Check your connection, then try again. If you leave it, the seats are released when the hold runs out.",
            },
    });
  });

  function toParty(notice: ReactNode = null) {
    setQuote(null);
    setTrouble(null);
    setPriceChange(null);
    setPartyNotice(notice);
    setStage({ kind: "party" });
    focusStep();
  }

  const retryAfterDecline = exclusive(async () => {
    if (!ready || !selection || !limits) return;
    const before = live?.session?.amount ?? null;
    setTrouble(null);
    setBusy("retry");
    const priced = await price(ready.offer, limits, selection, code, true);
    if ("trouble" in priced) {
      setBusy(null);
      showQuoteTrouble(priced.trouble, "details");
      if (!priced.trouble.stop && !priced.trouble.party) {
        setStage({ kind: "details" });
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
      setStage({ kind: "details" });
      focusStep();
      return;
    }
    const opened = await open(priced.quote, who.data);
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
    if (load.kind === "ready") toParty();
    else navigate(restartHref(address));
  };

  const releaseAndStartOver = exclusive(async () => {
    if (!live) {
      startOver();
      return;
    }
    setReleaseTrouble(null);
    setBusy("release");
    const result = await cancelCheckout(live.sessionId, live.secret);
    setBusy(null);
    if (result.kind === "ok" || (result.kind === "refused" && [401, 404].includes(result.status))) {
      startOver();
      return;
    }
    if (result.kind === "refused" && result.code === "checkout_not_cancelable") {
      const current = await readCheckout(live.sessionId, live.secret);
      if (current.kind === "ok") {
        finish(current.value);
        return;
      }
    }
    setReleaseTrouble("Check your connection, then try again.");
  });

  async function restoreCheckout() {
    const record = readResume(tripId);
    if (!record) {
      setStage({ kind: "gone" });
      return;
    }
    const restored: Live = {
      sessionId: record.sessionId,
      quoteId: record.quoteId,
      secret: record.secret,
      expiresAt: record.expiresAt,
      session: null,
      payment: null,
    };
    setLive(restored);
    const result = await readCheckout(record.sessionId, record.secret);
    if (result.kind === "ok") {
      setLive({ ...restored, session: result.value, expiresAt: result.value.expiresAt });
      if (isFinal(result.value)) {
        clearResume();
        setStage({ kind: "outcome", session: result.value });
        return;
      }
      setStage({ kind: record.paymentSent ? "waiting" : "interrupted" });
      return;
    }
    if (result.kind === "refused" && (result.status === 401 || result.status === 404)) {
      clearResume();
      setLive(null);
      setStage({ kind: "gone" });
      return;
    }
    // No answer yet: keep waiting for a payment that was sent; otherwise offer to start over.
    setStage({ kind: record.paymentSent ? "waiting" : "interrupted" });
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

  const listing = load.kind === "ready" ? load.listing : null;
  const trip = load.kind === "ready" ? contextOfOffer(load.offer) : contextOfQuote(load.quote);
  const stepIndex = stage.kind === "party" ? 0 : stage.kind === "details" ? 1 : 2;
  const showSteps =
    stage.kind === "party" ||
    stage.kind === "details" ||
    stage.kind === "pay" ||
    stage.kind === "waiting";

  return (
    <>
      {announcer}
      <TripHeader context={trip} listing={listing} titleRef={titleRef} />
      <div className="guest-container booking-layout">
        <aside className="booking-layout__facts" aria-label="Trip details">
          <TripFacts context={trip} listing={listing} />
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
                setSelection(next);
                if (trouble?.party || trouble?.addOns) setTrouble(null);
              }}
              trouble={trouble}
              notice={partyNotice}
              busy={busy === "quote"}
              now={now}
              onContinue={() => void continueFromParty()}
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
                setInDoubt(false);
                checkoutAttempt.current.done();
                toParty();
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
              onCancel={() => void cancel()}
              headingRef={stepRef}
            />
          )}
          {stage.kind === "waiting" && live && (
            <Waiting
              expiresAt={live.expiresAt}
              timeZone={trip.trip.timeZone}
              slow={slow}
              unreachable={unreachable}
              headingRef={stepRef}
            />
          )}
          {stage.kind === "outcome" && (
            <OutcomeFor
              session={stage.session}
              context={trip}
              listing={listing}
              quote={quote}
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
              }}
              onStartOver={startOver}
              headingRef={stepRef}
            />
          )}
          {stage.kind === "interrupted" && (
            <Interrupted
              charter={trip.charter}
              busy={busy === "release"}
              trouble={releaseTrouble}
              onStartOver={() => void releaseAndStartOver()}
              headingRef={stepRef}
            />
          )}
          {stage.kind === "gone" && <Gone onStartOver={startOver} headingRef={stepRef} />}
          {stage.kind === "stopped" && (
            <Stopped stop={stage.stop} brand={brand} headingRef={stepRef} />
          )}
        </div>
      </div>
    </>
  );
}

function OutcomeFor({
  session,
  context,
  listing,
  quote,
  brand,
  busy,
  onRetry,
  onChangeParty,
  onStartOver,
  headingRef,
}: {
  session: CheckoutSession;
  context: TripContext;
  listing: AvailableTrip | null;
  quote: Quote | null;
  brand: PublicBrand;
  busy: boolean;
  onRetry: () => void;
  onChangeParty: () => void;
  onStartOver: () => void;
  headingRef: Ref<HTMLHeadingElement>;
}) {
  switch (session.state) {
    case "confirmed":
      return (
        <Confirmed
          session={session}
          context={context}
          listing={listing}
          quote={quote}
          brand={brand}
          headingRef={headingRef}
        />
      );
    case "failed":
      return (
        <Declined
          charter={context.charter}
          busy={busy}
          onRetry={onRetry}
          onChangeParty={onChangeParty}
          headingRef={headingRef}
        />
      );
    case "expired":
      return (
        <Expired charter={context.charter} onStartOver={onStartOver} headingRef={headingRef} />
      );
    case "unfulfilled":
      return <Unfulfilled session={session} brand={brand} headingRef={headingRef} />;
    case "canceled":
      return (
        <Canceled charter={context.charter} onStartOver={onStartOver} headingRef={headingRef} />
      );
    case "open":
      // Not an outcome; never shown.
      return null;
  }
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
  return {
    title: "We couldn't reach the payment service",
    body: "Nothing has changed yet. Check your connection, then choose again.",
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
