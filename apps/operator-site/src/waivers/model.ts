import type { ParticipantWaiver, StaffRole, WaiverStatusCode } from "@tidegrid/contracts";
import type { IconName, StatusTone } from "@tidegrid/design-system/components";

/**
 * How the console shows a waiver (G2.15): every status is an icon and a
 * label, never a color alone, with a sentence for what staff can do.
 */
export const waiverStatuses: Record<
  WaiverStatusCode,
  { tone: StatusTone; icon: IconName; label: string }
> = {
  signed: { tone: "ready", icon: "check-circle", label: "Signed" },
  waiting: { tone: "pending", icon: "clock", label: "Waiting for signature" },
  email_failed: { tone: "blocked", icon: "x-octagon", label: "Email failed" },
  no_address: { tone: "warning", icon: "alert-triangle", label: "No email address" },
  email_held: { tone: "warning", icon: "alert-triangle", label: "Email on hold" },
  not_assigned: { tone: "warning", icon: "alert-triangle", label: "Not requested" },
  not_required: { tone: "neutral", icon: "dot", label: "No waiver needed" },
  not_needed: { tone: "neutral", icon: "dot", label: "Booking canceled" },
};

/** Who may send a waiver again. Mirrors the API's waivers.manage, for display only. */
export function canSendWaivers(role: StaffRole): boolean {
  return role === "owner" || role === "booking_staff";
}

const messageWords: Record<string, string> = {
  queued: "Email queued",
  sending: "Email sending",
  sent: "Email sent",
  failed: "Email failed",
  canceled: "Email canceled",
};

/**
 * The latest email, in words: what happened to it and where it went, and,
 * when a sending limit held it, when it goes out (on the marina's clock).
 */
export function deliveryText(
  waiver: ParticipantWaiver,
  when: (iso: string) => string,
  now: number,
): string | null {
  const delivery = waiver.request?.delivery;
  if (!delivery) return null;
  const nth = delivery.generation > 1 ? ` (send ${delivery.generation})` : "";
  if (delivery.message?.state === "queued" && Date.parse(delivery.sendAfter) > now) {
    return `Email goes out ${when(delivery.sendAfter)} to ${delivery.recipient}${nth}`;
  }
  const state = delivery.message ? messageWords[delivery.message.state] : "Email queued";
  return `${state ?? "Email queued"} to ${delivery.recipient}${nth}`;
}

const slotWords: Record<string, string> = {
  "72h": "3 days before",
  "24h": "1 day before",
};

/**
 * The reminder emails before departure (W1-G215-REMINDERS), in words: the
 * latest one sent, and the next one while nothing changes. Null for a signed
 * waiver, or when there is nothing to say (or the API predates reminders).
 */
export function reminderText(
  waiver: ParticipantWaiver,
  when: (iso: string) => string,
): string | null {
  const reminders = waiver.request?.reminders;
  if (waiver.request?.state !== "pending" || !reminders) return null;
  const parts: string[] = [];
  const last = reminders.sent.at(-1);
  if (last) {
    const what =
      last.state === "failed"
        ? "Reminder failed"
        : last.state === "canceled"
          ? "Reminder canceled"
          : last.state === "sent"
            ? "Reminder emailed"
            : "Reminder queued";
    parts.push(`${what} ${when(last.at ?? last.queuedAt)} (${slotWords[last.slot] ?? last.slot})`);
  }
  if (reminders.next) {
    parts.push(
      `Next reminder ${when(reminders.next.at)} (${slotWords[reminders.next.slot] ?? reminders.next.slot})`,
    );
  } else if (last && !emailOnItsWay(waiver)) {
    // While an email is on its way a reminder may still follow it, so this
    // is said only once nothing is pending.
    parts.push("No more reminders before the trip");
  }
  return parts.length ? `${parts.join(". ")}.` : null;
}

