/**
 * Adversarial suite for the guest's accountless access through the API (lane
 * 1, G2.11c and the G2.16 email shim): POST /v1/public/booking-access, its
 * renewals, the checkout's manage-session, the /v1/public/manage/* routes,
 * and the local demo mailbox. Contracts: packages/contracts/src/self-service.ts,
 * packages/domain-messaging/README.md, packages/domain-booking/README.md.
 *
 * Mail stays queued after commit (deliverEmailAfterCommit: false); the test
 * delivers it through the fake provider itself and reads the link the guest
 * would click from what the fake accepted. Synthetic data only.
 */
import { createHash, randomUUID } from "node:crypto";
import { createDb, inTenantTransaction, type TenantContext } from "@tidegrid/database";
import type {} from "@tidegrid/database/global-setup";
import { createCheckoutSession } from "@tidegrid/domain-booking";
import {
  type CheckoutFixture,
  confirmBooking,
  createCheckoutFixture,
  fakeProvider,
  newSecret,
  quoteFor,
  TEST_FAKE_SECRET,
} from "@tidegrid/domain-booking/testing";
import { tripAllocator } from "@tidegrid/domain-inventory/testing";
import {
  deliverTenantMessages,
  FakeEmailProvider,
  revokeAccessLinks,
} from "@tidegrid/domain-messaging";
import { FAKE_MINIMUM_AMOUNT, type FakePaymentProvider } from "@tidegrid/domain-payments";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";
import { createApp } from "../src/app.ts";

type Sql = ReturnType<typeof postgres>;
// biome-ignore lint/suspicious/noExplicitAny: response bodies are checked field by field.
type Json = Record<string, any>;

const env = inject("integrationDb");
const LINK_ORIGIN = "https://{slug}.book.example.test";
const sha256 = (text: string) => createHash("sha256").update(text).digest("hex");

interface Tenant extends CheckoutFixture {
  host: string;
}

