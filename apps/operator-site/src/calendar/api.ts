import type {
  CatalogResponse,
  StaffTrip,
  StaffTripListResponse,
  TripResponse,
  TripSalesStateRequest,
} from "@tidegrid/contracts";
import { isKnownZone, isLocalDate, type LocalDate } from "@tidegrid/design-system/format";
import { call, errorCode, type ReadFailure, tenantPath } from "../http.ts";
import { type ActionFailure, failureFrom, isKnownSalesState } from "./model.ts";

/**
 * The calendar's calls, through the console's shared fetch (../http.ts):
 * same-origin under /api, with a timeout.
 */

/**
 * Whether a trip has what the calendar shows, in a form it can show: a known
 * sales state, a time zone this browser knows, and readable dates and times.
 * The console does not run the contract's schemas, so it checks what it uses.
 */
export function isShowableTrip(value: unknown): value is StaffTrip {
  const t = value as Partial<StaffTrip> | null;
  return (
    typeof t?.tripId === "string" &&
    typeof t.productName === "string" &&
    typeof t.boatName === "string" &&
    isKnownSalesState(t.salesState) &&
    typeof t.timeZone === "string" &&
    isKnownZone(t.timeZone) &&
    typeof t.localDate === "string" &&
    isLocalDate(t.localDate) &&
    typeof t.localStartTime === "string" &&
    /^([01]\d|2[0-3]):[0-5]\d$/.test(t.localStartTime) &&
    typeof t.endsAtLocal === "string" &&
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(t.endsAtLocal) &&
    !Number.isNaN(Date.parse(t.startsAt ?? "")) &&
    !Number.isNaN(Date.parse(t.salesCloseAt ?? "")) &&
    typeof t.blackedOut === "boolean" &&
    (t.capacity?.kind === "seats" || t.capacity?.kind === "whole_boat") &&
    Number.isInteger(t.capacity.total) &&
    Number.isInteger(t.capacity.remaining)
  );
}

/** Why a week did not load; see ReadFailure. `rejected`: the API refused the dates. */
export type WeekFailure = ReadFailure;

export type WeekResult =
  | { kind: "ok"; trips: StaffTrip[] }
  | { kind: "failed"; reason: WeekFailure };

/** Every trip in a local date range, in any sales state. Never throws. */
export async function loadWeek(
  tenantId: string,
  range: { from: LocalDate; to: LocalDate },
  signal?: AbortSignal,
): Promise<WeekResult> {
  try {
    const params = new URLSearchParams({ from: range.from, to: range.to });
    const res = await call(
      `${tenantPath(tenantId)}/trips?${params}`,
      { headers: { accept: "application/json" } },
      signal,
    );
    if (res.ok) {
      const body = (await res.json().catch(() => null)) as StaffTripListResponse | null;
      if (!Array.isArray(body?.trips)) return { kind: "failed", reason: "unreadable" };
      if (!body.trips.every(isShowableTrip)) return { kind: "failed", reason: "unreadable" };
      return { kind: "ok", trips: body.trips };
    }
    if (res.status === 401) return { kind: "failed", reason: "signed_out" };
    if (res.status === 403) {
      const code = await errorCode(res);
      return { kind: "failed", reason: code === "tenant_suspended" ? "suspended" : "forbidden" };
    }
    if (res.status === 404) return { kind: "failed", reason: "not_found" };
    if (res.status === 400) return { kind: "failed", reason: "rejected" };
    return { kind: "failed", reason: "unavailable" };
  } catch {
    return { kind: "failed", reason: signal?.aborted ? "unavailable" : "unreachable" };
  }
}

/**
 * The marina's time zone, from the operator's catalog: its first active
 * location's zone. The calendar uses it to know what "this week" and "today"
 * are at the marina before any trip arrives. Undefined when it cannot be read;
 * the calendar then falls back to the viewer's own calendar. Never throws.
 */
export async function loadZone(
  tenantId: string,
  signal?: AbortSignal,
): Promise<string | undefined> {
  try {
    const res = await call(
      `${tenantPath(tenantId)}/catalog`,
      { headers: { accept: "application/json" } },
      signal,
    );
    if (!res.ok) return undefined;
    const body = (await res.json().catch(() => null)) as Partial<CatalogResponse> | null;
    const locations = Array.isArray(body?.locations) ? body.locations : [];
    const zone = (locations.find((l) => l?.status === "active") ?? locations[0])?.timeZone;
    return typeof zone === "string" && isKnownZone(zone) ? zone : undefined;
  } catch {
    return undefined;
  }
}

export type ChangeResult =
  /** `replayed`: the API answered from its record of an earlier, identical request. */
  { kind: "ok"; trip: StaffTrip; replayed: boolean } | { kind: "failed"; failure: ActionFailure };

/**
 * Publish, close, reopen, cancel, or complete a trip. `key` is the
 * Idempotency-Key: a new one for each new change, the same one when the same
 * change is sent again after a failure, so the API applies it once. Never throws.
 */
export async function changeSalesState(
  tenantId: string,
  tripId: string,
  body: TripSalesStateRequest,
  key: string,
): Promise<ChangeResult> {
  try {
    const res = await call(
      `${tenantPath(tenantId)}/trips/${encodeURIComponent(tripId)}/sales-state`,
      {
        method: "POST",
        headers: {
          accept: "application/json",
          "content-type": "application/json",
          "Idempotency-Key": key,
        },
        body: JSON.stringify(body),
      },
    );
    if (res.ok) {
      const data = (await res.json().catch(() => null)) as TripResponse | null;
      const trip: unknown = data?.trip;
      if (!isShowableTrip(trip)) return { kind: "failed", failure: { kind: "unavailable" } };
      return { kind: "ok", trip, replayed: res.headers.get("Idempotent-Replayed") === "true" };
    }
    return { kind: "failed", failure: failureFrom(res.status, await errorCode(res)) };
  } catch {
    return { kind: "failed", failure: { kind: "unreachable" } };
  }
}

/** A new idempotency key: a UUID, which the API's key pattern accepts. */
export function newIdempotencyKey(): string {
  if (typeof crypto.randomUUID === "function") return crypto.randomUUID();
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
}
