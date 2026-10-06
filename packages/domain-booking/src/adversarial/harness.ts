/**
 * Shared helpers for the G2.7 adversarial suites (Node only, integration
 * tests). Every call under test runs as tidegrid_app over real PostgreSQL
 * connections. The admin connection builds fixtures, makes time pass by moving
 * expiries earlier, and reads stored state. Nothing is mocked: events reach
 * checkout only after the fake provider signs them and the adapter verifies
 * them.
 *
 * Race size comes from the environment: RACE_ROUNDS (default 2) rounds per
 * race and RACE_SESSIONS (default 10) concurrent sessions per round. Every
 * race prints one RACE_STATS line, and appends it to RACE_STATS_FILE when set.
 */
import { randomBytes, randomUUID } from "node:crypto";
import { appendFileSync } from "node:fs";
import {
  type createDb,
  inTenantTransaction,
  type TenantContext,
  type TenantTransaction,
} from "@tidegrid/database";
import {
  FAKE_MINIMUM_AMOUNT,
  type FakePaymentProvider,
  type PaymentProvider,
  ProviderRejectedError,
  ProviderUnavailableError,
} from "@tidegrid/domain-payments";
import type postgres from "postgres";
import {
  type CreateCheckoutInput,
  createCheckoutSession,
  ensureProviderPayment,
  expireCheckoutSessions,
  type HandledEvent,
  handleVerifiedEvent,
} from "../index.ts";
import {
  type CheckoutFixture,
  createCheckoutFixture,
  guestContext,
  newSecret,
  quoteFor,
  verifiedFakeEvent,
} from "../test-fixtures.ts";

export type Sql = ReturnType<typeof postgres>;
export type Runtime = ReturnType<typeof createDb>;
export type Db = Runtime["db"];
export type Quote = Awaited<ReturnType<typeof quoteFor>>;

function envInt(name: string, fallback: number, min: number, max: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new RangeError(`${name} must be a whole number from ${min} to ${max}`);
  }
  return value;
}

export const RACE_ROUNDS = envInt("RACE_ROUNDS", 2, 1, 40);
export const RACE_SESSIONS = envInt("RACE_SESSIONS", 10, 4, 40);

/** A test timeout that grows with the number of rounds. */
export function raceTimeout(perRoundMs: number): number {
  return 120_000 + RACE_ROUNDS * perRoundMs;
}

/** Fixture days so that every round of every race in one file gets fresh trips. */
export function daysFor(tripsPerRound: number, extra = 12): number {
  return Math.max(40, RACE_ROUNDS * tripsPerRound + extra);
}

export const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** A promise that one side opens and others wait on. */
export function gate() {
  let open!: () => void;
  const opened = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { open, opened };
}

/**
 * Releases every party at once when the last one arrives. Times out instead of
 * hanging when a party never arrives, for example when a pool is too small.
 */
export function barrier(parties: number, timeoutMs = 90_000) {
  let arrived = 0;
  let open!: () => void;
  let fail!: (error: Error) => void;
  const opened = new Promise<void>((resolve, reject) => {
    open = resolve;
    fail = reject;
  });
  opened.catch(() => {});
  const timer = setTimeout(
    () => fail(new Error(`barrier: ${arrived} of ${parties} parties arrived in ${timeoutMs} ms`)),
    timeoutMs,
  );
  opened.then(
    () => clearTimeout(timer),
    () => clearTimeout(timer),
  );
  return {
    opened,
    arrive(): Promise<void> {
      arrived += 1;
      if (arrived === parties) open();
      return opened;
    },
  };
}

export type Outcome<T> =
  | { ok: true; value: T }
  | { ok: false; code: string; constraint: string | null; message: string };

/** Resolve to the value or to the error's SQLSTATE and constraint, never throw. */
export async function settle<T>(p: Promise<T>): Promise<Outcome<T>> {
  try {
    return { ok: true, value: await p };
  } catch (err) {
    const e = err as { code?: unknown; constraint_name?: unknown; message?: unknown };
    return {
      ok: false,
      code: typeof e.code === "string" ? e.code : "no-code",
      constraint: typeof e.constraint_name === "string" ? e.constraint_name : null,
      message: String(e.message ?? err),
    };
  }
}

