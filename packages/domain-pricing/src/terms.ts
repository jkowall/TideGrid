/**
 * Commercial terms as the pricing computation sees them, loaded from the
 * current versions (load.ts) or built by tests. Money is integer cents; tax
 * rates are parts per million; discounts and refunds are basis points; local
 * dates are "YYYY-MM-DD" in the trip's zone.
 */

export type ProductKind = "shared_seat" | "private_charter";
export type ChargeBasis = "per_booking" | "per_participant";
export type PolicyRemedy = "full_refund" | "percent_refund" | "credit" | "none";

interface PricedItem {
  code: string;
  name: string;
  unitAmount: number;
  taxable: boolean;
}

/** One ticket type of a shared-seat product. Each ticket is one participant and one seat. */
export type TicketItem = PricedItem;

/** A private charter's price for the whole boat. */
export interface CharterItem {
  name: string;
  amount: number;
  taxable: boolean;
}

/** A mandatory fee, charged once per booking or once per participant. */
export interface FeeItem extends PricedItem {
  basis: ChargeBasis;
}

/**
 * An optional paid add-on. A per-booking add-on allows up to `maxQuantity` on
 * the booking; a per-participant add-on allows up to `maxQuantity` for each
 * participant. It is offered for trips whose local date falls in its
 * inclusive range; a missing bound is open.
 */
export interface AddOnItem extends PricedItem {
  quantityRule: ChargeBasis;
  maxQuantity: number;
  availableFrom: string | null;
  availableUntil: string | null;
}

/** A product's price list version. Item arrays are in display order. */
export interface PriceList {
  productId: string;
  version: number;
  productKind: ProductKind;
  tickets: readonly TicketItem[];
  charter: CharterItem | null;
  fees: readonly FeeItem[];
  addOns: readonly AddOnItem[];
}

/** The current version of one active tax rate. */
export interface TaxRate {
  taxRateId: string;
  version: number;
  name: string;
  ratePpm: number;
  /** Prices already include it; otherwise it is added on top. */
  inclusive: boolean;
}

export type Discount =
  | { kind: "fixed_amount"; amountOff: number }
  | { kind: "percent"; percentOffBp: number };

/** The current version of the promotion a guest's code names. */
export interface PromotionTerms {
  promotionId: string;
  version: number;
  /** Upper case. */
  code: string;
  active: boolean;
  discount: Discount;
  /** Redeemable while the quote instant is in [startsAtMs, endsAtMs). */
  startsAtMs: number;
  endsAtMs: number;
  appliesToAllProducts: boolean;
  productIds: readonly string[];
}

export interface PolicyOutcomeTerms {
  remedy: PolicyRemedy;
  /** Basis points refunded; present only for percent_refund. */
  refundBp: number | null;
}

/** A product's policy version. */
export interface PolicyVersion {
  productId: string;
  version: number;
  /** Elapsed minutes before departure. */
  changeCutoffMinutes: number;
  beforeCutoff: PolicyOutcomeTerms;
  afterCutoff: PolicyOutcomeTerms;
  noShow: PolicyOutcomeTerms;
  text: {
    cancellation: string;
    reschedule: string;
    noShow: string;
    operatorCancellation: string;
    weather: string;
  };
}
