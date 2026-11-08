// @vitest-environment jsdom

// The Stripe card form on the payment step (W1-STRIPE-ELEMENT), against the
// fake API in fixtures.ts and a double of Stripe.js given through the page's
// loader. Nothing here loads Stripe.js or reaches Stripe.
process.env.TZ = "Asia/Tokyo";

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NavigationProvider } from "../navigation.tsx";
import { BookingPage } from "./BookingPage.tsx";
import {
  brand,
  type Call,
  callsTo,
  checkout,
  held,
  inOrder,
  json,
  nextSessionId,
  offline,
  refusal,
  stubApi,
  testNow,
  tripId,
} from "./fixtures.ts";
import { timing } from "./model.ts";
import {
  type ConfirmResultLike,
  cardOutcome,
  loadStripeJs,
  STRIPE_JS_URL,
  type StripeFactory,
  type StripeLoader,
  stripeJsTimeoutMs,
} from "./stripe-js.ts";

// Synthetic, built at run time: never a real key or account.
const publishableKey = `pk_test_${"U".repeat(30)}`;
const account = "acct_1TestHarbor0000";
const paymentRef = "pi_UNIT0000000000000001";
const clientSecret = `${paymentRef}_secret_${"c".repeat(24)}`;

const original = { ...timing };

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(testNow);
  Object.assign(timing, {
    pollDelaysMs: [5],
    clockTickMs: 20,
    providerRetryDelaysMs: [5, 5, 5],
    slowAfterMs: 50,
    expiryGraceMs: 5,
    lateSuccessGraceMs: 0,
  });
  window.sessionStorage.clear();
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  Object.assign(timing, original);
});

/** Opening under Stripe: the client secret, but never the key or the account. */
const openUnderStripe = (call: Call) => {
  const body = call.body as { quoteId: string };
  return json(
    {
      checkoutSession: checkout("open", { id: nextSessionId(), quoteId: body.quoteId }),
      payment: { provider: "stripe", paymentRef, clientSecret },
    },
    201,
  );
};

/** The Bearer read under Stripe: the client secret with the key and the account. */
const readUnderStripe = () =>
  json({
    checkoutSession: checkout("open"),
    payment: { provider: "stripe", paymentRef, clientSecret, stripe: { publishableKey, account } },
  });

interface DoubleOptions {
  /** What each confirmation answers, in order; the last repeats. */
  confirm?: (() => Promise<ConfirmResultLike>)[];
  /** What each check of the fields answers, in order; the last repeats. */
  submit?: (() => Promise<{ error?: { type: string } }>)[];
  /** The form fails to load inside Stripe's frame. */
  loadError?: boolean;
  /** The loader rejects these many times first, as a blocked script would. */
  loaderFailures?: number;
}

/** A double of Stripe.js, given through the page's loader. */
function stripeDouble(options: DoubleOptions = {}) {
  const seen = {
    factory: [] as [string, { stripeAccount: string }][],
    elements: [] as { clientSecret: string; appearance: Record<string, unknown> }[],
    created: [] as Record<string, unknown>[],
    confirms: 0,
    submits: 0,
    destroyed: 0,
  };
  let failures = options.loaderFailures ?? 0;
  const answers = options.confirm ?? [async () => ({ paymentIntent: { status: "succeeded" } })];
  const checks = options.submit ?? [async () => ({})];
  const factory: StripeFactory = (key, opts) => {
    seen.factory.push([key, opts]);
    return {
      elements: (elementsOptions) => {
        seen.elements.push(elementsOptions);
        return {
          create: (_type, createOptions) => {
            seen.created.push(createOptions);
            const handlers: Record<string, () => void> = {};
            return {
              mount: (target) => {
                const field = document.createElement("input");
                field.setAttribute("aria-label", "Card number");
                target.append(field);
                setTimeout(() => handlers[options.loadError ? "loaderror" : "ready"]?.(), 0);
              },
              on: (event, handler) => {
                handlers[event] = handler;
              },
              focus: () => {},
              destroy: () => {
                seen.destroyed += 1;
              },
            };
          },
          submit: async () => {
            const check = checks[Math.min(seen.submits, checks.length - 1)];
            seen.submits += 1;
            return check ? check() : {};
          },
        };
      },
      confirmPayment: async () => {
        const answer = answers[Math.min(seen.confirms, answers.length - 1)];
        seen.confirms += 1;
        if (!answer) throw new Error("no answer");
        return answer();
      },
    };
  };
  const loader = vi.fn<StripeLoader>(async () => {
    if (failures > 0) {
      failures -= 1;
      throw new Error("stripe_js_unavailable");
    }
    return factory;
  });
  return { loader, seen };
}

