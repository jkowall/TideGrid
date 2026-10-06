// @vitest-environment jsdom

// The guest is in Tokyo and the marina in New York: every time on the page
// must be the marina's.
process.env.TZ = "Asia/Tokyo";

import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NavigationProvider } from "../navigation.tsx";
import { BookingPage } from "./BookingPage.tsx";
import {
  brand,
  type Call,
  callsTo,
  charterListing,
  charterOffer,
  charterQuote,
  charterTripId,
  checkout,
  held,
  inOrder,
  json,
  listing,
  offer,
  offline,
  refusal,
  sharedQuote,
  stubApi,
  testNow,
  tripId,
} from "./fixtures.ts";
import { timing } from "./model.ts";

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const secretPattern = /^[A-Za-z0-9_-]{43}$/;
const clientSecret = "fpay_test_1_secret_abc123";

/** Text with every kind of space as a plain space. */
const text = (element: Element | null) => (element?.textContent ?? "").replace(/\s+/g, " ").trim();

/** A ledger's rows as they read: label, detail, amount. */
const ledgerRows = () =>
  within(screen.getByRole("table", { name: "Price in US dollars" }))
    .getAllByRole("row")
    .map((row) =>
      [...row.querySelectorAll(".tg-ledger__label, .tg-ledger__detail, .tg-ledger__amount")]
        .map((cell) => text(cell))
        .join(" "),
    );

/** The party's error, as shown beside the counts. */
const partyError = () => text(document.getElementById("booking-party-error"));

/** What the page last said aloud through its own status line. */
const announced = () => text(document.querySelector("p.tg-visually-hidden[role='status']"));

/** A description list's terms and their values. */
const summary = (element: Element) =>
  Object.fromEntries(
    [...element.querySelectorAll("dl > div")].map((row) => [
      text(row.querySelector("dt")),
      text(row.querySelector("dd")),
    ]),
  );

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
  window.localStorage.clear();
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  Object.assign(timing, original);
});

function renderPage(search = "", options: { trip?: string; focusOnArrival?: boolean } = {}) {
  const trip = options.trip ?? tripId;
  window.history.replaceState(null, "", `/book/${trip}${search}`);
  const navigate = vi.fn();
  render(
    <NavigationProvider navigate={navigate}>
      <BookingPage brand={brand} tripId={trip} focusOnArrival={options.focusOnArrival ?? false} />
    </NavigationProvider>,
  );
  return { navigate };
}

const heading = (name: string | RegExp) => screen.findByRole("heading", { name });

async function toDetails() {
  fireEvent.click(await screen.findByRole("button", { name: "Continue" }));
  await heading("Your details");
}

function fillDetails(name = "Ava Guest", email = "ava@example.test") {
  fireEvent.change(screen.getByRole("textbox", { name: "Full name" }), {
    target: { value: name },
  });
  fireEvent.change(screen.getByRole("textbox", { name: "Email" }), { target: { value: email } });
  const accept = screen.getByRole("checkbox", { name: "I accept this cancellation policy" });
  if (!(accept as HTMLInputElement).checked) fireEvent.click(accept);
}

async function toPayment() {
  fillDetails();
  fireEvent.click(screen.getByRole("button", { name: "Continue to payment" }));
  await heading("Payment");
}

/** The checkout secret the page sent when it opened its first checkout. */
const secretOf = (calls: Call[]) =>
  (callsTo(calls, "openCheckout")[0]?.body as { checkoutSecret?: string } | undefined)
    ?.checkoutSecret ?? "";

/** Every URL the page asked for or showed, to check nothing private is in one. */
function urlsSeen(calls: Call[]): string[] {
  return [...calls.map((c) => c.url), window.location.href];
}

describe("loading the trip", () => {
  it("shows the trip's shape and says it is loading, then the party step", async () => {
    const offerAnswer = held();
    stubApi({ offer: offerAnswer.answer });
    renderPage();
    expect(text(screen.getByRole("status"))).toBe("Loading the trip…");
    expect(document.querySelector('[aria-busy="true"] .booking-hero--skeleton')).toBeTruthy();
    offerAnswer.release(json({ offer }));
    expect(await heading("Who's coming")).toBeTruthy();
    expect(screen.getByRole("heading", { level: 1, name: "Sunset Harbor Cruise" })).toBeTruthy();
    expect(text(document.querySelector(".booking-hero__when"))).toBe(
      "Wednesday, October 7, 2026 at 6:00 PM · 1 h 30 min, for 1 hour 30 minutes",
    );
  });

  it("asks for the listing on the trip's own date and product, for its smallest party", async () => {
    const calls = stubApi();
    renderPage();
    await heading("Who's coming");
    const [query] = callsTo(calls, "listing");
    expect(query?.search.get("from")).toBe("2026-10-07");
    expect(query?.search.get("to")).toBe("2026-10-07");
    expect(query?.search.get("party")).toBe("1");
    expect(query?.search.get("product")).toBe(offer.product.id);
    const facts = screen.getByRole("region", { name: "Trip details" });
    expect(text(facts)).toContain("Meet at Dock C, slip 14");
    expect(text(facts)).toContain("Shared trip, 20 seats left");
    expect(text(facts)).toContain("Book by 5:00 PM");
    expect(text(facts)).toContain("Times are local to Harbor Marina, Dock C (New York).");
  });

  it("offers Try again when the trip does not load, and focuses the trip once it does", async () => {
    stubApi({ offer: inOrder(offline, () => json({ offer })) });
    renderPage();
    expect(await heading("We couldn't load this trip")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    const title = await screen.findByRole("heading", { level: 1, name: "Sunset Harbor Cruise" });
    await waitFor(() => expect(document.activeElement).toBe(title));
  });

  it("treats an offer that breaks the contract, or a zone this browser lacks, as a failed load", async () => {
    stubApi({
      offer: inOrder(
        () => json({ offer: { ...offer, tickets: "none" } }),
        () => json({ offer: { ...offer, trip: { ...offer.trip, timeZone: "Mars/Olympus_Mons" } } }),
      ),
    });
    renderPage();
    await heading("We couldn't load this trip");
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Try again" }).getAttribute("aria-busy")).toBe(
        null,
      ),
    );
    expect(screen.getByRole("heading", { name: "We couldn't load this trip" })).toBeTruthy();
  });

  it.each([
    [404, "trip_not_found", "We can't find this trip"],
    [409, "trip_not_bookable", "This trip isn't taking bookings now"],
    [409, "pricing_unavailable", "This trip can't be booked online yet"],
  ])("says plainly when the offer answers %i %s", async (status, code, title) => {
    stubApi({ offer: () => refusal(status, code) });
    renderPage();
    expect(await screen.findByRole("heading", { level: 1, name: title })).toBeTruthy();
    expect(screen.getByRole("link", { name: "Back to trips" })).toBeTruthy();
  });
});

