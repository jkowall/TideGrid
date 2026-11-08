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
 * provider call.
 */
import type { TenantTransaction } from "@tidegrid/database";
import { sql } from "kysely";

/** The booking reminder's template key; the booking module writes it. */
export const TRIP_REMINDER_TEMPLATE = "booking_reminder";
/** A reminder is due this long before the trip leaves. */
export const TRIP_REMINDER_LEAD_HOURS = 24;
/** No reminder goes out this close to departure, as for waiver reminders. */
export const TRIP_REMINDER_CUTOFF_HOURS = 2;
/** Why a reminder was canceled at claim: the booking was canceled or the trip was about to leave. */
export const REMINDER_TOO_LATE = "reminder_too_late";

/**
 * Whether a trip reminder for this booking must not go out now: the booking
 * was canceled, its trip leaves within the cutoff, or the booking is gone.
 */
export async function tripReminderTooLate(
  trx: TenantTransaction,
  tenantId: string,
  bookingId: string | null,
): Promise<boolean> {
  if (bookingId === null) return true;
  const { rows } = await sql<{ ok: boolean }>`
    select t.starts_at > now() + make_interval(hours => ${TRIP_REMINDER_CUTOFF_HOURS})
           and t.sales_state <> 'canceled'
           and not exists (
             select 1 from booking_cancellations c
              where c.tenant_id = b.tenant_id and c.booking_id = b.id) as ok
      from bookings b
      join scheduled_trips t on t.tenant_id = b.tenant_id and t.id = b.trip_id
     where b.tenant_id = ${tenantId} and b.id = ${bookingId}`.execute(trx);
  return rows[0]?.ok !== true;
}
