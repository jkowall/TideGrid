/**
 * The standard CSV import's dry run (W3-G2.13): every file, row, and control
 * total of a batch checked against the operator's catalog, trips, and
 * capacity, writing nothing. The rules are those of the draft in
 * docs/v2/drafts/standard-csv-import.md, a coordinator default pending the
 * owner's approval. Pure apart from `ImportLookup`, which reads the database.
 */
import { readCsv } from "./csv-read.ts";
import {
  COLUMNS,
  CONTROL_METRICS,
  type ColumnSpec,
  type DataFile,
  hasControl,
  IMPORT_FILES,
  type ImportFile,
  type ImportIssue,
  type ImportIssueCode,
  looksLikeCardNumber,
  MAPPING_VERSION,
  offsetMinutes,
  parseValue,
  timestampMs,
  type Value,
} from "./spec.ts";
import { instantsFor, isKnownZone, localDateAt, offsetAt } from "./zone-time.ts";

export interface ProductInfo {
  id: string;
  name: string;
  kind: "shared_seat" | "private_charter";
  minParty: number;
  maxParty: number;
  seatLimit: number | null;
  durationMinutes: number;
  turnaroundMinutes: number;
  zone: string;
}

export interface BoatInfo {
  id: string;
  guestCapacity: number;
  active: boolean;
  productIds: ReadonlySet<string>;
}

export interface TripInfo {
  id: string;
  productId: string;
  boatId: string;
  startsAtMs: number;
  boatFreeAtMs: number;
  seatCapacity: number;
  salesState: string;
  /** Seats in active and confirmed holds. */
  heldSeats: number;
}

/** A record an earlier commit imported, found by its file and deduplication key. */
export interface ImportedRecord {
  rowHash: string;
  /** For a booking: it is no longer confirmed in TideGrid (canceled since). */
  closed?: boolean;
}

/** A payment or refund an earlier commit imported for a booking. */
export interface ImportedPayment {
  /** The booking's deduplication key. */
  bookingKey: string;
  /** The payment's own deduplication key. */
  paymentKey: string;
  amount: number;
  refund: boolean;
}

/** What the dry run reads from the operator's data, in its tenant. */
export interface ImportLookup {
  /**
   * Records earlier commits imported, by `${file}|${key}`, so a row that was
   * imported unchanged is a no-op and a changed one is refused. Absent: none.
   */
  imported?(keys: ReadonlyMap<DataFile, readonly string[]>): Promise<Map<string, ImportedRecord>>;
  /** Payments and refunds earlier commits imported for these bookings (by key). */
  importedPayments?(bookingKeys: readonly string[]): Promise<ImportedPayment[]>;
  /** Bookings (by key) earlier commits imported as charters with a balance. Absent: none. */
  balanceBookings?(bookingKeys: readonly string[]): Promise<Set<string>>;
  products(ids: readonly string[]): Promise<Map<string, ProductInfo>>;
  boats(ids: readonly string[]): Promise<Map<string, BoatInfo>>;
  /** Trips, canceled ones included, on these boats that end after `fromMs` and start before `toMs`. */
  liveTrips(boatIds: readonly string[], fromMs: number, toMs: number): Promise<TripInfo[]>;
  /**
   * Positions of departures that the database's zone data reads differently
   * from the runtime's (the two ship separately), so the database would refuse them.
   */
  zoneMismatches(
    zone: string,
    departures: readonly {
      startsAtMs: number;
      local: string;
      offsetMinutes: number;
      endsAtMs: number;
      endOffsetMinutes: number;
    }[],
  ): Promise<Set<number>>;
}

export interface ImportManifest {
  batchId: string;
  runNumber: number;
  sourceSystem: string;
  mappingVersion: string;
  batchMode: "dry_run" | "commit";
  operatorTimeZone: string;
  exportedAt: string;
  waiverNotifications: "send_at_cutover" | "hold_until_staff_release" | null;
}

export interface ImportControl {
  file: DataFile;
  metric: string;
  declared: number | null;
  computed: number;
  matches: boolean;
}

export interface ImportFileSummary {
  file: ImportFile;
  rows: number;
  accepted: number;
  refused: number;
}

export interface ImportDryRun {
  manifest: ImportManifest | null;
  /** At most MAX_ISSUES_KEPT; the counts below cover every issue found. */
  issues: ImportIssue[];
  /** More issues were found than `issues` keeps. */
  issuesCapped: boolean;
  files: ImportFileSummary[];
  controls: ImportControl[];
  /** No error, and every declared total matched: a commit may follow. */
  clean: boolean;
  errorCount: number;
  warningCount: number;
  /** What a commit writes, when clean. */
  plan: ImportPlan | null;
}

interface PlannedRow {
  /** The deduplication key. */
  key: string;
  /** The source system's own id for the record. */
  externalId: string;
  /** SHA-256 of the row's values, as the ledger keeps it. */
  rowHash: string;
  /** Imported before, unchanged: nothing to write. */
  unchanged: boolean;
}

/** The accepted rows of a clean batch, in the shape the commit writes them. */
export interface ImportPlan {
  sourceSystem: string;
  products: (PlannedRow & { productId: string })[];
  trips: (PlannedRow & {
    sourceTripId: string;
    /** The TideGrid trip it maps onto, or null to create one in draft. */
    existingTripId: string | null;
    productId: string;
    boatId: string;
    startsAtMs: number;
    endsAtMs: number;
    timeZone: string;
    localDate: string;
    /** HH:MM, the operator's wall clock. */
    localStartTime: string;
    startOffsetMinutes: number;
    endOffsetMinutes: number;
    durationMinutes: number;
    /** Shared seats, or the boat's capacity for a charter. */
    seatCapacity: number;
  })[];
  customers: (PlannedRow & {
    sourceCustomerId: string;
    fullName: string;
    email: string | null;
    phone: string | null;
  })[];
  bookings: (PlannedRow & {
    sourceTripId: string;
    sourceCustomerId: string;
    legacySource: "direct" | "staff_assisted" | "ota";
    staffChannel: "phone" | "email" | "walk_up" | null;
    otaChannel: string | null;
    partySize: number;
    /** Null for an OTA reservation. */
    amounts: {
      subtotal: number;
      discount: number;
      fee: number;
      tax: number;
      includedTax: number;
      total: number;
    } | null;
    bookedAt: string | null;
    /**
     * A private charter's outstanding balance: what came in before TideGrid
     * (its deposit, which may be 0) and the local date it falls due, before
     * the trip, with its due instant: the last second of that date in the
     * operator's zone. Null when it is paid in full.
     */
    balance: { paidBefore: number; dueDate: string; dueAtMs: number } | null;
  })[];
  participants: (PlannedRow & {
    bookingKey: string;
    position: number;
    fullName: string;
    isMinor: boolean;
    email: string | null;
    guardianName: string | null;
    guardianEmail: string | null;
  })[];
  payments: (PlannedRow & {
    bookingKey: string;
    refund: boolean;
    amount: number;
    tender: "cash" | "check" | "card_outside_tidegrid" | "bank_transfer" | "other";
    reference: string | null;
    receivedAt: string;
  })[];
}

interface Row {
  line: number;
  raw: Map<string, string>;
  v: Map<string, Value>;
  key: string;
  refused: boolean;
  /** SHA-256 of the row's values in column order (data files only). */
  hash?: string;
  /** Imported by an earlier commit with the same values. */
  unchanged?: boolean;
}

interface FileRows {
  file: DataFile;
  rows: Row[];
  /** False when the file itself could not be read or its header was wrong. */
  readable: boolean;
}

const MANIFEST_ITEMS = [
  "batch_id",
  "run_number",
  "source_system",
  "mapping_version",
  "batch_mode",
  "operator_time_zone",
  "exported_at",
  "waiver_notifications",
] as const;

const MINUTE_MS = 60_000;
const DAY_MS = 24 * 60 * MINUTE_MS;
/** The furthest ahead an import may place a trip: the dates the catalog accepts. */
const LAST_YEAR = 2099;

/** The most issues one dry run keeps; the error and warning counts go on past it. */
export const MAX_ISSUES_KEPT = 5_000;
/** The longest offending value an issue repeats. */
const MAX_VALUE_CHARS = 64;
/** The most line numbers one message lists. */
const MAX_LINES_LISTED = 10;

/** "lines 2, 5, 9" with at most MAX_LINES_LISTED numbers, then "and N more". */
function linesText(lines: number[]): string {
  const listed = lines.slice(0, MAX_LINES_LISTED).join(", ");
  const more = lines.length - MAX_LINES_LISTED;
  return more > 0 ? `lines ${listed}, and ${more} more` : `lines ${listed}`;
}

/** True when any part of a value or key could be a card number. */
function holdsCardNumber(value: string): boolean {
  return value.split(/[|,;/]/).some((part) => looksLikeCardNumber(part.trim()));
}

class Report {
  readonly issues: ImportIssue[] = [];
  errorCount = 0;
  warningCount = 0;

