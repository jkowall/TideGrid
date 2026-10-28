import { readdirSync, readFileSync } from "node:fs";
import type { Page } from "@playwright/test";

export const PORT = 5361;

export function hostUrl(host: string, path = "/"): string {
  return `http://${host}:${PORT}${path}`;
}

/** The synthetic tenants in config/tenants, which drive these checks (08's PWA smoke tests). */
export function tenantManifests(): { slug: string; name: string; primary: string }[] {
  const dir = new URL("../../../config/tenants/", import.meta.url);
  return readdirSync(dir)
    .filter((f) => f.endsWith(".json"))
    .sort()
    .map((f) => {
      const m = JSON.parse(readFileSync(new URL(f, dir), "utf8"));
      return { slug: m.slug, name: m.brand.name, primary: m.brand.colors.primary };
    });
}

export const localHost = (slug: string) => `${slug}.book.localhost`;

/** CSP violations the page reports, collected from the console. */
export function collectCspViolations(page: Page): string[] {
  const violations: string[] = [];
  page.on("console", (message) => {
    const text = message.text();
    if (/Content Security Policy|Refused to/i.test(text)) violations.push(text);
  });
  return violations;
}

/** Chromium's own reading of the page's manifest and installability, over DevTools. */
export async function installability(page: Page) {
  const cdp = await page.context().newCDPSession(page);
  const manifest = (await cdp.send("Page.getAppManifest")) as {
    url: string;
    errors: { message: string; critical: number }[];
    data?: string;
  };
  let installabilityErrors: { errorId: string }[] | null = null;
  try {
    const result = (await cdp.send("Page.getInstallabilityErrors")) as {
      installabilityErrors: { errorId: string }[];
    };
    installabilityErrors = result.installabilityErrors;
  } catch {
    // Not every Chromium build has it; the manifest check still runs.
  }
  await cdp.detach();
  return { manifest, installabilityErrors };
}

/** Register /sw.js the way the page does once its operator is ready. */
export async function registerServiceWorker(page: Page): Promise<void> {
  await page.evaluate(async () => {
    await navigator.serviceWorker.register("/sw.js", { scope: "/", updateViaCache: "none" });
    await navigator.serviceWorker.ready;
  });
}

export async function serviceWorkerState(page: Page) {
  return page.evaluate(async () => ({
    registrations: (await navigator.serviceWorker.getRegistrations()).length,
    caches: await caches.keys(),
  }));
}
