import { z } from "zod";

/**
 * Pricing, policy, and quote contracts (G2.5). Money is integer US cents.
 * Tax rates are parts per million (70000 is 7%); discounts and refunds are
 * basis points (1000 is 10%). The server computes every amount; clients only
 * display them. The primitives below mirror the private helpers in index.ts
 * and catalog.ts, which this module cannot import without a cycle.
 */

const Uuid = z.uuid();
const Instant = z.iso.datetime({ offset: true });
const LocalDate = z.iso.date().describe("Local calendar date, YYYY-MM-DD");
const LocalTime = z
  .string()
  .regex(/^([01]\d|2[0-3]):[0-5]\d$/)
  .describe("Local wall-clock time, HH:MM, 24-hour");
const OffsetDateTime = z.iso
  .datetime({ offset: true, local: false })
  .describe("The same instant with the zone's offset, for display");
const ProductKind = z.enum(["shared_seat", "private_charter"]);
const Cents = z.number().int().describe("Integer US cents");
const Name = z.string().min(1);

export const Currency = z.literal("USD");

/** Operator-defined, stable across price list versions: `adult`, `snorkel_gear`. */
export const ItemCode = z
  .string()
  .regex(/^[a-z][a-z0-9_]{0,31}$/)
  .describe("Ticket type, add-on, or fee code from the trip's offer");

/** What a guest types. Compared case-insensitively after trimming. */
export const PromotionCodeInput = z
  .string()
  .trim()
  .regex(/^[A-Za-z0-9][A-Za-z0-9_-]{2,31}$/)
  .describe("Promotion code; case does not matter");

export const ChargeBasis = z
  .enum(["per_booking", "per_participant"])
  .describe(
    "per_booking: charged or limited once per booking. per_participant: once per participant, or up to the limit for each participant",
  );
export type ChargeBasis = z.infer<typeof ChargeBasis>;

export const PolicyRemedy = z
  .enum(["full_refund", "percent_refund", "credit", "none"])
  .describe("credit is a named-customer booking credit for the amount paid");
export type PolicyRemedy = z.infer<typeof PolicyRemedy>;

export const PolicyOutcome = z.object({
  remedy: PolicyRemedy,
  refundBp: z
    .number()
    .int()
    .min(1)
    .max(9999)
    .nullable()
    .describe("Basis points refunded; present only for percent_refund"),
});
export type PolicyOutcome = z.infer<typeof PolicyOutcome>;

export const PolicyTerms = z
  .object({
    version: z.number().int().min(1),
    changeCutoffMinutes: z.number().int().min(0),
    changeCutoffAt: Instant.describe(
      "Trip start minus the cutoff. A guest cancellation or reschedule before this instant gets beforeCutoff; at or after it, afterCutoff",
    ),
    beforeCutoff: PolicyOutcome,
    afterCutoff: PolicyOutcome,
    noShow: PolicyOutcome,
    text: z.object({
      cancellation: z.string(),
      reschedule: z.string(),
      noShow: z.string(),
      operatorCancellation: z.string(),
      weather: z.string(),
    }),
  })
  .describe("The product's policy version in force, which the guest accepts before paying");
export type PolicyTerms = z.infer<typeof PolicyTerms>;

const TripSnapshot = z.object({
  timeZone: z.string(),
  localDate: LocalDate,
  localStartTime: LocalTime,
  startsAt: Instant,
  startsAtLocal: OffsetDateTime,
});

// Offer -----------------------------------------------------------------------------

export const PublicTripParams = z.object({
  tripId: z.string().describe("Trip UUID; anything else answers 404"),
});

export const OfferTicket = z.object({
  code: ItemCode,
  name: Name,
  unitAmount: Cents,
  taxable: z.boolean(),
});

export const OfferCharter = z.object({
  name: Name,
  amount: Cents.describe("The whole boat, whatever the party size"),
  taxable: z.boolean(),
});

export const OfferAddOn = z.object({
  code: ItemCode,
  name: Name,
  unitAmount: Cents,
  quantityRule: ChargeBasis,
  maxQuantity: z
    .number()
    .int()
    .min(1)
    .describe("Per booking, or per participant when quantityRule is per_participant"),
  taxable: z.boolean(),
});

export const OfferFee = z.object({
  code: ItemCode,
  name: Name,
  unitAmount: Cents,
  basis: ChargeBasis,
  taxable: z.boolean(),
});

export const OfferTaxRate = z.object({
  name: Name,
  ratePpm: z.number().int().min(1).describe("Parts per million: 70000 is 7%"),
  inclusive: z.boolean().describe("Included in prices rather than added to them"),
});

export const TripOffer = z
  .object({
    tripId: Uuid,
    product: z.object({
      id: Uuid,
      name: z.string(),
      kind: ProductKind,
      minPartySize: z.number().int(),
      maxPartySize: z.number().int(),
    }),
    trip: TripSnapshot,
    currency: Currency,
    priceListVersion: z.number().int().min(1),
    tickets: z.array(OfferTicket).describe("Ticket types; empty for a private charter"),
    charter: OfferCharter.nullable().describe("The charter price; null for shared seats"),
    addOns: z.array(OfferAddOn).describe("Paid add-ons offered on this trip's date"),
    fees: z.array(OfferFee).describe("Mandatory fees added to every booking"),
    taxes: z.array(OfferTaxRate),
    policy: PolicyTerms,
  })
  .describe("What the operator sells for one bookable trip, under its current versions");
