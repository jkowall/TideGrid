/**
 * Participant invitations (W3-G2.11-rest, third part; migration 0036). The
 * booker, through the management link, or staff send one participant an
 * email with a link of their own. The link opens a session that sees only
 * that participant's details and the trip, never the rest of the party, the
 * booker's contact details, or the payment, and lets them correct their own
 * details. A minor's invitation goes to their guardian, who acts for them.
 *
 * - An invitation goes only to the address the participant's row holds now:
 *   their own email, or a minor's guardian's. The database checks it again.
 * - At most `MAX_INVITATIONS_PER_INVITEE` an invitee in 24 hours, and
 *   `MAX_INVITATIONS_PER_BOOKING` a booking, counted under the participant's
 *   row lock, here and by the database.
 * - A newer invitation's link replaces an older unused one. A link works once,
 *   for seven days or until the trip leaves, whichever is first.
 * - Changing the address an invitation went to (the participant's email, a
 *   guardian's, or whether they are a minor) ends that person's invitation
 *   links and every other session of theirs; removing the participant or
 *   canceling the booking ends them all (`withdrawProfileAccess`).
 *
 * Personal data: names and addresses stay in rows and response bodies; audit
 * rows and events record the place and who was written to (the participant
 * or the guardian), never an address.
 *
 * Lock order: the booking row, then the participant at the place, both FOR NO
 * KEY UPDATE, as `putParticipant` takes them.
 */
import { isUuid, type TenantContext, type TenantTransaction } from "@tidegrid/database";
import {
  type EmailBlock,
  enqueueMessage,
  type OpenedSession,
  openGuestSession,
  redeemAccessLink,
  resolveGuestSession,
} from "@tidegrid/domain-messaging";
import { sql } from "kysely";
import { clean, firstName, singleLine, tripWhen } from "./format.ts";
import { type BookingHooks, noBookingHooks } from "./hooks.ts";
import {
  MAX_PARTY_SIZE,
  type ParticipantView,
  type PutParticipantResult,
  placesGivenUp,
  putParticipant,
} from "./participants.ts";
import { iso, record } from "./views.ts";

/** The guest site's page that redeems an invitation's link. */
export const PARTICIPANT_PATH = "/participant";
export const INVITATION_TEMPLATE = { key: "participant_invitation", version: 1 } as const;
/** An invitation's link lasts seven days, or until the trip leaves (the database clamps it). */
export const INVITATION_LINK_TTL_SECONDS = 7 * 24 * 3600;
/** A participant's session lasts an hour; after that they ask the booker for a new invitation (D4). */
export const PARTICIPANT_SESSION_TTL_SECONDS = 3600;
/** Invitations one invitee may be sent in 24 hours (also held by the database). */
export const MAX_INVITATIONS_PER_INVITEE = 3;
/** Invitations one booking may send in 24 hours (also held by the database). */
export const MAX_INVITATIONS_PER_BOOKING = 20;

const demoNote =
  "TideGrid demo: this booking is synthetic. No real card was charged and no money moves.";

// Invitations --------------------------------------------------------------------------

export type InviteParticipantResult =
  | {
      kind: "invited";
      participantId: string;
      messageId: string;
      /** Who the email went to: the participant, or a minor's guardian. */
      recipient: "participant" | "guardian";
    }
  | { kind: "booking_not_found" }
  | { kind: "booking_canceled" }
  | { kind: "trip_departed" }
  | { kind: "position_out_of_range"; partySize: number }
  /** The place was given up, and its number is not used again. */
  | { kind: "place_removed" }
  /** Nobody is named at the place yet. */
  | { kind: "place_not_named" }
  /** An adult with no email of their own; a minor always has a guardian's. */
  | { kind: "no_address" }
  | { kind: "limit_reached" };

interface InviteeRow {
  id: string;
  full_name: string;
  is_minor: boolean;
  email: string | null;
  guardian_name: string | null;
  guardian_email: string | null;
}

