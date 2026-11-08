// @vitest-environment jsdom

import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { BookingEmailCard } from "./BookingEmailCard.tsx";
import { bookerEmail, bookingId, json, messagesBody, stubApi, tenantId } from "./fixtures.ts";

/**
 * Arriving from the email exceptions list (W1-EMAIL-EXC): its links end in
 * #email, and the card takes focus from the page's heading once it has read.
 */

function renderOnPage() {
  render(
    <>
      <h1 tabIndex={-1}>Booking</h1>
      <button type="button">Elsewhere</button>
      <BookingEmailCard
        tenantId={tenantId}
        bookingId={bookingId}
        role="owner"
        timeZone="America/New_York"
        bookerEmail={bookerEmail}
      />
    </>,
  );
  screen.getByRole("heading", { level: 1, name: "Booking" }).focus();
}

const card = () => screen.getByRole("region", { name: "Email" });
const settled = () => waitFor(() => expect(card().getAttribute("aria-busy")).toBe("false"));
const cardHeading = () => screen.getByRole("heading", { level: 2, name: "Email" });

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  window.history.replaceState(null, "", "/");
});

describe("arriving at a booking's Email card from the exceptions list (W1-EMAIL-EXC)", () => {
  it("moves focus from the page's heading to the card's once it has read, under #email", async () => {
    window.history.replaceState(null, "", `/bookings/${bookingId}#email`);
    stubApi(() => json(200, messagesBody()));
    renderOnPage();
    await settled();
    await waitFor(() => expect(document.activeElement).toBe(cardHeading()));
    expect(card().id).toBe("email");
  });

  it("leaves focus alone without #email, and where the person moved it", async () => {
    window.history.replaceState(null, "", `/bookings/${bookingId}`);
    stubApi(() => json(200, messagesBody()));
    renderOnPage();
    await settled();
    expect(document.activeElement?.tagName).toBe("H1");
    cleanup();

    window.history.replaceState(null, "", `/bookings/${bookingId}#email`);
    stubApi(() => json(200, messagesBody()));
    renderOnPage();
    const elsewhere = screen.getByRole("button", { name: "Elsewhere" });
    elsewhere.focus();
    await settled();
    expect(document.activeElement).toBe(elsewhere);
  });
});
