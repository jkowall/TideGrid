import { describe, expect, it } from "vitest";
import { clean, singleLine } from "./format.ts";

const tab = String.fromCharCode(9);
const lf = String.fromCharCode(10);
const cr = String.fromCharCode(13);
const nel = String.fromCharCode(0x85);
const bell = String.fromCharCode(7);

/** Whether a text holds any C0 or C1 control character. */
const hasControl = (text: string) =>
  [...text].some((ch) => {
    const code = ch.charCodeAt(0);
    return code < 0x20 || (code >= 0x7f && code <= 0x9f);
  });

describe("text from stored data, for email", () => {
  it("makes a one-line field of any control, tab and newline included", () => {
    expect(singleLine(`Sunset${tab}Harbor${lf}Cruise`, 200)).toBe("Sunset Harbor Cruise");
    expect(singleLine(`Reef${cr}${lf}Dive${nel}Two${bell}Tank`, 200)).toBe("Reef Dive Two Tank");
    // Runs of controls and spaces become one space, and the ends are trimmed.
    expect(singleLine(`${tab} Sunset ${lf}${lf} Cruise ${tab}`, 200)).toBe("Sunset Cruise");
    expect(hasControl(singleLine(`a${tab}b${lf}c${nel}d`, 200))).toBe(false);
  });

  it("keeps a body's tab and newline, and still replaces the other controls", () => {
    expect(clean(`Dock C${lf}Slip 14`, 200)).toBe(`Dock C${lf}Slip 14`);
    expect(clean(`Dock C${bell}Slip 14`, 200)).toBe("Dock C Slip 14");
  });

  it("cuts to the limit with an ellipsis, and never answers empty", () => {
    expect(singleLine("a".repeat(250), 200)).toHaveLength(200);
    expect(singleLine("a".repeat(250), 200).endsWith("…")).toBe(true);
    expect(singleLine(`${tab}${lf}`, 200)).toBe("-");
    expect(clean("   ", 200)).toBe("-");
  });
});
