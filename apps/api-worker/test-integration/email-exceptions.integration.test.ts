/**
 * The tenant-wide email exceptions list (W1-EMAIL-EXC) through the real app
 * over a throwaway PostgreSQL: GET /v1/staff/tenants/{tenantId}/email-exceptions.
 *
 * What these prove:
 * - Owners and booking staff read one paged list of the operator's failed,
 *   outcome_unknown, and delivery_failed messages, with the kind (a waiver
 *   request is labeled waiver), the booking's id and reference, the state,
 *   the attempts, and the last error's class; sent and queued email is not
 *   listed; no answer carries an address, a name, or content.
 * - A staff resend that was sent marks the earlier failure laterSent.
 * - Finance is refused with 403 forbidden, before the cursor is read.
 * - Two tenants: a member of A asking under B's id gets 404
 *   tenant_not_found; B's message id as A's cursor is 400 cursor_invalid;
 *   neither list holds the other's messages.
 * - Paging walks the list once; limits outside 1 to 100 are 400.
 * The read's row-level security is in
 * packages/domain-messaging/src/exceptions.integration.test.ts.
 */
import { randomUUID } from "node:crypto";
import { createDb, inTenantTransaction } from "@tidegrid/database";
import type {} from "@tidegrid/database/global-setup";
import {
  type CheckoutFixture,
  confirmBooking,
  createCheckoutFixture,
  fakeProvider,
  TEST_FAKE_SECRET,
} from "@tidegrid/domain-booking/testing";
import { tripAllocator } from "@tidegrid/domain-inventory/testing";
import {
  deliverTenantMessages,
  type EmailProvider,
  EmailProviderRejectedError,
  EmailProviderUnavailableError,
  enqueueMessage,
} from "@tidegrid/domain-messaging";
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
const TEAM = "tidegrid-email-exceptions.cloudflareaccess.com";
const AUD = "cd".repeat(32);
const LINK_ORIGIN = "https://{slug}.book.example.test";
const BOOKER = "Synthetic Exceptions Guest";

interface Staffed extends CheckoutFixture {
  owner: string;
  bookingStaff: string;
  finance: string;
}

type Plan = "bounced" | "delivery_failed" | "unknown";

