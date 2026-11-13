/**
 * W3-G2.13, part D2: waiver email for imported bookings. Saving a batch sends
 * nothing; the cron's import waiver sweep creates the guests' requests and
 * emails them, right away for a batch saved with send_at_cutover, and only
 * after an owner releases a batch saved with hold_until_staff_release. The
 * batch that imported a guest decides. Against PostgreSQL as tidegrid_app,
 * with the real import commit.
 */
import { randomUUID } from "node:crypto";
import { createDb, inTenantTransaction, type TenantContext } from "@tidegrid/database";
import type {} from "@tidegrid/database/global-setup";
import { runImportCommit, runImportDryRun } from "@tidegrid/domain-booking";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";
import {
  assignBookingWaivers,
  releaseImportWaiverEmail,
  sendWaiverRequest,
  sweepImportWaiverEmail,
} from "./index.ts";
import { createWaiverFixture, fixtureDeps, type WaiverFixture } from "./test-fixtures.ts";

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
  let laterDays: string[] = [];
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

  interface Batch {
    batchId: string;
    /** The legacy booking; a later batch naming the same one adds guests to it. */
    ref?: string;
    /** Guests beyond the first two (a third, added by a later batch). */
    third?: boolean;
    /** The trip's date, when not the usual one. */
    day?: string;
    /** Instead: this many guests, all at crowd@example.test. */
    crowd?: number;
    notify: Notify;
  }

  /**
   * One booking for three on the fixture's 10:00 shared trip: one guest with an
   * email, one without, and a third only when the batch adds one.
   */
  function files(
    t: WaiverFixture,
    o: Batch & { run: number; mode: "dry_run" | "commit" },
    totals: string[],
  ): Record<string, string> {
    const ref = o.ref ?? o.batchId;
    const tripDay = o.day ?? day;
    const tripId = o.day ? `T-${o.day}` : "T-AM";
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
        `${tripId},P-SEATS,${t.boats.lark},${tripDay},10:00,UTC,,`,
      ].join("\n"),
      "customers.csv": [
        "source_customer_id,full_name,email,phone",
        `C-${ref},Ima Sample,ima.${ref.toLowerCase()}@example.test,`,
      ].join("\n"),
      "bookings.csv": [
        "source_booking_ref,trip_date,source_trip_id,source_customer_id,booking_source,staff_channel,ota_channel,party_size,subtotal_cents,discount_cents,fee_cents,tax_cents,included_tax_cents,total_cents,balance_due_date,booked_at",
        `R-${ref},${tripDay},${tripId},C-${ref},direct,,,${o.crowd ?? 3},10000,0,0,0,0,10000,,${exportedAt}`,
      ].join("\n"),
      "participants.csv": [
        "source_booking_ref,trip_date,position,full_name,is_minor,email,guardian_name,guardian_email",
        ...(o.crowd
          ? Array.from(
              { length: o.crowd },
              (_, k) => `R-${ref},${tripDay},${k + 1},Guest ${k + 1},false,crowd@example.test,,`,
            )
          : [
              `R-${ref},${tripDay},1,Ima Sample,false,ima.${ref.toLowerCase()}@example.test,,`,
              `R-${ref},${tripDay},2,Ola Nomail,false,,,`,
              ...(o.third
                ? [`R-${ref},${tripDay},3,Tia Third,false,tia.${ref.toLowerCase()}@example.test,,`]
                : []),
            ]),
      ].join("\n"),
      "payments.csv": [
        "source_payment_id,source_booking_ref,trip_date,entry_kind,amount_cents,tender,reference,received_at",
        `PAY-${ref},R-${ref},${tripDay},payment,10000,cash,,${exportedAt}`,
      ].join("\n"),
    };
  }

  /** Two dry runs (the second with the totals the first computed), then the commit. */
  async function save(t: WaiverFixture, owner: string, batch: Batch) {
    const ctx = staff(t.id, owner);
    const first = await inTenantTransaction(runtime.db, ctx, (trx) =>
      runImportDryRun(trx, ctx, files(t, { ...batch, run: 1, mode: "dry_run" }, [])),
    );
    if (first.kind !== "checked") throw new Error(JSON.stringify(first));
    const totals = first.result.controls.map((c) => `${c.metric},${c.file},${c.computed}`);
    const second = await inTenantTransaction(runtime.db, ctx, (trx) =>
      runImportDryRun(trx, ctx, files(t, { ...batch, run: 2, mode: "dry_run" }, totals)),
    );
    if (second.kind !== "checked" || !second.result.clean) {
      throw new Error(JSON.stringify(second));
    }
    const saved = await inTenantTransaction(runtime.db, ctx, (trx) =>
      runImportCommit(trx, ctx, files(t, { ...batch, run: 3, mode: "commit" }, totals)),
    );
    if (saved.kind !== "committed") throw new Error(JSON.stringify(saved));
    const [booking] = await admin<{ id: string }[]>`
      select b.id from public.bookings b
        join public.import_bookings ib on ib.checkout_session_id = b.checkout_session_id
        join public.import_records r on r.id = ib.record_id
        join public.import_runs run on run.id = r.run_id
       where run.tenant_id = ${t.id} and r.file = 'bookings.csv'
         and r.dedupe_key like ${`%R-${batch.ref ?? batch.batchId}%`}`;
    if (!booking) throw new Error("no imported booking");
    return { runId: saved.runId, bookingId: booking.id };
  }

  const sweep = (emailsPerTenant?: number) =>
    sweepImportWaiverEmail(runtime.db, {
      runId: `sweep-${randomUUID()}`,
      deps: fixtureDeps(),
      ...(emailsPerTenant ? { emailsPerTenant } : {}),
    });

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
    const [clock] = await admin<{ day: string; day4: string; day5: string; exported: string }[]>`
      select ((now() at time zone 'UTC')::date + 3)::text as day,
             ((now() at time zone 'UTC')::date + 4)::text as day4,
             ((now() at time zone 'UTC')::date + 5)::text as day5,
             to_char((now() - interval '1 hour') at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') as exported`;
    day = clock?.day ?? "";
    laterDays = [clock?.day4 ?? "", clock?.day5 ?? ""];
    exportedAt = clock?.exported ?? "";
  }, 180_000);

  afterAll(async () => {
    await runtime?.end();
    await admin?.end({ timeout: 5 });
  });

  it("sends nothing at save; the sweep emails a send_at_cutover batch once", async () => {
    const { runId, bookingId } = await save(A, ownerA, {
      batchId: "CUT",
      notify: "send_at_cutover",
    });
    expect(await waiverMail(bookingId)).toEqual([]);
    await sweep();
    // The guest with an email gets hers; the one without waits for an address
    // and does not keep the booking in the sweep.
    expect(await waiverMail(bookingId)).toEqual([
      { state: "pending", deliveries: 1 },
      { state: "pending", deliveries: 0 },
    ]);
    const [done] = await admin<{ n: number }[]>`
      select count(*)::int as n from public.import_waiver_email_done
       where run_id = ${runId} and booking_id = ${bookingId}`;
    expect(done?.n).toBe(1);
    await sweep();
    expect(await waiverMail(bookingId)).toEqual([
      { state: "pending", deliveries: 1 },
      { state: "pending", deliveries: 0 },
    ]);
  });

  it("holds a batch's email until an owner releases it, once", async () => {
    const { runId, bookingId } = await save(A, ownerA, {
      batchId: "HOLD",
      notify: "hold_until_staff_release",
    });
    await sweep();
    expect(await waiverMail(bookingId)).toEqual([]);
    // Requests staff create are not emailed while the batch holds them.
    const desk = staff(A.id, deskA);
    const assigned = await inTenantTransaction(runtime.db, desk, (trx) =>
      assignBookingWaivers(trx, desk, fixtureDeps(), { bookingId }),
    );
    expect(assigned.created.map((c) => c.delivery.kind)).toEqual([
      "imported_booking",
      "imported_booking",
    ]);
    const early = await inTenantTransaction(runtime.db, desk, (trx) =>
      sendWaiverRequest(trx, desk, fixtureDeps(), {
        requestId: assigned.created[0]?.requestId ?? "",
        kind: "resend",
        reason: "Guest asked",
      }),
    );
    expect(early).toEqual({ kind: "imported_booking" });
    // Booking staff cannot release it: the database wants an owner.
    await expect(
      inTenantTransaction(runtime.db, desk, (trx) =>
        releaseImportWaiverEmail(trx, desk, { runId }),
      ),
    ).rejects.toMatchObject({ code: "42501" });

    const owner = staff(A.id, ownerA);
    expect(
      await inTenantTransaction(runtime.db, owner, (trx) =>
        releaseImportWaiverEmail(trx, owner, { runId }),
      ),
    ).toEqual({ kind: "released", releasedNow: true, waitingBookings: 1 });
    await sweep();
    expect(await waiverMail(bookingId)).toEqual([
      { state: "pending", deliveries: 1 },
      { state: "pending", deliveries: 0 },
    ]);
    // Again: recorded once, and nothing left waiting.
    expect(
      await inTenantTransaction(runtime.db, owner, (trx) =>
        releaseImportWaiverEmail(trx, owner, { runId }),
      ),
    ).toEqual({ kind: "released", releasedNow: false, waitingBookings: 0 });
    const [releases] = await admin<{ n: number }[]>`
      select count(*)::int as n from public.import_email_releases where run_id = ${runId}`;
    expect(releases?.n).toBe(1);
    const audits = await admin<{ after_state: unknown }[]>`
      select after_state from public.audit_events
       where action = 'import.waiver_email.released' and subject_id = ${runId}`;
    expect(audits.map((a) => a.after_state)).toEqual([{ waitingBookings: 1 }]);
  });

  it("follows the batch that imported each guest", async () => {
    // Batch 1 sends at cutover; batch 2 holds, and adds a third guest.
    const { bookingId } = await save(A, ownerA, { batchId: "MIX1", notify: "send_at_cutover" });
    await sweep();
    const { runId: held } = await save(A, ownerA, {
      batchId: "MIX2",
      ref: "MIX1",
      third: true,
      notify: "hold_until_staff_release",
    });
    await sweep();
    expect(await waiverMail(bookingId)).toEqual([
      { state: "pending", deliveries: 1 },
      { state: "pending", deliveries: 0 },
    ]);
    const owner = staff(A.id, ownerA);
    await inTenantTransaction(runtime.db, owner, (trx) =>
      releaseImportWaiverEmail(trx, owner, { runId: held }),
    );
    await sweep();
    expect(await waiverMail(bookingId)).toEqual([
      { state: "pending", deliveries: 1 },
      { state: "pending", deliveries: 0 },
      { state: "pending", deliveries: 1 },
    ]);
  });

  it("stops at the run's email budget for an operator", async () => {
    const one = await save(B, ownerB, { batchId: "CAP1", notify: "send_at_cutover" });
    const two = await save(B, ownerB, { batchId: "CAP2", notify: "send_at_cutover" });
    const capped = await sweep(1);
    // Stopped with a booking waiting: the run says so.
    expect(capped.cappedTenants).toBeGreaterThanOrEqual(1);
    expect(capped.complete).toBe(false);
    const sent = async () =>
      (await waiverMail(one.bookingId)).length + (await waiverMail(two.bookingId)).length;
    expect(await sent()).toBe(2);
    await sweep(1);
    expect(await sent()).toBe(4);
  });

  it("leaves a booking a sending limit held for a later run, and sends it once", async () => {
    // Eleven guests over two batches share one address, which takes ten an hour.
    await save(B, ownerB, {
      batchId: "BUSY1",
      crowd: 8,
      day: laterDays[0],
      notify: "send_at_cutover",
    });
    await sweep();
    const { runId, bookingId } = await save(B, ownerB, {
      batchId: "BUSY2",
      crowd: 3,
      day: laterDays[1],
      notify: "send_at_cutover",
    });
    const delivered = async () =>
      (await waiverMail(bookingId)).reduce((n, w) => n + w.deliveries, 0);
    const done = async () =>
      (
        await admin<{ n: number }[]>`
          select count(*)::int as n from public.import_waiver_email_done
           where run_id = ${runId} and booking_id = ${bookingId}`
      )[0]?.n;
    const first = await sweep();
    expect(await delivered()).toBe(2);
    expect(await done()).toBe(0);
    expect(first.complete).toBe(false);
    // An hour later (moved back, with the guard off for that statement only).
    await admin.begin(async (tx) => {
      await tx`alter table public.waiver_deliveries disable trigger waiver_deliveries_append_only`;
      await tx`update public.waiver_deliveries d
                  set created_at = d.created_at - interval '61 minutes',
                      send_after = d.send_after - interval '61 minutes'
                where d.recipient_email = 'crowd@example.test'`;
      await tx`alter table public.waiver_deliveries enable trigger waiver_deliveries_append_only`;
    });
    await sweep();
    expect(await delivered()).toBe(3);
    expect(await done()).toBe(1);
    await sweep();
    expect(await delivered()).toBe(3);
  });

  it("finds no other tenant's batch, and releases no batch that never held", async () => {
    const { runId } = await save(B, ownerB, {
      batchId: "OTHER",
      notify: "hold_until_staff_release",
    });
    const owner = staff(A.id, ownerA);
    expect(
      await inTenantTransaction(runtime.db, owner, (trx) =>
        releaseImportWaiverEmail(trx, owner, { runId }),
      ),
    ).toEqual({ kind: "not_found" });
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
