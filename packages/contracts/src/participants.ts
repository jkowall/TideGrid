import { z } from "zod";

/**
 * Booking participants (lane 1, G2.11c). Who is coming on a confirmed
 * booking: one participant per place in the party, from 1 to the booking's
 * party size. The guest names them after booking, through the accountless
 * management link; owners and booking staff read them. A minor names a
 * guardian, who signs for them once waivers exist (G2.15); an adult names
 * none. The participant's own email is optional.
 *
 * Personal data. Participants travel only in request and response bodies:
 * never in an address, an audit row, an event, or a log. Finance, which does
 * not hold `bookings.read`, never receives them.
 *
 * The primitives below mirror the private helpers in index.ts, which this
 * module cannot import without a cycle.
 */

const Uuid = z.uuid();
const Instant = z.iso.datetime({ offset: true });
/** ASCII; the service lowercases it before storing, so one mailbox is one address. */
const EmailAddress = z
  .email()
  .max(254)
  .regex(/^[\x21-\x7e]+$/, "Addresses must be ASCII");
/**
 * Single-line text a guest types. C0 and C1 control characters are refused
 * here, as PostgreSQL's [[:cntrl:]] check refuses them, so bad input answers
 * 400 rather than failing in the database.
 */
const SingleLineText = (max: number) =>
  z
    .string()
    .trim()
    .min(1)
    .max(max)
    // biome-ignore lint/suspicious/noControlCharactersInRegex: the pattern exists to reject them.
    .regex(/^[^\u0000-\u001f\u007f-\u009f]*$/, "Control characters are not allowed");

export const ParticipantPosition = z.coerce
  .number()
  .int()
  .min(1)
  .max(500)
  .describe("The participant's place in the party: 1 to the booking's party size");

export const ParticipantGuardian = z
  .object({
    name: SingleLineText(120),
    email: EmailAddress,
  })
  .describe("The parent or legal guardian who acts for a minor");
export type ParticipantGuardian = z.infer<typeof ParticipantGuardian>;

/**
 * What the guest sends for one place in the party. A minor needs a guardian;
 * an adult has none. The participant's own email is optional, and absent or
 * null means none.
 */
export const ParticipantInput = z
  .object({
    name: SingleLineText(120).describe("The participant's full name"),
    isMinor: z.boolean().describe("Under 18 on the trip date, by the guest's word"),
    email: EmailAddress.nullable()
      .optional()
      .describe("The participant's own email, if they have one; optional"),
    guardian: ParticipantGuardian.nullable()
      .optional()
      .describe("Required for a minor; absent or null for an adult"),
  })
  .superRefine((value, ctx) => {
    if (value.isMinor && !value.guardian) {
      ctx.addIssue({
        code: "custom",
        path: ["guardian"],
        message: "A minor needs a parent or guardian's name and email",
      });
    }
    if (!value.isMinor && value.guardian) {
      ctx.addIssue({
        code: "custom",
        path: ["guardian"],
        message: "Only a minor names a guardian",
      });
    }
  });
export type ParticipantInput = z.infer<typeof ParticipantInput>;

export const Participant = z
  .object({
    id: Uuid,
    position: z.number().int().min(1).max(500),
    name: z.string(),
    isMinor: z.boolean(),
    email: z.string().nullable(),
    guardian: z.object({ name: z.string(), email: z.string() }).nullable(),
    createdAt: Instant,
    updatedAt: Instant,
  })
  .describe("One person in the party. Personal data");
export type Participant = z.infer<typeof Participant>;

export const ParticipantList = z
  .object({
    partySize: z.number().int().min(1).describe("Places in the party: the most participants"),
    participants: z
      .array(Participant)
      .describe("Named so far, by place; places without a participant are not listed"),
  })
  .describe("A booking's party as named so far");
export type ParticipantList = z.infer<typeof ParticipantList>;

export const ParticipantListResponse = z.object({ party: ParticipantList });
export type ParticipantListResponse = z.infer<typeof ParticipantListResponse>;

export const ParticipantResponse = z.object({
  participant: Participant,
  created: z.boolean().describe("True when this request named the place for the first time"),
});
export type ParticipantResponse = z.infer<typeof ParticipantResponse>;

/** Staff read of one booking's participants: owners and booking staff only. */
export const StaffParticipantParams = z.object({
  tenantId: z.string(),
  bookingId: z.string().describe("Booking UUID; anything else answers 404"),
});
