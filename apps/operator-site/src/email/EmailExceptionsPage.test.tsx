// @vitest-environment jsdom

// Staff in Tokyo looking at New York and Honolulu marinas: times stay the trip's own.
process.env.TZ = "Asia/Tokyo";

import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { StaffRole } from "@tidegrid/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { me, membership } from "../bookings/fixtures.ts";
import { ConsoleShell, routeOf } from "../ConsoleShell.tsx";
import { NavigationProvider } from "../navigation.tsx";
import { EmailExceptionsPage } from "./EmailExceptionsPage.tsx";
import {
  apiError,
  bookingId,
  emailException,
  exceptionsPath,
  json,
  type Sent,
  stubApi,
  text,
} from "./fixtures.ts";

const reads = (calls: Sent[]) => calls.filter((c) => c.path === exceptionsPath);

function renderPage(role: StaffRole = "owner", navigate = vi.fn()) {
  render(
    <NavigationProvider navigate={navigate}>
      <EmailExceptionsPage membership={membership(role)} focusHeading={false} />
    </NavigationProvider>,
  );
  return navigate;
}

const items = () => screen.queryAllByRole("listitem");
const status = () => document.querySelector('[role="status"]');
const loaded = () => waitFor(() => expect(document.querySelector(".ex-list--skeleton")).toBeNull());

/** A promise the test releases, for a read still in flight. */
function deferred() {
  let release: (res: Response) => void = () => {};
  const promise = new Promise<Response>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-11-02T17:00:00Z"));
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  window.history.replaceState(null, "", "/");
});

