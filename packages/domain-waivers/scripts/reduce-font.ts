/**
 * Writes src/fonts/dejavu-sans.ts: DejaVu Sans reduced to the alphabets the
 * waiver PDF draws with it (FALLBACK_RANGES), as base64. Run from the package
 * directory with the system's DejaVu Sans:
 *
 *   node scripts/reduce-font.ts /usr/share/fonts/truetype/dejavu/DejaVuSans.ttf
 *
 * The output is deterministic for one input font.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { FALLBACK_RANGES } from "../src/fallback-ranges.ts";
import { parseTrueType, subsetTrueType } from "../src/truetype.ts";

const source = process.argv[2];
if (!source) throw new Error("usage: node scripts/reduce-font.ts <DejaVuSans.ttf>");
const font = parseTrueType(new Uint8Array(readFileSync(source)));
const glyphs: number[] = [];
for (const [cp, glyph] of font.cmap) {
  if (FALLBACK_RANGES.some(([from, to]) => cp >= from && cp <= to)) glyphs.push(glyph);
}
const reduced = subsetTrueType(font, glyphs, ["cmap"]);
const base64 = Buffer.from(reduced).toString("base64");
const lines = base64.match(/.{1,100}/g) ?? [];
writeFileSync(
  new URL("../src/fonts/dejavu-sans.ts", import.meta.url),
  [
    "/**",
    " * DejaVu Sans, reduced by scripts/reduce-font.ts to the alphabets the waiver",
    " * PDF draws with it. Generated; do not edit. The font's license is in",
    " * ./DEJAVU-LICENSE.txt and in its own name table.",
    " */",
    "export const DEJAVU_SANS_BASE64 = [",
    ...lines.map((l) => `  "${l}",`),
    '].join("");',
    "",
  ].join("\n"),
);
console.log(`reduced to ${reduced.length} bytes (${glyphs.length} mapped glyphs)`);
