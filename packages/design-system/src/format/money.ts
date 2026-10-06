/**
 * Money and rates as TideGrid shows them. The API sends money as integer
 * cents and rates as integers (parts per million, basis points). Everything
 * here is integer arithmetic and string building: a value is never divided
 * into a float, so a cent can never be rounded away or gained. No DOM and no
 * React: safe in Node.
 */

/** U+2212, which screen readers say as "minus"; a hyphen is often skipped. */
const minus = "−";

export type Currency = "USD";

function wholeAndRest(value: number, unit: number): [number, number] {
  const rest = value % unit;
  // value - rest is an exact multiple of unit, so this division is exact.
  return [(value - rest) / unit, rest];
}

function grouped(whole: number): string {
  return String(whole).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

/**
 * Integer cents in dollars: 4500 reads "$45.00", 123456 reads "$1,234.56",
 * and -1150 reads "−$11.50". Throws on anything but a safe integer, so a float
 * from somewhere else fails loudly instead of printing a wrong amount.
 */
export function formatMoney(cents: number, currency: Currency = "USD"): string {
  if (!Number.isSafeInteger(cents)) throw new RangeError(`not integer cents: ${String(cents)}`);
  if (currency !== "USD") throw new RangeError(`unsupported currency: ${String(currency)}`);
  const negative = cents < 0;
  const [dollars, rest] = wholeAndRest(negative ? -cents : cents, 100);
  return `${negative ? minus : ""}$${grouped(dollars)}.${String(rest).padStart(2, "0")}`;
}

function percent(value: number, perPercent: number, digits: number): string {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RangeError(`not a whole, non-negative rate: ${String(value)}`);
  }
  const [whole, rest] = wholeAndRest(value, perPercent);
  if (rest === 0) return `${whole}%`;
  return `${whole}.${String(rest).padStart(digits, "0").replace(/0+$/, "")}%`;
}

/** A rate in parts per million: 60000 reads "6%", 47120 reads "4.712%". */
export function formatRatePpm(ppm: number): string {
  return percent(ppm, 10_000, 4);
}

/** Basis points: 1000 reads "10%", 1250 reads "12.5%". */
export function formatBasisPoints(bp: number): string {
  return percent(bp, 100, 2);
}

/**
 * Time left before a deadline, in words that do not pretend to precision:
 * "less than a minute", "about 1 minute", "about 14 minutes", "about 2 hours".
 * Rounds down, so it never promises more time than there is. Zero or less
 * reads "no time".
 */
export function formatTimeLeft(milliseconds: number): string {
  if (!(milliseconds > 0)) return "no time";
  const minutes = Math.floor(milliseconds / 60_000);
  if (minutes < 1) return "less than a minute";
  if (minutes < 60) return `about ${minutes} ${minutes === 1 ? "minute" : "minutes"}`;
  const hours = Math.floor(minutes / 60);
  return `about ${hours} ${hours === 1 ? "hour" : "hours"}`;
}
