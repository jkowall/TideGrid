/**
 * Sending a waiver request: one delivery generation per intentional send.
 * Generation 1 goes out when the request is assigned; each later one is an
 * audited resend, at least RESEND_INTERVAL_MINUTES after the previous one and
 * at most MAX_GENERATIONS in all (the database enforces both for every
 * writer). Each generation issues a fresh entry token, revokes the earlier
 * unredeemed ones, and queues one message whose idempotency key is
 * waiver:<request>:<generation>, all in the caller's transaction. A retry of a
 * command that already sent finds the generation and sends nothing.
 */
import {
  type JsonObject,
  recordAudit,
  type TenantContext,
  type TenantTransaction,
  type WaiverRequestState,
  type WaiverSignerRole,
} from "@tidegrid/database";
import { sql } from "kysely";
import { type BookingContext, loadBookingContext, tripFacts } from "./booking.ts";
import type { WaiverDeps, WaiverParticipant } from "./ports.ts";
import { hashWaiverToken, newWaiverSecret } from "./secrets.ts";

export const RESEND_INTERVAL_MINUTES = 10;
export const MAX_GENERATIONS = 5;
/** An emailed link works for 7 days, never past its trip's end. */
export const TOKEN_TTL_DAYS = 7;
/** A link with less time than this left before its trip ends is not worth sending. */
const MIN_LINK_MINUTES = 15;

export interface LockedRequest {
  id: string;
  booking_id: string;
  participant_id: string;
  state: WaiverRequestState;
  required_signer: WaiverSignerRole;
  template_id: string;
  template_version: number;
}

/** The request, locked for a change, in this tenant; null when there is none. */
export async function lockRequest(
  trx: TenantTransaction,
  tenantId: string,
  requestId: string,
): Promise<LockedRequest | null> {
  const { rows } = await sql<LockedRequest>`
    select id, booking_id, participant_id, state, required_signer, template_id, template_version
      from waiver_requests
     where tenant_id = ${tenantId} and id = ${requestId}
       for no key update`.execute(trx);
  return rows[0] ?? null;
}

export type SendResult =
  | {
      kind: "sent";
      deliveryId: string;
      generation: number;
      messageId: string | null;
      linkExpiresAt: Date;
    }
  /** An initial send found the request already sent; nothing new was sent. */
  | { kind: "already_sent" }
  | { kind: "not_pending"; state: WaiverRequestState }
  /** The participant is no longer on the booking. */
  | { kind: "no_participant" }
  /** The booking has no address for the participant yet. */
  | { kind: "no_address" }
  | { kind: "too_soon"; retryAfter: Date }
  | { kind: "limit_reached" }
  /** The trip ends too soon for a link to be of use. */
  | { kind: "trip_over" }
  /** The operator has no guest site to link to. */
  | { kind: "no_guest_site" };

export interface SendInput {
  requestId: string;
  kind: "initial" | "resend";
  /** Required for a resend; recorded on the delivery and in the audit history. */
  reason: string | null;
  booking?: BookingContext;
  participant?: WaiverParticipant;
}

/**
 * Send one generation of a pending request. Locks the request first, so a
 * send is ordered against signing, revocation, and other sends.
 */
