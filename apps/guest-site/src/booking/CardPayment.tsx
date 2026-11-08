import { Button, Notice, Skeleton } from "@tidegrid/design-system/components";
import { formatMoney } from "@tidegrid/design-system/format";
import { useEffect, useRef, useState } from "react";
import { type Failure, readCheckoutPayment } from "./api.ts";
import {
  type CardOutcome,
  cardAppearance,
  cardOutcome,
  type DeclineReason,
  type ElementsLike,
  type PaymentElementLike,
  type StripeLike,
  type StripeLoader,
} from "./stripe-js.ts";

type Phase =
  /** Reading what to pay with, loading Stripe.js, and drawing the form. */
  | { kind: "loading" }
  | { kind: "ready" }
  | { kind: "paying" }
  /** Stripe declined the card: nothing was charged, and the form stays. */
  | { kind: "declined"; reason: DeclineReason }
  /** No answer from Stripe: the payment may have gone through. */
  | { kind: "unknown" }
  /** The form failed before anything was sent. */
  | { kind: "error" }
  /** The form could not be shown. */
  | { kind: "unavailable"; reason: "not_configured" | "offline" | "load" };

const declineCopy: Record<DeclineReason, { title: string; body: string }> = {
  declined: {
    title: "Your card was declined",
    body: "Nothing was charged. Try another card, or contact the bank that issued it.",
  },
  expired: {
    title: "Your card has expired",
    body: "Nothing was charged. Try another card.",
  },
  cvc: {
    title: "The security code didn't match",
    body: "Nothing was charged. Check the 3 or 4 digit code on your card, then pay again.",
  },
  processing: {
    title: "Your card couldn't be processed",
    body: "Nothing was charged. Wait a moment, then pay again.",
  },
  authentication: {
    title: "Your bank didn't confirm the payment",
    body: "Nothing was charged. Pay again to repeat your bank's check, or try another card.",
  },
};

const unavailableCopy = {
  not_configured: {
    title: "Card payments aren't available right now",
    body: "The card form isn't set up here yet. Try again later, or cancel the checkout to release what it holds.",
  },
  offline: {
    title: "We couldn't reach the payment service",
    body: "Check your connection, then try again.",
  },
  load: {
    title: "The card form couldn't load",
    body: "Check your connection, then try again. If it keeps failing, a browser extension may be blocking the card form.",
  },
} as const;

function unavailableFor(failure: Failure): Phase {
  return failure.kind === "refused" && failure.code === "payments_unavailable"
    ? { kind: "unavailable", reason: "not_configured" }
    : { kind: "unavailable", reason: "offline" };
}

/**
 * The card-only Payment Element under the Stripe provider (G2.11,
 * W1-STRIPE-ELEMENT). It reads what to pay with through the checkout's Bearer
 * payment read (the client secret, the publishable key, and the connected
 * account), loads Stripe.js through the injected loader, and mounts the form.
 * Pay asks Stripe to confirm the card; the page then waits for the
 * checkout's own state, which only a verified webhook confirms. Nothing here
 * says a booking is paid. The client secret and the key stay in memory.
 */
