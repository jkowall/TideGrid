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

  it("says the booking list comes later, and that the calendar shows booked seats now", async () => {
    vi.stubGlobal("fetch", api({ "GET /api/v1/me": [() => json(me())] }));
    const App = await loadApp();
    const { container } = render(<App />);
    await heading("Overview");
    fireEvent.click(screen.getByRole("link", { name: "Bookings" }));
    await focusLandsOn("Bookings");
    expect(screen.getByRole("heading", { name: "The booking list isn't here yet" })).toBeTruthy();
    expect(container.textContent).toContain(
      "comes in a later build. Booked and held seats show on the calendar.",
    );
    // Guests can book now, so the page never says the build takes no bookings.
    expect(container.textContent).not.toMatch(/does not take bookings|No bookings yet/);
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