  add(
    file: ImportFile,
    row: Row | null,
    column: string | null,
    code: ImportIssueCode,
    message: string,
    value: string | null = null,
    severity: "error" | "warning" = "error",
  ): void {
    if (row && severity === "error") row.refused = true;
    if (severity === "error") this.errorCount += 1;
    else this.warningCount += 1;
    if (this.issues.length >= MAX_ISSUES_KEPT) return;
    // A card number never leaves in a key or a value, whatever column held it.
    const key = row?.key ? (holdsCardNumber(row.key) ? null : row.key.slice(0, 120)) : null;
    let shownValue = value;
    if (shownValue !== null && holdsCardNumber(shownValue)) shownValue = "[withheld]";
    if (shownValue !== null && shownValue.length > MAX_VALUE_CHARS) {
      shownValue = `${shownValue.slice(0, MAX_VALUE_CHARS)}...`;
    }
    this.issues.push({
      file,
      line: row?.line ?? null,
      recordKey: key,
      column,
      code,
      severity,
      message,
      value: shownValue,
    });
  }
}

function shown(spec: ColumnSpec | undefined, raw: string | undefined): string | null {
  if (raw === undefined || raw === "") return null;
  return spec?.personal ? "[withheld]" : raw;
}

const s = (row: Row, col: string) => row.v.get(col) as string | undefined;
const n = (row: Row, col: string) => row.v.get(col) as number | undefined;
const b = (row: Row, col: string) => row.v.get(col) as boolean | undefined;

/** Reads one data file: header, types, required values, card numbers. */
function readFile(
  report: Report,
  file: DataFile,
  text: string,
  keyOf: (row: Row) => string,
): FileRows {
  const parsed = readCsv(text);
  if (!parsed.ok) {
    report.add(
      file,
      null,
      null,
      "file_unreadable",
      `The file could not be read as CSV (${parsed.reason}).`,
    );
    return { file, rows: [], readable: false };
  }
  const specs = COLUMNS[file];
  const known = new Set(specs.map((c) => c.name));
  let headerOk = true;
  const seen = new Set<string>();
  parsed.header.forEach((name, i) => {
    // A header name not in the standard is named by its position, never echoed.
    const where = known.has(name) ? name : `column ${i + 1}`;
    if (seen.has(name)) {
      report.add(file, null, where, "repeated_column", "This column appears more than once.");
      headerOk = false;
    }
    seen.add(name);
    if (!known.has(name)) {
      report.add(
        file,
        null,
        where,
        "unknown_column",
        "This column is not part of the standard import; unknown columns are refused, not ignored.",
      );
      headerOk = false;
    }
  });
  for (const spec of specs) {
    if (!seen.has(spec.name)) {
      report.add(
        file,
        null,
        spec.name,
        "missing_column",
        "This column is missing from the header.",
      );
      headerOk = false;
    }
  }
  if (!headerOk) return { file, rows: [], readable: false };

  const rows: Row[] = [];
  for (const record of parsed.records) {
    const row: Row = { line: record.line, raw: new Map(), v: new Map(), key: "", refused: false };
    if (record.fields.length !== parsed.header.length) {
      row.key = "";
      report.add(
        file,
        row,
        null,
        "invalid_type",
        `The row has ${record.fields.length} fields; the header has ${parsed.header.length}.`,
      );
      rows.push(row);
      continue;
    }
    parsed.header.forEach((name, i) => {
      row.raw.set(name, (record.fields[i] ?? "").trim());
    });
    rows.push(row);
  }
  // Keys first, so every issue on a row names it. A key column that fails its
  // type leaves the key blank.
  for (const row of rows) {
    if (row.raw.size === 0) continue;
    for (const spec of specs) {
      const raw = row.raw.get(spec.name) ?? "";
      if (raw === "") continue;
      if (hasControl(raw)) continue;
      // A card number is never kept, not even as part of the row's key.
      if ((spec.type.t === "text" || spec.type.t === "id") && holdsCardNumber(raw)) continue;
      const parsedValue = parseValue(raw, spec.type);
      if (parsedValue.ok) row.v.set(spec.name, parsedValue.value);
    }
    row.key = keyOf(row);
    for (const spec of specs) {
      const raw = row.raw.get(spec.name) ?? "";
      if (raw === "") {
        if (spec.required) {
          report.add(file, row, spec.name, "missing_required", "A value is required here.");
        }
        continue;
      }
      if (hasControl(raw)) {
        report.add(
          file,
          row,
          spec.name,
          "invalid_type",
          "Control characters are not allowed.",
          spec.personal ? "[withheld]" : null,
        );
        continue;
      }
      if ((spec.type.t === "text" || spec.type.t === "id") && holdsCardNumber(raw)) {
        row.v.delete(spec.name);
        report.add(
          file,
          row,
          spec.name,
          "possible_card_number",
          "The value looks like a card number and was not stored.",
          "[withheld]",
        );
        continue;
      }
      const parsedValue = parseValue(raw, spec.type);
      if (!parsedValue.ok) {
        const what =
          parsedValue.code === "invalid_enum"
            ? "is not one of the listed values"
            : parsedValue.code === "out_of_range"
              ? "is outside the allowed range or length"
              : "is not in the column's format";
        report.add(file, row, spec.name, parsedValue.code, `The value ${what}.`, shown(spec, raw));
      }
    }
  }
  return { file, rows, readable: true };
}

/** Refuses every row whose deduplication key repeats in the file. */
function refuseDuplicates(report: Report, fr: FileRows): void {
  const byKey = new Map<string, Row[]>();
  for (const row of fr.rows) {
    if (!row.key) continue;
    const list = byKey.get(row.key) ?? [];
    list.push(row);
    byKey.set(row.key, list);
  }
  for (const [, list] of byKey) {
    if (list.length < 2) continue;
    const lines = linesText(list.map((r) => r.line));
    for (const row of list) {
      report.add(
        fr.file,
        row,
        null,
        "duplicate_key_in_batch",
        `Another row in this file has the same key (${lines}).`,
      );
    }
  }
}

