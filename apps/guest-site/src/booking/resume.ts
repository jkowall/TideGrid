/**
 * What survives a reload, in sessionStorage. See the README's "Secrets and
 * personal data" for why. Two records, each one at a time:
 *
 * The open checkout ("tidegrid.checkout"): its id, its quote's id, and the
 * checkout secret, so a reload can follow a payment that was sent.
 * - sessionStorage belongs to this tab and is gone when the tab closes; it is
 *   never sent anywhere.
 * - One record, one checkout: a new checkout replaces it.
 * - Cleared as soon as the checkout reaches a final state, is canceled, or is
 *   left behind past its expiry.
 * - Never the booker's name or email, and never the payment's client secret:
 *   a reload can watch a payment that was sent, but cannot pay.
 *
 * The last confirmation ("tidegrid.booked"): what the confirmation screen
 * showed, so a reload of it still shows the booking reference. It holds no
 * secret and no name or email: the reference, the trip, the party, the
 * extras, and the total. The next confirmation in the tab replaces it.
 */

const checkoutKey = "tidegrid.checkout";
const bookedKey = "tidegrid.booked";
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const secretPattern = /^[A-Za-z0-9_-]{43}$/;
const referencePattern = /^[0-9A-HJKMNP-TV-Z]{8}$/;
/** How long after its expiry a record is kept, so a late reload can still read the outcome. */
const graceMs = 10 * 60_000;
/** A device clock off by more than a week is not one the page can work with. */
const maxOffsetMs = 7 * 24 * 60 * 60_000;

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
  /** The provider took a payment button's request, so a reload waits for the outcome. */
  paymentSent: boolean;
  /**
   * A payment button was pressed, though its answer may never have arrived:
   * the payment may have gone through, so no screen may say nothing was charged.
   */
  paymentTried: boolean;
  /** The checkout's own expiry. */
  expiresAt: string;
  /** The server's clock minus this device's, when the page had learned it. */
  clockOffsetMs: number | null;
}

/** What the confirmation screen shows, as text and cents. */
export interface BookedRecord {
  tripId: string;
  reference: string;
  productName: string;
  /** When the trip leaves, as the screen said it. */
  when: string;
  where: string | null;
  meetAt: string | null;
  party: string;
  extras: string | null;
  /** The total paid, in cents. */
  total: number;
}

function storage(): Storage | null {
  try {
    return window.sessionStorage;
  } catch {
    return null;
  }
}

function read(key: string): string | null {
  try {
    return storage()?.getItem(key) ?? null;
  } catch {
    return null;
  }
}

function write(key: string, value: unknown): void {
  try {
    storage()?.setItem(key, JSON.stringify(value));
  } catch {
    // Full or blocked storage: the page still works; a reload cannot resume.
  }
}

function remove(key: string): void {
  try {
    storage()?.removeItem(key);
  } catch {
    // Nothing to clear.
  }
}

function json(text: string | null): Record<string, unknown> | null {
  if (!text) return null;
  try {
    const value: unknown = JSON.parse(text);
    return value && typeof value === "object" ? (value as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

function parseResume(text: string | null): ResumeRecord | null {
  const value = json(text);
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
    typeof value.paymentTried !== "boolean" ||
    typeof value.expiresAt !== "string" ||
    Number.isNaN(Date.parse(value.expiresAt))
  ) {
    return null;
  }
  const offset = value.clockOffsetMs;
  const clockOffsetMs =
    typeof offset === "number" && Number.isFinite(offset) && Math.abs(offset) <= maxOffsetMs
      ? offset
      : null;
  return {
    tripId: value.tripId,
    sessionId: value.sessionId,
    quoteId: value.quoteId,
    secret: value.secret,
    paymentSent: value.paymentSent,
    paymentTried: value.paymentTried || value.paymentSent,
    expiresAt: value.expiresAt,
    clockOffsetMs,
  };
}

export function saveResume(record: ResumeRecord): void {
  write(checkoutKey, record);
}

export function clearResume(): void {
  remove(checkoutKey);
}

/**
 * The record for this trip's checkout, if there is one. A record that is
 * unreadable or long past its checkout's expiry is removed instead.
 */
export function readResume(tripId: string, now: number = Date.now()): ResumeRecord | null {
  const text = read(checkoutKey);
  if (text === null) return null;
  const record = parseResume(text);
  if (!record || Date.parse(record.expiresAt) + graceMs < now) {
    clearResume();
    return null;
  }
  return record.tripId === tripId.toLowerCase() ? record : null;
}

const text = (value: unknown, max = 200): value is string =>
  typeof value === "string" && value.length > 0 && value.length <= max;
const optionalText = (value: unknown): value is string | null => value === null || text(value);

export function saveBooked(record: BookedRecord): void {
  write(bookedKey, record);
}

/** The last confirmation in this tab, if it was for this trip. */
export function readBooked(tripId: string): BookedRecord | null {
  const value = json(read(bookedKey));
  if (
    !value ||
    typeof value.tripId !== "string" ||
    !uuid.test(value.tripId) ||
    typeof value.reference !== "string" ||
    !referencePattern.test(value.reference) ||
    !text(value.productName) ||
    !text(value.when) ||
    !optionalText(value.where) ||
    !optionalText(value.meetAt) ||
    !text(value.party) ||
    !optionalText(value.extras) ||
    typeof value.total !== "number" ||
    !Number.isSafeInteger(value.total) ||
    value.total < 0
  ) {
    return null;
  }
  if (value.tripId !== tripId.toLowerCase()) return null;
  return {
    tripId: value.tripId,
    reference: value.reference,
    productName: value.productName,
    when: value.when,
    where: value.where,
    meetAt: value.meetAt,
    party: value.party,
    extras: value.extras,
    total: value.total,
  };
}
