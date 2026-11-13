/**
 * The standard CSV import's dry run against the database (W3-G2.13, part 1):
 * a batch checked against a real tenant's products, boats, trips, and holds,
 * with nothing from the files written, the run recorded for owners only, and
 * tenants kept apart.
 */
import { randomUUID } from "node:crypto";
import { createDb, inTenantTransaction, type TenantContext } from "@tidegrid/database";
import type {} from "@tidegrid/database/global-setup";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";
import { type CheckoutFixture, createCheckoutFixture } from "../test-fixtures.ts";
import { runImportDryRun } from "./dry-run.ts";

type Sql = ReturnType<typeof postgres>;

const env = inject("integrationDb");

describe.skipIf(!env)("the standard CSV import's dry run (W3-G2.13)", () => {
  let admin: Sql;
  let runtime: ReturnType<typeof createDb>;
  let A: CheckoutFixture;
  let B: CheckoutFixture;
  let ownerA: string;
  let deskA: string;
  let ownerB: string;
  let day: string;
  let exportedAt: string;

  async function member(tenantId: string, role: "owner" | "booking_staff"): Promise<string> {
    const id = randomUUID();
    await admin`insert into public.staff_users (id, email, display_name)
      values (${id}, ${`imp-${id.slice(0, 8)}@example.test`}, ${role})`;
    await admin`insert into public.tenant_memberships (tenant_id, user_id, role, display_name)
      values (${tenantId}, ${id}, ${role}, ${role})`;
    return id;
  }

  const staffCtx = (tenantId: string, userId: string): TenantContext => ({
    tenantId,
    actorType: "staff",
    actorId: userId,
    requestId: `req-${randomUUID()}`,
    sourceIp: null,
  });

  /** A batch on day+3: one row onto the fixture's 10:00 shared trip, two new trips at 14:00. */
  function batch(
    t: CheckoutFixture,
    opts: { batchId?: string; run?: number; source?: string; party?: number } = {},
  ) {
    const party = opts.party ?? 4;
    return {
      "manifest.csv": [
        "item,file,value",
        `batch_id,,${opts.batchId ?? `B-${randomUUID().slice(0, 8)}`}`,
        `run_number,,${opts.run ?? 1}`,
        `source_system,,${opts.source ?? "legacy-booker"}`,
        "mapping_version,,std-csv-v0",
        "batch_mode,,dry_run",
        "operator_time_zone,,UTC",
        `exported_at,,${exportedAt}`,
        "waiver_notifications,,hold_until_staff_release",
        "row_count,products.csv,2",
        "row_count,trips.csv,3",
        "sum_seat_capacity,trips.csv,20",
        "row_count,customers.csv,2",
        "rows_with_email,customers.csv,2",
        "row_count,bookings.csv,3",
        `sum_party_size,bookings.csv,${party + 2 + 3}`,
        "rows_direct,bookings.csv,3",
        "rows_staff_assisted,bookings.csv,0",
        "rows_ota,bookings.csv,0",
        "sum_total_cents,bookings.csv,30000",
        "sum_included_tax_cents,bookings.csv,0",
        "row_count,payments.csv,2",
        "sum_payment_cents,payments.csv,20000",
        "sum_refund_cents,payments.csv,0",
        "sum_outstanding_cents,payments.csv,10000",
      ].join("\n"),
      "products.csv": [
        "source_product_id,source_product_name,tidegrid_product_id,tidegrid_product_name,product_kind",
        `P-SEATS,Legacy seats,${t.products.shared},Harbor Seats,shared_seat`,
        `P-CHARTER,Legacy charter,${t.products.charter},Wren Charter,private_charter`,
      ].join("\n"),
      "trips.csv": [
        "source_trip_id,source_product_id,tidegrid_boat_id,local_date,local_start_time,time_zone,utc_offset,seat_capacity",
        // The fixture's own 10:00 departure: mapped onto it, 10 seats.
        `T-AM,P-SEATS,${t.boats.lark},${day},10:00,UTC,,`,
        `T-PM,P-SEATS,${t.boats.lark},${day},14:00,UTC,,10`,
        `T-CH,P-CHARTER,${t.boats.wren},${day},14:00,UTC,,`,
      ].join("\n"),
      "customers.csv": [
        "source_customer_id,full_name,email,phone",
        "C-1,Ima Sample,ima.sample@example.test,",
        "C-2,Jo Fixture,jo.fixture@example.test,",
      ].join("\n"),
      "bookings.csv": [
        "source_booking_ref,trip_date,source_trip_id,source_customer_id,booking_source,staff_channel,ota_channel,party_size,subtotal_cents,discount_cents,fee_cents,tax_cents,included_tax_cents,total_cents,balance_due_date,booked_at",
        `R-1,${day},T-AM,C-1,direct,,,${party},10000,0,0,0,0,10000,,`,
        `R-2,${day},T-PM,C-2,direct,,,2,10000,0,0,0,0,10000,,`,
        `R-3,${day},T-CH,C-2,direct,,,3,10000,0,0,0,0,10000,${day},`,
      ].join("\n"),
      "payments.csv": [
        "source_payment_id,source_booking_ref,trip_date,entry_kind,amount_cents,tender,reference,received_at",
        `PAY-1,R-1,${day},payment,10000,cash,,${exportedAt}`,
        `PAY-2,R-2,${day},payment,10000,check,CHK-77,${exportedAt}`,
      ].join("\n"),
    };
  }

  const counts = async (tenantId: string) => {
    const [row] = await admin<
      { trips: number; bookings: number; holds: number; sessions: number }[]
    >`
      select (select count(*) from public.scheduled_trips where tenant_id = ${tenantId})::int as trips,
             (select count(*) from public.bookings where tenant_id = ${tenantId})::int as bookings,
             (select count(*) from public.capacity_holds where tenant_id = ${tenantId})::int as holds,
             (select count(*) from public.checkout_sessions where tenant_id = ${tenantId})::int as sessions`;
    return row;
  };

  beforeAll(async () => {
    if (!env) return;
    admin = postgres(env.adminUrl, { max: 4, onnotice: () => {} });
    runtime = createDb(env.runtimeUrl, { max: 6 });
    [A, B] = await Promise.all([
      createCheckoutFixture(admin, runtime.db, "imp-a", { days: 6 }),
      createCheckoutFixture(admin, runtime.db, "imp-b", { days: 2 }),
    ]);
    ownerA = await member(A.id, "owner");
    deskA = await member(A.id, "booking_staff");
    ownerB = await member(B.id, "owner");
    const [clock] = await admin<{ day: string; exported: string }[]>`
      select ((now() at time zone 'UTC')::date + 3)::text as day,
             to_char((now() - interval '1 hour') at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') as exported`;
    day = clock?.day ?? "";
    exportedAt = clock?.exported ?? "";
  }, 180_000);

  afterAll(async () => {
    await runtime?.end();
    await admin?.end({ timeout: 5 });
  });

  it("checks a clean batch against the tenant, writes none of it, and records the run", async () => {
    const before = await counts(A.id);
    const ctx = staffCtx(A.id, ownerA);
    const files = batch(A, { batchId: "CLEAN-1" });
    const result = await inTenantTransaction(runtime.db, ctx, (trx) =>
      runImportDryRun(trx, ctx, files),
    );
    if (result.kind !== "checked") throw new Error(JSON.stringify(result));
    // The charter's balance is checked; saving it comes in a later part (a warning here).
    expect(result.result.issues.map((i) => [i.code, i.severity])).toEqual([
      ["import_not_supported_yet", "warning"],
    ]);
    expect(result.result.clean).toBe(true);
    expect(await counts(A.id)).toEqual(before);

    const [run] = await admin<
      {
        batch_id: string;
        run_number: number;
        clean: boolean;
        content_hash: string;
        actor_id: string;
        files: unknown;
      }[]
    >`select batch_id, run_number, clean, content_hash, actor_id, files
        from public.import_runs where id = ${result.runId ?? ""}`;
    expect(run).toMatchObject({
      batch_id: "CLEAN-1",
      run_number: 1,
      clean: true,
      content_hash: result.contentHash,
      actor_id: ownerA,
    });
    expect(run?.files).toMatchObject({ "bookings.csv": { rows: 3, accepted: 3, refused: 0 } });
    // Neither the run nor its audit event holds a name or an email from the files.
    const [audit] = await admin<{ after_state: unknown }[]>`
      select after_state from public.audit_events
       where tenant_id = ${A.id} and action = 'import.dry_run' and subject_id = ${result.runId ?? ""}`;
    expect(audit?.after_state).toMatchObject({ batchId: "CLEAN-1", clean: true });
    const [stored] = await admin<{ text: string }[]>`
      select (select row_to_json(r)::text from public.import_runs r where r.id = ${result.runId ?? ""})
             || (select coalesce(string_agg(after_state::text, ''), '') from public.audit_events
                  where tenant_id = ${A.id} and action = 'import.dry_run') as text`;
    expect(stored?.text).not.toMatch(/ima\.sample|Ima Sample|Jo Fixture/);

    // The same run number again is refused; the next one is taken.
    const again = await inTenantTransaction(runtime.db, ctx, (trx) =>
      runImportDryRun(trx, ctx, files),
    );
    expect(again).toEqual({
      kind: "run_number_used",
      batchId: "CLEAN-1",
      runNumber: 1,
      expected: 2,
    });
    // Skipping ahead is refused too.
    const skipped = await inTenantTransaction(runtime.db, ctx, (trx) =>
      runImportDryRun(trx, ctx, batch(A, { batchId: "CLEAN-1", run: 5 })),
    );
    expect(skipped).toMatchObject({ kind: "run_number_used", expected: 2 });
    const second = await inTenantTransaction(runtime.db, ctx, (trx) =>
      runImportDryRun(trx, ctx, batch(A, { batchId: "CLEAN-1", run: 2 })),
    );
    expect(second).toMatchObject({ kind: "checked", contentHash: result.contentHash });
    // A batch keeps its source system.
    const moved = await inTenantTransaction(runtime.db, ctx, (trx) =>
      runImportDryRun(trx, ctx, batch(A, { batchId: "CLEAN-1", run: 3, source: "other-system" })),
    );
    expect(moved).toEqual({ kind: "source_changed", batchId: "CLEAN-1" });
  });

  it("counts the trip's live holds and refuses what would overbook it", async () => {
    // The fixture's 10:00 trip has 10 seats; 6 are held already.
    const [trip] = await admin<{ id: string }[]>`
      select id from public.scheduled_trips
       where tenant_id = ${A.id} and boat_id = ${A.boats.lark} and local_date = ${day}::date
         and local_start_time = '10:00'`;
    if (!trip) throw new Error("no fixture trip");
    const holdCtx: TenantContext = {
      tenantId: A.id,
      actorType: "system",
      actorId: "imp-test",
      requestId: "r",
    };
    await inTenantTransaction(runtime.db, holdCtx, async (trx) => {
      await trx
        .insertInto("capacity_holds")
        .values({
          tenant_id: A.id,
          trip_id: trip.id,
          owner_ref: `test:${randomUUID()}`,
          party_size: 6,
          expires_at: new Date(Date.now() + 30 * 60_000),
        })
        .execute();
    });
    const ctx = staffCtx(A.id, ownerA);
    const result = await inTenantTransaction(runtime.db, ctx, (trx) =>
      runImportDryRun(trx, ctx, batch(A, { batchId: "FULL-1", party: 5 })),
    );
    if (result.kind !== "checked") throw new Error(JSON.stringify(result));
    expect(result.result.issues).toContainEqual(
      expect.objectContaining({ file: "bookings.csv", line: 2, code: "over_capacity" }),
    );
    expect(result.result.clean).toBe(false);
  });

  it("refuses another operator's product and boat, and records nothing for anyone but an owner", async () => {
    const ctxB = staffCtx(B.id, ownerB);
    // Tenant B's owner names tenant A's product and boat ids.
    const result = await inTenantTransaction(runtime.db, ctxB, (trx) =>
      runImportDryRun(trx, ctxB, batch(A, { batchId: "CROSS-1" })),
    );
    if (result.kind !== "checked") throw new Error(JSON.stringify(result));
    expect(
      result.result.issues.filter((i) => i.file === "products.csv").map((i) => i.code),
    ).toEqual(["product_not_found", "product_not_found"]);
    expect(result.result.issues.every((i) => i.code !== "boat_overlap")).toBe(true);

    // Booking staff: the database refuses the run's record.
    const desk = staffCtx(A.id, deskA);
    await expect(
      inTenantTransaction(runtime.db, desk, (trx) =>
        runImportDryRun(trx, desk, batch(A, { batchId: "DESK-1" })),
      ),
    ).rejects.toMatchObject({ code: "42501", constraint_name: "import_runs_owner" });
    // The runs are append-only.
    await expect(
      admin`delete from public.import_runs where tenant_id = ${A.id}`,
    ).rejects.toMatchObject({
      code: "55000",
    });
    // Tenant B sees none of tenant A's runs.
    const seen = await inTenantTransaction(runtime.db, ctxB, (trx) =>
      trx.selectFrom("import_runs").select("batch_id").execute(),
    );
    expect(seen.map((r) => r.batch_id)).toEqual(["CROSS-1"]);
  });
});
