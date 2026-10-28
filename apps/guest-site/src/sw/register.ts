import type { Experience } from "../bootstrap.ts";

/**
 * The page's side of the service worker (G2.14b), and the only page module
 * that touches the service worker or CacheStorage APIs.
 *
 * - On a ready operator, register /sw.js at scope / with updateViaCache
 *   "none", so the browser always asks the network for the script, and the
 *   guest Worker can swap in the kill switch for a host that stopped
 *   resolving. Production builds only: the dev server serves no sw.js.
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
    await navigator.serviceWorker.register("/sw.js", { scope: "/", updateViaCache: "none" });
  } catch {
    // Private browsing, a blocked script, or no support: no offline page, nothing else.
  }
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
