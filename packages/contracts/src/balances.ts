import { z } from "zod";
import { BookingBalance } from "./bookings.ts";

/**
 * Private-charter balances, as staff act on them (W3-G2.8): move the due date
 * with a reason, and email the guest the balance link. A balance paid outside
 * the card flow is recorded as an external payment (W3-G2.10).
 */

const Instant = z.iso.datetime({ offset: true });

// biome-ignore lint/suspicious/noControlCharactersInRegex: the pattern exists to reject them.
const noControl = /^[^\u0000-\u001f\u007f]*$/;

export const BalanceDueChangeRequest = z.object({
  dueAt: Instant.max(40).describe("The new due date; before the trip starts"),
  reason: z
    .string()
    .trim()
    .min(1)
    .max(500)
    .regex(noControl)
    .describe("Why the date moved. Kept with the change and in the audit history"),
});
export type BalanceDueChangeRequest = z.infer<typeof BalanceDueChangeRequest>;

export const BookingBalanceResponse = z.object({ balance: BookingBalance });
export type BookingBalanceResponse = z.infer<typeof BookingBalanceResponse>;

export const BalanceLinkAccepted = z.object({
  status: z.literal("accepted"),
  messageId: z.uuid().describe("The email, as the booking's email history lists it"),
});
export type BalanceLinkAccepted = z.infer<typeof BalanceLinkAccepted>;
