import { z } from "zod";
import {
  BookingCancellation,
  BookingExtra,
  BookingOrder,
  BookingParty,
  BookingReference,
  BookingRefund,
  BookingState,
} from "./bookings.ts";
import { TripSummary } from "./catalog.ts";
import { PaymentProviderName } from "./checkout.ts";
import { ParticipantList } from "./participants.ts";

/**
 * The guest's accountless management of a booking (lane 1, G2.11c), and the
 * delivery status of a booking's email (the G2.16 shim).
 *
 * The booker opens a booking with the link its email carried: the page reads
 * the token from the URL's fragment and exchanges it, only when the guest
 * acts, with `POST /v1/public/booking-access` for a restricted session, so an
 * email scanner's GET or a link preview never uses it. The session's token is
 * then sent as `Authorization: Bearer <token>` and never appears in a URL.
 * Money is integer US cents; instants are RFC 3339.
 */

const Instant = z.iso.datetime({ offset: true });
const Cents = z.number().int().describe("Integer US cents");
const OffsetDateTime = z.iso
  .datetime({ offset: true, local: false })
  .describe("The same instant with the zone's offset, for display");

export const AccessToken = z
  .string()
  .regex(/^[A-Za-z0-9_-]{43}$/)
  .describe("32 random bytes, base64url without padding. Never put one in a URL's path or query");

// Opening a session ---------------------------------------------------------------------

export const ManageSessionCreateRequest = z.object({
  token: AccessToken.describe("The management link's token, from its URL fragment (#t=...)"),
});
export type ManageSessionCreateRequest = z.infer<typeof ManageSessionCreateRequest>;

export const ManageSession = z
  .object({
    token: AccessToken.describe(
      "Send as Authorization: Bearer <token>. Keep it in memory or session storage, never in a URL",
    ),
    expiresAt: Instant,
  })
  .describe("A restricted session for one booking; it lasts an hour");
export type ManageSession = z.infer<typeof ManageSession>;

export const ManageSessionResponse = z.object({
  session: ManageSession,
  booking: z.object({ reference: BookingReference }),
});
export type ManageSessionResponse = z.infer<typeof ManageSessionResponse>;

export const ManageLinkRenewRequest = z.object({
  token: AccessToken.describe("An earlier management link's token: used, expired, or replaced"),
});
export type ManageLinkRenewRequest = z.infer<typeof ManageLinkRenewRequest>;

export const ManageLinkAccepted = z
  .object({ status: z.literal("accepted") })
  .describe(
    "Accepted. A new link goes to the booker's email on file, never to an address in the request",
  );
export type ManageLinkAccepted = z.infer<typeof ManageLinkAccepted>;

// What canceling would do ------------------------------------------------------------------

export const CancellationRefusal = z
  .enum(["already_canceled", "trip_departed", "remedy_requires_operator"])
  .describe(
    "already_canceled: nothing more to do. trip_departed: it is a no-show now. remedy_requires_operator: the policy gives credit here, which the operator issues",
  );

export const CancellationTerms = z
  .object({
    cancelable: z
      .boolean()
      .describe("True when the guest can cancel now, with exactly these terms"),
    refusal: CancellationRefusal.nullable(),
    remedy: z.enum(["full_refund", "percent_refund", "credit", "none"]),
    refundBp: z
      .number()
      .int()
      .min(0)
      .max(10000)
      .describe("Basis points of what was paid: 10000 for a full refund"),
    paidAmount: Cents,
    refundAmount: Cents.describe("Rounded half up to the cent. Send it back to cancel"),
    currency: z.literal("USD"),
    departsAt: Instant,
    cutoffAt: Instant.describe("Departure minus the policy's change cutoff"),
    beforeCutoff: z.boolean(),
    policyVersion: z.number().int().min(1),
    asOf: Instant.describe("The server's clock when these terms were computed"),
  })
  .describe("What canceling now would do, from the booking's own policy version");
