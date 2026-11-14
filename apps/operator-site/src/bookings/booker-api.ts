import type { BookerContactRequest, StaffBookerContactResponse } from "@tidegrid/contracts";
import { call, errorCode, failureOf, type ReadFailure, tenantPath } from "../http.ts";

/**
 * Correct a booking's booker (W3-G2.11-rest): owners and booking staff, on a
 * confirmed booking whose trip has not left. Staff are not limited. Never
 * throws.
 */

export type BookerFailure =
  | ReadFailure
  /** The key went with other details. */
  | "key_reused"
  | "booking_canceled"
  | "trip_departed"
  /** Another correction landed a moment ago: read the booking again. */
  | "booking_changed";

export type CorrectBookerResult =
  | { kind: "saved"; changed: boolean; emailChanged: boolean }
  | { kind: "failed"; reason: BookerFailure };

const bookerPath = (tenantId: string, bookingId: string) =>
  `${tenantPath(tenantId)}/bookings/${encodeURIComponent(bookingId)}/booker`;

/**
 * `key` is the Idempotency-Key: a new one for new details, the same one when
 * the same details are sent again after a failure.
 */
export async function correctBooker(
  tenantId: string,
  bookingId: string,
  input: BookerContactRequest,
  key: string,
): Promise<CorrectBookerResult> {
  try {
    const res = await call(bookerPath(tenantId, bookingId), {
      method: "PUT",
      headers: {
        accept: "application/json",
        "content-type": "application/json",
        "Idempotency-Key": key,
      },
      body: JSON.stringify(input),
    });
    if (res.ok) {
      const data = (await res
        .json()
        .catch(() => null)) as Partial<StaffBookerContactResponse> | null;
      if (data?.change === null) return { kind: "saved", changed: false, emailChanged: false };
      const change = data?.change;
      if (typeof change?.emailChanged !== "boolean" || typeof change.nameChanged !== "boolean") {
        return { kind: "failed", reason: "unreadable" };
      }
      return { kind: "saved", changed: true, emailChanged: change.emailChanged };
    }
    if (res.status === 409) {
      const code = await errorCode(res.clone());
      if (code === "booking_canceled" || code === "trip_departed" || code === "booking_changed") {
        return { kind: "failed", reason: code };
      }
    }
    if (res.status === 422 && (await errorCode(res.clone())) === "idempotency_key_reused") {
      return { kind: "failed", reason: "key_reused" };
    }
    return { kind: "failed", reason: await failureOf(res) };
  } catch {
    return { kind: "failed", reason: "unreachable" };
  }
}
