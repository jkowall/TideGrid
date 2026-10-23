/**
 * Waiver content: the text a signer reads and agrees to, its canonical form,
 * and its SHA-256. The database computes the same hash when a version is
 * written (app.check_waiver_template_version in the waiver migration), so the
 * service never chooses it; this module lets the service and tests compute and
 * check it. Pure and dependency-free; runs in Workers and Node.
 */
import { isWinAnsiLine } from "./pdf.ts";

export const CONTENT_FORMAT = "tidegrid.waiver.content.v1";

/** The parts of a version a signer reads. */
export interface WaiverText {
  title: string;
  /** Paragraphs separated by blank lines; single newlines break lines. Plain text. */
  body: string;
  /** Each one is a separate box the signer checks. */
  acknowledgments: string[];
}

const encoder = new TextEncoder();
const byteLength = (text: string) => encoder.encode(text).length;

/**
 * The canonical content: a format line, then the title, the body, and each
 * acknowledgment in order, each as "<label>:<UTF-8 byte length>:<text>" on its
 * own line. The length prefix keeps the parts unambiguous whatever they hold.
 */
export function canonicalWaiverContent(text: WaiverText): string {
  return [
    CONTENT_FORMAT,
    `title:${byteLength(text.title)}:${text.title}`,
    `body:${byteLength(text.body)}:${text.body}`,
    ...text.acknowledgments.map((a) => `ack:${byteLength(a)}:${a}`),
  ].join("\n");
}

export async function sha256Hex(data: string | Uint8Array): Promise<string> {
  const bytes = typeof data === "string" ? encoder.encode(data) : data;
  const digest = await crypto.subtle.digest("SHA-256", bytes as Uint8Array<ArrayBuffer>);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** The content hash the database stores for a version with this text. */
export function waiverContentSha256(text: WaiverText): Promise<string> {
  return sha256Hex(canonicalWaiverContent(text));
}

/** Body paragraphs, in order; each paragraph's lines in order. */
export function bodyParagraphs(body: string): string[][] {
  return body
    .split(/\n{2,}/)
    .map((p) => p.split("\n").map((line) => line.trim()))
    .filter((lines) => lines.some((l) => l.length > 0));
}

export type WaiverTextField = "title" | "body" | "acknowledgments";

export interface WaiverTextProblem {
  field: WaiverTextField;
  code: "required" | "too_long" | "too_many" | "control_characters" | "unprintable";
  message: string;
}

// biome-ignore lint/suspicious/noControlCharactersInRegex: the pattern exists to find them.
const controlChars = /[\u0000-\u001f\u007f]/;
// biome-ignore lint/suspicious/noControlCharactersInRegex: newlines are allowed in a body.
const bodyControlChars = /[\u0000-\u0009\u000b-\u001f\u007f]/;

/**
 * The text as stored: Unicode NFC, line endings as \n, no trailing spaces on
 * a line, at most one blank line between paragraphs, and trimmed parts.
 */
export function normalizeWaiverText(text: WaiverText): WaiverText {
  const clean = (s: string) => s.normalize("NFC").trim();
  const body = text.body
    .normalize("NFC")
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .map((line) => line.replace(/[ \t]+$/g, ""))
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return {
    title: clean(text.title).replace(/\s+/g, " "),
    body,
    acknowledgments: text.acknowledgments.map((a) => clean(a).replace(/\s+/g, " ")),
  };
}

/**
 * What a version's text must be. Every character must be one the PDF shows
 * exactly (WinAnsi), so the signed document never differs from what the
 * signer read. Apply to normalized text.
 */
export function validateWaiverText(text: WaiverText): WaiverTextProblem[] {
  const problems: WaiverTextProblem[] = [];
  if (text.title.length === 0) {
    problems.push({ field: "title", code: "required", message: "A waiver needs a title" });
  } else if (text.title.length > 120) {
    problems.push({
      field: "title",
      code: "too_long",
      message: "Keep the title to 120 characters",
    });
  } else if (controlChars.test(text.title)) {
    problems.push({
      field: "title",
      code: "control_characters",
      message: "The title is one line of text",
    });
  } else if (!isWinAnsiLine(text.title)) {
    problems.push({
      field: "title",
      code: "unprintable",
      message: "The title has a character the signed PDF cannot show",
    });
  }
  if (text.body.length === 0) {
    problems.push({ field: "body", code: "required", message: "A waiver needs its text" });
  } else if (text.body.length > 20_000) {
    problems.push({
      field: "body",
      code: "too_long",
      message: "Keep the text to 20,000 characters",
    });
  } else if (bodyControlChars.test(text.body)) {
    problems.push({
      field: "body",
      code: "control_characters",
      message: "The text holds characters that are not printable",
    });
  } else if (!text.body.split("\n").every(isWinAnsiLine)) {
    problems.push({
      field: "body",
      code: "unprintable",
      message: "The text has a character the signed PDF cannot show",
    });
  }
  if (text.acknowledgments.length === 0) {
    problems.push({
      field: "acknowledgments",
      code: "required",
      message: "A waiver needs at least one acknowledgment",
    });
  } else if (text.acknowledgments.length > 10) {
    problems.push({
      field: "acknowledgments",
      code: "too_many",
      message: "A waiver has at most 10 acknowledgments",
    });
  }
  for (const ack of text.acknowledgments) {
    if (ack.length === 0) {
      problems.push({
        field: "acknowledgments",
        code: "required",
        message: "An acknowledgment cannot be empty",
      });
    } else if (ack.length > 300) {
      problems.push({
        field: "acknowledgments",
        code: "too_long",
        message: "Keep each acknowledgment to 300 characters",
      });
    } else if (controlChars.test(ack)) {
      problems.push({
        field: "acknowledgments",
        code: "control_characters",
        message: "Each acknowledgment is one line of text",
      });
    } else if (!isWinAnsiLine(ack)) {
      problems.push({
        field: "acknowledgments",
        code: "unprintable",
        message: "An acknowledgment has a character the signed PDF cannot show",
      });
    }
  }
  return problems;
}
