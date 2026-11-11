/**
 * The standard CSV import's files, columns, and types (W3-G2.13), as the
 * draft in docs/v2/drafts/standard-csv-import.md proposes them. Pure.
 *
 * Every value is checked against its column's type here; the rules that join
 * rows and files are in validate.ts.
 */
import { isKnownZone } from "./zone-time.ts";

export const MAPPING_VERSION = "std-csv-v0";

export const IMPORT_FILES = [
  "manifest.csv",
  "products.csv",
  "trips.csv",
  "customers.csv",
  "bookings.csv",
  "participants.csv",
  "payments.csv",
  "opening_balances.csv",
  "waivers.csv",
] as const;
export type ImportFile = (typeof IMPORT_FILES)[number];
export type DataFile = Exclude<ImportFile, "manifest.csv">;

export const IMPORT_ISSUE_CODES = [
  "file_unreadable",
  "missing_file",
  "missing_column",
  "unknown_column",
  "repeated_column",
  "batch_mode_not_supported",
  "later_than_export",
  "missing_required",
  "invalid_type",
  "invalid_enum",
  "staff_channel_required",
  "staff_channel_not_allowed",
  "out_of_range",
  "duplicate_key_in_batch",
  "unknown_reference",
  "parent_rejected",
  "product_not_found",
  "product_name_mismatch",
  "product_kind_mismatch",
  "boat_not_linked",
  "zone_mismatch",
  "nonexistent_local_time",
  "ambiguous_local_time",
  "trip_in_past",
  "trip_departed",
  "boat_overlap",
  "trip_date_mismatch",
  "over_capacity",
  "charter_already_booked",
  "amounts_do_not_add_up",
  "ota_amounts_present",
  "payment_on_ota_booking",
  "overpaid",
  "refund_exceeds_payments",
  "unexpected_balance",
  "balance_due_date_missing",
  "position_out_of_range",
  "guardian_required",
  "guardian_not_allowed",
  "module_disabled",
  "balance_expired",
  "possible_card_number",
  "customer_match_candidate",
  "participant_email_missing",
  "control_total_mismatch",
] as const;
export type ImportIssueCode = (typeof IMPORT_ISSUE_CODES)[number];

export interface ImportIssue {
  file: ImportFile;
  /** The record number, the header being 1; null for a file-level issue. */
  line: number | null;
  recordKey: string | null;
  column: string | null;
  code: ImportIssueCode;
  severity: "error" | "warning";
  /** Plain, safe to show; never quotes a personal value or one that failed its type. */
  message: string;
  /** The offending value for non-personal columns; "[withheld]" for personal ones. */
  value: string | null;
}

export type ColumnType =
  | { t: "text"; max: number }
  | { t: "id" }
  | { t: "uuid" }
  | { t: "int"; min: number; max: number }
  | { t: "cents"; min: number }
  | { t: "date" }
  | { t: "time" }
  | { t: "timestamp" }
  | { t: "offset" }
  | { t: "zone" }
  | { t: "bool" }
  | { t: "email" }
  | { t: "phone" }
  | { t: "enum"; values: readonly string[] };

export interface ColumnSpec {
  name: string;
  type: ColumnType;
  /** Required on every row; a conditional requirement is a rule in validate.ts. */
  required: boolean;
  /** Names, emails, phones, and references: shown as "[withheld]". */
  personal?: boolean;
}

const text = (max: number): ColumnType => ({ t: "text", max });
const id: ColumnType = { t: "id" };
const cents0: ColumnType = { t: "cents", min: 0 };
const cents1: ColumnType = { t: "cents", min: 1 };
const en = (...values: string[]): ColumnType => ({ t: "enum", values });

