/**
 * The Stripe payment adapter (standing goal item 3, proposed; coordinator
 * default of 2026-10-28, pending the owner). Stripe Connect direct charges:
 * every call runs on the operator's connected account through the
 * `Stripe-Account` header, the operator is merchant of record, and TideGrid
 * adds no application fee. It speaks to Stripe's REST API over fetch, runs in
 * workerd and in Node, and has no SDK and no dependency.
 *
 * Until the owner approves the live step it is tested only against the
 * recorded-shape fixture in `stripe-fixture.ts`. No test reaches Stripe.
 *
 * - Fail closed on configuration: only a test key of the full shape is
 *   accepted, never a live key, and never a test key in production.
 * - Fail closed on answers: every answer is parsed, and anything that does not
 *   parse is an unknown outcome, never trusted.
 * - The key goes only into the Authorization header. No error message, code,
 *   thrown value, or cause carries it, the webhook secret, a signature, or a
 *   client secret. Stripe's own error text is never echoed.
 * - A refund settles as failed only on Stripe's answer about that refund.
 *   Authentication, permission, account, and configuration faults leave it
 *   unknown, so it stays requested for the sweep.
 *
 * API reference: https://docs.stripe.com/api
 * Direct charges: https://docs.stripe.com/connect/direct-charges
 * Errors: https://docs.stripe.com/error-low-level and https://docs.stripe.com/error-codes
 * Idempotency: https://docs.stripe.com/api/idempotent_requests
 * Webhooks: https://docs.stripe.com/webhooks and https://docs.stripe.com/connect/webhooks
 */
import {
  type CreatedPayment,
  type CreatePaymentInput,
  type PaymentCurrency,
  type PaymentProvider,
  type ProviderEventFields,
  type ProviderPayment,
  type ProviderPaymentStatus,
  type ProviderRefund,
  ProviderRejectedError,
  ProviderUnavailableError,
  type RefundPaymentInput,
  type VerifiedProviderEvent,
  type VerifyWebhookInput,
  verifiedEvent,
  type WebhookVerification,
} from "./adapter.ts";
import { DEFAULT_TOLERANCE_SECONDS, sha256Hex, verifySignature } from "./signature.ts";

/** The pinned API version (D11). The webhook endpoint is created with the same one. */
export const STRIPE_API_VERSION = "2026-09-30.endive";
export const STRIPE_API_BASE = "https://api.stripe.com";
export const STRIPE_SIGNATURE_HEADER = "stripe-signature";
/** Stripe's smallest USD charge: https://docs.stripe.com/currencies#minimum-and-maximum-charge-amounts */
export const STRIPE_MINIMUM_AMOUNT = 50;
/** Stripe's largest USD charge, in cents. */
export const STRIPE_MAXIMUM_AMOUNT = 99_999_999;
/** The refund lookup reads at most this many pages of 100 before it gives up. */
export const STRIPE_REFUND_LOOKUP_PAGES = 5;
/** Metadata key on every PaymentIntent TideGrid creates: TideGrid's payment id. */
export const STRIPE_PAYMENT_METADATA_KEY = "tidegrid_payment_id";
/** Metadata key on every Refund TideGrid creates: the refund's idempotency key. */
export const STRIPE_REFUND_METADATA_KEY = "tidegrid_refund_key";
export const STRIPE_DEFAULT_TIMEOUT_MS = 15_000;

