/**
 * A guest's own new waiver link (W1-WAIVER-RENEWAL, D1), and a staff reset of
 * a request's five sends (D2).
 *
 * Renewal: a guest whose emailed link was spent, lapsed, or replaced sends
 * that link's token back. When its request still waits for a signature, a new
 * generation goes to the address the latest generation went to, never
 * anywhere else, at most three a day for the participant. The answer to the
 * guest is the same whatever happened, so a token says nothing about an
 * address or a booking. Staff-assisted codes are not renewed.
 *
 * Reset: once a request has had its five sends, a staff member may allow
 * five more with a reason. The database holds the count and records who
 * reset it.
 */
import { recordAudit, type TenantContext, type TenantTransaction } from "@tidegrid/database";
import { accessTokenPattern, hashLinkToken } from "@tidegrid/domain-messaging";
import { sql } from "kysely";
import { tripIsOver } from "./booking.ts";
import {
  lockRequest,
  MAX_ALL_GENERATIONS,
  MAX_GENERATIONS,
  sendWaiverRequest,
} from "./delivery.ts";
import { requestIdOf, WAIVER_LINK_PURPOSE } from "./links.ts";
import type { WaiverDeps } from "./ports.ts";

export const GUEST_RENEWAL_REASON = "The guest asked for a new link";

export type RenewalResult =
  | { kind: "renewed"; generation: number }
  | {
      kind: "skipped";
      reason:
        | "invalid"
        | "not_pending"
        | "trip_over"
        | "still_usable"
        | "email_pending"
        | "not_renewable"
        | "renewal_limit"
        | "limit_reached"
        | "too_soon"
        | "rate_limited"
        | "email_invalid";
    };

/**
 * Renew an emailed waiver link for the guest holding its token, in the
 * caller's guest transaction. Every outcome is answered the same way to the
 * guest; the result is for audit and tests.
 */
export async function renewWaiverLink(
  trx: TenantTransaction,
  ctx: TenantContext,
  deps: WaiverDeps,
  input: { token: string },
): Promise<RenewalResult> {
  const skip = (reason: Extract<RenewalResult, { kind: "skipped" }>["reason"]) =>
    ({ kind: "skipped", reason }) as const;
  if (ctx.actorType !== "guest") throw new Error("only a guest renews their own waiver link");
  if (!accessTokenPattern.test(input.token)) return skip("invalid");
  const { rows: peeked } = await sql<{
    subject_ref: string | null;
    message_id: string | null;
    sent_to: string | null;
  }>`
    select l.subject_ref, l.message_id, m.to_email as sent_to
      from guest_access_links l
      left join email_messages m on m.tenant_id = l.tenant_id and m.id = l.message_id
     where l.tenant_id = ${ctx.tenantId} and l.token_hash = ${await hashLinkToken(input.token)}
       and l.purpose = ${WAIVER_LINK_PURPOSE}`.execute(trx);
  const link = peeked[0];
  const requestId = requestIdOf(link?.subject_ref ?? null);
  // Only a link an email carried: a staff-assisted code is the dock's to issue.
  if (!link || !requestId || link.message_id === null) return skip("invalid");
  const request = await lockRequest(trx, ctx.tenantId, requestId);
  if (!request) return skip("invalid");
  if (request.state !== "pending") return skip("not_pending");
  if (await tripIsOver(trx, ctx.tenantId, request.booking_id)) return skip("trip_over");
  // An invitation or reminder still on its way issues its link when it is
  // sent, under its message's lock, not the request's. Wait for any such send
  // to finish (the lock), then leave the email to arrive: renewing now would
  // replace a link the guest is about to get.
  const { rows: pending } = await sql<{ id: string }>`
    select m.id from email_messages m
     where m.tenant_id = ${ctx.tenantId}
       and m.id in (select d.message_id from waiver_deliveries d
                     where d.tenant_id = ${ctx.tenantId} and d.request_id = ${request.id}
                    union all
                    select w.message_id from waiver_reminders w
                     where w.tenant_id = ${ctx.tenantId} and w.request_id = ${request.id})
       and m.state in ('queued', 'sending')
     for no key update of m`.execute(trx);
  if (pending.length > 0) return skip("email_pending");
  // Any emailed link of this request that still works is the guest's to use,
  // whichever token asked: nothing new goes out, and an old token cannot
  // spend the guest's sends while their newest link waits in their inbox. A
  // link whose email the provider refused never reached the guest, so it
  // does not count; one whose outcome is unknown (failed as
  // `outcome_unknown`) may have, so it still does.
  const { rows: live } = await sql<{ n: number }>`
    select count(*)::int as n from guest_access_links l
      join email_messages m on m.tenant_id = l.tenant_id and m.id = l.message_id
     where l.tenant_id = ${ctx.tenantId} and l.subject_ref = ${link.subject_ref}
       and l.purpose = ${WAIVER_LINK_PURPOSE}
       and l.consumed_at is null and l.revoked_at is null and l.expires_at > now()
       and (m.state <> 'failed' or m.last_error_code = 'outcome_unknown')`.execute(trx);
  if ((live[0]?.n ?? 0) > 0) return skip("still_usable");
  // Only a link that went to the address the latest invitation went to: after
  // a corrected address, a link the old address held (opened or not) renews
  // nothing, so it cannot keep sending the new address emails.
  const { rows: latest } = await sql<{ recipient_email: string }>`
    select recipient_email from waiver_deliveries
     where tenant_id = ${ctx.tenantId} and request_id = ${request.id}
     order by generation desc limit 1`.execute(trx);
  const latestTo = latest[0]?.recipient_email;
  if (!latestTo || link.sent_to?.toLowerCase() !== latestTo.toLowerCase()) {
    return skip("not_renewable");
  }

  const sent = await sendWaiverRequest(trx, ctx, deps, {
    requestId: request.id,
    kind: "resend",
    reason: GUEST_RENEWAL_REASON,
    guestRenewal: true,
  });
  switch (sent.kind) {
    case "sent":
      return { kind: "renewed", generation: sent.generation };
    case "not_pending":
    case "already_sent":
      return skip("not_pending");
    case "no_participant":
    case "no_address":
    case "not_renewable":
      return skip("not_renewable");
    case "renewal_limit":
      return skip("renewal_limit");
    case "limit_reached":
      return skip("limit_reached");
    case "too_soon":
      return skip("too_soon");
    case "rate_limited":
      return skip("rate_limited");
    case "trip_over":
      return skip("trip_over");
    case "email_invalid":
      return skip("email_invalid");
  }
}

