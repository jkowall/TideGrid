/**
 * Saving a standard CSV import batch (W3-G2.13, commit step, part A).
 *
 * A commit follows its batch's latest run, a clean dry run of the same files,
 * and checks the files again against TideGrid as it is now. A clean result is
 * written all or nothing: the commit run, one ledger row per record, new trips
 * (in draft), and for each booking its imported checkout header, order
 * statement, confirmed hold, booking, participants, and legacy payments and
 * refunds as labeled external settlements. A refused commit is recorded too,
 * not clean, so the next commit needs a fresh dry run.
 *
 * Nothing here sends an email, runs a booking hook, or calls a provider.
 * Personal data stays in the ledger and on the booking's own rows, never in
 * the run record, the audit row, or the response.
 */
import { recordAudit, type TenantContext, type TenantTransaction } from "@tidegrid/database";
import { sql } from "kysely";
import { CORE_FEE_BP, feeReversalFor } from "../fee-ledger.ts";
import { newBookingReference } from "../secrets.ts";
import { importContentHash, importLookup } from "./dry-run.ts";
import type { ImportFile } from "./spec.ts";
import { type ImportDryRun, type ImportPlan, validateImport } from "./validate.ts";

export interface ImportCommitCounts {
  trips: number;
  tripsCreated: number;
  customers: number;
  bookings: number;
  participants: number;
  payments: number;
  refunds: number;
  /** Opening booking credits (part C). */
  credits: number;
  /** Rows imported before, unchanged: nothing written for them. */
  unchanged: number;
}

export type ImportCommitResult =
  /** Saved: the run's id and what it wrote. */
  | {
      kind: "committed";
      runId: string;
      contentHash: string;
      committedAt: string;
      counts: ImportCommitCounts;
      result: ImportDryRun;
    }
  /**
   * Checked again and refused (an error, or a total that no longer matches).
   * Recorded as a commit run that is not clean, so the next try needs a fresh
   * dry run. `runId` is null when the manifest could not be read.
   */
  | {
      kind: "refused";
      runId: string | null;
      contentHash: string;
      checkedAt: string;
      result: ImportDryRun;
    }
  /** The database refused a write (another batch or a booking got there first). Recorded as refused. */
  | {
      kind: "write_refused";
      runId: string;
      batchId: string;
      constraint: string | null;
      contentHash: string;
      checkedAt: string;
      result: ImportDryRun;
    }
  /** The run number is not the batch's next one. */
  | { kind: "run_number_used"; batchId: string; runNumber: number; expected: number }
  /** The batch's earlier runs name another source system. */
  | { kind: "source_changed"; batchId: string }
  /** The batch's latest run is not a clean dry run. */
  | { kind: "no_clean_dry_run"; batchId: string }
  /** The files differ from the clean dry run's. */
  | { kind: "batch_changed_since_dry_run"; batchId: string }
  /** The batch was committed already; a final delta is a new batch. */
  | { kind: "already_committed"; batchId: string }
  /** A product the batch books has no cancellation policy yet. */
  | { kind: "product_missing_policy"; batchId: string; productIds: string[] }
  /** More new rows than one commit writes; split the batch. */
  | { kind: "too_large"; batchId: string; rows: number; limit: number };

/**
 * New rows one commit writes at most. A commit is one transaction that holds
 * its trips' locks until it ends, so a bigger one would stall the trips'
 * checkouts; a bigger export is sent as several batches.
 */
export const MAX_COMMIT_ROWS = 5_000;

type Files = Partial<Record<ImportFile, string | undefined>>;

/**
 * Commits a batch as the signed-in owner in `ctx` (the database checks the
 * role). The time of the check is the database's. Runs inside the caller's
 * READ COMMITTED transaction.
 */
