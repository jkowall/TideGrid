/**
 * A small in-memory stand-in for the public API, enough for last-seat,
 * isolation, and stripe-smoke unit tests: trips with capacity, quotes,
 * checkouts that hold seats (with the 3-open-checkouts-per-client rule), the
 * fake pay control, and a per-tenant limiter that answers 429 after 30.
 */
import { randomUUID } from "node:crypto";
import { json } from "./helpers.ts";

interface Trip {
  tripId: string;
  tenant: string;
  product: string;
  kind: "shared_seat" | "private_charter";
  localDate: string;
  total: number;
  confirmed: number;
}

interface Checkout {
  id: string;
  tenant: string;
  tripId: string;
  party: number;
  state: "open" | "confirmed" | "canceled";
  secret: string;
  paymentRef: string;
}

export function fakeApi(options: { limit?: number; hosts?: Record<string, string> } = {}) {
  const limit = options.limit ?? 30;
  const hostTenant = options.hosts ?? {
    "https://demo-harbor.book.tidegrid.us": "demo-harbor",
    "https://demo-reef.book.tidegrid.us": "demo-reef",
    "http://demo-harbor.book.localhost:5361": "demo-harbor",
    "http://demo-reef.book.localhost:5361": "demo-reef",
  };
  const trips: Trip[] = [];
  for (let d = 4; d < 60; d++) {
    const date = new Date(Date.parse("2026-11-01T12:00:00Z") + d * 86_400_000)
      .toISOString()
      .slice(0, 10);
    const weekday = ((new Date(`${date}T12:00:00Z`).getUTCDay() + 6) % 7) + 1;
    trips.push({
      tripId: randomUUID(),
      tenant: "demo-reef",
      product: "Two-Tank Morning Dive",
      kind: "shared_seat",
      localDate: date,
      total: 12,
      confirmed: 0,
    });
    trips.push({
      tripId: randomUUID(),
      tenant: "demo-harbor",
      product: "Sunset Harbor Cruise",
      kind: "shared_seat",
      localDate: date,
      total: 20,
      confirmed: 0,
    });
    if (weekday >= 6)
      trips.push({
        tripId: randomUUID(),
        tenant: "demo-harbor",
        product: "Private Half-Day Charter",
        kind: "private_charter",
        localDate: date,
        total: 12,
        confirmed: 0,
      });
  }
  const quotes = new Map<string, { tenant: string; tripId: string; party: number }>();
  const checkouts = new Map<string, Checkout>();
  const counts = new Map<string, number>();
  let opened = 0;

  const held = (t: Trip) => {
    let n = t.confirmed;
    for (const c of checkouts.values())
      if (c.tripId === t.tripId && c.state === "open")
        n += t.kind === "private_charter" ? t.total : c.party;
    if (t.kind === "private_charter" && t.confirmed > 0) n = t.total;
    return Math.min(n, t.total);
  };
  const remaining = (t: Trip) => t.total - held(t);
  const limited = (tenant: string) => {
    const n = (counts.get(tenant) ?? 0) + 1;
    counts.set(tenant, n);
    return n > limit;
  };

  function handle(
    url: URL,
    method: string,
    headers: Record<string, string>,
    body: unknown,
  ): Response {
    const tenant = hostTenant[headers.origin ?? ""];
    const path = url.pathname;
    if (path === "/v1/health")
      return json(200, { database: "ok", environment: "preview", version: "x" });
    if (!tenant)
      return json(404, {
        error: { code: "tenant_not_found", message: "No operator is published at this address" },
      });
    if (method === "GET" && path === "/v1/public/trips") {
      const party = Number(url.searchParams.get("party") ?? 1);
      const from = url.searchParams.get("from") ?? "";
      const to = url.searchParams.get("to") ?? "";
      const list = trips
        .filter(
          (t) =>
            t.tenant === tenant &&
            t.localDate >= from &&
            t.localDate <= to &&
            remaining(t) >= party,
        )
        .map((t) => ({
          tripId: t.tripId,
          localDate: t.localDate,
          product: { name: t.product, kind: t.kind },
          capacity: { total: t.total, remaining: remaining(t) },
        }));
      return json(200, { trips: list });
    }
    let m = /^\/v1\/public\/trips\/([^/]+)\/offer$/.exec(path);
    if (m) {
      const t = trips.find((x) => x.tripId === m?.[1] && x.tenant === tenant);
      return t
        ? json(200, { offer: { tickets: [{ code: "adult" }] } })
        : json(404, { error: { code: "trip_not_found", message: "No such trip at this address" } });
    }
    if (method === "POST" && path === "/v1/public/quotes") {
      if (limited(tenant)) return json(429, { error: { code: "rate_limited" } });
      const b = body as {
        tripId: string;
        party: { kind: string; guests?: number; tickets?: { quantity: number }[] };
      };
      const t = trips.find((x) => x.tripId === b.tripId && x.tenant === tenant);
      if (!t) return json(404, { error: { code: "trip_not_found" } });
      const party =
        b.party.kind === "charter" ? (b.party.guests ?? 1) : (b.party.tickets?.[0]?.quantity ?? 1);
      if (remaining(t) < (t.kind === "private_charter" ? t.total : party))
        return json(409, { error: { code: "insufficient_capacity" } });
      const quoteId = randomUUID();
      quotes.set(quoteId, { tenant, tripId: t.tripId, party });
      return json(201, { quote: { quoteId, policy: { version: 1 } } });
    }
    m = /^\/v1\/public\/quotes\/([^/]+)$/.exec(path);
    if (m) {
      const q = quotes.get(m[1] ?? "");
      return q && q.tenant === tenant
        ? json(200, { quote: { quoteId: m[1] } })
        : json(404, {
            error: { code: "quote_not_found", message: "No such quote at this address" },
          });
    }
    if (method === "POST" && path === "/v1/public/checkout-sessions") {
      if (limited(tenant)) return json(429, { error: { code: "rate_limited" } });
      const b = body as { quoteId: string; checkoutSecret: string; booker: { email: string } };
      if (!b.booker.email.endsWith(".test")) return json(400, { error: { code: "not_synthetic" } });
      const q = quotes.get(b.quoteId);
      if (!q || q.tenant !== tenant) return json(404, { error: { code: "quote_not_found" } });
      const open = [...checkouts.values()].filter(
        (c) => c.tenant === tenant && c.state === "open",
      ).length;
      if (open >= 3) return json(429, { error: { code: "too_many_checkouts" } });
      const t = trips.find((x) => x.tripId === q.tripId) as Trip;
      if (remaining(t) < (t.kind === "private_charter" ? t.total : q.party))
        return json(409, { error: { code: "insufficient_capacity" } });
      opened++;
      const c: Checkout = {
        id: randomUUID(),
        tenant,
        tripId: t.tripId,
        party: q.party,
        state: "open",
        secret: b.checkoutSecret,
        paymentRef: `fpay_${opened}`,
      };
      checkouts.set(c.id, c);
      return json(201, {
        checkoutSession: { id: c.id, state: "open" },
        payment: { provider: "fake", paymentRef: c.paymentRef, clientSecret: `cs_${c.id}` },
      });
    }
    m = /^\/v1\/public\/checkout-sessions\/([^/]+)(\/cancel)?$/.exec(path);
    if (m) {
      const c = checkouts.get(m[1] ?? "");
      const ok = c && c.tenant === tenant && headers.authorization === `Bearer ${c.secret}`;
      if (!ok)
        return json(404, {
          error: { code: "checkout_not_found", message: "No such checkout at this address" },
        });
      if (m[2]) {
        if (limited(tenant)) return json(429, { error: { code: "rate_limited" } });
        if (c.state === "open") c.state = "canceled";
      }
      return json(200, { checkoutSession: { id: c.id, state: c.state } });
    }
    m = /^\/v1\/fake-provider\/payments\/([^/]+)\/succeed$/.exec(path);
    if (m) {
      if (limited(tenant)) return json(429, { error: { code: "rate_limited" } });
      const c = [...checkouts.values()].find((x) => x.paymentRef === m?.[1] && x.tenant === tenant);
      if (!c || headers.authorization !== `Bearer cs_${c.id}`)
        return json(404, { error: { code: "payment_not_found" } });
      c.state = "confirmed";
      const t = trips.find((x) => x.tripId === c.tripId) as Trip;
      t.confirmed += t.kind === "private_charter" ? t.total : c.party;
      return json(200, {
        event: { type: "payment.succeeded" },
        alreadySettled: false,
        delivery: { status: 200 },
      });
    }
    return json(404, { error: { code: "not_found" } });
  }

  return {
    trips,
    counts,
    fetch: (call: {
      url: string;
      method: string;
      headers: Record<string, string>;
      body: string | null;
    }) => {
      const url = new URL(call.url);
      if (!url.pathname.startsWith("/v1/")) return undefined;
      return handle(url, call.method, call.headers, call.body ? JSON.parse(call.body) : undefined);
    },
  };
}
