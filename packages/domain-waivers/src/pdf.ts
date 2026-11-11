/**
 * A small, deterministic PDF 1.4 writer for waiver evidence: text in the
 * standard Helvetica faces with WinAnsi encoding, thin rules, and nothing
 * else. Nothing is compressed, and there is no clock or random id inside: the
 * same input always gives the same bytes, so the SHA-256 recorded with the
 * evidence names exactly one document. The whole file is ASCII apart from the
 * binary marker comment. Runs in Workers and Node.
 *
 * A character WinAnsi lacks, in a name or a typed signature, is drawn with
 * an embedded copy of DejaVu Sans holding only the glyphs the document uses
 * (fallback-ranges.ts names the alphabets). A document that needs none embeds
 * nothing, so its bytes are as they always were. A character outside those
 * alphabets shows a question mark.
 */
import { fallbackFont, fallbackGlyph, fallbackWidth } from "./fallback-font.ts";
import { compactTrueType } from "./truetype.ts";

export type PdfFont = "regular" | "bold" | "oblique";

const baseFonts: Record<PdfFont, string> = {
  regular: "Helvetica",
  bold: "Helvetica-Bold",
  oblique: "Helvetica-Oblique",
};
const fontKeys: Record<PdfFont, string> = { regular: "F1", bold: "F2", oblique: "F3" };

/** US Letter, in points. */
export const PAGE_WIDTH = 612;
export const PAGE_HEIGHT = 792;

// Advance widths in 1/1000 em for character codes 32 to 126, from the
// standard Helvetica and Helvetica-Bold metrics. Oblique shares Helvetica's.
const helvetica = [
  278, 278, 355, 556, 556, 889, 667, 191, 333, 333, 389, 584, 278, 333, 278, 278, 556, 556, 556,
  556, 556, 556, 556, 556, 556, 556, 278, 278, 584, 584, 584, 556, 1015, 667, 667, 722, 722, 667,
  611, 778, 722, 278, 500, 667, 556, 833, 722, 778, 667, 778, 722, 667, 611, 722, 667, 944, 667,
  667, 611, 278, 278, 278, 469, 556, 333, 556, 556, 500, 556, 556, 278, 556, 556, 222, 222, 500,
  222, 833, 556, 556, 556, 556, 333, 500, 278, 556, 500, 722, 500, 500, 500, 334, 260, 334, 584,
];
const helveticaBold = [
  278, 333, 474, 556, 556, 889, 722, 238, 333, 333, 389, 584, 278, 333, 278, 278, 556, 556, 556,
  556, 556, 556, 556, 556, 556, 556, 333, 333, 584, 584, 584, 611, 975, 722, 722, 722, 722, 667,
  611, 778, 722, 278, 556, 722, 611, 833, 722, 778, 667, 778, 722, 667, 611, 722, 667, 944, 667,
  667, 611, 333, 278, 333, 584, 556, 333, 556, 611, 556, 611, 556, 333, 611, 611, 278, 278, 556,
  278, 889, 611, 611, 611, 611, 389, 556, 333, 611, 556, 778, 556, 556, 500, 389, 280, 389, 584,
];

/** WinAnsi codes 0x80 to 0x9F, by Unicode code point. */
const winAnsiHigh: ReadonlyMap<number, number> = new Map([
  [0x20ac, 0x80],
  [0x201a, 0x82],
  [0x0192, 0x83],
  [0x201e, 0x84],
  [0x2026, 0x85],
  [0x2020, 0x86],
  [0x2021, 0x87],
  [0x02c6, 0x88],
  [0x2030, 0x89],
  [0x0160, 0x8a],
  [0x2039, 0x8b],
  [0x0152, 0x8c],
  [0x017d, 0x8e],
  [0x2018, 0x91],
  [0x2019, 0x92],
  [0x201c, 0x93],
  [0x201d, 0x94],
  [0x2022, 0x95],
  [0x2013, 0x96],
  [0x2014, 0x97],
  [0x02dc, 0x98],
  [0x2122, 0x99],
  [0x0161, 0x9a],
  [0x203a, 0x9b],
  [0x0153, 0x9c],
  [0x017e, 0x9e],
  [0x0178, 0x9f],
]);

