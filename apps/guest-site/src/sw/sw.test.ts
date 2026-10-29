import { describe, expect, it } from "vitest";
import { killSwitchSource } from "./kill-switch.ts";
import {
  cacheNameFor,
  installServiceWorker,
  OFFLINE_KEY,
  precacheEntries,
  routeRequest,
  type ServiceWorkerScopeLike,
  SKIP_WAITING,
} from "./sw.ts";

const ORIGIN = "https://demo-harbor.book.tidegrid.us";
const PRECACHE = ["/assets/index-abc123.js", "/assets/index-def456.css"];

type Listener = (event: unknown) => void;

/** A fake service worker scope with in-memory caches and a scripted network. */
function fakeScope(network: (url: string) => Promise<Response>) {
  const listeners = new Map<string, Listener>();
  const stores = new Map<string, Map<string, Response>>();
  const puts: { cache: string; key: string }[] = [];
  const skipped = { count: 0 };
  /** The site's open windows by client id, as clients.matchAll would report them. */
  const windows = { ids: ["asker"] };
  const keyOf = (r: RequestInfo | string) => (typeof r === "string" ? r : r.url);
  const scope: ServiceWorkerScopeLike = {
    location: { origin: ORIGIN },
    caches: {
      async open(name) {
        let store = stores.get(name);
        if (!store) {
          store = new Map();
          stores.set(name, store);
        }
        const s = store;
        return {
          async match(r) {
            const key = keyOf(r);
            return s.get(key) ?? s.get(new URL(key, ORIGIN).pathname)?.clone();
          },
          async put(r, response) {
            const key = keyOf(r);
            puts.push({ cache: name, key });
            s.set(key, response);
          },
          async addAll(urls) {
            for (const url of urls) {
              puts.push({ cache: name, key: url });
              s.set(url, await network(url));
            }
          },
        };
      },
      async keys() {
        return [...stores.keys()];
      },
      async delete(name) {
        return stores.delete(name);
      },
    },
    fetch: (r) => network(typeof r === "string" ? r : r.url),
    clients: {
      matchAll: async () => windows.ids.map((id) => ({ id })),
    },
    skipWaiting: async () => {
      skipped.count += 1;
    },
    addEventListener: ((type: string, listener: Listener) => {
      listeners.set(type, listener);
    }) as ServiceWorkerScopeLike["addEventListener"],
  };
  async function dispatch(type: "install" | "activate") {
    const waits: Promise<unknown>[] = [];
    listeners.get(type)?.({ waitUntil: (p: Promise<unknown>) => waits.push(p) });
    await Promise.all(waits);
  }
  async function fetchEvent(request: Request): Promise<Response | "passed"> {
    let answer: Promise<Response> | Response | undefined;
    listeners.get("fetch")?.({
      request,
      respondWith: (r: Promise<Response> | Response) => {
        answer = r;
      },
      waitUntil: () => {},
    });
    return answer === undefined ? "passed" : await answer;
  }
  /** A message from the window `from` (default: the asking page). */
  async function message(data: unknown, from: string | null = "asker") {
    const waits: Promise<unknown>[] = [];
    listeners.get("message")?.({
      data,
      source: from === null ? null : { id: from },
      waitUntil: (p: Promise<unknown>) => waits.push(p),
    });
    await Promise.all(waits);
  }
  return { scope, stores, puts, skipped, windows, dispatch, fetchEvent, message };
}

const ok = (body: string, type = "text/plain") =>
  Object.defineProperty(new Response(body, { headers: { "content-type": type } }), "type", {
    value: "basic",
  });

function navigation(url: string) {
  // Request.mode cannot be set to "navigate" by script; fake the field.
  const request = new Request(url);
  Object.defineProperty(request, "mode", { value: "navigate" });
  return request;
}

describe("service worker request routing (G2.14b)", () => {
  const precache = new Set(PRECACHE);
  const get = (url: string, init: RequestInit = {}) => new Request(url, init);

  it("passes cross-origin, non-GET, and Authorization requests through untouched", () => {
    for (const request of [
      get("https://api.tidegrid.us/v1/public/tenant"),
      get("https://api.tidegrid.us/v1/public/trips?from=x"),
      get(`${ORIGIN}/assets/index-abc123.js`, { method: "POST", body: "x" }),
      get(`${ORIGIN}/assets/index-abc123.js`, { headers: { authorization: "Bearer x" } }),
    ]) {
      expect(routeRequest(request, ORIGIN, precache)).toBe("pass");
    }
  });

  it("passes the manifest, icons, sw.js, and anything not precached", () => {
    for (const path of [
      "/manifest.webmanifest",
      "/icons/icon.svg",
      "/sw.js",
      "/favicon.svg",
      "/assets/other-999.js",
      "/assets/index-abc123.js?x=1",
    ]) {
      expect(routeRequest(get(`${ORIGIN}${path}`), ORIGIN, precache), path).toBe("pass");
    }
  });

  it("routes navigations, precached assets, and fonts", () => {
    expect(routeRequest(navigation(`${ORIGIN}/manage#t=secret`), ORIGIN, precache)).toBe(
      "navigate",
    );
    expect(routeRequest(get(`${ORIGIN}/assets/index-abc123.js`), ORIGIN, precache)).toBe("asset");
    expect(routeRequest(get(`${ORIGIN}/assets/inter-latin-x1.woff2`), ORIGIN, precache)).toBe(
      "font",
    );
  });

  it("precaches only hashed scripts and styles under /assets", () => {
    expect(
      precacheEntries([
        ...PRECACHE,
        "/index.html",
        "/sw.js",
        "/manifest.webmanifest",
        "/assets/inter.woff2",
        "/assets/index-abc123.js.map",
        "/assets/../secret.js",
        "https://api.tidegrid.us/assets/x.js",
      ]),
    ).toEqual(PRECACHE);
  });
});

