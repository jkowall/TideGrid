/**
 * A request's access, through the messaging module: the subject every waiver
 * message and link names, and closing a request's access when it is signed or
 * ends. Closing revokes its unused links, cancels its messages still queued,
 * and, unless it was signed, revokes its open signing sessions. Runs in the
 * caller's transaction, after the request's row lock.
 */
import type {
  TenantContext,
  TenantTransaction,
  WaiverSessionRevokedReason,
} from "@tidegrid/database";
import { cancelMessage, revokeAccessLinks } from "@tidegrid/domain-messaging";
import { sql } from "kysely";

/** The messaging module's subject for a waiver request: "waiver_request:<id>". */
export function waiverSubject(requestId: string): string {
  return `waiver_request:${requestId}`;
}

/** The request id a subject names, or null when it names something else. */
export function requestIdOf(subjectRef: string | null): string | null {
  const match = /^waiver_request:([0-9a-f-]{36})$/.exec(subjectRef ?? "");
  return match?.[1] ?? null;
}

export const WAIVER_LINK_PURPOSE = "waiver_sign" as const;
export const WAIVER_LINK_PATH = "/waiver";

/**
 * Cancel the request's waiver messages that have not gone out yet, queued or
 * in flight, and revoke the unused links they carried, with this reason (the
 * messaging module waits for a send in progress and records nothing for it).
 */
export async function cancelQueuedMessages(
  trx: TenantTransaction,
  ctx: TenantContext,
  requestId: string,
  reason: {
    link: "completed" | "withdrawn" | "recipient_changed" | "booking_canceled";
    code: string;
  } = {
    link: "withdrawn",
    code: "resent",
  },
): Promise<void> {
  const { rows } = await sql<{ message_id: string }>`
    select message_id from waiver_deliveries
     where tenant_id = ${ctx.tenantId} and request_id = ${requestId}
     order by generation`.execute(trx);
  for (const row of rows) {
    await cancelMessage(trx, ctx, row.message_id, { linkReason: reason.link, code: reason.code });
  }
}

export async function closeRequestAccess(
  trx: TenantTransaction,
  ctx: TenantContext,
  request: { id: string; booking_id: string; participant_id: string },
  reasons: {
    link: "completed" | "withdrawn" | "recipient_changed" | "booking_canceled";
    /** Null keeps open sessions open. */
    session: WaiverSessionRevokedReason | null;
    /** A session left open when the others close: the signer's own, for the signed copy. */
    keepSession?: string;
  },
): Promise<void> {
  await revokeAccessLinks(trx, ctx, {
    bookingId: request.booking_id,
    purpose: WAIVER_LINK_PURPOSE,
    participantId: request.participant_id,
    subjectRef: waiverSubject(request.id),
    reason: reasons.link,
  });
  await cancelQueuedMessages(trx, ctx, request.id, {
    link: reasons.link,
    code: reasons.link === "recipient_changed" ? "recipient_changed" : "access_withdrawn",
  });
  if (reasons.session) {
    await sql`
      update waiver_signing_sessions set revoked_at = now(), revoked_reason = ${reasons.session}
       where tenant_id = ${ctx.tenantId} and request_id = ${request.id}
         and revoked_at is null
         and id is distinct from ${reasons.keepSession ?? null}::uuid`.execute(trx);
  }
}
