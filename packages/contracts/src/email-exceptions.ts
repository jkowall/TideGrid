import { z } from "zod";
import { BookingReference } from "./bookings.ts";

/**
 * The tenant-wide staff list of email exceptions (W1-EMAIL-EXC, a follow-up
 * to G2.16b D9 A): every message of the operator that stopped without the
 * email service taking it, newest first. Owners and booking staff only
 * (bookings.read); finance is refused. Like the booking's messages read, it
 * carries no recipient, subject, body, or person's name: only what the email
 * was, its booking's reference, and how delivery ended.
 *
 * The primitives below mirror the private helpers in index.ts, which this
 * module cannot import without a cycle.
 */

const Uuid = z.uuid();
const Instant = z.iso.datetime({ offset: true });

export const EmailExceptionKind = z
  .enum(["booking", "waiver"])
  .describe(
    "booking: the booking's own email (confirmation, booking link, cancellation notice, refund problem notice). waiver: a waiver request, which the booking's Waivers card shows and sends again",
  );
export type EmailExceptionKind = z.infer<typeof EmailExceptionKind>;

export const EmailExceptionState = z
  .enum(["failed", "outcome_unknown", "delivery_failed"])
  .describe(
    "How delivery ended. Every listed message is in the failed delivery state; this splits it by the last error. outcome_unknown: the email service did not answer, so it may have arrived, and TideGrid did not try again. delivery_failed: the email service could not deliver it, and TideGrid did not try again. failed: any other final failure, such as bounced or retries_exhausted",
  );
export type EmailExceptionState = z.infer<typeof EmailExceptionState>;

export const EmailException = z
  .object({
    id: Uuid.describe("The message's id"),
    template: z
      .string()
      .describe(
        "booking_confirmation, booking_manage_link, booking_canceled, booking_refund_failed, waiver_request, ...",
      ),
    kind: EmailExceptionKind,
    state: EmailExceptionState,
    attempts: z.number().int().min(0).describe("Counted delivery attempts"),
    failureCode: z
      .string()
      .describe(
        "The last error's class, as the booking's messages read names it (MESSAGE_FAILURE_CODES); a client shows any other code generically",
      ),
    failedAt: Instant.describe("When delivery stopped"),
    staffResend: z
      .boolean()
      .describe("True for an email staff sent again from the console (G2.16b)"),
    laterSent: z
      .boolean()
      .describe(
        "A later message of the same template, for the same booking, participant, and subject, was accepted by the email service. Acceptance is not proof the guest read it",
      ),
    booking: z
      .object({
        id: Uuid,
        reference: BookingReference,
        timeZone: z.string().describe("The trip's IANA time zone, for showing times"),
      })
      .nullable()
      .describe("The booking the message was about; null for a message about no booking"),
  })
  .describe(
    "A message that stopped without the email service taking it, without its recipient or content",
  );
export type EmailException = z.infer<typeof EmailException>;

export const EmailExceptionQuery = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(50),
  before: Uuid.optional().describe(
    "Cursor: the last exception id of the previous page (nextBefore). One that names no exception of this operator answers 400 cursor_invalid",
  ),
});
export type EmailExceptionQuery = z.infer<typeof EmailExceptionQuery>;

export const EmailExceptionsResponse = z
  .object({
    exceptions: z.array(EmailException),
    nextBefore: Uuid.nullable().describe("Pass as before for the next page; null on the last page"),
  })
  .describe(
    "The operator's failed email, newest first by when delivery stopped. A failed message never changes again, so a cursor keeps naming the same place",
  );
export type EmailExceptionsResponse = z.infer<typeof EmailExceptionsResponse>;