describe("service worker caching (G2.14b)", () => {
  function network() {
    const asked: string[] = [];
    let online = true;
    const fn = async (url: string) => {
      asked.push(url);
      if (!online) throw new TypeError("offline");
      if (url.endsWith(".woff2")) return ok("font", "font/woff2");
      return ok(`body of ${url}`);
    };
    return { fn, asked, offline: () => (online = false) };
  }

  it("precaches the build's assets and the neutral offline page under its fixed key", async () => {
    const net = network();
    const sw = fakeScope(net.fn);
    installServiceWorker(sw.scope, { precache: PRECACHE, buildId: "b1" });
    await sw.dispatch("install");
    const store = sw.stores.get(cacheNameFor("b1"));
    expect([...(store?.keys() ?? [])].sort()).toEqual([...PRECACHE, OFFLINE_KEY].sort());
    expect(net.asked).toContain("/neutral-offline");
  });

  it("never caches a navigation, and serves the offline page when the network fails", async () => {
    const net = network();
    const sw = fakeScope(net.fn);
    installServiceWorker(sw.scope, { precache: PRECACHE, buildId: "b1" });
    await sw.dispatch("install");
    const before = sw.puts.length;
    const online = await sw.fetchEvent(navigation(`${ORIGIN}/waiver#t=secret-token`));
    expect(online).not.toBe("passed");
    expect(sw.puts.length).toBe(before);
    net.offline();
    const offline = await sw.fetchEvent(navigation(`${ORIGIN}/manage#t=secret-token`));
    expect(offline === "passed" ? "" : await offline.text()).toBe("body of /neutral-offline");
    expect(sw.puts.length).toBe(before);
    // Nothing keyed by a navigation URL, a fragment, or the API.
    for (const store of sw.stores.values()) {
      for (const key of store.keys()) {
        expect(key).not.toMatch(/#|\/manage|\/waiver|\/book|api\.tidegrid\.us/);
      }
    }
  });

  it("never caches cross-origin, non-GET, or Authorization requests", async () => {
    const net = network();
    const sw = fakeScope(net.fn);
    installServiceWorker(sw.scope, { precache: PRECACHE, buildId: "b1" });
    await sw.dispatch("install");
    const before = sw.puts.length;
    for (const request of [
      new Request("https://api.tidegrid.us/v1/public/tenant"),
      new Request(`${ORIGIN}/assets/inter.woff2`, { method: "POST", body: "x" }),
      new Request(`${ORIGIN}/assets/inter.woff2`, { headers: { authorization: "Bearer x" } }),
    ]) {
      expect(await sw.fetchEvent(request)).toBe("passed");
    }
    expect(sw.puts.length).toBe(before);
  });

  it("serves precached assets cache-first and keeps fonts as they arrive", async () => {
    const net = network();
    const sw = fakeScope(net.fn);
    installServiceWorker(sw.scope, { precache: PRECACHE, buildId: "b1" });
    await sw.dispatch("install");
    const asked = net.asked.length;
    const asset = await sw.fetchEvent(new Request(`${ORIGIN}/assets/index-abc123.js`));
    expect(asset === "passed" ? "" : await asset.text()).toBe("body of /assets/index-abc123.js");
    expect(net.asked.length).toBe(asked);
    await sw.fetchEvent(new Request(`${ORIGIN}/assets/inter-latin-x1.woff2`));
    expect(sw.puts.map((p) => p.key)).toContain(`${ORIGIN}/assets/inter-latin-x1.woff2`);
  });

  it("deletes every other cache on activate", async () => {
    const net = network();
    const sw = fakeScope(net.fn);
    await sw.scope.caches.open("tidegrid-guest-old");
    await sw.scope.caches.open("someone-else");
    installServiceWorker(sw.scope, { precache: PRECACHE, buildId: "b2" });
    await sw.dispatch("install");
    await sw.dispatch("activate");
    expect(await sw.scope.caches.keys()).toEqual([cacheNameFor("b2")]);
  });
});

describe("service worker update policy (G2.14b, D11(a))", () => {
  it("never skips waiting by itself, and takes over only when a page load asks", async () => {
    const sw = fakeScope(async (url) => ok(`body of ${url}`));
    installServiceWorker(sw.scope, { precache: PRECACHE, buildId: "b3" });
    await sw.dispatch("install");
    expect(sw.skipped.count).toBe(0);
    await sw.message({ type: "something-else" });
    await sw.message(null);
    await sw.message("SKIP_WAITING");
    expect(sw.skipped.count).toBe(0);
    await sw.message({ type: SKIP_WAITING });
    expect(sw.skipped.count).toBe(1);
  });

  it("keeps waiting while another window or the installed app is open", async () => {
    const sw = fakeScope(async (url) => ok(`body of ${url}`));
    installServiceWorker(
      sw.scope,
      { precache: PRECACHE, buildId: "b4" },
      { takeOverChecksMs: [0, 1, 1] },
    );
    await sw.dispatch("install");
    sw.windows.ids = ["asker", "installed-app"];
    await sw.message({ type: SKIP_WAITING });
    expect(sw.skipped.count).toBe(0);
    sw.windows.ids = ["asker"];
    await sw.message({ type: SKIP_WAITING });
    expect(sw.skipped.count).toBe(1);
  });

  it("takes over only for the window that asked, never for another one left alone", async () => {
    const sw = fakeScope(async (url) => ok(`body of ${url}`));
    installServiceWorker(
      sw.scope,
      { precache: PRECACHE, buildId: "b6" },
      { takeOverChecksMs: [0, 5, 5] },
    );
    await sw.dispatch("install");
    // The one window open is not the one that asked.
    sw.windows.ids = ["other"];
    await sw.message({ type: SKIP_WAITING });
    expect(sw.skipped.count).toBe(0);
    // A message with no source, or from no window, never takes over.
    sw.windows.ids = ["asker"];
    await sw.message({ type: SKIP_WAITING }, null);
    expect(sw.skipped.count).toBe(0);
    // The asker leaves while a different window stays: no take-over.
    sw.windows.ids = ["asker", "other"];
    const asked = sw.message({ type: SKIP_WAITING });
    setTimeout(() => {
      sw.windows.ids = ["other"];
    }, 2);
    await asked;
    expect(sw.skipped.count).toBe(0);
  });

  it("looks again when the asker is not on the client list yet", async () => {
    const sw = fakeScope(async (url) => ok(`body of ${url}`));
    installServiceWorker(
      sw.scope,
      { precache: PRECACHE, buildId: "b7" },
      { takeOverChecksMs: [0, 5, 5] },
    );
    await sw.dispatch("install");
    // At the first look the list has only the document the reload replaced.
    sw.windows.ids = ["replaced"];
    const asked = sw.message({ type: SKIP_WAITING });
    setTimeout(() => {
      sw.windows.ids = ["asker"];
    }, 2);
    await asked;
    expect(sw.skipped.count).toBe(1);
  });

  it("looks again for a moment, so a window that just closed does not hold it back", async () => {
    const sw = fakeScope(async (url) => ok(`body of ${url}`));
    installServiceWorker(
      sw.scope,
      { precache: PRECACHE, buildId: "b5" },
      { takeOverChecksMs: [0, 5, 5] },
    );
    await sw.dispatch("install");
    sw.windows.ids = ["asker", "just-closed"];
    const asked = sw.message({ type: SKIP_WAITING });
    // The closed window leaves the client list after the first look; the asker stays.
    setTimeout(() => {
      sw.windows.ids = ["asker"];
    }, 2);
    await asked;
    expect(sw.skipped.count).toBe(1);
  });
});

describe("kill-switch rollback (G2.14b)", () => {
  /** Runs the kill-switch source against a fake scope, as a browser would after an update check. */
  async function runKillSwitch(scope: {
    caches: { keys(): Promise<string[]>; delete(k: string): Promise<boolean> };
    registration: { unregister(): Promise<boolean> };
    skipWaiting(): void;
    addEventListener(type: string, fn: (event: unknown) => void): void;
  }) {
    const run = new Function("self", "caches", killSwitchSource);
    run(scope, scope.caches);
  }

  it("takes over, deletes every cache, and unregisters a client that installed build N", async () => {
    const net = async (url: string) => ok(`body of ${url}`);
    const sw = fakeScope(net);
    installServiceWorker(sw.scope, { precache: PRECACHE, buildId: "build-n" });
    await sw.dispatch("install");
    await sw.dispatch("activate");
    expect(await sw.scope.caches.keys()).toEqual([cacheNameFor("build-n")]);

    // Build N+1 ships the kill switch (GUEST_SW_KILL_SWITCH=1, or a host's miss).
    const listeners = new Map<string, (event: unknown) => void>();
    let skipped = false;
    let unregistered = false;
    await runKillSwitch({
      caches: sw.scope.caches,
      registration: {
        unregister: async () => {
          unregistered = true;
          return true;
        },
      },
      skipWaiting: () => {
        skipped = true;
      },
      addEventListener: (type, fn) => listeners.set(type, fn),
    });
    listeners.get("install")?.({});
    const waits: Promise<unknown>[] = [];
    listeners.get("activate")?.({ waitUntil: (p: Promise<unknown>) => waits.push(p) });
    await Promise.all(waits);
    expect(skipped).toBe(true);
    expect(await sw.scope.caches.keys()).toEqual([]);
    expect(unregistered).toBe(true);
    expect(listeners.has("fetch")).toBe(false);
  });
});
