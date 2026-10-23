/**
 * Waiver status for staff: one booking's participants, or a whole trip's,
 * each with its live request (or the last one, when none is live), whether
 * and when it was signed, and its latest delivery with what the email's
 * delivery reports. Delivery and signature are reported separately: an email
 * that was sent says nothing about a signature. Read-only, under the caller's
 * tenant transaction, with the tenant named in every query. The booking's
 * participants and its messages are read through their modules' table
 * contracts, in one query per call; nothing here writes them.
 */
import {
  type GuardianRelationship,
  isUuid,
  type TenantTransaction,
  type WaiverDeliveryKind,
  type WaiverRequestState,
  type WaiverRevokedReason,
  type WaiverSignerRole,
} from "@tidegrid/database";
import { sql } from "kysely";
import { MAX_GENERATIONS } from "./delivery.ts";
import { maskEmail } from "./render.ts";
import { findApplicableVersion } from "./templates.ts";

/** How a participant's waiver stands, as the console shows it: always an icon and a label. */
export type WaiverStatusCode =
  /** Signed for this booking. */
  | "signed"
  /** Sent, or about to be, and waiting for the signer. */
  | "waiting"
  /** The latest email could not be delivered. */
  | "email_failed"
  /** No address to send to yet. */
  | "no_address"
  /**
   * The booking has an address, but no working email went to it: a sending
   * limit held it, or the address went and came back. Staff can send it again
   * once the limits allow.
   */
  | "email_held"
  /** A waiver applies, but this participant has no request, such as one named before it applied. */
  | "not_assigned"
  /** No waiver applies to this trip. */
  | "not_required"
  /** The booking was canceled; nothing is needed. */
  | "not_needed";

/** What the email's delivery reports. */
export type MessageState = "queued" | "sending" | "sent" | "failed" | "canceled";

export interface MessageStatus {
  state: MessageState;
  /** When it was sent, failed, or was last tried; null while it waits for its first try. */
  at: Date | null;
  failureCode: string | null;
}

export interface ParticipantWaiver {
  participantId: string;
  position: number;
  name: string;
  minor: boolean;
  status: WaiverStatusCode;
  request: null | {
    id: string;
    state: WaiverRequestState;
    revokedReason: WaiverRevokedReason | null;
    requiredSigner: WaiverSignerRole;
    templateName: string;
    version: number;
    assignedAt: Date;
    signed: null | {
      evidenceId: string;
      signedAt: Date;
      signerName: string;
      relationship: GuardianRelationship | null;
    };
    delivery: null | {
      generation: number;
      kind: WaiverDeliveryKind;
      /** The address it went to, masked: its first character and its domain. */
      recipient: string;
      queuedAt: Date;
      /** When the email may first go out: later than queuedAt when a limit held it. */
      sendAfter: Date;
      message: MessageStatus;
    };
    /** When staff may send it again; null when it cannot be sent again. */
    resendAvailableAt: Date | null;
  };
}

export interface BookingWaivers {
  bookingId: string;
  reference: string;
  bookingState: string;
  partySize: number;
  /** Whether a waiver applies to the booking's trip now. */
  required: boolean;
  participants: ParticipantWaiver[];
  /** Places in the party nobody has been named for yet. */
  unnamedPlaces: number;
}

interface Row {
  booking_id: string;
  reference: string;
  booking_state: string;
  party_size: number;
  product_id: string;
  participant_id: string | null;
  position: number | null;
  full_name: string | null;
  is_minor: boolean | null;
  request_id: string | null;
  state: WaiverRequestState | null;
  revoked_reason: WaiverRevokedReason | null;
  required_signer: WaiverSignerRole | null;
  template_name: string | null;
  template_version: number | null;
  assigned_at: Date | null;
  evidence_id: string | null;
  signed_at: Date | null;
  signer_name: string | null;
  guardian_relationship: GuardianRelationship | null;
  generation: number | null;
  kind: WaiverDeliveryKind | null;
  recipient_email: string | null;
  queued_at: Date | null;
  message_state: MessageState | null;
  message_at: Date | null;
  message_error: string | null;
  send_after: Date | null;
  /** The latest email's access was closed for a recipient change. */
  latest_closed: boolean | null;
  /** The address the booking has now for the request's signer; null when it has none. */
  current_recipient: string | null;
  /** When the sending limits next allow a send to that address; null when they allow it now. */
  refusal_retry_after: Date | null;
  now: Date;
}

