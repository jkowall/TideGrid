import { describe, expect, it } from "vitest";
import {
  isWinAnsiLine,
  type PdfDocument,
  pdfString,
  plainSpaces,
  textWidth,
  winAnsiCode,
  wrapText,
  writePdf,
} from "./pdf.ts";

const ascii = (bytes: Uint8Array) => String.fromCharCode(...bytes);

function sampleDoc(pages = 1): PdfDocument {
  return {
    title: "Fixture (waiver) \\ test",
    creationDate: new Date("2026-10-06T15:04:05.678Z"),
    pages: Array.from({ length: pages }, (_, i) => ({
      texts: [{ x: 54, y: 700, font: "regular" as const, size: 10, text: `Page ${i + 1} (one)` }],
      rules: [{ x1: 54, y1: 690, x2: 558, y2: 690, width: 0.5 }],
    })),
  };
}

describe("WinAnsi text", () => {
  it("encodes ASCII, Latin-1, and the typographic marks WinAnsi has", () => {
    expect(winAnsiCode("A".codePointAt(0) ?? 0)).toBe(0x41);
    expect(winAnsiCode("é".codePointAt(0) ?? 0)).toBe(0xe9);
    expect(winAnsiCode("’".codePointAt(0) ?? 0)).toBe(0x92);
    expect(winAnsiCode("€".codePointAt(0) ?? 0)).toBe(0x80);
    expect(winAnsiCode("•".codePointAt(0) ?? 0)).toBe(0x95);
    expect(winAnsiCode("ł".codePointAt(0) ?? 0)).toBeNull();
    expect(winAnsiCode(0x0a)).toBeNull();
    expect(isWinAnsiLine("Zoë’s “waiver” – 2026 ©")).toBe(true);
    expect(isWinAnsiLine("Łukasz")).toBe(false);
    expect(isWinAnsiLine("😀")).toBe(false);
  });

  it("escapes delimiters and writes non-ASCII bytes in octal, so the file stays ASCII", () => {
    expect(pdfString("a(b)c\\d")).toBe("(a\\(b\\)c\\\\d)");
    expect(pdfString("José’s")).toBe("(Jos\\351\\222s)");
    expect(pdfString("Łódź")).toBe("(?\\363d?)");
    expect(pdfString("9:00 AM")).toBe("(9:00 AM)");
  });

  it("turns spaces the fonts lack into plain spaces", () => {
    expect(plainSpaces("6:00 PM EDT")).toBe("6:00 PM EDT");
  });
});

describe("wrapping", () => {
  it("measures with the standard metrics", () => {
    // "Hi" in Helvetica: H 722 + i 222, at 10 points.
    expect(textWidth("Hi", "regular", 10)).toBeCloseTo(9.44, 5);
    expect(textWidth("Hi", "bold", 10)).toBeCloseTo(10, 5);
  });

  it("wraps greedily inside the width and breaks a word wider than the line", () => {
    const lines = wrapText("one two three four five six seven", "regular", 10, 60);
    expect(lines.length).toBeGreaterThan(1);
    for (const l of lines) expect(textWidth(l, "regular", 10)).toBeLessThanOrEqual(60);
    expect(lines.join(" ")).toBe("one two three four five six seven");
    const long = wrapText("x".repeat(200), "regular", 10, 100);
    expect(long.join("")).toBe("x".repeat(200));
    for (const l of long) expect(textWidth(l, "regular", 10)).toBeLessThanOrEqual(100);
    expect(wrapText("", "regular", 10, 100)).toEqual([""]);
  });
});

describe("writePdf", () => {
  it("writes a well-formed PDF whose cross-reference offsets point at their objects", () => {
    const text = ascii(writePdf(sampleDoc(2)));
    expect(text.startsWith("%PDF-1.4\n")).toBe(true);
    expect(text.endsWith("%%EOF\n")).toBe(true);
    const startxref = Number(/startxref\n(\d+)\n%%EOF\n$/.exec(text)?.[1]);
    expect(text.slice(startxref, startxref + 4)).toBe("xref");
    const entries = text
      .slice(startxref)
      .split("\n")
      .filter((l) => / 00000 n $/.test(l))
      .map((l) => Number(l.slice(0, 10)));
    expect(entries).toHaveLength(10);
    entries.forEach((offset, i) => {
      expect(text.slice(offset, offset + `${i + 1} 0 obj`.length)).toBe(`${i + 1} 0 obj`);
    });
    for (const line of text.split("\n").filter((l) => / 0{5} [nf] $/.test(l))) {
      expect(line.length + 1).toBe(20);
    }
    expect(text).toContain("/Count 2");
    expect(text).toContain("/CreationDate (D:20261006150405Z)");
    expect(text).toContain("(Fixture \\(waiver\\) \\\\ test)");
  });

  it("gives each content stream its exact length", () => {
    const text = ascii(writePdf(sampleDoc(1)));
    const match = /<< \/Length (\d+) >>\nstream\n([\s\S]*?)endstream/.exec(text);
    expect(match).not.toBeNull();
    expect(match?.[2]?.length).toBe(Number(match?.[1]));
  });

  it("is deterministic and ASCII apart from its binary marker", () => {
    const a = writePdf(sampleDoc(3));
    const b = writePdf(sampleDoc(3));
    expect(a).toEqual(b);
    const body = a.slice(15);
    expect([...body].every((byte) => byte === 0x0a || (byte >= 0x20 && byte <= 0x7e))).toBe(true);
  });

  it("refuses a document with no pages", () => {
    expect(() => writePdf({ ...sampleDoc(1), pages: [] })).toThrow(RangeError);
  });
});
