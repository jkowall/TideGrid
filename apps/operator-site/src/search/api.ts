import type {
  BookingSearchField,
  BookingSearchResponse,
  BookingSearchResult,
} from "@tidegrid/contracts";
import {
  isBooker,
  isInstant,
  isInt,
  isPaymentStatus,
  isString,
  isTripSummary,
  type Read,
} from "../bookings/api.ts";
import { bookingStates, type ListSource } from "../bookings/model.ts";
import { call, failureOf, tenantPath } from "../http.ts";

/**
 * Booking search (G2.12c). A POST with the terms in its body, so a guest's
 * name or email never enters an address, a log line, or browser history.
 * Never throws.
 */

export interface SearchCriteria {
  q?: string | undefined;
  from?: string | undefined;
  to?: string | undefined;
  /** Only this source's bookings. It narrows a search; it is never asked alone. */
  source?: ListSource | undefined;
}

export interface SearchPage {
  results: BookingSearchResult[];
  total: number;
  nextAfter: string | null;
  matchedOn: BookingSearchField[];
}

const fields = new Set(["reference", "booker_name", "booker_email"]);

function isResult(r: Partial<BookingSearchResult> | null | undefined): boolean {
  return (
    isString(r?.id) &&
    isString(r.reference) &&
    // Any booking state the console can show, so a state added for the
    // booking views (cancellation) reads here too.
    typeof r.state === "string" &&
    Object.hasOwn(bookingStates, r.state) &&
    isInstant(r.confirmedAt) &&
    isTripSummary(r.trip) &&
    isBooker(r.booker, true) &&
    isInt(r.guests) &&
    isInt(r.total) &&
    r.currency === "USD" &&
    isPaymentStatus(r.payment)
  );
}

export async function searchBookings(
  tenantId: string,
  criteria: SearchCriteria,
  options: { after?: string | undefined; limit?: number } = {},
  signal?: AbortSignal,
): Promise<Read<SearchPage>> {
  const body = {
    ...(criteria.q ? { q: criteria.q } : {}),
    ...(criteria.from ? { from: criteria.from } : {}),
    ...(criteria.to ? { to: criteria.to } : {}),
    ...(criteria.source ? { source: criteria.source } : {}),
    ...(options.after ? { after: options.after } : {}),
    limit: options.limit ?? 25,
  };
  try {
    const res = await call(
      `${tenantPath(tenantId)}/booking-searches`,
      {
        method: "POST",
        headers: { accept: "application/json", "content-type": "application/json" },
        body: JSON.stringify(body),
      },
      signal,
    );
    if (!res.ok) return { kind: "failed", reason: await failureOf(res) };
    const data = (await res.json().catch(() => null)) as Partial<BookingSearchResponse> | null;
    // An API that ignores source answers unfiltered. Refuse that rather than show it as filtered.
    const echo = data?.source;
    if (criteria.source ? echo !== criteria.source : echo !== undefined && echo !== null) {
      return { kind: "failed", reason: "unreadable" };
    }
    if (
      !Array.isArray(data?.results) ||
      !data.results.every(isResult) ||
      !isInt(data.total) ||
      (data.nextAfter !== null && !isString(data.nextAfter)) ||
      !Array.isArray(data.matchedOn) ||
      !data.matchedOn.every((f) => fields.has(f))
    ) {
      return { kind: "failed", reason: "unreadable" };
    }
    return {
      kind: "ok",
      value: {
        results: data.results,
        total: data.total,
        nextAfter: data.nextAfter ?? null,
        matchedOn: data.matchedOn,
      },
    };
  } catch {
    return { kind: "failed", reason: signal?.aborted ? "unavailable" : "unreachable" };
  }
}