async function rows(
  trx: TenantTransaction,
  tenantId: string,
  filter: { bookingId: string } | { tripId: string },
): Promise<Row[]> {
  const where =
    "bookingId" in filter
      ? sql`b.id = ${filter.bookingId}`
      : sql`b.trip_id = ${filter.tripId} and b.state = 'confirmed'`;
  const { rows: found } = await sql<Row>`
    select b.id as booking_id, b.reference, b.state as booking_state, b.party_size,
           o.product_id, p.id as participant_id, p.position, p.full_name, p.is_minor,
           r.id as request_id, r.state, r.revoked_reason, r.required_signer,
           t.name as template_name, r.template_version, r.created_at as assigned_at,
           e.id as evidence_id, e.signed_at, e.signer_name, e.guardian_relationship,
           d.generation, d.kind, d.recipient_email, d.created_at as queued_at, d.send_after,
           m.state as message_state,
           coalesce(m.sent_at, m.failed_at, m.canceled_at, m.last_attempt_at) as message_at,
           m.last_error_code as message_error,
           (m.state = 'canceled' and m.last_error_code = 'recipient_changed')
             or exists (select 1 from guest_access_links l
                         where l.tenant_id = b.tenant_id and l.message_id = d.message_id
                           and l.revoked_reason = 'recipient_changed') as latest_closed,
           cr.address as current_recipient, f.retry_after as refusal_retry_after,
           now() as now
      from bookings b
      join orders o on o.tenant_id = b.tenant_id and o.id = b.order_id
      left join booking_participants p on p.tenant_id = b.tenant_id and p.booking_id = b.id
      left join lateral (
        select x.id, x.state, x.revoked_reason, x.required_signer, x.template_id,
               x.template_version, x.created_at
          from waiver_requests x
         where x.tenant_id = b.tenant_id and x.booking_id = b.id and x.participant_id = p.id
         order by (x.state in ('pending', 'signed')) desc, x.created_at desc, x.id desc
         limit 1) r on true
      left join waiver_templates t on t.tenant_id = b.tenant_id and t.id = r.template_id
      left join waiver_evidence e on e.tenant_id = b.tenant_id and e.request_id = r.id
      left join lateral (
        select y.generation, y.kind, y.recipient_email, y.created_at, y.send_after, y.message_id
          from waiver_deliveries y
         where y.tenant_id = b.tenant_id and y.request_id = r.id
         order by y.generation desc
         limit 1) d on true
      left join email_messages m on m.tenant_id = b.tenant_id and m.id = d.message_id
      left join lateral (
        select nullif(lower(btrim(case when r.required_signer = 'guardian' then p.guardian_email
                                       else p.email end)), '') as address) cr on true
      left join lateral (
        select x.retry_after
          from app.waiver_send_refusal(b.tenant_id, b.id, p.id, cr.address, now()) x
         where r.state = 'pending' and cr.address is not null) f on true
     where b.tenant_id = ${tenantId} and ${where}
     order by b.confirmed_at, b.id, p.position`.execute(trx);
  return found;
}

function statusOf(row: Row, required: boolean): WaiverStatusCode {
  if (row.booking_state !== "confirmed") return "not_needed";
  if (!row.request_id || (row.state !== "pending" && row.state !== "signed")) {
    return required ? "not_assigned" : "not_required";
  }
  if (row.state === "signed") return "signed";
  // No address for the signer: never had one, or it was removed.
  if (row.current_recipient === null) return "no_address";
  // An address, but no working email went to it.
  if (
    row.generation === null ||
    row.recipient_email !== row.current_recipient ||
    row.latest_closed === true
  ) {
    return "email_held";
  }
  if (row.message_state === "failed") return "email_failed";
  return "waiting";
}

function resendAt(row: Row): Date | null {
  if (row.state !== "pending" || row.booking_state !== "confirmed") return null;
  if (row.current_recipient === null) return null;
  if (row.generation !== null && row.generation >= MAX_GENERATIONS) return null;
  // The database's sending limits, across the participant's requests.
  return row.refusal_retry_after ?? row.now;
}

async function assemble(
  trx: TenantTransaction,
  tenantId: string,
  found: Row[],
): Promise<BookingWaivers[]> {
  const required = new Map<string, boolean>();
  const bookings = new Map<string, BookingWaivers>();
  for (const row of found) {
    if (!required.has(row.product_id)) {
      required.set(
        row.product_id,
        (await findApplicableVersion(trx, tenantId, row.product_id)) !== null,
      );
    }
    let booking = bookings.get(row.booking_id);
    if (!booking) {
      booking = {
        bookingId: row.booking_id,
        reference: row.reference,
        bookingState: row.booking_state,
        partySize: row.party_size,
        required: required.get(row.product_id) ?? false,
        participants: [],
        unnamedPlaces: row.party_size,
      };
      bookings.set(row.booking_id, booking);
    }
    if (!row.participant_id || row.position === null) continue;
    booking.unnamedPlaces -= 1;
    booking.participants.push({
      participantId: row.participant_id,
      position: row.position,
      name: row.full_name ?? "",
      minor: row.is_minor ?? false,
      status: statusOf(row, booking.required),
      request:
        row.request_id && row.state && row.required_signer && row.template_version !== null
          ? {
              id: row.request_id,
              state: row.state,
              revokedReason: row.revoked_reason,
              requiredSigner: row.required_signer,
              templateName: row.template_name ?? "",
              version: row.template_version,
              assignedAt: row.assigned_at ?? row.now,
              signed:
                row.evidence_id && row.signed_at && row.signer_name
                  ? {
                      evidenceId: row.evidence_id,
                      signedAt: row.signed_at,
                      signerName: row.signer_name,
                      relationship: row.guardian_relationship,
                    }
                  : null,
              delivery:
                row.generation !== null &&
                row.kind &&
                row.recipient_email &&
                row.queued_at &&
                row.message_state
                  ? {
                      generation: row.generation,
                      kind: row.kind,
                      recipient: maskEmail(row.recipient_email),
                      queuedAt: row.queued_at,
                      sendAfter: row.send_after ?? row.queued_at,
                      message: {
                        state: row.message_state,
                        at: row.message_at,
                        failureCode: row.message_error,
                      },
                    }
                  : null,
              resendAvailableAt: resendAt(row),
            }
          : null,
    });
  }
  return [...bookings.values()];
}

