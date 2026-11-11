/**
 * Correcting the booker's own name and email on a confirmed booking
 * (W3-G2.11-rest, docs/v2/02: "correct permitted contact and participant details"). The booker, from
 * their booking session, or staff with `bookings.reschedule`, sends the
 * details as they should be. One transaction:
 *
 * - The checkout's booker fields change. The database checks the shape (only
 *   those two fields, confirmed, before the trip leaves, at most 3 a booking
 *   in 24 hours by the guest) and writes the history row itself (0037). The
 *   history says who changed which field, never the addresses.
 * - On an email change, everything that would still reach the old address
 *   stops: its unused management links are revoked, the booker's email not
 *   yet sent is canceled (`recipient_changed`), and every other management
 *   session ends except the one making the change. The trip and balance
 *   reminders that were canceled are written again to the new address. The
 *   old address gets a notice with a masked new address and no link; the new
 *   address gets a fresh management link. The checkout's own secret no
 *   longer opens a session afterwards (manage.ts), so whoever held it on the
 *   old device cannot come back that way.
 * - A name-only change sends nothing; email already queued keeps the old
 *   name in its greeting.
 *
 * Coordinator defaults pending the owner's confirmation (the W3-G2.11-rest
 * booker contact entry in docs/v2/06).
 *
 * Lock order: checkout session, then booking (as cancellation, moves, and
 * party changes take them), then the booker's queued email.
 */
import { isUuid, type TenantContext, type TenantTransaction } from "@tidegrid/database";
import {
  BALANCE_REMINDER_TEMPLATE,
  cancelMessage,
  revokeAccessLinks,
  revokeGuestSessions,
} from "@tidegrid/domain-messaging";
import { sql } from "kysely";
import {
  enqueueBalanceEmail,
  enqueueContactChangedEmail,
  enqueueManageLinkEmail,
  enqueueReminderEmail,
  REMINDER_TEMPLATE,
} from "./emails.ts";
import { iso, record } from "./views.ts";

/**
 * Corrections the guest may make to one booking in 24 hours (0037). Staff
 * and support are not limited, so they can always restore a booking someone
 * took over with a leaked link.
 */
export const MAX_CONTACT_CHANGES_PER_DAY = 3;

export interface BookerContactChangeRecord {
  contactChangeId: string;
  nameChanged: boolean;
  emailChanged: boolean;
  by: "staff" | "guest" | "system" | "support";
  changedAt: string;
}

export type ChangeBookerContactResult =
  | { kind: "changed"; change: BookerContactChangeRecord }
  /** The details are already these: nothing changed and nothing was sent. */
  | { kind: "unchanged" }
  | { kind: "not_found" }
  | { kind: "not_confirmed" }
  | { kind: "trip_departed" }
  | { kind: "limit_reached" }
  /** The guest session making the change ended while it waited. Nothing changed. */
  | { kind: "session_ended" };

export interface ChangeBookerContactInput {
  bookingId: string;
  name: string;
  email: string;
  /** The guest session making the change: it stays open. Staff pass none. */
  keepSessionId?: string | null;
}

// biome-ignore lint/suspicious/noControlCharactersInRegex: the pattern exists to reject them.
const namePattern = /^[^\u0000-\u001f\u007f]{1,120}$/;
// The checkout table's own rule (0007), so a refusal is a RangeError, not a 23514.
const emailPattern = /^[\x21-\x7e]+$/;
const emailShape = /^[^@]+@[^@]+\.[^@]+$/;

interface ChangeRow {
  id: string;
  name_changed: boolean;
  email_changed: boolean;
  actor_type: BookerContactChangeRecord["by"];
  created_at: Date | string;
}

/** A booking's booker corrections, oldest first. Empty for an unknown booking. */
export async function listBookerContactChanges(
  trx: TenantTransaction,
  tenantId: string,
  bookingId: string,
): Promise<BookerContactChangeRecord[]> {
  if (!isUuid(bookingId)) return [];
  const { rows } = await sql<ChangeRow>`
    select id, name_changed, email_changed, actor_type, created_at
      from booking_contact_changes
     where tenant_id = ${tenantId} and booking_id = ${bookingId}
     order by created_at, id`.execute(trx);
  return rows.map(toRecord);
}

function toRecord(row: ChangeRow): BookerContactChangeRecord {
  return {
    contactChangeId: row.id,
    nameChanged: row.name_changed,
    emailChanged: row.email_changed,
    by: row.actor_type,
    changedAt: iso(row.created_at),
  };
}

/**
 * Correct a confirmed booking's booker. The caller claims its idempotency
 * key first and delivers any queued email after commit.
 */
