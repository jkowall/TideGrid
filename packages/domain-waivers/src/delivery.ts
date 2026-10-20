/**
 * Sending a waiver request: one delivery generation per intentional send.
 * Generation 1 goes out when the request is assigned; each later one is an
 * audited resend, at most MAX_GENERATIONS in all. Across all of a
 * participant's requests, the database's sending limits
 * (app.waiver_send_refusal) hold every writer: RESEND_INTERVAL_MINUTES
 * between sends to one address, and caps per participant, address, booking,
 * and operator. This module asks those limits first, so a booking hook never
 * fails on one: a send no one waits on (a hook, a version move) that only the
 * interval holds is queued for when it is allowed; anything else answers why.
 * Email content that cannot be built answers email_invalid, under a
 * savepoint, so it never fails the caller's transaction either.
 *
 * A generation queues one message through the messaging module, in the
 * caller's transaction, deduplicated by waiver.request:<request>:<generation>,
 * with a waiver link the delivery job issues when it sends: the token is never
 * stored in a message, only its hash in the link. Messages of earlier
 * generations still queued are canceled, so only the newest goes out, and a
 * new address revokes the old one's links and sessions. A retry of a command
 * that already sent finds the generation and sends nothing.
 */
import {
  type JsonObject,
  recordAudit,
  type TenantContext,
  type TenantTransaction,
  type WaiverRequestState,
  type WaiverSignerRole,
} from "@tidegrid/database";
import { enqueueMessage } from "@tidegrid/domain-messaging";
import { sql } from "kysely";
import { type BookingContext, loadBookingContext, tripFacts } from "./booking.ts";
import { WAIVER_EMAIL_TEMPLATE, WAIVER_EMAIL_VERSION, waiverRequestEmail } from "./email.ts";
import {
  cancelQueuedMessages,
  closeRequestAccess,
  WAIVER_LINK_PATH,
  WAIVER_LINK_PURPOSE,
  waiverSubject,
} from "./links.ts";
import type { WaiverDeps, WaiverParticipant } from "./ports.ts";

export const RESEND_INTERVAL_MINUTES = 10;
export const MAX_GENERATIONS = 5;
/** An emailed link lasts 7 days once sent, never past its trip's end. */
export const LINK_TTL_DAYS = 7;
/** A link with less time than this left before its trip ends is not worth sending. */
const MIN_LINK_SECONDS = 15 * 60;

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

/** A sending cap across requests (app.waiver_send_refusal). */
export type RateScope = "participant" | "address" | "booking" | "tenant";

export type SendResult =
  | {
      kind: "sent";
      deliveryId: string;
      generation: number;
      messageId: string;
      /** When the generation was recorded, by the database clock. */
      queuedAt: Date;
      /** When the email may first go out: later than queuedAt when the interval held it. */
      sendAfter: Date;
    }
  /** An initial send found the request already sent; nothing new was sent. */
  | { kind: "already_sent" }
  | { kind: "not_pending"; state: WaiverRequestState }
  /** The participant is no longer on the booking. */
  | { kind: "no_participant" }
  /** The booking has no address for the participant yet. */
  | { kind: "no_address" }
  /** This participant's waiver went to this address less than the interval ago. */
  | { kind: "too_soon"; retryAfter: Date }
  /** This request has had MAX_GENERATIONS sends. */
  | { kind: "limit_reached" }
  /** A sending cap across requests: per participant, address, booking, or operator. */
  | { kind: "rate_limited"; scope: RateScope; retryAfter: Date }
  /** The trip ends too soon for a link to be of use. */
  | { kind: "trip_over" }
  /** The email could not be built from the booking's details; nothing was queued. */
  | { kind: "email_invalid" };

export interface SendInput {
  requestId: string;
  kind: "initial" | "resend";
  /** Required for a resend; recorded on the delivery and in the audit history. */
  reason: string | null;
  booking?: BookingContext;
  participant?: WaiverParticipant;
  /**
   * For a send no one is waiting on (a booking hook, a version move): when
   * only the interval holds it, queue it for when it is allowed instead of
   * answering too_soon.
   */
  whenAllowed?: boolean;
}

