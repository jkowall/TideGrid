/** The alphabets the waiver PDF draws with its fallback font (see fallback-font.ts). */

/** Code point ranges the PDF draws with the fallback font, inclusive. */
export const FALLBACK_RANGES: readonly (readonly [number, number])[] = [
  [0x00a0, 0x024f], // Latin-1 Supplement, Latin Extended-A and -B
  [0x0250, 0x02ff], // IPA Extensions, Spacing Modifier Letters
  [0x0300, 0x036f], // Combining Diacritical Marks
  [0x0370, 0x03ff], // Greek and Coptic
  [0x0400, 0x052f], // Cyrillic and Cyrillic Supplement
  [0x0530, 0x058f], // Armenian
  [0x10a0, 0x10ff], // Georgian
  [0x1e00, 0x1fff], // Latin Extended Additional, Greek Extended
  [0x2000, 0x206f], // General Punctuation
  [0x20a0, 0x20cf], // Currency Symbols
  [0x2100, 0x214f], // Letterlike Symbols
  [0x2c60, 0x2c7f], // Latin Extended-C
  [0xa720, 0xa7ff], // Latin Extended-D
];

export function inFallbackRanges(codePoint: number): boolean {
  return FALLBACK_RANGES.some(([from, to]) => codePoint >= from && codePoint <= to);
}