/** A secret or restricted test key, in full. Live keys are refused until the Core live gate (D8). */
export const stripeSecretKeyPattern = /^(sk|rk)_test_[A-Za-z0-9]{24,}$/;
export const stripeWebhookSecretPattern = /^whsec_[A-Za-z0-9]{24,}$/;
const liveKeyPattern = /^(sk|rk|pk)_live_/;
/** Stripe's connected account ids: acct_ and letters and digits only. */
export const stripeAccountPattern = /^acct_[A-Za-z0-9]{1,64}$/;
export const stripePaymentIntentPattern = /^pi_[A-Za-z0-9]{1,250}$/;
export const stripeRefundPattern = /^re_[A-Za-z0-9]{1,250}$/;
export const stripeEventIdPattern = /^evt_[A-Za-z0-9]{1,250}$/;
const chargePattern = /^ch_[A-Za-z0-9]{1,250}$/;
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
/** The shape payments and payment_refunds allow (0007). */
const idempotencyKeyPattern = /^[A-Za-z0-9_:-]{8,255}$/;
/** The shape TideGrid stores a failure or refusal code in (0007). */
const codePattern = /^[a-z][a-z0-9_]{0,63}$/;
const eventTypePattern = /^[a-z][a-z0-9_.]{0,99}$/;

/**
 * Stripe error codes about the key, the platform, or the connected account,
 * not about the request (https://docs.stripe.com/error-codes). They are
 * configuration faults: retried after the fix, never final. A refund must
 * never settle as failed on one (https://docs.stripe.com/error-low-level).
 */
const configurationCodes = new Set([
  "api_key_expired",
  "platform_api_key_expired",
  "secret_key_required",
  "account_invalid",
  "livemode_mismatch",
  "platform_account_required",
  "capability_not_active",
  "action_blocked",
  "testmode_charges_only",
  "tls_version_unsupported",
  "anomalous_money_movement_request",
  "account_country_invalid_address",
  "progressive_onboarding_limit_exceeded",
]);

/** Stripe error codes that mean "not now": the same request may succeed later. */
const transientCodes = new Set([
  "lock_timeout",
  "rate_limit",
  "idempotency_key_in_use",
  "balance_insufficient",
  "charge_exceeds_source_limit",
  "payment_method_not_available",
]);

/**
 * The fixture's credentials. They fail the shape checks above on purpose, so
 * they can never configure a deployment; the constructor takes them only as a
 * pair and only with an injected fetch, which no deployment passes.
 */
const fixtureKeyPattern = /^rk_test_fixture_[A-Za-z0-9]{8,}$/;
const fixtureWebhookSecretPattern = /^whsec_fixture_[A-Za-z0-9]{8,}$/;

export type StripeConfigProblem =
  | { kind: "off"; reason: "stripe_key_missing" | "stripe_webhook_secret_missing" }
  | {
      kind: "refused";
      reason:
        | "live_key"
        | "key_malformed"
        | "stripe_test_in_production"
        | "webhook_secret_malformed";
    };

/**
 * Whether a key, webhook secret, and environment may build the adapter. Null
 * when they may. The API's settings and the constructor both apply it, so a
 * refusal holds even if one of them is bypassed.
 */
export function checkStripeConfig(input: {
  secretKey?: string | undefined;
  webhookSecret?: string | undefined;
  environment: string;
}): StripeConfigProblem | null {
  const key = input.secretKey;
  if (typeof key !== "string" || key.length === 0) {
    return { kind: "off", reason: "stripe_key_missing" };
  }
  if (liveKeyPattern.test(key)) return { kind: "refused", reason: "live_key" };
  if (!stripeSecretKeyPattern.test(key)) return { kind: "refused", reason: "key_malformed" };
  // Test cards would confirm real bookings with no money moving.
  if (input.environment === "production") {
    return { kind: "refused", reason: "stripe_test_in_production" };
  }
  const secret = input.webhookSecret;
  if (typeof secret !== "string" || secret.length === 0) {
    return { kind: "off", reason: "stripe_webhook_secret_missing" };
  }
  if (!stripeWebhookSecretPattern.test(secret)) {
    return { kind: "refused", reason: "webhook_secret_malformed" };
  }
  return null;
}