/** The WinAnsi code for a Unicode code point, or null when WinAnsi has none. */
export function winAnsiCode(codePoint: number): number | null {
  if (codePoint >= 0x20 && codePoint <= 0x7e) return codePoint;
  if (codePoint >= 0xa0 && codePoint <= 0xff) return codePoint;
  return winAnsiHigh.get(codePoint) ?? null;
}

/** Whether every character of one line can be shown exactly in the PDF. */
export function isWinAnsiLine(text: string): boolean {
  for (const ch of text) {
    const cp = ch.codePointAt(0) ?? 0;
    if (winAnsiCode(cp) === null) return false;
  }
  return true;
}

// Approximate widths for codes 0x80 to 0xFF: an accented letter takes its
// base letter's width; everything else a typical width. Wrapping only needs
// to stay inside the margin, so the estimate errs wide.
const latinBase: Record<string, string> = {
  À: "A",
  Á: "A",
  Â: "A",
  Ã: "A",
  Ä: "A",
  Å: "A",
  Ç: "C",
  È: "E",
  É: "E",
  Ê: "E",
  Ë: "E",
  Ì: "I",
  Í: "I",
  Î: "I",
  Ï: "I",
  Ð: "D",
  Ñ: "N",
  Ò: "O",
  Ó: "O",
  Ô: "O",
  Õ: "O",
  Ö: "O",
  Ø: "O",
  Ù: "U",
  Ú: "U",
  Û: "U",
  Ü: "U",
  Ý: "Y",
  Š: "S",
  Ž: "Z",
  Ÿ: "Y",
  à: "a",
  á: "a",
  â: "a",
  ã: "a",
  ä: "a",
  å: "a",
  ç: "c",
  è: "e",
  é: "e",
  ê: "e",
  ë: "e",
  ì: "i",
  í: "i",
  î: "i",
  ï: "i",
  ñ: "n",
  ò: "o",
  ó: "o",
  ô: "o",
  õ: "o",
  ö: "o",
  ø: "o",
  ù: "u",
  ú: "u",
  û: "u",
  ü: "u",
  ý: "y",
  ÿ: "y",
  š: "s",
  ž: "z",
};
const wideHigh = new Set(["Æ", "Œ", "—", "…", "™", "‰"]);

function charWidth(ch: string, font: PdfFont): number {
  const table = font === "bold" ? helveticaBold : helvetica;
  const cp = ch.codePointAt(0) ?? 0;
  if (cp >= 32 && cp <= 126) return table[cp - 32] ?? 600;
  if (winAnsiCode(cp) === null) {
    const glyph = fallbackGlyph(cp);
    if (glyph !== null) return fallbackWidth(glyph);
  }
  const base = latinBase[ch];
  if (base) return table[(base.codePointAt(0) ?? 65) - 32] ?? 600;
  if (wideHigh.has(ch)) return 1000;
  return 600;
}

/** The width of one line in points. */
export function textWidth(text: string, font: PdfFont, size: number): number {
  let units = 0;
  for (const ch of text) units += charWidth(ch, font);
  return (units * size) / 1000;
}

/** Spaces the PDF cannot show, such as the no-break spaces dates use, become plain spaces. */
export function plainSpaces(text: string): string {
  return text.replace(/[  -​  　]/g, " ");
}

/**
 * Greedy word wrap of one line of text to a width in points. A word wider
 * than the line is broken between characters. Always returns at least one
 * line, possibly empty.
 */
export function wrapText(text: string, font: PdfFont, size: number, maxWidth: number): string[] {
  const words = plainSpaces(text)
    .split(" ")
    .filter((w) => w.length > 0);
  const lines: string[] = [];
  let current = "";
  const push = () => {
    lines.push(current);
    current = "";
  };
  for (const word of words) {
    const candidate = current ? `${current} ${word}` : word;
    if (textWidth(candidate, font, size) <= maxWidth) {
      current = candidate;
      continue;
    }
    if (current) push();
    if (textWidth(word, font, size) <= maxWidth) {
      current = word;
      continue;
    }
    // A word wider than the line: break it between characters.
    for (const ch of word) {
      if (current && textWidth(current + ch, font, size) > maxWidth) push();
      current += ch;
    }
  }
  if (current || lines.length === 0) lines.push(current);
  return lines;
}

/** One run of text: its baseline origin, face, and size. */
export interface PdfText {
  x: number;
  y: number;
  font: PdfFont;
  size: number;
  text: string;
}

