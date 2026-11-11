/**
 * The font the waiver PDF falls back to for characters WinAnsi lacks:
 * DejaVu Sans, reduced to the alphabets it can draw without shaping or
 * right-to-left layout (Latin, Greek, Cyrillic, Armenian, Georgian, and their
 * extensions). A character outside these, such as Arabic, Hebrew, or Chinese,
 * still shows a question mark, and the evidence keeps the exact text.
 */

import { FALLBACK_RANGES, inFallbackRanges } from "./fallback-ranges.ts";
import { DEJAVU_SANS_BASE64 } from "./fonts/dejavu-sans.ts";
import { advanceWidth, hasOutline, parseTrueType, type TrueTypeFont } from "./truetype.ts";

export { FALLBACK_RANGES, inFallbackRanges };

let font: TrueTypeFont | null = null;

export function fallbackFont(): TrueTypeFont {
  if (!font) {
    const binary = atob(DEJAVU_SANS_BASE64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    font = parseTrueType(bytes);
  }
  return font;
}

/** The fallback glyph for a code point, or null when the PDF cannot draw it this way. */
export function fallbackGlyph(codePoint: number): number | null {
  if (!inFallbackRanges(codePoint)) return null;
  const f = fallbackFont();
  const glyph = f.cmap.get(codePoint);
  return glyph !== undefined && hasOutline(f, glyph) ? glyph : null;
}

/** A fallback glyph's advance, in 1/1000 em. */
export function fallbackWidth(glyph: number): number {
  const f = fallbackFont();
  return Math.round((advanceWidth(f, glyph) * 1000) / f.unitsPerEm);
}
