/**
 * Waiver email for imported bookings (W3-G2.13, part D2, migration 0048).
 *
 * Saving a batch sends nothing and creates no waiver request, so a large
 * batch's save stays short. The cron's import waiver sweep does that work
 * afterwards for every saved batch whose email is due: one saved with
 * `send_at_cutover` right away, one saved with `hold_until_staff_release` once
 * an owner releases it here. The sweep takes a few bookings at a time, each in
 * its own transaction, and stops starting bookings for an operator once
 * IMPORT_EMAILS_PER_TENANT_RUN emails are queued (one booking's party may go
 * over), so an import never uses up the sending limit ordinary bookings need.
 * A booking that fails is logged and left for a later run; it never holds up
 * the operator's others.
 *
 * For each booking it creates the waiver requests a guest lacks and emails the
 * pending ones that never had an email. A booking is finished for its batch
 * unless a sending limit held an email, which a later run tries again; a guest
 * with no address, or a booking that needs no waiver, never holds up the rest.
 * The batch that imported a guest decides whether that guest's email is held
 * (app.import_waiver_email_held), so a held batch that adds guests to a
 * booking an earlier batch emailed still holds theirs.
 *
 * The same pass opens a booking's own email for the batch that imported it
 * (0049, openImportedBookingEmail): the booker's welcome goes out before the
 * guests' waiver requests and counts toward the same cap.
 */
import {
  type Database,
  inTenantTransaction,
  recordAudit,
  recordSweepTurn,
  runFairSweep,
  type TenantContext,
  type TenantTransaction,
} from "@tidegrid/database";
import { openImportedBookingEmail } from "@tidegrid/domain-booking";
import { type Kysely, type RawBuilder, sql } from "kysely";
import { assignBookingWaivers } from "./assign.ts";
import { type SendResult, sendWaiverRequest } from "./delivery.ts";
import type { WaiverDeps } from "./ports.ts";

/** Waiver emails the sweep queues per operator in one cron run (four runs an hour). */
export const IMPORT_EMAILS_PER_TENANT_RUN = 100;
/** Bookings per sweep turn. */
const BOOKINGS_PER_TURN = 20;

export type ImportWaiverReleaseResult =
  /** No saved batch with this id in this tenant. */
  | { kind: "not_found" }
  | {
      kind: "released";
      /** This call recorded the owner's release (a held batch, the first time). */
      releasedNow: boolean;
      /** The batch's bookings the sweep has still to email. */
      waitingBookings: number;
    };

/**
 * The bookings a batch imported or gave imported guests, confirmed, not yet
 * left, and not finished by the sweep for that batch: its waiver email not
 * done, or, for a booking the batch imported, its own email not open (0049).
 */
function dueBookings(tenantId: string, runFilter: RawBuilder<unknown>): RawBuilder<unknown> {
  return sql`
    select run.id as run_id, b.id as booking_id, min(t.starts_at) as starts_at
      from import_runs run
      join import_records r
        on r.tenant_id = run.tenant_id and r.run_id = run.id
       and r.file in ('bookings.csv', 'participants.csv')
      left join import_bookings ib on ib.tenant_id = r.tenant_id and ib.record_id = r.id
      left join booking_participants bp on bp.tenant_id = r.tenant_id and bp.id = r.participant_id
      join bookings b
        on b.tenant_id = run.tenant_id
       and (b.checkout_session_id = ib.checkout_session_id or b.id = bp.booking_id)
      join scheduled_trips t on t.tenant_id = b.tenant_id and t.id = b.trip_id
     where run.tenant_id = ${tenantId} and run.mode = 'commit' and run.clean
       and ${runFilter}
       and b.state = 'confirmed' and t.starts_at > now()
     group by run.id, b.id
    having not exists (select 1 from import_waiver_email_done d
                        where d.tenant_id = run.tenant_id and d.run_id = run.id
                          and d.booking_id = b.id)
        or (bool_or(ib.record_id is not null)
            and not exists (select 1 from import_booking_email_opened o
                             where o.tenant_id = run.tenant_id and o.booking_id = b.id))`;
}

/**
 * An owner releases a held batch's waiver email; the sweep sends it. Safe to
 * repeat. For a batch saved with send_at_cutover it records nothing and only
 * reports what is still waiting.
 */