function readManifest(
  report: Report,
  text: string | undefined,
  mode: "dry_run" | "commit",
): {
  manifest: ImportManifest | null;
  declared: Map<string, { value: number | null; line: number }>;
} {
  const declared = new Map<string, { value: number | null; line: number }>();
  const file: ImportFile = "manifest.csv";
  if (text === undefined) {
    report.add(file, null, null, "missing_file", "Every batch needs a manifest.");
    return { manifest: null, declared };
  }
  const parsed = readCsv(text);
  if (!parsed.ok) {
    report.add(
      file,
      null,
      null,
      "file_unreadable",
      `The file could not be read as CSV (${parsed.reason}).`,
    );
    return { manifest: null, declared };
  }
  const want = ["item", "file", "value"];
  const header = parsed.header;
  if (header.length !== 3 || !want.every((w) => header.includes(w))) {
    for (const w of want) {
      if (!header.includes(w))
        report.add(file, null, w, "missing_column", "This column is missing from the header.");
    }
    header.forEach((h, i) => {
      if (want.includes(h) && header.indexOf(h) !== i)
        report.add(file, null, h, "repeated_column", "This column appears more than once.");
      if (!want.includes(h))
        report.add(
          file,
          null,
          `column ${i + 1}`,
          "unknown_column",
          "The manifest has the columns item, file, and value.",
        );
    });
    return { manifest: null, declared };
  }
  const at = (name: string) => header.indexOf(name);
  const items = new Map<string, { value: string; line: number }>();
  let fatal = false;
  for (const record of parsed.records) {
    const row: Row = { line: record.line, raw: new Map(), v: new Map(), key: "", refused: false };
    if (record.fields.length !== 3) {
      report.add(file, row, null, "invalid_type", "Each manifest row has three fields.");
      fatal = true;
      continue;
    }
    const item = (record.fields[at("item")] ?? "").trim();
    const target = (record.fields[at("file")] ?? "").trim();
    const value = (record.fields[at("value")] ?? "").trim();
    if (hasControl(item + target + value)) {
      report.add(file, row, null, "invalid_type", "Control characters are not allowed.");
      fatal = true;
      continue;
    }
    row.key = target ? `${item}|${target}` : item;
    if (target === "") {
      if (!(MANIFEST_ITEMS as readonly string[]).includes(item)) {
        report.add(
          file,
          row,
          "item",
          "invalid_enum",
          "This is not a manifest item.",
          item.slice(0, 64),
        );
        fatal = true;
        continue;
      }
      if (items.has(item)) {
        report.add(
          file,
          row,
          "item",
          "duplicate_key_in_batch",
          "This item appears more than once.",
          item,
        );
        fatal = true;
        continue;
      }
      items.set(item, { value, line: record.line });
      continue;
    }
    // A control total.
    if (!(IMPORT_FILES as readonly string[]).includes(target) || target === "manifest.csv") {
      report.add(
        file,
        row,
        "file",
        "invalid_enum",
        "This is not a file of the standard import.",
        target.slice(0, 64),
      );
      fatal = true;
      continue;
    }
    if (!CONTROL_METRICS[target as DataFile].includes(item)) {
      report.add(
        file,
        row,
        "item",
        "invalid_enum",
        `This is not a control total for ${target}.`,
        item.slice(0, 64),
      );
      fatal = true;
      continue;
    }
    const key = `${item}|${target}`;
    if (declared.has(key)) {
      report.add(
        file,
        row,
        "item",
        "duplicate_key_in_batch",
        "This control total is declared more than once.",
        item,
      );
      fatal = true;
      continue;
    }
    if (!/^-?\d{1,12}$/.test(value)) {
      report.add(
        file,
        row,
        "value",
        "invalid_type",
        "A control total is a whole number.",
        value.slice(0, 64),
      );
      // The files are still checked; only this total cannot be compared.
      declared.set(key, { value: null, line: record.line });
      continue;
    }
    declared.set(key, { value: Number(value), line: record.line });
  }

  const get = (item: string) => items.get(item)?.value ?? "";
  const need = (
    item: string,
    ok: (v: string) => boolean,
    code: ImportIssueCode = "invalid_type",
  ): string | null => {
    const entry = items.get(item);
    const row: Row | null = entry
      ? { line: entry.line, raw: new Map(), v: new Map(), key: item, refused: false }
      : null;
    const v = entry?.value ?? "";
    if (v === "") {
      report.add(file, row, item, "missing_required", "This manifest item is required.");
      fatal = true;
      return null;
    }
    if (holdsCardNumber(v)) {
      report.add(
        file,
        row,
        item,
        "possible_card_number",
        "The value looks like a card number and was not stored.",
        "[withheld]",
      );
      fatal = true;
      return null;
    }
    if (!ok(v)) {
      report.add(file, row, item, code, "The value is not valid for this item.", v.slice(0, 64));
      fatal = true;
      return null;
    }
    return v;
  };
  const batchId = need("batch_id", (v) => /^[A-Za-z0-9._-]{1,64}$/.test(v));
  const runNumber = need("run_number", (v) => /^\d{1,6}$/.test(v) && Number(v) >= 1);
  const sourceSystem = need("source_system", (v) => /^[A-Za-z0-9._-]{1,64}$/.test(v));
  const mappingVersion = need("mapping_version", (v) => v === MAPPING_VERSION, "invalid_enum");
  const batchMode = need("batch_mode", (v) => v === "dry_run" || v === "commit", "invalid_enum");
  // A dry run's manifest says dry_run, and a commit's says commit: the same
  // files otherwise, since the content hash leaves this row out.
  if (batchMode !== null && batchMode !== mode) {
    const entry = items.get("batch_mode");
    report.add(
      file,
      entry
        ? { line: entry.line, raw: new Map(), v: new Map(), key: "batch_mode", refused: false }
        : null,
      "batch_mode",
      "batch_mode_not_supported",
      mode === "commit"
        ? "This is a commit; the manifest's batch_mode must be commit."
        : "This is a dry run; the manifest's batch_mode must be dry_run.",
      batchMode,
    );
    fatal = true;
  }
  const zone = need("operator_time_zone", isKnownZone);
  const exportedAt = need("exported_at", (v) => !Number.isNaN(timestampMs(v)));
  const waiver = get("waiver_notifications");
  if (waiver !== "" && waiver !== "send_at_cutover" && waiver !== "hold_until_staff_release") {
    const entry = items.get("waiver_notifications");
    report.add(
      file,
      entry
        ? {
            line: entry.line,
            raw: new Map(),
            v: new Map(),
            key: "waiver_notifications",
            refused: false,
          }
        : null,
      "waiver_notifications",
      "invalid_enum",
      "The value is send_at_cutover or hold_until_staff_release.",
      waiver.slice(0, 64),
    );
    fatal = true;
  }
  if (fatal || !batchId || !runNumber || !sourceSystem || !mappingVersion || !zone || !exportedAt) {
    return { manifest: null, declared };
  }
  return {
    manifest: {
      batchId,
      runNumber: Number(runNumber),
      sourceSystem,
      mappingVersion,
      batchMode: mode,
      operatorTimeZone: zone,
      exportedAt,
      waiverNotifications:
        waiver === "" ? null : (waiver as "send_at_cutover" | "hold_until_staff_release"),
    },
    declared,
  };
}

/**
 * The last second of a local date in a zone, as an instant: one second before
 * the next day's first local midnight (or its first moment, when a clock change
 * skips midnight).
 */
function endOfLocalDate(zone: string, date: string): number {
  const next = new Date(Date.parse(`${date}T00:00:00Z`) + DAY_MS).toISOString().slice(0, 10);
  for (const time of ["00:00", "00:30", "01:00", "02:00"]) {
    const found = instantsFor(zone, next, time);
    if (found.kind === "unique") return found.epochMs - 1000;
    if (found.kind === "ambiguous") return (found.options[0]?.epochMs ?? 0) - 1000;
  }
  throw new Error(`no local midnight after ${date} in ${zone}`);
}

interface TripPlan {
  row: Row;
  product: ProductInfo;
  boat: BoatInfo;
  startMs: number;
  freeAtMs: number;
  localDate: string;
  localTime: string;
  capacity: number;
  existing: TripInfo | null;
}

/**
 * Checks a batch without writing anything. `nowMs` is the time of the check:
 * a trip that has departed by then, or a balance that has expired by the
 * operator's date then, is refused.
 */
