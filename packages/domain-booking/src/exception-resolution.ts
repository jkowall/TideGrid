/**
 * Finalization exception resolution (W1-FIN-EXC, in the G2.12 row). Staff
 * mark a payment exception as followed up, with a reason code and, when they
 * choose, a short note; the reason code other requires one. Owners and
 * booking staff resolve; the API checks the role (`exceptions.resolve`).
 *
 * A resolution records follow-up only. It changes no money, booking,
 * payment, refund, or checkout: this module writes one resolution row and
 * one audit row, nothing else. One resolution per exception, for ever
 * (migration 0017); the database sets who resolved it, the request, and the
 * time from the transaction.
 *
 * The note is text a person typed and may name a guest. It never enters an
 * audit row, an event, a log, or the idempotency store: the audit row names
 * the resolution's id and its reason code.
 */
import {
  type ExceptionResolutionReason,
  isUuid,
  recordAudit,
  type TenantContext,
  type TenantTransaction,
} from "@tidegrid/database";
import { sql } from "kysely";
import { iso } from "./views.ts";

/** A resolution as its writer is answered: without the note it sent. */
export interface ResolvedExceptionView {
  id: string;
  reasonCode: ExceptionResolutionReason;
  resolvedBy: { userId: string; name: string };
  resolvedAt: string;
}

export type ResolveExceptionResult =
  | { kind: "resolved"; resolution: ResolvedExceptionView }
  | { kind: "exception_not_found" }
  | { kind: "already_resolved" }
  | { kind: "refund_pending" };

/**
 * Resolve one of this tenant's finalization exceptions as the transaction's
 * staff actor, and record it in the audit history.
 *
 * Refused while the exception's automatic refund is still requested: its
 * outcome is not known yet, and a refund that then failed would leave the
 * open list unseen. A requested refund only ever settles to succeeded or
 * failed, so a stale read of requested can only refuse, never let through.
 *
 * Two staff resolving the same exception at once: the second insert waits on
 * the first's unique key and then does nothing, and is answered
 * already_resolved. The note is the contract's: trimmed, 1 to 500
 * characters, line breaks allowed; null when absent.
 */
export async function resolveFinalizationException(
  trx: TenantTransaction,
  ctx: TenantContext,
  input: { exceptionId: string; reasonCode: ExceptionResolutionReason; note: string | null },
): Promise<ResolveExceptionResult> {
  if (!isUuid(input.exceptionId)) return { kind: "exception_not_found" };
  const { rows: found } = await sql<{ refund_state: string | null }>`
    select r.state as refund_state
      from finalization_exceptions e
      left join payment_refunds r on r.tenant_id = e.tenant_id and r.id = e.refund_id
     where e.tenant_id = ${ctx.tenantId} and e.id = ${input.exceptionId}::uuid`.execute(trx);
  const exception = found[0];
  if (!exception) return { kind: "exception_not_found" };
  // Never true of a resolved exception: a refund leaves requested only for
  // succeeded or failed, and none resolves while it is requested.
  if (exception.refund_state === "requested") return { kind: "refund_pending" };

  const { rows: inserted } = await sql<{ id: string }>`
    insert into finalization_exception_resolutions (tenant_id, exception_id, reason_code, note)
    values (${ctx.tenantId}::uuid, ${input.exceptionId}::uuid, ${input.reasonCode}, ${input.note})
    on conflict on constraint finalization_exception_resolutions_once do nothing
    returning id`.execute(trx);
  const id = inserted[0]?.id;
  if (!id) return { kind: "already_resolved" };

  const { rows } = await sql<{
    id: string;
    reason_code: ExceptionResolutionReason;
    resolved_by_user_id: string;
    resolved_by_name: string;
    created_at: Date | string;
  }>`
    select res.id, res.reason_code, res.resolved_by_user_id,
           m.display_name as resolved_by_name, res.created_at
      from finalization_exception_resolutions res
      join tenant_memberships m
        on m.tenant_id = res.tenant_id and m.user_id = res.resolved_by_user_id
     where res.tenant_id = ${ctx.tenantId} and res.id = ${id}::uuid`.execute(trx);
  const row = rows[0];
  if (!row) throw new Error("the resolution just written cannot be read back");
  await recordAudit(trx, ctx, {
    action: "finalization_exception.resolved",
    subjectType: "finalization_exception",
    subjectId: input.exceptionId,
    after: { resolutionId: row.id, reasonCode: row.reason_code, withNote: input.note !== null },
  });
  return {
    kind: "resolved",
    resolution: {
      id: row.id,
      reasonCode: row.reason_code,
      resolvedBy: { userId: row.resolved_by_user_id, name: row.resolved_by_name },
      resolvedAt: iso(row.created_at),
    },
  };
}
