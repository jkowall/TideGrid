import type {
  BookingEmailResendAvailability,
  BookingEmailResendKind,
  BookingEmailResendReason,
  BookingMessagesResponse,
  MessageStatus,
} from "@tidegrid/contracts";
import { call, errorCode, failureOf, type ReadFailure, tenantPath } from "../http.ts";

/**
 * The console's calls for a booking's email (G2.16b). Reads never throw: each
 * answers with what it read or why it could not. The console does not run the
 * contract's schemas, so each answer is checked for what the card uses.
 */

export type Read<T> = { kind: "ok"; value: T } | { kind: "failed"; reason: ReadFailure };

const states = new Set(["queued", "sending", "sent", "failed", "canceled"]);
const kinds = new Set(["confirmation", "cancellation"]);
const blocks = new Set([
  "email_off",
  "kind_mismatch",
  "trip_over",
  "refund_failed",
  "limit",
  "too_soon",
  "rate_limited",
  "in_progress",
]);

const isString = (v: unknown): v is string => typeof v === "string";
const isInstant = (v: unknown) => isString(v) && !Number.isNaN(Date.parse(v));
const isInstantOrNull = (v: unknown) => v === null || isInstant(v);

function isMessage(m: Partial<MessageStatus> | null | undefined): boolean {
  return (
    !!m &&
    isString(m.id) &&
    isString(m.template) &&
    states.has(m.state as string) &&
    Number.isSafeInteger(m.attempts) &&
    (m.failureCode === null || isString(m.failureCode)) &&
    typeof m.staffResend === "boolean" &&
    isInstant(m.createdAt) &&
    isInstantOrNull(m.sentAt) &&
    isInstantOrNull(m.failedAt) &&
    isInstantOrNull(m.canceledAt) &&
    isInstantOrNull(m.nextAttemptAt)
  );
}

function isAvailability(r: Partial<BookingEmailResendAvailability> | null | undefined): boolean {
  return (
    !!r &&
    (r.kind === null || kinds.has(r.kind as string)) &&
    typeof r.allowed === "boolean" &&
    isInstantOrNull(r.availableAt) &&
    Number.isSafeInteger(r.remaining) &&
    (r.blockedBy === null || blocks.has(r.blockedBy as string))
  );
}

export function loadBookingEmail(
  tenantId: string,
  bookingId: string,
  signal?: AbortSignal,
): Promise<Read<BookingMessagesResponse>> {
  return (async () => {
    try {
      const res = await call(
        `${tenantPath(tenantId)}/bookings/${encodeURIComponent(bookingId)}/messages`,
        { headers: { accept: "application/json" } },
        signal,
      );
      if (!res.ok) return { kind: "failed", reason: await failureOf(res) };
      const body = (await res.json().catch(() => null)) as Partial<BookingMessagesResponse> | null;
      const ok =
        !!body &&
        Array.isArray(body.messages) &&
        body.messages.every(isMessage) &&
        (body.emailDelivery === "on" || body.emailDelivery === "off") &&
        isAvailability(body.resend);
      return ok
        ? { kind: "ok", value: body as BookingMessagesResponse }
        : { kind: "failed", reason: "unreadable" };
    } catch {
      return { kind: "failed", reason: signal?.aborted ? "unavailable" : "unreachable" };
    }
  })();
}

export type ResendResult =
  | { kind: "sent"; generation: number }
  | {
      kind: "failed";
      /**
       * email_off, kind_mismatch, trip_over, refund_failed, limit, too_soon,
       * rate_limited, in_progress, email_invalid, key_reused (the key went
       * with another body: an earlier try may have gone through), forbidden,
       * signed_out, not_found, unreachable, unavailable
       */
      reason: string;
      /**
       * The API decided: a refusal is the stored answer for its key (and
       * email_off stores nothing), so the next try needs a new key. Not final
       * when no answer came: the same key then replays the first answer.
       */
      final: boolean;
    };

const refusals: Record<string, string> = {
  booking_email_off: "email_off",
  booking_email_kind_mismatch: "kind_mismatch",
  booking_trip_over: "trip_over",
  booking_email_refund_failed: "refund_failed",
  booking_email_resend_limit: "limit",
  booking_email_too_soon: "too_soon",
  booking_email_rate_limited: "rate_limited",
  booking_email_in_progress: "in_progress",
  booking_email_invalid: "email_invalid",
  // The key went with another body before: that earlier try may have gone
  // through, so this is final for the key, and the card reads again.
  idempotency_key_reused: "key_reused",
};

/**
 * Send the booking's email again, with the reason code the audit history
 * records. `key` is the Idempotency-Key: a new one for each new send, the
 * same one when the same send is retried after no answer. No address is ever
 * sent: the API uses the booker's address on file. Never throws.
 */
export async function resendBookingEmail(
  tenantId: string,
  bookingId: string,
  kind: BookingEmailResendKind,
  reason: BookingEmailResendReason,
  key: string,
): Promise<ResendResult> {
  try {
    const res = await call(
      `${tenantPath(tenantId)}/bookings/${encodeURIComponent(bookingId)}/emails/resend`,
      {
        method: "POST",
        headers: {
          accept: "application/json",
          "content-type": "application/json",
          "Idempotency-Key": key,
        },
        body: JSON.stringify({ kind, reason }),
      },
    );
    if (res.ok) {
      const body = (await res.json().catch(() => null)) as {
        message?: { generation?: unknown };
      } | null;
      const generation = body?.message?.generation;
      return Number.isSafeInteger(generation)
        ? { kind: "sent", generation: generation as number }
        : { kind: "failed", reason: "unavailable", final: false };
    }
    const code = await errorCode(res);
    const known = code ? refusals[code] : undefined;
    if (known) return { kind: "failed", reason: known, final: true };
    if (res.status === 401) return { kind: "failed", reason: "signed_out", final: false };
    if (res.status === 403) return { kind: "failed", reason: "forbidden", final: false };
    if (res.status === 404) return { kind: "failed", reason: "not_found", final: true };
    return { kind: "failed", reason: "unavailable", final: false };
  } catch {
    return { kind: "failed", reason: "unreachable", final: false };
  }
}

/** A new idempotency key: a UUID, which the API's key pattern accepts. */
export function newResendKey(): string {
  if (typeof crypto.randomUUID === "function") return crypto.randomUUID();
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
}
