/**
 * Private-charter deposits (W3-G2.8, docs/v2/02 "Private-charter deposit and
 * balance"). A charter's price list version says how its bookings pay: in
 * full, a fixed deposit, or a percentage of the booking's total, with one
 * balance due a whole number of days before the trip starts. The quote takes
 * the deposit its terms give at the quote instant, and the database checks it
 * again (0033, `app.deposit_for`), so the two must agree to the cent.
 *
 * A booking pays in full when its terms take no deposit, when the deposit
 * would be the whole total or nothing, or when the due date has already come
 * at the quote instant.
 */
import { mulDivHalfUp } from "./money.ts";

export type DepositTerms =
  | { kind: "none" }
  | { kind: "fixed"; amount: number; balanceDueDays: number }
  | { kind: "percent"; bp: number; balanceDueDays: number };

export const NO_DEPOSIT: DepositTerms = { kind: "none" };

/** What a quote charges now and later: null when the booking pays in full. */
export interface QuoteDeposit {
  /** Charged at checkout. */
  amount: number;
  /** What is left after it. */
  balanceAmount: number;
  /** When the balance is due, as an ISO instant. */
  balanceDueAt: string;
}

const DAY_MS = 86_400_000;

/**
 * The deposit the terms give for a total, a trip start, and a quote instant.
 * The due instant is the trip start less whole days of elapsed time (24 hours
 * each), as the database computes it.
 */
export function depositFor(
  terms: DepositTerms,
  total: number,
  tripStartsAtMs: number,
  quotedAtMs: number,
): QuoteDeposit | null {
  if (terms.kind === "none") return null;
  const amount = terms.kind === "fixed" ? terms.amount : mulDivHalfUp(total, terms.bp, 10_000);
  const dueMs = tripStartsAtMs - terms.balanceDueDays * DAY_MS;
  if (amount < 1 || amount >= total || dueMs <= quotedAtMs) return null;
  return {
    amount,
    balanceAmount: total - amount,
    balanceDueAt: new Date(dueMs).toISOString(),
  };
}

/** True when the terms are well formed; a fixed amount at most $100,000, a percentage 0.01% to 99.99%. */
export function validDepositTerms(terms: DepositTerms): boolean {
  if (terms.kind === "none") return true;
  const days =
    Number.isSafeInteger(terms.balanceDueDays) &&
    terms.balanceDueDays >= 1 &&
    terms.balanceDueDays <= 365;
  if (!days) return false;
  if (terms.kind === "fixed") {
    return Number.isSafeInteger(terms.amount) && terms.amount >= 1 && terms.amount <= 10_000_000;
  }
  return Number.isSafeInteger(terms.bp) && terms.bp >= 1 && terms.bp <= 9_999;
}
