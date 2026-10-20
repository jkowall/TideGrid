// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { Membership, MeResponse, StaffTrip } from "@tidegrid/contracts";
import { ErrorBoundary } from "@tidegrid/design-system/components";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CrashedConsole } from "./Gate.tsx";

const me = (authMethod: "magic_link" | "access" = "magic_link"): MeResponse => ({
  principal: {
    userId: "5f0c3a52-2a55-4f8a-9d7e-5d6f0f1b2a01",
    email: "ava@demo-harbor.example",
    displayName: "Ava Marsh",
    authMethod,
  },
  memberships: [
    {
      tenantId: "0b9b0f6e-7d3c-4d7e-8f43-8a3f1b2c0001",
      tenantSlug: "demo-harbor",
      tenantName: "Demo Harbor Charters",
      role: "owner",
    },
    {
      tenantId: "0b9b0f6e-7d3c-4d7e-8f43-8a3f1b2c0002",
      tenantSlug: "demo-reef",
      tenantName: "Demo Reef Divers",
      role: "booking_staff",
    },
  ],
});

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const status = (code: number) => json({ error: { code: "x", message: "x", requestId: "r" } }, code);

type Answer = () => Response | Promise<Response>;

/** An operator's catalog, as far as the calendar reads it: its location's zone. */
const catalog = (timeZone: string) =>
  json({
    locations: [
      {
        id: "0f2c7a10-1b2c-4d3e-8f40-5a6b7c8d9e01",
        name: "Main dock",
        timeZone,
        meetingPoint: "Main dock",
        status: "active",
      },
    ],
    boats: [],
    products: [],
    schedules: [],
  });

/** A future, published trip on `saturday`, in `timeZone`. */
const saturdayTrip = (saturday: string, timeZone = "America/New_York"): StaffTrip => ({
  tripId: "bc5f3492-d330-487d-8078-7221db331801",
  timeZone,
  localDate: saturday,
  localStartTime: "18:00",
  startsAt: "2099-01-01T23:00:00.000Z",
  endsAt: "2099-01-02T00:30:00.000Z",
  startsAtLocal: `${saturday}T18:00:00-05:00`,
  endsAtLocal: `${saturday}T19:30:00-05:00`,
  durationMinutes: 90,
  productId: "4f51db31-f9aa-492a-ad2b-05d7c1c3cb2a",
  productName: "Sunset Harbor Cruise",
  productKind: "shared_seat",
  boatId: "9a0e7c55-3b1d-4f2a-8c6e-1d2f3a4b5c01",
  boatName: "Sea Lark",
  scheduleId: null,
  salesState: "published",
  salesStateChangedAt: "2026-09-30T12:00:00.000Z",
  salesCloseAt: "2099-01-01T22:00:00.000Z",
  blackedOut: false,
  capacity: { kind: "seats", total: 20, remaining: 20 },
});

/** A fetch that answers each "METHOD /path" from its own queue, in order. */
function api(routes: Record<string, Answer[]>) {
  return vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const key = `${init?.method ?? "GET"} ${String(input)}`;
    const answer = routes[key]?.shift();
    if (!answer) throw new Error(`unexpected request ${key}`);
    return answer();
  });
}

/** App reads a sign-in token from the URL once, when its module loads. */
async function loadApp(hash = "") {
  window.history.replaceState(null, "", `/${hash}`);
  vi.resetModules();
  return (await import("./App.tsx")).App;
}

const heading = (name: string) => screen.findByRole("heading", { level: 1, name });

/** Wait for the screen with this heading, then for its effects to move focus there. */
async function focusLandsOn(name: string) {
  const target = await heading(name);
  await waitFor(() => expect(document.activeElement).toBe(target));
}

