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
 * - On that same page load, once, the worker waiting when the page first
 *   reads its registration (once a worker is ready) is asked to take over,
 *   after the page has settled (see pageSettled), and only if it is still
 *   the one waiting. That is usually a new build an earlier visit's update
 *   check found. Rarely this load's own update check finished installing a
 *   newer one before that first read, and then that worker is the one asked;
 *   one that installs while the page settles is left for the next page load,
 *   which asks the version already waiting when it began. The worker takes over only when this is the site's one
 *   open window (G2.14b, D11(a)).
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
    await navigator.serviceWorker.register("/sw.js", {
      scope: "/",
      updateViaCache: "none",
    });
    await navigator.serviceWorker.ready;
    await askWaitingWorker(
      async () => (await navigator.serviceWorker.getRegistration("/"))?.waiting ?? null,
    );
  } catch {
    // Private browsing, a blocked script, or no support: no offline page, nothing else.
  }
}

/** The parts of window that pageSettled reads; a fake in tests. */
export interface SettlingPage {
  document: { readyState: string; fonts?: { ready: Promise<unknown> } };
  addEventListener(type: "load", listener: () => void, options: { once: true }): void;
  requestAnimationFrame(callback: () => void): unknown;
}

/**
 * Resolves once this page load's own startup requests have gone through the
 * old worker: the load event has fired, and two frames have run, so the
 * ready page has rendered and sent its first reads (the trips list). Any web
 * fonts that render requested have loaded too. Every request from a
 * controlled page, the cross-origin API included, is a fetch event on the
 * old worker. The bootstrap calls followExperience before that render. When
 * the page asked before it, in CI the new worker sometimes skipped waiting,
 * Chromium stopped the old one, and the old one restarted within
 * milliseconds and was still running 75 seconds later, with the new worker
 * still waiting. The request that restarted it was most likely the trips
 * read. Asked after this, nothing reached the old worker after the new one
 * skipped waiting, in 22 of 22 runs (verification log, G2.14b follow-up).
 * A hidden tab runs no frames, so it asks once it is shown.
 */
export async function pageSettled(page: SettlingPage = window): Promise<void> {
  if (page.document.readyState !== "complete") {
    await new Promise<void>((resolve) => page.addEventListener("load", resolve, { once: true }));
  }
  for (let frame = 0; frame < 2; frame++) {
    await new Promise<void>((resolve) => page.requestAnimationFrame(resolve));
  }
  await page.document.fonts?.ready;
}

/** Whether this page load has already asked; module state lives as long as the page. */
const thisPageLoad = { asked: false };

/** The one thing the page does with a waiting worker. */
type WaitingWorker = { postMessage(message: unknown): void };

/** Ask a worker that is waiting to take over, at most once per page load. */
export function activateWaitingWorker(
  registration: { waiting: WaitingWorker | null },
  pageLoad: { asked: boolean } = thisPageLoad,
): void {
  if (pageLoad.asked) return;
  pageLoad.asked = true;
  registration.waiting?.postMessage({ type: SKIP_WAITING });
}

/**
 * Note the worker waiting now, let the page settle, then ask that same worker
 * to take over. A worker that replaced it meanwhile, from this load's own
 * update check, is not asked: the next page load asks the version already
 * waiting when it begins (D11(a)). Navigations go network first, so this page
 * is usually that newer build already; the cost is that the newer worker
 * waits one more page load. The browser hands back the same ServiceWorker object for the
 * same worker, so identity tells them apart. Either way this page load has
 * had its one ask.
 */
export async function askWaitingWorker(
  readWaiting: () => Promise<WaitingWorker | null>,
  settle: () => Promise<void> = pageSettled,
  pageLoad: { asked: boolean } = thisPageLoad,
): Promise<void> {
  const noted = await readWaiting();
  if (noted) await settle();
  const now = await readWaiting();
  activateWaitingWorker({ waiting: noted && now === noted ? now : null }, pageLoad);
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
