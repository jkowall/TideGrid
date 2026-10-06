/**
 * Opening a signing session with a waiver link. The email's link carries an
 * opaque token in its fragment; nothing happens until the guest asks, with a
 * POST, to open it. Redemption consumes the link once (the messaging module's
 * redeemAccessLink) in the same transaction that opens a signing session bound
 * to the tenant, booking, participant, request, and purpose, for the signer
 * the request requires. Only hashes of the token and of the session secret
 * are stored. The session lasts SESSION_TTL_MINUTES and is revoked when its
 * request ends or its address changes.
 *
 * Lock order: the request first, then the link, as everywhere else. The link
 * row is read once, without a lock, to learn which request it names.
 */
import {
  recordAudit,
  type TenantContext,
  type TenantTransaction,
  type WaiverRequestState,
  type WaiverSignerRole,
} from "@tidegrid/database";
import { accessTokenPattern, hashLinkToken, redeemAccessLink } from "@tidegrid/domain-messaging";
import { sql } from "kysely";
import { lockRequest } from "./delivery.ts";
import { requestIdOf, WAIVER_LINK_PURPOSE, waiverSubject } from "./links.ts";
import { hashWaiverSession, newWaiverSecret, waiverSecretPattern } from "./secrets.ts";

export const SESSION_TTL_MINUTES = 60;

export type RedeemResult =
  | { kind: "opened"; secret: string; session: WaiverSession }
  /** No such waiver link at this operator. */
  | { kind: "invalid" }
  | { kind: "expired" }
  /** Already opened once; links work once. */
  | { kind: "used" }
  /** A newer email replaced this link, or the address changed. */
  | { kind: "replaced" }
  /** The waiver no longer takes a signature: signed, superseded, or no longer needed. */
  | { kind: "closed"; state: Exclude<WaiverRequestState, "pending"> };

export interface WaiverSession {
  id: string;
  requestId: string;
  bookingId: string;
  participantId: string;
  signerRole: WaiverSignerRole;
  expiresAt: Date;
}

/**
 * Open a signing session with a waiver link's token. Only an explicit POST
 * calls this, never a GET, so a mail scanner that follows the link consumes
 * nothing.
 */
export async function redeemWaiverToken(
  trx: TenantTransaction,
  ctx: TenantContext,
  input: { token: string },
): Promise<RedeemResult> {
  if (!accessTokenPattern.test(input.token)) return { kind: "invalid" };
  const { rows: peeked } = await sql<{ subject_ref: string | null }>`
    select subject_ref from guest_access_links
     where tenant_id = ${ctx.tenantId} and token_hash = ${await hashLinkToken(input.token)}
       and purpose = ${WAIVER_LINK_PURPOSE}`.execute(trx);
  const requestId = requestIdOf(peeked[0]?.subject_ref ?? null);
  if (!requestId) return { kind: "invalid" };
  const request = await lockRequest(trx, ctx.tenantId, requestId);
  if (!request) return { kind: "invalid" };

  const redeemed = await redeemAccessLink(trx, ctx, {
    token: input.token,
    purpose: WAIVER_LINK_PURPOSE,
  });
  switch (redeemed.kind) {
    case "invalid":
    case "expired":
    case "used":
      return { kind: redeemed.kind };
    case "superseded":
      return { kind: "replaced" };
    case "revoked":
      if (redeemed.reason === "recipient_changed") return { kind: "replaced" };
      return request.state === "pending"
        ? { kind: "replaced" }
        : { kind: "closed", state: request.state };
  }
  const link = redeemed.link;
  if (
    link.subjectRef !== waiverSubject(request.id) ||
    link.bookingId !== request.booking_id ||
    link.participantId !== request.participant_id
  ) {
    throw new Error("a waiver link names another request than its subject");
  }
  // The link is spent either way; a request that no longer takes a
  // signature opens no session.
  if (request.state !== "pending") return { kind: "closed", state: request.state };

  const secret = newWaiverSecret();
  const { rows } = await sql<{ id: string; expires_at: Date }>`
    insert into waiver_signing_sessions (tenant_id, access_link_id, request_id, booking_id,
      participant_id, purpose, signer_role, secret_hash, expires_at)
    values (${ctx.tenantId}, ${link.linkId}, ${request.id}, ${request.booking_id},
            ${request.participant_id}, 'sign', ${request.required_signer},
            ${await hashWaiverSession(secret)},
            now() + make_interval(mins => ${SESSION_TTL_MINUTES}))
    returning id, expires_at`.execute(trx);
  const session = rows[0];
  if (!session) throw new Error("session insert returned no row");
  await recordAudit(trx, ctx, {
    action: "waiver_access.redeemed",
    subjectType: "waiver_request",
    subjectId: request.id,
    after: { linkId: link.linkId, sessionId: session.id, signerRole: request.required_signer },
  });
  return {
    kind: "opened",
    secret,
    session: {
      id: session.id,
      requestId: request.id,
      bookingId: request.booking_id,
      participantId: request.participant_id,
      signerRole: request.required_signer,
      expiresAt: session.expires_at,
    },
  };
}

/**
 * The session a secret names in this tenant, if it is open: not revoked and
 * not past its expiry. Anything else, including another tenant's session,
 * reads as null.
 */
export async function loadWaiverSession(
  trx: TenantTransaction,
  tenantId: string,
  secret: string,
): Promise<WaiverSession | null> {
  if (!waiverSecretPattern.test(secret)) return null;
  const hash = await hashWaiverSession(secret);
  const { rows } = await sql<{
    id: string;
    request_id: string;
    booking_id: string;
    participant_id: string;
    signer_role: WaiverSignerRole;
    expires_at: Date;
  }>`
    select id, request_id, booking_id, participant_id, signer_role, expires_at
      from waiver_signing_sessions
     where tenant_id = ${tenantId} and secret_hash = ${hash}
       and revoked_at is null and expires_at > now()`.execute(trx);
  const row = rows[0];
  if (!row) return null;
  return {
    id: row.id,
    requestId: row.request_id,
    bookingId: row.booking_id,
    participantId: row.participant_id,
    signerRole: row.signer_role,
    expiresAt: row.expires_at,
  };
}
