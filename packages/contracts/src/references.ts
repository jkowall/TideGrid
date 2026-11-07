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

/**
 * True when a spreadsheet could read the reference as a number: digits only,
 * or digits, one E, and digits (scientific notation).
 */
export function isNumberShapedReference(ref: string): boolean {
  return /^[0-9]+(E[0-9]+)?$/.test(ref);
}

/**
 * A reference cell from the day's CSV export, without the one leading
 * apostrophe that guards a number-shaped reference. Lossless: the reference
 * alphabet has no apostrophe.
 */
export function unguardBookingReference(cell: string): string {
  return cell.startsWith("'") ? cell.slice(1) : cell;
}

/**
 * Case ignored, spaces and hyphens dropped, then one leading apostrophe
 * (pasted from the export), O as 0, I and L as 1. Separators go first, so a
 * guarded reference pasted with a space or a hyphen around it still reads.
 */
function readAsReference(input: string): string {
  return unguardBookingReference(input.toUpperCase().replace(/[\s-]/g, ""))
    .replace(/O/g, "0")
    .replace(/[IL]/g, "1");
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
