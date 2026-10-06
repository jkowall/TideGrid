/**
 * Entry tokens and signing sessions. An email link carries an opaque token in
 * its fragment; nothing happens until the guest asks, with a POST, to open it.
 * Redeeming it consumes it, once, in the same transaction that opens a
 * signing session bound to the tenant, booking, participant, request, and
 * purpose. Only hashes of the token and the session secret are stored. The
 * session lasts SESSION_TTL_MINUTES and is revoked when its request ends.
 */
import {
  recordAudit,
  type TenantContext,
  type TenantTransaction,
  type WaiverRequestState,
  type WaiverSignerRole,
  type WaiverTokenRevokedReason,
} from "@tidegrid/database";
import { sql } from "kysely";
import { lockRequest, sendWaiverRequest } from "./delivery.ts";
import type { WaiverDeps } from "./ports.ts";
import {
  hashWaiverSession,
  hashWaiverToken,
  newWaiverSecret,
  waiverSecretPattern,
} from "./secrets.ts";

export const SESSION_TTL_MINUTES = 60;

interface TokenRow {
  id: string;
  request_id: string;
  expired: boolean;
  redeemed_at: Date | null;
  revoked_at: Date | null;
  revoked_reason: WaiverTokenRevokedReason | null;
}

async function findToken(
  trx: TenantTransaction,
  tenantId: string,
  token: string,
): Promise<TokenRow | null> {
  if (!waiverSecretPattern.test(token)) return null;
  const hash = await hashWaiverToken(token);
  const { rows } = await sql<TokenRow>`
    select id, request_id, expires_at <= now() as expired, redeemed_at, revoked_at, revoked_reason
      from waiver_access_tokens
     where tenant_id = ${tenantId} and token_hash = ${hash}`.execute(trx);
  return rows[0] ?? null;
}

export type RedeemResult =
  | { kind: "opened"; secret: string; session: WaiverSession }
  /** No such link at this operator. */
  | { kind: "invalid" }
  | { kind: "expired" }
  /** Already opened once; links work once. */
  | { kind: "used" }
  /** A newer email replaced this link. */
  | { kind: "replaced" }
  /** The waiver no longer needs this link: signed, superseded, or no longer required. */
  | { kind: "closed"; state: Exclude<WaiverRequestState, "pending"> | "pending" };

export interface WaiverSession {
  id: string;
  requestId: string;
  bookingId: string;
  participantId: string;
  signerRole: WaiverSignerRole;
  expiresAt: Date;
}

/**
 * Open a signing session with an entry token. Locks the request before the
 * token, as every command on a request does.
 */
export async function redeemWaiverToken(
  trx: TenantTransaction,
  ctx: TenantContext,
  input: { token: string },
): Promise<RedeemResult> {
  const found = await findToken(trx, ctx.tenantId, input.token);
  if (!found) return { kind: "invalid" };
  const request = await lockRequest(trx, ctx.tenantId, found.request_id);
  if (!request) return { kind: "invalid" };
  if (found.redeemed_at) return { kind: "used" };
  if (found.revoked_at) {
    return found.revoked_reason === "replaced"
      ? { kind: "replaced" }
      : { kind: "closed", state: request.state };
  }
  if (request.state !== "pending") return { kind: "closed", state: request.state };
  if (found.expired) return { kind: "expired" };

  const { rows: redeemed } = await sql<{ id: string }>`
    update waiver_access_tokens set redeemed_at = now()
     where tenant_id = ${ctx.tenantId} and id = ${found.id}
       and redeemed_at is null and revoked_at is null and expires_at > now()
    returning id`.execute(trx);
  if (!redeemed[0]) return { kind: "used" };

  const secret = newWaiverSecret();
  const { rows } = await sql<{ id: string; expires_at: Date }>`
    insert into waiver_signing_sessions (tenant_id, token_id, request_id, booking_id,
      participant_id, purpose, signer_role, secret_hash, expires_at)
    values (${ctx.tenantId}, ${found.id}, ${request.id}, ${request.booking_id},
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
    after: { tokenId: found.id, sessionId: session.id, signerRole: request.required_signer },
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

export type RenewResult = { kind: "sent" } | { kind: "not_sent"; reason: string };

/**
 * "Email me a new link": for a link that expired, was used, or was replaced,
 * send the request again to the address the booking has now, as a resend
 * with the usual limits. The caller answers the same whatever happens, so the
 * answer reveals nothing about the link.
 */
export async function renewWaiverLink(
  trx: TenantTransaction,
  ctx: TenantContext,
  deps: WaiverDeps,
  input: { token: string },
): Promise<RenewResult> {
  const found = await findToken(trx, ctx.tenantId, input.token);
  if (!found) return { kind: "not_sent", reason: "invalid" };
  if (found.revoked_at && found.revoked_reason !== "replaced") {
    return { kind: "not_sent", reason: "closed" };
  }
  // Only the newest link can ask for another, so an old or forwarded link can
  // spend at most one of the request's resends.
  const latest = await trx
    .selectFrom("waiver_deliveries")
    .select("token_id")
    .where("tenant_id", "=", ctx.tenantId)
    .where("request_id", "=", found.request_id)
    .orderBy("generation", "desc")
    .limit(1)
    .executeTakeFirst();
  if (latest?.token_id !== found.id) return { kind: "not_sent", reason: "not_latest" };
  const sent = await sendWaiverRequest(trx, ctx, deps, {
    requestId: found.request_id,
    kind: "resend",
    reason: "The guest asked for a new link",
  });
  return sent.kind === "sent" ? { kind: "sent" } : { kind: "not_sent", reason: sent.kind };
}
