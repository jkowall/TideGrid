import {
  type BookingEmailResendAvailability,
  type BookingEmailResendBlock,
  type BookingEmailResendKind,
  type BookingEmailResendReason,
  MESSAGE_FAILURE_CODES,
  type MessageFailureCode,
  type MessageStatus,
} from "@tidegrid/contracts";
import type { IconName, StatusTone } from "@tidegrid/design-system/components";

/**
 * How the console shows a booking's email (G2.16b): every state is an icon
 * and a label, never a color alone, with the failure in plain words. The
 * console never sees a recipient, a subject, or a body: the API sends none.
 */

const templateNames: Record<string, string> = {
  booking_confirmation: "Confirmation",
  booking_manage_link: "Booking link",
  booking_canceled: "Cancellation notice",
  booking_refund_failed: "Refund problem notice",
};

/** What an email was, by its template; a template the console does not know is a booking email. */
export function templateName(template: string): string {
  return templateNames[template] ?? "Booking email";
}

/** The booking's own email (D11): waiver requests stay on the Waivers card. */
export function isBookingEmail(message: Pick<MessageStatus, "template">): boolean {
  return !message.template.startsWith("waiver_");
}

export interface StateView {
  tone: StatusTone;
  icon: IconName;
  label: string;
}

/** A message's state as a badge. An unknown outcome is its own label: it may have arrived. */
export function stateView(
  message: Pick<MessageStatus, "state" | "attempts" | "failureCode">,
): StateView {
  switch (message.state) {
    case "queued":
      return message.attempts > 0
        ? { tone: "pending", icon: "refresh", label: "Trying again" }
        : { tone: "pending", icon: "clock", label: "Waiting to send" };
    case "sending":
      return { tone: "pending", icon: "hourglass", label: "Sending" };
    case "sent":
      return { tone: "ready", icon: "check-circle", label: "Sent" };
    case "failed":
      return message.failureCode === "outcome_unknown"
        ? { tone: "warning", icon: "alert-triangle", label: "Outcome unknown" }
        : { tone: "blocked", icon: "x-octagon", label: "Failed" };
    case "canceled":
      return { tone: "neutral", icon: "dot", label: "Not sent" };
  }
}

/** Every known failure or cancellation code in words. */
export const failureCopy: Record<MessageFailureCode, string> = {
  provider_unavailable: "The email service was unavailable. TideGrid tries again on its own.",
  bounced: "The guest's mail server refused it. The address may be wrong.",
  retries_exhausted: "TideGrid tried six times and the email service never took it.",
  link_host_unmapped:
    "The operator's booking site isn't set up yet, so the email's link had nowhere to go.",
  send_error: "Something went wrong preparing it. TideGrid tries again on its own.",
  outcome_unknown:
    "The email service did not answer, so TideGrid did not try again, to avoid a second working link. Send it again if the guest did not get it.",
  invalid_message: "The email service refused the email as TideGrid built it.",
  recipient_suppressed:
    "The email service won't deliver to this address, because mail to it bounced or was reported before.",
  recipient_not_allowed:
    "This environment only sends to approved test addresses, and this isn't one.",
  provider_rate_limited:
    "The email service asked TideGrid to slow down. It tries again on its own.",
  provider_quota_exceeded: "The day's email limit was reached. TideGrid tries again later.",
  sender_not_verified: "The sending address isn't verified with the email service yet.",
  provider_account_suspended: "The email account is suspended, so nothing can be sent.",
  recipient_changed: "Not sent: the address changed before it went out.",
  access_withdrawn: "Not sent: what it asked for was no longer needed.",
  booking_canceled: "Not sent: the booking was canceled first.",
  resent: "Replaced by a newer email before it went out.",
};

const knownCodes = new Set<string>(MESSAGE_FAILURE_CODES);

/** Templates whose email carries a link that opens something. */
const linkTemplates = new Set(["booking_confirmation", "booking_manage_link", "waiver_request"]);

/**
 * A failure in words; a code the console does not know still reads as a
 * sentence. An unknown outcome names the second working link only for an
 * email that carries one.
 */
export function failureText(code: string | null, template = ""): string | null {
  if (code === null) return null;
  if (code === "outcome_unknown" && !linkTemplates.has(template)) {
    return "The email service did not answer, so TideGrid did not try again, to avoid sending it twice. Send it again if the guest did not get it.";
  }
  if (knownCodes.has(code)) return failureCopy[code as MessageFailureCode];
  return "The email service reported a problem TideGrid doesn't describe yet.";
}