export type TripOffer = z.infer<typeof TripOffer>;

export const TripOfferResponse = z.object({ offer: TripOffer });
export type TripOfferResponse = z.infer<typeof TripOfferResponse>;

// Quote request -----------------------------------------------------------------------

export const QuotePartyRequest = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("tickets"),
    tickets: z
      .array(z.object({ code: ItemCode, quantity: z.number().int().min(1).max(500) }))
      .min(1)
      .max(20)
      .describe("Shared seats: one entry per ticket type; each ticket is one participant"),
  }),
  z.object({
    kind: z.literal("charter"),
    guests: z
      .number()
      .int()
      .min(1)
      .max(500)
      .describe("Private charter: participants aboard; the charter price does not change"),
  }),
]);
export type QuotePartyRequest = z.infer<typeof QuotePartyRequest>;

export const QuoteCreateRequest = z.object({
  tripId: Uuid,
  party: QuotePartyRequest,
  addOns: z
    .array(z.object({ code: ItemCode, quantity: z.number().int().min(1).max(50000) }))
    .max(50)
    .default([]),
  promotionCode: PromotionCodeInput.optional(),
});
export type QuoteCreateRequest = z.infer<typeof QuoteCreateRequest>;

/**
 * Why a quote could not be priced. The error code is the first problem; the
 * message lists them all. promotion_not_applicable covers unknown, retired,
 * not yet valid, expired, and ineligible codes alike.
 */
export const QuoteProblemCode = z.enum([
  "pricing_unavailable",
  "party_kind_mismatch",
  "invalid_quantity",
  "unknown_ticket_type",
  "duplicate_ticket_type",
  "party_size_out_of_range",
  "insufficient_capacity",
  "unknown_add_on",
  "duplicate_add_on",
  "add_on_unavailable",
  "add_on_quantity_exceeded",
  "promotion_not_applicable",
  "quote_amount_too_large",
]);
export type QuoteProblemCode = z.infer<typeof QuoteProblemCode>;

// Quote ---------------------------------------------------------------------------------

export const QuoteParams = z.object({
  quoteId: z.string().describe("Quote UUID; anything else answers 404"),
});

export const QuoteLineTax = z.object({
  taxRateId: Uuid,
  name: Name,
  ratePpm: z.number().int(),
  inclusive: z.boolean(),
  taxableAmount: Cents.describe("Pre-tax amount of this line the rate applies to"),
  amount: Cents,
});

export const QuoteLine = z.object({
  lineNo: z.number().int().min(1),
  kind: z.enum(["ticket", "charter", "add_on", "fee", "discount"]),
  code: z.string().describe("Ticket, add-on, or fee code; charter; or the promotion code"),
  name: z.string(),
  basis: ChargeBasis.nullable().describe("Fees and add-ons only"),
  quantity: z.number().int().min(1),
  unitAmount: Cents,
  amount: Cents.describe("quantity times unitAmount; negative on the discount line"),
  discountAmount: Cents.describe("This trip-price line's share of the discount"),
  taxable: z.boolean(),
  taxes: z.array(QuoteLineTax),
});
export type QuoteLine = z.infer<typeof QuoteLine>;

export const QuoteTax = z.object({
  taxRateId: Uuid,
  version: z.number().int().min(1),
  name: Name,
  ratePpm: z.number().int(),
  inclusive: z.boolean(),
  taxableAmount: Cents,
  amount: Cents,
});
export type QuoteTax = z.infer<typeof QuoteTax>;

export const QuotePromotion = z.object({
  code: z.string(),
  version: z.number().int().min(1),
  discountKind: z.enum(["fixed_amount", "percent"]),
  amountOff: Cents.nullable(),
  percentOffBp: z.number().int().nullable(),
});

export const QuoteTotals = z
  .object({
    subtotal: Cents.describe("Trip price and add-ons, before the discount"),
    discount: Cents.describe("Promotion discount, off the trip price only"),
    fees: Cents.describe("Mandatory fees"),
    tax: Cents.describe("Taxes added on top of prices"),
    includedTax: Cents.describe("Taxes already inside prices; informational"),
    total: Cents.describe("subtotal - discount + fees + tax"),
    amountDueNow: Cents.describe("What checkout charges for this quote"),
  })
  .describe("Every total is the sum of the lines above it");

export const Quote = z
  .object({
    quoteId: Uuid,
    tripId: Uuid,
    product: z.object({ id: Uuid, name: z.string(), kind: ProductKind }),
    trip: TripSnapshot,
    partySize: z.number().int().min(1),
    currency: Currency,
    priceListVersion: z.number().int().min(1),
    lines: z.array(QuoteLine),
    taxes: z.array(QuoteTax).describe("Per rate, summed over the lines"),
    promotion: QuotePromotion.nullable(),
    totals: QuoteTotals,
    policy: PolicyTerms,
    quotedAt: Instant,
    expiresAt: Instant.describe("Checkout must start before this instant or ask for a new quote"),
  })
  .describe(
    "An immutable priced quote. Later price, tax, promotion, or policy changes never alter it.",
  );
export type Quote = z.infer<typeof Quote>;

export const QuoteResponse = z.object({ quote: Quote });
export type QuoteResponse = z.infer<typeof QuoteResponse>;
