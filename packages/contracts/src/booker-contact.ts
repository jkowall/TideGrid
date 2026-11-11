import { z } from "zod";
import { BookerDetails } from "./checkout.ts";
import { ManagedBooking } from "./self-service.ts";

/**
 * Correcting the booker's own name and email on a confirmed booking
 * (W3-G2.11-rest). The booker does it from the booking session; owners and
 * booking staff do it from the console. Only before the trip leaves, and at
 * most 3 times a booking in 24 hours. An email change ends the old address's
 * links and the booking's other sessions, moves the trip and balance
 * reminders to the new address, tells the old address (without a link), and
 * sends the new address a fresh link.
 */

const Instant = z.iso.datetime({ offset: true });

export const BookerContactChangeRecord = z
  .object({
    contactChangeId: z.uuid(),
    nameChanged: z.boolean(),
    emailChanged: z.boolean(),
    by: z.enum(["staff", "guest", "system", "support"]),
    changedAt: Instant,
  })
  .describe("Which fields changed and who changed them; never the old or new values");
export type BookerContactChangeRecord = z.infer<typeof BookerContactChangeRecord>;

export const BookerContactRequest = BookerDetails.describe(
  "The booker's name and email as they should be. Personal data: never in URLs, events, or logs",
);
export type BookerContactRequest = z.infer<typeof BookerContactRequest>;

export const StaffBookerContactResponse = z.object({
  change: BookerContactChangeRecord.nullable().describe(
    "Null when the details were already these: nothing changed and nothing was sent",
  ),
});
export type StaffBookerContactResponse = z.infer<typeof StaffBookerContactResponse>;

export const GuestBookerContactResponse = z.object({
  booking: ManagedBooking,
  change: BookerContactChangeRecord.nullable().describe(
    "Null when the details were already these: nothing changed and nothing was sent",
  ),
});
export type GuestBookerContactResponse = z.infer<typeof GuestBookerContactResponse>;
