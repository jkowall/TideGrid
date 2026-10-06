/**
 * The guest's accountless management of a booking (lane 1, G2.11c). The
 * booker opens it with the link their email carried, exchanged on an explicit
 * POST for a restricted session bound to the tenant, the booking, and the
 * purpose `booking_manage`; or, right after paying, with the checkout's own
 * secret within an hour of confirmation. The session lets them read the
 * booking, name its party, cancel within its policy, and ask for a new link.
 *
 * The links and sessions themselves are in @tidegrid/domain-messaging
 * (access.ts): tokens are stored only as hashes, consumed once, and scoped by
 * tenant, so another operator's token is simply invalid.
 */
import { isUuid, type TenantContext, type TenantTransaction } from "@tidegrid/database";
import {
  type GuestSession,
  hashLinkToken,
  type OpenedSession,
  openGuestSession,
  redeemAccessLink,
  resolveGuestSession,
} from "@tidegrid/domain-messaging";
import { sql } from "kysely";
import { type CancellationTerms, previewCancellation } from "./cancel.ts";
import { type BookingDetailView, getBookingDetail } from "./console.ts";
import { enqueueManageLinkEmail, MANAGE_LINK_TEMPLATE } from "./emails.ts";
import { listParticipants, type ParticipantListView } from "./participants.ts";
import { hashCheckoutSecret } from "./secrets.ts";

/** A management session lasts an hour; the guest asks for a new link after that. */
export const MANAGE_SESSION_TTL_SECONDS = 3600;
/** Link emails one booking may ask for in an hour. */
export const MAX_LINK_EMAILS_PER_HOUR = 3;

export type OpenManageSessionResult =
  | { kind: "opened"; session: OpenedSession; reference: string }
  | { kind: "invalid" }
  | { kind: "expired" }
  | { kind: "used" }
  | { kind: "superseded" }
  | { kind: "revoked" };

async function referenceOf(
  trx: TenantTransaction,
  tenantId: string,
  bookingId: string,
): Promise<string> {
  const { rows } = await sql<{ reference: string }>`
    select reference from bookings where tenant_id = ${tenantId} and id = ${bookingId}`.execute(
    trx,
  );
  const reference = rows[0]?.reference;
  if (!reference) throw new Error("a link's booking was not found");
  return reference;
}

/**
 * Exchange a management link's token for a session, in one transaction: the
 * link is consumed once and the session opened from it. Only an explicit
 * POST may call this. Another tenant's token is `invalid`.
 */
export async function openManageSession(
  trx: TenantTransaction,
  ctx: TenantContext,
  input: { token: string },
): Promise<OpenManageSessionResult> {
  const redeemed = await redeemAccessLink(trx, ctx, {
    token: input.token,
    purpose: "booking_manage",
  });
  if (redeemed.kind !== "redeemed") {
    return { kind: redeemed.kind === "revoked" ? "revoked" : redeemed.kind };
  }
  const session = await openGuestSession(trx, ctx, {
    link: redeemed.link,
    ttlSeconds: MANAGE_SESSION_TTL_SECONDS,
  });
  return {
    kind: "opened",
    session,
    reference: await referenceOf(trx, ctx.tenantId, redeemed.link.bookingId),
  };
}

export type OpenCheckoutSessionResult =
  | { kind: "opened"; session: OpenedSession; reference: string }
  /** No such checkout here, or the secret is wrong. */
  | { kind: "not_found" }
  /** The checkout did not become a booking. */
  | { kind: "not_confirmed" }
  /** The hour after confirmation has passed; the email's link is the way in. */
  | { kind: "window_closed" };

/**
 * Right after paying, the guest's own checkout secret opens a session for the
 * booking it made, within an hour of confirmation, so they can name their
 * party without waiting for the email.
 */
export async function openManageSessionFromCheckout(
  trx: TenantTransaction,
  ctx: TenantContext,
  input: { checkoutSessionId: string; secret: string },
): Promise<OpenCheckoutSessionResult> {
  if (!isUuid(input.checkoutSessionId)) return { kind: "not_found" };
  const secretHash = await hashCheckoutSecret(input.secret);
  const { rows } = await sql<{
    state: string;
    booking_id: string | null;
    reference: string | null;
    within: boolean | null;
  }>`
    select s.state, b.id as booking_id, b.reference,
           now() <= b.confirmed_at + interval '1 hour' as within
      from checkout_sessions s
      left join bookings b on b.tenant_id = s.tenant_id and b.checkout_session_id = s.id
     where s.tenant_id = ${ctx.tenantId} and s.id = ${input.checkoutSessionId}
       and s.secret_hash = ${secretHash}`.execute(trx);
  const row = rows[0];
  if (!row) return { kind: "not_found" };
  if (!row.booking_id || !row.reference) return { kind: "not_confirmed" };
  if (!row.within) return { kind: "window_closed" };
  const session = await openGuestSession(trx, ctx, {
    checkout: { checkoutSessionId: input.checkoutSessionId, bookingId: row.booking_id },
    ttlSeconds: MANAGE_SESSION_TTL_SECONDS,
  });
  return { kind: "opened", session, reference: row.reference };
}

