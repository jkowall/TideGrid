/**
 * G2.7 adversarial tests through the whole API. The webhook route's signature
 * and timestamp checks, with nothing recorded for any refused request; an
 * exact signed request replayed many times at once; the last seats and one
 * charter raced through the checkout route; one quote and one idempotency key
 * sent many times at once; the fake provider's controls racing on one
 * payment; rate limits that write nothing; the response headers every guest
 * route promises; and two tenants on every new route. Every request runs the
 * real Hono app against a real database as tidegrid_app.
 */
import { randomUUID } from "node:crypto";
import { createDb } from "@tidegrid/database";
import type {} from "@tidegrid/database/global-setup";
import {
  type CheckoutFixture,
  craftedFakeEventBody,
  createCheckoutFixture,
  newSecret,
  quoteFor,
  TEST_FAKE_SECRET,
} from "@tidegrid/domain-booking/testing";
import { tripAllocator } from "@tidegrid/domain-inventory/testing";
import { signatureHeaderValue, signPayload } from "@tidegrid/domain-payments";
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT } from "jose";
import postgres from "postgres";
import { afterAll, beforeAll, describe, inject, it } from "vitest";
import { createApp } from "../src/app.ts";
import { createAccessVerifier } from "../src/auth/access.ts";

type Sql = ReturnType<typeof postgres>;
type Json = Record<string, unknown> & {
  error?: { code: string };
  checkoutSession?: {
    id: string;
    state: string;
    amount: number;
    booking: { reference: string } | null;
    refund: { state: string; amount: number } | null;
  };
  payment?: { provider: string; paymentRef: string; clientSecret: string } | null;
  delivery?: { status: number; outcome: string | null; duplicate: boolean | null } | null;
  event?: { id: string; type: string };
  alreadySettled?: boolean;
  outcome?: string;
  duplicate?: boolean;
  received?: boolean;
  bookings?: { booker: { name: string; email: string } }[];
  exceptions?: { checkoutSessionId: string }[];
};
type Tenant = CheckoutFixture & { host: string; owner: string; staff: string; finance: string };
type Res = { status: number; headers: Headers; json: Json; text: string };

const env = inject("integrationDb");
const CONSOLE = "https://console.test";
const TEAM = "tidegrid-checkout-adv.cloudflareaccess.com";
const AUD = "ef".repeat(32);
const SESSIONS = Number(process.env.RACE_SESSIONS ?? "") || 10;
const ROUNDS = Number(process.env.RACE_ROUNDS ?? "") || 2;
const WEBHOOK = "/v1/webhooks/payments/fake";

