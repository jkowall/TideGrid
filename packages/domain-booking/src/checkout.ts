/**
 * Checkout sessions (G2.7). Creating one turns a fresh quote into a held party,
 * an immutable order, and a pending payment record, in one tenant transaction.
 * The provider payment is created afterwards, outside any transaction, with an
 * idempotency key the payment row already carries. Nothing here marks
 * anything paid: only a verified provider event does (finalize.ts).
 *
 * Lock order: checkout session row, then the trip and its holds (the inventory
 * module's order). The quote and the client's address are serialized with
 * transaction-scoped advisory locks taken before any of those.
 */
import {
  type CheckoutSessionState,
  type Database,
  inTenantTransaction,
  isUuid,
  type TenantContext,
  type TenantTransaction,
} from "@tidegrid/database";
import {
  acquireHold,
  DEFAULT_HOLD_TTL_SECONDS,
  MIN_HOLD_TTL_SECONDS,
  type NotBookableReason,
  releaseHold,
} from "@tidegrid/domain-inventory";
import {
  getPaymentAccount,
  type PaymentProvider,
  type PaymentProviderName,
  ProviderRejectedError,
  ProviderUnavailableError,
} from "@tidegrid/domain-payments";
import { type Kysely, sql } from "kysely";
import { checkoutSecretPattern, clientKeyFor, hashCheckoutSecret } from "./secrets.ts";
import { type CheckoutSessionView, loadSessionView, record } from "./views.ts";

/** How long a checkout holds its party, unless the trip departs sooner. */
export const CHECKOUT_TTL_SECONDS = DEFAULT_HOLD_TTL_SECONDS;
/**
 * Open checkouts one client address may have at one operator at a time. A
 * script could otherwise hold every seat on a trip; this bounds it to a few
 * parties per address per checkout window, on top of the per-minute rate limit.
 */
export const MAX_OPEN_CHECKOUTS_PER_CLIENT = 3;

const ownerRefFor = (sessionId: string) => `checkout_session:${sessionId}`;

// C0 and C1 controls, which the database's [[:cntrl:]] check also refuses.
// biome-ignore lint/suspicious/noControlCharactersInRegex: the pattern exists to reject them.
const bookerNamePattern = /^[^\u0000-\u001f\u007f-\u009f]{1,120}$/;
const emailPattern = /^[\x21-\x7e]+$/;

export interface BookerDetails {
  name: string;
  email: string;
}

export interface CreateCheckoutInput {
  quoteId: string;
  /** The policy version the guest saw and accepted; must be the quote's. */
  acceptedPolicyVersion: number;
  booker: BookerDetails;
  /** The guest's capability secret. Only its hash is stored. */
  secret: string;
  /** The client's address, for the per-client limit; null when the request carried none. */
  clientAddress: string | null;
  provider: PaymentProviderName;
  /** The provider's smallest charge. */
  minimumAmount: number;
  ttlSeconds?: number;
}

export type CreateCheckoutResult =
  | { kind: "created"; session: CheckoutSessionView }
  | { kind: "quote_not_found" }
  | { kind: "quote_expired" }
  | { kind: "quote_already_used" }
  | { kind: "policy_not_accepted"; policyVersion: number }
  | { kind: "amount_too_small"; minimum: number }
  | { kind: "payments_unavailable" }
  | { kind: "too_many_checkouts"; limit: number }
  | { kind: "not_bookable"; reason: NotBookableReason }
  | { kind: "insufficient_capacity"; remaining: number };

interface QuoteRow {
  id: string;
  trip_id: string;
  product_id: string;
  party_size: number;
  policy_version: number;
  total_amount: number;
  /** Whole seconds the quote still holds its price, by the database clock; negative once lapsed. */
  remaining: number;
}

function normalizeBooker(booker: BookerDetails): BookerDetails {
  const name = booker.name.trim();
  const email = booker.email.trim().toLowerCase();
  if (!bookerNamePattern.test(name)) throw new TypeError("booker name must be 1 to 120 characters");
  if (email.length > 254 || !emailPattern.test(email) || !/^[^@]+@[^@]+\.[^@]+$/.test(email)) {
    throw new TypeError("booker email must be an ASCII address");
  }
  return { name, email };
}