/**
 * Send the participant at one place an invitation to check their own
 * details. The caller claims its idempotency key first and commits; the
 * email goes out after commit.
 */
export async function inviteParticipant(
  trx: TenantTransaction,
  ctx: TenantContext,
  input: { bookingId: string; position: number },
): Promise<InviteParticipantResult> {
  if (!Number.isInteger(input.position) || input.position < 1 || input.position > MAX_PARTY_SIZE) {
    throw new RangeError(`a participant's place is a whole number from 1 to ${MAX_PARTY_SIZE}`);
  }
  if (!isUuid(input.bookingId)) return { kind: "booking_not_found" };
  const tenantId = ctx.tenantId;

  const { rows: bookings } = await sql<{
    state: "confirmed" | "canceled";
    party_size: number;
    departed: boolean;
  }>`
    select b.state, b.party_size, t.starts_at <= now() as departed
      from bookings b
      join scheduled_trips t on t.tenant_id = b.tenant_id and t.id = b.trip_id
     where b.tenant_id = ${tenantId} and b.id = ${input.bookingId}
       for no key update of b`.execute(trx);
  const booking = bookings[0];
  if (!booking) return { kind: "booking_not_found" };
  if (booking.state !== "confirmed") return { kind: "booking_canceled" };
  if (booking.departed) return { kind: "trip_departed" };
  const givenUp = await placesGivenUp(trx, tenantId, input.bookingId);
  if (givenUp.includes(input.position)) return { kind: "place_removed" };
  if (input.position > booking.party_size + givenUp.length) {
    return { kind: "position_out_of_range", partySize: booking.party_size };
  }

  const { rows: invitees } = await sql<InviteeRow>`
    select id, full_name, is_minor, email, guardian_name, guardian_email
      from booking_participants
     where tenant_id = ${tenantId} and booking_id = ${input.bookingId}
       and position = ${input.position} and removed_at is null
       for no key update`.execute(trx);
  const invitee = invitees[0];
  if (!invitee) return { kind: "place_not_named" };
  const recipient = invitee.is_minor ? "guardian" : "participant";
  const address = invitee.is_minor ? invitee.guardian_email : invitee.email;
  if (!address) return { kind: "no_address" };

  const { rows: counts } = await sql<{ invitee: number; booking: number }>`
    select count(*) filter (where participant_id = ${invitee.id})::int as invitee,
           count(*)::int as booking
      from email_messages
     where tenant_id = ${tenantId} and booking_id = ${input.bookingId}
       and link_purpose = 'participant_profile'
       and created_at > now() - interval '24 hours'`.execute(trx);
  const recent = counts[0] ?? { invitee: 0, booking: 0 };
  if (
    recent.invitee >= MAX_INVITATIONS_PER_INVITEE ||
    recent.booking >= MAX_INVITATIONS_PER_BOOKING
  ) {
    return { kind: "limit_reached" };
  }

  const messageId = await enqueueInvitation(trx, ctx, input.bookingId, invitee, address);
  await record(trx, ctx, {
    action: "participant.invited",
    subjectType: "booking_participant",
    subjectId: invitee.id,
    after: { bookingId: input.bookingId, position: input.position, recipient },
    topic: "booking.participant.invited",
    payload: {
      bookingId: input.bookingId,
      participantId: invitee.id,
      position: input.position,
      recipient,
    },
  });
  return { kind: "invited", participantId: invitee.id, messageId, recipient };
}

interface InvitationTrip {
  product_name: string;
  starts_at: Date | string;
  time_zone: string;
  location_name: string;
  meeting_point: string | null;
  meeting_instructions: string | null;
  booker_name: string;
}