/** A straight line, such as a signature line or a section rule. */
export interface PdfRule {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  width: number;
}

export interface PdfPage {
  texts: PdfText[];
  rules: PdfRule[];
}

export interface PdfDocument {
  title: string;
  /** Written as the document's creation date; for evidence, the signing instant. */
  creationDate: Date;
  pages: PdfPage[];
}

/** A number as PDF writes it: at most two decimals, no trailing zeros. */
function num(value: number): string {
  if (!Number.isFinite(value)) throw new RangeError("PDF numbers are finite");
  const fixed = value.toFixed(2);
  return fixed.replace(/\.?0+$/, "") || "0";
}

/**
 * A PDF literal string: WinAnsi bytes, with the delimiters escaped and every
 * byte outside printable ASCII written in octal, so the file stays ASCII. A
 * character WinAnsi lacks becomes a question mark.
 */
export function pdfString(text: string): string {
  let out = "(";
  for (const ch of plainSpaces(text)) {
    const code = winAnsiCode(ch.codePointAt(0) ?? 0) ?? 0x3f;
    if (code === 0x28 || code === 0x29 || code === 0x5c) out += `\\${String.fromCharCode(code)}`;
    else if (code < 0x20 || code > 0x7e) out += `\\${code.toString(8).padStart(3, "0")}`;
    else out += String.fromCharCode(code);
  }
  return `${out})`;
}

function pdfDate(date: Date): string {
  const iso = date.toISOString();
  return `D:${iso.slice(0, 4)}${iso.slice(5, 7)}${iso.slice(8, 10)}${iso.slice(11, 13)}${iso.slice(14, 16)}${iso.slice(17, 19)}Z`;
}

/** A run of text cut where it moves between Helvetica and the fallback font. */
interface Segment {
  text: string;
  /** Fallback glyph ids, when the segment is drawn with the fallback font. */
  glyphs: number[] | null;
}

function segments(text: string, used: Map<number, number>): Segment[] {
  const out: Segment[] = [];
  for (const ch of plainSpaces(text)) {
    const cp = ch.codePointAt(0) ?? 0;
    const glyph = winAnsiCode(cp) === null ? fallbackGlyph(cp) : null;
    const last = out.at(-1);
    if (glyph === null) {
      if (last && last.glyphs === null) last.text += ch;
      else out.push({ text: ch, glyphs: null });
      continue;
    }
    if (!used.has(glyph)) used.set(glyph, cp);
    if (last?.glyphs) {
      last.text += ch;
      last.glyphs.push(glyph);
    } else out.push({ text: ch, glyphs: [glyph] });
  }
  return out;
}

const FALLBACK_KEY = "F4";
/** DejaVu Sans's capital height (1493 of 2048 units), in 1/1000 em. */
const DEJAVU_CAP_HEIGHT = 729;
/** The slant Helvetica-Oblique has, for fallback text in an oblique run. */
const OBLIQUE_SKEW = 0.21;

function textRun(t: PdfText, used: Map<number, number>, cid: (g: number) => number): string {
  const parts = segments(t.text, used);
  if (parts.every((p) => p.glyphs === null)) {
    return `BT /${fontKeys[t.font]} ${num(t.size)} Tf 1 0 0 1 ${num(t.x)} ${num(t.y)} Tm ${pdfString(t.text)} Tj ET`;
  }
  // One text object for the whole run, so each piece starts exactly where the
  // viewer finished drawing the last one, with no widths estimated here. An
  // oblique run slants the whole object and sets its WinAnsi pieces in upright
  // Helvetica, which is how Helvetica-Oblique is drawn; a bold run strokes the
  // fallback outlines as well as filling them.
  const oblique = t.font === "oblique";
  const plain = oblique ? fontKeys.regular : fontKeys[t.font];
  const bold = t.font === "bold";
  const size = num(t.size);
  const out: string[] = [];
  if (bold) out.push(`q ${num(t.size * 0.03)} w`);
  out.push(`BT 1 0 ${oblique ? num(OBLIQUE_SKEW) : "0"} 1 ${num(t.x)} ${num(t.y)} Tm`);
  for (const p of parts) {
    if (p.glyphs === null) {
      out.push(`${bold ? "0 Tr " : ""}/${plain} ${size} Tf ${pdfString(p.text)} Tj`);
    } else {
      const hex = p.glyphs.map((g) => cid(g).toString(16).toUpperCase().padStart(4, "0")).join("");
      out.push(`${bold ? "2 Tr " : ""}/${FALLBACK_KEY} ${size} Tf <${hex}> Tj`);
    }
  }
  out.push(bold ? "ET Q" : "ET");
  return out.join("\n");
}

