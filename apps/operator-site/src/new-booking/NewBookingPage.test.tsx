// @vitest-environment jsdom

// Staff in Tokyo booking a New York trip: times must stay the marina's.
process.env.TZ = "Asia/Tokyo";

import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { StaffRole } from "@tidegrid/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  api,
  apiError,
  callsTo,
  deferred,
  dropped,
  json,
  membership,
  sentTo,
  strayRequests,
  tenantName,
  text,
  tripIds,
} from "../bookings/fixtures.ts";
import { NavigationProvider } from "../navigation.tsx";
import {
  bookedId,
  caller,
  charterOffer,
  checkoutId,
  confirmed,
  newRoute,
  paid,
  quoteFor,
  quoteId,
  sharedOffer,
  staffCheckout,
} from "./fixtures.ts";
import { NewBookingPage } from "./NewBookingPage.tsx";

function renderPage(role: StaffRole = "booking_staff", tripId: string = tripIds.sunset) {
  const navigate = vi.fn();
  const view = render(
    <NavigationProvider navigate={navigate}>
      <NewBookingPage membership={membership(role)} tripId={tripId} focusHeading={false} />
    </NavigationProvider>,
  );
  return { navigate, ...view };
}

/** Let React commit and run its passive effects before the next click (CI-only focus races). */
const settle = () => act(() => new Promise<void>((resolve) => setTimeout(resolve, 0)));

const stepHeading = (name: string | RegExp) => screen.findByRole("heading", { level: 2, name });
const click = async (name: string | RegExp) => {
  await settle();
  fireEvent.click(screen.getByRole("button", { name }));
};
const offerAnswer =
  (offer = sharedOffer()) =>
  () =>
    json({ offer });
const quoteAnswer = () => json({ quote: quoteFor() }, 201);
const openAnswer = () => json({ checkout: staffCheckout(), paymentReady: true }, 201);

/**
 * The staff quotes route as the API keeps it: a request with a key it has
 * seen replays that key's first answer; each new key gets the next quote id.
 */
function quotesByKey(ids: string[]) {
  const answered = new Map<string, string>();
  return () => {
    const key = sentTo(newRoute.quote).at(-1)?.headers.get("idempotency-key") ?? "";
    const id = answered.get(key) ?? ids[answered.size] ?? quoteId;
    answered.set(key, id);
    return json({ quote: quoteFor({ quoteId: id }) }, 201);
  };
}

async function toGuest() {
  await stepHeading("Who is coming");
  await click("Add one Adult");
  await click("Add one Adult");
  await click("Price and continue");
  await stepHeading("The guest");
}

async function toReview() {
  await toGuest();
  fireEvent.change(screen.getByLabelText("Booker's name"), { target: { value: caller.name } });
  fireEvent.change(screen.getByLabelText("Booker's email"), {
    target: { value: ` ${caller.email.toUpperCase()} ` },
  });
  await click("Review");
  await stepHeading("Review with the guest");
}

async function attestBoth() {
  await settle();
  fireEvent.click(screen.getByLabelText("I read the email address back to the guest"));
  fireEvent.click(screen.getByLabelText("I told the guest the cancellation policy (version 3)"));
}

async function toPayment() {
  await toReview();
  await attestBoth();
  await click("Hold seats and take payment");
  await stepHeading("Payment");
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-11-04T17:00:00Z"));
  window.history.replaceState(null, "", `/trips/${tripIds.sunset}/book`);
});

afterEach(() => {
  const strays = strayRequests();
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  expect(strays).toEqual([]);
});

function expectNoBookerInAddresses() {
  const addresses = [
    window.location.href,
    ...[...document.querySelectorAll("a[href]")].map((a) => a.getAttribute("href") ?? ""),
  ].map((a) => decodeURIComponent(a).toLowerCase());
  for (const a of addresses) {
    expect(a).not.toContain("rosa");
    expect(a).not.toContain("telefono");
  }
  expect(document.title.toLowerCase()).not.toContain("rosa");
}

describe("who may book", () => {
  it("shows finance a refusal and makes no request", async () => {
    const calls = api({});
    renderPage("finance");
    expect(screen.getByRole("heading", { level: 1, name: "New booking" })).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Your role can't make bookings" })).toBeTruthy();
    expect(screen.getByRole("link", { name: "Go to calendar" }).getAttribute("href")).toBe(
      "/calendar",
    );
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(calls).toEqual([]);
  });

  it.each(["owner", "booking_staff"] as const)("lets %s book", async (role) => {
    api({ [newRoute.offer()]: offerAnswer() });
    renderPage(role);
    expect(await stepHeading("Who is coming")).toBeTruthy();
    expect(text(document.querySelector(".tg-eyebrow"))).toBe(tenantName);
  });
});

describe("the trip's offer", () => {
  it("names the trip on the marina's clock and counts tickets", async () => {
    api({ [newRoute.offer()]: offerAnswer() });
    renderPage();
    await stepHeading("Who is coming");
    expect(text(document.querySelector(".nb-trip"))).toBe(
      "Sunset Harbor CruiseThursday, November 5, 2026, 6:00 PM",
    );
    expect(screen.getByLabelText("Adult")).toBeTruthy();
    expect(screen.getByLabelText("Child 3 to 12")).toBeTruthy();
    expect(screen.getByLabelText("Souvenir photo")).toBeTruthy();
    expect(screen.getByRole("list", { name: "Booking steps" })).toBeTruthy();
  });

  it("explains a trip that is not on sale, with no way to book it", async () => {
    api({ [newRoute.offer()]: () => apiError(409, "trip_not_bookable") });
    renderPage();
    expect(
      await screen.findByRole("heading", { name: "This trip isn't on sale now" }),
    ).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Price and continue" })).toBeNull();
  });

  it("explains a trip that is not this operator's", async () => {
    api({ [newRoute.offer()]: () => apiError(404, "trip_not_found") });
    renderPage();
    expect(await screen.findByRole("heading", { name: "This trip isn't here" })).toBeTruthy();
  });

  it("offers Try again when the offer did not load, and loads on the second try", async () => {
    const calls = api({ [newRoute.offer()]: [() => apiError(503, "x"), offerAnswer()] });
    renderPage();
    const alert = await screen.findByRole("alert");
    expect(text(alert)).toContain("didn't load");
    await click("Try again");
    await stepHeading("Who is coming");
    expect(callsTo(calls, newRoute.offer())).toHaveLength(2);
  });

  it("asks a signed-out person to sign in again here", async () => {
    api({ [newRoute.offer()]: () => apiError(401, "unauthenticated") });
    renderPage();
    const link = await screen.findByRole("link", { name: "Sign in again" });
    expect(link.getAttribute("href")).toBe(`/trips/${tripIds.sunset}/book`);
  });

  it("prices a charter by its guests aboard", async () => {
    api({
      [newRoute.offer(tripIds.charter)]: offerAnswer(charterOffer()),
      [newRoute.quote]: quoteAnswer,
    });
    renderPage("owner", tripIds.charter);
    await stepHeading("Who is coming");
    expect((screen.getByLabelText("Guests aboard") as HTMLInputElement).value).toBe("2");
    await click("One guest more");
    await click("Price and continue");
    await stepHeading("The guest");
    expect(sentTo(newRoute.quote)[0]?.body).toEqual({
      tripId: tripIds.charter,
      party: { kind: "charter", guests: 3 },
      addOns: [],
    });
  });
});

