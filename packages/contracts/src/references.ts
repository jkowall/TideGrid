/**
 * Booking references (G2.7, G2.12b): eight characters of Crockford base32,
 * with no I, L, O, or U. A guest reads theirs out to the operator, so the
 * console accepts it the way people say and type it. This module has no
 * dependencies, so the console can use it without bundling any schema code.
 */

/** A booking reference as TideGrid issues it. */
export const bookingReferencePattern = /^[0-9A-HJKMNP-TV-Z]{8}$/;

/**
 * A typed or spoken reference in its issued form, or null when it cannot be
 * one: case is ignored, spaces and hyphens are dropped, and the letters
 * Crockford base32 reads as digits become them (O as 0, I and L as 1).
 */
export function normalizeBookingReference(input: string): string | null {
  if (input.length > 64) return null;
  const compact = readAsReference(input);
  return bookingReferencePattern.test(compact) ? compact : null;
}

/** Case ignored, spaces and hyphens dropped, O as 0, I and L as 1. */
function readAsReference(input: string): string {
  return input.toUpperCase().replace(/[\s-]/g, "").replace(/O/g, "0").replace(/[IL]/g, "1");
}

const referencePrefixPattern = /^[0-9A-HJKMNP-TV-Z]{2,8}$/;

/**
 * The start of a booking reference, read the way a guest quotes one, as
 * `normalizeBookingReference` reads a whole one (G2.12c): two to eight of its
 * characters, or null. The API's search and the console's search form both
 * use it, so they can never read finance's text by different rules.
 */
export function bookingReferencePrefix(input: string): string | null {
  if (input.length > 64) return null;
  const compact = readAsReference(input);
  return referencePrefixPattern.test(compact) ? compact : null;
}