/**
 * Open a checkout for a quote. In one transaction: check the quote is this
 * tenant's and still fresh by the database clock, that the guest accepted its
 * policy, and that its total is chargeable; refuse a quote already used; check
 * the operator can take payments and the client is under its limit; take the
 * hold for the quote's party, which re-checks the party against the product
 * and the trip's capacity, holds included; then write the session, the order
 * copied from the quote, and the pending payment, with audit and an event.
 * The caller claims the idempotency key first and commits.
 */
export async function createCheckoutSession(
  trx: TenantTransaction,
  ctx: TenantContext,
  input: CreateCheckoutInput,
): Promise<CreateCheckoutResult> {
  const booker = normalizeBooker(input.booker);
  const secretHash = await hashCheckoutSecret(input.secret);
  if (!isUuid(input.quoteId)) return { kind: "quote_not_found" };

  // One checkout per quote: concurrent attempts on one quote queue here, and the
  // later ones see the first one's session.
  await sql`select pg_advisory_xact_lock(hashtextextended(${`tidegrid.checkout_quote:${ctx.tenantId}:${input.quoteId}`}, 0))`.execute(
    trx,
  );
  // A quote holds its price until the earlier of its own expiry and 30 minutes
  // after the database wrote it. The checkout must end by then too, so its
  // hold lasts the shorter of the checkout window and what is left.
  const { rows: quotes } = await sql<QuoteRow>`
    select id, trip_id, product_id, party_size, policy_version, total_amount,
           floor(extract(epoch from
             least(expires_at, created_at + interval '30 minutes') - now()))::int as remaining
      from quotes
     where tenant_id = ${ctx.tenantId} and id = ${input.quoteId}`.execute(trx);
  const quote = quotes[0];
  if (!quote) return { kind: "quote_not_found" };
  const used = await trx
    .selectFrom("checkout_sessions")
    .select("id")
    .where("tenant_id", "=", ctx.tenantId)
    .where("quote_id", "=", quote.id)
    .executeTakeFirst();
  if (used) return { kind: "quote_already_used" };
  const ttlSeconds = Math.min(input.ttlSeconds ?? CHECKOUT_TTL_SECONDS, quote.remaining);
  // Less than a minute left is too little to pay in: ask for a new quote.
  if (ttlSeconds < MIN_HOLD_TTL_SECONDS) return { kind: "quote_expired" };
  if (input.acceptedPolicyVersion !== quote.policy_version) {
    return { kind: "policy_not_accepted", policyVersion: quote.policy_version };
  }
  if (quote.total_amount < input.minimumAmount) {
    return { kind: "amount_too_small", minimum: input.minimumAmount };
  }
  const account = await getPaymentAccount(trx, ctx.tenantId, input.provider);
  if (account?.status !== "active") return { kind: "payments_unavailable" };

  let clientKey: string | null = null;
  if (input.clientAddress) {
    clientKey = await clientKeyFor(ctx.tenantId, input.clientAddress);
    await sql`select pg_advisory_xact_lock(hashtextextended(${`tidegrid.checkout_client:${ctx.tenantId}:${clientKey}`}, 0))`.execute(
      trx,
    );
    const { rows } = await sql<{ open: number }>`
      select count(*)::int as open from checkout_sessions
       where tenant_id = ${ctx.tenantId} and client_key = ${clientKey}
         and state = 'open' and expires_at > now()`.execute(trx);
    if ((rows[0]?.open ?? 0) >= MAX_OPEN_CHECKOUTS_PER_CLIENT) {
      return { kind: "too_many_checkouts", limit: MAX_OPEN_CHECKOUTS_PER_CLIENT };
    }
  }

  const sessionId = crypto.randomUUID();
  const ownerRef = ownerRefFor(sessionId);
  const held = await acquireHold(trx, ctx, {
    ownerRef,
    tripId: quote.trip_id,
    partySize: quote.party_size,
    ttlSeconds,
  });
  switch (held.kind) {
    case "acquired":
      break;
    case "not_bookable":
      return { kind: "not_bookable", reason: held.reason };
    case "insufficient_capacity":
      return { kind: "insufficient_capacity", remaining: held.remaining };
    case "trip_not_found":
      // The quote's trip is a foreign key; it cannot vanish.
      throw new Error("a quote's trip was not found");
    case "existing":
    case "owner_conflict":
      throw new Error("a new checkout session already held its trip");
  }
  const hold = held.hold;

  // The session copies the hold's expiry in SQL, at full precision.
  await sql`
    insert into checkout_sessions (id, tenant_id, quote_id, trip_id, party_size, hold_id,
      policy_version, expires_at, secret_hash, client_key, booker_name, booker_email)
    select ${sessionId}, ${ctx.tenantId}, ${quote.id}, h.trip_id, h.party_size, h.id,
           ${quote.policy_version}, h.expires_at, ${secretHash}, ${clientKey}, ${booker.name},
           ${booker.email}
      from capacity_holds h
     where h.tenant_id = ${ctx.tenantId} and h.id = ${hold.id}`.execute(trx);

  const { rows: orders } = await sql<{ id: string; total_amount: number }>`
    insert into orders (tenant_id, checkout_session_id, quote_id, trip_id, product_id,
      party_size, policy_version, currency, subtotal_amount, discount_amount, fee_amount,
      tax_amount, included_tax_amount, total_amount)
    select q.tenant_id, ${sessionId}, q.id, q.trip_id, q.product_id, q.party_size,
           q.policy_version, q.currency, q.subtotal_amount, q.discount_amount, q.fee_amount,
           q.tax_amount, q.included_tax_amount, q.total_amount
      from quotes q
     where q.tenant_id = ${ctx.tenantId} and q.id = ${quote.id}
    returning id, total_amount`.execute(trx);
  const order = orders[0];
  if (!order) throw new Error("order insert returned no row");
  // Service, add-on, fee, and discount lines keep their quote line numbers;
  // tax lines follow from 201, one per rate version, in the quote's tax order.
  await sql`
    insert into order_lines (tenant_id, order_id, line_no, kind, code, name, basis, quantity,
      unit_amount, amount, discount_amount, taxable)
    select l.tenant_id, ${order.id}, l.line_no,
           case l.kind when 'ticket' then 'service' when 'charter' then 'service' else l.kind end,
           l.code, l.name, l.basis, l.quantity, l.unit_amount, l.amount, l.discount_amount,
           l.taxable
      from quote_lines l
     where l.tenant_id = ${ctx.tenantId} and l.quote_id = ${quote.id}`.execute(trx);
  await sql`
    insert into order_lines (tenant_id, order_id, line_no, kind, code, name, quantity,
      unit_amount, amount, taxable, tax_rate_id, tax_rate_version, tax_inclusive, taxable_amount)
    select t.tenant_id, ${order.id},
           (200 + row_number() over (order by r.name, t.tax_rate_id))::smallint,
           'tax', 'tax', r.name, 1, sum(t.amount)::int, sum(t.amount)::int, false,
           t.tax_rate_id, t.tax_rate_version, r.inclusive, sum(t.taxable_amount)::int
      from quote_line_taxes t
      join tax_rate_versions r
        on r.tenant_id = t.tenant_id and r.tax_rate_id = t.tax_rate_id
       and r.version = t.tax_rate_version
     where t.tenant_id = ${ctx.tenantId} and t.quote_id = ${quote.id}
     group by t.tenant_id, t.tax_rate_id, t.tax_rate_version, r.name, r.inclusive`.execute(trx);

  const paymentId = crypto.randomUUID();
  await trx
    .insertInto("payments")
    .values({
      id: paymentId,
      tenant_id: ctx.tenantId,
      checkout_session_id: sessionId,
      order_id: order.id,
      provider: input.provider,
      account_ref: account.accountRef,
      idempotency_key: `checkout_payment:${paymentId}`,
      amount: order.total_amount,
      currency: "USD",
    })
    .execute();

  const view = await loadSessionView(trx, ctx.tenantId, sessionId);
  if (!view) throw new Error("checkout session vanished inside its own transaction");
  await record(trx, ctx, {
    action: "checkout.session_opened",
    subjectType: "checkout_session",
    subjectId: sessionId,
    after: {
      state: "open",
      quoteId: quote.id,
      tripId: quote.trip_id,
      holdId: hold.id,
      orderId: order.id,
      paymentId,
      amount: order.total_amount,
      expiresAt: view.expiresAt,
    },
    topic: "checkout.session.opened",
    payload: {
      checkoutSessionId: sessionId,
      tripId: quote.trip_id,
      orderId: order.id,
      paymentId,
    },
  });
  return { kind: "created", session: view };
}