function contentStream(
  page: PdfPage,
  used: Map<number, number>,
  cid: (g: number) => number = (g) => g,
): string {
  const parts: string[] = [];
  if (page.rules.length > 0) {
    parts.push("0 G");
    for (const r of page.rules) {
      parts.push(`${num(r.width)} w ${num(r.x1)} ${num(r.y1)} m ${num(r.x2)} ${num(r.y2)} l S`);
    }
  }
  for (const t of page.texts) {
    if (t.text.length === 0) continue;
    parts.push(textRun(t, used, cid));
  }
  return `${parts.join("\n")}\n`;
}

/** ASCII85, so the embedded font keeps the file ASCII. */
export function ascii85(bytes: Uint8Array): string {
  let out = "";
  for (let i = 0; i < bytes.length; i += 4) {
    const chunk = bytes.subarray(i, i + 4);
    let value = 0;
    for (let j = 0; j < 4; j++) value = value * 256 + (chunk[j] ?? 0);
    if (chunk.length === 4 && value === 0) {
      out += "z";
      continue;
    }
    const digits: string[] = [];
    for (let j = 0; j < 5; j++) {
      digits.unshift(String.fromCharCode(33 + (value % 85)));
      value = Math.floor(value / 85);
    }
    out += digits.slice(0, chunk.length + 1).join("");
  }
  return `${out}~>`;
}

