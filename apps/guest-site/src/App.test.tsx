// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "./App.tsx";
import { loadExperience } from "./bootstrap.ts";
import { NotReadyState } from "./States.tsx";

vi.mock("./bootstrap.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./bootstrap.ts")>();
  return { ...actual, loadExperience: vi.fn(actual.loadExperience) };
});

const svg =
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><circle cx="32" cy="32" r="30"/></svg>';
const markSrc = `data:image/svg+xml;base64,${Buffer.from(svg).toString("base64")}`;
const tenant = { slug: "demo-harbor", name: "Demo Harbor Charters" };
const brand = {
  version: 1,
  name: "Demo Harbor Charters",
  colors: { primary: "#0b3c5d", accent: "#e0a526" },
  fonts: { display: "fraunces", body: "source-sans-3" },
  logo: { src: markSrc, kind: "mark", alt: "Demo Harbor Charters", width: 64, height: 64 },
  contact: { phone: "+13055550142" },
  legal: { terms: "/legal/terms", privacy: "/legal/privacy" },
  locale: "en-US",
  capabilities: [],
};

const ready = () =>
  new Response(JSON.stringify({ tenant, brand }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });

const noTrips = () =>
  new Response(JSON.stringify({ trips: [] }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });

/** The bootstrap answers `tenant`; the trips list answers `trips`. */
const site =
  (tenantAnswer: () => Response = ready, trips: () => Response = noTrips) =>
  async (input: RequestInfo | URL) =>
    String(input).includes("/v1/public/trips") ? trips() : tenantAnswer();

beforeEach(() => {
  document.head.innerHTML =
    '<meta name="theme-color" content="#f6f7f6"><link rel="icon" href="/favicon.ico" sizes="32x32"><link rel="icon" href="/favicon.svg" type="image/svg+xml">';
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.mocked(loadExperience).mockClear();
});

describe("guest app", () => {
  it("leaves focus alone on a first load, trips included", async () => {
    vi.stubGlobal("fetch", vi.fn(site()));
    render(<App />);
    await screen.findByRole("heading", { level: 1, name: "Demo Harbor Charters" });
    await screen.findByRole("heading", { name: "No trips in these dates" });
    // Let any pending effects run before checking that nothing moved focus.
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(document.activeElement).toBe(document.body);
  });

  it("lists upcoming trips on the home page in place of the old empty state", async () => {
    vi.stubGlobal("fetch", vi.fn(site()));
    render(<App />);
    const trips = await screen.findByRole("region", { name: "Upcoming trips" });
    expect(await screen.findByRole("combobox", { name: "Party size" })).toBeTruthy();
    expect(trips.textContent).not.toContain("No trips are open for online booking yet");
    // Discovery only: nothing on the page books or checks out. ("Terms of booking" is a policy link.)
    expect(screen.queryByRole("button", { name: /^(book|checkout|check out)/i })).toBeNull();
    expect(screen.queryByRole("link", { name: /^(book|checkout|check out)/i })).toBeNull();
  });

  it("moves focus to the page heading when Try again brings the site in", async () => {
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockRejectedValueOnce(new TypeError("Failed to fetch"))
      .mockImplementation(site());
    vi.stubGlobal("fetch", fetch);
    render(<App />);
    fireEvent.click(await screen.findByRole("button", { name: "Try again" }));
    const heading = await screen.findByRole("heading", { level: 1, name: "Demo Harbor Charters" });
    await waitFor(() => expect(document.activeElement).toBe(heading));
    // The trips list arriving afterwards leaves focus where the shell put it.
    await screen.findByRole("heading", { name: "No trips in these dates" });
    expect(document.activeElement).toBe(heading);
  });

  it("shows the failure screen when the loader itself throws", async () => {
    vi.mocked(loadExperience).mockRejectedValueOnce(
      new TypeError("AbortSignal.any is not a function"),
    );
    render(<App />);
    expect(
      await screen.findByRole("heading", { name: "We couldn't load this booking site" }),
    ).toBeTruthy();
  });

  it("shows the operator's mark as the tab icon and restores the neutral icon", async () => {
    vi.stubGlobal("fetch", vi.fn(site()));
    const { unmount } = render(<App />);
    await screen.findByRole("heading", { level: 1, name: "Demo Harbor Charters" });
    const svgIcon = document.querySelector('link[rel="icon"][type="image/svg+xml"]');
    expect(svgIcon?.getAttribute("href")).toBe(markSrc);
    unmount();
    expect(svgIcon?.getAttribute("href")).toBe("/favicon.svg");
  });

  it("keeps the neutral icon for a lockup logo", async () => {
    const lockup = { ...brand, logo: { ...brand.logo, kind: "lockup", width: 160, height: 40 } };
    vi.stubGlobal(
      "fetch",
      vi.fn(site(() => new Response(JSON.stringify({ tenant, brand: lockup }), { status: 200 }))),
    );
    render(<App />);
    await screen.findByRole("heading", { level: 1, name: "Demo Harbor Charters" });
    const svgIcon = document.querySelector('link[rel="icon"][type="image/svg+xml"]');
    expect(svgIcon?.getAttribute("href")).toBe("/favicon.svg");
  });

  it("tells a guest to check back, not to contact an operator it cannot name a way to reach", () => {
    render(<NotReadyState tenant={tenant} />);
    const body = document.querySelector(".guest-state__body")?.textContent ?? "";
    expect(body).toBe("Demo Harbor Charters hasn't opened online booking yet. Check back soon.");
    expect(body).not.toMatch(/contact/i);
  });
});
