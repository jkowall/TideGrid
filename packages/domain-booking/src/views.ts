import type {
  CheckoutSessionState,
  JsonObject,
  RefundState,
  TenantContext,
  TenantTransaction,
} from "@tidegrid/database";
import { enqueueOutbox, isUuid, recordAudit } from "@tidegrid/database";
import { sql } from "kysely";

/**
 * What a guest may see of their checkout: its state, the amount, the expiry,
 * and the booking reference once confirmed, or the refund when a payment could
 * not be honored. No personal data and no provider detail.
 */
export interface CheckoutSessionView {
  id: string;
  /** An open session past its expiry instant reads as expired, before the sweep writes it. */
  state: CheckoutSessionState;
  quoteId: string;
  tripId: string;
  partySize: number;
  amount: number;
  currency: "USD";
  expiresAt: string;
  createdAt: string;
  booking: { reference: string } | null;
  refund: { state: RefundState; amount: number } | null;
}

interface ViewRow {
  id: string;
  state: CheckoutSessionState;
  lapsed: boolean;
  quote_id: string;
  trip_id: string;
  party_size: number;
  expires_at: Date | string;
  created_at: Date | string;
  total_amount: number;
  currency: "USD";
  reference: string | null;
  refund_state: RefundState | null;
  refund_amount: number | null;
}

export function iso(value: Date | string): string {
  return (typeof value === "string" ? new Date(value) : value).toISOString();
}

export function isoOrNull(value: Date | string | null): string | null {
  return value === null ? null : iso(value);
}

/**
 * One session's guest view. With `secretHash`, only a session holding that
 * secret matches, so a wrong secret, another tenant's session, and an unknown
 * id all read as nothing.
 */
export async function loadSessionView(
  trx: TenantTransaction,
  tenantId: string,
  sessionId: string,
  secretHash?: string,
): Promise<CheckoutSessionView | null> {
  if (!isUuid(sessionId)) return null;
  const { rows } = await sql<ViewRow>`
    select s.id, s.state, s.state = 'open' and s.expires_at <= now() as lapsed,
           s.quote_id, s.trip_id, s.party_size, s.expires_at, s.created_at,
           o.total_amount, o.currency, b.reference,
           r.state as refund_state, r.amount as refund_amount
      from checkout_sessions s
      join orders o on o.tenant_id = s.tenant_id and o.checkout_session_id = s.id
      join payments p on p.tenant_id = s.tenant_id and p.checkout_session_id = s.id
      left join bookings b on b.tenant_id = s.tenant_id and b.checkout_session_id = s.id
      left join payment_refunds r on r.tenant_id = s.tenant_id and r.payment_id = p.id
     where s.tenant_id = ${tenantId} and s.id = ${sessionId}
       ${secretHash === undefined ? sql`` : sql`and s.secret_hash = ${secretHash}`}`.execute(trx);
  const row = rows[0];
  if (!row) return null;
  return {
    id: row.id,
    state: row.lapsed ? "expired" : row.state,
    quoteId: row.quote_id,
    tripId: row.trip_id,
    partySize: row.party_size,
    amount: row.total_amount,
    currency: row.currency,
    expiresAt: iso(row.expires_at),
    createdAt: iso(row.created_at),
    booking: row.reference ? { reference: row.reference } : null,
    refund:
      row.refund_state && row.refund_amount !== null
        ? { state: row.refund_state, amount: row.refund_amount }
        : null,
  };
}

/** The session as a plain object, for a stored idempotent response. */
export function viewJson(view: CheckoutSessionView): JsonObject {
  return { ...view };
}

/** One audit row and, when a topic is given, one outbox event, with ids only. */
export async function record(
  trx: TenantTransaction,
  ctx: TenantContext,
  entry: {
    action: string;
    subjectType: string;
    subjectId: string;
    reason?: string | null;
    before?: JsonObject | null;
    after?: JsonObject | null;
    topic?: string;
    payload?: JsonObject;
  },
): Promise<void> {
  await recordAudit(trx, ctx, {
    action: entry.action,
    subjectType: entry.subjectType,
    subjectId: entry.subjectId,
    reason: entry.reason ?? null,
    before: entry.before ?? null,
    after: entry.after ?? null,
  });
  if (entry.topic) {
    await enqueueOutbox(trx, ctx, {
      topic: entry.topic,
      aggregateType: entry.subjectType,
      aggregateId: entry.subjectId,
      payload: entry.payload ?? {},
    });
  }
}
