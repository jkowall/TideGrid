/**
 * Waiver reminders up to a completion cutoff (W1-G215-REMINDERS, migration
 * 0024). An unsigned waiver gets at most two reminder emails before its trip
 * leaves: one in the 72 hour slot and one in the 24 hour slot (decision D1).
 * None is queued from REMINDER_CUTOFF_HOURS before departure. A slot is
 * skipped when an email for the request went out after it opened (a booking
 * made 30 hours ahead gets its first email, then only the 24 hour reminder),
 * and a request that never had an email, or whose address changed since,
 * gets none: the status shows that to staff.
 *
 * Reminders are not delivery generations (decision D2): they never count
 * against the five generations or the sending limits that hold staff
 * resends, and those limits never count them. A reminder still waits when
 * this address had a waiver email less than the interval ago, and the next
 * sweep tries again.
 *
 * The sweep runs in the cron before the email sweep, one tenant turn at a
 * time (sweep_turns, 'waiver_reminder'), and each reminder in its own
 * transaction, locking the request first as every waiver command does. The
 * database holds one reminder per request and slot, so concurrent sweeps and
 * retries queue one email. The email carries a new single-use link, issued
 * when it is sent, which replaces the earlier email's unused link, as a
 * resend's does. A signature, revocation, cancellation, participant change,
 * or corrected address cancels a queued reminder, and the delivery job drops
 * one whose access was withdrawn before it went out.
 */
import {
  type Database,
  inTenantTransaction,
  recordAudit,
  recordSweepTurn,
  runFairSweep,
  type TenantContext,
  type TenantTransaction,
  type WaiverReminderSlot,
} from "@tidegrid/database";
import { enqueueMessage } from "@tidegrid/domain-messaging";
import { type Kysely, type RawBuilder, sql } from "kysely";
import { loadBookingContext, tripFacts } from "./booking.ts";
import { LINK_TTL_DAYS, lockRequest, sendingRefusal } from "./delivery.ts";
import { waiverRequestEmail } from "./email.ts";
import { WAIVER_LINK_PATH, WAIVER_LINK_PURPOSE, waiverSubject } from "./links.ts";
import type { WaiverDeps } from "./ports.ts";

export const WAIVER_REMINDER_TEMPLATE = "waiver_reminder";
export const WAIVER_REMINDER_VERSION = 1;
/** The reminder slots, in order, by hours before departure (decision D1). */
export const REMINDER_SLOTS: readonly { slot: WaiverReminderSlot; hours: number }[] = [
  { slot: "72h", hours: 72 },
  { slot: "24h", hours: 24 },
];
const [EARLY, LATE] = REMINDER_SLOTS as readonly [
  (typeof REMINDER_SLOTS)[number],
  (typeof REMINDER_SLOTS)[number],
];
/** No reminder is queued from this many hours before departure. */
export const REMINDER_CUTOFF_HOURS = 2;
/**
 * A waiver email sent up to this long before a slot opens covers that slot,
 * so a reminder never lands just after the first email.
 */
export const REMINDER_GRACE_HOURS = 12;
const HOUR_MS = 3_600_000;

export type ReminderResult =
  | { kind: "queued"; slot: WaiverReminderSlot; messageId: string }
  /** Why no reminder now: the next sweep looks again, when it can change. */
  | {
      kind: "skipped";
      reason:
        | "not_found"
        | "not_pending"
        | "outside_window"
        | "already_reminded"
        | "email_since"
        | "never_sent"
        | "address_changed"
        | "email_pending"
        | "too_soon"
        | "email_invalid";
    };

/** The slot whose window holds `now`, or null outside both or past the cutoff. */
export function dueSlot(startsAt: Date, now: Date): WaiverReminderSlot | null {
  const left = startsAt.getTime() - now.getTime();
  if (left <= REMINDER_CUTOFF_HOURS * HOUR_MS) return null;
  // The latest slot that has opened.
  let due: WaiverReminderSlot | null = null;
  for (const s of REMINDER_SLOTS) if (left <= s.hours * HOUR_MS) due = s.slot;
  return due;
}

const slotHours = (slot: WaiverReminderSlot) =>
  REMINDER_SLOTS.find((s) => s.slot === slot)?.hours ?? 24;