describe("the operator's email exceptions (W1-EMAIL-EXC)", () => {
  it("lists each exception with what it was, its state as an icon and a label, when, attempts, the error, and its booking's card", async () => {
    const waiverBooking = "22222222-3333-4444-8555-666666666666";
    const calls = stubApi(() =>
      json(200, {
        exceptions: [
          emailException({ state: "outcome_unknown", failureCode: "outcome_unknown" }),
          emailException({
            template: "booking_canceled",
            state: "delivery_failed",
            failureCode: "delivery_failed",
            attempts: 2,
            staffResend: true,
          }),
          emailException({
            template: "waiver_request",
            kind: "waiver",
            failedAt: "2026-11-03T20:00:00.000Z",
            booking: { id: waiverBooking, reference: "ZX9KP2QM", timeZone: "Pacific/Honolulu" },
          }),
        ],
        nextBefore: null,
      }),
    );
    renderPage("booking_staff");
    await loaded();
    expect(reads(calls).map((c) => c.method)).toEqual(["GET"]);
    const rows = items();
    expect(rows.map((row) => text(row.querySelector("h2")))).toEqual([
      "Confirmation",
      "Cancellation notice, Sent again by staff",
      "Waiver request",
    ]);
    expect(rows.map((row) => text(row.querySelector(".tg-status")))).toEqual([
      "Outcome unknown",
      "Delivery failed",
      "Failed",
    ]);
    for (const badge of document.querySelectorAll(".tg-status")) {
      expect(badge.querySelector("svg")).not.toBeNull();
    }
    expect(text(rows[0])).toContain(
      "The email service did not answer, so TideGrid did not try again, to avoid a second working link.",
    );
    expect(text(rows[0])).toContain("Wed, Nov 4, 9:00 AM EST, after 1 attempt");
    expect(text(rows[1])).toContain("The email service could not deliver it");
    expect(text(rows[1])).toContain("after 2 attempts");
    expect(text(rows[2])).toContain("The guest's mail server refused it.");
    // The waiver's time is on its own marina's clock.
    expect(text(rows[2])).toContain("Tue, Nov 3, 10:00 AM HST");
    expect(rows.map((row) => text(row.querySelector("code")))).toEqual([
      "outcome_unknown",
      "delivery_failed",
      "bounced",
    ]);
    const links = rows.map((row) => within(row).getByRole("link"));
    expect(links.map((a) => [text(a), a.getAttribute("href")])).toEqual([
      ["Booking QKG6ERBF, Email card", `/bookings/${bookingId}#email`],
      ["Booking QKG6ERBF, Email card", `/bookings/${bookingId}#email`],
      ["Booking ZX9KP2QM", `/bookings/${waiverBooking}`],
    ]);
    // No recipient, subject, or body: the API sends none and the page shows none.
    expect(document.body.textContent).not.toContain("@");
    expect(text(status())).toBe("3 email exceptions.");
  });

  it("follows a row's link in place, to the booking's Email card", async () => {
    stubApi(() => json(200, { exceptions: [emailException()], nextBefore: null }));
    const navigate = renderPage();
    await loaded();
    fireEvent.click(screen.getByRole("link", { name: "Booking QKG6ERBF, Email card" }));
    expect(navigate).toHaveBeenCalledWith(`/bookings/${bookingId}#email`);
  });

  it("says when a later email of the same kind went out, and names a message with no booking", async () => {
    stubApi(() =>
      json(200, {
        exceptions: [
          emailException({ laterSent: true }),
          emailException({ template: "test_message", booking: null }),
        ],
        nextBefore: null,
      }),
    );
    renderPage();
    await loaded();
    const [later, orphan] = items();
    expect(later?.getAttribute("data-tone")).toBe("info");
    expect(text(later)).toContain(
      "A later confirmation for this booking was taken by the email service. That doesn't mean the guest read it.",
    );
    // The badge still says how this one ended.
    expect(text(later?.querySelector(".tg-status"))).toBe("Failed");
    expect(text(orphan?.querySelector("h2"))).toBe("Booking email");
    expect(within(orphan as HTMLElement).queryByRole("link")).toBeNull();
    expect(text(orphan)).toContain("No booking");
  });

  it("shows a designed loading state, then the empty state", async () => {
    const read = deferred();
    stubApi(() => read.promise);
    renderPage();
    expect(text(status())).toBe("Loading email exceptions…");
    expect(document.querySelector(".ex-list--skeleton")?.getAttribute("aria-hidden")).toBe("true");
    read.release(json(200, { exceptions: [], nextBefore: null }));
    await screen.findByRole("heading", { level: 2, name: "No email exceptions" });
    expect(text(status())).toBe("No email exceptions.");
    expect(document.body.textContent).toContain(
      "Every email Demo Harbor Charters sent was taken by the email service, or is still being tried.",
    );
    expect(items()).toEqual([]);
  });

  it("shows a designed error with Try again, and focuses the heading once it works", async () => {
    let n = 0;
    const calls = stubApi(() => {
      n += 1;
      return n === 1
        ? apiError(503, "unavailable")
        : json(200, { exceptions: [], nextBefore: null });
    });
    renderPage();
    await screen.findByText("Email exceptions didn't load");
    const retry = screen.getByRole("button", { name: "Try again" });
    retry.focus();
    fireEvent.click(retry);
    await screen.findByRole("heading", { level: 2, name: "No email exceptions" });
    await waitFor(() =>
      expect(document.activeElement).toBe(
        screen.getByRole("heading", { level: 1, name: "Email exceptions" }),
      ),
    );
    expect(reads(calls)).toHaveLength(2);
  });

  it.each([
    [401, "unauthenticated", "You're signed out", "Sign in again"],
    [403, "forbidden", "Your role can't see email exceptions", null],
    [404, "tenant_not_found", "You no longer have access to this operator", null],
  ])("explains a %i (%s) without Try again", async (statusCode, code, title, action) => {
    stubApi(() => apiError(statusCode, code));
    renderPage();
    await screen.findByText(title);
    expect(screen.queryByRole("button", { name: "Try again" })).toBeNull();
    if (action) expect(screen.getByRole("link", { name: action })).toBeTruthy();
  });

  it("treats an answer it cannot read as an error, not as an empty list", async () => {
    stubApi(() =>
      json(200, { exceptions: [emailException({ state: "sent" as never })], nextBefore: null }),
    );
    renderPage();
    await screen.findByText("Email exceptions couldn't be shown");
    expect(items()).toEqual([]);
  });

  it("treats a negative attempt count as an answer it cannot read", async () => {
    stubApi(() => json(200, { exceptions: [emailException({ attempts: -1 })], nextBefore: null }));
    renderPage();
    await screen.findByText("Email exceptions couldn't be shown");
    expect(items()).toEqual([]);
  });

  it("loads older exceptions with the cursor, says when that fails, and keeps the person's place", async () => {
    const first = emailException();
    const older = emailException({ failedAt: "2026-11-01T14:00:00.000Z" });
    let olderFails = true;
    const asked: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = new URL(String(input), "http://localhost:5184");
        asked.push(`${url.pathname}${url.search}`);
        if (!url.searchParams.has("before")) {
          return json(200, { exceptions: [first], nextBefore: first.id });
        }
        if (olderFails) {
          olderFails = false;
          throw new TypeError("Failed to fetch");
        }
        return json(200, { exceptions: [older], nextBefore: null });
      }),
    );
    renderPage();
    await loaded();
    expect(text(status())).toBe("1 email exception shown, with older ones to load.");
    fireEvent.click(screen.getByRole("button", { name: "Show older email exceptions" }));
    await screen.findByText("Older email exceptions didn't load");
    const retry = screen.getByRole("button", { name: "Try again" });
    retry.focus();
    fireEvent.click(retry);
    await waitFor(() => expect(items()).toHaveLength(2));
    expect(asked).toEqual([
      `${exceptionsPath}?limit=50`,
      `${exceptionsPath}?limit=50&before=${first.id}`,
      `${exceptionsPath}?limit=50&before=${first.id}`,
    ]);
    // The button went with the last page: the first older exception takes focus.
    await waitFor(() =>
      expect(document.activeElement).toBe(document.getElementById(`email-exception-${older.id}`)),
    );
    expect(screen.queryByRole("button", { name: /older/ })).toBeNull();
  });

  it("gives finance a designed refusal and asks the API nothing", async () => {
    const calls = stubApi(() => json(200, { exceptions: [], nextBefore: null }));
    renderPage("finance");
    expect(
      screen.getByRole("heading", { level: 2, name: "Your role can't see email exceptions" }),
    ).toBeTruthy();
    expect(document.body.textContent).toContain("Your role, finance, sees bookings");
    expect(screen.getByRole("link", { name: "Go to bookings" }).getAttribute("href")).toBe(
      "/bookings",
    );
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(calls).toEqual([]);
  });

  it("puts every control in the tab order: each booking link and the older button", async () => {
    stubApi(() =>
      json(200, {
        exceptions: [
          emailException(),
          emailException({ kind: "waiver", template: "waiver_request" }),
        ],
        nextBefore: "00000000-0000-4000-9000-000000000999",
      }),
    );
    renderPage();
    await loaded();
    const controls = [
      ...screen.getAllByRole("link"),
      screen.getByRole("button", { name: "Show older email exceptions" }),
    ];
    expect(controls).toHaveLength(3);
    for (const control of controls) {
      expect(control.tabIndex).toBeGreaterThanOrEqual(0);
      expect(control.closest("[aria-hidden='true']")).toBeNull();
    }
  });
});

