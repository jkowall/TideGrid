/**
 * Staff resend of a booking's email (G2.16b). An owner or booking staff
 * member sends the booking's confirmation (with a new management link) or its
 * cancellation notice again, from the console, when the guest did not get it.
 *
 * A resend is a new message with its own id and its own dedupe key,
 * "booking.resend:<bookingId>:<generation>", rendered from the booking as it
 * is now and addressed to the booker's address on file. It is never a retry
 * of an earlier message: delivery still sends each message at most once on a
 * provider that does not deduplicate. Its management link is minted when the
 * delivery job claims it to send, and that supersedes the links earlier emails
 * carried, even if the send then fails (they still renew). A link email the
 * guest asks for later supersedes it in turn: the link in the email sent last
 * opens the booking.
 *
 * Limits, held by the database for every writer (owner decision D4 A,
 * 2026-10-29, and migration 0014): at most 5 deliverable resends per booking
 * for ever (attempted, or still waiting), at least 10 minutes after the
 * booking's newest resend of any state, and 50 resends an hour per operator.
 * Each resend writes a row in the append-only ledger `booking_email_resends`
 * beside its message; `app.booking_resend_facts` counts the ledger by those
 * rules, and the ledger's trigger decides them again, under the tenant's
 * resend lock, for every writer. The service reads the same facts first, so
 * its refusals stay typed, ordered, and before any write. Both decide, and
 * the trigger stamps the row, at the transaction's time, `now()` to the
 * millisecond, so they agree at every boundary. A resend whose transaction
 * has run longer than 30 s is refused (`booking_email_resends_late`, at the
 * ledger insert and at commit), so a stamp lags its commit by at most 30 s;
 * that error propagates, and the route answers it as 503
 * `booking_email_busy`, with nothing written.
 * A limit the trigger raises anyway means a row landed past the tenant's
 * lock, which only a writer with 0014's triggers off can do; it is mapped to
 * the same typed refusal, with when it lifts from the database's facts. The
 * generation is separate from the count: 1 plus the highest generation the
 * booking's ledger has, in any state. `at` replaces the clock for the
 * availability read only (tests).
 *
 * Every refusal is decided before any write, in RESEND_REFUSAL_ORDER. A
 * refused request changes nothing. An earlier email of the same template still
 * waiting to go out is canceled with code `resent` (its links superseded) only
 * once every check has passed; one being sent right now refuses the resend.
 */
import {
  isUuid,
  type JsonObject,
  type TenantContext,
  type TenantTransaction,
} from "@tidegrid/database";
import { cancelMessage, STAFF_RESEND_TOPIC } from "@tidegrid/domain-messaging";
import { sql } from "kysely";
import {
  CANCELED_TEMPLATE,
  CONFIRMATION_TEMPLATE,
  enqueueCancellationEmail,
  enqueueConfirmationEmail,
} from "./emails.ts";
import { record } from "./views.ts";

export type ResendKind = "confirmation" | "cancellation";

/** Why staff send it again, as a code: finance reads the audit history, so never free text. */
export const RESEND_REASONS = [
  "guest_did_not_receive",
  "delivery_failed",
  "delivery_unknown",
  "guest_asked_again",
  "other",
] as const;
export type ResendReason = (typeof RESEND_REASONS)[number];

/** The refusals, in the fixed order the service decides them. */
export const RESEND_REFUSAL_ORDER = [
  "kind_mismatch",
  "trip_over",
  "refund_failed",
  "limit",
  "too_soon",
  "rate_limited",
  "in_progress",
] as const;
export type ResendRefusalCode = (typeof RESEND_REFUSAL_ORDER)[number];

/** Deliverable resends per booking, for ever: attempted, or still waiting. */
export const MAX_STAFF_RESENDS = 5;
/** Minutes after the booking's newest resend, of any state, before another. */
export const STAFF_RESEND_INTERVAL_MINUTES = 10;
/** Resends, of any state, per operator in the last hour. */
export const MAX_OPERATOR_RESENDS_PER_HOUR = 50;

/** What the refusals are decided from, read in the request's transaction. */
export interface ResendFacts {
  bookingState: "confirmed" | "canceled";
  tripEndsAt: Date;
  /** The booking's cancellation refund failed: the notice would say it is on its way. */
  refundFailed: boolean;
  /** The booking's resends that were attempted or are still waiting. */
  deliverable: number;
  /** The booking's newest resend's creation, any state; null before the first. */
  newestResendAt: Date | null;
  /** The operator's resends, any state, in the hour before the decision. */
  operatorResends: number;
  /** When the operator's count falls under the cap; null while it is under. */
  operatorAvailableAt: Date | null;
  /** The booking's earlier emails of the requested template being sent right now. */
  sending: number;
}

