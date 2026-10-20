import { z } from "zod";

/**
 * Waiver evidence (G2.15). A waiver request email carries a single-use link
 * whose token sits in the URL's fragment; the guest page sends it once, in a
 * POST body, to open a signing session bound to one participant's request, and
 * then uses the session's secret as `Authorization: Bearer <secret>`. Nothing
 * here is ever in a URL. Staff read each participant's status and the signed
 * PDF, and may send a request again.
 *
 * Who sees what. The signer sees only their own request: the waiver's text,
 * the trip, and the names they sign with. The booker, in their booking
 * session, sees each named person's status, who signs, and where the latest
 * email went, masked; never the evidence. Staff reads carry participants'
 * names, so they need bookings.read (owners and booking staff); finance is
 * refused. The primitives below mirror the private helpers in index.ts, which
 * this module cannot import without a cycle.
 */

const Uuid = z.uuid();
const Instant = z.iso.datetime({ offset: true });
const Sha256 = z.string().regex(/^[0-9a-f]{64}$/);
/** 32 random bytes, base64url without padding. */
const Secret = z.string().regex(/^[A-Za-z0-9_-]{43}$/);
/**
 * Single-line text a guest types. C0 and C1 control characters are refused
 * here, as PostgreSQL's [[:cntrl:]] check refuses them, so bad input answers
 * 400 rather than failing in the database.
 */
const SingleLineText = (max: number) =>
  z
    .string()
    .max(max)
    // biome-ignore lint/suspicious/noControlCharactersInRegex: the pattern exists to reject them.
    .regex(/^[^\u0000-\u001f\u007f-\u009f]*$/, "Control characters are not allowed");

export const WaiverSignerRole = z
  .enum(["participant", "guardian"])
  .describe(
    "participant: an adult signs for themselves; guardian: a parent or legal guardian signs for a minor",
  );
export type WaiverSignerRole = z.infer<typeof WaiverSignerRole>;

export const GuardianRelationship = z
  .enum(["parent", "legal_guardian"])
  .describe("What a guardian declares they are to the minor");
export type GuardianRelationship = z.infer<typeof GuardianRelationship>;

export const WaiverRequestState = z
  .enum(["pending", "signed", "revoked", "superseded"])
  .describe(
    "pending: waiting for the signer; signed: evidence recorded; revoked: no longer needed (the booking was canceled, or the participant changed); superseded: replaced by a request for a newer version",
  );
export type WaiverRequestState = z.infer<typeof WaiverRequestState>;

// The signer's side ------------------------------------------------------------------

export const WaiverLinkRedeemRequest = z.object({
  token: Secret.describe(
    "The token from the email link's fragment (#t=...). Sent once, in this body; a link works once",
  ),
});
export type WaiverLinkRedeemRequest = z.infer<typeof WaiverLinkRedeemRequest>;

export const WaiverSignedSummary = z.object({
  signedAt: Instant,
  signerName: z.string(),
  signerRole: WaiverSignerRole,
  relationship: GuardianRelationship.nullable(),
  documentSha256: Sha256.describe("The SHA-256 of the signed PDF, as recorded"),
});
export type WaiverSignedSummary = z.infer<typeof WaiverSignedSummary>;

export const WaiverSigning = z
  .object({
    state: WaiverRequestState,
    operatorName: z.string(),
    trip: z.object({
      name: z.string(),
      when: z.string().describe("When it departs, on the marina's clock, as a person reads it"),
      place: z.string(),
      bookingReference: z.string(),
    }),
    participant: z
      .object({
        name: z.string(),
        minor: z.boolean(),
        signerName: z
          .string()
          .nullable()
          .describe(
            "The name the signer types: the participant's own, or a minor's parent or guardian's, as the booking gives it",
          ),
      })
      .nullable()
      .describe("Null once the participant has left the booking"),
    signerRole: WaiverSignerRole,
    waiver: z.object({
      title: z.string(),
      version: z.number().int().min(1),
      body: z.string().describe("Plain text: paragraphs separated by blank lines"),
      acknowledgments: z.array(z.string()).min(1).max(10),
      contentSha256: Sha256.describe(
        "Send it back when signing, to show this is the text you read",
      ),
    }),
    consent: z.object({ version: z.string(), text: z.string() }),
    sessionExpiresAt: Instant,
    signed: WaiverSignedSummary.nullable(),
  })
  .describe("One request, as its signer sees it");
