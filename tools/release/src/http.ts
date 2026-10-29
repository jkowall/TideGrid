/**
 * HTTP for smoke, last-seat, isolation, and stripe-smoke: target profiles, the
 * tenant hosts, and a small public-API client. Every call is counted, so a run
 * can show it stayed inside the public limiter (30 commands per 60 s per
 * address per tenant, apps/api-worker/wrangler.jsonc:66-70).
 */
import { randomBytes, randomUUID } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { request as httpRequest } from "node:http";
import { join } from "node:path";
import type { Deps, Fetch } from "./core.ts";
import { Refusal } from "./core.ts";
import { classifyHost, classifyUrl } from "./gate.ts";

export type ProfileName = "local" | "preview";

export interface TenantHost {
  /** host[:port] as the browser sends it in Origin. */
  host: string;
  slug: string;
}

export interface Profile {
  name: ProfileName;
  apiBase: string;
  guestScheme: "http" | "https";
  hosts: TenantHost[];
}

export interface TenantMeta {
  slug: string;
  name: string;
  previewHostname: string;
}

export function tenantMetas(repoRoot: string): TenantMeta[] {
  const dir = join(repoRoot, "config/tenants");
  return readdirSync(dir)
    .filter((f) => f.endsWith(".json"))
    .sort()
    .map((f) => {
      const m = JSON.parse(readFileSync(join(dir, f), "utf8"));
      return { slug: m.slug, name: m.brand.name, previewHostname: m.previewHostname };
    });
}

/** `host[=slug]` items; the slug defaults to the first label. */
export function parseHosts(raw: string | undefined): TenantHost[] {
  if (!raw) throw new Refusal("--hosts is required: host[=slug],host[=slug]");
  return raw.split(",").map((item) => {
    const [host, slug] = item.trim().split("=");
    if (!host || !/^[a-z0-9.-]+(:\d{1,5})?$/.test(host)) throw new Refusal(`bad host ${item}`);
    return { host, slug: slug ?? (host.split(".")[0] as string) };
  });
}

/**
 * Build a profile and check it fits its targets: a local profile only on local
 * targets, a preview profile only on live ones. A mismatch would test the
 * wrong expectations (local accepts http, ports, and staff routes on loopback).
 */
export function profileFor(
  name: string | undefined,
  apiBase: string | undefined,
  hosts: TenantHost[],
): Profile {
  if (name !== "local" && name !== "preview")
    throw new Refusal("--profile must be local or preview");
  if (!apiBase) throw new Refusal("--api (or --base) is required");
  const kinds = new Set([
    classifyUrl(apiBase),
    ...hosts.map((h) => classifyHost(h.host.split(":")[0] ?? "")),
  ]);
  const want = name === "local" ? "local" : "live";
  if (kinds.size !== 1 || !kinds.has(want)) {
    throw new Refusal(
      `--profile ${name} needs ${want} targets only; got ${[...kinds].join(" and ")}`,
    );
  }
  if (name === "preview" && !apiBase.startsWith("https://"))
    throw new Refusal("the preview API is https");
  return {
    name,
    apiBase: apiBase.replace(/\/$/, ""),
    guestScheme: name === "local" ? "http" : "https",
    hosts,
  };
}

export const originOf = (p: Profile, h: TenantHost) => `${p.guestScheme}://${h.host}`;

/** fetch for *.localhost: connect to 127.0.0.1, send the real Host. */
export const nodeLocalFetch: Fetch = (input, init = {}) =>
  new Promise((resolve, reject) => {
    const url = new URL(input);
    const headers: Record<string, string> = { host: url.host };
    new Headers(init.headers).forEach((v, k) => {
      headers[k] = v;
    });
    const req = httpRequest(
      {
        host: "127.0.0.1",
        port: Number(url.port || 80),
        path: `${url.pathname}${url.search}`,
        method: init.method ?? "GET",
        headers,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("end", () => {
          const h = new Headers();
          for (const [k, v] of Object.entries(res.headers)) {
            if (typeof v === "string") h.set(k, v);
            else if (Array.isArray(v)) h.set(k, v.join(", "));
          }
          resolve(new Response(Buffer.concat(chunks), { status: res.statusCode ?? 0, headers: h }));
        });
      },
    );
    req.on("error", reject);
    if (init.body) req.write(String(init.body));
    req.end();
  });

export interface Answer {
  status: number;
  headers: Headers;
  json: Record<string, unknown>;
  text: string;
  requestId: string | null;
}

export interface CallLog {
  /** Limited public commands, per tenant slug. */
  limited: Map<string, number>;
  lines: string[];
}

export const newCallLog = (): CallLog => ({ limited: new Map(), lines: [] });

export class RateLimited extends Error {
  override name = "RateLimited";
}

/** A public-API client for one tenant host. `limited` marks calls the limiter counts. */
export function client(deps: Deps, profile: Profile, host: TenantHost, log: CallLog) {
  const origin = originOf(profile, host);
  return async function call(
    method: string,
    path: string,
    options: {
      body?: unknown;
      headers?: Record<string, string>;
      limited?: boolean;
      origin?: string;
    } = {},
  ): Promise<Answer> {
    const headers: Record<string, string> = {
      origin: options.origin ?? origin,
      ...options.headers,
    };
    if (options.body !== undefined) headers["content-type"] = "application/json";
    const url = `${profile.apiBase}${path}`;
    const f =
      classifyUrl(url) === "local" && new URL(url).hostname.endsWith(".localhost")
        ? deps.localFetch
        : deps.fetch;
    const res = await f(url, {
      method,
      headers,
      ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
    });
    const text = await res.text();
    let json: Record<string, unknown> = {};
    try {
      json = JSON.parse(text) as Record<string, unknown>;
    } catch {
      // Not JSON; the status says enough.
    }
    if (options.limited) log.limited.set(host.slug, (log.limited.get(host.slug) ?? 0) + 1);
    const requestId = res.headers.get("x-request-id");
    log.lines.push(
      `${host.slug} ${method} ${path.replace(/[0-9a-f-]{36}/g, "<id>")} -> ${res.status}${requestId ? ` (${requestId})` : ""}`,
    );
    if (res.status === 429)
      throw new RateLimited(`${host.slug}: 429 ${(json.error as { code?: string })?.code ?? ""}`);
    return { status: res.status, headers: res.headers, json, text, requestId };
  };
}

