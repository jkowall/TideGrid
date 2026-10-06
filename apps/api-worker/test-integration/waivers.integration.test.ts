/**
 * G2.15 waivers through the whole API as tidegrid_app: the guest's link,
 * session, signature, and PDF, and the staff reads and resend. Bookings come
 * from the real checkout with the waiver hooks on; participants are named
 * through the booking module's own command, which runs the hooks; the links
 * come from the messaging module's real delivery job and fake mailbox. Every
 * route is tried from both tenants, with each role.
 */
import { createHash, randomUUID } from "node:crypto";
import { createDb } from "@tidegrid/database";
import type {} from "@tidegrid/database/global-setup";
import type { BookingHooks } from "@tidegrid/domain-booking";
import { TEST_FAKE_SECRET } from "@tidegrid/domain-booking/testing";
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
      await tx`update public.waiver_deliveries set created_at = created_at - interval '11 minutes'
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
});