/** Let any pending effects run before checking that nothing moved focus. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 50));

/** The text a screen reader reads as an element's description. */
const description = (element: Element) =>
  (element.getAttribute("aria-describedby") ?? "")
    .split(/\s+/)
    .filter(Boolean)
    .map((id) => document.getElementById(id)?.textContent?.trim() ?? "")
    .join(" ");

beforeEach(() => {
  window.history.replaceState(null, "", "/");
  // The shell remembers the chosen operator; every test starts with none.
  window.localStorage.clear();
  window.sessionStorage.clear();
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("focus after each transition", () => {
  it("moves focus to the Overview heading after Continue signing in", async () => {
    vi.stubGlobal(
      "fetch",
      api({
        "POST /api/v1/auth/sessions": [() => json({}, 201)],
        "GET /api/v1/me": [() => json(me())],
      }),
    );
    const App = await loadApp("#token=synthetic-link-token");
    render(<App />);
    await focusLandsOn("Finish signing in");
    fireEvent.click(screen.getByRole("button", { name: "Continue signing in" }));
    await focusLandsOn("Overview");
  });

  it("leaves focus alone when a page load lands on the Overview", async () => {
    vi.stubGlobal("fetch", api({ "GET /api/v1/me": [() => json(me())] }));
    const App = await loadApp();
    render(<App />);
    await heading("Overview");
    await settle();
    expect(document.activeElement).toBe(document.body);
  });

  it("gives the failure screen a focused heading and copy without status codes", async () => {
    vi.stubGlobal("fetch", api({ "GET /api/v1/me": [() => status(502), () => json(me())] }));
    const App = await loadApp();
    const { container } = render(<App />);
    await focusLandsOn("The console can't reach TideGrid");
    expect(container.textContent).toContain("TideGrid isn't responding right now.");
    expect(container.textContent).not.toMatch(/\b[1-5]\d\d\b|\bAPI\b/);
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    await focusLandsOn("Overview");
  });

  it("says to check the connection when the API cannot be reached", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new TypeError("Failed to fetch");
      }),
    );
    const App = await loadApp();
    const { container } = render(<App />);
    await heading("The console can't reach TideGrid");
    expect(container.textContent).toContain("Check your connection, then try again.");
  });

  it("moves focus to each page's heading, including between Calendar and Bookings", async () => {
    vi.stubGlobal("fetch", api({ "GET /api/v1/me": [() => json(me())] }));
    const App = await loadApp();
    render(<App />);
    await heading("Overview");
    const nav = screen.getByRole("navigation", { name: "Console" });
    // As in Chrome and Firefox, where clicking a link also focuses it.
    for (const page of ["Calendar", "Bookings", "Overview"]) {
      const link = within(nav).getByRole("link", { name: page });
      link.focus();
      fireEvent.click(link);
      await focusLandsOn(page);
    }
  });

  it("opens the booking list for the marina's day from the navigation, in place of the placeholder", async () => {
    const asked: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = new URL(String(input), "http://localhost:5174");
        asked.push(`${url.pathname}${url.search}`);
        if (url.pathname === "/api/v1/me") return json(me());
        if (url.pathname.endsWith("/catalog")) return catalog("America/New_York");
        if (url.pathname.endsWith("/bookings")) {
          return json({
            date: url.searchParams.get("date"),
            trips: [],
            bookings: [],
            nextAfter: null,
          });
        }
        throw new Error(`unexpected request ${url.pathname}`);
      }),
    );
    const App = await loadApp();
    const { container } = render(<App />);
    await heading("Overview");
    fireEvent.click(screen.getByRole("link", { name: "Bookings" }));
    await focusLandsOn("Bookings");
    expect(await screen.findByRole("heading", { name: /^No trips on / })).toBeTruthy();
    expect(container.textContent).not.toContain("comes in a later build");
    // The day asked for is today in New York, the marina's zone.
    const day = asked.find((a) => a.includes("/bookings?"));
    expect(day).toMatch(/[?&]date=\d{4}-\d{2}-\d{2}/);
    expect(screen.getByRole("link", { name: "Bookings" }).getAttribute("aria-current")).toBe(
      "page",
    );
  });

  it("moves focus to the new page's heading when the click leaves focus behind", async () => {
    vi.stubGlobal("fetch", api({ "GET /api/v1/me": [() => json(me())] }));
    const App = await loadApp();
    render(<App />);
    await heading("Overview");
    // Safari does not focus a link on click.
    fireEvent.click(screen.getByRole("link", { name: "Calendar" }));
    await focusLandsOn("Calendar");
  });

  it("moves focus to the page heading on the browser's back button", async () => {
    vi.stubGlobal("fetch", api({ "GET /api/v1/me": [() => json(me())] }));
    const App = await loadApp();
    render(<App />);
    await heading("Overview");
    fireEvent.click(screen.getByRole("link", { name: "Bookings" }));
    await focusLandsOn("Bookings");
    window.history.replaceState(null, "", "/calendar");
    fireEvent.popState(window);
    await focusLandsOn("Calendar");
  });
});

