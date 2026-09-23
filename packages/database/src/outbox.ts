import type { TenantContext, TenantTransaction } from "./tenant.ts";
import type { JsonObject } from "./types.ts";

export interface OutboxEvent {
  /** Versioned topic, dotted and lowercase: `tenant.membership.created`. */
  topic: string;
  aggregateType: string;
  aggregateId: string;
  /** Identifiers and minimum operational data only; no secrets or personal detail. */
  payload: JsonObject;
}

/**
 * Enqueue a domain event in the caller's transaction. It becomes visible to the
 * publisher only if the domain change commits.
 */
export async function enqueueOutbox(
  trx: TenantTransaction,
  ctx: TenantContext,
  event: OutboxEvent,
): Promise<void> {
  await trx
    .insertInto("outbox_events")
    .values({
      tenant_id: ctx.tenantId,
      topic: event.topic,
      aggregate_type: event.aggregateType,
      aggregate_id: event.aggregateId,
      payload: event.payload,
      request_id: ctx.requestId ?? null,
    })
    .execute();
}
