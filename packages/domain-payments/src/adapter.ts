/**
 * The provider-neutral payment adapter (G2.7). Checkout talks to a payment
 * provider only through this interface. The demo runs the fake provider in
 * `fake.ts`; a Stripe adapter replaces it behind the same interface before
 * any live booking, as the demo build plan records.
 *
 * Every amount is integer minor units with an explicit currency. Every call
 * that creates something carries an idempotency key, so retrying a call whose
 * outcome is unknown returns the first result instead of acting twice. No
 * method may be called inside a database transaction.
 */

export type PaymentProviderName = "fake" | "stripe";
export type PaymentCurrency = "USD";

/** pending until the provider settles it; succeeded and failed are final. */
export type ProviderPaymentStatus = "pending" | "succeeded" | "failed";

export interface CreatePaymentInput {
  /** The operator's connected account. Direct charges land there. */
  accountRef: string;
  amount: number;
  currency: PaymentCurrency;
  /** The same key always names the same payment. */
  idempotencyKey: string;
  /** TideGrid's payment id. The provider echoes it on every event about the payment. */
  clientReference: string;
}

export interface ProviderPayment {
  paymentRef: string;
  status: ProviderPaymentStatus;
  amount: number;
  currency: PaymentCurrency;
  amountRefunded: number;
}

export interface CreatedPayment extends ProviderPayment {
  /** What the guest's browser needs to pay, and nothing more. Never stored by TideGrid. */
  clientSecret: string;
}

export interface RefundPaymentInput {
  accountRef: string;
  paymentRef: string;
  amount: number;
  currency: PaymentCurrency;
  idempotencyKey: string;
}

export interface ProviderRefund {
  refundRef: string;
  status: "succeeded" | "failed";
  /** Present when the provider refused the refund. */
  failureCode?: string;
}

/**
 * The provider-neutral kinds of event. `payment.failed` means the provider
 * will not complete this payment: it is final. A provider that lets a guest
 * retry after a declined attempt (Stripe's `payment_intent.payment_failed`)
 * must not report that attempt as `payment.failed`. Every other event is
 * `other`, recorded and ignored.
 */
export type ProviderEventType = "payment.succeeded" | "payment.failed" | "other";

declare const verified: unique symbol;

/**
 * An event whose signature the adapter verified. Only `verifyWebhook` builds
 * one, so code that holds one has passed verification; the inbox accepts
 * nothing else.
 */
export interface VerifiedProviderEvent {
  readonly provider: PaymentProviderName;
  readonly eventId: string;
  readonly type: ProviderEventType;
  /** The provider's own type string, for diagnosis. */
  readonly providerType: string;
  readonly accountRef: string;
  readonly occurredAt: Date | null;
  /** Present for payment events. Currency is upper case. */
  readonly payment: {
    readonly ref: string;
    readonly amount: number;
    readonly currency: string;
    readonly clientReference: string | null;
  } | null;
  /** SHA-256 of the raw body, hex. */
  readonly payloadSha256: string;
  readonly [verified]: true;
}

export type WebhookRejection =
  | "missing_signature"
  | "malformed_signature"
  | "timestamp_out_of_tolerance"
  | "signature_mismatch"
  | "payload_invalid";

export type WebhookVerification =
  | { kind: "verified"; event: VerifiedProviderEvent }
  | { kind: "rejected"; reason: WebhookRejection };

export interface VerifyWebhookInput {
  /** The body exactly as received; the signature covers these bytes. */
  rawBody: string;
  signatureHeader: string | null;
  /** The Worker's clock in milliseconds, for the replay tolerance window. */
  nowMs: number;
}

export interface PaymentProvider {
  readonly name: PaymentProviderName;
  /** The request header that carries the webhook signature, lower case. */
  readonly signatureHeader: string;
  /** The smallest amount the provider charges, in minor units. */
  minimumAmount(currency: PaymentCurrency): number;
  /** Idempotent by key. Throws ProviderUnavailableError when the outcome is unknown. */
  createPayment(input: CreatePaymentInput): Promise<CreatedPayment>;
  retrievePayment(input: {
    accountRef: string;
    paymentRef: string;
  }): Promise<ProviderPayment | null>;
  /** Idempotent by key. Throws ProviderUnavailableError when the outcome is unknown. */
  refundPayment(input: RefundPaymentInput): Promise<ProviderRefund>;
  verifyWebhook(input: VerifyWebhookInput): Promise<WebhookVerification>;
}

/**
 * The provider could not be reached, or answered in a way that leaves the
 * outcome unknown. Retry with the same idempotency key; never start a new
 * attempt until the old one is reconciled.
 */
export class ProviderUnavailableError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "ProviderUnavailableError";
  }
}

/** The provider refused the request; retrying the same request will not help. */
export class ProviderRejectedError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "ProviderRejectedError";
  }
}

/** A verified event's fields, as an adapter assembles them before vouching for them. */
export type ProviderEventFields = Omit<VerifiedProviderEvent, typeof verified>;

/** Builds a verified event. Internal to adapters: call it only after the signature checks out. */
export function verifiedEvent(fields: ProviderEventFields): VerifiedProviderEvent {
  return Object.freeze({ ...fields }) as VerifiedProviderEvent;
}
