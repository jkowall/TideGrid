import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { maskEmail, renderWaiverPdf, type WaiverDocumentInput } from "./render.ts";
import { hasOutline, parseTrueType } from "./truetype.ts";

const ascii = (bytes: Uint8Array) => {
  let out = "";
  for (const b of bytes) out += String.fromCharCode(b);
  return out;
};

// Computed from the renderer as it was before the fallback font (commit e06dfab).
const PINNED_SHA256 = "192cbc871333d7bc5ed30ab498936f40d412df8cfe8a89a44e626b7873140c2e";

function fromAscii85(text: string): Uint8Array {
  const out: number[] = [];
  const body = text.replace(/~>$/, "").replace(/\s/g, "");
  let group: number[] = [];
  const flush = (n: number) => {
    let value = 0;
    for (let i = 0; i < 5; i++) value = value * 85 + (group[i] ?? 84);
    for (let i = 0; i < n - 1; i++) out.push((value >>> (24 - i * 8)) & 0xff);
  };
  for (const ch of body) {
    if (ch === "z" && group.length === 0) {
      out.push(0, 0, 0, 0);
      continue;
    }
    group.push(ch.charCodeAt(0) - 33);
    if (group.length === 5) {
      flush(5);
      group = [];
    }
  }
  if (group.length > 0) flush(group.length);
  return new Uint8Array(out);
}

function sampleWaiver(overrides: Partial<WaiverDocumentInput> = {}): WaiverDocumentInput {
  return {
    operatorName: "Demo Harbor Charters",
    title: "Harbor cruise participation waiver",
    version: 2,
    contentSha256: "a".repeat(64),
    body: [
      "Synthetic demo text. Not a real legal agreement.",
      "Boating has risks, including slips and falls, sun exposure, and sea sickness.\nFollow the crew's instructions at all times.",
      "I release Demo Harbor Charters from claims for ordinary negligence, to the extent the law allows.",
    ].join("\n\n"),
    acknowledgments: ["I have read this waiver.", "I understand and accept the risks."],
    trip: {
      name: "Sunset Harbor Cruise",
      when: "Saturday, November 7, 2026 at 6:00 PM EST",
      place: "Harbor Marina, Dock C",
      bookingReference: "7KQ2M9XA",
    },
    participant: { name: "Zoë Example", minor: false },
    signer: { role: "participant", name: "Zoë Example", relationship: null },
    signatureText: "Zoë Example",
    consentText: "I agree to sign electronically. My typed name is my signature.",
    signedAt: new Date("2026-10-06T19:04:05.000Z"),
    signedAtLocal: "Tuesday, October 6, 2026 at 3:04 PM EDT",
    evidenceId: "00000000-0000-4000-8000-000000000001",
    requestId: "00000000-0000-4000-8000-000000000002",
    arrival: { kind: "email_link", recipientMasked: maskEmail("zoe@example.test") },
    sourceIp: "203.0.113.7",
    userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X)",
    ...overrides,
  };
}