describe.skipIf(!env)("adversarial: guest booking access through the API", () => {
  let admin: Sql;
  let runtime: ReturnType<typeof createDb>;
  let app: ReturnType<typeof createApp>;
  let payments: FakePaymentProvider;
  let mail: FakeEmailProvider;
  let A: Tenant;
  let B: Tenant;
  let tripsA: ReturnType<typeof tripAllocator>;
  let tripsB: ReturnType<typeof tripAllocator>;
  let bookerCount = 0;

  const bindings = (overrides: Record<string, string> = {}) => ({
    ENVIRONMENT: "local" as "local" | "preview",
    BUILD_ID: "integration",
    DATABASE_URL: env?.runtimeUrl ?? "",
    ALLOWED_ORIGINS: [A, B].map((t) => `https://${t.host}`).join(","),
    STAFF_ORIGINS: "https://console.test",
    PAYMENT_PROVIDER: "fake",
    FAKE_PAYMENT_WEBHOOK_SECRET: TEST_FAKE_SECRET,
    EMAIL_PROVIDER: "fake",
    GUEST_LINK_ORIGIN: LINK_ORIGIN,
    ...overrides,
  });
  const executionCtx = { waitUntil: () => {}, passThroughOnException: () => {}, props: {} };

  async function request(
    method: string,
    path: string,
    opts: {
      origin?: string | null;
      body?: unknown;
      raw?: string;
      headers?: Record<string, string>;
      env?: Record<string, string>;
    } = {},
  ) {
    const headers = new Headers(opts.headers);
    if (opts.origin) headers.set("origin", opts.origin);
    if (opts.body !== undefined || opts.raw !== undefined) {
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
    const text = method === "HEAD" ? "" : await res.text();
    let json: Json = {};
    try {
      json = text ? (JSON.parse(text) as Json) : {};
    } catch {
      json = { text };
    }
    return { status: res.status, headers: res.headers, json, text };
  }

  const guest = (t: Tenant) => `https://${t.host}`;
  const bearer = (token: string) => ({ authorization: `Bearer ${token}` });
  const redeemAt = (t: Tenant, token: unknown) =>
    request("POST", "/v1/public/booking-access", { origin: guest(t), body: { token } });
  const renewAt = (t: Tenant, body: unknown) =>
    request("POST", "/v1/public/booking-access/renewals", { origin: guest(t), body });

  function booker(label: string) {
    bookerCount += 1;
    return {
      name: `Synthetic ${label} ${bookerCount}`,
      email: `synthetic.${label}.${bookerCount}@example.test`,
    };
  }

  async function deliver(t: Tenant) {
    return deliverTenantMessages(runtime.db, t.id, {
      provider: mail,
      fromAddress: "bookings@tidegrid.test",
      guestLinkOrigin: LINK_ORIGIN,
      runId: `run-${randomUUID()}`,
    });
  }

  async function tokenOf(messageId: string): Promise<string> {
    const [row] = await admin<{ html_body: string }[]>`
      select html_body from public.fake_email_deliveries
       where idempotency_key = ${messageId} and result = 'accepted'`;
    const token = /#t=([A-Za-z0-9_-]{43})/.exec(row?.html_body ?? "")?.[1];
    if (!token) throw new Error(`no delivered link for ${messageId}`);
    return token;
  }

  async function messages(bookingId: string) {
    return admin<{ id: string; template: string; state: string; to_email: string }[]>`
      select id, template, state, to_email from public.email_messages
       where booking_id = ${bookingId} order by created_at, id`;
  }

  /** A confirmed booking, its confirmation delivered, and the link it carries. */
  async function bookedWithLink(t: Tenant, party = 2) {
    const who = booker("guest");
    const booked = await confirmBooking(
      runtime.db,
      payments,
      t,
      (t === A ? tripsA : tripsB).shared(),
      party,
      { booker: who },
    );
    await deliver(t);
    const [confirmation] = await messages(booked.bookingId);
    if (confirmation?.state !== "sent") throw new Error("setup: not delivered");
    return {
      booked,
      booker: who,
      messageId: confirmation.id,
      token: await tokenOf(confirmation.id),
    };
  }

  async function linkState(token: string) {
    const [row] = await admin<{ consumed: boolean; revoked_reason: string | null }[]>`
      select consumed_at is not null as consumed, revoked_reason from public.guest_access_links
       where token_hash = ${sha256(`access-link:${token}`)}`;
    return row ?? null;
  }

  async function sessionFor(t: Tenant, booked: { checkoutSessionId: string; secret: string }) {
    const res = await request(
      "POST",
      `/v1/public/checkout-sessions/${booked.checkoutSessionId}/manage-session`,
      { origin: guest(t), headers: bearer(booked.secret) },
    );
    if (res.status !== 201) throw new Error(`setup session: ${res.status} ${res.text}`);
    return res.json.session.token as string;
  }

  async function withHost(fixture: CheckoutFixture): Promise<Tenant> {
    const host = `${fixture.slug}.book.example.test`;
    await admin`insert into public.tenant_hostnames (hostname, tenant_id, kind, status, verified_at)
      values (${host}, ${fixture.id}, 'preview', 'active', now())`;
    return { ...fixture, host };
  }

  beforeAll(async () => {
    if (!env) return;
    admin = postgres(env.adminUrl, { max: 3, onnotice: () => {} });
    runtime = createDb(env.runtimeUrl, { max: 10 });
    payments = fakeProvider(runtime.db);
    mail = new FakeEmailProvider({ db: runtime.db, environment: "local" });
    const [a, b] = await Promise.all([
      createCheckoutFixture(admin, runtime.db, "ssapi-a", { days: 30 }),
      createCheckoutFixture(admin, runtime.db, "ssapi-b", { days: 6 }),
    ]);
    A = await withHost(a);
    B = await withHost(b);
    tripsA = tripAllocator(A);
    tripsB = tripAllocator(B);
    app = createApp({ deliverEmailAfterCommit: false });
  });

  afterAll(async () => {
    await runtime?.end();
    await admin?.end({ timeout: 5 });
  });

  it("uses a link only on the explicit POST: scanner GETs, HEADs, previews, and queries use nothing", async () => {
    const { booked, token } = await bookedWithLink(A);
    const linkEmails = async () =>
      (await messages(booked.bookingId)).filter((m) => m.template === "booking_manage_link").length;
    const probes: [string, string][] = [
      ["GET", "/v1/public/booking-access"],
      ["HEAD", "/v1/public/booking-access"],
      ["GET", `/v1/public/booking-access?token=${token}`],
      ["GET", `/v1/public/booking-access?t=${token}`],
      ["GET", `/v1/public/booking-access/${token}`],
      ["HEAD", `/v1/public/booking-access/${token}`],
      ["OPTIONS", "/v1/public/booking-access"],
      ["GET", `/manage?t=${token}`],
      ["HEAD", `/manage?t=${token}`],
      ["GET", `/manage/${token}`],
      ["GET", `/v1/public/booking-access/renewals?token=${token}`],
      ["GET", `/v1/public/manage/booking?token=${token}`],
    ];
    for (const [method, path] of probes) {
      const res = await request(method, path, { origin: guest(A) });
      expect(res.status, `${method} ${path}`).not.toBe(201);
      expect(await linkState(token), `${method} ${path}`).toEqual({
        consumed: false,
        revoked_reason: null,
      });
    }
    expect(await linkEmails()).toBe(0);
    // The token in the URL's query is refused even on a POST.
    const queried = await request("POST", `/v1/public/booking-access?token=${token}`, {
      origin: guest(A),
      body: {},
    });
    expect(queried.status).toBe(400);
    expect((await linkState(token))?.consumed).toBe(false);
    const opened = await redeemAt(A, token);
    expect(opened.status).toBe(201);
    expect(opened.json.booking.reference).toBe(booked.reference);
    expect((await linkState(token))?.consumed).toBe(true);
  });

  it("redeems a link once: a replay and concurrent redemptions answer link_used", async () => {
    const first = await bookedWithLink(A);
    const opened = await redeemAt(A, first.token);
    expect(opened.status).toBe(201);
    expect(opened.json.session.token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(opened.headers.get("cache-control")).toBe("no-store");
    const replay = await redeemAt(A, first.token);
    expect(replay.status).toBe(410);
    expect(replay.json.error.code).toBe("link_used");
    expect(replay.headers.get("cache-control")).toBe("no-store");
    expect(replay.text).not.toContain(opened.json.session.token);

    const second = await bookedWithLink(A);
    const racing = await Promise.all(Array.from({ length: 6 }, () => redeemAt(A, second.token)));
    expect(racing.filter((r) => r.status === 201)).toHaveLength(1);
    const losers = racing.filter((r) => r.status !== 201);
    expect(losers.map((r) => [r.status, r.json.error?.code])).toEqual(
      Array.from({ length: 5 }, () => [410, "link_used"]),
    );
    const [sessions] = await admin<{ n: number }[]>`
      select count(*)::int as n from public.guest_sessions s
        join public.guest_access_links l on l.id = s.link_id
       where l.token_hash = ${sha256(`access-link:${second.token}`)}`;
    expect(sessions?.n).toBe(1);
  });

  it("keeps a link and its session inside their operator: another site, an unknown one, or none", async () => {
    const { booked, token } = await bookedWithLink(A);
    const elsewhere = await redeemAt(B, token);
    expect([elsewhere.status, elsewhere.json.error?.code]).toEqual([404, "link_not_found"]);
    const unknown = await request("POST", "/v1/public/booking-access", {
      origin: "https://nobody-here.book.example.test",
      body: { token },
    });
    expect([unknown.status, unknown.json.error?.code]).toEqual([404, "tenant_not_found"]);
    const none = await request("POST", "/v1/public/booking-access", {
      origin: null,
      body: { token },
    });
    expect(none.status).toBe(404);
    expect((await linkState(token))?.consumed).toBe(false);

    const opened = await redeemAt(A, token);
    expect(opened.status).toBe(201);
    const session = opened.json.session.token as string;
    const terms = await request("GET", "/v1/public/manage/cancellation", {
      origin: guest(A),
      headers: bearer(session),
    });
    expect(terms.status).toBe(200);
    // The same session at another operator's site is no session at all.
    const attempts = [
      request("GET", "/v1/public/manage/booking", { origin: guest(B), headers: bearer(session) }),
      request("GET", "/v1/public/manage/cancellation", {
        origin: guest(B),
        headers: bearer(session),
      }),
      request("POST", "/v1/public/manage/cancellation", {
        origin: guest(B),
        headers: { ...bearer(session), "idempotency-key": `adv-${randomUUID()}` },
        body: { expectedRefundAmount: terms.json.terms.refundAmount },
      }),
      request("PUT", "/v1/public/manage/participants/1", {
        origin: guest(B),
        headers: { ...bearer(session), "idempotency-key": `adv-${randomUUID()}` },
        body: { name: "Synthetic Intruder", isMinor: false },
      }),
      request("POST", "/v1/public/manage/link-email", {
        origin: guest(B),
        headers: bearer(session),
      }),
      request("POST", "/v1/public/manage/session/end", {
        origin: guest(B),
        headers: bearer(session),
      }),
    ];
    for (const res of await Promise.all(attempts)) {
      expect([res.status, res.json.error?.code]).toEqual([401, "session_expired"]);
      expect(res.text).not.toContain(booked.reference);
    }
    const [state] = await admin<{ state: string; participants: number; links: number }[]>`
      select b.state,
             (select count(*)::int from public.booking_participants p where p.booking_id = b.id)
               as participants,
             (select count(*)::int from public.email_messages m where m.booking_id = b.id
               and m.template = 'booking_manage_link') as links
        from public.bookings b where b.id = ${booked.bookingId}`;
    expect(state).toEqual({ state: "confirmed", participants: 0, links: 0 });
    const read = await request("GET", "/v1/public/manage/booking", {
      origin: guest(A),
      headers: bearer(session),
    });
    expect(read.status).toBe(200);
    expect(read.json.booking.id).toBe(booked.bookingId);
  });

  it("refuses malformed tokens, and never takes a token from a URL", async () => {
    const { token } = await bookedWithLink(A);
    for (const bad of [
      "short",
      `${token}=`,
      ` ${token}`,
      `${token.slice(0, 42)}+`,
      `${token.slice(0, 42)}/`,
      `${token}\n`,
      123,
      null,
    ]) {
      const res = await redeemAt(A, bad);
      expect(res.status, JSON.stringify(bad)).toBe(400);
    }
    const empty = await request("POST", "/v1/public/booking-access", {
      origin: guest(A),
      body: {},
    });
    expect(empty.status).toBe(400);
    const unknown = await redeemAt(A, newSecret());
    expect([unknown.status, unknown.json.error?.code]).toEqual([404, "link_not_found"]);
    expect((await linkState(token))?.consumed).toBe(false);

    const opened = await redeemAt(A, token);
    const session = opened.json.session.token as string;
    for (const headers of [
      {},
      { authorization: `bearer ${session}` },
      { authorization: `Bearer ${session}x` },
      { authorization: `Bearer  ${session}` },
      { authorization: `Basic ${Buffer.from(`guest:${session}`).toString("base64")}` },
      { cookie: `session=${session}` },
    ]) {
      const res = await request("GET", `/v1/public/manage/booking?token=${session}`, {
        origin: guest(A),
        headers,
      });
      expect([res.status, res.json.error?.code], JSON.stringify(headers)).toEqual([
        401,
        "session_required",
      ]);
    }
    // A link is not a session, and a session is not a link.
    const asSession = await request("GET", "/v1/public/manage/booking", {
      origin: guest(A),
      headers: bearer(token),
    });
    expect([asSession.status, asSession.json.error?.code]).toEqual([401, "session_expired"]);
    const asLink = await redeemAt(A, session);
    expect([asLink.status, asLink.json.error?.code]).toEqual([404, "link_not_found"]);
  });

  it("expires links and sessions on the database clock, and opens sessions for an hour", async () => {
    const lapsing = await bookedWithLink(A);
    const [ttl] = await admin<{ seconds: number }[]>`
      select extract(epoch from expires_at - created_at)::int as seconds
        from public.guest_access_links where message_id = ${lapsing.messageId}`;
    expect(ttl?.seconds).toBe(3 * 24 * 3600);
    await admin`update public.guest_access_links set expires_at = now() - interval '1 second'
                 where token_hash = ${sha256(`access-link:${lapsing.token}`)}`;
    const expired = await redeemAt(A, lapsing.token);
    expect([expired.status, expired.json.error?.code]).toEqual([410, "link_expired"]);

    const fresh = await bookedWithLink(A);
    const before = Date.now();
    const opened = await redeemAt(A, fresh.token);
    expect(opened.status).toBe(201);
    const expiresAt = Date.parse(opened.json.session.expiresAt);
    expect(expiresAt).toBeGreaterThan(before + 3600_000 - 120_000);
    expect(expiresAt).toBeLessThanOrEqual(Date.now() + 3600_000 + 120_000);
    const session = opened.json.session.token as string;
    const hash = sha256(`guest-session:${session}`);
    const [span] = await admin<{ seconds: number }[]>`
      select extract(epoch from expires_at - created_at)::int as seconds
        from public.guest_sessions where token_hash = ${hash}`;
    expect(span?.seconds).toBe(3600);
    // Even the owner cannot stretch a session; time passing ends it.
    let refused: { code?: string } = {};
    try {
      await admin`update public.guest_sessions set expires_at = expires_at + interval '1 hour'
                   where token_hash = ${hash}`;
    } catch (err) {
      refused = err as { code?: string };
    }
    expect(refused.code).toBe("23514");
    await admin`update public.guest_sessions set expires_at = now() - interval '1 second'
                 where token_hash = ${hash}`;
    const ended = await request("GET", "/v1/public/manage/booking", {
      origin: guest(A),
      headers: bearer(session),
    });
    expect([ended.status, ended.json.error?.code]).toEqual([401, "session_expired"]);
  });

  it("says why a link stopped working; a superseded link renews to the booker, a revoked one renews nothing", async () => {
    const { booked, booker: who, token: first } = await bookedWithLink(A);
    const session = await sessionFor(A, booked);
    const asked = await request("POST", "/v1/public/manage/link-email", {
      origin: guest(A),
      headers: bearer(session),
    });
    expect([asked.status, asked.json]).toEqual([202, { status: "accepted" }]);
    await deliver(A);
    const linkMail = (await messages(booked.bookingId)).filter(
      (m) => m.template === "booking_manage_link",
    );
    expect(linkMail).toHaveLength(1);
    const second = await tokenOf(linkMail[0]?.id ?? "");
    const superseded = await redeemAt(A, first);
    expect([superseded.status, superseded.json.error?.code]).toEqual([410, "link_superseded"]);

    const ctx: TenantContext = {
      tenantId: A.id,
      actorType: "staff",
      actorId: "adv",
      requestId: "adv",
    };
    await inTenantTransaction(runtime.db, ctx, (trx) =>
      revokeAccessLinks(trx, ctx, {
        bookingId: booked.bookingId,
        purpose: "booking_manage",
        reason: "staff",
      }),
    );
    const revoked = await redeemAt(A, second);
    expect([revoked.status, revoked.json.error?.code]).toEqual([410, "link_revoked"]);

    // A link revoked on purpose renews nothing, though it answers as any token does:
    // otherwise whoever still holds that email could keep replacing the booker's link.
    const refused = await renewAt(A, { token: second });
    expect([refused.status, refused.json]).toEqual([202, { status: "accepted" }]);
    await deliver(A);
    expect(
      (await messages(booked.bookingId)).filter((m) => m.template === "booking_manage_link"),
    ).toHaveLength(1);

    // A superseded link still renews, to the booker's address on file.
    const renewed = await renewAt(A, { token: first });
    expect([renewed.status, renewed.json]).toEqual([202, { status: "accepted" }]);
    await deliver(A);
    const newest = (await messages(booked.bookingId)).filter(
      (m) => m.template === "booking_manage_link",
    );
    expect(newest).toHaveLength(2);
    expect(newest.every((m) => m.to_email === who.email && m.state === "sent")).toBe(true);
    const third = await tokenOf(newest[1]?.id ?? "");
    expect((await redeemAt(A, third)).status).toBe(201);
    expect((await linkState(second))?.revoked_reason).toBe("staff");
    expect((await redeemAt(A, second)).json.error?.code).toBe("link_revoked");
  });

  it("answers every renewal alike, mails only the booker on file, and at most three an hour", async () => {
    const { booked, booker: who, token } = await bookedWithLink(A);
    expect((await redeemAt(A, token)).status).toBe(201);
    const linkMail = async () =>
      (await messages(booked.bookingId)).filter((m) => m.template === "booking_manage_link");
    const countAll = async () => {
      const [row] = await admin<{ n: number }[]>`
        select count(*)::int as n from public.email_messages
         where template = 'booking_manage_link' and tenant_id in (${A.id}, ${B.id})`;
      return row?.n ?? 0;
    };
    const before = await countAll();
    const unknown = await renewAt(A, { token: newSecret() });
    const foreign = await renewAt(B, { token });
    expect(await countAll()).toBe(before);
    const used = await renewAt(A, { token, email: "intruder@example.test" });
    for (const res of [unknown, foreign, used]) {
      expect(res.status).toBe(202);
      expect(res.json).toEqual({ status: "accepted" });
      expect(res.headers.get("cache-control")).toBe("no-store");
    }
    expect(unknown.text).toBe(used.text);
    expect(foreign.text).toBe(used.text);
    expect(await linkMail()).toHaveLength(1);

    const racing = await Promise.all(
      Array.from({ length: 6 }, () => renewAt(A, { token, email: "intruder@example.test" })),
    );
    expect(racing.every((r) => r.status === 202)).toBe(true);
    const sent = await linkMail();
    expect(sent).toHaveLength(3);
    expect(sent.every((m) => m.to_email === who.email)).toBe(true);
    const [intruded] = await admin<{ n: number }[]>`
      select count(*)::int as n from public.email_messages where to_email = 'intruder@example.test'`;
    expect(intruded?.n).toBe(0);
    const session = await sessionFor(A, booked);
    const limited = await request("POST", "/v1/public/manage/link-email", {
      origin: guest(A),
      headers: bearer(session),
    });
    expect([limited.status, limited.json.error?.code]).toEqual([429, "link_email_rate_limited"]);
    expect(await linkMail()).toHaveLength(3);
  });

  it("binds a session to its booking: its commands and idempotency keys never reach another booking", async () => {
    const one = await confirmBooking(runtime.db, payments, A, tripsA.shared(), 2, {
      booker: booker("first"),
    });
    const two = await confirmBooking(runtime.db, payments, A, tripsA.shared(), 2, {
      booker: booker("second"),
    });
    const s1 = await sessionFor(A, one);
    const s2 = await sessionFor(A, two);
    const key = `adv-shared-${randomUUID()}`;
    const rider = { name: "Synthetic Same Name", isMinor: false };
    const put = (session: string) =>
      request("PUT", "/v1/public/manage/participants/1", {
        origin: guest(A),
        headers: { ...bearer(session), "idempotency-key": key },
        body: rider,
      });
    const p1 = await put(s1);
    const p2 = await put(s2);
    expect([p1.status, p2.status]).toEqual([200, 200]);
    expect(p2.headers.get("idempotent-replayed")).toBeNull();
    expect(p2.json.created).toBe(true);
    expect(p2.json.participant.id).not.toBe(p1.json.participant.id);
    const owners = await admin<{ id: string; booking_id: string }[]>`
      select id, booking_id from public.booking_participants
       where id in (${p1.json.participant.id}, ${p2.json.participant.id})`;
    expect(Object.fromEntries(owners.map((o) => [o.id, o.booking_id]))).toEqual({
      [p1.json.participant.id]: one.bookingId,
      [p2.json.participant.id]: two.bookingId,
    });

    const terms = await request("GET", "/v1/public/manage/cancellation", {
      origin: guest(A),
      headers: bearer(s1),
    });
    const cancelKey = `adv-cancel-${randomUUID()}`;
    const cancel = (session: string) =>
      request("POST", "/v1/public/manage/cancellation", {
        origin: guest(A),
        headers: { ...bearer(session), "idempotency-key": cancelKey },
        body: { expectedRefundAmount: terms.json.terms.refundAmount },
      });
    const c1 = await cancel(s1);
    expect(c1.status).toBe(200);
    expect(c1.json.booking.id).toBe(one.bookingId);
    const read2 = await request("GET", "/v1/public/manage/booking", {
      origin: guest(A),
      headers: bearer(s2),
    });
    expect(read2.json.booking).toMatchObject({ id: two.bookingId, state: "confirmed" });
    expect(read2.text).not.toContain(c1.json.booking.booker.email);
    // The same key from the other booking's session is that booking's own command.
    const c2 = await cancel(s2);
    expect(c2.status).toBe(200);
    expect(c2.headers.get("idempotent-replayed")).toBeNull();
    expect(c2.json.booking.id).toBe(two.bookingId);
    expect(c2.text).not.toContain(c1.json.booking.booker.email);
  });

  it("opens the paying checkout's booking only with its secret, at its operator, and within the hour", async () => {
    const booked = await confirmBooking(runtime.db, payments, A, tripsA.shared(), 1, {
      booker: booker("payer"),
    });
    const path = `/v1/public/checkout-sessions/${booked.checkoutSessionId}/manage-session`;
    const none = await request("POST", path, { origin: guest(A) });
    expect([none.status, none.json.error?.code]).toEqual([401, "checkout_secret_required"]);
    for (const [label, res] of [
      [
        "wrong secret",
        await request("POST", path, { origin: guest(A), headers: bearer(newSecret()) }),
      ],
      [
        "other operator",
        await request("POST", path, { origin: guest(B), headers: bearer(booked.secret) }),
      ],
      [
        "unknown checkout",
        await request("POST", `/v1/public/checkout-sessions/${randomUUID()}/manage-session`, {
          origin: guest(A),
          headers: bearer(booked.secret),
        }),
      ],
      [
        "malformed checkout",
        await request("POST", "/v1/public/checkout-sessions/not-a-uuid/manage-session", {
          origin: guest(A),
          headers: bearer(booked.secret),
        }),
      ],
    ] as const) {
      expect(res.status, label).toBe(404);
      expect(res.text, label).not.toContain(booked.reference);
    }
    // A checkout that never became a booking opens nothing.
    const quote = await quoteFor(runtime.db, A.id, tripsA.shared(), 1);
    const secret = newSecret();
    const ctx: TenantContext = {
      tenantId: A.id,
      actorType: "guest",
      actorId: null,
      requestId: "adv",
    };
    const open = await inTenantTransaction(runtime.db, ctx, (trx) =>
      createCheckoutSession(trx, ctx, {
        quoteId: quote.quoteId,
        acceptedPolicyVersion: quote.policy.version,
        booker: booker("unpaid"),
        secret,
        clientAddress: null,
        provider: "fake",
        minimumAmount: FAKE_MINIMUM_AMOUNT,
      }),
    );
    if (open.kind !== "created") throw new Error("setup checkout");
    const unpaid = await request(
      "POST",
      `/v1/public/checkout-sessions/${open.session.id}/manage-session`,
      { origin: guest(A), headers: bearer(secret) },
    );
    expect([unpaid.status, unpaid.json.error?.code]).toEqual([409, "checkout_not_confirmed"]);

    const opened = await request("POST", path, {
      origin: guest(A),
      headers: bearer(booked.secret),
    });
    expect(opened.status).toBe(201);
    expect(opened.json.booking.reference).toBe(booked.reference);

    // Two hours after confirmation the checkout's secret opens nothing more.
    await admin.begin(async (tx) => {
      await tx`alter table public.bookings disable trigger bookings_lifecycle`;
      await tx`update public.bookings set confirmed_at = confirmed_at - interval '2 hours'
                where id = ${booked.bookingId}`;
      await tx`alter table public.bookings enable trigger bookings_lifecycle`;
    });
    const [trigger] = await admin<{ enabled: string }[]>`
      select tgenabled as enabled from pg_trigger
       where tgname = 'bookings_lifecycle' and tgrelid = 'public.bookings'::regclass`;
    expect(trigger?.enabled).toBe("O");
    const late = await request("POST", path, { origin: guest(A), headers: bearer(booked.secret) });
    expect([late.status, late.json.error?.code]).toEqual([410, "manage_window_closed"]);
  });

  it("ends a session on request, and it stays ended", async () => {
    const booked = await confirmBooking(runtime.db, payments, A, tripsA.shared(), 1, {
      booker: booker("leaver"),
    });
    const session = await sessionFor(A, booked);
    const end = await request("POST", "/v1/public/manage/session/end", {
      origin: guest(A),
      headers: bearer(session),
    });
    expect([end.status, end.json]).toEqual([200, { ended: true }]);
    for (const [method, path] of [
      ["GET", "/v1/public/manage/booking"],
      ["POST", "/v1/public/manage/session/end"],
    ] as const) {
      const res = await request(method, path, { origin: guest(A), headers: bearer(session) });
      expect([res.status, res.json.error?.code]).toEqual([401, "session_expired"]);
    }
  });

  it("shows the demo mailbox one operator at a time, only locally and only with the fake", async () => {
    const { messageId } = await bookedWithLink(A);
    const [delivered] = await admin<{ id: string; subject: string }[]>`
      select id, subject from public.fake_email_deliveries
       where idempotency_key = ${messageId} and result = 'accepted'`;
    if (!delivered) throw new Error("setup: nothing delivered");
    const own = await request("GET", `/v1/fake-email/mailbox/${A.host}/${delivered.id}`);
    expect(own.status).toBe(200);
    expect(own.headers.get("cache-control")).toBe("no-store");
    const other = await request("GET", `/v1/fake-email/mailbox/${B.host}/${delivered.id}`);
    expect(other.status).toBe(404);
    expect(other.text).not.toContain(delivered.subject);
    const listing = await request("GET", `/v1/fake-email/mailbox/${B.host}`);
    expect(listing.text).not.toContain(delivered.id);
    for (const overrides of [{ ENVIRONMENT: "preview" }, { EMAIL_PROVIDER: "" }]) {
      for (const path of [
        "/v1/fake-email/mailbox",
        `/v1/fake-email/mailbox/${A.host}`,
        `/v1/fake-email/mailbox/${A.host}/${delivered.id}`,
      ]) {
        const res = await request("GET", path, { env: overrides });
        expect(res.status, `${JSON.stringify(overrides)} ${path}`).toBe(404);
        expect(res.text).not.toContain(delivered.subject);
      }
    }
  });
});
