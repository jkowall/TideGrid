/**
 * A small, deterministic PDF 1.4 writer for waiver evidence: text in the
 * standard Helvetica faces with WinAnsi encoding, thin rules, and nothing
 * else. No font is embedded, nothing is compressed, and there is no clock or
 * random id inside: the same input always gives the same bytes, so the
 * SHA-256 recorded with the evidence names exactly one document. The whole
 * file is ASCII apart from the binary marker comment. Runs in Workers and Node.
 */

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

function contentStream(page: PdfPage): string {
  const parts: string[] = [];
  if (page.rules.length > 0) {
    parts.push("0 G");
    for (const r of page.rules) {
      parts.push(`${num(r.width)} w ${num(r.x1)} ${num(r.y1)} m ${num(r.x2)} ${num(r.y2)} l S`);
    }
  }
  for (const t of page.texts) {
    if (t.text.length === 0) continue;
    parts.push(
      `BT /${fontKeys[t.font]} ${num(t.size)} Tf 1 0 0 1 ${num(t.x)} ${num(t.y)} Tm ${pdfString(t.text)} Tj ET`,
    );
  }
  return `${parts.join("\n")}\n`;
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
  const fontResources = fonts.map((f, i) => `/${fontKeys[f]} ${3 + i} 0 R`).join(" ");
  doc.pages.forEach((page, i) => {
    const contentRef = firstPage + i * 2 + 1;
    bodies.push(
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${PAGE_WIDTH} ${PAGE_HEIGHT}] /Resources << /Font << ${fontResources} >> >> /Contents ${contentRef} 0 R >>`,
    );
    const stream = contentStream(page);
    bodies.push(`<< /Length ${stream.length} >>\nstream\n${stream}endstream`);
  });

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

  // Every character is below 256, so one character is one byte.
  const bytes = new Uint8Array(out.length);
  for (let i = 0; i < out.length; i++) bytes[i] = out.charCodeAt(i);
  return bytes;
}