export async function runImportCommit(
  trx: TenantTransaction,
  ctx: TenantContext,
  files: Files,
): Promise<ImportCommitResult> {
  if (ctx.actorType !== "staff" || !ctx.actorId) {
    throw new TypeError("an import is run by a signed-in staff member");
  }
  const tenantId = ctx.tenantId;
  const contentHash = await importContentHash(files);
  const { rows: clock } = await sql<{ now: Date }>`select now() as now`.execute(trx);
  const checkedAt = new Date(clock[0]?.now ?? Date.now());

  // The manifest first, to take the batch's lock before reading anything the
  // check depends on: two commits of one batch take turns.
  const peek = await validateImport(
    { "manifest.csv": files["manifest.csv"] },
    importLookup(trx, tenantId),
    checkedAt.getTime(),
    "commit",
  );
  const pm = peek.manifest;
  if (!pm) {
    const result = await validateImport(
      files,
      importLookup(trx, tenantId),
      checkedAt.getTime(),
      "commit",
    );
    return {
      kind: "refused",
      runId: null,
      contentHash,
      checkedAt: checkedAt.toISOString(),
      result,
    };
  }
  const batchId = pm.batchId;
  await sql`select pg_advisory_xact_lock(hashtext(${`import_runs:${tenantId}:${batchId}`}))`.execute(
    trx,
  );
  const { rows: earlier } = await sql<{
    id: string;
    run_number: number;
    source_system: string;
    mode: "dry_run" | "commit";
    clean: boolean;
    content_hash: string;
  }>`
    select id, run_number, source_system, mode, clean, content_hash from import_runs
     where tenant_id = ${tenantId} and batch_id = ${batchId}
     order by run_number desc`.execute(trx);
  if (earlier.some((r) => r.mode === "commit" && r.clean)) {
    return { kind: "already_committed", batchId };
  }
  if (earlier.some((r) => r.source_system !== pm.sourceSystem)) {
    return { kind: "source_changed", batchId };
  }
  const latest = earlier[0];
  const expected = (latest?.run_number ?? 0) + 1;
  if (pm.runNumber !== expected) {
    return { kind: "run_number_used", batchId, runNumber: pm.runNumber, expected };
  }
  if (latest?.mode !== "dry_run" || !latest.clean) {
    return { kind: "no_clean_dry_run", batchId };
  }
  if (latest.content_hash !== contentHash) {
    return { kind: "batch_changed_since_dry_run", batchId };
  }

  const result = await validateImport(
    files,
    importLookup(trx, tenantId),
    checkedAt.getTime(),
    "commit",
  );
  const m = result.manifest;
  // The manifest was read above; reading it again gives the same values.
  if (!m) throw new Error("an import manifest read once did not read again");

  const runValues = {
    tenant_id: tenantId,
    batch_id: batchId,
    run_number: m.runNumber,
    source_system: m.sourceSystem,
    mapping_version: "std-csv-v0" as const,
    mode: "commit" as const,
    dry_run_id: latest.id,
    content_hash: contentHash,
    waiver_notifications: m.waiverNotifications,
    files: Object.fromEntries(
      result.files
        .filter((f) => f.file !== "manifest.csv")
        .map((f) => [f.file, { rows: f.rows, accepted: f.accepted, refused: f.refused }]),
    ),
    controls: Object.fromEntries(
      result.controls.map((c) => [
        `${c.metric}|${c.file}`,
        { declared: c.declared, computed: c.computed },
      ]),
    ),
  };
  const refuse = async (errorCount: number) => {
    const row = await trx
      .insertInto("import_runs")
      .values({
        ...runValues,
        clean: false,
        error_count: errorCount,
        warning_count: result.warningCount,
      })
      .returning("id")
      .executeTakeFirstOrThrow();
    await recordAudit(trx, ctx, {
      action: "import.commit_refused",
      subjectType: "import_run",
      subjectId: row.id,
      after: {
        batchId,
        runNumber: m.runNumber,
        sourceSystem: m.sourceSystem,
        errorCount,
        warningCount: result.warningCount,
      },
    });
    return row.id;
  };

  const plan = result.plan;
  if (!result.clean || !plan) {
    const runId = await refuse(result.errorCount);
    return { kind: "refused", runId, contentHash, checkedAt: checkedAt.toISOString(), result };
  }

  // Every booked product needs a policy version: the booking's terms of
  // record. A new booking can sit on an unchanged trip, so this keys on the
  // trips the new bookings name, not on the trips being written.
  const tripProducts = new Map(plan.trips.map((t) => [t.sourceTripId, t.productId]));
  const bookedProducts = [
    ...new Set(
      plan.bookings
        .filter((b) => !b.unchanged)
        .map((b) => tripProducts.get(b.sourceTripId))
        .filter((id): id is string => id !== undefined),
    ),
  ];
  const policies = await latestPolicies(trx, tenantId, bookedProducts);
  const missing = bookedProducts.filter((id) => !policies.has(id));
  if (missing.length > 0) return { kind: "product_missing_policy", batchId, productIds: missing };

  const newRows = [
    plan.products,
    plan.trips,
    plan.customers,
    plan.bookings,
    plan.participants,
    plan.payments,
    plan.credits,
  ]
    .flat()
    .filter((r) => !r.unchanged).length;
  if (newRows > MAX_COMMIT_ROWS) {
    return { kind: "too_large", batchId, rows: newRows, limit: MAX_COMMIT_ROWS };
  }
  // A trip's checkouts wait on this commit's lock, so it gives up rather than
  // queue behind a long one, and never runs long itself.
  await sql`set local lock_timeout = '10s'`.execute(trx);
  await sql`set local statement_timeout = '30s'`.execute(trx);

  await sql`savepoint import_commit`.execute(trx);
  try {
    const run = await trx
      .insertInto("import_runs")
      .values({
        ...runValues,
        clean: true,
        error_count: 0,
        warning_count: result.warningCount,
      })
      .returning("id")
      .executeTakeFirstOrThrow();
    const counts = await writePlan(trx, tenantId, run.id, plan, policies);
    await sql`release savepoint import_commit`.execute(trx);
    await recordAudit(trx, ctx, {
      action: "import.commit",
      subjectType: "import_run",
      subjectId: run.id,
      after: {
        batchId,
        runNumber: m.runNumber,
        sourceSystem: m.sourceSystem,
        dryRunId: latest.id,
        warningCount: result.warningCount,
        ...counts,
      },
    });
    return {
      kind: "committed",
      runId: run.id,
      contentHash,
      committedAt: checkedAt.toISOString(),
      counts,
      result,
    };
  } catch (error) {
    const code = (error as { code?: unknown } | null)?.code;
    // Only the database's own refusals (integrity and exclusion) are an
    // answer; anything else is a fault and propagates.
    if (typeof code !== "string" || !code.startsWith("23")) throw error;
    await sql`rollback to savepoint import_commit`.execute(trx);
    const failed = error as { constraint?: unknown; constraint_name?: unknown };
    const constraint = failed.constraint_name ?? failed.constraint;
    const runId = await refuse(1);
    return {
      kind: "write_refused",
      runId,
      batchId,
      constraint: typeof constraint === "string" ? constraint : null,
      contentHash,
      checkedAt: checkedAt.toISOString(),
      result,
    };
  }
}

