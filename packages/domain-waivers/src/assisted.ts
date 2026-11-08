/**
 * Staff-assisted and QR signing (W1-G215-SIGNING, migration 0020). At the
 * dock, staff start a signing for one pending request, after ticking that
 * they checked who signs. The start issues a waiver link that no email
 * carries: single-use, lasting ASSISTED_LINK_TTL_MINUTES, bound to the
 * request's booking, participant, and subject like an emailed link, and
 * recorded with the staff member in `waiver_assisted_links`. Its token goes
 * back once, in the staff response, for the QR code or for the staff
 * device's own browser; only its hash is stored. Redeeming it is the same
 * explicit POST as an email link, and opens a session of at most
 * ASSISTED_LINK_TTL_MINUTES. The evidence then records the mode as the access
 * method, `staff_confirmed` as the match method, and the staff member.
 *
 * A new start supersedes the request's earlier unused assisted link, so one
 * code at most works per request. It never touches the emailed link: a guest
 * who signs from their email later is still fine. A newer email's link does
 * supersede an older assisted one (the messaging module's rule for a link
 * with no message).
 *
 * Lock order: the request, then its links, as everywhere else.
 */
import {
  isUuid,
  recordAudit,
  type TenantContext,
  type TenantTransaction,
  type WaiverAssistedMode,
} from "@tidegrid/database";
import { hashLinkToken, newAccessToken } from "@tidegrid/domain-messaging";
import { sql } from "kysely";
import { tripIsOver } from "./booking.ts";
import { lockRequest } from "./delivery.ts";
import { WAIVER_LINK_PATH, WAIVER_LINK_PURPOSE, waiverSubject } from "./links.ts";
import type { WaiverDeps } from "./ports.ts";

/** How long a staff-started link, and the session it opens, last (decision D1). */
export const ASSISTED_LINK_TTL_MINUTES = 15;

export type AssistedStartResult =
  | {
      kind: "issued";
      linkId: string;
      /** The raw token: return it once, in the staff response, and nowhere else. */
      token: string;
      /** The path and fragment the guest site opens: `/waiver#t=<token>`. */
      path: string;
      expiresAt: Date;
      mode: WaiverAssistedMode;
    }
  | { kind: "not_found" }
  | { kind: "not_pending" }
  | { kind: "trip_over" }
  /** The participant left the booking, or now needs another signer. */
  | { kind: "participant_changed" }
  /** The staff member did not tick that they checked who signs. */
  | { kind: "identity_unchecked" };

/**
 * Start a staff-assisted signing for one request, in the caller's staff
 * transaction. The caller holds `waivers.manage`.
 */
export async function startAssistedSigning(
  trx: TenantTransaction,
  ctx: TenantContext,
  deps: WaiverDeps,
  input: { requestId: string; mode: WaiverAssistedMode; identityChecked: boolean },
): Promise<AssistedStartResult> {
  if (!isUuid(input.requestId)) return { kind: "not_found" };
  if (input.identityChecked !== true) return { kind: "identity_unchecked" };
  if (ctx.actorType !== "staff" || !ctx.actorId) {
    throw new Error("only a staff member starts an assisted waiver signing");
  }
  const request = await lockRequest(trx, ctx.tenantId, input.requestId);
  if (!request) return { kind: "not_found" };
  if (request.state !== "pending") return { kind: "not_pending" };
  if (await tripIsOver(trx, ctx.tenantId, request.booking_id)) return { kind: "trip_over" };
  const participants = await deps.participants.list(trx, ctx.tenantId, request.booking_id);
  const participant = participants.find((p) => p.id === request.participant_id);
  if (!participant || (request.required_signer === "guardian") !== participant.minor) {
    return { kind: "participant_changed" };
  }
  const subject = waiverSubject(request.id);
  // One working code per request: the earlier unused assisted link ends.
  await sql`
    update guest_access_links l
       set revoked_at = now(), revoked_reason = 'superseded'
     where l.tenant_id = ${ctx.tenantId} and l.booking_id = ${request.booking_id}
       and l.purpose = ${WAIVER_LINK_PURPOSE}
       and l.participant_id = ${request.participant_id}
       and l.subject_ref = ${subject}
       and l.message_id is null
       and l.consumed_at is null and l.revoked_at is null`.execute(trx);
  const token = newAccessToken();
  const { rows } = await sql<{ id: string; expires_at: Date }>`
    insert into guest_access_links (tenant_id, booking_id, participant_id, purpose, subject_ref,
      message_id, token_hash, expires_at)
    values (${ctx.tenantId}, ${request.booking_id}, ${request.participant_id},
            ${WAIVER_LINK_PURPOSE}, ${subject}, null, ${await hashLinkToken(token)},
            now() + make_interval(mins => ${ASSISTED_LINK_TTL_MINUTES}))
    returning id, expires_at`.execute(trx);
  const link = rows[0];
  if (!link) throw new Error("link insert returned no row");
  await trx
    .insertInto("waiver_assisted_links")
    .values({
      tenant_id: ctx.tenantId,
      access_link_id: link.id,
      request_id: request.id,
      booking_id: request.booking_id,
      participant_id: request.participant_id,
      mode: input.mode,
      identity_checked: true,
    })
    .execute();
  await recordAudit(trx, ctx, {
    action: "waiver_access.assisted_started",
    subjectType: "waiver_request",
    subjectId: request.id,
    after: { linkId: link.id, mode: input.mode, identityChecked: true },
  });
  return {
    kind: "issued",
    linkId: link.id,
    token,
    path: `${WAIVER_LINK_PATH}#t=${token}`,
    expiresAt: new Date(link.expires_at),
    mode: input.mode,
  };
}

export interface AssistedLinkFacts {
  mode: WaiverAssistedMode;
  staffId: string;
}

/**
 * Whether a waiver link no email carried was started by staff, and how. Null
 * for an emailed link, or for a link with no assisted record, which opens
 * nothing.
 */
export async function assistedLinkFacts(
  trx: TenantTransaction,
  tenantId: string,
  linkId: string,
): Promise<AssistedLinkFacts | null> {
  const row = await trx
    .selectFrom("waiver_assisted_links")
    .select(["mode", "actor_id"])
    .where("tenant_id", "=", tenantId)
    .where("access_link_id", "=", linkId)
    .executeTakeFirst();
  return row ? { mode: row.mode, staffId: row.actor_id } : null;
}
