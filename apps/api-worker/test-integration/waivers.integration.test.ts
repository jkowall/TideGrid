/**
 * G2.15 waivers through the whole API as tidegrid_app: the guest's link,
 * session, signature, and PDF, and the staff reads and resend. Bookings come
 * from the real checkout with the waiver hooks on; participants are named
 * through the booking module's own command, which runs the hooks; the links
 * come from the messaging module's real delivery job and fake mailbox. Every
 * route is tried from both tenants, with each role.
 */
import { createHash, randomUUID } from "node:crypto";
import { createDb, inTenantTransaction } from "@tidegrid/database";
import type {} from "@tidegrid/database/global-setup";
import type { BookingHooks } from "@tidegrid/domain-booking";
import { guestContext, TEST_FAKE_SECRET } from "@tidegrid/domain-booking/testing";
import { openGuestSession } from "@tidegrid/domain-messaging";
import {
  adult,
  bookParty,
  createWaiverFixture,
  fixtureHooks,
  linkFor,
  minor,
  nameParticipant,
  type WaiverFixture,
} from "@tidegrid/domain-waivers/testing";
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT } from "jose";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";
import { createApp } from "../src/app.ts";
import { createAccessVerifier } from "../src/auth/access.ts";

type Sql = ReturnType<typeof postgres>;
type Json = Record<string, unknown> & { error?: { code: string; message: string } };
type Res = { status: number; headers: Headers; json: Json; bytes: Uint8Array };
type Tenant = WaiverFixture & { owner: string; staff: string; finance: string };

const env = inject("integrationDb");
const TEAM = "tidegrid-waivers.cloudflareaccess.com";
const AUD = "c3".repeat(32);
const CONSOLE = "https://console.test";