export async function releaseImportWaiverEmail(
  trx: TenantTransaction,
  ctx: TenantContext,
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

  let releasedNow = false;
  if (run.waiver_notifications === "hold_until_staff_release") {
    const { rows } = await sql<{ id: string }>`
      insert into import_email_releases (tenant_id, run_id)
      values (${ctx.tenantId}, ${run.id})
      on conflict (tenant_id, run_id) do nothing
      returning id`.execute(trx);
    releasedNow = rows.length > 0;
  }
  const { rows: waiting } = await sql<{ n: number }>`
    select count(*)::int as n
      from (${dueBookings(ctx.tenantId, sql`run.id = ${run.id}`)}) due`.execute(trx);
  const waitingBookings = waiting[0]?.n ?? 0;
  if (releasedNow) {
    await recordAudit(trx, ctx, {
      action: "import.waiver_email.released",
      subjectType: "import_run",
      subjectId: run.id,
      after: { waitingBookings },
    });
  }
  return { kind: "released", releasedNow, waitingBookings };
}

/** A send a later run should try again: a sending limit or interval held it. */
function retryable(result: SendResult): boolean {
  return result.kind === "rate_limited" || result.kind === "too_soon";
}

/**
 * One booking for one batch: open the booking's own email if this batch
 * imported it, then create the requests its guests lack and email the pending
 * ones that never had an email. Finished unless a sending limit held an email.
 */
export async function sendImportedBookingWaivers(
  trx: TenantTransaction,
  ctx: TenantContext,
  deps: WaiverDeps,
  input: { runId: string; bookingId: string },
): Promise<{ queued: number; finished: boolean; operatorLimited: boolean }> {
  let queued = 0;
  let retry = false;
  let operatorLimited = false;
  const note = (result: SendResult) => {
    if (result.kind === "sent") queued += 1;
    else if (retryable(result)) retry = true;
    if (result.kind === "rate_limited" && result.scope === "tenant") operatorLimited = true;
  };
  // The booker hears first: a booking this batch imported gets its welcome
  // before its guests' waiver requests (0049). Nothing when it is not this
  // batch's booking or is open already.
  const opened = await openImportedBookingEmail(trx, ctx, input);
  if (opened.kind === "opened") queued += opened.queued;
  // Locks the booking for waivers first, as every waiver command does.
  const assigned = await assignBookingWaivers(trx, ctx, deps, { bookingId: input.bookingId });
  const created = new Set(assigned.created.map((c) => c.requestId));
  for (const c of assigned.created) note(c.delivery);
  const { rows: unsent } = await sql<{ id: string; participant_id: string }>`
    select w.id, w.participant_id from waiver_requests w
     where w.tenant_id = ${ctx.tenantId} and w.booking_id = ${input.bookingId}
       and w.state = 'pending'
       and not exists (select 1 from waiver_deliveries d
                        where d.tenant_id = w.tenant_id and d.request_id = w.id)
     order by w.created_at, w.id`.execute(trx);
  const left = unsent.filter((r) => !created.has(r.id));
  // The party once for the booking, not once a request.
  const party =
    left.length > 0
      ? new Map(
          (await deps.participants.list(trx, ctx.tenantId, input.bookingId)).map((p) => [p.id, p]),
        )
      : new Map();
  for (const { id: requestId, participant_id: participantId } of left) {
    const participant = party.get(participantId);
    note(
      await sendWaiverRequest(trx, ctx, deps, {
        requestId,
        kind: "initial",
        reason: null,
        whenAllowed: true,
        ...(participant ? { participant } : {}),
      }),
    );
  }
  if (!retry) {
    await sql`
      insert into import_waiver_email_done (tenant_id, run_id, booking_id)
      values (${ctx.tenantId}, ${input.runId}, ${input.bookingId})
      on conflict do nothing`.execute(trx);
  }
  return { queued, finished: !retry, operatorLimited };
}

export interface ImportWaiverSweepOptions {
  runId: string;
  deps: WaiverDeps;
  /** Emails per operator this run. Default IMPORT_EMAILS_PER_TENANT_RUN. */
  emailsPerTenant?: number;
  tenantLimit?: number;
  budgetMs?: number;
  clock?: () => number;
  onTenantError?: (tenantId: string, error: unknown) => void;
  onStampError?: (tenantId: string, error: unknown) => void;
  /** One booking failed; the sweep goes on with the next. */
  onBookingError?: (
    tenantId: string,
    booking: { runId: string; bookingId: string },
    error: unknown,
  ) => void;
}

export interface ImportWaiverSweepReport {
  tenants: number;
  bookings: number;
  queued: number;
  /** Bookings that threw; each is logged and left for a later run. */
  failedBookings: number;
  /** Operators left with bookings waiting: the run's email cap, or the operator's sending limit. */
  cappedTenants: number;
  failedTenants: number;
  turns: number;
  passes: number;
  deferredTenants: number;
  stampFailures: number;
  complete: boolean;
}