export type Call = ReturnType<typeof client>;

export const errorCode = (a: Answer) =>
  (a.json.error as { code?: string } | undefined)?.code ?? null;

/** Guest-host GET (manifest, page headers). */
export async function guestGet(deps: Deps, profile: Profile, host: TenantHost, path: string) {
  const url = `${originOf(profile, host)}${path}`;
  const f = profile.name === "local" ? deps.localFetch : deps.fetch;
  return f(url, { redirect: "manual" });
}

export interface Trip {
  tripId: string;
  localDate: string;
  product: { name: string; kind: string };
  capacity: { total: number; remaining: number };
}

/** Bookable trips from `fromDays` days out, a week at a time, for up to `weeks` weeks. Reads are not limited. */
export async function findTrips(
  deps: Deps,
  call: Call,
  options: {
    product: string;
    party: number;
    fromDays: number;
    weeks?: number;
    weekdays?: number[];
  },
): Promise<Trip[]> {
  const found: Trip[] = [];
  const day = (n: number) =>
    new Date(deps.now().getTime() + n * 86_400_000).toISOString().slice(0, 10);
  for (let w = 0; w < (options.weeks ?? 6); w++) {
    const from = day(options.fromDays + w * 7);
    const to = day(options.fromDays + w * 7 + 6);
    const a = await call("GET", `/v1/public/trips?from=${from}&to=${to}&party=${options.party}`);
    if (a.status !== 200) throw new Error(`trips ${a.status} ${errorCode(a) ?? ""}`);
    for (const t of (a.json.trips ?? []) as Trip[]) {
      const weekday = ((new Date(`${t.localDate}T12:00:00Z`).getUTCDay() + 6) % 7) + 1;
      if (t.product.name !== options.product) continue;
      if (options.weekdays && !options.weekdays.includes(weekday)) continue;
      found.push(t);
    }
  }
  return found;
}

export const syntheticBooker = (label: string) => ({
  name: `Synthetic ${label} Guest`,
  email: `nov1.${label.toLowerCase()}.${randomBytes(4).toString("hex")}@nov1-acceptance.test`,
});

export interface OpenCheckout {
  sessionId: string;
  secret: string;
  paymentRef: string | null;
  clientSecret: string | null;
  provider: string | null;
}

/** A quote for a party: tickets on a shared trip, guests on a charter. One limited call. */
export async function quote(call: Call, trip: Trip, party: number): Promise<Answer> {
  const offer = await call("GET", `/v1/public/trips/${trip.tripId}/offer`);
  const tickets = ((offer.json.offer as { tickets?: { code: string }[] } | undefined)?.tickets ??
    []) as { code: string }[];
  return call("POST", "/v1/public/quotes", {
    limited: true,
    headers: { "idempotency-key": `nov1-q-${randomUUID()}` },
    body: {
      tripId: trip.tripId,
      party:
        trip.product.kind === "private_charter"
          ? { kind: "charter", guests: party }
          : { kind: "tickets", tickets: [{ code: tickets[0]?.code ?? "adult", quantity: party }] },
      addOns: [],
    },
  });
}

/** Open a checkout for a quote. One limited call. */
export async function checkout(
  call: Call,
  q: Answer,
  label: string,
): Promise<{ answer: Answer; open: OpenCheckout | null }> {
  const stored = q.json.quote as { quoteId: string; policy: { version: number } };
  const secret = randomBytes(32).toString("base64url");
  const answer = await call("POST", "/v1/public/checkout-sessions", {
    limited: true,
    headers: { "idempotency-key": `nov1-c-${randomUUID()}` },
    body: {
      quoteId: stored.quoteId,
      acceptedPolicyVersion: stored.policy.version,
      booker: syntheticBooker(label),
      checkoutSecret: secret,
    },
  });
  if (answer.status !== 201) return { answer, open: null };
  const session = answer.json.checkoutSession as { id: string };
  const payment = answer.json.payment as {
    paymentRef: string;
    clientSecret: string;
    provider: string;
  } | null;
  return {
    answer,
    open: {
      sessionId: session.id,
      secret,
      paymentRef: payment?.paymentRef ?? null,
      clientSecret: payment?.clientSecret ?? null,
      provider: payment?.provider ?? null,
    },
  };
}

/** Pay through the fake provider's control, which posts the signed event. One limited call. */
export async function payFake(call: Call, open: OpenCheckout): Promise<Answer> {
  return call("POST", `/v1/fake-provider/payments/${open.paymentRef}/succeed`, {
    limited: true,
    headers: { authorization: `Bearer ${open.clientSecret}` },
    body: {},
  });
}

export async function checkoutState(call: Call, open: OpenCheckout): Promise<string | null> {
  const a = await call("GET", `/v1/public/checkout-sessions/${open.sessionId}`, {
    headers: { authorization: `Bearer ${open.secret}` },
  });
  return (a.json.checkoutSession as { state?: string } | undefined)?.state ?? null;
}