/**
 * Start `fn` once `start` opens, after `delayMs`, and settle it. Each call is
 * started lazily and settled, so no rejection can arrive before its handler.
 */
export function startAt<T>(
  start: Promise<void>,
  fn: () => Promise<T>,
  delayMs = 0,
): Promise<Outcome<T>> {
  return settle(
    start.then(async () => {
      if (delayMs > 0) await sleep(delayMs);
      return fn();
    }),
  );
}

export function errorsOf<T>(outcomes: readonly Outcome<T>[]) {
  return outcomes.flatMap((o) => (o.ok ? [] : [o]));
}

export function valuesOf<T>(outcomes: readonly Outcome<T>[]): T[] {
  return outcomes.flatMap((o) => (o.ok ? [o.value] : []));
}

/** The database error expected from `p`: its SQLSTATE and constraint. */
export async function refusal(
  p: Promise<unknown>,
): Promise<{ code: string; constraint: string | null }> {
  const settled = await settle(p);
  if (settled.ok) throw new Error("expected a database refusal, and the statement succeeded");
  return { code: settled.code, constraint: settled.constraint };
}

// Contexts and fixtures ----------------------------------------------------------------

export interface World {
  admin: Sql;
  db: Db;
  provider: FakePaymentProvider;
}

export function asGuest<T>(
  db: Db,
  tenantId: string,
  fn: (trx: TenantTransaction, ctx: TenantContext) => Promise<T>,
): Promise<T> {
  const ctx = guestContext(tenantId);
  return inTenantTransaction(db, ctx, (trx) => fn(trx, ctx));
}

export function systemCtx(tenantId: string, actorId = "adversary"): TenantContext {
  return { tenantId, actorType: "system", actorId, requestId: `adv-${randomUUID()}` };
}

export function sweepCtx(tenantId: string): TenantContext {
  return {
    tenantId,
    actorType: "system",
    actorId: "checkout-sweep",
    requestId: `sweep-${randomUUID()}`,
  };
}

/** The sweep's first step for one tenant, exactly as sweepCheckouts runs it. */
export function expireTenant(db: Db, tenantId: string, limit = 100) {
  const ctx = sweepCtx(tenantId);
  return inTenantTransaction(db, ctx, (trx) => expireCheckoutSessions(trx, ctx, { limit }));
}

/**
 * Hands out unused fixture trips, building another synthetic tenant through
 * the real services whenever the current ones run out. Calls are serialized,
 * so concurrent callers never build a tenant twice.
 */
export function tripPool(world: World, label: string, days = 40) {
  const fixtures: CheckoutFixture[] = [];
  const used = { shared: 0, charter: 0 };
  let queue: Promise<unknown> = Promise.resolve();
  const take = (kind: "shared" | "charter") => {
    const next = queue.then(async () => {
      const n = used[kind];
      used[kind] += 1;
      const index = Math.floor(n / days);
      while (fixtures.length <= index) {
        fixtures.push(
          await createCheckoutFixture(world.admin, world.db, `${label}${fixtures.length}`, {
            days,
          }),
        );
      }
      const tenant = fixtures[index];
      const tripId = tenant?.trips[kind][n % days];
      if (!tenant || !tripId) throw new Error(`no ${kind} trip ${n}`);
      return { tenant, tripId };
    });
    queue = next.catch(() => undefined);
    return next;
  };
  return {
    shared: () => take("shared"),
    charter: () => take("charter"),
    tenants: () => [...fixtures],
  };
}

export function checkoutInput(
  quote: Quote,
  secret: string,
  clientAddress: string | null = null,
): CreateCheckoutInput {
  return {
    quoteId: quote.quoteId,
    acceptedPolicyVersion: quote.policy.version,
    booker: { name: "Synthetic Booker", email: "synthetic.booker@example.test" },
    secret,
    clientAddress,
    provider: "fake",
    minimumAmount: FAKE_MINIMUM_AMOUNT,
  };
}

