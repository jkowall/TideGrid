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
 * - Update policy: a new version waits for the next navigation (no
 *   skipWaiting), so a page never runs a mix of two builds' chunks (G2.14b,
 *   D11).
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

interface FetchEventLike extends ExtendableEventLike {
  request: Request;
  respondWith(response: Promise<Response> | Response): void;
}

/** The parts of the service worker global scope the worker uses. */
export interface ServiceWorkerScopeLike {
  location: { origin: string };
  caches: CacheStorageLike;
  fetch(request: RequestInfo | string, init?: RequestInit): Promise<Response>;
  addEventListener(
    type: "install" | "activate",
    listener: (event: ExtendableEventLike) => void,
  ): void;
  addEventListener(type: "fetch", listener: (event: FetchEventLike) => void): void;
}

/** Install the worker's listeners on a scope: the real one in sw.js, a fake in tests. */
export function installServiceWorker(scope: ServiceWorkerScopeLike, config: ServiceWorkerConfig) {
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