describe("sign-in notices", () => {
  it("reads an invalid link's error with the heading that takes focus", async () => {
    vi.stubGlobal("fetch", api({ "POST /api/v1/auth/sessions": [() => status(400)] }));
    const App = await loadApp("#token=synthetic-used-link");
    render(<App />);
    await focusLandsOn("Finish signing in");
    fireEvent.click(screen.getByRole("button", { name: "Continue signing in" }));
    await focusLandsOn("Sign in");
    const heading = screen.getByRole("heading", { level: 1, name: "Sign in" });
    expect(description(heading)).toBe("That sign-in link is invalid, already used, or expired.");
  });

  it("gives a plain sign-in screen no description", async () => {
    vi.stubGlobal("fetch", api({ "GET /api/v1/me": [() => status(401)] }));
    const App = await loadApp();
    render(<App />);
    await focusLandsOn("Sign in");
    expect(
      screen.getByRole("heading", { level: 1, name: "Sign in" }).hasAttribute("aria-describedby"),
    ).toBe(false);
  });
});

describe("sign out", () => {
  it("sits in the rail on every page and not in the Overview card", async () => {
    vi.stubGlobal("fetch", api({ "GET /api/v1/me": [() => json(me())] }));
    const App = await loadApp();
    const { container } = render(<App />);
    await heading("Overview");
    const access = screen.getByRole("region", { name: "Your access" });
    expect(within(access).queryByRole("button", { name: /sign out/i })).toBeNull();
    const rail = container.querySelector<HTMLElement>(".console-rail__user");
    for (const page of ["Calendar", "Bookings", "Overview"]) {
      fireEvent.click(screen.getByRole("link", { name: page }));
      await heading(page);
      expect(within(rail as HTMLElement).getByRole("button", { name: "Sign out" })).toBeTruthy();
    }
  });

  it("shows Signing out… while it works, then lands on sign-in with a notice and focus", async () => {
    let finish: (res: Response) => void = () => {};
    const deleted = new Promise<Response>((resolve) => {
      finish = resolve;
    });
    vi.stubGlobal(
      "fetch",
      api({
        "GET /api/v1/me": [() => json(me()), () => status(401)],
        "DELETE /api/v1/auth/sessions/current": [() => deleted],
      }),
    );
    const App = await loadApp();
    render(<App />);
    await heading("Overview");
    const button = screen.getByRole("button", { name: "Sign out" });
    fireEvent.click(button);
    expect(await screen.findByRole("button", { name: "Signing out…" })).toBe(button);
    expect(button.getAttribute("aria-busy")).toBe("true");
    finish(new Response(null, { status: 204 }));
    await focusLandsOn("Sign in");
    expect(screen.getByText("You're signed out")).toBeTruthy();
    // Read with the focused heading, since the notice is not a live region.
    expect(description(screen.getByRole("heading", { level: 1, name: "Sign in" }))).toBe(
      "You're signed out",
    );
  });

  it("keeps the person signed in and says so when sign-out does not reach the API", async () => {
    vi.stubGlobal(
      "fetch",
      api({
        "GET /api/v1/me": [() => json(me()), () => json(me())],
        "DELETE /api/v1/auth/sessions/current": [
          () => {
            throw new TypeError("Failed to fetch");
          },
        ],
      }),
    );
    const App = await loadApp();
    render(<App />);
    await heading("Overview");
    fireEvent.click(screen.getByRole("button", { name: "Sign out" }));
    expect(await screen.findByText("Sign-out didn't finish")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Sign out" })).toBeTruthy();
  });

  it("offers the Access logout, labelled Sign out, to an Access session", async () => {
    vi.stubGlobal("fetch", api({ "GET /api/v1/me": [() => json(me("access"))] }));
    const App = await loadApp();
    const { container } = render(<App />);
    await heading("Overview");
    const rail = container.querySelector<HTMLElement>(".console-rail__user") as HTMLElement;
    const link = within(rail).getByRole("link", { name: "Sign out of Cloudflare Access" });
    expect(link.getAttribute("href")).toBe("/cdn-cgi/access/logout");
  });
});

describe("calendar roles come from /v1/me", () => {
  it("shows no trip controls where the person is finance, and shows them where they own", async () => {
    const base = me();
    const [harbor, reef] = base.memberships as [Membership, Membership];
    const mixed: MeResponse = {
      ...base,
      memberships: [
        { ...harbor, role: "finance" },
        { ...reef, role: "owner" },
      ],
    };
    const tripsFor: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = new URL(String(input), "http://localhost:5174");
        if (url.pathname === "/api/v1/me") return json(mixed);
        if (/^\/api\/v1\/staff\/tenants\/[^/]+\/catalog$/.test(url.pathname)) {
          return catalog("America/New_York");
        }
        const match = /^\/api\/v1\/staff\/tenants\/([^/]+)\/trips$/.exec(url.pathname);
        if (!match) throw new Error(`unexpected request ${url.pathname}`);
        tripsFor.push(match[1] as string);
        // A future, published trip on the Saturday of whichever week is asked for.
        return json({ trips: [saturdayTrip(url.searchParams.get("to") as string)] });
      }),
    );
    const App = await loadApp();
    window.history.replaceState(null, "", "/calendar");
    render(<App />);
    await heading("Calendar");
    await screen.findByRole("heading", { level: 4, name: /Sunset Harbor Cruise/ });
    expect(tripsFor).toEqual([harbor.tenantId]);
    expect(screen.queryByRole("button", { name: /^Close sales/ })).toBeNull();
    expect(screen.queryByRole("button", { name: /^Cancel trip/ })).toBeNull();
    expect(screen.getByText(/View only\. Your role here, finance/)).toBeTruthy();

    fireEvent.change(screen.getByRole("combobox", { name: "Operator" }), {
      target: { value: reef.tenantId },
    });
    expect(await screen.findByRole("button", { name: /^Close sales/ })).toBeTruthy();
    expect(screen.getByRole("button", { name: /^Cancel trip/ })).toBeTruthy();
    expect(screen.queryByText(/View only/)).toBeNull();
    expect(tripsFor).toEqual([harbor.tenantId, reef.tenantId]);
  });
});