export interface Opened {
  tenant: CheckoutFixture;
  tripId: string;
  party: number;
  quoteId: string;
  sessionId: string;
  secret: string;
  amount: number;
  paymentId: string;
  paymentKey: string;
  holdId: string;
  /** Null until ensureProviderPayment, or a webhook, records it. */
  paymentRef: string | null;
  clientSecret: string | null;
}

export async function paymentRowOf(admin: Sql, sessionId: string) {
  const [row] = await admin<
    {
      id: string;
      idempotency_key: string;
      amount: number;
      provider_payment_id: string | null;
      hold_id: string;
    }[]
  >`
    select p.id, p.idempotency_key, p.amount, p.provider_payment_id, s.hold_id
      from public.payments p
      join public.checkout_sessions s on s.id = p.checkout_session_id
     where s.id = ${sessionId}`;
  if (!row) throw new Error(`no payment for checkout ${sessionId}`);
  return row;
}

/** A created checkout as an Opened record, its provider payment created unless told otherwise. */
export async function describeOpened(
  world: World,
  tenant: CheckoutFixture,
  quote: Quote,
  secret: string,
  sessionId: string,
  amount: number,
  ensure: boolean,
): Promise<Opened> {
  const row = await paymentRowOf(world.admin, sessionId);
  let paymentRef: string | null = null;
  let clientSecret: string | null = null;
  if (ensure) {
    const ready = await ensureProviderPayment(
      world.db,
      world.provider,
      guestContext(tenant.id),
      sessionId,
    );
    if (ready.kind !== "ready") throw new Error(`setup payment: ${JSON.stringify(ready)}`);
    paymentRef = ready.paymentRef;
    clientSecret = ready.clientSecret;
  }
  return {
    tenant,
    tripId: quote.tripId,
    party: quote.partySize,
    quoteId: quote.quoteId,
    sessionId,
    secret,
    amount,
    paymentId: row.id,
    paymentKey: row.idempotency_key,
    holdId: row.hold_id,
    paymentRef,
    clientSecret,
  };
}

/** A quote and an open checkout on it through the real services. */
export async function openCheckout(
  world: World,
  tenant: CheckoutFixture,
  tripId: string,
  party: number,
  options: {
    charter?: boolean;
    clientAddress?: string | null;
    ensure?: boolean;
    quote?: Quote;
  } = {},
): Promise<Opened> {
  const quote =
    options.quote ??
    (await quoteFor(world.db, tenant.id, tripId, party, { charter: options.charter ?? false }));
  const secret = newSecret();
  const created = await asGuest(world.db, tenant.id, (trx, ctx) =>
    createCheckoutSession(trx, ctx, checkoutInput(quote, secret, options.clientAddress ?? null)),
  );
  if (created.kind !== "created") throw new Error(`setup checkout: ${JSON.stringify(created)}`);
  return describeOpened(
    world,
    tenant,
    quote,
    secret,
    created.session.id,
    created.session.amount,
    options.ensure ?? true,
  );
}

// Events ---------------------------------------------------------------------------

/** A fake event id: fevt_ and 24 letters and digits. */
export function fakeEventId(): string {
  let suffix = "";
  while (suffix.length < 24) {
    suffix += randomBytes(24)
      .toString("base64")
      .replace(/[^A-Za-z0-9]/g, "");
  }
  return `fevt_${suffix.slice(0, 24)}`;
}

/** A fake payment reference that no payment has: fpay_ and 24 letters and digits. */
export function fakePaymentRef(): string {
  return `fpay_${fakeEventId().slice(5)}`;
}

/**
 * A fake event body for any payment, signed later the only way the system
 * accepts: by the fake provider's secret. Used for events a misbehaving or
 * reordering provider might send. Unlike the fixture's helper, the currency
 * and the type are free.
 */
