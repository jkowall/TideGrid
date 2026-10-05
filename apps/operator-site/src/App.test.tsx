// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { MeResponse } from "@tidegrid/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

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
