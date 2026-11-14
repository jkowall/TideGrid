/**
 * Tax rates through the API (W3-G2.5-TAX staff screens): owners add a rate,
 * for every location or one, and change or retire it by a new version with a
 * reason; every role reads them; booking staff and finance change none; one
 * operator never sees or changes another's. Contract:
 * packages/contracts/src/tax-rates.ts.
 */
import { randomUUID } from "node:crypto";
import { createDb } from "@tidegrid/database";
import type {} from "@tidegrid/database/global-setup";
import {
  type CheckoutFixture,
  createCheckoutFixture,
  TEST_FAKE_SECRET,
} from "@tidegrid/domain-booking/testing";
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
const TEAM = "tidegrid-tax.cloudflareaccess.com";
const AUD = "1c".repeat(32);

interface Tenant extends CheckoutFixture {
  host: string;
  owner: string;
  bookingStaff: string;
  finance: string;
}

describe.skipIf(!env)("tax rates through the API (W3-G2.5-TAX staff screens)", () => {
  let admin: Sql;
  let runtime: ReturnType<typeof createDb>;
  let app: ReturnType<typeof createApp>;
  let signingKey: CryptoKey;
  let A: Tenant;
  let B: Tenant;
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

  const ratesPath = (t: Tenant) => `/v1/staff/tenants/${t.id}/tax-rates`;
  const rate = (over: Json = {}) => ({
    name: "Harbor district tax",
    ratePpm: 62_500,
    inclusive: false,
    locationId: null,
    reason: "County rate for the harbor district",
    ...over,
  });
  const add = (t: Tenant, body: Json, as = t.owner, key = `t-${randomUUID()}`) =>
    request("POST", ratesPath(t), { as, key, body });
  const change = (t: Tenant, id: string, body: Json, as = t.owner) =>
    request("POST", `${ratesPath(t)}/${id}/versions`, { as, key: `v-${randomUUID()}`, body });
  async function locationOf(t: Tenant): Promise<{ id: string; name: string }> {
    const [row] = await admin<{ id: string; name: string }[]>`
      select id, name from public.locations where tenant_id = ${t.id} order by created_at limit 1`;
    if (!row) throw new Error("no location");
    return row;
  }

  beforeAll(async () => {
    if (!env) return;
    admin = postgres(env.adminUrl, { max: 3, onnotice: () => {} });
    runtime = createDb(env.runtimeUrl, { max: 8 });
    const [a, b] = await Promise.all([
      createCheckoutFixture(admin, runtime.db, "taxapi-a", { days: 4 }),
      createCheckoutFixture(admin, runtime.db, "taxapi-b", { days: 2 }),
    ]);
    A = await tenant(a, "taxapi-a");
    B = await tenant(b, "taxapi-b");
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

  it("lets an owner add a rate for one location, and every role read it", async () => {
    const where = await locationOf(A);
    const key = `t-${randomUUID()}`;
    const added = await add(A, rate({ locationId: where.id }), A.owner, key);
    expect(added.status).toBe(201);
    expect(added.json.taxRate).toMatchObject({
      version: 1,
      name: "Harbor district tax",
      ratePpm: 62_500,
      inclusive: false,
      active: true,
      locationId: where.id,
      locationName: where.name,
      reason: "County rate for the harbor district",
    });
    // The same request again is the same answer, not a second rate.
    const again = await add(A, rate({ locationId: where.id }), A.owner, key);
    expect(again.status).toBe(201);
    expect(again.headers.get("idempotent-replayed")).toBe("true");
    expect(again.json.taxRate.id).toBe(added.json.taxRate.id);
    for (const who of [A.owner, A.bookingStaff, A.finance]) {
      const listed = await request("GET", ratesPath(A), { as: who });
      expect(listed.status).toBe(200);
      const mine = listed.json.taxRates.filter((r: Json) => r.id === added.json.taxRate.id);
      expect(mine).toHaveLength(1);
    }
    const [audit] = await admin<{ n: number }[]>`
      select count(*)::int as n from public.audit_events
       where tenant_id = ${A.id} and subject_id = ${added.json.taxRate.id}
         and action = 'tax_rate.version_created'`;
    expect(audit?.n).toBe(1);
  });

  it("changes a rate by a new version, retires it, and lists retired ones last", async () => {
    const added = await add(A, rate({ name: "Aaa first by name" }));
    const id = added.json.taxRate.id as string;
    const moved = await change(A, id, {
      ...rate({ name: "Aaa first by name", ratePpm: 70_000 }),
      active: true,
    });
    expect(moved.status).toBe(201);
    expect(moved.json.taxRate).toMatchObject({ version: 2, ratePpm: 70_000, active: true });
    const retired = await change(A, id, {
      ...rate({ name: "Aaa first by name", ratePpm: 70_000, reason: "No longer charged" }),
      active: false,
    });
    expect(retired.json.taxRate).toMatchObject({
      version: 3,
      active: false,
      reason: "No longer charged",
    });
    const listed = await request("GET", ratesPath(A), { as: A.owner });
    const order = listed.json.taxRates.map((r: Json) => r.active);
    expect(order).toEqual([...order].sort((x: boolean, y: boolean) => Number(y) - Number(x)));
    expect(listed.json.taxRates.find((r: Json) => r.id === id)).toMatchObject({
      version: 3,
      active: false,
    });
    const [versions] = await admin<{ n: number }[]>`
      select count(*)::int as n from public.tax_rate_versions where tax_rate_id = ${id}`;
    expect(versions?.n).toBe(3);
  });

  it("refuses booking staff and finance, another operator's location, and a rate that is not there", async () => {
    for (const who of [A.bookingStaff, A.finance]) {
      expect((await add(A, rate(), who)).status).toBe(403);
    }
    const theirs = await locationOf(B);
    const foreign = await add(A, rate({ locationId: theirs.id }));
    expect(foreign.status).toBe(422);
    expect(foreign.json.error.code).toBe("tax_rate_unknown_location");
    expect((await add(A, rate({ ratePpm: 500_001 }))).status).toBe(400);
    expect((await add(A, rate({ reason: "" }))).status).toBe(400);
    const ours = await add(A, rate());
    const id = ours.json.taxRate.id as string;
    for (const who of [A.bookingStaff, A.finance]) {
      expect((await change(A, id, { ...rate(), active: false }, who)).status).toBe(403);
    }
    // Another operator's rate, an unknown one, and a malformed id are all "not here".
    const bRate = await add(B, rate());
    expect((await change(A, bRate.json.taxRate.id, { ...rate(), active: true })).status).toBe(404);
    expect((await change(A, randomUUID(), { ...rate(), active: true })).status).toBe(404);
    expect((await change(A, "not-a-uuid", { ...rate(), active: true })).status).toBe(404);
    // And B's list never shows A's rates.
    const listed = await request("GET", ratesPath(B), { as: B.owner });
    expect(listed.json.taxRates.some((r: Json) => r.id === id)).toBe(false);
  });
});