describe.skipIf(!env).concurrent("G2.7 adversarial: checkout and payments through the API", () => {
  let admin: Sql;
  let runtime: ReturnType<typeof createDb>;
  let app: ReturnType<typeof createApp>;
  let signingKey: CryptoKey;
  let A: Tenant;
  let B: Tenant;
  let tripsA: ReturnType<typeof tripAllocator>;
  let tripsB: ReturnType<typeof tripAllocator>;
  const kid = `kid-${randomUUID().slice(0, 8)}`;

  const bindings = (extra: Record<string, unknown> = {}) => ({
    ENVIRONMENT: "local" as const,
    BUILD_ID: "integration",
    DATABASE_URL: env?.runtimeUrl ?? "",
    ALLOWED_ORIGINS: CONSOLE,
    STAFF_ORIGINS: CONSOLE,
    PAYMENT_PROVIDER: "fake",
    FAKE_PAYMENT_WEBHOOK_SECRET: TEST_FAKE_SECRET,
    ...extra,
  });
  const executionCtx = { waitUntil: () => {}, passThroughOnException: () => {}, props: {} };
  const refuseAll = { limit: async () => ({ success: false }) };

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
      body?: unknown;
      raw?: string;
      headers?: Record<string, string>;
      env?: Record<string, unknown>;
    } = {},
  ): Promise<Res> {
    const headers = new Headers(opts.headers);
    if (opts.origin) headers.set("origin", opts.origin);
    if (opts.as) headers.set("cf-access-jwt-assertion", await token(opts.as));
    if ((opts.body !== undefined || opts.raw !== undefined) && !headers.has("content-type")) {
      headers.set("content-type", "application/json");
    }
    const res = await app.request(
      `http://localhost${path}`,
      {
        method,
        headers,
        body: opts.raw ?? (opts.body === undefined ? null : JSON.stringify(opts.body)),
      },
      bindings(opts.env),
      executionCtx,
    );
    const text = await res.text();
    let json: Json = {};
    try {
      json = JSON.parse(text) as Json;
    } catch {
      json = {};
    }
    return { status: res.status, headers: res.headers, json, text };
  }

  const guest = (t: Tenant) => `https://${t.host}`;

  async function quote(t: Tenant, tripId: string, party: number, charter = false) {
    const q = await quoteFor(runtime.db, t.id, tripId, party, { charter });
    return { quoteId: q.quoteId, policyVersion: q.policy.version, total: q.totals.total };
  }

  function openWith(
    t: Tenant,
    q: { quoteId: string; policyVersion: number },
    extra: {
      key?: string;
      secret?: string;
      headers?: Record<string, string>;
      env?: Record<string, unknown>;
    } = {},
  ) {
    const secret = extra.secret ?? newSecret();
    const key = extra.key ?? `chk-${randomUUID()}`;
    const body = {
      quoteId: q.quoteId,
      acceptedPolicyVersion: q.policyVersion,
      booker: { name: "Synthetic Guest", email: "synthetic.guest@example.test" },
      checkoutSecret: secret,
    };
    return request("POST", "/v1/public/checkout-sessions", {
      origin: guest(t),
      body,
      headers: { "idempotency-key": key, ...extra.headers },
      ...(extra.env ? { env: extra.env } : {}),
    }).then((res) => ({ ...res, secret, key, body }));
  }

  async function open(t: Tenant, tripId: string, party = 1, charter = false) {
    const opened = await openWith(t, await quote(t, tripId, party, charter));
    const session = opened.json.checkoutSession;
    const payment = opened.json.payment;
    if (opened.status !== 201 || !session || !payment) {
      throw new Error(`setup checkout: ${opened.status} ${opened.text}`);
    }
    const [row] = await admin<{ id: string }[]>`
      select id from public.payments where checkout_session_id = ${session.id}`;
    return { ...opened, session, payment, paymentId: row?.id ?? "" };
  }

  const status = (t: Tenant, id: string, secret: string) =>
    request("GET", `/v1/public/checkout-sessions/${id}`, {
      origin: guest(t),
      headers: { authorization: `Bearer ${secret}` },
    });

  const control = (
    t: Tenant,
    paymentRef: string,
    clientSecret: string,
    action: string,
    opts: { body?: unknown; env?: Record<string, unknown> } = {},
  ) =>
    request("POST", `/v1/fake-provider/payments/${paymentRef}/${action}`, {
      origin: guest(t),
      headers: { authorization: `Bearer ${clientSecret}` },
      ...(opts.body === undefined ? {} : { body: opts.body }),
      ...(opts.env ? { env: opts.env } : {}),
    });

  const post = (body: string, headers: Record<string, string>, path = WEBHOOK) =>
    request("POST", path, { raw: body, headers });

  const sign = async (body: string, nowMs = Date.now(), secret = TEST_FAKE_SECRET) => ({
    "fake-signature": await signatureHeaderValue(secret, nowMs, body),
  });

  async function inboxCount(eventId: string): Promise<number> {
    const [row] = await admin<{ n: number }[]>`
      select count(*)::int as n from public.provider_events where event_id = ${eventId}`;
    return row?.n ?? 0;
  }

  async function sessionRow(id: string) {
    const [row] = await admin<{ state: string; bookings: number; hold: string }[]>`
      select s.state, h.state as hold,
             (select count(*)::int from public.bookings b where b.checkout_session_id = s.id) as bookings
        from public.checkout_sessions s join public.capacity_holds h on h.id = s.hold_id
       where s.id = ${id}`;
    return row;
  }

  async function usage(tripId: string) {
    const [row] = await admin<{ counted: number; capacity: number; boats: number }[]>`
      select t.seat_capacity as capacity,
             coalesce(sum(h.seats) filter (where h.state in ('active', 'confirmed')), 0)::int as counted,
             count(h.id) filter (where h.kind = 'whole_boat' and h.state in ('active', 'confirmed'))::int
               as boats
        from public.scheduled_trips t
        left join public.capacity_holds h on h.trip_id = t.id
       where t.id = ${tripId}
       group by t.seat_capacity`;
    return row;
  }

  function stats(race: string, line: Record<string, unknown>) {
    console.log(`RACE_STATS ${JSON.stringify({ race, ...line })}`);
  }

  async function withAccess(fixture: CheckoutFixture, label: string): Promise<Tenant> {
    const host = `${fixture.slug}.book.example.test`;
    await admin`insert into public.tenant_hostnames (hostname, tenant_id, kind, status, verified_at)
      values (${host}, ${fixture.id}, 'preview', 'active', now())`;
    const emails: Record<string, string> = {};
    for (const role of ["owner", "booking_staff", "finance"] as const) {
      const email = `${label}-${role.replace("_", "-")}-${fixture.id.slice(0, 8)}@example.test`;
      const userId = randomUUID();
      await admin`insert into public.staff_users (id, email, display_name)
        values (${userId}, ${email}, ${role})`;
      await admin`insert into public.tenant_memberships (tenant_id, user_id, role, display_name)
        values (${fixture.id}, ${userId}, ${role}, ${role})`;
      emails[role] = email;
    }
    return {
      ...fixture,
      host,
      owner: emails.owner ?? "",
      staff: emails.booking_staff ?? "",
      finance: emails.finance ?? "",
    };
  }

  beforeAll(async () => {
    if (!env) return;
    admin = postgres(env.adminUrl, { max: 4, onnotice: () => {} });
    runtime = createDb(env.runtimeUrl, { max: 8 });
    const [a, b] = await Promise.all([
      createCheckoutFixture(admin, runtime.db, "advapi-a"),
      createCheckoutFixture(admin, runtime.db, "advapi-b"),
    ]);
    A = await withAccess(a, "adva");
    B = await withAccess(b, "advb");
    tripsA = tripAllocator(A);
    tripsB = tripAllocator(B);
    const pair = await generateKeyPair("RS256", { extractable: true });
    signingKey = pair.privateKey;
    const jwk = { ...(await exportJWK(pair.publicKey)), kid, alg: "RS256", use: "sig" };
    app = createApp({
      accessVerifier: createAccessVerifier({
        teamDomain: TEAM,
        audience: AUD,
        keys: createLocalJWKSet({ keys: [jwk] }),
      }),
    });
  });

  afterAll(async () => {
    await runtime?.end();
    await admin?.end({ timeout: 5 });
  });

  it("refuses every missing, malformed, forged, stale, or misplaced signature and records nothing", async ({
    expect,
  }) => {
    const opened = await open(A, tripsA.shared(), 2);
    // The provider's own success event, held back.
    const settled = await control(
      A,
      opened.payment.paymentRef,
      opened.payment.clientSecret,
      "succeed",
      {
        body: { deliver: false },
      },
    );
    expect(settled.status).toBe(200);
    const eventId = settled.json.event?.id ?? "";
    const [stored] = await admin<{ body: string }[]>`
      select body from public.fake_provider_events where id = ${eventId}`;
    const body = stored?.body ?? "";
    const now = Math.floor(Date.now() / 1000);
    const v1 = (t: number) => signPayload(TEST_FAKE_SECRET, t, body);
    const hex = await v1(now);
    const big = JSON.stringify({ ...JSON.parse(body), padding: "x".repeat(70 * 1024) });

    const refused: [string, () => Promise<Res>, number, string][] = [
      ["no signature", () => post(body, {}), 400, "signature_invalid"],
      [
        "not a signature",
        () => post(body, { "fake-signature": "nonsense" }),
        400,
        "signature_invalid",
      ],
      ["no v1", () => post(body, { "fake-signature": `t=${now}` }), 400, "signature_invalid"],
      [
        "upper-case hex",
        () => post(body, { "fake-signature": `t=${now},v1=${hex.toUpperCase()}` }),
        400,
        "signature_invalid",
      ],
      [
        "two timestamps",
        () => post(body, { "fake-signature": `t=${now},t=${now},v1=${hex}` }),
        400,
        "signature_invalid",
      ],
      [
        "a header over 1 KiB",
        () => post(body, { "fake-signature": `t=${now}${`,v1=${hex}`.repeat(16)}` }),
        400,
        "signature_invalid",
      ],
      [
        "only Stripe's v0",
        () => post(body, { "fake-signature": `t=${now},v0=${hex}` }),
        400,
        "signature_invalid",
      ],
      [
        "another secret",
        async () => post(body, await sign(body, Date.now(), `${TEST_FAKE_SECRET}-other`)),
        400,
        "signature_invalid",
      ],
      [
        "one byte changed",
        () =>
          post(body.replace('"object":"event"', '"object":"evenT"'), {
            "fake-signature": `t=${now},v1=${hex}`,
          }),
        400,
        "signature_invalid",
      ],
      [
        "303 s old",
        async () => post(body, { "fake-signature": `t=${now - 303},v1=${await v1(now - 303)}` }),
        400,
        "signature_invalid",
      ],
      [
        "303 s ahead",
        async () => post(body, { "fake-signature": `t=${now + 303},v1=${await v1(now + 303)}` }),
        400,
        "signature_invalid",
      ],
      [
        "moved to another timestamp",
        () => post(body, { "fake-signature": `t=${now - 1},v1=${hex}` }),
        400,
        "signature_invalid",
      ],
      [
        "from a browser",
        async () =>
          request("POST", WEBHOOK, { raw: body, origin: guest(A), headers: await sign(body) }),
        403,
        "origin_not_allowed",
      ],
      ["larger than any event", async () => post(big, await sign(big)), 413, "payload_too_large"],
      [
        "declared larger than any event",
        async () => post(body, { ...(await sign(body)), "content-length": String(65 * 1024) }),
        413,
        "payload_too_large",
      ],
      [
        "another provider's route",
        async () => post(body, await sign(body), "/v1/webhooks/payments/stripe"),
        404,
        "not_found",
      ],
    ];
    const got: Record<string, [number, string | undefined]> = {};
    const want: Record<string, [number, string]> = {};
    for (const [name, send, code, error] of refused) {
      const res = await send();
      got[name] = [res.status, res.json.error?.code];
      want[name] = [code, error];
    }
    expect(got).toEqual(want);
    // A signed body that is not an event.
    const junk = JSON.stringify({ hello: "world" });
    const junkRes = await post(junk, await sign(junk));
    expect([junkRes.status, junkRes.json.error?.code]).toEqual([400, "payload_invalid"]);
    // Nothing was recorded or changed.
    expect(await inboxCount(eventId)).toBe(0);
    expect(await sessionRow(opened.session.id)).toMatchObject({ state: "open", bookings: 0 });

    // Just inside the window, either way, and with a rotated secret beside the right one.
    const early = await post(body, {
      "fake-signature": `t=${now - 297},v1=${await v1(now - 297)}`,
    });
    expect(early.json).toEqual({ received: true, duplicate: false, outcome: "confirmed" });
    const other = craftedFakeEventBody({
      type: "payment.succeeded",
      accountRef: A.accountRef,
      paymentRef: opened.payment.paymentRef,
      amount: opened.session.amount,
      clientReference: opened.paymentId,
    });
    const ahead = Math.floor(Date.now() / 1000) + 297;
    const late = await post(other, {
      "fake-signature": `t=${ahead},v1=${await signPayload(TEST_FAKE_SECRET, ahead, other)}`,
    });
    expect(late.json).toEqual({ received: true, duplicate: false, outcome: "already_succeeded" });
    const rotated = craftedFakeEventBody({
      type: "payment.succeeded",
      accountRef: A.accountRef,
      paymentRef: opened.payment.paymentRef,
      amount: opened.session.amount,
      clientReference: opened.paymentId,
    });
    const t = Math.floor(Date.now() / 1000);
    const wrong = await signPayload(`${TEST_FAKE_SECRET}-retired`, t, rotated);
    const right = await signPayload(TEST_FAKE_SECRET, t, rotated);
    const both = await post(rotated, { "fake-signature": `t=${t},v1=${wrong},v1=${right}` });
    expect(both.json).toEqual({ received: true, duplicate: false, outcome: "already_succeeded" });
    expect(await inboxCount(eventId)).toBe(1);
    expect(await sessionRow(opened.session.id)).toMatchObject({ state: "confirmed", bookings: 1 });
  });

  it("changes nothing when one exact signed request is replayed many times at once", async ({
    expect,
  }) => {
    const opened = await open(A, tripsA.shared(), 1);
    const settled = await control(
      A,
      opened.payment.paymentRef,
      opened.payment.clientSecret,
      "succeed",
      {
        body: { deliver: false },
      },
    );
    const eventId = settled.json.event?.id ?? "";
    const [stored] = await admin<{ body: string }[]>`
      select body from public.fake_provider_events where id = ${eventId}`;
    const body = stored?.body ?? "";
    const headers = await sign(body);
    const replies = await Promise.all(Array.from({ length: SESSIONS }, () => post(body, headers)));
    stats("http_exact_replay", {
      sessions: SESSIONS,
      statuses: replies.map((r) => r.status).join(","),
      firsts: replies.filter((r) => r.json.duplicate === false).length,
    });
    expect(replies.map((r) => r.status)).toEqual(Array(SESSIONS).fill(200));
    expect(replies.map((r) => r.json.outcome)).toEqual(Array(SESSIONS).fill("confirmed"));
    expect(replies.filter((r) => r.json.duplicate === false)).toHaveLength(1);
    expect(await inboxCount(eventId)).toBe(1);
    expect(await sessionRow(opened.session.id)).toMatchObject({ state: "confirmed", bookings: 1 });
  });

  it("holds exactly the seats that are left when many guests check out the last seats over HTTP", async ({
    expect,
  }) => {
    for (let round = 0; round < ROUNDS; round++) {
      const tripId = tripsA.shared();
      const parties = Array.from({ length: SESSIONS }, (_, i) => (i % 2 === 0 ? 1 : 2));
      const [prefill, ...quotes] = await Promise.all([
        quote(A, tripId, 7),
        ...parties.map((p) => quote(A, tripId, p)),
      ]);
      if (!prefill) throw new Error("no prefill quote");
      expect((await openWith(A, prefill)).status).toBe(201);
      const replies = await Promise.all(quotes.map((q) => openWith(A, q)));
      const won = replies.reduce((n, r, i) => n + (r.status === 201 ? (parties[i] ?? 0) : 0), 0);
      stats("http_last_seats", {
        round,
        sessions: SESSIONS,
        winners: replies.filter((r) => r.status === 201).length,
        seatsWon: won,
        refusals: replies.filter((r) => r.status === 409).length,
        errors: replies.filter((r) => r.status >= 500).length,
      });
      expect(replies.filter((r) => r.status !== 201 && r.status !== 409)).toEqual([]);
      for (const r of replies.filter((x) => x.status === 409)) {
        expect(r.json.error?.code).toBe("insufficient_capacity");
      }
      expect(won).toBeLessThanOrEqual(3);
      // Every winner pays at once through the fake provider and its webhook.
      const paid = await Promise.all(
        replies
          .filter((r) => r.status === 201 && r.json.payment)
          .map((r) =>
            control(
              A,
              r.json.payment?.paymentRef ?? "",
              r.json.payment?.clientSecret ?? "",
              "succeed",
            ),
          ),
      );
      expect(paid.map((p) => p.json.delivery?.outcome)).toEqual(
        Array(paid.length).fill("confirmed"),
      );
      const used = await usage(tripId);
      expect(used?.counted).toBe(7 + won);
      expect(used?.counted).toBeLessThanOrEqual(used?.capacity ?? 0);
    }
  });

  it("lets exactly one guest check out a charter boat over HTTP when many try at once", async ({
    expect,
  }) => {
    for (let round = 0; round < ROUNDS; round++) {
      const tripId = tripsA.charter();
      const quotes = await Promise.all(
        Array.from({ length: SESSIONS }, (_, i) => quote(A, tripId, 2 + (i % 5), true)),
      );
      const replies = await Promise.all(quotes.map((q) => openWith(A, q)));
      stats("http_one_charter", {
        round,
        sessions: SESSIONS,
        winners: replies.filter((r) => r.status === 201).length,
        refusals: replies.filter((r) => r.status === 409).length,
        errors: replies.filter((r) => r.status >= 500).length,
      });
      expect(replies.filter((r) => r.status === 201)).toHaveLength(1);
      expect(
        replies.filter((r) => r.status === 409 && r.json.error?.code === "insufficient_capacity"),
      ).toHaveLength(SESSIONS - 1);
      const winner = replies.find((r) => r.status === 201);
      const paid = await control(
        A,
        winner?.json.payment?.paymentRef ?? "",
        winner?.json.payment?.clientSecret ?? "",
        "succeed",
      );
      expect(paid.json.delivery?.outcome).toBe("confirmed");
      expect(await usage(tripId)).toMatchObject({ counted: 6, boats: 1 });
    }
  });

  it("opens one checkout for one quote sent many times at once with different keys", async ({
    expect,
  }) => {
    const q = await quote(A, tripsA.shared(), 2);
    const replies = await Promise.all(Array.from({ length: SESSIONS }, () => openWith(A, q)));
    stats("http_quote_reuse", {
      sessions: SESSIONS,
      statuses: replies.map((r) => r.status).join(","),
    });
    expect(replies.filter((r) => r.status === 201)).toHaveLength(1);
    expect(
      replies.filter((r) => r.status === 409 && r.json.error?.code === "quote_already_used"),
    ).toHaveLength(SESSIONS - 1);
    const [count] = await admin<{ n: number }[]>`
      select count(*)::int as n from public.checkout_sessions where quote_id = ${q.quoteId}`;
    expect(count?.n).toBe(1);
  });

  it("returns one checkout and one provider payment for one key sent many times at once", async ({
    expect,
  }) => {
    const q = await quote(A, tripsA.shared(), 1);
    const key = `chk-${randomUUID()}`;
    const secret = newSecret();
    const replies = await Promise.all(
      Array.from({ length: SESSIONS }, () => openWith(A, q, { key, secret })),
    );
    stats("http_same_key", {
      sessions: SESSIONS,
      statuses: replies.map((r) => r.status).join(","),
      replayed: replies.filter((r) => r.headers.get("idempotent-replayed") === "true").length,
    });
    expect(replies.map((r) => r.status)).toEqual(Array(SESSIONS).fill(201));
    const ids = new Set(replies.map((r) => r.json.checkoutSession?.id));
    const refs = new Set(replies.map((r) => r.json.payment?.paymentRef));
    const clientSecrets = new Set(replies.map((r) => r.json.payment?.clientSecret));
    expect([ids.size, refs.size, clientSecrets.size]).toEqual([1, 1, 1]);
    expect(replies.filter((r) => r.headers.get("idempotent-replayed") === "true")).toHaveLength(
      SESSIONS - 1,
    );
    const [row] = await admin<{ fakes: number; recorded: number }[]>`
      select (select count(*)::int from public.fake_provider_payments f
               where f.idempotency_key = p.idempotency_key) as fakes,
             (select count(*)::int from public.audit_events a
               where a.subject_id = p.id::text and a.action = 'payment.provider_recorded') as recorded
        from public.payments p
       where p.checkout_session_id = ${[...ids][0] ?? ""}`;
    expect(row).toEqual({ fakes: 1, recorded: 1 });
  });

  it("settles a fake payment once when its controls race, and delivers one outcome", async ({
    expect,
  }) => {
    for (let round = 0; round < ROUNDS; round++) {
      const opened = await open(A, tripsA.shared(), 1);
      const actions = ["succeed", "fail", "succeed", "fail"];
      const replies = await Promise.all(
        actions.map((a) => control(A, opened.payment.paymentRef, opened.payment.clientSecret, a)),
      );
      stats("http_fake_controls", {
        round,
        settled: replies.filter((r) => r.json.alreadySettled === false).length,
        deliveries: replies
          .map((r) => `${r.json.delivery?.outcome}:${r.json.delivery?.duplicate}`)
          .join(","),
      });
      expect(replies.map((r) => r.status)).toEqual([200, 200, 200, 200]);
      expect(replies.filter((r) => r.json.alreadySettled === false)).toHaveLength(1);
      expect(new Set(replies.map((r) => r.json.event?.id)).size).toBe(1);
      expect(replies.filter((r) => r.json.delivery?.duplicate === false)).toHaveLength(1);
      const type = replies[0]?.json.event?.type;
      const expected = type === "payment.succeeded" ? "confirmed" : "released";
      expect(new Set(replies.map((r) => r.json.delivery?.outcome))).toEqual(new Set([expected]));
      expect(await sessionRow(opened.session.id)).toMatchObject({
        state: type === "payment.succeeded" ? "confirmed" : "failed",
      });
    }
  });

  it("keeps one client address to three open checkouts when it opens many at once over HTTP", async ({
    expect,
  }) => {
    const address = "203.0.113.77";
    const tripId = tripsA.shared();
    const quotes = await Promise.all(Array.from({ length: SESSIONS }, () => quote(A, tripId, 1)));
    const replies = await Promise.all(
      quotes.map((q) => openWith(A, q, { headers: { "cf-connecting-ip": address } })),
    );
    stats("http_client_limit", {
      sessions: SESSIONS,
      statuses: replies.map((r) => r.status).join(","),
    });
    expect(replies.filter((r) => r.status === 201)).toHaveLength(3);
    expect(
      replies.filter((r) => r.status === 429 && r.json.error?.code === "too_many_checkouts"),
    ).toHaveLength(SESSIONS - 3);
    const [count] = await admin<{ n: number }[]>`
      select count(*)::int as n from public.checkout_sessions
       where quote_id in ${admin(quotes.map((q) => q.quoteId))}`;
    expect(count?.n).toBe(3);
    // Another address at the same operator is not limited by this one.
    const other = await openWith(A, await quote(A, tripId, 1), {
      headers: { "cf-connecting-ip": "203.0.113.78" },
    });
    expect(other.status).toBe(201);
  });

  it("writes nothing for a rate-limited command", async ({ expect }) => {
    const limited = { PUBLIC_RATE_LIMITER: refuseAll };
    const q = await quote(A, tripsA.shared(), 1);
    const refused = await openWith(A, q, { env: limited });
    expect([refused.status, refused.json.error?.code]).toEqual([429, "rate_limited"]);
    const [count] = await admin<{ n: number }[]>`
      select count(*)::int as n from public.checkout_sessions where quote_id = ${q.quoteId}`;
    expect(count?.n).toBe(0);
    const opened = await open(A, tripsA.shared(), 1);
    const cancel = await request(
      "POST",
      `/v1/public/checkout-sessions/${opened.session.id}/cancel`,
      {
        origin: guest(A),
        headers: { authorization: `Bearer ${opened.secret}` },
        env: limited,
      },
    );
    expect([cancel.status, cancel.json.error?.code]).toEqual([429, "rate_limited"]);
    const pay = await control(
      A,
      opened.payment.paymentRef,
      opened.payment.clientSecret,
      "succeed",
      {
        env: limited,
      },
    );
    expect([pay.status, pay.json.error?.code]).toEqual([429, "rate_limited"]);
    expect(await sessionRow(opened.session.id)).toMatchObject({ state: "open", hold: "active" });
    const [fake] = await admin<{ n: number }[]>`
      select count(*)::int as n from public.fake_provider_events where payment_id = ${opened.payment.paymentRef}`;
    expect(fake?.n).toBe(0);
    // Reads are not limited.
    expect(
      (
        await request("GET", `/v1/public/checkout-sessions/${opened.session.id}`, {
          origin: guest(A),
          headers: { authorization: `Bearer ${opened.secret}` },
          env: limited,
        })
      ).status,
    ).toBe(200);
  });

  it("answers every guest checkout and fake-provider request, errors included, with no-store and Vary: Origin", async ({
    expect,
  }) => {
    const opened = await open(A, tripsA.shared(), 1);
    const id = opened.session.id;
    const bearer = { authorization: `Bearer ${opened.secret}` };
    const responses: [string, Res][] = [
      ["created", opened],
      ["read", await status(A, id, opened.secret)],
      [
        "no secret",
        await request("GET", `/v1/public/checkout-sessions/${id}`, { origin: guest(A) }),
      ],
      [
        "secret in the query",
        await request("GET", `/v1/public/checkout-sessions/${id}?secret=${opened.secret}`, {
          origin: guest(A),
        }),
      ],
      [
        "lower-case bearer",
        await request("GET", `/v1/public/checkout-sessions/${id}`, {
          origin: guest(A),
          headers: { authorization: `bearer ${opened.secret}` },
        }),
      ],
      ["wrong secret", await status(A, id, newSecret())],
      ["unknown id", await status(A, randomUUID(), opened.secret)],
      [
        "used quote",
        await openWith(A, {
          quoteId: opened.body.quoteId,
          policyVersion: opened.body.acceptedPolicyVersion,
        }),
      ],
      [
        "fake read",
        await request("GET", `/v1/fake-provider/payments/${opened.payment.paymentRef}`, {
          origin: guest(A),
          headers: { authorization: `Bearer ${opened.payment.clientSecret}` },
        }),
      ],
      [
        "fake wrong secret",
        await request("GET", `/v1/fake-provider/payments/${opened.payment.paymentRef}`, {
          origin: guest(A),
          headers: bearer,
        }),
      ],
      [
        "canceled",
        await request("POST", `/v1/public/checkout-sessions/${id}/cancel`, {
          origin: guest(A),
          headers: bearer,
        }),
      ],
    ];
    const statuses = Object.fromEntries(responses.map(([name, r]) => [name, r.status]));
    expect(statuses).toEqual({
      created: 201,
      read: 200,
      "no secret": 401,
      "secret in the query": 401,
      "lower-case bearer": 401,
      "wrong secret": 404,
      "unknown id": 404,
      "used quote": 409,
      "fake read": 200,
      "fake wrong secret": 404,
      canceled: 200,
    });
    const headers = Object.fromEntries(
      responses.map(([name, r]) => [
        name,
        [r.headers.get("cache-control"), (r.headers.get("vary") ?? "").includes("Origin")],
      ]),
    );
    expect(headers).toEqual(
      Object.fromEntries(responses.map(([name]) => [name, ["no-store", true]])),
    );
    // No guest response carries the booker's name or email.
    for (const [, r] of responses) {
      expect(r.text).not.toContain("synthetic.guest");
      expect(r.text).not.toContain("Synthetic Guest");
    }
  });

  // About 30 requests in sequence, each on its own database connection, so on
  // a distant Neon branch this one test runs close to a minute. It gets three
  // minutes instead of the suite's one.
  it("keeps every new route inside its tenant", async ({ expect }) => {
    const a = await open(A, tripsA.shared(), 1);
    const b = await open(B, tripsB.shared(), 1);
    const aBearer = { authorization: `Bearer ${a.secret}` };
    const aPay = { authorization: `Bearer ${a.payment.clientSecret}` };
    // A paid booking and a refunded payment in A, for the staff reads.
    const booked = await open(A, tripsA.shared(), 2);
    await control(A, booked.payment.paymentRef, booked.payment.clientSecret, "succeed");
    const refunded = await open(A, tripsA.shared(), 1);
    await request("POST", `/v1/public/checkout-sessions/${refunded.session.id}/cancel`, {
      origin: guest(A),
      headers: { authorization: `Bearer ${refunded.secret}` },
    });
    await control(A, refunded.payment.paymentRef, refunded.payment.clientSecret, "succeed");
    const succeededEvent = (
      await request("GET", `/v1/fake-provider/payments/${booked.payment.paymentRef}`, {
        origin: guest(A),
        headers: { authorization: `Bearer ${booked.payment.clientSecret}` },
      })
    ).json as unknown as { payment?: { events: { id: string }[] } };
    const bookedEventId = succeededEvent.payment?.events[0]?.id ?? "";
    const bookedTrip =
      (
        await admin<{ trip_id: string }[]>`
        select trip_id from public.checkout_sessions where id = ${booked.session.id}`
      )[0]?.trip_id ?? "";

    const results: Record<string, [number, string | undefined]> = {};
    const record = (name: string, r: Res) => {
      results[name] = [r.status, r.json.error?.code];
    };
    // Checkout routes at B's address with A's things.
    record("open A's quote at B", await openWith(B, await quote(A, tripsA.shared(), 1)));
    record(
      "read A's checkout at B",
      await request("GET", `/v1/public/checkout-sessions/${a.session.id}`, {
        origin: guest(B),
        headers: aBearer,
      }),
    );
    record(
      "cancel A's checkout at B",
      await request("POST", `/v1/public/checkout-sessions/${a.session.id}/cancel`, {
        origin: guest(B),
        headers: aBearer,
      }),
    );
    record(
      "read B's checkout with A's secret",
      await request("GET", `/v1/public/checkout-sessions/${b.session.id}`, {
        origin: guest(B),
        headers: aBearer,
      }),
    );
    record(
      "read A's checkout at an unknown address",
      await request("GET", `/v1/public/checkout-sessions/${a.session.id}`, {
        origin: "https://nobody.book.example.test",
        headers: aBearer,
      }),
    );
    // The fake provider's four controls at B's address with A's payment.
    record(
      "fake read at B",
      await request("GET", `/v1/fake-provider/payments/${a.payment.paymentRef}`, {
        origin: guest(B),
        headers: aPay,
      }),
    );
    record(
      "fake succeed at B",
      await request("POST", `/v1/fake-provider/payments/${a.payment.paymentRef}/succeed`, {
        origin: guest(B),
        headers: aPay,
      }),
    );
    record(
      "fake fail at B",
      await request("POST", `/v1/fake-provider/payments/${a.payment.paymentRef}/fail`, {
        origin: guest(B),
        headers: aPay,
      }),
    );
    record(
      "fake redeliver at B",
      await request(
        "POST",
        `/v1/fake-provider/payments/${booked.payment.paymentRef}/events/${bookedEventId}/redeliver`,
        { origin: guest(B), headers: { authorization: `Bearer ${booked.payment.clientSecret}` } },
      ),
    );
    record(
      "B's payment with A's client secret",
      await request("POST", `/v1/fake-provider/payments/${b.payment.paymentRef}/succeed`, {
        origin: guest(B),
        headers: aPay,
      }),
    );
    // Staff reads across tenants and roles.
    record(
      "B's owner reads A's bookings",
      await request("GET", `/v1/staff/tenants/${A.id}/trips/${bookedTrip}/bookings`, {
        as: B.owner,
      }),
    );
    record(
      "B's owner reads A's trip under B",
      await request("GET", `/v1/staff/tenants/${B.id}/trips/${bookedTrip}/bookings`, {
        as: B.owner,
      }),
    );
    record(
      "B's owner reads A's exceptions",
      await request("GET", `/v1/staff/tenants/${A.id}/finalization-exceptions`, { as: B.owner }),
    );
    record(
      "A's finance reads A's bookings",
      await request("GET", `/v1/staff/tenants/${A.id}/trips/${bookedTrip}/bookings`, {
        as: A.finance,
      }),
    );
    expect(results).toEqual({
      "open A's quote at B": [404, "quote_not_found"],
      "read A's checkout at B": [404, "checkout_not_found"],
      "cancel A's checkout at B": [404, "checkout_not_found"],
      "read B's checkout with A's secret": [404, "checkout_not_found"],
      "read A's checkout at an unknown address": [404, "tenant_not_found"],
      "fake read at B": [404, "payment_not_found"],
      "fake succeed at B": [404, "payment_not_found"],
      "fake fail at B": [404, "payment_not_found"],
      "fake redeliver at B": [404, "event_not_found"],
      "B's payment with A's client secret": [404, "payment_not_found"],
      "B's owner reads A's bookings": [404, "tenant_not_found"],
      "B's owner reads A's trip under B": [404, "trip_not_found"],
      "B's owner reads A's exceptions": [404, "tenant_not_found"],
      "A's finance reads A's bookings": [403, "forbidden"],
    });
    // A's staff see A's booking and exception; B's see none of A's.
    const ownList = await request("GET", `/v1/staff/tenants/${A.id}/trips/${bookedTrip}/bookings`, {
      as: A.staff,
    });
    expect(ownList.status).toBe(200);
    expect(ownList.json.bookings).toHaveLength(1);
    const financeExceptions = await request(
      "GET",
      `/v1/staff/tenants/${A.id}/finalization-exceptions`,
      { as: A.finance },
    );
    expect(financeExceptions.json.exceptions?.map((e) => e.checkoutSessionId)).toContain(
      refunded.session.id,
    );
    const bExceptions = await request("GET", `/v1/staff/tenants/${B.id}/finalization-exceptions`, {
      as: B.owner,
    });
    expect(bExceptions.status).toBe(200);
    expect(bExceptions.json.exceptions?.map((e) => e.checkoutSessionId)).not.toContain(
      refunded.session.id,
    );
    // The webhook: B's account with A's payment, and A's account with B's.
    const crossed = craftedFakeEventBody({
      type: "payment.succeeded",
      accountRef: B.accountRef,
      paymentRef: a.payment.paymentRef,
      amount: a.session.amount,
      clientReference: a.paymentId,
    });
    expect((await post(crossed, await sign(crossed))).json).toMatchObject({
      received: true,
      outcome: "unmatched_payment",
    });
    const reversed = craftedFakeEventBody({
      type: "payment.failed",
      accountRef: A.accountRef,
      paymentRef: b.payment.paymentRef,
      amount: b.session.amount,
      clientReference: b.paymentId,
    });
    expect((await post(reversed, await sign(reversed))).json).toMatchObject({
      received: true,
      outcome: "unmatched_payment",
    });
    // Nothing changed for either guest, and neither fake payment settled.
    expect(await sessionRow(a.session.id)).toMatchObject({
      state: "open",
      hold: "active",
      bookings: 0,
    });
    expect(await sessionRow(b.session.id)).toMatchObject({
      state: "open",
      hold: "active",
      bookings: 0,
    });
    const [settledCount] = await admin<{ n: number }[]>`
      select count(*)::int as n from public.fake_provider_events
       where payment_id in (${a.payment.paymentRef}, ${b.payment.paymentRef})`;
    expect(settledCount?.n).toBe(0);
  }, 180_000);
});