async function latestPolicies(
  trx: TenantTransaction,
  tenantId: string,
  productIds: string[],
): Promise<Map<string, number>> {
  const wanted = [...new Set(productIds)];
  if (wanted.length === 0) return new Map();
  const { rows } = await sql<{ product_id: string; version: number }>`
    select product_id, max(version)::int as version from policy_versions
     where tenant_id = ${tenantId} and product_id = any(${wanted}::uuid[])
     group by product_id`.execute(trx);
  return new Map(rows.map((r) => [r.product_id, r.version]));
}

/** Ledger rows of earlier commits, by `${file}|${key}`. */
async function earlierRecords(
  trx: TenantTransaction,
  tenantId: string,
  keys: Map<string, string[]>,
): Promise<Map<string, { id: string; tripId: string | null }>> {
  const out = new Map<string, { id: string; tripId: string | null }>();
  for (const [file, list] of keys) {
    if (list.length === 0) continue;
    const { rows } = await sql<{ id: string; dedupe_key: string; trip_id: string | null }>`
      select id, dedupe_key, trip_id from import_records
       where tenant_id = ${tenantId} and file = ${file}
         and dedupe_key = any(${list}::text[])`.execute(trx);
    for (const r of rows) out.set(`${file}|${r.dedupe_key}`, { id: r.id, tripId: r.trip_id });
  }
  return out;
}

