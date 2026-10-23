/**
 * Shared helpers for the lane 1 adversarial suites (G2.11c guest self-service
 * and the G2.16 email shim): cancellation within policy, access links, guest
 * sessions, and booking email. Node only, integration tests.
 *
 * Every call under test runs as tidegrid_app over real PostgreSQL
 * connections. The admin connection builds fixtures, makes time pass by
 * moving instants earlier (never later), and reads stored state. Payment
 * events reach the booking only after the fake provider signs them and the
 * adapter verifies them. Data is synthetic, at .test addresses.
 */
import { randomUUID } from "node:crypto";
import {
  inTenantTransaction,
  type TenantContext,
  type TenantTransaction,
} from "@tidegrid/database";
import {
  type DeliveryOptions,
  deliverTenantMessages,
  type EmailProvider,
  type FakeEmailProvider,
  type TenantDeliveryReport,
} from "@tidegrid/domain-messaging";
import { FAKE_MINIMUM_AMOUNT, type FakePaymentProvider } from "@tidegrid/domain-payments";
import { createPolicyVersion } from "@tidegrid/domain-pricing";
import {
  type BookingHooks,
  createCheckoutSession,
  ensureProviderPayment,
  type HandledEvent,
  handleVerifiedEvent,
  openManageSession,
} from "../index.ts";
import {
  type CheckoutFixture,
  guestContext,
  newSecret,
  quoteFor,
  verifiedFakeEvent,
} from "../test-fixtures.ts";
import { type Db, eventBody, type Sql } from "./harness.ts";

export interface SelfServiceWorld {
  admin: Sql;
  db: Db;
  payments: FakePaymentProvider;
  mail: FakeEmailProvider;
}

/** Where delivered links point in these suites: each tenant's local preview hostname. */
export const LINK_ORIGIN = "http://{slug}.book.localhost:5301";
export const FROM_ADDRESS = "bookings@tidegrid.test";

export function asGuest<T>(
  db: Db,
  tenantId: string,
  fn: (trx: TenantTransaction, ctx: TenantContext) => Promise<T>,
): Promise<T> {
  const ctx = guestContext(tenantId);
  return inTenantTransaction(db, ctx, (trx) => fn(trx, ctx));
}

export function asSystem<T>(
  db: Db,
  tenantId: string,
  fn: (trx: TenantTransaction, ctx: TenantContext) => Promise<T>,
): Promise<T> {
  const ctx: TenantContext = {
    tenantId,
    actorType: "system",
    actorId: "lane1-adversary",
    requestId: `adv-${randomUUID()}`,
  };
  return inTenantTransaction(db, ctx, (trx) => fn(trx, ctx));
}

/** The tenant's own local guest site, active and verified, so its links can be issued. */
export async function addLocalHostname(admin: Sql, tenant: CheckoutFixture): Promise<string> {
  const host = `${tenant.slug}.book.localhost`;
  await admin`insert into public.tenant_hostnames (hostname, tenant_id, kind, status, verified_at)
    values (${host}, ${tenant.id}, 'preview', 'active', now())`;
  return host;
}

// Bookings ------------------------------------------------------------------------------

export interface Booked {
  tenant: CheckoutFixture;
  tripId: string;
  party: number;
  bookingId: string;
  reference: string;
  checkoutSessionId: string;
  secret: string;
  paymentId: string;
  providerPaymentId: string;
  amount: number;
  holdId: string;
  bookerEmail: string;
  /** The provider's own success event body, as it was first delivered. */
  successBody: string;
}

let bookerCounter = 0;

/** A deterministic synthetic booker; each call gets the next address. */
export function syntheticBooker(label = "booker"): { name: string; email: string } {
  bookerCounter += 1;
  return {
    name: `Synthetic ${label} ${bookerCounter}`,
    email: `synthetic.${label}.${bookerCounter}@example.test`,
  };
}

/**
 * A confirmed booking made the way a guest makes one: a quote (optionally
 * with the tenant's promotion, for odd-cent totals), a checkout, the fake
 * payment settled, and its signed event through the webhook path.
 */
