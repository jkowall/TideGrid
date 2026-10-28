/**
 * Staff-assisted checkout (G2.12d). An owner or booking staff member opens a
 * checkout for a guest who phoned, emailed, or walked up. It is the guest's
 * checkout in every way that matters: the same quote, hold, order, and
 * pending payment in one transaction (createCheckoutSession), and a booking
 * only once a verified provider event says the payment succeeded
 * (finalize.ts, unchanged). Nothing here marks anything paid.
 *
 * What differs:
 * - The database stamps the checkout's source (staff_assisted) and its
 *   opener from the transaction's staff actor (migration 0012); the booking
 *   copies the source. No writer chooses either.
 * - The capability secret is generated here and never leaves: staff act
 *   through their own session, and the guest manages the booking through the
 *   management link in the confirmation email.
 * - Staff attest that they told the guest the policy and read the email back,
 *   in place of the guest's own acceptance (a demo narrowing, docs/v2/12).
 * - The per-client limit counts open checkouts per staff member.
 * - Staff cancel an open checkout without the secret, and ask for a test
 *   payment, whose request is audited here and whose settlement and signed
 *   delivery happen after commit (the API's route), because each opens its
 *   own transaction.
 */
import {
  type BookingChannel,
  type CheckoutSessionState,
  isUuid,
  type PaymentState,
  type RefundState,
  type TenantContext,
  type TenantTransaction,
} from "@tidegrid/database";
import type { PaymentProviderName } from "@tidegrid/domain-payments";
import { sql } from "kysely";
import {
  type CancelCheckoutResult,
  type CreateCheckoutResult,
  cancelLockedSession,
  createCheckoutSession,
  type StaffCheckoutDetails,
} from "./checkout.ts";
import { type CheckoutSessionView, iso, record } from "./views.ts";

export type StaffTestPaymentOutcome = "succeed" | "fail";

export interface OpenStaffCheckoutInput extends StaffCheckoutDetails {
  quoteId: string;
  acceptedPolicyVersion: number;
  booker: { name: string; email: string };
  provider: PaymentProviderName;
  minimumAmount: number;
  ttlSeconds?: number;
}

/** How a staff member is counted for the open-checkout limit. Never a client address. */
export const staffClientAddress = (userId: string) => `staff:${userId}`;

function assertStaff(ctx: TenantContext): string {
  if (ctx.actorType !== "staff" || !ctx.actorId || !isUuid(ctx.actorId)) {
    throw new TypeError("a staff checkout needs a signed-in staff actor");
  }
  return ctx.actorId;
}

