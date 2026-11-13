/**
 * Waiver email for imported bookings (W3-G2.13, part D2, migration 0048).
 *
 * A batch's manifest says when its guests get their waiver email:
 * `send_at_cutover` emails them as the batch is saved; `hold_until_staff_release`
 * creates the requests but holds the email until an owner releases the batch
 * here. Releasing is once a batch. Sending again for the same batch only emails
 * requests that never had an email (a sending limit or a missing address held
 * them), so it is safe to repeat; nothing already sent goes twice.
 *
 * Only waiver email: the booking's own emails stay held for imported bookings.
 */
import { recordAudit, type TenantContext, type TenantTransaction } from "@tidegrid/database";
import { sql } from "kysely";
import { assignBookingWaivers } from "./assign.ts";
import { sendWaiverRequest } from "./delivery.ts";
import type { WaiverDeps } from "./ports.ts";

/** At most this many bookings a call, so one request stays short; call again for the rest. */
export const RELEASE_BOOKINGS_PER_CALL = 200;

export type ImportWaiverReleaseResult =
  /** No saved batch with this id in this tenant. */
  | { kind: "not_found" }
  | {
      kind: "released";
      /** This call recorded the owner's release (a held batch, the first time). */
      releasedNow: boolean;
      /** Emails queued by this call. */
      queued: number;
      /** Requests still without an email: no address yet, or a sending limit held them. */
      notSent: number;
      /** Bookings left for another call. */
      remaining: number;
    };

export async function releaseImportWaiverEmail(
  trx: TenantTransaction,
  ctx: TenantContext,
  deps: WaiverDeps,
  input: { runId: string },
): Promise<ImportWaiverReleaseResult> {
  if (ctx.actorType !== "staff" || !ctx.actorId) {
    throw new TypeError("an import's email is released by a signed-in staff member");
  }
  const { rows: runs } = await sql<{ id: string; waiver_notifications: string | null }>`
    select id, waiver_notifications from import_runs
     where tenant_id = ${ctx.tenantId} and id = ${input.runId}
       and mode = 'commit' and clean`.execute(trx);
  const run = runs[0];
  if (!run) return { kind: "not_found" };
  // Two calls for one batch take turns.
  await sql`select pg_advisory_xact_lock(hashtext(${`import_waiver_email:${ctx.tenantId}:${run.id}`}))`.execute(
    trx,
  );

  let releasedNow = false;
  if (run.waiver_notifications === "hold_until_staff_release") {
    const { rows } = await sql<{ id: string }>`
      insert into import_email_releases (tenant_id, run_id)
      values (${ctx.tenantId}, ${run.id})
      on conflict (tenant_id, run_id) do nothing
      returning id`.execute(trx);
    releasedNow = rows.length > 0;
  }

  // The batch's confirmed bookings whose trip has not left, with a request
  // that never had an email, or a guest with no request yet.
  const { rows: bookings } = await sql<{ id: string }>`
    select b.id
      from import_records r
      join import_bookings ib on ib.tenant_id = r.tenant_id and ib.record_id = r.id
      join bookings b on b.tenant_id = ib.tenant_id
                     and b.checkout_session_id = ib.checkout_session_id
      join scheduled_trips t on t.tenant_id = b.tenant_id and t.id = b.trip_id
     where r.tenant_id = ${ctx.tenantId} and r.run_id = ${run.id} and r.file = 'bookings.csv'
       and b.state = 'confirmed' and t.starts_at > now()
       and exists (
         select 1 from booking_participants p
          where p.tenant_id = b.tenant_id and p.booking_id = b.id and p.removed_at is null
            and (not exists (select 1 from waiver_requests w
                              where w.tenant_id = p.tenant_id and w.booking_id = b.id
                                and w.participant_id = p.id
                                and w.state in ('pending', 'signed'))
                 or exists (select 1 from waiver_requests w
                             where w.tenant_id = p.tenant_id and w.booking_id = b.id
                               and w.participant_id = p.id and w.state = 'pending'
                               and not exists (select 1 from waiver_deliveries d
                                                where d.tenant_id = w.tenant_id
                                                  and d.request_id = w.id))))
     order by t.starts_at, b.id
     limit ${RELEASE_BOOKINGS_PER_CALL + 1}`.execute(trx);
  const batch = bookings.slice(0, RELEASE_BOOKINGS_PER_CALL);

  let queued = 0;
  let notSent = 0;
  for (const { id: bookingId } of batch) {
    // Guests named since without a request get one (and its first email).
    const assigned = await assignBookingWaivers(trx, ctx, deps, { bookingId });
    const created = new Set(assigned.created.map((c) => c.requestId));
    for (const c of assigned.created) {
      if (c.delivery.kind === "sent") queued += 1;
      else notSent += 1;
    }
    // The booking is locked for waivers by the assignment above.
    const { rows: unsent } = await sql<{ id: string }>`
      select w.id from waiver_requests w
       where w.tenant_id = ${ctx.tenantId} and w.booking_id = ${bookingId}
         and w.state = 'pending'
         and not exists (select 1 from waiver_deliveries d
                          where d.tenant_id = w.tenant_id and d.request_id = w.id)
       order by w.created_at, w.id`.execute(trx);
    for (const { id: requestId } of unsent) {
      if (created.has(requestId)) continue;
      const sent = await sendWaiverRequest(trx, ctx, deps, {
        requestId,
        kind: "initial",
        reason: null,
        whenAllowed: true,
      });
      if (sent.kind === "sent") queued += 1;
      else notSent += 1;
    }
  }
  const remaining = Math.max(0, bookings.length - batch.length);
  // Every call is on the record, counts only: who sent a batch's email, and how much.
  await recordAudit(trx, ctx, {
    action: "import.waiver_email.released",
    subjectType: "import_run",
    subjectId: run.id,
    after: { releasedNow, queued, notSent, remaining },
  });
  return { kind: "released", releasedNow, queued, notSent, remaining };
}
