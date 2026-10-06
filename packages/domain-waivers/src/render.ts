/**
 * The signed waiver as a PDF (rendering version 1): what the signer read, what
 * they accepted, their typed signature, and the signing record, laid out on
 * US Letter pages with a footer on each. Deterministic: the same evidence
 * always gives the same bytes. Pure; runs in Workers and Node.
 */
import { bodyParagraphs } from "./content.ts";
import {
  PAGE_HEIGHT,
  PAGE_WIDTH,
  type PdfFont,
  type PdfPage,
  textWidth,
  wrapText,
  writePdf,
} from "./pdf.ts";

export const RENDERING_VERSION = 1;

export type SignerRole = "participant" | "guardian";
export type GuardianRelationship = "parent" | "legal_guardian";

export interface WaiverDocumentInput {
  operatorName: string;
  title: string;
  version: number;
  contentSha256: string;
  body: string;
  acknowledgments: readonly string[];
  trip: {
    name: string;
    /** When it departs, on the marina's clock, as a person reads it. */
    when: string;
    /** Where it leaves from. */
    place: string;
    bookingReference: string;
  };
  participant: { name: string; minor: boolean };
  signer: { role: SignerRole; name: string; relationship: GuardianRelationship | null };
  signatureText: string;
  consentText: string;
  signedAt: Date;
  /** The signing instant on the marina's clock, as a person reads it. */
  signedAtLocal: string;
  evidenceId: string;
  requestId: string;
  /** The address the link went to, masked. */
  recipientMasked: string;
  sourceIp: string | null;
  userAgent: string | null;
}

const MARGIN = 54;
const CONTENT_WIDTH = PAGE_WIDTH - 2 * MARGIN;
const TOP = PAGE_HEIGHT - MARGIN;
const BOTTOM = MARGIN + 20;
const LABEL_WIDTH = 112;

interface LineStyle {
  font?: PdfFont;
  size?: number;
  leading?: number;
  x?: number;
}

/** A top-to-bottom flow of lines across pages. `y` is the top of the next line. */
class Flow {
  readonly pages: PdfPage[] = [];
  private page: PdfPage;
  private y = TOP;

  constructor() {
    this.page = { texts: [], rules: [] };
    this.pages.push(this.page);
  }

  /** Start a new page unless `height` more fits on this one. */
  keep(height: number): void {
    if (this.y - height >= BOTTOM) return;
    this.page = { texts: [], rules: [] };
    this.pages.push(this.page);
    this.y = TOP;
  }

  gap(height: number): void {
    this.y -= height;
  }

  line(text: string, style: LineStyle = {}): void {
    const size = style.size ?? 10;
    const leading = style.leading ?? size * 1.45;
    this.keep(leading);
    const baseline = this.y - size;
    this.page.texts.push({
      x: style.x ?? MARGIN,
      y: baseline,
      font: style.font ?? "regular",
      size,
      text,
    });
    this.y -= leading;
  }

  wrapped(text: string, style: LineStyle & { width?: number } = {}): void {
    const font = style.font ?? "regular";
    const size = style.size ?? 10;
    const width = style.width ?? CONTENT_WIDTH - ((style.x ?? MARGIN) - MARGIN);
    for (const l of wrapText(text, font, size, width)) this.line(l, style);
  }

  /** A label and its value side by side; the value wraps under itself. */
  field(label: string, value: string, size = 9): void {
    const leading = size * 1.5;
    const lines = wrapText(value, "regular", size, CONTENT_WIDTH - LABEL_WIDTH);
    this.keep(leading * Math.min(lines.length, 2));
    lines.forEach((l, i) => {
      this.keep(leading);
      const baseline = this.y - size;
      if (i === 0) {
        this.page.texts.push({ x: MARGIN, y: baseline, font: "bold", size, text: label });
      }
      this.page.texts.push({
        x: MARGIN + LABEL_WIDTH,
        y: baseline,
        font: "regular",
        size,
        text: l,
      });
      this.y -= leading;
    });
  }

  /** A box the signer checked, then its text, hanging under itself. */
  checked(text: string, size = 10): void {
    const leading = size * 1.45;
    const indent = 24;
    const lines = wrapText(text, "regular", size, CONTENT_WIDTH - indent);
    this.keep(leading * Math.min(lines.length, 2));
    lines.forEach((l, i) => {
      this.keep(leading);
      const baseline = this.y - size;
      if (i === 0) {
        this.page.texts.push({ x: MARGIN, y: baseline, font: "bold", size, text: "[X]" });
      }
      this.page.texts.push({ x: MARGIN + indent, y: baseline, font: "regular", size, text: l });
      this.y -= leading;
    });
  }