export type WaiverSigning = z.infer<typeof WaiverSigning>;

export const WaiverSessionOpenResponse = z.object({
  sessionSecret: Secret.describe(
    "Send it as Authorization: Bearer <secret> for this session's reads and the signature. Keep it in memory or the tab's session storage, never in a URL",
  ),
  waiver: WaiverSigning,
});
export type WaiverSessionOpenResponse = z.infer<typeof WaiverSessionOpenResponse>;

export const WaiverSessionResponse = z.object({ waiver: WaiverSigning });
export type WaiverSessionResponse = z.infer<typeof WaiverSessionResponse>;

export const WaiverSignRequest = z.object({
  contentSha256: Sha256.describe("The version's hash, as the session showed it"),
  acknowledgments: z
    .array(z.boolean())
    .min(1)
    .max(10)
    .describe("One per acknowledgment, in order; every one must be true"),
  consent: z.boolean().describe("Consent to sign electronically; must be true"),
  confirmIdentity: z
    .boolean()
    .describe(
      "The signer confirms who they are: the participant, or the minor's parent or legal guardian; must be true",
    ),
  signature: SingleLineText(200).describe(
    "The typed signature: the signer's full name as the booking gives it",
  ),
  relationship: GuardianRelationship.nullable().describe(
    "A guardian's relationship to the minor; null for a participant",
  ),
});
export type WaiverSignRequest = z.infer<typeof WaiverSignRequest>;

export const WaiverSignProblem = z.object({
  field: z.enum(["acknowledgments", "consent", "confirmIdentity", "signature", "relationship"]),
  code: z.string(),
  message: z.string(),
});
export type WaiverSignProblem = z.infer<typeof WaiverSignProblem>;

export const WaiverSignProblemsResponse = z
  .object({
    error: z.object({
      code: z.literal("signature_invalid"),
      message: z.string(),
      requestId: z.string(),
    }),
    problems: z.array(WaiverSignProblem).min(1),
  })
  .describe("What to fix before signing, field by field");
export type WaiverSignProblemsResponse = z.infer<typeof WaiverSignProblemsResponse>;

// Staff ------------------------------------------------------------------------------

export const WaiverStatusCode = z
  .enum([
    "signed",
    "waiting",
    "email_failed",
    "no_address",
    "email_held",
    "not_assigned",
    "not_required",
    "not_needed",
  ])
  .describe(
    "signed; waiting: sent, not signed yet; email_failed: the latest email failed; no_address: no address to send to yet; email_held: the booking has an address but no working email went to it (a sending limit held it, or the address went and came back); not_assigned: a waiver applies but this participant has no request; not_required: no waiver applies to the trip; not_needed: the booking was canceled",
  );
export type WaiverStatusCode = z.infer<typeof WaiverStatusCode>;

export const WaiverMessageState = z.enum(["queued", "sending", "sent", "failed", "canceled"]);

export const ParticipantWaiver = z.object({
  participantId: Uuid,
  position: z.number().int().min(1),
  name: z.string(),
  minor: z.boolean(),
  status: WaiverStatusCode,
  request: z
    .object({
      id: Uuid,
      state: WaiverRequestState,
      revokedReason: z
        .enum(["participant_removed", "participant_changed", "booking_canceled"])
        .nullable(),
      requiredSigner: WaiverSignerRole,
      templateName: z.string(),
      version: z.number().int().min(1),
      assignedAt: Instant,
      signed: z
        .object({
          evidenceId: Uuid,
          signedAt: Instant,
          signerName: z.string(),
          relationship: GuardianRelationship.nullable(),
        })
        .nullable(),
      delivery: z
        .object({
          generation: z.number().int().min(1),
          kind: z.enum(["initial", "resend"]),
          recipient: z
            .string()
            .describe("The address it went to, masked: first character and domain"),
          queuedAt: Instant,
          sendAfter: Instant.describe(
            "When the email may first go out: later than queuedAt when a sending limit held it",
          ),
          message: z
            .object({
              state: WaiverMessageState,
              at: Instant.nullable(),
              failureCode: z.string().nullable(),
            })
            .nullable()
            .describe("What the email's delivery reports; null when it has not reported yet"),
        })
        .nullable()
        .describe("The latest send; null when nothing was sent"),
      resendAvailableAt: Instant.nullable().describe(
        "When staff may send it again; null when it cannot be sent again",
      ),
    })
    .nullable(),
});
export type ParticipantWaiver = z.infer<typeof ParticipantWaiver>;