export async function book(
  world: SelfServiceWorld,
  tenant: CheckoutFixture,
  tripId: string,
  party: number,
  options: {
    charter?: boolean;
    promotion?: boolean;
    booker?: { name: string; email: string };
    hooks?: BookingHooks;
  } = {},
): Promise<Booked> {
  const quote = await quoteFor(world.db, tenant.id, tripId, party, {
    charter: options.charter ?? false,
    promotionCode: options.promotion ? tenant.promotionCode : null,
  });
  const secret = newSecret();
  const booker = options.booker ?? syntheticBooker();
  const created = await asGuest(world.db, tenant.id, (trx, ctx) =>
    createCheckoutSession(trx, ctx, {
      quoteId: quote.quoteId,
      acceptedPolicyVersion: quote.policy.version,
      booker,
      secret,
      clientAddress: null,
      provider: "fake",
      minimumAmount: FAKE_MINIMUM_AMOUNT,
    }),
  );
  if (created.kind !== "created") throw new Error(`setup checkout: ${JSON.stringify(created)}`);
  const ready = await ensureProviderPayment(
    world.db,
    world.payments,
    guestContext(tenant.id),
    created.session.id,
  );
  if (ready.kind !== "ready") throw new Error(`setup payment: ${JSON.stringify(ready)}`);
  const settled = await world.payments.settlePayment(
    tenant.id,
    ready.paymentRef,
    "succeeded",
    Date.now(),
  );
  if (settled.kind === "not_found") throw new Error("setup: no fake payment to settle");
  const handled = await deliverEvent(world, settled.event.body, options.hooks);
  if (handled.kind !== "processed" || !handled.outcome.startsWith("confirmed")) {
    throw new Error(`setup confirmation: ${JSON.stringify(handled)}`);
  }
  const [row] = await world.admin<
    {
      id: string;
      reference: string;
      payment_id: string;
      provider_payment_id: string;
      amount: number;
      hold_id: string;
    }[]
  >`
    select b.id, b.reference, b.payment_id, p.provider_payment_id, p.amount, b.hold_id
      from public.bookings b join public.payments p on p.id = b.payment_id
     where b.checkout_session_id = ${created.session.id}`;
  if (!row) throw new Error("setup: the confirmed booking was not found");
  return {
    tenant,
    tripId,
    party,
    bookingId: row.id,
    reference: row.reference,
    checkoutSessionId: created.session.id,
    secret,
    paymentId: row.payment_id,
    providerPaymentId: row.provider_payment_id,
    amount: row.amount,
    holdId: row.hold_id,
    bookerEmail: booker.email,
    successBody: settled.event.body,
  };
}

/** Sign, verify, and hand an event body to the webhook path, as the route does. */
export async function deliverEvent(
  world: SelfServiceWorld,
  body: string,
  hooks?: BookingHooks,
): Promise<HandledEvent> {
  const event = await verifiedFakeEvent(world.payments, body);
  return handleVerifiedEvent(world.db, world.payments, event, {
    requestId: `wh-${randomUUID()}`,
    hooks,
  });
}

/** A new event, with a new id, about a booking's own payment: a late or reordered delivery. */
export function lateEventBody(b: Booked, type: "payment.succeeded" | "payment.failed"): string {
  return eventBody({
    type,
    accountRef: b.tenant.accountRef,
    paymentRef: b.providerPaymentId,
    amount: b.amount,
    clientReference: b.paymentId,
  });
}

export function outcomeOf(handled: HandledEvent): string {
  return handled.kind === "processed" ? handled.outcome : handled.kind;
}

// Policies and time -----------------------------------------------------------------------

export interface PolicyTerms {
  changeCutoffMinutes: number;
  beforeCutoff: { remedy: "full_refund" | "percent_refund" | "credit" | "none"; refundBp?: number };
  afterCutoff: { remedy: "full_refund" | "percent_refund" | "credit" | "none"; refundBp?: number };
}

