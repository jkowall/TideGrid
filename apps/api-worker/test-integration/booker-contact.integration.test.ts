/**
 * Correcting the booker's contact details through the API (W3-G2.11-rest):
 * the booker from the booking page and staff with bookings.reschedule. An
 * email change ends the old address's access and every other session.
 * Finance and other tenants are refused. Contract:
 * packages/contracts/src/booker-contact.ts.
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
const TEAM = "tidegrid-booker.cloudflareaccess.com";
const AUD = "fe".repeat(32);

interface Tenant extends CheckoutFixture {
  host: string;
  owner: string;
  bookingStaff: string;
  finance: string;
}

describe.skipIf(!env)("booker contact corrections through the API (W3-G2.11-rest)", () => {
  let admin: Sql;
  let runtime: ReturnType<typeof createDb>;
  let app: ReturnType<typeof createApp>;
  let signingKey: CryptoKey;
  let payments: FakePaymentProvider;
  let mail: FakeEmailProvider;
  let A: Tenant;
  let B: Tenant;
  let tripsA: ReturnType<typeof tripAllocator>;
  const kid = `kid-${randomUUID().slice(0, 8)}`;

  const bindings = () => ({
    ENVIRONMENT: "local" as const,
    BUILD_ID: "integration",
    DATABASE_URL: env?.runtimeUrl ?? "",
    ALLOWED_ORIGINS: CONSOLE,
    STAFF_ORIGINS: CONSOLE,
    PAYMENT_PROVIDER: "fake",
    FAKE_PAYMENT_WEBHOOK_SECRET: TEST_FAKE_SECRET,
    EMAIL_PROVIDER: "fake",
    GUEST_LINK_ORIGIN: "https://{slug}.book.example.test",
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
    method: "GET" | "POST" | "PUT",
    path: string,
    options: {
      as?: string;
      key?: string;
      body?: unknown;
      origin?: string;
      headers?: Record<string, string>;
    } = {},
  ) {
    const headers = new Headers(options.headers);
    headers.set("origin", options.origin ?? CONSOLE);
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
      bindings(),
      executionCtx,
    );
    const text = await res.text();
    return {
      status: res.status,
      headers: res.headers,
      json: (text ? JSON.parse(text) : {}) as Json,
    };
  }

  async function member(tenantId: string, email: string, role: string) {
    const userId = randomUUID();
    await admin`insert into public.staff_users (id, email, display_name)
      values (${userId}, ${email}, ${role})`;
    await admin`insert into public.tenant_memberships (tenant_id, user_id, role, display_name)
      values (${tenantId}, ${userId}, ${role}, ${role})`;
    return email;
  }

  async function tenant(fixture: CheckoutFixture, label: string): Promise<Tenant> {
    const tag = fixture.id.slice(0, 8);
    const host = `${fixture.slug}.book.example.test`;
    await admin`insert into public.tenant_hostnames (hostname, tenant_id, kind, status, verified_at)
      values (${host}, ${fixture.id}, 'preview', 'active', now())`;
    return {
      ...fixture,
      host,
      owner: await member(fixture.id, `${label}-owner-${tag}@example.test`, "owner"),
      bookingStaff: await member(fixture.id, `${label}-desk-${tag}@example.test`, "booking_staff"),
      finance: await member(fixture.id, `${label}-finance-${tag}@example.test`, "finance"),
    };
  }

  async function booked(t: Tenant = A, party = 3, trip = tripsA.shared()) {
    const made = await confirmBooking(runtime.db, payments, t, trip, party);
    const res = await request(
      "POST",
      `/v1/public/checkout-sessions/${made.checkoutSessionId}/manage-session`,
      { origin: `https://${t.host}`, headers: { authorization: `Bearer ${made.secret}` } },
    );
    if (res.status !== 201) throw new Error(`session: ${res.status} ${JSON.stringify(res.json)}`);
    return { ...made, tripId: trip, session: res.json.session.token as string };
  }

  const guest = (session: string, key?: string, t: Tenant = A) => ({
    origin: `https://${t.host}`,
    headers: { authorization: `Bearer ${session}`, ...(key ? { "idempotency-key": key } : {}) },
  });

  const deliver = (t: Tenant) =>
    deliverTenantMessages(runtime.db, t.id, {
      provider: mail,
      fromAddress: "bookings@tidegrid.test",
      guestLinkOrigin: "https://{slug}.book.example.test",
      environment: "local",
      runId: `run-${randomUUID()}`,
    });

  const staffPath = (t: Tenant, bookingId: string) =>
    `/v1/staff/tenants/${t.id}/bookings/${bookingId}/booker`;

  beforeAll(async () => {
    if (!env) return;
    admin = postgres(env.adminUrl, { max: 3, onnotice: () => {} });
    runtime = createDb(env.runtimeUrl, { max: 8 });
    payments = fakeProvider(runtime.db);
    mail = new FakeEmailProvider({ db: runtime.db, environment: "local" });
    const [a, b] = await Promise.all([
      createCheckoutFixture(admin, runtime.db, "bkcapi-a", { days: 6 }),
      createCheckoutFixture(admin, runtime.db, "bkcapi-b", { days: 4 }),
    ]);
    A = await tenant(a, "bkcapi-a");
    B = await tenant(b, "bkcapi-b");
    tripsA = tripAllocator(A);
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

  it("lets the booker correct their details, keeping this session and ending the others", async () => {
    const b = await booked(A, 2);
    const second = await request(
      "POST",
      `/v1/public/checkout-sessions/${b.checkoutSessionId}/manage-session`,
      { origin: `https://${A.host}`, headers: { authorization: `Bearer ${b.secret}` } },
    );
    expect(second.status).toBe(201);
    const other = second.json.session.token as string;

    const key = randomUUID();
    const input = { name: "Bea Booker", email: "bea.new@example.test" };
    const res = await request("PUT", "/v1/public/manage/booker", {
      ...guest(b.session, key),
      body: input,
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(res.json.booking.booker).toEqual(input);
    expect(res.json.change).toMatchObject({ nameChanged: true, emailChanged: true, by: "guest" });
    // A repeat with the same key answers the same and changes nothing more.
    const again = await request("PUT", "/v1/public/manage/booker", {
      ...guest(b.session, key),
      body: input,
    });
    expect(again.status).toBe(200);
    expect(again.headers.get("idempotent-replayed")).toBe("true");
    const [count] = await admin<{ n: number }[]>`
      select count(*)::int as n from public.booking_contact_changes where booking_id = ${b.bookingId}`;
    expect(count?.n).toBe(1);
    // Another body under the same key is refused.
    const reused = await request("PUT", "/v1/public/manage/booker", {
      ...guest(b.session, key),
      body: { ...input, name: "Someone Else" },
    });
    expect(reused.status).toBe(422);

    expect((await request("GET", "/v1/public/manage/booking", guest(b.session))).status).toBe(200);
    expect((await request("GET", "/v1/public/manage/booking", guest(other))).status).toBe(401);

    // The same details again: nothing changes.
    const same = await request("PUT", "/v1/public/manage/booker", {
      ...guest(b.session, randomUUID()),
      body: input,
    });
    expect(same.status).toBe(200);
    expect(same.json.change).toBeNull();

    // The old address is told, the new one gets a link.
    await deliver(A);
    const inbox = await mail.listMailbox(A.id);
    expect(
      inbox.some(
        (m) => m.to === "booker@example.test" && m.subject.includes("email address changed"),
      ),
    ).toBe(true);
    expect(
      inbox.some((m) => m.to === "bea.new@example.test" && m.subject.startsWith("Your link")),
    ).toBe(true);
  });

  it("refuses a malformed request, no session, and a fourth correction in a day", async () => {
    const b = await booked(A, 1);
    const bad = await request("PUT", "/v1/public/manage/booker", {
      ...guest(b.session, randomUUID()),
      body: { name: "A B", email: "not-an-address" },
    });
    expect(bad.status).toBe(400);
    const noKey = await request("PUT", "/v1/public/manage/booker", {
      ...guest(b.session),
      body: { name: "A B", email: "a@example.test" },
    });
    expect(noKey.status).toBe(400);
    const noSession = await request("PUT", "/v1/public/manage/booker", {
      origin: `https://${A.host}`,
      key: randomUUID(),
      body: { name: "A B", email: "a@example.test" },
    });
    expect(noSession.status).toBe(401);

    for (let i = 1; i <= 3; i += 1) {
      const ok = await request("PUT", "/v1/public/manage/booker", {
        ...guest(b.session, randomUUID()),
        body: { name: `Name ${i}`, email: "booker@example.test" },
      });
      expect(ok.status).toBe(200);
    }
    const limited = await request("PUT", "/v1/public/manage/booker", {
      ...guest(b.session, randomUUID()),
      body: { name: "Name 4", email: "booker@example.test" },
    });
    expect(limited.status).toBe(429);
    expect(limited.json.error.code).toBe("contact_change_limit_reached");
  });

  it("lets owners and booking staff correct it, and refuses finance and another tenant", async () => {
    const b = await booked(A, 1);
    const body = { name: "Desk Fixed", email: "desk.fixed@example.test" };
    const finance = await request("PUT", staffPath(A, b.bookingId), {
      as: A.finance,
      key: randomUUID(),
      body,
    });
    expect(finance.status).toBe(403);
    const elsewhere = await request("PUT", staffPath(B, b.bookingId), {
      as: B.owner,
      key: randomUUID(),
      body,
    });
    expect(elsewhere.status).toBe(404);
    expect(elsewhere.json.error.code).toBe("booking_not_found");
    const crossTenant = await request("PUT", staffPath(A, b.bookingId), {
      as: B.owner,
      key: randomUUID(),
      body,
    });
    // Not a member of A: the same answer as no such tenant.
    expect(crossTenant.status).toBe(404);

    const done = await request("PUT", staffPath(A, b.bookingId), {
      as: A.bookingStaff,
      key: randomUUID(),
      body,
    });
    expect(done.status).toBe(200);
    expect(done.headers.get("cache-control")).toBe("no-store");
    expect(done.json.change).toMatchObject({ by: "staff", nameChanged: true, emailChanged: true });
    // Staff end every guest session on the booking.
    expect((await request("GET", "/v1/public/manage/booking", guest(b.session))).status).toBe(401);
    const [row] = await admin<{ booker_name: string; booker_email: string }[]>`
      select booker_name, booker_email from public.checkout_sessions where id = ${b.checkoutSessionId}`;
    expect(row).toEqual({ booker_name: body.name, booker_email: body.email });
  });

  it("refuses a canceled booking", async () => {
    const b = await booked(A, 1);
    const terms = await request("GET", "/v1/public/manage/cancellation", guest(b.session));
    expect(terms.status).toBe(200);
    const canceled = await request("POST", "/v1/public/manage/cancellation", {
      ...guest(b.session, randomUUID()),
      body: { expectedRefundAmount: terms.json.terms.refundAmount },
    });
    expect(canceled.status).toBe(200);
    const res = await request("PUT", staffPath(A, b.bookingId), {
      as: A.owner,
      key: randomUUID(),
      body: { name: "Late Fix", email: "late@example.test" },
    });
    expect(res.status).toBe(409);
    expect(res.json.error.code).toBe("booking_canceled");
  });
});
