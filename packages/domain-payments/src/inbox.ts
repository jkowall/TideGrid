import type {
  InboxProcessingState,
  ProviderDisputeStatus,
  ProviderEventType,
  ProviderRefundStatus,
  TenantContext,
  TenantTransaction,
} from "@tidegrid/database";
import { sql } from "kysely";
import {
  isVerifiedProviderEvent,
  type PaymentProviderName,
  type VerifiedProviderEvent,
} from "./adapter.ts";

/**
 * The provider-event inbox (G2.7). Every verified callback is written once,
 * keyed by the provider's event id, before anything acts on it, and commits on
 * its own. Processing then runs in a second transaction that locks the inbox
 * row first, so two deliveries of one event never act twice, and a failed
 * processing attempt leaves the row received for the provider's retry or the
 * sweep. The row's content never changes; only its processing state moves.
 */

export interface InboxEvent {
  id: string;
  provider: PaymentProviderName;
  eventId: string;
  eventType: ProviderEventType;
  providerType: string;
  accountRef: string;
  paymentRef: string | null;
  clientReference: string | null;
  amount: number | null;
  currency: string | null;
  payloadSha256: string;
  processingState: InboxProcessingState;
  outcome: string | null;
  /** Present for refund.updated events (W3-G2.9). */
  refund: {
    ref: string;
    status: ProviderRefundStatus;
    key: string;
    failureCode: string | null;
  } | null;
  /** Present for dispute.updated events (W3-G2.10). */
  dispute: {
    ref: string;
    status: ProviderDisputeStatus;
    reason: string;
  } | null;
}

export interface RecordedEvent {
  inboxId: string;
  /** The event id was already in the inbox. */
  duplicate: boolean;
  /** For a duplicate: whether the body hashes the same as the first delivery. */
  samePayload: boolean;
  processingState: InboxProcessingState;
  outcome: string | null;
}

/**
 * Thrown before any database work when `recordProviderEvent` is given an
 * object that an adapter's `verifyWebhook` did not build: a spread or other
 * copy of a real event included. A programming error, never a provider's.
 */
export class UnverifiedProviderEventError extends Error {
  constructor() {
    super("only an event an adapter's verifyWebhook built can be recorded");
    this.name = "UnverifiedProviderEventError";
  }
}

/** Thrown when the event id exists but is not visible in this tenant. */
export class InboxConflictError extends Error {
  constructor() {
    super("provider event id is recorded for another tenant");
    this.name = "InboxConflictError";
  }
}

interface InboxRow {
  id: string;
  provider: PaymentProviderName;
  event_id: string;
  event_type: ProviderEventType;
  provider_type: string;
  account_ref: string;
  payment_ref: string | null;
  client_reference: string | null;
  amount: number | null;
  currency: string | null;
  payload_sha256: string;
  processing_state: InboxProcessingState;
  outcome: string | null;
  refund_ref: string | null;
  refund_status: ProviderRefundStatus | null;
  refund_key: string | null;
  refund_failure_code: string | null;
  dispute_ref: string | null;
  dispute_status: ProviderDisputeStatus | null;
  dispute_reason: string | null;
}

const inboxColumns = sql`id, provider, event_id, event_type, provider_type, account_ref,
  payment_ref, client_reference, amount, currency, payload_sha256, processing_state, outcome,
  refund_ref, refund_status, refund_key, refund_failure_code,
  dispute_ref, dispute_status, dispute_reason`;

function toInboxEvent(row: InboxRow): InboxEvent {
  return {
    id: row.id,
    provider: row.provider,
    eventId: row.event_id,
    eventType: row.event_type,
    providerType: row.provider_type,
    accountRef: row.account_ref,
    paymentRef: row.payment_ref,
    clientReference: row.client_reference,
    amount: row.amount,
    currency: row.currency,
    payloadSha256: row.payload_sha256,
    processingState: row.processing_state,
    outcome: row.outcome,
    refund:
      row.refund_ref !== null && row.refund_status !== null && row.refund_key !== null
        ? {
            ref: row.refund_ref,
            status: row.refund_status,
            key: row.refund_key,
            failureCode: row.refund_failure_code,
          }
        : null,
    dispute:
      row.dispute_ref !== null && row.dispute_status !== null && row.dispute_reason !== null
        ? { ref: row.dispute_ref, status: row.dispute_status, reason: row.dispute_reason }
        : null,
  };
}

/**
 * Record a verified event in the tenant that owns its account, once. A
 * duplicate delivery returns the first row and whether its body matches.
 * Only a VerifiedProviderEvent, which only an adapter's verifyWebhook builds,
 * can be recorded. The runtime brand is checked first, so a copy of a real
 * event (`{ ...event, accountRef }`), which the compiler accepts, is refused
 * with UnverifiedProviderEventError before any statement runs.
 */
