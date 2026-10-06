/**
 * Ending requests that no longer apply: a participant removed from a booking,
 * or a canceled booking. A pending or signed request becomes revoked; its
 * unredeemed tokens and open sessions are revoked with it, so no link or
 * session works afterwards. Signed evidence never changes. Runs in the
 * caller's transaction, beside the removal or cancellation it follows.
 */
import {
  enqueueOutbox,
  isUuid,
  recordAudit,
  type TenantContext,
  type TenantTransaction,
  type WaiverRevokedReason,
} from "@tidegrid/database";
import { sql } from "kysely";
import { lockBookingForWaivers } from "./assign.ts";

export interface RevokeResult {
  revoked: number;
}

async function revoke(
  trx: TenantTransaction,
  ctx: TenantContext,
  bookingId: string,
  participantId: string | null,
  reason: WaiverRevokedReason,
): Promise<RevokeResult> {
  if (!isUuid(bookingId) || (participantId !== null && !isUuid(participantId))) {
    throw new TypeError("booking and participant ids must be UUIDs");
  }
  await lockBookingForWaivers(trx, ctx.tenantId, bookingId);
  const { rows } = await sql<{ id: string; state: "pending" | "signed" }>`
    select id, state from waiver_requests
     where tenant_id = ${ctx.tenantId} and booking_id = ${bookingId}
       ${participantId === null ? sql`` : sql`and participant_id = ${participantId}`}
       and state in ('pending', 'signed')
     order by id
       for no key update`.execute(trx);
  for (const request of rows) {
    await sql`
      update waiver_requests set state = 'revoked', revoked_reason = ${reason}
       where tenant_id = ${ctx.tenantId} and id = ${request.id}`.execute(trx);
    await sql`
      update waiver_access_tokens set revoked_at = now(), revoked_reason = ${reason}
       where tenant_id = ${ctx.tenantId} and request_id = ${request.id}
         and redeemed_at is null and revoked_at is null`.execute(trx);
    await sql`
      update waiver_signing_sessions set revoked_at = now(), revoked_reason = ${reason}
       where tenant_id = ${ctx.tenantId} and request_id = ${request.id}
         and revoked_at is null`.execute(trx);
    await recordAudit(trx, ctx, {
      action: "waiver_request.revoked",
      subjectType: "waiver_request",
      subjectId: request.id,
      before: { state: request.state },
      after: { state: "revoked", reason },
    });
    await enqueueOutbox(trx, ctx, {
      topic: "waiver.request.revoked",
      aggregateType: "waiver_request",
      aggregateId: request.id,
      payload: { requestId: request.id, bookingId, reason, wasSigned: request.state === "signed" },
    });
  }
  return { revoked: rows.length };
}

/**
 * A participant's requests end: they left the booking, or their details
 * changed who must sign or who they are, so a signature no longer covers them.
 */
export function revokeParticipantWaivers(
  trx: TenantTransaction,
  ctx: TenantContext,
  input: {
    bookingId: string;
    participantId: string;
    reason?: "participant_removed" | "participant_changed";
  },
): Promise<RevokeResult> {
  return revoke(
    trx,
    ctx,
    input.bookingId,
    input.participantId,
    input.reason ?? "participant_removed",
  );
}

/** The booking was canceled: every request on it ends. */
export function revokeBookingWaivers(
  trx: TenantTransaction,
  ctx: TenantContext,
  input: { bookingId: string },
): Promise<RevokeResult> {
  return revoke(trx, ctx, input.bookingId, null, "booking_canceled");
}