export const COLUMNS: Record<DataFile, readonly ColumnSpec[]> = {
  "products.csv": [
    { name: "source_product_id", type: id, required: true },
    { name: "source_product_name", type: text(120), required: true },
    { name: "tidegrid_product_id", type: { t: "uuid" }, required: true },
    { name: "tidegrid_product_name", type: text(120), required: true },
    { name: "product_kind", type: en("shared_seat", "private_charter"), required: true },
  ],
  "trips.csv": [
    { name: "source_trip_id", type: id, required: true },
    { name: "source_product_id", type: id, required: true },
    { name: "tidegrid_boat_id", type: { t: "uuid" }, required: true },
    { name: "local_date", type: { t: "date" }, required: true },
    { name: "local_start_time", type: { t: "time" }, required: true },
    { name: "time_zone", type: { t: "zone" }, required: true },
    { name: "utc_offset", type: { t: "offset" }, required: false },
    { name: "seat_capacity", type: { t: "int", min: 1, max: 500 }, required: false },
  ],
  "customers.csv": [
    { name: "source_customer_id", type: id, required: true },
    { name: "full_name", type: text(120), required: true, personal: true },
    { name: "email", type: { t: "email" }, required: false, personal: true },
    { name: "phone", type: { t: "phone" }, required: false, personal: true },
  ],
  "bookings.csv": [
    { name: "source_booking_ref", type: id, required: true },
    { name: "trip_date", type: { t: "date" }, required: true },
    { name: "source_trip_id", type: id, required: true },
    { name: "source_customer_id", type: id, required: true },
    { name: "booking_source", type: en("direct", "staff_assisted", "ota"), required: true },
    { name: "staff_channel", type: en("phone", "email", "walk_up"), required: false },
    { name: "ota_channel", type: text(80), required: false },
    { name: "party_size", type: { t: "int", min: 1, max: 500 }, required: true },
    { name: "subtotal_cents", type: cents0, required: false },
    { name: "discount_cents", type: cents0, required: false },
    { name: "fee_cents", type: cents0, required: false },
    { name: "tax_cents", type: cents0, required: false },
    { name: "included_tax_cents", type: cents0, required: false },
    { name: "total_cents", type: cents0, required: false },
    { name: "balance_due_date", type: { t: "date" }, required: false },
    { name: "booked_at", type: { t: "timestamp" }, required: false },
  ],
  "participants.csv": [
    { name: "source_booking_ref", type: id, required: true },
    { name: "trip_date", type: { t: "date" }, required: true },
    { name: "position", type: { t: "int", min: 1, max: 500 }, required: true },
    { name: "full_name", type: text(120), required: true, personal: true },
    { name: "is_minor", type: { t: "bool" }, required: true },
    { name: "email", type: { t: "email" }, required: false, personal: true },
    { name: "guardian_name", type: text(120), required: false, personal: true },
    { name: "guardian_email", type: { t: "email" }, required: false, personal: true },
  ],
  "payments.csv": [
    { name: "source_payment_id", type: id, required: true },
    { name: "source_booking_ref", type: id, required: true },
    { name: "trip_date", type: { t: "date" }, required: true },
    { name: "entry_kind", type: en("payment", "refund"), required: true },
    { name: "amount_cents", type: cents1, required: true },
    {
      name: "tender",
      type: en("cash", "check", "card_outside_tidegrid", "bank_transfer", "other"),
      required: true,
    },
    { name: "reference", type: text(64), required: false, personal: true },
    { name: "received_at", type: { t: "timestamp" }, required: true },
  ],
  "opening_balances.csv": [
    { name: "source_balance_id", type: id, required: true },
    { name: "source_customer_id", type: id, required: true },
    {
      name: "balance_kind",
      type: en("booking_credit", "dollar_card", "trip_count_card"),
      required: true,
    },
    {
      name: "lot_kind",
      type: en("purchased", "cancellation_credit", "promotional"),
      required: false,
    },
    { name: "amount_cents", type: cents1, required: false },
    { name: "units", type: { t: "int", min: 1, max: 100 }, required: false },
    { name: "eligible_source_product_ids", type: text(2000), required: false },
    { name: "expires_on", type: { t: "date" }, required: false },
    { name: "source_card_ref", type: id, required: false, personal: true },
  ],
  "waivers.csv": [
    { name: "source_booking_ref", type: id, required: true },
    { name: "trip_date", type: { t: "date" }, required: true },
    { name: "position", type: { t: "int", min: 1, max: 500 }, required: true },
    { name: "legacy_status", type: en("signed", "unsigned", "unknown"), required: true },
    { name: "legacy_signed_on", type: { t: "date" }, required: false },
    { name: "legacy_system", type: text(80), required: false },
  ],
};

/** The control-total metrics each file must declare in the manifest. */
export const CONTROL_METRICS: Record<DataFile, readonly string[]> = {
  "products.csv": ["row_count"],
  "trips.csv": ["row_count", "sum_seat_capacity"],
  "customers.csv": ["row_count", "rows_with_email"],
  "bookings.csv": [
    "row_count",
    "sum_party_size",
    "rows_direct",
    "rows_staff_assisted",
    "rows_ota",
    "sum_total_cents",
    "sum_included_tax_cents",
  ],
  "participants.csv": ["row_count", "rows_minor"],
  "payments.csv": ["row_count", "sum_payment_cents", "sum_refund_cents", "sum_outstanding_cents"],
  "opening_balances.csv": [
    "row_count",
    "sum_booking_credit_cents",
    "sum_dollar_card_cents",
    "sum_trip_count_units",
  ],
  "waivers.csv": ["row_count", "rows_signed", "rows_unsigned", "rows_unknown"],
};

export type Value = string | number | boolean;

export type ParsedValue =
  | { ok: true; value: Value }
  | { ok: false; code: "invalid_type" | "invalid_enum" | "out_of_range" };

