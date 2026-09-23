/**
 * Independent adversarial checks for G2.2 at the API layer. The Hono app runs
 * in Node against a throwaway Neon branch as tidegrid_app, with an injected
 * Access verifier over a local key set and a capturing login-link sender.
 * Fixtures use the admin connection. Tests whose names start with "documents"
 * pin behavior that is by design today. Change them only with a recorded
 * decision.
 */
import { createHash, randomUUID } from "node:crypto";
import type {} from "@tidegrid/database/global-setup";
import { createLocalJWKSet, exportJWK, exportSPKI, generateKeyPair, SignJWT } from "jose";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, inject, it, vi } from "vitest";
import { createApp } from "../src/app.ts";
import { createAccessVerifier } from "../src/auth/access.ts";
import type { LoginLinkSender } from "../src/auth/login-links.ts";

type Sql = ReturnType<typeof postgres>;
type Json = Record<string, unknown> & { error?: { code: string; message: string } };
interface MemberJson {
  member: {
    userId: string;
    email: string;
    displayName: string;
    role: string;
    status: string;
    createdAt: string;
  };
}

const env = inject("integrationDb");
const CONSOLE = "https://console.test";
const TEAM = "tidegrid-test.cloudflareaccess.com";
const AUD = "ab".repeat(32);
const uuidShape = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const sha256Hex = (text: string) => createHash("sha256").update(text).digest("hex");
const nothing = { users: 0, memberships: 0, audits: 0, events: 0 };

