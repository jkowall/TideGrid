// @vitest-environment jsdom
import { cleanup, render, screen, within } from "@testing-library/react";
import type { PublicBrand } from "@tidegrid/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import { BrandedShell } from "../BrandedShell.tsx";
import { NavigationProvider } from "../navigation.tsx";
import { activateWaitingWorker, followExperience, pageSettled } from "../sw/register.ts";

const tenant = { slug: "demo-reef", name: "Demo Reef Divers" };
const brand = {
  version: 2,
  name: "Demo Reef Divers",
  colors: { primary: "#006d77", accent: "#ffd166" },
  fonts: { display: "bricolage-grotesque", body: "atkinson-hyperlegible-next" },
  contact: { phone: "+13055550199", email: "hello@demo-reef.test" },
  legal: { terms: "/legal/terms", privacy: "https://demo-reef.test/privacy" },
  locale: "en-US",
  capabilities: [],
} as unknown as PublicBrand;

function shell(path: string) {
  return render(
    <NavigationProvider navigate={vi.fn()}>
      <BrandedShell tenant={tenant} brand={brand} path={path} />
    </NavigationProvider>,
  );
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("support pages (G2.14b)", () => {
  it("shows the operator's contact, booking help, waiver help, policy, and platform line", () => {
    shell("/support");
    expect(screen.getByRole("heading", { level: 1, name: "Help and support" })).toBeTruthy();
    for (const name of [
      "Contact Demo Reef Divers",
      "Find or manage my booking",
      "Waivers",
      "Cancellations and refunds",
      "About this booking site",
    ]) {
      expect(screen.getByRole("heading", { level: 2, name })).toBeTruthy();
    }
    const main = within(screen.getByRole("main"));
    expect(main.getByRole("link", { name: /Call/ }).getAttribute("href")).toBe("tel:+13055550199");
    expect(main.getByRole("link", { name: "Manage my booking" }).getAttribute("href")).toBe(
      "/manage",
    );
    expect(main.getByRole("link", { name: "Privacy notice" }).getAttribute("href")).toBe(
      "https://demo-reef.test/privacy",
    );
    // Links on their own line are 44 px tap targets, as the footer's are (UI-1).
    for (const name of ["Terms of booking", "Privacy notice"]) {
      expect(main.getByRole("link", { name }).className).toContain("tap-target");
    }
    expect(screen.getByRole("main").textContent).not.toMatch(/by email/);
    expect(screen.getByRole("main").textContent).toMatch(/synthetic operator/);
    expect(screen.getByRole("main").textContent).toMatch(/proposed platform support hours/i);
    expect(document.title).toBe("Help and support · Demo Reef Divers");
  });

  it("serves the legal aliases as the same pages, in place", () => {
    shell("/terms");
    expect(screen.getByRole("heading", { level: 1, name: "Terms of booking" })).toBeTruthy();
    cleanup();
    shell("/privacy");
    expect(screen.getByRole("heading", { level: 1, name: "Privacy notice" })).toBeTruthy();
    expect(screen.getByRole("main").textContent).toMatch(/placeholder/);
  });

  it("explains offline use without naming the operator in the page", () => {
    shell("/offline");
    const main = screen.getByRole("main");
    expect(within(main).getByRole("heading", { level: 1 }).textContent).toBe(
      "Using this site offline",
    );
    expect(main.textContent).not.toContain("Demo Reef");
    expect(main.textContent).toMatch(/Booking needs a connection/);
    // Neutral: no operator header, footer, or contact anywhere on the page (UI-2).
    expect(document.body.textContent).not.toContain("Demo Reef");
    expect(document.body.textContent).not.toContain("555-0199");
    expect(document.querySelector('a[href^="tel:"], a[href^="mailto:"]')).toBeNull();
  });

  it("links to support from the footer", () => {
    shell("/");
    const footer = within(screen.getByRole("contentinfo"));
    expect(footer.getByRole("link", { name: "Help and support" }).getAttribute("href")).toBe(
      "/support",
    );
  });
});

describe("service worker registration (G2.14b)", () => {
  it("asks a waiting worker to take over on page load, and does nothing without one (D11(a))", () => {
    const postMessage = vi.fn();
    const pageLoad = { asked: false };
    activateWaitingWorker({ waiting: { postMessage } }, pageLoad);
    expect(postMessage).toHaveBeenCalledWith({ type: "SKIP_WAITING" });
    // "Try again" registers again in the same page load: it never asks twice.
    activateWaitingWorker({ waiting: { postMessage } }, pageLoad);
    expect(postMessage).toHaveBeenCalledTimes(1);
    expect(() => activateWaitingWorker({ waiting: null }, { asked: false })).not.toThrow();
  });

  it("asks only after the load event, two frames, and the fonts those frames requested (D11(a))", async () => {
    let load = () => {};
    const frames: (() => void)[] = [];
    let fontsLoaded = () => {};
    const page = {
      document: {
        readyState: "loading",
        fonts: { ready: new Promise<void>((resolve) => (fontsLoaded = resolve)) },
      },
      addEventListener: (_type: "load", listener: () => void) => {
        load = listener;
      },
      requestAnimationFrame: (callback: () => void) => frames.push(callback),
    };
    let settled = false;
    void pageSettled(page).then(() => (settled = true));
    const tick = () => new Promise((r) => setTimeout(r, 0));

    await tick();
    expect(frames).toHaveLength(0);
    load();
    await tick();
    frames.shift()?.();
    await tick();
    frames.shift()?.();
    await tick();
    expect(settled).toBe(false);
    fontsLoaded();
    await tick();
    expect(settled).toBe(true);
  });

  it("clears workers and caches only on a readable not-published answer", async () => {
    const unregister = vi.fn(async () => true);
    const register = vi.fn(async () => ({}));
    const getRegistrations = vi.fn(async () => [{ unregister }]);
    const keys = vi.fn(async () => ["tidegrid-guest-b1"]);
    const del = vi.fn(async () => true);
    vi.stubGlobal("navigator", { serviceWorker: { register, getRegistrations } });
    vi.stubGlobal("caches", { keys, delete: del });

    followExperience({ kind: "failed" });
    followExperience({ kind: "not-ready", tenant });
    await new Promise((r) => setTimeout(r, 0));
    expect(getRegistrations).not.toHaveBeenCalled();
    expect(keys).not.toHaveBeenCalled();

    followExperience({ kind: "not-published" });
    await new Promise((r) => setTimeout(r, 0));
    expect(unregister).toHaveBeenCalledTimes(1);
    expect(del).toHaveBeenCalledWith("tidegrid-guest-b1");

    // Tests run a development build, which never registers a worker.
    followExperience({ kind: "ready", tenant, brand });
    await new Promise((r) => setTimeout(r, 0));
    expect(register).not.toHaveBeenCalled();
  });
});
