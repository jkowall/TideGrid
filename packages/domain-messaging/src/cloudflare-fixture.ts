/**
 * A recorded-shape stand-in for the Cloudflare Email Service `send_email`
 * binding, for tests (G2.16a). It answers `send(builder)` from memory with
 * the documented result shape, `{ messageId }`, and the documented errors,
 * `Error` objects with a `code`. Synthetic addresses only. Not exported from
 * the package.
 *
 * The shapes and checks come from the public docs, fetched 2026-10-28, and
 * are unverified against live Cloudflare:
 * - Workers API: https://developers.cloudflare.com/email-service/api/send-emails/workers-api/
 * - Headers: https://developers.cloudflare.com/email-service/reference/headers/
 * - Send bindings: https://developers.cloudflare.com/email-service/configuration/send-bindings/
 * - Limits: https://developers.cloudflare.com/email-service/platform/limits/
 *
 * Which code a refused sender gets is not documented; the fixture answers
 * E_SENDER_NOT_VERIFIED. The id format is not documented either. The
 * fixture answers the shape of the event-subscriptions examples
 * (`0101018f7d0c4d9a-msg-deadbeef`, 16 hex, `-msg-`, then 16 hex here):
 * https://developers.cloudflare.com/email-service/reference/event-subscriptions/
 * Whether `send()` returns that same id, and in that form, is unverified;
 * the local simulation answers `<36 alphanumerics@sender domain>` instead.
 * G2.16-live compares the two before the join rule is settled.
 *
 * Every scripted failure's message carries the recipient address, the
 * display names, the subject and the tenant id, as a careless provider
 * might, so a test that no personal data reaches a port error or a log
 * tests something real.
 */
import type { CloudflareEmailBuilder, SendEmailBinding } from "./cloudflare.ts";

/** The 21 documented binding error codes. */
export const CLOUDFLARE_ERROR_CODES = [
  "E_VALIDATION_ERROR",
  "E_FIELD_MISSING",
  "E_TOO_MANY_RECIPIENTS",
  "E_TOO_MANY_ATTACHMENTS",
  "E_SENDER_NOT_VERIFIED",
  "E_RECIPIENT_NOT_ALLOWED",
  "E_RECIPIENT_SUPPRESSED",
  "E_ACCOUNT_SUSPENDED",
  "E_SENDER_DOMAIN_NOT_AVAILABLE",
  "E_CONTENT_TOO_LARGE",
  "E_DELIVERY_FAILED",
  "E_RATE_LIMIT_EXCEEDED",
  "E_DAILY_LIMIT_EXCEEDED",
  "E_INTERNAL_SERVER_ERROR",
  "E_HEADER_NOT_ALLOWED",
  "E_HEADER_USE_API_FIELD",
  "E_HEADER_VALUE_INVALID",
  "E_HEADER_VALUE_TOO_LONG",
  "E_HEADER_NAME_INVALID",
  "E_HEADERS_TOO_LARGE",
  "E_HEADERS_TOO_MANY",
] as const;

export type CloudflareErrorCode = (typeof CLOUDFLARE_ERROR_CODES)[number];

/** Allowlisted non-X headers (headers page), lowercased. */
const ALLOWLISTED = new Set(
  [
    "In-Reply-To",
    "References",
    "Thread-Index",
    "Thread-Topic",
    "List-Unsubscribe",
    "List-Unsubscribe-Post",
    "List-Id",
    "List-Archive",
    "List-Help",
    "List-Owner",
    "List-Post",
    "List-Subscribe",
    "Precedence",
    "Auto-Submitted",
    "Content-Language",
    "Keywords",
    "Comments",
    "Importance",
    "Priority",
    "Sensitivity",
    "Organization",
    "Require-Recipient-Valid-Since",
    "Expires",
    "Reply-By",
    "Archived-At",
  ].map((h) => h.toLowerCase()),
);
const API_FIELDS = new Set(["from", "to", "cc", "bcc", "subject", "reply-to"]);
const PLATFORM = new Set(
  [
    "Date",
    "Message-ID",
    "MIME-Version",
    "Content-Type",
    "Content-Transfer-Encoding",
    "DKIM-Signature",
    "Return-Path",
    "Received",
    "Feedback-ID",
    "TLS-Required",
    "TLS-Report-Domain",
    "TLS-Report-Submitter",
    "CFBL-Address",
    "CFBL-Feedback-ID",
  ].map((h) => h.toLowerCase()),
);
const X_HEADER = /^X-[A-Za-z0-9_-]+$/i;
const ALLOWLISTED_NAME = /^[A-Za-z0-9-]+$/;