/** Six capital letters naming this glyph set, as a font subset's name begins. */
function subsetTag(glyphs: readonly number[]): string {
  let h = 0x811c9dc5;
  for (const g of glyphs) {
    h ^= g;
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  let tag = "";
  for (let i = 0; i < 6; i++) {
    tag += String.fromCharCode(65 + (h % 26));
    h = Math.floor(h / 26) + i * 7;
  }
  return tag;
}

/**
 * The fallback font's objects, numbered from `first`: the Type 0 font, its
 * CID font, the descriptor, the embedded subset, and the map back to Unicode
 * (so the text can be searched and copied).
 */
function fallbackObjects(
  first: number,
  used: Map<number, number>,
  embedded: { bytes: Uint8Array; glyphOf: ReadonlyMap<number, number> },
): string[] {
  const font = fallbackFont();
  const glyphs = [...used.keys()].sort((a, b) => a - b);
  const cid = (g: number) => embedded.glyphOf.get(g) ?? 0;
  const name = `${subsetTag(glyphs)}+DejaVuSans`;
  const scale = (v: number) => Math.round((v * 1000) / font.unitsPerEm);
  const widths = glyphs.map((g) => `${cid(g)} [${fallbackWidth(g)}]`).join(" ");
  const file = embedded.bytes;
  const encoded = ascii85(file);
  const hex4 = (n: number) => n.toString(16).toUpperCase().padStart(4, "0");
  const pairs = glyphs.map((g) => `<${hex4(cid(g))}> <${hex4(used.get(g) ?? 0xfffd)}>`);
  const blocks: string[] = [];
  for (let i = 0; i < pairs.length; i += 100) {
    const block = pairs.slice(i, i + 100);
    blocks.push(`${block.length} beginbfchar\n${block.join("\n")}\nendbfchar`);
  }
  const cmap = [
    "/CIDInit /ProcSet findresource begin",
    "12 dict begin",
    "begincmap",
    "/CIDSystemInfo << /Registry (Adobe) /Ordering (UCS) /Supplement 0 >> def",
    "/CMapName /Adobe-Identity-UCS def",
    "/CMapType 2 def",
    "1 begincodespacerange",
    "<0000> <FFFF>",
    "endcodespacerange",
    ...blocks,
    "endcmap",
    "CMapName currentdict /CMap defineresource pop",
    "end",
    "end",
    "",
  ].join("\n");
  const [x1, y1, x2, y2] = font.bbox.map(scale) as [number, number, number, number];
  return [
    `<< /Type /Font /Subtype /Type0 /BaseFont /${name} /Encoding /Identity-H /DescendantFonts [${first + 1} 0 R] /ToUnicode ${first + 4} 0 R >>`,
    `<< /Type /Font /Subtype /CIDFontType2 /BaseFont /${name} /CIDSystemInfo << /Registry (Adobe) /Ordering (Identity) /Supplement 0 >> /FontDescriptor ${first + 2} 0 R /CIDToGIDMap /Identity /DW 1000 /W [${widths}] >>`,
    `<< /Type /FontDescriptor /FontName /${name} /Flags 32 /FontBBox [${x1} ${y1} ${x2} ${y2}] /ItalicAngle 0 /Ascent ${scale(font.ascent)} /Descent ${scale(font.descent)} /CapHeight ${DEJAVU_CAP_HEIGHT} /StemV 80 /FontFile2 ${first + 3} 0 R >>`,
    `<< /Length ${encoded.length} /Length1 ${file.length} /Filter /ASCII85Decode >>\nstream\n${encoded}\nendstream`,
    `<< /Length ${cmap.length} >>\nstream\n${cmap}endstream`,
  ];
}

/** The document's bytes. Throws on a document with no pages. */
export function writePdf(doc: PdfDocument): Uint8Array {
  if (doc.pages.length === 0) throw new RangeError("a PDF has at least one page");
  // Objects: 1 catalog, 2 page tree, 3 to 5 fonts, 6 info, then a page and
  // its content stream for each page.
  const fonts: PdfFont[] = ["regular", "bold", "oblique"];
  const firstPage = 7;
  const pageRefs = doc.pages.map((_, i) => `${firstPage + i * 2} 0 R`);
  const bodies: string[] = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    `<< /Type /Pages /Kids [${pageRefs.join(" ")}] /Count ${doc.pages.length} >>`,
    ...fonts.map(
      (f) =>
        `<< /Type /Font /Subtype /Type1 /BaseFont /${baseFonts[f]} /Encoding /WinAnsiEncoding >>`,
    ),
    `<< /Title ${pdfString(doc.title)} /Producer (TideGrid waiver renderer 1) /CreationDate ${pdfString(pdfDate(doc.creationDate))} >>`,
  ];
  // The fallback glyphs the pages use, with a code point each, and the
  // objects that embed them, after the pages, only when there are any.
  const used = new Map<number, number>();
  let streams = doc.pages.map((page) => contentStream(page, used));
  // With fallback text, embed only its glyphs, renumbered, and write the
  // pages again with the new numbers.
  const embedded = used.size > 0 ? compactTrueType(fallbackFont(), used.keys()) : null;
  if (embedded) {
    const cid = (g: number) => embedded.glyphOf.get(g) ?? 0;
    streams = doc.pages.map((page) => contentStream(page, new Map(), cid));
  }
  const fallbackRef = firstPage + doc.pages.length * 2;
  let fontResources = fonts.map((f, i) => `/${fontKeys[f]} ${3 + i} 0 R`).join(" ");
  if (embedded) fontResources += ` /${FALLBACK_KEY} ${fallbackRef} 0 R`;
  streams.forEach((stream, i) => {
    const contentRef = firstPage + i * 2 + 1;
    bodies.push(
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${PAGE_WIDTH} ${PAGE_HEIGHT}] /Resources << /Font << ${fontResources} >> >> /Contents ${contentRef} 0 R >>`,
    );
    bodies.push(`<< /Length ${stream.length} >>\nstream\n${stream}endstream`);
  });
  if (embedded) bodies.push(...fallbackObjects(fallbackRef, used, embedded));

  let out = "%PDF-1.4\n%âãÏÓ\n";
  const offsets: number[] = [];
  bodies.forEach((body, i) => {
    offsets.push(out.length);
    out += `${i + 1} 0 obj\n${body}\nendobj\n`;
  });
  const xref = out.length;
  out += `xref\n0 ${bodies.length + 1}\n0000000000 65535 f \n`;
  for (const offset of offsets) out += `${String(offset).padStart(10, "0")} 00000 n \n`;
  out += `trailer\n<< /Size ${bodies.length + 1} /Root 1 0 R /Info 6 0 R >>\nstartxref\n${xref}\n%%EOF\n`;

  // Every character is ASCII but the marker's, so one character is one byte.
  const bytes = new Uint8Array(out.length);
  for (let i = 0; i < out.length; i++) bytes[i] = out.charCodeAt(i);
  return bytes;
}