/** Who the email greets: the participant, or a minor's parent or guardian. */
function recipientName(participant: WaiverParticipant, role: WaiverSignerRole): string {
  return role === "guardian" ? (participant.guardianName ?? participant.name) : participant.name;
}

export type SendingRefusal = { code: "interval" | RateScope; retry_after: Date } | null;

/** Why the database's sending limits would refuse this send at `at`, or null. */
export async function sendingRefusal(
  trx: TenantTransaction,
  tenantId: string,
  request: { booking_id: string; participant_id: string },
  recipient: string,
  at: Date,
): Promise<SendingRefusal> {
  const { rows } = await sql<{ code: "interval" | RateScope; retry_after: Date }>`
    select code, retry_after from app.waiver_send_refusal(
      ${tenantId}, ${request.booking_id}, ${request.participant_id}, ${recipient}, ${at})`.execute(
    trx,
  );
  return rows[0] ?? null;
}

/** A sending limit the delivery trigger raised, if that is what this error is. */
function triggerRefusal(error: unknown): "interval" | "limit" | null {
  const e = error as { code?: unknown; constraint_name?: unknown } | null;
  if (e?.code !== "23514") return null;
  if (e.constraint_name === "waiver_deliveries_rate") return "interval";
  if (e.constraint_name === "waiver_deliveries_limit") return "limit";
  return null;
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
  const recipient = participant.email?.trim().toLowerCase() || null;

  // The latest generation, and whether its address's access was closed for a
  // recipient change, so that the same address, added back, counts as a
  // change too.
  const { rows: clock } = await sql<{
    now: Date;
    latest_generation: number | null;
    latest_recipient: string | null;
    latest_closed: boolean | null;
  }>`
    select now() as now, d.generation as latest_generation,
           d.recipient_email as latest_recipient,
           (exists (select 1 from email_messages m
                     where m.tenant_id = d.tenant_id and m.id = d.message_id
                       and m.state = 'canceled' and m.last_error_code = 'recipient_changed')
            or exists (select 1 from guest_access_links l
                        where l.tenant_id = d.tenant_id and l.message_id = d.message_id
                          and l.revoked_reason = 'recipient_changed')) as latest_closed
      from (select 1) one
      left join lateral (
        select tenant_id, generation, recipient_email, message_id from waiver_deliveries
         where tenant_id = ${ctx.tenantId} and request_id = ${request.id}
         order by generation desc limit 1) d on true`.execute(trx);
  const facts = clock[0];
  if (!facts) throw new Error("no database clock");
  const closeOldAddress = () =>
    closeRequestAccess(trx, ctx, request, {
      link: "recipient_changed",
      session: "recipient_changed",
    });
  if (!recipient) {
    // The address removed from the booking is no longer this participant's:
    // its unsent email is canceled and its links and sessions end.
    if (facts.latest_recipient !== null) await closeOldAddress();
    return { kind: "no_address" };
  }
  if (input.kind === "initial" && facts.latest_generation !== null) return { kind: "already_sent" };
  // A request that never went out (it had no address) goes out now as its
  // first generation, whoever asks.
  const kind = facts.latest_generation === null ? "initial" : input.kind;
  const recipientChanged =
    facts.latest_recipient !== null &&
    (facts.latest_recipient !== recipient || facts.latest_closed === true);
  if (kind === "resend" && (facts.latest_generation ?? 0) >= MAX_GENERATIONS) {
    // Nothing more goes out, but an address that is no longer this
    // participant's loses its links and sessions all the same.
    if (recipientChanged) await closeOldAddress();
    return { kind: "limit_reached" };
  }

  // The sending limits now; a send that only the interval holds goes out when
  // it is allowed, if no one is waiting on it.
  let sendAfter = facts.now;
  let refusal = await sendingRefusal(trx, ctx.tenantId, request, recipient, facts.now);
  if (refusal?.code === "interval" && input.whenAllowed) {
    sendAfter = refusal.retry_after;
    refusal = await sendingRefusal(trx, ctx.tenantId, request, recipient, sendAfter);
  }
  if (refusal) {
    if (recipientChanged) await closeOldAddress();
    return refusal.code === "interval"
      ? { kind: "too_soon", retryAfter: refusal.retry_after }
      : { kind: "rate_limited", scope: refusal.code, retryAfter: refusal.retry_after };
  }
  const ttlSeconds = Math.floor(
    Math.min(LINK_TTL_DAYS * 86_400_000, booking.endsAt.getTime() - sendAfter.getTime()) / 1000,
  );
  if (ttlSeconds < MIN_LINK_SECONDS) {
    if (recipientChanged) await closeOldAddress();
    return { kind: "trip_over" };
  }

  if (recipientChanged) {
    // The old address loses its links and any session it opened.
    await closeOldAddress();
  } else {
    // Only the newest email goes out; an earlier one still queued is canceled.
    await cancelQueuedMessages(trx, ctx, request.id);
  }

  const generation = (facts.latest_generation ?? 0) + 1;
  const held = sendAfter.getTime() > facts.now.getTime();
  // The message and its delivery row commit together or not at all, and a
  // refusal of either never fails the caller's transaction.
  await sql`savepoint waiver_send`.execute(trx);
  let messageId: string;
  let deliveryId: string;
  try {
    const enqueued = await enqueueMessage(trx, ctx, {
      dedupeKey: `waiver.request:${request.id}:${generation}`,
      template: WAIVER_EMAIL_TEMPLATE,
      templateVersion: WAIVER_EMAIL_VERSION,
      to: { email: recipient, name: recipientName(participant, request.required_signer) },
      bookingId: request.booking_id,
      participantId: request.participant_id,
      subjectRef: waiverSubject(request.id),
      content: waiverRequestEmail({
        requiredSigner: request.required_signer,
        participantName: participant.name,
        recipientName: recipientName(participant, request.required_signer),
        operatorName: booking.operatorName,
        trip: tripFacts(booking),
        linkDays: Math.floor(ttlSeconds / 86_400),
        kind,
      }),
      accessLink: { purpose: WAIVER_LINK_PURPOSE, path: WAIVER_LINK_PATH, ttlSeconds },
      notBefore: held ? sendAfter : null,
    });
    if (enqueued.kind === "duplicate") {
      // The generation's key belongs to this request alone, and generations
      // follow the deliveries, so a duplicate means a message without its
      // delivery row: refuse rather than send under another generation.
      throw new Error(`waiver message for ${request.id} generation ${generation} already exists`);
    }
    messageId = enqueued.messageId;
    const delivery = await trx
      .insertInto("waiver_deliveries")
      .values({
        tenant_id: ctx.tenantId,
        request_id: request.id,
        generation,
        kind,
        recipient_email: recipient,
        message_id: enqueued.messageId,
        send_after: sendAfter,
        reason: input.reason,
      })
      .returning("id")
      .executeTakeFirstOrThrow();
    deliveryId = delivery.id;
    await sql`release savepoint waiver_send`.execute(trx);
  } catch (error) {
    const limit = triggerRefusal(error);
    if (!(error instanceof TypeError) && limit === null) throw error;
    await sql`rollback to savepoint waiver_send`.execute(trx);
    await sql`release savepoint waiver_send`.execute(trx);
    if (error instanceof TypeError) return { kind: "email_invalid" };
    // Another send got in first, such as a concurrent booking's to this
    // address: read the limits again for the answer.
    const again = await sendingRefusal(trx, ctx.tenantId, request, recipient, sendAfter);
    if (again && again.code !== "interval") {
      return { kind: "rate_limited", scope: again.code, retryAfter: again.retry_after };
    }
    return {
      kind: "too_soon",
      retryAfter:
        again?.retry_after ?? new Date(sendAfter.getTime() + RESEND_INTERVAL_MINUTES * 60_000),
    };
  }
  const after: JsonObject = {
    deliveryId,
    generation,
    messageId,
    linkTtlSeconds: ttlSeconds,
    recipientChanged,
    sendAfter: sendAfter.toISOString(),
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
    deliveryId,
    generation,
    messageId,
    queuedAt: facts.now,
    sendAfter,
  };
}