export interface ResendRefusal {
  code: ResendRefusalCode;
  /** When a time limit lifts (too_soon, rate_limited); null for the others. */
  availableAt: Date | null;
}

export interface ResendAvailability {
  /** The email that fits the booking's state. */
  kind: ResendKind;
  allowed: boolean;
  /** When the time limits that block it lift, while one blocks it first. */
  availableAt: Date | null;
  remaining: number;
  blockedBy: ResendRefusalCode | null;
}

export type ResendResult =
  | {
      kind: "queued";
      messageId: string;
      generation: number;
      queuedAt: Date;
      /** Earlier emails of the same template, still queued, that this one replaced. */
      canceledMessageIds: string[];
    }
  | { kind: "refused"; code: ResendRefusalCode | "email_invalid"; availableAt: Date | null }
  | { kind: "not_found" };

const templates = { confirmation: CONFIRMATION_TEMPLATE, cancellation: CANCELED_TEMPLATE } as const;
const stateFor = { confirmation: "confirmed", cancellation: "canceled" } as const;

/** The dedupe-key prefix of one booking's resends. */
function keyPrefix(bookingId: string): string {
  return `${STAFF_RESEND_TOPIC}:${bookingId}:`;
}

const later = (a: Date, minutes: number) => new Date(a.getTime() + minutes * 60_000);

/**
 * Every refusal that applies to these facts, in RESEND_REFUSAL_ORDER. Pure:
 * the first is the answer; the time limits carry when they lift.
 */
export function refusalsOf(facts: ResendFacts, kind: ResendKind, at: Date): ResendRefusal[] {
  const out: ResendRefusal[] = [];
  const refuse = (code: ResendRefusalCode, availableAt: Date | null = null) =>
    out.push({ code, availableAt });
  if (facts.bookingState !== stateFor[kind]) refuse("kind_mismatch");
  if (kind === "confirmation" && facts.tripEndsAt.getTime() <= at.getTime()) refuse("trip_over");
  if (kind === "cancellation" && facts.refundFailed) refuse("refund_failed");
  if (facts.deliverable >= MAX_STAFF_RESENDS) refuse("limit");
  if (facts.newestResendAt) {
    const lifts = later(facts.newestResendAt, STAFF_RESEND_INTERVAL_MINUTES);
    if (lifts.getTime() > at.getTime()) refuse("too_soon", lifts);
  }
  if (facts.operatorResends >= MAX_OPERATOR_RESENDS_PER_HOUR) {
    refuse("rate_limited", facts.operatorAvailableAt);
  }
  if (facts.sending > 0) refuse("in_progress");
  return out;
}

/** The transaction's time, to the millisecond: the instant the ledger's trigger decides at. */
async function databaseNow(trx: TenantTransaction): Promise<Date> {
  const { rows } = await sql<{ now: Date }>`
    select date_trunc('milliseconds', now()) as now`.execute(trx);
  const now = rows[0]?.now;
  if (!now) throw new Error("the database clock did not answer");
  return new Date(now);
}

const asDate = (v: Date | string) => (typeof v === "string" ? new Date(v) : v);

/**
 * The facts for one booking and kind at `at`; null when the booking is not
 * this tenant's. The limits' counts come from `app.booking_resend_facts`
 * (0014), the one counting definition the ledger's trigger also uses: the
 * booking's deliverable resends, its newest of any state, and the operator's
 * resends in the hour before `at`, with when the 50th newest is an hour old.
 */
