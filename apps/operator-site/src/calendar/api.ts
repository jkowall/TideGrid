import type {
  ErrorResponse,
  StaffTrip,
  StaffTripListResponse,
  TripResponse,
  TripSalesStateRequest,
} from "@tidegrid/contracts";
import type { LocalDate } from "@tidegrid/design-system/format";
import { type ActionFailure, failureFrom } from "./model.ts";

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

export type WeekFailure = "signed_out" | "forbidden" | "not_found" | "unreachable" | "unavailable";

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
      const body = (await res.json()) as StaffTripListResponse;
      if (!Array.isArray(body?.trips)) return { kind: "failed", reason: "unavailable" };
      return { kind: "ok", trips: body.trips };
    }
    if (res.status === 401) return { kind: "failed", reason: "signed_out" };
    if (res.status === 403) return { kind: "failed", reason: "forbidden" };
    if (res.status === 404) return { kind: "failed", reason: "not_found" };
    return { kind: "failed", reason: "unavailable" };
  } catch {
    return { kind: "failed", reason: signal?.aborted ? "unavailable" : "unreachable" };
  }
}

export type ChangeResult =
  | { kind: "ok"; trip: StaffTrip }
  | { kind: "failed"; failure: ActionFailure };

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
      const data = (await res.json()) as TripResponse;
      if (!data?.trip?.tripId) return { kind: "failed", failure: { kind: "unavailable" } };
      return { kind: "ok", trip: data.trip };
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
