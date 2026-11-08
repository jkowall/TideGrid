import type { EmailException, StaffRole } from "@tidegrid/contracts";
import type { StateView } from "./model.ts";
import { templateName } from "./model.ts";

/**
 * How the console shows the operator's email exceptions (W1-EMAIL-EXC). Each
 * state is an icon and a label, never a color alone. The console never sees
 * a recipient, a subject, or a body: the API sends none.
 */

/** The page's address. */
export const emailExceptionsPath = "/email-exceptions";

/**
 * Who sees the list and its navigation entry: owners and booking staff, as
 * with a booking's Email card (D2, coordinator default pending owner
 * confirmation). This mirrors the API's `bookings.read` for display only; the
 * API refuses finance either way.
 */
export function canSeeEmailExceptions(role: StaffRole): boolean {
  return role === "owner" || role === "booking_staff";
}

/** What an email was; a waiver request is named as one (D1). */
export function exceptionName(e: Pick<EmailException, "template" | "kind">): string {
  if (e.template === "waiver_request") return "Waiver request";
  if (e.kind === "waiver") return "Waiver email";
  return templateName(e.template);
}

/** How delivery ended, as a badge. */
export function exceptionStateView(state: EmailException["state"]): StateView {
  switch (state) {
    case "outcome_unknown":
      return { tone: "warning", icon: "alert-triangle", label: "Outcome unknown" };
    case "delivery_failed":
      return { tone: "blocked", icon: "x-octagon", label: "Delivery failed" };
    case "failed":
      return { tone: "blocked", icon: "x-octagon", label: "Failed" };
  }
}

/**
 * Where staff follow it up: the booking's Email card for the booking's own
 * email, and the booking's Waivers card for a waiver request, which is shown
 * and sent again there (G2.16b D11). Ids only, never a name or an address.
 */
export function followUpHref(e: Pick<EmailException, "kind" | "booking">): string | null {
  if (!e.booking) return null;
  const booking = `/bookings/${encodeURIComponent(e.booking.id)}`;
  return e.kind === "waiver" ? booking : `${booking}#email`;
}

/**
 * The follow-up link's words. They name the Email card only when the link
 * opens it. A waiver request's link opens the booking, whose Waivers card
 * shows it; nothing moves focus to that card, so the words do not name it.
 */
export function followUpText(e: Pick<EmailException, "kind" | "booking">): string | null {
  if (!e.booking) return null;
  const booking = `Booking ${e.booking.reference}`;
  return e.kind === "waiver" ? booking : `${booking}, Email card`;
}

const attemptsText = (n: number) => (n === 1 ? "1 attempt" : `${n} attempts`);

/** When it stopped, and after how many attempts. */
export function stoppedText(e: EmailException, when: (iso: string) => string): string {
  return `${when(e.failedAt)}, after ${attemptsText(e.attempts)}`;
}

/** The fragment the Email card answers to: an arrival from this list. */
export const emailCardFragment = "#email";
