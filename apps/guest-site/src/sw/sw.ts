/**
 * The guest site's service worker (G2.14b). Vite builds this file, with no
 * imports, into an unhashed /sw.js at the root scope, injecting the build's
 * precache list (see vite.config.ts). The guest Worker serves it only for a
 * host with an active, verified hostname; any other host gets the kill
 * switch in kill-switch.ts.
 *
 * Cache rules. The PWA is never an offline booking or operational authority:
 * no cache or client state ever confirms inventory, money, or stored value.
 *
 * - Precache only the content-hashed /assets/*.js and /assets/*.css of this
 *   build, and one neutral offline page that names no tenant, kept under a
 *   fixed key, never under a request's URL.
 * - Fonts (/assets/*.woff2) may be cached as they are fetched, cache first.
 * - Never cache, and never answer: a cross-origin request (the API, and
 *   with it /v1/public/tenant), a request that is not a GET, one that carries
 *   Authorization, or a navigation's own response, because a navigation's
 *   URL keeps its #t= fragment and /manage, /waiver, and /book carry state.
 *   The manifest, the icons, and sw.js pass through to the network too.
 * - Navigations go to the network first and fall back to the offline page.
 * - Cache names carry the build id; activation deletes every other cache.
 * - Update policy (G2.14b, D11(a)): a new version installs and waits. The
 *   next page load finds it waiting and asks it to take over, with a
 *   SKIP_WAITING message. It takes over only when the window that asked is
 *   the site's only open window, looking for up to 15 seconds after the ask:
 *   skipping waiting would switch every open window to the new worker at
 *   once, and its activation deletes the old build's cache. With another tab
 *   or the installed app still open after that, it keeps waiting, until the
 *   browser activates it when they all close, or a later page load asks
 *   again and finds itself alone. That page load
 *   came from the network (navigations go network first), so it is already
 *   the new build the new worker precached.
 */

export interface ServiceWorkerConfig {
  /** Root-relative URLs of this build's hashed /assets/*.js and *.css files. */
  precache: readonly string[];
  /** Changes with every build whose precache list changes. */
  buildId: string;
}

/** Where the neutral offline page lives in the cache: a fixed key, never a request URL. */
export const OFFLINE_KEY = "/__offline";
/**
 * The built offline page the install step fetches: neutral-offline.html,
 * which static assets serve at its path without the extension. Asking for
 * the .html path would answer with a redirect, and a redirected response
 * cannot answer a navigation.
 */
export const OFFLINE_SOURCE = "/neutral-offline";
const CACHE_PREFIX = "tidegrid-guest-";

export function cacheNameFor(buildId: string): string {
  return `${CACHE_PREFIX}${buildId}`;
}

const hashedAsset = /^\/assets\/[A-Za-z0-9._-]+\.(?:js|css)$/;
const font = /^\/assets\/[A-Za-z0-9._-]+\.woff2$/;

/** Which precache entries are allowed: hashed scripts and styles under /assets only. */
export function precacheEntries(precache: readonly string[]): string[] {
  return precache.filter((path) => hashedAsset.test(path));
}

export type RequestRoute = "pass" | "navigate" | "asset" | "font";

export interface RequestLike {
  url: string;
  method: string;
  mode: string;
  headers: { has(name: string): boolean };
}

/** What the fetch handler does with a request. Everything unlisted passes through untouched. */
export function routeRequest(
  request: RequestLike,
  origin: string,
  precache: ReadonlySet<string>,
): RequestRoute {
  let url: URL;
  try {
    url = new URL(request.url);
  } catch {
    return "pass";
  }
  if (url.origin !== origin) return "pass";
  if (request.method !== "GET") return "pass";
  if (request.headers.has("authorization")) return "pass";
  if (request.mode === "navigate") return "navigate";
  if (url.search) return "pass";
  if (precache.has(url.pathname)) return "asset";
  if (font.test(url.pathname)) return "font";
  return "pass";
}

/** The parts of a cache the worker uses. */
export interface CacheLike {
  match(request: RequestInfo | string): Promise<Response | undefined>;
  put(request: RequestInfo | string, response: Response): Promise<void>;
  addAll(requests: string[]): Promise<void>;
}

export interface CacheStorageLike {
  open(name: string): Promise<CacheLike>;
  keys(): Promise<string[]>;
  delete(name: string): Promise<boolean>;
}

interface ExtendableEventLike {
  waitUntil(promise: Promise<unknown>): void;
}

interface ClientLike {
  id: string;
}

interface MessageEventLike {
  data: unknown;
  /** The client that posted the message: the asking page's window. */
  source?: ClientLike | null;
  waitUntil?(promise: Promise<unknown>): void;
}

