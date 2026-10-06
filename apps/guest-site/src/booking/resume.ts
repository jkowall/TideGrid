/**
 * What lets a reload resume an open checkout: its id, its quote's id, and the
 * checkout secret, in sessionStorage, for one checkout at a time. See the
 * README's "Secrets and personal data" for why.
 *
 * - sessionStorage belongs to this tab and is gone when the tab closes; it is
 *   never sent anywhere.
 * - One record, one checkout: a new checkout replaces it.
 * - Cleared as soon as the checkout reaches a final state, is canceled, or is
 *   left behind past its expiry.
 * - Never the booker's name or email, and never the payment's client secret:
 *   a reload can watch a payment that was sent, but cannot pay.
 */

const storageKey = "tidegrid.checkout";
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const secretPattern = /^[A-Za-z0-9_-]{43}$/;
/** How long after its expiry a record is kept, so a late reload can still read the outcome. */
const graceMs = 10 * 60_000;

export interface ResumeRecord {
  tripId: string;
  sessionId: string;
  /**
   * The quote the checkout charges. Not a secret: it names the trip and its
   * price, so a reload can show them even when the checkout's own hold has
   * taken the trip off sale.
   */
  quoteId: string;
  secret: string;
  /** The guest pressed a payment button, so a reload waits for the outcome. */
  paymentSent: boolean;
  /** The checkout's own expiry. */
  expiresAt: string;
}

function storage(): Storage | null {
  try {
    return window.sessionStorage;
  } catch {
    return null;
  }
}

function parse(text: string | null): ResumeRecord | null {
  if (!text) return null;
  try {
    const value = JSON.parse(text) as Partial<ResumeRecord> | null;
    if (
      !value ||
      typeof value.tripId !== "string" ||
      !uuid.test(value.tripId) ||
      typeof value.sessionId !== "string" ||
      !uuid.test(value.sessionId) ||
      typeof value.quoteId !== "string" ||
      !uuid.test(value.quoteId) ||
      typeof value.secret !== "string" ||
      !secretPattern.test(value.secret) ||
      typeof value.paymentSent !== "boolean" ||
      typeof value.expiresAt !== "string" ||
      Number.isNaN(Date.parse(value.expiresAt))
    ) {
      return null;
    }
    return {
      tripId: value.tripId,
      sessionId: value.sessionId,
      quoteId: value.quoteId,
      secret: value.secret,
      paymentSent: value.paymentSent,
      expiresAt: value.expiresAt,
    };
  } catch {
    return null;
  }
}

export function saveResume(record: ResumeRecord): void {
  try {
    storage()?.setItem(storageKey, JSON.stringify(record));
  } catch {
    // Full or blocked storage: the checkout still works; a reload cannot resume it.
  }
}

export function clearResume(): void {
  try {
    storage()?.removeItem(storageKey);
  } catch {
    // Nothing to clear.
  }
}

/**
 * The record for this trip's checkout, if there is one. A record that is
 * unreadable or long past its checkout's expiry is removed instead.
 */
export function readResume(tripId: string, now: number = Date.now()): ResumeRecord | null {
  let text: string | null = null;
  try {
    text = storage()?.getItem(storageKey) ?? null;
  } catch {
    return null;
  }
  if (text === null) return null;
  const record = parse(text);
  if (!record || Date.parse(record.expiresAt) + graceMs < now) {
    clearResume();
    return null;
  }
  return record.tripId === tripId.toLowerCase() ? record : null;
}
