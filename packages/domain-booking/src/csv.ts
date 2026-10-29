/**
 * CSV for spreadsheets (G2.12c): RFC 4180 fields and CRLF lines, behind a
 * UTF-8 byte order mark so Excel reads accented names correctly. Pure; runs in
 * Workers and Node.
 *
 * Text that a guest or an operator typed is neutralized: a cell that starts
 * with =, +, -, @, a tab, or a carriage return is prefixed with an apostrophe,
 * so a spreadsheet shows it rather than running it as a formula (CSV
 * injection). Numbers this module writes itself never start with one of those.
 */
import { bookingDayExportColumns, bookingDayExportGuestColumns } from "@tidegrid/contracts";
import type { DayReport, DayReportMoney, DayReportRow } from "./day-report.ts";

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

/** An instant as a spreadsheet reads a UTC date and time: "2026-10-06 18:17:00". */
export function csvInstant(instant: string): string {
  return new Date(instant).toISOString().slice(0, 19).replace("T", " ");
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
    r.reference,
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

export type { DayReportRow };