const ID = /^[A-Za-z0-9._-]{1,64}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const INT = /^-?\d{1,9}$/;
const DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
const TIME = /^([01]\d|2[0-3]):([0-5]\d)$/;
const TIMESTAMP =
  /^(\d{4})-(\d{2})-(\d{2})T([01]\d|2[0-3]):([0-5]\d):([0-5]\d)(\.\d{1,3})?(Z|[+-](?:[01]\d|2[0-3]):[0-5]\d)$/;
const OFFSET = /^[+-](?:[01]\d|2[0-3]):[0-5]\d$/;
const EMAIL =
  /^[^\s@,;<>"]{1,64}@[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)+$/;
const PHONE = /^\+[1-9]\d{6,14}$/;
const MAX_CENTS = 100_000_000;
// C0 and C1 controls, and the bidirectional overrides that can disguise text.
// biome-ignore lint/suspicious/noControlCharactersInRegex: the pattern exists to find them.
const CONTROL = /[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/;

/** True when the text holds a control character, which no import value may. */
export function hasControl(value: string): boolean {
  return CONTROL.test(value);
}

export function isValidDate(value: string): boolean {
  const m = DATE.exec(value);
  if (!m) return false;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const probe = new Date(Date.UTC(y, mo - 1, d));
  return (
    y >= 2000 &&
    y <= 2099 &&
    probe.getUTCFullYear() === y &&
    probe.getUTCMonth() === mo - 1 &&
    probe.getUTCDate() === d
  );
}

/** Epoch milliseconds of a timestamp with its own offset; NaN when it is not one. */
export function timestampMs(value: string): number {
  const m = TIMESTAMP.exec(value);
  if (!m || !isValidDate(`${m[1]}-${m[2]}-${m[3]}`)) return Number.NaN;
  return Date.parse(value);
}

/** Minutes east of UTC for "+HH:MM" or "-HH:MM". */
export function offsetMinutes(value: string): number {
  const sign = value.startsWith("-") ? -1 : 1;
  const [h, m] = value.slice(1).split(":").map(Number) as [number, number];
  return sign * (h * 60 + m);
}

/** Parses one trimmed, non-empty value against its column type. */
export function parseValue(raw: string, type: ColumnType): ParsedValue {
  switch (type.t) {
    case "text":
      return raw.length <= type.max
        ? { ok: true, value: raw }
        : { ok: false, code: "out_of_range" };
    case "id":
      return ID.test(raw) ? { ok: true, value: raw } : { ok: false, code: "invalid_type" };
    case "uuid":
      return UUID.test(raw)
        ? { ok: true, value: raw.toLowerCase() }
        : { ok: false, code: "invalid_type" };
    case "int": {
      if (!INT.test(raw)) return { ok: false, code: "invalid_type" };
      const n = Number(raw);
      return n >= type.min && n <= type.max
        ? { ok: true, value: n }
        : { ok: false, code: "out_of_range" };
    }
    case "cents": {
      if (!/^\d{1,9}$/.test(raw)) return { ok: false, code: "invalid_type" };
      const n = Number(raw);
      return n >= type.min && n <= MAX_CENTS
        ? { ok: true, value: n }
        : { ok: false, code: "out_of_range" };
    }
    case "date":
      return isValidDate(raw) ? { ok: true, value: raw } : { ok: false, code: "invalid_type" };
    case "time":
      return TIME.test(raw) ? { ok: true, value: raw } : { ok: false, code: "invalid_type" };
    case "timestamp":
      return Number.isNaN(timestampMs(raw))
        ? { ok: false, code: "invalid_type" }
        : { ok: true, value: raw };
    case "offset":
      return OFFSET.test(raw) ? { ok: true, value: raw } : { ok: false, code: "invalid_type" };
    case "zone":
      return isKnownZone(raw) ? { ok: true, value: raw } : { ok: false, code: "invalid_type" };
    case "bool":
      return raw === "true" || raw === "false"
        ? { ok: true, value: raw === "true" }
        : { ok: false, code: "invalid_enum" };
    case "email":
      return raw.length <= 254 && EMAIL.test(raw)
        ? { ok: true, value: raw.toLowerCase() }
        : { ok: false, code: "invalid_type" };
    case "phone":
      return PHONE.test(raw) ? { ok: true, value: raw } : { ok: false, code: "invalid_type" };
    case "enum":
      return type.values.includes(raw)
        ? { ok: true, value: raw }
        : { ok: false, code: "invalid_enum" };
  }
}

/**
 * 13 to 19 digits, with or without spaces or hyphens, that pass the Luhn
 * check: possibly a card number, which the import never stores.
 */
export function looksLikeCardNumber(value: string): boolean {
  if (!/^[\d -]+$/.test(value)) return false;
  const digits = value.replace(/[ -]/g, "");
  if (digits.length < 13 || digits.length > 19) return false;
  let sum = 0;
  for (let i = 0; i < digits.length; i += 1) {
    let d = Number(digits[digits.length - 1 - i]);
    if (i % 2 === 1) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
  }
  return sum % 10 === 0;
}