  rule(width = 0.5, from = MARGIN, to = MARGIN + CONTENT_WIDTH): void {
    this.keep(10);
    this.y -= 5;
    this.page.rules.push({ x1: from, y1: this.y, x2: to, y2: this.y, width });
    this.y -= 5;
  }

  heading(text: string): void {
    // Never leave a heading alone at the foot of a page.
    this.keep(16 + 2 * 15);
    this.gap(6);
    this.line(text, { font: "bold", size: 11.5, leading: 18 });
  }
}

function capacity(input: WaiverDocumentInput): string {
  if (input.signer.role === "participant") return "Participant, signing for themselves";
  const relation = input.signer.relationship === "legal_guardian" ? "Legal guardian" : "Parent";
  return `${relation} of ${input.participant.name}, a minor`;
}

/** The PDF of one signed waiver. */
export function renderWaiverPdf(input: WaiverDocumentInput): Uint8Array {
  const flow = new Flow();
  flow.line(input.operatorName, { font: "bold", size: 10, leading: 16 });
  flow.wrapped(input.title, { font: "bold", size: 18, leading: 24 });
  flow.line(`Version ${input.version}. Signed ${input.signedAtLocal}.`, { size: 9.5, leading: 15 });
  flow.rule(0.75);

  flow.field("Trip", input.trip.name);
  flow.field("Departs", input.trip.when);
  flow.field("From", input.trip.place);
  flow.field("Booking", input.trip.bookingReference);
  flow.field(
    "Participant",
    input.participant.minor ? `${input.participant.name} (a minor)` : input.participant.name,
  );
  flow.rule();

  for (const paragraph of bodyParagraphs(input.body)) {
    for (const l of paragraph) flow.wrapped(l, { size: 10.5, leading: 15 });
    flow.gap(7);
  }

  flow.heading("Acknowledgments");
  for (const ack of input.acknowledgments) flow.checked(ack);

  flow.heading("Electronic signature");
  flow.checked(input.consentText);

  flow.heading("Signature");
  flow.keep(80);
  flow.gap(4);
  flow.line(input.signatureText, { font: "oblique", size: 18, leading: 22 });
  flow.rule(0.75, MARGIN, MARGIN + 300);
  flow.line(input.signer.name, { font: "bold", size: 10, leading: 14 });
  flow.line(capacity(input), { size: 9.5, leading: 14 });
  flow.line(`Signed ${input.signedAtLocal}`, { size: 9.5, leading: 14 });

  flow.heading("Signing record");
  flow.field("Evidence", input.evidenceId, 8.5);
  flow.field("Waiver request", input.requestId, 8.5);
  flow.field("Waiver version", `${input.title}, version ${input.version}`, 8.5);
  flow.field("Content SHA-256", input.contentSha256, 8.5);
  flow.field(
    "How it was reached",
    `A single-use link emailed to ${input.recipientMasked}, opened by an explicit request; the signer confirmed who they are and who they signed for`,
    8.5,
  );
  flow.field("Signed at (UTC)", input.signedAt.toISOString(), 8.5);
  flow.field("IP address", input.sourceIp ?? "Not recorded", 8.5);
  flow.field("Device", input.userAgent ?? "Not recorded", 8.5);
  flow.field("Rendering", `TideGrid waiver renderer ${RENDERING_VERSION}`, 8.5);

  const total = flow.pages.length;
  const left = `${input.operatorName}. ${input.title}, version ${input.version}.`;
  flow.pages.forEach((page, i) => {
    const right = `Page ${i + 1} of ${total}`;
    const size = 8;
    const leftLines = wrapText(left, "regular", size, CONTENT_WIDTH - 90);
    page.texts.push({ x: MARGIN, y: MARGIN - 8, font: "regular", size, text: leftLines[0] ?? "" });
    page.texts.push({
      x: MARGIN + CONTENT_WIDTH - textWidth(right, "regular", size),
      y: MARGIN - 8,
      font: "regular",
      size,
      text: right,
    });
  });

  return writePdf({
    title: `${input.title} (version ${input.version})`,
    creationDate: input.signedAt,
    pages: flow.pages,
  });
}

/** An address shown without giving it away: its first character and its domain. */
export function maskEmail(email: string): string {
  const at = email.lastIndexOf("@");
  if (at <= 0) return "•••";
  return `${email.slice(0, 1)}•••${email.slice(at)}`;
}