function renderPage(loader: StripeLoader) {
  window.history.replaceState(null, "", `/book/${tripId}`);
  render(
    <NavigationProvider navigate={vi.fn()}>
      <BookingPage brand={brand} tripId={tripId} focusOnArrival={false} stripeLoader={loader} />
    </NavigationProvider>,
  );
}

const heading = (name: string | RegExp) => screen.findByRole("heading", { name });

async function toPayment() {
  fireEvent.click(await screen.findByRole("button", { name: "Continue" }));
  await heading("Your details");
  fireEvent.change(screen.getByRole("textbox", { name: "Full name" }), {
    target: { value: "Ava Guest" },
  });
  fireEvent.change(screen.getByRole("textbox", { name: "Email" }), {
    target: { value: "ava@example.test" },
  });
  fireEvent.click(screen.getByRole("checkbox", { name: "I accept this cancellation policy" }));
  fireEvent.click(screen.getByRole("button", { name: "Continue to payment" }));
  await heading("Payment");
}

const payButton = () => screen.findByRole("button", { name: "Pay $160.51" });

const secretOf = (calls: Call[]) =>
  (callsTo(calls, "openCheckout")[0]?.body as { checkoutSecret?: string } | undefined)
    ?.checkoutSecret ?? "";

describe("the card form under Stripe", () => {
  it("mounts a card-only Payment Element from the Bearer read, and waits for the checkout to confirm", async () => {
    const calls = stubApi({
      openCheckout: openUnderStripe,
      readPayment: readUnderStripe,
      readCheckout: inOrder(
        () => json({ checkoutSession: checkout("open") }),
        () => json({ checkoutSession: checkout("confirmed") }),
      ),
    });
    const { loader, seen } = stripeDouble();
    renderPage(loader);
    await toPayment();
    expect(screen.getByText("This is a test payment")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Simulate successful payment" })).toBeNull();
    // Loading, then the form.
    expect(await screen.findByText("Loading the secure card form…")).toBeTruthy();
    fireEvent.click(await payButton());

    // The key and the account came only from the Bearer read.
    const [read] = callsTo(calls, "readPayment");
    expect(read?.headers.get("authorization")).toBe(`Bearer ${secretOf(calls)}`);
    expect(seen.factory).toEqual([[publishableKey, { stripeAccount: account }]]);
    expect(seen.elements[0]?.clientSecret).toBe(clientSecret);
    expect(seen.created[0]).toMatchObject({
      wallets: { applePay: "never", googlePay: "never" },
    });

    // Sent: the page waits for the checkout's own state, then confirms.
    expect(await heading("Confirming your payment")).toBeTruthy();
    expect(await screen.findByText("You're booked", {}, { timeout: 3000 })).toBeTruthy();
    expect(seen.submits).toBe(1);
    expect(seen.confirms).toBe(1);
    expect(seen.destroyed).toBe(1);

    // No secret, key, or account in an address or in storage.
    for (const url of [...calls.map((c) => c.url), window.location.href]) {
      for (const secret of [clientSecret, publishableKey, account, secretOf(calls)]) {
        expect(url).not.toContain(secret);
      }
    }
    const stored = JSON.stringify({ ...window.sessionStorage });
    for (const secret of [clientSecret, publishableKey, account]) {
      expect(stored).not.toContain(secret);
    }
  });

  it("never shows a booking while the checkout is still open after Stripe answers", async () => {
    stubApi({ openCheckout: openUnderStripe, readPayment: readUnderStripe });
    const { loader } = stripeDouble();
    renderPage(loader);
    await toPayment();
    fireEvent.click(await payButton());
    expect(await heading("Confirming your payment")).toBeTruthy();
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(screen.queryByText("You're booked")).toBeNull();
    expect(screen.getByRole("heading", { name: "Confirming your payment" })).toBeTruthy();
  });

  it("shows a decline on the payment step, charges nothing, and lets the guest pay again", async () => {
    const calls = stubApi({ openCheckout: openUnderStripe, readPayment: readUnderStripe });
    const { loader, seen } = stripeDouble({
      confirm: [
        async () => ({ error: { type: "card_error", code: "card_declined" } }),
        async () => ({ paymentIntent: { status: "succeeded" } }),
      ],
    });
    renderPage(loader);
    await toPayment();
    fireEvent.click(await payButton());
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("Your card was declined");
    expect(alert.textContent).toContain("Nothing was charged.");
    expect(screen.getByRole("heading", { name: "Payment" })).toBeTruthy();
    // The checkout stays open: no cancel, and nothing read as final.
    expect(callsTo(calls, "cancel")).toHaveLength(0);
    fireEvent.click(await payButton());
    expect(await heading("Confirming your payment")).toBeTruthy();
    expect(seen.confirms).toBe(2);
  });

  const declined = [async () => ({ error: { type: "card_error", code: "card_declined" } })];

  it("after a decline, a link away still asks before it leaves the open checkout", async () => {
    stubApi({ openCheckout: openUnderStripe, readPayment: readUnderStripe });
    const { loader } = stripeDouble({ confirm: declined });
    renderPage(loader);
    await toPayment();
    fireEvent.click(await payButton());
    await screen.findByRole("alert");
    fireEvent.click(screen.getByRole("link", { name: "All trips" }));
    expect(await screen.findByRole("dialog", { name: "Leave this checkout?" })).toBeTruthy();
  });

  it("after a decline, releases the open checkout when the page goes", async () => {
    const calls = stubApi({ openCheckout: openUnderStripe, readPayment: readUnderStripe });
    const { loader } = stripeDouble({ confirm: declined });
    renderPage(loader);
    await toPayment();
    fireEvent.click(await payButton());
    await screen.findByRole("alert");
    cleanup();
    const [cancel] = callsTo(calls, "cancel");
    expect(cancel?.keepalive).toBe(true);
    expect(window.sessionStorage.getItem("tidegrid.checkout")).toBeNull();
  });

  it("after a decline, stores the checkout as untried, so a reload offers to pay", async () => {
    stubApi({ openCheckout: openUnderStripe, readPayment: readUnderStripe });
    const { loader } = stripeDouble({ confirm: declined });
    renderPage(loader);
    await toPayment();
    fireEvent.click(await payButton());
    await screen.findByRole("alert");
    const stored = JSON.parse(window.sessionStorage.getItem("tidegrid.checkout") ?? "{}");
    expect(stored.paymentTried).toBe(false);
    expect(stored.paymentSent).toBe(false);
  });

  it("keeps a payment that may have gone through as tried when the page goes", async () => {
    const calls = stubApi({ openCheckout: openUnderStripe, readPayment: readUnderStripe });
    const { loader } = stripeDouble({
      confirm: [() => Promise.reject(new TypeError("Failed to fetch"))],
    });
    renderPage(loader);
    await toPayment();
    fireEvent.click(await payButton());
    await screen.findByRole("alert");
    cleanup();
    expect(callsTo(calls, "cancel")).toHaveLength(0);
    expect(window.sessionStorage.getItem("tidegrid.checkout")).not.toBeNull();
  });

  for (const [code, title] of [
    ["expired_card", "Your card has expired"],
    ["incorrect_cvc", "The security code didn't match"],
    ["processing_error", "Your card couldn't be processed"],
    ["authentication_required", "Your bank didn't confirm the payment"],
  ] as const) {
    it(`names ${code} in the page's own words`, async () => {
      stubApi({ openCheckout: openUnderStripe, readPayment: readUnderStripe });
      const { loader } = stripeDouble({
        confirm: [async () => ({ error: { type: "card_error", code } })],
      });
      renderPage(loader);
      await toPayment();
      fireEvent.click(await payButton());
      expect((await screen.findByRole("alert")).textContent).toContain(title);
    });
  }

  it("says a payment may have gone through when Stripe does not answer, and reads the checkout once", async () => {
    const calls = stubApi({ openCheckout: openUnderStripe, readPayment: readUnderStripe });
    const { loader } = stripeDouble({
      confirm: [() => Promise.reject(new TypeError("Failed to fetch"))],
    });
    renderPage(loader);
    await toPayment();
    const before = callsTo(calls, "readCheckout").length;
    fireEvent.click(await payButton());
    expect((await screen.findByRole("alert")).textContent).toContain(
      "We couldn't confirm your payment",
    );
    await waitFor(() => expect(callsTo(calls, "readCheckout").length).toBe(before + 1));
    // From here a reload waits for the outcome rather than offering to pay.
    expect(screen.getByRole("button", { name: "Pay $160.51" })).toBeTruthy();
  });

  it("moves on to wait when Stripe says the payment was already confirmed", async () => {
    stubApi({ openCheckout: openUnderStripe, readPayment: readUnderStripe });
    const { loader } = stripeDouble({
      confirm: [
        async () => ({
          error: { type: "invalid_request_error", code: "payment_intent_unexpected_state" },
        }),
      ],
    });
    renderPage(loader);
    await toPayment();
    fireEvent.click(await payButton());
    expect(await heading("Confirming your payment")).toBeTruthy();
  });

  it("offers Try again when Stripe.js does not load, and loads it again", async () => {
    stubApi({ openCheckout: openUnderStripe, readPayment: readUnderStripe });
    const { loader } = stripeDouble({ loaderFailures: 1 });
    renderPage(loader);
    await toPayment();
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("The card form couldn't load");
    expect(screen.queryByRole("button", { name: /^Pay / })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(await payButton()).toBeTruthy();
    expect(loader).toHaveBeenCalledTimes(2);
  });

  it("treats a form that fails inside Stripe's frame as not loaded", async () => {
    stubApi({ openCheckout: openUnderStripe, readPayment: readUnderStripe });
    const { loader } = stripeDouble({ loadError: true });
    renderPage(loader);
    await toPayment();
    expect((await screen.findByRole("alert")).textContent).toContain("The card form couldn't load");
  });

  it("says card payments are not available when the API has no publishable key", async () => {
    stubApi({
      openCheckout: openUnderStripe,
      readPayment: () => refusal(503, "payments_unavailable"),
    });
    const { loader } = stripeDouble();
    renderPage(loader);
    await toPayment();
    expect((await screen.findByRole("alert")).textContent).toContain(
      "Card payments aren't available right now",
    );
    expect(loader).not.toHaveBeenCalled();
    // The guest can still release the hold.
    expect(screen.getByRole("button", { name: "Cancel checkout" })).toBeTruthy();
  });

  it("says when the payment service cannot be reached, and reads again on Try again", async () => {
    const calls = stubApi({
      openCheckout: openUnderStripe,
      readPayment: inOrder(offline, readUnderStripe),
    });
    const { loader } = stripeDouble();
    renderPage(loader);
    await toPayment();
    expect((await screen.findByRole("alert")).textContent).toContain(
      "We couldn't reach the payment service",
    );
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(await payButton()).toBeTruthy();
    expect(callsTo(calls, "readPayment")).toHaveLength(2);
  });

  it("shows the checkout's own state when the read finds it no longer open", async () => {
    stubApi({
      openCheckout: openUnderStripe,
      readPayment: () => json({ checkoutSession: checkout("expired"), payment: null }),
      readCheckout: () => json({ checkoutSession: checkout("expired") }),
    });
    const { loader } = stripeDouble();
    renderPage(loader);
    await toPayment();
    expect(await screen.findByText("Your checkout expired")).toBeTruthy();
    expect(loader).not.toHaveBeenCalled();
  });

  it("holds Cancel checkout and Back while a card payment is confirming", async () => {
    stubApi({ openCheckout: openUnderStripe, readPayment: readUnderStripe });
    let answer: (result: ConfirmResultLike) => void = () => {};
    const { loader } = stripeDouble({
      confirm: [
        () =>
          new Promise<ConfirmResultLike>((resolve) => {
            answer = resolve;
          }),
      ],
    });
    renderPage(loader);
    await toPayment();
    fireEvent.click(await payButton());
    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: "Cancel checkout" }).getAttribute("aria-disabled"),
      ).toBe("true"),
    );
    // Back stays on the payment and says why.
    window.history.back();
    await waitFor(() =>
      expect(document.querySelector("p.tg-visually-hidden[role='status']")?.textContent).toBe(
        "Wait a moment: the page is still working.",
      ),
    );
    expect(screen.getByRole("heading", { name: "Payment" })).toBeTruthy();
    answer({ paymentIntent: { status: "processing" } });
    expect(await heading("Confirming your payment")).toBeTruthy();
  });

  /** A check of the fields that answers when the test says. */
  const deferredCheck = () => {
    let answer: (result: { error?: { type: string } }) => void = () => {};
    const check = () =>
      new Promise<{ error?: { type: string } }>((resolve) => {
        answer = resolve;
      });
    return { check, answer: (result: { error?: { type: string } }) => answer(result) };
  };
  const status = () => document.querySelector("p.tg-visually-hidden[role='status']")?.textContent;
  const stored = () => JSON.parse(window.sessionStorage.getItem("tidegrid.checkout") ?? "{}");

  it("holds Cancel checkout and Back while the card form checks its fields, then confirms", async () => {
    stubApi({ openCheckout: openUnderStripe, readPayment: readUnderStripe });
    const pending = deferredCheck();
    const { loader, seen } = stripeDouble({
      submit: [pending.check],
      confirm: [async () => ({ paymentIntent: { status: "processing" } })],
    });
    renderPage(loader);
    await toPayment();
    fireEvent.click(await payButton());
    await waitFor(() => expect(seen.submits).toBe(1));
    // The page's lock is held from the check of the fields on.
    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: "Cancel checkout" }).getAttribute("aria-disabled"),
      ).toBe("true"),
    );
    fireEvent.click(screen.getByRole("button", { name: "Cancel checkout" }));
    window.history.back();
    await waitFor(() => expect(status()).toBe("Wait a moment: the page is still working."));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(seen.confirms).toBe(0);
    pending.answer({});
    expect(await heading("Confirming your payment")).toBeTruthy();
    expect(seen.confirms).toBe(1);
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("asks nothing of a link away while the card form checks its fields", async () => {
    stubApi({ openCheckout: openUnderStripe, readPayment: readUnderStripe });
    const pending = deferredCheck();
    const { loader, seen } = stripeDouble({
      submit: [pending.check],
      confirm: [async () => ({ paymentIntent: { status: "processing" } })],
    });
    renderPage(loader);
    await toPayment();
    fireEvent.click(await payButton());
    await waitFor(() => expect(seen.submits).toBe(1));
    fireEvent.click(screen.getByRole("link", { name: "All trips" }));
    await waitFor(() => expect(status()).toBe("Wait a moment: the page is still working."));
    expect(screen.queryByRole("dialog")).toBeNull();
    pending.answer({});
    expect(await heading("Confirming your payment")).toBeTruthy();
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("leaves the checkout untried and Cancel checkout free when the fields do not pass", async () => {
    const calls = stubApi({ openCheckout: openUnderStripe, readPayment: readUnderStripe });
    const pending = deferredCheck();
    const { loader, seen } = stripeDouble({ submit: [pending.check] });
    renderPage(loader);
    await toPayment();
    fireEvent.click(await payButton());
    await waitFor(() => expect(seen.submits).toBe(1));
    // Nothing is sent while the fields are checked: the checkout stays untried.
    expect(stored().paymentTried).toBe(false);
    pending.answer({ error: { type: "validation_error" } });
    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: "Cancel checkout" }).getAttribute("aria-disabled"),
      ).toBeNull(),
    );
    expect(seen.confirms).toBe(0);
    expect(stored()).toMatchObject({ paymentTried: false, paymentSent: false });
    expect(callsTo(calls, "cancel")).toHaveLength(0);
    fireEvent.click(screen.getByRole("button", { name: "Cancel checkout" }));
    expect(await screen.findByRole("dialog", { name: "Cancel this checkout?" })).toBeTruthy();
  });

  for (const [label, failure] of [
    ["the form fails", { error: { type: "api_error" } }],
    ["a field does not pass", { error: { type: "validation_error" } }],
  ] as const) {
    it(`keeps the warning that a payment may have gone through when ${label} on a later try`, async () => {
      stubApi({ openCheckout: openUnderStripe, readPayment: readUnderStripe });
      const { loader, seen } = stripeDouble({
        submit: [async () => ({}), async () => failure],
        confirm: [() => Promise.reject(new TypeError("Failed to fetch"))],
      });
      renderPage(loader);
      await toPayment();
      fireEvent.click(await payButton());
      expect((await screen.findByRole("alert")).textContent).toContain(
        "We couldn't confirm your payment",
      );
      fireEvent.click(await payButton());
      await waitFor(() => expect(seen.submits).toBe(2));
      await payButton();
      const alert = await screen.findByRole("alert");
      expect(alert.textContent).toContain("We couldn't confirm your payment");
      expect(alert.textContent).toContain("it may have gone through");
      expect(document.body.textContent).not.toContain("Nothing was charged");
      expect(seen.confirms).toBe(1);
      // Still tried: a page that goes keeps the checkout, as a sent payment needs.
      expect(stored().paymentTried).toBe(true);
    });
  }

  it("never lets a late read for an earlier checkout end the one that replaced it", async () => {
    // The first checkout runs out soon; the second keeps the default hold.
    const ids: string[] = [];
    const first = () => ids[0] ?? "none";
    let firstReads = 0;
    const late = held();
    const calls = stubApi({
      openCheckout: (call) => {
        const body = call.body as { quoteId: string };
        const id = nextSessionId();
        ids.push(id);
        const fields =
          ids.length === 1 ? { expiresAt: new Date(Date.now() + 100).toISOString() } : {};
        return json(
          {
            checkoutSession: checkout("open", { id, quoteId: body.quoteId, ...fields }),
            payment: { provider: "stripe", paymentRef, clientSecret },
          },
          201,
        );
      },
      // The first checkout's payment read finds it closed; the second's is open.
      readPayment: (call) =>
        call.path.includes(first())
          ? json({ checkoutSession: checkout("failed", { id: first() }), payment: null })
          : readUnderStripe(),
      readCheckout: (call) => {
        if (!call.path.includes(first())) {
          return json({ checkoutSession: checkout("open", { id: ids[1] ?? "none" }) });
        }
        // The first read of the first checkout, after its payment read, waits.
        firstReads += 1;
        return firstReads === 1
          ? late.answer(call)
          : json({ checkoutSession: checkout("failed", { id: first() }) });
      },
    });
    const { loader } = stripeDouble();
    renderPage(loader);
    await toPayment();
    // The expiry check ends the first checkout while that read waits.
    expect(await heading("Your payment was declined")).toBeTruthy();
    expect(firstReads).toBe(2);
    // The guest starts again, and reaches the second checkout's payment.
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(await heading("Payment")).toBeTruthy();
    expect(await payButton()).toBeTruthy();
    expect(callsTo(calls, "openCheckout")).toHaveLength(2);
    expect(stored().sessionId).toBe(ids[1]);
    // The late answer for the first checkout arrives now.
    late.release(json({ checkoutSession: checkout("failed", { id: first() }) }));
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(screen.getByRole("heading", { name: "Payment" })).toBeTruthy();
    expect(screen.queryByText("Your payment was declined")).toBeNull();
    expect(stored().sessionId).toBe(ids[1]);
  });

  it("keeps the fake provider's test controls, and never loads Stripe.js", async () => {
    stubApi();
    const { loader } = stripeDouble();
    renderPage(loader);
    await toPayment();
    expect(screen.getByText("This is a demo test payment")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Simulate successful payment" })).toBeTruthy();
    expect(screen.queryByText("Loading the secure card form…")).toBeNull();
    expect(loader).not.toHaveBeenCalled();
  });

  it("waits on the read before the form, with a live status", async () => {
    const read = held();
    stubApi({ openCheckout: openUnderStripe, readPayment: read.answer });
    const { loader } = stripeDouble();
    renderPage(loader);
    await toPayment();
    const status = await screen.findByText("Loading the secure card form…");
    expect(status.getAttribute("role")).toBe("status");
    expect(loader).not.toHaveBeenCalled();
    read.release(readUnderStripe());
    expect(await payButton()).toBeTruthy();
  });
});

