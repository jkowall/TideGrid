import type { Experience } from "../bootstrap.ts";

/** The message sw.ts listens for; the same string as its SKIP_WAITING. */
const SKIP_WAITING = "SKIP_WAITING";

/**
 * The page's side of the service worker (G2.14b), and the only page module
 * that touches the service worker or CacheStorage APIs.
 *
 * - On a ready operator, register /sw.js at scope / with updateViaCache
 *   "none", so the browser always asks the network for the script, and the
 *   guest Worker can swap in the kill switch for a host that stopped
 *   resolving. Production builds only: the dev server serves no sw.js.
 * - On that same page load, once, a worker already waiting (a new build found
 *   by an earlier visit's update check) is asked to take over. The worker
 *   does so only when this is the site's one open window (G2.14b, D11(a)).
 *   "Try again" after a failed bootstrap never asks again.
 * - When the API says no operator is published here (a readable
 *   tenant_not_found), unregister every worker and delete every cache: the
 *   page's half of the kill switch. A failed or timed-out bootstrap is not a
 *   miss and clears nothing.
 *
 * Neither ever touches localStorage, sessionStorage, or IndexedDB. Every
 * failure is swallowed: the booking site works without a service worker.
 */
export function followExperience(experience: Experience): void {
  if (experience.kind === "ready") void registerServiceWorker();
  else if (experience.kind === "not-published") void clearServiceWorkers();
}

export async function registerServiceWorker(): Promise<void> {
  if (!import.meta.env.PROD) return;
  try {
    if (!("serviceWorker" in navigator)) return;
    const registration = await navigator.serviceWorker.register("/sw.js", {
      scope: "/",
      updateViaCache: "none",
    });
    activateWaitingWorker(registration);
  } catch {
    // Private browsing, a blocked script, or no support: no offline page, nothing else.
  }
}

/** Whether this page load has already asked; module state lives as long as the page. */
const thisPageLoad = { asked: false };

/** Ask a worker that is waiting to take over, at most once per page load. */
export function activateWaitingWorker(
  registration: { waiting: { postMessage(message: unknown): void } | null },
  pageLoad: { asked: boolean } = thisPageLoad,
): void {
  if (pageLoad.asked) return;
  pageLoad.asked = true;
  registration.waiting?.postMessage({ type: SKIP_WAITING });
}

export async function clearServiceWorkers(): Promise<void> {
  try {
    if ("serviceWorker" in navigator) {
      const registrations = await navigator.serviceWorker.getRegistrations();
      await Promise.all(registrations.map((r) => r.unregister()));
    }
  } catch {
    // Nothing registered, or the API is blocked.
  }
  try {
    if (typeof caches !== "undefined") {
      const keys = await caches.keys();
      await Promise.all(keys.map((key) => caches.delete(key)));
    }
  } catch {
    // CacheStorage is unavailable in this context.
  }
}
