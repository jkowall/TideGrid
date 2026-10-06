/**
 * The provider-neutral email adapter. Delivery talks to an email provider
 * only through this interface. The demo runs the fake provider in `fake.ts`;
 * a Cloudflare Email Service adapter replaces it before any live booking.
 * No method may be called inside a database transaction.
 */

export type EmailProviderName = "fake" | "cloudflare";

export interface OutgoingEmail {
  /** The message id. The same key always names the same email: a repeat returns the first. */
  idempotencyKey: string;
  /** Metadata, as a provider tag would be; the fake files messages by it. */
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
   * Send one email. Resolves with the provider's id once it accepted the
   * email. Throws `EmailProviderUnavailableError` when the outcome is unknown
   * or temporary (retry with the same key) and `EmailProviderRejectedError`
   * when the provider refuses it (do not retry).
   */
  send(email: OutgoingEmail): Promise<{ providerMessageId: string }>;
}

/** The provider did not answer, or answered that it cannot accept mail now. Retry with the same key. */
export class EmailProviderUnavailableError extends Error {
  constructor(
    readonly code = "provider_unavailable",
    message = "the email provider is unavailable",
  ) {
    super(message);
    this.name = "EmailProviderUnavailableError";
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
