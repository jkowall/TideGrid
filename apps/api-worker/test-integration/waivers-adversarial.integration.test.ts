/**
 * G2.15 adversarial: every waiver route through the whole API as
 * tidegrid_app, against the waiver contract's API table, its "Links and
 * sessions" rules, and "Who sees what". Two tenants (a third for a version
 * change), every staff role, and the guest's link and session from the wrong
 * places. Bookings come from the real checkout with the waiver hooks on;
 * participants are named through the booking module's own command; links come
 * from the messaging module's real delivery job and fake mailbox. Synthetic
 * data only.
 */
import { createHash, randomUUID } from "node:crypto";
import { createDb, inTenantTransaction, type TenantContext } from "@tidegrid/database";
import type {} from "@tidegrid/database/global-setup";
import type { BookingHooks, ParticipantDetails } from "@tidegrid/domain-booking";
import { TEST_FAKE_SECRET } from "@tidegrid/domain-booking/testing";
import { createWaiverHooks, defaultWaiverDeps, publishWaiverTemplateVersion } from "@tidegrid/domain-waivers";
import {
  adult,
  bookParty,
  createWaiverFixture,
  deliverMail,
  FIXTURE_TEXT,
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
const TEAM = "tidegrid-waivers-adv.cloudflareaccess.com";
const AUD = "d4".repeat(32);
const CONSOLE = "https://console.test";
const SESSIONS = "/v1/public/waiver-sessions";
const CURRENT = `${SESSIONS}/current`;
const SIGNATURE = `${CURRENT}/signature`;
const DOCUMENT = `${CURRENT}/document`;

const sha256 = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

describe.skipIf(!env)("G2.15 adversarial: waivers through the API", () => {
  let admin: Sql;
  let runtime: ReturnType<typeof createDb>;
  let app: ReturnType<typeof createApp>;
  let signingKey: CryptoKey;
  let A: Tenant;
  let B: Tenant;
  const kid = `kid-${randomUUID().slice(0, 8)}`;
  let hooks: BookingHooks;
  const tripIndex = new Map<string, number>();

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

  const guestOf = (t: WaiverFixture) => `https://${t.host}`;
  const staffBase = (tenantId: string) => `/v1/staff/tenants/${tenantId}`;
  const code = (res: Res) => [res.status, res.json.error?.code ?? null];

  async function member(tenantId: string, email: string, role: string): Promise<string> {
    const userId = randomUUID();
    await admin`insert into public.staff_users (id, email, display_name) values (${userId}, ${email}, ${role})`;
    await admin`insert into public.tenant_memberships (tenant_id, user_id, role, display_name)
      values (${tenantId}, ${userId}, ${role}, ${role})`;
    return email;
  }

  async function tenant(label: string): Promise<Tenant> {
    const f = await createWaiverFixture(admin, runtime.db, label, { days: 10 });
    const mail = (role: string) => `${label}-${role}-${f.id.slice(0, 8)}@example.test`;
    return {
      ...f,
      owner: await member(f.id, mail("owner"), "owner"),
      staff: await member(f.id, mail("staff"), "booking_staff"),
      finance: await member(f.id, mail("finance"), "finance"),
    };
  }

  function nextTrip(t: WaiverFixture): string {
    const i = tripIndex.get(t.id) ?? 0;
    tripIndex.set(t.id, i + 1);
    const tripId = t.trips.shared[i];
    if (!tripId) throw new Error("out of fixture trips");
    return tripId;
  }

  async function requestOf(participantId: string): Promise<string> {
    const [row] = await admin<{ id: string }[]>`
      select id from public.waiver_requests where participant_id = ${participantId}
         and state in ('pending', 'signed')`;
    if (!row) throw new Error("no live request");
    return row.id;
  }

  /** A booking with an adult and a minor named, and the links their emails carry. */
  async function party(t: WaiverFixture, people?: [ParticipantDetails, ParticipantDetails]) {
    const tripId = nextTrip(t);
    const booked = await bookParty(admin, runtime.db, t, tripId, 2, hooks);
    const [first, second] = people ?? [
      adult("Ann Adult"),
      minor("Kit Minor", { name: "Gus Guardian", email: "gus.guardian@example.test" }),
    ];
    const ann = await nameParticipant(runtime.db, t.id, booked.bookingId, 1, first, hooks);
    const kit = await nameParticipant(runtime.db, t.id, booked.bookingId, 2, second, hooks);
    const annRequest = await requestOf(ann.participant.id);
    const kitRequest = await requestOf(kit.participant.id);
    return {
      booked,
      tripId,
      annId: ann.participant.id,
      kitId: kit.participant.id,
      annRequest,
      kitRequest,
      annToken: (await linkFor(admin, runtime.db, t.id, annRequest)).token,
      kitToken: (await linkFor(admin, runtime.db, t.id, kitRequest)).token,
    };
  }

  type Opened = {
    sessionSecret: string;
    waiver: {
      signerRole: string;
      participant: { name: string; signerName: string };
      waiver: { contentSha256: string; acknowledgments: string[]; version: number };
    };
  };

  async function open(t: WaiverFixture, linkToken: string): Promise<Opened> {
    const res = await request("POST", SESSIONS, { origin: guestOf(t), body: { token: linkToken } });
    expect(code(res)).toEqual([201, null]);
    return res.json as unknown as Opened;
  }

  function signature(session: Opened, overrides: Record<string, unknown> = {}) {
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

  async function linkState(requestId: string) {
    const links = await admin<{ consumed: boolean }[]>`
      select consumed_at is not null as consumed from public.guest_access_links
       where subject_ref = ${`waiver_request:${requestId}`}`;
    const [sessions] = await admin<{ n: number }[]>`
      select count(*)::int as n from public.waiver_signing_sessions where request_id = ${requestId}`;
    return { links: links.map((l) => l.consumed), sessions: sessions?.n ?? -1 };
  }

  async function ageDeliveries(requestId: string) {
    await admin.begin(async (tx) => {
      await tx`alter table public.waiver_deliveries disable trigger waiver_deliveries_append_only`;
      await tx`update public.waiver_deliveries set created_at = created_at - interval '11 minutes'
                where request_id = ${requestId}`;
      await tx`alter table public.waiver_deliveries enable trigger waiver_deliveries_append_only`;
    });
  }

  beforeAll(async () => {
    if (!env) return;
    admin = postgres(env.adminUrl, { max: 4, onnotice: () => {} });
    runtime = createDb(env.runtimeUrl, { max: 12 });
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
      deliverEmailAfterCommit: false,
    });
    A = await tenant("g215adv-a");
    B = await tenant("g215adv-b");
  });

  afterAll(async () => {
    await runtime?.sql.end({ timeout: 5 });
    await runtime?.db.destroy();
    await admin?.end({ timeout: 5 });
  });

  it("consumes a link only by its POST body at its own operator: no GET, HEAD, query, path, or bearer use", async () => {
    const p = await party(A);
    const t = p.annToken;
    const attempts: [string, string, Parameters<typeof request>[2]][] = [
      ["GET", `${SESSIONS}?token=${t}`, { origin: guestOf(A) }],
      ["HEAD", `${SESSIONS}?token=${t}`, { origin: guestOf(A) }],
      ["GET", `${SESSIONS}?t=${t}`, { origin: guestOf(A) }],
      ["GET", `${SESSIONS}/${t}`, { origin: guestOf(A) }],
      ["HEAD", `${SESSIONS}/${t}`, { origin: guestOf(A) }],
      ["GET", `${CURRENT}?token=${t}`, { origin: guestOf(A) }],
      ["GET", `${DOCUMENT}?t=${t}`, { origin: guestOf(A) }],
      ["GET", `${SIGNATURE}?t=${t}`, { origin: guestOf(A) }],
      ["GET", `/waiver?t=${t}`, { origin: guestOf(A) }],
      // The link's token where a session's secret goes, on every session route.
      ["GET", CURRENT, { origin: guestOf(A), bearer: t }],
      ["HEAD", CURRENT, { origin: guestOf(A), bearer: t }],
      ["GET", DOCUMENT, { origin: guestOf(A), bearer: t }],
      ["POST", SIGNATURE, { origin: guestOf(A), bearer: t, body: { token: t } }],
      // A POST that does not carry it in the body, or not at its operator.
      ["POST", `${SESSIONS}?token=${t}`, { origin: guestOf(A), body: {} }],
      ["POST", SESSIONS, { origin: guestOf(A), body: { t } }],
      ["POST", SESSIONS, { origin: guestOf(B), body: { token: t } }],
      ["POST", SESSIONS, { body: { token: t } }],
      ["POST", SESSIONS, { origin: "https://unknown.book.example.test", body: { token: t } }],
    ];
    const seen: string[] = [];
    for (const [method, path, opts] of attempts) {
      const res = await request(method, path, opts);
      seen.push(`${method} ${path.replace(t, "<token>")} -> ${res.status}`);
      expect(res.status, `${method} ${path}`).toBeGreaterThanOrEqual(400);
    }
    expect(await linkState(p.annRequest)).toEqual({ links: [false], sessions: 0 });
    const opened = await open(A, t);
    expect(opened.waiver.participant.name).toBe("Ann Adult");
    expect(await linkState(p.annRequest)).toEqual({ links: [true], sessions: 1 });
    expect(seen).toHaveLength(attempts.length);
  });

  it("opens exactly one session when the same link is posted many times at once", async () => {
    const p = await party(A);
    const results = await Promise.all(
      Array.from({ length: 8 }, () =>
        request("POST", SESSIONS, { origin: guestOf(A), body: { token: p.annToken } }),
      ),
    );
    const answers = results.map(code).map((c) => c.join(" ")).sort();
    expect(answers).toEqual(["201 ", ...Array(7).fill("409 waiver_link_used")]);
    for (const res of results) expect(res.headers.get("cache-control")).toBe("no-store");
    expect(await linkState(p.annRequest)).toEqual({ links: [true], sessions: 1 });
  });

  it("lets a session reach only its own request, whatever another participant's ids it sends", async () => {
    const p = await party(A);
    const ann = await open(A, p.annToken);
    const bearer = ann.sessionSecret;
    const as = { origin: guestOf(A), bearer };
    const probes = {
      query: await request("GET", `${CURRENT}?requestId=${p.kitRequest}&participantId=${p.kitId}`, as),
      path: await request("GET", `${SESSIONS}/${p.kitRequest}`, as),
      document: await request("GET", `${DOCUMENT}?requestId=${p.kitRequest}`, as),
    };
    expect((probes.query.json.waiver as { participant: { name: string } }).participant.name).toBe(
      "Ann Adult",
    );
    expect(probes.path.status).toBe(404);
    expect(code(probes.document)).toEqual([404, "waiver_document_not_found"]);
    // Kit's guardian's name, typed in Ann's session, signs nothing for Kit.
    const asGuardian = await request("POST", SIGNATURE, {
      ...as,
      body: signature(ann, { signature: "Gus Guardian", relationship: "parent" }),
    });
    expect(code(asGuardian)).toEqual([422, "signature_invalid"]);
    // Every body field that could name another request is ignored or refused.
    const signed = await request("POST", SIGNATURE, {
      ...as,
      body: {
        ...signature(ann),
        requestId: p.kitRequest,
        participantId: p.kitId,
        bookingId: p.booked.bookingId,
        sessionId: randomUUID(),
        signerRole: "guardian",
      },
    });
    expect([201, 400]).toContain(signed.status);
    const evidence = await admin<{ request_id: string }[]>`
      select request_id from public.waiver_evidence where booking_id = ${p.booked.bookingId}`;
    expect(evidence.map((e) => e.request_id)).toEqual(signed.status === 201 ? [p.annRequest] : []);
    const [kitNow] = await admin<{ state: string }[]>`
      select state from public.waiver_requests where id = ${p.kitRequest}`;
    expect(kitNow?.state).toBe("pending");
    // Kit's own session sees Kit's waiver and no signed copy.
    const kit = await open(A, p.kitToken);
    expect(kit.waiver.participant.name).toBe("Kit Minor");
    expect(
      code(await request("GET", DOCUMENT, { origin: guestOf(A), bearer: kit.sessionSecret })),
    ).toEqual([404, "waiver_document_not_found"]);
  });

  it("refuses a session on every route once its request ends, and at any other operator", async () => {
    const p = await party(A);
    const ann = await open(A, p.annToken);
    const kit = await open(A, p.kitToken);
    const routes = (bearer: string, origin: string) => [
      request("GET", CURRENT, { origin, bearer }),
      request("POST", SIGNATURE, { origin, bearer, body: signature(ann) }),
      request("GET", DOCUMENT, { origin, bearer }),
    ];
    // Another operator's site, or none that resolves.
    for (const res of await Promise.all(routes(ann.sessionSecret, guestOf(B)))) {
      expect(code(res)).toEqual([401, "waiver_session_invalid"]);
    }
    for (const res of await Promise.all(routes(ann.sessionSecret, "https://nobody.example.test"))) {
      expect(code(res)).toEqual([404, "tenant_not_found"]);
    }
    // The booking is canceled: its waivers end with it.
    const ctx: TenantContext = {
      tenantId: A.id,
      actorType: "system",
      actorId: "cancellation",
      requestId: `adv-${randomUUID()}`,
    };
    await inTenantTransaction(runtime.db, ctx, async (trx) => {
      await createWaiverHooks(defaultWaiverDeps).bookingCanceled?.(trx, ctx, {
        bookingId: p.booked.bookingId,
        cancellationId: randomUUID(),
        refundId: null,
      });
    });
    for (const secret of [ann.sessionSecret, kit.sessionSecret]) {
      for (const res of await Promise.all(routes(secret, guestOf(A)))) {
        expect(code(res)).toEqual([401, "waiver_session_invalid"]);
        expect(res.headers.get("cache-control")).toBe("no-store");
      }
    }
    expect(await admin`select 1 from public.waiver_evidence where booking_id = ${p.booked.bookingId}`).toHaveLength(0);

    // A new version moves unsigned work: the old session ends, the new email opens version 2.
    const C = await createWaiverFixture(admin, runtime.db, "g215adv-c", { days: 2 });
    const pc = await party(C);
    const old = await open(C, pc.annToken);
    const owner: TenantContext = {
      tenantId: C.id,
      actorType: "system",
      actorId: "owner",
      requestId: `adv-${randomUUID()}`,
    };
    const published = await inTenantTransaction(runtime.db, owner, (trx) =>
      publishWaiverTemplateVersion(trx, owner, defaultWaiverDeps, {
        templateId: C.templateId,
        text: { ...FIXTURE_TEXT, title: "Fixture participation waiver, second edition" },
        reason: "Synthetic revision",
        reassignUnsigned: true,
      }),
    );
    expect(published).toMatchObject({ kind: "published", version: 2, reassigned: 2 });
    for (const res of await Promise.all(routes(old.sessionSecret, guestOf(C)))) {
      expect(code(res)).toEqual([401, "waiver_session_invalid"]);
    }
    expect(
      code(await request("POST", SESSIONS, { origin: guestOf(C), body: { token: pc.kitToken } })),
    ).toEqual([409, "waiver_superseded"]);
    const replacement = await requestOf(pc.annId);
    const fresh = await open(C, (await linkFor(admin, runtime.db, C.id, replacement)).token);
    expect(fresh.waiver.waiver.version).toBe(2);
  });

  it("serves the signed PDF as exactly the stored bytes, to the signer and to owners and booking staff only", async () => {
    const p = await party(A);
    const ann = await open(A, p.annToken);
    const signed = await request("POST", SIGNATURE, {
      origin: guestOf(A),
      bearer: ann.sessionSecret,
      body: signature(ann),
    });
    expect(signed.status).toBe(201);
    const [stored] = await admin<{ id: string; document: Buffer; document_sha256: string }[]>`
      select id, document, document_sha256 from public.waiver_evidence where request_id = ${p.annRequest}`;
    if (!stored) throw new Error("no evidence");
    expect(sha256(stored.document)).toBe(stored.document_sha256);
    expect((signed.json.waiver as { signed: { documentSha256: string } }).signed.documentSha256).toBe(
      stored.document_sha256,
    );
    const downloads = {
      signer: await request("GET", DOCUMENT, { origin: guestOf(A), bearer: ann.sessionSecret }),
      owner: await request("GET", `${staffBase(A.id)}/waiver-evidence/${stored.id}/document`, {
        as: A.owner,
      }),
      staff: await request("GET", `${staffBase(A.id)}/waiver-evidence/${stored.id}/document`, {
        as: A.staff,
      }),
    };
    for (const [who, res] of Object.entries(downloads)) {
      expect(res.status, who).toBe(200);
      expect(Buffer.from(res.bytes).equals(stored.document), who).toBe(true);
      expect(res.headers.get("content-type"), who).toBe("application/pdf");
      expect(res.headers.get("cache-control"), who).toBe("no-store");
      expect(res.headers.get("x-content-type-options"), who).toBe("nosniff");
    }
    const finance = await request("GET", `${staffBase(A.id)}/waiver-evidence/${stored.id}/document`, {
      as: A.finance,
    });
    expect(code(finance)).toEqual([403, "forbidden"]);
    expect(finance.bytes.length).toBeLessThan(1000);
  });

  it("answers staff waiver routes by role, and the same 404 for another operator's, an unknown, or a malformed id", async () => {
    const pa = await party(A);
    const pb = await party(B);
    for (const [t, pp] of [
      [A, pa],
      [B, pb],
    ] as const) {
      const s = await open(t, pp.annToken);
      expect(
        (await request("POST", SIGNATURE, { origin: guestOf(t), bearer: s.sessionSecret, body: signature(s) }))
          .status,
      ).toBe(201);
    }
    const evidenceOf = async (requestId: string) =>
      (await admin<{ id: string }[]>`select id from public.waiver_evidence where request_id = ${requestId}`)[0]?.id ?? "";
    const aEvidence = await evidenceOf(pa.annRequest);
    const bEvidence = await evidenceOf(pb.annRequest);
    const resend = (as: string, requestId: string) =>
      request("POST", `${staffBase(A.id)}/waiver-requests/${requestId}/resend`, {
        as,
        origin: CONSOLE,
        headers: { "idempotency-key": `k-${randomUUID()}` },
        body: { reason: "Guest asked" },
      });
    const routes = {
      booking: {
        path: (id: string) => `${staffBase(A.id)}/bookings/${id}/waivers`,
        own: pa.booked.bookingId,
        other: pb.booked.bookingId,
        notFound: "booking_not_found",
      },
      trip: {
        path: (id: string) => `${staffBase(A.id)}/trips/${id}/waivers`,
        own: pa.tripId,
        other: pb.tripId,
        notFound: "trip_not_found",
      },
      document: {
        path: (id: string) => `${staffBase(A.id)}/waiver-evidence/${id}/document`,
        own: aEvidence,
        other: bEvidence,
        notFound: "waiver_evidence_not_found",
      },
    };
    for (const [label, r] of Object.entries(routes)) {
      expect((await request("GET", r.path(r.own), { as: A.owner })).status, label).toBe(200);
      expect((await request("GET", r.path(r.own), { as: A.staff })).status, label).toBe(200);
      const denied = await request("GET", r.path(r.own), { as: A.finance });
      expect(code(denied), label).toEqual([403, "forbidden"]);
      // No participant's name in a refusal.
      expect(new TextDecoder().decode(denied.bytes), label).not.toMatch(/Ann Adult|Kit Minor|Gus Guardian/);
      const misses = [
        await request("GET", r.path(r.other), { as: A.owner }),
        await request("GET", r.path(randomUUID()), { as: A.owner }),
        await request("GET", r.path("not-a-uuid"), { as: A.owner }),
      ];
      expect(
        misses.map((m) => [m.status, m.json.error?.code, m.json.error?.message]),
        label,
      ).toEqual(Array(3).fill([404, r.notFound, misses[0]?.json.error?.message]));
      // Another tenant's member at this tenant's path.
      expect(code(await request("GET", r.path(r.own), { as: B.owner })), label).toEqual([
        404,
        "tenant_not_found",
      ]);
    }
    // The resend, which needs waivers.manage.
    expect(code(await resend(A.finance, pa.kitRequest))).toEqual([403, "forbidden"]);
    for (const as of [A.owner, A.staff]) {
      expect(code(await resend(as, pa.kitRequest))).toEqual([409, "waiver_resend_too_soon"]);
    }
    const resendMisses = [
      await resend(A.owner, pb.kitRequest),
      await resend(A.owner, randomUUID()),
      await resend(A.owner, "not-a-uuid"),
    ];
    expect(resendMisses.map((m) => [m.status, m.json.error?.code, m.json.error?.message])).toEqual(
      Array(3).fill([404, "waiver_request_not_found", resendMisses[0]?.json.error?.message]),
    );
    expect(code(await resend(A.owner, pa.annRequest))).toEqual([409, "waiver_not_pending"]);
  });

  it("shows a failed email as email_failed while the request stays pending, and holds the resend limit", async () => {
    const bounce = `ivy.${randomUUID().slice(0, 8)}+bounce@example.test`;
    const p = await party(A, [
      adult("Ivy Bounce", bounce),
      minor("Joy Minor", { name: "Kay Guardian", email: "kay.guardian@example.test" }),
    ]);
    await deliverMail(runtime.db, A.id);
    const read = await request("GET", `${staffBase(A.id)}/bookings/${p.booked.bookingId}/waivers`, {
      as: A.staff,
    });
    expect(read.status).toBe(200);
    const [ivy, joy] = (
      read.json.waivers as {
        participants: {
          status: string;
          request: { state: string; delivery: { message: { state: string; failureCode: string | null } } };
        }[];
      }
    ).participants;
    expect(ivy?.status).toBe("email_failed");
    expect(ivy?.request.state).toBe("pending");
    expect(ivy?.request.delivery.message).toMatchObject({ state: "failed", failureCode: "bounced" });
    expect(joy?.status).toBe("waiting");
    // Delivery left the request as it was.
    const [row] = await admin<{ state: string; signed_at: Date | null }[]>`
      select state, signed_at from public.waiver_requests where id = ${p.annRequest}`;
    expect(row).toEqual({ state: "pending", signed_at: null });

    const resend = () =>
      request("POST", `${staffBase(A.id)}/waiver-requests/${p.annRequest}/resend`, {
        as: A.staff,
        origin: CONSOLE,
        headers: { "idempotency-key": `k-${randomUUID()}` },
        body: { reason: "The address bounced; trying again" },
      });
    const generations: number[] = [];
    for (let i = 0; i < 4; i++) {
      await ageDeliveries(p.annRequest);
      const sent = await resend();
      expect(sent.status).toBe(201);
      generations.push((sent.json.delivery as { generation: number }).generation);
    }
    expect(generations).toEqual([2, 3, 4, 5]);
    await ageDeliveries(p.annRequest);
    expect(code(await resend())).toEqual([409, "waiver_resend_limit"]);
  });

  it("writes no name, address, signature, or waiver text into audit or outbox rows", async () => {
    const people: [ParticipantDetails, ParticipantDetails] = [
      adult("Pria Private", "pria.private@example.test"),
      minor("Quin Private", { name: "Rory Privateguardian", email: "rory.private@example.test" }),
    ];
    const p = await party(A, people);
    const pria = await open(A, p.annToken);
    expect(
      (
        await request("POST", SIGNATURE, {
          origin: guestOf(A),
          bearer: pria.sessionSecret,
          body: signature(pria, { signature: "  pria   PRIVATE " }),
        })
      ).status,
    ).toBe(201);
    await ageDeliveries(p.kitRequest);
    expect(
      (
        await request("POST", `${staffBase(A.id)}/waiver-requests/${p.kitRequest}/resend`, {
          as: A.owner,
          origin: CONSOLE,
          headers: { "idempotency-key": `k-${randomUUID()}` },
          body: { reason: "Guest asked" },
        })
      ).status,
    ).toBe(201);
    // A corrected address, then a change of who signs, then the booking's waivers end.
    await nameParticipant(
      runtime.db,
      A.id,
      p.booked.bookingId,
      2,
      minor("Quin Private", { name: "Rory Privateguardian", email: "rory.moved@example.test" }),
      hooks,
    );
    await nameParticipant(
      runtime.db,
      A.id,
      p.booked.bookingId,
      2,
      adult("Quin Private", "quin.private@example.test"),
      hooks,
    );
    const needles = [
      "Pria Private",
      "pria.private@example.test",
      "pria   PRIVATE",
      "pria PRIVATE",
      "Quin Private",
      "quin.private@example.test",
      "Rory Privateguardian",
      "rory.private@example.test",
      "rory.moved@example.test",
      FIXTURE_TEXT.title,
      ...FIXTURE_TEXT.body.split("\n").filter((line) => line.length > 0),
      ...FIXTURE_TEXT.acknowledgments,
    ];
    const audit = await admin<{ row: string }[]>`
      select row_to_json(a)::text as row from public.audit_events a
       where a.tenant_id = ${A.id} and (a.action like 'waiver%' or a.subject_type like 'waiver%')`;
    const outbox = await admin<{ row: string }[]>`
      select row_to_json(o)::text as row from public.outbox_events o
       where o.tenant_id = ${A.id} and (o.topic like 'waiver.%' or o.aggregate_type like 'waiver%')`;
    const text = [...audit, ...outbox].map((r) => r.row.toLowerCase());
    expect(audit.length).toBeGreaterThan(5);
    expect(outbox.length).toBeGreaterThan(3);
    expect(needles.filter((n) => text.some((row) => row.includes(n.toLowerCase())))).toEqual([]);
  });
});
