/**
 * How the Cloudflare Email Service binding's error codes map onto the port
 * (G2.16a). Cloudflare documents the codes but not which are retryable, so
 * this table is TideGrid policy, not provider fact. Every documented code is
 * listed by name; nothing matches by prefix. A code missing from the table
 * is ambiguous: the email may have been accepted.
 *
 * Source, fetched 2026-10-28:
 * https://developers.cloudflare.com/email-service/api/send-emails/workers-api/
 *
 * - rejected: the provider refused this email; it fails at once.
 * - unavailable: the provider said it did not take the email; it retries.
 * - ambiguous: nobody knows whether it was taken; delivery decides (D1: a
 *   non-deduplicating provider's ambiguous send is never repeated).
 */
import type { EmailFaultScope } from "./adapter.ts";

export type CloudflareErrorClass = "rejected" | "unavailable" | "ambiguous";

export interface CloudflareErrorRule {
  /** The TideGrid code stored on the message (`last_error_code`). */
  code: string;
  class: CloudflareErrorClass;
  scope: EmailFaultScope;
}

const rejected = (code: string): CloudflareErrorRule => ({
  code,
  class: "rejected",
  scope: "message",
});
const notSent = (code: string): CloudflareErrorRule => ({
  code,
  class: "unavailable",
  scope: "message",
});
const account = (code: string): CloudflareErrorRule => ({
  code,
  class: "unavailable",
  scope: "account",
});
const ambiguous: CloudflareErrorRule = {
  code: "provider_unavailable",
  class: "ambiguous",
  scope: "message",
};

/** The 21 documented binding codes, each by name. */
export const cloudflareErrorTable: ReadonlyMap<string, CloudflareErrorRule> = new Map([
  ["E_VALIDATION_ERROR", rejected("invalid_message")],
  ["E_FIELD_MISSING", rejected("invalid_message")],
  ["E_TOO_MANY_RECIPIENTS", rejected("invalid_message")],
  ["E_TOO_MANY_ATTACHMENTS", rejected("invalid_message")],
  ["E_CONTENT_TOO_LARGE", rejected("invalid_message")],
  ["E_HEADER_NOT_ALLOWED", rejected("invalid_message")],
  ["E_HEADER_USE_API_FIELD", rejected("invalid_message")],
  ["E_HEADER_VALUE_INVALID", rejected("invalid_message")],
  ["E_HEADER_VALUE_TOO_LONG", rejected("invalid_message")],
  ["E_HEADER_NAME_INVALID", rejected("invalid_message")],
  ["E_HEADERS_TOO_LARGE", rejected("invalid_message")],
  ["E_HEADERS_TOO_MANY", rejected("invalid_message")],
  ["E_RECIPIENT_SUPPRESSED", rejected("recipient_suppressed")],
  ["E_RECIPIENT_NOT_ALLOWED", rejected("recipient_not_allowed")],
  // A rate limit is known not sent and "must be retried later", but it is
  // not an account fault: the lifecycle page says the stage "checks sending
  // limits per account, domain, and recipient", with this one code for all
  // three. So it retries its own message and the run goes on (review note
  // fidelity F2). https://developers.cloudflare.com/email-service/concepts/email-lifecycle/
  ["E_RATE_LIMIT_EXCEEDED", notSent("provider_rate_limited")],
  // Account-level faults retry, so one misconfiguration does not fail the
  // whole queue at once, and stop the run (D2).
  ["E_DAILY_LIMIT_EXCEEDED", account("provider_quota_exceeded")],
  ["E_SENDER_NOT_VERIFIED", account("sender_not_verified")],
  ["E_SENDER_DOMAIN_NOT_AVAILABLE", account("sender_not_verified")],
  ["E_ACCOUNT_SUSPENDED", account("provider_account_suspended")],
  // E_DELIVERY_FAILED: description "Could not deliver the email", common
  // causes "SMTP delivery failure, recipient server rejection". A rejection by
  // the recipient's server means something was transmitted and refused, which
  // points toward Rejected; an SMTP failure does not say. It stays ambiguous
  // (coordinator default for D1), the safe direction: never sent again.
  // Whether a Rejected code (such as recipient_rejected) would serve staff
  // better is on the G2.16-live checklist.
  ["E_DELIVERY_FAILED", ambiguous],
  // E_INTERNAL_SERVER_ERROR: "Internal service error", common cause "Email
  // Service temporarily unavailable"; whether the email was taken is unknown.
  ["E_INTERNAL_SERVER_ERROR", ambiguous],
]);

/** The rule for anything else: no code, an unknown code, a non-Error throw, or a timeout. */
export const cloudflareAmbiguousRule: CloudflareErrorRule = ambiguous;

/** The documented code a thrown value carries, or null. Never reads its message. */
export function cloudflareErrorCode(error: unknown): string | null {
  if (typeof error !== "object" || error === null) return null;
  let code: unknown;
  try {
    code = (error as { code?: unknown }).code;
  } catch {
    return null;
  }
  return typeof code === "string" && cloudflareErrorTable.has(code) ? code : null;
}

export function classifyCloudflareError(error: unknown): CloudflareErrorRule {
  const code = cloudflareErrorCode(error);
  return (code && cloudflareErrorTable.get(code)) || cloudflareAmbiguousRule;
}
