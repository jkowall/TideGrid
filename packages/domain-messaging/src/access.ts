/**
 * Accountless access (lane 1, G2.11c and the G2.16 shim): single-use, expiring
 * links that email carries, and the restricted sessions they open. The
 * architecture's pattern for email and QR entry points: "exchange an opaque,
 * short-lived token for a restricted session bound to tenant, booking,
 * participant or guardian, assignment, and purpose. Store token hashes,
 * support revocation, and consume tokens atomically on explicit redemption;
 * an email scanner's GET or link preview does not consume them."
 *
 * - A token is 32 random bytes, base64url (43 characters). Only its SHA-256,
 *   with a purpose-specific prefix, is stored.
 * - A link is issued by the delivery job when it sends the email that carries
 *   it, and travels only in the URL's fragment. It is consumed once, by an
 *   explicit redemption (a POST), atomically: concurrent redemptions of one
 *   token open one session.
 * - Every lookup is tenant-scoped under row-level security, so another
 *   tenant's token is simply invalid.
 * - A session's token goes back once, in the redemption's response body, and
 *   is sent as a bearer token; it never appears in a URL.
 */
import {
  type AccessPurpose,
  type AccessRevocationReason,
  isUuid,
  type TenantContext,
  type TenantTransaction,
} from "@tidegrid/database";
import { sql } from "kysely";
import { subjectRefPattern } from "./enqueue.ts";

export const accessTokenPattern = /^[A-Za-z0-9_-]{43}$/;
/** A guest session lasts at most this long; the database refuses longer. */
export const MAX_SESSION_TTL_SECONDS = 12 * 3600;
export const DEFAULT_SESSION_TTL_SECONDS = 3600;

const encoder = new TextEncoder();

async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", encoder.encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function base64url(bytes: Uint8Array): string {
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

/** 32 random bytes, base64url without padding. */
export function newAccessToken(): string {
  return base64url(crypto.getRandomValues(new Uint8Array(32)));
}

/** The only form of a link token that is stored. */
export function hashLinkToken(token: string): Promise<string> {
  if (!accessTokenPattern.test(token))
    throw new TypeError("an access token is 43 base64url characters");
  return sha256Hex(`access-link:${token}`);
}

/** The only form of a session token that is stored. */
export function hashSessionToken(token: string): Promise<string> {
  if (!accessTokenPattern.test(token))
    throw new TypeError("a session token is 43 base64url characters");
  return sha256Hex(`guest-session:${token}`);
}

// Links -------------------------------------------------------------------------------

export interface IssueAccessLinkInput {
  bookingId: string;
  /** Required for waiver_sign. */
  participantId?: string | null;
  purpose: AccessPurpose;
  subjectRef?: string | null;
  /** The email that carries it; links issued for one message never supersede each other. */
  messageId?: string | null;
  ttlSeconds: number;
}

export interface IssuedAccessLink {
  linkId: string;
  /** The raw token: put it in the email and nowhere else. */
  token: string;
  expiresAt: string;
  /** Live links of the same booking, purpose, participant, and subject that this one replaced. */
  superseded: number;
}

/**
 * Issue a link in the caller's transaction (the delivery job's claim). Revokes,
 * as `superseded`, the unused links of the same booking, purpose, participant,
 * and subject that other messages carried, so only the newest email's link
 * works.
 */
