/**
 * Participant invitations through the API (W3-G2.11-rest): the booker from
 * the booking page and staff with messages.resend invite one named
 * participant; the participant's link opens a session that reads and
 * corrects only their own details. Finance and other tenants are refused.
 * Contract: packages/contracts/src/invitations.ts.
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
const TEAM = "tidegrid-invitations.cloudflareaccess.com";
const AUD = "fe".repeat(32);

interface Tenant extends CheckoutFixture {
  host: string;
  owner: string;
  bookingStaff: string;
  finance: string;
}

describe.skipIf(!env)("participant invitations through the API (W3-G2.11-rest)", () => {
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

  /** The link token of the newest invitation the fake mailbox holds for an address. */
  async function tokenFor(t: Tenant, to: string): Promise<string> {
    const inbox = await mail.listMailbox(t.id);
    const sent = inbox.find((m) => m.to === to && m.subject.startsWith("Your place on"));
    if (!sent) throw new Error(`no invitation to ${to}`);
    const message = await mail.getMailboxMessage(t.id, sent.id);
    const found = /https:\/\/[^/]+\/participant#t=([A-Za-z0-9_-]{43})/.exec(message?.html ?? "");
    if (!found?.[1]) throw new Error("no participant link");
    expect(found[0].startsWith(`https://${t.host}/participant#t=`)).toBe(true);
    return found[1];
  }

  const participantPaths = (t: Tenant, bookingId: string, position: number) =>
    `/v1/staff/tenants/${t.id}/bookings/${bookingId}/participants/${position}/invitation`;

  beforeAll(async () => {
    if (!env) return;
    admin = postgres(env.adminUrl, { max: 3, onnotice: () => {} });
    runtime = createDb(env.runtimeUrl, { max: 8 });
    payments = fakeProvider(runtime.db);
    mail = new FakeEmailProvider({ db: runtime.db, environment: "local" });
    const [a, b] = await Promise.all([
      createCheckoutFixture(admin, runtime.db, "invapi-a", { days: 6 }),
      createCheckoutFixture(admin, runtime.db, "invapi-b", { days: 4 }),
    ]);
    A = await tenant(a, "invapi-a");
    B = await tenant(b, "invapi-b");
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

  it("lets the booker invite a participant whose link reads and corrects only their own details", async () => {
    const b = await booked();
    for (const [place, body] of [
      [1, { name: "Bo Booker", isMinor: false, email: "bo@example.test" }],
      [2, { name: "Ivy Invited", isMinor: false, email: "ivy@example.test" }],
      [3, { name: "Zed Other", isMinor: false, email: "zed@example.test" }],
    ] as const) {
      const named = await request("PUT", `/v1/public/manage/participants/${place}`, {
        ...guest(b.session, randomUUID()),
        body,
      });
      expect(named.status).toBe(200);
    }

    const path = "/v1/public/manage/participants/2/invitation";
    const key = randomUUID();
    const sent = await request("POST", path, guest(b.session, key));
    expect(sent.status).toBe(202);
    expect(sent.json).toEqual({ status: "accepted", recipient: "participant" });
    expect(sent.headers.get("cache-control")).toBe("no-store");
    const again = await request("POST", path, guest(b.session, key));
    expect(again.status).toBe(202);
    expect(again.headers.get("idempotent-replayed")).toBe("true");
    const [count] = await admin<{ n: number }[]>`
      select count(*)::int as n from public.email_messages
       where booking_id = ${b.bookingId} and link_purpose = 'participant_profile'`;
    expect(count?.n).toBe(1);

    await deliver(A);
    const link = await tokenFor(A, "ivy@example.test");
    // Another operator's site does not know the link.
    const elsewhere = await request("POST", "/v1/public/participant-access", {
      origin: `https://${B.host}`,
      body: { token: link },
    });
    expect(elsewhere.status).toBe(404);
    expect(elsewhere.json.error.code).toBe("link_not_found");
    // Nor does the booking page's own redemption.
    const asManage = await request("POST", "/v1/public/booking-access", {
      origin: `https://${A.host}`,
      body: { token: link },
    });
    expect(asManage.status).toBe(404);

    const opened = await request("POST", "/v1/public/participant-access", {
      origin: `https://${A.host}`,
      body: { token: link },
    });
    expect(opened.status).toBe(201);
    const session = opened.json.session.token as string;
    const reused = await request("POST", "/v1/public/participant-access", {
      origin: `https://${A.host}`,
      body: { token: link },
    });
    expect(reused.status).toBe(410);
    expect(reused.json.error.code).toBe("link_used");

    const read = await request("GET", "/v1/public/participant/profile", guest(session));
    expect(read.status).toBe(200);
    expect(read.json.profile).toMatchObject({
      participant: { position: 2, name: "Ivy Invited", email: "ivy@example.test" },
      bookingState: "confirmed",
      editable: true,
    });
    const text = JSON.stringify(read.json);
    for (const other of ["Zed Other", "zed@example.test", "bo@example.test", b.reference]) {
      expect(text).not.toContain(other);
    }
    // The participant's session opens nothing else, and another site rejects it.
    expect((await request("GET", "/v1/public/manage/booking", guest(session))).status).toBe(401);
    expect(
      (await request("GET", "/v1/public/participant/profile", guest(session, undefined, B))).status,
    ).toBe(401);
    // Nor can the booking session read a participant's view.
    expect((await request("GET", "/v1/public/participant/profile", guest(b.session))).status).toBe(
      401,
    );

    const fixed = await request("PUT", "/v1/public/participant/profile", {
      ...guest(session, randomUUID()),
      body: { name: "Ivy Invitee", email: "ivy@example.test", isMinor: true },
    });
    expect(fixed.status).toBe(200);
    expect(fixed.json).toMatchObject({
      changed: true,
      profile: { participant: { name: "Ivy Invitee", isMinor: false } },
    });
    // A new address of their own: this session stays, and the waiver hooks run.
    const moved = await request("PUT", "/v1/public/participant/profile", {
      ...guest(session, randomUUID()),
      body: { name: "Ivy Invitee", email: "ivy.new@example.test" },
    });
    expect(moved.status).toBe(200);
    expect(moved.json.profile.participant.email).toBe("ivy.new@example.test");
    const [after] = await admin<{ email: string }[]>`
      select email from public.booking_participants
       where booking_id = ${b.bookingId} and position = 2`;
    expect(after?.email).toBe("ivy.new@example.test");
    expect((await request("GET", "/v1/public/participant/profile", guest(session))).status).toBe(
      200,
    );
    // An adult names no guardian.
    const wrong = await request("PUT", "/v1/public/participant/profile", {
      ...guest(session, randomUUID()),
      body: { name: "Ivy Invitee", guardian: { name: "G", email: "g@example.test" } },
    });
    expect(wrong.status).toBe(422);
    expect(wrong.json.error.code).toBe("guardian_mismatch");

    const ended = await request("POST", "/v1/public/participant/session/end", guest(session));
    expect(ended.status).toBe(200);
    expect((await request("GET", "/v1/public/participant/profile", guest(session))).status).toBe(
      401,
    );
  });

  it("lets owners and booking staff invite, refuses finance and other tenants, and holds the limits", async () => {
    const b = await booked();
    await request("PUT", "/v1/public/manage/participants/1", {
      ...guest(b.session, randomUUID()),
      body: { name: "Nan NoMail", isMinor: false },
    });
    await request("PUT", "/v1/public/manage/participants/2", {
      ...guest(b.session, randomUUID()),
      body: {
        name: "Kip Kid",
        isMinor: true,
        guardian: { name: "Gus Guardian", email: "gus@example.test" },
      },
    });
    const at = (position: number) => participantPaths(A, b.bookingId, position);

    const byStaff = await request("POST", at(2), { as: A.bookingStaff, key: randomUUID() });
    expect(byStaff.status).toBe(202);
    expect(byStaff.json).toEqual({ status: "accepted", recipient: "guardian" });
    const [msg] = await admin<{ to_email: string; actor_type: string }[]>`
      select m.to_email, a.actor_type from public.email_messages m
        join public.audit_events a on a.tenant_id = m.tenant_id and a.action = 'participant.invited'
             and a.subject_id = m.participant_id::text
       where m.booking_id = ${b.bookingId} and m.link_purpose = 'participant_profile'`;
    expect(msg).toEqual({ to_email: "gus@example.test", actor_type: "staff" });

    expect((await request("POST", at(2), { as: A.finance, key: randomUUID() })).status).toBe(403);
    const otherTenant = await request("POST", participantPaths(B, b.bookingId, 2), {
      as: B.owner,
      key: randomUUID(),
    });
    expect(otherTenant.status).toBe(404);
    const noMail = await request("POST", at(1), { as: A.owner, key: randomUUID() });
    expect(noMail.status).toBe(409);
    expect(noMail.json.error.code).toBe("participant_no_email");
    const empty = await request("POST", at(3), { as: A.owner, key: randomUUID() });
    expect(empty.status).toBe(409);
    expect(empty.json.error.code).toBe("participant_not_named");
    const outside = await request("POST", at(9), { as: A.owner, key: randomUUID() });
    expect(outside.status).toBe(422);
    expect(outside.json.error.code).toBe("position_out_of_range");

    // The guest's and staff's invitations count together: three a person a day.
    for (const expected of [202, 202, 429]) {
      const res = await request(
        "POST",
        "/v1/public/manage/participants/2/invitation",
        guest(b.session, randomUUID()),
      );
      expect(res.status).toBe(expected);
      if (expected === 429) expect(res.json.error.code).toBe("invitation_limit_reached");
    }
  });

  it("ends an invitation's link when the booking is canceled", async () => {
    const b = await booked(A, 2);
    await request("PUT", "/v1/public/manage/participants/2", {
      ...guest(b.session, randomUUID()),
      body: { name: "Lou Late", isMinor: false, email: "lou@example.test" },
    });
    expect(
      (
        await request(
          "POST",
          "/v1/public/manage/participants/2/invitation",
          guest(b.session, randomUUID()),
        )
      ).status,
    ).toBe(202);
    await deliver(A);
    const link = await tokenFor(A, "lou@example.test");
    const terms = await request("GET", "/v1/public/manage/cancellation", guest(b.session));
    const canceled = await request("POST", "/v1/public/manage/cancellation", {
      ...guest(b.session, randomUUID()),
      body: { expectedRefundAmount: terms.json.terms.refundAmount },
    });
    expect(canceled.status).toBe(200);
    const opened = await request("POST", "/v1/public/participant-access", {
      origin: `https://${A.host}`,
      body: { token: link },
    });
    expect(opened.status).toBe(410);
    expect(opened.json.error.code).toBe("link_revoked");
  });
});
