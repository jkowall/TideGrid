import type { ChargeBasis, Discount, PolicyRemedy, ProductKind } from "./terms.ts";

/**
 * Pure validation of the terms an operator configures. The database checks
 * the same bounds; these name the problem instead of failing an insert.
 */

export type TermsProblem =
  | "invalid_code"
  | "duplicate_code"
  | "invalid_name"
  | "invalid_amount"
  | "invalid_basis"
  | "invalid_max_quantity"
  | "invalid_date_range"
  | "too_many_items"
  | "tickets_required"
  | "tickets_not_allowed"
  | "charter_required"
  | "charter_not_allowed"
  | "invalid_cutoff"
  | "invalid_remedy"
  | "invalid_text"
  | "invalid_rate"
  | "invalid_discount"
  | "invalid_window"
  | "invalid_products"
  | "invalid_reason";

const ITEM_CODE = /^[a-z][a-z0-9_]{0,31}$/;
const PROMOTION_CODE = /^[A-Z0-9][A-Z0-9_-]{2,31}$/;
const LOCAL_DATE = /^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/;
// C0, DEL, and C1: what PostgreSQL's [[:cntrl:]] refuses in names.
// biome-ignore lint/suspicious/noControlCharactersInRegex: the pattern exists to reject them.
const CONTROL = /[\u0000-\u001f\u007f-\u009f]/;
// biome-ignore lint/suspicious/noControlCharactersInRegex: newlines are allowed in policy text.
const CONTROL_EXCEPT_NEWLINE = /[\u0000-\u0009\u000b-\u001f\u007f]/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

/** Most cents one priced item may cost: $100,000. */
export const MAX_UNIT_AMOUNT = 10_000_000;
export const MAX_TICKET_TYPES = 20;
export const MAX_FEES = 20;
export const MAX_ADD_ONS = 30;
/** Thirty days, in minutes. */
export const MAX_CHANGE_CUTOFF_MINUTES = 43_200;
/** 50%, in parts per million. */
export const MAX_TAX_RATE_PPM = 500_000;

export const isItemCode = (code: string): boolean => ITEM_CODE.test(code);
export const isPromotionCode = (code: string): boolean => PROMOTION_CODE.test(code);

export function isName(name: string): boolean {
  return name.trim().length > 0 && name.length <= 80 && !CONTROL.test(name);
}

export function isReason(reason: string): boolean {
  return reason.trim().length > 0 && reason.length <= 500 && !CONTROL.test(reason);
}

function isText(text: string): boolean {
  return text.trim().length > 0 && text.length <= 2000 && !CONTROL_EXCEPT_NEWLINE.test(text);
}

function isAmount(amount: number, min = 0): boolean {
  return Number.isSafeInteger(amount) && amount >= min && amount <= MAX_UNIT_AMOUNT;
}