/** The live management session a bearer token names in this tenant, or null. */
export function manageSession(
  trx: TenantTransaction,
  tenantId: string,
  token: string,
): Promise<GuestSession | null> {
  return resolveGuestSession(trx, tenantId, token, "booking_manage");
}

/** What the guest sees of their booking. */
export interface ManagedBookingView {
  booking: BookingDetailView & { booker: { name: string; email: string } };
  policy: { version: number; cancellationText: string; cutoffAt: string };
  party: ParticipantListView;
  /** True while the party can still be named: confirmed and not departed. */
  partyEditable: boolean;
  cancellation: CancellationTerms;
}

/**
 * The booking, its receipt, its party, and what canceling now would do, for
 * the guest who holds its session. Null when it is not this tenant's.
 */
export async function getManagedBooking(
  trx: TenantTransaction,
  tenantId: string,
  bookingId: string,
): Promise<ManagedBookingView | null> {
  const booking = await getBookingDetail(trx, tenantId, bookingId, { withBooker: true });
  if (!booking?.booker) return null;
  const party = await listParticipants(trx, tenantId, bookingId);
  const terms = await previewCancellation(trx, tenantId, bookingId);
  if (!party || !terms) return null;
  return {
    booking: { ...booking, booker: booking.booker },
    policy: {
      version: terms.policyVersion,
      cancellationText: terms.policyText,
      cutoffAt: terms.cutoffAt,
    },
    party,
    partyEditable: booking.state === "confirmed" && terms.refusal !== "trip_departed",
    cancellation: terms,
  };
}

export type RequestLinkResult =
  | { kind: "enqueued"; messageId: string }
  /** Three link emails in the last hour already; ask again later. */
  | { kind: "rate_limited" }
  | { kind: "not_found" };

/**
 * Email the booker a fresh management link: from an open session ("send me a
 * new link"), or by renewing an old link. The link goes only to the booker's
 * address on file, never one the requester names. At most three link emails
 * per booking an hour, counted under the booking's row lock.
 */
export async function requestManageLink(
  trx: TenantTransaction,
  ctx: TenantContext,
  input: { bookingId: string; requestKey: string },
): Promise<RequestLinkResult> {
  if (!isUuid(input.bookingId)) return { kind: "not_found" };
  const { rows: locked } = await sql<{ id: string }>`
    select id from bookings where tenant_id = ${ctx.tenantId} and id = ${input.bookingId}
       for update`.execute(trx);
  if (!locked[0]) return { kind: "not_found" };
  const { rows } = await sql<{ n: number }>`
    select count(*)::int as n from email_messages
     where tenant_id = ${ctx.tenantId} and booking_id = ${input.bookingId}
       and template = ${MANAGE_LINK_TEMPLATE.key}
       and created_at > now() - interval '1 hour'`.execute(trx);
  if ((rows[0]?.n ?? 0) >= MAX_LINK_EMAILS_PER_HOUR) return { kind: "rate_limited" };
  const sent = await enqueueManageLinkEmail(trx, ctx, input.bookingId, input.requestKey);
  return { kind: "enqueued", messageId: sent.messageId };
}

/**
 * Renew from an old management link, used, expired, or superseded: the token
 * names its booking (in this tenant only), and the fresh link goes to the
 * booker's address on file. A token that names nothing answers `not_found`;
 * the API answers every outcome the same way, so tokens cannot be probed.
 */
export async function renewManageLink(
  trx: TenantTransaction,
  ctx: TenantContext,
  input: { token: string; requestKey: string },
): Promise<RequestLinkResult> {
  let tokenHash: string;
  try {
    tokenHash = await hashLinkToken(input.token);
  } catch {
    return { kind: "not_found" };
  }
  const { rows } = await sql<{ booking_id: string }>`
    select booking_id from guest_access_links
     where tenant_id = ${ctx.tenantId} and token_hash = ${tokenHash}
       and purpose = 'booking_manage'`.execute(trx);
  const bookingId = rows[0]?.booking_id;
  if (!bookingId) return { kind: "not_found" };
  return requestManageLink(trx, ctx, { bookingId, requestKey: input.requestKey });
}
