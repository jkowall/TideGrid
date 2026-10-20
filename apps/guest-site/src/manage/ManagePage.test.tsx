// @vitest-environment jsdom

// The guest is in Tokyo and the marina in New York: every time on the page
// must be the marina's.
process.env.TZ = "Asia/Tokyo";

import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { StrictMode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { brand, held, inOrder, json, offline, refusal, testNow } from "../booking/fixtures.ts";
import { NavigationProvider } from "../navigation.tsx";
import {
  answers,
  booker,
  callsTo,
  canceledBooking,
  linkToken,
  type ManageCall,
  managedBooking,
  reference,
  server,
  sessionToken,
  storedCheckoutSession,
  storedSession,
  strayRequests,
  stubManageApi,
  terms,
  withTerms,
} from "./fixtures.ts";
import { ManagePage } from "./ManagePage.tsx";
import { loadSession, storeSession } from "./session.ts";

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const storageKey = "tidegrid.manage.v1";
/** The page's address with no fragment: where the email's link leaves it once the page takes the token out. */
const cleanAddress = "http://localhost:3000/manage";

/** Text with every kind of space as a plain space. */
const text = (element: Element | null | undefined) =>
  (element?.textContent ?? "").replace(/\s+/g, " ").trim();

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(testNow);
  window.sessionStorage.clear();
  window.localStorage.clear();
  window.history.replaceState(null, "", "/manage");
});

afterEach(() => {
  const strays = strayRequests();
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  expect(strays).toEqual([]);
});

type Options = { focusOnArrival?: boolean; strict?: boolean };

function renderPage(address = "/manage", options: Options = {}) {
  window.history.replaceState(null, "", address);
  const navigate = vi.fn();
  const page = (
    <NavigationProvider navigate={navigate}>
      <ManagePage brand={brand} focusOnArrival={options.focusOnArrival ?? false} />
    </NavigationProvider>
  );
  render(options.strict ? <StrictMode>{page}</StrictMode> : page);
  return { navigate };
}

/** The page as the email's link opens it: the token in the address's fragment. */
const arrive = (options: Options = {}) => renderPage(`/manage#t=${linkToken}`, options);

const heading = (name: string | RegExp) => screen.findByRole("heading", { name });
const openButton = () => screen.findByRole("button", { name: "Open my booking" });
const booked = () => screen.findByRole("heading", { level: 1, name: "Sunset Harbor Cruise" });

type Routes = Parameters<typeof stubManageApi>[0];
type Stub = Parameters<typeof stubManageApi>[1];

/** The booking open in this tab, as a reload shows it: from a session already stored. */
async function shown(routes: Routes = {}, options: Stub = {}, session = storedSession()) {
  const calls = stubManageApi(routes, options);
  storeSession(session);
  renderPage("/manage");
  await booked();
  return calls;
}

/** The booking the guest opens from the email, step by step, as the landing page leads. */
async function openedFromLink(routes: Routes = {}, options: Stub = {}) {
  const calls = stubManageApi(routes, options);
  arrive();
  fireEvent.click(await openButton());
  await booked();
  return calls;
}

const card = (name: string) => screen.getByRole("region", { name });
const badges = () => [...document.querySelectorAll(".tg-status")].map((badge) => text(badge));

/** A description list's term, and the value beside it. */
const termValue = (list: Element, term: string) =>
  [...list.querySelectorAll("dt")].find((dt) => text(dt) === term)?.nextElementSibling ?? null;

/** The receipt's rows as they read: label, detail, amount. */
const receiptRows = () =>
  within(screen.getByRole("table", { name: "Receipt in US dollars" }))
    .getAllByRole("row")
    .map((row) =>
      [...row.querySelectorAll(".tg-ledger__label, .tg-ledger__detail, .tg-ledger__amount")]
        .map((cell) => text(cell))
        .join(" "),
    );

/** The party's places as they read: who, the line under the name, and the button. */
const party = () =>
  [...card("Who's coming").querySelectorAll("ol > li")].map((li) => [
    text(li.querySelector(".manage-party__name")),
    text(li.querySelector(".manage-quiet")),
    text(li.querySelector("button")),
  ]);

/** A notice by its title, with its text. */
const noticeTitled = async (title: string) => {
  const notice = (await screen.findByText(title)).closest(".tg-notice");
  if (!notice) throw new Error(`no notice titled ${title}`);
  return notice;
};

const type = (field: HTMLElement, value: string) => fireEvent.change(field, { target: { value } });

/**
 * A party place's button, by its verb and place. The place is visually hidden
 * text after the verb: a browser reads "Edit guest 1", but jsdom has no
 * stylesheet to make that text a block, so it joins the verb without the space.
 */
const placeButton = (verb: "Add" | "Edit", position: number) =>
  new RegExp(`^${verb} ?guest ${position}$`);
/** Any place's button. Checked with queryByRole, so it must not miss one that is there. */
const anyPlaceButton = /^(Add|Edit) ?guest \d+$/;

async function openEditor(position: number, verb: "Add" | "Edit" = "Add") {
  fireEvent.click(screen.getByRole("button", { name: placeButton(verb, position) }));
  return screen.findByRole("textbox", { name: "Full name" });
}
const saveGuest = (position: number) =>
  fireEvent.click(screen.getByRole("button", { name: `Save guest ${position}` }));

async function askToCancel() {
  fireEvent.click(
    within(card("Cancel this booking")).getByRole("button", { name: "Cancel booking" }),
  );
  return screen.findByRole("dialog", { name: `Cancel booking ${reference}?` });
}
const confirmCancel = (dialog: HTMLElement) =>
  fireEvent.click(within(dialog).getByRole("button", { name: "Cancel booking" }));

const sessionAnswer = () =>
  json(
    {
      session: { token: sessionToken, expiresAt: new Date(Date.now() + 3_600_000).toISOString() },
      booking: { reference },
    },
    201,
  );

/** Every call, as "METHOD /path". */
const paths = (calls: ManageCall[]) => calls.map((c) => `${c.method} ${c.path}`);

// Arriving ------------------------------------------------------------------------------------

