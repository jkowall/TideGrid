import type {
  BookingWaivers,
  BookingWaiversResponse,
  ParticipantWaiver,
  TripWaiversResponse,
} from "@tidegrid/contracts";
import { call, errorCode, failureOf, type ReadFailure, tenantPath } from "../http.ts";

/**
 * The console's waiver calls (G2.15). Reads never throw: each answers with
 * what it read or why it could not. The console does not run the contract's
 * schemas, so each answer is checked for what the panel uses.
 */

export type Read<T> = { kind: "ok"; value: T } | { kind: "failed"; reason: ReadFailure };

const statusCodes = new Set([
  "signed",
  "waiting",
  "email_failed",
  "no_address",
  "not_assigned",
  "not_required",
  "not_needed",
]);

const isString = (v: unknown): v is string => typeof v === "string";
const isInstant = (v: unknown) => isString(v) && !Number.isNaN(Date.parse(v));

function isParticipantWaiver(p: Partial<ParticipantWaiver> | null | undefined): boolean {
  if (!p || !isString(p.participantId) || !isString(p.name) || !Number.isSafeInteger(p.position)) {
    return false;
  }
  if (!statusCodes.has(p.status as string)) return false;
  const r = p.request;
  if (r === null) return true;
  return (
    !!r &&
    isString(r.id) &&
    isString(r.templateName) &&
    Number.isSafeInteger(r.version) &&
    (r.signed === null || (isString(r.signed?.evidenceId) && isInstant(r.signed?.signedAt))) &&
    (r.delivery === null || (isString(r.delivery?.recipient) && isInstant(r.delivery?.queuedAt))) &&
    (r.resendAvailableAt === null || isInstant(r.resendAvailableAt))
  );
}

function isBookingWaivers(b: Partial<BookingWaivers> | null | undefined): b is BookingWaivers {
  return (
    !!b &&
    isString(b.bookingId) &&
    isString(b.reference) &&
    typeof b.required === "boolean" &&
    Number.isSafeInteger(b.unnamedPlaces) &&
    Array.isArray(b.participants) &&
    b.participants.every(isParticipantWaiver)
  );
}

async function read<T>(
  path: string,
  pick: (body: unknown) => T | null,
  signal?: AbortSignal,
): Promise<Read<T>> {
  try {
    const res = await call(path, { headers: { accept: "application/json" } }, signal);
    if (!res.ok) return { kind: "failed", reason: await failureOf(res) };
    const value = pick(await res.json().catch(() => null));
    return value === null ? { kind: "failed", reason: "unreadable" } : { kind: "ok", value };
  } catch {
    return { kind: "failed", reason: signal?.aborted ? "unavailable" : "unreachable" };
  }
}

export function loadBookingWaivers(
  tenantId: string,
  bookingId: string,
  signal?: AbortSignal,
): Promise<Read<BookingWaivers>> {
  return read(
    `${tenantPath(tenantId)}/bookings/${encodeURIComponent(bookingId)}/waivers`,
    (body) => {
      const waivers = (body as Partial<BookingWaiversResponse> | null)?.waivers;
      return isBookingWaivers(waivers) ? waivers : null;
    },
    signal,
  );
}

export function loadTripWaivers(
  tenantId: string,
  tripId: string,
  signal?: AbortSignal,
): Promise<Read<TripWaiversResponse>> {
  return read(
    `${tenantPath(tenantId)}/trips/${encodeURIComponent(tripId)}/waivers`,
    (body) => {
      const trip = body as Partial<TripWaiversResponse> | null;
      return trip &&
        Array.isArray(trip.bookings) &&
        trip.bookings.every(isBookingWaivers) &&
        trip.totals
        ? (trip as TripWaiversResponse)
        : null;
    },
    signal,
  );
}

/** Where a signed waiver's PDF downloads from: same-origin, with the console's own session. */
export function documentHref(tenantId: string, evidenceId: string): string {
  return `${tenantPath(tenantId)}/waiver-evidence/${encodeURIComponent(evidenceId)}/document`;
}

export type ResendResult =
  | { kind: "sent"; generation: number }
  | {
      kind: "failed";
      /** too_soon, limit, no_address, not_pending, trip_over, forbidden, signed_out, unreachable, unavailable */
      reason: string;
    };

/**
 * Send a participant's waiver request again, with the reason the audit
 * history records. `key` is the Idempotency-Key: a new one for each new
 * resend, the same one when the same resend is sent again after a failure.
 * Never throws.
 */
export async function resendWaiver(
  tenantId: string,
  requestId: string,
  reason: string,
  key: string,
): Promise<ResendResult> {
  try {
    const res = await call(
      `${tenantPath(tenantId)}/waiver-requests/${encodeURIComponent(requestId)}/resend`,
      {
        method: "POST",
        headers: {
          accept: "application/json",
          "content-type": "application/json",
          "Idempotency-Key": key,
        },
        body: JSON.stringify({ reason }),
      },
    );
    if (res.ok) {
      const body = (await res.json().catch(() => null)) as {
        delivery?: { generation?: unknown };
      } | null;
      const generation = body?.delivery?.generation;
      return Number.isSafeInteger(generation)
        ? { kind: "sent", generation: generation as number }
        : { kind: "failed", reason: "unavailable" };
    }
    const code = await errorCode(res);
    const known: Record<string, string> = {
      waiver_resend_too_soon: "too_soon",
      waiver_resend_limit: "limit",
      waiver_no_address: "no_address",
      waiver_not_pending: "not_pending",
      waiver_trip_over: "trip_over",
    };
    if (code && known[code]) return { kind: "failed", reason: known[code] as string };
    if (res.status === 401) return { kind: "failed", reason: "signed_out" };
    if (res.status === 403) return { kind: "failed", reason: "forbidden" };
    return { kind: "failed", reason: "unavailable" };
  } catch {
    return { kind: "failed", reason: "unreachable" };
  }
}

/** A new idempotency key: a UUID, which the API's key pattern accepts. */
export function newResendKey(): string {
  if (typeof crypto.randomUUID === "function") return crypto.randomUUID();
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
}
