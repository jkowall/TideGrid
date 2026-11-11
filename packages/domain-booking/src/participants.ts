/**
 * Booking participants (lane 1, G2.11c): who is coming, one per place in the
 * party, from 1 to the booking's party size. The guest names them through the
 * management link and corrects them in place; owners and booking staff read
 * them. Giving up a place in a shared-seat party, and removing whoever was
 * named there, is `removeParticipant` (party-changes.ts, W3-G2.11-rest): the
 * place keeps its number and is never named again, and a removed participant
 * is kept for the history that names them but no longer listed here.
 *
 * Personal data. Names and addresses go into the participant rows and the
 * responses that read them, never into audit rows, events, logs, or URLs:
 * audit and events record which place changed and which fields, not values.
 *
 * Lock order: the booking row, then the participant at the place, both FOR NO
 * KEY UPDATE. A cancellation locks the checkout session and then the booking
 * the same way, so the two serialize on the booking: a participant written
 * after a cancellation is refused, by this service and by the table's trigger.
 * NO KEY UPDATE, not UPDATE, so the email delivery job's foreign key checks on
 * these rows never wait behind a change that may itself wait for that job
 * (a hook that cancels a message being sent).
 */
import {
  type AccessRevocationReason,
  isUuid,
  type TenantContext,
  type TenantTransaction,
} from "@tidegrid/database";
import { revokeAccessLinks, revokeGuestSessions } from "@tidegrid/domain-messaging";
import { sql } from "kysely";
import { type BookingHooks, noBookingHooks, type ParticipantField } from "./hooks.ts";
import { iso, record } from "./views.ts";

/** The largest party a booking can have; positions run from 1 to the party size. */
export const MAX_PARTY_SIZE = 500;

export interface ParticipantDetails {
  name: string;
  isMinor: boolean;
  /** Optional; null or absent means none. */
  email?: string | null | undefined;
  /** Required for a minor; null or absent for an adult. */
  guardian?: { name: string; email: string } | null | undefined;
}

export interface ParticipantView {
  id: string;
  position: number;
  name: string;
  isMinor: boolean;
  email: string | null;
  guardian: { name: string; email: string } | null;
  createdAt: string;
  updatedAt: string;
}

export interface ParticipantListView {
  partySize: number;
  /**
   * The places the party has now, in order: 1 to the party size, less any
   * given up, whose numbers are never reused (W3-G2.11-rest). As many as the
   * party size.
   */
  places: number[];
  participants: ParticipantView[];
}

export type PutParticipantResult =
  | { kind: "created"; participant: ParticipantView }
  | { kind: "updated"; participant: ParticipantView; changed: ParticipantField[] }
  | { kind: "unchanged"; participant: ParticipantView }
  | { kind: "booking_not_found" }
  | { kind: "booking_canceled" }
  | { kind: "trip_departed" }
  | { kind: "position_out_of_range"; partySize: number }
  /** The place was given up, and its number is not used again. */
  | { kind: "place_removed" };

interface ParticipantRow {
  id: string;
  position: number;
  full_name: string;
  is_minor: boolean;
  email: string | null;
  guardian_name: string | null;
  guardian_email: string | null;
  created_at: Date | string;
  updated_at: Date | string;
}

const participantColumns = sql`id, position, full_name, is_minor, email, guardian_name,
  guardian_email, created_at, updated_at`;

function toView(row: ParticipantRow): ParticipantView {
  return {
    id: row.id,
    position: row.position,
    name: row.full_name,
    isMinor: row.is_minor,
    email: row.email,
    guardian:
      row.guardian_name !== null && row.guardian_email !== null
        ? { name: row.guardian_name, email: row.guardian_email }
        : null,
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
  };
}

// C0 and C1 controls, which the database's [[:cntrl:]] check also refuses.
// biome-ignore lint/suspicious/noControlCharactersInRegex: the pattern exists to reject them.
const namePattern = /^[^\u0000-\u001f\u007f-\u009f]{1,120}$/;

function normalizeName(value: string, what: string): string {
  const name = value.trim();
  if (!namePattern.test(name)) throw new TypeError(`${what} must be 1 to 120 characters`);
  return name;
}

function normalizeEmail(value: string, what: string): string {
  const email = value.trim().toLowerCase();
  if (email.length > 254 || !/^[\x21-\x7e]+$/.test(email) || !/^[^@]+@[^@]+\.[^@]+$/.test(email)) {
    throw new TypeError(`${what} must be an ASCII address`);
  }
  return email;
}

interface Normalized {
  full_name: string;
  is_minor: boolean;
  email: string | null;
  guardian_name: string | null;
  guardian_email: string | null;
}

/**
 * The details as stored: trimmed names, lowercased addresses. A minor without
 * a guardian, or an adult with one, is a programmer error here: the contract
 * refuses both before a request reaches the service.
 */
