/**
 * Scheduled trip reminders (W3-G2.16-rest). A booking's reminder is written
 * with its confirmation, in the same transaction, and waits in the queue
 * until a day before the trip (`notBefore`). Nothing else schedules it: the
 * delivery job sends it once it is due, like any other message.
 *
 * A reminder is only worth sending before the trip leaves. The claim checks
 * that again, under the message's row lock, because a message can wait in its
 * retry backoff for hours: a reminder whose booking was canceled, or whose
 * trip leaves within the cutoff, is canceled as `reminder_too_late` with no
 * provider call. The booking is read FOR SHARE, so a cancellation in
 * progress makes the claim wait for a later run instead of racing it.
 */
import type { TenantTransaction } from "@tidegrid/database";
import { sql } from "kysely";

/** The booking reminder's template key; the booking module writes it. */
export const TRIP_REMINDER_TEMPLATE = "booking_reminder";
/** A reminder is due this long before the trip leaves. */
export const TRIP_REMINDER_LEAD_HOURS = 24;
/** No reminder is written for a booking made this close to its reminder's due time. */
export const TRIP_REMINDER_MIN_NOTICE_HOURS = 24;
/** No reminder goes out this close to departure, as for waiver reminders. */
export const TRIP_REMINDER_CUTOFF_HOURS = 2;
/** Why a reminder was canceled at claim: the booking was canceled or the trip was about to leave. */
export const REMINDER_TOO_LATE = "reminder_too_late";

/**
 * Whether a trip reminder for this booking may go out now: `too_late` when
 * the booking was canceled, its trip was canceled or leaves within the
 * cutoff, or the booking is gone; `busy` when another transaction is changing
 * the booking (a cancellation holds it), so the claim leaves the reminder for
 * a later run rather than send it while the cancellation commits.
 */
export async function tripReminderTiming(
  trx: TenantTransaction,
  tenantId: string,
  bookingId: string | null,
): Promise<"ok" | "too_late" | "busy"> {
  if (bookingId === null) return "too_late";
  const { rows } = await sql<{ ok: boolean }>`
    select t.starts_at > now() + make_interval(hours => ${TRIP_REMINDER_CUTOFF_HOURS})
           and t.sales_state <> 'canceled'
           and not exists (
             select 1 from booking_cancellations c
              where c.tenant_id = b.tenant_id and c.booking_id = b.id) as ok
      from bookings b
      join scheduled_trips t on t.tenant_id = b.tenant_id and t.id = b.trip_id
     where b.tenant_id = ${tenantId} and b.id = ${bookingId}
       for share of b skip locked`.execute(trx);
  const row = rows[0];
  if (row) return row.ok === true ? "ok" : "too_late";
  const { rows: exists } = await sql<{ found: boolean }>`
    select exists (select 1 from bookings where tenant_id = ${tenantId} and id = ${bookingId})
      as found`.execute(trx);
  return exists[0]?.found === true ? "busy" : "too_late";
}
