/**
 * Running a standard CSV import's dry run in a tenant (W3-G2.13, part 1):
 * the database lookups `validateImport` needs, the batch's content hash, and
 * the run's record. Nothing from the files is written: only the record of the
 * run (counts and control totals) and its audit event.
 */
import { recordAudit, type TenantContext, type TenantTransaction } from "@tidegrid/database";
import { sql } from "kysely";
import { csvField, csvText } from "../csv.ts";
import { readCsv } from "./csv-read.ts";
import { IMPORT_FILES, type ImportFile } from "./spec.ts";
import {
  type BoatInfo,
  type ImportDryRun,
  type ImportLookup,
  type ProductInfo,
  type TripInfo,
  validateImport,
} from "./validate.ts";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** The tenant's catalog, boats, and trips, read in its transaction. */
export function importLookup(trx: TenantTransaction, tenantId: string): ImportLookup {
  return {
    async products(ids) {
      const wanted = [...new Set(ids.filter((id) => UUID.test(id)))];
      const out = new Map<string, ProductInfo>();
      if (wanted.length === 0) return out;
      const { rows } = await sql<{
        id: string;
        name: string;
        kind: "shared_seat" | "private_charter";
        min_party_size: number;
        max_party_size: number;
        seat_limit: number | null;
        duration_minutes: number;
        turnaround_buffer_minutes: number;
        time_zone: string;
      }>`
        select p.id, p.name, p.kind, p.min_party_size, p.max_party_size, p.seat_limit,
               p.duration_minutes, p.turnaround_buffer_minutes, l.time_zone
          from products p
          join locations l on l.tenant_id = p.tenant_id and l.id = p.location_id
         where p.tenant_id = ${tenantId} and p.id = any(${wanted}::uuid[])`.execute(trx);
      for (const r of rows) {
        out.set(r.id, {
          id: r.id,
          name: r.name,
          kind: r.kind,
          minParty: r.min_party_size,
          maxParty: r.max_party_size,
          seatLimit: r.seat_limit,
          durationMinutes: r.duration_minutes,
          turnaroundMinutes: r.turnaround_buffer_minutes,
          zone: r.time_zone,
        });
      }
      return out;
    },
    async boats(ids) {
      const wanted = [...new Set(ids.filter((id) => UUID.test(id)))];
      const out = new Map<string, BoatInfo>();
      if (wanted.length === 0) return out;
      const { rows } = await sql<{
        id: string;
        guest_capacity: number;
        status: string;
        product_ids: string[] | null;
      }>`
        select b.id, b.guest_capacity, b.status,
               array(select pb.product_id::text from product_boats pb
                      where pb.tenant_id = b.tenant_id and pb.boat_id = b.id) as product_ids
          from boats b
         where b.tenant_id = ${tenantId} and b.id = any(${wanted}::uuid[])`.execute(trx);
      for (const r of rows) {
        out.set(r.id, {
          id: r.id,
          guestCapacity: r.guest_capacity,
          active: r.status === "active",
          productIds: new Set(r.product_ids ?? []),
        });
      }
      return out;
    },
    async liveTrips(boatIds, fromMs, toMs) {
      if (boatIds.length === 0) return [];
      const { rows } = await sql<{
        id: string;
        product_id: string;
        boat_id: string;
        starts_at: Date;
        boat_free_at: Date;
        seat_capacity: number;
        sales_state: string;
        held: number;
      }>`
        select t.id, t.product_id, t.boat_id, t.starts_at, t.boat_free_at, t.seat_capacity,
               t.sales_state,
               (select coalesce(sum(h.seats), 0)::int from capacity_holds h
                 where h.tenant_id = t.tenant_id and h.trip_id = t.id
                   and (h.state = 'confirmed'
                        or (h.state = 'active' and h.expires_at > pg_catalog.now()))) as held
          from scheduled_trips t
         where t.tenant_id = ${tenantId}
           and t.boat_id = any(${[...boatIds]}::uuid[])
           and t.boat_free_at > ${new Date(fromMs)}
           and t.starts_at < ${new Date(toMs)}`.execute(trx);
      return rows.map(
        (r): TripInfo => ({
          id: r.id,
          productId: r.product_id,
          boatId: r.boat_id,
          startsAtMs: new Date(r.starts_at).getTime(),
          boatFreeAtMs: new Date(r.boat_free_at).getTime(),
          seatCapacity: r.seat_capacity,
          salesState: r.sales_state,
          heldSeats: r.held,
        }),
      );
    },
    // As catalog generation does: values travel as text, so the driver never
    // reads a wall-clock time in the process's zone.
    async zoneMismatches(zone, departures) {
      if (departures.length === 0) return new Set();
      const { rows } = await sql<{ position: number }>`
        select (d.n - 1)::int as position
          from unnest(
                 ${departures.map((d) => new Date(d.startsAtMs).toISOString())}::text[],
                 ${departures.map((d) => d.local)}::text[],
                 ${departures.map((d) => d.offsetMinutes)}::int[],
                 ${departures.map((d) => new Date(d.endsAtMs).toISOString())}::text[],
                 ${departures.map((d) => d.endOffsetMinutes)}::int[]
               ) with ordinality as d(starts_at, local_start, start_offset, ends_at, end_offset, n)
         where pg_catalog.timezone(${zone}, d.starts_at::timestamptz) <> d.local_start::timestamp
            or extract(epoch from pg_catalog.timezone(${zone}, d.starts_at::timestamptz)
                 - pg_catalog.timezone('UTC', d.starts_at::timestamptz)) / 60 <> d.start_offset
            or extract(epoch from pg_catalog.timezone(${zone}, d.ends_at::timestamptz)
                 - pg_catalog.timezone('UTC', d.ends_at::timestamptz)) / 60 <> d.end_offset
      `.execute(trx);
      return new Set(rows.map((r) => r.position));
    },
  };
}