const MAX_RECIPIENTS = 50;
const MAX_SUBJECT = 998;
const MAX_TOTAL_BYTES = 5 * 1024 * 1024;
const MAX_HEADER_BYTES = 16 * 1024;
const MAX_HEADER_VALUE_BYTES = 2048;
const MAX_HEADER_NAME = 100;
const MAX_ALLOWLISTED_HEADERS = 20;

const encoder = new TextEncoder();
const bytes = (s: string) => encoder.encode(s).length;

export interface RecordedSend {
  /** A copy of the builder as the binding received it. */
  builder: CloudflareEmailBuilder;
  outcome:
    | { kind: "accepted"; messageId: string }
    | { kind: "error"; code: string | null }
    | { kind: "hung" }
    | { kind: "late"; settles: "accept" | "reject" };
}

export interface CloudflareEmailFixtureOptions {
  /** The binding's `allowed_sender_addresses`; unset allows any sender. */
  allowedSenderAddresses?: string[];
  /** Echoed into every error message, as a careless provider might. */
  tenantId?: string;
}

export interface CloudflareEmailFixture {
  binding: SendEmailBinding;
  /** Every call in order, faulted ones included. */
  readonly sends: RecordedSend[];
  /** The next call throws an `Error` with this code. */
  failNext(code: CloudflareErrorCode | string): void;
  /** The next call rejects with this value, which need not be an Error. */
  throwNext(value: unknown): void;
  /** The next call never settles. */
  hangNext(): void;
  /** The next call rejects with this code after `ms`. */
  rejectLate(code: CloudflareErrorCode | string, ms: number): void;
  /** The next call is accepted, but answers only after `ms`. */
  acceptLate(ms: number): void;
  /** The next accepted call answers with this id. */
  answerId(id: string): void;
}

type Script =
  | { kind: "fail"; code: string }
  | { kind: "throw"; value: unknown }
  | { kind: "hang" }
  | { kind: "reject_late"; code: string; ms: number }
  | { kind: "accept_late"; ms: number };

