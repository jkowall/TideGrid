/**
 * CSV for spreadsheets (G2.12c): RFC 4180 fields and CRLF lines, behind a
 * UTF-8 byte order mark so Excel reads accented names correctly. Pure; runs in
 * Workers and Node.
 *
 * Text that a guest or an operator typed is neutralized: a cell that starts
 * with =, +, -, @, a tab, or a carriage return is prefixed with an apostrophe,
 * so a spreadsheet shows it rather than running it as a formula (CSV
 * injection). Numbers this module writes itself never start with one of those.
 *
 * A booking reference never starts with one of those either, but a
 * spreadsheet reads one that is digits, or digits around one E, as a number.
 * Such a reference is prefixed with an apostrophe too (about 1 in 6,900), and
 * `unguardBookingReference` in the contracts removes it. Any other reference
 * is written as is.
 */
import {
  bookingDayExportColumns,
  bookingDayExportGuestColumns,
  isNumberShapedReference,
  moneyExportColumns,
} from "@tidegrid/contracts";
import type { DayReport, DayReportMoney, DayReportRow } from "./day-report.ts";
import type { MoneyReport } from "./money-report.ts";

const byteOrderMark = "\ufeff";
const lineEnd = "\r\n";

/** One field, quoted when it holds a comma, a quote, or a line break, with quotes doubled. */
export function csvField(value: string): string {
  return /[",\r\n]/.test(value) ? `"${value.replaceAll('"', '""')}"` : value;
}

/** Text from a person, kept from being read as a formula. */
export function csvText(value: string): string {
  return /^[=+\-@\t\r]/.test(value) ? `'${value}` : value;
}

/** A booking reference, kept from being read as a number by a spreadsheet. */
export function csvReference(ref: string): string {
  return isNumberShapedReference(ref) ? `'${ref}` : ref;
}

/**
 * Integer cents as a plain decimal a spreadsheet reads as a number: 12345 is
 * "123.45" and 5 is "0.05". No currency sign and no grouping. Throws on
 * anything but a whole, non-negative amount, which no column here can hold.
 */
export function csvMoney(cents: number): string {
  if (!Number.isSafeInteger(cents) || cents < 0) {
    throw new RangeError(`not whole, non-negative cents: ${String(cents)}`);
  }
  const dollars = Math.trunc(cents / 100);
  return `${dollars}.${String(cents % 100).padStart(2, "0")}`;
}

/**
 * A reference someone typed or a provider issued (a check or receipt number),
 * kept from running as a formula and from being read as a number: a
 * spreadsheet would drop "001234"'s leading zeros or round a long one, so a
 * number-shaped reference starts with an apostrophe, as a booking reference
 * that looks like a number does.
 */
export function csvTypedReference(value: string): string {
  return /^\s*[+-]?(\d[\d,]*\.?\d*|\.\d+)([eE][+-]?\d+)?\s*$/.test(value)
    ? `'${value}`
    : csvText(value);
}

/**
 * Signed integer cents, for the columns that can go down (credit, TideGrid's
 * fee): -1234 is "-12.34". A spreadsheet reads it as a number; it is never
 * text from a person, so the minus sign is not a formula risk.
 */
export function csvSignedMoney(cents: number): string {
  if (!Number.isSafeInteger(cents)) throw new RangeError(`not whole cents: ${String(cents)}`);
  return cents < 0 ? `-${csvMoney(-cents)}` : csvMoney(cents);
}

/** An instant as a spreadsheet reads a UTC date and time: "2026-10-06 18:17:00". */
export function csvInstant(instant: string): string {
  return new Date(instant).toISOString().slice(0, 19).replace("T", " ");
}

/** An instant to the millisecond, for rows that two entries can share a second in. */
export function csvInstantMs(instant: string): string {
  return new Date(instant).toISOString().slice(0, 23).replace("T", " ");
}

/** A whole file: the byte order mark, a header, and the rows, each line ending CRLF. */
export function renderCsv(header: readonly string[], rows: readonly (readonly string[])[]): string {
  const line = (cells: readonly string[]) => cells.map(csvField).join(",");
  return `${byteOrderMark}${[header, ...rows].map(line).join(lineEnd)}${lineEnd}`;
}

/**
 * Gross to Included tax, in the contract's column order. Pending refunds sit
 * after Refunds: requested and not settled, so in neither Refunds nor Net.
 */
const money = (m: DayReportMoney, pendingRefunds: number) => [
  csvMoney(m.gross),
  csvMoney(m.discounts),
  csvMoney(m.fees),
  csvMoney(m.taxes),
  csvMoney(m.total),
  csvMoney(m.refunds),
  csvMoney(pendingRefunds),
  csvMoney(m.net),
  csvMoney(m.includedTax),
];

/** The day's time zone for the total row: the one zone its trips share, or blank. */
function dayZone(rows: readonly DayReportRow[]): string {
  const zones = new Set(rows.map((r) => r.trip.timeZone));
  return zones.size === 1 ? ([...zones][0] ?? "") : "";
}

/**
 * The day's export: a header, one row per booking, and a total row whose
 * figures are the report's control totals. Stable columns
 * (`bookingDayExportColumns`), with the booker's name and email after them
 * only `withBooker`.
 */
export function renderDayExport(
  report: DayReport,
  operator: { name: string },
  options: { withBooker: boolean },
): string {
  const generated = csvInstant(report.generatedAt);
  const header: string[] = [
    ...bookingDayExportColumns,
    ...(options.withBooker ? bookingDayExportGuestColumns : []),
  ];
  const operatorName = csvText(operator.name);
  const bookingRows = report.rows.map((r) => [
    "Booking",
    operatorName,
    r.trip.localDate,
    r.trip.localStartTime,
    csvText(r.trip.timeZone),
    // The exact instant beside the wall clock: two departures at 01:30 on a
    // fall-back night read the same locally and differ here.
    csvInstant(r.trip.startsAt),
    csvText(r.trip.productName),
    csvText(r.trip.boatName),
    csvReference(r.reference),
    r.state,
    r.paymentState,
    r.refundState ?? "",
    String(r.bookings),
    String(r.guests),
    ...money(r, r.pendingRefund.amount),
    "USD",
    csvInstant(r.confirmedAt),
    generated,
    r.source,
    ...(options.withBooker ? [csvText(r.booker?.name ?? ""), csvText(r.booker?.email ?? "")] : []),
  ]);
  const t = report.totals;
  const totalRow = [
    "Total",
    operatorName,
    report.date,
    "",
    csvText(dayZone(report.rows)),
    "",
    "",
    "",
    "",
    "",
    "",
    "",
    String(t.bookings),
    String(t.guests),
    ...money(t, t.pendingRefunds.amount),
    "USD",
    "",
    generated,
    "",
    ...(options.withBooker ? ["", ""] : []),
  ];
  return renderCsv(header, [...bookingRows, totalRow]);
}

/** The export's file name: the operator's slug and the date, never a person's details. */
export function dayExportFileName(slug: string, date: string): string {
  return `${slug}-bookings-${date}.csv`;
}

/**
 * The money export (W3-G2.12-rest): a header, one row per ledger entry, and a
 * total row whose figures are the report's totals. Stable columns
 * (`moneyExportColumns`). No guest's name or email; a check or receipt
 * number staff typed (present only for roles that see guests) is kept from
 * running as a formula.
 */
export function renderMoneyExport(report: MoneyReport, operator: { name: string }): string {
  const generated = csvInstant(report.generatedAt);
  const operatorName = csvText(operator.name);
  const zone = csvText(report.timeZone);
  const entryRows = report.entries.map((e) => [
    "Entry",
    operatorName,
    report.from,
    report.to,
    zone,
    e.businessDate,
    csvInstantMs(e.at),
    e.kind,
    e.booking ? csvReference(e.booking.reference) : "",
    e.booking?.source ?? "",
    e.tender ?? "",
    csvTypedReference(e.reference ?? ""),
    csvMoney(e.moneyIn),
    csvMoney(e.moneyOut),
    csvSignedMoney(e.credit),
    csvSignedMoney(e.fee),
    "USD",
    generated,
    "1",
  ]);
  const t = report.totals;
  const totalRow = [
    "Total",
    operatorName,
    report.from,
    report.to,
    zone,
    "",
    "",
    "",
    "",
    "",
    "",
    "",
    csvMoney(t.moneyIn),
    csvMoney(t.moneyOut),
    csvSignedMoney(t.credit),
    csvSignedMoney(t.fee),
    "USD",
    generated,
    String(t.entries),
  ];
  return renderCsv(moneyExportColumns, [...entryRows, totalRow]);
}

/** The money export's file name: the operator's slug and the range only. */
export function moneyExportFileName(slug: string, from: string, to: string): string {
  return `${slug}-money-${from}-to-${to}.csv`;
}

export type { DayReportRow };