export async function sendWaiverRequest(
  trx: TenantTransaction,
  ctx: TenantContext,
  deps: WaiverDeps,
  input: SendInput,
): Promise<SendResult> {
  const request = await lockRequest(trx, ctx.tenantId, input.requestId);
  if (!request) throw new Error("waiver request not found in this tenant");
  if (request.state !== "pending") return { kind: "not_pending", state: request.state };
  if (input.kind === "resend" && !input.reason) throw new TypeError("a resend needs a reason");

  const booking =
    input.booking ?? (await loadBookingContext(trx, ctx.tenantId, request.booking_id));
  if (!booking) throw new Error("a waiver request's booking was not found");
  const participant =
    input.participant ??
    (await deps.participants.list(trx, ctx.tenantId, request.booking_id)).find(
      (p) => p.id === request.participant_id,
    );
  if (!participant) return { kind: "no_participant" };
  const recipient = participant.email?.trim().toLowerCase() ?? null;
  if (!recipient) return { kind: "no_address" };

  const { rows: clock } = await sql<{
    now: Date;
    latest_generation: number | null;
    latest_at: Date | null;
    latest_recipient: string | null;
  }>`
    select now() as now, d.generation as latest_generation, d.created_at as latest_at,
           d.recipient_email as latest_recipient
      from (select 1) one
      left join lateral (
        select generation, created_at, recipient_email from waiver_deliveries
         where tenant_id = ${ctx.tenantId} and request_id = ${request.id}
         order by generation desc limit 1) d on true`.execute(trx);
  const facts = clock[0];
  if (!facts) throw new Error("no database clock");
  const now = facts.now.getTime();
  if (input.kind === "initial" && facts.latest_generation !== null) return { kind: "already_sent" };
  // A request that never went out (it had no address) goes out now as its
  // first generation, whoever asks.
  const kind = facts.latest_generation === null ? "initial" : input.kind;
  if (kind === "resend") {
    if (facts.latest_generation !== null && facts.latest_generation >= MAX_GENERATIONS) {
      return { kind: "limit_reached" };
    }
    // The interval protects one mailbox from repeats; a corrected address
    // gets the request at once, within the cap on generations.
    if (facts.latest_at !== null && facts.latest_recipient === recipient) {
      const retryAfter = facts.latest_at.getTime() + RESEND_INTERVAL_MINUTES * 60_000;
      if (retryAfter > now) return { kind: "too_soon", retryAfter: new Date(retryAfter) };
    }
  }
  const expiresAt = new Date(Math.min(now + TOKEN_TTL_DAYS * 86_400_000, booking.endsAt.getTime()));
  if (expiresAt.getTime() - now < MIN_LINK_MINUTES * 60_000) return { kind: "trip_over" };
  const origin = await deps.guestOrigin(trx, ctx.tenantId);
  if (!origin) return { kind: "no_guest_site" };

  // Replacing a link revokes the earlier ones. A new address also ends any
  // session the old address opened.
  await sql`
    update waiver_access_tokens set revoked_at = now(), revoked_reason = 'replaced'
     where tenant_id = ${ctx.tenantId} and request_id = ${request.id}
       and redeemed_at is null and revoked_at is null`.execute(trx);
  if (facts.latest_recipient !== null && facts.latest_recipient !== recipient) {
    await sql`
      update waiver_signing_sessions set revoked_at = now(), revoked_reason = 'recipient_changed'
       where tenant_id = ${ctx.tenantId} and request_id = ${request.id} and revoked_at is null`.execute(
      trx,
    );
  }

  const token = newWaiverSecret();
  const tokenRow = await trx
    .insertInto("waiver_access_tokens")
    .values({
      tenant_id: ctx.tenantId,
      request_id: request.id,
      purpose: "sign",
      token_hash: await hashWaiverToken(token),
      expires_at: expiresAt,
    })
    .returning("id")
    .executeTakeFirstOrThrow();
  const generation = (facts.latest_generation ?? 0) + 1;
  const { messageId } = await deps.mailer.enqueue(trx, ctx, {
    idempotencyKey: `waiver:${request.id}:${generation}`,
    to: recipient,
    requestId: request.id,
    generation,
    requiredSigner: request.required_signer,
    participantName: participant.name,
    recipientName:
      request.required_signer === "guardian"
        ? (participant.guardianName ?? participant.name)
        : participant.name,
    bookingId: request.booking_id,
    participantId: request.participant_id,
    operatorName: booking.operatorName,
    trip: tripFacts(booking),
    link: `${origin.replace(/\/+$/, "")}/waiver#t=${token}`,
    linkExpiresAt: expiresAt,
  });
  const delivery = await trx
    .insertInto("waiver_deliveries")
    .values({
      tenant_id: ctx.tenantId,
      request_id: request.id,
      generation,
      kind,
      recipient_email: recipient,
      token_id: tokenRow.id,
      message_id: messageId,
      reason: input.reason,
    })
    .returning("id")
    .executeTakeFirstOrThrow();
  const after: JsonObject = {
    deliveryId: delivery.id,
    generation,
    messageId,
    linkExpiresAt: expiresAt.toISOString(),
    recipientChanged: facts.latest_recipient !== null && facts.latest_recipient !== recipient,
  };
  await recordAudit(trx, ctx, {
    action: kind === "initial" ? "waiver_request.sent" : "waiver_request.resent",
    subjectType: "waiver_request",
    subjectId: request.id,
    reason: input.reason,
    after,
  });
  return {
    kind: "sent",
    deliveryId: delivery.id,
    generation,
    messageId,
    linkExpiresAt: expiresAt,
  };
}
