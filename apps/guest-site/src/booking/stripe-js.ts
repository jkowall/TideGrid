/**
 * Stripe.js for the guest's card form (G2.11, W1-STRIPE-ELEMENT). No npm
 * dependency: Stripe.js loads from js.stripe.com, as Stripe requires, through
 * one script element, the only Stripe code the page fetches. The page's CSP
 * admits that origin (public/_headers). Tests never load it: the card form
 * takes a loader, and unit tests and the browser tests pass a double.
 *
 * Only the members the card form uses are typed here, so a double stays small.
 */

/** Stripe.js's own entry, versioned by path. Never self-hosted, never bundled. */
export const STRIPE_JS_URL = "https://js.stripe.com/v3/";
/** A script that has not loaded by then is treated as unavailable. */
export const stripeJsTimeoutMs = 20_000;

/** An error Stripe.js returns. Its message is never shown: the page has its own copy. */
export interface StripeErrorLike {
  type: string;
  code?: string;
  decline_code?: string;
}

export interface ConfirmResultLike {
  error?: StripeErrorLike;
  paymentIntent?: { status: string };
}

export interface PaymentElementLike {
  mount(target: HTMLElement): void;
  on(event: "ready" | "loaderror", handler: () => void): void;
  focus(): void;
  destroy(): void;
}

export interface ElementsLike {
  create(type: "payment", options: Record<string, unknown>): PaymentElementLike;
  submit(): Promise<{ error?: StripeErrorLike }>;
}

export interface StripeLike {
  elements(options: { clientSecret: string; appearance: Record<string, unknown> }): ElementsLike;
  confirmPayment(options: {
    elements: ElementsLike;
    redirect: "if_required";
  }): Promise<ConfirmResultLike>;
}

/** `window.Stripe`: the publishable key and, for a direct charge, the connected account. */
export type StripeFactory = (
  publishableKey: string,
  options: { stripeAccount: string },
) => StripeLike;

/** Gives the card form Stripe.js. Injectable, so no test loads the real one. */
export type StripeLoader = () => Promise<StripeFactory>;

let pending: Promise<StripeFactory> | null = null;

const loaded = (): StripeFactory | undefined => (globalThis as { Stripe?: StripeFactory }).Stripe;

/**
 * Load Stripe.js once per page. A failed or slow load is forgotten, so Try
 * again adds a fresh script; the failed element is removed.
 */
export const loadStripeJs: StripeLoader = () => {
  const ready = loaded();
  if (ready) return Promise.resolve(ready);
  if (pending) return pending;
  const attempt = new Promise<StripeFactory>((resolve, reject) => {
    const script = document.createElement("script");
    let timer: ReturnType<typeof setTimeout> | undefined;
    const fail = () => {
      if (timer !== undefined) clearTimeout(timer);
      script.remove();
      if (pending === attempt) pending = null;
      reject(new Error("stripe_js_unavailable"));
    };
    script.src = STRIPE_JS_URL;
    script.async = true;
    script.addEventListener("load", () => {
      if (timer !== undefined) clearTimeout(timer);
      const factory = loaded();
      if (!factory) {
        fail();
        return;
      }
      // Loaded: later calls read window.Stripe.
      if (pending === attempt) pending = null;
      resolve(factory);
    });
    script.addEventListener("error", fail);
    timer = setTimeout(fail, stripeJsTimeoutMs);
    document.head.append(script);
  });
  pending = attempt;
  return attempt;
};

/**
 * What a confirmation came to, for the page. `sent`: Stripe has the payment,
 * or may (it succeeded, is processing, or was already confirmed); only the
 * checkout's own state, from a verified webhook, says it is booked.
 * `declined`: nothing was charged and the card form stays for another try.
 * `invalid`: the card form shows what to fix. `unknown`: no answer, so the
 * payment may have gone through.
 */
export type CardOutcome =
  | { kind: "sent" }
  | { kind: "declined"; reason: DeclineReason }
  | { kind: "invalid" }
  | { kind: "unknown" };

export type DeclineReason = "declined" | "expired" | "cvc" | "processing" | "authentication";

/** Read Stripe's answer by its codes, never by its message text. */
export function cardOutcome(result: ConfirmResultLike): CardOutcome {
  const error = result.error;
  if (!error) {
    const status = result.paymentIntent?.status;
    // A card that still needs a method was not charged; anything else may have been.
    if (status === "requires_payment_method") return { kind: "declined", reason: "declined" };
    return { kind: "sent" };
  }
  if (error.type === "validation_error") return { kind: "invalid" };
  // Confirmed already, perhaps by an earlier press whose answer was lost.
  if (error.code === "payment_intent_unexpected_state") return { kind: "sent" };
  if (error.code === "payment_intent_authentication_failure") {
    return { kind: "declined", reason: "authentication" };
  }
  if (error.type === "card_error") {
    switch (error.code) {
      case "expired_card":
        return { kind: "declined", reason: "expired" };
      case "incorrect_cvc":
        return { kind: "declined", reason: "cvc" };
      case "processing_error":
        return { kind: "declined", reason: "processing" };
      case "authentication_required":
        return { kind: "declined", reason: "authentication" };
      default:
        return { kind: "declined", reason: "declined" };
    }
  }
  return { kind: "unknown" };
}

/**
 * The card form's look from the page's own brand slots, read from <html>,
 * where applyBrandTheme sets them. Stripe draws the form in its own frame,
 * so only these values cross; the system font stands in for the brand's.
 */
export function cardAppearance(root: Element = document.documentElement): Record<string, unknown> {
  const style = getComputedStyle(root);
  const slot = (name: string, fallback: string) => style.getPropertyValue(name).trim() || fallback;
  return {
    theme: "stripe",
    variables: {
      colorPrimary: slot("--brand-primary", "#143f2e"),
      colorText: slot("--brand-ink", "#0e2b1f"),
      colorDanger: slot("--tg-status-blocked", "#b42318"),
      fontFamily: 'system-ui, -apple-system, "Segoe UI", sans-serif',
      fontSizeBase: "16px",
      borderRadius: "6px",
      spacingUnit: "4px",
    },
    // 16 px text on 12 px padding and a 1 px border: fields at least 44 px tall.
    rules: {
      ".Input": { padding: "12px" },
      ".Tab": { padding: "12px" },
    },
  };
}