describe.skipIf(!env)("adversarial staff API checks as the runtime role", () => {
  let admin: Sql;
  const run = randomUUID().slice(0, 8);
  const tenant = (label: string) => ({
    id: randomUUID(),
    slug: `adv-api-${label}-${run}`,
    name: `Adversarial API ${label} ${run}`,
  });
  const A = tenant("a");
  const B = tenant("b");
  const person = (label: string) => ({ id: randomUUID(), email: `${label}-${run}@example.test` });
  const ownerA = person("adv-owner-a");
  const ownerA2 = person("adv-owner-a2");
  const ownerB = person("adv-owner-b");
  const dual = person("adv-dual"); // owner in A and B
  const racer = person("adv-racer");
  const lapsed = person("adv-lapsed"); // account disabled during a test
  const benched = person("adv-benched"); // owner in A and B; A membership disabled during a test
  const demoted = person("adv-demoted"); // A membership changes during a test
  const cookieUser = person("adv-cookie");
  const kelvin = person("kelvin"); // the address must start with an ASCII "k"
  const retired = person("adv-retired"); // disabled from the start
  const auditor = person("adv-auditor");

  const sent: Array<{ email: string; link: string }> = [];
  const captureSender: LoginLinkSender = {
    async send({ email, link }) {
      sent.push({ email, link });
      return {};
    },
  };

  let signingKey: CryptoKey;
  let rs512Key: CryptoKey;
  let publicPem = "";
  let publicJwkJson = "";
  const kid = `adv-kid-${run}`;
  const rs512Kid = `adv-rs512-${run}`;
  let app: ReturnType<typeof createApp>;
  const pending: Promise<unknown>[] = [];
  const executionCtx = {
    waitUntil: (p: Promise<unknown>) => void pending.push(p),
    passThroughOnException: () => {},
    props: {},
  };
  const bindings = () => ({
    ENVIRONMENT: "local" as const,
    BUILD_ID: "adversarial",
    DATABASE_URL: env?.runtimeUrl,
    ALLOWED_ORIGINS: CONSOLE,
    STAFF_ORIGINS: CONSOLE,
  });

  async function accessToken(
    email: unknown,
    opts: {
      alg?: string;
      kid?: string;
      key?: CryptoKey | Uint8Array;
      claims?: Record<string, unknown>;
      notBefore?: number;
    } = {},
  ): Promise<string> {
    const now = Math.floor(Date.now() / 1000);
    const claims: Record<string, unknown> = { type: "app", ...opts.claims };
    if (email !== null) claims.email = email;
    const jwt = new SignJWT(claims)
      .setProtectedHeader({ alg: opts.alg ?? "RS256", kid: opts.kid ?? kid })
      .setIssuer(`https://${TEAM}`)
      .setAudience(AUD)
      .setSubject(randomUUID())
      .setIssuedAt(now)
      .setExpirationTime(now + 300);
    if (opts.notBefore !== undefined) jwt.setNotBefore(opts.notBefore);
    return jwt.sign(opts.key ?? signingKey);
  }

  interface CallOptions {
    body?: unknown;
    session?: string;
    cookie?: string;
    access?: string;
    origin?: string | null;
    headers?: Record<string, string> | Array<[string, string]>;
  }

  async function call(method: string, path: string, opts: CallOptions = {}) {
    const headers = new Headers(opts.headers);
    if (opts.body !== undefined) headers.set("content-type", "application/json");
    const origin = opts.origin === undefined ? (method === "GET" ? null : CONSOLE) : opts.origin;
    if (origin) headers.set("origin", origin);
    if (opts.session) headers.set("cookie", `__Host-tg_session=${opts.session}`);
    if (opts.cookie !== undefined) headers.set("cookie", opts.cookie);
    if (opts.access) headers.set("cf-access-jwt-assertion", opts.access);
    const res = await app.request(
      `http://localhost${path}`,
      { method, headers, body: opts.body === undefined ? null : JSON.stringify(opts.body) },
      bindings(),
      executionCtx,
    );
    await Promise.allSettled(pending.splice(0));
    const text = await res.text();
    return { res, text, json: (text ? JSON.parse(text) : {}) as Json };
  }

  async function requestLinkToken(email: string): Promise<string> {
    const before = sent.length;
    const requested = await call("POST", "/v1/auth/login-links", { body: { email } });
    expect(requested.res.status).toBe(202);
    const link = sent.slice(before).find((s) => s.email === email)?.link;
    if (!link) throw new Error(`no link sent to ${email}`);
    return new URL(link).hash.replace("#token=", "");
  }

  function sessionFrom(res: Response): string {
    const cookie = res.headers.get("set-cookie") ?? "";
    const session = /__Host-tg_session=([A-Za-z0-9_-]{43})/.exec(cookie)?.[1];
    if (!session) throw new Error("no session cookie");
    return session;
  }

  async function signIn(email: string): Promise<{ session: string; loginToken: string }> {
    const loginToken = await requestLinkToken(email);
    const opened = await call("POST", "/v1/auth/sessions", { body: { token: loginToken } });
    expect(opened.res.status).toBe(201);
    return { session: sessionFrom(opened.res), loginToken };
  }

  const membersPath = (id: string) => `/v1/staff/tenants/${id}/members`;
  const auditPath = (id: string) => `/v1/staff/tenants/${id}/audit-events`;
  const newMember = (label: string) => ({
    email: `adv-new-${label}-${run}@example.test`,
    displayName: `Adversarial ${label}`,
    role: "finance" as const,
    reason: "Adversarial check",
  });

  /** Everything a member creation writes for this address, across all tenants. */
  async function footprint(email: string) {
    const [row] = await admin`select
        (select count(*)::int from public.staff_users where email = ${email}) as users,
        (select count(*)::int from public.tenant_memberships m
           join public.staff_users u on u.id = m.user_id where u.email = ${email}) as memberships,
        (select count(*)::int from public.audit_events a
           join public.staff_users u on a.subject_id = u.id::text where u.email = ${email}) as audits,
        (select count(*)::int from public.outbox_events o
           join public.staff_users u on o.aggregate_id = u.id::text where u.email = ${email}) as events`;
    return row;
  }

  beforeAll(async () => {
    if (!env) return;
    admin = postgres(env.adminUrl, { max: 2, onnotice: () => {} });
    await admin`insert into public.tenants (id, slug, display_name) values
      (${A.id}, ${A.slug}, ${A.name}),
      (${B.id}, ${B.slug}, ${B.name})`;
    const people = [
      ownerA,
      ownerA2,
      ownerB,
      dual,
      racer,
      lapsed,
      benched,
      demoted,
      cookieUser,
      kelvin,
      retired,
      auditor,
    ];
    for (const p of people) {
      await admin`insert into public.staff_users (id, email, display_name, status)
        values (${p.id}, ${p.email}, ${p.email.split("@")[0] ?? "person"},
                ${p === retired ? "disabled" : "active"})`;
    }
    await admin`insert into public.tenant_memberships (tenant_id, user_id, role, display_name) values
      (${A.id}, ${ownerA.id}, 'owner', 'Fixture member'),
      (${A.id}, ${ownerA2.id}, 'owner', 'Fixture member'),
      (${B.id}, ${ownerB.id}, 'owner', 'Fixture member'),
      (${A.id}, ${dual.id}, 'owner', 'Fixture member'),
      (${B.id}, ${dual.id}, 'owner', 'Fixture member'),
      (${A.id}, ${racer.id}, 'booking_staff', 'Fixture member'),
      (${A.id}, ${lapsed.id}, 'owner', 'Fixture member'),
      (${A.id}, ${benched.id}, 'owner', 'Fixture member'),
      (${B.id}, ${benched.id}, 'owner', 'Fixture member'),
      (${A.id}, ${demoted.id}, 'owner', 'Fixture member'),
      (${A.id}, ${cookieUser.id}, 'booking_staff', 'Fixture member'),
      (${A.id}, ${kelvin.id}, 'owner', 'Fixture member'),
      (${A.id}, ${retired.id}, 'owner', 'Fixture member'),
      (${A.id}, ${auditor.id}, 'owner', 'Fixture member')`;

    const pair = await generateKeyPair("RS256", { extractable: true });
    signingKey = pair.privateKey;
    publicPem = await exportSPKI(pair.publicKey);
    const publicJwk = { ...(await exportJWK(pair.publicKey)), kid, alg: "RS256", use: "sig" };
    publicJwkJson = JSON.stringify(publicJwk);
    // A second key in the same set, for an algorithm the verifier must refuse.
    const rs512 = await generateKeyPair("RS512", { extractable: true });
    rs512Key = rs512.privateKey;
    const rs512Jwk = {
      ...(await exportJWK(rs512.publicKey)),
      kid: rs512Kid,
      alg: "RS512",
      use: "sig",
    };
    app = createApp({
      accessVerifier: createAccessVerifier({
        teamDomain: TEAM,
        audience: AUD,
        keys: createLocalJWKSet({ keys: [publicJwk, rs512Jwk] }),
      }),
      loginLinkSender: captureSender,
    });
  });

  afterAll(async () => {
    await admin?.end();
  });

  describe("credentials", () => {
    it("opens exactly one session when six requests race to redeem one sign-in link", async () => {
      const token = await requestLinkToken(racer.email);
      const [before] =
        await admin`select count(*)::int as n from public.staff_sessions where user_id = ${racer.id}`;
      const results = await Promise.all(
        Array.from({ length: 6 }, () => call("POST", "/v1/auth/sessions", { body: { token } })),
      );
      const [after] =
        await admin`select count(*)::int as n from public.staff_sessions where user_id = ${racer.id}`;
      expect({
        statuses: results.map((r) => r.res.status).sort(),
        losers: [
          ...new Set(results.filter((r) => r.res.status !== 201).map((r) => r.json.error?.code)),
        ],
        newSessions: (after?.n ?? 0) - (before?.n ?? 0),
      }).toEqual({
        statuses: [201, 401, 401, 401, 401, 401],
        losers: ["invalid_or_expired_token"],
        newSessions: 1,
      });
      const winner = results.find((r) => r.res.status === 201);
      if (!winner) throw new Error("no winner");
      const me = await call("GET", "/v1/me", { session: sessionFrom(winner.res) });
      expect(me.json.principal).toMatchObject({ userId: racer.id, authMethod: "magic_link" });
    });

    it("shuts a disabled account out of every credential path, and documents that re-enabling revives its sessions", async () => {
      const { session } = await signIn(lapsed.email);
      expect((await call("GET", "/v1/me", { session })).res.status).toBe(200);
      await admin`update public.staff_users set status = 'disabled' where id = ${lapsed.id}`;
      let whileDisabled: unknown;
      try {
        const viaSession = await call("GET", "/v1/me", { session });
        const viaAccess = await call("GET", "/v1/me", { access: await accessToken(lapsed.email) });
        const tenantRoute = await call("GET", membersPath(A.id), { session });
        const sentBefore = sent.length;
        const link = await call("POST", "/v1/auth/login-links", { body: { email: lapsed.email } });
        whileDisabled = {
          session: [viaSession.res.status, viaSession.json.error?.code],
          access: [viaAccess.res.status, viaAccess.json.error?.code],
          tenantRoute: tenantRoute.res.status,
          link: link.res.status,
          linksSent: sent.length - sentBefore,
        };
      } finally {
        await admin`update public.staff_users set status = 'active' where id = ${lapsed.id}`;
      }
      expect(whileDisabled).toEqual({
        session: [401, "session_invalid"],
        access: [403, "not_provisioned"],
        tenantRoute: 401,
        link: 202,
        linksSent: 0,
      });
      // By design today: disabling does not revoke sessions, so this one comes back.
      expect((await call("GET", "/v1/me", { session })).res.status).toBe(200);
    });

    it("accepts a session only from the exact __Host- cookie, only the first of duplicates, and never a login token", async () => {
      const { session } = await signIn(cookieUser.email);
      const unredeemed = await requestLinkToken(cookieUser.email);
      const stranger = "A".repeat(43); // well-formed, never issued
      const cases: Array<[string, string, number, string | undefined]> = [
        ["login token as session", `__Host-tg_session=${unredeemed}`, 401, "session_invalid"],
        ["unprefixed name", `tg_session=${session}`, 401, "unauthenticated"],
        ["__Secure- prefix", `__Secure-tg_session=${session}`, 401, "unauthenticated"],
        ["lowercase prefix", `__host-tg_session=${session}`, 401, "unauthenticated"],
        ["percent-encoded name", `%5F%5FHost-tg_session=${session}`, 401, "unauthenticated"],
        [
          "unknown token first",
          `__Host-tg_session=${stranger}; __Host-tg_session=${session}`,
          401,
          "session_invalid",
        ],
        [
          "real token first",
          `__Host-tg_session=${session}; __Host-tg_session=${stranger}`,
          200,
          undefined,
        ],
        ["padded pair", `theme=dark;   __Host-tg_session=${session}`, 200, undefined],
      ];
      const observed = [];
      for (const [label, cookie] of cases) {
        const r = await call("GET", "/v1/me", { cookie });
        observed.push({ label, status: r.res.status, code: r.json.error?.code });
      }
      expect(observed).toEqual(cases.map(([label, , status, code]) => ({ label, status, code })));

      // The reverse confusion fails too, and neither attempt burned a credential.
      const sessionAsLink = await call("POST", "/v1/auth/sessions", { body: { token: session } });
      const redeemed = await call("POST", "/v1/auth/sessions", { body: { token: unredeemed } });
      const stillSignedIn = await call("GET", "/v1/me", { session });
      expect({
        sessionAsLink: [sessionAsLink.res.status, sessionAsLink.json.error?.code],
        redeemed: redeemed.res.status,
        stillSignedIn: stillSignedIn.res.status,
      }).toEqual({
        sessionAsLink: [401, "invalid_or_expired_token"],
        redeemed: 201,
        stillSignedIn: 200,
      });
    });

    it("rejects algorithm confusion, unknown and wrong-algorithm keys, org tokens, and early tokens", async () => {
      const control = await call("GET", "/v1/me", { access: await accessToken(ownerA.email) });
      expect(control.res.status).toBe(200);
      const encoder = new TextEncoder();
      const now = Math.floor(Date.now() / 1000);
      const forged: Array<[string, string]> = [
        [
          "HS256 keyed with the RSA public key PEM",
          await accessToken(ownerA.email, { alg: "HS256", key: encoder.encode(publicPem) }),
        ],
        [
          "HS256 keyed with the public JWK",
          await accessToken(ownerA.email, { alg: "HS256", key: encoder.encode(publicJwkJson) }),
        ],
        ["kid outside the key set", await accessToken(ownerA.email, { kid: `unknown-${run}` })],
        [
          "RS512 key that is in the set",
          await accessToken(ownerA.email, { alg: "RS512", kid: rs512Kid, key: rs512Key }),
        ],
        ["org token type", await accessToken(ownerA.email, { claims: { type: "org" } })],
        ["not valid yet", await accessToken(ownerA.email, { notBefore: now + 600 })],
        ["email claim as an array", await accessToken([ownerA.email])],
        ["space inside the address", await accessToken(ownerA.email.replace("@", " @"))],
      ];
      const observed = [];
      for (const [label, token] of forged) {
        const r = await call("GET", "/v1/me", { access: token });
        observed.push({ label, status: r.res.status, code: r.json.error?.code });
      }
      expect(observed).toEqual(
        forged.map(([label]) => ({ label, status: 401, code: "invalid_access_token" })),
      );

      // Surrounding whitespace and ASCII case are normalized by design.
      const padded = await call("GET", "/v1/me", {
        access: await accessToken(`  ${ownerA.email.toUpperCase()}\t`),
      });
      expect(padded.json.principal).toMatchObject({ userId: ownerA.id, authMethod: "access" });
      // A valid assertion for a disabled account is refused after verification.
      const refused = await call("GET", "/v1/me", { access: await accessToken(retired.email) });
      expect({ status: refused.res.status, code: refused.json.error?.code }).toEqual({
        status: 403,
        code: "not_provisioned",
      });
    });

    it("does not map a Unicode lookalike Access email onto an ASCII staff account", async () => {
      // U+212A KELVIN SIGN lowercases to ASCII "k" in JavaScript and in PostgreSQL,
      // so a different address would sign in as this owner. Access emails must be
      // ASCII, so the assertion is refused before any lookup.
      const lookalike = `K${kelvin.email.slice(1)}`;
      expect(lookalike).not.toBe(kelvin.email);
      const token = await accessToken(lookalike);
      const me = await call("GET", "/v1/me", { access: token });
      const members = await call("GET", membersPath(A.id), { access: token });
      expect({
        me: me.res.status,
        principal: me.json.principal,
        members: members.res.status,
      }).toEqual({ me: 401, principal: undefined, members: 401 });
    });
  });

  describe("tenant authorization", () => {
    it("answers a disabled membership exactly like a missing tenant on every staff route and drops it from /v1/me", async () => {
      const { session } = await signIn(benched.email);
      await admin`update public.tenant_memberships set status = 'disabled'
        where tenant_id = ${A.id} and user_id = ${benched.id}`;
      const access = await accessToken(benched.email);
      const missing = await call("GET", membersPath(randomUUID()), { access });
      expect(missing.res.status).toBe(404);
      const planted = newMember("benched");
      const routes: Array<[string, string]> = [
        ["GET", membersPath(A.id)],
        ["GET", auditPath(A.id)],
        ["POST", membersPath(A.id)],
      ];
      const observed = [];
      const expected = [];
      for (const [authLabel, auth] of [
        ["access", { access }],
        ["session", { session }],
      ] as const) {
        for (const [method, path] of routes) {
          const r = await call(method, path, {
            ...auth,
            headers: { "idempotency-key": `benched-${randomUUID()}` },
            body: method === "POST" ? planted : undefined,
          });
          const label = `${authLabel} ${method} ${path}`;
          observed.push({ label, status: r.res.status, body: r.json.error?.message });
          expected.push({ label, status: 404, body: missing.json.error?.message });
        }
      }
      expect(observed).toEqual(expected);
      const me = await call("GET", "/v1/me", { session });
      const memberships = (me.json.memberships as Array<{ tenantId: string }>).map(
        (m) => m.tenantId,
      );
      const otherTenant = await call("GET", membersPath(B.id), { session });
      expect({
        memberships,
        otherTenant: otherTenant.res.status,
        footprint: await footprint(planted.email),
      }).toEqual({ memberships: [B.id], otherTenant: 200, footprint: nothing });
    });

    it("answers non-canonical and traversal-shaped tenant ids with the missing-tenant 404 and writes nothing", async () => {
      const access = await accessToken(ownerA.email);
      const missing = await call("GET", membersPath(randomUUID()), { access });
      const planted = newMember("spelling");
      const spellings = [
        A.id.toUpperCase(),
        encodeURIComponent(` ${A.id}`),
        encodeURIComponent(`${A.id} `),
        encodeURIComponent(`{${A.id}}`),
        A.id.replaceAll("-", ""),
        encodeURIComponent(`${A.id}\n`),
        encodeURIComponent(`${A.id}\u0000`),
        encodeURIComponent(`../${B.id}`),
        `..%252F${B.id}`,
        encodeURIComponent(`${A.id}/../${A.id}`),
      ];
      const observed = [];
      const expected = [];
      for (const spelling of spellings) {
        for (const [method, path] of [
          ["GET", membersPath(spelling)],
          ["GET", auditPath(spelling)],
          ["POST", membersPath(spelling)],
        ] as const) {
          const r = await call(method, path, {
            access,
            headers: { "idempotency-key": `spelling-${randomUUID()}` },
            body: method === "POST" ? planted : undefined,
          });
          observed.push({ method, path, status: r.res.status, code: r.json.error?.code });
          expected.push({ method, path, status: 404, code: missing.json.error?.code });
        }
      }
      expect(observed).toEqual(expected);
      expect(await footprint(planted.email)).toEqual(nothing);
    });

    it("ignores tenant and identity fields smuggled into the member body and rejects roles outside the enum", async () => {
      const access = await accessToken(ownerA.email);
      const smuggled = {
        ...newMember("smuggled"),
        tenantId: B.id,
        tenant_id: B.id,
        userId: ownerB.id,
        user_id: ownerB.id,
        status: "disabled",
        actorId: ownerB.id,
      };
      const created = await call("POST", membersPath(A.id), {
        access,
        headers: { "idempotency-key": `smuggle-${run}` },
        body: smuggled,
      });
      expect(created.res.status).toBe(201);
      const member = (created.json as unknown as MemberJson).member;
      expect(member).toMatchObject({ email: smuggled.email, role: "finance", status: "active" });
      expect(member.userId).not.toBe(ownerB.id);
      const placed = await admin`select m.tenant_id, m.status, a.actor_id
        from public.tenant_memberships m
        left join public.audit_events a on a.tenant_id = m.tenant_id and a.subject_id = m.user_id::text
        where m.user_id = ${member.userId}`;
      const [ownerBInA] = await admin`select count(*)::int as n from public.tenant_memberships
        where tenant_id = ${A.id} and user_id = ${ownerB.id}`;
      expect({
        placed: placed.map((r) => [r.tenant_id, r.status, r.actor_id]),
        ownerBInA: ownerBInA?.n,
      }).toEqual({ placed: [[A.id, "active", ownerA.id]], ownerBInA: 0 });

      const badRoles: unknown[] = [
        "admin",
        "OWNER",
        " owner",
        "owner ",
        "booking-staff",
        "",
        null,
        ["owner"],
        { role: "owner" },
      ];
      const body = newMember("bad-role");
      const observed = [];
      for (const role of badRoles) {
        const r = await call("POST", membersPath(A.id), {
          access,
          headers: { "idempotency-key": `role-${randomUUID()}` },
          body: { ...body, role },
        });
        observed.push({ role, status: r.res.status, code: r.json.error?.code });
      }
      expect(observed).toEqual(
        badRoles.map((role) => ({ role, status: 400, code: "validation_failed" })),
      );
      expect(await footprint(body.email)).toEqual(nothing);
    });
  });

  describe("idempotency", () => {
    it("never replays one owner's stored response to another owner who reuses the key", async () => {
      const body = newMember("borrowed-key");
      const key = `borrowed-${run}`;
      const first = await call("POST", membersPath(A.id), {
        access: await accessToken(ownerA.email),
        headers: { "idempotency-key": key },
        body,
      });
      expect(first.res.status).toBe(201);
      const second = await call("POST", membersPath(A.id), {
        access: await accessToken(ownerA2.email),
        headers: { "idempotency-key": key },
        body,
      });
      const stored = await admin`select principal, status from public.idempotency_keys
        where tenant_id = ${A.id} and key = ${key}`;
      expect({
        status: second.res.status,
        code: second.json.error?.code,
        replayed: second.res.headers.get("idempotent-replayed"),
        stored: stored.map((r) => [r.principal, r.status]),
      }).toEqual({
        status: 409,
        code: "member_exists",
        replayed: null,
        stored: [[`staff:${ownerA.id}`, "completed"]],
      });
    });

    it("re-checks membership and role before replaying a stored response", async () => {
      const body = newMember("recheck");
      const key = `recheck-${run}`;
      const post = async () =>
        call("POST", membersPath(A.id), {
          access: await accessToken(demoted.email),
          headers: { "idempotency-key": key },
          body,
        });
      const first = await post();
      expect(first.res.status).toBe(201);
      const setMembership = (status: string, role: string) =>
        admin`update public.tenant_memberships set status = ${status}, role = ${role}
          where tenant_id = ${A.id} and user_id = ${demoted.id}`;
      const observed = [];
      try {
        for (const [status, role] of [
          ["disabled", "owner"],
          ["active", "finance"],
          ["active", "booking_staff"],
        ] as const) {
          await setMembership(status, role);
          const r = await post();
          observed.push({
            status,
            role,
            http: r.res.status,
            code: r.json.error?.code,
            replayed: r.res.headers.get("idempotent-replayed"),
          });
        }
      } finally {
        await setMembership("active", "owner");
      }
      expect(observed).toEqual([
        { status: "disabled", role: "owner", http: 404, code: "tenant_not_found", replayed: null },
        { status: "active", role: "finance", http: 403, code: "forbidden", replayed: null },
        { status: "active", role: "booking_staff", http: 403, code: "forbidden", replayed: null },
      ]);
      // Control: the stored response was there all along. Replays are deep-equal,
      // not byte-equal: response_body is jsonb, which reorders object keys.
      const restored = await post();
      expect({
        status: restored.res.status,
        replayed: restored.res.headers.get("idempotent-replayed"),
        body: restored.json,
      }).toEqual({ status: 201, replayed: "true", body: first.json });
    });

    it("keeps one principal's concurrent same-key requests to two tenants independent", async () => {
      const body = newMember("twin");
      const key = `twin-${run}`;
      const access = await accessToken(dual.email);
      const post = (tenantId: string) =>
        call("POST", membersPath(tenantId), { access, headers: { "idempotency-key": key }, body });
      const [inA, inB] = await Promise.all([post(A.id), post(B.id)]);
      expect({
        statuses: [inA.res.status, inB.res.status],
        replayed: [
          inA.res.headers.get("idempotent-replayed"),
          inB.res.headers.get("idempotent-replayed"),
        ],
      }).toEqual({ statuses: [201, 201], replayed: [null, null] });
      const userId = (inA.json as unknown as MemberJson).member.userId;
      expect((inB.json as unknown as MemberJson).member.userId).toBe(userId);

      const audits = await admin`select tenant_id, actor_id, request_id from public.audit_events
        where subject_id = ${userId} order by tenant_id`;
      const events = await admin`select tenant_id, payload from public.outbox_events
        where aggregate_id = ${userId}`;
      const keys = await admin`select k.tenant_id, k.response_body, m.created_at
        from public.idempotency_keys k
        join public.tenant_memberships m on m.tenant_id = k.tenant_id and m.user_id = ${userId}
        where k.key = ${key} and k.principal = ${`staff:${dual.id}`}`;
      const [created] = await admin`select count(*)::int as n from public.security_events
        where kind = 'staff_user_created' and user_id = ${userId}`;
      const requestIdFor = (t: string) => (t === A.id ? inA : inB).res.headers.get("x-request-id");
      expect({
        audits: audits.map((r) => [
          r.tenant_id,
          r.actor_id,
          r.request_id === requestIdFor(r.tenant_id),
        ]),
        eventsMatchTenant: events.map((e) => e.payload.tenantId === e.tenant_id),
        storedMatchesTenant: keys.map(
          (k) => k.response_body.member.createdAt === new Date(k.created_at).toISOString(),
        ),
        identitiesCreated: created?.n,
      }).toEqual({
        audits: [A.id, B.id].sort().map((t) => [t, dual.id, true]),
        eventsMatchTenant: [true, true],
        storedMatchesTenant: [true, true],
        identitiesCreated: 1,
      });

      // Each tenant replays its own stored response (deep-equal; jsonb reorders keys).
      const [replayA, replayB] = [await post(A.id), await post(B.id)];
      expect({
        a: [replayA.res.headers.get("idempotent-replayed"), replayA.json],
        b: [replayB.res.headers.get("idempotent-replayed"), replayB.json],
      }).toEqual({ a: ["true", inA.json], b: ["true", inB.json] });
    });

    it("accepts idempotency keys only inside the contract's length and alphabet", async () => {
      const access = await accessToken(ownerA.email);
      const longest = "k".repeat(255);
      const ok = await call("POST", membersPath(A.id), {
        access,
        headers: { "idempotency-key": longest },
        body: newMember("longest-key"),
      });
      expect(ok.res.status).toBe(201);
      const rejected: Array<[string, Record<string, string> | Array<[string, string]>]> = [
        ["seven characters", { "idempotency-key": "k".repeat(7) }],
        ["256 characters", { "idempotency-key": "k".repeat(256) }],
        ["Latin-1 letter", { "idempotency-key": "clé-12345678" }],
        ["space inside", { "idempotency-key": "key 12345678" }],
        ["slash inside", { "idempotency-key": "key/12345678" }],
        [
          "two key headers",
          [
            ["idempotency-key", "first-12345678"],
            ["idempotency-key", "second-12345678"],
          ],
        ],
      ];
      const body = newMember("bad-key");
      const observed = [];
      for (const [label, headers] of rejected) {
        const r = await call("POST", membersPath(A.id), { access, headers, body });
        observed.push({ label, status: r.res.status, code: r.json.error?.code });
      }
      expect(observed).toEqual(
        rejected.map(([label]) => ({ label, status: 400, code: "validation_failed" })),
      );
      expect(await footprint(body.email)).toEqual(nothing);
    });

    it("executes once when two keys race to add the same person, and the loser leaves nothing behind", async () => {
      const body = newMember("contested");
      const access = await accessToken(ownerA.email);
      const keys = [`contest-1-${run}`, `contest-2-${run}`] as const;
      const post = (key: string) =>
        call("POST", membersPath(A.id), { access, headers: { "idempotency-key": key }, body });
      const results = await Promise.all(keys.map(post));
      expect(results.map((r) => r.res.status).sort()).toEqual([201, 409]);
      const winner = results[0]?.res.status === 201 ? keys[0] : keys[1];
      const loser = winner === keys[0] ? keys[1] : keys[0];
      const stored = await admin`select key, status from public.idempotency_keys
        where tenant_id = ${A.id} and key in (${keys[0]}, ${keys[1]})`;
      const [identity] = await admin`select count(*)::int as n from public.security_events s
        join public.staff_users u on u.id = s.user_id
        where s.kind = 'staff_user_created' and u.email = ${body.email}`;
      expect({
        footprint: await footprint(body.email),
        stored: stored.map((r) => [r.key, r.status]),
        identityEvents: identity?.n,
      }).toEqual({
        footprint: { users: 1, memberships: 1, audits: 1, events: 1 },
        stored: [[winner, "completed"]],
        identityEvents: 1,
      });
      const [retryLoser, replayWinner] = [await post(loser), await post(winner)];
      expect({
        loser: [retryLoser.res.status, retryLoser.res.headers.get("idempotent-replayed")],
        winner: [replayWinner.res.status, replayWinner.res.headers.get("idempotent-replayed")],
      }).toEqual({ loser: [409, null], winner: [201, "true"] });
    });
  });

  describe("rollback and audit", () => {
    it("rolls back the new identity and every other write when a later statement fails", async () => {
      // Fault injection: the outbox insert, the last write before the key is
      // completed, fails after the identity, membership, and audit rows exist.
      const body = newMember("late-failure");
      const key = `late-failure-${run}`;
      const access = await accessToken(ownerA.email);
      const fn = `adv_fail_outbox_${run.replaceAll("-", "_")}`;
      await admin.unsafe(`create function public.${fn}() returns trigger language plpgsql
        as $$ begin raise exception 'injected outbox failure'; end $$`);
      await admin.unsafe(`create trigger ${fn} before insert on public.outbox_events
        for each row when (new.tenant_id = '${A.id}') execute function public.${fn}()`);
      let failed: Awaited<ReturnType<typeof call>>;
      try {
        failed = await call("POST", membersPath(A.id), {
          access,
          headers: { "idempotency-key": key },
          body,
        });
      } finally {
        await admin.unsafe(`drop trigger if exists ${fn} on public.outbox_events`);
        await admin.unsafe(`drop function if exists public.${fn}()`);
      }
      const [keys] = await admin`select count(*)::int as n from public.idempotency_keys
        where tenant_id = ${A.id} and key = ${key}`;
      expect({
        status: failed.res.status,
        code: failed.json.error?.code,
        footprint: await footprint(body.email),
        keys: keys?.n,
      }).toEqual({ status: 500, code: "internal_error", footprint: nothing, keys: 0 });
      // Nothing was burned: the same key and body now execute exactly once.
      const retried = await call("POST", membersPath(A.id), {
        access,
        headers: { "idempotency-key": key },
        body,
      });
      expect(retried.res.status).toBe(201);
      expect(retried.res.headers.get("idempotent-replayed")).toBeNull();
      expect(await footprint(body.email)).toEqual({
        users: 1,
        memberships: 1,
        audits: 1,
        events: 1,
      });
    });

    it("answers a NUL byte in a member field as a validation error, not a server error", async () => {
      const access = await accessToken(ownerA.email);
      const observed = [];
      for (const field of ["displayName", "reason"] as const) {
        const body = { ...newMember(`nul-only-${field}`), [field]: "Night\u0000shift" };
        const r = await call("POST", membersPath(A.id), {
          access,
          headers: { "idempotency-key": `nul-only-${field}-${run}` },
          body,
        });
        observed.push({ field, status: r.res.status, code: r.json.error?.code });
      }
      expect(observed).toEqual([
        { field: "displayName", status: 400, code: "validation_failed" },
        { field: "reason", status: 400, code: "validation_failed" },
      ]);
    });

    it("records actor, request id, and trimmed reason for a cookie session and keeps credentials out of every table and log", async () => {
      const logs: string[] = [];
      const spy = vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
        logs.push(args.map(String).join(" "));
      });
      const supplied = `adv-audit-${run}`;
      const forgedId = "bad id; drop table";
      let secrets: string[] = [];
      let responses: string[] = [];
      let observed: unknown;
      let serverId = "";
      try {
        const { session, loginToken } = await signIn(auditor.email);
        secrets = [loginToken, sha256Hex(loginToken), session, sha256Hex(session)];
        const first = await call("POST", membersPath(A.id), {
          session,
          headers: { "idempotency-key": `audit-1-${run}`, "x-request-id": supplied },
          body: { ...newMember("audited"), reason: "  Night shift cover  " },
        });
        const second = await call("POST", membersPath(A.id), {
          session,
          headers: { "idempotency-key": `audit-2-${run}`, "x-request-id": forgedId },
          body: newMember("audited-2"),
        });
        const history = await call("GET", `${auditPath(A.id)}?limit=100`, { session });
        const signOut = await call("DELETE", "/v1/auth/sessions/current", { session });
        serverId = second.res.headers.get("x-request-id") ?? "";
        const subjects = [first, second].map(
          (r) => (r.json as unknown as MemberJson).member.userId,
        );
        const audits = await admin`select actor_type, actor_id, request_id, reason
          from public.audit_events where tenant_id = ${A.id} and subject_id in ${admin(subjects)}
          order by id`;
        observed = {
          statuses: [first.res.status, second.res.status, history.res.status, signOut.res.status],
          echoed: first.res.headers.get("x-request-id"),
          audits,
        };
        responses = [first.text, second.text, history.text];
      } finally {
        spy.mockRestore();
      }
      // Request ids are server-issued; a caller-supplied value is ignored.
      const firstId = String((observed as { echoed?: unknown }).echoed);
      expect(firstId).toMatch(uuidShape);
      expect(firstId).not.toBe(supplied);
      expect(serverId).toMatch(uuidShape);
      expect(observed).toEqual({
        statuses: [201, 201, 200, 204],
        echoed: firstId,
        audits: [
          {
            actor_type: "staff",
            actor_id: auditor.id,
            request_id: firstId,
            reason: "Night shift cover",
          },
          {
            actor_type: "staff",
            actor_id: auditor.id,
            request_id: serverId,
            reason: "Adversarial check",
          },
        ],
      });

      const rows = await admin`
        select row_to_json(a)::text as j from public.audit_events a where a.tenant_id = ${A.id}
        union all
        select row_to_json(o)::text from public.outbox_events o where o.tenant_id = ${A.id}
        union all
        select row_to_json(k)::text from public.idempotency_keys k where k.tenant_id = ${A.id}
        union all
        select row_to_json(s)::text from public.security_events s where s.user_id = ${auditor.id}`;
      const corpus = [...rows.map((r) => String(r.j)), ...logs, ...responses];
      // Non-vacuous: the scan covers this user's rows and request logs.
      expect(corpus.filter((line) => line.includes(auditor.id)).length).toBeGreaterThan(3);
      expect(logs.some((line) => line.includes(auditor.id))).toBe(true);
      const leaks = secrets.flatMap((secret, i) =>
        corpus.filter((line) => line.includes(secret)).map((line) => `${i}: ${line.slice(0, 160)}`),
      );
      expect(leaks).toEqual([]);
    });

    it("keeps each tenant's own name for a shared identity and shows neither to the other", async () => {
      // Identities are global; names live on memberships. Adding an address that
      // already has an identity reveals nothing another tenant chose.
      const email = `adv-shared-identity-${run}@example.test`;
      const inB = await call("POST", membersPath(B.id), {
        access: await accessToken(ownerB.email),
        headers: { "idempotency-key": `identity-b-${run}` },
        body: { email, displayName: "Chosen By Tenant B", role: "booking_staff", reason: "Hire" },
      });
      const inA = await call("POST", membersPath(A.id), {
        access: await accessToken(ownerA.email),
        headers: { "idempotency-key": `identity-a-${run}` },
        body: { email, displayName: "Chosen By Tenant A", role: "finance", reason: "Hire" },
      });
      const a = (inA.json as unknown as MemberJson).member;
      const b = (inB.json as unknown as MemberJson).member;
      const listB = await call("GET", membersPath(B.id), {
        access: await accessToken(ownerB.email),
      });
      const seenByB = (listB.json.members as Array<{ userId: string; displayName: string }>).find(
        (m) => m.userId === b.userId,
      )?.displayName;
      expect({
        statuses: [inB.res.status, inA.res.status],
        sameIdentity: a.userId === b.userId,
        nameSeenByA: a.displayName,
        nameSeenByB: seenByB,
      }).toEqual({
        statuses: [201, 201],
        sameIdentity: true,
        nameSeenByA: "Chosen By Tenant A",
        nameSeenByB: "Chosen By Tenant B",
      });
    });
  });
});