export function eventBody(input: {
  type: string;
  accountRef: string;
  paymentRef: string;
  amount: number;
  clientReference: string | null;
  currency?: string;
  eventId?: string;
}): string {
  return JSON.stringify({
    id: input.eventId ?? fakeEventId(),
    object: "event",
    type: input.type,
    created: Math.floor(Date.now() / 1000),
    account: input.accountRef,
    data: {
      object: {
        id: input.paymentRef,
        object: "payment",
        amount: input.amount,
        currency: input.currency ?? "usd",
        status: input.type === "payment.failed" ? "failed" : "succeeded",
        client_reference: input.clientReference,
      },
    },
  });
}

/** A success or failure body for one opened checkout, with any field overridden. */
export function bodyFor(
  opened: Opened,
  type: "payment.succeeded" | "payment.failed",
  overrides: {
    amount?: number;
    currency?: string;
    paymentRef?: string;
    clientReference?: string | null;
    accountRef?: string;
    eventId?: string;
  } = {},
): string {
  const paymentRef = overrides.paymentRef ?? opened.paymentRef;
  if (!paymentRef) throw new Error("the checkout has no provider payment yet");
  return eventBody({
    type,
    accountRef: overrides.accountRef ?? opened.tenant.accountRef,
    paymentRef,
    amount: overrides.amount ?? opened.amount,
    clientReference:
      overrides.clientReference === undefined ? opened.paymentId : overrides.clientReference,
    ...(overrides.currency === undefined ? {} : { currency: overrides.currency }),
    ...(overrides.eventId === undefined ? {} : { eventId: overrides.eventId }),
  });
}

/** Settle the fake payment (the guest pays at the provider) without delivering its event. */
export async function settleFake(
  world: World,
  opened: Opened,
  outcome: "succeeded" | "failed",
): Promise<{ id: string; body: string }> {
  if (!opened.paymentRef) throw new Error("the checkout has no provider payment yet");
  const settled = await world.provider.settlePayment(
    opened.tenant.id,
    opened.paymentRef,
    outcome,
    Date.now(),
  );
  if (settled.kind === "not_found") throw new Error("no fake payment to settle");
  return { id: settled.event.id, body: settled.event.body };
}

/** Sign, verify, and hand an event body to the webhook path, as the route does. */
export async function deliver(
  world: World,
  body: string,
  provider: PaymentProvider = world.provider,
): Promise<HandledEvent> {
  const event = await verifiedFakeEvent(world.provider, body);
  return handleVerifiedEvent(world.db, provider, event, { requestId: `wh-${randomUUID()}` });
}

export function outcomeOf(handled: HandledEvent): string {
  return handled.kind === "processed" ? handled.outcome : handled.kind;
}

// A provider that loses answers ------------------------------------------------------

type Failure = "never" | "before" | "after";

/**
 * The fake provider behind the same interface, made to fail on demand: a
 * failure "before" never reaches the fake; one "after" reaches it and then
 * loses the answer, as a timeout would. Either is ProviderUnavailableError, an
 * unknown outcome. "reject" makes the provider refuse outright.
 */
export class FlakyProvider implements PaymentProvider {
  readonly name = "fake" as const;
  readonly signatureHeader: string;
  failCreate: Failure = "never";
  failRefund: Failure | "reject" = "never";
  readonly calls = { create: 0, refund: 0 };

  constructor(private readonly real: FakePaymentProvider) {
    this.signatureHeader = real.signatureHeader;
  }

  minimumAmount(currency: Parameters<PaymentProvider["minimumAmount"]>[0]): number {
    return this.real.minimumAmount(currency);
  }

  async createPayment(input: Parameters<PaymentProvider["createPayment"]>[0]) {
    this.calls.create += 1;
    if (this.failCreate === "before") throw new ProviderUnavailableError("simulated timeout");
    const created = await this.real.createPayment(input);
    if (this.failCreate === "after") throw new ProviderUnavailableError("simulated lost answer");
    return created;
  }

  retrievePayment(input: Parameters<PaymentProvider["retrievePayment"]>[0]) {
    return this.real.retrievePayment(input);
  }