async function writePlan(
  trx: TenantTransaction,
  tenantId: string,
  runId: string,
  plan: ImportPlan,
  policies: Map<string, number>,
): Promise<ImportCommitCounts> {
  const counts: ImportCommitCounts = {
    trips: 0,
    tripsCreated: 0,
    customers: 0,
    bookings: 0,
    participants: 0,
    payments: 0,
    refunds: 0,
    credits: 0,
    unchanged: 0,
  };
  const src = plan.sourceSystem;
  const unchangedKeys = new Map<string, string[]>([
    ["trips.csv", plan.trips.filter((r) => r.unchanged).map((r) => r.key)],
    ["customers.csv", plan.customers.filter((r) => r.unchanged).map((r) => r.key)],
    ["bookings.csv", plan.bookings.filter((r) => r.unchanged).map((r) => r.key)],
  ]);
  const before = await earlierRecords(trx, tenantId, unchangedKeys);
  const earlierId = (file: string, key: string) => {
    const found = before.get(`${file}|${key}`);
    if (!found) throw new Error(`an unchanged ${file} row has no ledger record`);
    return found;
  };
  const record = async (
    file: string,
    row: { key: string; externalId: string; rowHash: string },
    target: { product_id?: string; trip_id?: string; participant_id?: string } = {},
  ): Promise<string> => {
    const inserted = await trx
      .insertInto("import_records")
      .values({
        tenant_id: tenantId,
        run_id: runId,
        source_system: src,
        mapping_version: "std-csv-v0",
        file: file as "products.csv",
        external_id: row.externalId,
        dedupe_key: row.key,
        row_hash: row.rowHash,
        ...target,
      })
      .returning("id")
      .executeTakeFirstOrThrow();
    return inserted.id;
  };

  for (const p of plan.products) {
    if (p.unchanged) {
      counts.unchanged += 1;
      continue;
    }
    await record("products.csv", p, { product_id: p.productId });
  }

  // Trips, by the source's trip id: an existing departure, or a new one in draft.
  const trips = new Map<string, { id: string; productId: string }>();
  for (const t of plan.trips) {
    if (t.unchanged) {
      counts.unchanged += 1;
      const tripId = t.existingTripId ?? earlierId("trips.csv", t.key).tripId;
      if (!tripId) throw new Error("an unchanged trip has no TideGrid trip");
      trips.set(t.sourceTripId, { id: tripId, productId: t.productId });
      continue;
    }
    let tripId = t.existingTripId;
    if (!tripId) {
      const created = await trx
        .insertInto("scheduled_trips")
        .values({
          tenant_id: tenantId,
          product_id: t.productId,
          boat_id: t.boatId,
          time_zone: t.timeZone,
          local_date: t.localDate,
          local_start_time: `${t.localStartTime}:00`,
          starts_at: new Date(t.startsAtMs),
          ends_at: new Date(t.endsAtMs),
          start_utc_offset_minutes: t.startOffsetMinutes,
          end_utc_offset_minutes: t.endOffsetMinutes,
          duration_minutes: t.durationMinutes,
          seat_capacity: t.seatCapacity,
          sales_state: "draft",
        })
        .returning("id")
        .executeTakeFirstOrThrow();
      tripId = created.id;
      counts.tripsCreated += 1;
    }
    await record("trips.csv", t, { trip_id: tripId });
    trips.set(t.sourceTripId, { id: tripId, productId: t.productId });
    counts.trips += 1;
  }

  const customers = new Map<string, { recordId: string; fullName: string; email: string | null }>();
  for (const c of plan.customers) {
    let recordId: string;
    if (c.unchanged) {
      counts.unchanged += 1;
      recordId = earlierId("customers.csv", c.key).id;
    } else {
      recordId = await record("customers.csv", c);
      await trx
        .insertInto("import_customers")
        .values({
          tenant_id: tenantId,
          record_id: recordId,
          full_name: c.fullName,
          email: c.email,
          phone: c.phone,
        })
        .execute();
      counts.customers += 1;
    }
    customers.set(c.sourceCustomerId, { recordId, fullName: c.fullName, email: c.email });
  }

  // Bookings, by their deduplication key, which participants and payments name.
  const bookings = new Map<string, string>();
  const unchangedBookings = plan.bookings.filter((b) => b.unchanged);
  if (unchangedBookings.length > 0) {
    const recordIds = unchangedBookings.map((b) => earlierId("bookings.csv", b.key).id);
    const { rows } = await sql<{ record_id: string; booking_id: string }>`
      select ib.record_id, x.id as booking_id
        from import_bookings ib
        join bookings x on x.tenant_id = ib.tenant_id
                       and x.checkout_session_id = ib.checkout_session_id
       where ib.tenant_id = ${tenantId} and ib.record_id = any(${recordIds}::uuid[])`.execute(trx);
    const byRecord = new Map(rows.map((r) => [r.record_id, r.booking_id]));
    for (const b of unchangedBookings) {
      const bookingId = byRecord.get(earlierId("bookings.csv", b.key).id);
      if (!bookingId) throw new Error("an unchanged imported booking has no booking");
      bookings.set(b.key, bookingId);
      counts.unchanged += 1;
    }
  }
  for (const b of plan.bookings) {
    if (b.unchanged) continue;
    const trip = trips.get(b.sourceTripId);
    const customer = customers.get(b.sourceCustomerId);
    if (!trip || !customer)
      throw new Error("a planned booking names a trip or customer not planned");
    const policyVersion = policies.get(trip.productId);
    if (policyVersion === undefined) throw new Error("a planned booking's product has no policy");
    const recordId = await record("bookings.csv", b);
    const checkoutId = crypto.randomUUID();
    const amounts = b.amounts;
    await trx
      .insertInto("import_bookings")
      .values({
        tenant_id: tenantId,
        record_id: recordId,
        checkout_session_id: checkoutId,
        customer_record_id: customer.recordId,
        trip_id: trip.id,
        party_size: b.partySize,
        legacy_source: b.legacySource,
        staff_channel: b.staffChannel,
        ota_channel: b.otaChannel,
        subtotal_cents: amounts?.subtotal ?? null,
        discount_cents: amounts?.discount ?? null,
        fee_cents: amounts?.fee ?? null,
        tax_cents: amounts?.tax ?? null,
        included_tax_cents: amounts?.includedTax ?? null,
        total_cents: amounts?.total ?? null,
        booked_at: b.bookedAt === null ? null : new Date(b.bookedAt),
      })
      .execute();
    // The import capacity path: the trip's lock and seat count, until departure.
    const ownerRef = `checkout_session:${checkoutId}`;
    const { rows: holds } = await sql<{ id: string }>`
      insert into capacity_holds (tenant_id, trip_id, owner_ref, party_size, expires_at)
      select ${tenantId}, t.id, ${ownerRef}, ${b.partySize}, t.starts_at
        from scheduled_trips t
       where t.tenant_id = ${tenantId} and t.id = ${trip.id}
      returning id`.execute(trx);
    const holdId = holds[0]?.id;
    if (!holdId) throw new Error("an imported hold insert returned no row");
    // The checkout's secret is never handed out: an imported booking is
    // managed by the link its confirmation would carry, sent in a later part.
    const secretHash = [...crypto.getRandomValues(new Uint8Array(32))]
      .map((byte) => byte.toString(16).padStart(2, "0"))
      .join("");
    await sql`
      insert into checkout_sessions (id, tenant_id, quote_id, trip_id, party_size, hold_id,
        policy_version, expires_at, secret_hash, client_key, booker_name, booker_email, channel)
      select ${checkoutId}, ${tenantId}, null, h.trip_id, h.party_size, h.id,
             ${policyVersion}, h.expires_at, ${secretHash}, null, ${customer.fullName},
             ${customer.email}, null
        from capacity_holds h
       where h.tenant_id = ${tenantId} and h.id = ${holdId}`.execute(trx);
    const { rows: orders } = await sql<{ id: string }>`
      insert into orders (tenant_id, checkout_session_id, quote_id, trip_id, product_id,
        party_size, policy_version, currency, subtotal_amount, discount_amount, fee_amount,
        tax_amount, included_tax_amount, total_amount, deposit_amount, balance_due_at)
      select ${tenantId}, ${checkoutId}, null, t.id, ${trip.productId}, ${b.partySize},
             ${policyVersion}, 'USD', ${amounts?.subtotal ?? 0}, ${amounts?.discount ?? 0},
             ${amounts?.fee ?? 0}, ${amounts?.tax ?? 0}, ${amounts?.includedTax ?? 0},
             ${amounts?.total ?? 0}, ${b.balance?.paidBefore ?? null}::int,
             -- The last second of its local due date, as the dry run computed it.
             ${b.balance ? new Date(b.balance.dueAtMs) : null}::timestamptz
        from scheduled_trips t
       where t.tenant_id = ${tenantId} and t.id = ${trip.id}
      returning id`.execute(trx);
    const orderId = orders[0]?.id;
    if (!orderId) throw new Error("an imported order insert returned no row");
    await sql`
      update capacity_holds set state = 'confirmed'
       where tenant_id = ${tenantId} and id = ${holdId} and state = 'active'`.execute(trx);
    let booking: { id: string } | undefined;
    for (let attempt = 0; attempt < 5 && !booking; attempt++) {
      const { rows } = await sql<{ id: string }>`
        insert into bookings (tenant_id, reference, checkout_session_id, order_id, payment_id,
          hold_id, trip_id, party_size, reacquired)
        values (${tenantId}, ${newBookingReference()}, ${checkoutId}, ${orderId}, null,
                ${holdId}, ${trip.id}, ${b.partySize}, false)
        on conflict (tenant_id, reference) do nothing
        returning id`.execute(trx);
      booking = rows[0];
    }
    if (!booking) throw new Error("could not choose a free booking reference");
    await sql`update orders set status = 'paid'
               where tenant_id = ${tenantId} and id = ${orderId} and status = 'pending'`.execute(
      trx,
    );
    await sql`update checkout_sessions set state = 'confirmed'
               where tenant_id = ${tenantId} and id = ${checkoutId} and state = 'open'`.execute(
      trx,
    );
    bookings.set(b.key, booking.id);
    counts.bookings += 1;
  }

  for (const p of plan.participants) {
    if (p.unchanged) {
      counts.unchanged += 1;
      continue;
    }
    const bookingId = bookings.get(p.bookingKey);
    if (!bookingId) throw new Error("a planned participant names a booking not planned");
    const { rows } = await sql<{ id: string }>`
      insert into booking_participants (tenant_id, booking_id, position, full_name, is_minor,
        email, guardian_name, guardian_email)
      values (${tenantId}, ${bookingId}, ${p.position}, ${p.fullName}, ${p.isMinor},
              ${p.email}, ${p.guardianName}, ${p.guardianEmail})
      returning id`.execute(trx);
    const participantId = rows[0]?.id;
    if (!participantId) throw new Error("an imported participant insert returned no row");
    await record("participants.csv", p, { participant_id: participantId });
    counts.participants += 1;
  }

  // Payments before refunds, so a refund never returns money not yet in.
  const money = [
    ...plan.payments.filter((p) => !p.refund),
    ...plan.payments.filter((p) => p.refund),
  ];
  for (const pay of money) {
    if (pay.unchanged) {
      counts.unchanged += 1;
      continue;
    }
    const bookingId = bookings.get(pay.bookingKey);
    if (!bookingId) throw new Error("a planned payment names a booking not planned");
    const recordId = await record("payments.csv", pay);
    // An imported refund returned money paid above the booking's total (each
    // booking balances), so it reverses no fee; the database checks the same.
    let fee: { orderTotal: number; eligibleTotal: number; eligibleAmount: number } | null = null;
    if (pay.refund) {
      const { rows } = await sql<{ total_amount: number; eligible_total: number }>`
        select o.total_amount, o.total_amount - o.tax_amount - o.included_tax_amount as eligible_total
          from bookings x
          join orders o on o.tenant_id = x.tenant_id and o.id = x.order_id
         where x.tenant_id = ${tenantId} and x.id = ${bookingId}`.execute(trx);
      const order = rows[0];
      if (!order) throw new Error("an imported refund's booking vanished");
      fee = {
        orderTotal: order.total_amount,
        eligibleTotal: order.eligible_total,
        eligibleAmount: feeReversalFor({
          refundAmount: pay.amount,
          orderTotal: order.total_amount,
          eligibleTotal: order.eligible_total,
        }).eligibleAmount,
      };
    }
    await trx
      .insertInto("external_settlements")
      .values({
        tenant_id: tenantId,
        booking_id: bookingId,
        kind: pay.refund ? "refund" : "payment",
        tender: pay.tender,
        amount: pay.amount,
        reason: pay.refund
          ? "Imported refund (recorded before TideGrid)"
          : "Imported payment (received before TideGrid)",
        tender_reference: pay.reference,
        idempotency_key: `import:${recordId}`,
        order_total: fee?.orderTotal ?? null,
        eligible_total: fee?.eligibleTotal ?? null,
        eligible_amount: fee?.eligibleAmount ?? null,
        fee_bp: fee === null ? null : CORE_FEE_BP,
        fee_amount: fee === null ? null : 0,
        import_record_id: recordId,
        received_at: new Date(pay.receivedAt),
      })
      .execute();
    if (pay.refund) counts.refunds += 1;
    else counts.payments += 1;
  }

  // Opening booking credit, on the account of the email its customer books
  // with; the database takes it only from this commit's ledger row. In email
  // order, so two batches lock the same accounts in the same order.
  const emailOf = (id: string) => customers.get(id)?.email?.trim().toLowerCase() ?? "";
  const credits = [...plan.credits].sort((a, b) => {
    const x = emailOf(a.sourceCustomerId);
    const y = emailOf(b.sourceCustomerId);
    return x < y ? -1 : x > y ? 1 : 0;
  });
  for (const credit of credits) {
    if (credit.unchanged) {
      counts.unchanged += 1;
      continue;
    }
    const email = emailOf(credit.sourceCustomerId);
    if (!email) throw new Error("a planned credit's customer has no email");
    const recordId = await record("opening_balances.csv", credit);
    await sql`
      insert into credit_accounts (tenant_id, customer_email) values (${tenantId}, ${email})
      on conflict (tenant_id, customer_email) do nothing`.execute(trx);
    const { rows: accounts } = await sql<{ id: string }>`
      select id from credit_accounts
       where tenant_id = ${tenantId} and customer_email = ${email}`.execute(trx);
    const accountId = accounts[0]?.id;
    if (!accountId) throw new Error("a credit account was not found after its insert");
    await sql`
      insert into credit_entries (tenant_id, account_id, kind, amount, import_record_id,
        idempotency_key)
      values (${tenantId}, ${accountId}, 'import', ${credit.amount}, ${recordId},
              ${`import:${recordId}`})`.execute(trx);
    counts.credits += 1;
  }
  return counts;
}