/** One booking's waivers; null when the booking is not this tenant's. */
export async function listBookingWaivers(
  trx: TenantTransaction,
  tenantId: string,
  bookingId: string,
): Promise<BookingWaivers | null> {
  if (!isUuid(bookingId)) return null;
  const [booking] = await assemble(trx, tenantId, await rows(trx, tenantId, { bookingId }));
  return booking ?? null;
}

export interface TripWaivers {
  tripId: string;
  bookings: BookingWaivers[];
  totals: {
    participants: number;
    signed: number;
    waiting: number;
    attention: number;
    unnamed: number;
  };
}

/**
 * A trip's confirmed bookings and their waivers, for the roster; null when
 * the trip is not this tenant's.
 */
export async function listTripWaivers(
  trx: TenantTransaction,
  tenantId: string,
  tripId: string,
): Promise<TripWaivers | null> {
  if (!isUuid(tripId)) return null;
  const trip = await trx
    .selectFrom("scheduled_trips")
    .select("id")
    .where("tenant_id", "=", tenantId)
    .where("id", "=", tripId)
    .executeTakeFirst();
  if (!trip) return null;
  const bookings = await assemble(trx, tenantId, await rows(trx, tenantId, { tripId }));
  const all = bookings.flatMap((b) => b.participants);
  return {
    tripId,
    bookings,
    totals: {
      participants: all.length,
      signed: all.filter((p) => p.status === "signed").length,
      waiting: all.filter((p) => p.status === "waiting").length,
      attention: all.filter(
        (p) =>
          p.status === "no_address" ||
          p.status === "email_failed" ||
          p.status === "email_held" ||
          p.status === "not_assigned",
      ).length,
      unnamed: bookings.reduce((n, b) => n + b.unnamedPlaces, 0),
    },
  };
}

/** One person's waiver as the booker sees it on the booking's management page. */
export interface GuestParticipantWaiver {
  position: number;
  name: string;
  minor: boolean;
  status: WaiverStatusCode;
  /** Who signs: the participant, or a minor's parent or guardian; null when nothing was requested. */
  signer: WaiverSignerRole | null;
  signedAt: Date | null;
  /** Where the latest email went, masked; null once signed or when none went out. */
  sentTo: string | null;
  /** When a waiting email is due to go out, when that is later than now; else null. */
  sendsAt: Date | null;
}

export interface GuestBookingWaivers {
  /** False when no waiver applies or the booking is not confirmed: the page shows nothing. */
  applies: boolean;
  unnamedPlaces: number;
  participants: GuestParticipantWaiver[];
}

/**
 * The booker's view of their party's waivers, for lane 1's management page:
 * each named person's status, who signs, when it was signed, and where the
 * latest email went, masked. It leaves out ids, evidence, the text, the
 * signer's typed name, and the delivery history: the booker named the party
 * but signs only for themselves. Null when the booking is not this tenant's.
 */
export async function listGuestBookingWaivers(
  trx: TenantTransaction,
  tenantId: string,
  bookingId: string,
): Promise<GuestBookingWaivers | null> {
  const booking = await listBookingWaivers(trx, tenantId, bookingId);
  if (!booking) return null;
  return {
    applies:
      booking.bookingState === "confirmed" &&
      (booking.required || booking.participants.some((p) => p.request !== null)),
    unnamedPlaces: booking.unnamedPlaces,
    participants: booking.participants.map((p) => ({
      position: p.position,
      name: p.name,
      minor: p.minor,
      status: p.status,
      signer: p.request?.requiredSigner ?? null,
      signedAt: p.status === "signed" ? (p.request?.signed?.signedAt ?? null) : null,
      sentTo: p.status === "signed" ? null : (p.request?.delivery?.recipient ?? null),
      sendsAt:
        p.status === "waiting" &&
        p.request?.delivery?.message.state === "queued" &&
        p.request.delivery.sendAfter.getTime() > Date.now()
          ? p.request.delivery.sendAfter
          : null,
    })),
  };
}