/** Append a policy version to one of the fixture's products; later quotes carry it. */
export async function setPolicy(
  world: SelfServiceWorld,
  tenant: CheckoutFixture,
  product: "shared" | "charter",
  terms: PolicyTerms,
): Promise<number> {
  return asSystem(world.db, tenant.id, async (trx, ctx) => {
    const made = await createPolicyVersion(trx, ctx, {
      productId: tenant.products[product],
      changeCutoffMinutes: terms.changeCutoffMinutes,
      beforeCutoff: terms.beforeCutoff,
      afterCutoff: terms.afterCutoff,
      noShow: { remedy: "none" },
      text: {
        cancellation: `Synthetic terms: ${terms.beforeCutoff.remedy} then ${terms.afterCutoff.remedy}.`,
        reschedule: "Synthetic reschedule terms.",
        noShow: "Synthetic no-show terms.",
        operatorCancellation: "Synthetic operator terms.",
        weather: "Synthetic weather terms.",
      },
      reason: "lane 1 adversarial policy",
    });
    if (made.kind !== "created") throw new Error(`setup policy: ${JSON.stringify(made)}`);
    return made.version;
  });
}

/**
 * Move a trip so it departs `minutes` from now (negative: it has departed),
 * on a whole minute, keeping its local date and time consistent (the
 * fixture's zone is UTC). Admin only. Callers keep two trips of one boat
 * apart by more than a trip's length.
 */
export async function departIn(admin: Sql, tripId: string, minutes: number): Promise<Date> {
  const rows = await admin<{ starts_at: Date }[]>`
    with t as (select date_trunc('minute', now()) + make_interval(mins => ${minutes}) as s)
    update public.scheduled_trips st
       set starts_at = t.s,
           ends_at = t.s + make_interval(mins => st.duration_minutes),
           local_date = (t.s at time zone st.time_zone)::date,
           local_start_time = (t.s at time zone st.time_zone)::time(0)
      from t
     where st.id = ${tripId}
    returning st.starts_at`;
  const row = rows[0];
  if (!row) throw new Error(`no trip ${tripId} to move`);
  return row.starts_at;
}

/** Half up to the cent, computed independently of the service: exact integers, then the remainder. */
export function halfUp(paid: number, bp: number): number {
  const exact = BigInt(paid) * BigInt(bp);
  const whole = exact / 10000n;
  const rest = exact % 10000n;
  return Number(rest * 2n >= 10000n ? whole + 1n : whole);
}

// Email -------------------------------------------------------------------------------------

/** One delivery run for one tenant, links pointing at its local guest site. */
export function deliverMail(
  world: SelfServiceWorld,
  tenantId: string,
  provider: EmailProvider = world.mail,
  extra: Partial<DeliveryOptions> = {},
): Promise<TenantDeliveryReport> {
  return deliverTenantMessages(world.db, tenantId, {
    provider,
    fromAddress: FROM_ADDRESS,
    guestLinkOrigin: LINK_ORIGIN,
    runId: `run-${randomUUID()}`,
    ...extra,
  });
}

/** Make a queued message due now, as time passing would. */
export async function makeDue(admin: Sql, messageId: string): Promise<void> {
  await admin`update public.email_messages set next_attempt_at = now() - interval '1 second'
               where id = ${messageId} and state = 'queued' and next_attempt_at > now()`;
}

export interface MessageRow {
  id: string;
  template: string;
  state: string;
  attempts: number;
  to_email: string;
  last_error_code: string | null;
  provider_message_id: string | null;
}

/** A booking's messages, oldest first. */
export async function messagesOf(admin: Sql, bookingId: string): Promise<MessageRow[]> {
  return admin<MessageRow[]>`
    select id, template, state, attempts, to_email, last_error_code, provider_message_id
      from public.email_messages where booking_id = ${bookingId}
     order by created_at, id`;
}