describe("arriving from the email's link", () => {
  it("asks the guest to open the booking, and says what that does", async () => {
    stubManageApi();
    arrive();
    const title = await heading("Open your booking");
    expect(title.tagName).toBe("H1");
    expect(text(document.querySelector(".booking-outcome__body > p"))).toBe(
      "This link opens your booking with Demo Harbor Charters: see your trip and receipt, name everyone coming, or cancel within the policy.",
    );
    expect(screen.getByRole("button", { name: "Open my booking" })).toBeTruthy();
    expect(text(document.querySelector(".manage-quiet"))).toBe(
      "For your security the link works once, for three days. Opening it here signs this browser tab in for an hour.",
    );
    await waitFor(() => expect(document.title).toBe("Open your booking · Demo Harbor Charters"));
  });

  it("takes the token out of the address before any request, and adds no history entry", async () => {
    const calls = stubManageApi();
    const entries = window.history.length;
    arrive();
    await openButton();
    expect(window.location.hash).toBe("");
    expect(window.location.href).toBe(cleanAddress);
    expect(window.history.length).toBe(entries);
    expect(calls).toHaveLength(0);
    // Nowhere on the page, either: the token is kept in memory.
    expect(document.documentElement.outerHTML).not.toContain(linkToken);
    expect(document.title).not.toContain(linkToken);
  });

  it("has taken the token out of the address by every request it sends", async () => {
    const calls = await openedFromLink();
    expect(calls.length).toBeGreaterThanOrEqual(2);
    for (const call of calls) expect(call.address).toBe(cleanAddress);
    expect(window.location.hash).toBe("");
  });

  it("keeps the path and the query when it takes the fragment out", async () => {
    stubManageApi();
    renderPage(`/manage?from=email#t=${linkToken}`);
    await openButton();
    expect(window.location.href).toBe(`${cleanAddress}?from=email`);
  });

  it("sends no request until the guest presses the button, as a mail scanner's visit would not", async () => {
    const calls = stubManageApi();
    arrive();
    await openButton();
    // Give an effect that sent a request time to send it.
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(calls).toHaveLength(0);
    expect(window.sessionStorage.length).toBe(0);
    fireEvent.click(screen.getByRole("button", { name: "Open my booking" }));
    await booked();
    expect(callsTo(calls, "open")).toHaveLength(1);
  });

  it("keeps the token in memory only: nothing is stored until the booking opens", async () => {
    stubManageApi();
    arrive();
    await openButton();
    expect(window.sessionStorage.length).toBe(0);
    expect(window.localStorage.length).toBe(0);
    expect(document.cookie).toBe("");
  });

  it("works when React runs every effect twice, as it does in development", async () => {
    const calls = stubManageApi();
    arrive({ strict: true });
    fireEvent.click(await openButton());
    await booked();
    expect(window.location.href).toBe(cleanAddress);
    expect(callsTo(calls, "open")).toHaveLength(1);
    expect(callsTo(calls, "open")[0]?.body).toEqual({ token: linkToken });
  });

  it("puts a link in the address before a session stored in the tab, and asks first", async () => {
    const calls = stubManageApi();
    storeSession(storedSession());
    arrive();
    expect(await heading("Open your booking")).toBeTruthy();
    expect(calls).toHaveLength(0);
  });

  it("focuses the page's heading on arrival when asked to, and leaves focus alone otherwise", async () => {
    stubManageApi();
    arrive({ focusOnArrival: true });
    const title = await heading("Open your booking");
    await waitFor(() => expect(document.activeElement).toBe(title));
    cleanup();
    arrive({ focusOnArrival: false });
    const again = await heading("Open your booking");
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(document.activeElement).not.toBe(again);
  });

  it("says where the email's button is when there is no link and no session", async () => {
    const calls = stubManageApi();
    const { navigate } = renderPage("/manage");
    const title = await heading("Open your booking from your email");
    expect(title.tagName).toBe("H1");
    expect(text(document.querySelector(".booking-outcome__body > p"))).toBe(
      "Your confirmation email from Demo Harbor Charters has a button that opens your booking here: to see your receipt, name your party, or cancel within the policy. No account needed.",
    );
    const back = screen.getByRole("link", { name: "Back to trips" });
    expect(back.getAttribute("href")).toBe("/");
    fireEvent.click(back);
    expect(navigate).toHaveBeenCalledWith("/");
    expect(calls).toHaveLength(0);
    await waitFor(() =>
      expect(document.title).toBe("Open your booking from your email · Demo Harbor Charters"),
    );
  });

  it.each([
    ["a token that is too short", "#t=short"],
    ["a token that is too long", `#t=${linkToken}x`],
    ["a token with a character outside base64url", `#t=+${linkToken.slice(1)}`],
    ["another fragment", "#top"],
    ["a query where the fragment goes", `?t=${linkToken}`],
  ])("treats %s as no link, and still takes it out of the address", async (_what, tail) => {
    const calls = stubManageApi();
    renderPage(`/manage${tail}`);
    expect(await heading("Open your booking from your email")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Open my booking" })).toBeNull();
    expect(calls).toHaveLength(0);
    expect(window.location.hash).toBe("");
  });

  it("opens a booking from a session still stored in the tab, with no link", async () => {
    const calls = await shown();
    expect(paths(calls)).toEqual(["GET /v1/public/manage/booking"]);
    expect(calls[0]?.headers.get("authorization")).toBe(`Bearer ${sessionToken}`);
  });

  it("drops a stored session that has passed its expiry by the device's clock, and asks for the link", async () => {
    const calls = stubManageApi();
    storeSession(storedSession({ expiresAt: new Date(Date.now() - 1).toISOString() }));
    renderPage("/manage");
    expect(await heading("Open your booking from your email")).toBeTruthy();
    expect(calls).toHaveLength(0);
    expect(window.sessionStorage.getItem(storageKey)).toBeNull();
  });
});

// Opening ------------------------------------------------------------------------------------

describe("opening the booking", () => {
  it("exchanges the link's token for a session in a POST body, and sends nothing else", async () => {
    const calls = await openedFromLink();
    const [open] = callsTo(calls, "open");
    expect(open?.method).toBe("POST");
    expect(open?.path).toBe("/v1/public/booking-access");
    expect(open?.search.toString()).toBe("");
    expect(open?.body).toEqual({ token: linkToken });
    expect(open?.headers.get("authorization")).toBeNull();
    expect(open?.headers.get("idempotency-key")).toBeNull();
    expect(open?.headers.get("content-type")).toBe("application/json");
    expect(open?.cache).toBe("no-store");
    expect(open?.referrerPolicy).toBe("no-referrer");
  });

  it("says it is opening while the API answers, and sends one request however often it is pressed", async () => {
    const answer = held();
    const calls = stubManageApi({ open: answer.answer });
    arrive();
    const button = await openButton();
    fireEvent.click(button);
    await waitFor(() => expect(button.getAttribute("aria-busy")).toBe("true"));
    expect(text(button)).toBe("Opening…");
    fireEvent.click(button);
    fireEvent.click(button);
    expect(callsTo(calls, "open")).toHaveLength(1);
    answer.release(sessionAnswer());
    await booked();
    expect(callsTo(calls, "open")).toHaveLength(1);
  });

  it("stores the session for this tab, and reads the booking with it as a bearer token", async () => {
    const calls = await openedFromLink();
    expect(JSON.parse(window.sessionStorage.getItem(storageKey) ?? "null")).toEqual({
      token: sessionToken,
      expiresAt: new Date(testNow.getTime() + 3_600_000).toISOString(),
      reference,
      // The link it was opened with: used already, kept only to ask for a new one.
      linkToken,
    });
    expect(window.sessionStorage.length).toBe(1);
    expect(window.localStorage.length).toBe(0);
    expect(paths(calls)).toEqual([
      "POST /v1/public/booking-access",
      "GET /v1/public/manage/booking",
    ]);
    const [read] = callsTo(calls, "read");
    expect(read?.headers.get("authorization")).toBe(`Bearer ${sessionToken}`);
    expect(read?.body).toBeUndefined();
    expect(read?.search.toString()).toBe("");
  });

  it("uses the link once: the token is in one request body, and the session's in none", async () => {
    const calls = await openedFromLink();
    const body = (c: ManageCall) => JSON.stringify(c.body ?? "");
    expect(paths(calls.filter((c) => body(c).includes(linkToken)))).toEqual([
      "POST /v1/public/booking-access",
    ]);
    expect(calls.filter((c) => body(c).includes(sessionToken))).toHaveLength(0);
  });

  it("shows the booking in the guest's own words and takes focus to its heading", async () => {
    await openedFromLink();
    const title = await booked();
    await waitFor(() => expect(document.activeElement).toBe(title));
    expect(text(document.querySelector(".booking-hero__eyebrow"))).toBe("Your booking");
    expect(text(document.querySelector(".booking-hero__when"))).toBe(
      "Wednesday, October 7, 6:00 PM",
    );
    expect(badges()).toEqual(["Confirmed"]);
    expect(text(document.querySelector(".manage-status__ref"))).toBe("Reference C03G4ZFJ");
    await waitFor(() => expect(document.title).toBe("Booking C03G4ZFJ · Demo Harbor Charters"));
    expect(screen.queryByRole("button", { name: "Open my booking" })).toBeNull();
    expect(screen.getByRole("link", { name: "All trips" }).getAttribute("href")).toBe("/");
  });

  it("shows the trip on the marina's clock, where to meet, and who booked", async () => {
    await openedFromLink();
    const trip = card("The trip");
    // 6:00 PM in New York, which is already the next morning in Tokyo.
    expect(text(termValue(trip, "When"))).toBe(
      "Wednesday, October 7, 6:00 PM (1 h 30 min, New York time)",
    );
    const meet = termValue(trip, "Meet at");
    expect(text(meet)).toContain("Dock C, slip 14, Harbor Marina, Dock C");
    expect(text(meet?.querySelector(".manage-block"))).toBe(
      "Check in at the dock office 20 minutes before departure.",
    );
    const by = termValue(trip, "Booked by");
    expect(text(by)).toContain(booker.name);
    expect(text(by?.querySelector(".manage-block"))).toBe(booker.email);
  });

  it("leaves out the meeting point's parts the operator did not give", async () => {
    await openedFromLink(
      {},
      {
        booking: managedBooking({
          location: { name: "Harbor Marina, Dock C", meetingPoint: "", meetingInstructions: "" },
        }),
      },
    );
    const meet = termValue(card("The trip"), "Meet at");
    expect(text(meet)).toBe("Harbor Marina, Dock C");
    expect(meet?.querySelector(".manage-block")).toBeNull();
  });

  it("shows the receipt as the order holds it, the total paid, and says the payment was a test", async () => {
    await openedFromLink();
    expect(receiptRows()).toEqual([
      "Adult 2 × $45.00 $90.00",
      "Child (3 to 12) 1 × $25.00 $25.00",
      "Souvenir photo 1 × $12.00 $12.00",
      "Drink voucher 2 × $8.00 $16.00",
      "Harbor fee 3 × $2.50 $7.50",
      "County surtax 1% $1.43",
      "State sales tax 6% $8.58",
      "Total paid $160.51",
    ]);
    expect(text(card("Receipt").querySelector("p.manage-quiet"))).toBe(
      "Paid with a test payment ($160.51). This is a demo: no real card was charged.",
    );
    expect(card("Receipt").querySelector(".manage-refund")).toBeNull();
  });

  it("shows the party: who is named, who is not, and how many", async () => {
    await openedFromLink();
    expect(party()).toEqual([
      ["Guest 1: Ava Guest", "Adult", "Edit guest 1"],
      ["Guest 2: Theo Guest", "Under 18. Guardian: Ava Guest", "Edit guest 2"],
      ["Guest 3: Not named yet", "", "Add guest 3"],
    ]);
    expect(text(card("Who's coming").querySelector(".manage-card__head .manage-quiet"))).toBe(
      "2 of 3 named",
    );
    expect(text(card("Who's coming").querySelector(":scope > p"))).toBe(
      "Add the name of each person in your party, so Demo Harbor Charters knows who's coming. A guest under 18 needs a parent or guardian.",
    );
  });

  it("shows a loading state while the booking is read, then the booking", async () => {
    const read = held();
    stubManageApi({ read: read.answer });
    storeSession(storedSession());
    renderPage("/manage");
    expect(text(screen.getByRole("status"))).toBe("Loading your booking…");
    expect(document.querySelector('[aria-busy="true"]')).toBeTruthy();
    read.release(
      json({ booking: server.booking, session: { expiresAt: new Date(Date.now()).toISOString() } }),
    );
    expect(await booked()).toBeTruthy();
    expect(screen.queryByText("Loading your booking…")).toBeNull();
  });

  it("says plainly when the booking did not load, and tries again on request", async () => {
    const calls = stubManageApi({ read: inOrder(offline, answers.read) });
    storeSession(storedSession());
    renderPage("/manage");
    const title = await heading("Your booking didn't load");
    expect(title.tagName).toBe("H1");
    expect(text(document.querySelector(".booking-outcome__body p"))).toBe(
      "We couldn't reach the booking site. Check your connection and try again.",
    );
    // The session is kept: nothing says it ended.
    expect(window.sessionStorage.getItem(storageKey)).not.toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(await booked()).toBeTruthy();
    expect(callsTo(calls, "read")).toHaveLength(2);
    for (const read of callsTo(calls, "read")) {
      expect(read.headers.get("authorization")).toBe(`Bearer ${sessionToken}`);
    }
  });

  it("shows Trying while it tries again", async () => {
    const retry = held();
    stubManageApi({ read: inOrder(offline, retry.answer) });
    storeSession(storedSession());
    renderPage("/manage");
    await heading("Your booking didn't load");
    const again = screen.getByRole("button", { name: "Try again" });
    fireEvent.click(again);
    await waitFor(() => expect(again.getAttribute("aria-busy")).toBe("true"));
    expect(text(again)).toBe("Trying…");
    retry.release(json({ booking: server.booking, session: { expiresAt: testNow.toISOString() } }));
    expect(await booked()).toBeTruthy();
  });

  it.each([
    ["a server error", () => refusal(500, "internal_error")],
    [
      "an answer that breaks the contract",
      () => json({ booking: { ...managedBooking(), state: "frozen" } }),
    ],
    ["an answer with no booking", () => json({})],
  ])("treats %s as a booking that did not load, and keeps the session", async (_what, answer) => {
    stubManageApi({ read: answer });
    storeSession(storedSession());
    renderPage("/manage");
    expect(await heading("Your booking didn't load")).toBeTruthy();
    expect(window.sessionStorage.getItem(storageKey)).not.toBeNull();
    expect(screen.queryByRole("heading", { name: "Your session has ended" })).toBeNull();
  });
});

// A link that does not open ------------------------------------------------------------------------

describe("a link that does not open the booking", () => {
  const generic = "Something went wrong on our side. Try again in a moment.";

  it.each([
    [410, "link_used", "This link was already used", /^Each link opens your booking once/],
    [410, "link_expired", "This link has expired", /^Links work for three days/],
    [
      410,
      "link_superseded",
      "A newer email replaced this link",
      /^Use the link in your most recent email/,
    ],
    [410, "link_revoked", "This link no longer works", /^Ask for a new one/],
  ] as const)(
    "shows its own screen for %i %s, and offers a new link",
    async (status, code, title, body) => {
      const calls = stubManageApi({ open: () => refusal(status, code) });
      arrive();
      fireEvent.click(await openButton());
      const h1 = await heading(title);
      expect(h1.tagName).toBe("H1");
      expect(text(document.querySelector(".booking-outcome__body > p"))).toMatch(body);
      const renew = screen.getByRole("button", { name: "Email me a new link" });
      expect(renew.className).toContain("tg-button--primary");
      expect(screen.queryByRole("button", { name: "Open my booking" })).toBeNull();
      expect(screen.queryByRole("button", { name: "Back to my booking" })).toBeNull();
      expect(screen.queryByRole("link", { name: /^Call/ })).toBeNull();
      await waitFor(() => expect(document.activeElement).toBe(h1));
      await waitFor(() => expect(document.title).toBe(`${title} · Demo Harbor Charters`));
      // Nothing was stored, and only the one request went.
      expect(window.sessionStorage.length).toBe(0);
      expect(paths(calls)).toEqual(["POST /v1/public/booking-access"]);
    },
  );

  it("says a link that names no booking here doesn't open one, and offers the operator, not a new link", async () => {
    const calls = stubManageApi({ open: () => refusal(404, "link_not_found") });
    arrive();
    fireEvent.click(await openButton());
    const h1 = await heading("This link doesn't open a booking here");
    expect(h1.tagName).toBe("H1");
    expect(text(document.querySelector(".booking-outcome__body > p"))).toBe(
      "Check that you opened the whole link from your email. If it still doesn't work, contact Demo Harbor Charters.",
    );
    expect(screen.queryByRole("button", { name: "Email me a new link" })).toBeNull();
    const call = screen.getByRole("link", { name: "Call (305) 555-0142" });
    expect(call.getAttribute("href")).toBe("tel:+13055550142");
    expect(call.className).toContain("tg-button--primary");
    expect(screen.getByRole("link", { name: "Email instead" }).getAttribute("href")).toBe(
      "mailto:hello@demo-harbor.test",
    );
    expect(window.sessionStorage.length).toBe(0);
    expect(paths(calls)).toEqual(["POST /v1/public/booking-access"]);
  });

  it("posts the renewal with the link's token when asked for a new link, and says to check the email", async () => {
    const calls = stubManageApi({ open: () => refusal(410, "link_used") });
    arrive();
    fireEvent.click(await openButton());
    await heading("This link was already used");
    fireEvent.click(screen.getByRole("button", { name: "Email me a new link" }));
    const notice = await noticeTitled("Check your email");
    expect(text(notice)).toContain(
      "If this link belongs to a booking here, we've sent a new one to the email address it was booked with. It can take a minute to arrive.",
    );
    expect(notice.getAttribute("role")).toBe("status");
    const [renewal] = callsTo(calls, "renew");
    expect(renewal?.method).toBe("POST");
    expect(renewal?.path).toBe("/v1/public/booking-access/renewals");
    expect(renewal?.search.toString()).toBe("");
    expect(renewal?.body).toEqual({ token: linkToken });
    expect(renewal?.headers.get("authorization")).toBeNull();
    // Asked for once: the button is gone, so the same ask cannot go twice.
    expect(screen.queryByRole("button", { name: "Email me a new link" })).toBeNull();
    expect(callsTo(calls, "renew")).toHaveLength(1);
    expect(window.location.href).toBe(cleanAddress);
  });

  it("shows Sending while the new link is asked for, and sends one request", async () => {
    const answer = held();
    const calls = stubManageApi({ open: () => refusal(410, "link_expired"), renew: answer.answer });
    arrive();
    fireEvent.click(await openButton());
    await heading("This link has expired");
    const renew = screen.getByRole("button", { name: "Email me a new link" });
    fireEvent.click(renew);
    await waitFor(() => expect(renew.getAttribute("aria-busy")).toBe("true"));
    expect(text(renew)).toBe("Sending…");
    fireEvent.click(renew);
    expect(callsTo(calls, "renew")).toHaveLength(1);
    answer.release(json({ status: "accepted" }, 202));
    expect(await noticeTitled("Check your email")).toBeTruthy();
  });

  it.each([
    ["no answer", offline],
    ["a rate limit", () => refusal(429, "rate_limited")],
    ["a server error", () => refusal(500, "internal_error")],
  ])(
    "says so, and keeps the button, when %s came to asking for a new link; a second try goes with the same token",
    async (_what, answer) => {
      const calls = stubManageApi({
        open: () => refusal(410, "link_expired"),
        renew: inOrder(answer, answers.renew),
      });
      arrive();
      fireEvent.click(await openButton());
      await heading("This link has expired");
      fireEvent.click(screen.getByRole("button", { name: "Email me a new link" }));
      const alert = await screen.findByRole("alert");
      expect(text(alert)).toContain("We couldn't send a new link");
      expect(text(alert)).toContain("Check your connection and try again in a minute.");
      fireEvent.click(screen.getByRole("button", { name: "Email me a new link" }));
      expect(await noticeTitled("Check your email")).toBeTruthy();
      expect(screen.queryByRole("alert")).toBeNull();
      expect(callsTo(calls, "renew").map((c) => c.body)).toEqual([
        { token: linkToken },
        { token: linkToken },
      ]);
    },
  );

  it("offers a way back to the booking this tab has open, when the link opens no other", async () => {
    const calls = stubManageApi({ open: () => refusal(410, "link_used") });
    storeSession(storedSession());
    arrive();
    fireEvent.click(await openButton());
    await heading("This link was already used");
    const back = screen.getByRole("button", { name: "Back to my booking" });
    expect(back.className).toContain("tg-button--primary");
    // With a booking to go back to, asking for a new link is the secondary action.
    expect(screen.getByRole("button", { name: "Email me a new link" }).className).toContain(
      "tg-button--secondary",
    );
    fireEvent.click(back);
    expect(await booked()).toBeTruthy();
    expect(paths(calls)).toEqual([
      "POST /v1/public/booking-access",
      "GET /v1/public/manage/booking",
    ]);
    expect(callsTo(calls, "read")[0]?.headers.get("authorization")).toBe(`Bearer ${sessionToken}`);
  });

  it("offers the way back beside the operator's contact when the link names no booking here", async () => {
    stubManageApi({ open: () => refusal(404, "link_not_found") });
    storeSession(storedSession());
    arrive();
    fireEvent.click(await openButton());
    await heading("This link doesn't open a booking here");
    expect(screen.getByRole("button", { name: "Back to my booking" })).toBeTruthy();
    expect(screen.getByRole("link", { name: "Call (305) 555-0142" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Email me a new link" })).toBeNull();
  });

  it.each([
    [
      "no answer",
      offline,
      "We couldn't reach the booking site. Check your connection and try again.",
    ],
    [
      "a rate limit",
      () => refusal(429, "rate_limited"),
      "That was a lot of tries in a short time. Wait a minute, then try again.",
    ],
    ["a server error", () => refusal(500, "internal_error"), generic],
    ["a refusal it has no screen for", () => refusal(400, "invalid_request"), generic],
    [
      "an answer that breaks the contract",
      () => json({ session: { token: "short" } }, 201),
      generic,
    ],
  ])(
    "stays on the button, saying why, after %s, and tries again with the same token",
    async (_what, answer, why) => {
      const calls = stubManageApi({ open: inOrder(answer, answers.open) });
      arrive();
      fireEvent.click(await openButton());
      const notice = await noticeTitled("Your booking didn't open");
      expect(text(notice)).toContain(why);
      expect(notice.getAttribute("role")).toBe("alert");
      expect(screen.getByRole("heading", { level: 1 }).textContent).toBe("Open your booking");
      expect(window.sessionStorage.length).toBe(0);
      const button = screen.getByRole("button", { name: "Open my booking" });
      expect(button.getAttribute("aria-busy")).toBeNull();
      fireEvent.click(button);
      expect(await booked()).toBeTruthy();
      expect(callsTo(calls, "open").map((c) => c.body)).toEqual([
        { token: linkToken },
        { token: linkToken },
      ]);
      expect(window.location.href).toBe(cleanAddress);
    },
  );
});

// A session that has ended ----------------------------------------------------------------------------

describe("a session that has ended", () => {
  const endedBody =
    "For your security, a booking stays open for an hour. Nothing changed on your booking. To open it again, ask for a new link.";

  it("shows the ended screen when the API says the session is over on a read, and clears the tab", async () => {
    stubManageApi({ read: () => refusal(401, "session_expired") });
    storeSession(storedSession());
    renderPage("/manage");
    const h1 = await heading("Your session has ended");
    expect(h1.tagName).toBe("H1");
    expect(text(document.querySelector(".booking-outcome__body > p"))).toBe(endedBody);
    expect(window.sessionStorage.getItem(storageKey)).toBeNull();
    expect(loadSession()).toBeNull();
    expect(screen.queryByRole("heading", { name: "Sunset Harbor Cruise" })).toBeNull();
    await waitFor(() => expect(document.activeElement).toBe(h1));
    await waitFor(() =>
      expect(document.title).toBe("Your session has ended · Demo Harbor Charters"),
    );
  });

  it("offers a new link, asked for with the link the session was opened with", async () => {
    const calls = stubManageApi({ read: () => refusal(401, "session_expired") });
    storeSession(storedSession());
    renderPage("/manage");
    await heading("Your session has ended");
    fireEvent.click(screen.getByRole("button", { name: "Email me a new link" }));
    expect(await noticeTitled("Check your email")).toBeTruthy();
    expect(paths(calls)).toEqual([
      "GET /v1/public/manage/booking",
      "POST /v1/public/booking-access/renewals",
    ]);
    expect(callsTo(calls, "renew")[0]?.body).toEqual({ token: linkToken });
    expect(screen.queryByRole("button", { name: "Email me a new link" })).toBeNull();
  });

  it("sends a guest whose session came from the checkout to the email's button, as no link is kept", async () => {
    const calls = stubManageApi({ read: () => refusal(401, "session_expired") });
    storeSession(storedCheckoutSession());
    renderPage("/manage");
    await heading("Your session has ended");
    expect(screen.queryByRole("button", { name: "Email me a new link" })).toBeNull();
    expect(text(document.querySelector(".booking-outcome__body"))).toContain(
      "Use the button in your confirmation email from Demo Harbor Charters.",
    );
    expect(callsTo(calls, "renew")).toHaveLength(0);
  });

  it("ends a session the API ended as soon as it was opened, and offers the link just used", async () => {
    const calls = stubManageApi({ read: () => refusal(401, "session_expired") });
    arrive();
    fireEvent.click(await openButton());
    await heading("Your session has ended");
    expect(window.sessionStorage.getItem(storageKey)).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Email me a new link" }));
    await noticeTitled("Check your email");
    expect(callsTo(calls, "renew")[0]?.body).toEqual({ token: linkToken });
  });

  it("closes the booking on this device when asked: the session ends, the tab forgets it", async () => {
    const calls = await shown();
    const close = screen.getByRole("button", { name: "Close my booking on this device" });
    fireEvent.click(close);
    const h1 = await heading("Your booking is closed on this device");
    expect(h1.tagName).toBe("H1");
    expect(text(document.querySelector(".booking-outcome__body > p"))).toBe(
      "Nothing changed on your booking. To open it again, ask for a new link.",
    );
    const [end] = callsTo(calls, "end");
    expect(end?.method).toBe("POST");
    expect(end?.path).toBe("/v1/public/manage/session/end");
    expect(end?.headers.get("authorization")).toBe(`Bearer ${sessionToken}`);
    expect(end?.body).toBeUndefined();
    expect(window.sessionStorage.getItem(storageKey)).toBeNull();
    // The link it was opened with can still ask for a new one.
    fireEvent.click(screen.getByRole("button", { name: "Email me a new link" }));
    await noticeTitled("Check your email");
    expect(callsTo(calls, "renew")[0]?.body).toEqual({ token: linkToken });
  });

  it("closes the booking on this device even when the API did not answer", async () => {
    await shown({ end: offline });
    fireEvent.click(screen.getByRole("button", { name: "Close my booking on this device" }));
    expect(await heading("Your booking is closed on this device")).toBeTruthy();
    expect(window.sessionStorage.getItem(storageKey)).toBeNull();
  });

  it("shows Closing while the API answers", async () => {
    const answer = held();
    await shown({ end: answer.answer });
    const close = screen.getByRole("button", { name: "Close my booking on this device" });
    fireEvent.click(close);
    await waitFor(() => expect(close.getAttribute("aria-busy")).toBe("true"));
    expect(text(close)).toBe("Closing…");
    answer.release(json({ ended: true }));
    expect(await heading("Your booking is closed on this device")).toBeTruthy();
  });
});

// Naming the party ------------------------------------------------------------------------------------

describe("naming the party", () => {
  it("opens one place's form with the name field focused, and sends nothing yet", async () => {
    const calls = await shown();
    const name = await openEditor(3);
    await waitFor(() => expect(document.activeElement).toBe(name));
    expect(screen.getByRole("group", { name: "Add guest 3" })).toBeTruthy();
    expect((name as HTMLInputElement).value).toBe("");
    expect(screen.getByRole("checkbox", { name: "Under 18 on the day of the trip" })).toBeTruthy();
    expect(screen.getByRole("textbox", { name: "Their email (optional)" })).toBeTruthy();
    expect(screen.queryByRole("textbox", { name: "Parent or guardian's full name" })).toBeNull();
    expect(callsTo(calls, "saveParticipant")).toHaveLength(0);
  });

  it("lets one place be edited at a time, and makes its Save the page's one primary action", async () => {
    await shown();
    await openEditor(3);
    expect(
      screen.getByRole("button", { name: placeButton("Edit", 1) }).getAttribute("aria-disabled"),
    ).toBe("true");
    expect(
      screen.getByRole("button", { name: placeButton("Edit", 2) }).getAttribute("aria-disabled"),
    ).toBe("true");
    const primary = [...document.querySelectorAll(".tg-button--primary")];
    expect(primary.map((button) => text(button))).toEqual(["Save guest 3"]);
  });

  it("names a place: a PUT with an Idempotency-Key, then the saved name in the party", async () => {
    const calls = await shown();
    const name = await openEditor(3);
    type(name, "  Ben Guest  ");
    saveGuest(3);
    const saved = await noticeTitled("Saved");
    expect(text(saved)).toContain("Ben Guest is guest 3.");
    const [put] = callsTo(calls, "saveParticipant");
    expect(put?.method).toBe("PUT");
    expect(put?.path).toBe("/v1/public/manage/participants/3");
    expect(put?.search.toString()).toBe("");
    expect(put?.body).toEqual({ name: "Ben Guest", isMinor: false, email: null, guardian: null });
    expect(put?.headers.get("idempotency-key")).toMatch(uuid);
    expect(put?.headers.get("authorization")).toBe(`Bearer ${sessionToken}`);
    // The booking is read again, so the party shows what the API holds.
    await waitFor(() =>
      expect(party()[2]).toEqual(["Guest 3: Ben Guest", "Adult", "Edit guest 3"]),
    );
    expect(callsTo(calls, "read")).toHaveLength(2);
    expect(text(card("Who's coming").querySelector(".manage-card__head .manage-quiet"))).toBe(
      "3 of 3 named",
    );
    // The form is gone, and keyboard focus is back on the place's own button.
    expect(screen.queryByRole("group", { name: "Add guest 3" })).toBeNull();
    await waitFor(() =>
      expect(document.activeElement).toBe(
        screen.getByRole("button", { name: placeButton("Edit", 3) }),
      ),
    );
  });

  it("sends a guest's own email when one is given, and the row shows it", async () => {
    const calls = await shown();
    const name = await openEditor(3);
    type(name, "Ben Guest");
    type(screen.getByRole("textbox", { name: "Their email (optional)" }), " ben@example.test ");
    saveGuest(3);
    await noticeTitled("Saved");
    expect(callsTo(calls, "saveParticipant")[0]?.body).toEqual({
      name: "Ben Guest",
      isMinor: false,
      email: "ben@example.test",
      guardian: null,
    });
    await waitFor(() =>
      expect(party()[2]).toEqual(["Guest 3: Ben Guest", "ben@example.test", "Edit guest 3"]),
    );
  });

  it("corrects a place in place: the form holds what was saved, and Save sends the corrected details", async () => {
    const calls = await shown();
    const name = await openEditor(1, "Edit");
    expect(screen.getByRole("group", { name: "Edit guest 1" })).toBeTruthy();
    expect((name as HTMLInputElement).value).toBe("Ava Guest");
    type(name, "Ava B. Guest");
    saveGuest(1);
    expect(text(await noticeTitled("Saved"))).toContain("Ava B. Guest is guest 1.");
    const [put] = callsTo(calls, "saveParticipant");
    expect(put?.path).toBe("/v1/public/manage/participants/1");
    expect(put?.body).toEqual({
      name: "Ava B. Guest",
      isMinor: false,
      email: null,
      guardian: null,
    });
    expect(put?.headers.get("idempotency-key")).toMatch(uuid);
    await waitFor(() =>
      expect(party()[0]).toEqual(["Guest 1: Ava B. Guest", "Adult", "Edit guest 1"]),
    );
    // Two of the three were named before, and still are.
    expect(text(card("Who's coming").querySelector(".manage-card__head .manage-quiet"))).toBe(
      "2 of 3 named",
    );
  });

  it("holds a minor's guardian in the form for editing, and sends no guardian once the guest says adult", async () => {
    const calls = await shown();
    const name = await openEditor(2, "Edit");
    expect((name as HTMLInputElement).value).toBe("Theo Guest");
    const minor = screen.getByRole("checkbox", { name: "Under 18 on the day of the trip" });
    expect((minor as HTMLInputElement).checked).toBe(true);
    expect(
      (screen.getByRole("textbox", { name: "Parent or guardian's full name" }) as HTMLInputElement)
        .value,
    ).toBe("Ava Guest");
    expect(
      (screen.getByRole("textbox", { name: "Parent or guardian's email" }) as HTMLInputElement)
        .value,
    ).toBe("ava@example.test");
    fireEvent.click(minor);
    expect(screen.queryByRole("textbox", { name: "Parent or guardian's full name" })).toBeNull();
    saveGuest(2);
    await noticeTitled("Saved");
    expect(callsTo(calls, "saveParticipant")[0]?.body).toEqual({
      name: "Theo Guest",
      isMinor: false,
      email: null,
      guardian: null,
    });
    await waitFor(() =>
      expect(party()[1]).toEqual(["Guest 2: Theo Guest", "Adult", "Edit guest 2"]),
    );
  });

  it("asks a minor's parent or guardian for a name and email, and sends them", async () => {
    const calls = await shown();
    const name = await openEditor(3);
    type(name, "Mia Guest");
    fireEvent.click(screen.getByRole("checkbox", { name: "Under 18 on the day of the trip" }));
    const guardianName = screen.getByRole("textbox", { name: "Parent or guardian's full name" });
    const guardianEmail = screen.getByRole("textbox", { name: "Parent or guardian's email" });
    saveGuest(3);
    expect(await screen.findByText("Enter the parent or guardian's name")).toBeTruthy();
    expect(screen.getByText("Enter the parent or guardian's email")).toBeTruthy();
    expect(guardianName.getAttribute("aria-invalid")).toBe("true");
    expect(guardianEmail.getAttribute("aria-invalid")).toBe("true");
    await waitFor(() => expect(document.activeElement).toBe(guardianName));
    expect(callsTo(calls, "saveParticipant")).toHaveLength(0);
    type(guardianName, "Ava Guest");
    type(guardianEmail, "ava@example.test");
    saveGuest(3);
    await noticeTitled("Saved");
    expect(callsTo(calls, "saveParticipant")[0]?.body).toEqual({
      name: "Mia Guest",
      isMinor: true,
      email: null,
      guardian: { name: "Ava Guest", email: "ava@example.test" },
    });
    await waitFor(() =>
      expect(party()[2]).toEqual([
        "Guest 3: Mia Guest",
        "Under 18. Guardian: Ava Guest",
        "Edit guest 3",
      ]),
    );
  });

  it("asks for the name before sending anything, ties the problem to the field, and focuses it", async () => {
    const calls = await shown();
    const name = await openEditor(3);
    saveGuest(3);
    expect(await screen.findByText("Enter their full name")).toBeTruthy();
    expect(name.getAttribute("aria-invalid")).toBe("true");
    expect(name.getAttribute("aria-describedby")).toMatch(/-error$/);
    await waitFor(() => expect(document.activeElement).toBe(name));
    expect(callsTo(calls, "saveParticipant")).toHaveLength(0);
    type(name, "Ben Guest");
    saveGuest(3);
    await noticeTitled("Saved");
    expect(callsTo(calls, "saveParticipant")).toHaveLength(1);
  });

  it("checks their own email when one is given, and a name's hidden characters, before sending", async () => {
    const calls = await shown();
    const name = await openEditor(3);
    const email = screen.getByRole("textbox", { name: "Their email (optional)" });
    type(name, "Ben\tGuest");
    type(email, "not an email");
    saveGuest(3);
    expect(await screen.findByText("Use letters, spaces, and punctuation only")).toBeTruthy();
    expect(screen.getByText("Enter an email address like name@example.com")).toBeTruthy();
    await waitFor(() => expect(document.activeElement).toBe(name));
    expect(callsTo(calls, "saveParticipant")).toHaveLength(0);
    type(name, "Ben Guest");
    saveGuest(3);
    await waitFor(() => expect(document.activeElement).toBe(email));
    expect(callsTo(calls, "saveParticipant")).toHaveLength(0);
    type(email, "");
    saveGuest(3);
    await noticeTitled("Saved");
  });

  it("closes the form on Not now without sending, and puts focus back on the place's button", async () => {
    const calls = await shown();
    const name = await openEditor(3);
    type(name, "Ben Guest");
    fireEvent.click(screen.getByRole("button", { name: "Not now" }));
    await waitFor(() => expect(screen.queryByRole("group", { name: "Add guest 3" })).toBeNull());
    expect(callsTo(calls, "saveParticipant")).toHaveLength(0);
    expect(party()[2]).toEqual(["Guest 3: Not named yet", "", "Add guest 3"]);
    await waitFor(() =>
      expect(document.activeElement).toBe(
        screen.getByRole("button", { name: placeButton("Add", 3) }),
      ),
    );
    expect(screen.queryByText("Saved")).toBeNull();
  });

  it("sends the same request again under the same key when no answer came", async () => {
    const calls = await shown({ saveParticipant: inOrder(offline, answers.saveParticipant) });
    const name = await openEditor(3);
    type(name, "Ben Guest");
    saveGuest(3);
    const alert = await screen.findByRole("alert");
    expect(text(alert)).toContain(
      "Not saved: we couldn't reach the booking site. Check your connection and try again.",
    );
    // The form stays, with what was typed.
    expect((name as HTMLInputElement).value).toBe("Ben Guest");
    saveGuest(3);
    await noticeTitled("Saved");
    const [first, second] = callsTo(calls, "saveParticipant");
    expect(first?.headers.get("idempotency-key")).toMatch(uuid);
    expect(second?.headers.get("idempotency-key")).toBe(first?.headers.get("idempotency-key"));
    expect(second?.body).toEqual(first?.body);
    expect(second?.path).toBe(first?.path);
  });

  it("keeps the same key through several lost answers", async () => {
    const calls = await shown({
      saveParticipant: inOrder(offline, offline, offline, answers.saveParticipant),
    });
    const name = await openEditor(3);
    type(name, "Ben Guest");
    for (let tries = 0; tries < 3; tries += 1) {
      saveGuest(3);
      await waitFor(() => expect(callsTo(calls, "saveParticipant")).toHaveLength(tries + 1));
      await screen.findByRole("alert");
    }
    saveGuest(3);
    await noticeTitled("Saved");
    const keys = callsTo(calls, "saveParticipant").map((c) => c.headers.get("idempotency-key"));
    expect(keys).toHaveLength(4);
    expect(new Set(keys).size).toBe(1);
  });

  it("uses a new key for details that changed after a lost answer, and for the next save after a success", async () => {
    const calls = await shown({ saveParticipant: inOrder(offline, answers.saveParticipant) });
    const name = await openEditor(3);
    type(name, "Ben Guest");
    saveGuest(3);
    await screen.findByRole("alert");
    // Other details are another command: another key.
    type(name, "Ben A. Guest");
    saveGuest(3);
    await noticeTitled("Saved");
    // Saved: the next save, even of the same details, is a new command.
    await openEditor(3, "Edit");
    saveGuest(3);
    await waitFor(() => expect(callsTo(calls, "saveParticipant")).toHaveLength(3));
    const [first, second, third] = callsTo(calls, "saveParticipant");
    const keyOf = (c?: ManageCall) => c?.headers.get("idempotency-key");
    expect(keyOf(second)).not.toBe(keyOf(first));
    expect(keyOf(third)).not.toBe(keyOf(second));
    expect(second?.body).toEqual({
      name: "Ben A. Guest",
      isMinor: false,
      email: null,
      guardian: null,
    });
    expect(third?.body).toEqual(second?.body);
    for (const c of [first, second, third]) expect(keyOf(c)).toMatch(uuid);
  });

  it.each([
    [
      "the booking being canceled",
      409,
      "booking_canceled",
      "Refused",
      "This booking is canceled, so its party no longer changes.",
    ],
    [
      "the trip having left",
      409,
      "trip_departed",
      "Refused",
      "This trip has left, so its party no longer changes.",
    ],
    [
      "a refusal that explains itself",
      422,
      "position_out_of_range",
      "This party has 3 place(s)",
      "This party has 3 place(s)",
    ],
    [
      "a refusal that says nothing",
      422,
      "idempotency_key_reused",
      "",
      "This change can't be saved.",
    ],
    [
      "details the API cannot take",
      400,
      "invalid_request",
      "Refused",
      "Check the details and try again.",
    ],
    [
      "a server error",
      500,
      "internal_error",
      "Refused",
      "Not saved: something went wrong on our side. Try again in a moment.",
    ],
  ])(
    "explains %s, and keeps the form open with what was typed",
    async (_what, status, code, message, shown_) => {
      await shown({ saveParticipant: () => refusal(status, code, message) });
      const name = await openEditor(3);
      type(name, "Ben Guest");
      saveGuest(3);
      const alert = await screen.findByRole("alert");
      expect(text(alert)).toContain(shown_);
      expect(text(alert)).toContain("Not saved");
      expect((name as HTMLInputElement).value).toBe("Ben Guest");
      expect(screen.getByRole("group", { name: "Add guest 3" })).toBeTruthy();
      expect(screen.queryByText("Saved")).toBeNull();
    },
  );

  it("says it did not save when the answer breaks the contract, and keeps the same request for a retry", async () => {
    const calls = await shown({
      saveParticipant: inOrder(
        () => json({ participant: { name: "Ben" }, created: true }),
        answers.saveParticipant,
      ),
    });
    const name = await openEditor(3);
    type(name, "Ben Guest");
    saveGuest(3);
    const alert = await screen.findByRole("alert");
    expect(text(alert)).toContain("Not saved: something went wrong on our side.");
    saveGuest(3);
    await noticeTitled("Saved");
    const [first, second] = callsTo(calls, "saveParticipant");
    expect(second?.headers.get("idempotency-key")).toBe(first?.headers.get("idempotency-key"));
  });

  it("shows Saving while the API answers, and sends once however often Save is pressed", async () => {
    const answer = held();
    const calls = await shown({ saveParticipant: answer.answer });
    const name = await openEditor(3);
    type(name, "Ben Guest");
    const save = screen.getByRole("button", { name: "Save guest 3" });
    fireEvent.click(save);
    await waitFor(() => expect(save.getAttribute("aria-busy")).toBe("true"));
    expect(text(save)).toBe("Saving…");
    expect(screen.getByRole("button", { name: "Not now" }).getAttribute("aria-disabled")).toBe(
      "true",
    );
    fireEvent.click(save);
    expect(callsTo(calls, "saveParticipant")).toHaveLength(1);
    answer.release(
      json({
        participant: {
          id: "7c1e9d3a-5b2f-4a6e-8d40-2f9b1c3e5a03",
          position: 3,
          name: "Ben Guest",
          isMinor: false,
          email: null,
          guardian: null,
          createdAt: testNow.toISOString(),
          updatedAt: testNow.toISOString(),
        },
        created: true,
      }),
    );
    expect(await noticeTitled("Saved")).toBeTruthy();
  });

  it("ends the session on a 401, whatever was being saved", async () => {
    await shown({ saveParticipant: () => refusal(401, "session_expired") });
    const name = await openEditor(3);
    type(name, "Ben Guest");
    saveGuest(3);
    expect(await heading("Your session has ended")).toBeTruthy();
    expect(window.sessionStorage.getItem(storageKey)).toBeNull();
  });

  it("offers no form once the trip has left, and says why", async () => {
    await shown(
      {},
      {
        booking: managedBooking({
          partyEditable: false,
          cancellationTerms: terms("none", { cancelable: false, refusal: "trip_departed" }),
        }),
      },
    );
    expect(text(card("Who's coming").querySelector(":scope > p"))).toBe(
      "This trip has left, so its party no longer changes.",
    );
    expect(screen.queryByRole("button", { name: anyPlaceButton })).toBeNull();
    // Who is named is still shown.
    expect(party().map(([who]) => who)).toEqual([
      "Guest 1: Ava Guest",
      "Guest 2: Theo Guest",
      "Guest 3: Not named yet",
    ]);
  });
});

// Canceling ---------------------------------------------------------------------------------------------

describe("canceling", () => {
  const cardText = () => text(card("Cancel this booking"));

  it("says what canceling gives now, and until when, before anything is asked", async () => {
    const calls = await shown();
    expect(cardText()).toContain(
      "If you cancel now: You get a full refund of $160.51. This holds until Tue, Oct 6 at 6:00 PM EDT, New York time.",
    );
    expect(cardText()).toContain(
      "Policy: Cancel at least 24 hours before departure for a full refund.",
    );
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(callsTo(calls, "cancel")).toHaveLength(0);
  });

  it("asks first, in a dialog that shows the refund and what canceling means, with Keep my booking focused", async () => {
    const calls = await shown();
    const dialog = await askToCancel();
    expect(text(dialog)).toContain("You get a full refund of $160.51.");
    expect(text(dialog)).toContain("Your places go back on sale, and this can't be undone.");
    const keep = within(dialog).getByRole("button", { name: "Keep my booking" });
    await waitFor(() => expect(document.activeElement).toBe(keep));
    expect(within(dialog).getByRole("button", { name: "Cancel booking" })).toBeTruthy();
    expect(callsTo(calls, "cancel")).toHaveLength(0);
    // Nothing about the terms having changed, until they do.
    expect(within(dialog).queryByText("The refund changed")).toBeNull();
  });

  it("says a party of one's place goes back on sale", async () => {
    await shown(
      {},
      {
        booking: managedBooking({
          party: {
            kind: "tickets",
            guests: 1,
            tickets: [{ code: "adult", name: "Adult", quantity: 1 }],
          },
          participants: { partySize: 1, participants: [] },
        }),
      },
    );
    const dialog = await askToCancel();
    expect(text(dialog)).toContain("Your place goes back on sale, and this can't be undone.");
  });

  it("keeps the booking on Keep my booking, and sends nothing", async () => {
    const calls = await shown();
    const dialog = await askToCancel();
    fireEvent.click(within(dialog).getByRole("button", { name: "Keep my booking" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(callsTo(calls, "cancel")).toHaveLength(0);
    expect(badges()).toEqual(["Confirmed"]);
  });

  it("cancels: a POST with the refund the guest was shown and a key, then shows the canceled booking", async () => {
    const calls = await shown();
    const dialog = await askToCancel();
    confirmCancel(dialog);
    const done = await noticeTitled("Your booking is canceled");
    expect(text(done)).toContain("$160.51 refund on its way. We've emailed you the details.");
    expect(done.getAttribute("role")).toBe("status");
    const [cancel] = callsTo(calls, "cancel");
    expect(cancel?.method).toBe("POST");
    expect(cancel?.path).toBe("/v1/public/manage/cancellation");
    expect(cancel?.search.toString()).toBe("");
    expect(cancel?.body).toEqual({ expectedRefundAmount: 16_051 });
    expect(cancel?.headers.get("idempotency-key")).toMatch(uuid);
    expect(cancel?.headers.get("authorization")).toBe(`Bearer ${sessionToken}`);
    // The dialog is gone, and the booking reads as canceled.
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(badges()).toEqual(["Canceled"]);
    expect(screen.queryByRole("region", { name: "Cancel this booking" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Cancel booking" })).toBeNull();
    expect(text(card("Who's coming").querySelector(":scope > p"))).toBe(
      "This booking is canceled, so its party no longer changes.",
    );
    expect(screen.queryByRole("button", { name: anyPlaceButton })).toBeNull();
    // The receipt says where the refund is.
    expect(text(card("Receipt").querySelector(".manage-refund"))).toBe("$160.51 refund on its way");
    expect(server.booking.state).toBe("canceled");
    // The page did not read the booking again to find out: the answer was the booking.
    expect(callsTo(calls, "read")).toHaveLength(1);
  });

  it("says the refund was made when the API's answer says it was", async () => {
    await shown({
      cancel: () => json({ booking: canceledBooking(server.booking, "succeeded") }),
    });
    confirmCancel(await askToCancel());
    expect(text(await noticeTitled("Your booking is canceled"))).toContain(
      "$160.51 refunded to your original payment method. We've emailed you the details.",
    );
    expect(text(card("Receipt").querySelector(".manage-refund"))).toBe(
      "$160.51 refunded to your original payment method",
    );
  });

  it("shows a half refund with its share and its odd cent, in the card, the dialog, the request, and the receipt", async () => {
    const calls = await shown(
      {},
      { booking: withTerms(managedBooking(), terms("percent_refund")) },
    );
    // After the cutoff, so no "until" sentence.
    expect(cardText()).toContain(
      "If you cancel now: You get 50% back: $80.26 of the $160.51 you paid.",
    );
    expect(cardText()).not.toContain("This holds until");
    const dialog = await askToCancel();
    expect(text(dialog)).toContain("You get 50% back: $80.26 of the $160.51 you paid.");
    confirmCancel(dialog);
    expect(text(await noticeTitled("Your booking is canceled"))).toContain(
      "$80.26 refund on its way. We've emailed you the details.",
    );
    expect(callsTo(calls, "cancel")[0]?.body).toEqual({ expectedRefundAmount: 8026 });
    expect(text(card("Receipt").querySelector(".manage-refund"))).toBe("$80.26 refund on its way");
  });

  it("says plainly when canceling gives nothing back, and asks for a refund of nothing", async () => {
    const calls = await shown({}, { booking: withTerms(managedBooking(), terms("none")) });
    expect(cardText()).toContain(
      "If you cancel now: You get no refund: the cutoff for a refund has passed.",
    );
    const dialog = await askToCancel();
    expect(text(dialog)).toContain("You get no refund: the cutoff for a refund has passed.");
    confirmCancel(dialog);
    expect(text(await noticeTitled("Your booking is canceled"))).toContain(
      "There is no refund under the policy. We've emailed you the details.",
    );
    expect(callsTo(calls, "cancel")[0]?.body).toEqual({ expectedRefundAmount: 0 });
    expect(card("Receipt").querySelector(".manage-refund")).toBeNull();
  });

  it("shows Canceling while the API answers, keeps the dialog, and sends once", async () => {
    const answer = held();
    const calls = await shown({ cancel: answer.answer });
    const dialog = await askToCancel();
    const confirm = within(dialog).getByRole("button", { name: "Cancel booking" });
    fireEvent.click(confirm);
    await waitFor(() => expect(confirm.getAttribute("aria-busy")).toBe("true"));
    expect(text(confirm)).toBe("Canceling…");
    expect(
      within(dialog).getByRole("button", { name: "Keep my booking" }).getAttribute("aria-disabled"),
    ).toBe("true");
    fireEvent.click(confirm);
    expect(callsTo(calls, "cancel")).toHaveLength(1);
    answer.release(json({ booking: canceledBooking(server.booking) }));
    expect(await noticeTitled("Your booking is canceled")).toBeTruthy();
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("sends the same request again under the same key when no answer came", async () => {
    const calls = await shown({ cancel: inOrder(offline, answers.cancel) });
    const dialog = await askToCancel();
    confirmCancel(dialog);
    const alert = await within(dialog).findByRole("alert");
    expect(text(alert)).toContain("Your booking wasn't canceled");
    expect(text(alert)).toContain(
      "We couldn't reach the booking site. Check your connection and try again.",
    );
    // The dialog stays, and the terms are as they were.
    expect(text(dialog)).toContain("You get a full refund of $160.51.");
    confirmCancel(dialog);
    await noticeTitled("Your booking is canceled");
    const [first, second] = callsTo(calls, "cancel");
    expect(first?.headers.get("idempotency-key")).toMatch(uuid);
    expect(second?.headers.get("idempotency-key")).toBe(first?.headers.get("idempotency-key"));
    expect(second?.body).toEqual(first?.body);
  });

  it.each([
    [
      "a rate limit",
      () => refusal(429, "rate_limited"),
      "That was a lot of tries in a short time. Wait a minute, then try again.",
    ],
    [
      "a server error",
      () => refusal(500, "internal_error"),
      "Something went wrong on our side. Try again in a moment.",
    ],
    [
      "an answer that breaks the contract",
      () => json({ booking: { state: "canceled" } }),
      "Something went wrong on our side. Try again in a moment.",
    ],
  ])(
    "says the booking was not canceled after %s, and leaves the dialog to try again",
    async (_what, answer, why) => {
      await shown({ cancel: answer });
      const dialog = await askToCancel();
      confirmCancel(dialog);
      const alert = await within(dialog).findByRole("alert");
      expect(text(alert)).toContain("Your booking wasn't canceled");
      expect(text(alert)).toContain(why);
      expect(badges()).toEqual(["Confirmed"]);
      expect(
        within(dialog).getByRole("button", { name: "Cancel booking" }).getAttribute("aria-busy"),
      ).toBeNull();
    },
  );

  it("rereads what canceling gives when the terms changed, shows the new amount, and asks again with a new key", async () => {
    const calls = await shown();
    const dialog = await askToCancel();
    expect(text(dialog)).toContain("You get a full refund of $160.51.");
    // The cutoff passes while the guest is deciding.
    server.booking = withTerms(server.booking, terms("none"));
    confirmCancel(dialog);
    const changed = await within(dialog).findByRole("alert");
    expect(text(changed)).toContain("The refund changed");
    expect(text(changed)).toContain("The policy's cutoff passed while you were deciding.");
    expect(text(dialog)).toContain("You get no refund: the cutoff for a refund has passed.");
    expect(text(dialog)).not.toContain("You get a full refund");
    // Nothing was canceled, and the terms were read again.
    expect(server.booking.state).toBe("confirmed");
    expect(paths(calls).slice(-2)).toEqual([
      "POST /v1/public/manage/cancellation",
      "GET /v1/public/manage/cancellation",
    ]);
    expect(callsTo(calls, "readTerms")[0]?.headers.get("authorization")).toBe(
      `Bearer ${sessionToken}`,
    );
    // The card behind the dialog says the same.
    expect(cardText()).toContain("You get no refund: the cutoff for a refund has passed.");
    // The guest decides again: the new amount, and a new key.
    confirmCancel(dialog);
    expect(text(await noticeTitled("Your booking is canceled"))).toContain(
      "There is no refund under the policy.",
    );
    const [first, second] = callsTo(calls, "cancel");
    expect(first?.body).toEqual({ expectedRefundAmount: 16_051 });
    expect(second?.body).toEqual({ expectedRefundAmount: 0 });
    expect(second?.headers.get("idempotency-key")).toMatch(uuid);
    expect(second?.headers.get("idempotency-key")).not.toBe(first?.headers.get("idempotency-key"));
    expect(server.booking.state).toBe("canceled");
  });

  it("shows the new amount, and not the old, for a refund that got smaller by a share", async () => {
    await shown();
    const dialog = await askToCancel();
    server.booking = withTerms(server.booking, terms("percent_refund"));
    confirmCancel(dialog);
    await within(dialog).findByText("The refund changed");
    expect(text(dialog)).toContain("You get 50% back: $80.26 of the $160.51 you paid.");
  });

  it("forgets that the refund changed when the guest keeps the booking, but not the new terms", async () => {
    await shown();
    const dialog = await askToCancel();
    server.booking = withTerms(server.booking, terms("none"));
    confirmCancel(dialog);
    await within(dialog).findByText("The refund changed");
    fireEvent.click(within(dialog).getByRole("button", { name: "Keep my booking" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    const again = await askToCancel();
    expect(within(again).queryByText("The refund changed")).toBeNull();
    expect(text(again)).toContain("You get no refund: the cutoff for a refund has passed.");
  });

  it("closes the dialog, and says so in the card, when the terms changed to something the guest cannot cancel under", async () => {
    await shown({
      cancel: () => refusal(409, "cancellation_terms_changed"),
      readTerms: () => json({ terms: terms("credit") }),
    });
    const dialog = await askToCancel();
    confirmCancel(dialog);
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(cardText()).toContain(
      "Canceling now gives a credit for a future trip, which Demo Harbor Charters issues. Contact them to cancel.",
    );
    expect(screen.queryByRole("button", { name: "Cancel booking" })).toBeNull();
  });

  it("sends the guest to the operator when the policy turned to a credit while the dialog was open", async () => {
    const calls = await shown();
    const dialog = await askToCancel();
    server.booking = withTerms(server.booking, terms("credit"));
    confirmCancel(dialog);
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(cardText()).toContain(
      "Canceling now gives a credit for a future trip, which Demo Harbor Charters issues. Contact them to cancel.",
    );
    expect(screen.getByRole("link", { name: "Call (305) 555-0142" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Cancel booking" })).toBeNull();
    expect(badges()).toEqual(["Confirmed"]);
    expect(callsTo(calls, "readTerms")).toHaveLength(1);
  });

  it("says the trip has left when it left while the dialog was open", async () => {
    await shown();
    const dialog = await askToCancel();
    server.booking = withTerms(
      server.booking,
      terms("none", { cancelable: false, refusal: "trip_departed" }),
    );
    confirmCancel(dialog);
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(cardText()).toContain("This trip has already left, so it can't be canceled here.");
    expect(screen.queryByRole("button", { name: "Cancel booking" })).toBeNull();
  });

  it("starts with a credit as a way to reach the operator, and no cancel button", async () => {
    const calls = await shown({}, { booking: withTerms(managedBooking(), terms("credit")) });
    expect(cardText()).toContain(
      "Canceling now gives a credit for a future trip, which Demo Harbor Charters issues. Contact them to cancel.",
    );
    const call = screen.getByRole("link", { name: "Call (305) 555-0142" });
    expect(call.className).toContain("tg-button--secondary");
    expect(call.getAttribute("href")).toBe("tel:+13055550142");
    expect(screen.queryByRole("button", { name: "Cancel booking" })).toBeNull();
    expect(callsTo(calls, "cancel")).toHaveLength(0);
  });

  it("starts with a trip that has left as no way to cancel", async () => {
    await shown(
      {},
      {
        booking: managedBooking({
          partyEditable: false,
          cancellationTerms: terms("none", { cancelable: false, refusal: "trip_departed" }),
        }),
      },
    );
    expect(cardText()).toContain("This trip has already left, so it can't be canceled here.");
    expect(screen.queryByRole("button", { name: "Cancel booking" })).toBeNull();
  });

  it("ends the session on a 401", async () => {
    await shown({ cancel: () => refusal(401, "session_expired") });
    confirmCancel(await askToCancel());
    expect(await heading("Your session has ended")).toBeTruthy();
    expect(window.sessionStorage.getItem(storageKey)).toBeNull();
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("shows a booking canceled earlier as canceled, with no way to cancel it again", async () => {
    await shown({}, { booking: canceledBooking(managedBooking(), "succeeded") });
    expect(badges()).toEqual(["Canceled"]);
    expect(screen.queryByRole("region", { name: "Cancel this booking" })).toBeNull();
    expect(text(card("Receipt").querySelector(".manage-refund"))).toBe(
      "$160.51 refunded to your original payment method",
    );
    // Said once, when it happened: not on every visit.
    expect(screen.queryByText("Your booking is canceled")).toBeNull();
    expect(text(card("Who's coming").querySelector(":scope > p"))).toBe(
      "This booking is canceled, so its party no longer changes.",
    );
  });

  it("says a refund the provider could not send yet, without calling it done", async () => {
    const failed = {
      ...canceledBooking(managedBooking()),
      refund: {
        state: "failed" as const,
        amount: 16_051,
        failureCode: "charge_already_refunded",
        requestedAt: "2026-10-05T16:00:00.000Z",
        settledAt: "2026-10-05T16:01:00.000Z",
      },
    };
    await shown({}, { booking: failed });
    expect(text(card("Receipt").querySelector(".manage-refund"))).toBe(
      "$160.51 refund could not be sent yet; the operator will follow up",
    );
  });
});

// Coming back later ------------------------------------------------------------------------------------

describe("coming back later", () => {
  it("says what the link is for, and to whom a new one goes", async () => {
    await shown();
    expect(text(card("Coming back later?"))).toContain(
      "This page stays open in this tab for an hour. We can email a new link to ava@example.test whenever you need one.",
    );
  });

  it("emails a new link on request, with the session as a bearer token and no body", async () => {
    const calls = await shown();
    fireEvent.click(screen.getByRole("button", { name: "Email me a new link" }));
    const done = await noticeTitled("New link sent");
    expect(text(done)).toContain(
      "We've emailed a new link to ava@example.test. Links in earlier emails no longer work.",
    );
    const [email] = callsTo(calls, "emailLink");
    expect(email?.method).toBe("POST");
    expect(email?.path).toBe("/v1/public/manage/link-email");
    expect(email?.search.toString()).toBe("");
    // No body: the new link goes to the address the booking has on file, never one the page sent.
    expect(email?.body).toBeUndefined();
    expect(email?.headers.get("content-type")).toBeNull();
    expect(email?.headers.get("authorization")).toBe(`Bearer ${sessionToken}`);
  });

  it.each([
    ["a sent link", () => json({ status: "accepted" }, 202), "New link sent"],
    [
      "the hour's limit",
      () => refusal(429, "link_email_rate_limited"),
      "We've already sent three links this hour",
    ],
    ["no answer", offline, "We couldn't send a link"],
  ])(
    "shows the outcome of %s under the button that asked, and moves focus to it",
    async (_what, answer, title) => {
      await shown({ emailLink: answer });
      fireEvent.click(screen.getByRole("button", { name: "Email me a new link" }));
      const notice = await noticeTitled(title);
      const later = card("Coming back later?");
      // In the card the guest is looking at, after its actions, not at the top of the page.
      expect(later.contains(notice)).toBe(true);
      const actions = later.querySelector(".booking-actions");
      if (!actions) throw new Error("no actions in the card");
      expect(
        actions.compareDocumentPosition(notice) & Node.DOCUMENT_POSITION_FOLLOWING,
      ).toBeTruthy();
      await waitFor(() => expect(notice.closest("[tabindex='-1']")).toBe(document.activeElement));
    },
  );

  it("shows Sending while the API answers, and sends once", async () => {
    const answer = held();
    const calls = await shown({ emailLink: answer.answer });
    const send = screen.getByRole("button", { name: "Email me a new link" });
    fireEvent.click(send);
    await waitFor(() => expect(send.getAttribute("aria-busy")).toBe("true"));
    expect(text(send)).toBe("Sending…");
    fireEvent.click(send);
    expect(callsTo(calls, "emailLink")).toHaveLength(1);
    answer.release(json({ status: "accepted" }, 202));
    expect(await noticeTitled("New link sent")).toBeTruthy();
  });

  it("says three links an hour is the most, and to look in the inbox", async () => {
    await shown({ emailLink: () => refusal(429, "link_email_rate_limited") });
    fireEvent.click(screen.getByRole("button", { name: "Email me a new link" }));
    const notice = await noticeTitled("We've already sent three links this hour");
    expect(text(notice)).toContain("Check your email, including spam, or try again later.");
    expect(screen.queryByText("New link sent")).toBeNull();
  });

  it.each([
    [
      "no answer",
      offline,
      "We couldn't reach the booking site. Check your connection and try again.",
    ],
    [
      "a request rate limit",
      () => refusal(429, "rate_limited"),
      "That was a lot of tries in a short time. Wait a minute, then try again.",
    ],
    [
      "a server error",
      () => refusal(500, "internal_error"),
      "Something went wrong on our side. Try again in a moment.",
    ],
  ])("says no link was sent after %s", async (_what, answer, why) => {
    await shown({ emailLink: answer });
    fireEvent.click(screen.getByRole("button", { name: "Email me a new link" }));
    const notice = await noticeTitled("We couldn't send a link");
    expect(text(notice)).toContain(why);
    expect(screen.queryByText("New link sent")).toBeNull();
  });

  it("ends the session on a 401", async () => {
    await shown({ emailLink: () => refusal(401, "session_expired") });
    fireEvent.click(screen.getByRole("button", { name: "Email me a new link" }));
    expect(await heading("Your session has ended")).toBeTruthy();
    expect(window.sessionStorage.getItem(storageKey)).toBeNull();
  });
});

// Secrets and personal data ----------------------------------------------------------------------------

describe("secrets and personal data", () => {
  it("never puts a token or a guest's details in an address, and sends each only where it belongs", async () => {
    const calls = stubManageApi();
    arrive();
    const addresses = [window.location.href];
    fireEvent.click(await openButton());
    await booked();
    addresses.push(window.location.href);

    // Name a guest and a minor, with details that are easy to find.
    const name = await openEditor(3);
    type(name, "Benedict Marlowe");
    type(screen.getByRole("textbox", { name: "Their email (optional)" }), "benedict@example.test");
    saveGuest(3);
    await noticeTitled("Saved");
    addresses.push(window.location.href);

    // Send a new link, then cancel.
    fireEvent.click(screen.getByRole("button", { name: "Email me a new link" }));
    await noticeTitled("New link sent");
    confirmCancel(await askToCancel());
    await noticeTitled("Your booking is canceled");
    addresses.push(window.location.href);

    // Every call, as the fake API recorded it.
    expect(paths(calls)).toEqual([
      "POST /v1/public/booking-access",
      "GET /v1/public/manage/booking",
      "PUT /v1/public/manage/participants/3",
      "GET /v1/public/manage/booking",
      "POST /v1/public/manage/link-email",
      "POST /v1/public/manage/cancellation",
    ]);

    // No address holds a token, a name, or an email: not the request's, not the page's.
    for (const url of [...calls.map((c) => c.url), ...calls.map((c) => c.address), ...addresses]) {
      expect(url).not.toContain(linkToken);
      expect(url).not.toContain(sessionToken);
      expect(decodeURIComponent(url)).not.toMatch(
        /Ava|Benedict|Marlowe|Theo|Guest|example\.test|@/i,
      );
    }
    for (const call of calls) expect(call.search.toString()).toBe("");

    // The link's token travels in one body, and the session's in none; the session is a bearer only.
    const body = (c: ManageCall) => JSON.stringify(c.body ?? "");
    expect(paths(calls.filter((c) => body(c).includes(linkToken)))).toEqual([
      "POST /v1/public/booking-access",
    ]);
    expect(calls.filter((c) => body(c).includes(sessionToken))).toHaveLength(0);
    const bearer = calls.filter((c) => c.headers.get("authorization") === `Bearer ${sessionToken}`);
    expect(bearer).toHaveLength(calls.length - 1);
    expect(calls[0]?.headers.get("authorization")).toBeNull();

    // The guest's details travel in the one PUT that names them.
    expect(paths(calls.filter((c) => /Benedict|benedict@/.test(body(c))))).toEqual([
      "PUT /v1/public/manage/participants/3",
    ]);

    // Nothing is cached, referred, or sent as a cookie.
    for (const call of calls) {
      expect(call.cache).toBe("no-store");
      expect(call.referrerPolicy).toBe("no-referrer");
      expect(call.headers.get("cookie")).toBeNull();
      expect(call.address).toBe(cleanAddress);
    }
    expect(document.cookie).toBe("");

    // The tab keeps the session and the link it was opened with, and no part of the guest.
    expect(window.localStorage.length).toBe(0);
    expect(window.sessionStorage.length).toBe(1);
    const kept = window.sessionStorage.getItem(storageKey) ?? "";
    expect(Object.keys(JSON.parse(kept)).sort()).toEqual([
      "expiresAt",
      "linkToken",
      "reference",
      "token",
    ]);
    expect(kept).not.toMatch(/Ava|Benedict|Marlowe|Theo|Guest|example\.test|@/);

    // Neither token is anywhere on the page, nor in its title.
    expect(document.documentElement.outerHTML).not.toContain(linkToken);
    expect(document.documentElement.outerHTML).not.toContain(sessionToken);
    expect(document.title).not.toContain(linkToken);
  });
});