/**
 * When the request's latest waiver email reached the guest: each invitation
 * or reminder counts from when it was sent (or last tried), not when it was
 * queued, so a delayed first email still gets its grace. One not yet tried
 * counts from when it may go. Shared with the staff read.
 */
export function latestEmailAt(tenantId: string, requestId: string | RawBuilder<string>) {
  return sql<Date | null>`greatest(
    (select max(coalesce(m.sent_at, m.last_attempt_at, d.send_after))
       from waiver_deliveries d
       join email_messages m on m.tenant_id = d.tenant_id and m.id = d.message_id
      where d.tenant_id = ${tenantId} and d.request_id = ${requestId}),
    (select max(coalesce(m.sent_at, m.last_attempt_at, w.created_at))
       from waiver_reminders w
       join email_messages m on m.tenant_id = w.tenant_id and m.id = w.message_id
      where w.tenant_id = ${tenantId} and w.request_id = ${requestId}))`;
}

/**
 * Whether anything emailed since the request's latest invitation (it, or a
 * reminder after it) was closed because the address changed: the guest then
 * holds no working link to that address until staff send a new invitation.
 * Shared with the staff read; the reminder trigger holds the same rule.
 */
export function closedSinceInvitation(tenantId: string, requestId: string | RawBuilder<string>) {
  return sql<boolean>`coalesce((
    select exists (
      select 1 from email_messages m
       where m.tenant_id = ${tenantId}
         and m.subject_ref = 'waiver_request:' || (${requestId})::text
         and m.created_at >= lm.created_at
         and ((m.state = 'canceled' and m.last_error_code = 'recipient_changed')
              or exists (select 1 from guest_access_links l
                          where l.tenant_id = m.tenant_id and l.message_id = m.id
                            and l.revoked_reason = 'recipient_changed')))
      from waiver_deliveries ld
      join email_messages lm on lm.tenant_id = ld.tenant_id and lm.id = ld.message_id
     where ld.tenant_id = ${tenantId} and ld.request_id = ${requestId}
     order by ld.generation desc limit 1), false)`;
}

/**
 * Queue the due reminder for one request, if it should have one now, in the
 * caller's transaction (a system actor's). Locks the request first.
 */
