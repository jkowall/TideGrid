import { z } from "zod";
import { ManagedBooking } from "./self-service.ts";

/**
 * Giving up one place in a shared-seat booking's party (W3-G2.11-rest). The
 * participant named there, if any, is removed and their waivers withdrawn,
 * and the seat goes back on sale. The guest does it from the booking session
 * before the policy's change cutoff; staff do it too, and an owner may do it
 * after the cutoff with a reason. The booking keeps the price it was sold at.
 */

const Instant = z.iso.datetime({ offset: true });
const Uuid = z.uuid();

// biome-ignore lint/suspicious/noControlCharactersInRegex: the pattern exists to reject them.
const noControl = /^[^\u0000-\u001f\u007f]*$/;

export const PartyChangeRecord = z.object({
  partyChangeId: Uuid,
  position: z.number().int().min(1).max(500).describe("The place given up"),
  participantId: Uuid.nullable().describe("Who was named there, now removed; null if no one was"),
  fromPartySize: z.number().int().min(2),
  toPartySize: z.number().int().min(1),
  beforeCutoff: z.boolean(),
  overridden: z
    .boolean()
    .describe("True when an owner changed the party against the policy, with a reason"),
  by: z.enum(["staff", "guest", "system", "support"]),
  changedAt: Instant,
});
export type PartyChangeRecord = z.infer<typeof PartyChangeRecord>;

export const RemoveParticipantRequest = z.object({
  partySize: z.coerce
    .number()
    .int()
    .min(1)
    .max(500)
    .describe(
      "The party size the guest saw. If the party is another size now, nothing changes (409 booking_changed)",
    ),
});
export type RemoveParticipantRequest = z.infer<typeof RemoveParticipantRequest>;

export const StaffRemoveParticipantRequest = RemoveParticipantRequest.extend({
  overrideReason: z
    .string()
    .trim()
    .min(1)
    .max(500)
    .regex(noControl)
    .nullable()
    .optional()
    .describe(
      "Owners only (bookings.override): why a place is given up past the change cutoff. Kept in the audit history",
    ),
});
export type StaffRemoveParticipantRequest = z.infer<typeof StaffRemoveParticipantRequest>;

export const StaffRemoveParticipantResponse = z.object({ change: PartyChangeRecord });
export type StaffRemoveParticipantResponse = z.infer<typeof StaffRemoveParticipantResponse>;

export const GuestRemoveParticipantResponse = z.object({
  booking: ManagedBooking,
  change: PartyChangeRecord,
});
export type GuestRemoveParticipantResponse = z.infer<typeof GuestRemoveParticipantResponse>;
