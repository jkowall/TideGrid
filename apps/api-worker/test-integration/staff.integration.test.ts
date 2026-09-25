import { randomUUID } from "node:crypto";
import type {} from "@tidegrid/database/global-setup";
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT } from "jose";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";
import { createApp } from "../src/app.ts";
import { createAccessVerifier } from "../src/auth/access.ts";
import type { LoginLinkSender } from "../src/auth/login-links.ts";
import type { Bindings } from "../src/env.ts";
import { markConsoleGateway } from "../src/gateway.ts";

type Sql = ReturnType<typeof postgres>;
type Json = Record<string, unknown> & { error?: { code: string; message: string } };

const env = inject("integrationDb");
const CONSOLE = "https://console.test";
const TEAM = "tidegrid-test.cloudflareaccess.com";
const AUD = "ab".repeat(32);

describe.skipIf(!env)("staff API against a real database as the runtime role", () => {
  let admin: Sql;
  const run = randomUUID().slice(0, 8);
  const tenant = (label: string) => ({
    id: randomUUID(),
    slug: `api-${label}-${run}`,
    name: `API ${label} ${run}`,
  });
  const A = tenant("a");
  const B = tenant("b");
  const C = tenant("c"); // suspended
  const person = (label: string) => ({ id: randomUUID(), email: `${label}-${run}@example.test` });
  const ownerA = person("owner-a");
  const ownerB = person("owner-b");
  const staffA = person("staff-a");
  const financeA = person("finance-a");
  const limited = person("limited");
  const previewHost = `${A.slug}.book.example.test`;

  const sent: Array<{ email: string; link: string }> = [];
  const captureSender: LoginLinkSender = {
    async send({ email, link }) {
      sent.push({ email, link });
      return {};
    },
  };

  let signingKey: CryptoKey;
  let foreignKey: CryptoKey;
  const kid = `kid-${run}`;
  let app: ReturnType<typeof createApp>;
  const pending: Promise<unknown>[] = [];
  const executionCtx = {
    waitUntil: (p: Promise<unknown>) => void pending.push(p),
    passThroughOnException: () => {},
    props: {},
  };
  const bindings = () => ({
    ENVIRONMENT: "local" as const,
    BUILD_ID: "integration",
    DATABASE_URL: env?.runtimeUrl ?? "",
    ALLOWED_ORIGINS: CONSOLE,
    STAFF_ORIGINS: CONSOLE,
  });

  async function accessToken(
    email: string | null,
    overrides: { audience?: string; issuer?: string; expired?: boolean; key?: CryptoKey } = {},
  ): Promise<string> {
    const claims: Record<string, unknown> = { type: "app" };
    if (email !== null) claims.email = email;
    const now = Math.floor(Date.now() / 1000);
    return new SignJWT(claims)
      .setProtectedHeader({ alg: "RS256", kid })
      .setIssuer(overrides.issuer ?? `https://${TEAM}`)
      .setAudience(overrides.audience ?? AUD)
      .setSubject(randomUUID())
      .setIssuedAt(overrides.expired ? now - 600 : now)
      .setExpirationTime(overrides.expired ? now - 300 : now + 300)
      .sign(overrides.key ?? signingKey);
  }

  interface CallOptions {
    body?: unknown;
    session?: string;
    access?: string;
    origin?: string | null;
    headers?: Record<string, string>;
    env?: Bindings;
  }

  async function call(method: string, path: string, opts: CallOptions = {}) {
    const headers = new Headers(opts.headers);
    if (opts.body !== undefined) headers.set("content-type", "application/json");
    const origin = opts.origin === undefined ? (method === "GET" ? null : CONSOLE) : opts.origin;
    if (origin) headers.set("origin", origin);
    if (opts.session) headers.set("cookie", `__Host-tg_session=${opts.session}`);
    if (opts.access) headers.set("cf-access-jwt-assertion", opts.access);
    const res = await app.request(
      `http://localhost${path}`,
      { method, headers, body: opts.body === undefined ? null : JSON.stringify(opts.body) },
      opts.env ?? bindings(),
      executionCtx,
    );
    await Promise.allSettled(pending.splice(0));
    const text = await res.text();
    return { res, json: (text ? JSON.parse(text) : {}) as Json };
  }

  async function signIn(email: string): Promise<string> {
    const before = sent.length;
    const requested = await call("POST", "/v1/auth/login-links", { body: { email } });
    expect(requested.res.status).toBe(202);
    const link = sent.slice(before).find((s) => s.email === email)?.link;
    if (!link) throw new Error(`no link sent to ${email}`);
    const token = new URL(link).hash.replace("#token=", "");
    const opened = await call("POST", "/v1/auth/sessions", { body: { token } });
    expect(opened.res.status).toBe(201);
    const cookie = opened.res.headers.get("set-cookie") ?? "";
    const session = /__Host-tg_session=([A-Za-z0-9_-]{43})/.exec(cookie)?.[1];
    if (!session) throw new Error("no session cookie");
    return session;
  }

  const membersPath = (id: string) => `/v1/staff/tenants/${id}/members`;
  const auditPath = (id: string) => `/v1/staff/tenants/${id}/audit-events`;

  beforeAll(async () => {
    if (!env) return;
    admin = postgres(env.adminUrl, { max: 2, onnotice: () => {} });
    await admin`insert into public.tenants (id, slug, display_name, status) values
      (${A.id}, ${A.slug}, ${A.name}, 'active'),
      (${B.id}, ${B.slug}, ${B.name}, 'active'),
      (${C.id}, ${C.slug}, ${C.name}, 'suspended')`;
    for (const p of [ownerA, ownerB, staffA, financeA, limited]) {
      await admin`insert into public.staff_users (id, email, display_name)
        values (${p.id}, ${p.email}, ${p.email.split("@")[0] ?? "person"})`;
    }
    await admin`insert into public.tenant_memberships (tenant_id, user_id, role, display_name) values
      (${A.id}, ${ownerA.id}, 'owner', 'Fixture member'),
      (${A.id}, ${staffA.id}, 'booking_staff', 'Fixture member'),
      (${A.id}, ${financeA.id}, 'finance', 'Fixture member'),
      (${A.id}, ${limited.id}, 'booking_staff', 'Fixture member'),
      (${B.id}, ${ownerB.id}, 'owner', 'Fixture member'),
      (${C.id}, ${ownerA.id}, 'owner', 'Fixture member')`;
    await admin`insert into public.tenant_hostnames (hostname, tenant_id, kind, status, verified_at)
      values (${previewHost}, ${A.id}, 'preview', 'active', now())`;

    const pair = await generateKeyPair("RS256", { extractable: true });
    signingKey = pair.privateKey;
    foreignKey = (await generateKeyPair("RS256")).privateKey;
    const jwk = { ...(await exportJWK(pair.publicKey)), kid, alg: "RS256", use: "sig" };
    app = createApp({
      accessVerifier: createAccessVerifier({
        teamDomain: TEAM,
        audience: AUD,
        keys: createLocalJWKSet({ keys: [jwk] }),
      }),
      loginLinkSender: captureSender,
    });
  });

  afterAll(async () => {
    await admin?.end();
  });

  describe("magic-link sign-in", () => {
    it("issues a fragment link, opens a hardened session once, and signs out", async () => {
      const before = sent.length;
      const requested = await call("POST", "/v1/auth/login-links", {
        body: { email: ownerA.email.toUpperCase() },
      });
      expect(requested.res.status).toBe(202);
      expect(requested.json).toEqual({ status: "accepted" });
      const link = sent.slice(before)[0]?.link ?? "";
      expect(link).toMatch(/^https:\/\/console\.test\/login#token=[A-Za-z0-9_-]{43}$/);
      const token = new URL(link).hash.replace("#token=", "");

      const opened = await call("POST", "/v1/auth/sessions", { body: { token } });
      expect(opened.res.status).toBe(201);
      expect(opened.json.principal).toMatchObject({
        email: ownerA.email,
        authMethod: "magic_link",
      });
      const cookie = opened.res.headers.get("set-cookie") ?? "";
      for (const attribute of [
        "__Host-tg_session=",
        "HttpOnly",
        "Secure",
        "SameSite=Strict",
        "Path=/",
      ]) {
        expect(cookie).toContain(attribute);
      }
      expect(cookie).not.toMatch(/Domain=/i);
      const session = /__Host-tg_session=([A-Za-z0-9_-]{43})/.exec(cookie)?.[1] ?? "";

      const replayed = await call("POST", "/v1/auth/sessions", { body: { token } });
      expect(replayed.res.status).toBe(401);
      expect(replayed.json.error?.code).toBe("invalid_or_expired_token");

      const me = await call("GET", "/v1/me", { session });
      expect(me.res.status).toBe(200);
      expect(me.json.memberships).toEqual([
        { tenantId: A.id, tenantSlug: A.slug, tenantName: A.name, role: "owner" },
      ]);

      const out = await call("DELETE", "/v1/auth/sessions/current", { session });
      expect(out.res.status).toBe(204);
      expect(out.res.headers.get("set-cookie") ?? "").toMatch(/__Host-tg_session=;.*Max-Age=0/);
      const after = await call("GET", "/v1/me", { session });
      expect(after.res.status).toBe(401);
      expect(after.json.error?.code).toBe("session_invalid");
    });

    it("answers identically for unknown addresses and sends nothing", async () => {
      const before = sent.length;
      const unknown = await call("POST", "/v1/auth/login-links", {
        body: { email: `nobody-${run}@example.test` },
      });
      expect(unknown.res.status).toBe(202);
      expect(unknown.json).toEqual({ status: "accepted" });
      expect(sent.length).toBe(before);
    });

    it("stops sending after five links in fifteen minutes without changing the answer", async () => {
      const before = sent.length;
      for (let i = 0; i < 6; i++) {
        const r = await call("POST", "/v1/auth/login-links", { body: { email: limited.email } });
        expect(r.res.status).toBe(202);
      }
      expect(sent.length - before).toBe(5);
    });

    it("rejects malformed tokens by contract", async () => {
      const r = await call("POST", "/v1/auth/sessions", { body: { token: "short" } });
      expect(r.res.status).toBe(400);
      expect(r.json.error?.code).toBe("validation_failed");
    });
  });

  describe("Cloudflare Access sign-in", () => {
    it("maps a verified assertion to the staff account, case-insensitively", async () => {
      const r = await call("GET", "/v1/me", {
        access: await accessToken(ownerA.email.toUpperCase()),
      });
      expect(r.res.status).toBe(200);
      expect(r.json.principal).toMatchObject({ userId: ownerA.id, authMethod: "access" });
    });

    it("refuses identities without a staff account", async () => {
      const r = await call("GET", "/v1/me", {
        access: await accessToken(`stranger-${run}@example.test`),
      });
      expect(r.res.status).toBe(403);
      expect(r.json.error?.code).toBe("not_provisioned");
    });

    it("rejects wrong audience, wrong issuer, expiry, foreign keys, and missing email", async () => {
      const bad = [
        await accessToken(ownerA.email, { audience: "cd".repeat(32) }),
        await accessToken(ownerA.email, { issuer: "https://other.cloudflareaccess.com" }),
        await accessToken(ownerA.email, { expired: true }),
        await accessToken(ownerA.email, { key: foreignKey }),
        await accessToken(null),
        "eyJhbGciOiJub25lIiwidHlwIjoiSldUIn0.eyJlbWFpbCI6ImFAYi5jIn0.",
      ];
      for (const token of bad) {
        const r = await call("GET", "/v1/me", { access: token });
        expect(r.res.status).toBe(401);
        expect(r.json.error?.code).toBe("invalid_access_token");
      }
    });

    it("prefers the Access identity over a session cookie", async () => {
      const staffSession = await signIn(staffA.email);
      const r = await call("GET", "/v1/me", {
        session: staffSession,
        access: await accessToken(ownerB.email),
      });
      expect(r.json.principal).toMatchObject({ userId: ownerB.id, authMethod: "access" });
    });
  });

  describe("console gateway", () => {
    const deployed = (): Bindings => ({ ...bindings(), ENVIRONMENT: "preview" });

    it("hides staff and sign-in routes on a deployed public entry", async () => {
      const token = await accessToken(ownerA.email);
      for (const [method, path] of [
        ["GET", "/v1/me"],
        ["GET", membersPath(A.id)],
        ["POST", "/v1/auth/login-links"],
      ] as const) {
        const r = await call(method, path, {
          access: token,
          env: deployed(),
          ...(method === "POST" ? { body: { email: ownerA.email } } : {}),
        });
        expect({ path, status: r.res.status, code: r.json.error?.code }).toEqual({
          path,
          status: 404,
          code: "not_found",
        });
      }
    });

    it("serves them through the gateway entrypoint's mark", async () => {
      const r = await call("GET", "/v1/me", {
        access: await accessToken(ownerA.email),
        env: markConsoleGateway(deployed()),
      });
      expect(r.res.status).toBe(200);
      expect(r.json.principal).toMatchObject({ userId: ownerA.id });
    });
  });

  describe("tenant isolation and roles", () => {
    it("hides other tenants behind the same 404 as a tenant that does not exist", async () => {
      const token = await accessToken(ownerA.email);
      const missing = await call("GET", membersPath(randomUUID()), { access: token });
      for (const path of [membersPath(B.id), auditPath(B.id), membersPath("not-a-uuid")]) {
        const r = await call("GET", path, { access: token });
        expect({
          path,
          status: r.res.status,
          code: r.json.error?.code,
          message: r.json.error?.message,
        }).toEqual({
          path,
          status: 404,
          code: missing.json.error?.code,
          message: missing.json.error?.message,
        });
      }
      const other = await call("GET", membersPath(A.id), {
        access: await accessToken(ownerB.email),
      });
      expect(other.res.status).toBe(404);
    });

    it("cannot write into another tenant", async () => {
      const r = await call("POST", membersPath(B.id), {
        access: await accessToken(ownerA.email),
        headers: { "idempotency-key": `cross-${run}` },
        body: {
          email: `planted-${run}@example.test`,
          displayName: "Planted",
          role: "owner",
          reason: "x",
        },
      });
      expect(r.res.status).toBe(404);
      const [row] =
        await admin`select count(*)::int as n from public.tenant_memberships where tenant_id = ${B.id}`;
      expect(row?.n).toBe(1);
      const [planted] =
        await admin`select count(*)::int as n from public.staff_users where email = ${`planted-${run}@example.test`}`;
      expect(planted?.n).toBe(0);
    });

    it("enforces the role matrix for every staff route", async () => {
      const cases: Array<[string, { id: string; email: string }, string, string, number]> = [
        ["owner lists members", ownerA, "GET", membersPath(A.id), 200],
        ["owner reads audit", ownerA, "GET", auditPath(A.id), 200],
        ["finance reads audit", financeA, "GET", auditPath(A.id), 200],
        ["finance cannot list members", financeA, "GET", membersPath(A.id), 403],
        ["booking staff cannot list members", staffA, "GET", membersPath(A.id), 403],
        ["booking staff cannot read audit", staffA, "GET", auditPath(A.id), 403],
      ];
      for (const [label, who, method, path, status] of cases) {
        const r = await call(method, path, { access: await accessToken(who.email) });
        expect({ label, status: r.res.status }).toEqual({ label, status });
      }
      for (const who of [staffA, financeA]) {
        const r = await call("POST", membersPath(A.id), {
          access: await accessToken(who.email),
          headers: { "idempotency-key": `deny-${who.id}` },
          body: {
            email: `denied-${run}@example.test`,
            displayName: "Denied",
            role: "owner",
            reason: "x",
          },
        });
        expect({ who: who.email, status: r.res.status, code: r.json.error?.code }).toEqual({
          who: who.email,
          status: 403,
          code: "forbidden",
        });
      }
      const session = await signIn(staffA.email);
      const viaSession = await call("GET", membersPath(A.id), { session });
      expect(viaSession.res.status).toBe(403);
    });

    it("refuses a suspended tenant and leaves it out of /v1/me", async () => {
      const token = await accessToken(ownerA.email);
      const r = await call("GET", membersPath(C.id), { access: token });
      expect(r.res.status).toBe(403);
      expect(r.json.error?.code).toBe("tenant_suspended");
      const me = await call("GET", "/v1/me", { access: token });
      expect((me.json.memberships as Array<{ tenantId: string }>).map((m) => m.tenantId)).toEqual([
        A.id,
      ]);
    });

    it("rejects a state change without the console origin even when signed in", async () => {
      const r = await call("POST", membersPath(A.id), {
        access: await accessToken(ownerA.email),
        origin: null,
        headers: { "idempotency-key": `no-origin-${run}` },
        body: { email: `o-${run}@example.test`, displayName: "O", role: "finance", reason: "x" },
      });
      expect(r.res.status).toBe(403);
      expect(r.json.error?.code).toBe("origin_not_allowed");
    });
  });

  describe("idempotent member creation", () => {
    const newMember = (label: string) => ({
      email: `${label}-${run}@example.test`,
      displayName: `Member ${label}`,
      role: "finance" as const,
      reason: "Seasonal bookkeeping",
    });

    it("creates once, audits with reason and context, enqueues an event, and replays", async () => {
      const token = await accessToken(ownerA.email);
      const body = newMember("replay");
      const key = `replay-${run}`;
      const first = await call("POST", membersPath(A.id), {
        access: token,
        headers: { "idempotency-key": key },
        body,
      });
      expect(first.res.status).toBe(201);
      expect(first.res.headers.get("idempotent-replayed")).toBeNull();
      const member = first.json.member as { userId: string; role: string; email: string };
      expect(member).toMatchObject({ email: body.email, role: "finance", status: "active" });

      const again = await call("POST", membersPath(A.id), {
        access: await accessToken(ownerA.email),
        headers: { "idempotency-key": key },
        body,
      });
      expect(again.res.status).toBe(201);
      expect(again.res.headers.get("idempotent-replayed")).toBe("true");
      expect(again.json).toEqual(first.json);

      const audits =
        await admin`select actor_type, actor_id, request_id, reason, before_state, after_state
        from public.audit_events where tenant_id = ${A.id} and action = 'membership.created' and subject_id = ${member.userId}`;
      expect(audits).toEqual([
        {
          actor_type: "staff",
          actor_id: ownerA.id,
          request_id: first.res.headers.get("x-request-id"),
          reason: "Seasonal bookkeeping",
          before_state: null,
          after_state: { role: "finance", status: "active" },
        },
      ]);
      const events = await admin`select topic, payload from public.outbox_events
        where tenant_id = ${A.id} and aggregate_id = ${member.userId}`;
      expect(events).toEqual([
        {
          topic: "tenant.membership.created",
          payload: { tenantId: A.id, userId: member.userId, role: "finance" },
        },
      ]);

      const reused = await call("POST", membersPath(A.id), {
        access: await accessToken(ownerA.email),
        headers: { "idempotency-key": key },
        body: { ...body, role: "owner" },
      });
      expect(reused.res.status).toBe(422);
      expect(reused.json.error?.code).toBe("idempotency_key_reused");

      const duplicate = await call("POST", membersPath(A.id), {
        access: await accessToken(ownerA.email),
        headers: { "idempotency-key": `${key}-2` },
        body,
      });
      expect(duplicate.res.status).toBe(409);
      expect(duplicate.json.error?.code).toBe("member_exists");
    });

    it("executes concurrent duplicates exactly once", async () => {
      const token = await accessToken(ownerA.email);
      const body = newMember("race");
      const key = `race-${run}`;
      const [one, two] = await Promise.all([
        call("POST", membersPath(A.id), {
          access: token,
          headers: { "idempotency-key": key },
          body,
        }),
        call("POST", membersPath(A.id), {
          access: token,
          headers: { "idempotency-key": key },
          body,
        }),
      ]);
      expect([one.res.status, two.res.status]).toEqual([201, 201]);
      expect(one.json).toEqual(two.json);
      const replayFlags = [one, two].map((r) => r.res.headers.get("idempotent-replayed")).sort();
      expect(replayFlags).toEqual([null, "true"].sort());
      const userId = (one.json.member as { userId: string }).userId;
      const [counts] = await admin`select
          (select count(*)::int from public.tenant_memberships where tenant_id = ${A.id} and user_id = ${userId}) as members,
          (select count(*)::int from public.audit_events where tenant_id = ${A.id} and subject_id = ${userId}) as audits,
          (select count(*)::int from public.outbox_events where tenant_id = ${A.id} and aggregate_id = ${userId}) as events`;
      expect(counts).toEqual({ members: 1, audits: 1, events: 1 });
    });

    it("scopes keys by tenant and principal", async () => {
      const key = `shared-key-${run}`;
      const inA = await call("POST", membersPath(A.id), {
        access: await accessToken(ownerA.email),
        headers: { "idempotency-key": key },
        body: newMember("scope-a"),
      });
      const inB = await call("POST", membersPath(B.id), {
        access: await accessToken(ownerB.email),
        headers: { "idempotency-key": key },
        body: newMember("scope-b"),
      });
      expect([inA.res.status, inB.res.status]).toEqual([201, 201]);
      expect(inB.res.headers.get("idempotent-replayed")).toBeNull();
    });

    it("requires an idempotency key", async () => {
      const r = await call("POST", membersPath(A.id), {
        access: await accessToken(ownerA.email),
        body: newMember("nokey"),
      });
      expect(r.res.status).toBe(400);
    });

    it("lets a newly added member sign in and see the membership", async () => {
      const body = { ...newMember("newbie"), role: "booking_staff" as const };
      const added = await call("POST", membersPath(A.id), {
        access: await accessToken(ownerA.email),
        headers: { "idempotency-key": `newbie-${run}` },
        body,
      });
      expect(added.res.status).toBe(201);
      const session = await signIn(body.email);
      const me = await call("GET", "/v1/me", { session });
      expect(me.json.memberships).toEqual([
        { tenantId: A.id, tenantSlug: A.slug, tenantName: A.name, role: "booking_staff" },
      ]);
    });
  });

  it("pages audit history newest first within the tenant", async () => {
    const token = await accessToken(ownerA.email);
    const first = await call("GET", `${auditPath(A.id)}?limit=1`, { access: token });
    expect(first.res.status).toBe(200);
    const events = first.json.events as Array<{ id: string; action: string }>;
    expect(events).toHaveLength(1);
    const cursor = first.json.nextBefore as string;
    expect(cursor).toBe(events[0]?.id);
    const second = await call("GET", `${auditPath(A.id)}?limit=100&before=${cursor}`, {
      access: token,
    });
    const older = second.json.events as Array<{ id: string }>;
    expect(older.length).toBeGreaterThan(0);
    expect(older.every((e) => BigInt(e.id) < BigInt(cursor))).toBe(true);
    const [total] =
      await admin`select count(*)::int as n from public.audit_events where tenant_id = ${A.id}`;
    expect(older.length + 1).toBe(total?.n);
  });

  it("resolves the public tenant from the browser origin only for active hostnames", async () => {
    const ok = await call("GET", "/v1/public/tenant", { origin: `https://${previewHost}` });
    expect(ok.res.status).toBe(200);
    expect(ok.json).toEqual({ tenant: { slug: A.slug, name: A.name } });
    const unknown = await call("GET", "/v1/public/tenant", {
      origin: `https://nope-${run}.example.test`,
    });
    expect(unknown.res.status).toBe(404);
  });
});
