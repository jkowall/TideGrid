/**
 * A Stripe fixture for tests: an in-memory server for the endpoints the Stripe
 * adapter calls, with direct-charge state per connected account, idempotent
 * POSTs, and signed snapshot events.
 *
 * Recorded-shape, modeled on documentation, unverified against live. The
 * bodies follow the API reference, trimmed to the fields that matter, and no
 * body here was captured from Stripe. Synthetic ids, keys, and accounts only.
 * Thin events are unsupported: they carry no `data.object`, and the adapter
 * refuses them.
 *
 * Like Stripe, a POST with an idempotency key saves its answer only once it
 * has executed: a parameter-validation error is not saved, so the same key
 * runs again once the request is fixed. A declined confirmation leaves a
 * failed charge as the intent's latest charge. One behavior is not Stripe's:
 * a call with no Stripe-Account header is refused as a test tripwire
 * (`fixture_tripwire_stripe_account_missing`), where Stripe would run it on the
 * platform account. The adapter's own check is the real guard. An account the
 * key cannot reach answers 403 `account_invalid`.
 *
 * The rules for replacing these bodies with sanitized sandbox
 * captures are in the package README, and `stripe-fixture-hygiene.test.ts`
 * enforces them.
 *
 * Reachable from outside the package only through
 * `@tidegrid/domain-payments/testing`, and never from runtime code.
 *
 * - PaymentIntents: https://docs.stripe.com/api/payment_intents/object
 * - Charges: https://docs.stripe.com/api/charges/object
 * - Refunds: https://docs.stripe.com/api/refunds/object and https://docs.stripe.com/api/refunds/list
 * - Events: https://docs.stripe.com/api/events/object
 * - Errors: https://docs.stripe.com/error-low-level and https://docs.stripe.com/error-codes
 * - Idempotency: https://docs.stripe.com/api/idempotent_requests
 * - Connect: https://docs.stripe.com/connect/direct-charges and https://docs.stripe.com/connect/webhooks
 * - Signatures: https://docs.stripe.com/webhooks#verify-manually
 */
import { signPayload } from "./signature.ts";
import {
  STRIPE_API_BASE,
  STRIPE_API_VERSION,
  STRIPE_MAXIMUM_AMOUNT,
  STRIPE_MINIMUM_AMOUNT,
} from "./stripe.ts";

// The fixture's credentials have a shape no deployment accepts: the
// configuration check refuses both as malformed in every environment, and the
// adapter takes them only as a pair over an injected fetch. None works anywhere.
/** A synthetic restricted test key, fixture-shaped. */
export const STRIPE_FIXTURE_SECRET_KEY = "rk_test_fixture_TideGridSynthetic0001";
/** A synthetic webhook signing secret, fixture-shaped. */
export const STRIPE_FIXTURE_WEBHOOK_SECRET = "whsec_fixture_TideGridSynthetic0001";
/** The two synthetic connected accounts, modeled on demo-harbor and demo-reef. */
export const STRIPE_FIXTURE_ACCOUNTS = {
  harbor: "acct_1TestHarbor0000",
  reef: "acct_1TestReef00000",
} as const;
/** Every id the fixture makes carries this marker after its prefix. */
export const STRIPE_FIXTURE_ID_MARKER = "TestFixture";
/** Every client secret the fixture makes carries this after the intent id. */
export const STRIPE_FIXTURE_CLIENT_SECRET_INFIX = "_secret_SyntheticFixture";
/** The only receipt URL a fixture body may carry. */
export const STRIPE_FIXTURE_RECEIPT_URL = "https://pay.stripe.com/receipts/placeholder";

export interface StripeRecordedRequest {
  method: string;
  path: string;
  search: [string, string][];
  /** The form body, in order. */
  form: [string, string][];
  /** Whether the Authorization header named the fixture's key. The key is not recorded. */
  authorized: boolean;
  stripeAccount: string | null;
  stripeVersion: string | null;
  idempotencyKey: string | null;
  contentType: string | null;
}

export interface StripeScriptedAnswer {
  status: number;
  body: string;
  headers?: Record<string, string>;
}

