import { describe, expect, it } from "vitest";
import { fallbackFont, fallbackGlyph, fallbackWidth } from "./fallback-font.ts";
import { advanceWidth, compactTrueType, hasOutline, parseTrueType } from "./truetype.ts";

/** The sum every TrueType file's 32-bit words come to once its head is adjusted. */
function wholeSum(bytes: Uint8Array): number {
  const padded = new Uint8Array((bytes.length + 3) & ~3);
  padded.set(bytes);
  const dv = new DataView(padded.buffer);
  let sum = 0;
  for (let i = 0; i < padded.length; i += 4) sum = (sum + dv.getUint32(i)) >>> 0;
  return sum;
}

const glyphOfChar = (ch: string) => fallbackGlyph(ch.codePointAt(0) ?? 0);

describe("the fallback font", () => {
  it("draws Latin, Greek, Cyrillic, Armenian, and Georgian letters WinAnsi lacks", () => {
    for (const ch of ["Ł", "ż", "ő", "Ș", "Ā", "ǅ", "Ω", "ά", "Ж", "ї", "Ա", "ა", "ẞ", "₹"]) {
      expect([ch, glyphOfChar(ch)]).toEqual([ch, expect.any(Number)]);
    }
  });

  it("leaves out scripts it cannot lay out, and characters it lacks", () => {
    // Right-to-left and shaped scripts, Chinese, and emoji keep the question mark.
    for (const ch of ["ש", "ع", "李", "한", "क", "😀"]) {
      expect([ch, glyphOfChar(ch)]).toEqual([ch, null]);
    }
  });

  it("gives each glyph its own advance width", () => {
    const glyph = glyphOfChar("Ж") as number;
    const font = fallbackFont();
    expect(fallbackWidth(glyph)).toBe(
      Math.round((advanceWidth(font, glyph) * 1000) / font.unitsPerEm),
    );
    expect(fallbackWidth(glyph)).toBeGreaterThan(500);
  });
});

describe("compactTrueType", () => {
  const font = fallbackFont();

  it("keeps only the glyphs asked for, renumbered, with .notdef first", () => {
    const wanted = ["Ł", "ż", "Ω"].map((ch) => glyphOfChar(ch) as number);
    const { bytes, glyphOf } = compactTrueType(font, wanted);
    const small = parseTrueType(bytes);
    expect(small.numGlyphs).toBe(glyphOf.size);
    expect(glyphOf.get(0)).toBe(0);
    for (const g of wanted) {
      const id = glyphOf.get(g) as number;
      expect(hasOutline(small, id)).toBe(true);
      expect(advanceWidth(small, id)).toBe(advanceWidth(font, g));
    }
    // A valid font: the head's adjustment makes the whole file sum to the magic number.
    expect(wholeSum(bytes)).toBe(0xb1b0afba);
    expect(bytes.length).toBeLessThan(20_000);
    // The copyright and license names travel with it.
    const name = new TextDecoder("utf-16be").decode(bytes);
    expect(name).toContain("Bitstream");
  });

  it("brings a composite glyph's parts and points it at their new ids", () => {
    // Find a composite among the fallback letters.
    let composite: number | null = null;
    for (let cp = 0x100; cp < 0x250 && composite === null; cp++) {
      const g = fallbackGlyph(cp);
      if (g === null) continue;
      const only = compactTrueType(font, [g]);
      if (only.glyphOf.size > 2) composite = g;
    }
    expect(composite).not.toBeNull();
    const { bytes, glyphOf } = compactTrueType(font, [composite as number]);
    const small = parseTrueType(bytes);
    for (const id of glyphOf.values()) expect(id).toBeLessThan(small.numGlyphs);
    expect(hasOutline(small, glyphOf.get(composite as number) as number)).toBe(true);
    expect(wholeSum(bytes)).toBe(0xb1b0afba);
  });

  it("gives the same bytes for the same glyphs", () => {
    const glyphs = ["Ж", "ї"].map((ch) => glyphOfChar(ch) as number);
    expect(compactTrueType(font, glyphs).bytes).toEqual(
      compactTrueType(font, [...glyphs].reverse()).bytes,
    );
  });
});
