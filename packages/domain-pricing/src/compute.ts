import type { QuoteProblemCode } from "@tidegrid/contracts";
import { allocateLargestRemainder, BASIS_POINTS, mulDivHalfUp, PPM } from "./money.ts";
import type {
  AddOnItem,
  ChargeBasis,
  Discount,
  PolicyVersion,
  PriceList,
  ProductKind,
  PromotionTerms,
  TaxRate,
} from "./terms.ts";

/**
 * The quote computation. Pure: the same input always prices the same way, and
 * nothing here reads a clock or a database.
 *
 * Rules, in order:
 *
 * 1. The price list must describe the trip's product and be complete, and the
 *    party must match the product's kind: tickets for shared seats, a guest
 *    count for a private charter.
 * 2. Party: each ticket type once, known, with a positive quantity. The party
 *    size (tickets, or guests aboard a charter) must be within the product's
 *    limits and the trip's remaining capacity.
 * 3. Add-ons: each once, known, offered on the trip's local date, and within
 *    its limit (per booking, or per participant times the party size).
 * 4. Promotion: a code must name an active promotion whose window contains
 *    the quote instant and which covers the product.
 * 5. Lines: tickets or the charter, then add-ons, then fees, each in price
 *    list order. A per-participant fee is charged once per participant.
 * 6. Discount: off the trip price only (ticket or charter lines), never off
 *    add-ons, fees, or tax. A percentage rounds half up; a fixed amount is
 *    capped at the trip price. It is allocated to the trip-price lines in
 *    proportion to their amounts by the largest remainder method.
 * 7. Tax: per taxable line, on the line's amount after its discount share.
 *    Every rate applies to the same pre-tax amount (no tax on tax). Inclusive
 *    rates are extracted from the price together, base = round(net ÷ (1 + sum
 *    of inclusive rates)), and the extracted tax is split across them by the
 *    largest remainder; exclusive rates are added, each round(base × rate).
 *    All rounding is half up, per line.
 * 8. Totals: subtotal is trip price and add-ons before the discount; total is
 *    subtotal − discount + fees + added tax. Included tax is reported only.
 *
 * Every problem in an independent area is reported. Checks that depend on an
 * invalid party size are skipped rather than reported as consequences.
 */

/** No line amount or total may exceed $1,000,000. */
export const MAX_QUOTE_AMOUNT = 100_000_000;
/** No single quantity may exceed this, whatever the limits say. */
const MAX_QUANTITY = 1_000_000;

export interface QuoteSubject {
  productId: string;
  productKind: ProductKind;
  /** The trip's local date, "YYYY-MM-DD". */
  localDate: string;
  minPartySize: number;
  maxPartySize: number;
  /** Seats left on a shared-seat trip, or the boat's guests while a charter is free. */
  capacityRemaining: number;
}

export type PartySelection =
  | { kind: "tickets"; tickets: readonly { code: string; quantity: number }[] }
  | { kind: "charter"; guests: number };

export interface QuoteSelection {
  party: PartySelection;
  addOns: readonly { code: string; quantity: number }[];
  /** As the guest typed it, or null. */
  promotionCode: string | null;
}

export interface QuoteInput {
  /** The quote instant; the promotion window is checked against it. */
  nowMs: number;
  subject: QuoteSubject;
  priceList: PriceList;
  /** Active rates, in display order. */
  taxRates: readonly TaxRate[];
  /** The promotion the entered code names, or null when there is none. */
  promotion: PromotionTerms | null;
  selection: QuoteSelection;
}

export type PromotionRejection =
  | "unknown"
  | "inactive"
  | "not_started"
  | "expired"
  | "product_ineligible";

export interface QuoteProblem {
  code: QuoteProblemCode;
  /** The ticket type or add-on code the problem is about, when there is one. */
  subject?: string;
  /** Why a promotion code did not apply. Logged and tested; the API shows one code. */
  reason?: PromotionRejection;
}

export interface LineTax {
  taxRateId: string;
  version: number;
  name: string;
  ratePpm: number;
  inclusive: boolean;
  /** The line's pre-tax amount the rate applies to. */
  taxableAmount: number;
  amount: number;
}

export type PricedLineKind = "ticket" | "charter" | "add_on" | "fee";