describe("switching operators", () => {
  it("starts the calendar afresh, so one marina's day never carries over to another", async () => {
    // Thursday 12:00 AM in New York is still Wednesday evening in Honolulu.
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-11-05T05:00:00Z"));
    const base = me();
    const [harbor, reef] = base.memberships as [Membership, Membership];
    const zones: Record<string, string> = {
      [harbor.tenantId]: "America/New_York",
      [reef.tenantId]: "Pacific/Honolulu",
    };
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = new URL(String(input), "http://localhost:5174");
        if (url.pathname === "/api/v1/me") return json(base);
        const match = /^\/api\/v1\/staff\/tenants\/([^/]+)\/(catalog|trips)$/.exec(url.pathname);
        if (!match) throw new Error(`unexpected request ${url.pathname}`);
        const tenantId = match[1] as string;
        // The Reef's catalog does not answer, so its zone can only come from its trips.
        if (match[2] === "catalog") {
          return tenantId === harbor.tenantId ? catalog("America/New_York") : status(500);
        }
        const saturday = url.searchParams.get("to") as string;
        return json({ trips: [saturdayTrip(saturday, zones[tenantId])] });
      }),
    );
    const App = await loadApp();
    window.history.replaceState(null, "", "/calendar");
    render(<App />);
    await screen.findByRole("heading", { level: 4, name: /Sunset Harbor Cruise/ });
    const dayTitle = (name: RegExp) =>
      screen.getByRole("region", { name }).querySelector("h3")?.textContent;
    expect(dayTitle(/^Thursday, November 5/)).toBe("Thursday, November 5 Today");

    const picker = screen.getByRole("combobox", { name: "Operator" });
    picker.focus();
    fireEvent.change(picker, { target: { value: reef.tenantId } });
    await waitFor(() =>
      expect(dayTitle(/^Wednesday, November 4/)).toBe("Wednesday, November 4 Today"),
    );
    expect(dayTitle(/^Thursday, November 5/)).toBe("Thursday, November 5");
    // The person is still choosing an operator, so focus stays with the picker.
    expect(document.activeElement).toBe(picker);
  });
});