// The provider payment -----------------------------------------------------------------

export type EnsurePaymentResult =
  | { kind: "ready"; provider: PaymentProviderName; paymentRef: string; clientSecret: string }
  /** The session is no longer open, or is past its expiry; no payment is offered. */
  | { kind: "not_open"; state: CheckoutSessionState }
  /** The provider did not answer, or refused; retry later with the same request. */
  | { kind: "unavailable"; reason: string }
  | { kind: "not_found" };

interface PaymentRow {
  id: string;
  provider: PaymentProviderName;
  account_ref: string;
  idempotency_key: string;
  provider_payment_id: string | null;
  amount: number;
  state: CheckoutSessionState;
  live: boolean;
}

/**
 * Make sure the provider has this session's payment, and return what the
 * guest's browser needs to pay. Runs outside any transaction: it reads the
 * payment row, calls the provider with the row's idempotency key, and records
 * the provider's payment id once. A crash anywhere in between is repaired by
 * calling it again: the same key returns the same provider payment, so a
 * retry never creates a second one.
 */
export async function ensureProviderPayment(
  db: Kysely<Database>,
  provider: PaymentProvider,
  ctx: TenantContext,
  sessionId: string,
): Promise<EnsurePaymentResult> {
  if (!isUuid(sessionId)) return { kind: "not_found" };
  const row = await inTenantTransaction(db, ctx, async (trx) => {
    const { rows } = await sql<PaymentRow>`
      select p.id, p.provider, p.account_ref, p.idempotency_key, p.provider_payment_id,
             p.amount, s.state, s.expires_at > now() as live
        from payments p
        join checkout_sessions s on s.tenant_id = p.tenant_id and s.id = p.checkout_session_id
       where p.tenant_id = ${ctx.tenantId} and p.checkout_session_id = ${sessionId}`.execute(trx);
    return rows[0];
  });
  if (!row) return { kind: "not_found" };
  if (row.state !== "open" || !row.live) {
    return { kind: "not_open", state: row.state === "open" ? "expired" : row.state };
  }
  if (row.provider !== provider.name) {
    return { kind: "unavailable", reason: "provider_changed" };
  }
  let created: Awaited<ReturnType<PaymentProvider["createPayment"]>>;
  try {
    created = await provider.createPayment({
      accountRef: row.account_ref,
      amount: row.amount,
      currency: "USD",
      idempotencyKey: row.idempotency_key,
      clientReference: row.id,
    });
  } catch (err) {
    if (err instanceof ProviderRejectedError) return { kind: "unavailable", reason: err.code };
    if (err instanceof ProviderUnavailableError)
      return { kind: "unavailable", reason: "unavailable" };
    throw err;
  }
  if (row.provider_payment_id === null) {
    await inTenantTransaction(db, ctx, async (trx) => {
      const recorded = await trx
        .updateTable("payments")
        .set({ provider_payment_id: created.paymentRef })
        .where("tenant_id", "=", ctx.tenantId)
        .where("id", "=", row.id)
        .where("provider_payment_id", "is", null)
        .executeTakeFirst();
      if (recorded.numUpdatedRows === 1n) {
        await record(trx, ctx, {
          action: "payment.provider_recorded",
          subjectType: "payment",
          subjectId: row.id,
          before: { providerPaymentId: null },
          after: { providerPaymentId: created.paymentRef },
        });
        return;
      }
      // A webhook recorded it first; it must be the same payment.
      const now = await trx
        .selectFrom("payments")
        .select("provider_payment_id")
        .where("tenant_id", "=", ctx.tenantId)
        .where("id", "=", row.id)
        .executeTakeFirstOrThrow();
      if (now.provider_payment_id !== created.paymentRef) {
        throw new Error("the provider returned another payment for the same idempotency key");
      }
    });
  } else if (row.provider_payment_id !== created.paymentRef) {
    throw new Error("the provider returned another payment for the same idempotency key");
  }
  return {
    kind: "ready",
    provider: provider.name,
    paymentRef: created.paymentRef,
    clientSecret: created.clientSecret,
  };
}