describe("a staff booking from start to finish", () => {
  it("prices, checks the guest, reads back, holds, pays, and confirms only from the checkout's state", async () => {
    const calls = api({
      [newRoute.offer()]: offerAnswer(),
      [newRoute.quote]: quoteAnswer,
      [newRoute.open]: openAnswer,
      [newRoute.pay()]: () => json(paid()),
      [newRoute.read()]: [
        () => json({ checkout: staffCheckout() }),
        () => json({ checkout: confirmed() }),
      ],
    });
    renderPage();
    await stepHeading("Who is coming");

    // An empty party is not priced.
    await click("Price and continue");
    expect(text(screen.getByText("Add at least one guest."))).toBeTruthy();
    expect(callsTo(calls, newRoute.quote)).toHaveLength(0);

    await click("Add one Adult");
    await click("Add one Adult");
    await click("Price and continue");
    await stepHeading("The guest");
    const [quoteSent] = sentTo(newRoute.quote);
    expect(quoteSent?.body).toEqual({
      tripId: tripIds.sunset,
      party: { kind: "tickets", tickets: [{ code: "adult", quantity: 2 }] },
      addOns: [],
    });
    expect(quoteSent?.headers.get("idempotency-key")).toMatch(/^[0-9a-f-]{36}$/);

    // The address is checked before review, and focus goes to it.
    fireEvent.change(screen.getByLabelText("Booker's name"), { target: { value: caller.name } });
    fireEvent.change(screen.getByLabelText("Booker's email"), {
      target: { value: "rosa at home" },
    });
    await click("Review");
    const email = screen.getByLabelText("Booker's email");
    expect(email.getAttribute("aria-invalid")).toBe("true");
    expect(document.activeElement).toBe(email);
    expect(
      screen.getByText("The confirmation, management link, and waiver requests go here."),
    ).toBeTruthy();
    fireEvent.change(email, { target: { value: ` ${caller.email.toUpperCase()} ` } });
    fireEvent.change(screen.getByLabelText("How the guest reached you"), {
      target: { value: "walk_up" },
    });
    await click("Review");
    await stepHeading("Review with the guest");

    // The server's quote, the policy, and the address to read back, lowercase.
    const ledger = screen.getByRole("table", { name: "Price in US dollars" });
    expect(text(ledger)).toContain("Adult2 × $45.00$90.00");
    expect(text(ledger)).toContain("Total$96.30");
    expect(text(document.querySelector(".nb-policy"))).toBe(
      "Cancellation policy (version 3)Cancel up to 24 hours before departure for a full refund.",
    );
    expect(text(document.querySelector(".nb-readback__email"))).toBe(caller.email);

    // Payment is blocked until both attestations are checked.
    await click("Hold seats and take payment");
    expect(callsTo(calls, newRoute.open)).toHaveLength(0);
    expect(screen.getByText("Read the address back first.")).toBeTruthy();
    expect(screen.getByText("Tell the guest the policy first.")).toBeTruthy();
    expect(document.activeElement).toBe(
      screen.getByLabelText("I read the email address back to the guest"),
    );
    await attestBoth();
    await click("Hold seats and take payment");
    await stepHeading("Payment");
    expect(sentTo(newRoute.open)[0]?.body).toEqual({
      quoteId,
      acceptedPolicyVersion: 3,
      booker: { name: caller.name, email: caller.email },
      channel: "walk_up",
      attestations: { policyToldToGuest: true, emailReadBack: true },
    });

    // A demo payment, the amount, and the hold's end on the marina's clock.
    expect(screen.getByText("This is a demo test payment")).toBeTruthy();
    expect(text(document.querySelector(".nb-facts"))).toContain("$96.30");
    expect(text(document.querySelector(".nb-facts"))).toContain("12:15");
    await click("Take test payment");
    expect(sentTo(newRoute.pay())[0]?.body).toEqual({ outcome: "succeed" });

    // Booked only once the checkout reads confirmed: the first read is still open.
    expect(await stepHeading("Waiting for the payment's result")).toBeTruthy();
    expect(
      await screen.findByRole("heading", { level: 2, name: "Booked" }, { timeout: 4000 }),
    ).toBeTruthy();
    const open = await screen.findByRole("link", { name: "Open the booking" });
    expect(open.getAttribute("href")).toBe(`/bookings/${bookedId}`);
    expect(text(document.querySelector(".tg-notice--success, .tg-notice"))).toContain("QKG6ERBF");
    expect(callsTo(calls, newRoute.read()).length).toBeGreaterThanOrEqual(2);
    expectNoBookerInAddresses();
  });

  it("keeps the key for the same request and makes a new one when the request changes", async () => {
    api({
      [newRoute.offer()]: offerAnswer(),
      [newRoute.quote]: [() => apiError(503, "unavailable"), quoteAnswer],
    });
    renderPage();
    await stepHeading("Who is coming");
    await click("Add one Adult");
    await click("Price and continue");
    await screen.findByRole("alert");
    await click("Try again");
    await stepHeading("The guest");
    const [first, second] = sentTo(newRoute.quote);
    expect(second?.headers.get("idempotency-key")).toBe(first?.headers.get("idempotency-key"));
  });
});