/** Send the due import waiver email across tenants, each tenant in turn. */
export async function sweepImportWaiverEmail(
  db: Kysely<Database>,
  options: ImportWaiverSweepOptions,
): Promise<ImportWaiverSweepReport> {
  const clock = options.clock ?? Date.now;
  const emailsPerTenant = options.emailsPerTenant ?? IMPORT_EMAILS_PER_TENANT_RUN;
  if (!Number.isInteger(emailsPerTenant) || emailsPerTenant < 1 || emailsPerTenant > 1000) {
    throw new RangeError("emailsPerTenant is a whole number from 1 to 1000");
  }
  const tenantLimit = options.tenantLimit ?? 100;
  const report = { bookings: 0, queued: 0, failedBookings: 0 };
  const capped = new Set<string>();
  // Bookings left for a later run: a sending limit held an email, or it failed.
  let unfinished = 0;
  const contextOf = (tenantId: string): TenantContext => ({
    tenantId,
    actorType: "system",
    actorId: "import-waiver-email",
    requestId: options.runId,
  });
  // Per tenant this run: emails queued. A booking is looked at once a run.
  const spent = new Map<string, number>();
  const seen = new Set<string>();
  const dueRun = sql`(run.waiver_notifications = 'send_at_cutover'
    or exists (select 1 from import_email_releases x
                where x.tenant_id = run.tenant_id and x.run_id = run.id))`;
  const fair = await runFairSweep({
    listTenants: async () => {
      const { rows } = await sql<{ tenant_id: string }>`
        select tenant_id from app.import_waiver_email_tenants(${tenantLimit})`.execute(db);
      return rows.map((r) => r.tenant_id);
    },
    tenantLimit,
    stamp: (tenantId) => recordSweepTurn(db, contextOf(tenantId), "import_waiver_email"),
    budgetMs: options.budgetMs ?? 10_000,
    clock,
    turn: async (tenantId) => {
      const ctx = contextOf(tenantId);
      const candidates = await inTenantTransaction(db, ctx, async (trx) => {
        const { rows } = await sql<{ run_id: string; booking_id: string }>`
          select run_id, booking_id from (${dueBookings(tenantId, dueRun)}) d
           where not ((run_id::text || ':' || booking_id::text) = any(${[...seen]}::text[]))
           order by starts_at, booking_id, run_id
           limit ${BOOKINGS_PER_TURN + 1}`.execute(trx);
        return rows;
      });
      const batch = candidates.slice(0, BOOKINGS_PER_TURN);
      let units = 0;
      // The cap is checked before each booking, so a run may go over it by
      // one booking's party.
      const atCap = () => (spent.get(tenantId) ?? 0) >= emailsPerTenant;
      for (const { run_id: runId, booking_id: bookingId } of batch) {
        if (atCap()) {
          capped.add(tenantId);
          return { units, more: false };
        }
        seen.add(`${runId}:${bookingId}`);
        units += 1;
        report.bookings += 1;
        let result: Awaited<ReturnType<typeof sendImportedBookingWaivers>>;
        try {
          result = await inTenantTransaction(db, ctx, (trx) =>
            sendImportedBookingWaivers(trx, ctx, options.deps, { runId, bookingId }),
          );
        } catch (error) {
          // One booking that fails never holds up the operator's others.
          report.failedBookings += 1;
          unfinished += 1;
          options.onBookingError?.(tenantId, { runId, bookingId }, error);
          continue;
        }
        report.queued += result.queued;
        if (!result.finished) unfinished += 1;
        spent.set(tenantId, (spent.get(tenantId) ?? 0) + result.queued);
        if (result.operatorLimited) {
          // The operator's own sending limit: nothing more goes out this run.
          capped.add(tenantId);
          return { units, more: false };
        }
      }
      const more = candidates.length > batch.length;
      if (more && atCap()) {
        capped.add(tenantId);
        return { units, more: false };
      }
      return { units, more };
    },
    onTenantError: (tenantId, error, during) => {
      if (during === "stamp") options.onStampError?.(tenantId, error);
      else options.onTenantError?.(tenantId, error);
    },
  });
  return {
    tenants: fair.tenants,
    bookings: report.bookings,
    queued: report.queued,
    failedBookings: report.failedBookings,
    cappedTenants: capped.size,
    failedTenants: fair.failedTenants,
    turns: fair.turns,
    passes: fair.passes,
    deferredTenants: fair.deferredTenants,
    stampFailures: fair.stampFailures,
    // Not complete while a booking is still waiting: an operator stopped at
    // its cap or limit, or a booking a sending limit held or that failed.
    complete: fair.complete && capped.size === 0 && unfinished === 0,
  };
}