export interface StripeProviderOptions {
  /** A test key, `sk_test_` or `rk_test_` (D12). A Worker secret, never a var. */
  secretKey: string;
  /** The endpoint's signing secret, `whsec_` (D10). A Worker secret, never a var. */
  webhookSecret: string;
  /** The deployment's ENVIRONMENT; "production" is refused with a test key (D8). */
  environment: string;
  fetch?: typeof fetch;
  /** Each request's deadline. Defaults to 15000 ms. */
  requestTimeoutMs?: number;
  /** Defaults to https://api.stripe.com; anything else only with an injected fetch. */
  apiBase?: string;
  /** The signature tolerance window, clamped to 1-300 seconds. */
  toleranceSeconds?: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isAmount(value: unknown): value is number {
  return (
    typeof value === "number" &&
    Number.isInteger(value) &&
    value >= 0 &&
    value <= STRIPE_MAXIMUM_AMOUNT
  );
}

/** A Stripe code as TideGrid may store it, or null. */
function safeCode(value: unknown): string | null {
  return typeof value === "string" && codePattern.test(value) ? value : null;
}

/** The outcome is unknown. The message is a stable code and carries nothing else. */
function unavailable(code: string): ProviderUnavailableError {
  return new ProviderUnavailableError(code);
}

function malformed(): ProviderUnavailableError {
  return unavailable("stripe_malformed_response");
}

interface Refusal {
  status: number;
  code: string | null;
}

function rejected(refusal: Refusal): ProviderRejectedError {
  const code = refusal.code ?? `http_${refusal.status}`;
  return new ProviderRejectedError(code, `Stripe refused the request (${code})`);
}

interface StripeIntent {
  id: string;
  status: string;
  amount: number;
  amountReceived: number;
  currency: string;
  clientSecret: string | null;
  metadata: Record<string, unknown>;
  latestCharge: unknown;
}

function parseIntent(value: unknown): StripeIntent {
  if (!isRecord(value)) throw malformed();
  const { id, object, status, amount, amount_received, currency, client_secret, metadata } = value;
  if (
    object !== "payment_intent" ||
    typeof id !== "string" ||
    !stripePaymentIntentPattern.test(id) ||
    typeof status !== "string" ||
    !codePattern.test(status) ||
    !isAmount(amount) ||
    (amount_received !== undefined && amount_received !== null && !isAmount(amount_received)) ||
    typeof currency !== "string" ||
    !/^[a-z]{3}$/.test(currency) ||
    (client_secret !== undefined && client_secret !== null && typeof client_secret !== "string") ||
    !isRecord(metadata) ||
    // A test key never sees a live object.
    value.livemode !== false
  ) {
    throw malformed();
  }
  return {
    id,
    status,
    amount,
    amountReceived: typeof amount_received === "number" ? amount_received : 0,
    currency,
    clientSecret: typeof client_secret === "string" ? client_secret : null,
    metadata,
    latestCharge: value.latest_charge ?? null,
  };
}

/** https://docs.stripe.com/payments/paymentintents/lifecycle */
function intentStatus(status: string): ProviderPaymentStatus {
  if (status === "succeeded") return "succeeded";
  if (status === "canceled") return "failed";
  return "pending";
}

interface StripeRefund {
  id: string;
  status: string;
  amount: number;
  paymentIntent: string | null;
  key: string | null;
  failureReason: string | null;
}

function parseRefund(value: unknown): StripeRefund {
  if (!isRecord(value)) throw malformed();
  const { id, object, status, amount, currency, payment_intent, metadata, failure_reason } = value;
  if (
    object !== "refund" ||
    typeof id !== "string" ||
    !stripeRefundPattern.test(id) ||
    typeof status !== "string" ||
    !isAmount(amount) ||
    currency !== "usd" ||
    (payment_intent !== null && typeof payment_intent !== "string") ||
    (metadata !== null && metadata !== undefined && !isRecord(metadata)) ||
    (failure_reason !== null && failure_reason !== undefined && typeof failure_reason !== "string")
  ) {
    throw malformed();
  }
  const key = isRecord(metadata) ? metadata[STRIPE_REFUND_METADATA_KEY] : undefined;
  return {
    id,
    status,
    amount,
    paymentIntent: payment_intent,
    key: typeof key === "string" ? key : null,
    failureReason: typeof failure_reason === "string" ? failure_reason : null,
  };
}

/** A refund Stripe holds, as the port reports it. Pending is an unknown outcome (D3). */
function refundOutcome(refund: StripeRefund): ProviderRefund {
  switch (refund.status) {
    case "succeeded":
      return { refundRef: refund.id, status: "succeeded" };
    case "failed":
      return {
        refundRef: refund.id,
        status: "failed",
        failureCode: safeCode(refund.failureReason) ?? "refund_failed",
      };
    case "canceled":
      return {
        refundRef: refund.id,
        status: "failed",
        failureCode: safeCode(refund.failureReason) ?? "refund_canceled",
      };
    case "pending":
    case "requires_action":
      throw unavailable("stripe_refund_pending");
    default:
      throw unavailable("stripe_refund_status_unknown");
  }
}

class CanonicalDepthError extends Error {}

/** JSON with object keys sorted at every level, so a re-serialized body hashes the same. */
function canonicalJson(value: unknown, depth = 0): string {
  if (depth > 64) throw new CanonicalDepthError();
  if (Array.isArray(value)) return `[${value.map((v) => canonicalJson(v, depth + 1)).join(",")}]`;
  if (isRecord(value)) {
    const keys = Object.keys(value).sort();
    return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(value[k], depth + 1)}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

/**
 * Read a Stripe event body into neutral fields, or null when it is not a
 * snapshot Connect event TideGrid can take. Thin events carry no
 * `data.object` and are refused here.
 */
function parseStripeEvent(
  rawBody: string,
): { fields: Omit<ProviderEventFields, "payloadSha256">; projection: string } | null {
  let json: unknown;
  try {
    json = JSON.parse(rawBody);
  } catch {
    return null;
  }
  if (!isRecord(json)) return null;
  const { id, object, type, created, livemode, account, api_version, data } = json;
  if (
    typeof id !== "string" ||
    !stripeEventIdPattern.test(id) ||
    object !== "event" ||
    typeof type !== "string" ||
    !eventTypePattern.test(type) ||
    typeof created !== "number" ||
    !Number.isInteger(created) ||
    created <= 0 ||
    created > 99_999_999_999 ||
    typeof livemode !== "boolean" ||
    typeof api_version !== "string" ||
    api_version.length < 1 ||
    api_version.length > 64 ||
    !isRecord(data) ||
    !isRecord(data.object)
  ) {
    return null;
  }
  // No live event under a test key (D8).
  if (livemode !== false) return null;
  // A platform-scope event names no connected account, so no tenant owns it.
  if (typeof account !== "string" || !stripeAccountPattern.test(account)) return null;

  const intent = data.object;
  const reference = isRecord(intent.metadata)
    ? intent.metadata[STRIPE_PAYMENT_METADATA_KEY]
    : undefined;
  // Only an intent TideGrid created carries its payment id. Any other intent on
  // the account is a sale TideGrid did not make, and is recorded as other.
  const ours =
    type.startsWith("payment_intent.") &&
    intent.object === "payment_intent" &&
    typeof reference === "string" &&
    uuidPattern.test(reference);

  let kind: VerifiedProviderEvent["type"] = "other";
  let payment: VerifiedProviderEvent["payment"] = null;
  if (ours && (type === "payment_intent.succeeded" || type === "payment_intent.canceled")) {
    const succeeded = type === "payment_intent.succeeded";
    const ref = intent.id;
    const amount = succeeded ? intent.amount_received : intent.amount;
    if (
      typeof ref !== "string" ||
      !stripePaymentIntentPattern.test(ref) ||
      intent.status !== (succeeded ? "succeeded" : "canceled") ||
      !isAmount(amount) ||
      intent.currency !== "usd"
    ) {
      return null;
    }
    kind = succeeded ? "payment.succeeded" : "payment.failed";
    // A canceled intent received nothing, so its amount is the intent's, which
    // is what the payment row holds.
    payment = { ref, amount, currency: "USD", clientReference: reference };
  }
  let projection: string;
  try {
    // Leaves out pending_webhooks and request, which change between deliveries.
    projection = canonicalJson({ id, type, account, livemode, created, api_version, data });
  } catch (error) {
    if (error instanceof CanonicalDepthError) return null;
    throw error;
  }
  return {
    fields: {
      provider: "stripe",
      eventId: id,
      type: kind,
      providerType: type,
      accountRef: account,
      occurredAt: new Date(created * 1000),
      payment,
    },
    projection,
  };
}

type Sent = { ok: true; body: Record<string, unknown> } | { ok: false; refusal: Refusal };

export class StripePaymentProvider implements PaymentProvider {
  readonly name = "stripe" as const;
  readonly signatureHeader = STRIPE_SIGNATURE_HEADER;
  readonly #base: string;
  readonly #key: string;
  readonly #webhookSecret: string;
  readonly #fetch: typeof fetch;
  readonly #timeoutMs: number;
  readonly #toleranceSeconds: number;

  constructor(options: StripeProviderOptions) {
    const fixture =
      options.fetch !== undefined &&
      typeof options.secretKey === "string" &&
      fixtureKeyPattern.test(options.secretKey);
    if (fixture) {
      if (options.environment === "production") {
        throw new TypeError("the Stripe adapter is refused: stripe_test_in_production");
      }
      if (
        typeof options.webhookSecret !== "string" ||
        !fixtureWebhookSecretPattern.test(options.webhookSecret)
      ) {
        throw new TypeError("the Stripe adapter is refused: webhook_secret_malformed");
      }
    } else {
      const problem = checkStripeConfig(options);
      if (problem) throw new TypeError(`the Stripe adapter is refused: ${problem.reason}`);
    }
    const apiBase = options.apiBase ?? STRIPE_API_BASE;
    let url: URL;
    try {
      url = new URL(apiBase);
    } catch {
      throw new TypeError("the Stripe API base is not a URL");
    }
    if (
      url.protocol !== "https:" ||
      url.username !== "" ||
      url.password !== "" ||
      url.pathname !== "/" ||
      url.search !== "" ||
      url.hash !== ""
    ) {
      throw new TypeError("the Stripe API base is an https origin");
    }
    if (url.origin !== STRIPE_API_BASE && options.fetch === undefined) {
      throw new TypeError("another Stripe API base is allowed only with an injected fetch");
    }
    const timeout = options.requestTimeoutMs ?? STRIPE_DEFAULT_TIMEOUT_MS;
    if (!Number.isInteger(timeout) || timeout < 1 || timeout > 60_000) {
      throw new RangeError("the Stripe request timeout is 1 to 60000 ms");
    }
    const tolerance = options.toleranceSeconds;
    this.#toleranceSeconds =
      tolerance === undefined || !Number.isFinite(tolerance)
        ? DEFAULT_TOLERANCE_SECONDS
        : Math.min(DEFAULT_TOLERANCE_SECONDS, Math.max(1, Math.trunc(tolerance)));
    this.#base = url.origin;
    this.#key = options.secretKey;
    this.#webhookSecret = options.webhookSecret;
    // Bound to globalThis: workerd refuses a fetch called with another receiver.
    this.#fetch = options.fetch ?? ((input, init) => fetch(input, init));
    this.#timeoutMs = timeout;
  }

  /** The signature tolerance in force, after clamping. */
  get toleranceSeconds(): number {
    return this.#toleranceSeconds;
  }

  minimumAmount(_currency: PaymentCurrency): number {
    return STRIPE_MINIMUM_AMOUNT;
  }

  async createPayment(input: CreatePaymentInput): Promise<CreatedPayment> {
    if (
      !Number.isInteger(input.amount) ||
      input.amount < STRIPE_MINIMUM_AMOUNT ||
      input.amount > STRIPE_MAXIMUM_AMOUNT ||
      input.currency !== "USD"
    ) {
      throw new ProviderRejectedError("amount_invalid", "The amount is outside what Stripe takes");
    }
    this.#checkKey(input.idempotencyKey);
    if (typeof input.clientReference !== "string" || !uuidPattern.test(input.clientReference)) {
      throw new ProviderRejectedError("client_reference_invalid", "Malformed client reference");
    }
    const account = this.#checkAccount(input.accountRef);
    const form = new URLSearchParams();
    form.set("amount", String(input.amount));
    form.set("currency", "usd");
    // Card only (D5): no redirects and no asynchronous methods against the hold.
    form.append("payment_method_types[]", "card");
    form.set(`metadata[${STRIPE_PAYMENT_METADATA_KEY}]`, input.clientReference);
    const sent = await this.#send("POST", "/v1/payment_intents", account, form, {
      idempotencyKey: input.idempotencyKey,
    });
    if (!sent.ok) throw rejected(sent.refusal);
    const intent = parseIntent(sent.body);
    if (
      intent.metadata[STRIPE_PAYMENT_METADATA_KEY] !== input.clientReference ||
      intent.amount !== input.amount ||
      intent.currency !== "usd"
    ) {
      throw new ProviderRejectedError("malformed_response", "Stripe answered for another payment");
    }
    const secret = intent.clientSecret;
    if (
      secret === null ||
      !secret.startsWith(`${intent.id}_secret_`) ||
      !/^[A-Za-z0-9]{1,250}$/.test(secret.slice(intent.id.length + 8))
    ) {
      throw malformed();
    }
    return {
      paymentRef: intent.id,
      status: intentStatus(intent.status),
      amount: intent.amount,
      currency: "USD",
      amountRefunded: 0,
      clientSecret: secret,
    };
  }

