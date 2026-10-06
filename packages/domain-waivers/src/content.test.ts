import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  bodyParagraphs,
  canonicalWaiverContent,
  normalizeWaiverText,
  validateWaiverText,
  waiverContentSha256,
} from "./content.ts";
import {
  hashWaiverSession,
  hashWaiverToken,
  newWaiverSecret,
  waiverSecretPattern,
} from "./secrets.ts";

const text = {
  title: "Participation waiver",
  body: "First paragraph.\nA second line.\n\nZoë’s paragraph.",
  acknowledgments: ["I read it.", "I accept the risks."],
};

describe("canonical content", () => {
  it("prefixes each part with its UTF-8 byte length, one part per line", () => {
    expect(canonicalWaiverContent(text)).toBe(
      [
        "tidegrid.waiver.content.v1",
        "title:20:Participation waiver",
        // ë and ’ take 2 and 3 bytes.
        "body:52:First paragraph.\nA second line.\n\nZoë’s paragraph.",
        "ack:10:I read it.",
        "ack:19:I accept the risks.",
      ].join("\n"),
    );
  });

  it("hashes the canonical content with SHA-256", async () => {
    const expected = createHash("sha256")
      .update(canonicalWaiverContent(text), "utf8")
      .digest("hex");
    expect(await waiverContentSha256(text)).toBe(expected);
  });

  it("cannot be made ambiguous by moving text between parts", async () => {
    const a = await waiverContentSha256({ title: "A", body: "B\nack:1:C", acknowledgments: ["D"] });
    const b = await waiverContentSha256({ title: "A", body: "B", acknowledgments: ["C", "D"] });
    expect(a).not.toBe(b);
  });
});

describe("normalizing and validating", () => {
  it("normalizes line endings, spacing, and blank lines", () => {
    const normal = normalizeWaiverText({
      title: "  Two   spaces ",
      body: "Line one  \r\nLine two\r\n\r\n\r\n\r\nNexté",
      acknowledgments: ["  I  agree  "],
    });
    expect(normal).toEqual({
      title: "Two spaces",
      body: "Line one\nLine two\n\nNexté",
      acknowledgments: ["I agree"],
    });
  });

  it("accepts text the PDF shows exactly and refuses what it cannot", () => {
    expect(validateWaiverText(text)).toEqual([]);
    const codes = (t: Partial<typeof text>) =>
      validateWaiverText({ ...text, ...t }).map((p) => `${p.field}:${p.code}`);
    expect(codes({ title: "" })).toEqual(["title:required"]);
    expect(codes({ title: "x".repeat(121) })).toEqual(["title:too_long"]);
    expect(codes({ title: "Łódź" })).toEqual(["title:unprintable"]);
    expect(codes({ body: "Tab\there" })).toEqual(["body:control_characters"]);
    expect(codes({ body: "Emoji 😀" })).toEqual(["body:unprintable"]);
    expect(codes({ acknowledgments: [] })).toEqual(["acknowledgments:required"]);
    expect(codes({ acknowledgments: Array(11).fill("x") })).toEqual(["acknowledgments:too_many"]);
    expect(codes({ acknowledgments: ["two\nlines"] })).toEqual([
      "acknowledgments:control_characters",
    ]);
  });

  it("splits the body into paragraphs of lines", () => {
    expect(bodyParagraphs(text.body)).toEqual([
      ["First paragraph.", "A second line."],
      ["Zoë’s paragraph."],
    ]);
  });
});

describe("secrets", () => {
  it("makes 43-character base64url secrets and hashes them under a purpose label", async () => {
    const secret = newWaiverSecret();
    expect(secret).toMatch(waiverSecretPattern);
    expect(newWaiverSecret()).not.toBe(secret);
    const token = await hashWaiverToken(secret);
    const session = await hashWaiverSession(secret);
    expect(token).toMatch(/^[0-9a-f]{64}$/);
    expect(token).not.toBe(session);
    expect(token).toBe(createHash("sha256").update(`waiver-token:${secret}`).digest("hex"));
    await expect(hashWaiverToken("short")).rejects.toThrow(TypeError);
  });
});
