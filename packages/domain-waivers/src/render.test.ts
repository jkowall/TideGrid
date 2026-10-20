import { describe, expect, it } from "vitest";
import { maskEmail, renderWaiverPdf, type WaiverDocumentInput } from "./render.ts";

const ascii = (bytes: Uint8Array) => String.fromCharCode(...bytes);

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
    recipientMasked: maskEmail("zoe@example.test"),
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

  it("masks an address to its first character and domain", () => {
    expect(maskEmail("pat@example.test")).toBe("p•••@example.test");
    expect(maskEmail("broken")).toBe("•••");
  });
});
