import { describe, expect, it } from "vitest";
import {
  brandContrastProblems,
  contrastRatio,
  guestSurface,
  primaryInk,
  relativeLuminance,
} from "./index.ts";

describe("WCAG contrast computation", () => {
  it("computes relative luminance at the ends of the range and for primaries", () => {
    expect(relativeLuminance("#000000")).toBe(0);
    expect(relativeLuminance("#ffffff")).toBeCloseTo(1, 10);
    expect(relativeLuminance("#ff0000")).toBeCloseTo(0.2126, 4);
    expect(relativeLuminance("#00ff00")).toBeCloseTo(0.7152, 4);
    expect(relativeLuminance("#0000ff")).toBeCloseTo(0.0722, 4);
  });

  it("uses the sRGB transfer function, not a linear scale", () => {
    // #808080 is 50% in sRGB but about 21.6% luminance.
    expect(relativeLuminance("#808080")).toBeCloseTo(0.2159, 3);
    // Below the 0.04045 knee the curve is linear: 10/255 / 12.92.
    expect(relativeLuminance("#0a0a0a")).toBeCloseTo(10 / 255 / 12.92, 6);
  });

  it("matches published reference ratios", () => {
    expect(contrastRatio("#000000", "#ffffff")).toBeCloseTo(21, 6);
    expect(contrastRatio("#ffffff", "#ffffff")).toBe(1);
    // Commonly cited borderline pairs.
    expect(contrastRatio("#767676", "#ffffff")).toBeCloseTo(4.54, 2);
    expect(contrastRatio("#777777", "#ffffff")).toBeCloseTo(4.48, 2);
    expect(contrastRatio("#949494", "#ffffff")).toBeCloseTo(3.03, 2);
  });

  it("is symmetric", () => {
    expect(contrastRatio("#0b3c5d", "#e0a526")).toBe(contrastRatio("#e0a526", "#0b3c5d"));
  });

  it("refuses anything but six-digit lowercase hex", () => {
    for (const bad of ["#FFF", "#FFFFFF", "fff", "#fffffff", "red", "rgb(0,0,0)", ""]) {
      expect(() => relativeLuminance(bad)).toThrow(TypeError);
    }
  });

  it("chooses white or Deep Forest ink, whichever contrasts more", () => {
    expect(primaryInk("#0b3c5d")).toBe("#ffffff");
    expect(primaryInk("#ffd166")).toBe(guestSurface.ink);
  });

  it("reports each failing brand rule with the measured ratio", () => {
    expect(brandContrastProblems({ primary: "#0b3c5d", accent: "#e0a526" })).toEqual([]);
    // Too light for the Foam page: about 1.66:1, printed rounded down.
    const lime = brandContrastProblems({ primary: "#a7d129", accent: "#0e2b1f" });
    expect(lime.some((p) => /^Primary #a7d129 has 1\.6\d:1 contrast with the page/.test(p))).toBe(
      true,
    );
    // Rounding down never prints a failing ratio as the threshold, across the
    // grays that straddle 4.5:1 on the page.
    for (let v = 0x60; v <= 0x80; v++) {
      const gray = `#${v.toString(16).repeat(3)}`;
      const onPage = contrastRatio(gray, guestSurface.page);
      const message = brandContrastProblems({ primary: gray, accent: "#ffffff" })[0] ?? "";
      expect({ gray, fails: onPage < 4.5 }).toEqual({ gray, fails: message.startsWith("Primary") });
      if (onPage < 4.5) expect(message).not.toContain("4.50:1");
    }
    // Malformed colors are the field validator's to report, not a crash here.
    expect(brandContrastProblems({ primary: "#0B3C5D", accent: "nope" })).toEqual([]);
    // Accent too close to the primary.
    const dull = brandContrastProblems({ primary: "#0b3c5d", accent: "#1d4e70" });
    expect(dull).toHaveLength(1);
    expect(dull[0]).toMatch(/^Accent #1d4e70 has 1\.\d\d:1 contrast with primary/);
  });
});