/** 32 random bytes, base64url: a capability secret nobody will ever hold. */
function unusedSecret(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

/**
 * Open a staff-assisted checkout for a quote that staff of this tenant
 * created. A quote a guest made, another tenant's, an unknown one, and a
 * malformed id all read as quote_not_found. Then exactly the guest's
 * checkout: the caller claims the idempotency key first and commits, and
 * creates the provider payment after commit with ensureProviderPayment.
 */
export async function openStaffCheckout(
  trx: TenantTransaction,
  ctx: TenantContext,
  input: OpenStaffCheckoutInput,
): Promise<CreateCheckoutResult> {
  const actorId = assertStaff(ctx);
  if (!isUuid(input.quoteId)) return { kind: "quote_not_found" };
  const { rows } = await sql<{ actor_type: string }>`
    select actor_type from quotes
     where tenant_id = ${ctx.tenantId} and id = ${input.quoteId}`.execute(trx);
  if (rows[0]?.actor_type !== "staff") return { kind: "quote_not_found" };
  return createCheckoutSession(trx, ctx, {
    quoteId: input.quoteId,
    acceptedPolicyVersion: input.acceptedPolicyVersion,
    booker: input.booker,
    secret: unusedSecret(),
    clientAddress: staffClientAddress(actorId),
    provider: input.provider,
    minimumAmount: input.minimumAmount,
    ...(input.ttlSeconds === undefined ? {} : { ttlSeconds: input.ttlSeconds }),
    staff: { channel: input.channel, attestations: input.attestations },
  });
}

/** Lock a staff-assisted checkout of this tenant; a guest's reads as nothing. */
async function lockStaffSession(trx: TenantTransaction, tenantId: string, sessionId: string) {
  if (!isUuid(sessionId)) return undefined;
  const { rows } = await sql<{
    id: string;
    state: CheckoutSessionState;
    hold_id: string;
    live: boolean;
  }>`
    select id, state, hold_id, expires_at > now() as live from checkout_sessions
     where tenant_id = ${tenantId} and id = ${sessionId} and source = 'staff_assisted'
       for update`.execute(trx);
  return rows[0];
}

/**
 * Staff abandon an open staff-assisted checkout: the guest's cancel, found
 * without the secret and recorded with the staff actor and a reason. A
 * guest's checkout, another tenant's, and an unknown id are not_found. A
 * payment that succeeds afterwards anyway is refunded in full (finalize.ts).
 */
export async function cancelStaffCheckout(
  trx: TenantTransaction,
  ctx: TenantContext,
  input: { sessionId: string },
): Promise<CancelCheckoutResult> {
  assertStaff(ctx);
  const session = await lockStaffSession(trx, ctx.tenantId, input.sessionId);
  if (!session) return { kind: "not_found" };
  return cancelLockedSession(trx, ctx, session, {
    holdReason: "checkout canceled by staff",
    auditReason: "checkout canceled by staff",
  });
}

export type StaffTestPaymentRequestResult =
  /** Recorded; settle and deliver after commit. paymentRef is null until the provider has it. */
  | { kind: "requested"; paymentRef: string | null }
  /** Not open, or past its expiry: nothing is settled. */
  | { kind: "not_open"; state: CheckoutSessionState }
  /** The payment already settled the other way; nothing is recorded, and that outcome stands. */
  | { kind: "already_settled"; outcome: StaffTestPaymentOutcome }
  | { kind: "not_found" };

/**
 * Phase 1 of a staff test payment: under the checkout's row lock, refuse one
 * that is not open or is past its expiry, and record which staff member asked
 * for which outcome. The fake provider settles as the system actor, so this
 * row is the only record of who took or declined the payment. No booker
 * details. The settlement and the signed delivery run after commit.
 *
 * `settledOutcome` reads, in this transaction, how the provider already
 * settled the payment, if it has. A request for the other outcome is refused
 * and records nothing, so the audit history never says a payment was
 * declined when it went through, or taken when it was declined.
 */
export async function requestStaffTestPayment(
  trx: TenantTransaction,
  ctx: TenantContext,
  input: {
    sessionId: string;
    outcome: StaffTestPaymentOutcome;
    settledOutcome?: (paymentRef: string) => Promise<StaffTestPaymentOutcome | null>;
  },
): Promise<StaffTestPaymentRequestResult> {
  assertStaff(ctx);
  const session = await lockStaffSession(trx, ctx.tenantId, input.sessionId);
  if (!session) return { kind: "not_found" };
  if (session.state !== "open" || !session.live) {
    return { kind: "not_open", state: session.state === "open" ? "expired" : session.state };
  }
  const { rows } = await sql<{ provider: PaymentProviderName; provider_payment_id: string | null }>`
    select provider, provider_payment_id from payments
     where tenant_id = ${ctx.tenantId} and checkout_session_id = ${session.id}`.execute(trx);
  const payment = rows[0];
  if (!payment) throw new Error("a checkout session has no payment");
  if (payment.provider !== "fake") return { kind: "not_found" };
  if (payment.provider_payment_id !== null && input.settledOutcome) {
    const settled = await input.settledOutcome(payment.provider_payment_id);
    if (settled !== null && settled !== input.outcome) {
      return { kind: "already_settled", outcome: settled };
    }
  }
  await record(trx, ctx, {
    action: "checkout.test_payment_requested",
    subjectType: "checkout_session",
    subjectId: session.id,
    after: { outcome: input.outcome, provider: payment.provider },
  });
  return { kind: "requested", paymentRef: payment.provider_payment_id };
}

/**
 * The provider's payment id for a staff-assisted checkout, for the
 * after-commit settle, with whether the checkout is still open and inside
 * its hold. A replayed request skips phase 1, so the settle checks this
 * itself before settling anything new.
 */
export async function staffCheckoutPaymentRef(
  trx: TenantTransaction,
  tenantId: string,
  sessionId: string,
): Promise<{ paymentRef: string | null; open: boolean; state: CheckoutSessionState } | null> {
  if (!isUuid(sessionId)) return null;
  const { rows } = await sql<{
    provider_payment_id: string | null;
    state: CheckoutSessionState;
    live: boolean;
  }>`
    select p.provider_payment_id, s.state, s.expires_at > now() as live
      from checkout_sessions s
      join payments p on p.tenant_id = s.tenant_id and p.checkout_session_id = s.id
     where s.tenant_id = ${tenantId} and s.id = ${sessionId}
       and s.source = 'staff_assisted' and p.provider = 'fake'`.execute(trx);
  const row = rows[0];
  if (!row) return null;
  const open = row.state === "open" && row.live;
  return {
    paymentRef: row.provider_payment_id,
    open,
    state: row.state === "open" && !row.live ? "expired" : row.state,
  };
}

/**
 * Record that a staff test payment asked for one outcome and the provider had
 * already settled the other (two requests raced before either settled). The
 * latest record is what staff see as the last test payment, so it reads true.
 */
export async function recordStaffTestPaymentSuperseded(
  trx: TenantTransaction,
  ctx: TenantContext,
  input: {
    sessionId: string;
    requested: StaffTestPaymentOutcome;
    settled: StaffTestPaymentOutcome;
  },
): Promise<void> {
  assertStaff(ctx);
  await record(trx, ctx, {
    action: "checkout.test_payment_superseded",
    subjectType: "checkout_session",
    subjectId: input.sessionId,
    reason: "the payment had already settled the other way",
    after: { requested: input.requested, outcome: input.settled },
  });
}

/** What staff see of a staff-assisted checkout: no booker details and no provider secret. */
export interface StaffCheckoutView {
  id: string;
  /** An open checkout past its expiry reads as expired, before the sweep writes it. */
  state: CheckoutSessionState;
  tripId: string;
  quoteId: string;
  partySize: number;
  amount: number;
  currency: "USD";
  expiresAt: string;
  createdAt: string;
  channel: BookingChannel;
  paymentState: PaymentState;
  lastTestPayment: { outcome: StaffTestPaymentOutcome; requestedAt: string } | null;
  booking: { id: string; reference: string } | null;
  refund: { state: RefundState; amount: number } | null;
}

/** One staff-assisted checkout of this tenant; a guest's, another tenant's, or none is null. */
export async function getStaffCheckout(
  trx: TenantTransaction,
  tenantId: string,
  sessionId: string,
): Promise<StaffCheckoutView | null> {
  if (!isUuid(sessionId)) return null;
  const { rows } = await sql<{
    id: string;
    state: CheckoutSessionState;
    lapsed: boolean;
    trip_id: string;
    quote_id: string;
    party_size: number;
    total_amount: number;
    expires_at: Date | string;
    created_at: Date | string;
    channel: BookingChannel;
    payment_state: PaymentState;
    booking_id: string | null;
    reference: string | null;
    refund_state: RefundState | null;
    refund_amount: number | null;
    test_outcome: StaffTestPaymentOutcome | null;
    test_at: Date | string | null;
  }>`
    select s.id, s.state, s.state = 'open' and s.expires_at <= now() as lapsed,
           s.trip_id, s.quote_id, s.party_size, o.total_amount, s.expires_at, s.created_at,
           s.channel, p.state as payment_state, b.id as booking_id, b.reference,
           r.state as refund_state, r.amount as refund_amount,
           t.after_state ->> 'outcome' as test_outcome, t.occurred_at as test_at
      from checkout_sessions s
      join orders o on o.tenant_id = s.tenant_id and o.checkout_session_id = s.id
      join payments p on p.tenant_id = s.tenant_id and p.checkout_session_id = s.id
      left join bookings b on b.tenant_id = s.tenant_id and b.checkout_session_id = s.id
      left join payment_refunds r on r.tenant_id = s.tenant_id and r.payment_id = p.id
      left join lateral (
        select a.after_state, a.occurred_at from audit_events a
         where a.tenant_id = s.tenant_id and a.subject_type = 'checkout_session'
           and a.subject_id = s.id::text
           and a.action in ('checkout.test_payment_requested', 'checkout.test_payment_superseded')
         order by a.id desc
         limit 1
      ) t on true
     where s.tenant_id = ${tenantId} and s.id = ${sessionId}
       and s.source = 'staff_assisted'`.execute(trx);
  const row = rows[0];
  if (!row) return null;
  return {
    id: row.id,
    state: row.lapsed ? "expired" : row.state,
    tripId: row.trip_id,
    quoteId: row.quote_id,
    partySize: row.party_size,
    amount: row.total_amount,
    currency: "USD",
    expiresAt: iso(row.expires_at),
    createdAt: iso(row.created_at),
    channel: row.channel,
    paymentState: row.payment_state,
    lastTestPayment:
      row.test_outcome !== null && row.test_at !== null
        ? { outcome: row.test_outcome, requestedAt: iso(row.test_at) }
        : null,
    booking:
      row.booking_id !== null && row.reference !== null
        ? { id: row.booking_id, reference: row.reference }
        : null,
    refund:
      row.refund_state && row.refund_amount !== null
        ? { state: row.refund_state, amount: row.refund_amount }
        : null,
  };
}

/** A checkout's guest view as staff see it, for a just-opened checkout. */
export function staffViewOf(
  session: CheckoutSessionView,
  channel: BookingChannel,
): StaffCheckoutView {
  return {
    id: session.id,
    state: session.state,
    tripId: session.tripId,
    quoteId: session.quoteId,
    partySize: session.partySize,
    amount: session.amount,
    currency: session.currency,
    expiresAt: session.expiresAt,
    createdAt: session.createdAt,
    channel,
    paymentState: "pending",
    lastTestPayment: null,
    booking: null,
    refund: null,
  };
}
