import { z } from "zod";
import { BookingReference } from "./bookings.ts";
import { BookingSource } from "./checkout.ts";

/**
 * Money movements for a date range (W3-G2.12-rest): every entry in the money
 * ledgers on the operator's business dates, with control totals that match
 * the ledgers. Every role that holds `payments.read` (owners, booking staff,
 * and finance) reads the totals and exports the entries; neither carries a
 * guest's name or email, so every role gets the same columns. Money is
 * integer US cents.
 */

const Uuid = z.uuid();
const Instant = z.iso.datetime({ offset: true });
const Cents = z.number().int().describe("Integer US cents");
const SignedCents = z.number().int().describe("Integer US cents, negative for a reduction");
const QueryDate = z.iso
  .date()
  .refine((value) => !value.startsWith("0000-"), "There is no year 0")
  .describe("The operator's business date, YYYY-MM-DD");

export const MoneyReportQuery = z.object({
  from: QueryDate.describe("First business date, inclusive"),
  to: QueryDate.describe("Last business date, inclusive; at most 91 days after from"),
});
export type MoneyReportQuery = z.infer<typeof MoneyReportQuery>;

export const MoneyEntryKind = z
  .enum([
    "card_payment",
    "balance_payment",
    "external_payment",
    "card_refund",
    "external_refund",
    "dispute_lost",
    "credit_issued",
    "credit_used",
    "credit_reinstated",
    "credit_adjusted",
    "fee_assessed",
    "fee_reversed",
  ])
  .describe(
    "card_payment and balance_payment: a card payment that succeeded. external_payment and external_refund: cash, check, or other money staff recorded. card_refund: a card refund that succeeded. dispute_lost: a card dispute the operator lost. credit_*: an entry in the booking credit ledger. fee_assessed and fee_reversed: TideGrid's fee and a card refund's reversal of it",
  );
export type MoneyEntryKind = z.infer<typeof MoneyEntryKind>;

const MoneyFigures = {
  moneyIn: Cents.describe("Money received"),
  moneyOut: Cents.describe("Money returned or taken back, as a positive amount"),
  credit: SignedCents.describe(
    "Booking credit's change: issued and reinstated add, used subtracts",
  ),
  fee: SignedCents.describe("TideGrid's fee: an assessment adds, a reversal subtracts"),
};

export const MoneyKindTotals = z.object({
  kind: MoneyEntryKind,
  count: z.number().int().min(0),
  ...MoneyFigures,
});
export type MoneyKindTotals = z.infer<typeof MoneyKindTotals>;

export const MoneyReportResponse = z.object({
  from: z.iso.date(),
  to: z.iso.date(),
  timeZone: z
    .string()
    .describe(
      "The zone business dates are counted in: the billing plan's, else the one zone all active locations share, else UTC",
    ),
  generatedAt: Instant.describe("When the figures were read"),
  currency: z.literal("USD"),
  totals: z
    .object({
      entries: z.number().int().min(0),
      ...MoneyFigures,
      netMoney: SignedCents.describe("moneyIn - moneyOut"),
    })
    .describe("The range's control totals, which the CSV export's last row repeats"),
  byKind: z
    .array(MoneyKindTotals)
    .describe("Every kind, in a fixed order, summed from the entries"),
  ledgerFeeTotal: SignedCents.describe(
    "TideGrid's fee for the range as the monthly invoice computes it",
  ),
  controlTotalsMatch: z
    .boolean()
    .describe(
      "True when every kind's entries add up to a separate count and sum of its ledger in the same statement, and the fee to the monthly invoice's figure: the export is whole. It does not tie money to orders",
    ),
});
export type MoneyReportResponse = z.infer<typeof MoneyReportResponse>;

/** One entry, as the JSON form of a row; the CSV carries the same fields. */
export const MoneyEntry = z.object({
  entryId: Uuid,
  kind: MoneyEntryKind,
  at: Instant,
  businessDate: z.iso.date(),
  booking: z
    .object({ bookingId: Uuid, reference: BookingReference, source: BookingSource })
    .nullable(),
  tender: z.enum(["cash", "check", "other"]).nullable(),
  reference: z.string().nullable(),
  ...MoneyFigures,
});
export type MoneyEntry = z.infer<typeof MoneyEntry>;

/**
 * The money export, column by column. Stable: positions never change, and a
 * later column is only ever appended. Operator, From, To, Time zone, and
 * Generated at repeat on every row so a row pasted elsewhere keeps them.
 * Entries is 1 on an entry's row and the count on the total row. The
 * Reference column is the provider's id (masked for TideGrid support), or a
 * check or receipt number staff typed, which only roles that see guests
 * receive: for the others it is blank.
 */
export const moneyExportColumns = [
  "Row",
  "Operator",
  "From",
  "To",
  "Time zone",
  "Business date",
  "At (UTC)",
  "Kind",
  "Booking reference",
  "Source",
  "Tender",
  "Reference",
  "Money in",
  "Money out",
  "Credit",
  "TideGrid fee",
  "Currency",
  "Generated at (UTC)",
  "Entries",
] as const;