export function normalizeParticipant(input: ParticipantDetails): Normalized {
  const guardian = input.guardian ?? null;
  if (input.isMinor !== (guardian !== null)) {
    throw new TypeError("a minor names a guardian, and an adult names none");
  }
  return {
    full_name: normalizeName(input.name, "a participant's name"),
    is_minor: input.isMinor,
    email:
      input.email === null || input.email === undefined
        ? null
        : normalizeEmail(input.email, "a participant's email"),
    guardian_name: guardian ? normalizeName(guardian.name, "a guardian's name") : null,
    guardian_email: guardian ? normalizeEmail(guardian.email, "a guardian's email") : null,
  };
}

const fieldOrder: [ParticipantField, keyof Normalized][] = [
  ["name", "full_name"],
  ["isMinor", "is_minor"],
  ["email", "email"],
  ["guardianName", "guardian_name"],
  ["guardianEmail", "guardian_email"],
];

/** Audit and event state: which details are present, never what they are. */
function shape(row: Normalized | ParticipantRow) {
  return {
    isMinor: row.is_minor,
    hasEmail: row.email !== null,
    hasGuardian: row.guardian_name !== null,
  };
}

/**
 * A booking's party as named so far, by place. Null when the booking is not
 * this tenant's (another tenant's, unknown, or a malformed id).
 */
export async function listParticipants(
  trx: TenantTransaction,
  tenantId: string,
  bookingId: string,
): Promise<ParticipantListView | null> {
  if (!isUuid(bookingId)) return null;
  // One statement, so the party size, the places given up, and the
  // participants are read from one snapshot even under READ COMMITTED: a
  // place given up meanwhile never shows a size and places that disagree.
  const { rows } = await sql<
    Partial<ParticipantRow> & { party_size: number; given_up: number[]; p_id: string | null }
  >`
    select b.party_size,
           array(select c.position from booking_party_changes c
                  where c.tenant_id = b.tenant_id and c.booking_id = b.id
                  order by c.position)::int[] as given_up,
           p.id as p_id, p.position, p.full_name, p.is_minor, p.email, p.guardian_name,
           p.guardian_email, p.created_at, p.updated_at
      from bookings b
      left join booking_participants p
        on p.tenant_id = b.tenant_id and p.booking_id = b.id and p.removed_at is null
     where b.tenant_id = ${tenantId} and b.id = ${bookingId}
     order by p.position`.execute(trx);
  const first = rows[0];
  if (!first) return null;
  return {
    partySize: first.party_size,
    places: placesOf(first.party_size, first.given_up),
    participants: rows
      .filter((r) => r.p_id !== null)
      .map((r) => toView({ ...(r as ParticipantRow), id: r.p_id as string })),
  };
}

/** The places a booking's party gave up, by number (0035). */
export async function placesGivenUp(
  trx: TenantTransaction,
  tenantId: string,
  bookingId: string,
): Promise<number[]> {
  const { rows } = await sql<{ position: number }>`
    select position from booking_party_changes
     where tenant_id = ${tenantId} and booking_id = ${bookingId}
     order by position`.execute(trx);
  return rows.map((r) => r.position);
}

/** The places a party of `partySize` has after giving up `givenUp`. */
export function placesOf(partySize: number, givenUp: readonly number[]): number[] {
  const gone = new Set(givenUp);
  const places: number[] = [];
  for (let place = 1; places.length < partySize; place++) {
    if (!gone.has(place)) places.push(place);
  }
  return places;
}

/**
 * Name the participant at one place in a confirmed booking's party, or correct
 * the one already there. Idempotent by place: the same details again change
 * nothing and record nothing. Refused once the booking is canceled or its
 * trip has departed (by the database clock), and for a place past the party
 * size. A new participant runs the `participantAdded` hook and a change runs
 * `participantUpdated`, inside this transaction; a hook may refuse by
 * throwing `BookingHookRefusal`, which rolls the change back. The caller
 * claims the idempotency key first and commits.
 */