export interface PricedLine {
  lineNo: number;
  kind: PricedLineKind;
  code: string;
  name: string;
  basis: ChargeBasis | null;
  quantity: number;
  unitAmount: number;
  /** quantity × unitAmount. */
  amount: number;
  /** This trip-price line's share of the discount; zero on other lines. */
  discountAmount: number;
  taxable: boolean;
  /** One per tax rate, in rate order, on taxable lines; empty otherwise. */
  taxes: LineTax[];
}

export interface PricedDiscount {
  /** The discount line's number, after every other line. */
  lineNo: number;
  promotionId: string;
  version: number;
  code: string;
  discount: Discount;
  /** The trip price the discount was taken from. */
  eligibleAmount: number;
  /** Positive; the discount line carries it negated. */
  amount: number;
}

export interface TaxTotal {
  taxRateId: string;
  version: number;
  name: string;
  ratePpm: number;
  inclusive: boolean;
  taxableAmount: number;
  amount: number;
}

export interface QuoteTotals {
  subtotal: number;
  discount: number;
  fees: number;
  tax: number;
  includedTax: number;
  total: number;
}

export interface PricedQuote {
  partySize: number;
  lines: PricedLine[];
  discount: PricedDiscount | null;
  taxes: TaxTotal[];
  totals: QuoteTotals;
}

export type QuoteOutcome =
  | { kind: "priced"; quote: PricedQuote }
  | { kind: "rejected"; problems: QuoteProblem[] };

/** Promotion codes compare trimmed and upper case. */
export function normalizePromotionCode(code: string): string {
  return code.trim().toUpperCase();
}

/** Whether an add-on is offered for a trip on this local date. Bounds are inclusive. */
export function addOnAvailableOn(item: AddOnItem, localDate: string): boolean {
  if (item.availableFrom !== null && localDate < item.availableFrom) return false;
  if (item.availableUntil !== null && localDate > item.availableUntil) return false;
  return true;
}

/** Why a code does not apply, or null when it does. */
export function promotionRejection(
  promotion: PromotionTerms | null,
  enteredCode: string,
  productId: string,
  nowMs: number,
): PromotionRejection | null {
  if (!promotion || promotion.code !== normalizePromotionCode(enteredCode)) return "unknown";
  if (!promotion.active) return "inactive";
  if (nowMs < promotion.startsAtMs) return "not_started";
  if (nowMs >= promotion.endsAtMs) return "expired";
  if (!promotion.appliesToAllProducts && !promotion.productIds.includes(productId)) {
    return "product_ineligible";
  }
  return null;
}

/** The instant a guest's change moves from the before-cutoff to the after-cutoff remedy. */
export function changeCutoffAt(policy: PolicyVersion, tripStartsAtMs: number): Date {
  return new Date(tripStartsAtMs - policy.changeCutoffMinutes * 60_000);
}

function isCount(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 1 && value <= MAX_QUANTITY;
}

function checkTaxRates(rates: readonly TaxRate[]): void {
  const ids = new Set<string>();
  for (const r of rates) {
    if (!Number.isSafeInteger(r.ratePpm) || r.ratePpm < 1 || r.ratePpm > 500_000) {
      throw new RangeError(`tax rate ${r.taxRateId} has an invalid rate ${r.ratePpm}`);
    }
    if (ids.has(r.taxRateId)) throw new RangeError(`tax rate ${r.taxRateId} is listed twice`);
    ids.add(r.taxRateId);
  }
}

interface DraftLine {
  kind: PricedLineKind;
  code: string;
  name: string;
  basis: ChargeBasis | null;
  quantity: number;
  unitAmount: number;
  taxable: boolean;
}

/** Taxes on one line's net amount (after its discount share), in rate order. */
function taxLine(net: number, rates: readonly TaxRate[]): LineTax[] {
  const inclusive = rates.filter((r) => r.inclusive);
  let base = net;
  let included: number[] = [];
  if (inclusive.length > 0) {
    const sum = inclusive.reduce((acc, r) => acc + r.ratePpm, 0);
    base = mulDivHalfUp(net, PPM, PPM + sum);
    included = allocateLargestRemainder(
      net - base,
      inclusive.map((r) => r.ratePpm),
    );
  }
  let next = 0;
  return rates.map((r) => ({
    taxRateId: r.taxRateId,
    version: r.version,
    name: r.name,
    ratePpm: r.ratePpm,
    inclusive: r.inclusive,
    taxableAmount: base,
    amount: r.inclusive ? (included[next++] ?? 0) : mulDivHalfUp(base, r.ratePpm, PPM),
  }));
}