async function loadFacts(
  trx: TenantTransaction,
  tenantId: string,
  bookingId: string,
  kind: ResendKind,
  at: Date,
): Promise<ResendFacts | null> {
  const { rows } = await sql<{
    state: "confirmed" | "canceled";
    ends_at: Date | string;
    refund_failed: boolean;
    deliverable: number;
    newest_at: Date | string | null;
    operator_resends: number;
    operator_available_at: Date | string | null;
    sending: number;
  }>`
    select b.state, t.ends_at,
           exists (select 1 from booking_cancellations c
                     join payment_refunds r on r.tenant_id = c.tenant_id and r.id = c.refund_id
                    where c.tenant_id = b.tenant_id and c.booking_id = b.id
                      and r.state = 'failed') as refund_failed,
           f.deliverable, f.newest_at, f.operator_resends, f.operator_available_at,
           (select count(*)::int from email_messages m
             where m.tenant_id = b.tenant_id and m.booking_id = b.id
               and m.template = ${templates[kind].key} and m.state = 'sending') as sending
      from bookings b
      join scheduled_trips t on t.tenant_id = b.tenant_id and t.id = b.trip_id
      cross join lateral app.booking_resend_facts(b.tenant_id, b.id, ${at}::timestamptz) f
     where b.tenant_id = ${tenantId} and b.id = ${bookingId}`.execute(trx);
  const row = rows[0];
  if (!row) return null;
  return {
    bookingState: row.state,
    tripEndsAt: asDate(row.ends_at),
    refundFailed: row.refund_failed,
    deliverable: row.deliverable,
    newestResendAt: row.newest_at === null ? null : asDate(row.newest_at),
    operatorResends: row.operator_resends,
    operatorAvailableAt:
      row.operator_available_at === null ? null : asDate(row.operator_available_at),
    sending: row.sending,
  };
}

/** The first refusal at `at`; the caller has found the booking. */
async function firstRefusal(
  trx: TenantTransaction,
  tenantId: string,
  bookingId: string,
  kind: ResendKind,
  at: Date,
): Promise<ResendRefusal | null> {
  const facts = await loadFacts(trx, tenantId, bookingId, kind, at);
  if (!facts) throw new Error("a booking for a resend was not found");
  return refusalsOf(facts, kind, at)[0] ?? null;
}

/**
 * The first refusal for a resend of `kind` now, on the database clock, or
 * null when none applies. Reads only; the caller has found the booking. The
 * send path decides this way after taking the booking's lock and its earlier
 * messages' locks.
 */
export async function resendRefusal(
  trx: TenantTransaction,
  tenantId: string,
  bookingId: string,
  kind: ResendKind,
): Promise<ResendRefusal | null> {
  return firstRefusal(trx, tenantId, bookingId, kind, await databaseNow(trx));
}

/** When a limit the trigger raised lifts, from the facts: the interval's end, or the hour's. */
function liftsAt(facts: ResendFacts, code: ResendRefusalCode): Date | null {
  if (code === "too_soon" && facts.newestResendAt) {
    return later(facts.newestResendAt, STAFF_RESEND_INTERVAL_MINUTES);
  }
  if (code === "rate_limited") return facts.operatorAvailableAt;
  return null;
}

const limitConstraints: Record<string, ResendRefusalCode> = {
  booking_email_resends_limit: "limit",
  booking_email_resends_interval: "too_soon",
  booking_email_resends_rate: "rate_limited",
  // Eligibility, decided again by the ledger's trigger (0019). The service
  // decides each first under the same locks, so it never meets them.
  booking_email_resends_kind_mismatch: "kind_mismatch",
  booking_email_resends_trip_over: "trip_over",
  booking_email_resends_refund_failed: "refund_failed",
  booking_email_resends_in_progress: "in_progress",
};

/** The refusal the ledger's trigger raised, if that is what this error is (0014, 0019). */
function limitRefused(error: unknown): ResendRefusalCode | null {
  const e = error as { code?: unknown; constraint_name?: unknown } | null;
  if (e?.code !== "23514" || typeof e.constraint_name !== "string") return null;
  return Object.hasOwn(limitConstraints, e.constraint_name)
    ? (limitConstraints[e.constraint_name] ?? null)
    : null;
}

/**
 * Whether staff can send the booking's email again now, for the console's
 * read: the kind that fits its state, the first refusal, and how many sends
 * are left. Advisory: the send decides again under the lock. Null when the
 * booking is not this tenant's. `at` replaces the database clock, for tests.
 */
export async function resendAvailability(
  trx: TenantTransaction,
  tenantId: string,
  bookingId: string,
  options: { at?: Date } = {},
): Promise<ResendAvailability | null> {
  if (!isUuid(bookingId)) return null;
  const { rows } = await sql<{ state: "confirmed" | "canceled" }>`
    select state from bookings where tenant_id = ${tenantId} and id = ${bookingId}`.execute(trx);
  const state = rows[0]?.state;
  if (!state) return null;
  const kind: ResendKind = state === "canceled" ? "cancellation" : "confirmation";
  const at = options.at ?? (await databaseNow(trx));
  const facts = await loadFacts(trx, tenantId, bookingId, kind, at);
  if (!facts) return null;
  const refusals = refusalsOf(facts, kind, at);
  const first = refusals[0] ?? null;
  const timed = first?.availableAt
    ? refusals.flatMap((r) => (r.availableAt ? [r.availableAt.getTime()] : []))
    : [];
  return {
    kind,
    allowed: first === null,
    availableAt: timed.length > 0 ? new Date(Math.max(...timed)) : null,
    remaining: Math.max(0, MAX_STAFF_RESENDS - facts.deliverable),
    blockedBy: first?.code ?? null,
  };
}