async function invitationTrip(
  trx: TenantTransaction,
  tenantId: string,
  bookingId: string,
): Promise<InvitationTrip> {
  const { rows } = await sql<InvitationTrip>`
    select p.name as product_name, t.starts_at, t.time_zone, l.name as location_name,
           l.meeting_point, l.meeting_instructions, s.booker_name
      from bookings b
      join scheduled_trips t on t.tenant_id = b.tenant_id and t.id = b.trip_id
      join products p on p.tenant_id = t.tenant_id and p.id = t.product_id
      join locations l on l.tenant_id = p.tenant_id and l.id = p.location_id
      join checkout_sessions s on s.tenant_id = b.tenant_id and s.id = b.checkout_session_id
     where b.tenant_id = ${tenantId} and b.id = ${bookingId}`.execute(trx);
  const row = rows[0];
  if (!row) throw new Error("an invitation's booking was not found");
  return row;
}

async function enqueueInvitation(
  trx: TenantTransaction,
  ctx: TenantContext,
  bookingId: string,
  invitee: InviteeRow,
  address: string,
): Promise<string> {
  const trip = await invitationTrip(trx, ctx.tenantId, bookingId);
  const when = tripWhen(iso(trip.starts_at), trip.time_zone);
  const booker = firstName(trip.booker_name);
  const product = clean(trip.product_name, 1000);
  const where = trip.meeting_point
    ? `${trip.meeting_point}, ${trip.location_name}`
    : trip.location_name;
  const forMinor = invitee.is_minor && invitee.guardian_name !== null;
  const greeting = forMinor
    ? `Hi ${firstName(invitee.guardian_name ?? "")}. ${booker} booked ${product} for ${when} and named ${invitee.full_name} in the party, with you as their parent or guardian.`
    : `Hi ${firstName(invitee.full_name)}. ${booker} booked ${product} for ${when} and named you in the party.`;
  const whose = forMinor ? "their" : "your";
  const blocks: EmailBlock[] = [
    { kind: "heading", text: "You're on the trip" },
    { kind: "paragraph", text: clean(greeting, 2000) },
    {
      kind: "details",
      rows: [
        { label: "Trip", value: product },
        { label: "When", value: when },
        { label: "Meet at", value: clean(where, 1000) },
        ...(trip.meeting_instructions
          ? [{ label: "Directions", value: clean(trip.meeting_instructions, 1000) }]
          : []),
      ],
    },
    {
      kind: "paragraph",
      text: `Use the button to check ${whose} name and contact details, and correct them if they are wrong. It shows ${whose} own details only, not the rest of the party or the payment.`,
    },
    { kind: "action", label: `Check ${whose} details`, href: "access_link" },
    {
      kind: "note",
      text: clean(
        `The button works once, for seven days or until the trip leaves. If it has expired, ask ${booker} to send another.`,
        1000,
      ),
    },
    { kind: "note", text: demoNote },
  ];
  const result = await enqueueMessage(trx, ctx, {
    // Each invitation is its own message; the limits above bound how many.
    dedupeKey: `participant.invitation:${invitee.id}:${crypto.randomUUID()}`,
    template: INVITATION_TEMPLATE.key,
    templateVersion: INVITATION_TEMPLATE.version,
    to: {
      email: address,
      name: singleLine(forMinor ? (invitee.guardian_name ?? "") : invitee.full_name, 120) || null,
    },
    bookingId,
    participantId: invitee.id,
    content: {
      subject: singleLine(`Your place on ${trip.product_name}`, 200),
      preview: `Check ${whose} details for ${singleLine(trip.product_name, 100)}.`,
      blocks,
    },
    accessLink: {
      purpose: "participant_profile",
      path: PARTICIPANT_PATH,
      ttlSeconds: INVITATION_LINK_TTL_SECONDS,
    },
  });
  return result.messageId;
}

// The participant's own session --------------------------------------------------------

