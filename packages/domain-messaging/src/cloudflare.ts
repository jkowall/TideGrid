/**
 * The Cloudflare Email Service adapter (G2.16a): the email port over the
 * Workers `send_email` binding, with the structured builder. It holds no
 * secret (the binding is authorized by the account and the Worker's deploy)
 * and makes no `fetch` call. It is switched off in every deployed
 * configuration until the owner authorizes the live step, and it has never
 * called the real service: it is tested against a recorded-shape fixture.
 *
 * - Not idempotent. Cloudflare documents no idempotency key, so the adapter
 *   says `deduplicates: false` and delivery never repeats a send whose
 *   outcome is unknown. The message id travels only as the opaque
 *   `X-TideGrid-Message-Id` header, for correlation.
 * - A recipient fence. Outside production the adapter sends only to an
 *   explicit allowlist and refuses anything else with no provider call.
 * - Bounded. Each send races a timeout (10 s by default). A timeout is an
 *   unknown outcome. An answer that arrives later is logged, never thrown.
 * - No personal data in errors or logs. A provider error's message is never
 *   read; only its documented code is. Port errors carry TideGrid's code.
 *   Logs carry event names, codes, the message id, and opaque provider ids.
 *
 * Provider docs, fetched 2026-10-28:
 * https://developers.cloudflare.com/email-service/api/send-emails/workers-api/
 * https://developers.cloudflare.com/email-service/reference/headers/
 */
import {
  type EmailProvider,
  EmailProviderRejectedError,
  EmailProviderUnavailableError,
  type OutgoingEmail,
  providerMessageIdPattern,
} from "./adapter.ts";
import { classifyCloudflareError, cloudflareErrorCode } from "./cloudflare-errors.ts";

/** A sender or recipient, as the builder takes it. */
export interface CloudflareEmailAddress {
  email: string;
  name: string;
}

/** The builder fields this adapter sends: a subset of the Workers `EmailMessageBuilder`. */
export interface CloudflareEmailBuilder {
  from: CloudflareEmailAddress;
  to: string | CloudflareEmailAddress;
  subject: string;
  html: string;
  text: string;
  replyTo?: string;
  headers: Record<string, string>;
}

/**
 * The binding, structurally. A function-typed property, not a method, so the
 * API Worker's check that `SendEmail` is assignable to it compares the
 * builder strictly.
 */
export type SendEmailBinding = {
  send: (builder: CloudflareEmailBuilder) => Promise<{ messageId: string }>;
};

/** Who may receive email: an explicit list, or anyone (production only). */
export type RecipientPolicy = { kind: "only"; addresses: ReadonlySet<string> } | { kind: "any" };

/** A structured log line. Attribute values are codes, opaque ids, and flags only. */
export type EmailProviderLog = (
  event: string,
  attributes: Record<string, string | number | boolean>,
) => void;

export interface CloudflareEmailOptions {
  /** The `send_email` binding; undefined is refused. */
  binding: SendEmailBinding | undefined;
  /** Required: there is no default, so a caller cannot forget the fence. */
  recipients: RecipientPolicy;
  /** The deployment's ENVIRONMENT; `any` recipients is refused outside "production". */
  environment: string;
  /** One send's bound, 1 to 60,000 ms; default 10,000. */
  timeoutMs?: number;
  log?: EmailProviderLog;
}

export const DEFAULT_CLOUDFLARE_SEND_TIMEOUT_MS = 10_000;
export const MESSAGE_ID_HEADER = "X-TideGrid-Message-Id";

/** A key the adapter writes into a header: opaque and header-safe (a message id is a UUID). */
const keyPattern = /^[A-Za-z0-9_.:-]{1,200}$/;
/** One address: no whitespace, exactly one @, something on each side. */
const addressPattern = /^[^\s@]+@[^\s@]+$/;
/** C0 and C1 control characters, DEL included: CR and LF among them. */
// biome-ignore lint/suspicious/noControlCharactersInRegex: the point is to find them
const controlPattern = /[\u0000-\u001f\u007f-\u009f]/;

function hasControl(value: string): boolean {
  return typeof value !== "string" || controlPattern.test(value);
}

