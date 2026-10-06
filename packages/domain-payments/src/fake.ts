/**
 * The fake payment provider: a demo stand-in for Stripe behind the neutral
 * adapter (owner decision of 2026-10-05, recorded in the demo build plan). It
 * keeps its payments, outcome events, and refunds in its own append-only
 * tables, signs its webhooks the way Stripe does, and offers demo controls
 * that settle a payment and deliver, redeliver, or hold back its event. It
 * exists only when PAYMENT_PROVIDER=fake and refuses to run in production.
 *
 * It behaves like a provider, not like a shortcut: it never touches TideGrid's
 * own tables, a payment settles once (succeeded or failed), creation and
 * refunds are idempotent by key, and the only thing it tells TideGrid is a
 * signed event, delivered to the real webhook route.
 */
import {
  type Database,
  inTenantTransaction,
  type TenantContext,
  type TenantTransaction,
} from "@tidegrid/database";
import { type Kysely, sql } from "kysely";
import { accountRefPattern, resolvePaymentAccount } from "./accounts.ts";
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
import {
  DEFAULT_TOLERANCE_SECONDS,
  sha256Hex,
  signatureHeaderValue,
  verifySignature,
} from "./signature.ts";

export const FAKE_SIGNATURE_HEADER = "fake-signature";
/** Stripe's smallest USD charge; the fake keeps the same floor so the demo meets it. */
export const FAKE_MINIMUM_AMOUNT = 50;
/** The webhook secret's shortest length. */
export const FAKE_SECRET_MIN_LENGTH = 32;

export const fakePaymentRefPattern = /^fpay_[A-Za-z0-9]{24}$/;
export const fakeEventIdPattern = /^fevt_[A-Za-z0-9]{24}$/;
const clientSecretPattern = /^(fpay_[A-Za-z0-9]{24})_secret_([A-Za-z0-9_-]{43})$/;
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const idempotencyKeyPattern = /^[A-Za-z0-9_:-]{8,255}$/;

export type FakeOutcome = "succeeded" | "failed";

export interface FakeEvent {
  id: string;
  paymentRef: string;
  type: "payment.succeeded" | "payment.failed";
  /** The exact JSON text delivered. */
  body: string;
  createdAt: string;
}

export interface FakePaymentView {
  paymentRef: string;
  accountRef: string;
  amount: number;
  currency: PaymentCurrency;
  status: ProviderPaymentStatus;
  amountRefunded: number;
  createdAt: string;
  events: FakeEvent[];
}

export interface FakeProviderOptions {
  /**
   * The fake's storage, or a function that opens it on first use, so that
   * checking a webhook signature never needs a database.
   */
  db: Kysely<Database> | (() => Kysely<Database>);
  /** Signs webhooks and derives client secrets. At least 32 characters. */
  secret: string;
  /** The deployment's ENVIRONMENT; "production" is refused. */
  environment: string;
  toleranceSeconds?: number;
}

const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";

/** 24 random letters and digits, unbiased. */
export function randomFakeSuffix(): string {
  let out = "";
  while (out.length < 24) {
    for (const b of crypto.getRandomValues(new Uint8Array(32))) {
      // 248 is the largest multiple of 62 below 256.
      if (b < 248 && out.length < 24) out += alphabet[b % 62];
    }
  }
  return out;
}