export type OpenParticipantSessionResult =
  | { kind: "opened"; session: OpenedSession }
  | { kind: "invalid" }
  | { kind: "expired" }
  | { kind: "used" }
  | { kind: "superseded" }
  | { kind: "revoked" }
  /** The link was good, but the booking was canceled, the trip left, or the participant removed. */
  | { kind: "closed" };

/**
 * Exchange an invitation link's token for the participant's session, in one
 * transaction. Only an explicit POST may call this. Another tenant's token
 * is `invalid`. A good link whose participant can no longer be reached is
 * used up and answers `closed`.
 */
export async function openParticipantSession(
  trx: TenantTransaction,
  ctx: TenantContext,
  input: { token: string },
): Promise<OpenParticipantSessionResult> {
  const redeemed = await redeemAccessLink(trx, ctx, {
    token: input.token,
    purpose: "participant_profile",
  });
  if (redeemed.kind !== "redeemed") return { kind: redeemed.kind };
  const { participantId, bookingId } = redeemed.link;
  if (participantId === null) throw new Error("a participant link names no participant");
  const { rows } = await sql<{ open: boolean | null }>`
    select app.profile_access_open(${ctx.tenantId}::uuid, ${bookingId}::uuid,
                                   ${participantId}::uuid) as open`.execute(trx);
  if (rows[0]?.open !== true) return { kind: "closed" };
  const session = await openGuestSession(trx, ctx, {
    link: redeemed.link,
    ttlSeconds: PARTICIPANT_SESSION_TTL_SECONDS,
  });
  return { kind: "opened", session };
}

export interface ParticipantSession {
  sessionId: string;
  bookingId: string;
  participantId: string;
  expiresAt: string;
}

/** The live participant session a bearer token names in this tenant, or null. */
export async function participantSession(
  trx: TenantTransaction,
  tenantId: string,
  token: string,
): Promise<ParticipantSession | null> {
  const session = await resolveGuestSession(trx, tenantId, token, "participant_profile");
  if (!session || session.participantId === null) return null;
  return {
    sessionId: session.sessionId,
    bookingId: session.bookingId,
    participantId: session.participantId,
    expiresAt: session.expiresAt,
  };
}

export interface ParticipantProfileView {
  participant: ParticipantView;
  /** Canceled bookings and departed trips are read-only. */
  bookingState: "confirmed" | "canceled";
  trip: {
    productName: string;
    startsAt: string;
    timeZone: string;
    departed: boolean;
  };
  location: { name: string; meetingPoint: string | null; meetingInstructions: string | null };
  /** The booker's first name, as the invitation named them. */
  bookedBy: string;
  /** Whether the participant may correct their details now. */
  editable: boolean;
}

/**
 * What a participant's session shows: their own details, the trip, and
 * where to meet. Null once the participant is removed or the session has
 * ended (the caller answers that their session is over). Never the party, the booker's contact details, or the payment.
 */
