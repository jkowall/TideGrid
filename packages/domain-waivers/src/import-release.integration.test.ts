/**
 * W3-G2.13, part D2: waiver email for imported bookings. A batch saved with
 * send_at_cutover emails its guests' waivers as it is saved; one saved with
 * hold_until_staff_release creates the requests and emails nothing until an
 * owner releases it, once. Against PostgreSQL as tidegrid_app, with the real
 * import commit and the waiver hooks.
 */
import { randomUUID } from "node:crypto";
import { createDb, inTenantTransaction, type TenantContext } from "@tidegrid/database";
import type {} from "@tidegrid/database/global-setup";
import { runImportCommit, runImportDryRun } from "@tidegrid/domain-booking";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";
import { releaseImportWaiverEmail, sendWaiverRequest } from "./index.ts";
import {
  createWaiverFixture,
  fixtureDeps,
  fixtureHooks,
  type WaiverFixture,
} from "./test-fixtures.ts";

type Sql = ReturnType<typeof postgres>;
const env = inject("integrationDb");

type Notify = "send_at_cutover" | "hold_until_staff_release";

describe.skipIf(!env)("waiver email for imported bookings", () => {
  let admin: Sql;
  let runtime: ReturnType<typeof createDb>;
  let A: WaiverFixture;
  let B: WaiverFixture;
  let ownerA: string;
  let deskA: string;
  let ownerB: string;
  let day = "";
  let exportedAt = "";

  async function member(tenantId: string, role: "owner" | "booking_staff"): Promise<string> {
    const id = randomUUID();
    await admin`insert into public.staff_users (id, email, display_name)
      values (${id}, ${`iwr-${id.slice(0, 8)}@example.test`}, ${role})`;
    await admin`insert into public.tenant_memberships (tenant_id, user_id, role, display_name)
      values (${tenantId}, ${id}, ${role}, ${role})`;
    return id;
  }

  const staff = (tenantId: string, userId: string): TenantContext => ({
    tenantId,
    actorType: "staff",
    actorId: userId,
    requestId: `req-${randomUUID()}`,
    sourceIp: null,
  });

  /** One booking of two on the fixture's 10:00 shared trip: one guest with an email, one without. */
  function files(
    t: WaiverFixture,
    o: { batchId: string; run: number; mode: "dry_run" | "commit"; notify: Notify },
    totals: string[],
  ): Record<string, string> {
    return {
      "manifest.csv": [
        "item,file,value",
        `batch_id,,${o.batchId}`,
        `run_number,,${o.run}`,
        "source_system,,legacy-booker",
        "mapping_version,,std-csv-v0",
        `batch_mode,,${o.mode}`,
        "operator_time_zone,,UTC",
        `exported_at,,${exportedAt}`,
        `waiver_notifications,,${o.notify}`,
        ...totals,
      ].join("\n"),
      "products.csv": [
        "source_product_id,source_product_name,tidegrid_product_id,tidegrid_product_name,product_kind",
        `P-SEATS,Legacy seats,${t.products.shared},Harbor Seats,shared_seat`,
      ].join("\n"),
      "trips.csv": [
        "source_trip_id,source_product_id,tidegrid_boat_id,local_date,local_start_time,time_zone,utc_offset,seat_capacity",
        `T-AM,P-SEATS,${t.boats.lark},${day},10:00,UTC,,`,
      ].join("\n"),
      "customers.csv": [
        "source_customer_id,full_name,email,phone",
        `C-${o.batchId},Ima Sample,ima.${o.batchId.toLowerCase()}@example.test,`,
      ].join("\n"),
      "bookings.csv": [
        "source_booking_ref,trip_date,source_trip_id,source_customer_id,booking_source,staff_channel,ota_channel,party_size,subtotal_cents,discount_cents,fee_cents,tax_cents,included_tax_cents,total_cents,balance_due_date,booked_at",
        `R-${o.batchId},${day},T-AM,C-${o.batchId},direct,,,2,10000,0,0,0,0,10000,,${exportedAt}`,
      ].join("\n"),
      "participants.csv": [
        "source_booking_ref,trip_date,position,full_name,is_minor,email,guardian_name,guardian_email",
        `R-${o.batchId},${day},1,Ima Sample,false,ima.${o.batchId.toLowerCase()}@example.test,,`,
        `R-${o.batchId},${day},2,Ola Nomail,false,,,`,
      ].join("\n"),
      "payments.csv": [
        "source_payment_id,source_booking_ref,trip_date,entry_kind,amount_cents,tender,reference,received_at",
        `PAY-${o.batchId},R-${o.batchId},${day},payment,10000,cash,,${exportedAt}`,
      ].join("\n"),
    };
  }

  /** Two dry runs (the second with the totals the first computed), then the commit. */
  async function save(t: WaiverFixture, owner: string, batchId: string, notify: Notify) {
    const ctx = staff(t.id, owner);
    const first = await inTenantTransaction(runtime.db, ctx, (trx) =>
      runImportDryRun(trx, ctx, files(t, { batchId, run: 1, mode: "dry_run", notify }, [])),
    );
    if (first.kind !== "checked") throw new Error(JSON.stringify(first));
    const totals = first.result.controls.map((c) => `${c.metric},${c.file},${c.computed}`);
    const second = await inTenantTransaction(runtime.db, ctx, (trx) =>
      runImportDryRun(trx, ctx, files(t, { batchId, run: 2, mode: "dry_run", notify }, totals)),
    );
    if (second.kind !== "checked" || !second.result.clean) {
      throw new Error(JSON.stringify(second));
    }
    const saved = await inTenantTransaction(runtime.db, ctx, (trx) =>
      runImportCommit(
        trx,
        ctx,
        files(t, { batchId, run: 3, mode: "commit", notify }, totals),
        fixtureHooks(),
      ),
    );
    if (saved.kind !== "committed") throw new Error(JSON.stringify(saved));
    const [booking] = await admin<{ id: string }[]>`
      select b.id from public.bookings b
        join public.import_bookings ib on ib.checkout_session_id = b.checkout_session_id
        join public.import_records r on r.id = ib.record_id
       where r.run_id = ${saved.runId}`;
    if (!booking) throw new Error("no imported booking");
    return { runId: saved.runId, bookingId: booking.id };
  }

  async function waiverMail(bookingId: string) {
    return admin<{ state: string; deliveries: number }[]>`
      select w.state,
             (select count(*) from public.waiver_deliveries d where d.request_id = w.id)::int
               as deliveries
        from public.waiver_requests w
        join public.booking_participants p on p.id = w.participant_id
       where w.booking_id = ${bookingId}
       order by p.position`;
  }

  beforeAll(async () => {
    if (!env) return;
    admin = postgres(env.adminUrl, { max: 4, onnotice: () => {} });
    runtime = createDb(env.runtimeUrl, { max: 6 });
    [A, B] = await Promise.all([
      createWaiverFixture(admin, runtime.db, "iwr-a", { days: 6 }),
      createWaiverFixture(admin, runtime.db, "iwr-b", { days: 6 }),
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

  it("emails the waivers as the batch is saved, when it says send_at_cutover", async () => {
    const { bookingId } = await save(A, ownerA, "CUT", "send_at_cutover");
    // The guest with an email gets hers; the one without waits for an address.
    expect(await waiverMail(bookingId)).toEqual([
      { state: "pending", deliveries: 1 },
      { state: "pending", deliveries: 0 },
    ]);
  });

  it("holds them until an owner releases the batch, once", async () => {
    const { runId, bookingId } = await save(A, ownerA, "HOLD", "hold_until_staff_release");
    expect(await waiverMail(bookingId)).toEqual([
      { state: "pending", deliveries: 0 },
      { state: "pending", deliveries: 0 },
    ]);
    // Staff's own send is refused while the batch holds it.
    const desk = staff(A.id, deskA);
    const [request] = await admin<{ id: string }[]>`
      select w.id from public.waiver_requests w
        join public.booking_participants p on p.id = w.participant_id
       where w.booking_id = ${bookingId} and p.position = 1`;
    const early = await inTenantTransaction(runtime.db, desk, (trx) =>
      sendWaiverRequest(trx, desk, fixtureDeps(), {
        requestId: request?.id ?? "",
        kind: "resend",
        reason: "Guest asked",
      }),
    );
    expect(early).toEqual({ kind: "imported_booking" });
    // Booking staff cannot release it: the database wants an owner.
    await expect(
      inTenantTransaction(runtime.db, desk, (trx) =>
        releaseImportWaiverEmail(trx, desk, fixtureDeps(), { runId }),
      ),
    ).rejects.toMatchObject({ code: "42501" });

    const owner = staff(A.id, ownerA);
    const released = await inTenantTransaction(runtime.db, owner, (trx) =>
      releaseImportWaiverEmail(trx, owner, fixtureDeps(), { runId }),
    );
    expect(released).toEqual({
      kind: "released",
      releasedNow: true,
      queued: 1,
      notSent: 1,
      remaining: 0,
    });
    expect(await waiverMail(bookingId)).toEqual([
      { state: "pending", deliveries: 1 },
      { state: "pending", deliveries: 0 },
    ]);
    // Again: nothing sent twice, and the release is not recorded again.
    const again = await inTenantTransaction(runtime.db, owner, (trx) =>
      releaseImportWaiverEmail(trx, owner, fixtureDeps(), { runId }),
    );
    expect(again).toEqual({
      kind: "released",
      releasedNow: false,
      queued: 0,
      notSent: 1,
      remaining: 0,
    });
    const [releases] = await admin<{ n: number }[]>`
      select count(*)::int as n from public.import_email_releases where run_id = ${runId}`;
    expect(releases?.n).toBe(1);
    // Each call is audited, counts only.
    const audits = await admin<{ after_state: unknown }[]>`
      select after_state from public.audit_events
       where action = 'import.waiver_email.released' and subject_id = ${runId}
       order by id`;
    expect(audits.map((a) => a.after_state)).toEqual([
      { releasedNow: true, queued: 1, notSent: 1, remaining: 0 },
      { releasedNow: false, queued: 0, notSent: 1, remaining: 0 },
    ]);
  });

  it("finds no other tenant's batch, and releases no batch that never held", async () => {
    const { runId } = await save(B, ownerB, "OTHER", "hold_until_staff_release");
    const owner = staff(A.id, ownerA);
    expect(
      await inTenantTransaction(runtime.db, owner, (trx) =>
        releaseImportWaiverEmail(trx, owner, fixtureDeps(), { runId }),
      ),
    ).toEqual({ kind: "not_found" });
    const [held] = await admin<{ n: number }[]>`
      select count(*)::int as n from public.waiver_deliveries d
        join public.waiver_requests w on w.id = d.request_id
       where w.tenant_id = ${B.id}`;
    expect(held?.n).toBe(0);
    const [cutover] = await admin<{ id: string }[]>`
      select id from public.import_runs
       where tenant_id = ${A.id} and batch_id = 'CUT' and mode = 'commit'`;
    await expect(
      inTenantTransaction(runtime.db, owner, (trx) =>
        trx
          .insertInto("import_email_releases")
          .values({ tenant_id: A.id, run_id: cutover?.id ?? "" })
          .execute(),
      ),
    ).rejects.toMatchObject({ code: "23514" });
  });
});