export type CancellationTerms = z.infer<typeof CancellationTerms>;

// The booking as its guest sees it ----------------------------------------------------------

export const ManagedBooking = z
  .object({
    id: z.uuid(),
    reference: BookingReference,
    state: BookingState,
    confirmedAt: Instant,
    booker: z.object({ name: z.string(), email: z.string() }).describe("The guest's own details"),
    trip: TripSummary.extend({
      endsAt: Instant,
      endsAtLocal: OffsetDateTime,
      durationMinutes: z.number().int(),
    }),
    location: z.object({
      name: z.string(),
      meetingPoint: z.string(),
      meetingInstructions: z.string(),
    }),
    party: BookingParty,
    extras: z.array(BookingExtra),
    order: BookingOrder,
    payment: z.object({
      provider: PaymentProviderName,
      state: z.enum(["pending", "succeeded", "failed"]),
      amount: Cents,
      currency: z.literal("USD"),
    }),
    refund: BookingRefund.nullable(),
    cancellation: BookingCancellation.nullable(),
    policy: z.object({
      version: z.number().int().min(1),
      cancellationText: z.string(),
      cutoffAt: Instant,
    }),
    participants: ParticipantList,
    partyEditable: z
      .boolean()
      .describe("True while the party can still be named: confirmed and not departed"),
    cancellationTerms: CancellationTerms,
  })
  .describe("One booking as its guest may see it: their own details, the receipt, and the party");
export type ManagedBooking = z.infer<typeof ManagedBooking>;

export const ManagedBookingResponse = z.object({
  booking: ManagedBooking,
  session: z.object({ expiresAt: Instant }),
});
export type ManagedBookingResponse = z.infer<typeof ManagedBookingResponse>;

export const CancellationTermsResponse = z.object({ terms: CancellationTerms });
export type CancellationTermsResponse = z.infer<typeof CancellationTermsResponse>;

export const CancelBookingRequest = z.object({
  expectedRefundAmount: Cents.min(0).describe(
    "The refund the guest was shown. If canceling now gives anything else, nothing changes and the answer is 409 cancellation_terms_changed",
  ),
});
export type CancelBookingRequest = z.infer<typeof CancelBookingRequest>;

export const CancelBookingResponse = z.object({ booking: ManagedBooking });
export type CancelBookingResponse = z.infer<typeof CancelBookingResponse>;

export const ManageSessionEndResponse = z.object({ ended: z.literal(true) });

// Delivery status, for staff -----------------------------------------------------------------

export const MessageDeliveryState = z
  .enum(["queued", "sending", "sent", "failed", "canceled"])
  .describe(
    "queued: waiting, or waiting to retry. sending: an attempt is in flight. sent: the provider accepted it, which is not proof the guest read it. failed: refused, or out of attempts. canceled: no longer needed",
  );

export const MessageStatus = z
  .object({
    id: z.uuid(),
    template: z
      .string()
      .describe("booking_confirmation, booking_manage_link, booking_canceled, ..."),
    templateVersion: z.number().int().min(1),
    state: MessageDeliveryState,
    attempts: z.number().int().min(0),
    lastAttemptAt: Instant.nullable(),
    nextAttemptAt: Instant.nullable().describe("While queued"),
    sentAt: Instant.nullable(),
    failedAt: Instant.nullable(),
    canceledAt: Instant.nullable(),
    failureCode: z
      .string()
      .nullable()
      .describe(
        "The last attempt's error: provider_unavailable, bounced, retries_exhausted, link_host_unmapped, send_error",
      ),
    provider: z.enum(["fake", "cloudflare"]).nullable(),
    createdAt: Instant,
  })
  .describe("A message's delivery, without its recipient or content");
export type MessageStatus = z.infer<typeof MessageStatus>;

export const BookingMessagesResponse = z.object({
  messages: z.array(MessageStatus).describe("Oldest first"),
});
export type BookingMessagesResponse = z.infer<typeof BookingMessagesResponse>;