describe("after the checkout is asked for", () => {
  it("retries a provider timeout with the same request, and frozen inputs", async () => {
    api({
      [newRoute.offer()]: offerAnswer(),
      [newRoute.quote]: quoteAnswer,
      [newRoute.open]: [() => apiError(503, "payment_provider_unavailable"), openAnswer],
    });
    renderPage();
    await toReview();
    await attestBoth();
    await click("Hold seats and take payment");
    const alert = await screen.findByRole("alert");
    expect(text(alert)).toContain("The payment provider didn't answer");
    expect(
      (screen.getByLabelText("I read the email address back to the guest") as HTMLInputElement)
        .disabled,
    ).toBe(true);
    await click("Try again");
    await stepHeading("Payment");
    const [first, second] = sentTo(newRoute.open);
    expect(second?.headers.get("idempotency-key")).toBe(first?.headers.get("idempotency-key"));
    expect(second?.body).toEqual(first?.body);
  });

  it("cancels the held checkout before an edit after a timeout, then opens a new one with a new key", async () => {
    api({
      [newRoute.offer()]: offerAnswer(),
      [newRoute.quote]: [quoteAnswer, quoteAnswer],
      [newRoute.open]: [
        () => apiError(503, "payment_provider_unavailable"),
        // The same request again, to learn the held checkout.
        openAnswer,
        () =>
          json(
            {
              checkout: staffCheckout({ id: "4b2d6c70-9a1e-4f3b-8c5d-2e7f9a0b1c32" }),
              paymentReady: true,
            },
            201,
          ),
      ],
      [newRoute.cancel()]: () => json({ checkout: staffCheckout({ state: "canceled" }) }),
    });
    renderPage();
    await toReview();
    await attestBoth();
    await click("Hold seats and take payment");
    await screen.findByRole("alert");
    await click("Change details");
    await stepHeading("Who is coming");
    const opens = sentTo(newRoute.open);
    expect(opens).toHaveLength(2);
    expect(opens[1]?.headers.get("idempotency-key")).toBe(opens[0]?.headers.get("idempotency-key"));
    expect(sentTo(newRoute.cancel())).toHaveLength(1);
    // Fresh inputs: price the same party again (a new quote, so a new key), review, attest, and open.
    await click("Price and continue");
    await stepHeading("The guest");
    const quotes = sentTo(newRoute.quote);
    expect(quotes[1]?.body).toEqual(quotes[0]?.body);
    expect(quotes[1]?.headers.get("idempotency-key")).not.toBe(
      quotes[0]?.headers.get("idempotency-key"),
    );
    await click("Review");
    await stepHeading("Review with the guest");
    expect(
      (screen.getByLabelText("I read the email address back to the guest") as HTMLInputElement)
        .checked,
    ).toBe(false);
    await attestBoth();
    await click("Hold seats and take payment");
    await stepHeading("Payment");
    const all = sentTo(newRoute.open);
    expect(all).toHaveLength(3);
    expect(all[2]?.headers.get("idempotency-key")).not.toBe(all[0]?.headers.get("idempotency-key"));
  });

  it("disables Cancel booking while a test payment is in flight", async () => {
    const payment = deferred();
    api({
      [newRoute.offer()]: offerAnswer(),
      [newRoute.quote]: quoteAnswer,
      [newRoute.open]: openAnswer,
      [newRoute.pay()]: payment.answer,
      [newRoute.read()]: () => json({ checkout: confirmed() }),
    });
    renderPage();
    await toPayment();
    await click("Take test payment");
    await settle();
    const cancel = screen.getByRole("button", { name: "Cancel booking" });
    expect(cancel.getAttribute("aria-disabled")).toBe("true");
    fireEvent.click(cancel);
    expect(screen.queryByRole("dialog")).toBeNull();
    payment.release(json(paid()));
    await stepHeading("Booked");
  });

  it("cancels the booking after a danger confirmation", async () => {
    api({
      [newRoute.offer()]: offerAnswer(),
      [newRoute.quote]: quoteAnswer,
      [newRoute.open]: openAnswer,
      [newRoute.cancel()]: () => json({ checkout: staffCheckout({ state: "canceled" }) }),
    });
    renderPage();
    await toPayment();
    await click("Cancel booking");
    const dialog = await screen.findByRole("dialog", { name: "Cancel this booking?" });
    await settle();
    fireEvent.click(within(dialog).getByRole("button", { name: "Cancel booking" }));
    expect(await stepHeading("Booking canceled")).toBeTruthy();
    expect(sentTo(newRoute.cancel())).toHaveLength(1);
  });

  it("retries a lost delivery with the same key", async () => {
    api({
      [newRoute.offer()]: offerAnswer(),
      [newRoute.quote]: quoteAnswer,
      [newRoute.open]: openAnswer,
      [newRoute.pay()]: [
        () => json(paid({ delivery: { status: 500, outcome: null, duplicate: null } })),
        () => json(paid({ alreadySettled: true })),
      ],
      [newRoute.read()]: () => json({ checkout: confirmed() }),
    });
    renderPage();
    await toPayment();
    await click("Take test payment");
    const alert = await screen.findByRole("alert");
    expect(text(alert)).toContain("The payment's result didn't reach TideGrid");
    await click("Try again");
    await stepHeading("Booked");
    const [first, second] = sentTo(newRoute.pay());
    expect(second?.headers.get("idempotency-key")).toBe(first?.headers.get("idempotency-key"));
  });
});

describe("outcomes", () => {
  it("says a declined test payment booked nothing", async () => {
    api({
      [newRoute.offer()]: offerAnswer(),
      [newRoute.quote]: quoteAnswer,
      [newRoute.open]: openAnswer,
      [newRoute.pay()]: () =>
        json(
          paid({
            outcome: "fail",
            delivery: { status: 200, outcome: "released", duplicate: false },
          }),
        ),
      [newRoute.read()]: () =>
        json({ checkout: staffCheckout({ state: "failed", paymentState: "failed" }) }),
    });
    renderPage();
    await toPayment();
    await click("Decline");
    expect(await stepHeading("The test payment was declined")).toBeTruthy();
    expect(screen.getByText("Nothing was booked")).toBeTruthy();
  });

  it("says a payment that came after the hold is refunded in full", async () => {
    api({
      [newRoute.offer()]: offerAnswer(),
      [newRoute.quote]: quoteAnswer,
      [newRoute.open]: openAnswer,
      [newRoute.pay()]: () => apiError(409, "checkout_not_open"),
      [newRoute.read()]: () =>
        json({
          checkout: staffCheckout({
            state: "unfulfilled",
            paymentState: "succeeded",
            refund: { state: "succeeded", amount: 9630 },
          }),
        }),
    });
    renderPage();
    await toPayment();
    await click("Take test payment");
    expect(await stepHeading("The payment came too late")).toBeTruthy();
    expect(
      screen.getByText(
        "The payment came through after the hold ended or the booking was canceled. It is refunded in full. Tell the guest.",
      ),
    ).toBeTruthy();
  });

  it("explains a refusal when the seats are gone, and lets the details change", async () => {
    api({
      [newRoute.offer()]: offerAnswer(),
      [newRoute.quote]: quoteAnswer,
      [newRoute.open]: () => apiError(409, "insufficient_capacity"),
    });
    renderPage();
    await toReview();
    await attestBoth();
    await click("Hold seats and take payment");
    const alert = await screen.findByRole("alert");
    expect(text(alert)).toContain("Not enough seats left");
    expect(
      (screen.getByLabelText("I read the email address back to the guest") as HTMLInputElement)
        .disabled,
    ).toBe(false);
  });

  it("explains the per-staff limit", async () => {
    api({
      [newRoute.offer()]: offerAnswer(),
      [newRoute.quote]: quoteAnswer,
      [newRoute.open]: () => apiError(429, "too_many_checkouts"),
    });
    renderPage();
    await toReview();
    await attestBoth();
    await click("Hold seats and take payment");
    expect(text(await screen.findByRole("alert"))).toContain(
      "You have three bookings waiting for payment",
    );
  });

  it("prices again when the quote expired before the hold", async () => {
    api({
      [newRoute.offer()]: offerAnswer(),
      [newRoute.quote]: [quoteAnswer, quoteAnswer],
      [newRoute.open]: [() => apiError(409, "quote_expired"), openAnswer],
    });
    renderPage();
    await toReview();
    await attestBoth();
    await click("Hold seats and take payment");
    await screen.findByRole("alert");
    await click("Price again");
    await waitFor(() => expect(sentTo(newRoute.quote)).toHaveLength(2));
    await stepHeading("Review with the guest");
    const [first, second] = sentTo(newRoute.quote);
    expect(second?.headers.get("idempotency-key")).not.toBe(first?.headers.get("idempotency-key"));
    void checkoutId;
  });
});

