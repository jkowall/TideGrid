/**
 * An imported booking's own email (W3-G2.13 follow-up, migration 0049).
 *
 * An imported booking gets no booking email until the batch that imported it
 * has its email due: saved with `send_at_cutover`, or released by an owner.
 * Then the import sweep opens it here, once: the booker gets a welcome worded
 * for a booking paid before TideGrid, in place of a confirmation, and the trip
 * reminder and any balance reminders are written as a confirmation writes
 * them. From then on the booking's email works as any booking's does:
 * reminders, management links on request, a cancellation notice, move
 * notices, participant invitations, staff "send again", and a charter's
 * balance link and online balance payment.
 *
 * A booker imported with no email gets nothing; the booking is still opened,
 * so once staff add an address its later email goes there.
 */
import type { TenantContext, TenantTransaction } from "@tidegrid/database";
import { sql } from "kysely";
import { enqueueBalanceReminders } from "../balance.ts";
import { enqueueConfirmationEmail, enqueueReminderEmail } from "../emails.ts";

export type OpenImportedBookingEmailResult =
  /** Opened now; `queued` emails go out now (the welcome, when there is an address). */
  | { kind: "opened"; queued: number }
  /** Opened before. */
  | { kind: "already_open" }
  /** Not a booking this batch imported, or canceled, or its trip has left. */
  | { kind: "not_due" };

/**
 * Open an imported booking's email for the batch that imported it, in the
 * caller's transaction. The database refuses it unless the batch's email is
 * due (0049).
 */
export async function openImportedBookingEmail(
  trx: TenantTransaction,
  ctx: TenantContext,
  input: { runId: string; bookingId: string },
): Promise<OpenImportedBookingEmailResult> {
  const { rows } = await sql<{ email: string | null; opened: boolean }>`
    select s.booker_email as email,
           exists (select 1 from import_booking_email_opened o
                    where o.tenant_id = b.tenant_id and o.booking_id = b.id) as opened
      from bookings b
      join checkout_sessions s on s.tenant_id = b.tenant_id and s.id = b.checkout_session_id
      join import_bookings ib
        on ib.tenant_id = b.tenant_id and ib.checkout_session_id = b.checkout_session_id
      join import_records r on r.tenant_id = ib.tenant_id and r.id = ib.record_id
      join scheduled_trips t on t.tenant_id = b.tenant_id and t.id = b.trip_id
     where b.tenant_id = ${ctx.tenantId} and b.id = ${input.bookingId}
       and b.source = 'imported' and r.run_id = ${input.runId}
       and b.state = 'confirmed' and t.starts_at > now()
       for no key update of b`.execute(trx);
  const booking = rows[0];
  if (!booking) return { kind: "not_due" };
  if (booking.opened) return { kind: "already_open" };
  await sql`
    insert into import_booking_email_opened (tenant_id, booking_id, run_id)
    values (${ctx.tenantId}, ${input.bookingId}, ${input.runId})`.execute(trx);
  if (!booking.email) return { kind: "opened", queued: 0 };
  const welcome = await enqueueConfirmationEmail(trx, ctx, input.bookingId);
  await enqueueReminderEmail(trx, ctx, input.bookingId);
  // A charter that still owes: its balance reminders, as a new booking's.
  await enqueueBalanceReminders(trx, ctx, input.bookingId);
  return { kind: "opened", queued: welcome && !welcome.duplicate ? 1 : 0 };
}
