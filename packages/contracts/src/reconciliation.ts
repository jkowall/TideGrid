import { z } from "zod";
import { BookingReference } from "./bookings.ts";

/**
 * External payment and reconciliation (W3-G2.10). Staff record cash, check,
 * or other tender against a booking; owners and finance read the month's
 * reconciliation with its control total, TideGrid's fee invoices, disputes
 * on card payments, and provider readings that disagree with a pending
 * payment.
 *
 * The primitives below mirror the private helpers in index.ts, which this
 * module cannot import without a cycle.
 */

const Uuid = z.uuid();
const Instant = z.iso.datetime({ offset: true });
const Cents = z.number().int().describe("Integer US cents");

// biome-ignore lint/suspicious/noControlCharactersInRegex: the pattern exists to reject them.
const noControl = /^[^\u0000-\u001f\u007f]*$/;

export const ExternalSettlementRequest = z.object({
  kind: z
    .enum(["payment", "refund"])
    .describe(
      "payment: money the guest paid outside the card flow. refund: money paid back outside it (owners only)",
    ),
  tender: z.enum(["cash", "check", "other"]),
  amount: Cents.min(1).max(100_000_000),
  reason: z
    .string()
    .trim()
    .min(1)
    .max(500)
    .regex(noControl, "Control characters are not allowed")
    .describe("Why; kept on the record and in the audit history"),
  tenderReference: z
    .string()
    .trim()
    .min(1)
    .max(100)
    .regex(noControl, "Control characters are not allowed")
    .optional()
    .describe("A check or receipt number, when there is one"),
});
export type ExternalSettlementRequest = z.infer<typeof ExternalSettlementRequest>;

export const ExternalSettlement = z.object({
  id: Uuid,
  kind: z.enum(["payment", "refund"]),
  tender: z.enum(["cash", "check", "other"]),
  amount: Cents,
  reason: z
    .string()
    .nullable()
    .describe(
      "Why it was recorded. Null for a role that does not read bookings (masked support): free text may name the guest",
    ),
  tenderReference: z
    .string()
    .nullable()
    .describe(
      "A check or receipt number. Null when there is none, and for a role that does not read bookings",
    ),
  eligibleAmount: Cents.nullable().describe(
    "For a refund: the eligible booking value it returned, which leaves TideGrid's fee base",
  ),
  feeAmount: Cents.nullable().describe("For a refund: TideGrid's fee reversed, zero or negative"),
  recordedAt: Instant,
  recordedBy: z.string().nullable().describe("The staff member's user id"),
});
export type ExternalSettlement = z.infer<typeof ExternalSettlement>;

export const ExternalSettlementsResponse = z.object({
  settlements: z.array(ExternalSettlement).describe("Oldest first"),
  refundable: Cents.describe(
    "What a refund may still return: the lower of the money in and what the booking cost, less refunds so far",
  ),
});
export type ExternalSettlementsResponse = z.infer<typeof ExternalSettlementsResponse>;

export const ExternalSettlementResponse = z.object({
  settlement: ExternalSettlement,
  refundable: Cents,
});
export type ExternalSettlementResponse = z.infer<typeof ExternalSettlementResponse>;

const DisputeStatus = z
  .enum(["needs_response", "under_review", "won", "lost", "closed"])
  .describe(
    "needs_response and under_review are open. won, lost, and closed (an inquiry that never became a chargeback) are final",
  );

export const PaymentDispute = z.object({
  id: Uuid,
  status: DisputeStatus,
  open: z.boolean(),
  amount: Cents.describe("The disputed amount"),
  reason: z.string().describe("The card network's reason code, as the provider reports it"),
  openedAt: Instant,
  updatedAt: Instant,
  closedAt: Instant.nullable(),
  payment: z.object({ id: Uuid, amount: Cents }),
  booking: z.object({ id: Uuid, reference: BookingReference }).nullable(),
});
export type PaymentDispute = z.infer<typeof PaymentDispute>;