/**
 * One address of printable characters, as the message table admits: no
 * whitespace or control character, exactly one @, something on each side.
 * The API checks its sender with the same rule (EMAIL_FROM_ADDRESS).
 */
export function isAddress(value: string): boolean {
  return typeof value === "string" && !hasControl(value) && addressPattern.test(value);
}

const encoder = new TextEncoder();

async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", encoder.encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * The id TideGrid stores for a Cloudflare message id: the id itself when it
 * fits `email_messages.provider_message_id` (migration 0009), otherwise
 * `cfh_` and the first 40 hex characters of its SHA-256. Deterministic, so a
 * future delivery-events consumer joins on the same rule.
 */
export async function normalizeCloudflareMessageId(
  raw: string,
): Promise<{ id: string; normalized: boolean }> {
  if (providerMessageIdPattern.test(raw)) return { id: raw, normalized: false };
  return { id: `cfh_${(await sha256Hex(raw)).slice(0, 40)}`, normalized: true };
}

/** The lowercased, trimmed form an address is compared in. */
export function normalizeRecipient(address: string): string {
  return address.trim().toLowerCase();
}

type Answer =
  | { kind: "accepted"; result: unknown }
  | { kind: "failed"; error: unknown }
  | { kind: "timeout" };

export class CloudflareEmailProvider implements EmailProvider {
  readonly name = "cloudflare" as const;
  readonly deduplicates = false;
  readonly sendTimeoutMs: number;
  readonly #binding: SendEmailBinding;
  readonly #only: ReadonlySet<string> | null;
  readonly #log: EmailProviderLog;

