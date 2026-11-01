/**
 * The request body cap (proposed hardening) through the whole API, against a
 * real PostgreSQL 17 as tidegrid_app, with verified-origin CORS on.
 *
 * - A legitimate body padded close to the cap still works.
 * - An oversize body reaches no limiter and no hostname lookup.
 * - The CORS check and the route still share one lookup, whether the body
 *   came with a Content-Length or chunked.
 * - A provider event passes through byte for byte and verifies; an oversize
 *   one records nothing.
 * - A staff note over the cap is refused through the console path, no-store.
 *
 * Hostname lookups are counted in the database: the admin turns on function
 * statistics for the runtime role, and each request's own connection flushes
 * its counts when it closes. No collaborator is replaced to count them.
 */
import { randomUUID } from "node:crypto";
import { createDb } from "@tidegrid/database";
import type {} from "@tidegrid/database/global-setup";
import {
  type CheckoutFixture,
  confirmBooking,
  craftedFakeEventBody,
  createCheckoutFixture,
  fakeProvider,
  newSecret,
  quoteFor,
  TEST_FAKE_SECRET,
} from "@tidegrid/domain-booking/testing";
import { tripAllocator } from "@tidegrid/domain-inventory/testing";
import { signatureHeaderValue } from "@tidegrid/domain-payments";
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT } from "jose";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";
import { createApp } from "../src/app.ts";
import { createAccessVerifier } from "../src/auth/access.ts";
import type { Bindings } from "../src/env.ts";
import { markConsoleGateway } from "../src/gateway.ts";
import { preflightProjection } from "../src/hostnames/cors.ts";

type Sql = ReturnType<typeof postgres>;
type Json = Record<string, unknown> & { error?: { code: string; requestId?: string } };
type Res = { status: number; headers: Headers; json: Json };

const env = inject("integrationDb");
const CONSOLE = "https://console.test";
const TEAM = "tidegrid-body-cap-test.cloudflareaccess.com";
const AUD = "b0".repeat(32);
const WEBHOOK = "/v1/webhooks/payments/fake";
const MB = 1_000_000;

/** `text` as a stream with no Content-Length, in 4 KiB chunks. */
function chunked(text: string): ReadableStream<Uint8Array> {
  const whole = new TextEncoder().encode(text);
  let at = 0;
  return new ReadableStream({
    pull(controller) {
      if (at >= whole.byteLength) {
        controller.close();
        return;
      }
      controller.enqueue(whole.slice(at, at + 4096));
      at += 4096;
    },
  });
}