describe("review fixes (G2.12d review)", () => {
  const base = () => ({
    [newRoute.offer()]: offerAnswer(),
    [newRoute.quote]: quoteAnswer,
    [newRoute.open]: openAnswer,
  });

  it("UI-1: Try again after a failed cancel retries the cancel, never a payment", async () => {
    api({
      ...base(),
      [newRoute.cancel()]: [
        () => apiError(503, "unavailable"),
        () => json({ checkout: staffCheckout({ state: "canceled" }) }),
      ],
    });
    renderPage();
    await toPayment();
    await click("Cancel booking");
    const dialog = await screen.findByRole("dialog", { name: "Cancel this booking?" });
    await settle();
    fireEvent.click(within(dialog).getByRole("button", { name: "Cancel booking" }));
    const alert = await screen.findByRole("alert");
    expect(text(alert)).toContain("Try again");
    await click("Try again");
    expect(await stepHeading("Booking canceled")).toBeTruthy();
    expect(sentTo(newRoute.cancel())).toHaveLength(2);
    expect(sentTo(newRoute.pay())).toHaveLength(0);
  });

  it("UI-1: a cancel refused because the payment was decided shows where the booking stands, with no payment", async () => {
    api({
      ...base(),
      [newRoute.cancel()]: () => apiError(409, "checkout_not_cancelable"),
      [newRoute.read()]: () => json({ checkout: confirmed() }),
    });
    renderPage();
    await toPayment();
    await click("Cancel booking");
    const dialog = await screen.findByRole("dialog", { name: "Cancel this booking?" });
    await settle();
    fireEvent.click(within(dialog).getByRole("button", { name: "Cancel booking" }));
    expect(await stepHeading("Booked")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Try again" })).toBeNull();
    expect(sentTo(newRoute.pay())).toHaveLength(0);
  });

  it("UI-2: clears both attestations when the review is left and the address changes", async () => {
    api(base());
    renderPage();
    await toReview();
    await attestBoth();
    await click("Change details");
    await stepHeading("Who is coming");
    await click("Price and continue");
    await stepHeading("The guest");
    fireEvent.change(screen.getByLabelText("Booker's email"), {
      target: { value: "someone.else@guest.example" },
    });
    await click("Review");
    await stepHeading("Review with the guest");
    expect(text(document.querySelector(".nb-readback__email"))).toBe("someone.else@guest.example");
    for (const label of [
      "I read the email address back to the guest",
      "I told the guest the cancellation policy (version 3)",
    ]) {
      expect((screen.getByLabelText(label) as HTMLInputElement).checked).toBe(false);
    }
    await click("Hold seats and take payment");
    expect(sentTo(newRoute.open)).toHaveLength(0);
  });

  it("UI-2: a new quote after the old one expired clears the policy attestation", async () => {
    api({
      ...base(),
      [newRoute.quote]: [
        quoteAnswer,
        () => json({ quote: quoteFor({ quoteId: "6a1c3e50-7b2d-4f8e-9a6b-1c2d3e4f5a62" }) }, 201),
      ],
      [newRoute.open]: () => apiError(409, "quote_expired"),
    });
    renderPage();
    await toReview();
    await attestBoth();
    await click("Hold seats and take payment");
    await screen.findByRole("alert");
    const policy = screen.getByLabelText(
      "I told the guest the cancellation policy (version 3)",
    ) as HTMLInputElement;
    // Still checked for the old quote.
    expect(policy.checked).toBe(true);
    await click("Price again");
    await waitFor(() => expect(sentTo(newRoute.quote)).toHaveLength(2));
    await stepHeading("Review with the guest");
    // Only the new quote's answer clears it, and that answer can land a few
    // tasks after the request went out.
    await waitFor(() => expect(policy.checked).toBe(false));
  });

  it("UI-2: Hold waits while Price again is pricing, and sends no second checkout", async () => {
    const requoted = deferred();
    api({
      ...base(),
      [newRoute.quote]: [quoteAnswer, requoted.answer],
      [newRoute.open]: () => apiError(409, "quote_expired"),
    });
    renderPage();
    await toReview();
    await attestBoth();
    await click("Hold seats and take payment");
    await screen.findByRole("alert");
    await click("Price again");
    await waitFor(() => expect(sentTo(newRoute.quote)).toHaveLength(2));
    const hold = screen.getByRole("button", { name: "Hold seats and take payment" });
    expect(hold.getAttribute("aria-disabled")).toBe("true");
    fireEvent.click(hold);
    expect(sentTo(newRoute.open)).toHaveLength(1);

    requoted.release(
      json({ quote: quoteFor({ quoteId: "6a1c3e50-7b2d-4f8e-9a6b-1c2d3e4f5a62" }) }, 201),
    );
    await waitFor(() => expect(hold.getAttribute("aria-disabled")).toBeNull());
    expect(sentTo(newRoute.open)).toHaveLength(1);
  });

  it("Hold stays unavailable when Price again fails, and never resends the refused quote", async () => {
    api({
      ...base(),
      [newRoute.quote]: [quoteAnswer, () => apiError(500, "internal_error")],
      [newRoute.open]: () => apiError(409, "quote_expired"),
    });
    renderPage();
    await toReview();
    await attestBoth();
    await click("Hold seats and take payment");
    await screen.findByText("The price needs refreshing");
    await click("Price again");
    await screen.findByText("The party couldn't be priced");
    await stepHeading("Review with the guest");
    await settle();
    const hold = screen.getByRole("button", { name: "Hold seats and take payment" });
    expect(hold.getAttribute("aria-disabled")).toBe("true");
    fireEvent.click(hold);
    await settle();
    expect(sentTo(newRoute.open)).toHaveLength(1);
    // The way forward stays on screen: price the same party again.
    expect(screen.getByRole("button", { name: "Try again" })).toBeTruthy();
  });

  it("Hold is unavailable from the refusal that needs a new quote until a new quote arrives", async () => {
    const requoted = deferred();
    api({
      ...base(),
      [newRoute.quote]: [quoteAnswer, requoted.answer],
      [newRoute.open]: () => apiError(409, "quote_expired"),
    });
    renderPage();
    await toReview();
    await attestBoth();
    await click("Hold seats and take payment");
    await screen.findByText("The price needs refreshing");
    await settle();
    const hold = screen.getByRole("button", { name: "Hold seats and take payment" });
    expect(hold.getAttribute("aria-disabled")).toBe("true");
    fireEvent.click(hold);
    await settle();
    expect(sentTo(newRoute.open)).toHaveLength(1);
    expect(screen.getByRole("button", { name: "Price again" })).toBeTruthy();

    await click("Price again");
    await waitFor(() => expect(sentTo(newRoute.quote)).toHaveLength(2));
    expect(hold.getAttribute("aria-disabled")).toBe("true");
    requoted.release(
      json({ quote: quoteFor({ quoteId: "6a1c3e50-7b2d-4f8e-9a6b-1c2d3e4f5a62" }) }, 201),
    );
    await waitFor(() => expect(hold.getAttribute("aria-disabled")).toBeNull());
    expect(sentTo(newRoute.open)).toHaveLength(1);
  });

  it("a successful Price again makes Hold available, and Hold sends the new quote", async () => {
    const fresh = "6a1c3e50-7b2d-4f8e-9a6b-1c2d3e4f5a62";
    api({
      ...base(),
      [newRoute.quote]: [quoteAnswer, () => json({ quote: quoteFor({ quoteId: fresh }) }, 201)],
      [newRoute.open]: [() => apiError(409, "quote_expired"), openAnswer],
    });
    renderPage();
    await toReview();
    await attestBoth();
    await click("Hold seats and take payment");
    await screen.findByText("The price needs refreshing");
    await click("Price again");
    const policy = screen.getByLabelText(
      "I told the guest the cancellation policy (version 3)",
    ) as HTMLInputElement;
    await waitFor(() => expect(policy.checked).toBe(false));
    const hold = screen.getByRole("button", { name: "Hold seats and take payment" });
    expect(hold.getAttribute("aria-disabled")).toBeNull();
    await attestBoth();
    await click("Hold seats and take payment");
    await stepHeading("Payment");
    const [first, second] = sentTo(newRoute.open);
    expect(first?.body).toMatchObject({ quoteId });
    expect(second?.body).toMatchObject({ quoteId: fresh });
  });

  it("Change details and the same party get a new quote, never the refused one", async () => {
    const fresh = "6a1c3e50-7b2d-4f8e-9a6b-1c2d3e4f5a62";
    api({
      ...base(),
      [newRoute.quote]: quotesByKey([quoteId, fresh]),
      [newRoute.open]: [() => apiError(409, "quote_expired"), openAnswer],
    });
    renderPage();
    await toReview();
    await attestBoth();
    await click("Hold seats and take payment");
    await screen.findByText("The price needs refreshing");
    await click("Change details");
    await stepHeading("Who is coming");
    await click("Price and continue");
    await stepHeading("The guest");
    await click("Review");
    await stepHeading("Review with the guest");
    await attestBoth();
    await click("Hold seats and take payment");
    await stepHeading("Payment");
    const keyOf = (c: { headers: Headers } | undefined) => c?.headers.get("idempotency-key");
    const [firstQuote, secondQuote] = sentTo(newRoute.quote);
    expect(keyOf(secondQuote)).not.toBe(keyOf(firstQuote));
    const opens = sentTo(newRoute.open);
    expect(opens.map((o) => (o.body as { quoteId: string }).quoteId)).toEqual([quoteId, fresh]);
    expect(keyOf(opens[1])).not.toBe(keyOf(opens[0]));
  });

  it("a quote that comes back with the refused id keeps Hold waiting, and says so", async () => {
    const fresh = "6a1c3e50-7b2d-4f8e-9a6b-1c2d3e4f5a62";
    api({
      ...base(),
      [newRoute.quote]: [
        quoteAnswer,
        quoteAnswer,
        () => json({ quote: quoteFor({ quoteId: fresh }) }, 201),
      ],
      [newRoute.open]: [() => apiError(409, "quote_expired"), openAnswer],
    });
    renderPage();
    await toReview();
    await attestBoth();
    await click("Hold seats and take payment");
    await screen.findByText("The price needs refreshing");
    await click("Price again");
    await waitFor(() => expect(sentTo(newRoute.quote)).toHaveLength(2));
    // The notice goes while pricing and comes back for the refused quote.
    await screen.findByRole("button", { name: "Price again" });
    expect(screen.getByText(/The quote is no longer valid/)).toBeTruthy();
    const hold = screen.getByRole("button", { name: "Hold seats and take payment" });
    expect(hold.getAttribute("aria-disabled")).toBe("true");
    fireEvent.click(hold);
    await settle();
    expect(sentTo(newRoute.open)).toHaveLength(1);

    await click("Price again");
    await waitFor(() => expect(hold.getAttribute("aria-disabled")).toBeNull());
    await attestBoth();
    await click("Hold seats and take payment");
    await stepHeading("Payment");
    const opens = sentTo(newRoute.open);
    expect(opens.map((o) => (o.body as { quoteId: string }).quoteId)).toEqual([quoteId, fresh]);
  });

  it("UI-2: a new quote's policy is never sent with the old quote's attestations", async () => {
    // The new quote has a new policy version. Hold is pressed in the same task
    // as the commit that shows it, before any passive effect of that commit runs.
    const newer = quoteFor({
      quoteId: "6a1c3e50-7b2d-4f8e-9a6b-1c2d3e4f5a62",
      policy: { ...quoteFor().policy, version: 4 },
    });
    api({
      ...base(),
      [newRoute.quote]: [quoteAnswer, () => json({ quote: newer }, 201)],
      [newRoute.open]: [() => apiError(409, "quote_expired"), openAnswer],
    });
    renderPage();
    await toReview();
    await attestBoth();
    await click("Hold seats and take payment");
    await screen.findByRole("alert");
    let pressed = false;
    const observer = new MutationObserver(() => {
      if (pressed || !document.body.textContent?.includes("(version 4)")) return;
      pressed = true;
      screen.getByRole("button", { name: "Hold seats and take payment" }).click();
    });
    observer.observe(document.body, { childList: true, subtree: true, characterData: true });
    await click("Price again");
    await waitFor(() => expect(pressed).toBe(true));
    observer.disconnect();
    await settle();
    expect(sentTo(newRoute.open)).toHaveLength(1);
    const policy = screen.getByLabelText(
      "I told the guest the cancellation policy (version 4)",
    ) as HTMLInputElement;
    expect(policy.checked).toBe(false);
    expect(screen.getByText("Read the address back first.")).toBeTruthy();
  });

  it("UI-10: an attestation's error goes once its box is checked", async () => {
    api(base());
    renderPage();
    await toReview();
    await click("Hold seats and take payment");
    expect(screen.getByText("Read the address back first.")).toBeTruthy();
    fireEvent.click(screen.getByLabelText("I read the email address back to the guest"));
    expect(screen.queryByText("Read the address back first.")).toBeNull();
    expect(screen.getByText("Tell the guest the policy first.")).toBeTruthy();
  });

  it("UI-3: after a settled payment whose result was lost, only Try again is offered", async () => {
    api({
      ...base(),
      [newRoute.pay()]: () =>
        json(paid({ delivery: { status: 502, outcome: null, duplicate: null } })),
    });
    renderPage();
    await toPayment();
    await click("Take test payment");
    await screen.findByRole("alert");
    await settle();
    for (const name of ["Take test payment", "Decline", "Cancel booking", "Change details"]) {
      expect(screen.getByRole("button", { name }).getAttribute("aria-disabled")).toBe("true");
    }
    fireEvent.click(screen.getByRole("button", { name: "Cancel booking" }));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(screen.getByRole("button", { name: "Try again" })).toBeTruthy();
  });

  it("UI-3 and UI-4: a cancel after an unanswered payment warns it may have gone through, and the outcome shows no stale error", async () => {
    api({
      ...base(),
      // The cancel's follow-up asks on the payment's own key and is refused: nothing settled.
      [newRoute.pay()]: [dropped, () => apiError(409, "checkout_not_open")],
      [newRoute.cancel()]: () => json({ checkout: staffCheckout({ state: "canceled" }) }),
      [newRoute.read()]: () => json({ checkout: staffCheckout({ state: "canceled" }) }),
    });
    renderPage();
    await toPayment();
    await click("Take test payment");
    await screen.findByRole("alert");
    await click("Cancel booking");
    const dialog = await screen.findByRole("dialog", { name: "Cancel this booking?" });
    expect(text(dialog)).toContain("may already have gone through");
    expect(text(dialog)).not.toContain("Nothing has been charged");
    await settle();
    fireEvent.click(within(dialog).getByRole("button", { name: "Cancel booking" }));
    expect(await stepHeading("Booking canceled")).toBeTruthy();
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("recheck 1: an unanswered Take test payment leaves Decline unavailable and Try again on its own key", async () => {
    api({
      ...base(),
      [newRoute.pay()]: [dropped, () => json(paid())],
      [newRoute.read()]: () => json({ checkout: confirmed() }),
    });
    renderPage();
    await toPayment();
    await click("Take test payment");
    const alert = await screen.findByRole("alert");
    expect(text(alert)).toContain("may not have gone through");
    await settle();
    expect(screen.getByRole("button", { name: "Decline" }).getAttribute("aria-disabled")).toBe(
      "true",
    );
    fireEvent.click(screen.getByRole("button", { name: "Decline" }));
    expect(sentTo(newRoute.pay())).toHaveLength(1);
    await click("Try again");
    await stepHeading("Booked");
    const [first, second] = sentTo(newRoute.pay());
    expect(second?.body).toEqual({ outcome: "succeed" });
    expect(second?.headers.get("idempotency-key")).toBe(first?.headers.get("idempotency-key"));
  });

  it("recheck 1: a refusal as already settled stays on screen, and Try again sends the settled outcome", async () => {
    api({
      ...base(),
      // Declined elsewhere first: this Take test payment is refused, and the decline still needs delivering.
      [newRoute.pay()]: [
        () => apiError(409, "test_payment_settled"),
        () =>
          json(
            paid({
              outcome: "fail",
              alreadySettled: true,
              delivery: { status: 200, outcome: "released", duplicate: false },
            }),
          ),
      ],
      [newRoute.read()]: () =>
        json({ checkout: staffCheckout({ state: "failed", paymentState: "failed" }) }),
    });
    renderPage();
    await toPayment();
    await click("Take test payment");
    expect(text(await screen.findByRole("alert"))).toContain(
      "The test payment was already declined",
    );
    expect(screen.getByRole("heading", { level: 2, name: "Payment" })).toBeTruthy();
    await settle();
    for (const name of ["Take test payment", "Decline", "Cancel booking", "Change details"]) {
      expect(screen.getByRole("button", { name }).getAttribute("aria-disabled")).toBe("true");
    }
    await click("Try again");
    expect(await stepHeading("The test payment was declined")).toBeTruthy();
    expect(sentTo(newRoute.pay()).map((p) => p.body)).toEqual([
      { outcome: "succeed" },
      { outcome: "fail" },
    ]);
  });

  it("recheck 1: Try again after an unanswered payment books whether its event reached the inbox or not", async () => {
    for (const duplicate of [true, false]) {
      api({
        ...base(),
        [newRoute.pay()]: [
          dropped,
          () =>
            json(
              paid({
                alreadySettled: true,
                delivery: { status: 200, outcome: "confirmed", duplicate },
              }),
            ),
        ],
        [newRoute.read()]: () => json({ checkout: confirmed() }),
      });
      const view = renderPage();
      await toPayment();
      await click("Take test payment");
      await screen.findByRole("alert");
      await click("Try again");
      expect(await stepHeading("Booked")).toBeTruthy();
      const [first, second] = sentTo(newRoute.pay());
      expect(second?.headers.get("idempotency-key")).toBe(first?.headers.get("idempotency-key"));
      view.unmount();
      vi.unstubAllGlobals();
    }
  });

  it("recheck 3: a cancel after an unanswered payment says it may have gone through, delivers a settled result, and shows the refund", async () => {
    api({
      ...base(),
      [newRoute.pay()]: [
        dropped,
        // The payment's own key after the cancel: the settled success is delivered, and refunded.
        () =>
          json(
            paid({
              alreadySettled: true,
              delivery: { status: 200, outcome: "refund_required", duplicate: true },
            }),
          ),
      ],
      [newRoute.cancel()]: () => json({ checkout: staffCheckout({ state: "canceled" }) }),
      [newRoute.read()]: () =>
        json({
          checkout: staffCheckout({
            state: "unfulfilled",
            paymentState: "succeeded",
            refund: { state: "succeeded", amount: 9630 },
          }),
        }),
    });
    renderPage();
    await toPayment();
    await click("Take test payment");
    await screen.findByRole("alert");
    await click("Cancel booking");
    const dialog = await screen.findByRole("dialog", { name: "Cancel this booking?" });
    await settle();
    fireEvent.click(within(dialog).getByRole("button", { name: "Cancel booking" }));
    expect(await stepHeading("The payment came too late")).toBeTruthy();
    expect(screen.getByText("Refunded in full")).toBeTruthy();
    const [first, second] = sentTo(newRoute.pay());
    expect(second?.headers.get("idempotency-key")).toBe(first?.headers.get("idempotency-key"));
  });

  it("recheck 3: a canceled outcome after an unanswered payment never says nothing was charged, and offers Check again", async () => {
    api({
      ...base(),
      // The payment, the cancel's resend, and Check again's resend: no answer each time.
      [newRoute.pay()]: [dropped, dropped, dropped],
      [newRoute.cancel()]: () => json({ checkout: staffCheckout({ state: "canceled" }) }),
      [newRoute.read()]: [
        () => json({ checkout: staffCheckout({ state: "canceled" }) }),
        () =>
          json({
            checkout: staffCheckout({
              state: "unfulfilled",
              paymentState: "succeeded",
              refund: { state: "succeeded", amount: 9630 },
            }),
          }),
      ],
    });
    renderPage();
    await toPayment();
    await click("Take test payment");
    await screen.findByRole("alert");
    await click("Cancel booking");
    const dialog = await screen.findByRole("dialog", { name: "Cancel this booking?" });
    await settle();
    fireEvent.click(within(dialog).getByRole("button", { name: "Cancel booking" }));
    expect(await stepHeading("Booking canceled")).toBeTruthy();
    const page = text(document.querySelector(".nb-page"));
    expect(page).not.toContain("Nothing was charged");
    expect(page).toContain("may have gone through");
    await click("Check again");
    expect(await stepHeading("The payment came too late")).toBeTruthy();
  });

  it("recheck 2: a retried edit cancels the checkout the re-ask found, never dropping it", async () => {
    api({
      ...base(),
      [newRoute.open]: [() => apiError(503, "payment_provider_unavailable"), openAnswer],
      [newRoute.cancel()]: [
        () => apiError(503, "unavailable"),
        () => json({ checkout: staffCheckout({ state: "canceled" }) }),
      ],
    });
    renderPage();
    await toReview();
    await attestBoth();
    await click("Hold seats and take payment");
    await screen.findByRole("alert");
    await click("Change details");
    expect(text(await screen.findByRole("alert"))).toContain("The details couldn't be changed");
    expect(screen.getByRole("heading", { level: 2, name: "Review with the guest" })).toBeTruthy();
    await click("Try again");
    await stepHeading("Who is coming");
    expect(sentTo(newRoute.cancel())).toHaveLength(2);
    expect(sentTo(newRoute.open)).toHaveLength(2);
  });

  it("recheck note: an edit whose re-ask is refused outright goes straight on, with no held-seats notice", async () => {
    api({
      ...base(),
      [newRoute.open]: [
        () => apiError(503, "payment_provider_unavailable"),
        () => apiError(409, "quote_expired"),
      ],
    });
    renderPage();
    await toReview();
    await attestBoth();
    await click("Hold seats and take payment");
    await screen.findByRole("alert");
    await click("Change details");
    await stepHeading("Who is coming");
    expect(screen.queryByText("The earlier hold couldn't be released yet")).toBeNull();
    expect(sentTo(newRoute.cancel())).toHaveLength(0);
  });

  it("UI-5: marks Payment done only for a confirmed booking", async () => {
    api({
      ...base(),
      [newRoute.pay()]: () =>
        json(
          paid({
            outcome: "fail",
            delivery: { status: 200, outcome: "released", duplicate: false },
          }),
        ),
      [newRoute.read()]: () =>
        json({ checkout: staffCheckout({ state: "failed", paymentState: "failed" }) }),
    });
    renderPage();
    await toPayment();
    await click("Decline");
    await stepHeading("The test payment was declined");
    const steps = screen.getByRole("list", { name: "Booking steps" });
    const payment = [...steps.querySelectorAll("li")].at(-1);
    expect(text(payment)).not.toContain("done");
    expect(payment?.getAttribute("aria-current")).toBe("step");
  });

  it("UI-8: an edit after two provider timeouts keeps the request and says the seats may be held", async () => {
    api({
      ...base(),
      [newRoute.open]: [
        () => apiError(503, "payment_provider_unavailable"),
        () => apiError(503, "payment_provider_unavailable"),
      ],
    });
    renderPage();
    await toReview();
    await attestBoth();
    await click("Hold seats and take payment");
    await screen.findByRole("alert");
    await click("Change details");
    expect(await screen.findByText("The earlier hold couldn't be released yet")).toBeTruthy();
    expect(screen.getByRole("heading", { level: 2, name: "Review with the guest" })).toBeTruthy();
    expect(sentTo(newRoute.cancel())).toHaveLength(0);
    const opens = sentTo(newRoute.open);
    expect(opens).toHaveLength(2);
    expect(opens[1]?.headers.get("idempotency-key")).toBe(opens[0]?.headers.get("idempotency-key"));
  });

  it("UI-9: names the command that failed", async () => {
    api({ [newRoute.offer()]: offerAnswer(), [newRoute.quote]: dropped });
    renderPage();
    await stepHeading("Who is coming");
    await click("Add one Adult");
    await click("Price and continue");
    const alert = await screen.findByRole("alert");
    expect(text(alert)).toContain("The party couldn't be priced");
    expect(text(alert)).not.toContain("didn't load");
  });

  it("UI-11 and UI-12: one guest reads as one, and the address breaks only after an @ or a dot", async () => {
    api(base());
    renderPage();
    await stepHeading("Who is coming");
    await click("Add one Adult");
    expect(text(document.querySelector(".nb-status"))).toBe("1 guest");
    await click("Add one Adult");
    expect(text(document.querySelector(".nb-status"))).toBe("2 guests");
    await click("Price and continue");
    await stepHeading("The guest");
    fireEvent.change(screen.getByLabelText("Booker's name"), { target: { value: caller.name } });
    fireEvent.change(screen.getByLabelText("Booker's email"), { target: { value: caller.email } });
    await click("Review");
    await stepHeading("Review with the guest");
    const email = document.querySelector(".nb-readback__email") as HTMLElement;
    expect(text(email)).toBe(caller.email);
    expect(email.querySelectorAll("wbr")).toHaveLength(3);
  });
});

describe("uncertain payment recovery (G2.12d follow-up)", () => {
  const base = () => ({
    [newRoute.offer()]: offerAnswer(),
    [newRoute.quote]: quoteAnswer,
    [newRoute.open]: openAnswer,
  });
  const canceledCheckout = () => staffCheckout({ state: "canceled" });
  const refunded = () =>
    staffCheckout({
      state: "unfulfilled",
      paymentState: "succeeded",
      refund: { state: "succeeded", amount: 9630 },
    });
  const declined = paid({
    outcome: "fail",
    event: {
      id: "fevt_ABCDEFGHIJKLMNOPQRSTUVWX",
      type: "payment.failed",
      createdAt: "2026-11-04T17:01:00.000Z",
    },
    alreadySettled: true,
    delivery: { status: 200, outcome: "failure_recorded", duplicate: false },
  });
  const keysOf = (calls: { headers: Headers }[]) =>
    new Set(calls.map((c) => c.headers.get("idempotency-key")));

  /** The payment gets no answer, then staff cancel through the danger dialog. */
  async function cancelAfterUnanswered(press: "Take test payment" | "Decline") {
    await toPayment();
    await click(press);
    await screen.findByRole("alert");
    await click("Cancel booking");
    const dialog = await screen.findByRole("dialog", { name: "Cancel this booking?" });
    await settle();
    fireEvent.click(within(dialog).getByRole("button", { name: "Cancel booking" }));
  }

  it.each([
    ["expired", "The hold ended", "The payment wasn't taken before the hold ended."],
    ["canceled", "Booking canceled", "Nothing was charged."],
  ] as const)(
    "follow-up 2: Try again refused as not open after an unanswered payment reads %s, with nothing charged and a new booking offered",
    async (state, heading, said) => {
      api({
        ...base(),
        // Refused as no longer open on the payment's own key: nothing had settled.
        [newRoute.pay()]: [dropped, () => apiError(409, "checkout_not_open")],
        [newRoute.read()]: () => json({ checkout: staffCheckout({ state }) }),
      });
      renderPage();
      await toPayment();
      await click("Take test payment");
      await screen.findByRole("alert");
      await click("Try again");
      expect(await stepHeading(heading)).toBeTruthy();
      const page = text(document.querySelector(".nb-page"));
      expect(page).toContain(said);
      expect(page).not.toContain("may have gone through");
      expect(screen.getByRole("link", { name: "Start a new booking" })).toBeTruthy();
      expect(screen.queryByRole("button", { name: "Check again" })).toBeNull();
      const pays = sentTo(newRoute.pay());
      expect(pays).toHaveLength(2);
      expect(keysOf(pays).size).toBe(1);
    },
  );

  it("follow-up 1: Check again on a canceled outcome sends the payment's own request again, so a settled success is refunded", async () => {
    let delivered = false;
    api({
      ...base(),
      [newRoute.pay()]: [
        dropped,
        // The cancel's resend gets no answer either: nothing has delivered the settled success.
        dropped,
        () => {
          delivered = true;
          return json(
            paid({
              alreadySettled: true,
              delivery: { status: 200, outcome: "refund_required", duplicate: false },
            }),
          );
        },
      ],
      [newRoute.cancel()]: () => json({ checkout: canceledCheckout() }),
      // The checkout stays canceled until the success is delivered, then it is refunded.
      [newRoute.read()]: () => json({ checkout: delivered ? refunded() : canceledCheckout() }),
    });
    renderPage();
    await cancelAfterUnanswered("Take test payment");
    expect(await stepHeading("Booking canceled")).toBeTruthy();
    expect(text(document.querySelector(".nb-page"))).toContain("may have gone through");
    await click("Check again");
    expect(await stepHeading("The payment came too late")).toBeTruthy();
    expect(screen.getByText("Refunded in full")).toBeTruthy();
    const pays = sentTo(newRoute.pay());
    expect(pays.map((p) => p.body)).toEqual([
      { outcome: "succeed" },
      { outcome: "succeed" },
      { outcome: "succeed" },
    ]);
    expect(keysOf(pays).size).toBe(1);
  });

  it("follow-up 1: a resend whose result did not reach TideGrid says so, and Try again sends it again on its key", async () => {
    let delivered = false;
    api({
      ...base(),
      [newRoute.pay()]: [
        dropped,
        // The cancel's resend: the provider has the success, and the webhook answered 500.
        () =>
          json(
            paid({
              alreadySettled: true,
              delivery: { status: 500, outcome: null, duplicate: null },
            }),
          ),
        () => {
          delivered = true;
          return json(
            paid({
              alreadySettled: true,
              delivery: { status: 200, outcome: "refund_required", duplicate: true },
            }),
          );
        },
      ],
      [newRoute.cancel()]: () => json({ checkout: canceledCheckout() }),
      [newRoute.read()]: () => json({ checkout: delivered ? refunded() : canceledCheckout() }),
    });
    renderPage();
    await cancelAfterUnanswered("Take test payment");
    expect(await stepHeading("Booking canceled")).toBeTruthy();
    expect(text(await screen.findByRole("alert"))).toContain(
      "The payment's result didn't reach TideGrid",
    );
    await click("Try again");
    expect(await stepHeading("The payment came too late")).toBeTruthy();
    expect(screen.queryByRole("alert")).toBeNull();
    const pays = sentTo(newRoute.pay());
    expect(pays).toHaveLength(3);
    expect(keysOf(pays).size).toBe(1);
  });

  it("follow-up 1: a resend whose result did not reach TideGrid says so when the read after it fails too", async () => {
    api({
      ...base(),
      [newRoute.pay()]: [
        dropped,
        () =>
          json(
            paid({
              alreadySettled: true,
              delivery: { status: 503, outcome: null, duplicate: null },
            }),
          ),
      ],
      [newRoute.cancel()]: () => json({ checkout: canceledCheckout() }),
      [newRoute.read()]: () => apiError(503, "unavailable"),
    });
    renderPage();
    await cancelAfterUnanswered("Take test payment");
    expect(await stepHeading("Booking canceled")).toBeTruthy();
    expect(text(await screen.findByRole("alert"))).toContain(
      "The payment's result didn't reach TideGrid",
    );
    expect(text(document.querySelector(".nb-page"))).toContain("may have gone through");
  });

  it("follow-up 1: a resend that delivers a decline clears the doubt, even when the read after it fails", async () => {
    api({
      ...base(),
      [newRoute.pay()]: [dropped, () => json(declined)],
      // The cancel's own answer is all the page has: pending, as it was canceled.
      [newRoute.cancel()]: () => json({ checkout: canceledCheckout() }),
      [newRoute.read()]: () => apiError(503, "unavailable"),
    });
    renderPage();
    await cancelAfterUnanswered("Decline");
    expect(await stepHeading("Booking canceled")).toBeTruthy();
    const page = text(document.querySelector(".nb-page"));
    expect(page).toContain("Nothing was charged.");
    expect(page).not.toContain("may have gone through");
    expect(screen.getByRole("link", { name: "Start a new booking" })).toBeTruthy();
    expect(sentTo(newRoute.pay()).map((p) => p.body)).toEqual([
      { outcome: "fail" },
      { outcome: "fail" },
    ]);
  });

  it("follow-up 1: a read that shows the payment failed clears the doubt, with no stale problem", async () => {
    api({
      ...base(),
      [newRoute.pay()]: [dropped, dropped],
      [newRoute.cancel()]: () => json({ checkout: canceledCheckout() }),
      // The decline reached TideGrid; only its answer to the console was lost.
      [newRoute.read()]: () =>
        json({ checkout: staffCheckout({ state: "canceled", paymentState: "failed" }) }),
    });
    renderPage();
    await cancelAfterUnanswered("Decline");
    expect(await stepHeading("Booking canceled")).toBeTruthy();
    const page = text(document.querySelector(".nb-page"));
    expect(page).toContain("Nothing was charged.");
    expect(page).not.toContain("may have gone through");
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.queryByRole("button", { name: "Check again" })).toBeNull();
  });

  it("follow-up 1: after a cancel refused because the hold had ended, Check again only reads, and says a late success books or refunds", async () => {
    api({
      ...base(),
      [newRoute.pay()]: [dropped],
      [newRoute.cancel()]: () => apiError(409, "checkout_not_cancelable"),
      [newRoute.read()]: () => json({ checkout: staffCheckout({ state: "expired" }) }),
    });
    renderPage();
    await cancelAfterUnanswered("Take test payment");
    expect(await stepHeading("The hold ended")).toBeTruthy();
    const page = text(document.querySelector(".nb-page"));
    expect(page).toContain("may have gone through");
    expect(page).toContain("the guest is booked if the seats are still free, or refunded in full");
    expect(page).not.toContain("Check again shows the refund");
    expect(screen.getByRole("link", { name: "Back to calendar" })).toBeTruthy();
    expect(screen.queryByRole("link", { name: "Start a new booking" })).toBeNull();
    await click("Check again");
    await waitFor(() => expect(sentTo(newRoute.read())).toHaveLength(2));
    await settle();
    // A delivered success on an ended hold books the guest: Check again never sends it.
    expect(sentTo(newRoute.pay())).toHaveLength(1);
  });

  it("follow-up 3: after quote_expired, Change details then Price again on the party step goes to the guest, keeps the name, and Hold sends the new quote", async () => {
    const fresh = "6a1c3e50-7b2d-4f8e-9a6b-1c2d3e4f5a62";
    api({
      ...base(),
      [newRoute.quote]: [quoteAnswer, () => json({ quote: quoteFor({ quoteId: fresh }) }, 201)],
      [newRoute.open]: [() => apiError(409, "quote_expired"), openAnswer],
    });
    renderPage();
    await toReview();
    await attestBoth();
    await click("Hold seats and take payment");
    await screen.findByText("The price needs refreshing");
    await click("Change details");
    await stepHeading("Who is coming");
    await click("Price again");
    expect(await stepHeading("The guest")).toBeTruthy();
    expect((screen.getByLabelText("Booker's name") as HTMLInputElement).value).toBe(caller.name);
    await click("Review");
    await stepHeading("Review with the guest");
    await settle();
    for (const label of [
      "I read the email address back to the guest",
      "I told the guest the cancellation policy (version 3)",
    ]) {
      expect((screen.getByLabelText(label) as HTMLInputElement).checked).toBe(false);
    }
    await attestBoth();
    await click("Hold seats and take payment");
    await stepHeading("Payment");
    const opens = sentTo(newRoute.open);
    expect(opens.map((o) => (o.body as { quoteId: string }).quoteId)).toEqual([quoteId, fresh]);
  });
});