export async function messageOf(admin: Sql, messageId: string): Promise<MessageRow> {
  const [row] = await admin<MessageRow[]>`
    select id, template, state, attempts, to_email, last_error_code, provider_message_id
      from public.email_messages where id = ${messageId}`;
  if (!row) throw new Error(`no message ${messageId}`);
  return row;
}

/** What the fake provider accepted for one message: the email the guest holds. */
export async function acceptedFor(
  admin: Sql,
  messageId: string,
): Promise<{ id: string; html: string; text: string; count: number } | null> {
  const rows = await admin<{ id: string; html_body: string; text_body: string }[]>`
    select id, html_body, text_body from public.fake_email_deliveries
     where idempotency_key = ${messageId} and result = 'accepted'`;
  const first = rows[0];
  return first
    ? { id: first.id, html: first.html_body, text: first.text_body, count: rows.length }
    : null;
}

const tokenPattern = /#t=([A-Za-z0-9_-]{43})/;

/** The link token in a delivered email's HTML, or null. */
export function tokenIn(html: string): string | null {
  return tokenPattern.exec(html)?.[1] ?? null;
}

/** The token in the email the provider accepted for a message; throws when there is none. */
export async function deliveredToken(admin: Sql, messageId: string): Promise<string> {
  const accepted = await acceptedFor(admin, messageId);
  const token = accepted ? tokenIn(accepted.html) : null;
  if (!token) throw new Error(`no delivered link for message ${messageId}`);
  return token;
}

/** Redeem a management link as the guest page's POST does, opening a session. */
export async function redeem(world: SelfServiceWorld, tenantId: string, token: string) {
  return asGuest(world.db, tenantId, (trx, ctx) => openManageSession(trx, ctx, { token }));
}

// Stored state ------------------------------------------------------------------------------

export interface CancelState {
  booking: string;
  canceledAt: Date | null;
  hold: string;
  payment: string;
  order: string;
  checkout: string;
  cancellations: number;
  refunds: {
    id: string;
    state: string;
    amount: number;
    reason: string;
    idempotencyKey: string;
    providerRefundId: string | null;
    failureCode: string | null;
  }[];
  fakeRefunds: number;
  fakeRefunded: number;
  exceptions: number;
  confirmationEmails: number;
  cancellationEmails: number;
  participants: number;
}

export async function cancelStateOf(admin: Sql, bookingId: string): Promise<CancelState> {
  const [row] = await admin<
    {
      booking: string;
      canceled_at: Date | null;
      hold: string;
      payment: string;
      order: string;
      checkout: string;
      cancellations: number;
      fake_refunds: number;
      fake_refunded: number;
      exceptions: number;
      confirmation_emails: number;
      cancellation_emails: number;
      participants: number;
    }[]
  >`
    select b.state as booking, b.canceled_at, h.state as hold, p.state as payment,
           o.status as order, s.state as checkout,
           (select count(*)::int from public.booking_cancellations c where c.booking_id = b.id)
             as cancellations,
           (select count(*)::int from public.fake_provider_refunds f
             where f.tenant_id = b.tenant_id and f.payment_id = p.provider_payment_id)
             as fake_refunds,
           coalesce((select sum(f.amount)::int from public.fake_provider_refunds f
                      where f.tenant_id = b.tenant_id and f.payment_id = p.provider_payment_id), 0)
             as fake_refunded,
           (select count(*)::int from public.finalization_exceptions e
             where e.checkout_session_id = b.checkout_session_id) as exceptions,
           (select count(*)::int from public.email_messages m
             where m.booking_id = b.id and m.template = 'booking_confirmation')
             as confirmation_emails,
           (select count(*)::int from public.email_messages m
             where m.booking_id = b.id and m.template = 'booking_canceled')
             as cancellation_emails,
           (select count(*)::int from public.booking_participants x where x.booking_id = b.id)
             as participants
      from public.bookings b
      join public.capacity_holds h on h.id = b.hold_id
      join public.payments p on p.id = b.payment_id
      join public.orders o on o.id = b.order_id
      join public.checkout_sessions s on s.id = b.checkout_session_id
     where b.id = ${bookingId}`;
  if (!row) throw new Error(`no booking ${bookingId}`);
  const refunds = await admin<
    {
      id: string;
      state: string;
      amount: number;
      reason: string;
      idempotency_key: string;
      provider_refund_id: string | null;
      failure_code: string | null;
    }[]
  >`
    select r.id, r.state, r.amount, r.reason, r.idempotency_key, r.provider_refund_id,
           r.failure_code
      from public.payment_refunds r join public.bookings b on b.payment_id = r.payment_id
     where b.id = ${bookingId}
     order by r.created_at, r.id`;
  return {
    booking: row.booking,
    canceledAt: row.canceled_at,
    hold: row.hold,
    payment: row.payment,
    order: row.order,
    checkout: row.checkout,
    cancellations: row.cancellations,
    refunds: refunds.map((r) => ({
      id: r.id,
      state: r.state,
      amount: r.amount,
      reason: r.reason,
      idempotencyKey: r.idempotency_key,
      providerRefundId: r.provider_refund_id,
      failureCode: r.failure_code,
    })),
    fakeRefunds: row.fake_refunds,
    fakeRefunded: row.fake_refunded,
    exceptions: row.exceptions,
    confirmationEmails: row.confirmation_emails,
    cancellationEmails: row.cancellation_emails,
    participants: row.participants,
  };
}

