import type { CancellationTerms, ManagedBooking, Participant } from "@tidegrid/contracts";
import type { LedgerRow } from "@tidegrid/design-system/components";
import {
  formatBasisPoints,
  formatDate,
  formatMoney,
  formatRatePpm,
  inZone,
  zoneCity,
} from "@tidegrid/design-system/format";

/**
 * The management page's rules, apart from React (lane 1, G2.11c): what a link
 * problem says, the receipt as ledger rows, the party's places, what canceling
 * gives, and the participant form's checks. Money reaches the screen only
 * through formatMoney, from cents; nothing here adds anything up.
 */

/** Why a link did not open the booking, from the API's code. */
export type LinkProblem = "used" | "expired" | "superseded" | "revoked" | "not_found";

export function linkProblemOf(code: string): LinkProblem | null {
  switch (code) {
    case "link_used":
      return "used";
    case "link_expired":
      return "expired";
    case "link_superseded":
      return "superseded";
    case "link_revoked":
      return "revoked";
    case "link_not_found":
      return "not_found";
    default:
      return null;
  }
}

export function linkProblemCopy(
  problem: LinkProblem,
  operator: string,
): { title: string; body: string } {
  switch (problem) {
    case "used":
      return {
        title: "This link was already used",
        body: "Each link opens your booking once, so it stays yours if the email is forwarded. Ask for a new one and we'll email it to the address you booked with.",
      };
    case "expired":
      return {
        title: "This link has expired",
        body: "Links work for three days. Ask for a new one and we'll email it to the address you booked with.",
      };
    case "superseded":
      return {
        title: "A newer email replaced this link",
        body: "Use the link in your most recent email from us, or ask for a new one.",
      };
    case "revoked":
      return {
        title: "This link no longer works",
        body: "Ask for a new one and we'll email it to the address you booked with.",
      };
    case "not_found":
      return {
        title: "This link doesn't open a booking here",
        body: `Check that you opened the whole link from your email. If it still doesn't work, contact ${operator}.`,
      };
  }
}

/** One place in the party: its participant, or none yet. */
export interface Slot {
  position: number;
  participant: Participant | null;
}

export function slotsOf(partySize: number, participants: readonly Participant[]): Slot[] {
  const byPlace = new Map(participants.map((p) => [p.position, p]));
  return Array.from({ length: partySize }, (_, i) => ({
    position: i + 1,
    participant: byPlace.get(i + 1) ?? null,
  }));
}

/** The booking with one participant saved: the place's old one replaced, or a new place. */
export function withParticipant(booking: ManagedBooking, saved: Participant): ManagedBooking {
  const others = booking.participants.participants.filter((p) => p.position !== saved.position);
  return {
    ...booking,
    participants: {
      ...booking.participants,
      participants: [...others, saved].sort((a, b) => a.position - b.position),
    },
  };
}

/** "2 of 4 named". */
export function namedText(partySize: number, participants: readonly Participant[]): string {
  return `${participants.length} of ${partySize} named`;
}

/** What a participant's row says under the name. */
export function participantDetail(p: Participant): string {
  if (p.isMinor && p.guardian) return `Under 18. Guardian: ${p.guardian.name}`;
  return p.email ? p.email : "Adult";
}

/** The receipt, as the order holds it: trip price, extras, fees, discount, taxes, total. */
export function orderRows(order: ManagedBooking["order"]): LedgerRow[] {
  const rows: LedgerRow[] = [];
  for (const line of order.lines) {
    if (line.kind === "tax") {
      if (line.taxInclusive) continue;
      rows.push({
        id: `l${line.lineNo}`,
        label: line.name,
        ...(line.taxRatePpm !== null ? { detail: formatRatePpm(line.taxRatePpm) } : {}),
        amount: formatMoney(line.amount),
      });
      continue;
    }
    rows.push({
      id: `l${line.lineNo}`,
      label: line.name,
      ...(line.kind === "discount"
        ? {}
        : {
            detail:
              line.unitAmount === 0
                ? `${line.quantity} at no charge`
                : `${line.quantity} × ${formatMoney(line.unitAmount)}`,
          }),
      amount: formatMoney(line.amount),
      kind: line.kind === "discount" ? "adjustment" : "item",
    });
  }
  rows.push({
    id: "total",
    label: "Total paid",
    amount: formatMoney(order.totals.total),
    kind: "total",
  });
  if (order.totals.includedTax > 0) {
    rows.push({
      id: "included",
      label: "Taxes included in the prices",
      amount: formatMoney(order.totals.includedTax),
      kind: "note",
    });
  }
  return rows;
}