  async refundPayment(input: Parameters<PaymentProvider["refundPayment"]>[0]) {
    this.calls.refund += 1;
    if (this.failRefund === "reject") {
      throw new ProviderRejectedError("simulated_refusal", "simulated refusal");
    }
    if (this.failRefund === "before") throw new ProviderUnavailableError("simulated timeout");
    const refunded = await this.real.refundPayment(input);
    if (this.failRefund === "after") throw new ProviderUnavailableError("simulated lost answer");
    return refunded;
  }

  verifyWebhook(input: Parameters<PaymentProvider["verifyWebhook"]>[0]) {
    return this.real.verifyWebhook(input);
  }
}

// Time ---------------------------------------------------------------------------------

/**
 * Make time pass for checkouts: move each session's expiry and its hold's
 * expiry earlier together, in one statement, so they share one instant. Admin
 * only; the database refuses later.
 */
export async function backdateMany(
  admin: Sql,
  sessionIds: readonly string[],
  seconds = 5,
): Promise<void> {
  if (sessionIds.length === 0) return;
  const rows = await admin`
    with s as (
      update public.checkout_sessions
         set expires_at = least(expires_at, now() - make_interval(secs => ${seconds}))
       where id in ${admin(sessionIds as string[])}
      returning hold_id, expires_at)
    update public.capacity_holds h
       set expires_at = least(h.expires_at, s.expires_at)
      from s
     where h.id = s.hold_id
    returning h.id`;
  if (rows.length !== sessionIds.length) throw new Error("not every checkout was backdated");
}

// Stored state -------------------------------------------------------------------------

export interface CheckoutState {
  session: string;
  hold: string;
  order: string;
  payment: string;
  providerPaymentId: string | null;
  bookings: number;
  reacquired: boolean | null;
  refund: string | null;
  refundFailure: string | null;
  refundKey: string | null;
  providerRefundId: string | null;
  exceptions: string[];
  fakeRefunds: number;
  fakeRefunded: number;
}

export async function stateOf(admin: Sql, sessionId: string): Promise<CheckoutState> {
  const [row] = await admin<
    {
      session: string;
      hold: string;
      order: string;
      payment: string;
      provider_payment_id: string | null;
      bookings: number;
      reacquired: boolean | null;
      refund: string | null;
      refund_failure: string | null;
      refund_key: string | null;
      provider_refund_id: string | null;
      exceptions: string[];
      fake_refunds: number;
      fake_refunded: number;
    }[]
  >`
    select s.state as session, h.state as hold, o.status as order, p.state as payment,
           p.provider_payment_id,
           (select count(*)::int from public.bookings b where b.checkout_session_id = s.id)
             as bookings,
           (select b.reacquired from public.bookings b where b.checkout_session_id = s.id)
             as reacquired,
           r.state as refund, r.failure_code as refund_failure, r.idempotency_key as refund_key,
           r.provider_refund_id,
           coalesce((select array_agg(e.reason order by e.created_at, e.id)
                       from public.finalization_exceptions e
                      where e.checkout_session_id = s.id), '{}'::text[]) as exceptions,
           (select count(*)::int from public.fake_provider_refunds f
             where f.tenant_id = s.tenant_id and f.payment_id = p.provider_payment_id)
             as fake_refunds,
           coalesce((select sum(f.amount)::int from public.fake_provider_refunds f
                      where f.tenant_id = s.tenant_id and f.payment_id = p.provider_payment_id), 0)
             as fake_refunded
      from public.checkout_sessions s
      join public.capacity_holds h on h.id = s.hold_id
      join public.orders o on o.checkout_session_id = s.id
      join public.payments p on p.checkout_session_id = s.id
      left join public.payment_refunds r on r.payment_id = p.id
     where s.id = ${sessionId}`;
  if (!row) throw new Error(`no checkout ${sessionId}`);
  return {
    session: row.session,
    hold: row.hold,
    order: row.order,
    payment: row.payment,
    providerPaymentId: row.provider_payment_id,
    bookings: row.bookings,
    reacquired: row.reacquired,
    refund: row.refund,
    refundFailure: row.refund_failure,
    refundKey: row.refund_key,
    providerRefundId: row.provider_refund_id,
    exceptions: row.exceptions,
    fakeRefunds: row.fake_refunds,
    fakeRefunded: row.fake_refunded,
  };
}