export async function validateImport(
  files: Partial<Record<ImportFile, string | undefined>>,
  lookup: ImportLookup,
  nowMs: number,
  mode: "dry_run" | "commit" = "dry_run",
): Promise<ImportDryRun> {
  const report = new Report();
  const { manifest, declared } = readManifest(report, files["manifest.csv"], mode);
  // What a commit cannot save yet (charter balances, opening balances, legacy
  // waiver status) is a warning in a dry run and refuses the commit.
  const notYet = mode === "commit" ? "error" : "warning";
  const present = IMPORT_FILES.filter(
    (f): f is DataFile => f !== "manifest.csv" && files[f] !== undefined,
  );
  const summaries = (byFile: Map<DataFile, FileRows>): ImportFileSummary[] => [
    {
      file: "manifest.csv",
      rows: 0,
      accepted: 0,
      refused: 0,
    },
    ...present.map((file) => {
      const rows = byFile.get(file)?.rows ?? [];
      const refused = rows.filter((r) => r.refused).length;
      return { file, rows: rows.length, accepted: rows.length - refused, refused };
    }),
  ];
  if (!manifest) {
    return finish(report, null, summaries(new Map()), []);
  }
  const src = manifest.sourceSystem;
  const exportedMs = timestampMs(manifest.exportedAt);

  // Which files the batch needs.
  if (files["products.csv"] === undefined) {
    report.add("products.csv", null, null, "missing_file", "Every batch needs products.csv.");
  }
  if (files["bookings.csv"] !== undefined && files["trips.csv"] === undefined) {
    report.add("trips.csv", null, null, "missing_file", "A batch with bookings needs trips.csv.");
  }
  if (
    (files["bookings.csv"] !== undefined || files["opening_balances.csv"] !== undefined) &&
    files["customers.csv"] === undefined
  ) {
    report.add(
      "customers.csv",
      null,
      null,
      "missing_file",
      "A batch with bookings or balances needs customers.csv.",
    );
  }
  if (files["bookings.csv"] !== undefined && manifest.waiverNotifications === null) {
    report.add(
      "manifest.csv",
      null,
      "waiver_notifications",
      "missing_required",
      "A batch with bookings needs a waiver notification policy.",
    );
  }

  const keys: Record<DataFile, (row: Row) => string> = {
    "products.csv": (r) => join(src, s(r, "source_product_id")),
    "trips.csv": (r) => join(src, s(r, "source_trip_id")),
    "customers.csv": (r) => join(src, s(r, "source_customer_id")),
    "bookings.csv": (r) => join(src, s(r, "source_booking_ref"), s(r, "trip_date")),
    "participants.csv": (r) =>
      join(src, s(r, "source_booking_ref"), s(r, "trip_date"), n(r, "position")),
    "payments.csv": (r) => join(src, s(r, "source_payment_id")),
    "opening_balances.csv": (r) => join(src, s(r, "source_balance_id")),
    "waivers.csv": (r) =>
      join(src, s(r, "source_booking_ref"), s(r, "trip_date"), n(r, "position")),
  };
  const byFile = new Map<DataFile, FileRows>();
  for (const file of present) {
    const fr = readFile(report, file, files[file] as string, keys[file]);
    refuseDuplicates(report, fr);
    byFile.set(file, fr);
  }
  const rowsOf = (file: DataFile) => byFile.get(file)?.rows ?? [];

  // Records earlier commits imported: the same values are a no-op, and other
  // values are refused, since a re-import never overwrites.
  for (const [file, fr] of byFile) {
    for (const row of fr.rows) {
      if (row.raw.size > 0) row.hash = await rowHash(file, row);
    }
  }
  // Imported bookings canceled in TideGrid since: nothing new is added to them.
  const closedBookings = new Set<string>();
  if (lookup.imported) {
    const wanted = new Map<DataFile, string[]>();
    for (const [file, fr] of byFile) {
      const keysOf = fr.rows.filter((r) => !r.refused && r.key !== "").map((r) => r.key);
      if (keysOf.length > 0) wanted.set(file, keysOf);
    }
    const earlier = wanted.size > 0 ? await lookup.imported(wanted) : new Map();
    for (const [file, fr] of byFile) {
      for (const row of fr.rows) {
        if (row.refused || row.key === "") continue;
        const found = earlier.get(`${file}|${row.key}`);
        if (!found) continue;
        if (found.rowHash === row.hash) {
          row.unchanged = true;
          if (file === "bookings.csv" && found.closed) closedBookings.add(row.key);
        } else {
          report.add(
            file,
            row,
            null,
            "changed_since_import",
            "This record was imported before with other values; an import never overwrites. Correct it in TideGrid.",
          );
        }
      }
    }
  }
  const parentRejected = (file: DataFile, row: Row, column: string, what: string) =>
    report.add(file, row, column, "parent_rejected", `The ${what} this row refers to was refused.`);
  const unknownRef = (file: DataFile, row: Row, column: string, where: string) =>
    report.add(
      file,
      row,
      column,
      "unknown_reference",
      `No row in ${where} has this id.`,
      s(row, column) ?? null,
    );

  // Products ----------------------------------------------------------------
  const productRows = new Map<string, Row>();
  const products = await lookup.products(
    rowsOf("products.csv").flatMap((r) =>
      s(r, "tidegrid_product_id") ? [s(r, "tidegrid_product_id") as string] : [],
    ),
  );
  const productBySource = new Map<string, ProductInfo>();
  for (const row of rowsOf("products.csv")) {
    const id = s(row, "tidegrid_product_id");
    const source = s(row, "source_product_id");
    if (source) productRows.set(source, row);
    if (!id || row.refused) continue;
    const product = products.get(id);
    if (!product) {
      report.add(
        "products.csv",
        row,
        "tidegrid_product_id",
        "product_not_found",
        "No product of this operator has this id.",
        id,
      );
      continue;
    }
    if (s(row, "tidegrid_product_name") !== product.name) {
      report.add(
        "products.csv",
        row,
        "tidegrid_product_name",
        "product_name_mismatch",
        "The name does not match the product's current name; check the id.",
      );
    }
    if (s(row, "product_kind") !== product.kind) {
      report.add(
        "products.csv",
        row,
        "product_kind",
        "product_kind_mismatch",
        `The product is ${product.kind}.`,
        s(row, "product_kind") ?? null,
      );
    }
    if (product.zone !== manifest.operatorTimeZone) {
      report.add(
        "products.csv",
        row,
        "tidegrid_product_id",
        "zone_mismatch",
        "The product's location is not in the manifest's operator time zone.",
        id,
      );
    }
    if (!row.refused && source) productBySource.set(source, product);
  }

  // Trips -------------------------------------------------------------------
  const boats = await lookup.boats(
    rowsOf("trips.csv").flatMap((r) =>
      s(r, "tidegrid_boat_id") ? [s(r, "tidegrid_boat_id") as string] : [],
    ),
  );
  const plans: TripPlan[] = [];
  const tripRows = new Map<string, Row>();
  for (const row of rowsOf("trips.csv")) {
    const source = s(row, "source_trip_id");
    if (source) tripRows.set(source, row);
    if (row.refused) continue;
    const productSource = s(row, "source_product_id") as string;
    const product = productBySource.get(productSource);
    if (!product) {
      if (productRows.has(productSource))
        parentRejected("trips.csv", row, "source_product_id", "product");
      else unknownRef("trips.csv", row, "source_product_id", "products.csv");
      continue;
    }
    const boat = boats.get(s(row, "tidegrid_boat_id") as string);
    if (!boat?.active || !boat.productIds.has(product.id)) {
      report.add(
        "trips.csv",
        row,
        "tidegrid_boat_id",
        "boat_not_linked",
        "This boat is not an active boat linked to the product.",
        s(row, "tidegrid_boat_id") ?? null,
      );
      continue;
    }
    const zone = s(row, "time_zone") as string;
    if (zone !== product.zone || zone !== manifest.operatorTimeZone) {
      report.add(
        "trips.csv",
        row,
        "time_zone",
        "zone_mismatch",
        "The zone must be the product location's and the manifest's.",
        zone,
      );
      continue;
    }
    const localDate = s(row, "local_date") as string;
    const localTime = s(row, "local_start_time") as string;
    if (Number(localDate.slice(0, 4)) > LAST_YEAR) {
      report.add(
        "trips.csv",
        row,
        "local_date",
        "out_of_range",
        "The date is too far ahead.",
        localDate,
      );
      continue;
    }
    const resolved = instantsFor(zone, localDate, localTime);
    const offset = s(row, "utc_offset");
    let startMs: number;
    if (resolved.kind === "nonexistent") {
      report.add(
        "trips.csv",
        row,
        "local_start_time",
        "nonexistent_local_time",
        `${localTime} does not exist on ${localDate} in ${zone}.`,
        localTime,
      );
      continue;
    }
    if (resolved.kind === "ambiguous") {
      const pick = offset
        ? resolved.options.find((o) => o.offsetMinutes === offsetMinutes(offset))
        : undefined;
      if (!pick) {
        report.add(
          "trips.csv",
          row,
          offset ? "utc_offset" : "local_start_time",
          "ambiguous_local_time",
          `${localTime} happens twice on ${localDate} in ${zone}; utc_offset must pick one.`,
          offset ?? localTime,
        );
        continue;
      }
      startMs = pick.epochMs;
    } else {
      if (offset && offsetMinutes(offset) !== resolved.offsetMinutes) {
        report.add(
          "trips.csv",
          row,
          "utc_offset",
          "out_of_range",
          "The offset is not the zone's offset at this time.",
          offset,
        );
        continue;
      }
      startMs = resolved.epochMs;
    }
    if (startMs <= exportedMs) {
      report.add(
        "trips.csv",
        row,
        "local_date",
        "trip_in_past",
        "The trip starts before the export; only future departures are imported.",
        localDate,
      );
      continue;
    }
    if (startMs <= nowMs) {
      report.add(
        "trips.csv",
        row,
        "local_date",
        "trip_departed",
        "The trip has already departed.",
        localDate,
      );
      continue;
    }
    const given = n(row, "seat_capacity");
    if (product.kind === "private_charter" && given !== undefined) {
      report.add(
        "trips.csv",
        row,
        "seat_capacity",
        "out_of_range",
        "A private charter takes the whole boat; leave seat_capacity empty.",
        String(given),
      );
      continue;
    }
    const capacity =
      product.kind === "private_charter"
        ? boat.guestCapacity
        : (given ?? Math.min(product.seatLimit ?? boat.guestCapacity, boat.guestCapacity));
    if (capacity > boat.guestCapacity) {
      report.add(
        "trips.csv",
        row,
        "seat_capacity",
        "out_of_range",
        `The boat takes ${boat.guestCapacity} guests.`,
        String(capacity),
      );
      continue;
    }
    const freeAtMs = startMs + (product.durationMinutes + product.turnaroundMinutes) * MINUTE_MS;
    plans.push({
      row,
      product,
      boat,
      startMs,
      freeAtMs,
      localDate,
      localTime,
      capacity,
      existing: null,
    });
  }
  // The database must read each start the same way, or it would refuse the trip.
  if (plans.length > 0) {
    const zone = manifest.operatorTimeZone;
    const mismatched = await lookup.zoneMismatches(
      zone,
      plans.map((p) => {
        const endsAtMs = p.startMs + p.product.durationMinutes * MINUTE_MS;
        return {
          startsAtMs: p.startMs,
          local: `${p.localDate} ${p.localTime}`,
          offsetMinutes: offsetAt(zone, p.startMs),
          endsAtMs,
          endOffsetMinutes: offsetAt(zone, endsAtMs),
        };
      }),
    );
    plans.forEach((plan, i) => {
      if (!mismatched.has(i)) return;
      report.add(
        "trips.csv",
        plan.row,
        "time_zone",
        "zone_mismatch",
        "The database's time zone data reads this local time differently; the trip cannot be placed until they agree.",
        plan.localDate,
      );
    });
  }
  // The same departure under two source ids.
  const sameDeparture = new Map<string, TripPlan[]>();
  for (const plan of plans) {
    const k = `${plan.product.id}|${plan.boat.id}|${plan.startMs}`;
    const list = sameDeparture.get(k);
    if (list) list.push(plan);
    else sameDeparture.set(k, [plan]);
  }
  for (const [, list] of sameDeparture) {
    if (list.length < 2) continue;
    const lines = linesText(list.map((p) => p.row.line));
    for (const plan of list) {
      report.add(
        "trips.csv",
        plan.row,
        "source_trip_id",
        "duplicate_key_in_batch",
        `Another row is the same product, boat, and start (${lines}).`,
      );
    }
  }
  // Existing trips: the same departure maps onto it; any other overlap on the boat is refused.
  let live: TripInfo[] = [];
  const open = plans.filter((p) => !p.row.refused);
  if (open.length > 0) {
    let from = Number.POSITIVE_INFINITY;
    let to = Number.NEGATIVE_INFINITY;
    for (const p of open) {
      from = Math.min(from, p.startMs);
      to = Math.max(to, p.freeAtMs);
    }
    live = await lookup.liveTrips([...new Set(open.map((p) => p.boat.id))], from, to);
  }
  // A canceled departure still holds its product, boat, and start, so a row
  // naming it is refused; it never blocks another trip on the boat. Lookups
  // are by key, and overlaps by a binary search over each boat's trips sorted
  // by start, so a large batch against many trips stays near-linear.
  const departureKey = (product: string, boat: string, startMs: number) =>
    `${product}|${boat}|${startMs}`;
  const canceledKeys = new Set<string>();
  const liveByKey = new Map<string, TripInfo>();
  const liveByBoat = new Map<string, TripInfo[]>();
  for (const t of live) {
    const k = departureKey(t.productId, t.boatId, t.startsAtMs);
    if (t.salesState === "canceled") {
      canceledKeys.add(k);
      continue;
    }
    liveByKey.set(k, t);
    const list = liveByBoat.get(t.boatId);
    if (list) list.push(t);
    else liveByBoat.set(t.boatId, [t]);
  }
  // Per boat: trips by start, with the latest boat-free time so far.
  const boatIndex = new Map<string, { trips: TripInfo[]; maxFree: number[] }>();
  for (const [boatId, trips] of liveByBoat) {
    trips.sort((a, c) => a.startsAtMs - c.startsAtMs);
    const maxFree: number[] = [];
    trips.forEach((t, i) => {
      maxFree.push(Math.max(t.boatFreeAtMs, i > 0 ? (maxFree[i - 1] as number) : t.boatFreeAtMs));
    });
    boatIndex.set(boatId, { trips, maxFree });
  }
  /** A live trip on the boat, other than `except`, that is out between start and free. */
  const clashWith = (
    boatId: string,
    startMs: number,
    freeAtMs: number,
    except: TripInfo | null,
  ): TripInfo | null => {
    const index = boatIndex.get(boatId);
    if (!index) return null;
    // The last trip starting before `freeAtMs`.
    let lo = 0;
    let hi = index.trips.length - 1;
    let last = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if ((index.trips[mid] as TripInfo).startsAtMs < freeAtMs) {
        last = mid;
        lo = mid + 1;
      } else hi = mid - 1;
    }
    for (let j = last; j >= 0 && (index.maxFree[j] as number) > startMs; j -= 1) {
      const t = index.trips[j] as TripInfo;
      if (t !== except && t.boatFreeAtMs > startMs) return t;
    }
    return null;
  };
  for (const plan of open) {
    const k = departureKey(plan.product.id, plan.boat.id, plan.startMs);
    if (canceledKeys.has(k)) {
      report.add(
        "trips.csv",
        plan.row,
        "local_start_time",
        "trip_canceled",
        "This departure was canceled in TideGrid.",
        plan.localDate,
      );
      continue;
    }
    const same = liveByKey.get(k) ?? null;
    if (same) {
      if (n(plan.row, "seat_capacity") !== undefined && same.seatCapacity !== plan.capacity) {
        report.add(
          "trips.csv",
          plan.row,
          "seat_capacity",
          "out_of_range",
          `This departure already exists in TideGrid with ${same.seatCapacity} seats.`,
          String(plan.capacity),
        );
        continue;
      }
      plan.existing = same;
      plan.capacity = same.seatCapacity;
      plan.freeAtMs = same.boatFreeAtMs;
    }
    if (clashWith(plan.boat.id, plan.startMs, plan.freeAtMs, same)) {
      report.add(
        "trips.csv",
        plan.row,
        "local_start_time",
        "boat_overlap",
        "The boat is already on another trip then, including its turnaround.",
        plan.localDate,
      );
    }
  }
  const stillOpen = open.filter((p) => !p.row.refused && !p.existing);
  // Two new trips on one boat at once: per boat, sorted by start, a trip
  // overlaps another exactly when an earlier one is still out at its start or
  // the next one starts before it is free.
  const byBoat = new Map<string, TripPlan[]>();
  for (const plan of stillOpen) {
    const list = byBoat.get(plan.boat.id);
    if (list) list.push(plan);
    else byBoat.set(plan.boat.id, [plan]);
  }
  const overlapOf = new Map<TripPlan, TripPlan>();
  for (const [, list] of byBoat) {
    list.sort((a, c) => a.startMs - c.startMs);
    let latest: TripPlan | null = null;
    list.forEach((plan, i) => {
      const next = list[i + 1];
      if (latest && latest.freeAtMs > plan.startMs) overlapOf.set(plan, latest);
      else if (next && next.startMs < plan.freeAtMs) overlapOf.set(plan, next);
      if (!latest || plan.freeAtMs > latest.freeAtMs) latest = plan;
    });
  }
  for (const plan of stillOpen) {
    const other = overlapOf.get(plan);
    if (other) {
      report.add(
        "trips.csv",
        plan.row,
        "local_start_time",
        "boat_overlap",
        `The boat would be on two trips at once (line ${other.row.line}).`,
        plan.localDate,
      );
    }
  }
  const tripBySource = new Map<string, TripPlan>();
  for (const plan of plans) {
    if (!plan.row.refused) tripBySource.set(s(plan.row, "source_trip_id") as string, plan);
  }

  // Customers -----------------------------------------------------------------
  const customerRows = new Map<string, Row>();
  const byEmail = new Map<string, Row[]>();
  for (const row of rowsOf("customers.csv")) {
    const source = s(row, "source_customer_id");
    if (source) customerRows.set(source, row);
    const email = s(row, "email");
    if (email && !row.refused) {
      const list = byEmail.get(email);
      if (list) list.push(row);
      else byEmail.set(email, [row]);
    }
  }
  for (const [, list] of byEmail) {
    if (list.length < 2) continue;
    const lines = linesText(list.map((r) => r.line));
    for (const row of list) {
      report.add(
        "customers.csv",
        row,
        "email",
        "customer_match_candidate",
        `Another customer has the same email (${lines}); they stay separate until reviewed.`,
        "[withheld]",
        "warning",
      );
    }
  }
  const customerOk = (id: string) => {
    const row = customerRows.get(id);
    return row ? (row.refused ? "refused" : "ok") : "unknown";
  };

  // Bookings ------------------------------------------------------------------
  interface BookingPlan {
    row: Row;
    trip: TripPlan;
    ota: boolean;
    total: number;
  }
  const bookingRows = new Map<string, Row>();
  const bookingPlans = new Map<string, BookingPlan>();
  for (const row of rowsOf("bookings.csv")) {
    const ref = s(row, "source_booking_ref");
    const date = s(row, "trip_date");
    if (ref && date) bookingRows.set(`${ref}|${date}`, row);
    if (row.refused) continue;
    const tripSource = s(row, "source_trip_id") as string;
    const trip = tripBySource.get(tripSource);
    if (!trip) {
      if (tripRows.has(tripSource)) parentRejected("bookings.csv", row, "source_trip_id", "trip");
      else unknownRef("bookings.csv", row, "source_trip_id", "trips.csv");
      continue;
    }
    const customer = customerOk(s(row, "source_customer_id") as string);
    if (customer === "unknown") {
      unknownRef("bookings.csv", row, "source_customer_id", "customers.csv");
      continue;
    }
    if (customer === "refused") {
      parentRejected("bookings.csv", row, "source_customer_id", "customer");
      continue;
    }
    if (date !== trip.localDate) {
      report.add(
        "bookings.csv",
        row,
        "trip_date",
        "trip_date_mismatch",
        `The trip's date is ${trip.localDate}.`,
        date ?? null,
      );
    }
    const source = s(row, "booking_source");
    const channel = s(row, "staff_channel");
    if (source === "staff_assisted" && !channel) {
      report.add(
        "bookings.csv",
        row,
        "staff_channel",
        "staff_channel_required",
        "A staff-assisted booking needs its channel.",
      );
    }
    if (source !== "staff_assisted" && channel) {
      report.add(
        "bookings.csv",
        row,
        "staff_channel",
        "staff_channel_not_allowed",
        "Only a staff-assisted booking has a staff channel.",
        channel,
      );
    }
    const ota = source === "ota";
    if (ota && !s(row, "ota_channel")) {
      report.add(
        "bookings.csv",
        row,
        "ota_channel",
        "missing_required",
        "An OTA booking names its OTA.",
      );
    }
    if (!ota && s(row, "ota_channel")) {
      report.add(
        "bookings.csv",
        row,
        "ota_channel",
        "out_of_range",
        "Only an OTA booking names an OTA.",
      );
    }
    const money = [
      "subtotal_cents",
      "discount_cents",
      "fee_cents",
      "tax_cents",
      "included_tax_cents",
      "total_cents",
    ];
    let total = 0;
    if (ota) {
      const given = money.filter((c) => (row.raw.get(c) ?? "") !== "");
      if (given.length > 0) {
        report.add(
          "bookings.csv",
          row,
          given[0] as string,
          "ota_amounts_present",
          "An OTA booking carries no amounts; its money stays with the OTA.",
        );
      }
    } else {
      const missing = money.filter((c) => (row.raw.get(c) ?? "") === "");
      for (const c of missing) {
        report.add(
          "bookings.csv",
          row,
          c,
          "missing_required",
          "A direct or staff-assisted booking carries every amount.",
        );
      }
      const [sub, disc, fee, tax, incl, tot] = money.map((c) => n(row, c));
      if (
        sub !== undefined &&
        disc !== undefined &&
        fee !== undefined &&
        tax !== undefined &&
        tot !== undefined
      ) {
        if (disc > sub) {
          report.add(
            "bookings.csv",
            row,
            "discount_cents",
            "out_of_range",
            "The discount is above the subtotal.",
            String(disc),
          );
        } else if (sub - disc + fee + tax !== tot) {
          report.add(
            "bookings.csv",
            row,
            "total_cents",
            "amounts_do_not_add_up",
            `Subtotal minus discount plus fee plus tax is ${sub - disc + fee + tax}.`,
            String(tot),
          );
        }
        if (incl !== undefined && incl > sub - disc) {
          report.add(
            "bookings.csv",
            row,
            "included_tax_cents",
            "out_of_range",
            "Included tax is above the subtotal less the discount.",
            String(incl),
          );
        }
        total = tot;
      }
    }
    const party = n(row, "party_size") as number;
    if (party < trip.product.minParty || party > trip.product.maxParty) {
      report.add(
        "bookings.csv",
        row,
        "party_size",
        "out_of_range",
        `The product takes parties of ${trip.product.minParty} to ${trip.product.maxParty}.`,
        String(party),
      );
    } else if (trip.product.kind === "shared_seat" && party > trip.capacity) {
      report.add(
        "bookings.csv",
        row,
        "party_size",
        "out_of_range",
        `The trip has ${trip.capacity} seats.`,
        String(party),
      );
    } else if (trip.product.kind === "private_charter" && party > trip.boat.guestCapacity) {
      report.add(
        "bookings.csv",
        row,
        "party_size",
        "out_of_range",
        `The boat takes ${trip.boat.guestCapacity} guests.`,
        String(party),
      );
    }
    if (s(row, "balance_due_date") && trip.product.kind !== "private_charter") {
      report.add(
        "bookings.csv",
        row,
        "balance_due_date",
        "unexpected_balance",
        "Only a private charter has a balance due date.",
        s(row, "balance_due_date") ?? null,
      );
    }
    const bookedAt = s(row, "booked_at");
    if (bookedAt && timestampMs(bookedAt) > exportedMs) {
      report.add(
        "bookings.csv",
        row,
        "booked_at",
        "later_than_export",
        "This is later than the export.",
        bookedAt,
      );
    }
    if (!row.refused) bookingPlans.set(`${ref}|${date}`, { row, trip, ota, total });
  }
  const bookingFor = (file: DataFile, row: Row): BookingPlan | null => {
    const k = `${s(row, "source_booking_ref")}|${s(row, "trip_date")}`;
    const plan = bookingPlans.get(k);
    if (plan && !plan.row.refused) return plan;
    if (bookingRows.has(k)) parentRejected(file, row, "source_booking_ref", "booking");
    else unknownRef(file, row, "source_booking_ref", "bookings.csv");
    return null;
  };

  // Payments, before capacity: a booking whose money does not balance is
  // refused before it takes seats. Totals per booking, so row order never matters.
  interface PaymentEntry {
    row: Row;
    booking: BookingPlan;
    amount: number;
    refund: boolean;
  }
  const entries = new Map<BookingPlan, PaymentEntry[]>();
  for (const row of rowsOf("payments.csv")) {
    if (row.refused) continue;
    const booking = bookingPlans.get(`${s(row, "source_booking_ref")}|${s(row, "trip_date")}`);
    if (!booking) {
      bookingFor("payments.csv", row);
      continue;
    }
    if (!row.unchanged && closedBookings.has(booking.row.key)) {
      report.add(
        "payments.csv",
        row,
        "source_booking_ref",
        "booking_closed",
        "The booking this row adds to was canceled in TideGrid since it was imported.",
      );
      continue;
    }
    if (booking.ota) {
      report.add(
        "payments.csv",
        row,
        "source_booking_ref",
        "payment_on_ota_booking",
        "An OTA booking's money stays with the OTA.",
      );
      continue;
    }
    const at = s(row, "received_at") as string;
    if (timestampMs(at) > exportedMs) {
      report.add(
        "payments.csv",
        row,
        "received_at",
        "later_than_export",
        "This is later than the export.",
        at,
      );
      continue;
    }
    const entry = {
      row,
      booking,
      amount: n(row, "amount_cents") as number,
      refund: s(row, "entry_kind") !== "payment",
    };
    const list = entries.get(booking);
    if (list) list.push(entry);
    else entries.set(booking, [entry]);
  }
  // Payments earlier commits imported for these bookings count too, once: a
  // row this batch repeats is counted from the batch.
  const earlierPaid = new Map<BookingPlan, { in: number; out: number }>();
  if (lookup.importedPayments && bookingPlans.size > 0) {
    const inBatch = new Set(rowsOf("payments.csv").map((r) => r.key));
    const byKey = new Map([...bookingPlans.values()].map((p) => [p.row.key, p]));
    for (const p of await lookup.importedPayments([...byKey.keys()])) {
      if (inBatch.has(p.paymentKey)) continue;
      const plan = byKey.get(p.bookingKey);
      if (!plan) continue;
      const sums = earlierPaid.get(plan) ?? { in: 0, out: 0 };
      if (p.refund) sums.out += p.amount;
      else sums.in += p.amount;
      earlierPaid.set(plan, sums);
    }
  }
  const paid = new Map<BookingPlan, { in: number; out: number }>();
  for (const booking of new Set([...entries.keys(), ...earlierPaid.keys()])) {
    const list = entries.get(booking) ?? [];
    let sumIn = earlierPaid.get(booking)?.in ?? 0;
    let sumOut = earlierPaid.get(booking)?.out ?? 0;
    for (const e of list) {
      if (e.refund) sumOut += e.amount;
      else sumIn += e.amount;
    }
    if (sumOut > sumIn) {
      for (const e of list.filter((x) => x.refund)) {
        report.add(
          "payments.csv",
          e.row,
          "amount_cents",
          "refund_exceeds_payments",
          `The booking's refunds (${sumOut}) exceed its payments (${sumIn}).`,
          String(e.amount),
        );
      }
      report.add(
        "bookings.csv",
        booking.row,
        "total_cents",
        "refund_exceeds_payments",
        "The booking's refunds exceed its payments, so its money cannot be taken over.",
      );
      continue;
    }
    // TideGrid's ledger caps a booking's refunds at what it cost, so an
    // overpayment returned before TideGrid cannot be taken over as such.
    if (sumOut > booking.total) {
      for (const e of list.filter((x) => x.refund)) {
        report.add(
          "payments.csv",
          e.row,
          "amount_cents",
          "refunds_exceed_total",
          `The booking's refunds (${sumOut}) exceed its total of ${booking.total}.`,
          String(e.amount),
        );
      }
      report.add(
        "bookings.csv",
        booking.row,
        "total_cents",
        "refunds_exceed_total",
        "The booking's refunds exceed its total, so its money cannot be taken over. Net the overpayment and its refund out of the export.",
      );
      continue;
    }
    if (sumIn - sumOut > booking.total) {
      for (const e of list.filter((x) => !x.refund)) {
        report.add(
          "payments.csv",
          e.row,
          "amount_cents",
          "overpaid",
          `The booking's payments, less refunds, come to ${sumIn - sumOut}, more than its total of ${booking.total}.`,
          String(e.amount),
        );
      }
      report.add(
        "bookings.csv",
        booking.row,
        "total_cents",
        "overpaid",
        "The booking's payments exceed its total, so its money cannot be taken over.",
      );
      continue;
    }
    paid.set(booking, { in: sumIn, out: sumOut });
  }
  const withBalance =
    lookup.balanceBookings && bookingPlans.size > 0
      ? await lookup.balanceBookings([...bookingPlans.values()].map((p) => p.row.key))
      : new Set<string>();
  let outstanding = 0;
  const owing = new Map<BookingPlan, number>();
  /** A charter's balance, by its bookings.csv row: what came in, and the due date. */
  const balances = new Map<Row, { paidBefore: number; dueDate: string; dueAtMs: number }>();
  for (const [, plan] of bookingPlans) {
    if (plan.ota || plan.row.refused) continue;
    const sums = paid.get(plan) ?? { in: 0, out: 0 };
    const left = plan.total - (sums.in - sums.out);
    // A charter imported with a balance keeps taking its money as money in,
    // so a later batch brings it no refund, even once it is paid off.
    if (withBalance.has(plan.row.key) && (entries.get(plan) ?? []).some((e) => e.refund)) {
      report.add(
        "bookings.csv",
        plan.row,
        "balance_due_date",
        "refund_with_balance",
        "This charter was imported with a balance, so it takes no imported refund; record the refund in TideGrid instead.",
      );
      continue;
    }
    if (left <= 0) continue;
    if (plan.trip.product.kind !== "private_charter") {
      report.add(
        "bookings.csv",
        plan.row,
        "total_cents",
        "unexpected_balance",
        `A shared-seat booking cannot carry a balance; ${left} is unpaid.`,
        String(plan.total),
      );
      continue;
    }
    if (!s(plan.row, "balance_due_date")) {
      report.add(
        "bookings.csv",
        plan.row,
        "balance_due_date",
        "balance_due_date_missing",
        `${left} is unpaid; a balance needs its due date.`,
      );
      continue;
    }
    const dueDate = s(plan.row, "balance_due_date") as string;
    const dueAtMs = endOfLocalDate(manifest.operatorTimeZone, dueDate);
    if (dueDate >= plan.trip.localDate || dueAtMs >= plan.trip.startMs) {
      report.add(
        "bookings.csv",
        plan.row,
        "balance_due_date",
        "balance_due_after_trip",
        `A balance falls due before the trip; the trip is on ${plan.trip.localDate}.`,
        dueDate,
      );
      continue;
    }
    // TideGrid reads a charter's balance from the money that came in, so a
    // refund on a booking that still owes cannot be taken over as such.
    if (sums.out > 0) {
      report.add(
        "bookings.csv",
        plan.row,
        "balance_due_date",
        "refund_with_balance",
        "A charter that still owes a balance has a refund; net the refund out of its payments in the export.",
      );
      continue;
    }
    owing.set(plan, left);
    balances.set(plan.row, { paidBefore: sums.in - sums.out, dueDate, dueAtMs });
  }

  // Capacity, in file order: rows that would overbook are refused.
  const taken = new Map<TripPlan, { seats: number; bookings: number }>();
  for (const [, plan] of bookingPlans) {
    // A booking imported before already holds its seats.
    if (plan.row.refused || plan.row.unchanged) continue;
    const t = taken.get(plan.trip) ?? {
      seats: plan.trip.existing?.heldSeats ?? 0,
      bookings: plan.trip.existing && plan.trip.existing.heldSeats > 0 ? 1 : 0,
    };
    const party = n(plan.row, "party_size") as number;
    if (plan.trip.product.kind === "private_charter") {
      if (t.bookings > 0) {
        report.add(
          "bookings.csv",
          plan.row,
          "source_trip_id",
          "charter_already_booked",
          "This private charter already has a booking.",
        );
        continue;
      }
      t.bookings = 1;
      t.seats = plan.trip.boat.guestCapacity;
    } else {
      if (t.seats + party > plan.trip.capacity) {
        report.add(
          "bookings.csv",
          plan.row,
          "party_size",
          "over_capacity",
          `The trip would hold ${t.seats + party} guests against ${plan.trip.capacity} seats.`,
          String(party),
        );
        continue;
      }
      t.seats += party;
      t.bookings += 1;
    }
    taken.set(plan.trip, t);
  }
  // Payments on a booking refused for its money or its seats go with it.
  for (const [booking, list] of entries) {
    for (const e of list) {
      if (e.row.refused) continue;
      if (booking.row.refused)
        parentRejected("payments.csv", e.row, "source_booking_ref", "booking");
    }
  }
  for (const [plan, left] of owing) {
    if (!plan.row.refused) outstanding += left;
  }

  // Participants ----------------------------------------------------------------
  const participantRows = new Map<string, Row>();
  for (const row of rowsOf("participants.csv")) {
    participantRows.set(row.key, row);
    if (row.refused) continue;
    const booking = bookingFor("participants.csv", row);
    if (!booking) continue;
    if (!row.unchanged && closedBookings.has(booking.row.key)) {
      report.add(
        "participants.csv",
        row,
        "source_booking_ref",
        "booking_closed",
        "The booking this row adds to was canceled in TideGrid since it was imported.",
      );
      continue;
    }
    const position = n(row, "position") as number;
    const party = n(booking.row, "party_size") as number;
    if (position > party) {
      report.add(
        "participants.csv",
        row,
        "position",
        "position_out_of_range",
        `The booking's party is ${party}.`,
        String(position),
      );
    }
    const minor = b(row, "is_minor");
    const guardian = ["guardian_name", "guardian_email"];
    if (minor) {
      for (const c of guardian) {
        if (!s(row, c))
          report.add(
            "participants.csv",
            row,
            c,
            "guardian_required",
            "A minor needs a guardian's name and email.",
          );
      }
    } else {
      for (const c of guardian) {
        if ((row.raw.get(c) ?? "") !== "") {
          report.add(
            "participants.csv",
            row,
            c,
            "guardian_not_allowed",
            "Only a minor has a guardian.",
            "[withheld]",
          );
        }
      }
      if (!row.refused && !s(row, "email")) {
        report.add(
          "participants.csv",
          row,
          "email",
          "participant_email_missing",
          "This adult has no email for the waiver request.",
          null,
          "warning",
        );
      }
    }
  }

  // Opening balances -----------------------------------------------------------------
  for (const file of ["opening_balances.csv", "waivers.csv"] as const) {
    if (rowsOf(file).length > 0) {
      report.add(
        file,
        null,
        null,
        "import_not_supported_yet",
        file === "waivers.csv"
          ? "Legacy waiver status is checked, but saving it comes with a later part of the import."
          : "Opening balances are checked, but saving them comes with a later part of the import.",
        null,
        notYet,
      );
    }
  }
  const today = localDateAt(manifest.operatorTimeZone, nowMs);
  for (const row of rowsOf("opening_balances.csv")) {
    if (row.refused) continue;
    const customer = customerOk(s(row, "source_customer_id") as string);
    if (customer === "unknown") {
      unknownRef("opening_balances.csv", row, "source_customer_id", "customers.csv");
      continue;
    }
    if (customer === "refused") {
      parentRejected("opening_balances.csv", row, "source_customer_id", "customer");
      continue;
    }
    const kind = s(row, "balance_kind");
    if (kind === "dollar_card" || kind === "trip_count_card") {
      report.add(
        "opening_balances.csv",
        row,
        "balance_kind",
        "module_disabled",
        "Trip cards and dollar cards are not enabled for this operator.",
        kind,
      );
      continue;
    }
    if (n(row, "amount_cents") === undefined) {
      report.add(
        "opening_balances.csv",
        row,
        "amount_cents",
        "missing_required",
        "A booking credit has an amount.",
      );
    }
    for (const c of ["lot_kind", "units"]) {
      if ((row.raw.get(c) ?? "") !== "") {
        report.add(
          "opening_balances.csv",
          row,
          c,
          "out_of_range",
          "A booking credit has no lot kind or units.",
          row.raw.get(c) ?? null,
        );
      }
    }
    const eligible = s(row, "eligible_source_product_ids");
    if (eligible) {
      for (const id of eligible.split("|").map((x) => x.trim())) {
        if (!productBySource.has(id)) {
          report.add(
            "opening_balances.csv",
            row,
            "eligible_source_product_ids",
            productRows.has(id) ? "parent_rejected" : "unknown_reference",
            "A listed product is not an accepted row of products.csv.",
            looksLikeCardNumber(id) ? "[withheld]" : id,
          );
          break;
        }
      }
    }
    const expires = s(row, "expires_on");
    if (expires && expires < today) {
      report.add(
        "opening_balances.csv",
        row,
        "expires_on",
        "balance_expired",
        `The balance expired before today (${today}).`,
        expires,
      );
    }
  }

  // Waivers ---------------------------------------------------------------------------
  for (const row of rowsOf("waivers.csv")) {
    if (row.refused) continue;
    const participant = participantRows.get(row.key);
    if (!participant) {
      if (!bookingFor("waivers.csv", row)) continue;
      report.add(
        "waivers.csv",
        row,
        "position",
        "unknown_reference",
        "No row in participants.csv has this booking and position.",
        String(n(row, "position")),
      );
      continue;
    }
    if (participant.refused) {
      parentRejected("waivers.csv", row, "position", "participant");
      continue;
    }
    const signedOn = s(row, "legacy_signed_on");
    if (signedOn && s(row, "legacy_status") !== "signed") {
      report.add(
        "waivers.csv",
        row,
        "legacy_signed_on",
        "out_of_range",
        "Only a signed waiver has a signing date.",
        signedOn,
      );
    }
  }

  // Control totals -----------------------------------------------------------------------
  const accepted = (file: DataFile) => rowsOf(file).filter((r) => !r.refused);
  const sum = (rows: Row[], col: string) => rows.reduce((acc, r) => acc + (n(r, col) ?? 0), 0);
  const count = (rows: Row[], pred: (r: Row) => boolean) => rows.filter(pred).length;
  const computed = (file: DataFile, metric: string): number => {
    const rows = accepted(file);
    if (metric === "row_count") return rows.length;
    switch (`${file}:${metric}`) {
      case "trips.csv:sum_seat_capacity":
        return plans
          .filter((p) => !p.row.refused && p.product.kind === "shared_seat")
          .reduce((acc, p) => acc + p.capacity, 0);
      case "customers.csv:rows_with_email":
        return count(rows, (r) => s(r, "email") !== undefined);
      case "bookings.csv:sum_party_size":
        return sum(rows, "party_size");
      case "bookings.csv:rows_direct":
        return count(rows, (r) => s(r, "booking_source") === "direct");
      case "bookings.csv:rows_staff_assisted":
        return count(rows, (r) => s(r, "booking_source") === "staff_assisted");
      case "bookings.csv:rows_ota":
        return count(rows, (r) => s(r, "booking_source") === "ota");
      case "bookings.csv:sum_total_cents":
        return sum(rows, "total_cents");
      case "bookings.csv:sum_included_tax_cents":
        return sum(rows, "included_tax_cents");
      case "participants.csv:rows_minor":
        return count(rows, (r) => b(r, "is_minor") === true);
      case "payments.csv:sum_payment_cents":
        return sum(
          rows.filter((r) => s(r, "entry_kind") === "payment"),
          "amount_cents",
        );
      case "payments.csv:sum_refund_cents":
        return sum(
          rows.filter((r) => s(r, "entry_kind") === "refund"),
          "amount_cents",
        );
      case "payments.csv:sum_outstanding_cents":
        return outstanding;
      case "opening_balances.csv:sum_booking_credit_cents":
        return sum(
          rows.filter((r) => s(r, "balance_kind") === "booking_credit"),
          "amount_cents",
        );
      case "opening_balances.csv:sum_dollar_card_cents":
        return sum(
          rows.filter((r) => s(r, "balance_kind") === "dollar_card"),
          "amount_cents",
        );
      case "opening_balances.csv:sum_trip_count_units":
        return sum(
          rows.filter((r) => s(r, "balance_kind") === "trip_count_card"),
          "units",
        );
      case "waivers.csv:rows_signed":
        return count(rows, (r) => s(r, "legacy_status") === "signed");
      case "waivers.csv:rows_unsigned":
        return count(rows, (r) => s(r, "legacy_status") === "unsigned");
      case "waivers.csv:rows_unknown":
        return count(rows, (r) => s(r, "legacy_status") === "unknown");
      default:
        return 0;
    }
  };
  const controls: ImportControl[] = [];
  for (const file of present) {
    if (!byFile.get(file)?.readable) continue;
    for (const metric of CONTROL_METRICS[file]) {
      const entry = declared.get(`${metric}|${file}`);
      const value = computed(file, metric);
      const matches = entry?.value === value;
      controls.push({ file, metric, declared: entry?.value ?? null, computed: value, matches });
      if (!entry) {
        report.add(
          "manifest.csv",
          null,
          metric,
          "missing_required",
          `The manifest does not declare ${metric} for ${file}.`,
        );
      } else if (!matches && entry.value !== null) {
        report.add(
          "manifest.csv",
          {
            line: entry.line,
            raw: new Map(),
            v: new Map(),
            key: `${metric}|${file}`,
            refused: false,
          },
          metric,
          "control_total_mismatch",
          `Declared ${entry.value} for ${file}; accepted rows give ${value}.`,
          String(entry.value),
        );
      }
    }
  }
  for (const [key, entry] of declared) {
    const file = key.slice(key.indexOf("|") + 1) as DataFile;
    if (!present.includes(file)) {
      report.add(
        "manifest.csv",
        { line: entry.line, raw: new Map(), v: new Map(), key, refused: false },
        "file",
        "missing_file",
        `A total is declared for ${file}, which is not in the batch.`,
        file,
      );
    }
  }
  const result = finish(report, manifest, summaries(byFile), controls);
  if (!result.clean) return result;

  // The plan a commit writes: every accepted row, in file order.
  const planned = (_file: DataFile, row: Row, externalId: string): PlannedRow => ({
    key: row.key,
    externalId,
    rowHash: row.hash as string,
    unchanged: row.unchanged === true,
  });
  const opt = (row: Row, col: string) => s(row, col) ?? null;
  const plan: ImportPlan = {
    sourceSystem: manifest.sourceSystem,
    products: accepted("products.csv").map((row) => ({
      ...planned("products.csv", row, s(row, "source_product_id") as string),
      productId: s(row, "tidegrid_product_id") as string,
    })),
    trips: plans
      .filter((p) => !p.row.refused)
      .map((p) => ({
        ...planned("trips.csv", p.row, s(p.row, "source_trip_id") as string),
        sourceTripId: s(p.row, "source_trip_id") as string,
        existingTripId: p.existing?.id ?? null,
        productId: p.product.id,
        boatId: p.boat.id,
        startsAtMs: p.startMs,
        endsAtMs: p.startMs + p.product.durationMinutes * MINUTE_MS,
        timeZone: manifest.operatorTimeZone,
        localDate: p.localDate,
        localStartTime: p.localTime,
        startOffsetMinutes: offsetAt(manifest.operatorTimeZone, p.startMs),
        endOffsetMinutes: offsetAt(
          manifest.operatorTimeZone,
          p.startMs + p.product.durationMinutes * MINUTE_MS,
        ),
        durationMinutes: p.product.durationMinutes,
        seatCapacity: p.capacity,
      })),
    customers: accepted("customers.csv").map((row) => ({
      ...planned("customers.csv", row, s(row, "source_customer_id") as string),
      sourceCustomerId: s(row, "source_customer_id") as string,
      fullName: s(row, "full_name") as string,
      email: opt(row, "email"),
      phone: opt(row, "phone"),
    })),
    bookings: accepted("bookings.csv").map((row) => {
      const source = s(row, "booking_source") as "direct" | "staff_assisted" | "ota";
      return {
        ...planned("bookings.csv", row, s(row, "source_booking_ref") as string),
        sourceTripId: s(row, "source_trip_id") as string,
        sourceCustomerId: s(row, "source_customer_id") as string,
        legacySource: source,
        staffChannel: (s(row, "staff_channel") ?? null) as "phone" | "email" | "walk_up" | null,
        otaChannel: opt(row, "ota_channel"),
        partySize: n(row, "party_size") as number,
        amounts:
          source === "ota"
            ? null
            : {
                subtotal: n(row, "subtotal_cents") as number,
                discount: n(row, "discount_cents") as number,
                fee: n(row, "fee_cents") as number,
                tax: n(row, "tax_cents") as number,
                includedTax: n(row, "included_tax_cents") as number,
                total: n(row, "total_cents") as number,
              },
        bookedAt: opt(row, "booked_at"),
        balance: balances.get(row) ?? null,
      };
    }),
    participants: accepted("participants.csv").map((row) => ({
      ...planned(
        "participants.csv",
        row,
        `${s(row, "source_booking_ref")}|${s(row, "trip_date")}|${n(row, "position")}`,
      ),
      bookingKey: join(src, s(row, "source_booking_ref"), s(row, "trip_date")),
      position: n(row, "position") as number,
      fullName: s(row, "full_name") as string,
      isMinor: b(row, "is_minor") === true,
      email: opt(row, "email"),
      guardianName: opt(row, "guardian_name"),
      guardianEmail: opt(row, "guardian_email"),
    })),
    payments: accepted("payments.csv").map((row) => ({
      ...planned("payments.csv", row, s(row, "source_payment_id") as string),
      bookingKey: join(src, s(row, "source_booking_ref"), s(row, "trip_date")),
      refund: s(row, "entry_kind") === "refund",
      amount: n(row, "amount_cents") as number,
      tender: s(row, "tender") as ImportPlan["payments"][number]["tender"],
      reference: opt(row, "reference"),
      receivedAt: s(row, "received_at") as string,
    })),
  };
  return { ...result, plan };
}

function finish(
  report: Report,
  manifest: ImportManifest | null,
  files: ImportFileSummary[],
  controls: ImportControl[],
): ImportDryRun {
  const { errorCount, warningCount } = report;
  return {
    manifest,
    issues: report.issues,
    issuesCapped: errorCount + warningCount > report.issues.length,
    files,
    controls,
    clean: manifest !== null && errorCount === 0 && controls.every((c) => c.matches),
    errorCount,
    warningCount,
    plan: null,
  };
}

/** SHA-256 of a row's values, in its file's column order. */
async function rowHash(file: DataFile, row: Row): Promise<string> {
  const values = COLUMNS[file].map((c) => row.raw.get(c.name) ?? "");
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode([file, ...values].join("\u0000")),
  );
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function join(...parts: (string | number | undefined)[]): string {
  return parts.some((p) => p === undefined || p === "") ? "" : parts.join("|");
}