export interface StripeFixtureDelivery {
  id: string;
  type: string;
  account: string;
  /** The event as an object, before serialization. */
  payload: Record<string, unknown>;
  /** The exact bytes delivered. */
  body: string;
  /** The Stripe-Signature header value. */
  header: string;
  /** The clock the delivery was signed at, in ms. */
  nowMs: number;
}

export interface StripeEventOptions {
  /** Reuse an event id, as a redelivery does. */
  id?: string;
  account?: string;
  livemode?: boolean;
  pendingWebhooks?: number;
  /** Also sign with this secret, first, as Stripe does while a secret rolls. */
  extraV1?: string;
  /** Unix seconds for `created`; defaults to the signing clock. */
  created?: number;
  /** The signing clock in ms; defaults to the fixture's clock. */
  nowMs?: number;
  previousAttributes?: Record<string, unknown>;
  /** Pretty-printed, as Stripe sends, unless false. */
  pretty?: boolean;
}

export type StripeRefundStatus =
  | "succeeded"
  | "pending"
  | "requires_action"
  | "failed"
  | "canceled";

export interface StripeFixtureOptions {
  secretKey?: string;
  webhookSecret?: string;
  accounts?: readonly string[];
  apiBase?: string;
  /** The fixture's clock in ms. */
  now?: () => number;
}

export interface StripeFixture {
  fetch: typeof fetch;
  readonly secretKey: string;
  readonly webhookSecret: string;
  /** The synthetic accounts, whatever `accounts` the fixture was given. */
  readonly syntheticAccounts: typeof STRIPE_FIXTURE_ACCOUNTS;
  /** Every request in order, faulted ones included. */
  readonly requests: StripeRecordedRequest[];
  /** The next matching request gets this answer and is never executed. */
  answerNext(answer: StripeScriptedAnswer, match?: { method?: string; path?: string }): void;
  /**
   * The next matching request times out. With `afterExecution`, Stripe runs it
   * and only the answer is lost.
   */
  timeoutNext(options?: { afterExecution?: boolean; method?: string; path?: string }): void;
  /** The guest's card succeeds: the intent is paid and charged. Returns the intent as events carry it. */
  succeed(paymentRef: string): Record<string, unknown>;
  /** The guest's card is declined; the intent waits for another payment method. */
  decline(paymentRef: string, code?: string): Record<string, unknown>;
  /** The intent is canceled, so it will never be paid. */
  cancel(paymentRef: string): Record<string, unknown>;
  /** The next refund created is pending. */
  refundPending(): void;
  /** The next refund created takes this status. */
  refundNext(status: StripeRefundStatus, failureReason?: string): void;
  /** Move a refund to a final status, as Stripe does later. */
  settleRefund(
    refundRef: string,
    status: "succeeded" | "failed" | "canceled",
    failureReason?: string,
  ): Record<string, unknown>;
  /** Forget every idempotency key, as Stripe may after 24 hours. */
  pruneKeys(): void;
  /** Refunds made outside TideGrid (the Dashboard), newer than any before. */
  addForeignRefunds(paymentRef: string, count: number, amount?: number): void;
  /** An intent made outside TideGrid on the account, with no TideGrid metadata. */
  addForeignIntent(account: string, amount: number): Record<string, unknown>;
  intent(paymentRef: string): Record<string, unknown>;
  charge(paymentRef: string): Record<string, unknown>;
  refund(refundRef: string): Record<string, unknown>;
  /** Ids held, oldest first. */
  intentIds(): string[];
  refundIds(paymentRef?: string): string[];
  /** A signed snapshot event about `object`. */
  event(
    type: string,
    object: Record<string, unknown>,
    options?: StripeEventOptions,
  ): Promise<StripeFixtureDelivery>;
  /** The same event delivered again: re-serialized, re-signed now, `pending_webhooks` changed. */
  redeliver(
    delivery: StripeFixtureDelivery,
    changes?: { pendingWebhooks?: number; nowMs?: number; pretty?: boolean },
  ): Promise<StripeFixtureDelivery>;
}

interface Intent {
  id: string;
  account: string;
  amount: number;
  status: string;
  metadata: Record<string, string>;
  created: number;
  sequence: number;
  /** The latest charge, as latest_charge names it. */
  chargeId: string | null;
  chargeStatus: "succeeded" | "failed" | null;
  paymentMethodId: string | null;
  amountReceived: number;
  lastPaymentError: Record<string, unknown> | null;
  canceledAt: number | null;
}

