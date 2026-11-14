import { MAX_TAX_RATE_PPM, type TaxRate } from "@tidegrid/contracts";

/**
 * Tax rates in the console: a rate is typed as a percentage with up to four
 * decimal places and sent in parts per million (6.25% is 62,500).
 */

/** "6.25" for 62,500 parts per million. */
export function percentOf(ppm: number): string {
  return (ppm / 10_000).toFixed(4).replace(/\.?0+$/, "");
}

/** Parts per million for a typed percentage, or null when it is not one a rate can be. */
export function ppmOf(text: string): number | null {
  const t = text.trim().replace(/%$/, "").trim();
  const m = /^(\d{1,2})(?:\.(\d{1,4}))?$/.exec(t);
  if (!m) return null;
  const ppm = Number(m[1]) * 10_000 + Number((m[2] ?? "").padEnd(4, "0"));
  return ppm >= 1 && ppm <= MAX_TAX_RATE_PPM ? ppm : null;
}

export const nameLimit = 80;
export const reasonLimit = 500;
// biome-ignore lint/suspicious/noControlCharactersInRegex: the pattern exists to find them.
const CONTROL = /[\u0000-\u001f\u007f-\u009f]/;
/** Invisible format characters (zero-width spaces, direction marks), which the API refuses in a name. */
const FORMAT = /\p{Cf}/u;

export type Field = "name" | "rate" | "reason";

/** What the form checks before sending, in the same terms as the API. */
export function formProblems(form: {
  name: string;
  rate: string;
  reason: string;
}): Partial<Record<Field, string>> {
  const problems: Partial<Record<Field, string>> = {};
  const name = form.name.trim();
  if (!name) problems.name = "Give the rate a name.";
  else if (name.length > nameLimit) problems.name = `Use at most ${nameLimit} characters.`;
  else if (CONTROL.test(name) || FORMAT.test(name)) {
    problems.name = "Remove hidden or control characters from the name.";
  }
  if (ppmOf(form.rate) === null) {
    problems.rate = "Enter a percentage from 0.0001 to 50, such as 6.25.";
  }
  const reason = form.reason.trim();
  if (!reason) problems.reason = "Say why, for the record.";
  else if (reason.length > reasonLimit) problems.reason = `Use at most ${reasonLimit} characters.`;
  else if (CONTROL.test(reason)) {
    problems.reason = "Remove hidden or control characters from the reason.";
  }
  return problems;
}

/** How the rate is charged, in words. */
export function chargedAs(rate: Pick<TaxRate, "ratePpm" | "inclusive">): string {
  return `${percentOf(rate.ratePpm)}%, ${rate.inclusive ? "included in prices" : "added to prices"}`;
}

/** Where it applies, in words. */
export function appliesAt(rate: Pick<TaxRate, "locationId" | "locationName">): string {
  if (rate.locationId === null) return "Every location";
  return rate.locationName ?? "A location no longer listed";
}