export async function putParticipant(
  trx: TenantTransaction,
  ctx: TenantContext,
  input: { bookingId: string; position: number; details: ParticipantDetails },
  hooks: BookingHooks = noBookingHooks,
): Promise<PutParticipantResult> {
  if (!Number.isInteger(input.position) || input.position < 1 || input.position > MAX_PARTY_SIZE) {
    throw new RangeError(`a participant's place is a whole number from 1 to ${MAX_PARTY_SIZE}`);
  }
  const wanted = normalizeParticipant(input.details);
  if (!isUuid(input.bookingId)) return { kind: "booking_not_found" };

  const { rows: bookings } = await sql<{
    state: "confirmed" | "canceled";
    party_size: number;
    departed: boolean;
  }>`
    select b.state, b.party_size, t.starts_at <= now() as departed
      from bookings b
      join scheduled_trips t on t.tenant_id = b.tenant_id and t.id = b.trip_id
     where b.tenant_id = ${ctx.tenantId} and b.id = ${input.bookingId}
       for no key update of b`.execute(trx);
  const booking = bookings[0];
  if (!booking) return { kind: "booking_not_found" };
  if (booking.state !== "confirmed") return { kind: "booking_canceled" };
  if (booking.departed) return { kind: "trip_departed" };
  const givenUp = await placesGivenUp(trx, ctx.tenantId, input.bookingId);
  if (givenUp.includes(input.position)) return { kind: "place_removed" };
  if (input.position > booking.party_size + givenUp.length) {
    return { kind: "position_out_of_range", partySize: booking.party_size };
  }

  const { rows: existing } = await sql<ParticipantRow>`
    select ${participantColumns} from booking_participants
     where tenant_id = ${ctx.tenantId} and booking_id = ${input.bookingId}
       and position = ${input.position}
       for no key update`.execute(trx);
  const current = existing[0];

  if (!current) {
    const { rows } = await sql<ParticipantRow>`
      insert into booking_participants (tenant_id, booking_id, position, full_name, is_minor,
        email, guardian_name, guardian_email)
      values (${ctx.tenantId}, ${input.bookingId}, ${input.position}, ${wanted.full_name},
              ${wanted.is_minor}, ${wanted.email}, ${wanted.guardian_name},
              ${wanted.guardian_email})
      returning ${participantColumns}`.execute(trx);
    const row = rows[0];
    if (!row) throw new Error("participant insert returned no row");
    await record(trx, ctx, {
      action: "participant.added",
      subjectType: "booking_participant",
      subjectId: row.id,
      after: { bookingId: input.bookingId, position: row.position, ...shape(row) },
      topic: "booking.participant.added",
      payload: { bookingId: input.bookingId, participantId: row.id, position: row.position },
    });
    await hooks.participantAdded?.(trx, ctx, {
      bookingId: input.bookingId,
      participantId: row.id,
      position: row.position,
    });
    return { kind: "created", participant: toView(row) };
  }

  const changed = fieldOrder
    .filter(([, column]) => current[column] !== wanted[column])
    .map(([field]) => field);
  if (changed.length === 0) return { kind: "unchanged", participant: toView(current) };

  const { rows } = await sql<ParticipantRow>`
    update booking_participants
       set full_name = ${wanted.full_name}, is_minor = ${wanted.is_minor}, email = ${wanted.email},
           guardian_name = ${wanted.guardian_name}, guardian_email = ${wanted.guardian_email}
     where tenant_id = ${ctx.tenantId} and id = ${current.id}
     returning ${participantColumns}`.execute(trx);
  const row = rows[0];
  if (!row) throw new Error("locked participant did not update");
  await record(trx, ctx, {
    action: "participant.updated",
    subjectType: "booking_participant",
    subjectId: row.id,
    before: { ...shape(current) },
    after: { ...shape(row), changed },
    topic: "booking.participant.updated",
    payload: {
      bookingId: input.bookingId,
      participantId: row.id,
      position: row.position,
      changed,
    },
  });
  await hooks.participantUpdated?.(trx, ctx, {
    bookingId: input.bookingId,
    participantId: row.id,
    position: row.position,
    changed,
  });
  // An invitation went to the address that changed (invitations.ts, 0036):
  // its links, and every session of that participant but the one making
  // this change, end.
  if (changed.some((f) => f === "email" || f === "guardianEmail" || f === "isMinor")) {
    await withdrawProfileAccess(trx, ctx, {
      bookingId: input.bookingId,
      participantId: row.id,
      reason: "recipient_changed",
      keepSessionId: actingSessionOf(ctx),
    });
  }
  return { kind: "updated", participant: toView(row), changed };
}

/** The guest session making a change, from its actor (`guest_session:<id>`), or null. */
function actingSessionOf(ctx: TenantContext): string | null {
  const match = /^guest_session:([0-9a-f-]{36})$/.exec(ctx.actorId ?? "");
  return match?.[1] ?? null;
}

/**
 * End a participant's invitation links, and their sessions (all but `keep`,
 * the session making the change), and close any invitation not yet sent:
 * when the address it went to changes (`recipient_changed`), the participant
 * is removed (`withdrawn`), or the booking is canceled (`booking_canceled`,
 * every participant's). Call it after the change's own rows are written.
 */
export async function withdrawProfileAccess(
  trx: TenantTransaction,
  ctx: TenantContext,
  input: {
    bookingId: string;
    /** Omit for every participant of the booking. */
    participantId?: string;
    reason: Extract<AccessRevocationReason, "recipient_changed" | "withdrawn" | "booking_canceled">;
    keepSessionId?: string | null;
  },
): Promise<void> {
  const scope = input.participantId === undefined ? {} : { participantId: input.participantId };
  await revokeAccessLinks(trx, ctx, {
    bookingId: input.bookingId,
    purpose: "participant_profile",
    ...scope,
    reason: input.reason,
  });
  await revokeGuestSessions(trx, ctx, {
    bookingId: input.bookingId,
    purpose: "participant_profile",
    ...scope,
    exceptSessionId: input.keepSessionId ?? null,
  });
}