/** What a page posts to its waiting worker on load (src/sw/register.ts). */
export const SKIP_WAITING = "SKIP_WAITING";

interface FetchEventLike extends ExtendableEventLike {
  request: Request;
  respondWith(response: Promise<Response> | Response): void;
}

/** The parts of the service worker global scope the worker uses. */
export interface ServiceWorkerScopeLike {
  location: { origin: string };
  caches: CacheStorageLike;
  clients: {
    matchAll(options: {
      type: "window";
      includeUncontrolled: boolean;
    }): Promise<readonly ClientLike[]>;
  };
  fetch(request: RequestInfo | string, init?: RequestInit): Promise<Response>;
  skipWaiting(): Promise<void>;
  addEventListener(
    type: "install" | "activate",
    listener: (event: ExtendableEventLike) => void,
  ): void;
  addEventListener(type: "fetch", listener: (event: FetchEventLike) => void): void;
  addEventListener(type: "message", listener: (event: MessageEventLike) => void): void;
}

/**
 * When a page load's take-over request looks for the site to be down to the
 * asking window alone: at once, then 1, 3, 7, and 15 seconds after the ask. A
 * window that just closed, or the document a reload replaced, can stay on the
 * browser's client list for a moment. A window that is really open stays on
 * it, and the worker keeps waiting; so does it when the asker leaves.
 */
export const TAKE_OVER_CHECKS_MS: readonly number[] = [0, 1_000, 2_000, 4_000, 8_000];

/** Install the worker's listeners on a scope: the real one in sw.js, a fake in tests. */
export function installServiceWorker(
  scope: ServiceWorkerScopeLike,
  config: ServiceWorkerConfig,
  options: { takeOverChecksMs?: readonly number[] } = {},
) {
  const checks = options.takeOverChecksMs ?? TAKE_OVER_CHECKS_MS;
  const name = cacheNameFor(config.buildId);
  const entries = precacheEntries(config.precache);
  const precached = new Set(entries);

  scope.addEventListener("install", (event) => {
    event.waitUntil(
      (async () => {
        const cache = await scope.caches.open(name);
        await cache.addAll(entries);
        const offline = await scope.fetch(OFFLINE_SOURCE, { cache: "no-store" });
        if (offline.ok) {
          // A fresh response, so nothing about how it was fetched (such as
          // a redirect) can stop it answering a navigation later.
          const body = await offline.blob();
          await cache.put(
            OFFLINE_KEY,
            new Response(body, { status: 200, headers: offline.headers }),
          );
        }
      })(),
    );
  });

  // D11(a): only a page's load asks a waiting worker to take over, and it
  // does so only when the asking window is the site's one open window.
  scope.addEventListener("message", (event) => {
    if ((event.data as { type?: unknown } | null)?.type !== SKIP_WAITING) return;
    const asker = event.source?.id;
    if (!asker) return;
    const takeOver = (async () => {
      for (const delay of checks) {
        if (delay > 0) await new Promise((resolve) => setTimeout(resolve, delay));
        const windows = await scope.clients.matchAll({ type: "window", includeUncontrolled: true });
        const ids = windows.map((w) => w.id);
        // The asker left (it closed, or navigated away): nobody is asking any more.
        if (!ids.includes(asker)) return;
        if (ids.length === 1) {
          await scope.skipWaiting();
          return;
        }
      }
    })();
    event.waitUntil?.(takeOver);
  });

  scope.addEventListener("activate", (event) => {
    event.waitUntil(
      (async () => {
        const keys = await scope.caches.keys();
        await Promise.all(
          keys.filter((key) => key !== name).map((key) => scope.caches.delete(key)),
        );
      })(),
    );
  });

  scope.addEventListener("fetch", (event) => {
    const route = routeRequest(event.request, scope.location.origin, precached);
    if (route === "pass") return;
    if (route === "navigate") {
      event.respondWith(
        scope.fetch(event.request).catch(async () => {
          const cache = await scope.caches.open(name);
          return (await cache.match(OFFLINE_KEY)) ?? Response.error();
        }),
      );
      return;
    }
    event.respondWith(
      (async () => {
        const cache = await scope.caches.open(name);
        const hit = await cache.match(event.request);
        if (hit) return hit;
        const response = await scope.fetch(event.request);
        // Only a font, and only a complete same-origin answer, is kept.
        if (route === "font" && response.ok && response.type === "basic") {
          await cache.put(event.request, response.clone());
        }
        return response;
      })(),
    );
  });
}

/** Replaced by the build with this build's config; absent in tests. */
declare const __TIDEGRID_SW__: ServiceWorkerConfig | undefined;

if (typeof __TIDEGRID_SW__ !== "undefined") {
  installServiceWorker(self as unknown as ServiceWorkerScopeLike, __TIDEGRID_SW__);
}
