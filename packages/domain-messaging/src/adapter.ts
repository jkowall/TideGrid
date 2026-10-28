/**
 * The provider-neutral email adapter. Delivery talks to an email provider
 * only through this interface. The demo runs the fake provider in `fake.ts`;
 * the Cloudflare Email Service adapter in `cloudflare.ts` (G2.16a) is built
 * and tested against a recorded-shape fixture, and stays off in every
 * deployed configuration until the owner authorizes the live step.
 * No method may be called inside a database transaction.
 *
 * Providers differ in one way delivery must know about: whether a repeat
 * with the same key returns the first email (the fake) or sends a second one
 * (Cloudflare documents no idempotency key). A provider states it in
 * `deduplicates`; delivery never assumes it.
 */

export type EmailProviderName = "fake" | "cloudflare";

export interface OutgoingEmail {
  /**
   * The message id. The same key always names the same email. Whether a
   * repeat returns the first email depends on the provider: see
   * `EmailProvider.deduplicates`.
   */
  idempotencyKey: string;
  /** Metadata, as a provider tag would be; the fake files messages by it. Never sent. */
  tenantId: string;
  from: { email: string; name: string };
  replyTo: string | null;
  to: { email: string; name: string | null };
  subject: string;
  html: string;
  text: string;
}

export interface EmailProvider {
  name: EmailProviderName;
  /**
   * Whether a repeat with the same key answers with the first email instead
   * of sending another. Unset means it does, as the fake does. A provider
   * that cannot promise it says false, and delivery then never repeats a
   * send whose outcome is unknown (G2.16a, at most once).
   */
  readonly deduplicates?: boolean;
  /**
   * The longest one send can take, in milliseconds, when the provider bounds
   * it. A delivery run with a deadline reserves this much for each send.
   */
  readonly sendTimeoutMs?: number;
  /**
   * Send one email. Resolves with the provider's id once it accepted the
   * email. Throws `EmailProviderUnavailableError` when the email was not
   * accepted now, or nobody knows whether it was (`outcome`), and
   * `EmailProviderRejectedError` when the provider refuses it (do not retry).
   */
  send(email: OutgoingEmail): Promise<{ providerMessageId: string }>;
}

/**
 * What an unavailable provider did with the email. "not_sent": the provider
 * said so, and a retry cannot duplicate it. "unknown": it may have been
 * accepted (a timeout, an internal error, an answer that never came).
 */
export type EmailSendOutcome = "not_sent" | "unknown";

/**
 * How far a fault reaches. "message": this email only. "account": the
 * sending account itself (a sender not verified, a suspended account, a rate
 * or daily limit), so every other email would fail the same way now.
 */
export type EmailFaultScope = "message" | "account";

/**
 * The provider did not take the email now. Retry with the same key when the
 * provider deduplicates, or when `outcome` is "not_sent". The message is the
 * adapter's own text: never a recipient, a name, a subject, or a provider's
 * error text.
 */
export class EmailProviderUnavailableError extends Error {
  /** Unknown unless the adapter knows better, so a non-deduplicating provider fails safe. */
  readonly outcome: EmailSendOutcome;
  readonly scope: EmailFaultScope;

  constructor(
    readonly code = "provider_unavailable",
    message = "the email provider is unavailable",
    options: { outcome?: EmailSendOutcome; scope?: EmailFaultScope } = {},
  ) {
    super(message);
    this.name = "EmailProviderUnavailableError";
    this.outcome = options.outcome ?? "unknown";
    this.scope = options.scope ?? "message";
    if (!/^[a-z][a-z0-9_]{0,63}$/.test(code)) {
      throw new TypeError("a provider error code is lowercase snake case");
    }
  }
}

/** The provider refused the email, such as a bounced address. Retrying cannot help. */
export class EmailProviderRejectedError extends Error {
  constructor(
    readonly code: string,
    message = `the email provider refused the message: ${code}`,
  ) {
    super(message);
    this.name = "EmailProviderRejectedError";
    if (!/^[a-z][a-z0-9_]{0,63}$/.test(code)) {
      throw new TypeError("a provider error code is lowercase snake case");
    }
  }
}

/** What `email_messages.provider_message_id` admits (migration 0009). */
export const providerMessageIdPattern = /^[A-Za-z0-9_.@<>:+=-]{3,255}$/;
