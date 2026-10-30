/**
 * Staff resend of a booking's email (G2.16b). An owner or booking staff
 * member sends the booking's confirmation (with a new management link) or its
 * cancellation notice again, from the console, when the guest did not get it.
 *
 * A resend is a new message with its own id and its own dedupe key,
 * "booking.resend:<bookingId>:<generation>", rendered from the booking as it
 * is now and addressed to the booker's address on file. It is never a retry
 * of an earlier message: delivery still sends each message at most once on a
 * provider that does not deduplicate. Its management link is minted when it
 * is sent, and that supersedes the links earlier emails carried (they still
 * renew), so only the newest link opens the booking.
 *
 * Limits, counted from committed email_messages rows under the booking's row
 * lock, across every request and every staff member (owner decision D4 A,
 * 2026-10-29; a database trigger is a pre-pilot follow-up): at most 5
 * deliverable resends per booking for ever (attempted, or still waiting), at
 * least 10 minutes after the booking's newest resend of any state, and 50
 * resends an hour per operator. The generation is separate from the count:
 * 1 plus the highest generation the booking has, in any state.
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

const generationPattern = "^booking\\.resend:[0-9a-f-]{36}:([0-9]{1,9})$";

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

async function databaseNow(trx: TenantTransaction): Promise<Date> {
  const { rows } = await sql<{ now: Date }>`select now() as now`.execute(trx);
  const now = rows[0]?.now;
  if (!now) throw new Error("the database clock did not answer");
  return new Date(now);
}

const asDate = (v: Date | string) => (typeof v === "string" ? new Date(v) : v);

/** The facts for one booking and kind; null when the booking is not this tenant's. */
async function loadFacts(
  trx: TenantTransaction,
  tenantId: string,
  bookingId: string,
  kind: ResendKind,
  at: Date,
): Promise<ResendFacts | null> {
  const prefix = keyPrefix(bookingId);
  const { rows } = await sql<{
    state: "confirmed" | "canceled";
    ends_at: Date | string;
    refund_failed: boolean;
    deliverable: number;
    newest_resend_at: Date | string | null;
    sending: number;
  }>`
    select b.state, t.ends_at,
           exists (select 1 from booking_cancellations c
                     join payment_refunds r on r.tenant_id = c.tenant_id and r.id = c.refund_id
                    where c.tenant_id = b.tenant_id and c.booking_id = b.id
                      and r.state = 'failed') as refund_failed,
           (select count(*)::int from email_messages m
             where m.tenant_id = b.tenant_id and m.booking_id = b.id
               and starts_with(m.dedupe_key, ${prefix})
               and (m.state <> 'canceled' or m.attempts > 0)) as deliverable,
           (select max(m.created_at) from email_messages m
             where m.tenant_id = b.tenant_id and m.booking_id = b.id
               and starts_with(m.dedupe_key, ${prefix})) as newest_resend_at,
           (select count(*)::int from email_messages m
             where m.tenant_id = b.tenant_id and m.booking_id = b.id
               and m.template = ${templates[kind].key} and m.state = 'sending') as sending
      from bookings b
      join scheduled_trips t on t.tenant_id = b.tenant_id and t.id = b.trip_id
     where b.tenant_id = ${tenantId} and b.id = ${bookingId}`.execute(trx);
  const row = rows[0];
  if (!row) return null;
  // The operator's resends in the hour before `at`, and the 50th newest of
  // them: once it is an hour old, the count is under the cap again.
  const { rows: operator } = await sql<{ n: number; fiftieth: Date | string | null }>`
    with recent as (
      select m.created_at from email_messages m
       where m.tenant_id = ${tenantId}
         and starts_with(m.dedupe_key, ${`${STAFF_RESEND_TOPIC}:`})
         and m.created_at > ${at}::timestamptz - interval '1 hour')
    select (select count(*)::int from recent) as n,
           (select created_at from recent order by created_at desc
             offset ${MAX_OPERATOR_RESENDS_PER_HOUR - 1} limit 1) as fiftieth`.execute(trx);
  const recent = operator[0];
  return {
    bookingState: row.state,
    tripEndsAt: asDate(row.ends_at),
    refundFailed: row.refund_failed,
    deliverable: row.deliverable,
    newestResendAt: row.newest_resend_at === null ? null : asDate(row.newest_resend_at),
    operatorResends: recent?.n ?? 0,
    operatorAvailableAt: recent?.fiftieth ? later(asDate(recent.fiftieth), 60) : null,
    sending: row.sending,
  };
}

/**
 * The first refusal for a resend of `kind` at `at`, or null when none
 * applies. Reads only; the caller has found the booking. The send path calls
 * it after taking the booking's lock and its earlier messages' locks.
 */
export async function resendRefusal(
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
 * Send the booking's confirmation or cancellation notice again, in the
 * caller's transaction (the route's, which holds the idempotency key). The
 * order is fixed: the booking's row lock (`FOR NO KEY UPDATE`, never
 * `FOR UPDATE`, so the delivery job's key checks never wait behind it), then
 * the earlier emails of the same template that have not gone out, locked;
 * then every refusal, decided from what is committed, before any write; then,
 * under a savepoint, the earlier queued emails canceled as `resent` and the
 * new message written; then one audit row. A composer that refuses the
 * booking's data answers `email_invalid` with everything rolled back to the
 * savepoint. `at` replaces the database clock for the time limits, for tests;
 * the route never passes it.
 */
export async function resendBookingEmail(
  trx: TenantTransaction,
  ctx: TenantContext,
  input: { bookingId: string; kind: ResendKind; reason: ResendReason },
  options: { at?: Date } = {},
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

  const at = options.at ?? (await databaseNow(trx));
  const refusal = await resendRefusal(trx, tenantId, bookingId, kind, at);
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
    select coalesce(max(substring(dedupe_key from ${generationPattern})::int), 0) as highest
      from email_messages
     where tenant_id = ${tenantId} and booking_id = ${bookingId}
       and starts_with(dedupe_key, ${prefix})`.execute(trx);
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
    if (made.duplicate) {
      // The generation is read under the booking's lock, so its key is new
      // unless another writer bypassed this service: refuse to answer success.
      throw new Error(`a staff resend for generation ${generation} already exists`);
    }
    messageId = made.messageId;
    await sql`release savepoint booking_email_resend`.execute(trx);
  } catch (error) {
    if (!(error instanceof TypeError) && !(error instanceof RangeError)) throw error;
    await sql`rollback to savepoint booking_email_resend`.execute(trx);
    await sql`release savepoint booking_email_resend`.execute(trx);
    return { kind: "refused", code: "email_invalid", availableAt: null };
  }

  const { rows: written } = await sql<{ created_at: Date | string }>`
    select created_at from email_messages
     where tenant_id = ${tenantId} and id = ${messageId}`.execute(trx);
  const createdAt = written[0]?.created_at;
  if (!createdAt) throw new Error("a written resend is not visible");
  const previous = earlier[0];
  // Ids and codes only: never an address, a name, a subject, or a body.
  const after: JsonObject = {
    messageId,
    kind,
    template: template.key,
    templateVersion: template.version,
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
