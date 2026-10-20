/**
 * Adversarial suite for the staff reads lane 1 adds (G2.11c and the G2.16
 * email shim): GET /v1/staff/tenants/{tenantId}/bookings/{bookingId}/participants
 * and .../messages. Owners and booking staff read them; finance, which does
 * not hold bookings.read, is refused; another tenant's staff, unknown ids,
 * and malformed ids answer 404; every answer is Cache-Control: no-store.
 * Messages carry their delivery status only, never a recipient or content.
 * Contracts: packages/contracts/src/participants.ts and self-service.ts.
 */
import { randomUUID } from "node:crypto";
import { createDb, inTenantTransaction, type TenantContext } from "@tidegrid/database";
import type {} from "@tidegrid/database/global-setup";
import { putParticipant } from "@tidegrid/domain-booking";
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
const TEAM = "tidegrid-selfservice-staff.cloudflareaccess.com";
const AUD = "ef".repeat(32);
const LINK_ORIGIN = "https://{slug}.book.example.test";

interface Staffed extends CheckoutFixture {
  host: string;
  owner: string;
  bookingStaff: string;
  finance: string;
}

const STATUS_KEYS = [
  "attempts",
  "canceledAt",
  "createdAt",
  "failedAt",
  "failureCode",
  "id",
  "lastAttemptAt",
  "nextAttemptAt",
  "provider",
  "sentAt",
  "state",
  "template",
  "templateVersion",
];

