/**
 * Money movements for a date range through the API (W3-G2.12-rest): every
 * role reads the totals and exports the entries, with the same columns and no
 * guest's name or email; each export is audited; another tenant's id answers
 * as an unknown one; a bad or too-full range is refused. Contract:
 * packages/contracts/src/money-report.ts.
 */
import { randomUUID } from "node:crypto";
import { MoneyReportResponse, moneyExportColumns } from "@tidegrid/contracts";
import { createDb, inTenantTransaction, type TenantContext } from "@tidegrid/database";
import type {} from "@tidegrid/database/global-setup";
import { recordExternalSettlement } from "@tidegrid/domain-booking";
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
const TEAM = "tidegrid-money.cloudflareaccess.com";
const AUD = "9a".repeat(32);

interface Tenant extends CheckoutFixture {
  host: string;
  owner: string;
  bookingStaff: string;
  finance: string;
}

describe.skipIf(!env)("money movements through the API (W3-G2.12-rest)", () => {
  let admin: Sql;
  let runtime: ReturnType<typeof createDb>;
  let app: ReturnType<typeof createApp>;
  let small: ReturnType<typeof createApp>;
  let signingKey: CryptoKey;
  let payments: FakePaymentProvider;
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
      via?: ReturnType<typeof createApp>;
    } = {},
  ) {
    const headers = new Headers(options.headers);
    headers.set("origin", options.origin ?? CONSOLE);
    if (options.as) headers.set("cf-access-jwt-assertion", await token(options.as));
    if (options.key) headers.set("idempotency-key", options.key);
    if (options.body !== undefined) headers.set("content-type", "application/json");
    const res = await (options.via ?? app).request(
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
    const csv = (res.headers.get("content-type") ?? "").startsWith("text/csv");
    return {
      status: res.status,
      headers: res.headers,
      text,
      json: (text && !csv ? JSON.parse(text) : {}) as Json,
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

  const desk = (tenantId: string): TenantContext => ({
    tenantId,
    actorType: "staff",
    actorId: "desk-money",
    requestId: `req-${randomUUID()}`,
  });

  const reportPath = (t: Tenant, from: string, to: string) =>
    `/v1/staff/tenants/${t.id}/money-report?from=${from}&to=${to}`;
  const exportPath = (t: Tenant, from: string, to: string) =>
    `/v1/staff/tenants/${t.id}/money-export?from=${from}&to=${to}`;
  let day = "";

  beforeAll(async () => {
    if (!env) return;
    admin = postgres(env.adminUrl, { max: 3, onnotice: () => {} });
    runtime = createDb(env.runtimeUrl, { max: 8 });
    payments = fakeProvider(runtime.db);
    const [a, b] = await Promise.all([
      createCheckoutFixture(admin, runtime.db, "moneyapi-a", { days: 4 }),
      createCheckoutFixture(admin, runtime.db, "moneyapi-b", { days: 4 }),
    ]);
    A = await tenant(a, "moneyapi-a");
    B = await tenant(b, "moneyapi-b");
    tripsA = tripAllocator(A);
    const first = await confirmBooking(runtime.db, payments, A, tripsA.shared(), 2);
    // Cash taken at the dock, with a receipt note that names the guest.
    const done = await inTenantTransaction(runtime.db, desk(A.id), (trx) =>
      recordExternalSettlement(trx, desk(A.id), {
        bookingId: first.bookingId,
        kind: "payment",
        tender: "cash",
        amount: 900,
        reason: "Paid the rest at the dock",
        tenderReference: "Receipt 77 Maria Lopez",
        idempotencyKey: `money:${randomUUID()}`,
      }),
    );
    if (done.kind !== "recorded") throw new Error(done.kind);
    await confirmBooking(runtime.db, payments, A, tripsA.shared(), 1);
    await confirmBooking(runtime.db, payments, B, tripAllocator(B).shared(), 1);
    const [row] = await admin<{ d: string }[]>`select (now() at time zone 'UTC')::date::text as d`;
    day = row?.d ?? "";
    const pair = await generateKeyPair("RS256", { extractable: true });
    signingKey = pair.privateKey;
    const jwk = { ...(await exportJWK(pair.publicKey)), kid, alg: "RS256", use: "sig" };
    const accessVerifier = createAccessVerifier({
      teamDomain: TEAM,
      audience: AUD,
      keys: createLocalJWKSet({ keys: [jwk] }),
    });
    app = createApp({ accessVerifier, deliverEmailAfterCommit: false });
    small = createApp({ accessVerifier, deliverEmailAfterCommit: false, moneyReportLimit: 1 });
  });

  afterAll(async () => {
    await runtime?.end();
    await admin?.end({ timeout: 5 });
  });

  const exports = async (tenantId: string) =>
    (
      await admin<{ n: number }[]>`
        select count(*)::int as n from public.audit_events
         where tenant_id = ${tenantId} and action = 'money_report.exported'`
    )[0]?.n ?? 0;

  it("gives every role the same totals and export, matching the ledger, with each export audited", async () => {
    const [paid] = await admin<{ n: number; sum: string }[]>`
      select ((select count(*) from public.payments
                where tenant_id = ${A.id} and state = 'succeeded')
              + (select count(*) from public.external_settlements where tenant_id = ${A.id}))::int as n,
             ((select coalesce(sum(amount), 0) from public.payments
                where tenant_id = ${A.id} and state = 'succeeded')
              + (select coalesce(sum(amount), 0) from public.external_settlements
                  where tenant_id = ${A.id}))::text as sum`;
    let first: string | null = null;
    for (const who of [A.owner, A.bookingStaff, A.finance]) {
      const res = await request("GET", reportPath(A, day, day), { as: who });
      expect(res.status, who).toBe(200);
      expect(res.headers.get("cache-control")).toBe("no-store");
      const report = MoneyReportResponse.parse(res.json);
      expect(report).toMatchObject({
        from: day,
        to: day,
        timeZone: "UTC",
        currency: "USD",
        controlTotalsMatch: true,
        totals: { entries: paid?.n, moneyIn: Number(paid?.sum), moneyOut: 0 },
      });
      expect(report.byKind.find((k) => k.kind === "external_payment")?.count).toBe(1);

      const before = await exports(A.id);
      const csv = await request("GET", exportPath(A, day, day), { as: who });
      expect(csv.status, who).toBe(200);
      expect(csv.headers.get("content-type")).toBe("text/csv; charset=utf-8");
      expect(csv.headers.get("content-disposition")).toBe(
        `attachment; filename="${A.slug}-money-${day}-to-${day}.csv"`,
      );
      expect(csv.headers.get("cache-control")).toBe("no-store");
      expect(await exports(A.id)).toBe(before + 1);
      const lines = csv.text
        .replace(/^\ufeff/, "")
        .trimEnd()
        .split("\r\n");
      expect(lines[0]).toBe(moneyExportColumns.join(","));
      expect(lines).toHaveLength((paid?.n ?? 0) + 2);
      expect(lines.at(-1)?.split(",")[12]).toBe((Number(paid?.sum) / 100).toFixed(2));
      // Never a guest's address; the typed receipt note only for roles that see guests.
      expect(csv.text).not.toMatch(/@/);
      expect(csv.text.includes("Receipt 77 Maria Lopez"), who).toBe(who !== A.finance);
      // Otherwise the same file for every role.
      const body = lines
        .map((l) =>
          l
            .split(",")
            .filter((_, i) => i !== 17)
            .map((cell) => (cell === "Receipt 77 Maria Lopez" ? "" : cell))
            .join(","),
        )
        .join("\n");
      first ??= body;
      expect(body).toBe(first);
    }
  });

  it("answers another tenant's id as an unknown one, and refuses a bad or too-full range", async () => {
    const before = await exports(B.id);
    for (const path of [reportPath(B, day, day), exportPath(B, day, day)]) {
      const res = await request("GET", path, { as: A.owner });
      expect(res.status, path).toBe(404);
      expect(res.headers.get("content-disposition")).toBeNull();
    }
    expect(await exports(B.id)).toBe(before);
    for (const [from, to] of [
      ["2026-11-02", "2026-11-01"],
      ["2026-01-01", "2026-04-03"],
    ] as const) {
      const res = await request("GET", reportPath(A, from, to), { as: A.finance });
      expect(res.status).toBe(400);
      expect(res.json.error?.code).toBe("invalid_range");
    }
    expect((await request("GET", reportPath(A, "2026-13-01", day), { as: A.owner })).status).toBe(
      400,
    );
    const auditedBefore = await exports(A.id);
    for (const path of [reportPath(A, day, day), exportPath(A, day, day)]) {
      const res = await request("GET", path, { as: A.owner, via: small });
      expect(res.status, path).toBe(422);
      expect(res.json.error?.code).toBe("range_too_large");
      expect(res.headers.get("content-disposition")).toBeNull();
    }
    expect(await exports(A.id)).toBe(auditedBefore);
    // Not signed in.
    expect((await request("GET", reportPath(A, day, day))).status).toBe(401);
  });
});