describe("renderWaiverPdf", () => {
  it("renders the same bytes for the same evidence", () => {
    expect(renderWaiverPdf(sampleWaiver())).toEqual(renderWaiverPdf(sampleWaiver()));
  });

  it("shows the text, the acknowledgments, the signature, and the signing record", () => {
    const pdf = ascii(renderWaiverPdf(sampleWaiver()));
    for (const part of [
      "(Demo Harbor Charters)",
      "(Harbor cruise participation waiver)",
      "(Sunset Harbor Cruise)",
      "(7KQ2M9XA)",
      "(Zo\\353 Example)",
      "(I have read this waiver.)",
      "(I understand and accept the risks.)",
      "([X])",
      "(Participant, signing for themselves)",
      `(${"a".repeat(64)})`,
      "(00000000-0000-4000-8000-000000000001)",
      "(203.0.113.7)",
      "(Page 1 of 1)",
    ]) {
      expect(pdf).toContain(part);
    }
    // The typed signature is set in the oblique face.
    expect(pdf).toMatch(/\/F3 18 Tf 1 0 0 1 [\d.]+ [\d.]+ Tm \(Zo\\353 Example\) Tj/);
    expect(pdf).toContain("z\\225\\225\\225@example.test");
  });

  it("names a guardian's capacity and the minor", () => {
    const pdf = ascii(
      renderWaiverPdf(
        sampleWaiver({
          participant: { name: "Sam Example", minor: true },
          signer: { role: "guardian", name: "Pat Example", relationship: "legal_guardian" },
          signatureText: "Pat Example",
        }),
      ),
    );
    expect(pdf).toContain("(Sam Example \\(a minor\\))");
    expect(pdf).toContain("(Legal guardian of Sam Example, a minor)");
  });

  it("flows a long waiver onto more pages and numbers every page", () => {
    const body = Array.from(
      { length: 60 },
      (_, i) => `Paragraph ${i + 1}. ${"Risk text. ".repeat(30)}`,
    ).join("\n\n");
    const pdf = ascii(renderWaiverPdf(sampleWaiver({ body })));
    const pages = Number(/\/Count (\d+)/.exec(pdf)?.[1]);
    expect(pages).toBeGreaterThan(3);
    expect(pdf).toContain(`(Page ${pages} of ${pages})`);
    // Every text run starts inside the page's margins.
    for (const m of pdf.matchAll(/1 0 0 1 ([\d.]+) ([\d.]+) Tm/g)) {
      const [x, y] = [Number(m[1]), Number(m[2])];
      expect(x).toBeGreaterThanOrEqual(54);
      expect(x).toBeLessThan(558);
      expect(y).toBeGreaterThan(30);
      expect(y).toBeLessThan(740);
    }
  });

  it("keeps the signing record on one page however long the waiver runs", () => {
    const pageOf = (pdf: string, text: string) =>
      [...pdf.matchAll(/stream\n([\s\S]*?)endstream/g)].findIndex((m) => m[1]?.includes(text));
    const pagesSeen = new Set<number>();
    for (let lines = 1; lines <= 60; lines++) {
      const body = Array.from({ length: lines }, (_, i) => `Short line ${i + 1}.`).join("\n\n");
      const pdf = ascii(renderWaiverPdf(sampleWaiver({ body })));
      const start = pageOf(pdf, "(Signing record)");
      expect(start).toBeGreaterThanOrEqual(0);
      for (const label of ["(Evidence)", "(How it was reached)", "(Device)", "(Rendering)"]) {
        expect([lines, label, pageOf(pdf, label)]).toEqual([lines, label, start]);
      }
      pagesSeen.add(start);
    }
    // The bodies push the record across at least one page break.
    expect(pagesSeen.size).toBeGreaterThan(1);
  });

  it("keeps a waiver WinAnsi can show byte for byte as it was, with no font embedded", () => {
    const pdf = renderWaiverPdf(
      sampleWaiver({ body: "Synthetic demo text.\n\nI release Demo Harbor Charters." }),
    );
    expect(ascii(pdf)).not.toContain("FontFile2");
    // Pinned before the fallback font existed: these bytes must never change.
    expect(createHash("sha256").update(pdf).digest("hex")).toBe(PINNED_SHA256);
  });

  it("draws names and signatures in other alphabets with an embedded subset font", () => {
    const input = sampleWaiver({
      operatorName: "Ελληνική Ναυτιλία",
      participant: { name: "Łukasz Żółć", minor: false },
      signer: { role: "participant", name: "Łukasz Żółć", relationship: null },
      signatureText: "Łukasz Żółć Дмитрий 李",
    });
    const bytes = renderWaiverPdf(input);
    expect(bytes).toEqual(renderWaiverPdf(input));
    const pdf = ascii(bytes);
    expect(pdf).toMatch(/\/BaseFont \/[A-Z]{6}\+DejaVuSans \/Encoding \/Identity-H/);
    expect(pdf).toContain("/CIDToGIDMap /Identity");
    expect(pdf).toContain("/ToUnicode");
    // The signature: Latin letters WinAnsi has stay in Helvetica, the rest in
    // the subset, slanted like the oblique face; Chinese keeps the question mark.
    // One text object, slanted as a whole, so each piece starts where the
    // viewer finished drawing the one before.
    expect(pdf).toMatch(
      /BT 1 0 0\.21 1 [\d.]+ [\d.]+ Tm\n\/F4 18 Tf <[0-9A-F]{4}> Tj\n\/F1 18 Tf \(ukasz \) Tj\n\/F4 18 Tf <[0-9A-F]{4}> Tj\n/,
    );
    expect(pdf).toContain("( ?)");
    // Each fallback character maps back to its Unicode, so the text can be searched.
    for (const cp of ["Ł", "Ż", "Д", "λ"].map((c) => c.codePointAt(0) as number)) {
      expect(pdf).toMatch(
        new RegExp(`<[0-9A-F]{4}> <${cp.toString(16).toUpperCase().padStart(4, "0")}>`),
      );
    }
    // The embedded font holds only what the document uses, and every one has an outline.
    const stream =
      /\/Filter \/ASCII85Decode >>\nstream\n([\s\S]*?)\nendstream/.exec(pdf)?.[1] ?? "";
    const font = parseTrueType(fromAscii85(stream));
    const used = new Set("ŁŻżółćДмитрийΕλληνικήΝαυτιλία".split("")).size;
    expect(font.numGlyphs).toBeGreaterThanOrEqual(used);
    expect(font.numGlyphs).toBeLessThan(used + 10);
    for (let g = 1; g < font.numGlyphs; g++) expect(hasOutline(font, g)).toBe(true);
    expect(bytes.length).toBeLessThan(60_000);
  });

  it("strokes fallback text in a bold run and fills the rest as usual", () => {
    const pdf = ascii(renderWaiverPdf(sampleWaiver({ operatorName: "Łódź Charters" })));
    expect(pdf).toMatch(
      /q [\d.]+ w\nBT 1 0 0 1 [\d.]+ [\d.]+ Tm\n2 Tr \/F4 [\d.]+ Tf <[0-9A-F]{4}> Tj\n0 Tr \/F2 [\d.]+ Tf \(\\363d\) Tj\n2 Tr \/F4 [\d.]+ Tf <[0-9A-F]{4}> Tj\n0 Tr \/F2 [\d.]+ Tf \( Charters\) Tj\nET Q/,
    );
  });

  it("draws a letter typed with a combining accent as the composed letter", () => {
    const sig = "Mai\u0308a Example";
    const pdf = ascii(
      renderWaiverPdf(
        sampleWaiver({
          participant: { name: sig, minor: false },
          signer: { role: "participant", name: sig, relationship: null },
          signatureText: sig,
        }),
      ),
    );
    expect(pdf).toContain("(Ma\\357a Example)");
    expect(pdf).not.toContain("FontFile2");
  });

  it("masks an address to its first character and domain", () => {
    expect(maskEmail("pat@example.test")).toBe("p•••@example.test");
    expect(maskEmail("broken")).toBe("•••");
  });
});
