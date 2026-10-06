import type {
  CatalogResponse,
  ErrorResponse,
  StaffTrip,
  StaffTripListResponse,
  TripResponse,
  TripSalesStateRequest,
} from "@tidegrid/contracts";
import { isKnownZone, isLocalDate, type LocalDate } from "@tidegrid/design-system/format";
import { type ActionFailure, failureFrom, isKnownSalesState } from "./model.ts";

/**
 * The calendar's calls. Same-origin under /api, like every console call: the
 * console Worker forwards them to the API's ConsoleGateway. The API checks the
 * session, the membership, and the role on every call; the console's role
 * check only decides what to show.
 */

const timeoutMs = 15_000;

/** A fetch that gives up after `timeoutMs` or when `signal` aborts. Throws on network failure. */
async function call(path: string, init: RequestInit, signal?: AbortSignal): Promise<Response> {
  const controller = new AbortController();
  const abort = () => controller.abort();
  if (signal?.aborted) controller.abort();
  signal?.addEventListener("abort", abort, { once: true });
  const timer = setTimeout(abort, timeoutMs);
  try {
    return await fetch(path, { ...init, credentials: "same-origin", signal: controller.signal });
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", abort);
  }
}

async function errorCode(res: Response): Promise<string | undefined> {
  const body = (await res.json().catch(() => null)) as Partial<ErrorResponse> | null;
  const code = body?.error?.code;
  return typeof code === "string" ? code : undefined;
}

const tenantPath = (tenantId: string) => `/api/v1/staff/tenants/${encodeURIComponent(tenantId)}`;

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

/**
 * Why a week did not load:
 * - signed_out, forbidden, suspended, not_found: what the API said about the person or operator;
 * - rejected: the API refused the dates (400);
 * - unreadable: trips the console cannot show, such as an unknown state or zone;
 * - unreachable: no answer; unavailable: any other failure.
 */
export type WeekFailure =
  | "signed_out"
  | "forbidden"
  | "suspended"
  | "not_found"
  | "rejected"
  | "unreadable"
  | "unreachable"
  | "unavailable";

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
