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
  /**
   * pending: the provider accepted the refund and has not finished it (W3-G2.9).
   * Not an unknown outcome: the refund exists and has an id; its result
   * arrives as a refund event, or on a later lookup.
   */
  status: "pending" | "succeeded" | "failed";
  /** Present when the provider refused the refund. */
  failureCode?: string;
}

export interface CancelPaymentInput {
  accountRef: string;
  paymentRef: string;
  /** The same key always names the same cancellation. */
  idempotencyKey: string;
}

/**
 * What canceling an unpaid payment found (W3-G2.9). `canceled`: the guest can
 * no longer pay it, and the provider sends its own event saying so.
 * `succeeded`: it was paid first, so the late-success refund takes over.
 */
export type CanceledPayment =
  | { status: "canceled"; paymentRef: string }
  | { status: "succeeded"; paymentRef: string };

/**
 * The provider-neutral kinds of event. `payment.failed` means the provider
 * will not complete this payment: it is final. A provider that lets a guest
 * retry after a declined attempt (Stripe's `payment_intent.payment_failed`)
 * must not report that attempt as `payment.failed`. `refund.updated` reports
 * the status of a refund TideGrid created, which carries its idempotency key
 * (W3-G2.9). `dispute.updated` reports a dispute (a chargeback) on a payment
 * TideGrid took (W3-G2.10). Every other event is `other`, recorded and ignored.
 */
export type ProviderEventType =
  | "payment.succeeded"
  | "payment.failed"
  | "refund.updated"
  | "dispute.updated"
  | "other";

/**
 * A dispute's status, neutral across providers (W3-G2.10). `needs_response`
 * and `under_review` are open; `won`, `lost`, and `closed` (an inquiry that
 * ended without a chargeback) are final.
 */
export type ProviderDisputeStatus = "needs_response" | "under_review" | "won" | "lost" | "closed";

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
  /**
   * Present for refund events: the provider's refund id, its status, the
   * idempotency key TideGrid gave it, and a failure code when it failed. Never
   * the provider's whole refund object.
   */
  readonly refund: {
    readonly ref: string;
    readonly status: "pending" | "succeeded" | "failed";
    readonly key: string;
    readonly failureCode: string | null;
  } | null;
  /**
   * Present for dispute events: the provider's dispute id, its neutral status,
   * and its reason code. The payment is the disputed one, and its amount is
   * the disputed amount. Never the provider's whole dispute object, which
   * carries the cardholder's evidence.
   */
  readonly dispute: {
    readonly ref: string;
    readonly status: ProviderDisputeStatus;
    readonly reason: string;
  } | null;
  /**
   * SHA-256, hex, of the raw body for the fake; for Stripe, a canonical
   * projection that leaves out per-delivery fields.
   */
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
  /**
   * Cancel a payment nobody has paid, so an expired or canceled checkout is
   * never charged and then refunded (W3-G2.9). Idempotent by key; a payment
   * already canceled answers canceled. Throws ProviderUnavailableError when
   * the outcome is unknown and ProviderRejectedError when the provider will
   * never cancel it.
   */
  cancelPayment(input: CancelPaymentInput): Promise<CanceledPayment>;
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

/**
 * The runtime brand (W1-PROVENANCE). Every event the minting function below
 * returned, held by identity in a WeakSet that no other module can reach. A
 * spread, a clone, a parse, a Proxy, or an object whose prototype is a real
 * event is a new object, so it is not in the set. The methods are bound when
 * this module loads, so a later change to `WeakSet.prototype` does not reach
 * them. The type brand above stays for the compiler; this is what the inbox
 * checks.
 */
const minted = new WeakSet<object>();
const mark = minted.add.bind(minted);
const isMinted = minted.has.bind(minted);

/**
 * The globals the minting function and `occurredAt` use, taken when this
 * module loads, for the same reason: code that replaces `Object.freeze`,
 * `Date`, or `Date.prototype.getTime` later cannot mint a branded event that
 * can be changed, or change the time an event reports.
 */
const freeze = Object.freeze;
const DateAtLoad = Date;
const timeOf: (date: Date) => number = Function.prototype.call.bind(Date.prototype.getTime);

/**
 * Whether `value` is an event an adapter's `verifyWebhook` built in this
 * module instance. A check only: it cannot mint. The inbox refuses anything
 * that fails it.
 */
export function isVerifiedProviderEvent(value: unknown): value is VerifiedProviderEvent {
  return typeof value === "object" && value !== null && isMinted(value);
}

/**
 * Builds a verified event. Internal to adapters: call it only after the
 * signature checks out. The event and its payment are frozen, and
 * `occurredAt` is a getter that returns a new Date on each read, so nothing
 * that holds the event can change what the inbox records. Both use the
 * globals taken at load above.
 */
export function verifiedEvent(fields: ProviderEventFields): VerifiedProviderEvent {
  const at = fields.occurredAt === null ? null : timeOf(fields.occurredAt);
  const payment = fields.payment === null ? null : freeze({ ...fields.payment });
  const refund = fields.refund === null ? null : freeze({ ...fields.refund });
  const dispute = fields.dispute === null ? null : freeze({ ...fields.dispute });
  const event = freeze({
    provider: fields.provider,
    eventId: fields.eventId,
    type: fields.type,
    providerType: fields.providerType,
    accountRef: fields.accountRef,
    get occurredAt(): Date | null {
      return at === null ? null : new DateAtLoad(at);
    },
    payment,
    refund,
    dispute,
    payloadSha256: fields.payloadSha256,
  }) as VerifiedProviderEvent;
  mark(event);
  return event;
}