function base64url(bytes: ArrayBuffer): string {
  let binary = "";
  for (const b of new Uint8Array(bytes)) binary += String.fromCharCode(b);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

function fromBase64url(text: string): Uint8Array<ArrayBuffer> | null {
  try {
    const binary = atob(text.replaceAll("-", "+").replaceAll("_", "/"));
    const out = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
    return out;
  } catch {
    return null;
  }
}

function iso(value: Date | string): string {
  return (typeof value === "string" ? new Date(value) : value).toISOString();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Parse a fake event body. Returns null for anything that is not the fake's
 * own envelope; payment events must carry the payment object.
 */
export function parseFakeEventBody(
  rawBody: string,
): Omit<ProviderEventFields, "payloadSha256"> | null {
  let json: unknown;
  try {
    json = JSON.parse(rawBody);
  } catch {
    return null;
  }
  if (!isRecord(json)) return null;
  const { id, object, type, created, account, data } = json;
  if (
    typeof id !== "string" ||
    !fakeEventIdPattern.test(id) ||
    object !== "event" ||
    typeof type !== "string" ||
    !/^[a-z][a-z0-9_.]{0,99}$/.test(type) ||
    typeof created !== "number" ||
    !Number.isInteger(created) ||
    created <= 0 ||
    created > 99_999_999_999 ||
    typeof account !== "string" ||
    !accountRefPattern.test(account)
  ) {
    return null;
  }
  const kind = type === "payment.succeeded" || type === "payment.failed" ? type : "other";
  let payment: VerifiedProviderEvent["payment"] = null;
  if (kind !== "other") {
    const obj = isRecord(data) ? data.object : undefined;
    if (!isRecord(obj)) return null;
    const ref = obj.id;
    const amount = obj.amount;
    const currency = obj.currency;
    const clientReference = obj.client_reference ?? null;
    if (
      typeof ref !== "string" ||
      !fakePaymentRefPattern.test(ref) ||
      obj.object !== "payment" ||
      typeof amount !== "number" ||
      !Number.isInteger(amount) ||
      amount < 0 ||
      amount > 100_000_000 ||
      typeof currency !== "string" ||
      !/^[a-z]{3}$/.test(currency) ||
      (clientReference !== null &&
        (typeof clientReference !== "string" || !uuidPattern.test(clientReference)))
    ) {
      return null;
    }
    payment = { ref, amount, currency: currency.toUpperCase(), clientReference };
  }
  return {
    provider: "fake",
    eventId: id,
    type: kind,
    providerType: type,
    accountRef: account,
    occurredAt: new Date(created * 1000),
    payment,
  };
}
interface PaymentRow {
  id: string;
  tenant_id: string;
  account_ref: string;
  amount: number;
  currency: PaymentCurrency;
  idempotency_key: string;
  client_reference: string;
  created_at: Date | string;
}

export class FakePaymentProvider implements PaymentProvider {
  readonly name = "fake" as const;
  readonly signatureHeader = FAKE_SIGNATURE_HEADER;
  private readonly openDb: () => Kysely<Database>;
  private readonly secret: string;
  private readonly toleranceSeconds: number;

  private get db(): Kysely<Database> {
    return this.openDb();
  }

  constructor(options: FakeProviderOptions) {
    if (options.environment === "production") {
      throw new Error("the fake payment provider is refused in a production configuration");
    }
    if (options.secret.length < FAKE_SECRET_MIN_LENGTH) {
      throw new RangeError(
        `the fake provider's secret must be at least ${FAKE_SECRET_MIN_LENGTH} characters`,
      );
    }
    const db = options.db;
    this.openDb = typeof db === "function" ? db : () => db;
    this.secret = options.secret;
    this.toleranceSeconds = options.toleranceSeconds ?? DEFAULT_TOLERANCE_SECONDS;
  }

  minimumAmount(_currency: PaymentCurrency): number {
    return FAKE_MINIMUM_AMOUNT;
  }

  private context(tenantId: string): TenantContext {
    return { tenantId, actorType: "system", actorId: "fake-provider", requestId: null };
  }

  private async tenantOf(accountRef: string, requireActive: boolean): Promise<string> {
    let resolved: Awaited<ReturnType<typeof resolvePaymentAccount>>;
    try {
      resolved = await resolvePaymentAccount(this.db, "fake", accountRef);
    } catch (err) {
      throw new ProviderUnavailableError("the fake provider could not read its accounts", {
        cause: err,
      });
    }
    if (!resolved) throw new ProviderRejectedError("account_unknown", "No such fake account");
    if (requireActive && resolved.status !== "active") {
      throw new ProviderRejectedError("account_disabled", "This fake account cannot take payments");
    }
    return resolved.tenantId;
  }

  /** Runs storage work; anything but a refusal is an unknown outcome. */
  private async store<T>(tenantId: string, work: (trx: TenantTransaction) => Promise<T>) {
    try {
      return await inTenantTransaction(this.db, this.context(tenantId), work);
    } catch (err) {
      if (err instanceof ProviderRejectedError) throw err;
      throw new ProviderUnavailableError("the fake provider's storage failed", { cause: err });
    }
  }

  /** The client secret for a payment, derived, never stored: what the guest pays with. */
  async clientSecretFor(paymentRef: string): Promise<string> {
    const key = await crypto.subtle.importKey(
      "raw",
      new TextEncoder().encode(this.secret),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign"],
    );
    const mac = await crypto.subtle.sign(
      "HMAC",
      key,
      new TextEncoder().encode(`fake-client-secret:${paymentRef}`),
    );
    return `${paymentRef}_secret_${base64url(mac)}`;
  }

  /** Whether a client secret belongs to this payment. Constant time in the secret. */
  async checkClientSecret(paymentRef: string, clientSecret: string): Promise<boolean> {
    const match = clientSecretPattern.exec(clientSecret);
    if (!match || match[1] !== paymentRef) return false;
    const mac = fromBase64url(match[2] ?? "");
    if (mac?.length !== 32) return false;
    const key = await crypto.subtle.importKey(
      "raw",
      new TextEncoder().encode(this.secret),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["verify"],
    );
    return crypto.subtle.verify(
      "HMAC",
      key,
      mac,
      new TextEncoder().encode(`fake-client-secret:${paymentRef}`),
    );
  }

  async createPayment(input: CreatePaymentInput): Promise<CreatedPayment> {
    if (
      !Number.isInteger(input.amount) ||
      input.amount < FAKE_MINIMUM_AMOUNT ||
      input.amount > 100_000_000 ||
      input.currency !== "USD"
    ) {
      throw new ProviderRejectedError(
        "amount_invalid",
        "The amount is outside what the fake takes",
      );
    }
    if (!idempotencyKeyPattern.test(input.idempotencyKey)) {
      throw new ProviderRejectedError("idempotency_key_invalid", "Malformed idempotency key");
    }
    if (input.clientReference.length < 1 || input.clientReference.length > 255) {
      throw new ProviderRejectedError("client_reference_invalid", "Malformed client reference");
    }
    const tenantId = await this.tenantOf(input.accountRef, true);
    const row = await this.store(tenantId, async (trx) => {
      const { rows } = await sql<PaymentRow>`
        insert into fake_provider_payments
          (id, tenant_id, account_ref, amount, currency, idempotency_key, client_reference)
        values (${`fpay_${randomFakeSuffix()}`}, ${tenantId}, ${input.accountRef}, ${input.amount},
                ${input.currency}, ${input.idempotencyKey}, ${input.clientReference})
        on conflict (tenant_id, idempotency_key) do nothing
        returning id, tenant_id, account_ref, amount, currency, idempotency_key,
                  client_reference, created_at`.execute(trx);
      if (rows[0]) return rows[0];
      const { rows: existing } = await sql<PaymentRow>`
        select id, tenant_id, account_ref, amount, currency, idempotency_key, client_reference,
               created_at
          from fake_provider_payments
         where tenant_id = ${tenantId} and idempotency_key = ${input.idempotencyKey}`.execute(trx);
      const first = existing[0];
      if (!first) throw new Error("idempotent payment vanished");
      if (
        first.account_ref !== input.accountRef ||
        first.amount !== input.amount ||
        first.currency !== input.currency ||
        first.client_reference !== input.clientReference
      ) {
        throw new ProviderRejectedError(
          "idempotency_key_reused",
          "This idempotency key was used for another payment",
        );
      }
      return first;
    });
    const view = await this.retrieveIn(tenantId, row.id);
    if (!view) throw new ProviderUnavailableError("the fake payment vanished after creation");
    return {
      paymentRef: view.paymentRef,
      status: view.status,
      amount: view.amount,
      currency: view.currency,
      amountRefunded: view.amountRefunded,
      clientSecret: await this.clientSecretFor(view.paymentRef),
    };
  }

  private async retrieveIn(tenantId: string, paymentRef: string): Promise<ProviderPayment | null> {
    const view = await this.store(tenantId, (trx) => this.paymentView(trx, tenantId, paymentRef));
    return view
      ? {
          paymentRef: view.paymentRef,
          status: view.status,
          amount: view.amount,
          currency: view.currency,
          amountRefunded: view.amountRefunded,
        }
      : null;
  }

  async retrievePayment(input: {
    accountRef: string;
    paymentRef: string;
  }): Promise<ProviderPayment | null> {
    if (!fakePaymentRefPattern.test(input.paymentRef)) return null;
    const tenantId = await this.tenantOf(input.accountRef, false);
    return this.retrieveIn(tenantId, input.paymentRef);
  }

  private async paymentView(
    trx: TenantTransaction,
    tenantId: string,
    paymentRef: string,
  ): Promise<FakePaymentView | null> {
    if (!fakePaymentRefPattern.test(paymentRef)) return null;
    const { rows } = await sql<PaymentRow & { refunded: number }>`
      select p.id, p.tenant_id, p.account_ref, p.amount, p.currency, p.idempotency_key,
             p.client_reference, p.created_at,
             coalesce((select sum(r.amount) from fake_provider_refunds r
                        where r.tenant_id = p.tenant_id and r.payment_id = p.id), 0)::int
               as refunded
        from fake_provider_payments p
       where p.tenant_id = ${tenantId} and p.id = ${paymentRef}`.execute(trx);
    const row = rows[0];
    if (!row) return null;
    const { rows: events } = await sql<{
      id: string;
      payment_id: string;
      type: FakeEvent["type"];
      body: string;
      created_at: Date | string;
    }>`
      select id, payment_id, type, body, created_at from fake_provider_events
       where tenant_id = ${tenantId} and payment_id = ${paymentRef}
       order by created_at, id`.execute(trx);
    const outcome = events[0]?.type;
    return {
      paymentRef: row.id,
      accountRef: row.account_ref,
      amount: row.amount,
      currency: row.currency,
      status:
        outcome === "payment.succeeded"
          ? "succeeded"
          : outcome === "payment.failed"
            ? "failed"
            : "pending",
      amountRefunded: row.refunded,
      createdAt: iso(row.created_at),
      events: events.map((e) => ({
        id: e.id,
        paymentRef: e.payment_id,
        type: e.type,
        body: e.body,
        createdAt: iso(e.created_at),
      })),
    };
  }

  async refundPayment(input: RefundPaymentInput): Promise<ProviderRefund> {
    if (!Number.isInteger(input.amount) || input.amount < 1 || input.currency !== "USD") {
      throw new ProviderRejectedError("amount_invalid", "The refund amount is invalid");
    }
    if (!idempotencyKeyPattern.test(input.idempotencyKey)) {
      throw new ProviderRejectedError("idempotency_key_invalid", "Malformed idempotency key");
    }
    if (!fakePaymentRefPattern.test(input.paymentRef)) {
      throw new ProviderRejectedError("payment_unknown", "No such fake payment");
    }
    const tenantId = await this.tenantOf(input.accountRef, false);
    return this.store(tenantId, async (trx) => {
      // One refund decision at a time per payment, so two keys cannot both
      // pass the amount check.
      await sql`select pg_advisory_xact_lock(hashtextextended(${`tidegrid.fake_payment:${input.paymentRef}`}, 0))`.execute(
        trx,
      );
      const { rows: prior } = await sql<{ id: string; payment_id: string; amount: number }>`
        select id, payment_id, amount from fake_provider_refunds
         where tenant_id = ${tenantId} and idempotency_key = ${input.idempotencyKey}`.execute(trx);
      const replay = prior[0];
      if (replay) {
        if (replay.payment_id !== input.paymentRef || replay.amount !== input.amount) {
          throw new ProviderRejectedError(
            "idempotency_key_reused",
            "This idempotency key was used for another refund",
          );
        }
        return { refundRef: replay.id, status: "succeeded" as const };
      }
      const view = await this.paymentView(trx, tenantId, input.paymentRef);
      if (!view || view.accountRef !== input.accountRef) {
        throw new ProviderRejectedError("payment_unknown", "No such fake payment");
      }
      if (view.status !== "succeeded") {
        throw new ProviderRejectedError("payment_not_succeeded", "Only a paid payment is refunded");
      }
      if (view.amountRefunded + input.amount > view.amount) {
        throw new ProviderRejectedError("amount_exceeds_payment", "More than was paid");
      }
      const refundRef = `frf_${randomFakeSuffix()}`;
      await sql`
        insert into fake_provider_refunds (id, tenant_id, payment_id, amount, idempotency_key)
        values (${refundRef}, ${tenantId}, ${input.paymentRef}, ${input.amount},
                ${input.idempotencyKey})`.execute(trx);
      return { refundRef, status: "succeeded" as const };
    });
  }

  async verifyWebhook(input: VerifyWebhookInput): Promise<WebhookVerification> {
    const checked = await verifySignature({
      secret: this.secret,
      header: input.signatureHeader,
      rawBody: input.rawBody,
      nowMs: input.nowMs,
      toleranceSeconds: this.toleranceSeconds,
    });
    if (checked !== "ok") return { kind: "rejected", reason: checked };
    const parsed = parseFakeEventBody(input.rawBody);
    if (!parsed) return { kind: "rejected", reason: "payload_invalid" };
    return {
      kind: "verified",
      event: verifiedEvent({ ...parsed, payloadSha256: await sha256Hex(input.rawBody) }),
    };
  }

  // Demo controls -------------------------------------------------------------------
  // What a hosted payment page and the provider's dashboard would do. The API
  // exposes them only under the fake provider, to a caller holding the
  // payment's client secret at the operator's own origin.

  /** The payment as the fake sees it, with its events, in one tenant. */
  async getPayment(tenantId: string, paymentRef: string): Promise<FakePaymentView | null> {
    return this.store(tenantId, (trx) => this.paymentView(trx, tenantId, paymentRef));
  }

  /**
   * Settle a pending payment once. The outcome event is stored first, with the
   * exact body that will be delivered. A payment that already settled keeps its
   * first outcome.
   */
  async settlePayment(
    tenantId: string,
    paymentRef: string,
    outcome: FakeOutcome,
    nowMs: number,
  ): Promise<
    | { kind: "settled"; event: FakeEvent }
    | { kind: "already_settled"; event: FakeEvent }
    | { kind: "not_found" }
  > {
    if (!fakePaymentRefPattern.test(paymentRef)) return { kind: "not_found" };
    return this.store(tenantId, async (trx) => {
      const view = await this.paymentView(trx, tenantId, paymentRef);
      if (!view) return { kind: "not_found" as const };
      const { rows: owner } = await sql<{ client_reference: string }>`
        select client_reference from fake_provider_payments
         where tenant_id = ${tenantId} and id = ${paymentRef}`.execute(trx);
      const clientReference = owner[0]?.client_reference ?? null;
      const type = outcome === "succeeded" ? "payment.succeeded" : "payment.failed";
      const id = `fevt_${randomFakeSuffix()}`;
      const body = JSON.stringify({
        id,
        object: "event",
        type,
        created: Math.floor(nowMs / 1000),
        account: view.accountRef,
        data: {
          object: {
            id: view.paymentRef,
            object: "payment",
            amount: view.amount,
            currency: view.currency.toLowerCase(),
            status: outcome,
            client_reference:
              clientReference !== null && uuidPattern.test(clientReference)
                ? clientReference
                : null,
          },
        },
      });
      const { rows } = await sql<{ id: string; created_at: Date | string }>`
        insert into fake_provider_events (id, tenant_id, payment_id, type, body)
        values (${id}, ${tenantId}, ${paymentRef}, ${type}, ${body})
        on conflict (tenant_id, payment_id) do nothing
        returning id, created_at`.execute(trx);
      const inserted = rows[0];
      if (inserted) {
        return {
          kind: "settled" as const,
          event: { id, paymentRef, type, body, createdAt: iso(inserted.created_at) },
        };
      }
      const settled = await this.paymentView(trx, tenantId, paymentRef);
      const first = settled?.events[0];
      if (!first) throw new Error("settled fake payment has no event");
      return { kind: "already_settled" as const, event: first };
    });
  }

  /** One stored event of one payment, for redelivery. */
  async findEvent(
    tenantId: string,
    paymentRef: string,
    eventId: string,
  ): Promise<FakeEvent | null> {
    if (!fakeEventIdPattern.test(eventId)) return null;
    const view = await this.getPayment(tenantId, paymentRef);
    return view?.events.find((e) => e.id === eventId) ?? null;
  }

  /** The signature header for delivering a body now. Each delivery is signed afresh. */
  async signDelivery(body: string, nowMs: number): Promise<{ name: string; value: string }> {
    return {
      name: FAKE_SIGNATURE_HEADER,
      value: await signatureHeaderValue(this.secret, nowMs, body),
    };
  }
}

export function createFakePaymentProvider(options: FakeProviderOptions): FakePaymentProvider {
  return new FakePaymentProvider(options);
}