  constructor(options: CloudflareEmailOptions) {
    const binding = options.binding;
    if (!binding || typeof binding.send !== "function") {
      throw new TypeError("the Cloudflare email adapter needs its send_email binding");
    }
    const recipients = options.recipients;
    if (recipients?.kind === "any") {
      if (options.environment !== "production") {
        throw new TypeError("unrestricted recipients are allowed only in production");
      }
      this.#only = null;
    } else if (recipients?.kind === "only") {
      const only = new Set<string>();
      for (const entry of recipients.addresses) {
        const address = normalizeRecipient(entry);
        if (!addressPattern.test(address)) {
          throw new TypeError("a recipient allowlist entry is one address");
        }
        only.add(address);
      }
      this.#only = only;
    } else {
      throw new TypeError("the Cloudflare email adapter needs an explicit recipient policy");
    }
    const timeoutMs = options.timeoutMs ?? DEFAULT_CLOUDFLARE_SEND_TIMEOUT_MS;
    if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 60_000) {
      throw new RangeError("timeoutMs is a whole number from 1 to 60000");
    }
    this.sendTimeoutMs = timeoutMs;
    this.#binding = binding;
    this.#log = options.log ?? (() => undefined);
  }

  #emit(event: string, attributes: Record<string, string | number | boolean>): void {
    try {
      this.#log(event, { "event.name": event, ...attributes });
    } catch {
      // A failing log never changes a send's outcome.
    }
  }

  async send(email: OutgoingEmail): Promise<{ providerMessageId: string }> {
    const key = email.idempotencyKey;
    if (typeof key !== "string" || !keyPattern.test(key)) {
      throw new EmailProviderRejectedError("invalid_message");
    }
    const to = normalizeRecipient(email.to.email);
    // No control character in a name or the subject, and one address in
    // each address field, checked here rather than left to the message
    // table's CHECKs or the provider's encoding (review notes F8, S3).
    if (
      hasControl(email.from.name) ||
      (email.to.name !== null && hasControl(email.to.name)) ||
      hasControl(email.subject) ||
      !isAddress(email.from.email) ||
      !isAddress(to) ||
      (email.replyTo !== null && !isAddress(email.replyTo))
    ) {
      this.#emit("email_invalid_message", { "tidegrid.email.message_id": key });
      throw new EmailProviderRejectedError("invalid_message");
    }
    if (this.#only && !this.#only.has(to)) {
      this.#emit("email_recipient_not_allowed", { "tidegrid.email.message_id": key });
      throw new EmailProviderRejectedError("recipient_not_allowed");
    }
    const builder: CloudflareEmailBuilder = {
      from: { email: email.from.email, name: email.from.name },
      to: email.to.name ? { email: to, name: email.to.name } : to,
      subject: email.subject,
      html: email.html,
      text: email.text,
      ...(email.replyTo ? { replyTo: email.replyTo } : {}),
      headers: { [MESSAGE_ID_HEADER]: key, "Auto-Submitted": "auto-generated" },
    };

    const answer = await this.#call(builder, key);
    if (answer.kind === "accepted") return { providerMessageId: await this.#accepted(answer, key) };
    if (answer.kind === "timeout") {
      this.#emit("email_send_timeout", {
        "error.type": "timeout",
        "tidegrid.email.message_id": key,
      });
      throw new EmailProviderUnavailableError(
        "provider_unavailable",
        "the email provider did not answer in time",
        { outcome: "unknown" },
      );
    }
    const rule = classifyCloudflareError(answer.error);
    this.#emit("email_provider_error", {
      "error.type": cloudflareErrorCode(answer.error) ?? "unknown",
      "tidegrid.email.message_id": key,
    });
    if (rule.class === "rejected") throw new EmailProviderRejectedError(rule.code);
    throw new EmailProviderUnavailableError(
      rule.code,
      `the email provider did not take the message: ${rule.code}`,
      { outcome: rule.class === "ambiguous" ? "unknown" : "not_sent", scope: rule.scope },
    );
  }

  /** The id to record for an accepted send. Never throws: the email is already out. */
  async #accepted(answer: { result: unknown }, key: string): Promise<string> {
    let raw: unknown;
    try {
      raw = (answer.result as { messageId?: unknown } | null)?.messageId;
    } catch {
      raw = undefined;
    }
    try {
      if (typeof raw === "string" && raw.length > 0) {
        const { id, normalized } = await normalizeCloudflareMessageId(raw);
        if (normalized) {
          this.#emit("email_provider_id_normalized", {
            "tidegrid.email.message_id": key,
            "tidegrid.email.provider_id_normalized": true,
          });
        }
        return id;
      }
    } catch {
      // Fall through to the stand-in id.
    }
    this.#emit("email_provider_id_missing", {
      "tidegrid.email.message_id": key,
      "tidegrid.email.provider_id_normalized": true,
    });
    return `cf_no_id.${key}`;
  }

  /**
   * One binding call raced against the timeout. Handlers go on the call's own
   * promise before the race, so an answer after the timeout is observed:
   * a late rejection is swallowed and logged by code only, and a late
   * acceptance is logged with the message id and the normalized provider id.
   */
  #call(builder: CloudflareEmailBuilder, key: string): Promise<Answer> {
    let pending: Promise<unknown>;
    try {
      pending = Promise.resolve(this.#binding.send(builder));
    } catch (error) {
      return Promise.resolve({ kind: "failed", error });
    }
    return new Promise<Answer>((resolve) => {
      let settled = false;
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        resolve({ kind: "timeout" });
      }, this.sendTimeoutMs);
      pending.then(
        (result) => {
          if (settled) {
            this.#lateAccept(result, key).catch(() => undefined);
            return;
          }
          settled = true;
          clearTimeout(timer);
          resolve({ kind: "accepted", result });
        },
        (error: unknown) => {
          if (settled) {
            this.#emit("email_send_late_reject", {
              "error.type": cloudflareErrorCode(error) ?? "unknown",
            });
            return;
          }
          settled = true;
          clearTimeout(timer);
          resolve({ kind: "failed", error });
        },
      );
    });
  }

  /**
   * A delivered copy the message table never records (it ended
   * `outcome_unknown`): log its provider id as it would have been stored,
   * normalized, so a future events consumer can join on it (review note F7).
   */
  async #lateAccept(result: unknown, key: string): Promise<void> {
    let id = "none";
    try {
      const raw = (result as { messageId?: unknown } | null)?.messageId;
      if (typeof raw === "string" && raw.length > 0) {
        id = (await normalizeCloudflareMessageId(raw)).id;
      }
    } catch {
      id = "none";
    }
    this.#emit("email_send_late_accept", {
      "tidegrid.email.message_id": key,
      "tidegrid.email.provider_message_id": id,
    });
  }
}

export function createCloudflareEmailProvider(
  options: CloudflareEmailOptions,
): CloudflareEmailProvider {
  return new CloudflareEmailProvider(options);
}
