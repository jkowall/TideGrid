/**
 * The staff resend route and the messages read's additions (G2.16b), through
 * the real app over a throwaway PostgreSQL:
 * POST /v1/staff/tenants/{tenantId}/bookings/{bookingId}/emails/resend and
 * GET .../bookings/{bookingId}/messages.
 *
 * What these prove:
 * - 201 with the new message; a replay answers the same with
 *   Idempotent-Replayed; the same key with another body is 422; a refusal is
 *   the key's stored answer and replays as the same 409.
 * - Finance is refused on the read and the resend, with email on or off;
 *   another tenant's, unknown, and malformed ids answer the same 404.
 * - With email off, 401, 404, and 403 come first; then booking_email_off,
 *   with nothing written and the key left unused; a key that already
 *   succeeded replays its answer.
 * - The read says whether email is on and whether a resend is allowed.
 * Domain behavior is in
 * packages/domain-booking/src/adversarial/staff-email-resend.integration.test.ts.
 */
import { randomUUID } from "node:crypto";
import { createDb } from "@tidegrid/database";
import type {} from "@tidegrid/database/global-setup";
import {
  type CheckoutFixture,
  confirmBooking,
  createCheckoutFixture,
  fakeProvider,
  TEST_FAKE_SECRET,
} from "@tidegrid/domain-booking/testing";
import { tripAllocator } from "@tidegrid/domain-inventory/testing";
import { deliverTenantMessages, FakeEmailProvider } from "@tidegrid/domain-messaging";
import type { FakePaymentProvider } from "@tidegrid/domain-payments";
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT } from "jose";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";
import { createApp } from "../src/app.ts";
import { createAccessVerifier } from "../src/auth/access.ts";

type Sql = ReturnType<typeof postgres>;
// biome-ignore lint/suspicious/noExplicitAny: response bodies are checked field by field.
type Json = Record<string, any>;

const env = inject("integrationDb");
const CONSOLE = "https://console.test";
const TEAM = "tidegrid-email-resend.cloudflareaccess.com";
const AUD = "ab".repeat(32);
const LINK_ORIGIN = "https://{slug}.book.example.test";

interface Staffed extends CheckoutFixture {
  owner: string;
  bookingStaff: string;
  finance: string;
}

