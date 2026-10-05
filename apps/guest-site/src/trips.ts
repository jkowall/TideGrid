import { type AvailableTrip, TripAvailabilityResponse } from "@tidegrid/contracts";
import { addDays, isLocalDate, type LocalDate } from "@tidegrid/design-system/format";
import { apiBase } from "./bootstrap.ts";

/** Four weeks a page, today included. One request may span at most 93 days. */
export const windowDays = 28;

/** The party sizes a guest can pick. The API accepts more; the demo offers 1 to 12. */
export const partySizes: readonly number[] = Array.from({ length: 12 }, (_, i) => i + 1);

export const tripsTimeoutMs = 10_000;

export interface TripWindow {
  /** First date the page shows. */
  start: LocalDate;
  /** Last date the page shows, inclusive. */
  end: LocalDate;
  /** First date the request asks for. */
  from: LocalDate;
  /** Last date the request asks for. */
  to: LocalDate;
}

/**
 * The dates a page shows and the dates it asks for. Dates are the marina's
 * calendar, and the page knows only the guest's. A guest whose date is already
 * tomorrow, east of the marina, would miss the rest of the marina's today, so
 * the first page asks for one day more. The API never returns a trip whose
 * sales have closed, so that day adds nothing in the past.
 */
export function windowOf(start: LocalDate, today: LocalDate): TripWindow {
  const end = addDays(start, windowDays - 1);
  return { start, end, from: start <= today ? addDays(start, -1) : start, to: end };
}

export interface TripQuery {
  start: LocalDate;
  party: number;
}

/** Read `?from=` and `?party=` from the address. Anything out of range falls back. */
export function readQuery(search: string, today: LocalDate): TripQuery {
  const params = new URLSearchParams(search);
  const from = params.get("from") ?? "";
  const party = Number(params.get("party"));
  return {
    start: isLocalDate(from) && from > today ? from : today,
    party: partySizes.includes(party) ? party : 1,
  };
}

/** The address query for a page; empty for the first page for one guest. */
export function writeQuery(query: TripQuery, today: LocalDate): string {
  const params = new URLSearchParams();
  if (query.start > today) params.set("from", query.start);
  if (query.party !== 1) params.set("party", String(query.party));
  const text = params.toString();
  return text ? `?${text}` : "";
}

export type TripsResult = { kind: "ok"; trips: AvailableTrip[] } | { kind: "failed" };

/**
 * Ask the API for bookable trips. The browser sends the page's Origin, and the
 * API answers for the operator published there. The response is parsed against
 * the contract. Never throws: every failure, including a timeout, is "failed".
 */
export async function loadTrips(
  request: { from: LocalDate; to: LocalDate; party: number },
  signal?: AbortSignal,
  fetchImpl: typeof fetch = (...args) => fetch(...args),
): Promise<TripsResult> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let stopListening = () => {};
  try {
    const controller = new AbortController();
    if (signal?.aborted) controller.abort();
    else if (signal) {
      const forward = () => controller.abort();
      signal.addEventListener("abort", forward, { once: true });
      stopListening = () => signal.removeEventListener("abort", forward);
    }
    timer = setTimeout(() => controller.abort(), tripsTimeoutMs);
    const params = new URLSearchParams({
      from: request.from,
      to: request.to,
      party: String(request.party),
    });
    const res = await fetchImpl(`${apiBase}/v1/public/trips?${params}`, {
      credentials: "omit",
      headers: { accept: "application/json" },
      signal: controller.signal,
    });
    if (!res.ok) return { kind: "failed" };
    const parsed = TripAvailabilityResponse.safeParse(await res.json());
    return parsed.success ? { kind: "ok", trips: parsed.data.trips } : { kind: "failed" };
  } catch {
    return { kind: "failed" };
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    stopListening();
  }
}

export interface TripDay {
  /** The marina's local date. */
  date: LocalDate;
  trips: AvailableTrip[];
}

/**
 * Group trips by their local date at the marina, never the guest's: a trip
 * leaving at 6:00 PM on Oct 31 in New York is an Oct 31 trip wherever the
 * guest is. Days are in date order; trips in a day keep departure order.
 */
export function groupByDate(trips: readonly AvailableTrip[]): TripDay[] {
  const days = new Map<LocalDate, AvailableTrip[]>();
  for (const trip of trips) {
    const day = days.get(trip.localDate);
    if (day) day.push(trip);
    else days.set(trip.localDate, [trip]);
  }
  return [...days.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([date, list]) => ({
      date,
      trips: list.sort((a, b) => Date.parse(a.startsAt) - Date.parse(b.startsAt)),
    }));
}