function hex(bytes: number): string {
  return [...crypto.getRandomValues(new Uint8Array(bytes))]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/** An id in the shape of the event-subscriptions examples. */
function randomId(): string {
  return `${hex(8)}-msg-${hex(8)}`;
}

function addressOf(value: string | { email: string; name?: string }): string {
  return typeof value === "string" ? value : value.email;
}

function nameOf(value: string | { email: string; name?: string }): string {
  return typeof value === "string" ? "" : (value.name ?? "");
}

function copy(builder: CloudflareEmailBuilder): CloudflareEmailBuilder {
  return {
    ...builder,
    from: { ...builder.from },
    to: typeof builder.to === "string" ? builder.to : { ...builder.to },
    headers: { ...builder.headers },
  };
}

export function createCloudflareEmailFixture(
  options: CloudflareEmailFixtureOptions = {},
): CloudflareEmailFixture {
  const sends: RecordedSend[] = [];
  const scripts: Script[] = [];
  const ids: string[] = [];
  const failedOnce = new Set<string>();
  const allowedSenders = options.allowedSenderAddresses?.map((a) => a.toLowerCase()) ?? null;

  const error = (code: string, builder: CloudflareEmailBuilder): Error => {
    const to = addressOf(builder.to);
    const detail = [
      `${code}: could not send to ${to}`,
      nameOf(builder.to) ? `(${nameOf(builder.to)})` : "",
      `from ${builder.from?.name ?? ""} <${builder.from?.email ?? ""}>`,
      `about "${builder.subject}"`,
      options.tenantId ? `for tenant ${options.tenantId}` : "",
    ]
      .filter(Boolean)
      .join(" ");
    return Object.assign(new Error(detail), { code });
  };

  /** The documented checks, in a plausible order; null when the builder passes. */
  function check(builder: CloudflareEmailBuilder): string | null {
    if (!builder?.from || !builder.to || !builder.subject) return "E_FIELD_MISSING";
    if (!builder.html && !builder.text) return "E_FIELD_MISSING";
    const from = addressOf(builder.from).toLowerCase();
    if (allowedSenders && !allowedSenders.includes(from)) return "E_SENDER_NOT_VERIFIED";
    const recipients = Array.isArray(builder.to) ? builder.to.length : 1;
    if (recipients > MAX_RECIPIENTS) return "E_TOO_MANY_RECIPIENTS";
    if (builder.subject.length > MAX_SUBJECT) return "E_VALIDATION_ERROR";
    const headers = Object.entries(builder.headers ?? {});
    let headerBytes = 0;
    let allowlisted = 0;
    const seen = new Set<string>();
    for (const [name, value] of headers) {
      const lower = name.toLowerCase();
      if (API_FIELDS.has(lower)) return "E_HEADER_USE_API_FIELD";
      if (PLATFORM.has(lower) || lower.startsWith("arc-")) return "E_HEADER_NOT_ALLOWED";
      if (name.length < 1 || name.length > MAX_HEADER_NAME || /[\s:]/.test(name)) {
        return "E_HEADER_NAME_INVALID";
      }
      if (X_HEADER.test(name)) {
        // Any X- name of letters, digits, hyphens and underscores.
      } else if (ALLOWLISTED.has(lower) && ALLOWLISTED_NAME.test(name)) {
        allowlisted += 1;
      } else if (/^[\x21-\x7e]+$/.test(name)) {
        return "E_HEADER_NOT_ALLOWED";
      } else {
        return "E_HEADER_NAME_INVALID";
      }
      if (seen.has(lower)) return "E_VALIDATION_ERROR";
      seen.add(lower);
      if (typeof value !== "string" || value.length === 0 || /[\r\n]/.test(value)) {
        return "E_HEADER_VALUE_INVALID";
      }
      if (bytes(value) > MAX_HEADER_VALUE_BYTES) return "E_HEADER_VALUE_TOO_LONG";
      headerBytes += bytes(name) + 2 + bytes(value) + 2;
    }
    if (allowlisted > MAX_ALLOWLISTED_HEADERS) return "E_HEADERS_TOO_MANY";
    if (headerBytes > MAX_HEADER_BYTES) return "E_HEADERS_TOO_LARGE";
    const total =
      bytes(builder.subject) + bytes(builder.html ?? "") + bytes(builder.text ?? "") + headerBytes;
    if (total > MAX_TOTAL_BYTES) return "E_CONTENT_TOO_LARGE";
    // Mapped addresses, as the fake's: +bounce is suppressed; +fail-once is
    // rate limited on its first call for that address only.
    const local = (addressOf(builder.to).split("@")[0] ?? "").toLowerCase();
    if (local.endsWith("+bounce")) return "E_RECIPIENT_SUPPRESSED";
    if (local.endsWith("+fail-once")) {
      const address = addressOf(builder.to).toLowerCase();
      if (!failedOnce.has(address)) {
        failedOnce.add(address);
        return "E_RATE_LIMIT_EXCEEDED";
      }
    }
    return null;
  }

  const binding: SendEmailBinding = {
    send: async (builder) => {
      const record: RecordedSend = { builder: copy(builder), outcome: { kind: "hung" } };
      sends.push(record);
      const script = scripts.shift();
      if (script) {
        switch (script.kind) {
          case "fail":
            record.outcome = { kind: "error", code: script.code };
            throw error(script.code, builder);
          case "throw":
            record.outcome = { kind: "error", code: null };
            throw script.value;
          case "hang":
            return new Promise<never>(() => undefined);
          case "reject_late": {
            record.outcome = { kind: "late", settles: "reject" };
            const late = error(script.code, builder);
            return new Promise<never>((_, reject) => setTimeout(() => reject(late), script.ms));
          }
          case "accept_late": {
            record.outcome = { kind: "late", settles: "accept" };
            const messageId = ids.shift() ?? randomId();
            return new Promise((resolve) => setTimeout(() => resolve({ messageId }), script.ms));
          }
        }
      }
      const refused = check(builder);
      if (refused) {
        record.outcome = { kind: "error", code: refused };
        throw error(refused, builder);
      }
      const messageId = ids.shift() ?? randomId();
      record.outcome = { kind: "accepted", messageId };
      return { messageId };
    },
  };

  return {
    binding,
    sends,
    failNext: (code) => scripts.push({ kind: "fail", code }),
    throwNext: (value) => scripts.push({ kind: "throw", value }),
    hangNext: () => scripts.push({ kind: "hang" }),
    rejectLate: (code, ms) => scripts.push({ kind: "reject_late", code, ms }),
    acceptLate: (ms) => scripts.push({ kind: "accept_late", ms }),
    answerId: (id) => ids.push(id),
  };
}