describe.skipIf(!env)("staff resend of a booking's email: the API (G2.16b)", () => {
  let admin: Sql;
  let runtime: ReturnType<typeof createDb>;
  let app: ReturnType<typeof createApp>;
  let signingKey: CryptoKey;
  let payments: FakePaymentProvider;
  let mail: FakeEmailProvider;
  let A: Staffed;
  let B: Staffed;
  let tripsA: ReturnType<typeof tripAllocator>;
  let tripsB: ReturnType<typeof tripAllocator>;
  const kid = `kid-${randomUUID().slice(0, 8)}`;

  /** Email on (the fake), or off: EMAIL_PROVIDER unset, as on the Nov 1 preview. */
  const bindings = (email: "on" | "off" = "on") => ({
    ENVIRONMENT: "local" as const,
    BUILD_ID: "integration",
    DATABASE_URL: env?.runtimeUrl ?? "",
    ALLOWED_ORIGINS: CONSOLE,
    STAFF_ORIGINS: CONSOLE,
    PAYMENT_PROVIDER: "fake",
    FAKE_PAYMENT_WEBHOOK_SECRET: TEST_FAKE_SECRET,
    GUEST_LINK_ORIGIN: LINK_ORIGIN,
    ...(email === "on" ? { EMAIL_PROVIDER: "fake" } : {}),
  });
  const executionCtx = { waitUntil: () => {}, passThroughOnException: () => {}, props: {} };

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
    method: "GET" | "POST",
    path: string,
    options: { as?: string; key?: string; body?: unknown; email?: "on" | "off" } = {},
  ) {
    const headers = new Headers({ origin: CONSOLE });
    if (options.as) headers.set("cf-access-jwt-assertion", await token(options.as));
    if (options.key) headers.set("idempotency-key", options.key);
    if (options.body !== undefined) headers.set("content-type", "application/json");
    const res = await app.request(
      `http://localhost${path}`,
      {
        method,
        headers,
        ...(options.body !== undefined ? { body: JSON.stringify(options.body) } : {}),
      },
      bindings(options.email ?? "on"),
      executionCtx,
    );
    const text = await res.text();
    return {
      status: res.status,
      headers: res.headers,
      text,
      json: (text ? JSON.parse(text) : {}) as Json,
    };
  }

  const paths = (tenantId: string, bookingId: string) => ({
    resend: `/v1/staff/tenants/${tenantId}/bookings/${bookingId}/emails/resend`,
    messages: `/v1/staff/tenants/${tenantId}/bookings/${bookingId}/messages`,
  });

  const confirmation = { kind: "confirmation", reason: "guest_did_not_receive" } as const;

  async function member(tenantId: string, email: string, role: string) {
    const [existing] = await admin<{ id: string }[]>`
      select id from public.staff_users where email = ${email}`;
    const userId = existing?.id ?? randomUUID();
    if (!existing) {
      await admin`insert into public.staff_users (id, email, display_name)
        values (${userId}, ${email}, ${role})`;
    }
    await admin`insert into public.tenant_memberships (tenant_id, user_id, role, display_name)
      values (${tenantId}, ${userId}, ${role}, ${role})`;
    return email;
  }

  async function staffed(fixture: CheckoutFixture, label: string): Promise<Staffed> {
    const host = `${fixture.slug}.book.example.test`;
    await admin`insert into public.tenant_hostnames (hostname, tenant_id, kind, status, verified_at)
      values (${host}, ${fixture.id}, 'preview', 'active', now())`;
    const tag = fixture.id.slice(0, 8);
    return {
      ...fixture,
      owner: await member(fixture.id, `${label}-owner-${tag}@example.test`, "owner"),
      bookingStaff: await member(fixture.id, `${label}-desk-${tag}@example.test`, "booking_staff"),
      finance: await member(fixture.id, `${label}-finance-${tag}@example.test`, "finance"),
    };
  }

  const deliver = (t: Staffed) =>
    deliverTenantMessages(runtime.db, t.id, {
      provider: mail,
      fromAddress: "bookings@tidegrid.test",
      guestLinkOrigin: LINK_ORIGIN,
      environment: "local",
      runId: `run-${randomUUID()}`,
    });

  async function booked(t: Staffed, trips: ReturnType<typeof tripAllocator>) {
    const made = await confirmBooking(runtime.db, payments, t, trips.shared(), 1, {
      booker: {
        name: "Synthetic Resend Guest",
        email: `synthetic.resend.${randomUUID().slice(0, 8)}@example.test`,
      },
    });
    await deliver(t);
    return made;
  }

  async function storedKeys(tenantId: string, key: string) {
    const [row] = await admin<{ n: number }[]>`
      select count(*)::int as n from public.idempotency_keys
       where tenant_id = ${tenantId} and key = ${key}`;
    return row?.n ?? 0;
  }

  async function messageCount(bookingId: string) {
    const [row] = await admin<{ n: number }[]>`
      select count(*)::int as n from public.email_messages where booking_id = ${bookingId}`;
    return row?.n ?? 0;
  }

  async function auditCount(bookingId: string) {
    const [row] = await admin<{ n: number }[]>`
      select count(*)::int as n from public.audit_events
       where subject_id = ${bookingId} and action = 'booking.email_resent'`;
    return row?.n ?? 0;
  }

  beforeAll(async () => {
    if (!env) return;
    admin = postgres(env.adminUrl, { max: 3, onnotice: () => {} });
    runtime = createDb(env.runtimeUrl, { max: 8 });
    payments = fakeProvider(runtime.db);
    mail = new FakeEmailProvider({ db: runtime.db, environment: "local" });
    const [a, b] = await Promise.all([
      createCheckoutFixture(admin, runtime.db, "rsapi-a", { days: 12 }),
      createCheckoutFixture(admin, runtime.db, "rsapi-b", { days: 4 }),
    ]);
    A = await staffed(a, "rsapi-a");
    B = await staffed(b, "rsapi-b");
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
      deliverEmailAfterCommit: false,
    });
  });

  afterAll(async () => {
    await runtime?.end();
    await admin?.end({ timeout: 5 });
  });

  it("sends again with 201, replays the same answer, refuses another body under the key, and the read shows it", async () => {
    const b = await booked(A, tripsA);
    const own = paths(A.id, b.bookingId);
    const before = await request("GET", own.messages, { as: A.owner });
    expect(before.status).toBe(200);
    expect(before.json).toMatchObject({
      emailDelivery: "on",
      resend: {
        kind: "confirmation",
        allowed: true,
        availableAt: null,
        remaining: 5,
        blockedBy: null,
      },
    });

    const key = randomUUID();
    const sent = await request("POST", own.resend, { as: A.owner, key, body: confirmation });
    expect(sent.status).toBe(201);
    expect(sent.headers.get("cache-control")).toBe("no-store");
    expect(sent.headers.get("idempotent-replayed")).toBeNull();
    expect(Object.keys(sent.json)).toEqual(["message"]);
    expect(sent.json.message).toEqual({
      id: expect.any(String),
      generation: 1,
      queuedAt: expect.any(String),
    });
    for (const secret of ["@", "Synthetic Resend Guest", b.reference]) {
      expect(sent.text).not.toContain(secret);
    }

    const again = await request("POST", own.resend, { as: A.owner, key, body: confirmation });
    expect(again.status).toBe(201);
    expect(again.headers.get("idempotent-replayed")).toBe("true");
    expect(again.json).toEqual(sent.json);

    const other = await request("POST", own.resend, {
      as: A.owner,
      key,
      body: { kind: "confirmation", reason: "other" },
    });
    expect([other.status, other.json.error?.code]).toEqual([422, "idempotency_key_reused"]);
    expect(await messageCount(b.bookingId)).toBe(2);
    expect(await auditCount(b.bookingId)).toBe(1);

    const after = await request("GET", own.messages, { as: A.bookingStaff });
    expect(after.json.messages.map((m: Json) => [m.id, m.staffResend])).toEqual([
      [expect.any(String), false],
      [sent.json.message.id, true],
    ]);
    const lifted = new Date(Date.parse(after.json.messages[1].createdAt) + 10 * 60_000);
    expect(after.json.resend).toEqual({
      kind: "confirmation",
      allowed: false,
      availableAt: lifted.toISOString(),
      remaining: 4,
      blockedBy: "too_soon",
    });
  });

  it("stores a refusal as the key's answer and replays it as the same 409", async () => {
    const b = await booked(A, tripsA);
    const own = paths(A.id, b.bookingId);
    const first = await request("POST", own.resend, {
      as: A.bookingStaff,
      key: randomUUID(),
      body: confirmation,
    });
    expect(first.status).toBe(201);

    const key = randomUUID();
    const soon = await request("POST", own.resend, { as: A.bookingStaff, key, body: confirmation });
    expect([soon.status, soon.json.error?.code]).toEqual([409, "booking_email_too_soon"]);
    expect(soon.json.error?.message).toMatch(/10 minutes/);
    expect(await storedKeys(A.id, key)).toBe(1);
    const replay = await request("POST", own.resend, {
      as: A.bookingStaff,
      key,
      body: confirmation,
    });
    expect([replay.status, replay.json.error?.code]).toEqual([409, "booking_email_too_soon"]);
    expect(replay.headers.get("idempotent-replayed")).toBe("true");

    const mismatch = await request("POST", own.resend, {
      as: A.owner,
      key: randomUUID(),
      body: { kind: "cancellation", reason: "guest_asked_again" },
    });
    expect([mismatch.status, mismatch.json.error?.code]).toEqual([
      409,
      "booking_email_kind_mismatch",
    ]);
    expect(await messageCount(b.bookingId)).toBe(2);
  });

  it("refuses finance on the read and the resend, with email on or off, and hides other tenants", async () => {
    const b = await booked(A, tripsA);
    const inB = await booked(B, tripsB);
    const own = paths(A.id, b.bookingId);
    for (const email of ["on", "off"] as const) {
      const read = await request("GET", own.messages, { as: A.finance, email });
      expect([read.status, read.json.error?.code], email).toEqual([403, "forbidden"]);
      const key = randomUUID();
      const sent = await request("POST", own.resend, {
        as: A.finance,
        key,
        body: confirmation,
        email,
      });
      expect([sent.status, sent.json.error?.code], email).toEqual([403, "forbidden"]);
      expect(await storedKeys(A.id, key)).toBe(0);
    }
    const notFound: [string, string, string][] = [
      // Another tenant's staff, at a tenant they do not belong to.
      [own.resend, B.owner, "tenant_not_found"],
      // Another tenant's booking, named under one's own tenant.
      [paths(B.id, b.bookingId).resend, B.owner, "booking_not_found"],
      [paths(A.id, inB.bookingId).resend, A.owner, "booking_not_found"],
      // Unknown, malformed, and uppercase ids.
      [paths(A.id, randomUUID()).resend, A.owner, "booking_not_found"],
      [paths(A.id, "not-a-booking").resend, A.owner, "booking_not_found"],
      [paths(A.id, b.bookingId.toUpperCase()).resend, A.owner, "booking_not_found"],
    ];
    for (const email of ["on", "off"] as const) {
      for (const [path, who, code] of notFound) {
        const key = randomUUID();
        const res = await request("POST", path, { as: who, key, body: confirmation, email });
        expect([res.status, res.json.error?.code], `${email} ${who} ${path}`).toEqual([404, code]);
        expect(res.text).not.toContain("Synthetic Resend Guest");
      }
    }
    expect(await messageCount(b.bookingId)).toBe(1);
    expect(await messageCount(inB.bookingId)).toBe(1);
  });

  it("with email off: 401, 404, and 403 first, then booking_email_off with nothing written; an earlier success replays", async () => {
    const b = await booked(A, tripsA);
    const own = paths(A.id, b.bookingId);
    const doneKey = randomUUID();
    const done = await request("POST", own.resend, {
      as: A.owner,
      key: doneKey,
      body: confirmation,
    });
    expect(done.status).toBe(201);

    const anonymous = await request("POST", own.resend, {
      key: randomUUID(),
      body: confirmation,
      email: "off",
    });
    expect(anonymous.status).toBe(401);

    const key = randomUUID();
    const off = await request("POST", own.resend, {
      as: A.bookingStaff,
      key,
      body: confirmation,
      email: "off",
    });
    expect([off.status, off.json.error?.code]).toEqual([409, "booking_email_off"]);
    expect(await storedKeys(A.id, key)).toBe(0);
    expect(await messageCount(b.bookingId)).toBe(2);
    expect(await auditCount(b.bookingId)).toBe(1);

    // The key was never used: with email on, the same key gets a decision of
    // its own (too soon after the success above), stored, and replayed as the
    // same 409 even with email off.
    const decided = await request("POST", own.resend, {
      as: A.bookingStaff,
      key,
      body: confirmation,
    });
    expect([decided.status, decided.json.error?.code]).toEqual([409, "booking_email_too_soon"]);
    expect(decided.headers.get("idempotent-replayed")).toBeNull();
    const decidedOff = await request("POST", own.resend, {
      as: A.bookingStaff,
      key,
      body: confirmation,
      email: "off",
    });
    expect([decidedOff.status, decidedOff.json.error?.code]).toEqual([
      409,
      "booking_email_too_soon",
    ]);
    expect(decidedOff.headers.get("idempotent-replayed")).toBe("true");

    const replayOff = await request("POST", own.resend, {
      as: A.owner,
      key: doneKey,
      body: confirmation,
      email: "off",
    });
    expect(replayOff.status).toBe(201);
    expect(replayOff.headers.get("idempotent-replayed")).toBe("true");
    expect(replayOff.json).toEqual(done.json);

    const read = await request("GET", own.messages, { as: A.owner, email: "off" });
    expect(read.status).toBe(200);
    expect(read.json.emailDelivery).toBe("off");
    expect(read.json.resend).toEqual({
      kind: "confirmation",
      allowed: false,
      availableAt: null,
      remaining: 4,
      blockedBy: "email_off",
    });
  });

  it("validates the request before anything else: a key, a kind, a reason code, and no address", async () => {
    const b = await booked(A, tripsA);
    const own = paths(A.id, b.bookingId);
    const cases: { key?: string; body: unknown }[] = [
      { body: confirmation },
      { key: "short", body: confirmation },
      { key: randomUUID(), body: { kind: "manage_link", reason: "other" } },
      { key: randomUUID(), body: { kind: "confirmation", reason: "The guest said so" } },
      { key: randomUUID(), body: { kind: "confirmation" } },
      { key: randomUUID(), body: { ...confirmation, email: "someone.else@example.test" } },
    ];
    for (const c of cases) {
      const res = await request("POST", own.resend, {
        as: A.owner,
        body: c.body,
        ...(c.key ? { key: c.key } : {}),
      });
      expect([res.status, res.json.error?.code], JSON.stringify(c)).toEqual([
        400,
        "validation_failed",
      ]);
    }
    expect(await messageCount(b.bookingId)).toBe(1);
  });
});