describe("choosing the party", () => {
  it("starts from the trips list's party size, as that many of the first ticket type", async () => {
    stubApi();
    renderPage("?party=3");
    await heading("Who's coming");
    expect((screen.getByRole("spinbutton", { name: "Adult" }) as HTMLInputElement).value).toBe("3");
    // The address follows the page in an effect, a moment after the render.
    await waitFor(() => expect(window.location.search).toBe("?t.adult=3"));
  });

  it("keeps the party within the seats left, and says how many", async () => {
    stubApi({
      listing: () =>
        json({ trips: [{ ...listing, capacity: { ...listing.capacity, remaining: 2 } }] }),
    });
    renderPage("?t.adult=1");
    await heading("Who's coming");
    expect(screen.getByText(/2 seats are left\./)).toBeTruthy();
    const addAdult = screen.getByRole("button", { name: "Add one Adult ticket" });
    fireEvent.click(addAdult);
    expect((screen.getByRole("spinbutton", { name: "Adult" }) as HTMLInputElement).value).toBe("2");
    expect(addAdult.getAttribute("aria-disabled")).toBe("true");
    expect(
      screen
        .getByRole("button", { name: "Add one Child (3 to 12) ticket" })
        .getAttribute("aria-disabled"),
    ).toBe("true");
    fireEvent.click(addAdult);
    expect((screen.getByRole("spinbutton", { name: "Adult" }) as HTMLInputElement).value).toBe("2");
  });

  it("refuses an empty party before asking for a price, and focuses the first count", async () => {
    const calls = stubApi();
    renderPage("?t.adult=1");
    await heading("Who's coming");
    fireEvent.click(screen.getByRole("button", { name: "Remove one Adult ticket" }));
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    await waitFor(() => expect(partyError()).toBe("Choose at least 1 ticket."));
    const group = screen.getByRole("group", { name: "Tickets" });
    expect(group.getAttribute("aria-describedby")).toBe("booking-party-error");
    expect(document.activeElement).toBe(screen.getByRole("spinbutton", { name: "Adult" }));
    expect(callsTo(calls, "createQuote")).toHaveLength(0);
  });

  it("limits a per-guest add-on by the party, and lowers it when the party shrinks", async () => {
    stubApi();
    renderPage("?t.adult=2&a.drinks=4");
    await heading("Who's coming");
    const drinks = screen.getByRole("spinbutton", { name: "Drink voucher" }) as HTMLInputElement;
    expect(drinks.value).toBe("4");
    expect(
      screen.getByRole("button", { name: "Add one Drink voucher" }).getAttribute("aria-disabled"),
    ).toBe("true");
    fireEvent.click(screen.getByRole("button", { name: "Remove one Adult ticket" }));
    await waitFor(() => expect(drinks.value).toBe("2"));
    await waitFor(() => expect(window.location.search).toBe("?t.adult=1&a.drinks=2"));
  });

  it("books a charter by guests aboard, within the boat and the product", async () => {
    const calls = stubApi({
      offer: () => json({ offer: charterOffer }),
      listing: () => json({ trips: [charterListing] }),
      createQuote: () => json({ quote: charterQuote() }, 201),
    });
    renderPage("?party=6", { trip: charterTripId });
    await heading("Your group");
    const group = screen.getByRole("group", { name: "Guests aboard" });
    expect(text(group)).toContain("Whole boat, up to 12 guests$1,200.00");
    expect((screen.getByRole("spinbutton", { name: "Guests" }) as HTMLInputElement).value).toBe(
      "6",
    );
    expect(screen.getByText("If you miss the trip, you get no refund.")).toBeTruthy();
    expect(
      screen.getByText(
        "The deadline for changes has passed, so canceling now gets a credit for a future trip.",
      ),
    ).toBeTruthy();
    await toDetails();
    expect(callsTo(calls, "createQuote")[0]?.body).toEqual({
      tripId: charterTripId,
      party: { kind: "charter", guests: 6 },
      addOns: [],
    });
    expect(ledgerRows()).toEqual([
      "Whole boat, up to 12 guests $1,200.00",
      "Subtotal $1,200.00",
      "Fuel surcharge 1 × $75.00 $75.00",
      "State sales tax (7%) $89.25",
      "Total $1,364.25",
    ]);
    expect(
      screen.getByText(/The boat is held for you once you continue to payment\./),
    ).toBeTruthy();
  });

  it("shows unit prices, fees, how tax is added, and the policy before any price", async () => {
    stubApi();
    renderPage();
    await heading("Who's coming");
    expect(screen.getByText("$45.00 each")).toBeTruthy();
    expect(screen.getByText("Free")).toBeTruthy();
    expect(screen.getByText("$12.00 each, up to 2 per booking")).toBeTruthy();
    expect(screen.getByText("$8.00 each, up to 2 per guest")).toBeTruthy();
    expect(screen.getByText("Harbor fee: $2.50 per guest")).toBeTruthy();
    expect(screen.getByText("County surtax (1%) and State sales tax (6%) are added.")).toBeTruthy();
    expect(screen.getByText("Cancel before Tue, Oct 6, 6:00 PM for a full refund.")).toBeTruthy();
    expect(screen.getByText("After that, canceling gets no refund.")).toBeTruthy();
  });
});