export const PaymentDisputesResponse = z.object({ disputes: z.array(PaymentDispute) });
export type PaymentDisputesResponse = z.infer<typeof PaymentDisputesResponse>;

export const PaymentReconciliationException = z.object({
  id: Uuid,
  reason: z
    .enum([
      "succeeded_without_event",
      "failed_without_event",
      "missing_at_provider",
      "amount_mismatch",
    ])
    .describe(
      "What the payment provider said about a payment TideGrid still holds as pending, past its checkout's hold: it was paid, it will never be paid, it does not exist, or its amount differs. Nothing was changed: only the provider's verified event confirms or fails a payment",
    ),
  providerStatus: z.string().nullable(),
  providerAmount: Cents.nullable(),
  raisedAt: Instant,
  open: z.boolean().describe("Still pending: no verified event has settled the payment"),
  payment: z.object({
    id: Uuid,
    state: z.string(),
    amount: Cents,
    checkedAt: Instant.nullable(),
  }),
  checkoutSessionId: Uuid,
});
export type PaymentReconciliationException = z.infer<typeof PaymentReconciliationException>;

export const PaymentReconciliationExceptionsResponse = z.object({
  exceptions: z.array(PaymentReconciliationException),
});
export type PaymentReconciliationExceptionsResponse = z.infer<
  typeof PaymentReconciliationExceptionsResponse
>;

export const ReconciliationQuery = z.object({
  month: z
    .string()
    .regex(/^2\d{3}-(0[1-9]|1[0-2])$/)
    .describe("YYYY-MM, in the billing plan's time zone (UTC without one)"),
});
export type ReconciliationQuery = z.infer<typeof ReconciliationQuery>;

const ReconciliationFigures = {
  assessedValue: Cents.describe("Eligible value of the bookings that closed this month"),
  refundedValue: Cents.describe("Eligible value refunded this month, by card or externally"),
  externalPaid: Cents,
  externalRefunded: Cents,
  feeAmount: Cents.describe("TideGrid's fee entries this month: assessments less reversals"),
};

export const ReconciliationReportResponse = z.object({
  month: z.string(),
  timeZone: z.string(),
  rows: z.array(
    z.object({
      bookingId: Uuid,
      reference: BookingReference,
      state: z.string(),
      ...ReconciliationFigures,
    }),
  ),
  totals: z.object({
    ...ReconciliationFigures,
    netManagedValue: Cents.describe("assessedValue less refundedValue"),
  }),
  ledgerFeeTotal: Cents.describe("The fee ledgers' own total for the month, summed apart"),
  controlTotalsMatch: z.boolean().describe("The rows add up to the ledger"),
  receivedShareBp: z
    .number()
    .int()
    .describe(
      "Of the bookings that closed this month, the share of their value received by card or recorded externally, in basis points",
    ),
  shortBookings: z.number().int().describe("Closed bookings with less received than they cost"),
  meetsTarget: z.boolean().describe("receivedShareBp is at least 9,800 (98%)"),
});
export type ReconciliationReportResponse = z.infer<typeof ReconciliationReportResponse>;

export const FeeInvoice = z.object({
  id: Uuid,
  month: z.string().describe("YYYY-MM, in the billing plan's time zone"),
  contractMonth: z.number().int().min(1).max(12),
  subscriptionAmount: Cents,
  variableAmount: Cents.describe("The month's fee ledger total; negative after large refunds"),
  carriedIn: Cents.describe("A negative balance from earlier months, zero or less"),
  variableBilled: Cents,
  carriedOut: Cents,
  trueUpAmount: Cents.describe("The annual minimum's shortfall, in the 12th contract month only"),
  totalAmount: Cents,
  state: z.literal("draft").describe("Not sent: sending waits on TideGrid's billing tool"),
  issuedAt: Instant,
});
export type FeeInvoice = z.infer<typeof FeeInvoice>;

export const FeeInvoicesResponse = z.object({
  invoices: z.array(FeeInvoice).describe("Newest month first"),
});
export type FeeInvoicesResponse = z.infer<typeof FeeInvoicesResponse>;