/** What canceling now gives, in one sentence. */
export function refundSentence(terms: CancellationTerms): string {
  switch (terms.remedy) {
    case "full_refund":
      return `You get a full refund of ${formatMoney(terms.refundAmount)}.`;
    case "percent_refund":
      return `You get ${formatBasisPoints(terms.refundBp)} back: ${formatMoney(terms.refundAmount)} of the ${formatMoney(terms.paidAmount)} you paid.`;
    case "none":
      return terms.beforeCutoff
        ? "You get no refund: this booking's policy refunds nothing."
        : "You get no refund: the cutoff for a refund has passed.";
    case "credit":
      return "The policy gives a credit now, which the operator issues.";
  }
}

/** When the remedy changes, if it still can: "This holds until Wed, Oct 7 at 6:00 PM EDT, New York time." */
export function cutoffSentence(
  terms: CancellationTerms,
  trip: { timeZone: string; localDate: string; startsAt: string },
): string | null {
  if (!terms.beforeCutoff) return null;
  const at = inZone(terms.cutoffAt, trip.timeZone);
  return `This holds until ${formatDate(at.date, "medium")} at ${at.time} ${at.abbreviation}, ${zoneCity(trip.timeZone)} time.`;
}

/** A refund's state, as the guest reads it. */
export function refundStateText(refund: NonNullable<ManagedBooking["refund"]>): string {
  switch (refund.state) {
    case "succeeded":
      return `${formatMoney(refund.amount)} refunded to your original payment method`;
    case "requested":
      return `${formatMoney(refund.amount)} refund on its way`;
    case "failed":
      return `${formatMoney(refund.amount)} refund could not be sent yet; the operator will follow up`;
  }
}

export interface ParticipantForm {
  name: string;
  isMinor: boolean;
  email: string;
  guardianName: string;
  guardianEmail: string;
}

export function formOf(p: Participant | null): ParticipantForm {
  return {
    name: p?.name ?? "",
    isMinor: p?.isMinor ?? false,
    email: p?.email ?? "",
    guardianName: p?.guardian?.name ?? "",
    guardianEmail: p?.guardian?.email ?? "",
  };
}

export type FormErrors = Partial<Record<keyof ParticipantForm, string>>;

const emailShape = /^[\x21-\x7e]+@[\x21-\x7e]+\.[\x21-\x7e]+$/;
// biome-ignore lint/suspicious/noControlCharactersInRegex: the pattern exists to reject them.
const controls = /[\u0000-\u001f\u007f-\u009f]/;

function nameProblem(value: string, what: string): string | undefined {
  const v = value.trim();
  if (!v) return `Enter ${what}`;
  if (v.length > 120)
    return `${what[0]?.toUpperCase()}${what.slice(1)} is too long (120 characters at most)`;
  if (controls.test(v)) return `Use letters, spaces, and punctuation only`;
  return undefined;
}

function emailProblem(value: string, required: boolean, what: string): string | undefined {
  const v = value.trim();
  if (!v) return required ? `Enter ${what}` : undefined;
  if (v.length > 254 || !emailShape.test(v)) return "Enter an email address like name@example.com";
  return undefined;
}

/** The form's problems, field by field; empty when it can be saved. */
export function formErrors(form: ParticipantForm): FormErrors {
  const errors: FormErrors = {};
  const name = nameProblem(form.name, "their full name");
  if (name) errors.name = name;
  const email = emailProblem(form.email, false, "their email");
  if (email) errors.email = email;
  if (form.isMinor) {
    const guardian = nameProblem(form.guardianName, "the parent or guardian's name");
    if (guardian) errors.guardianName = guardian;
    const guardianEmail = emailProblem(form.guardianEmail, true, "the parent or guardian's email");
    if (guardianEmail) errors.guardianEmail = guardianEmail;
  }
  return errors;
}

/** What the API takes for one place. */
export function inputOf(form: ParticipantForm) {
  return {
    name: form.name.trim(),
    isMinor: form.isMinor,
    email: form.email.trim() ? form.email.trim() : null,
    guardian: form.isMinor
      ? { name: form.guardianName.trim(), email: form.guardianEmail.trim() }
      : null,
  };
}
