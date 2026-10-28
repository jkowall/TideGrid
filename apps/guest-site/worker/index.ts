import { type PublicBrand, PublicExperienceResponse } from "@tidegrid/contracts";
import { killSwitchSource } from "../src/sw/kill-switch.ts";
import { ICON_CSP, plain, securityHeaders } from "./headers.ts";
import { type IconPurpose, tenantIcon } from "./icons.ts";
import { buildManifest, etagFor, type PublicTenant } from "./manifest.ts";

/**
 * The guest site's edge Worker (G2.14b). The site stays an assets-only SPA:
 * this Worker runs first only for the per-tenant PWA paths (run_worker_first
 * in wrangler.jsonc), and every other request goes straight to the assets.
 *
 * - /manifest.webmanifest: the tenant's manifest, from its published brand.
 * - /icons/icon.svg and /icons/maskable.svg: the tenant's icons.
 * - /sw.js: the service worker for a resolved host, the kill switch for a
 *   host with a definite miss.
 *
 * The tenant comes from the hostname the request reached, read from the
 * request URL only, never from Host, X-Forwarded-Host, or any other header.
 * The Worker asks the API's GuestGateway entrypoint over a service binding,
 * and the gateway checks the host with the strict origin rules itself, so
 * the Worker never forges an Origin and never trusts its own parsing. There
 * is no default tenant and no generic manifest.
 *
 * Fail-closed, and careful about which way: only a definite miss (the
 * gateway says no active, verified hostname matches) serves the kill switch.
 * A gateway error, a timeout, a withheld brand, or an answer that fails the
 * contract is 503 with no-store: the installed service worker stays, and no
 * Clear-Site-Data is sent.
 */

export interface GuestGatewayBinding {
  resolveHost(host: string): Promise<unknown>;
}

export interface GuestEnv {
  ASSETS: { fetch(request: Request): Promise<Response> };
  GuestGateway: GuestGatewayBinding;
}

type Resolution =
  | { kind: "found"; tenant: PublicTenant; brand: PublicBrand | undefined }
  | { kind: "miss" }
  | { kind: "unavailable" };

const GATEWAY_TIMEOUT_MS = 5_000;

async function resolve(request: Request, env: GuestEnv): Promise<Resolution> {
  const host = new URL(request.url).hostname;
  if (host.length === 0 || host.length > 253) return { kind: "miss" };
  let answer: unknown;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    answer = await Promise.race([
      env.GuestGateway.resolveHost(host),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("gateway_timeout")), GATEWAY_TIMEOUT_MS);
      }),
    ]);
  } catch {
    return { kind: "unavailable" };
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
  const kind = (answer as { kind?: unknown } | null)?.kind;
  if (kind === "miss") return { kind: "miss" };
  if (kind !== "found") return { kind: "unavailable" };
  const parsed = PublicExperienceResponse.safeParse(
    (answer as { experience?: unknown }).experience,
  );
  if (!parsed.success) return { kind: "unavailable" };
  return { kind: "found", tenant: parsed.data.tenant, brand: parsed.data.brand };
}

const unavailable = () => plain(503, "This booking site is temporarily unavailable.\n");
const notHere = () => plain(404, "Not found.\n");

/** A service worker's own fetches are governed by its script's policy: same-origin only. */
const SERVICE_WORKER_CSP = "default-src 'none'; connect-src 'self'";

function killSwitch(): Response {
  const headers = securityHeaders("text/javascript; charset=utf-8", "no-store", SERVICE_WORKER_CSP);
  // "cache" only: storage holds an open checkout's secret and the manage and
  // waiver sessions, which belong to the guest, not to this host's mapping.
  headers.set("Clear-Site-Data", '"cache"');
  return new Response(killSwitchSource, { status: 200, headers });
}

async function serviceWorker(request: Request, env: GuestEnv): Promise<Response> {
  const asset = await env.ASSETS.fetch(new Request(new URL("/sw.js", request.url), request));
  const type = asset.headers.get("content-type") ?? "";
  // The SPA fallback answers a missing file with index.html; never serve that as a script.
  if (asset.status !== 200 || !/javascript/.test(type)) return unavailable();
  const headers = securityHeaders("text/javascript; charset=utf-8", "no-cache", SERVICE_WORKER_CSP);
  return new Response(asset.body, { status: 200, headers });
}

function cached(request: Request, etag: string, body: string, headers: Headers): Response {
  headers.set("ETag", etag);
  if (request.headers.get("if-none-match") === etag) {
    return new Response(null, { status: 304, headers });
  }
  return new Response(body, { status: 200, headers });
}

const iconPaths: Record<string, IconPurpose> = {
  "/icons/icon.svg": "any",
  "/icons/maskable.svg": "maskable",
};

function isWorkerPath(path: string): boolean {
  return path === "/manifest.webmanifest" || path === "/sw.js" || path.startsWith("/icons/");
}

export async function handle(request: Request, env: GuestEnv): Promise<Response> {
  const path = new URL(request.url).pathname;
  if (!isWorkerPath(path)) return env.ASSETS.fetch(request);
  if (request.method !== "GET" && request.method !== "HEAD") {
    const res = plain(404, "Not found.\n");
    return new Response(res.body, { status: 405, headers: res.headers });
  }
  const purpose = Object.hasOwn(iconPaths, path) ? iconPaths[path] : undefined;
  if (path.startsWith("/icons/") && !purpose) return notHere();

  const resolution = await resolve(request, env);
  if (resolution.kind === "unavailable") return unavailable();

  if (path === "/sw.js") {
    return resolution.kind === "miss" ? killSwitch() : serviceWorker(request, env);
  }
  // A miss, or an operator that has not published a brand: nothing to install.
  if (resolution.kind === "miss" || !resolution.brand) return notHere();
  const { tenant, brand } = resolution;
  if (path === "/manifest.webmanifest") {
    return cached(
      request,
      etagFor(tenant, brand, "manifest"),
      JSON.stringify(buildManifest(brand)),
      securityHeaders("application/manifest+json", "no-cache"),
    );
  }
  if (!purpose) return notHere();
  return cached(
    request,
    etagFor(tenant, brand, purpose),
    tenantIcon(brand, purpose),
    securityHeaders("image/svg+xml", "no-cache", ICON_CSP),
  );
}

export default {
  fetch: (request: Request, env: GuestEnv) => handle(request, env),
};