/** A real calendar date in "YYYY-MM-DD". */
export function isLocalDate(value: string): boolean {
  if (!LOCAL_DATE.test(value)) return false;
  const date = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

const isBasis = (basis: string): basis is ChargeBasis =>
  basis === "per_booking" || basis === "per_participant";

export interface TicketInput {
  code: string;
  name: string;
  unitAmount: number;
  taxable: boolean;
}

export interface CharterInput {
  name: string;
  amount: number;
  taxable: boolean;
}

export interface FeeInput {
  code: string;
  name: string;
  unitAmount: number;
  basis: ChargeBasis;
  taxable: boolean;
}

export interface AddOnInput {
  code: string;
  name: string;
  unitAmount: number;
  quantityRule: ChargeBasis;
  maxQuantity: number;
  taxable: boolean;
  availableFrom?: string | null;
  availableUntil?: string | null;
}

export interface PriceListInput {
  tickets?: readonly TicketInput[];
  charter?: CharterInput | null;
  fees?: readonly FeeInput[];
  addOns?: readonly AddOnInput[];
}

function pushOnce(problems: TermsProblem[], problem: TermsProblem): void {
  if (!problems.includes(problem)) problems.push(problem);
}

function checkCodes(problems: TermsProblem[], codes: readonly string[]): void {
  if (codes.some((c) => !isItemCode(c))) pushOnce(problems, "invalid_code");
  if (new Set(codes).size !== codes.length) pushOnce(problems, "duplicate_code");
}

/** Problems with a price list for a product of this kind; empty when it is valid. */
export function validatePriceList(kind: ProductKind, input: PriceListInput): TermsProblem[] {
  const problems: TermsProblem[] = [];
  const tickets = input.tickets ?? [];
  const fees = input.fees ?? [];
  const addOns = input.addOns ?? [];
  if (kind === "shared_seat") {
    if (tickets.length === 0) problems.push("tickets_required");
    if (input.charter) problems.push("charter_not_allowed");
  } else {
    if (!input.charter) problems.push("charter_required");
    if (tickets.length > 0) problems.push("tickets_not_allowed");
  }
  if (tickets.length > MAX_TICKET_TYPES || fees.length > MAX_FEES || addOns.length > MAX_ADD_ONS) {
    problems.push("too_many_items");
  }
  checkCodes(
    problems,
    tickets.map((t) => t.code),
  );
  checkCodes(
    problems,
    fees.map((f) => f.code),
  );
  checkCodes(
    problems,
    addOns.map((a) => a.code),
  );
  const names = [
    ...tickets.map((t) => t.name),
    ...fees.map((f) => f.name),
    ...addOns.map((a) => a.name),
    ...(input.charter ? [input.charter.name] : []),
  ];
  if (names.some((n) => !isName(n))) pushOnce(problems, "invalid_name");
  if (
    tickets.some((t) => !isAmount(t.unitAmount)) ||
    addOns.some((a) => !isAmount(a.unitAmount)) ||
    fees.some((f) => !isAmount(f.unitAmount, 1)) ||
    (input.charter && !isAmount(input.charter.amount))
  ) {
    pushOnce(problems, "invalid_amount");
  }
  if (fees.some((f) => !isBasis(f.basis)) || addOns.some((a) => !isBasis(a.quantityRule))) {
    pushOnce(problems, "invalid_basis");
  }
  if (
    addOns.some(
      (a) => !Number.isSafeInteger(a.maxQuantity) || a.maxQuantity < 1 || a.maxQuantity > 100,
    )
  ) {
    pushOnce(problems, "invalid_max_quantity");
  }
  for (const a of addOns) {
    const from = a.availableFrom ?? null;
    const until = a.availableUntil ?? null;
    if (
      (from !== null && !isLocalDate(from)) ||
      (until !== null && !isLocalDate(until)) ||
      (from !== null && until !== null && until < from)
    ) {
      pushOnce(problems, "invalid_date_range");
    }
  }
  return problems;
}

export interface PolicyOutcomeInput {
  remedy: PolicyRemedy;
  refundBp?: number | null;
}

export interface PolicyInput {
  changeCutoffMinutes: number;
  beforeCutoff: PolicyOutcomeInput;
  afterCutoff: PolicyOutcomeInput;
  noShow: PolicyOutcomeInput;
  text: {
    cancellation: string;
    reschedule: string;
    noShow: string;
    operatorCancellation: string;
    weather: string;
  };
}

const remedies: readonly PolicyRemedy[] = ["full_refund", "percent_refund", "credit", "none"];

function isOutcome(outcome: PolicyOutcomeInput): boolean {
  if (!remedies.includes(outcome.remedy)) return false;
  const bp = outcome.refundBp ?? null;
  if (outcome.remedy === "percent_refund") {
    return bp !== null && Number.isSafeInteger(bp) && bp >= 1 && bp <= 9999;
  }
  return bp === null;
}

export function validatePolicy(input: PolicyInput): TermsProblem[] {
  const problems: TermsProblem[] = [];
  if (
    !Number.isSafeInteger(input.changeCutoffMinutes) ||
    input.changeCutoffMinutes < 0 ||
    input.changeCutoffMinutes > MAX_CHANGE_CUTOFF_MINUTES
  ) {
    problems.push("invalid_cutoff");
  }
  if (![input.beforeCutoff, input.afterCutoff, input.noShow].every(isOutcome)) {
    problems.push("invalid_remedy");
  }
  if (!Object.values(input.text).every(isText)) problems.push("invalid_text");
  return problems;
}

export interface TaxRateInput {
  name: string;
  ratePpm: number;
  inclusive: boolean;
}

export function validateTaxRate(input: TaxRateInput): TermsProblem[] {
  const problems: TermsProblem[] = [];
  if (!isName(input.name)) problems.push("invalid_name");
  if (
    !Number.isSafeInteger(input.ratePpm) ||
    input.ratePpm < 1 ||
    input.ratePpm > MAX_TAX_RATE_PPM
  ) {
    problems.push("invalid_rate");
  }
  return problems;
}

export type PromotionProducts = { all: true } | { productIds: readonly string[] };

export interface PromotionTermsInput {
  discount: Discount;
  startsAt: Date;
  endsAt: Date;
  products: PromotionProducts;
}

export function validatePromotionTerms(input: PromotionTermsInput): TermsProblem[] {
  const problems: TermsProblem[] = [];
  const d = input.discount;
  const discountOk =
    d.kind === "fixed_amount"
      ? isAmount(d.amountOff, 1)
      : d.kind === "percent" &&
        Number.isSafeInteger(d.percentOffBp) &&
        d.percentOffBp >= 1 &&
        d.percentOffBp <= 10_000;
  if (!discountOk) problems.push("invalid_discount");
  const starts = input.startsAt.getTime();
  const ends = input.endsAt.getTime();
  if (Number.isNaN(starts) || Number.isNaN(ends) || ends <= starts) problems.push("invalid_window");
  if (!("all" in input.products)) {
    const ids = input.products.productIds;
    if (
      ids.length === 0 ||
      ids.length > 100 ||
      ids.some((id) => !UUID.test(id)) ||
      new Set(ids).size !== ids.length
    ) {
      problems.push("invalid_products");
    }
  }
  return problems;
}