export async function issueAccessLink(
  trx: TenantTransaction,
  ctx: TenantContext,
  input: IssueAccessLinkInput,
): Promise<IssuedAccessLink> {
  const participantId = input.participantId ?? null;
  const subjectRef = input.subjectRef ?? null;
  const messageId = input.messageId ?? null;
  if (!isUuid(input.bookingId)) throw new TypeError("bookingId must be a UUID");
  if (participantId !== null && !isUuid(participantId))
    throw new TypeError("participantId must be a UUID");
  if (messageId !== null && !isUuid(messageId)) throw new TypeError("messageId must be a UUID");
  if (subjectRef !== null && !subjectRefPattern.test(subjectRef)) {
    throw new TypeError("subjectRef is '<type>:<uuid>'");
  }
  if (!Number.isInteger(input.ttlSeconds) || input.ttlSeconds < 300 || input.ttlSeconds > 1209600) {
    throw new RangeError("a link lasts 300 seconds to 14 days");
  }
  const { rows: revoked } = await sql<{ id: string }>`
    update guest_access_links
       set revoked_at = now(), revoked_reason = 'superseded'
     where tenant_id = ${ctx.tenantId} and booking_id = ${input.bookingId}
       and purpose = ${input.purpose}
       and participant_id is not distinct from ${participantId}
       and subject_ref is not distinct from ${subjectRef}
       and message_id is distinct from ${messageId}
       and consumed_at is null and revoked_at is null
    returning id`.execute(trx);
  const token = newAccessToken();
  const tokenHash = await hashLinkToken(token);
  const { rows } = await sql<{ id: string; expires_at: Date | string }>`
    insert into guest_access_links (tenant_id, booking_id, participant_id, purpose, subject_ref,
      message_id, token_hash, expires_at)
    values (${ctx.tenantId}, ${input.bookingId}, ${participantId}, ${input.purpose}, ${subjectRef},
            ${messageId}, ${tokenHash}, now() + make_interval(secs => ${input.ttlSeconds}))
    returning id, expires_at`.execute(trx);
  const row = rows[0];
  if (!row) throw new Error("link insert returned no row");
  return {
    linkId: row.id,
    token,
    expiresAt: new Date(row.expires_at).toISOString(),
    superseded: revoked.length,
  };
}

export interface RedeemedLink {
  linkId: string;
  bookingId: string;
  participantId: string | null;
  messageId: string | null;
  subjectRef: string | null;
  purpose: AccessPurpose;
}

export type RedeemAccessLinkResult =
  | { kind: "redeemed"; link: RedeemedLink }
  /** Malformed, unknown, another tenant's, or for another purpose. */
  | { kind: "invalid" }
  | { kind: "expired" }
  | { kind: "used" }
  /** A newer email's link replaced it. */
  | { kind: "superseded" }
  | { kind: "revoked"; reason: Exclude<AccessRevocationReason, "superseded"> };

interface LinkRow {
  id: string;
  booking_id: string;
  participant_id: string | null;
  message_id: string | null;
  subject_ref: string | null;
  purpose: AccessPurpose;
  consumed_at: Date | string | null;
  revoked_at: Date | string | null;
  revoked_reason: AccessRevocationReason | null;
  expired: boolean;
}

/**
 * Consume a link once, for its purpose, in the caller's transaction: only an
 * explicit redemption (a POST) calls this, never a GET. Concurrent
 * redemptions of one token serialize on its row; one consumes it and the
 * others answer `used`. The tenant is the caller's, so another tenant's token
 * is `invalid`. The caller opens the session in the same transaction.
 */
export async function redeemAccessLink(
  trx: TenantTransaction,
  ctx: TenantContext,
  input: { token: string; purpose: AccessPurpose },
): Promise<RedeemAccessLinkResult> {
  if (typeof input.token !== "string" || !accessTokenPattern.test(input.token)) {
    return { kind: "invalid" };
  }
  const tokenHash = await hashLinkToken(input.token);
  const { rows } = await sql<LinkRow>`
    update guest_access_links
       set consumed_at = now()
     where tenant_id = ${ctx.tenantId} and token_hash = ${tokenHash}
       and purpose = ${input.purpose}
       and consumed_at is null and revoked_at is null and expires_at > now()
    returning id, booking_id, participant_id, message_id, subject_ref, purpose, consumed_at,
              revoked_at, revoked_reason, false as expired`.execute(trx);
  const used = rows[0];
  if (used) {
    return {
      kind: "redeemed",
      link: {
        linkId: used.id,
        bookingId: used.booking_id,
        participantId: used.participant_id,
        messageId: used.message_id,
        subjectRef: used.subject_ref,
        purpose: used.purpose,
      },
    };
  }
  const { rows: found } = await sql<LinkRow>`
    select id, booking_id, participant_id, message_id, subject_ref, purpose, consumed_at,
           revoked_at, revoked_reason, expires_at <= now() as expired
      from guest_access_links
     where tenant_id = ${ctx.tenantId} and token_hash = ${tokenHash}`.execute(trx);
  const link = found[0];
  if (!link || link.purpose !== input.purpose) return { kind: "invalid" };
  if (link.consumed_at !== null) return { kind: "used" };
  if (link.revoked_reason === "superseded") return { kind: "superseded" };
  if (link.revoked_reason !== null) return { kind: "revoked", reason: link.revoked_reason };
  if (link.expired) return { kind: "expired" };
  // Live, unexpired, and unused, yet not updated: only a concurrent change to
  // the row between the two statements does that. Ask the guest to try again.
  return { kind: "invalid" };
}