describe.skipIf(!env)("request body cap through the API", () => {
  let admin: Sql;
  /** One connection that always reads current statistics. */
  let stats: Sql;
  let runtime: ReturnType<typeof createDb>;
  let app: ReturnType<typeof createApp>;
  let signingKey: CryptoKey;
  let A: CheckoutFixture & { host: string; owner: string };
  let trips: ReturnType<typeof tripAllocator>;
  const kid = `kid-${randomUUID().slice(0, 8)}`;
  const limiterKeys: string[] = [];
  const pending: Promise<unknown>[] = [];
  const executionCtx = {
    waitUntil: (p: Promise<unknown>) => void pending.push(p),
    passThroughOnException: () => {},
    props: {},
  };

  const bindings = (): Bindings => ({
    ENVIRONMENT: "local",
    BUILD_ID: "integration",
    DATABASE_URL: env?.runtimeUrl ?? "",
    ALLOWED_ORIGINS: CONSOLE,
    STAFF_ORIGINS: CONSOLE,
    PUBLIC_CORS: "dynamic",
    PAYMENT_PROVIDER: "fake",
    FAKE_PAYMENT_WEBHOOK_SECRET: TEST_FAKE_SECRET,
    PUBLIC_RATE_LIMITER: {
      limit: async ({ key }) => {
        limiterKeys.push(key);
        return { success: true };
      },
    },
  });

  async function token(email: string): Promise<string> {
    const now = Math.floor(Date.now() / 1000);
    return new SignJWT({ type: "app", email })
      .setProtectedHeader({ alg: "RS256", kid })
      .setIssuer(`https://${TEAM}`)
      .setAudience(AUD)
      .setSubject(randomUUID())
      .setIssuedAt(now)
      .setExpirationTime(now + 300)
      .sign(signingKey);
  }

  async function request(
    method: string,
    path: string,
    opts: {
      origin?: string;
      as?: string;
      body?: string | ReadableStream<Uint8Array>;
      headers?: Record<string, string>;
      console?: boolean;
    } = {},
  ): Promise<Res> {
    const headers = new Headers(opts.headers);
    if (opts.origin) headers.set("origin", opts.origin);
    if (opts.as) headers.set("cf-access-jwt-assertion", await token(opts.as));
    if (opts.body !== undefined) headers.set("content-type", "application/json");
    const on = opts.console ? markConsoleGateway(bindings()) : bindings();
    const res = await app.request(
      `https://api.test${path}`,
      { method, headers, body: opts.body ?? null, duplex: "half" } as RequestInit,
      on,
      executionCtx,
    );
    const text = await res.text();
    // Each request's connection closes in waitUntil; its statistics flush then.
    await Promise.allSettled(pending.splice(0));
    let json: Json = {};
    try {
      json = JSON.parse(text) as Json;
    } catch {
      json = {};
    }
    return { status: res.status, headers: res.headers, json };
  }

  /** Calls of app.resolve_hostname so far, by every connection that has flushed. */
  async function resolveCalls(): Promise<number> {
    const [row] = await stats<{ n: number }[]>`
      select coalesce(sum(calls), 0)::int as n from pg_stat_user_functions
       where schemaname = 'app' and funcname = 'resolve_hostname'`;
    return row?.n ?? 0;
  }

  /**
   * The calls since `base`, once they stop changing. A closing backend flushes
   * its counts as it exits, a little after the client's end() returns.
   */
  async function callsSince(base: number, atLeast: number): Promise<number> {
    const deadline = Date.now() + 10_000;
    let seen = (await resolveCalls()) - base;
    while (seen < atLeast && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 50));
      seen = (await resolveCalls()) - base;
    }
    // Long enough for any straggler to land.
    await new Promise((r) => setTimeout(r, 500));
    return (await resolveCalls()) - base;
  }

  const guest = () => `https://${A.host}`;

  /** A bodyless public read that resolves the tenant once: the trip list. */
  function lookupOnce() {
    const day = (n: number) => new Date(Date.now() + n * 86_400_000).toISOString().slice(0, 10);
    return request("GET", `/v1/public/trips?from=${day(1)}&to=${day(30)}&party=1`, {
      origin: guest(),
    });
  }

  async function checkoutBody(): Promise<string> {
    const q = await quoteFor(runtime.db, A.id, trips.shared(), 1);
    return JSON.stringify({
      quoteId: q.quoteId,
      acceptedPolicyVersion: q.policy.version,
      booker: { name: "Cap Booker", email: "cap.booker@example.test" },
      checkoutSecret: newSecret(),
    });
  }

  beforeAll(async () => {
    if (!env) return;
    admin = postgres(env.adminUrl, { max: 2, onnotice: () => {} });
    stats = postgres(env.adminUrl, {
      max: 1,
      onnotice: () => {},
      connection: { stats_fetch_consistency: "none" },
    });
    // New connections of the runtime role count function calls. Every request
    // opens its own connection, so each one picks this up.
    await admin`alter role tidegrid_app set track_functions = 'all'`;
    runtime = createDb(env.runtimeUrl, { max: 2 });
    const fixture = await createCheckoutFixture(admin, runtime.db, "bodycap");
    const host = `${fixture.slug}.book.example.test`;
    await admin`insert into public.tenant_hostnames (hostname, tenant_id, kind, status, verified_at)
      values (${host}, ${fixture.id}, 'preview', 'active', now())`;
    const owner = `bodycap-owner-${fixture.id.slice(0, 8)}@example.test`;
    const userId = randomUUID();
    await admin`insert into public.staff_users (id, email, display_name)
      values (${userId}, ${owner}, 'Owner')`;
    await admin`insert into public.tenant_memberships (tenant_id, user_id, role, display_name)
      values (${fixture.id}, ${userId}, 'owner', 'Owner')`;
    A = { ...fixture, host, owner };
    trips = tripAllocator(A);
    const pair = await generateKeyPair("RS256", { extractable: true });
    signingKey = pair.privateKey;
    const jwk = { ...(await exportJWK(pair.publicKey)), kid, alg: "RS256", use: "sig" };
    app = createApp({
      deliverEmailAfterCommit: false,
      accessVerifier: createAccessVerifier({
        teamDomain: TEAM,
        audience: AUD,
        keys: createLocalJWKSet({ keys: [jwk] }),
      }),
    });
  });

  afterAll(async () => {
    if (admin) await admin`alter role tidegrid_app reset track_functions`;
    await runtime?.end();
    await stats?.end({ timeout: 5 });
    await admin?.end({ timeout: 5 });
  });

  it("counts hostname lookups (the counter works)", async () => {
    const base = await resolveCalls();
    const res = await lookupOnce();
    expect(res.status).toBe(200);
    expect(await callsSince(base, 1)).toBe(1);
  });

  it("prices a real quote padded with JSON whitespace to 16,000 bytes", async () => {
    const body = JSON.stringify({
      tripId: trips.shared(),
      party: { kind: "tickets", tickets: [{ code: "adult", quantity: 1 }] },
      addOns: [],
    });
    const padded = `${body.slice(0, -1)}${" ".repeat(16_000 - body.length)}}`;
    expect(new TextEncoder().encode(padded).byteLength).toBe(16_000);
    for (const sent of [padded, chunked(padded)]) {
      const res = await request("POST", "/v1/public/quotes", {
        origin: guest(),
        body: sent,
        headers: { "idempotency-key": `quote-${randomUUID()}` },
      });
      expect(res.status, JSON.stringify(res.json)).toBe(201);
    }
  });

  it("spends no limiter call and no hostname lookup on an oversize body", async () => {
    const big = JSON.stringify({ pad: "x".repeat(MB) });
    for (const sent of [() => big, () => chunked(big)]) {
      preflightProjection.clear();
      limiterKeys.length = 0;
      const base = await resolveCalls();
      const res = await request("POST", "/v1/public/quotes", {
        origin: guest(),
        body: sent(),
        headers: { "idempotency-key": `quote-${randomUUID()}`, "cf-connecting-ip": "192.0.2.10" },
      });
      expect([res.status, res.json.error?.code]).toEqual([413, "payload_too_large"]);
      expect(limiterKeys).toEqual([]);
      // A sentinel lookup after it, so a straggling count would show up too.
      expect((await lookupOnce()).status).toBe(200);
      expect(await callsSince(base, 1)).toBe(1);
      // No CORS decision was made, so the browser cannot read it (D3).
      expect(res.headers.get("access-control-allow-origin")).toBeNull();
      expect(res.headers.get("vary") ?? "").toMatch(/Origin/);
    }
  });

  it("shares one hostname lookup between CORS and the route, with a length or chunked", async () => {
    for (const kind of ["length", "chunked"] as const) {
      const body = await checkoutBody();
      preflightProjection.clear();
      limiterKeys.length = 0;
      const base = await resolveCalls();
      const res = await request("POST", "/v1/public/checkout-sessions", {
        origin: guest(),
        body: kind === "length" ? body : chunked(body),
        headers: { "idempotency-key": `chk-${randomUUID()}`, "cf-connecting-ip": "192.0.2.11" },
      });
      expect(res.status, `${kind}: ${JSON.stringify(res.json)}`).toBe(201);
      expect(res.headers.get("access-control-allow-origin"), kind).toBe(guest());
      expect(await callsSince(base, 1), kind).toBe(1);
      // The CORS lookup's limiter and the command's limiter, one each.
      expect(
        limiterKeys.map((k) => k.split(":")[0]),
        kind,
      ).toEqual(["cors", A.id]);
    }
  });

  it("passes a provider event through byte for byte, and records nothing oversize", async () => {
    const opened = await request("POST", "/v1/public/checkout-sessions", {
      origin: guest(),
      body: await checkoutBody(),
      headers: { "idempotency-key": `chk-${randomUUID()}` },
    });
    expect(opened.status).toBe(201);
    const payment = opened.json.payment as { paymentRef: string; clientSecret: string };
    const settled = await request(
      "POST",
      `/v1/fake-provider/payments/${payment.paymentRef}/succeed`,
      {
        origin: guest(),
        body: JSON.stringify({ deliver: false }),
        headers: { authorization: `Bearer ${payment.clientSecret}` },
      },
    );
    expect(settled.status).toBe(200);
    const eventId = (settled.json.event as { id: string }).id;
    const [stored] = await admin<{ body: string }[]>`
      select body from public.fake_provider_events where id = ${eventId}`;
    const event = stored?.body ?? "";
    const inbox = async (id: string) => {
      const [row] = await admin<{ n: number }[]>`
        select count(*)::int as n from public.provider_events where event_id = ${id}`;
      return row?.n ?? 0;
    };
    const sign = async (body: string) => ({
      "fake-signature": await signatureHeaderValue(TEST_FAKE_SECRET, Date.now(), body),
    });

    const delivered = await request("POST", WEBHOOK, {
      body: chunked(event),
      headers: await sign(event),
    });
    expect([delivered.status, delivered.json.duplicate]).toEqual([200, false]);
    expect(await inbox(eventId)).toBe(1);

    const bigId = `fevt_${"B".repeat(24)}`;
    const big = JSON.stringify({
      ...(JSON.parse(
        craftedFakeEventBody({
          type: "payment.succeeded",
          accountRef: A.accountRef,
          paymentRef: payment.paymentRef,
          amount: 1,
          clientReference: null,
          eventId: bigId,
        }),
      ) as object),
      padding: "x".repeat(65 * 1024),
    });
    const refused = await request("POST", WEBHOOK, {
      body: chunked(big),
      headers: await sign(big),
    });
    expect([refused.status, refused.json.error?.code]).toEqual([413, "payload_too_large"]);
    expect(await inbox(bigId)).toBe(0);
  });

  it("refuses a 17 KiB staff note through the console path, no-store, and keeps a 500-character one", async () => {
    const booked = await confirmBooking(runtime.db, fakeProvider(runtime.db), A, trips.shared(), 1);
    const path = `/v1/staff/tenants/${A.id}/bookings/${booked.bookingId}/notes`;
    const note = (text: string) =>
      request("POST", path, {
        origin: CONSOLE,
        as: A.owner,
        console: true,
        body: JSON.stringify({ body: text }),
        headers: { "idempotency-key": `note-${randomUUID()}` },
      });
    const over = await note("x".repeat(17 * 1024));
    expect([over.status, over.json.error?.code]).toEqual([413, "payload_too_large"]);
    expect(over.headers.get("cache-control")).toBe("no-store");
    expect(over.headers.get("vary") ?? "").toMatch(/Origin/);
    const kept = await note("y".repeat(500));
    expect(kept.status, JSON.stringify(kept.json)).toBe(201);
    const [row] = await admin<{ n: number }[]>`
      select count(*)::int as n from public.booking_notes where booking_id = ${booked.bookingId}`;
    expect(row?.n).toBe(1);
  });
});