export async function recordProviderEvent(
  trx: TenantTransaction,
  ctx: TenantContext,
  event: VerifiedProviderEvent,
): Promise<RecordedEvent> {
  if (!isVerifiedProviderEvent(event)) throw new UnverifiedProviderEventError();
  const payment = event.payment;
  const refund = event.refund;
  const dispute = event.dispute;
  const { rows } = await sql<{ id: string }>`
    insert into provider_events (
      tenant_id, provider, event_id, event_type, provider_type, account_ref, payment_ref,
      client_reference, amount, currency, provider_created_at, payload_sha256,
      refund_ref, refund_status, refund_key, refund_failure_code,
      dispute_ref, dispute_status, dispute_reason)
    values (
      ${ctx.tenantId}, ${event.provider}, ${event.eventId}, ${event.type}, ${event.providerType},
      ${event.accountRef}, ${payment?.ref ?? null}, ${payment?.clientReference ?? null},
      ${payment?.amount ?? null}, ${payment?.currency ?? null}, ${event.occurredAt},
      ${event.payloadSha256}, ${refund?.ref ?? null}, ${refund?.status ?? null},
      ${refund?.key ?? null}, ${refund?.failureCode ?? null}, ${dispute?.ref ?? null},
      ${dispute?.status ?? null}, ${dispute?.reason ?? null})
    on conflict (provider, event_id) do nothing
    returning id`.execute(trx);
  const inserted = rows[0];
  if (inserted) {
    return {
      inboxId: inserted.id,
      duplicate: false,
      samePayload: true,
      processingState: "received",
      outcome: null,
    };
  }
  const existing = await findInboxEvent(trx, ctx.tenantId, event.provider, event.eventId);
  if (!existing) throw new InboxConflictError();
  return {
    inboxId: existing.id,
    duplicate: true,
    samePayload: existing.payloadSha256 === event.payloadSha256,
    processingState: existing.processingState,
    outcome: existing.outcome,
  };
}

export async function findInboxEvent(
  trx: TenantTransaction,
  tenantId: string,
  provider: PaymentProviderName,
  eventId: string,
): Promise<InboxEvent | null> {
  const { rows } = await sql<InboxRow>`
    select ${inboxColumns} from provider_events
     where tenant_id = ${tenantId} and provider = ${provider} and event_id = ${eventId}`.execute(
    trx,
  );
  return rows[0] ? toInboxEvent(rows[0]) : null;
}

/** Lock one inbox row for processing. Take it before the checkout session. */
export async function lockInboxEvent(
  trx: TenantTransaction,
  tenantId: string,
  inboxId: string,
): Promise<InboxEvent | null> {
  const { rows } = await sql<InboxRow>`
    select ${inboxColumns} from provider_events
     where tenant_id = ${tenantId} and id = ${inboxId}
       for update`.execute(trx);
  return rows[0] ? toInboxEvent(rows[0]) : null;
}

/**
 * Lock one inbox row unless another transaction holds it. Null when one does,
 * or when the row is not in this tenant: either way there is nothing for this
 * caller to do. For processing after a quick acknowledgement, which must
 * never wait on a sweep or a redelivery that is already processing the row.
 */
export async function tryLockInboxEvent(
  trx: TenantTransaction,
  tenantId: string,
  inboxId: string,
): Promise<InboxEvent | null> {
  const { rows } = await sql<InboxRow>`
    select ${inboxColumns} from provider_events
     where tenant_id = ${tenantId} and id = ${inboxId}
       for update skip locked`.execute(trx);
  return rows[0] ? toInboxEvent(rows[0]) : null;
}

/** Record the outcome once. Refuses a row that is not received, so nothing is processed twice. */
export async function markInboxProcessed(
  trx: TenantTransaction,
  tenantId: string,
  inboxId: string,
  outcome: string,
): Promise<void> {
  const result = await trx
    .updateTable("provider_events")
    .set({ processing_state: "processed", outcome })
    .where("tenant_id", "=", tenantId)
    .where("id", "=", inboxId)
    .where("processing_state", "=", "received")
    .executeTakeFirst();
  if (result.numUpdatedRows !== 1n) {
    throw new Error("inbox event was not received, or not locked by this transaction");
  }
}

/**
 * Received events older than `olderThanSeconds`, oldest first, for the sweep.
 * Rows another transaction holds are skipped, so the sweep never waits on a
 * webhook that is processing them.
 */
export async function lockPendingInboxEvents(
  trx: TenantTransaction,
  tenantId: string,
  options: { olderThanSeconds: number; limit: number },
): Promise<InboxEvent[]> {
  const { rows } = await sql<InboxRow>`
    select ${inboxColumns} from provider_events
     where tenant_id = ${tenantId} and processing_state = 'received'
       and verified_at <= now() - make_interval(secs => ${options.olderThanSeconds})
     order by verified_at, id
     limit ${options.limit}
       for update skip locked`.execute(trx);
  return rows.map(toInboxEvent);
}
