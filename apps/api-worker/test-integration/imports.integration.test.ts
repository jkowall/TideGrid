/**
 * The standard CSV import's dry run through the API (W3-G2.13, part 1):
 * owners only, idempotent by key, a used run number refused, the issues and
 * errors.csv returned with personal values withheld, and another tenant's ids
 * treated as unknown. Then the commit (part A): a clean dry run saved once,
 * the imported booking read back by the console. Contract:
 * packages/contracts/src/imports.ts.
 */
import { randomUUID } from "node:crypto";
import { ImportCommitResponse, ImportDryRunResponse } from "@tidegrid/contracts";
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
const TEAM = "tidegrid-imports.cloudflareaccess.com";
const AUD = "7c".repeat(32);

interface Tenant extends CheckoutFixture {
  owner: string;
  bookingStaff: string;
}

describe.skipIf(!env)("the standard CSV import's dry run through the API (W3-G2.13)", () => {
  let admin: Sql;
  let runtime: ReturnType<typeof createDb>;
  let app: ReturnType<typeof createApp>;
  let signingKey: CryptoKey;
  let A: Tenant;
  let B: Tenant;
  let day = "";
  let exportedAt = "";
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

  async function dryRun(t: Tenant, as: string, body: unknown, key = `imp-${randomUUID()}`) {
    return send(t, as, "import-dry-runs", body, key);
  }

  async function commit(t: Tenant, as: string, body: unknown, key = `imp-${randomUUID()}`) {
    return send(t, as, "import-commits", body, key);
  }

  async function get(t: Tenant, as: string, path: string) {
    const res = await app.request(
      `http://localhost/v1/staff/tenants/${t.id}/${path}`,
      {
        method: "GET",
        headers: new Headers({ origin: CONSOLE, "cf-access-jwt-assertion": await token(as) }),
      },
      bindings(),
      executionCtx,
    );
    const text = await res.text();
    return { status: res.status, text, json: (text ? JSON.parse(text) : {}) as Json };
  }

  async function send(t: Tenant, as: string, path: string, body: unknown, key: string) {
    const headers = new Headers({
      origin: CONSOLE,
      "content-type": "application/json",
      "idempotency-key": key,
      "cf-access-jwt-assertion": await token(as),
    });
    const res = await app.request(
      `http://localhost/v1/staff/tenants/${t.id}/${path}`,
      { method: "POST", headers, body: JSON.stringify(body) },
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
    const userId = randomUUID();
    await admin`insert into public.staff_users (id, email, display_name)
      values (${userId}, ${email}, ${role})`;
    await admin`insert into public.tenant_memberships (tenant_id, user_id, role, display_name)
      values (${tenantId}, ${userId}, ${role}, ${role})`;
    return email;
  }

  async function tenant(fixture: CheckoutFixture, label: string): Promise<Tenant> {
    const tag = fixture.id.slice(0, 8);
    return {
      ...fixture,
      owner: await member(fixture.id, `${label}-owner-${tag}@example.test`, "owner"),
      bookingStaff: await member(fixture.id, `${label}-desk-${tag}@example.test`, "booking_staff"),
    };
  }

  /** One shared-seat trip at 14:00 on day+3 and one paid booking on it. */
  function files(
    t: CheckoutFixture,
    batchId: string,
    run = 1,
    extra: { cardRef?: boolean; mode?: "dry_run" | "commit" } = {},
  ) {
    return {
      "manifest.csv": [
        "item,file,value",
        `batch_id,,${batchId}`,
        `run_number,,${run}`,
        "source_system,,legacy-booker",
        "mapping_version,,std-csv-v0",
        `batch_mode,,${extra.mode ?? "dry_run"}`,
        "operator_time_zone,,UTC",
        `exported_at,,${exportedAt}`,
        "waiver_notifications,,send_at_cutover",
        "row_count,products.csv,1",
        "row_count,trips.csv,1",
        "sum_seat_capacity,trips.csv,10",
        "row_count,customers.csv,1",
        "rows_with_email,customers.csv,1",
        "row_count,bookings.csv,1",
        "sum_party_size,bookings.csv,2",
        "rows_direct,bookings.csv,0",
        "rows_staff_assisted,bookings.csv,1",
        "rows_ota,bookings.csv,0",
        "sum_total_cents,bookings.csv,9000",
        "sum_included_tax_cents,bookings.csv,0",
        "row_count,payments.csv,1",
        "sum_payment_cents,payments.csv,9000",
        "sum_refund_cents,payments.csv,0",
        "sum_outstanding_cents,payments.csv,0",
      ].join("\r\n"),
      "products.csv": `source_product_id,source_product_name,tidegrid_product_id,tidegrid_product_name,product_kind\nP-1,Seats,${t.products.shared},Harbor Seats,shared_seat\n`,
      "trips.csv": `source_trip_id,source_product_id,tidegrid_boat_id,local_date,local_start_time,time_zone,utc_offset,seat_capacity\nT-1,P-1,${t.boats.lark},${day},14:00,UTC,,\n`,
      "customers.csv":
        "source_customer_id,full_name,email,phone\nC-1,Quinn Example,quinn.example@example.test,+15555550100\n",
      "bookings.csv": `source_booking_ref,trip_date,source_trip_id,source_customer_id,booking_source,staff_channel,ota_channel,party_size,subtotal_cents,discount_cents,fee_cents,tax_cents,included_tax_cents,total_cents,balance_due_date,booked_at\nR-1,${day},T-1,C-1,staff_assisted,phone,,2,9000,0,0,0,0,9000,,\n`,
      "payments.csv": `source_payment_id,source_booking_ref,trip_date,entry_kind,amount_cents,tender,reference,received_at\nPAY-1,R-1,${day},payment,9000,cash,${extra.cardRef ? "4242424242424242" : "Quinn receipt"},${exportedAt}\n`,
    };
  }

  beforeAll(async () => {
    if (!env) return;
    admin = postgres(env.adminUrl, { max: 3, onnotice: () => {} });
    runtime = createDb(env.runtimeUrl, { max: 6 });
    const [a, b] = await Promise.all([
      createCheckoutFixture(admin, runtime.db, "impapi-a", { days: 4 }),
      createCheckoutFixture(admin, runtime.db, "impapi-b", { days: 2 }),
    ]);
    A = await tenant(a, "impapi-a");
    B = await tenant(b, "impapi-b");
    const [clock] = await admin<{ day: string; exported: string }[]>`
      select ((now() at time zone 'UTC')::date + 3)::text as day,
             to_char((now() - interval '1 hour') at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') as exported`;
    day = clock?.day ?? "";
    exportedAt = clock?.exported ?? "";
    const pair = await generateKeyPair("RS256", { extractable: true });
    signingKey = pair.privateKey;
    const jwk = { ...(await exportJWK(pair.publicKey)), kid, alg: "RS256", use: "sig" };
    const accessVerifier = createAccessVerifier({
      teamDomain: TEAM,
      audience: AUD,
      keys: createLocalJWKSet({ keys: [jwk] }),
    });
    app = createApp({ accessVerifier, deliverEmailAfterCommit: false });
  });

  afterAll(async () => {
    await runtime?.end();
    await admin?.end({ timeout: 5 });
  });

  it("checks an owner's batch, replays by key, and refuses a used run number", async () => {
    const key = `imp-${randomUUID()}`;
    const body = { files: files(A, "API-1") };
    const first = await dryRun(A, A.owner, body, key);
    expect(first.status, first.text).toBe(200);
    expect(first.headers.get("cache-control")).toBe("no-store");
    const parsed = ImportDryRunResponse.parse(first.json);
    expect(parsed.run).toMatchObject({
      batchId: "API-1",
      runNumber: 1,
      clean: true,
      errorCount: 0,
    });
    expect(parsed.run.controls.every((c) => c.matches)).toBe(true);

    const replay = await dryRun(A, A.owner, body, key);
    expect(replay.status).toBe(200);
    expect(replay.headers.get("idempotent-replayed")).toBe("true");
    expect(replay.json.run.id).toBe(parsed.run.id);

    const again = await dryRun(A, A.owner, body);
    expect([again.status, again.json.error?.code]).toEqual([409, "import_run_number_used"]);
    const [{ n } = { n: -1 }] = await admin<{ n: number }[]>`
      select count(*)::int as n from public.import_runs where tenant_id = ${A.id} and batch_id = 'API-1'`;
    expect(n).toBe(1);
  });

  it("refuses booking staff and malformed bodies, and keeps tenants apart", async () => {
    const desk = await dryRun(A, A.bookingStaff, { files: files(A, "API-2") });
    expect([desk.status, desk.json.error?.code]).toEqual([403, "forbidden"]);
    const stray = await dryRun(A, A.owner, { files: { ...files(A, "API-3"), "notes.csv": "x" } });
    expect(stray.status).toBe(400);
    const noManifest = await dryRun(A, A.owner, { files: { "products.csv": "a" } });
    expect(noManifest.status).toBe(400);
    // B's owner, naming A's ids: unknown here.
    const cross = await dryRun(B, B.owner, { files: files(A, "API-4") });
    expect(cross.status).toBe(200);
    expect(cross.json.run.clean).toBe(false);
    expect(cross.json.run.issues.map((i: Json) => i.code)).toContain("product_not_found");
    // A's owner in B's tenant: not a member there.
    const outsider = await dryRun(B, A.owner, { files: files(B, "API-5") });
    expect(outsider.status).toBe(404);
  });

  it("returns errors.csv with personal values and card numbers withheld", async () => {
    const res = await dryRun(A, A.owner, { files: files(A, "API-6", 1, { cardRef: true }) });
    expect(res.status, res.text).toBe(200);
    expect(res.json.run.clean).toBe(false);
    expect(res.json.run.issues).toContainEqual(
      expect.objectContaining({
        file: "payments.csv",
        code: "possible_card_number",
        value: "[withheld]",
      }),
    );
    expect(res.text).not.toContain("4242424242424242");
    expect(res.text).not.toContain("Quinn");
    expect(res.json.errorsCsv).toMatch(
      /^﻿batch_id,run_number,file,line,record_key,column,code,severity,message,value\r\n/,
    );
  });

  it("saves a clean dry run once, and the console reads the imported booking", async () => {
    const dry = await dryRun(A, A.owner, { files: files(A, "API-C1") });
    expect(dry.status, dry.text).toBe(200);
    expect(dry.json.run.clean).toBe(true);
    // Not before a clean dry run, and never by booking staff.
    const early = await commit(A, A.owner, { files: files(A, "API-C2", 1, { mode: "commit" }) });
    expect([early.status, early.json.error?.code]).toEqual([409, "import_no_clean_dry_run"]);
    const body = { files: files(A, "API-C1", 2, { mode: "commit" }) };
    const desk = await commit(A, A.bookingStaff, body);
    expect([desk.status, desk.json.error?.code]).toEqual([403, "forbidden"]);

    const key = `imp-${randomUUID()}`;
    const saved = await commit(A, A.owner, body, key);
    expect(saved.status, saved.text).toBe(200);
    expect(saved.headers.get("cache-control")).toBe("no-store");
    const parsed = ImportCommitResponse.parse(saved.json);
    expect(parsed).toMatchObject({
      committed: true,
      refusal: null,
      counts: { trips: 1, tripsCreated: 1, customers: 1, bookings: 1, payments: 1, refunds: 0 },
    });
    expect(saved.text).not.toContain("Quinn");
    const replay = await commit(A, A.owner, body, key);
    expect(replay.headers.get("idempotent-replayed")).toBe("true");
    expect(replay.json.run.id).toBe(parsed.run.id);
    const twice = await commit(A, A.owner, { files: files(A, "API-C1", 3, { mode: "commit" }) });
    expect([twice.status, twice.json.error?.code]).toEqual([409, "import_already_committed"]);

    // The console reads it: imported, with its legacy total and no card payment.
    const [booking] = await admin<{ id: string }[]>`
      select b.id from public.bookings b
        join public.import_bookings ib on ib.checkout_session_id = b.checkout_session_id
        join public.import_records r on r.id = ib.record_id
       where b.tenant_id = ${A.id} and r.run_id = ${parsed.run.id ?? ""}`;
    if (!booking) throw new Error("no imported booking");
    const detail = await get(A, A.owner, `bookings/${booking.id}`);
    expect(detail.status, detail.text).toBe(200);
    expect(detail.json.booking).toMatchObject({
      source: "imported",
      payment: null,
      booker: { name: "Quinn Example", email: "quinn.example@example.test" },
    });
  });
});