describe.skipIf(!env)("adversarial: staff reads of participants and email delivery", () => {
  let admin: Sql;
  let runtime: ReturnType<typeof createDb>;
  let app: ReturnType<typeof createApp>;
  let signingKey: CryptoKey;
  let payments: FakePaymentProvider;
  let mail: FakeEmailProvider;
  let A: Staffed;
  let B: Staffed;
  let twoHats: string;
  let tripsA: ReturnType<typeof tripAllocator>;
  let tripsB: ReturnType<typeof tripAllocator>;
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
    GUEST_LINK_ORIGIN: LINK_ORIGIN,
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

  async function get(path: string, as?: string) {
    const headers = new Headers();
    if (as) headers.set("cf-access-jwt-assertion", await token(as));
    const res = await app.request(
      `http://localhost${path}`,
      { method: "GET", headers },
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
      host,
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
      runId: `run-${randomUUID()}`,
    });

  const paths = (tenantId: string, bookingId: string) => ({
    participants: `/v1/staff/tenants/${tenantId}/bookings/${bookingId}/participants`,
    messages: `/v1/staff/tenants/${tenantId}/bookings/${bookingId}/messages`,
  });

  beforeAll(async () => {
    if (!env) return;
    admin = postgres(env.adminUrl, { max: 3, onnotice: () => {} });
    runtime = createDb(env.runtimeUrl, { max: 8 });
    payments = fakeProvider(runtime.db);
    mail = new FakeEmailProvider({ db: runtime.db, environment: "local" });
    const [a, b] = await Promise.all([
      createCheckoutFixture(admin, runtime.db, "ssst-a", { days: 8 }),
      createCheckoutFixture(admin, runtime.db, "ssst-b", { days: 4 }),
    ]);
    A = await staffed(a, "ssst-a");
    B = await staffed(b, "ssst-b");
    tripsA = tripAllocator(A);
    tripsB = tripAllocator(B);
    twoHats = `ssst-two-hats-${A.id.slice(0, 8)}@example.test`;
    await member(A.id, twoHats, "finance");
    await member(B.id, twoHats, "owner");
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

  it("lets owners and booking staff read a booking's party and mail, refuses finance, and hides other tenants", async () => {
    const booker = { name: "Synthetic Staffread", email: "synthetic.staffread@example.test" };
    const inA = await confirmBooking(runtime.db, payments, A, tripsA.shared(), 2, { booker });
    const inB = await confirmBooking(runtime.db, payments, B, tripsB.shared(), 1, {
      booker: { name: "Synthetic Other", email: "synthetic.other@example.test" },
    });
    const ctx: TenantContext = {
      tenantId: A.id,
      actorType: "guest",
      actorId: null,
      requestId: "adv",
    };
    await inTenantTransaction(runtime.db, ctx, (trx) =>
      putParticipant(trx, ctx, {
        bookingId: inA.bookingId,
        position: 2,
        details: {
          name: "Synthetic Junior",
          isMinor: true,
          guardian: { name: "Synthetic Guardian", email: "synthetic.guardian@example.test" },
        },
      }),
    );
    await deliver(A);
    const own = paths(A.id, inA.bookingId);

    for (const who of [A.owner, A.bookingStaff]) {
      const party = await get(own.participants, who);
      expect(party.status, who).toBe(200);
      expect(party.headers.get("cache-control")).toBe("no-store");
      expect(party.json.party).toMatchObject({
        partySize: 2,
        participants: [
          {
            position: 2,
            name: "Synthetic Junior",
            isMinor: true,
            email: null,
            guardian: { name: "Synthetic Guardian", email: "synthetic.guardian@example.test" },
          },
        ],
      });
      const mailbox = await get(own.messages, who);
      expect(mailbox.status, who).toBe(200);
      expect(mailbox.headers.get("cache-control")).toBe("no-store");
      expect(mailbox.json.messages).toHaveLength(1);
      for (const m of mailbox.json.messages as Json[]) {
        expect(Object.keys(m).sort()).toEqual(STATUS_KEYS);
      }
      expect(mailbox.json.messages[0]).toMatchObject({
        template: "booking_confirmation",
        state: "sent",
        attempts: 1,
        failureCode: null,
        provider: "fake",
      });
      // No recipient, no subject, no body, no link.
      for (const secret of [booker.email, booker.name, inA.reference, "#t=", "Synthetic Junior"]) {
        expect(mailbox.text).not.toContain(secret);
      }
    }

    const refusals: [string, string, number, string][] = [
      [own.participants, A.finance, 403, "forbidden"],
      [own.messages, A.finance, 403, "forbidden"],
      [own.participants, twoHats, 403, "forbidden"],
      [own.messages, twoHats, 403, "forbidden"],
      // Another tenant's staff, at the tenant they do not belong to.
      [own.participants, B.owner, 404, "tenant_not_found"],
      [own.messages, B.owner, 404, "tenant_not_found"],
      // Another tenant's staff, naming this booking under their own tenant.
      [paths(B.id, inA.bookingId).participants, B.owner, 404, "booking_not_found"],
      [paths(B.id, inA.bookingId).messages, B.owner, 404, "booking_not_found"],
      [paths(B.id, inA.bookingId).participants, twoHats, 404, "booking_not_found"],
      [paths(B.id, inA.bookingId).messages, twoHats, 404, "booking_not_found"],
      // And the other way round.
      [paths(A.id, inB.bookingId).participants, A.owner, 404, "booking_not_found"],
      [paths(A.id, inB.bookingId).messages, A.bookingStaff, 404, "booking_not_found"],
      // Unknown, malformed, and uppercase ids.
      [paths(A.id, randomUUID()).participants, A.owner, 404, "booking_not_found"],
      [paths(A.id, randomUUID()).messages, A.owner, 404, "booking_not_found"],
      [paths(A.id, "not-a-booking").participants, A.owner, 404, "booking_not_found"],
      [paths(A.id, "not-a-booking").messages, A.owner, 404, "booking_not_found"],
      [paths(A.id, inA.bookingId.toUpperCase()).participants, A.owner, 404, "booking_not_found"],
      [paths(A.id, inA.bookingId.toUpperCase()).messages, A.owner, 404, "booking_not_found"],
      [paths("not-a-tenant", inA.bookingId).participants, A.owner, 404, "tenant_not_found"],
    ];
    for (const [path, who, status, code] of refusals) {
      const res = await get(path, who);
      expect([res.status, res.json.error?.code], `${who} ${path}`).toEqual([status, code]);
      expect(res.headers.get("cache-control"), `${who} ${path}`).toBe("no-store");
      expect(res.text).not.toContain("Synthetic Junior");
      expect(res.text).not.toContain(booker.email);
    }
    for (const path of [own.participants, own.messages]) {
      const anonymous = await get(path);
      expect(anonymous.status).toBe(401);
      expect(anonymous.text).not.toContain("Synthetic Junior");
    }
  });

  it("shows each message's delivery as it happens: a retry after a temporary failure, and a refusal", async () => {
    const flaky = await confirmBooking(runtime.db, payments, A, tripsA.shared(), 1, {
      booker: { name: "Synthetic Flaky", email: "synthetic.flaky+fail-once@example.test" },
    });
    const gone = await confirmBooking(runtime.db, payments, A, tripsA.shared(), 1, {
      booker: { name: "Synthetic Gone", email: "synthetic.gone+bounce@example.test" },
    });
    await deliver(A);
    const flakyRead = async () => (await get(paths(A.id, flaky.bookingId).messages, A.owner)).json;
    const waiting = (await flakyRead()).messages[0];
    expect(waiting).toMatchObject({
      template: "booking_confirmation",
      state: "queued",
      attempts: 1,
      failureCode: "provider_unavailable",
      sentAt: null,
    });
    expect(waiting.nextAttemptAt).not.toBeNull();
    expect(Date.parse(waiting.nextAttemptAt)).toBeGreaterThan(Date.parse(waiting.lastAttemptAt));

    const refused = (await get(paths(A.id, gone.bookingId).messages, A.bookingStaff)).json
      .messages[0];
    expect(refused).toMatchObject({
      state: "failed",
      attempts: 1,
      failureCode: "bounced",
      nextAttemptAt: null,
    });
    expect(refused.failedAt).not.toBeNull();

    await admin`update public.email_messages set next_attempt_at = now() - interval '1 second'
                 where booking_id = ${flaky.bookingId} and state = 'queued'`;
    await deliver(A);
    const sent = (await flakyRead()).messages[0];
    expect(sent).toMatchObject({ state: "sent", attempts: 2, nextAttemptAt: null });
    expect(sent.sentAt).not.toBeNull();
    // The contract names failureCode "the last attempt's error"; the last attempt was accepted.
    expect(sent.failureCode, "a sent message still reports an earlier attempt's error").toBeNull();
  });
});