  async retrievePayment(input: {
    accountRef: string;
    paymentRef: string;
  }): Promise<ProviderPayment | null> {
    if (
      typeof input.paymentRef !== "string" ||
      !stripePaymentIntentPattern.test(input.paymentRef)
    ) {
      return null;
    }
    const account = this.#checkAccount(input.accountRef);
    const search = new URLSearchParams();
    search.append("expand[]", "latest_charge");
    const sent = await this.#send(
      "GET",
      `/v1/payment_intents/${input.paymentRef}`,
      account,
      search,
    );
    if (!sent.ok) {
      if (sent.refusal.status === 404 && sent.refusal.code === "resource_missing") return null;
      throw rejected(sent.refusal);
    }
    const intent = parseIntent(sent.body);
    if (intent.id !== input.paymentRef || intent.currency !== "usd") throw malformed();
    let amountRefunded = 0;
    const charge = intent.latestCharge;
    if (charge !== null) {
      // Expanded on request, so a bare id here is an answer we did not ask for.
      if (
        !isRecord(charge) ||
        charge.object !== "charge" ||
        typeof charge.id !== "string" ||
        !chargePattern.test(charge.id) ||
        !isAmount(charge.amount_refunded) ||
        charge.amount_refunded > intent.amount
      ) {
        throw malformed();
      }
      amountRefunded = charge.amount_refunded;
    }
    return {
      paymentRef: intent.id,
      status: intentStatus(intent.status),
      amount: intent.amount,
      currency: "USD",
      amountRefunded,
    };
  }

  /**
   * Looks for the refund by its key first, then creates it. Stripe may forget
   * an idempotency key after 24 hours and run a reused one as a new request,
   * and the sweep retries a requested refund with no time limit, so the key
   * alone cannot stop a second refund. The lookup also reads the refund's
   * current status, where a replayed POST would answer the first one.
   */
  async refundPayment(input: RefundPaymentInput): Promise<ProviderRefund> {
    if (
      !Number.isInteger(input.amount) ||
      input.amount < 1 ||
      input.amount > STRIPE_MAXIMUM_AMOUNT ||
      input.currency !== "USD"
    ) {
      throw new ProviderRejectedError("amount_invalid", "The refund amount is invalid");
    }
    this.#checkKey(input.idempotencyKey);
    if (
      typeof input.paymentRef !== "string" ||
      !stripePaymentIntentPattern.test(input.paymentRef)
    ) {
      throw new ProviderRejectedError("payment_ref_invalid", "Malformed Stripe payment id");
    }
    const account = this.#checkAccount(input.accountRef);
    const found = await this.#findRefund(account, input.paymentRef, input.idempotencyKey);
    if (found) return this.#matched(found, input);

    const form = new URLSearchParams();
    form.set("payment_intent", input.paymentRef);
    form.set("amount", String(input.amount));
    form.set(`metadata[${STRIPE_REFUND_METADATA_KEY}]`, input.idempotencyKey);
    const sent = await this.#send("POST", "/v1/refunds", account, form, {
      idempotencyKey: input.idempotencyKey,
    });
    if (!sent.ok) {
      if (sent.refusal.code === "charge_already_refunded") {
        // Perhaps by this very refund, created by an attempt whose answer was
        // lost. Never final without finding out.
        const again = await this.#findRefund(account, input.paymentRef, input.idempotencyKey);
        if (again) return this.#matched(again, input);
        throw unavailable("stripe_refund_unreconciled");
      }
      throw rejected(sent.refusal);
    }
    const refund = parseRefund(sent.body);
    if (
      refund.paymentIntent !== input.paymentRef ||
      refund.key !== input.idempotencyKey ||
      refund.amount !== input.amount
    ) {
      throw malformed();
    }
    return refundOutcome(refund);
  }

  async verifyWebhook(input: VerifyWebhookInput): Promise<WebhookVerification> {
    const checked = await verifySignature({
      secret: this.#webhookSecret,
      header: input.signatureHeader,
      rawBody: input.rawBody,
      nowMs: input.nowMs,
      toleranceSeconds: this.#toleranceSeconds,
    });
    if (checked !== "ok") return { kind: "rejected", reason: checked };
    const parsed = parseStripeEvent(input.rawBody);
    if (!parsed) return { kind: "rejected", reason: "payload_invalid" };
    return {
      kind: "verified",
      event: verifiedEvent({ ...parsed.fields, payloadSha256: await sha256Hex(parsed.projection) }),
    };
  }

  #checkKey(key: unknown): void {
    if (typeof key !== "string" || !idempotencyKeyPattern.test(key)) {
      throw new ProviderRejectedError("idempotency_key_invalid", "Malformed idempotency key");
    }
  }

  /** A malformed account is TideGrid's configuration fault, never a final answer. */
  #checkAccount(accountRef: unknown): string {
    if (typeof accountRef !== "string" || !stripeAccountPattern.test(accountRef)) {
      throw unavailable("stripe_config");
    }
    return accountRef;
  }

  #matched(found: StripeRefund, input: RefundPaymentInput): ProviderRefund {
    if (found.amount !== input.amount) {
      throw new ProviderRejectedError(
        "idempotency_key_reused",
        "This idempotency key was used for another refund",
      );
    }
    return refundOutcome(found);
  }

  /** The refund carrying this key, newest first, within the page bound. */
  async #findRefund(
    account: string,
    paymentRef: string,
    key: string,
  ): Promise<StripeRefund | null> {
    let startingAfter: string | null = null;
    for (let page = 0; page < STRIPE_REFUND_LOOKUP_PAGES; page++) {
      const search = new URLSearchParams();
      search.set("payment_intent", paymentRef);
      search.set("limit", "100");
      if (startingAfter !== null) search.set("starting_after", startingAfter);
      const sent = await this.#send("GET", "/v1/refunds", account, search);
      // A refused lookup is no answer about the refund, so it is never final.
      if (!sent.ok) throw unavailable("stripe_refund_lookup_refused");
      const { object, data, has_more } = sent.body;
      if (object !== "list" || !Array.isArray(data) || typeof has_more !== "boolean") {
        throw malformed();
      }
      if (data.length > 100) throw malformed();
      let last: StripeRefund | null = null;
      for (const item of data) {
        const refund = parseRefund(item);
        if (refund.paymentIntent !== paymentRef) throw malformed();
        if (refund.key === key) return refund;
        last = refund;
      }
      if (!has_more) return null;
      if (last === null) throw malformed();
      startingAfter = last.id;
    }
    throw unavailable("stripe_refund_lookup_exhausted");
  }

  /**
   * One request. Returns the parsed body, or a refusal about the request
   * itself (400, 402, 404). Everything that leaves the outcome unknown or
   * names a configuration fault throws ProviderUnavailableError; a reused key
   * throws ProviderRejectedError. Nothing Stripe says in words is kept.
   */
  async #send(
    method: "GET" | "POST",
    path: string,
    account: string,
    params: URLSearchParams,
    options: { idempotencyKey?: string } = {},
  ): Promise<Sent> {
    const headers: Record<string, string> = {
      authorization: `Bearer ${this.#key}`,
      accept: "application/json",
      "stripe-account": account,
      "stripe-version": STRIPE_API_VERSION,
    };
    const init: RequestInit = { method, headers, signal: AbortSignal.timeout(this.#timeoutMs) };
    let url = `${this.#base}${path}`;
    if (method === "POST") {
      headers["content-type"] = "application/x-www-form-urlencoded";
      if (options.idempotencyKey !== undefined) headers["idempotency-key"] = options.idempotencyKey;
      init.body = params.toString();
    } else if ([...params.keys()].length > 0) {
      url = `${url}?${params.toString()}`;
    }
    let response: Response;
    let text: string;
    try {
      response = await this.#fetch(url, init);
      text = await response.text();
    } catch {
      // A dropped connection or a deadline: the outcome is unknown. The cause
      // is not kept, so nothing from the request can travel with the error.
      throw unavailable("stripe_unreachable");
    }
    const status = response.status;
    let json: unknown = null;
    try {
      json = JSON.parse(text);
    } catch {
      json = null;
    }
    if (status >= 200 && status < 300) {
      if (!isRecord(json)) throw malformed();
      return { ok: true, body: json };
    }
    // Stripe says whether a retry can help; when it says so, the outcome is unknown.
    if (response.headers.get("stripe-should-retry") === "true") throw unavailable("stripe_retry");
    // A request with the same key still in flight.
    if (status === 409) throw unavailable("stripe_conflict");
    if (status === 429) throw unavailable("stripe_rate_limited");
    // A 5xx leaves the outcome unknown even when Stripe says not to retry:
    // reconcile before any new attempt.
    if (status >= 500) throw unavailable("stripe_server_error");
    if (status === 401) throw unavailable("stripe_auth");
    if (status === 403) throw unavailable("stripe_config");
    const error = isRecord(json) && isRecord(json.error) ? json.error : null;
    const code = safeCode(error?.code);
    if (code !== null && configurationCodes.has(code)) throw unavailable("stripe_config");
    if (code !== null && transientCodes.has(code)) throw unavailable("stripe_retry");
    if (error?.type === "idempotency_error") {
      throw new ProviderRejectedError(
        "idempotency_key_reused",
        "This idempotency key was used for another request",
      );
    }
    if (status === 400 || status === 402 || status === 404) {
      return { ok: false, refusal: { status, code } };
    }
    throw unavailable("stripe_unexpected_status");
  }
}

export function createStripePaymentProvider(options: StripeProviderOptions): StripePaymentProvider {
  return new StripePaymentProvider(options);
}
