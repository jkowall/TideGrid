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

/**
 * Text cut to `max` characters, ending in an ellipsis when cut, so a line
 * built from guest and operator names always fits the messaging module's
 * limits (200 characters for a subject, a preview, or a heading).
 */
export function elide(text: string, max: number): string {
  const chars = [...text];
  if (chars.length <= max) return text;
  return `${chars
    .slice(0, max - 1)
    .join("")
    .trimEnd()}\u2026`;
}

export function waiverRequestEmail(input: WaiverEmailInput): EmailContent {
  const guardian = input.requiredSigner === "guardian";
  // Names are up to 120 characters each; these bounds keep every one-line
  // field under 200 whatever the booking holds.
  const who = elide(input.participantName, 60);
  const trip = elide(input.trip.name, 80);
  const operator = elide(input.operatorName, 80);
  const lasts =
    input.linkDays >= 1
      ? `${input.linkDays} day${input.linkDays === 1 ? "" : "s"}`
      : "a short time before the trip";
  return {
    subject: guardian ? `Sign the waiver for ${who}: ${trip}` : `Sign your waiver for ${trip}`,
    preview: `${operator} needs a signed waiver before ${elide(input.trip.when, 80)}.`,
    blocks: [
      {
        kind: "heading",
        text: guardian
          ? `A waiver for ${elide(input.participantName, 120)}`
          : "Your waiver is ready to sign",
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
