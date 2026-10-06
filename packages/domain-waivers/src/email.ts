/**
 * The waiver request email, as the messaging module's blocks: who it is for,
 * the trip, and one button that the delivery job turns into the single-use
 * link when it sends. Plain text only; the messaging module escapes it and
 * brands it with the operator's name and colors. Pure.
 */
import type { EmailContent } from "@tidegrid/domain-messaging";
import type { tripFacts } from "./booking.ts";

export const WAIVER_EMAIL_TEMPLATE = "waiver_request";
export const WAIVER_EMAIL_VERSION = 1;

export interface WaiverEmailInput {
  requiredSigner: "participant" | "guardian";
  participantName: string;
  /** Who the email greets: the participant, or a minor's parent or guardian. */
  recipientName: string;
  operatorName: string;
  trip: ReturnType<typeof tripFacts>;
  /** How long the link lasts once sent, in days, rounded down; at least 1. */
  linkDays: number;
  kind: "initial" | "resend";
}

export function waiverRequestEmail(input: WaiverEmailInput): EmailContent {
  const guardian = input.requiredSigner === "guardian";
  const lasts =
    input.linkDays >= 1
      ? `${input.linkDays} day${input.linkDays === 1 ? "" : "s"}`
      : "a short time before the trip";
  return {
    subject: guardian
      ? `Sign the waiver for ${input.participantName}: ${input.trip.name}`
      : `Sign your waiver for ${input.trip.name}`,
    preview: `${input.operatorName} needs a signed waiver before ${input.trip.when}.`,
    blocks: [
      {
        kind: "heading",
        text: guardian ? `A waiver for ${input.participantName}` : "Your waiver is ready to sign",
      },
      {
        kind: "paragraph",
        text: guardian
          ? `Hi ${input.recipientName}, ${input.participantName} is booked as a minor, so ${input.operatorName} needs a parent or legal guardian to sign their waiver before the trip.`
          : `Hi ${input.recipientName}, ${input.operatorName} asks every guest to sign a waiver before the trip. It takes about two minutes on your phone.`,
      },
      {
        kind: "details",
        rows: [
          { label: "Trip", value: input.trip.name },
          { label: "Departs", value: input.trip.when },
          { label: "From", value: input.trip.place },
          { label: "Booking", value: input.trip.bookingReference },
          { label: guardian ? "Signing for" : "For", value: input.participantName },
        ],
      },
      { kind: "action", label: "Review and sign", href: "access_link" },
      {
        kind: "note",
        text: `The link works once and lasts ${lasts}. If it has stopped working, ask ${input.operatorName} to send a new one.${input.kind === "resend" ? " This email replaces any earlier waiver link." : ""}`,
      },
    ],
  };
}
