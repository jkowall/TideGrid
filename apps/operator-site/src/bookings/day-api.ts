import type { BookingDayTotals, BookingDayTotalsResponse } from "@tidegrid/contracts";
import type { LocalDate } from "@tidegrid/design-system/format";
import { call, failureOf, type ReadFailure, tenantPath } from "../http.ts";
import { isInstant, isInt, type Read } from "./api.ts";

/**
 * A day's control totals and its CSV export (G2.12c). Both read the same
 * ledger on the server: each booking's order and its payment's refunds, for
 * the trips departing on one local date. Neither call throws.
 */

export interface DayTotals {
  generatedAt: string;
  totals: BookingDayTotals;
}

const totalKeys = [
  "bookings",
  "guests",
  "gross",
  "discounts",
  "fees",
  "taxes",
  "total",
  "refunds",
  "net",
  "includedTax",
] as const;

function isTotals(t: Partial<BookingDayTotals> | null | undefined): t is BookingDayTotals {
  return (
    !!t &&
    totalKeys.every((key) => isInt(t[key]) && (t[key] as number) >= 0) &&
    isInt(t.pendingRefunds?.count) &&
    isInt(t.pendingRefunds?.amount)
  );
}

export async function loadDayTotals(
  tenantId: string,
  date: LocalDate,
  signal?: AbortSignal,
): Promise<Read<DayTotals>> {
  try {
    const res = await call(
      `${tenantPath(tenantId)}/booking-day-totals?${new URLSearchParams({ date })}`,
      { headers: { accept: "application/json" } },
      signal,
    );
    if (!res.ok) return { kind: "failed", reason: await failureOf(res) };
    const body = (await res.json().catch(() => null)) as Partial<BookingDayTotalsResponse> | null;
    if (body?.date !== date || !isInstant(body.generatedAt) || !isTotals(body.totals)) {
      return { kind: "failed", reason: "unreadable" };
    }
    return { kind: "ok", value: { generatedAt: body.generatedAt as string, totals: body.totals } };
  } catch {
    return { kind: "failed", reason: signal?.aborted ? "unavailable" : "unreachable" };
  }
}

/**
 * The file name the server gave the export, from Content-Disposition, or a
 * plain fallback. Only a simple, safe name is accepted.
 */
export function exportFileName(disposition: string | null, date: LocalDate): string {
  const named = /filename="([A-Za-z0-9._-]{1,120})"/.exec(disposition ?? "")?.[1];
  return named?.endsWith(".csv") ? named : `bookings-${date}.csv`;
}

export type ExportResult =
  | { kind: "saved"; fileName: string }
  | { kind: "failed"; reason: ReadFailure };

/**
 * Hand the browser a file to save: an object URL behind a link with
 * `download`, clicked once and let go. Kept apart so a test can replace it.
 */
export function saveFile(blob: Blob, fileName: string): void {
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = fileName;
  link.hidden = true;
  document.body.append(link);
  link.click();
  link.remove();
  // Give the browser a moment to start the download before the URL goes.
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

/**
 * Fetch the day's CSV and save it. Same-origin with the session, so the file
 * never travels through a link anyone could open; the address carries the
 * operator's id and the date only.
 */
export async function exportDay(
  tenantId: string,
  date: LocalDate,
  save: (blob: Blob, fileName: string) => void = saveFile,
): Promise<ExportResult> {
  try {
    const res = await call(
      `${tenantPath(tenantId)}/booking-day-export?${new URLSearchParams({ date })}`,
      { headers: { accept: "text/csv" } },
    );
    if (!res.ok) return { kind: "failed", reason: await failureOf(res) };
    if (!(res.headers.get("content-type") ?? "").startsWith("text/csv")) {
      return { kind: "failed", reason: "unreadable" };
    }
    const fileName = exportFileName(res.headers.get("content-disposition"), date);
    save(await res.blob(), fileName);
    return { kind: "saved", fileName };
  } catch {
    return { kind: "failed", reason: "unreachable" };
  }
}