/**
 * The operator's resends, one at a time: a transaction-scoped advisory lock
 * per tenant, so the hourly count is read and written by one resend at a time
 * and the cap is exact. Taken first, before any row lock, as checkout's
 * advisory locks are. Only the ledger's trigger (0014) takes this key besides,
 * when the ledger row is written; advisory transaction locks stack, so for
 * this path the second take is a no-op. A resend waiting for it holds nothing
 * another path needs (README, Lock order).
 */
async function lockTenantResends(trx: TenantTransaction, tenantId: string): Promise<void> {
  await sql`select pg_advisory_xact_lock(hashtextextended(${`tidegrid.booking_resend:${tenantId}`}, 0))`.execute(
    trx,
  );
}

/**
 * The cancellation's refund row, shared: a refund being refused right now
 * commits first and the refusal check then sees it, and one refused later
 * waits for this transaction, so its follow-up email comes after the notice.
 * Send path only: the messages read runs READ ONLY and takes no lock.
 */
async function lockCancellationRefund(
  trx: TenantTransaction,
  tenantId: string,
  bookingId: string,
): Promise<void> {
  await sql`
    select r.id from booking_cancellations c
      join payment_refunds r on r.tenant_id = c.tenant_id and r.id = c.refund_id
     where c.tenant_id = ${tenantId} and c.booking_id = ${bookingId}
       for share of r`.execute(trx);
}

/**
 * Send the booking's confirmation or cancellation notice again, in the
 * caller's transaction (the route's, which holds the idempotency key). The
 * order is fixed: the tenant's resend lock (advisory); the booking's row lock
 * (`FOR NO KEY UPDATE`, never `FOR UPDATE`, so the delivery job's key checks
 * never wait behind it); the earlier emails of the same template that have
 * not gone out (`FOR UPDATE`); for a cancellation notice, the refund row
 * (`FOR SHARE`); then every refusal, decided from what is committed, before
 * any write, on the database clock; then, under a savepoint, the earlier queued
 * emails canceled as `resent`, the new message written, and its ledger row;
 * then one audit row. A composer that refuses the booking's data answers
 * `email_invalid`, and a limit the ledger's trigger raises answers its typed
 * refusal, each with everything rolled back to the savepoint. Any other error
 * propagates, and the caller's transaction (the key's claim) rolls back.
 */