export function priceQuote(input: QuoteInput): QuoteOutcome {
  const { subject, priceList, selection } = input;
  checkTaxRates(input.taxRates);

  // 1. Structure.
  const complete =
    priceList.productId === subject.productId &&
    priceList.productKind === subject.productKind &&
    (subject.productKind === "shared_seat"
      ? priceList.tickets.length > 0 && priceList.charter === null
      : priceList.charter !== null && priceList.tickets.length === 0);
  if (!complete) return { kind: "rejected", problems: [{ code: "pricing_unavailable" }] };
  if ((selection.party.kind === "tickets") !== (subject.productKind === "shared_seat")) {
    return { kind: "rejected", problems: [{ code: "party_kind_mismatch" }] };
  }

  const problems: QuoteProblem[] = [];

  // 2. Party.
  const priceLines: DraftLine[] = [];
  let partySize = 0;
  let partyValid = true;
  if (selection.party.kind === "tickets") {
    const chosen = new Map<string, number>();
    const seen = new Set<string>();
    for (const t of selection.party.tickets) {
      if (seen.has(t.code)) {
        problems.push({ code: "duplicate_ticket_type", subject: t.code });
        partyValid = false;
        continue;
      }
      seen.add(t.code);
      if (!isCount(t.quantity)) {
        problems.push({ code: "invalid_quantity", subject: t.code });
        partyValid = false;
        continue;
      }
      if (!priceList.tickets.some((i) => i.code === t.code)) {
        problems.push({ code: "unknown_ticket_type", subject: t.code });
        partyValid = false;
        continue;
      }
      chosen.set(t.code, t.quantity);
      partySize += t.quantity;
    }
    if (chosen.size === 0 && partyValid) {
      problems.push({ code: "party_size_out_of_range" });
      partyValid = false;
    }
    for (const item of priceList.tickets) {
      const quantity = chosen.get(item.code);
      if (quantity === undefined) continue;
      priceLines.push({
        kind: "ticket",
        code: item.code,
        name: item.name,
        basis: null,
        quantity,
        unitAmount: item.unitAmount,
        taxable: item.taxable,
      });
    }
  } else {
    if (!isCount(selection.party.guests)) {
      problems.push({ code: "invalid_quantity", subject: "guests" });
      partyValid = false;
    } else {
      partySize = selection.party.guests;
    }
    const charter = priceList.charter;
    if (charter) {
      priceLines.push({
        kind: "charter",
        code: "charter",
        name: charter.name,
        basis: null,
        quantity: 1,
        unitAmount: charter.amount,
        taxable: charter.taxable,
      });
    }
  }
  if (partyValid) {
    if (partySize < subject.minPartySize || partySize > subject.maxPartySize) {
      problems.push({ code: "party_size_out_of_range" });
      partyValid = false;
    }
    if (partySize > subject.capacityRemaining) {
      problems.push({ code: "insufficient_capacity" });
      partyValid = false;
    }
  }

  // 3. Add-ons.
  const chosenAddOns = new Map<string, number>();
  const seenAddOns = new Set<string>();
  for (const a of selection.addOns) {
    if (seenAddOns.has(a.code)) {
      problems.push({ code: "duplicate_add_on", subject: a.code });
      continue;
    }
    seenAddOns.add(a.code);
    if (!isCount(a.quantity)) {
      problems.push({ code: "invalid_quantity", subject: a.code });
      continue;
    }
    const item = priceList.addOns.find((i) => i.code === a.code);
    if (!item) {
      problems.push({ code: "unknown_add_on", subject: a.code });
      continue;
    }
    if (!addOnAvailableOn(item, subject.localDate)) {
      problems.push({ code: "add_on_unavailable", subject: a.code });
      continue;
    }
    if (partyValid) {
      const limit =
        item.quantityRule === "per_participant" ? item.maxQuantity * partySize : item.maxQuantity;
      if (a.quantity > limit) {
        problems.push({ code: "add_on_quantity_exceeded", subject: a.code });
        continue;
      }
    }
    chosenAddOns.set(a.code, a.quantity);
  }

  // 4. Promotion.
  let promotion: PromotionTerms | null = null;
  if (selection.promotionCode !== null) {
    const reason = promotionRejection(
      input.promotion,
      selection.promotionCode,
      subject.productId,
      input.nowMs,
    );
    if (reason) problems.push({ code: "promotion_not_applicable", reason });
    else promotion = input.promotion;
  }

  if (problems.length > 0) return { kind: "rejected", problems };

  // 5. Lines.
  const drafts: DraftLine[] = [...priceLines];
  for (const item of priceList.addOns) {
    const quantity = chosenAddOns.get(item.code);
    if (quantity === undefined) continue;
    drafts.push({
      kind: "add_on",
      code: item.code,
      name: item.name,
      basis: item.quantityRule,
      quantity,
      unitAmount: item.unitAmount,
      taxable: item.taxable,
    });
  }
  for (const fee of priceList.fees) {
    drafts.push({
      kind: "fee",
      code: fee.code,
      name: fee.name,
      basis: fee.basis,
      quantity: fee.basis === "per_participant" ? partySize : 1,
      unitAmount: fee.unitAmount,
      taxable: fee.taxable,
    });
  }
  const lines: PricedLine[] = drafts.map((d, i) => ({
    ...d,
    lineNo: i + 1,
    amount: d.quantity * d.unitAmount,
    discountAmount: 0,
    taxes: [],
  }));
  if (lines.some((l) => l.amount > MAX_QUOTE_AMOUNT)) {
    return { kind: "rejected", problems: [{ code: "quote_amount_too_large" }] };
  }

  // 6. Discount, off the trip price only.
  const tripPriceLines = lines.filter((l) => l.kind === "ticket" || l.kind === "charter");
  const eligibleAmount = tripPriceLines.reduce((acc, l) => acc + l.amount, 0);
  let discount: PricedDiscount | null = null;
  if (promotion) {
    const amount =
      promotion.discount.kind === "percent"
        ? mulDivHalfUp(eligibleAmount, promotion.discount.percentOffBp, BASIS_POINTS)
        : Math.min(promotion.discount.amountOff, eligibleAmount);
    const shares = allocateLargestRemainder(
      amount,
      tripPriceLines.map((l) => l.amount),
    );
    tripPriceLines.forEach((l, i) => {
      l.discountAmount = shares[i] ?? 0;
    });
    discount = {
      lineNo: lines.length + 1,
      promotionId: promotion.promotionId,
      version: promotion.version,
      code: promotion.code,
      discount: promotion.discount,
      eligibleAmount,
      amount,
    };
  }

  // 7. Tax, per taxable line on its discounted amount.
  for (const line of lines) {
    if (line.taxable) line.taxes = taxLine(line.amount - line.discountAmount, input.taxRates);
  }
  const taxes: TaxTotal[] = [];
  for (const rate of input.taxRates) {
    const applied = lines.flatMap((l) => l.taxes.filter((t) => t.taxRateId === rate.taxRateId));
    if (applied.length === 0) continue;
    taxes.push({
      taxRateId: rate.taxRateId,
      version: rate.version,
      name: rate.name,
      ratePpm: rate.ratePpm,
      inclusive: rate.inclusive,
      taxableAmount: applied.reduce((acc, t) => acc + t.taxableAmount, 0),
      amount: applied.reduce((acc, t) => acc + t.amount, 0),
    });
  }

  // 8. Totals.
  const sum = (kinds: readonly PricedLineKind[]) =>
    lines.filter((l) => kinds.includes(l.kind)).reduce((acc, l) => acc + l.amount, 0);
  const subtotal = sum(["ticket", "charter", "add_on"]);
  const fees = sum(["fee"]);
  const tax = taxes.filter((t) => !t.inclusive).reduce((acc, t) => acc + t.amount, 0);
  const includedTax = taxes.filter((t) => t.inclusive).reduce((acc, t) => acc + t.amount, 0);
  const discountTotal = discount?.amount ?? 0;
  const total = subtotal - discountTotal + fees + tax;
  if ([subtotal, fees, tax, includedTax, total].some((v) => v > MAX_QUOTE_AMOUNT)) {
    return { kind: "rejected", problems: [{ code: "quote_amount_too_large" }] };
  }
  return {
    kind: "priced",
    quote: {
      partySize,
      lines,
      discount,
      taxes,
      totals: { subtotal, discount: discountTotal, fees, tax, includedTax, total },
    },
  };
}