// Guest reads and cancellation --------------------------------------------------------

/** A session by its id and the guest's secret; anything else reads as nothing. */
export async function getCheckoutSession(
  trx: TenantTransaction,
  tenantId: string,
  input: { sessionId: string; secret: string },
): Promise<CheckoutSessionView | null> {
  if (!checkoutSecretPattern.test(input.secret)) return null;
  return loadSessionView(trx, tenantId, input.sessionId, await hashCheckoutSecret(input.secret));
}

export type CancelCheckoutResult =
  | { kind: "canceled"; session: CheckoutSessionView }
  /** Already canceled; nothing changed. */
  | { kind: "unchanged"; session: CheckoutSessionView }
  /** Confirmed, failed, expired, or unfulfilled; it cannot be canceled. */
  | { kind: "not_cancelable"; session: CheckoutSessionView }
  | { kind: "not_found" };

/**
 * The guest abandons an open checkout: its hold is released at once, so the
 * party can be quoted again without its own hold counting against it, and its
 * order is void. A payment that succeeds later anyway is refunded in full
 * (finalize.ts). Idempotent.
 */
export async function cancelCheckoutSession(
  trx: TenantTransaction,
  ctx: TenantContext,
  input: { sessionId: string; secret: string },
): Promise<CancelCheckoutResult> {
  if (!isUuid(input.sessionId) || !checkoutSecretPattern.test(input.secret)) {
    return { kind: "not_found" };
  }
  const secretHash = await hashCheckoutSecret(input.secret);
  const { rows } = await sql<{ id: string; state: CheckoutSessionState; hold_id: string }>`
    select id, state, hold_id from checkout_sessions
     where tenant_id = ${ctx.tenantId} and id = ${input.sessionId} and secret_hash = ${secretHash}
       for update`.execute(trx);
  const session = rows[0];
  if (!session) return { kind: "not_found" };
  const current = async () => {
    const view = await loadSessionView(trx, ctx.tenantId, session.id);
    if (!view) throw new Error("checkout session vanished inside its own transaction");
    return view;
  };
  if (session.state === "canceled") return { kind: "unchanged", session: await current() };
  if (session.state !== "open") return { kind: "not_cancelable", session: await current() };

  const released = await releaseHold(trx, ctx, {
    holdId: session.hold_id,
    ownerRef: ownerRefFor(session.id),
    reason: "checkout canceled by the guest",
  });
  if (released.kind === "not_found") throw new Error("a checkout session's hold was not found");
  await trx
    .updateTable("orders")
    .set({ status: "void" })
    .where("tenant_id", "=", ctx.tenantId)
    .where("checkout_session_id", "=", session.id)
    .where("status", "=", "pending")
    .execute();
  await trx
    .updateTable("checkout_sessions")
    .set({ state: "canceled" })
    .where("tenant_id", "=", ctx.tenantId)
    .where("id", "=", session.id)
    .where("state", "=", "open")
    .execute();
  await record(trx, ctx, {
    action: "checkout.session_canceled",
    subjectType: "checkout_session",
    subjectId: session.id,
    before: { state: "open" },
    after: { state: "canceled", orderStatus: "void" },
    topic: "checkout.session.canceled",
    payload: { checkoutSessionId: session.id },
  });
  return { kind: "canceled", session: await current() };
}

export { ownerRefFor };