/**
 * The batch's content hash: every file by name, with the manifest's
 * `batch_mode` and `run_number` rows left out, so a commit of the same files
 * (a later step) can be matched to its clean dry run.
 */
export async function importContentHash(
  files: Partial<Record<ImportFile, string | undefined>>,
): Promise<string> {
  const parts: string[] = [];
  for (const name of IMPORT_FILES) {
    let text = files[name];
    if (text === undefined) continue;
    if (name === "manifest.csv") {
      const parsed = readCsv(text);
      if (parsed.ok) {
        const item = parsed.header.indexOf("item");
        const kept = parsed.records
          .filter((r) => !["batch_mode", "run_number"].includes((r.fields[item] ?? "").trim()))
          .map((r) => r.fields.map(csvField).join(","));
        text = [parsed.header.map(csvField).join(","), ...kept].join("\n");
      }
    }
    parts.push(`${name}\u0000${text.length}\u0000${text}`);
  }
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(parts.join("\u0000")),
  );
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

export type ImportDryRunResult =
  | {
      kind: "checked";
      runId: string | null;
      contentHash: string;
      checkedAt: string;
      result: ImportDryRun;
    }
  /** The run number is not the batch's next one (used already, or skipping ahead). */
  | { kind: "run_number_used"; batchId: string; runNumber: number; expected: number }
  /** The batch's earlier runs name another source system. */
  | { kind: "source_changed"; batchId: string };

/**
 * Checks a batch as the signed-in owner in `ctx` and records the run when the
 * manifest could be read. The time of the check is the database's.
 */
export async function runImportDryRun(
  trx: TenantTransaction,
  ctx: TenantContext,
  files: Partial<Record<ImportFile, string | undefined>>,
): Promise<ImportDryRunResult> {
  if (ctx.actorType !== "staff" || !ctx.actorId) {
    throw new TypeError("an import is run by a signed-in staff member");
  }
  const { rows: clock } = await sql<{ now: Date }>`select now() as now`.execute(trx);
  const now = new Date(clock[0]?.now ?? Date.now());
  const result = await validateImport(files, importLookup(trx, ctx.tenantId), now.getTime());
  const contentHash = await importContentHash(files);
  const m = result.manifest;
  if (!m) {
    return { kind: "checked", runId: null, contentHash, checkedAt: now.toISOString(), result };
  }
  // One run of a batch at a time, so two at once cannot both pass the check below.
  await sql`select pg_advisory_xact_lock(hashtext(${`import_runs:${ctx.tenantId}:${m.batchId}`}))`.execute(
    trx,
  );
  const { rows: earlier } = await sql<{ run_number: number; source_system: string }>`
    select run_number, source_system from import_runs
     where tenant_id = ${ctx.tenantId} and batch_id = ${m.batchId}`.execute(trx);
  // Run numbers start at 1 and go up by one: never reused, never skipped.
  const expected = earlier.reduce((max, r) => Math.max(max, r.run_number), 0) + 1;
  if (m.runNumber !== expected) {
    return { kind: "run_number_used", batchId: m.batchId, runNumber: m.runNumber, expected };
  }
  if (earlier.some((r) => r.source_system !== m.sourceSystem)) {
    return { kind: "source_changed", batchId: m.batchId };
  }
  const filesSummary = Object.fromEntries(
    result.files
      .filter((f) => f.file !== "manifest.csv")
      .map((f) => [f.file, { rows: f.rows, accepted: f.accepted, refused: f.refused }]),
  );
  const controls = Object.fromEntries(
    result.controls.map((c) => [
      `${c.metric}|${c.file}`,
      { declared: c.declared, computed: c.computed },
    ]),
  );
  const inserted = await trx
    .insertInto("import_runs")
    .values({
      tenant_id: ctx.tenantId,
      batch_id: m.batchId,
      run_number: m.runNumber,
      source_system: m.sourceSystem,
      mapping_version: "std-csv-v0",
      mode: "dry_run",
      content_hash: contentHash,
      clean: result.clean,
      error_count: result.errorCount,
      warning_count: result.warningCount,
      files: filesSummary,
      controls,
    })
    .returning("id")
    .executeTakeFirstOrThrow();
  await recordAudit(trx, ctx, {
    action: "import.dry_run",
    subjectType: "import_run",
    subjectId: inserted.id,
    after: {
      batchId: m.batchId,
      runNumber: m.runNumber,
      sourceSystem: m.sourceSystem,
      clean: result.clean,
      errorCount: result.errorCount,
      warningCount: result.warningCount,
    },
  });
  return { kind: "checked", runId: inserted.id, contentHash, checkedAt: now.toISOString(), result };
}

export const importErrorColumns = [
  "batch_id",
  "run_number",
  "file",
  "line",
  "record_key",
  "column",
  "code",
  "severity",
  "message",
  "value",
] as const;

/**
 * The dry run's errors.csv: one row per issue, every cell kept from running as
 * a spreadsheet formula, since values come from the legacy files.
 */
export function renderImportErrors(run: ImportDryRun): string {
  const batch = run.manifest?.batchId ?? "";
  const runNumber = run.manifest ? String(run.manifest.runNumber) : "";
  const lines = [importErrorColumns.join(",")];
  for (const i of run.issues) {
    lines.push(
      [
        batch,
        runNumber,
        i.file,
        i.line === null ? "" : String(i.line),
        i.recordKey ?? "",
        i.column ?? "",
        i.code,
        i.severity,
        i.message,
        i.value ?? "",
      ]
        .map((cell) => csvField(csvText(cell)))
        .join(","),
    );
  }
  return `﻿${lines.join("\r\n")}\r\n`;
}