export async function getParticipantProfile(
  trx: TenantTransaction,
  tenantId: string,
  session: ParticipantSession,
): Promise<ParticipantProfileView | null> {
  const { rows } = await sql<{
    id: string;
    position: number;
    full_name: string;
    is_minor: boolean;
    email: string | null;
    guardian_name: string | null;
    guardian_email: string | null;
    created_at: Date | string;
    updated_at: Date | string;
    state: "confirmed" | "canceled";
    product_name: string;
    starts_at: Date | string;
    time_zone: string;
    departed: boolean;
    location_name: string;
    meeting_point: string | null;
    meeting_instructions: string | null;
    booker_name: string;
  }>`
    select pt.id, pt.position, pt.full_name, pt.is_minor, pt.email, pt.guardian_name,
           pt.guardian_email, pt.created_at, pt.updated_at,
           b.state, p.name as product_name, t.starts_at, t.time_zone,
           t.starts_at <= now() as departed,
           l.name as location_name, l.meeting_point, l.meeting_instructions, s.booker_name
      from booking_participants pt
      join bookings b on b.tenant_id = pt.tenant_id and b.id = pt.booking_id
      join scheduled_trips t on t.tenant_id = b.tenant_id and t.id = b.trip_id
      join products p on p.tenant_id = t.tenant_id and p.id = t.product_id
      join locations l on l.tenant_id = p.tenant_id and l.id = p.location_id
      join checkout_sessions s on s.tenant_id = b.tenant_id and s.id = b.checkout_session_id
      -- The session is checked again in this statement, so a session the
      -- booker ended a moment ago never reads the details they just changed.
      join guest_sessions g
        on g.tenant_id = pt.tenant_id and g.id = ${session.sessionId}
       and g.participant_id = pt.id and g.purpose = 'participant_profile'
       and g.revoked_at is null and g.expires_at > now()
     where pt.tenant_id = ${tenantId} and pt.booking_id = ${session.bookingId}
       and pt.id = ${session.participantId} and pt.removed_at is null`.execute(trx);
  const row = rows[0];
  if (!row) return null;
  return {
    participant: {
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
    },
    bookingState: row.state,
    trip: {
      productName: row.product_name,
      startsAt: iso(row.starts_at),
      timeZone: row.time_zone,
      departed: row.departed,
    },
    location: {
      name: row.location_name,
      meetingPoint: row.meeting_point,
      meetingInstructions: row.meeting_instructions,
    },
    bookedBy: firstName(row.booker_name),
    editable: row.state === "confirmed" && !row.departed,
  };
}

/** What a participant may correct: everything but whether they are a minor. */
export interface OwnDetails {
  name: string;
  /** Their own email, if they have one; null or absent for none. */
  email?: string | null | undefined;
  /** A minor's guardian; an adult names none. */
  guardian?: { name: string; email: string } | null | undefined;
}

export type UpdateOwnDetailsResult =
  | Exclude<PutParticipantResult, { kind: "created" } | { kind: "position_out_of_range" }>
  /** Removed from the party; the session is over. */
  | { kind: "participant_not_found" }
  /** A minor named no guardian, or an adult named one. */
  | { kind: "details_invalid"; field: "guardian" };

/**
 * Correct the session's own participant, as `putParticipant` would, with
 * whether they are a minor kept as it is. Changing the address an invitation
 * went to ends their other sessions and links (`putParticipant` does it,
 * keeping this session).
 */
export async function updateOwnDetails(
  trx: TenantTransaction,
  ctx: TenantContext,
  session: ParticipantSession,
  details: OwnDetails,
  hooks: BookingHooks = noBookingHooks,
): Promise<UpdateOwnDetailsResult> {
  // The booking's lock, then the participant's, as putParticipant takes them,
  // so whether they are a minor cannot change between this read and the write.
  await sql`
    select 1 from bookings where tenant_id = ${ctx.tenantId} and id = ${session.bookingId}
       for no key update`.execute(trx);
  const { rows } = await sql<{ position: number; is_minor: boolean }>`
    select position, is_minor from booking_participants
     where tenant_id = ${ctx.tenantId} and booking_id = ${session.bookingId}
       and id = ${session.participantId} and removed_at is null
       for no key update`.execute(trx);
  const current = rows[0];
  if (!current) return { kind: "participant_not_found" };
  const guardian = details.guardian ?? null;
  if (current.is_minor !== (guardian !== null))
    return { kind: "details_invalid", field: "guardian" };
  const result = await putParticipant(
    trx,
    ctx,
    {
      bookingId: session.bookingId,
      position: current.position,
      details: {
        name: details.name,
        isMinor: current.is_minor,
        email: details.email ?? null,
        guardian,
      },
    },
    hooks,
  );
  switch (result.kind) {
    case "created":
    case "position_out_of_range":
      // The place was named and in range a moment ago, under the same locks.
      throw new Error(`a participant's own update answered ${result.kind}`);
    case "place_removed":
      return { kind: "participant_not_found" };
    default:
      return result;
  }
}