function emailOnItsWay(waiver: ParticipantWaiver): boolean {
  const pending = (state: string | undefined) => state === "queued" || state === "sending";
  return (
    pending(waiver.request?.delivery?.message?.state) ||
    (waiver.request?.reminders?.sent ?? []).some((r) => pending(r.state))
  );
}

/** Who signs: the participant, or a minor's parent or guardian. */
export function signerText(waiver: ParticipantWaiver): string {
  if (waiver.request?.requiredSigner === "guardian") return "A parent or guardian signs";
  return "Signs for themselves";
}

export function relationshipText(relationship: string | null): string {
  if (relationship === "legal_guardian") return "legal guardian";
  if (relationship === "parent") return "parent";
  return "";
}

/** Whether staff can send it again now, and if not, why. */
export function resendState(
  waiver: ParticipantWaiver,
  now: number,
): { kind: "ready" } | { kind: "later"; at: string } | { kind: "none" } {
  const request = waiver.request;
  if (request?.state !== "pending" || waiver.status === "no_address") {
    return { kind: "none" };
  }
  if (!request.resendAvailableAt) return { kind: "none" };
  return Date.parse(request.resendAvailableAt) <= now
    ? { kind: "ready" }
    : { kind: "later", at: request.resendAvailableAt };
}

export function resendFailureText(reason: string): string {
  switch (reason) {
    case "too_soon":
      return "It went to this address less than 10 minutes ago. Try again shortly.";
    case "limit":
      return "It has been sent 5 times. Allow 5 more sends first, with a reason.";
    case "rate_limited":
      return "Waiver email for this guest, address, or booking has reached its sending limit for now. Try again later.";
    case "email_invalid":
      return "TideGrid couldn't build this email from the booking's details.";
    case "no_address":
      return "The booking has no email address for this person yet.";
    case "not_pending":
      return "This waiver no longer needs a signature.";
    case "trip_over":
      return "The trip ends too soon to send a link.";
    case "forbidden":
      return "Your role can't send waivers or allow more sends.";
    case "signed_out":
      return "You're signed out. Sign in again to send it.";
    case "unreachable":
      return "The console can't reach TideGrid. Check your connection, then try again.";
    default:
      return "TideGrid didn't send it. Try again in a moment.";
  }
}

/** Why "Allow 5 more" did not save, in words for the dialog. */
export function resetFailureText(reason: string): string {
  switch (reason) {
    case "reset_not_needed":
      return "This waiver can't take more sends now. Close this and reload to see its sends.";
    case "not_pending":
      return "This waiver no longer needs a signature.";
    case "forbidden":
      return "Your role can't allow more sends.";
    case "signed_out":
      return "You're signed out. Sign in again to save it.";
    case "unreachable":
      return "The console can't reach TideGrid. Check your connection, then try again.";
    default:
      return "TideGrid didn't save it. Try again in a moment.";
  }
}

/** How a signed waiver was reached, in words, for the signature line. */
export function methodText(method: string | undefined): string {
  if (method === "staff_device") return "with staff, on the operator's device";
  if (method === "participant_qr") return "with staff, by QR code";
  return "from the emailed link";
}

/** Whether staff can start a signing at the dock: the request waits for a signature. */
export function canStartAssisted(waiver: ParticipantWaiver, role: StaffRole): boolean {
  return canSendWaivers(role) && waiver.request?.state === "pending";
}

export function assistedFailureText(reason: string): string {
  switch (reason) {
    case "not_pending":
      return "This waiver no longer needs a signature.";
    case "trip_over":
      return "This trip has ended, so its waiver takes no signature.";
    case "participant_changed":
      return "This person's details changed who signs. Close this and look at the booking again.";
    case "no_site":
      return "This operator's guest site has no working address yet, so there's nowhere to sign.";
    case "forbidden":
      return "Your role can't start a signing.";
    case "signed_out":
      return "You're signed out. Sign in again to start it.";
    case "unreachable":
      return "The console can't reach TideGrid. Check your connection, then try again.";
    default:
      return "TideGrid didn't start it. Try again in a moment.";
  }
}