describe.skipIf(!env)("the email exceptions list: the API (W1-EMAIL-EXC)", () => {
  let admin: Sql;
  let runtime: ReturnType<typeof createDb>;
  let app: ReturnType<typeof createApp>;
  let signingKey: CryptoKey;
  let payments: FakePaymentProvider;
  let A: Staffed;
  let B: Staffed;
  let tripsA: ReturnType<typeof tripAllocator>;
  let tripsB: ReturnType<typeof tripAllocator>;
  const kid = `kid-${randomUUID().slice(0, 8)}`;

  /** What the scripted provider does with each message id; any other is accepted. */
  const plans = new Map<string, Plan>();
  const scripted: EmailProvider = {
    name: "cloudflare",
    deduplicates: false,
    async send(email) {
      const plan = plans.get(email.idempotencyKey);
      if (plan === "bounced") throw new EmailProviderRejectedError("bounced");
      if (plan === "delivery_failed") throw new EmailProviderRejectedError("delivery_failed");
      if (plan === "unknown") throw new EmailProviderUnavailableError();
      return { providerMessageId: `test-${email.idempotencyKey}` };
    },
  };

  const bindings = () => ({
    ENVIRONMENT: "local" as const,
    BUILD_ID: "integration",
    DATABASE_URL: env?.runtimeUrl ?? "",
    ALLOWED_ORIGINS: CONSOLE,
    STAFF_ORIGINS: CONSOLE,
    PAYMENT_PROVIDER: "fake",
    FAKE_PAYMENT_WEBHOOK_SECRET: TEST_FAKE_SECRET,
    GUEST_LINK_ORIGIN: LINK_ORIGIN,
    EMAIL_PROVIDER: "fake",
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
    options: { as?: string; key?: string; body?: unknown } = {},
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
      bindings(),
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

  const listPath = (tenantId: string, query = "") =>
    `/v1/staff/tenants/${tenantId}/email-exceptions${query}`;

  async function member(tenantId: string, email: string, role: string) {
    const userId = randomUUID();
    await admin`insert into public.staff_users (id, email, display_name)
      values (${userId}, ${email}, ${role})`;
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
      provider: scripted,
      fromAddress: "bookings@tidegrid.test",
      guestLinkOrigin: LINK_ORIGIN,
      environment: "local",
      runId: `run-${randomUUID()}`,
    });

  /** The booking's queued messages, oldest first, without the trip reminder waiting for its day. */
  async function queued(bookingId: string): Promise<string[]> {
    const rows = await admin<{ id: string }[]>`
      select id from public.email_messages
       where booking_id = ${bookingId} and state = 'queued' and template <> 'booking_reminder'
       order by created_at, id`;
    return rows.map((r) => r.id);
  }

  /** A confirmed booking whose confirmation delivery ends as planned (or is sent). */
  async function booked(
    t: Staffed,
    trips: ReturnType<typeof tripAllocator>,
    plan: Plan | null,
  ): Promise<{ bookingId: string; reference: string; messageId: string }> {
    const made = await confirmBooking(runtime.db, payments, t, trips.shared(), 1, {
      booker: { name: BOOKER, email: `synthetic.exc.${randomUUID().slice(0, 8)}@example.test` },
    });
    const [messageId] = await queued(made.bookingId);
    if (!messageId) throw new Error("the booking queued no confirmation");
    if (plan) plans.set(messageId, plan);
    await deliver(t);
    return { bookingId: made.bookingId, reference: made.reference, messageId };
  }

  /** A waiver request about a booking, failed as bounced: the list labels it waiver. */
  async function waiverEmail(t: Staffed, bookingId: string): Promise<string> {
    const ctx = {
      tenantId: t.id,
      actorType: "system" as const,
      actorId: "exceptions-test",
      requestId: `req-${randomUUID()}`,
    };
    const result = await inTenantTransaction(runtime.db, ctx, (trx) =>
      enqueueMessage(trx, ctx, {
        dedupeKey: `test.waiver:${randomUUID()}`,
        template: "waiver_request",
        templateVersion: 1,
        bookingId,
        to: { email: `synthetic.waiver.${randomUUID().slice(0, 8)}@example.test`, name: BOOKER },
        content: {
          subject: "Sign your waiver",
          blocks: [{ kind: "paragraph", text: "A synthetic waiver request." }],
        },
      }),
    );
    plans.set(result.messageId, "bounced");
    await deliver(t);
    return result.messageId;
  }

  async function failedIds(tenantId: string): Promise<string[]> {
    const rows = await admin<{ id: string }[]>`
      select id from public.email_messages
       where tenant_id = ${tenantId} and state = 'failed'
       order by failed_at desc, id desc`;
    return rows.map((r) => r.id);
  }

  let bounced: Awaited<ReturnType<typeof booked>>;
  let undeliverable: Awaited<ReturnType<typeof booked>>;
  let unknown: Awaited<ReturnType<typeof booked>>;
  let sent: Awaited<ReturnType<typeof booked>>;
  let waiver: string;
  let inB: Awaited<ReturnType<typeof booked>>;

  beforeAll(async () => {
    if (!env) return;
    admin = postgres(env.adminUrl, { max: 3, onnotice: () => {} });
    runtime = createDb(env.runtimeUrl, { max: 8 });
    payments = fakeProvider(runtime.db);
    const [a, b] = await Promise.all([
      createCheckoutFixture(admin, runtime.db, "excapi-a", { days: 12 }),
      createCheckoutFixture(admin, runtime.db, "excapi-b", { days: 4 }),
    ]);
    A = await staffed(a, "excapi-a");
    B = await staffed(b, "excapi-b");
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
    bounced = await booked(A, tripsA, "bounced");
    undeliverable = await booked(A, tripsA, "delivery_failed");
    unknown = await booked(A, tripsA, "unknown");
    sent = await booked(A, tripsA, null);
    waiver = await waiverEmail(A, sent.bookingId);
    inB = await booked(B, tripsB, "bounced");
  });

  afterAll(async () => {
    await runtime?.end();
    await admin?.end({ timeout: 5 });
  });

  it("gives owners and booking staff one list of the failed email, with kind, reference, state, attempts, and error class", async () => {
    for (const who of [A.owner, A.bookingStaff]) {
      const res = await request("GET", listPath(A.id), { as: who });
      expect(res.status, who).toBe(200);
      expect(res.headers.get("cache-control")).toBe("no-store");
      expect(Object.keys(res.json).sort()).toEqual(["exceptions", "nextBefore"]);
      expect(res.json.nextBefore).toBeNull();
      const list = res.json.exceptions as Json[];
      expect(list.map((e) => e.id)).toEqual(await failedIds(A.id));
      const byId = new Map(list.map((e) => [e.id, e]));
      const timeZone = expect.any(String);
      expect(byId.get(bounced.messageId)).toEqual({
        id: bounced.messageId,
        template: "booking_confirmation",
        kind: "booking",
        state: "failed",
        attempts: 1,
        failureCode: "bounced",
        failedAt: expect.any(String),
        staffResend: false,
        laterSent: false,
        booking: { id: bounced.bookingId, reference: bounced.reference, timeZone },
      });
      expect(byId.get(undeliverable.messageId)).toMatchObject({
        kind: "booking",
        state: "delivery_failed",
        failureCode: "delivery_failed",
        booking: { id: undeliverable.bookingId, reference: undeliverable.reference },
      });
      expect(byId.get(unknown.messageId)).toMatchObject({
        state: "outcome_unknown",
        failureCode: "outcome_unknown",
        attempts: 1,
        booking: { id: unknown.bookingId, reference: unknown.reference },
      });
      expect(byId.get(waiver)).toMatchObject({
        template: "waiver_request",
        kind: "waiver",
        state: "failed",
        booking: { id: sent.bookingId, reference: sent.reference },
      });
      // Sent email, and the other tenant's, are not listed.
      expect(byId.has(sent.messageId)).toBe(false);
      expect(byId.has(inB.messageId)).toBe(false);
      // No address, name, subject, or body.
      for (const secret of ["@", BOOKER, "Sign your waiver", "synthetic waiver"]) {
        expect(res.text).not.toContain(secret);
      }
    }
  });

  it("marks a failure laterSent once a staff resend of the same email was sent", async () => {
    const failed = await booked(A, tripsA, "bounced");
    const resend = `/v1/staff/tenants/${A.id}/bookings/${failed.bookingId}/emails/resend`;
    const posted = await request("POST", resend, {
      as: A.bookingStaff,
      key: randomUUID(),
      body: { kind: "confirmation", reason: "delivery_failed" },
    });
    expect(posted.status).toBe(201);
    const before = await request("GET", listPath(A.id), { as: A.owner });
    const row = () => (before.json.exceptions as Json[]).find((e) => e.id === failed.messageId);
    expect(row()?.laterSent).toBe(false);
    await deliver(A);
    const after = await request("GET", listPath(A.id), { as: A.owner });
    const again = (after.json.exceptions as Json[]).find((e) => e.id === failed.messageId);
    expect(again?.laterSent).toBe(true);
    // The resend itself was sent, so it is not an exception.
    expect((after.json.exceptions as Json[]).some((e) => e.id === posted.json.message.id)).toBe(
      false,
    );
  });

  it("refuses finance with 403 before the cursor, and the unsigned with 401", async () => {
    for (const query of ["", "?limit=1", `?before=${randomUUID()}`, "?before=not-a-cursor"]) {
      const res = await request("GET", listPath(A.id, query), { as: A.finance });
      // A malformed cursor fails the contract before any role is read.
      const expected = query === "?before=not-a-cursor" ? 400 : 403;
      expect(res.status, query).toBe(expected);
      // A refusal is never cached either.
      expect(res.headers.get("cache-control"), query).toBe("no-store");
      if (expected === 403) expect(res.json.error?.code).toBe("forbidden");
      expect(res.text).not.toContain(bounced.reference);
    }
    const unsigned = await request("GET", listPath(A.id));
    expect([unsigned.status, unsigned.json.error?.code]).toEqual([401, "unauthenticated"]);
    expect(unsigned.headers.get("cache-control")).toBe("no-store");
  });

  it("keeps two tenants apart: another tenant's id is 404, and its message id as a cursor is 400", async () => {
    const across = await request("GET", listPath(B.id), { as: A.owner });
    expect([across.status, across.json.error?.code]).toEqual([404, "tenant_not_found"]);
    expect(across.text).not.toContain(inB.reference);

    const cursor = await request("GET", listPath(A.id, `?before=${inB.messageId}`), {
      as: A.owner,
    });
    expect([cursor.status, cursor.json.error?.code]).toEqual([400, "cursor_invalid"]);
    expect(across.headers.get("cache-control")).toBe("no-store");
    expect(cursor.headers.get("cache-control")).toBe("no-store");

    const ownB = await request("GET", listPath(B.id), { as: B.bookingStaff });
    expect(ownB.status).toBe(200);
    expect((ownB.json.exceptions as Json[]).map((e) => e.id)).toEqual([inB.messageId]);
    expect(ownB.text).not.toContain(bounced.reference);

    const sentCursor = await request("GET", listPath(A.id, `?before=${sent.messageId}`), {
      as: A.owner,
    });
    expect([sentCursor.status, sentCursor.json.error?.code]).toEqual([400, "cursor_invalid"]);
  });

  it("walks the list one page at a time, once, and refuses limits outside 1 to 100", async () => {
    const seen: string[] = [];
    let query = "?limit=2";
    for (let i = 0; i < 20; i++) {
      const res = await request("GET", listPath(A.id, query), { as: A.bookingStaff });
      expect(res.status).toBe(200);
      const page = res.json.exceptions as Json[];
      expect(page.length).toBeLessThanOrEqual(2);
      seen.push(...page.map((e) => e.id));
      if (res.json.nextBefore === null) break;
      query = `?limit=2&before=${res.json.nextBefore}`;
    }
    expect(seen).toEqual(await failedIds(A.id));

    for (const limit of ["0", "101", "x"]) {
      const res = await request("GET", listPath(A.id, `?limit=${limit}`), { as: A.owner });
      expect([res.status, res.json.error?.code], limit).toEqual([400, "validation_failed"]);
    }
  });
});
