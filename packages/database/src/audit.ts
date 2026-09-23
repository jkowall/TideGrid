import type { TenantContext, TenantTransaction } from "./tenant.ts";
import type { JsonObject } from "./types.ts";

export interface AuditEntry {
  /** Dotted, lowercase: `membership.created`. */
  action: string;
  subjectType: string;
  subjectId: string;
  /** Required for role changes, financial changes, overrides, and support access. */
  reason?: string | null;
  /** Redacted state. Never include tokens, payment data, or waiver bodies. */
  before?: JsonObject | null;
  after?: JsonObject | null;
}

/**
 * Append an audit event in the caller's transaction, so it commits or rolls
 * back with the change it describes. Actor, correlation, and source come from
 * the tenant context and are also enforced by column defaults.
 */
export async function recordAudit(
  trx: TenantTransaction,
  ctx: TenantContext,
  entry: AuditEntry,
): Promise<void> {
  await trx
    .insertInto("audit_events")
    .values({
      tenant_id: ctx.tenantId,
      actor_type: ctx.actorType,
      actor_id: ctx.actorId ?? null,
      request_id: ctx.requestId ?? null,
      source_ip: ctx.sourceIp ?? null,
      action: entry.action,
      subject_type: entry.subjectType,
      subject_id: entry.subjectId,
      reason: entry.reason ?? null,
      before_state: entry.before ?? null,
      after_state: entry.after ?? null,
    })
    .execute();
}