export type SendResetResult =
  | { kind: "reset"; afterGeneration: number; sendsAllowed: number }
  | { kind: "not_found" }
  | { kind: "not_pending" }
  /** The request still has sends left, or has reached the 20 in all. */
  | { kind: "not_needed" };

/**
 * Allow five more sends for a request that used its five, in the caller's
 * staff transaction. The caller holds `waivers.manage`.
 */
export async function resetWaiverSendCount(
  trx: TenantTransaction,
  ctx: TenantContext,
  input: { requestId: string; reason: string },
): Promise<SendResetResult> {
  if (ctx.actorType !== "staff" || !ctx.actorId) {
    throw new Error("only a staff member resets a waiver's send count");
  }
  const reason = input.reason.trim();
  if (!reason) throw new TypeError("a reset needs a reason");
  const request = await lockRequest(trx, ctx.tenantId, input.requestId);
  if (!request) return { kind: "not_found" };
  if (request.state !== "pending") return { kind: "not_pending" };
  const { rows } = await sql<{ latest: number | null; reset_at: number | null }>`
    select (select max(generation) from waiver_deliveries
             where tenant_id = ${ctx.tenantId} and request_id = ${request.id}) as latest,
           (select max(after_generation) from waiver_send_resets
             where tenant_id = ${ctx.tenantId} and request_id = ${request.id}) as reset_at`.execute(
    trx,
  );
  const latest = rows[0]?.latest ?? null;
  const resetAt = rows[0]?.reset_at ?? 0;
  if (
    latest === null ||
    latest - resetAt < MAX_GENERATIONS ||
    latest + MAX_GENERATIONS > MAX_ALL_GENERATIONS
  ) {
    return { kind: "not_needed" };
  }
  await trx
    .insertInto("waiver_send_resets")
    .values({
      tenant_id: ctx.tenantId,
      request_id: request.id,
      after_generation: latest,
      actor_id: ctx.actorId,
      reason,
    })
    .execute();
  await recordAudit(trx, ctx, {
    action: "waiver_request.send_count_reset",
    subjectType: "waiver_request",
    subjectId: request.id,
    reason,
    after: { afterGeneration: latest, sendsAllowed: MAX_GENERATIONS },
  });
  return { kind: "reset", afterGeneration: latest, sendsAllowed: MAX_GENERATIONS };
}