interface Refund {
  id: string;
  account: string;
  intentId: string;
  chargeId: string;
  amount: number;
  status: StripeRefundStatus;
  metadata: Record<string, string>;
  failureReason: string | null;
  created: number;
  sequence: number;
  balanceTransaction: string | null;
}

type Script =
  | { kind: "answer"; answer: StripeScriptedAnswer; method?: string; path?: string }
  | { kind: "timeout"; afterExecution: boolean; method?: string; path?: string };

const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body, null, 2), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });

/** An error body as https://docs.stripe.com/api/errors shows it. */
function errorBody(type: string, code: string | null, message: string, param?: string) {
  return {
    error: {
      type,
      ...(code ? { code, doc_url: `https://docs.stripe.com/error-codes/${code}` } : {}),
      message,
      ...(param ? { param } : {}),
    },
  };
}

const activeRefund = (r: Refund) =>
  r.status === "succeeded" || r.status === "pending" || r.status === "requires_action";

export function createStripeFixture(options: StripeFixtureOptions = {}): StripeFixture {
  const secretKey = options.secretKey ?? STRIPE_FIXTURE_SECRET_KEY;
  const webhookSecret = options.webhookSecret ?? STRIPE_FIXTURE_WEBHOOK_SECRET;
  const accounts = new Set(options.accounts ?? Object.values(STRIPE_FIXTURE_ACCOUNTS));
  const base = new URL(options.apiBase ?? STRIPE_API_BASE);
  const now = options.now ?? (() => Date.now());
  const intents = new Map<string, Intent>();
  const refunds = new Map<string, Refund>();
  const keys = new Map<string, { signature: string; status: number; body: string }>();
  const scripts: Script[] = [];
  const nextRefund: { status: StripeRefundStatus; failureReason: string | null }[] = [];
  const requests: StripeRecordedRequest[] = [];
  let sequence = 0;

  const nextId = (prefix: string) => {
    sequence += 1;
    return `${prefix}_${STRIPE_FIXTURE_ID_MARKER}${String(sequence).padStart(13, "0")}`;
  };
  const seconds = () => Math.floor(now() / 1000);

  const intentOf = (paymentRef: string) => {
    const intent = intents.get(paymentRef);
    if (!intent) throw new Error(`the fixture holds no intent ${paymentRef}`);
    return intent;
  };

  const refundedOn = (intent: Intent) => {
    let total = 0;
    for (const r of refunds.values()) {
      if (r.intentId === intent.id && activeRefund(r)) total += r.amount;
    }
    return total;
  };

  /** The intent's latest charge: succeeded once paid, failed after a declined attempt. */
  const renderCharge = (intent: Intent) => {
    const paid = intent.chargeStatus === "succeeded";
    const refunded = paid ? refundedOn(intent) : 0;
    return {
      id: intent.chargeId,
      object: "charge",
      amount: intent.amount,
      amount_captured: paid ? intent.amount : 0,
      amount_refunded: refunded,
      application_fee: null,
      application_fee_amount: null,
      balance_transaction: paid ? (intent.chargeId?.replace(/^ch_/, "txn_") ?? null) : null,
      billing_details: {
        address: {
          city: null,
          country: null,
          line1: null,
          line2: null,
          postal_code: null,
          state: null,
        },
        email: null,
        name: null,
        phone: null,
      },
      captured: paid,
      created: intent.created,
      currency: "usd",
      customer: null,
      description: null,
      disputed: false,
      failure_code: paid ? null : "card_declined",
      livemode: false,
      metadata: {},
      on_behalf_of: null,
      outcome: null,
      paid,
      payment_intent: intent.id,
      payment_method: intent.paymentMethodId,
      payment_method_details: {
        card: {
          brand: "visa",
          country: "US",
          exp_month: null,
          exp_year: null,
          fingerprint: null,
          funding: "credit",
          last4: null,
          network: "visa",
        },
        type: "card",
      },
      receipt_email: null,
      receipt_number: null,
      receipt_url: STRIPE_FIXTURE_RECEIPT_URL,
      refunded: paid && refunded === intent.amount,
      status: paid ? "succeeded" : "failed",
      transfer_data: null,
      transfer_group: null,
    };
  };

  const renderIntent = (intent: Intent, expandCharge = false) => ({
    id: intent.id,
    object: "payment_intent",
    amount: intent.amount,
    amount_capturable: 0,
    amount_received: intent.amountReceived,
    application: null,
    application_fee_amount: null,
    automatic_payment_methods: null,
    canceled_at: intent.canceledAt,
    cancellation_reason: intent.canceledAt === null ? null : "abandoned",
    capture_method: "automatic",
    client_secret: `${intent.id}${STRIPE_FIXTURE_CLIENT_SECRET_INFIX}${String(intent.sequence).padStart(6, "0")}`,
    confirmation_method: "automatic",
    created: intent.created,
    currency: "usd",
    customer: null,
    description: null,
    last_payment_error: intent.lastPaymentError,
    latest_charge:
      intent.chargeId === null ? null : expandCharge ? renderCharge(intent) : intent.chargeId,
    livemode: false,
    metadata: { ...intent.metadata },
    next_action: null,
    on_behalf_of: null,
    payment_method: intent.paymentMethodId,
    payment_method_options: { card: { request_three_d_secure: "automatic" } },
    payment_method_types: ["card"],
    processing: null,
    receipt_email: null,
    review: null,
    setup_future_usage: null,
    shipping: null,
    statement_descriptor: null,
    statement_descriptor_suffix: null,
    status: intent.status,
    transfer_data: null,
    transfer_group: null,
  });

  const renderRefund = (refund: Refund) => ({
    id: refund.id,
    object: "refund",
    amount: refund.amount,
    balance_transaction: refund.balanceTransaction,
    charge: refund.chargeId,
    created: refund.created,
    currency: "usd",
    destination_details: { card: { reference_status: "pending", type: "refund" }, type: "card" },
    failure_reason: refund.failureReason,
    metadata: { ...refund.metadata },
    next_action: null,
    payment_intent: refund.intentId,
    pending_reason: refund.status === "pending" ? "processing" : null,
    reason: null,
    receipt_number: null,
    source_transfer_reversal: null,
    status: refund.status,
    transfer_reversal: null,
  });

  const storeRefund = (
    intent: Intent,
    amount: number,
    metadata: Record<string, string>,
    status: StripeRefundStatus,
    failureReason: string | null,
  ) => {
    if (!intent.chargeId) throw new Error("a refund needs a charge");
    const id = nextId("re");
    const refund: Refund = {
      id,
      account: intent.account,
      intentId: intent.id,
      chargeId: intent.chargeId,
      amount,
      status,
      metadata,
      failureReason,
      created: seconds(),
      sequence,
      balanceTransaction: status === "succeeded" ? id.replace(/^re_/, "txn_") : null,
    };
    refunds.set(id, refund);
    return refund;
  };

  /** Bracketed form keys as Stripe reads them: metadata[key] and list[]. */
  const readForm = (form: [string, string][]) => {
    const fields = new Map<string, string>();
    const metadata: Record<string, string> = {};
    const lists = new Map<string, string[]>();
    for (const [key, value] of form) {
      const meta = /^metadata\[([A-Za-z0-9_]{1,40})\]$/.exec(key);
      if (meta?.[1]) {
        metadata[meta[1]] = value;
      } else if (key.endsWith("[]")) {
        lists.set(key.slice(0, -2), [...(lists.get(key.slice(0, -2)) ?? []), value]);
      } else if (fields.has(key)) {
        return null;
      } else {
        fields.set(key, value);
      }
    }
    return { fields, metadata, lists };
  };

  /**
   * Answers refused while Stripe validates parameters, before execution. Stripe
   * saves no idempotent result for them (https://docs.stripe.com/api/idempotent_requests).
   */
  const validationFailures = new WeakSet<Response>();
  const invalid = (status: number, body: unknown) => {
    const response = json(status, body);
    validationFailures.add(response);
    return response;
  };
  const duplicate = () =>
    invalid(400, errorBody("invalid_request_error", null, "Duplicate parameter"));

  const unknownParameter = (name: string) =>
    invalid(
      400,
      errorBody(
        "invalid_request_error",
        "parameter_unknown",
        `Received unknown parameter: ${name}`,
        name,
      ),
    );

  const missing = (kind: string, id: string, param?: string) =>
    json(
      404,
      errorBody("invalid_request_error", "resource_missing", `No such ${kind}: '${id}'`, param),
    );

  const parseAmount = (value: string | undefined) =>
    value !== undefined && /^\d{1,9}$/.test(value) ? Number(value) : null;

  const execute = (
    method: string,
    path: string,
    url: URL,
    account: string,
    form: [string, string][],
  ): Response => {
    if (method === "POST" && path === "/v1/payment_intents") {
      const read = readForm(form);
      if (!read) return duplicate();
      for (const name of read.fields.keys()) {
        if (name !== "amount" && name !== "currency") return unknownParameter(name);
      }
      for (const name of read.lists.keys()) {
        if (name !== "payment_method_types") return unknownParameter(`${name}[]`);
      }
      const amount = parseAmount(read.fields.get("amount"));
      if (amount === null) {
        return invalid(
          400,
          errorBody("invalid_request_error", "parameter_missing", "Missing amount", "amount"),
        );
      }
      if (read.fields.get("currency") !== "usd") {
        return invalid(
          400,
          errorBody(
            "invalid_request_error",
            "parameter_invalid_string",
            "Bad currency",
            "currency",
          ),
        );
      }
      if (amount < STRIPE_MINIMUM_AMOUNT) {
        return invalid(
          400,
          errorBody(
            "invalid_request_error",
            "amount_too_small",
            "Amount must be at least $0.50 usd",
            "amount",
          ),
        );
      }
      if (amount > STRIPE_MAXIMUM_AMOUNT) {
        return invalid(
          400,
          errorBody(
            "invalid_request_error",
            "amount_too_large",
            "Amount must be no more than $999,999.99",
            "amount",
          ),
        );
      }
      const id = nextId("pi");
      const intent: Intent = {
        id,
        account,
        amount,
        status: "requires_payment_method",
        metadata: read.metadata,
        created: seconds(),
        sequence,
        chargeId: null,
        chargeStatus: null,
        paymentMethodId: null,
        amountReceived: 0,
        lastPaymentError: null,
        canceledAt: null,
      };
      intents.set(id, intent);
      return json(200, renderIntent(intent));
    }

    const intentPath = /^\/v1\/payment_intents\/([^/]+)$/.exec(path);
    if (method === "GET" && intentPath?.[1]) {
      const id = decodeURIComponent(intentPath[1]);
      for (const [name, value] of url.searchParams) {
        if (name !== "expand[]" || value !== "latest_charge") return unknownParameter(name);
      }
      const intent = intents.get(id);
      // Another account's intent does not exist here.
      if (!intent || intent.account !== account) return missing("payment_intent", id, "intent");
      return json(200, renderIntent(intent, url.searchParams.has("expand[]")));
    }

    if (method === "POST" && path === "/v1/refunds") {
      const read = readForm(form);
      if (!read) return duplicate();
      for (const name of read.fields.keys()) {
        if (name !== "payment_intent" && name !== "amount") return unknownParameter(name);
      }
      for (const name of read.lists.keys()) return unknownParameter(`${name}[]`);
      const id = read.fields.get("payment_intent") ?? "";
      const intent = intents.get(id);
      if (!intent || intent.account !== account) {
        return missing("payment_intent", id, "payment_intent");
      }
      if (intent.status !== "succeeded" || intent.chargeStatus !== "succeeded") {
        return json(
          400,
          errorBody(
            "invalid_request_error",
            "payment_intent_unexpected_state",
            "This PaymentIntent does not have a successful charge to refund.",
          ),
        );
      }
      const remaining = intent.amount - refundedOn(intent);
      const amount = parseAmount(read.fields.get("amount")) ?? remaining;
      if (remaining === 0) {
        return json(
          400,
          errorBody(
            "invalid_request_error",
            "charge_already_refunded",
            "Charge has already been refunded.",
          ),
        );
      }
      if (amount < 1 || amount > remaining) {
        return json(
          400,
          errorBody(
            "invalid_request_error",
            "amount_too_large",
            "Refund amount is greater than unrefunded amount on charge",
            "amount",
          ),
        );
      }
      const next = nextRefund.shift() ?? { status: "succeeded" as const, failureReason: null };
      const refund = storeRefund(intent, amount, read.metadata, next.status, next.failureReason);
      return json(200, renderRefund(refund));
    }

    if (method === "GET" && path === "/v1/refunds") {
      let intentId: string | null = null;
      let limit = 10;
      let startingAfter: string | null = null;
      for (const [name, value] of url.searchParams) {
        if (name === "payment_intent") intentId = value;
        else if (name === "limit") limit = Number(value);
        else if (name === "starting_after") startingAfter = value;
        else return unknownParameter(name);
      }
      if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
        return json(
          400,
          errorBody("invalid_request_error", "parameter_invalid_integer", "Bad limit", "limit"),
        );
      }
      if (intentId !== null) {
        const intent = intents.get(intentId);
        if (!intent || intent.account !== account) {
          return missing("payment_intent", intentId, "payment_intent");
        }
      }
      // Newest first, as Stripe lists them.
      const all = [...refunds.values()]
        .filter((r) => r.account === account && (intentId === null || r.intentId === intentId))
        .sort((a, b) => b.sequence - a.sequence);
      let start = 0;
      if (startingAfter !== null) {
        const at = all.findIndex((r) => r.id === startingAfter);
        if (at < 0) return missing("refund", startingAfter, "starting_after");
        start = at + 1;
      }
      const page = all.slice(start, start + limit);
      return json(200, {
        object: "list",
        data: page.map(renderRefund),
        has_more: start + limit < all.length,
        url: "/v1/refunds",
      });
    }

    return json(404, errorBody("invalid_request_error", null, `Unrecognized request URL`));
  };

  const handle = async (request: Request): Promise<Response> => {
    const url = new URL(request.url);
    const method = request.method.toUpperCase();
    const text = method === "POST" ? await request.text() : "";
    const form = [...new URLSearchParams(text).entries()];
    const path = url.pathname;
    const recorded: StripeRecordedRequest = {
      method,
      path,
      search: [...url.searchParams.entries()],
      form,
      authorized: request.headers.get("authorization") === `Bearer ${secretKey}`,
      stripeAccount: request.headers.get("stripe-account"),
      stripeVersion: request.headers.get("stripe-version"),
      idempotencyKey: request.headers.get("idempotency-key"),
      contentType: request.headers.get("content-type"),
    };
    requests.push(recorded);

    const index = scripts.findIndex(
      (s) =>
        (s.method === undefined || s.method === method) &&
        (s.path === undefined || s.path === path),
    );
    const script = index >= 0 ? scripts.splice(index, 1)[0] : undefined;
    if (script?.kind === "answer") {
      return new Response(script.answer.body, {
        status: script.answer.status,
        headers: script.answer.headers ?? { "content-type": "application/json" },
      });
    }
    if (script?.kind === "timeout" && !script.afterExecution) {
      throw new DOMException("The operation was aborted due to timeout", "TimeoutError");
    }

    const answer = (() => {
      if (url.origin !== base.origin) {
        return json(404, errorBody("invalid_request_error", null, "Unrecognized request URL"));
      }
      if (!recorded.authorized) {
        return json(401, errorBody("invalid_request_error", null, "Invalid API Key provided."));
      }
      if (recorded.stripeVersion !== STRIPE_API_VERSION) {
        return json(400, errorBody("invalid_request_error", null, "Invalid Stripe API version"));
      }
      const account = recorded.stripeAccount;
      // A test tripwire, not Stripe's behavior: Stripe would run this call on
      // the platform account, as a platform charge. The adapter must never send it.
      if (account === null) {
        return json(
          400,
          errorBody(
            "invalid_request_error",
            "fixture_tripwire_stripe_account_missing",
            "Fixture tripwire: every adapter call must name a connected account.",
          ),
        );
      }
      if (!accounts.has(account)) {
        return json(
          403,
          errorBody(
            "invalid_request_error",
            "account_invalid",
            "The provided key does not have access to the account in the Stripe-Account header.",
          ),
        );
      }
      if (method === "POST" && recorded.contentType !== "application/x-www-form-urlencoded") {
        return json(400, errorBody("invalid_request_error", null, "Invalid request body"));
      }
      const key = recorded.idempotencyKey;
      if (method === "POST" && key !== null) {
        const signature = `${method} ${path} ${[...form]
          .map(([k, v]) => `${k}=${v}`)
          .sort()
          .join("&")}`;
        const stored = keys.get(`${account}\u0000${key}`);
        if (stored) {
          if (stored.signature !== signature) {
            return json(
              400,
              errorBody(
                "idempotency_error",
                null,
                "Keys for idempotent requests can only be used with the same parameters they were first used with.",
              ),
            );
          }
          return new Response(stored.body, {
            status: stored.status,
            headers: { "content-type": "application/json", "idempotent-replayed": "true" },
          });
        }
        return (async () => {
          const response = execute(method, path, url, account, form);
          // Only an executed request is saved under its key.
          if (!validationFailures.has(response)) {
            const body = await response.clone().text();
            keys.set(`${account}\u0000${key}`, { signature, status: response.status, body });
          }
          return response;
        })();
      }
      return execute(method, path, url, account, form);
    })();
    const response = await answer;
    if (script?.kind === "timeout") {
      throw new DOMException("The operation was aborted due to timeout", "TimeoutError");
    }
    response.headers.set("request-id", nextId("req"));
    return response;
  };

  const sign = async (body: string, nowMs: number, extraV1?: string) => {
    const timestamp = Math.floor(nowMs / 1000);
    const parts = [`t=${timestamp}`];
    if (extraV1) parts.push(`v1=${await signPayload(extraV1, timestamp, body)}`);
    parts.push(`v1=${await signPayload(webhookSecret, timestamp, body)}`);
    return parts.join(",");
  };

  const deliver = async (
    payload: Record<string, unknown>,
    nowMs: number,
    pretty: boolean,
    extraV1?: string,
  ): Promise<StripeFixtureDelivery> => {
    const body = pretty ? JSON.stringify(payload, null, 2) : JSON.stringify(payload);
    return {
      id: String(payload.id),
      type: String(payload.type),
      account: String(payload.account),
      payload,
      body,
      header: await sign(body, nowMs, extraV1),
      nowMs,
    };
  };

  const fixtureFetch = (async (input: Request | string | URL, init?: RequestInit) =>
    handle(new Request(input, init))) as typeof fetch;

  return {
    fetch: fixtureFetch,
    secretKey,
    webhookSecret,
    syntheticAccounts: STRIPE_FIXTURE_ACCOUNTS,
    requests,
    answerNext(answer, match = {}) {
      scripts.push({
        kind: "answer",
        answer,
        ...(match.method ? { method: match.method.toUpperCase() } : {}),
        ...(match.path ? { path: match.path } : {}),
      });
    },
    timeoutNext(timeout = {}) {
      scripts.push({
        kind: "timeout",
        afterExecution: timeout.afterExecution ?? false,
        ...(timeout.method ? { method: timeout.method.toUpperCase() } : {}),
        ...(timeout.path ? { path: timeout.path } : {}),
      });
    },
    succeed(paymentRef) {
      const intent = intentOf(paymentRef);
      if (intent.status === "succeeded" || intent.status === "canceled") {
        throw new Error(`the intent is already ${intent.status}`);
      }
      intent.status = "succeeded";
      intent.amountReceived = intent.amount;
      intent.chargeId = nextId("ch");
      intent.chargeStatus = "succeeded";
      intent.paymentMethodId = nextId("pm");
      intent.lastPaymentError = null;
      return renderIntent(intent);
    },
    decline(paymentRef, code = "card_declined") {
      const intent = intentOf(paymentRef);
      if (intent.status === "succeeded" || intent.status === "canceled") {
        throw new Error(`the intent is already ${intent.status}`);
      }
      intent.status = "requires_payment_method";
      intent.chargeId = nextId("ch");
      intent.chargeStatus = "failed";
      intent.lastPaymentError = {
        type: "card_error",
        code,
        decline_code: "generic_decline",
        doc_url: `https://docs.stripe.com/error-codes/${code}`,
        message: "Your card was declined.",
      };
      return renderIntent(intent);
    },
    cancel(paymentRef) {
      const intent = intentOf(paymentRef);
      if (intent.status === "succeeded" || intent.status === "canceled") {
        throw new Error(`the intent is already ${intent.status}`);
      }
      intent.status = "canceled";
      intent.canceledAt = seconds();
      return renderIntent(intent);
    },
    refundPending() {
      nextRefund.push({ status: "pending", failureReason: null });
    },
    refundNext(status, failureReason) {
      nextRefund.push({ status, failureReason: failureReason ?? null });
    },
    settleRefund(refundRef, status, failureReason) {
      const refund = refunds.get(refundRef);
      if (!refund) throw new Error(`the fixture holds no refund ${refundRef}`);
      if (!(refund.status === "pending" || refund.status === "requires_action")) {
        throw new Error(`the refund is already ${refund.status}`);
      }
      refund.status = status;
      refund.failureReason = status === "succeeded" ? null : (failureReason ?? "unknown");
      if (status === "succeeded") refund.balanceTransaction = refund.id.replace(/^re_/, "txn_");
      return renderRefund(refund);
    },
    pruneKeys() {
      keys.clear();
    },
    addForeignRefunds(paymentRef, count, amount = 1) {
      const intent = intentOf(paymentRef);
      for (let i = 0; i < count; i++) {
        if (refundedOn(intent) + amount > intent.amount) {
          throw new Error("foreign refunds would exceed the charge");
        }
        storeRefund(intent, amount, {}, "succeeded", null);
      }
    },
    addForeignIntent(account, amount) {
      if (!accounts.has(account)) throw new Error(`the fixture knows no account ${account}`);
      const id = nextId("pi");
      const intent: Intent = {
        id,
        account,
        amount,
        status: "requires_payment_method",
        metadata: { pos_order: "synthetic" },
        created: seconds(),
        sequence,
        chargeId: null,
        chargeStatus: null,
        paymentMethodId: null,
        amountReceived: 0,
        lastPaymentError: null,
        canceledAt: null,
      };
      intents.set(id, intent);
      return renderIntent(intent);
    },
    intent(paymentRef) {
      return renderIntent(intentOf(paymentRef));
    },
    charge(paymentRef) {
      const intent = intentOf(paymentRef);
      if (!intent.chargeId) throw new Error("the intent has no charge");
      return renderCharge(intent);
    },
    refund(refundRef) {
      const refund = refunds.get(refundRef);
      if (!refund) throw new Error(`the fixture holds no refund ${refundRef}`);
      return renderRefund(refund);
    },
    intentIds() {
      return [...intents.values()].sort((a, b) => a.sequence - b.sequence).map((i) => i.id);
    },
    refundIds(paymentRef) {
      return [...refunds.values()]
        .filter((r) => paymentRef === undefined || r.intentId === paymentRef)
        .sort((a, b) => a.sequence - b.sequence)
        .map((r) => r.id);
    },
    async event(type, object, eventOptions = {}) {
      const nowMs = eventOptions.nowMs ?? now();
      const account =
        eventOptions.account ??
        (typeof object.id === "string"
          ? (intents.get(object.id)?.account ??
            refunds.get(object.id)?.account ??
            [...intents.values()].find((i) => i.chargeId === object.id)?.account)
          : undefined) ??
        STRIPE_FIXTURE_ACCOUNTS.harbor;
      const data: Record<string, unknown> = { object };
      if (eventOptions.previousAttributes) {
        data.previous_attributes = eventOptions.previousAttributes;
      }
      const payload: Record<string, unknown> = {
        id: eventOptions.id ?? nextId("evt"),
        object: "event",
        account,
        api_version: STRIPE_API_VERSION,
        created: eventOptions.created ?? Math.floor(nowMs / 1000),
        data,
        livemode: eventOptions.livemode ?? false,
        pending_webhooks: eventOptions.pendingWebhooks ?? 1,
        request: { id: null, idempotency_key: null },
        type,
      };
      return deliver(payload, nowMs, eventOptions.pretty ?? true, eventOptions.extraV1);
    },
    async redeliver(delivery, changes = {}) {
      const nowMs = changes.nowMs ?? now();
      const payload = {
        ...delivery.payload,
        pending_webhooks:
          changes.pendingWebhooks ?? Math.max(0, Number(delivery.payload.pending_webhooks) - 1),
      };
      return deliver(payload, nowMs, changes.pretty ?? true);
    },
  };
}