const times = (n: number) => (n === 1 ? "1 attempt" : `${n} attempts`);

/**
 * When it happened and how many attempts, in a sentence. `sent` is the email
 * service's acceptance, not proof the guest read it.
 */
export function whenText(
  message: MessageStatus,
  when: (iso: string) => string,
  emailOff: boolean,
): string {
  switch (message.state) {
    case "queued":
      if (message.attempts === 0) {
        return emailOff
          ? `Queued ${when(message.createdAt)}. Email is off here, so it waits.`
          : `Queued ${when(message.createdAt)}.`;
      }
      return message.nextAttemptAt
        ? `Next try ${when(message.nextAttemptAt)}, after ${times(message.attempts)}.`
        : `Waiting to try again, after ${times(message.attempts)}.`;
    case "sending":
      return `Being sent now (${times(message.attempts)}).`;
    case "sent":
      return `Accepted by the email service ${when(message.sentAt ?? message.createdAt)}. That doesn't mean the guest read it.`;
    case "failed":
      return `Stopped ${when(message.failedAt ?? message.createdAt)}, after ${times(message.attempts)}.`;
    case "canceled":
      return `Canceled ${when(message.canceledAt ?? message.createdAt)}.`;
  }
}

/** The email "Send again" sends, by kind. */
export const kindNames: Record<BookingEmailResendKind, string> = {
  confirmation: "confirmation",
  cancellation: "cancellation notice",
};

/** The reasons staff choose from; the history records the code. */
export const reasonOptions: { value: BookingEmailResendReason; label: string }[] = [
  { value: "guest_did_not_receive", label: "The guest didn't get it" },
  { value: "delivery_failed", label: "It failed to send" },
  { value: "delivery_unknown", label: "Its outcome is unknown" },
  { value: "guest_asked_again", label: "The guest asked for it again" },
  { value: "other", label: "Another reason" },
];

/**
 * Why "Send again" is not offered now, in words, with when it will be.
 * Null when it is allowed.
 */
export function blockedText(
  resend: BookingEmailResendAvailability,
  when: (iso: string) => string,
): string | null {
  if (resend.allowed || resend.blockedBy === null) return null;
  const at = resend.availableAt ? when(resend.availableAt) : null;
  const copy: Record<BookingEmailResendBlock, string> = {
    email_off: "Email is off in this environment, so nothing can be sent again here.",
    kind_mismatch: "This booking has no email of that kind to send again.",
    trip_over: "The trip has ended, so the confirmation can't be sent again.",
    refund_failed:
      "The refund failed, so the cancellation notice would say money is on its way when it isn't. Contact the guest directly.",
    limit: "It has been sent again 5 times, the most for one booking.",
    too_soon: at
      ? `It was sent again a moment ago. It can be sent again from ${at}.`
      : "It was sent again a moment ago. Try again in 10 minutes.",
    rate_limited: at
      ? `Your operator has sent 50 emails again in the last hour. It can be sent again from ${at}.`
      : "Your operator has sent 50 emails again in the last hour. Try again later.",
    in_progress: "An earlier email of this kind is being sent right now. Check again in a minute.",
  };
  return copy[resend.blockedBy];
}

/** Why a send did not happen, in words. */
export function resendFailureText(reason: string): string {
  switch (reason) {
    case "email_off":
      return "Email is off in this environment, so nothing was sent.";
    case "kind_mismatch":
      return "The booking changed: it has no email of this kind to send now.";
    case "trip_over":
      return "The trip has ended, so the confirmation wasn't sent again.";
    case "refund_failed":
      return "The refund failed, so the cancellation notice wasn't sent again. Contact the guest directly.";
    case "limit":
      return "It has been sent again 5 times, the most for one booking.";
    case "too_soon":
      return "It was sent again less than 10 minutes ago. Try again shortly.";
    case "rate_limited":
      return "Your operator has sent 50 emails again in the last hour. Try again later.";
    case "in_progress":
      return "An earlier email is being sent right now. Try again in a minute.";
    case "email_invalid":
      return "TideGrid couldn't build this email from the booking's details.";
    case "forbidden":
      return "Your role can't send a booking's email again.";
    case "signed_out":
      return "You're signed out. Sign in again to send it.";
    case "not_found":
      return "This booking isn't here any more.";
    case "unreachable":
      return "The console can't reach TideGrid. Check your connection, then try again.";
    case "key_reused":
      return "An earlier try may have gone through. Check the list before sending it again.";
    default:
      return "TideGrid didn't send it. Try again in a moment.";
  }
}