export function CardPayment({
  sessionId,
  secret,
  amount,
  loader,
  blocked,
  onPay,
  onEnded,
}: {
  sessionId: string;
  secret: string;
  amount: number;
  loader: StripeLoader;
  /** Another command is working, such as Cancel checkout: Pay waits. */
  blocked: boolean;
  /** Runs the confirmation under the page's one-command lock; null when the page was busy. */
  onPay: (confirm: () => Promise<CardOutcome>) => Promise<CardOutcome | null>;
  /** The checkout is not open, or not this guest's: the page reads and shows what it is. */
  onEnded: () => void;
}) {
  const [phase, setPhase] = useState<Phase>({ kind: "loading" });
  const [attempt, setAttempt] = useState(0);
  const mountRef = useRef<HTMLDivElement | null>(null);
  const formRef = useRef<{ stripe: StripeLike; elements: ElementsLike } | null>(null);
  const elementRef = useRef<PaymentElementLike | null>(null);
  const alive = useRef(true);
  const payingRef = useRef(false);
  // The latest callbacks, so a new render does not reload the form.
  const ended = useRef(onEnded);
  ended.current = onEnded;
  const load = useRef(loader);
  load.current = loader;

  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    let cancelled = false;
    let element: PaymentElementLike | null = null;
    setPhase({ kind: "loading" });
    const run = async () => {
      const read = await readCheckoutPayment(sessionId, secret, controller.signal);
      if (cancelled) return;
      if (read.kind === "refused" && (read.status === 401 || read.status === 404)) {
        setPhase({ kind: "unavailable", reason: "offline" });
        ended.current();
        return;
      }
      if (read.kind !== "ok") {
        setPhase(unavailableFor(read));
        return;
      }
      const { payment } = read.value;
      if (!payment) {
        setPhase({ kind: "unavailable", reason: "offline" });
        ended.current();
        return;
      }
      if (payment.provider !== "stripe" || !payment.stripe) {
        setPhase({ kind: "unavailable", reason: "not_configured" });
        return;
      }
      let factory: Awaited<ReturnType<StripeLoader>>;
      try {
        factory = await load.current();
      } catch {
        if (!cancelled) setPhase({ kind: "unavailable", reason: "load" });
        return;
      }
      if (cancelled || !mountRef.current) return;
      try {
        const stripe = factory(payment.stripe.publishableKey, {
          stripeAccount: payment.stripe.account,
        });
        const elements = stripe.elements({
          clientSecret: payment.clientSecret,
          appearance: cardAppearance(),
        });
        // Card only: the intent allows nothing else, and wallets stay off.
        element = elements.create("payment", {
          layout: "tabs",
          wallets: { applePay: "never", googlePay: "never" },
        });
        element.on("ready", () => {
          if (!cancelled) setPhase({ kind: "ready" });
        });
        element.on("loaderror", () => {
          if (!cancelled) setPhase({ kind: "unavailable", reason: "load" });
        });
        element.mount(mountRef.current);
        elementRef.current = element;
        formRef.current = { stripe, elements };
      } catch {
        setPhase({ kind: "unavailable", reason: "load" });
      }
    };
    void run();
    return () => {
      cancelled = true;
      controller.abort();
      formRef.current = null;
      elementRef.current = null;
      try {
        element?.destroy();
      } catch {
        // Already gone with its frame.
      }
    };
  }, [sessionId, secret, attempt]);

  const pay = async () => {
    const form = formRef.current;
    if (!form || payingRef.current) return;
    payingRef.current = true;
    try {
      await payWith(form);
    } finally {
      payingRef.current = false;
    }
  };

  const payWith = async (form: { stripe: StripeLike; elements: ElementsLike }) => {
    setPhase({ kind: "paying" });
    // Checks the fields in the form; nothing is sent to be charged.
    let checked: { error?: { type: string } };
    try {
      checked = await form.elements.submit();
    } catch {
      checked = { error: { type: "api_error" } };
    }
    if (!alive.current) return;
    if (checked.error) {
      setPhase(checked.error.type === "validation_error" ? { kind: "ready" } : { kind: "error" });
      if (checked.error.type === "validation_error") elementRef.current?.focus();
      return;
    }
    const outcome = await onPay(async () => {
      try {
        return cardOutcome(
          await form.stripe.confirmPayment({ elements: form.elements, redirect: "if_required" }),
        );
      } catch {
        return { kind: "unknown" };
      }
    });
    if (!alive.current) return;
    switch (outcome?.kind) {
      case undefined:
      case "invalid":
        setPhase({ kind: "ready" });
        if (outcome) elementRef.current?.focus();
        return;
      case "declined":
        setPhase({ kind: "declined", reason: outcome.reason });
        return;
      case "unknown":
        setPhase({ kind: "unknown" });
        return;
      case "sent":
        // The page moves on to wait for the checkout's own state.
        return;
    }
  };

  const loading = phase.kind === "loading";
  const unavailable = phase.kind === "unavailable" ? phase : null;
  const payable = ["ready", "declined", "unknown", "error", "paying"].includes(phase.kind);
  const paying = phase.kind === "paying";
  const notice =
    phase.kind === "declined"
      ? declineCopy[phase.reason]
      : phase.kind === "unknown"
        ? {
            title: "We couldn't confirm your payment",
            body: "The connection dropped before the payment service answered, so it may have gone through. Press Pay again: a payment that went through stands, and nothing is paid twice.",
          }
        : phase.kind === "error"
          ? {
              title: "The card form ran into a problem",
              body: "Nothing was charged. Press Pay again.",
            }
          : null;

  return (
    <div className="booking-card" aria-busy={loading}>
      {loading && (
        <div className="booking-card__loading">
          <p className="booking-card__status" role="status">
            Loading the secure card form…
          </p>
          <Skeleton height="3rem" />
          <Skeleton height="3rem" />
        </div>
      )}
      {unavailable && (
        <Notice
          tone="error"
          title={unavailableCopy[unavailable.reason].title}
          actions={
            <Button icon="refresh" onClick={() => setAttempt((n) => n + 1)}>
              Try again
            </Button>
          }
        >
          <p>{unavailableCopy[unavailable.reason].body}</p>
        </Notice>
      )}
      {/* Stripe draws the card form inside this element, in its own frame. */}
      <div
        className="booking-card__form"
        ref={mountRef}
        hidden={unavailable !== null}
        data-testid="card-form"
      />
      {notice && (
        <Notice tone="error" title={notice.title}>
          <p>{notice.body}</p>
        </Notice>
      )}
      {payable && (
        <div className="booking-pay__actions">
          <Button
            variant="primary"
            icon="lock"
            busy={paying}
            busyLabel="Paying…"
            disabled={blocked && !paying}
            onClick={() => void pay()}
          >
            Pay {formatMoney(amount)}
          </Button>
        </div>
      )}
    </div>
  );
}