export async function remindWaiverRequest(
  trx: TenantTransaction,
  ctx: TenantContext,
  deps: WaiverDeps,
  requestId: string,
): Promise<ReminderResult> {
  const skip = (reason: Extract<ReminderResult, { kind: "skipped" }>["reason"]) =>
    ({ kind: "skipped", reason }) as const;
  const request = await lockRequest(trx, ctx.tenantId, requestId);
  if (!request) return skip("not_found");
  if (request.state !== "pending") return skip("not_pending");
  const booking = await loadBookingContext(trx, ctx.tenantId, request.booking_id);
  if (!booking) return skip("not_found");
  if (booking.state !== "confirmed") return skip("not_pending");

  const { rows: facts } = await sql<{
    now: Date;
    reminded: WaiverReminderSlot[] | null;
    latest_at: Date | null;
    latest_recipient: string | null;
    latest_closed: boolean | null;
    pending_email: boolean;
  }>`
    select now() as now,
           (select array_agg(w.slot) from waiver_reminders w
             where w.tenant_id = ${ctx.tenantId} and w.request_id = ${request.id}) as reminded,
           ${latestEmailAt(ctx.tenantId, request.id)} as latest_at,
           d.recipient_email as latest_recipient,
           ${closedSinceInvitation(ctx.tenantId, request.id)} as latest_closed,
           exists (select 1 from email_messages m
                    where m.tenant_id = ${ctx.tenantId}
                      and m.subject_ref = ${waiverSubject(request.id)}
                      and m.booking_id = ${request.booking_id}
                      and m.state in ('queued', 'sending')) as pending_email
      from (select 1) one
      left join lateral (
        select recipient_email from waiver_deliveries
         where tenant_id = ${ctx.tenantId} and request_id = ${request.id}
         order by generation desc limit 1) d on true`.execute(trx);
  const f = facts[0];
  if (!f) throw new Error("no database clock");
  const slot = dueSlot(booking.startsAt, f.now);
  if (!slot) return skip("outside_window");
  if ((f.reminded ?? []).includes(slot)) return skip("already_reminded");
  const opened = new Date(booking.startsAt.getTime() - slotHours(slot) * HOUR_MS);
  if (f.latest_recipient === null) return skip("never_sent");
  if (f.latest_at && f.latest_at.getTime() >= opened.getTime() - REMINDER_GRACE_HOURS * HOUR_MS) {
    return skip("email_since");
  }
  if (f.pending_email) return skip("email_pending");

  const participant = (await deps.participants.list(trx, ctx.tenantId, request.booking_id)).find(
    (p) => p.id === request.participant_id,
  );
  const recipient = participant?.email?.trim().toLowerCase() || null;
  if (!participant || !recipient) return skip("address_changed");
  if (recipient !== f.latest_recipient || f.latest_closed === true) {
    return skip("address_changed");
  }
  // Not counted by the limits, but never right on the heels of another
  // waiver email to this address.
  const refusal = await sendingRefusal(trx, ctx.tenantId, request, recipient, f.now);
  if (refusal?.code === "interval") return skip("too_soon");

  const ttlSeconds = Math.floor(
    Math.min(LINK_TTL_DAYS * 86_400_000, booking.endsAt.getTime() - f.now.getTime()) / 1000,
  );
  const recipientName =
    request.required_signer === "guardian"
      ? (participant.guardianName ?? participant.name)
      : participant.name;
  await sql`savepoint waiver_reminder`.execute(trx);
  let messageId: string;
  try {
    const enqueued = await enqueueMessage(trx, ctx, {
      dedupeKey: `waiver.reminder:${request.id}:${slot}`,
      template: WAIVER_REMINDER_TEMPLATE,
      templateVersion: WAIVER_REMINDER_VERSION,
      to: { email: recipient, name: recipientName },
      bookingId: request.booking_id,
      participantId: request.participant_id,
      subjectRef: waiverSubject(request.id),
      content: waiverRequestEmail({
        requiredSigner: request.required_signer,
        participantName: participant.name,
        recipientName,
        operatorName: booking.operatorName,
        trip: tripFacts(booking),
        linkDays: Math.floor(ttlSeconds / 86_400),
        kind: "reminder",
      }),
      accessLink: { purpose: WAIVER_LINK_PURPOSE, path: WAIVER_LINK_PATH, ttlSeconds },
      notBefore: null,
    });
    if (enqueued.kind === "duplicate") {
      // The slot's key is this request's alone, and its reminder row commits
      // with it: a duplicate means another sweep got there first.
      await sql`rollback to savepoint waiver_reminder`.execute(trx);
      await sql`release savepoint waiver_reminder`.execute(trx);
      return skip("already_reminded");
    }
    messageId = enqueued.messageId;
    await trx
      .insertInto("waiver_reminders")
      .values({
        tenant_id: ctx.tenantId,
        request_id: request.id,
        booking_id: request.booking_id,
        participant_id: request.participant_id,
        slot,
        message_id: messageId,
        recipient_email: recipient,
      })
      .execute();
    await sql`release savepoint waiver_reminder`.execute(trx);
  } catch (error) {
    // The trip moved between the check above and the insert: the database's
    // window refuses it, and the next run decides again.
    const moved =
      typeof error === "object" &&
      error !== null &&
      (error as { code?: unknown; constraint_name?: unknown }).code === "23514" &&
      (error as { constraint_name?: unknown }).constraint_name === "waiver_reminders_window";
    if (!(error instanceof TypeError) && !moved) throw error;
    await sql`rollback to savepoint waiver_reminder`.execute(trx);
    await sql`release savepoint waiver_reminder`.execute(trx);
    return skip(moved ? "outside_window" : "email_invalid");
  }
  await recordAudit(trx, ctx, {
    action: "waiver_request.reminded",
    subjectType: "waiver_request",
    subjectId: request.id,
    after: { slot, messageId, linkTtlSeconds: ttlSeconds },
  });
  return { kind: "queued", slot, messageId };
}

export interface ReminderSweepOptions {
  runId: string;
  deps: WaiverDeps;
  /** Requests looked at per tenant turn. Default 25. */
  limit?: number;
  tenantLimit?: number;
  budgetMs?: number;
  clock?: () => number;
  onTenantError?: (tenantId: string, error: unknown) => void;
  onStampError?: (tenantId: string, error: unknown) => void;
}