/** The checkout session's audit actions, oldest first. */
export async function sessionTrail(admin: Sql, sessionId: string): Promise<string[]> {
  const rows = await admin<{ action: string }[]>`
    select action from public.audit_events
     where subject_type = 'checkout_session' and subject_id = ${sessionId}
     order by id`;
  return rows.map((r) => r.action);
}

/** How many audit rows name a subject with an action. */
export async function auditCount(admin: Sql, subjectId: string, action: string): Promise<number> {
  const [row] = await admin<{ n: number }[]>`
    select count(*)::int as n from public.audit_events
     where subject_id = ${subjectId} and action = ${action}`;
  return row?.n ?? 0;
}

interface LedgerRow {
  id: string;
  state: string;
  lapsed: boolean;
  hold: string;
  hold_matches: boolean;
  order_status: string;
  total_amount: number;
  payment: string;
  amount: number;
  provider_payment_id: string | null;
  bookings: number;
  bad_bookings: number;
  refunds: number;
  refund_state: string | null;
  refund_amount: number | null;
  refund_exceptions: number;
  fake_refunded: number;
  fake_payments: number;
  fake_payment_key_matches: boolean | null;
}

/**
 * Every checkout of the given tenants against the chain of custody, as stored:
 * each state has exactly its evidence, a payment never has both a booking and
 * a refund, and the fake provider moved exactly the money the ledger says.
 * Returns the problems found; an empty list is a clean ledger.
 */