describe("Stripe's answer, by code", () => {
  it("reads a success, a processing payment, and a card still needing a method", () => {
    expect(cardOutcome({ paymentIntent: { status: "succeeded" } })).toEqual({ kind: "sent" });
    expect(cardOutcome({ paymentIntent: { status: "processing" } })).toEqual({ kind: "sent" });
    expect(cardOutcome({})).toEqual({ kind: "sent" });
    expect(cardOutcome({ paymentIntent: { status: "requires_payment_method" } })).toEqual({
      kind: "declined",
      reason: "declined",
    });
  });

  it("never reads a decline from Stripe's message", () => {
    expect(
      cardOutcome({ error: { type: "card_error", code: "card_declined", decline_code: "x" } }),
    ).toEqual({ kind: "declined", reason: "declined" });
    expect(cardOutcome({ error: { type: "validation_error" } })).toEqual({ kind: "invalid" });
    expect(cardOutcome({ error: { type: "api_connection_error" } })).toEqual({ kind: "unknown" });
    expect(cardOutcome({ error: { type: "rate_limit_error" } })).toEqual({ kind: "unknown" });
  });
});

describe("the Stripe.js loader", () => {
  afterEach(() => {
    for (const script of document.querySelectorAll("script")) script.remove();
    delete (globalThis as { Stripe?: unknown }).Stripe;
  });

  it("adds one script from js.stripe.com, and nothing else", async () => {
    const first = loadStripeJs();
    const again = loadStripeJs();
    expect(again).toBe(first);
    const scripts = [...document.querySelectorAll("script")];
    expect(scripts.map((s) => s.src)).toEqual([STRIPE_JS_URL]);
    expect(new URL(STRIPE_JS_URL).origin).toBe("https://js.stripe.com");
    const factory = vi.fn();
    (globalThis as { Stripe?: unknown }).Stripe = factory;
    scripts[0]?.dispatchEvent(new Event("load"));
    expect(await first).toBe(factory);
    // Loaded: no second script.
    expect(await loadStripeJs()).toBe(factory);
    expect(document.querySelectorAll("script")).toHaveLength(1);
  });

  it("forgets a failed load, so Try again adds a fresh script", async () => {
    const first = loadStripeJs();
    document.querySelector("script")?.dispatchEvent(new Event("error"));
    await expect(first).rejects.toThrow("stripe_js_unavailable");
    expect(document.querySelectorAll("script")).toHaveLength(0);
    const second = loadStripeJs();
    expect(second).not.toBe(first);
    expect(document.querySelectorAll("script")).toHaveLength(1);
    document.querySelector("script")?.dispatchEvent(new Event("error"));
    await expect(second).rejects.toThrow();
  });

  it("gives up on a script that never loads", async () => {
    vi.useFakeTimers();
    const pending = loadStripeJs();
    vi.advanceTimersByTime(stripeJsTimeoutMs);
    await expect(pending).rejects.toThrow("stripe_js_unavailable");
    expect(document.querySelectorAll("script")).toHaveLength(0);
  });
});