export interface ReminderSweepReport {
  tenants: number;
  queued: number;
  skipped: number;
  failedTenants: number;
  turns: number;
  passes: number;
  deferredTenants: number;
  stampFailures: number;
  complete: boolean;
}

/**
 * Queue the due reminders across tenants, each tenant in turn. Each reminder
 * commits on its own; the email sweep sends them.
 */
export async function sweepWaiverReminders(
  db: Kysely<Database>,
  options: ReminderSweepOptions,
): Promise<ReminderSweepReport> {
  const clock = options.clock ?? Date.now;
  const limit = options.limit ?? 25;
  if (!Number.isInteger(limit) || limit < 1 || limit > 500) {
    throw new RangeError("limit is a whole number from 1 to 500");
  }
  const tenantLimit = options.tenantLimit ?? 100;
  const report = { queued: 0, skipped: 0 };
  const contextOf = (tenantId: string): TenantContext => ({
    tenantId,
    actorType: "system",
    actorId: "waiver-reminders",
    requestId: options.runId,
  });
  // A request looked at once per run: a skip is not retried in the same run.
  const seen = new Set<string>();
  const fair = await runFairSweep({
    listTenants: async () => {
      const { rows } = await sql<{ tenant_id: string }>`
        select tenant_id from app.waiver_reminder_tenants(${tenantLimit})`.execute(db);
      return rows.map((r) => r.tenant_id);
    },
    tenantLimit,
    stamp: (tenantId) => recordSweepTurn(db, contextOf(tenantId), "waiver_reminder"),
    budgetMs: options.budgetMs ?? 10_000,
    clock,
    turn: async (tenantId) => {
      const ctx = contextOf(tenantId);
      const candidates = await inTenantTransaction(db, ctx, async (trx) => {
        // Only requests whose due slot is not yet reminded and not covered by
        // a recent email, so the ones already handled never crowd out the
        // rest from run to run. remindWaiverRequest decides again under lock.
        const { rows } = await sql<{ id: string }>`
          select r.id
            from waiver_requests r
            join bookings b on b.tenant_id = r.tenant_id and b.id = r.booking_id
            join scheduled_trips t on t.tenant_id = b.tenant_id and t.id = b.trip_id
            cross join lateral (
              select case when t.starts_at <= now() + make_interval(hours => ${LATE.hours}::int)
                          then ${LATE.slot}::text else ${EARLY.slot}::text end as slot,
                     case when t.starts_at <= now() + make_interval(hours => ${LATE.hours}::int)
                          then ${LATE.hours}::int else ${EARLY.hours}::int end as hours) due
           where r.tenant_id = ${tenantId} and r.state = 'pending'
             and b.state = 'confirmed'
             and t.starts_at > now() + make_interval(hours => ${REMINDER_CUTOFF_HOURS})
             and t.starts_at <= now() + make_interval(hours => ${EARLY.hours})
             and not (r.id = any(${[...seen]}::uuid[]))
             and not exists (select 1 from waiver_reminders w
                              where w.tenant_id = r.tenant_id and w.request_id = r.id
                                and w.slot::text = due.slot)
             and ${latestEmailAt(tenantId, sql<string>`r.id`)}
                   < t.starts_at - make_interval(hours => due.hours + ${REMINDER_GRACE_HOURS}::int)
           order by t.starts_at, r.id
           limit ${limit + 1}`.execute(trx);
        return rows.map((r) => r.id);
      });
      const batch = candidates.slice(0, limit);
      for (const id of batch) {
        seen.add(id);
        const result = await inTenantTransaction(db, ctx, (trx) =>
          remindWaiverRequest(trx, ctx, options.deps, id),
        );
        if (result.kind === "queued") report.queued++;
        else report.skipped++;
      }
      return { units: batch.length, more: candidates.length > batch.length };
    },
    onTenantError: (tenantId, error, during) => {
      if (during === "stamp") options.onStampError?.(tenantId, error);
      else options.onTenantError?.(tenantId, error);
    },
  });
  return {
    tenants: fair.tenants,
    queued: report.queued,
    skipped: report.skipped,
    failedTenants: fair.failedTenants,
    turns: fair.turns,
    passes: fair.passes,
    deferredTenants: fair.deferredTenants,
    stampFailures: fair.stampFailures,
    complete: fair.complete,
  };
}