describe("the console's email exceptions entry (W1-EMAIL-EXC)", () => {
  const consoleNav = () => screen.getByRole("navigation", { name: "Console" });

  it("reads /email-exceptions as the page, and nothing under it", () => {
    expect(routeOf("/email-exceptions")).toEqual({ kind: "email_exceptions" });
    expect(routeOf("/email-exceptions/1")).toEqual({ kind: "not_found" });
    expect(routeOf("/Email-exceptions")).toEqual({ kind: "not_found" });
  });

  it.each(["owner", "booking_staff"] as const)(
    "gives %s a navigation entry that opens the list in place",
    async (role) => {
      const calls = stubApi(() => json(200, { exceptions: [], nextBefore: null }));
      window.history.replaceState(null, "", "/");
      render(<ConsoleShell me={me(role)} signOut={<button type="button">Sign out</button>} />);
      const link = within(consoleNav()).getByRole("link", { name: "Email exceptions" });
      expect(link.getAttribute("href")).toBe("/email-exceptions");
      fireEvent.click(link);
      await screen.findByRole("heading", { level: 2, name: "No email exceptions" });
      expect(window.location.pathname).toBe("/email-exceptions");
      expect(link.getAttribute("aria-current")).toBe("page");
      expect(document.title).toBe("Email exceptions · Demo Harbor Charters · TideGrid");
      expect(reads(calls)).toHaveLength(1);
    },
  );

  it("gives finance no navigation entry, and the address a refusal with no request", async () => {
    const calls = stubApi(() => json(200, { exceptions: [], nextBefore: null }));
    window.history.replaceState(null, "", "/email-exceptions");
    render(<ConsoleShell me={me("finance")} signOut={<button type="button">Sign out</button>} />);
    expect(within(consoleNav()).queryByRole("link", { name: "Email exceptions" })).toBeNull();
    expect(within(consoleNav()).getByRole("link", { name: "Exceptions" })).toBeTruthy();
    await screen.findByRole("heading", { level: 2, name: "Your role can't see email exceptions" });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(calls).toEqual([]);
  });
});