export const BookingWaivers = z.object({
  bookingId: Uuid,
  reference: z.string(),
  bookingState: z.string(),
  partySize: z.number().int().min(1),
  required: z.boolean().describe("Whether a waiver applies to the booking's trip now"),
  participants: z.array(ParticipantWaiver).describe("By place in the party"),
  unnamedPlaces: z.number().int().min(0).describe("Places nobody has been named for yet"),
});
export type BookingWaivers = z.infer<typeof BookingWaivers>;

export const BookingWaiversResponse = z.object({ waivers: BookingWaivers });
export type BookingWaiversResponse = z.infer<typeof BookingWaiversResponse>;

export const TripWaiversResponse = z.object({
  tripId: Uuid,
  bookings: z.array(BookingWaivers).describe("Confirmed bookings, oldest first"),
  totals: z.object({
    participants: z.number().int().min(0),
    signed: z.number().int().min(0),
    waiting: z.number().int().min(0),
    attention: z
      .number()
      .int()
      .min(0)
      .describe("Participants whose waiver needs staff: no address, a failed email, or no request"),
    unnamed: z.number().int().min(0),
  }),
});
export type TripWaiversResponse = z.infer<typeof TripWaiversResponse>;

export const WaiverRequestParams = z.object({
  tenantId: z.string(),
  requestId: z.string().describe("Waiver request UUID; anything else answers 404"),
});

export const WaiverEvidenceParams = z.object({
  tenantId: z.string(),
  evidenceId: z.string().describe("Waiver evidence UUID; anything else answers 404"),
});

export const WaiverResendRequest = z.object({
  reason: z
    .string()
    .trim()
    .min(1)
    .max(500)
    // biome-ignore lint/suspicious/noControlCharactersInRegex: the pattern exists to reject them.
    .regex(/^[^\u0000-\u001f\u007f-\u009f]*$/, "Control characters are not allowed")
    .describe("Recorded on the delivery and in the audit history"),
});
export type WaiverResendRequest = z.infer<typeof WaiverResendRequest>;

export const WaiverResendResponse = z.object({
  delivery: z.object({
    generation: z.number().int().min(1),
    queuedAt: Instant,
  }),
});
export type WaiverResendResponse = z.infer<typeof WaiverResendResponse>;

// The booker's side, on the booking's management page --------------------------------

export const GuestParticipantWaiver = z.object({
  position: z.number().int().min(1).describe("The person's place in the party"),
  name: z.string(),
  minor: z.boolean(),
  status: WaiverStatusCode,
  signer: WaiverSignerRole.nullable().describe("Who signs; null when nothing was requested"),
  signedAt: Instant.nullable(),
  sentTo: z
    .string()
    .nullable()
    .describe(
      "Where the latest email went, masked: first character and domain; null once signed or when none went out",
    ),
  sendsAt: Instant.nullable().describe(
    "When a waiting email is due to go out, when that is later than now; null otherwise",
  ),
});
export type GuestParticipantWaiver = z.infer<typeof GuestParticipantWaiver>;

export const ManageWaiversResponse = z.object({
  waivers: z.object({
    applies: z
      .boolean()
      .describe(
        "False when no waiver applies to the trip or the booking is not confirmed; the page then shows nothing",
      ),
    unnamedPlaces: z.number().int().min(0).describe("Places nobody has been named for yet"),
    participants: z.array(GuestParticipantWaiver).describe("By place in the party"),
  }),
});
export type ManageWaiversResponse = z.infer<typeof ManageWaiversResponse>;
