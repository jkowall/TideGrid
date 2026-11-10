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
 * progress makes the run pass the reminder over instead of racing it.
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
 * the booking (a cancellation holds it), so the run passes the reminder over
 * rather than send it while the cancellation commits.
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

/** A private charter's balance reminder (W3-G2.8), 7 days and 1 day before the due date. */
export const BALANCE_REMINDER_TEMPLATE = "booking_balance_reminder";
/** The balance link staff send on request (W3-G2.8). */
export const BALANCE_LINK_TEMPLATE = "booking_balance_link";
/** Days before the due date each balance reminder goes out (D1, coordinator default). */
export const BALANCE_REMINDER_LEAD_DAYS = [7, 1] as const;
/** Why a balance email was canceled at claim: nothing is owed, or the booking was canceled. */
export const BALANCE_SETTLED = "balance_settled";

/**
 * Whether a balance email for this booking may go out now: `settled` when
 * nothing is owed, the booking was canceled, its trip has left, or the
 * booking is gone; `busy` when another transaction holds the booking (a
 * cancellation, a payment recorded), so the run passes it over.
 */
export async function balanceEmailTiming(
  trx: TenantTransaction,
  tenantId: string,
  bookingId: string | null,
): Promise<"ok" | "settled" | "busy"> {
  if (bookingId === null) return "settled";
  const { rows } = await sql<{ ok: boolean }>`
    select b.state = 'confirmed' and t.starts_at > now()
           and coalesce((select x.owed from app.booking_balance(b.tenant_id, b.id) x), 0) > 0 as ok
      from bookings b
      join scheduled_trips t on t.tenant_id = b.tenant_id and t.id = b.trip_id
     where b.tenant_id = ${tenantId} and b.id = ${bookingId}
       for share of b skip locked`.execute(trx);
  const row = rows[0];
  if (row) return row.ok === true ? "ok" : "settled";
  const { rows: exists } = await sql<{ found: boolean }>`
    select exists (select 1 from bookings where tenant_id = ${tenantId} and id = ${bookingId})
      as found`.execute(trx);
  return exists[0]?.found === true ? "busy" : "settled";
}
