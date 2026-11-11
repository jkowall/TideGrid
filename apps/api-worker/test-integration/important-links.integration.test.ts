/**
 * Important links through the API (W3-G2.14b-rest): owners add, change,
 * reorder, and archive them; every role reads them; booking staff and finance
 * change none; guests see the links for every trip and for their booking's
 * product, and never another operator's. The database holds every writer to
 * the address rule, the products being the tenant's own, the limit of 25, and
 * no deletion. Contract: packages/contracts/src/important-links.ts.
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
const TEAM = "tidegrid-links.cloudflareaccess.com";
const AUD = "1b".repeat(32);

interface Tenant extends CheckoutFixture {
  host: string;
  owner: string;
  bookingStaff: string;
  finance: string;
}

describe.skipIf(!env)("important links through the API (W3-G2.14b-rest)", () => {
  let admin: Sql;
  let runtime: ReturnType<typeof createDb>;
  let app: ReturnType<typeof createApp>;
  let signingKey: CryptoKey;
  let payments: FakePaymentProvider;
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

  const linksPath = (t: Tenant) => `/v1/staff/tenants/${t.id}/important-links`;
  const link = (over: Json = {}) => ({
    label: "Fishing license",
    url: "https://licenses.example.org/buy?type=saltwater",
    description: "Buy a one-day license before you board.",
    productIds: null,
    position: 10,
    ...over,
  });
  const add = (t: Tenant, body: Json, as = t.owner) =>
    request("POST", linksPath(t), { as, key: `l-${randomUUID()}`, body });

  beforeAll(async () => {
    if (!env) return;
    admin = postgres(env.adminUrl, { max: 3, onnotice: () => {} });
    runtime = createDb(env.runtimeUrl, { max: 8 });
    payments = fakeProvider(runtime.db);
    const [a, b] = await Promise.all([
      createCheckoutFixture(admin, runtime.db, "linkapi-a", { days: 4 }),
      createCheckoutFixture(admin, runtime.db, "linkapi-b", { days: 2 }),
    ]);
    A = await tenant(a, "linkapi-a");
    B = await tenant(b, "linkapi-b");
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

  it("lets an owner add, change, and archive a link, idempotently and audited", async () => {
    const key = `l-${randomUUID()}`;
    const first = await request("POST", linksPath(A), { as: A.owner, key, body: link() });
    expect(first.status, JSON.stringify(first.json)).toBe(201);
    expect(first.json.link).toMatchObject({
      label: "Fishing license",
      host: "licenses.example.org",
      status: "active",
      productIds: null,
    });
    const again = await request("POST", linksPath(A), { as: A.owner, key, body: link() });
    expect(again.headers.get("idempotent-replayed")).toBe("true");
    expect(again.json.link.id).toBe(first.json.link.id);

    const id = first.json.link.id as string;
    const changed = await request("PUT", `${linksPath(A)}/${id}`, {
      as: A.owner,
      key: `l-${randomUUID()}`,
      body: link({ label: "Parking map", url: "https://maps.example.com/dock", position: 1 }),
    });
    expect(changed.status).toBe(200);
    expect(changed.json.link).toMatchObject({ label: "Parking map", host: "maps.example.com" });

    const archived = await request("POST", `${linksPath(A)}/${id}/archive`, {
      as: A.owner,
      key: `l-${randomUUID()}`,
    });
    expect([archived.status, archived.json.link.status]).toEqual([200, "archived"]);
    const twice = await request("POST", `${linksPath(A)}/${id}/archive`, {
      as: A.owner,
      key: `l-${randomUUID()}`,
    });
    expect([twice.status, twice.json.error?.code]).toEqual([409, "important_link_archived"]);
    const edit = await request("PUT", `${linksPath(A)}/${id}`, {
      as: A.owner,
      key: `l-${randomUUID()}`,
      body: link(),
    });
    expect([edit.status, edit.json.error?.code]).toEqual([409, "important_link_archived"]);

    const audit = await admin<{ action: string }[]>`
      select action from public.audit_events
       where tenant_id = ${A.id} and subject_id = ${id} order by occurred_at, id`;
    expect(audit.map((a) => a.action)).toEqual([
      "important_link.created",
      "important_link.updated",
      "important_link.archived",
    ]);
  });

  it("refuses bad addresses, other operators' products, and roles that change nothing", async () => {
    for (const url of [
      "http://example.com/a",
      "https://user:pw@example.com/",
      "https://192.168.1.10/",
      "https://localhost/",
      "javascript:alert(1)",
      "https://exa mple.com/",
    ]) {
      const res = await add(A, link({ url }));
      expect(res.status, url).toBe(400);
    }
    const foreign = await add(A, link({ productIds: [B.products.shared] }));
    expect([foreign.status, foreign.json.error?.code]).toEqual([
      409,
      "important_link_unknown_product",
    ]);
    const desk = await add(A, link(), A.bookingStaff);
    expect(desk.status).toBe(403);
    const finance = await add(A, link(), A.finance);
    expect(finance.status).toBe(403);
    const read = await request("GET", linksPath(A), { as: A.finance });
    expect(read.status).toBe(200);
    // Another operator's owner sees none of A's links and cannot touch them.
    const mine = await add(A, link({ label: "A only" }));
    const cross = await request("PUT", `${linksPath(B)}/${mine.json.link.id}`, {
      as: B.owner,
      key: `l-${randomUUID()}`,
      body: link(),
    });
    expect([cross.status, cross.json.error?.code]).toEqual([404, "important_link_not_found"]);
    const theirs = await request("GET", linksPath(B), { as: B.owner });
    expect(theirs.json.links.map((l: Json) => l.label)).not.toContain("A only");
    const outsider = await request("GET", linksPath(B), { as: A.owner });
    expect(outsider.status).toBe(404);
  });

  it("shows guests the links for every trip and for their booking's product, by position", async () => {
    const own = await createCheckoutFixture(admin, runtime.db, "linkapi-c", { days: 3 });
    const C = await tenant(own, "linkapi-c");
    const tripsC = tripAllocator(C);
    await add(C, link({ label: "Packing list", url: "https://c.example.com/pack", position: 5 }));
    await add(
      C,
      link({
        label: "Charter menu",
        url: "https://c.example.com/menu",
        productIds: [C.products.charter],
        position: 1,
      }),
    );
    await add(
      C,
      link({
        label: "Reef rules",
        url: "https://c.example.com/reef",
        productIds: [C.products.shared],
        position: 2,
        description: null,
      }),
    );
    const gone = await add(C, link({ label: "Old page", url: "https://c.example.com/old" }));
    await request("POST", `${linksPath(C)}/${gone.json.link.id}/archive`, {
      as: C.owner,
      key: `l-${randomUUID()}`,
    });

    const site = await request("GET", "/v1/public/important-links", {
      origin: `https://${C.host}`,
    });
    expect(site.status).toBe(200);
    expect(site.json.links).toEqual([
      {
        label: "Packing list",
        url: "https://c.example.com/pack",
        host: "c.example.com",
        description: "Buy a one-day license before you board.",
      },
    ]);
    const unknown = await request("GET", "/v1/public/important-links", {
      origin: "https://nobody.book.example.test",
    });
    expect(unknown.status).toBe(404);

    const made = await confirmBooking(runtime.db, payments, C, tripsC.shared(), 2);
    const session = await request(
      "POST",
      `/v1/public/checkout-sessions/${made.checkoutSessionId}/manage-session`,
      { origin: `https://${C.host}`, headers: { authorization: `Bearer ${made.secret}` } },
    );
    expect(session.status).toBe(201);
    const booking = await request("GET", "/v1/public/manage/booking", {
      origin: `https://${C.host}`,
      headers: { authorization: `Bearer ${session.json.session.token}` },
    });
    expect(booking.status).toBe(200);
    expect(booking.json.booking.importantLinks.map((l: Json) => l.label)).toEqual([
      "Reef rules",
      "Packing list",
    ]);
  });

  it("holds every writer to the rules in the database", async () => {
    // The runtime role, inside A's tenant, as a direct writer would be.
    const rt = postgres(env?.runtimeUrl ?? "", { max: 1, onnotice: () => {} });
    const write = (sql: (tx: Sql) => Promise<unknown>) =>
      rt.begin(async (tx) => {
        await tx`select set_config('app.tenant_id', ${A.id}, true)`;
        return sql(tx as unknown as Sql);
      });
    await expect(
      write(
        (tx) => tx`insert into public.important_links (tenant_id, label, url, position)
          values (${A.id}, 'Raw', 'https://10.0.0.1/', 0)`,
      ),
    ).rejects.toThrow(/check constraint/);
    await expect(
      write(
        (tx) => tx`insert into public.important_links (tenant_id, label, url, position, product_ids)
          values (${A.id}, 'Raw', 'https://ok.example.com/', 0, ${[B.products.shared]}::uuid[])`,
      ),
    ).rejects.toThrow(/its operator's products/);
    const [row] = (await write(
      (tx) => tx`insert into public.important_links (tenant_id, label, url, position)
        values (${A.id}, 'Raw', 'https://ok.example.com/', 0) returning id`,
    )) as { id: string }[];
    await expect(
      write((tx) => tx`delete from public.important_links where id = ${row?.id ?? ""}`),
    ).rejects.toThrow(/permission denied/);
    await expect(
      write(
        (tx) =>
          tx`update public.important_links set tenant_id = ${B.id} where id = ${row?.id ?? ""}`,
      ),
    ).rejects.toThrow(/permission denied/);

    // The same address and text rules as the contract.
    for (const [label, url] of [
      ["Raw", "https://ok.example.com:99999/"],
      ["Raw", "https://ok.example.com:0/"],
      ["Raw", "https://printer.local/"],
      ["Raw", "https://router.home.arpa/"],
      ["Raw", "https://metadata.google.internal/"],
      ["Raw", "https://ok.example.com/a\u0085b"],
      ["Raw", "https://ok.example.com/a\u2028b"],
      ["Raw", "https://ok.example.com/a\u00a0b"],
      ["Raw\u202e", "https://ok.example.com/"],
      ["Raw\u200b", "https://ok.example.com/"],
      ["Raw\u00a0", "https://ok.example.com/"],
    ] as const) {
      await expect(
        write(
          (tx) => tx`insert into public.important_links (tenant_id, label, url, position)
            values (${A.id}, ${label}, ${url}, 0)`,
        ),
      ).rejects.toThrow(/check constraint/);
    }
    await expect(
      write(
        (tx) => tx`insert into public.important_links (tenant_id, label, url, description, position)
          values (${A.id}, 'Raw', 'https://ok.example.com/', '   ', 0)`,
      ),
    ).rejects.toThrow(/check constraint/);

    // Archived is final, and nothing starts archived.
    await expect(
      write(
        (tx) => tx`insert into public.important_links (tenant_id, label, url, position, status)
          values (${A.id}, 'Raw', 'https://ok.example.com/', 0, 'archived')`,
      ),
    ).rejects.toThrow(/starts active/);
    await write(
      (tx) => tx`update public.important_links set status = 'archived' where id = ${row?.id ?? ""}`,
    );
    await expect(
      write(
        (tx) => tx`update public.important_links set status = 'active' where id = ${row?.id ?? ""}`,
      ),
    ).rejects.toThrow(/does not change/);

    // At most 25 active links a tenant.
    const own = await createCheckoutFixture(admin, runtime.db, "linkapi-d", { days: 1 });
    const D = await tenant(own, "linkapi-d");
    for (let i = 0; i < 25; i += 1) {
      const res = await add(D, link({ label: `Link ${i}`, position: i }));
      expect(res.status).toBe(201);
    }
    const over = await add(D, link({ label: "One too many" }));
    expect([over.status, over.json.error?.code]).toEqual([409, "important_links_limit"]);

    // And 500 in all, archived ones included.
    const writeD = (sql: (tx: Sql) => Promise<unknown>) =>
      rt.begin(async (tx) => {
        await tx`select set_config('app.tenant_id', ${D.id}, true)`;
        return sql(tx as unknown as Sql);
      });
    await writeD(
      (tx) => tx`update public.important_links set status = 'archived' where tenant_id = ${D.id}`,
    );
    await writeD(async (tx) => {
      for (let i = 25; i < 500; i += 1) {
        await tx`insert into public.important_links (tenant_id, label, url, position)
          values (${D.id}, ${`Old ${i}`}, 'https://ok.example.com/', 0)`;
        await tx`update public.important_links set status = 'archived'
          where tenant_id = ${D.id} and label = ${`Old ${i}`}`;
      }
    });
    const full = await add(D, link({ label: "Five hundred and one" }));
    expect([full.status, full.json.error?.code]).toEqual([409, "important_links_limit"]);
    await rt.end({ timeout: 5 });
  });
});