describe("a page that fails to render", () => {
  it("shows the designed failure screen, not a blank page", async () => {
    // React reports the caught error on the console; keep the test output clean.
    const quiet = vi.spyOn(console, "error").mockImplementation(() => {});
    function Broken(): never {
      throw new RangeError("Invalid time zone specified: Mars/Olympus_Mons");
    }
    render(
      <ErrorBoundary fallback={<CrashedConsole />}>
        <Broken />
      </ErrorBoundary>,
    );
    await focusLandsOn("Something went wrong on this page");
    expect(screen.getByText("Try again. If it keeps happening, reload the console.")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Try again" })).toBeTruthy();
    quiet.mockRestore();
  });
});

describe("operator list", () => {
  it("marks the operator in scope with the word Selected, apart from the Active badge", async () => {
    vi.stubGlobal("fetch", api({ "GET /api/v1/me": [() => json(me())] }));
    const App = await loadApp();
    render(<App />);
    await heading("Overview");
    const list = screen.getByRole("region", { name: "Your operators" });
    const rows = within(list).getAllByRole("listitem");
    const selected = rows.find((row) => row.getAttribute("aria-current") === "true");
    expect(selected?.querySelector(".console-list__title")?.textContent).toBe(
      "Demo Harbor Charters Selected",
    );
    const word = within(selected as HTMLElement).getByText("Selected");
    expect(word.closest(".tg-status")).toBeNull();
    expect(
      within(selected as HTMLElement)
        .getByText("Active")
        .closest(".tg-status"),
    ).not.toBeNull();
    const other = rows.find((row) => row !== selected) as HTMLElement;
    expect(within(other).queryByText("Selected")).toBeNull();
  });
});

describe("returning to the page after signing in", () => {
  const returnKey = "tidegrid.console.return";
  /** The first operator of `me()`, which the shell opens on. */
  const tenantId = "0b9b0f6e-7d3c-4d7e-8f43-8a3f1b2c0001";
  const bookingId = "3c1f6a52-9d44-4e0b-8a6f-2b7d5c9e0a11";
  const bookingPath = `/bookings/${bookingId}`;
  const minute = 60_000;

  beforeEach(() => {
    // A fixed clock, so an entry's age is exact.
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-11-04T17:00:00Z"));
  });

  /** What the console keeps: the address, and when it was kept. */
  const entry = (address: string, age = minute) =>
    JSON.stringify({ address, at: Date.now() - age });
  const keep = (raw: string) => window.localStorage.setItem(returnKey, raw);
  const kept = () => window.localStorage.getItem(returnKey);

  /** Open the console from an emailed sign-in link and press Continue. */
  async function continueFromLink(answers: Record<string, Answer[]> = {}) {
    vi.stubGlobal(
      "fetch",
      api({
        "POST /api/v1/auth/sessions": [() => json({}, 201)],
        "GET /api/v1/me": [() => json(me())],
        ...answers,
      }),
    );
    const App = await loadApp("#token=synthetic-link-token");
    render(<App />);
    await focusLandsOn("Finish signing in");
    fireEvent.click(screen.getByRole("button", { name: "Continue signing in" }));
  }

  /** The console, signed out, opened at an address. */
  async function openSignedOutAt(address: string) {
    vi.stubGlobal("fetch", api({ "GET /api/v1/me": [() => status(401)] }));
    const App = await loadApp();
    window.history.replaceState(null, "", address);
    render(<App />);
    await focusLandsOn("Sign in");
  }

  it("lands on the booking the person was on, with its heading in focus, and uses the entry up", async () => {
    const { bookingDetail } = await import("./bookings/fixtures.ts");
    keep(entry(bookingPath));
    await continueFromLink({
      [`GET /api/v1/staff/tenants/${tenantId}/bookings/${bookingId}`]: [
        () => json({ booking: bookingDetail() }),
      ],
      [`GET /api/v1/staff/tenants/${tenantId}/bookings/${bookingId}/notes`]: [
        () => json({ notes: [], total: 0 }),
      ],
    });
    const title = await heading("Booking QKG6ERBF");
    expect(window.location.pathname).toBe(bookingPath);
    await waitFor(() => expect(document.activeElement).toBe(title));
    // The Bookings section is the one marked as holding this page; Overview is not.
    const nav = screen.getByRole("navigation", { name: "Console" });
    expect(within(nav).getByRole("link", { name: "Bookings" }).getAttribute("aria-current")).toBe(
      "true",
    );
    expect(within(nav).getByRole("link", { name: "Overview" }).getAttribute("aria-current")).toBe(
      null,
    );
    expect(kept()).toBeNull();
  });

  it("lands on a day's list with its day, not on today", async () => {
    keep(entry("/bookings?day=2026-11-10"));
    await continueFromLink({
      [`GET /api/v1/staff/tenants/${tenantId}/catalog`]: [() => catalog("America/New_York")],
      [`GET /api/v1/staff/tenants/${tenantId}/bookings?date=2026-11-10`]: [
        () => json({ date: "2026-11-10", trips: [], bookings: [], nextAfter: null }),
      ],
    });
    await heading("Bookings");
    expect(
      await screen.findByRole("heading", { name: "No trips on Tuesday, November 10" }),
    ).toBeTruthy();
    expect(window.location.pathname + window.location.search).toBe("/bookings?day=2026-11-10");
    expect(kept()).toBeNull();
  });

  it("lands on the search page, which asks for nothing until the person searches", async () => {
    keep(entry("/bookings/search"));
    await continueFromLink();
    const title = await heading("Search bookings");
    await waitFor(() => expect(document.activeElement).toBe(title));
    expect(window.location.pathname).toBe("/bookings/search");
    expect(screen.getByRole("heading", { level: 2, name: "Find any booking" })).toBeTruthy();
    expect(kept()).toBeNull();
  });

  it.each([
    ["a minute", minute],
    ["29 minutes", 29 * minute],
    ["exactly half an hour", 30 * minute],
  ])("still returns to an entry that is %s old", async (_what, age) => {
    keep(entry("/bookings/search", age));
    await continueFromLink();
    await heading("Search bookings");
    expect(window.location.pathname).toBe("/bookings/search");
    expect(kept()).toBeNull();
  });

  // Each entry is made inside its test, so its age is read from the test's own clock.
  it.each([
    ["an entry a moment older than half an hour", () => entry("/bookings/search", 30 * minute + 1)],
    ["an entry a day old", () => entry("/bookings/search", 24 * 60 * minute)],
    [
      "an entry from the future",
      () => JSON.stringify({ address: "/bookings/search", at: Date.now() + minute }),
    ],
    ["the overview", () => entry("/")],
    ["a page the console does not have", () => entry("/not-a-page")],
    ["a booking address that is not a booking", () => entry("/bookings/not-an-id")],
    ["an address that starts with two slashes", () => entry(`//evil.example${bookingPath}`)],
    [
      "an address that starts with a slash and a backslash",
      () => entry(`/\\evil.example${bookingPath}`),
    ],
    ["an address on another site", () => entry(`https://evil.example${bookingPath}`)],
    ["an address that is only a path", () => entry("bookings/search")],
    ["an entry that is not JSON", () => "not json {"],
    ["an entry that is only null", () => "null"],
    ["an entry with no address", () => JSON.stringify({ at: Date.now() })],
    ["an entry with no time", () => JSON.stringify({ address: "/bookings/search" })],
    ["an address that is not text", () => JSON.stringify({ address: 7, at: Date.now() })],
    [
      "a time that is not a number",
      () => JSON.stringify({ address: "/bookings/search", at: "now" }),
    ],
  ])("ignores %s, shows the overview, and removes it", async (_what, make) => {
    keep(make());
    await continueFromLink();
    await focusLandsOn("Overview");
    expect(window.location.pathname).toBe("/");
    expect(kept()).toBeNull();
  });

  it("shows the overview when nothing was kept", async () => {
    await continueFromLink();
    await focusLandsOn("Overview");
    expect(window.location.pathname).toBe("/");
    expect(kept()).toBeNull();
  });

  it("returns only once: the next sign-in finds nothing kept", async () => {
    keep(entry("/bookings/search"));
    await continueFromLink();
    await heading("Search bookings");
    cleanup();
    await continueFromLink();
    await focusLandsOn("Overview");
    expect(window.location.pathname).toBe("/");
  });

  it("keeps the page when the sign-in link does not work, for the next try", async () => {
    keep(entry(bookingPath));
    vi.stubGlobal("fetch", api({ "POST /api/v1/auth/sessions": [() => status(400)] }));
    const App = await loadApp("#token=synthetic-used-link");
    render(<App />);
    await focusLandsOn("Finish signing in");
    fireEvent.click(screen.getByRole("button", { name: "Continue signing in" }));
    await focusLandsOn("Sign in");
    expect(JSON.parse(kept() ?? "null")).toMatchObject({ address: bookingPath });
  });

  it("stores the page when the person is found signed out on it", async () => {
    await openSignedOutAt(bookingPath);
    expect(JSON.parse(kept() ?? "null")).toEqual({ address: bookingPath, at: Date.now() });
  });

  it("stores a page's query with it, since a day and a trip are in it", async () => {
    const trip = "bc5f3492-d330-487d-8078-7221db331801";
    await openSignedOutAt(`/bookings?day=2026-11-10&trip=${trip}`);
    expect(JSON.parse(kept() ?? "null")).toEqual({
      address: `/bookings?day=2026-11-10&trip=${trip}`,
      at: Date.now(),
    });
  });

  it.each([
    ["the overview", "/"],
    ["a page the console does not have", "/not-a-page"],
    ["a booking address that is not a booking", "/bookings/not-an-id"],
  ])("stores nothing when the person is found signed out on %s", async (_what, address) => {
    await openSignedOutAt(address);
    expect(kept()).toBeNull();
  });

  it.each([
    ["the overview", "/"],
    ["a page the console does not have", "/not-a-page"],
  ])(
    "drops a page kept earlier when the person is later found signed out on %s, so sign-in opens there",
    async (_what, address) => {
      // Found signed out on a booking at 10:00, then the tab was closed.
      keep(entry(bookingPath, 20 * minute));
      await openSignedOutAt(address);
      expect(kept()).toBeNull();
      cleanup();
      await continueFromLink();
      await focusLandsOn("Overview");
      expect(window.location.pathname).toBe("/");
    },
  );

  it("keeps the newer page when the person is later found signed out on another one", async () => {
    keep(entry("/bookings/search", 20 * minute));
    await openSignedOutAt(bookingPath);
    expect(JSON.parse(kept() ?? "null")).toEqual({ address: bookingPath, at: Date.now() });
  });

  it("stores nothing for a sign-in screen that opens with a notice, as after a link that failed", async () => {
    vi.stubGlobal("fetch", api({ "POST /api/v1/auth/sessions": [() => status(400)] }));
    const App = await loadApp("#token=synthetic-used-link");
    window.history.replaceState(null, "", bookingPath);
    render(<App />);
    await focusLandsOn("Finish signing in");
    fireEvent.click(screen.getByRole("button", { name: "Continue signing in" }));
    await focusLandsOn("Sign in");
    expect(
      screen.getByText("That sign-in link is invalid, already used, or expired."),
    ).toBeTruthy();
    expect(kept()).toBeNull();
  });

  it("forgets the page, and does not store the one it was on, when the person signs out on purpose", async () => {
    keep(entry(bookingPath));
    vi.stubGlobal(
      "fetch",
      api({
        "GET /api/v1/me": [() => json(me()), () => status(401)],
        "DELETE /api/v1/auth/sessions/current": [() => new Response(null, { status: 204 })],
      }),
    );
    const App = await loadApp();
    window.history.replaceState(null, "", "/bookings/search");
    render(<App />);
    await heading("Search bookings");
    fireEvent.click(screen.getByRole("button", { name: "Sign out" }));
    await focusLandsOn("Sign in");
    expect(screen.getByText("You're signed out")).toBeTruthy();
    expect(kept()).toBeNull();
  });

  it("forgets the last search too, so the next person at this browser finds none", async () => {
    vi.stubGlobal(
      "fetch",
      api({
        "GET /api/v1/me": [() => json(me()), () => status(401)],
        "DELETE /api/v1/auth/sessions/current": [() => new Response(null, { status: 204 })],
      }),
    );
    const App = await loadApp();
    // The search memory of the console that was just loaded, not another copy of it.
    const { rememberSearch, recallSearch } = await import("./search/model.ts");
    rememberSearch(tenantId, { text: "maya", from: "", to: "" });
    expect(recallSearch(tenantId)).toBeDefined();
    render(<App />);
    await heading("Overview");
    fireEvent.click(screen.getByRole("button", { name: "Sign out" }));
    await focusLandsOn("Sign in");
    expect(recallSearch(tenantId)).toBeUndefined();
  });

  it("leaves nothing behind even when the sign-out does not reach the API", async () => {
    vi.stubGlobal(
      "fetch",
      api({
        "GET /api/v1/me": [() => json(me()), () => json(me())],
        "DELETE /api/v1/auth/sessions/current": [
          () => {
            throw new TypeError("Failed to fetch");
          },
        ],
      }),
    );
    const App = await loadApp();
    const { rememberSearch, recallSearch } = await import("./search/model.ts");
    rememberSearch(tenantId, { text: "maya", from: "", to: "" });
    keep(entry(bookingPath));
    render(<App />);
    await heading("Overview");
    fireEvent.click(screen.getByRole("button", { name: "Sign out" }));
    expect(await screen.findByText("Sign-out didn't finish")).toBeTruthy();
    expect(kept()).toBeNull();
    expect(recallSearch(tenantId)).toBeUndefined();
  });
});
