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
    // Fresh inputs: price, review, attest, and open again.
    await click("Add one Adult");
    await click("Price and continue");
    await stepHeading("The guest");
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
        "The payment came through after the hold ended. It is refunded in full. Tell the guest.",
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