describe("the price", () => {
  it("prices the party on the server and shows every line, fee, tax, and the total", async () => {
    const calls = stubApi();
    renderPage("?t.adult=2&t.child=1&a.photo=1&a.drinks=2");
    await toDetails();
    const [call] = callsTo(calls, "createQuote");
    expect(call?.body).toEqual({
      tripId,
      party: {
        kind: "tickets",
        tickets: [
          { code: "adult", quantity: 2 },
          { code: "child", quantity: 1 },
        ],
      },
      addOns: [
        { code: "photo", quantity: 1 },
        { code: "drinks", quantity: 2 },
      ],
    });
    expect(call?.headers.get("idempotency-key")).toMatch(uuid);
    expect(ledgerRows()).toEqual([
      "Adult 2 × $45.00 $90.00",
      "Child (3 to 12) 1 × $25.00 $25.00",
      "Souvenir photo 1 × $12.00 $12.00",
      "Drink voucher 2 × $8.00 $16.00",
      "Subtotal $143.00",
      "Harbor fee 3 × $2.50 $7.50",
      "County surtax (1%) $1.43",
      "State sales tax (6%) $8.58",
      "Total $160.51",
    ]);
    expect(text(document.querySelector(".booking-price__expiry"))).toBe(
      "This price is good until 12:30 PM EDT, about 30 minutes from now. Seats are held for you once you continue to payment.",
    );
    await waitFor(() => expect(window.location.search).toMatch(/&step=details&quote=0b7f3a52-/));
  });

  it("applies a promotion code as a new quote and shows the discount", async () => {
    const plain = sharedQuote();
    const discounted = sharedQuote({ promotion: true });
    const calls = stubApi({
      createQuote: inOrder(
        () => json({ quote: plain }, 201),
        () => json({ quote: discounted }, 201),
      ),
    });
    renderPage("?t.adult=2&t.child=1&a.photo=1&a.drinks=2");
    await toDetails();
    fireEvent.change(screen.getByRole("textbox", { name: "Promotion code (optional)" }), {
      target: { value: " harbor10 " },
    });
    fireEvent.click(screen.getByRole("button", { name: "Apply" }));
    const applied = await screen.findByText(
      (_, el) => text(el) === "Code HARBOR10 applied." && el?.tagName === "P",
    );
    const [first, second] = callsTo(calls, "createQuote");
    expect(second?.body).toMatchObject({ promotionCode: "harbor10" });
    expect(second?.headers.get("idempotency-key")).not.toBe(first?.headers.get("idempotency-key"));
    // The discount says it comes off the trip price only, not the subtotal with extras.
    expect(ledgerRows()).toContain("HARBOR10, 10% off On the trip price, not extras −$11.50");
    expect(ledgerRows()).toContain("Total $148.21");
    await waitFor(() => expect(document.activeElement).toBe(applied));
    await waitFor(() =>
      expect(text(screen.getByRole("status"))).toBe(
        "Code HARBOR10 applied. The total is now $148.21.",
      ),
    );
    // Removing it prices the party again without it.
    fireEvent.click(screen.getByRole("button", { name: "Remove code" }));
    await waitFor(() => expect(callsTo(calls, "createQuote")).toHaveLength(3));
    expect(callsTo(calls, "createQuote")[2]?.body as object).not.toHaveProperty("promotionCode");
  });

  it("keeps the current price and marks the field when a code is refused", async () => {
    const calls = stubApi({
      createQuote: inOrder(
        () => json({ quote: sharedQuote() }, 201),
        () =>
          refusal(
            422,
            "promotion_not_applicable",
            "This quote cannot be priced: promotion_not_applicable",
          ),
      ),
    });
    renderPage("?t.adult=2&t.child=1&a.photo=1&a.drinks=2");
    await toDetails();
    const field = screen.getByRole("textbox", { name: "Promotion code (optional)" });
    fireEvent.change(field, { target: { value: "NOPE123" } });
    fireEvent.click(screen.getByRole("button", { name: "Apply" }));
    expect(
      await screen.findByText(
        "This code can't be used for this trip. Check it, or book without it.",
      ),
    ).toBeTruthy();
    expect(field.getAttribute("aria-invalid")).toBe("true");
    expect(field.getAttribute("aria-describedby")).toMatch(/-error$/);
    await waitFor(() => expect(document.activeElement).toBe(field));
    expect(ledgerRows()).toContain("Total $160.51");
    expect(callsTo(calls, "createQuote")).toHaveLength(2);
  });

  it("refuses a malformed code without asking the server", async () => {
    const calls = stubApi();
    renderPage("?t.adult=1");
    await toDetails();
    fireEvent.change(screen.getByRole("textbox", { name: "Promotion code (optional)" }), {
      target: { value: "<b>" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Apply" }));
    expect(
      await screen.findByText("Enter the code as you were given it: 3 to 32 letters or numbers."),
    ).toBeTruthy();
    expect(callsTo(calls, "createQuote")).toHaveLength(1);
  });

  it("sends a failed price request again under the same key", async () => {
    const calls = stubApi({
      createQuote: inOrder(offline, () => json({ quote: sharedQuote() }, 201)),
    });
    renderPage("?t.adult=1");
    await heading("Who's coming");
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    expect(await screen.findByText("We couldn't reach the booking service")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    await heading("Your details");
    const [first, second] = callsTo(calls, "createQuote");
    expect(second?.headers.get("idempotency-key")).toBe(first?.headers.get("idempotency-key"));
    expect(second?.body).toEqual(first?.body);
  });

  it("says when too many prices were asked for in a minute", async () => {
    stubApi({ createQuote: () => refusal(429, "rate_limited") });
    renderPage("?t.adult=1");
    await heading("Who's coming");
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    expect(await screen.findByText("Too many tries in a short time")).toBeTruthy();
    expect(screen.getByText("Wait a minute, then try again.")).toBeTruthy();
  });

  it("marks the party when the seats ran out, and the add-on the server refused", async () => {
    stubApi({
      createQuote: inOrder(
        () =>
          refusal(
            409,
            "insufficient_capacity",
            "This quote cannot be priced: insufficient_capacity",
          ),
        () =>
          refusal(
            422,
            "add_on_quantity_exceeded",
            "This quote cannot be priced: add_on_quantity_exceeded (drinks)",
          ),
      ),
    });
    renderPage("?t.adult=2&a.drinks=2");
    await heading("Who's coming");
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    await waitFor(() =>
      expect(partyError()).toBe(
        "There aren't enough seats left for this party. Choose fewer guests.",
      ),
    );
    // The party stays as the guest chose it.
    expect((screen.getByRole("spinbutton", { name: "Adult" }) as HTMLInputElement).value).toBe("2");
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    expect(await screen.findByText("That's more than this party can take.")).toBeTruthy();
    const drinks = screen.getByRole("spinbutton", { name: "Drink voucher" });
    expect(drinks.getAttribute("aria-invalid")).toBe("true");
  });

  it("offers the current options when the trip's options changed", async () => {
    const calls = stubApi({
      createQuote: () =>
        refusal(
          422,
          "unknown_ticket_type",
          "This quote cannot be priced: unknown_ticket_type (adult)",
        ),
    });
    renderPage("?t.adult=1");
    await heading("Who's coming");
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    expect(await screen.findByText("This trip's options have changed")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Show the new options" }));
    await waitFor(() => expect(callsTo(calls, "offer")).toHaveLength(2));
  });

  it("asks for the current price once a price expires, as a new quote", async () => {
    const calls = stubApi();
    renderPage("?t.adult=1");
    await toDetails();
    vi.setSystemTime(new Date(testNow.getTime() + 31 * 60_000));
    expect(await screen.findByText("This price has expired")).toBeTruthy();
    const refresh = screen.getByRole("button", { name: "Get the current price" });
    fireEvent.click(refresh);
    await screen.findByRole("button", { name: "Continue to payment" });
    const [first, second] = callsTo(calls, "createQuote");
    expect(second?.body).toEqual(first?.body);
    expect(second?.headers.get("idempotency-key")).not.toBe(first?.headers.get("idempotency-key"));
    expect(screen.queryByText("This price has expired")).toBeNull();
  });

  it("prices again after a reload when the address's party no longer matches the quote", async () => {
    const stored = sharedQuote();
    const calls = stubApi({ getQuote: () => json({ quote: stored }) });
    // The stored quote is for 2 adults, 1 child, a photo, and 2 drinks.
    renderPage(`?t.adult=4&step=details&quote=${stored.quoteId}`);
    await heading("Your details");
    await waitFor(() => expect(callsTo(calls, "createQuote")).toHaveLength(1));
    expect(callsTo(calls, "createQuote")[0]?.body).toMatchObject({
      party: { kind: "tickets", tickets: [{ code: "adult", quantity: 4 }] },
    });
  });

  it("shows the same quote after a reload of the details step, without pricing again", async () => {
    const stored = sharedQuote();
    const calls = stubApi({ getQuote: () => json({ quote: stored }) });
    renderPage(`?t.adult=2&t.child=1&a.photo=1&a.drinks=2&step=details&quote=${stored.quoteId}`);
    await heading("Your details");
    await screen.findByRole("table", { name: "Price in US dollars" });
    expect(callsTo(calls, "getQuote")[0]?.path).toBe(`/v1/public/quotes/${stored.quoteId}`);
    expect(callsTo(calls, "createQuote")).toHaveLength(0);
  });
});

describe("opening the checkout", () => {
  it("ties each problem to its field and focuses the first", async () => {
    const calls = stubApi();
    renderPage("?t.adult=1");
    await toDetails();
    fireEvent.click(screen.getByRole("button", { name: "Continue to payment" }));
    const name = screen.getByRole("textbox", { name: "Full name" });
    await waitFor(() => expect(document.activeElement).toBe(name));
    expect(screen.getByText("Enter the name of the person booking.")).toBeTruthy();
    expect(screen.getByText("Enter an email address.")).toBeTruthy();
    expect(screen.getByText("Accept the cancellation policy to continue.")).toBeTruthy();
    expect(name.getAttribute("aria-invalid")).toBe("true");
    const accept = screen.getByRole("checkbox", { name: "I accept this cancellation policy" });
    expect(accept.getAttribute("aria-describedby")).toMatch(/-hint .*-error$/);
    fireEvent.change(name, { target: { value: "Ava Guest" } });
    fireEvent.change(screen.getByRole("textbox", { name: "Email" }), {
      target: { value: "zoë@example.test" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Continue to payment" }));
    expect(
      await screen.findByText("Enter an email address like name@example.com, without accents."),
    ).toBeTruthy();
    expect(callsTo(calls, "openCheckout")).toHaveLength(0);
  });

  it("opens the checkout with the quote, the accepted policy, the booker, and a new secret", async () => {
    const quote = sharedQuote();
    const calls = stubApi({ createQuote: () => json({ quote }, 201) });
    renderPage("?t.adult=2&t.child=1&a.photo=1&a.drinks=2");
    await toDetails();
    fillDetails("  Ava Guest  ", "ava@example.test");
    fireEvent.click(screen.getByRole("button", { name: "Continue to payment" }));
    await heading("Payment");
    const [open] = callsTo(calls, "openCheckout");
    const body = open?.body as { checkoutSecret: string };
    expect(body).toEqual({
      quoteId: quote.quoteId,
      acceptedPolicyVersion: 1,
      booker: { name: "Ava Guest", email: "ava@example.test" },
      checkoutSecret: expect.stringMatching(secretPattern),
    });
    expect(open?.headers.get("idempotency-key")).toMatch(uuid);
    expect(open?.headers.get("authorization")).toBeNull();
    // The payment step says plainly that this is a test.
    expect(screen.getByText("This is a demo test payment")).toBeTruthy();
    expect(screen.getByText(/No real card is charged/)).toBeTruthy();
    expect(text(document.querySelector(".booking-pay__amount"))).toBe("$160.51 USD");
    expect(text(document.querySelector(".booking-pay__hold"))).toBe(
      "Your seats are held for you until 12:15 PM EDT, about 15 minutes from now.",
    );
    expect(screen.getByRole("button", { name: "Simulate successful payment" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Simulate declined payment" })).toBeTruthy();
    // Only the checkout's id, quote, secret, and the clock are kept for a reload: never the booker.
    const stored = window.sessionStorage.getItem("tidegrid.checkout") ?? "";
    expect(JSON.parse(stored)).toEqual({
      tripId,
      sessionId: expect.stringMatching(uuid),
      quoteId: quote.quoteId,
      secret: body.checkoutSecret,
      paymentSent: false,
      paymentTried: false,
      expiresAt: expect.any(String),
      clockOffsetMs: 0,
    });
    expect(stored).not.toMatch(/Ava|example\.test/);
    // The facts beside the steps say the seats are held.
    expect(text(screen.getByRole("complementary", { name: "Trip details" }))).toContain(
      "Your 3 seats are held",
    );
  });

  it("sends the same request again under the same key while the provider does not answer", async () => {
    const calls = stubApi({
      openCheckout: inOrder(
        () => refusal(503, "payment_provider_unavailable"),
        () => refusal(503, "payment_provider_unavailable"),
        (call) =>
          json(
            {
              checkoutSession: checkout("open", {
                id: "5d0c4a1e-2b3c-4d5e-8f60-0000000000aa",
                quoteId: (call.body as { quoteId: string }).quoteId,
              }),
              payment: { provider: "fake", paymentRef: "fpay_test_1", clientSecret },
            },
            201,
          ),
      ),
    });
    renderPage("?t.adult=1");
    await toDetails();
    await toPayment();
    const opens = callsTo(calls, "openCheckout");
    expect(opens).toHaveLength(3);
    const keys = new Set(opens.map((c) => c.headers.get("idempotency-key")));
    const bodies = new Set(opens.map((c) => JSON.stringify(c.body)));
    expect(keys.size).toBe(1);
    expect(bodies.size).toBe(1);
  });

  it("locks the details and repeats the exact request after a lost answer", async () => {
    const calls = stubApi({
      openCheckout: inOrder(offline, (call) =>
        json(
          {
            checkoutSession: checkout("open", {
              quoteId: (call.body as { quoteId: string }).quoteId,
            }),
            payment: { provider: "fake", paymentRef: "fpay_test_1", clientSecret },
          },
          201,
        ),
      ),
    });
    renderPage("?t.adult=1");
    await toDetails();
    fillDetails();
    fireEvent.click(screen.getByRole("button", { name: "Continue to payment" }));
    expect(await screen.findByText("We couldn't confirm that your checkout started")).toBeTruthy();
    // The details are locked in their fieldset: only the same request may be sent.
    expect(screen.getByRole("textbox", { name: "Full name" }).matches(":disabled")).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    await heading("Payment");
    const [first, second] = callsTo(calls, "openCheckout");
    expect(second?.headers.get("idempotency-key")).toBe(first?.headers.get("idempotency-key"));
    expect(second?.body).toEqual(first?.body);
  });

  it("prices again when the quote expired on the server, and asks the guest to check it", async () => {
    const calls = stubApi({
      openCheckout: inOrder(() => refusal(409, "quote_expired")),
    });
    renderPage("?t.adult=1");
    await toDetails();
    fillDetails();
    fireEvent.click(screen.getByRole("button", { name: "Continue to payment" }));
    expect(await screen.findByText("Your price was updated")).toBeTruthy();
    expect(callsTo(calls, "createQuote")).toHaveLength(2);
    expect(callsTo(calls, "openCheckout")).toHaveLength(1);
    expect(screen.getByRole("heading", { name: "Your details" })).toBeTruthy();
  });

  it("goes back to the party when the seats ran out, saying how many are left", async () => {
    stubApi({
      openCheckout: () =>
        refusal(409, "insufficient_capacity", "Only 1 seat(s) are left on this trip"),
    });
    renderPage("?t.adult=2");
    await toDetails();
    fillDetails();
    fireEvent.click(screen.getByRole("button", { name: "Continue to payment" }));
    expect(await heading("Who's coming")).toBeTruthy();
    expect(partyError()).toBe("Only 1 seat is left now. Choose fewer guests.");
    // The guest's own count stays beside the error.
    expect((screen.getByRole("spinbutton", { name: "Adult" }) as HTMLInputElement).value).toBe("2");
  });

  it.each([
    [409, "trip_not_bookable", "This trip isn't taking bookings now"],
    [409, "payments_unavailable", "Online payment isn't available"],
    [503, "payments_unavailable", "Online payment isn't available"],
  ])("stops plainly on %i %s", async (status, code, title) => {
    stubApi({ openCheckout: () => refusal(status, code) });
    renderPage("?t.adult=1");
    await toDetails();
    fillDetails();
    fireEvent.click(screen.getByRole("button", { name: "Continue to payment" }));
    expect(await heading(title)).toBeTruthy();
  });

  it.each([
    [429, "too_many_checkouts", "Too many checkouts are open"],
    [429, "rate_limited", "Too many tries in a short time"],
    [422, "payment_amount_too_small", "This total is too small to pay online"],
  ])("explains %i %s at the step", async (status, code, title) => {
    stubApi({ openCheckout: () => refusal(status, code) });
    renderPage("?t.adult=1");
    await toDetails();
    fillDetails();
    fireEvent.click(screen.getByRole("button", { name: "Continue to payment" }));
    expect(await screen.findByText(title)).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Your details" })).toBeTruthy();
  });
});

describe("paying and the outcome", () => {
  it("books through the test provider and confirms only from the checkout's own state", async () => {
    const quote = sharedQuote({ promotion: true });
    const calls = stubApi({
      createQuote: () => json({ quote }, 201),
      readCheckout: inOrder(
        () => json({ checkoutSession: checkout("open") }),
        () => json({ checkoutSession: checkout("confirmed", { amount: 14_821 }) }),
      ),
    });
    renderPage("?t.adult=2&t.child=1&a.photo=1&a.drinks=2");
    await toDetails();
    await toPayment();
    const secret = secretOf(calls);
    fireEvent.click(screen.getByRole("button", { name: "Simulate successful payment" }));
    expect(await heading("Confirming your payment")).toBeTruthy();
    expect(await heading("You're booked")).toBeTruthy();
    const [pay] = callsTo(calls, "succeed");
    expect(pay?.path).toBe("/v1/fake-provider/payments/fpay_test_1/succeed");
    expect(pay?.headers.get("authorization")).toBe(`Bearer ${clientSecret}`);
    const reads = callsTo(calls, "readCheckout");
    expect(reads.length).toBeGreaterThanOrEqual(2);
    for (const read of reads) expect(read.headers.get("authorization")).toBe(`Bearer ${secret}`);
    const outcome = screen.getByRole("region", { name: "You're booked" });
    const code = outcome.querySelector(".booking-reference__code");
    expect(text(code?.querySelector('[aria-hidden="true"]') ?? null)).toBe("C03G4ZFJ");
    // Spelled out for screen readers, which would read the code as a word.
    expect(text(code?.querySelector(".tg-visually-hidden") ?? null)).toBe("C 0 3 G 4 Z F J");
    expect(summary(outcome)).toEqual({
      Trip: "Sunset Harbor Cruise",
      When: "Wednesday, October 7, 2026 at 6:00 PM",
      Where: "Harbor Marina, Dock C",
      "Meet at": "Dock C, slip 14",
      Party: "3 guests: 2 Adult, 1 Child (3 to 12)",
      Extras: "Souvenir photo × 1, Drink voucher × 2",
      "Total paid": "$148.21",
    });
    expect(window.sessionStorage.getItem("tidegrid.checkout")).toBeNull();
    // What the confirmation said is kept for a reload: no secret, no name, no email.
    const booked = window.sessionStorage.getItem("tidegrid.booked") ?? "";
    expect(JSON.parse(booked)).toMatchObject({ tripId, reference: "C03G4ZFJ", total: 14_821 });
    expect(booked).not.toContain(secret);
    expect(booked).not.toMatch(/Ava|example\.test|fpay_/);
    await waitFor(() => expect(window.location.search).toMatch(/step=status$/));
  });

  it("shows a declined payment, then starts a new checkout from a new quote on Try again", async () => {
    let declined = false;
    const calls = stubApi({
      fail: () => {
        declined = true;
        return json({
          event: { id: "evt_2", type: "payment.failed", createdAt: new Date().toISOString() },
          alreadySettled: false,
          delivery: { status: 200, outcome: "released", duplicate: false },
        });
      },
      readCheckout: (call) =>
        json({
          checkoutSession: checkout(
            declined && callsTo(calls, "openCheckout").length === 1 ? "failed" : "confirmed",
            { id: call.path.split("/").at(-1) ?? "" },
          ),
        }),
    });
    renderPage("?t.adult=1");
    await toDetails();
    await toPayment();
    fireEvent.click(screen.getByRole("button", { name: "Simulate declined payment" }));
    expect(await heading("Your payment was declined")).toBeTruthy();
    expect(
      screen.getByText(/Nothing was charged, and the seats held for you were released/),
    ).toBeTruthy();
    expect(window.sessionStorage.getItem("tidegrid.checkout")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    // Accepted policy and details are kept, so the new checkout opens at once.
    await heading("Payment");
    const quotes = callsTo(calls, "createQuote");
    const opens = callsTo(calls, "openCheckout");
    expect(quotes).toHaveLength(2);
    expect(quotes[1]?.headers.get("idempotency-key")).not.toBe(
      quotes[0]?.headers.get("idempotency-key"),
    );
    expect(opens).toHaveLength(2);
    expect(opens[1]?.headers.get("idempotency-key")).not.toBe(
      opens[0]?.headers.get("idempotency-key"),
    );
    const secrets = opens.map((c) => (c.body as { checkoutSecret: string }).checkoutSecret);
    expect(secrets[1]).not.toBe(secrets[0]);
    fireEvent.click(screen.getByRole("button", { name: "Simulate successful payment" }));
    expect(await heading("You're booked")).toBeTruthy();
  });

  it("says the checkout expired and starts over with the same party", async () => {
    stubApi({
      readCheckout: () => json({ checkoutSession: checkout("expired") }),
    });
    renderPage("?t.adult=2");
    await toDetails();
    await toPayment();
    fireEvent.click(screen.getByRole("button", { name: "Simulate successful payment" }));
    expect(await heading("Your checkout expired")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Start over" }));
    expect(await heading("Who's coming")).toBeTruthy();
    expect((screen.getByRole("spinbutton", { name: "Adult" }) as HTMLInputElement).value).toBe("2");
  });

  it("notices the hold running out on the payment step", async () => {
    stubApi({
      readCheckout: () => json({ checkoutSession: checkout("expired") }),
      openCheckout: (call) =>
        json(
          {
            checkoutSession: checkout("open", {
              quoteId: (call.body as { quoteId: string }).quoteId,
              expiresAt: new Date(Date.now() + 20).toISOString(),
            }),
            payment: { provider: "fake", paymentRef: "fpay_test_1", clientSecret },
          },
          201,
        ),
    });
    renderPage("?t.adult=1");
    await toDetails();
    await toPayment();
    expect(await heading("Your checkout expired")).toBeTruthy();
  });

  it("explains a payment that arrived too late and follows its refund", async () => {
    stubApi({
      readCheckout: inOrder(
        () =>
          json({
            checkoutSession: checkout("unfulfilled", {
              refund: { state: "requested", amount: 16_051 },
            }),
          }),
        () =>
          json({
            checkoutSession: checkout("unfulfilled", {
              refund: { state: "succeeded", amount: 16_051 },
            }),
          }),
      ),
    });
    renderPage("?t.adult=1");
    await toDetails();
    await toPayment();
    fireEvent.click(screen.getByRole("button", { name: "Simulate successful payment" }));
    expect(await heading("We couldn't book this trip")).toBeTruthy();
    expect(screen.getByText(/It is being refunded in full: \$160\.51\./)).toBeTruthy();
    expect(screen.getByText("Refund in progress")).toBeTruthy();
    expect(await screen.findByText("Refunded", {}, { timeout: 4000 })).toBeTruthy();
    expect(screen.getByText(/It has been refunded in full: \$160\.51\./)).toBeTruthy();
  });

  it("asks before canceling, then comes back to the party with the seats released", async () => {
    const calls = stubApi();
    renderPage("?t.adult=1");
    await toDetails();
    await toPayment();
    fireEvent.click(screen.getByRole("button", { name: "Cancel checkout" }));
    // A final step is confirmed in a dialog; the way back takes focus first.
    const dialog = await screen.findByRole("dialog", { name: "Cancel this checkout?" });
    expect(text(dialog)).toContain(
      "Your seats are released at once, and you go back to choose your party.",
    );
    const keep = within(dialog).getByRole("button", { name: "Keep my checkout" });
    expect(document.activeElement).toBe(keep);
    fireEvent.click(keep);
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(callsTo(calls, "cancel")).toHaveLength(0);
    expect(screen.getByRole("heading", { name: "Payment" })).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Cancel checkout" }));
    const again = await screen.findByRole("dialog", { name: "Cancel this checkout?" });
    fireEvent.click(within(again).getByRole("button", { name: "Cancel checkout" }));
    expect(await heading("Who's coming")).toBeTruthy();
    expect(screen.getByText("Checkout canceled")).toBeTruthy();
    expect(screen.getByText(/Nothing was charged, and your seats were released\./)).toBeTruthy();
    const [cancel] = callsTo(calls, "cancel");
    const secret = secretOf(calls);
    expect(cancel?.headers.get("authorization")).toBe(`Bearer ${secret}`);
    expect(window.sessionStorage.getItem("tidegrid.checkout")).toBeNull();
    // The seats left are read again after the release, before the party step counts them.
    expect(callsTo(calls, "listing").length).toBeGreaterThanOrEqual(3);
  });

  it("shows what happened when a checkout could not be canceled because it had ended", async () => {
    stubApi({
      cancel: () => refusal(409, "checkout_not_cancelable"),
      readCheckout: () => json({ checkoutSession: checkout("confirmed") }),
    });
    renderPage("?t.adult=1");
    await toDetails();
    await toPayment();
    fireEvent.click(screen.getByRole("button", { name: "Cancel checkout" }));
    const dialog = await screen.findByRole("dialog", { name: "Cancel this checkout?" });
    fireEvent.click(within(dialog).getByRole("button", { name: "Cancel checkout" }));
    expect(await heading("You're booked")).toBeTruthy();
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("keeps the payment step after a lost answer, and never says nothing was charged", async () => {
    stubApi({ succeed: offline });
    renderPage("?t.adult=1");
    await toDetails();
    await toPayment();
    fireEvent.click(screen.getByRole("button", { name: "Simulate successful payment" }));
    expect(await screen.findByText("We couldn't confirm your test payment")).toBeTruthy();
    expect(screen.getByText(/so it may have gone through/)).toBeTruthy();
    expect(screen.queryByText(/Nothing has changed/)).toBeNull();
    expect(screen.getByRole("heading", { name: "Payment" })).toBeTruthy();
    const stored = JSON.parse(window.sessionStorage.getItem("tidegrid.checkout") ?? "{}");
    expect(stored).toMatchObject({ paymentSent: false, paymentTried: true });
    // Canceling now cannot promise that nothing was charged.
    fireEvent.click(screen.getByRole("button", { name: "Cancel checkout" }));
    const dialog = await screen.findByRole("dialog", { name: "Cancel this checkout?" });
    expect(text(dialog)).toContain("If your test payment went through, it is refunded in full.");
    fireEvent.click(within(dialog).getByRole("button", { name: "Cancel checkout" }));
    expect(await heading("Who's coming")).toBeTruthy();
    expect(screen.queryByText(/Nothing was charged/)).toBeNull();
    expect(
      screen.getByText(/If your test payment went through, it is refunded in full\./),
    ).toBeTruthy();
  });
});

describe("a reload during a checkout", () => {
  const record = (fields: Record<string, unknown> = {}) =>
    window.sessionStorage.setItem(
      "tidegrid.checkout",
      JSON.stringify({
        tripId,
        sessionId: "5d0c4a1e-2b3c-4d5e-8f60-000000000000",
        quoteId: "0b7f3a52-9c1e-4d2a-8f6b-000000000000",
        secret: "A".repeat(43),
        paymentSent: true,
        paymentTried: true,
        expiresAt: new Date(Date.now() + 10 * 60_000).toISOString(),
        clockOffsetMs: null,
        ...fields,
      }),
    );

  it("goes on waiting for a payment that was sent, then shows the booking", async () => {
    record();
    const calls = stubApi({
      readCheckout: inOrder(
        () => json({ checkoutSession: checkout("open") }),
        () => json({ checkoutSession: checkout("open") }),
        () => json({ checkoutSession: checkout("confirmed") }),
      ),
    });
    renderPage("?t.adult=1&step=status");
    expect(await heading("Confirming your payment")).toBeTruthy();
    expect(await heading("You're booked")).toBeTruthy();
    expect(callsTo(calls, "readCheckout")[0]?.headers.get("authorization")).toBe(
      `Bearer ${"A".repeat(43)}`,
    );
    expect(window.sessionStorage.getItem("tidegrid.checkout")).toBeNull();
  });

  it("will not pay after a reload, and releases the seats when the guest starts over", async () => {
    record({ paymentSent: false, paymentTried: false });
    const calls = stubApi();
    renderPage("?t.adult=1&step=pay");
    expect(await heading("Your checkout was interrupted")).toBeTruthy();
    expect(screen.getByText(/nothing was charged/)).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Simulate successful payment" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Start over" }));
    const dialog = await screen.findByRole("dialog", { name: "Release and start over?" });
    fireEvent.click(within(dialog).getByRole("button", { name: "Release and start over" }));
    expect(await heading("Who's coming")).toBeTruthy();
    expect(callsTo(calls, "cancel")).toHaveLength(1);
    expect(window.sessionStorage.getItem("tidegrid.checkout")).toBeNull();
  });

  it("says the checkout is not open in this tab when there is nothing to resume", async () => {
    stubApi();
    renderPage("?t.adult=1&step=status");
    expect(await heading("This checkout isn't open in this tab")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Start a new booking" }));
    expect(await heading("Who's coming")).toBeTruthy();
  });

  it("shows the checkout from its quote when its own hold took the trip off sale", async () => {
    record({ paymentSent: false, paymentTried: false });
    const quote = sharedQuote({ quoteId: "0b7f3a52-9c1e-4d2a-8f6b-000000000000" });
    const calls = stubApi({
      offer: () => refusal(409, "trip_not_bookable"),
      getQuote: () => json({ quote }),
    });
    const { navigate } = renderPage("?t.adult=1&step=pay");
    expect(await heading("Your checkout was interrupted")).toBeTruthy();
    expect(screen.getByRole("heading", { level: 1, name: "Sunset Harbor Cruise" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Start over" }));
    const dialog = await screen.findByRole("dialog", { name: "Release and start over?" });
    fireEvent.click(within(dialog).getByRole("button", { name: "Release and start over" }));
    await waitFor(() => expect(navigate).toHaveBeenCalledWith(`/book/${tripId}?t.adult=1`));
    expect(callsTo(calls, "cancel")).toHaveLength(1);
  });

  it("drops a stored checkout long past its expiry", async () => {
    record({ expiresAt: new Date(Date.now() - 60 * 60_000).toISOString() });
    stubApi();
    renderPage("?t.adult=1&step=status");
    expect(await heading("This checkout isn't open in this tab")).toBeTruthy();
    expect(window.sessionStorage.getItem("tidegrid.checkout")).toBeNull();
  });
});

describe("secrets and personal data", () => {
  it("never puts a secret, the booker's name, or the email in an address", async () => {
    const calls = stubApi({
      readCheckout: () => json({ checkoutSession: checkout("confirmed") }),
    });
    renderPage("?t.adult=1");
    await toDetails();
    // Each address is read once its effect has written it, not before.
    await waitFor(() => expect(window.location.search).toMatch(/step=details/));
    const seen: string[] = [window.location.href];
    await toPayment();
    await waitFor(() => expect(window.location.search).toMatch(/step=pay$/));
    seen.push(window.location.href);
    fireEvent.click(screen.getByRole("button", { name: "Simulate successful payment" }));
    await heading("You're booked");
    await waitFor(() => expect(window.location.search).toMatch(/step=status$/));
    seen.push(...urlsSeen(calls));
    const secret = secretOf(calls);
    for (const url of seen) {
      expect(url).not.toContain(secret);
      expect(url).not.toContain(clientSecret);
      expect(url).not.toMatch(/Ava|Guest|example\.test|%40/i);
    }
    // Personal data travels only in the POST that opens the checkout.
    const carrying = calls.filter((c) => JSON.stringify(c.body ?? "").includes("ava@example.test"));
    expect(carrying.map((c) => `${c.method} ${c.path}`)).toEqual([
      "POST /v1/public/checkout-sessions",
    ]);
    expect(window.localStorage.length).toBe(0);
    for (const call of calls) expect(call.headers.get("cookie")).toBeNull();
  });
});

// The review's findings ------------------------------------------------------------------

/** An open checkout as a reload finds it in this tab. */
function storeCheckout(fields: Record<string, unknown> = {}) {
  window.sessionStorage.setItem(
    "tidegrid.checkout",
    JSON.stringify({
      tripId,
      sessionId: "5d0c4a1e-2b3c-4d5e-8f60-000000000000",
      quoteId: "0b7f3a52-9c1e-4d2a-8f6b-000000000000",
      secret: "A".repeat(43),
      paymentSent: false,
      paymentTried: false,
      expiresAt: new Date(Date.now() + 10 * 60_000).toISOString(),
      clockOffsetMs: null,
      ...fields,
    }),
  );
}

const opened = (call: Call, fields: Parameters<typeof checkout>[1] = {}) =>
  json(
    {
      checkoutSession: checkout("open", {
        quoteId: (call.body as { quoteId: string }).quoteId,
        ...fields,
      }),
      payment: { provider: "fake", paymentRef: "fpay_test_1", clientSecret },
    },
    201,
  );

const settled = () =>
  json({
    event: { id: "evt_1", type: "payment.succeeded", createdAt: new Date().toISOString() },
    alreadySettled: false,
    delivery: { status: 200, outcome: "confirmed", duplicate: false },
  });

describe("while a checkout may have started", () => {
  it("keeps the price, the code, and the party until the same request answers", async () => {
    const calls = stubApi({ openCheckout: inOrder(offline, (call) => opened(call)) });
    const { navigate } = renderPage("?t.adult=1");
    await toDetails();
    fireEvent.change(screen.getByRole("textbox", { name: "Promotion code (optional)" }), {
      target: { value: "HARBOR10" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Apply" }));
    await screen.findByRole("button", { name: "Remove code" });
    fillDetails();
    fireEvent.click(screen.getByRole("button", { name: "Continue to payment" }));
    expect(await screen.findByText("We couldn't confirm that your checkout started")).toBeTruthy();
    const quotes = callsTo(calls, "createQuote").length;

    const removeCode = screen.getByRole("button", { name: "Remove code" });
    const changeParty = screen.getByRole("button", { name: "Change party or extras" });
    expect(removeCode.getAttribute("aria-disabled")).toBe("true");
    expect(changeParty.getAttribute("aria-disabled")).toBe("true");
    fireEvent.click(removeCode);
    fireEvent.click(changeParty);
    expect(screen.getByRole("heading", { name: "Your details" })).toBeTruthy();

    // Back stays on the details, and says why.
    window.history.back();
    await waitFor(() =>
      expect(announced()).toBe("Your checkout may have started. Press Try again to find out."),
    );
    expect(screen.getByRole("heading", { name: "Your details" })).toBeTruthy();

    // A link away asks first.
    fireEvent.click(screen.getByRole("link", { name: "All trips" }));
    const dialog = await screen.findByRole("dialog", {
      name: "Leave before your checkout is confirmed?",
    });
    fireEvent.click(within(dialog).getByRole("button", { name: "Stay" }));
    expect(navigate).not.toHaveBeenCalled();
    expect(callsTo(calls, "createQuote")).toHaveLength(quotes);

    // Only the same request goes again.
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    await heading("Payment");
    const [first, second] = callsTo(calls, "openCheckout");
    expect(second?.headers.get("idempotency-key")).toBe(first?.headers.get("idempotency-key"));
    expect(second?.body).toEqual(first?.body);
  });

  it("stops after three more tries when the provider never answers, and keeps the same request", async () => {
    const calls = stubApi({ openCheckout: () => refusal(503, "payment_provider_unavailable") });
    renderPage("?t.adult=1");
    await toDetails();
    fillDetails();
    fireEvent.click(screen.getByRole("button", { name: "Continue to payment" }));
    expect(await screen.findByText("We couldn't confirm that your checkout started")).toBeTruthy();
    expect(callsTo(calls, "openCheckout")).toHaveLength(4);
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    await waitFor(() => expect(callsTo(calls, "openCheckout")).toHaveLength(8));
    const opens = callsTo(calls, "openCheckout");
    expect(new Set(opens.map((c) => c.headers.get("idempotency-key"))).size).toBe(1);
    expect(new Set(opens.map((c) => JSON.stringify(c.body))).size).toBe(1);
    expect(screen.getByRole("heading", { name: "Your details" })).toBeTruthy();
  });
});

describe("a device clock that is off", () => {
  it("prices and opens a checkout with the device 45 minutes fast", async () => {
    // The server writes its answers at noon in New York; the device reads 12:45.
    const quote = sharedQuote();
    const session = checkout("open", { quoteId: quote.quoteId });
    vi.setSystemTime(testNow.getTime() + 45 * 60_000);
    const calls = stubApi({
      createQuote: () => json({ quote }, 201),
      openCheckout: () =>
        json(
          {
            checkoutSession: session,
            payment: { provider: "fake", paymentRef: "fpay_test_1", clientSecret },
          },
          201,
        ),
    });
    renderPage("?t.adult=2&t.child=1&a.photo=1&a.drinks=2");
    await toDetails();
    expect(screen.queryByText("This price has expired")).toBeNull();
    expect(text(document.querySelector(".booking-price__expiry"))).toContain(
      "until 12:30 PM EDT, about 30 minutes from now",
    );
    await toPayment();
    expect(text(document.querySelector(".booking-pay__hold"))).toBe(
      "Your seats are held for you until 12:15 PM EDT, about 15 minutes from now.",
    );
    expect(callsTo(calls, "createQuote")).toHaveLength(1);
    expect(callsTo(calls, "openCheckout")).toHaveLength(1);
    // A reload keeps what the page learned about the clocks.
    const stored = JSON.parse(window.sessionStorage.getItem("tidegrid.checkout") ?? "{}");
    expect(stored.clockOffsetMs).toBe(-45 * 60_000);
  });
});

describe("typing a count", () => {
  it("keeps a typed party past the limit, says why beside it, and prices nothing", async () => {
    const calls = stubApi();
    renderPage("?t.adult=2");
    await heading("Who's coming");
    const adult = screen.getByRole("spinbutton", { name: "Adult" }) as HTMLInputElement;
    fireEvent.change(adult, { target: { value: "12" } });
    fireEvent.blur(adult);
    expect(adult.value).toBe("12");
    expect(partyError()).toBe("This trip takes up to 10 guests, and your party is 12.");
    expect(text(document.querySelector(".booking-group__total"))).toBe("12 guests");
    expect(adult.getAttribute("aria-invalid")).toBe("true");
    expect(adult.getAttribute("aria-describedby")).toContain("booking-party-error");
    // Enter sends the form: nothing is priced, and the count takes focus.
    fireEvent.submit(adult.form as HTMLFormElement);
    await waitFor(() => expect(document.activeElement).toBe(adult));
    expect(callsTo(calls, "createQuote")).toHaveLength(0);
    await waitFor(() => expect(window.location.search).toBe("?t.adult=12"));
  });

  it("focuses the count the guest typed in", async () => {
    stubApi({
      listing: () =>
        json({ trips: [{ ...listing, capacity: { ...listing.capacity, remaining: 4 } }] }),
    });
    renderPage("?t.adult=2");
    await heading("Who's coming");
    const child = screen.getByRole("spinbutton", { name: "Child (3 to 12)" }) as HTMLInputElement;
    fireEvent.change(child, { target: { value: "3" } });
    expect(partyError()).toBe("Only 4 seats are left, and your party is 5. Choose fewer guests.");
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    await waitFor(() => expect(document.activeElement).toBe(child));
  });

  it("prices exactly what the fields show when the form is sent, an emptied count as none", async () => {
    const calls = stubApi();
    renderPage("?t.adult=2&t.child=1");
    await heading("Who's coming");
    const child = screen.getByRole("spinbutton", { name: "Child (3 to 12)" }) as HTMLInputElement;
    fireEvent.change(child, { target: { value: "" } });
    fireEvent.submit(child.form as HTMLFormElement);
    await heading("Your details");
    expect(callsTo(calls, "createQuote")[0]?.body).toMatchObject({
      party: { kind: "tickets", tickets: [{ code: "adult", quantity: 2 }] },
    });
  });

  it("says aloud when a smaller party lowers an extra", async () => {
    stubApi();
    renderPage("?t.adult=2&a.drinks=4");
    await heading("Who's coming");
    fireEvent.click(screen.getByRole("button", { name: "Remove one Adult ticket" }));
    await waitFor(() =>
      expect(announced()).toBe("Drink voucher lowered to 2, the most for 1 guest."),
    );
  });

  it("marks an extra typed past its limit and prices nothing", async () => {
    const calls = stubApi();
    renderPage("?t.adult=1");
    await heading("Who's coming");
    const photo = screen.getByRole("spinbutton", { name: "Souvenir photo" }) as HTMLInputElement;
    fireEvent.change(photo, { target: { value: "5" } });
    expect(screen.getByText("Up to 2 per booking.")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    await waitFor(() => expect(document.activeElement).toBe(photo));
    expect(callsTo(calls, "createQuote")).toHaveLength(0);
  });
});

describe("seats that ran out, and seats the guest released", () => {
  it("keeps the party when the seats ran out, and says how many are left beside it", async () => {
    let refused = false;
    stubApi({
      createQuote: () => {
        refused = true;
        return refusal(
          409,
          "insufficient_capacity",
          "This quote cannot be priced: insufficient_capacity",
        );
      },
      listing: () =>
        json({
          trips: [{ ...listing, capacity: { ...listing.capacity, remaining: refused ? 1 : 20 } }],
        }),
    });
    renderPage("?t.adult=2");
    await heading("Who's coming");
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    await waitFor(() =>
      expect(partyError()).toBe("Only 1 seat is left, and your party is 2. Choose fewer guests."),
    );
    expect((screen.getByRole("spinbutton", { name: "Adult" }) as HTMLInputElement).value).toBe("2");
  });

  it("starts over after a reload with its own party, counting its own released hold as free", async () => {
    storeCheckout();
    let released = false;
    const calls = stubApi({
      listing: () =>
        json({
          trips: [{ ...listing, capacity: { ...listing.capacity, remaining: released ? 6 : 2 } }],
        }),
      cancel: () => {
        released = true;
        return json({ checkoutSession: checkout("canceled") });
      },
    });
    renderPage("?t.adult=4&step=pay");
    expect(await heading("Your checkout was interrupted")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Start over" }));
    const dialog = await screen.findByRole("dialog", { name: "Release and start over?" });
    fireEvent.click(within(dialog).getByRole("button", { name: "Release and start over" }));
    expect(await heading("Who's coming")).toBeTruthy();
    expect((screen.getByRole("spinbutton", { name: "Adult" }) as HTMLInputElement).value).toBe("4");
    expect(screen.getByText(/6 seats are left\./)).toBeTruthy();
    expect(document.getElementById("booking-party-error")).toBeNull();
    expect(callsTo(calls, "cancel")).toHaveLength(1);
  });

  it("says a charter whose boat was taken can't be booked, never 'only 0 seats'", async () => {
    stubApi({
      offer: () => json({ offer: charterOffer }),
      listing: () => json({ trips: [charterListing] }),
      createQuote: () => json({ quote: charterQuote() }, 201),
      openCheckout: () =>
        refusal(409, "insufficient_capacity", "Only 0 seat(s) are left on this trip"),
    });
    renderPage("?guests=6", { trip: charterTripId });
    await heading("Your group");
    await toDetails();
    fillDetails();
    fireEvent.click(screen.getByRole("button", { name: "Continue to payment" }));
    expect(await heading("This trip isn't taking bookings now")).toBeTruthy();
    expect(screen.queryByText(/Only 0/)).toBeNull();
  });
});

describe("after a confirmation", () => {
  it("shows the booking again after a reload, from what the confirmation said", async () => {
    const quote = sharedQuote({ promotion: true });
    stubApi({
      createQuote: () => json({ quote }, 201),
      readCheckout: () => json({ checkoutSession: checkout("confirmed", { amount: 14_821 }) }),
    });
    renderPage("?t.adult=2&t.child=1&a.photo=1&a.drinks=2");
    await toDetails();
    await toPayment();
    fireEvent.click(screen.getByRole("button", { name: "Simulate successful payment" }));
    await heading("You're booked");
    await waitFor(() => expect(window.location.search).toMatch(/step=status$/));
    const address = window.location.search;

    // The reload: a new page at the same address, with no checkout to resume.
    cleanup();
    const calls = stubApi();
    renderPage(address, { focusOnArrival: true });
    expect(await heading("You're booked")).toBeTruthy();
    expect(screen.getByRole("heading", { level: 1, name: "Sunset Harbor Cruise" })).toBeTruthy();
    const outcome = screen.getByRole("region", { name: "You're booked" });
    expect(text(outcome.querySelector(".booking-reference__code [aria-hidden='true']"))).toBe(
      "C03G4ZFJ",
    );
    expect(summary(outcome)).toEqual({
      Trip: "Sunset Harbor Cruise",
      When: "Wednesday, October 7, 2026 at 6:00 PM",
      Where: "Harbor Marina, Dock C",
      "Meet at": "Dock C, slip 14",
      Party: "3 guests: 2 Adult, 1 Child (3 to 12)",
      Extras: "Souvenir photo × 1, Drink voucher × 2",
      "Total paid": "$148.21",
    });
    expect(calls).toHaveLength(0);
    await waitFor(() =>
      expect(document.title).toBe(
        "Booking confirmed · Sunset Harbor Cruise · Demo Harbor Charters",
      ),
    );
  });

  it("says the outcome truthfully when a checkout expired after a payment was sent", async () => {
    stubApi({ readCheckout: () => json({ checkoutSession: checkout("expired") }) });
    renderPage("?t.adult=1");
    await toDetails();
    await toPayment();
    fireEvent.click(screen.getByRole("button", { name: "Simulate successful payment" }));
    expect(await heading("Your checkout expired")).toBeTruthy();
    expect(screen.queryByText(/Nothing was charged/)).toBeNull();
    expect(
      screen.getByText(/If your test payment still goes through, it is booked if the seats are/),
    ).toBeTruthy();
  });

  it("keeps reading an expired checkout for a short grace after a payment, and books a late success", async () => {
    timing.lateSuccessGraceMs = 60_000;
    stubApi({
      readCheckout: inOrder(
        () => json({ checkoutSession: checkout("expired") }),
        () => json({ checkoutSession: checkout("expired") }),
        () => json({ checkoutSession: checkout("confirmed") }),
      ),
    });
    renderPage("?t.adult=1");
    await toDetails();
    await toPayment();
    fireEvent.click(screen.getByRole("button", { name: "Simulate successful payment" }));
    expect(await heading("You're booked")).toBeTruthy();
    expect(screen.queryByRole("heading", { name: "Your checkout expired" })).toBeNull();
  });

  it("lets a checkout that ended stay ended when a late provider answer arrives", async () => {
    const settle = held();
    stubApi({
      openCheckout: (call) => opened(call, { expiresAt: new Date(Date.now() + 20).toISOString() }),
      succeed: settle.answer,
      readCheckout: () => json({ checkoutSession: checkout("expired") }),
    });
    renderPage("?t.adult=1");
    await toDetails();
    await toPayment();
    fireEvent.click(screen.getByRole("button", { name: "Simulate successful payment" }));
    expect(await heading("Your checkout expired")).toBeTruthy();
    settle.release(settled());
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(screen.getByRole("heading", { name: "Your checkout expired" })).toBeTruthy();
    expect(window.sessionStorage.getItem("tidegrid.checkout")).toBeNull();
  });
});

describe("refunds and charters", () => {
  it("words a charter's refund truthfully, with a checkout reference to quote", async () => {
    stubApi({
      offer: () => json({ offer: charterOffer }),
      listing: () => json({ trips: [charterListing] }),
      createQuote: () => json({ quote: charterQuote() }, 201),
      openCheckout: (call) => opened(call, { id: "3ba66e4f-2b3c-4d5e-8f60-000000000001" }),
      readCheckout: () =>
        json({
          checkoutSession: checkout("unfulfilled", {
            id: "3ba66e4f-2b3c-4d5e-8f60-000000000001",
            refund: { state: "succeeded", amount: 136_425 },
          }),
        }),
    });
    renderPage("?guests=6", { trip: charterTripId });
    await heading("Your group");
    await toDetails();
    await toPayment();
    expect(text(screen.getByRole("complementary", { name: "Trip details" }))).toContain(
      "The boat is held for you",
    );
    fireEvent.click(screen.getByRole("button", { name: "Simulate successful payment" }));
    const outcome = await screen.findByRole("region", { name: "We couldn't book this trip" });
    expect(text(outcome)).toContain("could no longer become a booking");
    expect(text(outcome)).toContain("That happens when the boat was booked first");
    expect(text(outcome)).not.toMatch(/seats/);
    const reference = outcome.querySelector(".booking-checkout-ref");
    expect(text(reference?.querySelector("[aria-hidden='true']") ?? null)).toBe("3BA66E4F");
    expect(text(reference?.querySelector(".tg-visually-hidden") ?? null)).toBe("3 B A 6 6 E 4 F");
  });
});

describe("Back and Forward", () => {
  it("steps back from the details to the party, and forward again to the same price", async () => {
    const calls = stubApi();
    // The party the fake API's quote prices, so the price still fits it on Forward.
    renderPage("?t.adult=2&t.child=1&a.photo=1&a.drinks=2");
    await toDetails();
    await waitFor(() => expect(window.location.search).toMatch(/step=details/));
    window.history.back();
    expect(await heading("Who's coming")).toBeTruthy();
    await waitFor(() =>
      expect(window.location.search).toBe("?t.adult=2&t.child=1&a.photo=1&a.drinks=2"),
    );
    window.history.forward();
    expect(await heading("Your details")).toBeTruthy();
    expect(callsTo(calls, "createQuote")).toHaveLength(1);
  });

  it("asks to cancel before Back leaves the payment, and stays when the guest keeps it", async () => {
    const calls = stubApi();
    renderPage("?t.adult=1");
    await toDetails();
    await toPayment();
    await waitFor(() => expect(window.location.search).toMatch(/step=pay$/));
    window.history.back();
    const dialog = await screen.findByRole("dialog", { name: "Cancel this checkout?" });
    await waitFor(() => expect(window.location.search).toMatch(/step=pay$/));
    fireEvent.click(within(dialog).getByRole("button", { name: "Keep my checkout" }));
    expect(screen.getByRole("heading", { name: "Payment" })).toBeTruthy();
    expect(callsTo(calls, "cancel")).toHaveLength(0);

    window.history.back();
    const again = await screen.findByRole("dialog", { name: "Cancel this checkout?" });
    fireEvent.click(within(again).getByRole("button", { name: "Cancel checkout" }));
    expect(await heading("Who's coming")).toBeTruthy();
    expect(callsTo(calls, "cancel")).toHaveLength(1);
    // The page went back to the party's own entry, so the next Back leaves the checkout.
    await waitFor(() => expect(window.location.search).toBe("?t.adult=1"));
  });

  it("stays while a payment is being confirmed", async () => {
    stubApi({ readCheckout: () => json({ checkoutSession: checkout("open") }) });
    renderPage("?t.adult=1");
    await toDetails();
    await toPayment();
    fireEvent.click(screen.getByRole("button", { name: "Simulate successful payment" }));
    await heading("Confirming your payment");
    await waitFor(() => expect(window.location.search).toMatch(/step=status$/));
    window.history.back();
    await waitFor(() =>
      expect(announced()).toBe(
        "Your payment is being confirmed. Keep this page open until it finishes.",
      ),
    );
    expect(screen.getByRole("heading", { name: "Confirming your payment" })).toBeTruthy();
    await waitFor(() => expect(window.location.search).toMatch(/step=status$/));
  });

  it("goes back from an outcome to the party, to book again", async () => {
    stubApi({ readCheckout: () => json({ checkoutSession: checkout("failed") }) });
    renderPage("?t.adult=1");
    await toDetails();
    await toPayment();
    fireEvent.click(screen.getByRole("button", { name: "Simulate declined payment" }));
    await heading("Your payment was declined");
    window.history.back();
    expect(await heading("Who's coming")).toBeTruthy();
  });
});

describe("leaving the page", () => {
  it("asks before a link leaves an open checkout, and cancels it on the way out", async () => {
    const calls = stubApi();
    const { navigate } = renderPage("?t.adult=1");
    await toDetails();
    await toPayment();
    fireEvent.click(screen.getByRole("link", { name: "All trips" }));
    const dialog = await screen.findByRole("dialog", { name: "Leave this checkout?" });
    expect(text(dialog)).toContain(
      "Leaving cancels this checkout and releases your seats at once.",
    );
    expect(navigate).not.toHaveBeenCalled();
    fireEvent.click(within(dialog).getByRole("button", { name: "Cancel checkout and leave" }));
    await waitFor(() => expect(navigate).toHaveBeenCalledWith("/"));
    expect(callsTo(calls, "cancel")).toHaveLength(1);
    expect(window.sessionStorage.getItem("tidegrid.checkout")).toBeNull();
  });

  it("releases an open, unpaid checkout when the page goes without asking", async () => {
    const calls = stubApi();
    renderPage("?t.adult=1");
    await toDetails();
    await toPayment();
    cleanup();
    const [cancel] = callsTo(calls, "cancel");
    expect(cancel?.keepalive).toBe(true);
    expect(window.sessionStorage.getItem("tidegrid.checkout")).toBeNull();
  });

  it("leaves a checkout whose payment was sent alone when the page goes", async () => {
    const calls = stubApi({ readCheckout: () => json({ checkoutSession: checkout("open") }) });
    renderPage("?t.adult=1");
    await toDetails();
    await toPayment();
    fireEvent.click(screen.getByRole("button", { name: "Simulate successful payment" }));
    await heading("Confirming your payment");
    cleanup();
    expect(callsTo(calls, "cancel")).toHaveLength(0);
    expect(window.sessionStorage.getItem("tidegrid.checkout")).not.toBeNull();
  });
});

describe("the booker's details", () => {
  it("asks only what the contract asks of a name", async () => {
    const calls = stubApi();
    renderPage("?t.adult=1");
    await toDetails();
    fillDetails("Ava\tGuest");
    fireEvent.click(screen.getByRole("button", { name: "Continue to payment" }));
    expect(
      await screen.findByText("Remove tabs and other hidden characters from the name."),
    ).toBeTruthy();
    expect(callsTo(calls, "openCheckout")).toHaveLength(0);
    // Accents, apostrophes, and hyphens are fine.
    fillDetails("Zoë O'Brien-Smith");
    fireEvent.click(screen.getByRole("button", { name: "Continue to payment" }));
    await heading("Payment");
  });
});

describe("a stored quote in a zone the page doesn't know", () => {
  it("refuses to show its times", async () => {
    storeCheckout();
    const quote = sharedQuote({ quoteId: "0b7f3a52-9c1e-4d2a-8f6b-000000000000" });
    stubApi({
      offer: () => refusal(409, "trip_not_bookable"),
      getQuote: () => json({ quote: { ...quote, trip: { ...quote.trip, timeZone: "Mars/Base" } } }),
    });
    renderPage("?t.adult=1&step=pay");
    expect(await heading("We couldn't load this trip")).toBeTruthy();
  });
});
