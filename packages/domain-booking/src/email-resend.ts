/**
 * Staff resend of a booking's email (G2.16b). Contract only in this commit;
 * the service follows its tests.
 */
import type { TenantContext, TenantTransaction } from "@tidegrid/database";

export type ResendKind = "confirmation" | "cancellation";

export const RESEND_REASONS = [
  "guest_did_not_receive",
  "delivery_failed",
  "delivery_unknown",
  "guest_asked_again",
  "other",
] as const;
export type ResendReason = (typeof RESEND_REASONS)[number];

/** The refusals, in the fixed order the service decides them. */
export const RESEND_REFUSAL_ORDER = [
  "kind_mismatch",
  "trip_over",
  "refund_failed",
  "limit",
  "too_soon",
  "rate_limited",
  "in_progress",
] as const;
export type ResendRefusalCode = (typeof RESEND_REFUSAL_ORDER)[number];

export const MAX_STAFF_RESENDS = 5;
export const STAFF_RESEND_INTERVAL_MINUTES = 10;
export const MAX_OPERATOR_RESENDS_PER_HOUR = 50;

export interface ResendFacts {
  bookingState: "confirmed" | "canceled";
  tripEndsAt: Date;
  refundFailed: boolean;
  deliverable: number;
  newestResendAt: Date | null;
  operatorResends: number;
  operatorAvailableAt: Date | null;
  sending: number;
}

export interface ResendRefusal {
  code: ResendRefusalCode;
  availableAt: Date | null;
}

export interface ResendAvailability {
  kind: ResendKind;
  allowed: boolean;
  availableAt: Date | null;
  remaining: number;
  blockedBy: ResendRefusalCode | null;
}

export type ResendResult =
  | {
      kind: "queued";
      messageId: string;
      generation: number;
      queuedAt: Date;
      canceledMessageIds: string[];
    }
  | { kind: "refused"; code: ResendRefusalCode | "email_invalid"; availableAt: Date | null }
  | { kind: "not_found" };

const notBuilt = () => new Error("G2.16b: the staff resend service is not built yet");

export function refusalsOf(_facts: ResendFacts, _kind: ResendKind, _at: Date): ResendRefusal[] {
  throw notBuilt();
}

export async function resendRefusal(
  _trx: TenantTransaction,
  _tenantId: string,
  _bookingId: string,
  _kind: ResendKind,
  _at: Date,
): Promise<ResendRefusal | null> {
  throw notBuilt();
}

export async function resendAvailability(
  _trx: TenantTransaction,
  _tenantId: string,
  _bookingId: string,
  _options: { at?: Date } = {},
): Promise<ResendAvailability | null> {
  throw notBuilt();
}

export async function resendBookingEmail(
  _trx: TenantTransaction,
  _ctx: TenantContext,
  _input: { bookingId: string; kind: ResendKind; reason: ResendReason },
  _options: { at?: Date } = {},
): Promise<ResendResult> {
  throw notBuilt();
}