export async function resendBookingEmail(
  trx: TenantTransaction,
  ctx: TenantContext,
  input: { bookingId: string; kind: ResendKind; reason: ResendReason },
): Promise<ResendResult> {
  const { bookingId, kind, reason } = input;
  if (!Object.hasOwn(templates, kind)) {
    throw new TypeError("a resend is a confirmation or a cancellation");
  }
  if (!(RESEND_REASONS as readonly string[]).includes(reason)) {
    throw new TypeError("a resend's reason is one of RESEND_REASONS");
  }
  if (!isUuid(bookingId)) return { kind: "not_found" };
  const tenantId = ctx.tenantId;
  const template = templates[kind];

  await lockTenantResends(trx, tenantId);
  const { rows: locked } = await sql<{ id: string }>`
    select id from bookings where tenant_id = ${tenantId} and id = ${bookingId}
       for no key update`.execute(trx);
  if (!locked[0]) return { kind: "not_found" };
  // Before any decision: a delivery claim in progress finishes first, and none
  // starts on these rows until this transaction ends.
  const { rows: pending } = await sql<{ id: string; state: "queued" | "sending" }>`
    select id, state from email_messages
     where tenant_id = ${tenantId} and booking_id = ${bookingId}
       and template = ${template.key} and state in ('queued', 'sending')
     order by created_at, id
       for update`.execute(trx);
  if (kind === "cancellation") await lockCancellationRefund(trx, tenantId, bookingId);

  // Read once: the transaction's time on the database clock, as the trigger reads it.
  const at = await databaseNow(trx);
  const refusal = await firstRefusal(trx, tenantId, bookingId, kind, at);
  if (refusal) return { kind: "refused", code: refusal.code, availableAt: refusal.availableAt };

  const { rows: earlier } = await sql<{
    id: string;
    state: string;
    last_error_code: string | null;
  }>`
    select id, state, last_error_code from email_messages
     where tenant_id = ${tenantId} and booking_id = ${bookingId} and template = ${template.key}
     order by created_at desc, id desc
     limit 1`.execute(trx);
  const prefix = keyPrefix(bookingId);
  const { rows: generations } = await sql<{ highest: number }>`
    select coalesce(max(generation), 0)::int as highest from booking_email_resends
     where tenant_id = ${tenantId} and booking_id = ${bookingId}`.execute(trx);
  const generation = (generations[0]?.highest ?? 0) + 1;

  const canceledMessageIds: string[] = [];
  let messageId: string;
  await sql`savepoint booking_email_resend`.execute(trx);
  try {
    for (const message of pending) {
      const done = await cancelMessage(trx, ctx, message.id, {
        linkReason: "superseded",
        code: "resent",
      });
      // Every pending row is queued here (a sending one refused above) and
      // locked, so nothing can be in flight.
      if (done.kind !== "canceled" || done.inFlight) {
        throw new Error(`an earlier message did not cancel cleanly: ${JSON.stringify(done)}`);
      }
      canceledMessageIds.push(message.id);
    }
    const key = `${prefix}${generation}`;
    const made =
      kind === "confirmation"
        ? await enqueueConfirmationEmail(trx, ctx, bookingId, { dedupeKey: key })
        : await enqueueCancellationEmail(trx, ctx, bookingId, { dedupeKey: key });
    // An imported booking's emails are held (W3-G2.13): nothing to send again.
    if (!made) {
      await sql`rollback to savepoint booking_email_resend`.execute(trx);
      await sql`release savepoint booking_email_resend`.execute(trx);
      return { kind: "refused", code: "email_invalid", availableAt: null };
    }
    if (made.duplicate) {
      // The generation is read from the ledger under the tenant's resend lock,
      // and a message without its ledger row cannot commit (0014), so its key
      // is new: refuse to answer success.
      throw new Error(`a staff resend for generation ${generation} already exists`);
    }
    messageId = made.messageId;
    // The trigger stamps the time and the actor, and decides the limits again.
    await trx
      .insertInto("booking_email_resends")
      .values({
        tenant_id: tenantId,
        booking_id: bookingId,
        generation,
        kind,
        message_id: messageId,
      })
      .execute();
    await sql`release savepoint booking_email_resend`.execute(trx);
  } catch (error) {
    const limit = limitRefused(error);
    if (!(error instanceof TypeError) && !(error instanceof RangeError) && limit === null) {
      throw error;
    }
    await sql`rollback to savepoint booking_email_resend`.execute(trx);
    await sql`release savepoint booking_email_resend`.execute(trx);
    if (limit === null) return { kind: "refused", code: "email_invalid", availableAt: null };
    // The trigger decided at the same instant and precision as the check
    // above, after the D5 cancellations, so it refuses only when a row landed
    // past the tenant's lock, which only a writer with 0014's triggers off can
    // do. When the limit lifts comes from the database's facts, read again.
    const facts = await loadFacts(trx, tenantId, bookingId, kind, at);
    return { kind: "refused", code: limit, availableAt: facts ? liftsAt(facts, limit) : null };
  }

  const { rows: written } = await sql<{ created_at: Date | string; template_version: number }>`
    select created_at, template_version from email_messages
     where tenant_id = ${tenantId} and id = ${messageId}`.execute(trx);
  const createdAt = written[0]?.created_at;
  if (!createdAt) throw new Error("a written resend is not visible");
  const previous = earlier[0];
  // Ids and codes only: never an address, a name, a subject, or a body.
  const after: JsonObject = {
    messageId,
    kind,
    template: template.key,
    // The version written: an imported booking's welcome is version 2.
    templateVersion: written[0]?.template_version ?? template.version,
    generation,
    canceledMessageIds,
    previous: previous
      ? { messageId: previous.id, state: previous.state, failureCode: previous.last_error_code }
      : null,
  };
  await record(trx, ctx, {
    action: "booking.email_resent",
    subjectType: "booking",
    subjectId: bookingId,
    reason,
    after,
  });
  return {
    kind: "queued",
    messageId,
    generation,
    queuedAt: asDate(createdAt),
    canceledMessageIds,
  };
}