export async function auditLedger(admin: Sql, tenantIds: readonly string[]): Promise<string[]> {
  if (tenantIds.length === 0) return [];
  const rows = await admin<LedgerRow[]>`
    select s.id, s.state, s.expires_at <= now() as lapsed,
           h.state as hold,
           (h.trip_id = s.trip_id and h.party_size = s.party_size
            and h.owner_ref = 'checkout_session:' || s.id::text) as hold_matches,
           o.status as order_status, o.total_amount,
           p.state as payment, p.amount, p.provider_payment_id,
           (select count(*)::int from public.bookings b
             where b.tenant_id = s.tenant_id and b.checkout_session_id = s.id) as bookings,
           (select count(*)::int from public.bookings b
             where b.tenant_id = s.tenant_id and b.checkout_session_id = s.id
               and (b.trip_id <> s.trip_id or b.party_size <> s.party_size
                    or b.hold_id <> s.hold_id or b.payment_id <> p.id or b.order_id <> o.id))
             as bad_bookings,
           (select count(*)::int from public.payment_refunds r
             where r.tenant_id = s.tenant_id and r.payment_id = p.id) as refunds,
           (select r.state from public.payment_refunds r
             where r.tenant_id = s.tenant_id and r.payment_id = p.id) as refund_state,
           (select r.amount from public.payment_refunds r
             where r.tenant_id = s.tenant_id and r.payment_id = p.id) as refund_amount,
           (select count(*)::int from public.finalization_exceptions e
             where e.tenant_id = s.tenant_id and e.checkout_session_id = s.id
               and e.refund_id is not null) as refund_exceptions,
           coalesce((select sum(f.amount)::int from public.fake_provider_refunds f
                      where f.tenant_id = s.tenant_id and f.payment_id = p.provider_payment_id), 0)
             as fake_refunded,
           (select count(*)::int from public.fake_provider_payments f
             where f.tenant_id = s.tenant_id and f.idempotency_key = p.idempotency_key)
             as fake_payments,
           (select f.idempotency_key = p.idempotency_key from public.fake_provider_payments f
             where f.tenant_id = s.tenant_id and f.id = p.provider_payment_id)
             as fake_payment_key_matches
      from public.checkout_sessions s
      join public.capacity_holds h on h.tenant_id = s.tenant_id and h.id = s.hold_id
      join public.orders o on o.tenant_id = s.tenant_id and o.checkout_session_id = s.id
      join public.payments p on p.tenant_id = s.tenant_id and p.checkout_session_id = s.id
     where s.tenant_id in ${admin(tenantIds as string[])}`;
  const problems: string[] = [];
  for (const r of rows) {
    const where = `checkout ${r.id} (${r.state})`;
    const expect = (ok: boolean, what: string) => {
      if (!ok) problems.push(`${where}: ${what}`);
    };
    expect(r.hold_matches, "its hold is not its own for its trip and party");
    expect(r.bad_bookings === 0, "a booking names another trip, party, hold, payment, or order");
    expect(r.total_amount === r.amount, "the payment is not the order's total");
    expect(r.bookings <= 1, `${r.bookings} bookings`);
    expect(r.refunds <= 1, `${r.refunds} refunds`);
    expect(!(r.bookings > 0 && r.refunds > 0), "both a booking and a refund");
    expect(r.fake_payments <= 1, `${r.fake_payments} provider payments for one key`);
    expect(r.fake_payment_key_matches !== false, "the recorded provider payment has another key");
    expect(
      r.provider_payment_id === null || r.fake_payment_key_matches !== null,
      "the recorded provider payment id names no provider payment",
    );
    expect(r.fake_refunded <= r.amount, `the provider refunded ${r.fake_refunded} of ${r.amount}`);
    if (r.refund_state === "succeeded") {
      expect(r.fake_refunded === r.amount, "a succeeded refund the provider did not make");
    } else if (r.refund_state === "failed" || r.refund_state === null) {
      expect(r.fake_refunded === 0, "the provider refunded without a succeeded refund");
    }
    if (r.refunds === 1) expect(r.refund_amount === r.amount, "a partial refund");
    switch (r.state) {
      case "confirmed":
        expect(r.bookings === 1, "confirmed without a booking");
        expect(r.hold === "confirmed", `confirmed with a ${r.hold} hold`);
        expect(r.payment === "succeeded", `confirmed with a ${r.payment} payment`);
        expect(r.order_status === "paid", `confirmed with a ${r.order_status} order`);
        break;
      case "unfulfilled":
        expect(r.bookings === 0, "unfulfilled with a booking");
        expect(r.payment === "succeeded", `unfulfilled with a ${r.payment} payment`);
        expect(r.order_status === "void", `unfulfilled with a ${r.order_status} order`);
        expect(r.refunds === 1, "unfulfilled without a refund");
        expect(r.refund_exceptions === 1, `${r.refund_exceptions} refund exceptions`);
        expect(r.hold === "released" || r.hold === "expired", `unfulfilled with a ${r.hold} hold`);
        break;
      case "failed":
        expect(r.bookings === 0 && r.refunds === 0, "failed with a booking or refund");
        expect(r.payment === "failed", `failed with a ${r.payment} payment`);
        expect(r.hold === "released", `failed with a ${r.hold} hold`);
        expect(r.order_status === "void", `failed with a ${r.order_status} order`);
        break;
      case "canceled":
        expect(r.bookings === 0 && r.refunds === 0, "canceled with a booking or refund");
        expect(r.hold === "released", `canceled with a ${r.hold} hold`);
        expect(r.order_status === "void", `canceled with a ${r.order_status} order`);
        expect(r.payment !== "succeeded", "canceled with a succeeded payment");
        break;
      case "expired":
        expect(r.bookings === 0 && r.refunds === 0, "expired with a booking or refund");
        expect(r.hold === "expired", `expired with a ${r.hold} hold`);
        expect(r.payment !== "succeeded", "expired with a succeeded payment");
        expect(
          r.order_status === (r.payment === "failed" ? "void" : "pending"),
          `expired with a ${r.order_status} order and a ${r.payment} payment`,
        );
        break;
      case "open":
        expect(r.bookings === 0 && r.refunds === 0, "open with a booking or refund");
        expect(r.payment === "pending", `open with a ${r.payment} payment`);
        expect(r.order_status === "pending", `open with a ${r.order_status} order`);
        expect(
          r.hold === "active" || (r.lapsed && r.hold === "expired"),
          `open with a ${r.hold} hold`,
        );
        break;
      default:
        problems.push(`${where}: unknown state`);
    }
  }
  return problems;
}