export async function changeBookerContact(
  trx: TenantTransaction,
  ctx: TenantContext,
  input: ChangeBookerContactInput,
): Promise<ChangeBookerContactResult> {
  const name = input.name.trim();
  if (!namePattern.test(name)) {
    throw new RangeError("a name is 1 to 120 characters, with no control characters");
  }
  const email = input.email.trim().toLowerCase();
  if (email.length > 254 || !emailPattern.test(email) || !emailShape.test(email)) {
    throw new RangeError("an email address is like name@example.com");
  }
  const keep = input.keepSessionId ?? null;
  if (keep !== null && !isUuid(keep)) throw new TypeError("keepSessionId must be a UUID");
  if (!isUuid(input.bookingId)) return { kind: "not_found" };
  const tenantId = ctx.tenantId;

  const { rows: located } = await sql<{ checkout_session_id: string }>`
    select checkout_session_id from bookings
     where tenant_id = ${tenantId} and id = ${input.bookingId}`.execute(trx);
  const sessionId = located[0]?.checkout_session_id;
  if (!sessionId) return { kind: "not_found" };
  const { rows: checkouts } = await sql<{ booker_name: string; booker_email: string }>`
    select booker_name, booker_email from checkout_sessions
     where tenant_id = ${tenantId} and id = ${sessionId}
       for update`.execute(trx);
  const before = checkouts[0];
  if (!before) throw new Error("a booking's checkout was not found");
  const { rows: booked } = await sql<{ state: string; departed: boolean }>`
    select b.state, t.starts_at <= now() as departed
      from bookings b
      join scheduled_trips t on t.tenant_id = b.tenant_id and t.id = b.trip_id
     where b.tenant_id = ${tenantId} and b.id = ${input.bookingId}
       for no key update of b`.execute(trx);
  const row = booked[0];
  if (!row) throw new Error("a located booking was not found");
  if (row.state !== "confirmed") return { kind: "not_confirmed" };
  if (row.departed) return { kind: "trip_departed" };
  // The guest's session again, now that the checkout is locked: staff who
  // restored the booking while this request waited ended it, and a request
  // from an ended session must not undo their change.
  if (keep !== null) {
    const { rows: live } = await sql<{ id: string }>`
      select id from guest_sessions
       where tenant_id = ${tenantId} and id = ${keep} and booking_id = ${input.bookingId}
         and revoked_at is null and expires_at > now()`.execute(trx);
    if (live.length === 0) return { kind: "session_ended" };
  }

  const nameChanged = name !== before.booker_name;
  const emailChanged = email !== before.booker_email;
  if (!nameChanged && !emailChanged) return { kind: "unchanged" };

  if (ctx.actorType === "guest") {
    const { rows: recent } = await sql<{ n: number }>`
      select count(*)::int as n from booking_contact_changes
       where tenant_id = ${tenantId} and booking_id = ${input.bookingId}
         and actor_type = 'guest' and created_at > now() - interval '24 hours'`.execute(trx);
    if ((recent[0]?.n ?? 0) >= MAX_CONTACT_CHANGES_PER_DAY) return { kind: "limit_reached" };
  }

  // Under the booking's lock, the trip's start, the count, and this update
  // agree with the trigger's own checks, which write the history row.
  await sql`
    update checkout_sessions set booker_name = ${name}, booker_email = ${email}
     where tenant_id = ${tenantId} and id = ${sessionId}`.execute(trx);
  // The trigger names its row in this transaction's settings: never find it
  // by time, as a correction that waited on the lock would find another's.
  const { rows: written } = await sql<ChangeRow>`
    select id, name_changed, email_changed, actor_type, created_at
      from booking_contact_changes
     where tenant_id = ${tenantId}
       and id = nullif(current_setting('app.contact_change_id', true), '')::uuid`.execute(trx);
  const change = written[0];
  if (!change) throw new Error("a contact change's row was not written");
  const contactChangeId = change.id;

  let rewritten = 0;
  if (emailChanged) {
    // The booker's management email not yet sent, locked and canceled here
    // with the links it carried, whenever it was written: a correction that
    // committed while this one waited on the checkout's lock may have queued
    // email to the address this one replaces. A delivery in progress
    // finishes first, and one that finished is not rewritten.
    const { rows: pending } = await sql<{ id: string; template: string; next_attempt_at: Date }>`
      select id, template, next_attempt_at from email_messages
       where tenant_id = ${tenantId} and booking_id = ${input.bookingId}
         and link_purpose = 'booking_manage' and participant_id is null
         and state in ('queued', 'sending')
       order by id
         for update`.execute(trx);
    for (const message of pending) {
      await cancelMessage(trx, ctx, message.id, {
        code: "recipient_changed",
        linkReason: "recipient_changed",
      });
    }
    await revokeAccessLinks(trx, ctx, {
      bookingId: input.bookingId,
      purpose: "booking_manage",
      reason: "recipient_changed",
    });
    await revokeGuestSessions(trx, ctx, {
      bookingId: input.bookingId,
      purpose: "booking_manage",
      exceptSessionId: keep,
    });
    const reminder = pending.find((m) => m.template === REMINDER_TEMPLATE.key);
    if (reminder) {
      // At the moment the canceled one was due, however close that is now.
      const done = await enqueueReminderEmail(trx, ctx, input.bookingId, {
        dedupeKey: `booking.reminder:${input.bookingId}:contact:${contactChangeId}`,
        at: new Date(reminder.next_attempt_at),
      });
      if (done && !done.duplicate) rewritten += 1;
    }
    // Each balance reminder at its own moment too, a retry's included.
    for (const message of pending.filter((m) => m.template === BALANCE_REMINDER_TEMPLATE)) {
      const done = await enqueueBalanceEmail(trx, ctx, input.bookingId, {
        kind: "reminder",
        dedupeKey: `booking.balance_reminder:${input.bookingId}:contact.${contactChangeId}:${message.id}`,
        notBefore: new Date(message.next_attempt_at),
      });
      if (!done.duplicate) rewritten += 1;
    }
    await enqueueContactChangedEmail(trx, ctx, input.bookingId, {
      contactChangeId,
      oldEmail: before.booker_email,
      oldName: before.booker_name,
      newEmail: email,
    });
    await enqueueManageLinkEmail(trx, ctx, input.bookingId, `contact.${contactChangeId}`);
  }

  await record(trx, ctx, {
    action: "booking.booker_contact_changed",
    subjectType: "booking",
    subjectId: input.bookingId,
    // Which fields, never the values: the audit log is not a copy of personal data.
    after: { contactChangeId, nameChanged, emailChanged, remindersRewritten: rewritten },
    topic: "booking.booker_contact_changed",
    payload: { bookingId: input.bookingId, contactChangeId, nameChanged, emailChanged },
  });
  return { kind: "changed", change: toRecord(change) };
}
