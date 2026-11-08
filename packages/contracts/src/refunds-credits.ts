import { z } from "zod";
import { BookingCancellation, BookingReference } from "./bookings.ts";
import { RefundState } from "./checkout.ts";
import { CancellationTerms } from "./self-service.ts";

/**
 * Refunds, booking credit, and staff cancellation (W3-G2.9). Staff preview a
 * cancellation with the credit alternative beside the refund, then cancel
 * with the policy's remedy, its value as credit, or an override with a
 * reason. A booker's credit balance and ledger are read per booking; owners
 * adjust it with a reason. Refund exceptions list the refunds that need a
 * person.
 *
 * The primitives below mirror the private helpers in index.ts, which this
 * module cannot import without a cycle.
 */

const Uuid = z.uuid();
const Instant = z.iso.datetime({ offset: true });
const Cents = z.number().int().describe("Integer US cents");

export const StaffCancellationPreview = z
  .object({
    terms: CancellationTerms.describe(
      "The policy's terms now, as the guest would see them; staff may also cancel where the guest may not (a credit policy)",
    ),
    refusal: z
      .enum(["already_canceled", "trip_departed"])
      .nullable()
      .describe("Why staff cannot cancel now, or null"),
    policyValue: Cents.describe(
      "What the policy returns, in cents: its refund, or the whole payment when its remedy is credit",
    ),
    refund: z
      .object({
        amount: Cents.describe("The policy's refund to the original payment method"),
        feeReversal: Cents.describe(
          "TideGrid's fee reversed when this refund succeeds; negative or 0. Not the guest's money",
        ),
      })
      .nullable()
      .describe("Taking the policy's remedy as a refund. Null when the policy gives credit"),
    credit: z
      .object({
        amount: Cents,
        balanceAfter: Cents.describe("The booker's credit balance after this credit"),
      })
      .nullable()
      .describe(
        "Taking the policy's value as booking credit instead. Null when the policy gives nothing",
      ),
    creditBalance: Cents.describe("The booker's credit balance with this operator now"),
  })
  .describe("What staff canceling now would do, with the credit alternative beside the refund");
export type StaffCancellationPreview = z.infer<typeof StaffCancellationPreview>;

export const StaffCancellationPreviewResponse = z.object({ preview: StaffCancellationPreview });
export type StaffCancellationPreviewResponse = z.infer<typeof StaffCancellationPreviewResponse>;

export const StaffRemedyChoice = z
  .discriminatedUnion("kind", [
    z.object({ kind: z.literal("policy") }).describe("The policy's own remedy"),
    z
      .object({ kind: z.literal("credit") })
      .describe("The policy's value as booking credit instead of a refund; no reason needed"),
    z
      .object({
        kind: z.literal("override"),
        remedy: z.enum(["full_refund", "percent_refund", "credit", "none"]),
        refundBp: z
          .number()
          .int()
          .min(0)
          .max(10000)
          .describe(
            "Basis points of what was paid: 10000 for a full refund, 1 to 9999 for a percentage, 1 to 10000 for credit, 0 for none",
          ),
        reason: z
          .string()
          .min(1)
          .max(500)
          .describe("Why the policy is set aside; kept in the audit history"),
      })
      .describe("A remedy the policy does not give. Owners only (bookings.override)"),
  ])
  .describe("What the cancellation applies");
export type StaffRemedyChoice = z.infer<typeof StaffRemedyChoice>;

export const StaffCancelRequest = z.object({
  choice: StaffRemedyChoice,
  expectedAmount: Cents.min(0).describe(
    "The value staff were shown, refund plus credit, in cents. If canceling now gives another, nothing changes (409 cancellation_terms_changed)",
  ),
});
export type StaffCancelRequest = z.infer<typeof StaffCancelRequest>;

export const StaffCancelResponse = z.object({
  cancellation: BookingCancellation,
  refund: z
    .object({ state: RefundState, amount: Cents })
    .nullable()
    .describe("The refund, as it stands after the provider's answer; null when there is none"),
});
export type StaffCancelResponse = z.infer<typeof StaffCancelResponse>;

export const CreditEntry = z.object({
  id: Uuid,
  kind: z
    .enum(["issue", "redeem", "reinstate", "adjust"])
    .describe(
      "issue: from a canceled booking. redeem: used toward a booking. reinstate: a redemption returned because its booking was canceled. adjust: staff's correction",
    ),
  amount: Cents.describe("Positive adds to the balance, negative takes from it"),
  balanceAfter: Cents,
  bookingId: Uuid.nullable(),
  reason: z.string().nullable().describe("An adjustment's reason"),
  by: z.enum(["staff", "guest", "system", "support"]),
  createdAt: Instant,
});
export type CreditEntry = z.infer<typeof CreditEntry>;

export const CreditAccount = z
  .object({
    id: Uuid,
    balance: Cents.min(0),
    currency: z.literal("USD"),
    entries: z.array(CreditEntry).describe("The whole ledger, oldest first"),
  })
  .describe(
    "The booker's USD booking credit with this operator, under the email they booked with. Never expires during the pilot",
  );
export type CreditAccount = z.infer<typeof CreditAccount>;

export const CreditAccountResponse = z.object({
  account: CreditAccount.nullable().describe("Null when the booker has never had credit"),
});
export type CreditAccountResponse = z.infer<typeof CreditAccountResponse>;

export const CreditAdjustRequest = z.object({
  amount: z
    .number()
    .int()
    .min(-100_000_000)
    .max(100_000_000)
    .refine((n) => n !== 0, "an adjustment is not 0")
    .describe("Cents to add (positive) or take away (negative)"),
  reason: z
    .string()
    .min(1)
    .max(500)
    // biome-ignore lint/suspicious/noControlCharactersInRegex: the pattern exists to reject them.
    .regex(/^[^\u0000-\u001f\u007f]*$/, "Control characters are not allowed")
    .describe("Why; kept on the ledger and in the audit history"),
});
export type CreditAdjustRequest = z.infer<typeof CreditAdjustRequest>;

export const RefundException = z
  .object({
    id: Uuid,
    reason: z
      .enum(["unsettled", "lookup_refused", "failed_after_success", "succeeded_after_failure"])
      .describe(
        "unsettled: no final answer 24 hours after it was requested. lookup_refused: the payment provider keeps refusing to say what happened to it. failed_after_success: the provider reported it failed after it had succeeded. succeeded_after_failure: the provider reported it succeeded after TideGrid recorded it failed",
      ),
    errorCode: z.string().nullable(),
    raisedAt: Instant,
    open: z
      .boolean()
      .describe(
        "Still needs a person: the refund is still unsettled, or (failed_after_success, succeeded_after_failure) always until followed up outside TideGrid",
      ),
    refund: z.object({
      id: Uuid,
      state: RefundState,
      amount: Cents,
      requestedAt: Instant,
    }),
    booking: z
      .object({ id: Uuid, reference: BookingReference })
      .nullable()
      .describe("Null for a refund of a payment that never became a booking"),
    nextStep: z.string().describe("What to do, in words"),
  })
  .describe("A refund that needs a person");
export type RefundException = z.infer<typeof RefundException>;

export const RefundExceptionsResponse = z.object({ exceptions: z.array(RefundException) });
export type RefundExceptionsResponse = z.infer<typeof RefundExceptionsResponse>;