// Capacity ---------------------------------------------------------------------------------

export interface TripUsage {
  tripId: string;
  capacity: number;
  productKind: string;
  /** Seats of holds stored active or confirmed: the invariant's sum. */
  counted: number;
  countedHolds: number;
  wholeBoats: number;
  /** Seats taken by the database clock: confirmed, or active within their time. */
  live: number;
  confirmed: number;
  confirmedHolds: number;
}

export async function usageOfTrips(admin: Sql, tripIds: readonly string[]): Promise<TripUsage[]> {
  if (tripIds.length === 0) return [];
  const rows = await admin<
    {
      trip_id: string;
      seat_capacity: number;
      product_kind: string;
      counted: number;
      counted_holds: number;
      whole_boats: number;
      live: number;
      confirmed: number;
      confirmed_holds: number;
    }[]
  >`
    select t.id as trip_id, t.seat_capacity, p.kind as product_kind,
           coalesce(sum(h.seats) filter (where h.state in ('active', 'confirmed')), 0)::int
             as counted,
           count(h.id) filter (where h.state in ('active', 'confirmed'))::int as counted_holds,
           count(h.id) filter (where h.kind = 'whole_boat'
                                 and h.state in ('active', 'confirmed'))::int as whole_boats,
           coalesce(sum(h.seats) filter (where h.state = 'confirmed'
                       or (h.state = 'active' and h.expires_at > now())), 0)::int as live,
           coalesce(sum(h.seats) filter (where h.state = 'confirmed'), 0)::int as confirmed,
           count(h.id) filter (where h.state = 'confirmed')::int as confirmed_holds
      from public.scheduled_trips t
      join public.products p on p.tenant_id = t.tenant_id and p.id = t.product_id
      left join public.capacity_holds h on h.tenant_id = t.tenant_id and h.trip_id = t.id
     where t.id in ${admin(tripIds as string[])}
     group by t.id, t.seat_capacity, p.kind`;
  return rows.map((r) => ({
    tripId: r.trip_id,
    capacity: r.seat_capacity,
    productKind: r.product_kind,
    counted: r.counted,
    countedHolds: r.counted_holds,
    wholeBoats: r.whole_boats,
    live: r.live,
    confirmed: r.confirmed,
    confirmedHolds: r.confirmed_holds,
  }));
}

/** Trips that break the capacity invariant: oversold, or more than one counted charter hold. */
export function oversold(rows: readonly TripUsage[]): TripUsage[] {
  return rows.filter(
    (r) =>
      r.counted > r.capacity ||
      r.live > r.capacity ||
      r.wholeBoats > 1 ||
      (r.productKind === "private_charter" && r.countedHolds > 1),
  );
}

// Reporting ----------------------------------------------------------------------------

export interface RoundStats {
  sessions: number;
  successes: number;
  refusals: number;
  errors: number;
  oversell: number;
}

/** One machine-readable line per race for the verification log. */
export function reportRace(
  race: string,
  rounds: readonly RoundStats[],
  extra: Record<string, unknown> = {},
): void {
  const sum = (k: keyof RoundStats) => rounds.reduce((n, r) => n + r[k], 0);
  const line = {
    race,
    rounds: rounds.length,
    sessionsPerRound: rounds[0]?.sessions ?? 0,
    successes: sum("successes"),
    refusals: sum("refusals"),
    errors: sum("errors"),
    oversell: sum("oversell"),
    ...extra,
  };
  const text = `RACE_STATS ${JSON.stringify(line)}`;
  console.log(text);
  // Vitest hides the console output of passing tests; a run can ask for a file too.
  const file = process.env.RACE_STATS_FILE;
  if (file) appendFileSync(file, `${text}\n`);
}

/** Count how often each value occurs, for stats lines. */
export function tally(values: readonly string[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const v of values) out[v] = (out[v] ?? 0) + 1;
  return out;
}