interface LedgerRow {
  id: string;
  state: string;
  hold: string;
  payment: string;
  order_status: string;
  checkout: string;
  party_size: number;
  amount: number;
  cancellations: number;
  remedy: string | null;
  refund_bp: number | null;
  paid_amount: number | null;
  refund_amount: number | null;
  refund_id: string | null;
  refunds: number;
  refund_ref_id: string | null;
  refund_reason: string | null;
  refund_state: string | null;
  refund_row_amount: number | null;
  fake_refunds: number;
  fake_refunded: number;
  exceptions: number;
  confirmation_emails: number;
  cancellation_emails: number;
  participants: number;
}

/**
 * Every booking of the given tenants against the cancellation's chain of
 * custody, as stored: a canceled booking has exactly one cancellation, its
 * hold released, at most one refund of exactly the amount its terms give
 * (half up, computed here independently), and one cancellation email; a
 * confirmed booking has none of those; the payment stays succeeded and the
 * order paid; the provider moved exactly the money the ledger says. An empty
 * list is a clean ledger.
 */
export async function cancellationLedger(
  admin: Sql,
  tenantIds: readonly string[],
): Promise<string[]> {
  if (tenantIds.length === 0) return [];
  const rows = await admin<LedgerRow[]>`
    select b.id, b.state, h.state as hold, p.state as payment, o.status as order_status,
           s.state as checkout, b.party_size, p.amount,
           (select count(*)::int from public.booking_cancellations c where c.booking_id = b.id)
             as cancellations,
           c.remedy, c.refund_bp, c.paid_amount, c.refund_amount, c.refund_id,
           (select count(*)::int from public.payment_refunds r where r.payment_id = p.id)
             as refunds,
           r.id as refund_ref_id, r.reason as refund_reason, r.state as refund_state,
           r.amount as refund_row_amount,
           (select count(*)::int from public.fake_provider_refunds f
             where f.tenant_id = b.tenant_id and f.payment_id = p.provider_payment_id)
             as fake_refunds,
           coalesce((select sum(f.amount)::int from public.fake_provider_refunds f
                      where f.tenant_id = b.tenant_id and f.payment_id = p.provider_payment_id), 0)
             as fake_refunded,
           (select count(*)::int from public.finalization_exceptions e
             where e.checkout_session_id = b.checkout_session_id) as exceptions,
           (select count(*)::int from public.email_messages m
             where m.booking_id = b.id and m.template = 'booking_confirmation')
             as confirmation_emails,
           (select count(*)::int from public.email_messages m
             where m.booking_id = b.id and m.template = 'booking_canceled')
             as cancellation_emails,
           (select count(*)::int from public.booking_participants x where x.booking_id = b.id)
             as participants
      from public.bookings b
      join public.capacity_holds h on h.id = b.hold_id
      join public.payments p on p.id = b.payment_id
      join public.orders o on o.id = b.order_id
      join public.checkout_sessions s on s.id = b.checkout_session_id
      left join public.booking_cancellations c on c.booking_id = b.id
      left join public.payment_refunds r on r.payment_id = p.id
     where b.tenant_id in ${admin(tenantIds as string[])}`;
  const problems: string[] = [];
  for (const r of rows) {
    const check = (ok: boolean, what: string) => {
      if (!ok) problems.push(`booking ${r.id} (${r.state}): ${what}`);
    };
    check(r.payment === "succeeded", `payment ${r.payment}`);
    check(r.order_status === "paid", `order ${r.order_status}`);
    check(r.checkout === "confirmed", `checkout ${r.checkout}`);
    check(r.exceptions === 0, `${r.exceptions} finalization exceptions`);
    check(r.confirmation_emails === 1, `${r.confirmation_emails} confirmation emails`);
    check(r.participants <= r.party_size, `${r.participants} participants in ${r.party_size}`);
    check(r.refunds <= 1, `${r.refunds} refunds`);
    check(r.fake_refunds <= 1, `${r.fake_refunds} provider refunds`);
    if (r.state === "confirmed") {
      check(r.cancellations === 0, "a cancellation without a canceled booking");
      check(r.hold === "confirmed", `a ${r.hold} hold`);
      check(r.refunds === 0, "a refund without a cancellation");
      check(r.fake_refunded === 0, "the provider refunded a standing booking");
      check(r.cancellation_emails === 0, "a cancellation email for a standing booking");
      continue;
    }
    check(r.state === "canceled", "an unknown state");
    check(r.cancellations === 1, `${r.cancellations} cancellations`);
    check(r.hold === "released", `a canceled booking keeps a ${r.hold} hold`);
    check(r.cancellation_emails === 1, `${r.cancellation_emails} cancellation emails`);
    check(r.paid_amount === r.amount, "the cancellation names another paid amount");
    if (r.refund_bp === null || r.refund_amount === null) {
      check(false, "a canceled booking without terms");
      continue;
    }
    check(
      r.refund_amount === halfUp(r.amount, r.refund_bp),
      `refund ${r.refund_amount} is not ${r.refund_bp} bp of ${r.amount}, half up`,
    );
    if (r.refund_amount === 0) {
      check(r.refunds === 0 && r.refund_id === null, "a refund row for nothing");
      check(r.fake_refunded === 0, "the provider refunded nothing owed");
      continue;
    }
    check(r.refunds === 1, "money to return without a refund row");
    check(r.refund_ref_id === r.refund_id, "the refund is not the cancellation's");
    check(r.refund_reason === "booking_canceled", `refund reason ${r.refund_reason}`);
    check(r.refund_row_amount === r.refund_amount, "the refund row is another amount");
    if (r.refund_state === "succeeded") {
      check(r.fake_refunded === r.refund_amount, "a succeeded refund the provider did not make");
    } else if (r.refund_state === "failed") {
      check(r.fake_refunded === 0, "the provider refunded a failed refund");
    } else {
      check(
        r.fake_refunded === 0 || r.fake_refunded === r.refund_amount,
        `a requested refund the provider moved ${r.fake_refunded} for`,
      );
    }
  }
  return problems;
}

/** Seats a trip's holds take now: confirmed, or active and unexpired. */
export async function seatsTaken(admin: Sql, tripId: string): Promise<number> {
  const [row] = await admin<{ taken: number }[]>`
    select coalesce(sum(seats), 0)::int as taken from public.capacity_holds
     where trip_id = ${tripId}
       and (state = 'confirmed' or (state = 'active' and expires_at > now()))`;
  return row?.taken ?? 0;
}