/**
 * Revoke the unused links of one booking and purpose, optionally of one
 * participant and subject: a waiver signed (completed), a requirement or
 * participant removed (withdrawn), a recipient corrected, a booking canceled.
 * Answers how many were revoked. Used links stay as they are; their sessions
 * are revoked with `revokeGuestSessions`.
 */
export async function revokeAccessLinks(
  trx: TenantTransaction,
  ctx: TenantContext,
  input: {
    bookingId: string;
    purpose: AccessPurpose;
    /** Only this participant's links; omit for every participant's. */
    participantId?: string | null;
    /** Only this subject's links; omit for every subject's. */
    subjectRef?: string | null;
    reason: AccessRevocationReason;
  },
): Promise<number> {
  if (!isUuid(input.bookingId)) throw new TypeError("bookingId must be a UUID");
  const byParticipant = input.participantId !== undefined;
  const bySubject = input.subjectRef !== undefined;
  const { rows } = await sql<{ id: string }>`
    update guest_access_links
       set revoked_at = now(), revoked_reason = ${input.reason}
     where tenant_id = ${ctx.tenantId} and booking_id = ${input.bookingId}
       and purpose = ${input.purpose}
       and (${!byParticipant} or participant_id is not distinct from ${input.participantId ?? null})
       and (${!bySubject} or subject_ref is not distinct from ${input.subjectRef ?? null})
       and consumed_at is null and revoked_at is null
    returning id`.execute(trx);
  return rows.length;
}

// Sessions ------------------------------------------------------------------------------

export interface GuestSession {
  sessionId: string;
  bookingId: string;
  participantId: string | null;
  purpose: AccessPurpose;
  subjectRef: string | null;
  expiresAt: string;
}

export interface OpenedSession extends GuestSession {
  /** The raw token: return it once, in the response body, and nowhere else. */
  token: string;
}

/**
 * Open a restricted session in the transaction that redeemed its link, or,
 * for the guest who just paid, from the checkout that made the booking within
 * an hour of confirmation. The database refuses any other opening.
 */
