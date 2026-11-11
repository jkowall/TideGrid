import { z } from "zod";
import { Participant, ParticipantGuardian } from "./participants.ts";
import { AccessToken } from "./self-service.ts";

/**
 * Participant invitations (W3-G2.11-rest, third part). The booker, through
 * the management link, or staff email one named participant a link of their
 * own: to the participant's own address, or a minor's guardian's, never to an
 * address in the request. The link opens a session that sees only that
 * participant's details and the trip, never the rest of the party, the
 * booker's contact details, or the payment, and corrects only those details.
 *
 * As with the management link, the page reads the token from the URL's
 * fragment and exchanges it only when the person acts, with
 * `POST /v1/public/participant-access`; the session's token is then sent as
 * `Authorization: Bearer <token>` and never appears in a URL.
 *
 * Personal data travels only in request and response bodies.
 */

const Instant = z.iso.datetime({ offset: true });
/** ASCII; the service lowercases it before storing. */
const EmailAddress = z
  .email()
  .max(254)
  .regex(/^[\x21-\x7e]+$/, "Addresses must be ASCII");
const SingleLineText = (max: number) =>
  z
    .string()
    .trim()
    .min(1)
    .max(max)
    // biome-ignore lint/suspicious/noControlCharactersInRegex: the pattern exists to reject them.
    .regex(/^[^\u0000-\u001f\u007f-\u009f]*$/, "Control characters are not allowed");

// Sending one ------------------------------------------------------------------------------

export const ParticipantInvitationResponse = z
  .object({
    status: z.literal("accepted"),
    recipient: z
      .enum(["participant", "guardian"])
      .describe("Who the email goes to: the participant's own address, or a minor's guardian's"),
  })
  .describe("The invitation is queued; it goes out after this request");
export type ParticipantInvitationResponse = z.infer<typeof ParticipantInvitationResponse>;

// The participant's own session ------------------------------------------------------------

export const ParticipantSessionCreateRequest = z.object({
  token: AccessToken.describe("The invitation link's token, from its URL fragment (#t=...)"),
});
export type ParticipantSessionCreateRequest = z.infer<typeof ParticipantSessionCreateRequest>;

export const ParticipantSessionResponse = z.object({
  session: z
    .object({
      token: AccessToken.describe(
        "Send as Authorization: Bearer <token>. Keep it in memory or session storage, never in a URL",
      ),
      expiresAt: Instant,
    })
    .describe("A restricted session for one participant's own details; it lasts an hour"),
});
export type ParticipantSessionResponse = z.infer<typeof ParticipantSessionResponse>;

export const ParticipantProfile = z
  .object({
    participant: Participant,
    bookingState: z.enum(["confirmed", "canceled"]),
    trip: z.object({
      productName: z.string(),
      startsAt: Instant,
      timeZone: z.string().describe("The trip's IANA time zone, for showing its local time"),
      departed: z.boolean(),
    }),
    location: z.object({
      name: z.string(),
      meetingPoint: z.string().nullable(),
      meetingInstructions: z.string().nullable(),
    }),
    bookedBy: z.string().describe("The booker's first name, as the invitation named them"),
    editable: z
      .boolean()
      .describe("Whether the details can be corrected now: not once canceled or departed"),
  })
  .describe(
    "One participant's own view: their details and the trip. Never the rest of the party, the booker's contact details, or the payment. Personal data",
  );
export type ParticipantProfile = z.infer<typeof ParticipantProfile>;

export const ParticipantProfileResponse = z.object({ profile: ParticipantProfile });
export type ParticipantProfileResponse = z.infer<typeof ParticipantProfileResponse>;

/**
 * What a participant may correct about themselves. Whether they are a minor
 * is not theirs to change: a minor's details keep a guardian, an adult's
 * name none.
 */
export const OwnDetailsInput = z.object({
  name: SingleLineText(120).describe("The participant's full name"),
  email: EmailAddress.nullable()
    .optional()
    .describe("The participant's own email, if they have one; optional"),
  guardian: ParticipantGuardian.nullable()
    .optional()
    .describe("A minor's parent or guardian; required for a minor, absent or null for an adult"),
});
export type OwnDetailsInput = z.infer<typeof OwnDetailsInput>;

export const OwnDetailsResponse = z.object({
  profile: ParticipantProfile,
  changed: z.boolean().describe("False when the details were already these"),
});
export type OwnDetailsResponse = z.infer<typeof OwnDetailsResponse>;

export const ParticipantSessionEndResponse = z.object({ ended: z.literal(true) });