describe.skipIf(!env)("G2.15 waivers through the API", () => {
  let admin: Sql;
  let runtime: ReturnType<typeof createDb>;
  let app: ReturnType<typeof createApp>;
  let signingKey: CryptoKey;
  let A: Tenant;
  let B: Tenant;
  const kid = `kid-${randomUUID().slice(0, 8)}`;
  let hooks: BookingHooks;
  let tripIndex = 0;

  const bindings = () => ({
    ENVIRONMENT: "local" as const,
    BUILD_ID: "integration",
    DATABASE_URL: env?.runtimeUrl ?? "",
    ALLOWED_ORIGINS: CONSOLE,
    STAFF_ORIGINS: CONSOLE,
    PAYMENT_PROVIDER: "fake",
    FAKE_PAYMENT_WEBHOOK_SECRET: TEST_FAKE_SECRET,
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
    method: string,
    path: string,
    opts: {
      origin?: string;
      as?: string;
      bearer?: string;
      body?: unknown;
      headers?: Record<string, string>;
    } = {},
  ): Promise<Res> {
    const headers = new Headers(opts.headers);
    if (opts.origin) headers.set("origin", opts.origin);
    if (opts.as) headers.set("cf-access-jwt-assertion", await token(opts.as));
    if (opts.bearer) headers.set("authorization", `Bearer ${opts.bearer}`);
    if (opts.body !== undefined) headers.set("content-type", "application/json");
    const res = await app.request(
      `http://localhost${path}`,
      { method, headers, body: opts.body === undefined ? null : JSON.stringify(opts.body) },
      bindings(),
      executionCtx,
    );
    const bytes = new Uint8Array(await res.arrayBuffer());
    let json: Json = {};
    if ((res.headers.get("content-type") ?? "").includes("json")) {
      json = JSON.parse(new TextDecoder().decode(bytes)) as Json;
    }
    return { status: res.status, headers: res.headers, json, bytes };
  }

  const guestOf = (t: Tenant) => `https://${t.host}`;
  const staffBase = (tenantId: string) => `/v1/staff/tenants/${tenantId}`;

  async function member(tenantId: string, email: string, role: string): Promise<string> {
    const userId = randomUUID();
    await admin`insert into public.staff_users (id, email, display_name) values (${userId}, ${email}, ${role})`;
    await admin`insert into public.tenant_memberships (tenant_id, user_id, role, display_name)
      values (${tenantId}, ${userId}, ${role}, ${role})`;
    return email;
  }

  async function tenant(label: string): Promise<Tenant> {
    const f = await createWaiverFixture(admin, runtime.db, label, { days: 12 });
    const mail = (role: string) => `${label}-${role}-${f.id.slice(0, 8)}@example.test`;
    return {
      ...f,
      owner: await member(f.id, mail("owner"), "owner"),
      staff: await member(f.id, mail("staff"), "booking_staff"),
      finance: await member(f.id, mail("finance"), "finance"),
    };
  }

  /** A booking with an adult and a minor named, and the links their emails carry. */
  async function party(t: Tenant) {
    const tripId = t.trips.shared[tripIndex++] ?? "";
    const booked = await bookParty(admin, runtime.db, t, tripId, 2, hooks);
    const ann = await nameParticipant(
      runtime.db,
      t.id,
      booked.bookingId,
      1,
      adult("Ann Adult"),
      hooks,
    );
    const kit = await nameParticipant(
      runtime.db,
      t.id,
      booked.bookingId,
      2,
      minor("Kit Minor", { name: "Gus Guardian", email: "gus@example.test" }),
      hooks,
    );
    const requestOf = async (participantId: string) => {
      const [row] = await admin<{ id: string }[]>`
        select id from public.waiver_requests where participant_id = ${participantId}
           and state = 'pending'`;
      return row?.id ?? "";
    };
    const annRequest = await requestOf(ann.participant.id);
    const kitRequest = await requestOf(kit.participant.id);
    return {
      booked,
      tripId,
      annRequest,
      kitRequest,
      annToken: (await linkFor(admin, runtime.db, t.id, annRequest)).token,
      kitToken: (await linkFor(admin, runtime.db, t.id, kitRequest)).token,
    };
  }

  async function openSession(t: Tenant, linkToken: string) {
    const res = await request("POST", "/v1/public/waiver-sessions", {
      origin: guestOf(t),
      body: { token: linkToken },
    });
    expect(res.status).toBe(201);
    return res.json as {
      sessionSecret: string;
      waiver: {
        signerRole: string;
        participant: { name: string; signerName: string };
        waiver: { contentSha256: string; acknowledgments: string[] };
        signed: { documentSha256: string } | null;
      };
    };
  }

  function signature(
    session: Awaited<ReturnType<typeof openSession>>,
    overrides: Record<string, unknown> = {},
  ) {
    return {
      contentSha256: session.waiver.waiver.contentSha256,
      acknowledgments: session.waiver.waiver.acknowledgments.map(() => true),
      consent: true,
      confirmIdentity: true,
      signature: session.waiver.participant.signerName,
      relationship: session.waiver.signerRole === "guardian" ? "parent" : null,
      ...overrides,
    };
  }

  beforeAll(async () => {
    if (!env) return;
    admin = postgres(env.adminUrl, { max: 4, onnotice: () => {} });
    runtime = createDb(env.runtimeUrl, { max: 8 });
    const pair = await generateKeyPair("RS256", { extractable: true });
    signingKey = pair.privateKey;
    const jwk = { ...(await exportJWK(pair.publicKey)), kid, alg: "RS256", use: "sig" };
    hooks = fixtureHooks();
    app = createApp({
      accessVerifier: createAccessVerifier({
        teamDomain: TEAM,
        audience: AUD,
        keys: createLocalJWKSet({ keys: [jwk] }),
      }),
    });
    A = await tenant("g215-a");
    B = await tenant("g215-b");
  });

  afterAll(async () => {
    await runtime?.end();
    await admin?.end({ timeout: 5 });
  });

  it("opens a session only by an explicit POST, once, at the link's own operator", async () => {
    const p = await party(A);
    // A link scanner's GETs, with the token wherever it might put it, find no route and consume nothing.
    for (const path of [
      `/v1/public/waiver-sessions?t=${p.annToken}`,
      `/v1/public/waiver-sessions/${p.annToken}`,
      "/v1/public/waiver-sessions/current",
      `/waiver?t=${p.annToken}`,
    ]) {
      const res = await request("GET", path, { origin: guestOf(A) });
      expect([401, 404, 405]).toContain(res.status);
    }
    // Another operator's site, and no site, find no such link.
    expect(
      (
        await request("POST", "/v1/public/waiver-sessions", {
          origin: guestOf(B),
          body: { token: p.annToken },
        })
      ).json.error?.code,
    ).toBe("waiver_link_invalid");
    expect(
      (await request("POST", "/v1/public/waiver-sessions", { body: { token: p.annToken } })).status,
    ).toBe(404);
    const opened = await openSession(A, p.annToken);
    expect(opened.waiver.participant.name).toBe("Ann Adult");
    expect(opened.waiver.signerRole).toBe("participant");
    const replay = await request("POST", "/v1/public/waiver-sessions", {
      origin: guestOf(A),
      body: { token: p.annToken },
    });
    expect([replay.status, replay.json.error?.code]).toEqual([409, "waiver_link_used"]);
    expect(replay.headers.get("cache-control")).toBe("no-store");
  });

  it("reads, signs, and downloads only with the session's secret, at its own operator", async () => {
    const p = await party(A);
    const session = await openSession(A, p.annToken);
    const read = (o: { origin?: string; bearer?: string }) =>
      request("GET", "/v1/public/waiver-sessions/current", o);
    expect((await read({ origin: guestOf(A) })).json.error?.code).toBe("waiver_session_required");
    expect((await read({ origin: guestOf(A), bearer: "x".repeat(43) })).json.error?.code).toBe(
      "waiver_session_invalid",
    );
    expect((await read({ origin: guestOf(B), bearer: session.sessionSecret })).status).toBe(401);
    expect((await read({ origin: guestOf(A), bearer: session.sessionSecret })).status).toBe(200);

    const sign = (body: unknown) =>
      request("POST", "/v1/public/waiver-sessions/current/signature", {
        origin: guestOf(A),
        bearer: session.sessionSecret,
        body,
      });
    const refused = await sign(signature(session, { signature: "Not Ann", consent: false }));
    expect(refused.status).toBe(422);
    expect(refused.json).toMatchObject({
      error: { code: "signature_invalid" },
      problems: [
        { field: "consent", code: "required" },
        { field: "signature", code: "does_not_match" },
      ],
    });
    expect(
      (
        await request("GET", "/v1/public/waiver-sessions/current/document", {
          origin: guestOf(A),
          bearer: session.sessionSecret,
        })
      ).json.error?.code,
    ).toBe("waiver_document_not_found");

    const signed = await sign(signature(session));
    expect(signed.status).toBe(201);
    const documentSha256 = (signed.json.waiver as { signed: { documentSha256: string } }).signed
      .documentSha256;
    const again = await sign(signature(session));
    expect(again.status).toBe(200);
    expect(
      (again.json.waiver as { signed: { documentSha256: string } }).signed.documentSha256,
    ).toBe(documentSha256);
    const pdf = await request("GET", "/v1/public/waiver-sessions/current/document", {
      origin: guestOf(A),
      bearer: session.sessionSecret,
    });
    expect(pdf.status).toBe(200);
    expect(pdf.headers.get("content-type")).toBe("application/pdf");
    expect(pdf.headers.get("content-disposition")).toBe(
      `attachment; filename="waiver-${p.booked.reference}.pdf"`,
    );
    expect(createHash("sha256").update(pdf.bytes).digest("hex")).toBe(documentSha256);
  });

  it("lets the named guardian sign for a minor, declaring the relationship", async () => {
    const p = await party(A);
    const session = await openSession(A, p.kitToken);
    expect(session.waiver.signerRole).toBe("guardian");
    expect(session.waiver.participant).toMatchObject({
      name: "Kit Minor",
      signerName: "Gus Guardian",
    });
    const sign = (body: unknown) =>
      request("POST", "/v1/public/waiver-sessions/current/signature", {
        origin: guestOf(A),
        bearer: session.sessionSecret,
        body,
      });
    expect((await sign(signature(session, { relationship: null }))).status).toBe(422);
    expect((await sign(signature(session, { relationship: "legal_guardian" }))).status).toBe(201);
  });

  it("tells another session and a spent link that the waiver was signed, and keeps the signer's", async () => {
    const p = await party(A);
    const first = await openSession(A, p.annToken);
    await admin.begin(async (tx) => {
      await tx`alter table public.waiver_deliveries disable trigger waiver_deliveries_append_only`;
      await tx`update public.waiver_deliveries set created_at = created_at - interval '11 minutes',
                      send_after = send_after - interval '11 minutes'
                where request_id = ${p.annRequest}`;
      await tx`alter table public.waiver_deliveries enable trigger waiver_deliveries_append_only`;
    });
    const resent = await request(
      "POST",
      `${staffBase(A.id)}/waiver-requests/${p.annRequest}/resend`,
      {
        as: A.staff,
        origin: CONSOLE,
        headers: { "idempotency-key": `k-${randomUUID()}` },
        body: { reason: "Guest asked" },
      },
    );
    expect(resent.status).toBe(201);
    const second = await openSession(
      A,
      (await linkFor(admin, runtime.db, A.id, p.annRequest)).token,
    );
    const as = (secret: string) => ({ origin: guestOf(A), bearer: secret });
    const signed = await request("POST", "/v1/public/waiver-sessions/current/signature", {
      ...as(second.sessionSecret),
      body: signature(second),
    });
    expect(signed.status).toBe(201);

    const codeOf = (res: Res) => [res.status, res.json.error?.code];
    expect(
      codeOf(await request("GET", "/v1/public/waiver-sessions/current", as(first.sessionSecret))),
    ).toEqual([409, "waiver_signed"]);
    expect(
      codeOf(
        await request("POST", "/v1/public/waiver-sessions/current/signature", {
          ...as(first.sessionSecret),
          body: signature(first),
        }),
      ),
    ).toEqual([409, "waiver_signed"]);
    expect(
      codeOf(
        await request(
          "GET",
          "/v1/public/waiver-sessions/current/document",
          as(first.sessionSecret),
        ),
      ),
    ).toEqual([409, "waiver_signed"]);
    // Another operator's site still finds no session at all.
    expect(
      codeOf(
        await request("GET", "/v1/public/waiver-sessions/current", {
          origin: guestOf(B),
          bearer: first.sessionSecret,
        }),
      ),
    ).toEqual([401, "waiver_session_invalid"]);
    // The first email's link, opened once already, says the same.
    expect(
      codeOf(
        await request("POST", "/v1/public/waiver-sessions", {
          origin: guestOf(A),
          body: { token: p.annToken },
        }),
      ),
    ).toEqual([409, "waiver_signed"]);
    const mine = await request(
      "GET",
      "/v1/public/waiver-sessions/current",
      as(second.sessionSecret),
    );
    expect([mine.status, (mine.json.waiver as { state: string }).state]).toEqual([200, "signed"]);
  });

  it("shows waiver status to owners and booking staff only, and nothing across operators", async () => {
    const p = await party(A);
    const session = await openSession(A, p.annToken);
    await request("POST", "/v1/public/waiver-sessions/current/signature", {
      origin: guestOf(A),
      bearer: session.sessionSecret,
      body: signature(session),
    });
    const path = `${staffBase(A.id)}/bookings/${p.booked.bookingId}/waivers`;
    for (const as of [A.owner, A.staff]) {
      const res = await request("GET", path, { as });
      expect(res.status).toBe(200);
      const waivers = res.json.waivers as {
        participants: {
          name: string;
          status: string;
          request: { delivery: { message: { state: string } } };
        }[];
      };
      expect(waivers.participants.map((x) => [x.name, x.status])).toEqual([
        ["Ann Adult", "signed"],
        ["Kit Minor", "waiting"],
      ]);
      // Delivery is reported apart from the signature.
      expect(waivers.participants[1]?.request.delivery.message.state).toBe("sent");
      expect(res.headers.get("cache-control")).toBe("no-store");
    }
    expect((await request("GET", path, { as: A.finance })).status).toBe(403);
    expect((await request("GET", path, { as: B.owner })).json.error?.code).toBe("tenant_not_found");
    const pb = await party(B);
    const crossed = await request(
      "GET",
      `${staffBase(A.id)}/bookings/${pb.booked.bookingId}/waivers`,
      { as: A.owner },
    );
    expect([crossed.status, crossed.json.error?.code]).toEqual([404, "booking_not_found"]);

    const tripPath = (tenantId: string, tripId: string) =>
      `${staffBase(tenantId)}/trips/${tripId}/waivers`;
    const trip = await request("GET", tripPath(A.id, p.tripId), { as: A.staff });
    expect(trip.status).toBe(200);
    expect(trip.json.totals).toMatchObject({ participants: 2, signed: 1, waiting: 1 });
    expect((await request("GET", tripPath(A.id, p.tripId), { as: A.finance })).status).toBe(403);
    expect(
      (await request("GET", tripPath(A.id, pb.tripId), { as: A.owner })).json.error?.code,
    ).toBe("trip_not_found");

    // The signed PDF, by evidence id.
    const [evidence] = await admin<{ id: string; document_sha256: string }[]>`
      select id, document_sha256 from public.waiver_evidence where request_id = ${p.annRequest}`;
    const docPath = (tenantId: string, id: string) =>
      `${staffBase(tenantId)}/waiver-evidence/${id}/document`;
    const pdf = await request("GET", docPath(A.id, evidence?.id ?? ""), { as: A.owner });
    expect(pdf.status).toBe(200);
    expect(createHash("sha256").update(pdf.bytes).digest("hex")).toBe(evidence?.document_sha256);
    expect(
      (await request("GET", docPath(A.id, evidence?.id ?? ""), { as: A.finance })).status,
    ).toBe(403);
    expect((await request("GET", docPath(B.id, evidence?.id ?? ""), { as: B.owner })).status).toBe(
      404,
    );
    expect((await request("GET", docPath(A.id, "not-a-uuid"), { as: A.owner })).status).toBe(404);
  });

  it("resends for owners and booking staff, with a reason, rate limited and idempotent", async () => {
    const p = await party(A);
    const path = (tenantId: string, id: string) =>
      `${staffBase(tenantId)}/waiver-requests/${id}/resend`;
    const resend = (
      as: string,
      key: string,
      reason = "Guest asked",
      tenantId = A.id,
      id = p.annRequest,
    ) =>
      request("POST", path(tenantId, id), {
        as,
        origin: CONSOLE,
        headers: { "idempotency-key": key },
        body: { reason },
      });
    expect((await resend(A.finance, `k-${randomUUID()}`)).status).toBe(403);
    expect((await resend(B.owner, `k-${randomUUID()}`, "x", B.id)).json.error?.code).toBe(
      "waiver_request_not_found",
    );
    const tooSoon = await resend(A.staff, `k-${randomUUID()}`);
    expect([tooSoon.status, tooSoon.json.error?.code]).toEqual([409, "waiver_resend_too_soon"]);
    await admin.begin(async (tx) => {
      await tx`alter table public.waiver_deliveries disable trigger waiver_deliveries_append_only`;
      await tx`update public.waiver_deliveries set created_at = created_at - interval '11 minutes',
                      send_after = send_after - interval '11 minutes'
                where request_id = ${p.annRequest}`;
      await tx`alter table public.waiver_deliveries enable trigger waiver_deliveries_append_only`;
    });
    const key = `k-${randomUUID()}`;
    const sent = await resend(A.staff, key);
    expect([sent.status, (sent.json.delivery as { generation: number }).generation]).toEqual([
      201, 2,
    ]);
    const replayed = await resend(A.staff, key);
    expect(replayed.status).toBe(201);
    expect(replayed.headers.get("idempotent-replayed")).toBe("true");
    expect((await resend(A.staff, key, "Another reason")).json.error?.code).toBe(
      "idempotency_key_reused",
    );
    // The newest email's link opens; the first one was replaced when it went out.
    const newest = await linkFor(admin, runtime.db, A.id, p.annRequest);
    expect(
      (
        await request("POST", "/v1/public/waiver-sessions", {
          origin: guestOf(A),
          body: { token: p.annToken },
        })
      ).json.error?.code,
    ).toBe("waiver_link_replaced");
    await openSession(A, newest.token);
    // A request from outside the console is refused before anything else.
    const forged = await request("POST", path(A.id, p.annRequest), {
      as: A.owner,
      origin: "https://evil.example",
      headers: { "idempotency-key": `k-${randomUUID()}` },
      body: { reason: "x" },
    });
    expect(forged.json.error?.code).toBe("origin_not_allowed");
  });

  /** Lane 1's booking session for a booking its checkout just made, as the paid page opens it. */
  async function bookingSession(
    t: Tenant,
    booked: { bookingId: string; checkoutSessionId: string },
  ) {
    const ctx = guestContext(t.id);
    const opened = await inTenantTransaction(runtime.db, ctx, (trx) =>
      openGuestSession(trx, ctx, {
        checkout: { checkoutSessionId: booked.checkoutSessionId, bookingId: booked.bookingId },
      }),
    );
    return opened.token;
  }

  it("shows the booker their party's waivers in the booking session: names and statuses only", async () => {
    const p = await party(A);
    const session = await bookingSession(A, p.booked);
    const read = (o: { origin?: string; bearer?: string }) =>
      request("GET", "/v1/public/manage/waivers", o);
    // No session, an unknown one, another operator's site, and a waiver signing session.
    expect((await read({ origin: guestOf(A) })).json.error?.code).toBe("session_required");
    expect((await read({ origin: guestOf(A), bearer: "x".repeat(43) })).json.error?.code).toBe(
      "session_expired",
    );
    expect((await read({ origin: guestOf(B), bearer: session })).json.error?.code).toBe(
      "session_expired",
    );
    const signing = await openSession(A, p.annToken);
    expect((await read({ origin: guestOf(A), bearer: signing.sessionSecret })).status).toBe(401);
    expect(
      (
        await request("POST", "/v1/public/waiver-sessions/current/signature", {
          origin: guestOf(A),
          bearer: signing.sessionSecret,
          body: signature(signing),
        })
      ).status,
    ).toBe(201);

    const res = await read({ origin: guestOf(A), bearer: session });
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(res.json.waivers).toEqual({
      applies: true,
      unnamedPlaces: 0,
      participants: [
        {
          position: 1,
          name: "Ann Adult",
          minor: false,
          status: "signed",
          signer: "participant",
          signedAt: expect.stringMatching(/^\d{4}-\d\d-\d\dT/),
          sentTo: null,
          sendsAt: null,
        },
        {
          position: 2,
          name: "Kit Minor",
          minor: true,
          status: "waiting",
          signer: "guardian",
          signedAt: null,
          sentTo: "g•••@example.test",
          sendsAt: null,
        },
      ],
    });
    // Nothing that identifies a record, a guardian, or an address in full.
    const raw = new TextDecoder().decode(res.bytes);
    const [ids] = await admin<{ ids: string[] }[]>`
      select array_agg(x) as ids from (
        select id::text as x from public.waiver_requests where booking_id = ${p.booked.bookingId}
        union all select participant_id::text from public.waiver_requests
                   where booking_id = ${p.booked.bookingId}
        union all select id::text from public.waiver_evidence where booking_id = ${p.booked.bookingId}
        union all select ${p.booked.bookingId}::text) found`;
    expect(ids?.ids.length).toBeGreaterThanOrEqual(6);
    for (const value of [...(ids?.ids ?? []), "Gus Guardian", "gus@example.test"]) {
      expect(raw).not.toContain(value);
    }

    // Canceled: nothing is needed, so the page shows nothing.
    const managed = await request("GET", "/v1/public/manage/booking", {
      origin: guestOf(A),
      bearer: session,
    });
    const refund = (managed.json.booking as { cancellationTerms: { refundAmount: number } })
      .cancellationTerms.refundAmount;
    const canceled = await request("POST", "/v1/public/manage/cancellation", {
      origin: guestOf(A),
      bearer: session,
      headers: { "idempotency-key": `k-${randomUUID()}` },
      body: { expectedRefundAmount: refund },
    });
    expect(canceled.status).toBe(200);
    const after = await read({ origin: guestOf(A), bearer: session });
    expect(after.json.waivers).toMatchObject({ applies: false });
    expect(
      (after.json.waivers as { participants: { status: string }[] }).participants.map(
        (x) => x.status,
      ),
    ).toEqual(["not_needed", "not_needed"]);
  });
});