export async function openGuestSession(
  trx: TenantTransaction,
  ctx: TenantContext,
  input:
    | { link: RedeemedLink; ttlSeconds?: number }
    | { checkout: { checkoutSessionId: string; bookingId: string }; ttlSeconds?: number },
): Promise<OpenedSession> {
  const ttl = input.ttlSeconds ?? DEFAULT_SESSION_TTL_SECONDS;
  if (!Number.isInteger(ttl) || ttl < 60 || ttl > MAX_SESSION_TTL_SECONDS) {
    throw new RangeError("a guest session lasts 60 seconds to 12 hours");
  }
  const token = newAccessToken();
  const tokenHash = await hashSessionToken(token);
  const from =
    "link" in input
      ? {
          bookingId: input.link.bookingId,
          participantId: input.link.participantId,
          purpose: input.link.purpose,
          subjectRef: input.link.subjectRef,
          linkId: input.link.linkId,
          checkoutSessionId: null,
        }
      : {
          bookingId: input.checkout.bookingId,
          participantId: null,
          purpose: "booking_manage" as const,
          subjectRef: null,
          linkId: null,
          checkoutSessionId: input.checkout.checkoutSessionId,
        };
  const { rows } = await sql<{ id: string; expires_at: Date | string }>`
    insert into guest_sessions (tenant_id, booking_id, participant_id, purpose, subject_ref, link_id,
      checkout_session_id, token_hash, expires_at)
    values (${ctx.tenantId}, ${from.bookingId}, ${from.participantId}, ${from.purpose},
            ${from.subjectRef}, ${from.linkId}, ${from.checkoutSessionId}, ${tokenHash},
            now() + make_interval(secs => ${ttl}))
    returning id, expires_at`.execute(trx);
  const row = rows[0];
  if (!row) throw new Error("session insert returned no row");
  return {
    sessionId: row.id,
    token,
    bookingId: from.bookingId,
    participantId: from.participantId,
    purpose: from.purpose,
    subjectRef: from.subjectRef,
    expiresAt: new Date(row.expires_at).toISOString(),
  };
}

/**
 * The live session a bearer token names, for one purpose, in this tenant; null
 * for a malformed, unknown, expired, revoked, another tenant's, or another
 * purpose's token. Database clock.
 */
export async function resolveGuestSession(
  trx: TenantTransaction,
  tenantId: string,
  token: string,
  purpose: AccessPurpose,
): Promise<GuestSession | null> {
  if (typeof token !== "string" || !accessTokenPattern.test(token)) return null;
  const tokenHash = await hashSessionToken(token);
  const { rows } = await sql<{
    id: string;
    booking_id: string;
    participant_id: string | null;
    purpose: AccessPurpose;
    subject_ref: string | null;
    expires_at: Date | string;
  }>`
    select id, booking_id, participant_id, purpose, subject_ref, expires_at
      from guest_sessions
     where tenant_id = ${tenantId} and token_hash = ${tokenHash} and purpose = ${purpose}
       and revoked_at is null and expires_at > now()`.execute(trx);
  const row = rows[0];
  if (!row) return null;
  return {
    sessionId: row.id,
    bookingId: row.booking_id,
    participantId: row.participant_id,
    purpose: row.purpose,
    subjectRef: row.subject_ref,
    expiresAt: new Date(row.expires_at).toISOString(),
  };
}

/** End a session early (signing out). Answers whether it was live. */
export async function revokeGuestSession(
  trx: TenantTransaction,
  ctx: TenantContext,
  sessionId: string,
): Promise<boolean> {
  if (!isUuid(sessionId)) return false;
  const { rows } = await sql<{ id: string }>`
    update guest_sessions set revoked_at = now()
     where tenant_id = ${ctx.tenantId} and id = ${sessionId} and revoked_at is null
    returning id`.execute(trx);
  return rows.length === 1;
}

/**
 * Revoke the live sessions of one booking and purpose, optionally of one
 * participant and subject, such as when a waiver is signed or its recipient
 * corrected. Answers how many.
 */
export async function revokeGuestSessions(
  trx: TenantTransaction,
  ctx: TenantContext,
  input: {
    bookingId: string;
    purpose: AccessPurpose;
    participantId?: string | null;
    subjectRef?: string | null;
  },
): Promise<number> {
  if (!isUuid(input.bookingId)) throw new TypeError("bookingId must be a UUID");
  const byParticipant = input.participantId !== undefined;
  const bySubject = input.subjectRef !== undefined;
  const { rows } = await sql<{ id: string }>`
    update guest_sessions set revoked_at = now()
     where tenant_id = ${ctx.tenantId} and booking_id = ${input.bookingId}
       and purpose = ${input.purpose}
       and (${!byParticipant} or participant_id is not distinct from ${input.participantId ?? null})
       and (${!bySubject} or subject_ref is not distinct from ${input.subjectRef ?? null})
       and revoked_at is null and expires_at > now()
    returning id`.execute(trx);
  return rows.length;
}
