import type { BodyFont, DisplayFont } from "@tidegrid/contracts";

export interface FontSpec {
  /** The family name declared by the @font-face rules in fonts.css. */
  family: string;
  /** Name shown to people choosing a font. */
  label: string;
  /** Complete font-family value, fallbacks included. Constant, never tenant input. */
  stack: string;
}

/**
 * A body font also sets the reading measure. `ch` is the width of "0", which
 * is far wider than an average letter in these fonts, so `65ch` gave 80 to 98
 * characters a line. The measure is in em instead, calibrated per font.
 */
export interface BodyFontSpec extends FontSpec {
  /**
   * Average advance per character, in em, of TideGrid's own guest and console
   * copy (665 characters, spaces included) set at weight 400 in the
   * self-hosted face. Measured in Chromium on 2026-09-30.
   */
  averageCharWidth: number;
  /**
   * Maximum width of running text: about 65 characters a line, the middle of
   * the 45 to 75 range. `measure / averageCharWidth` stays within 63 to 67.
   */
  measure: `${number}em`;
}

/** Characters a line the measure aims for. */
export const targetCharactersPerLine = 65;

const sans = 'system-ui, -apple-system, "Segoe UI", Roboto, sans-serif';

/** Display fonts: headings and the brand name. */
export const displayFonts: Record<DisplayFont, FontSpec> = {
  sora: { family: "Sora", label: "Sora", stack: `"Sora", ${sans}` },
  fraunces: {
    family: "Fraunces",
    label: "Fraunces",
    stack: '"Fraunces", Georgia, "Times New Roman", serif',
  },
  "bricolage-grotesque": {
    family: "Bricolage Grotesque",
    label: "Bricolage Grotesque",
    stack: `"Bricolage Grotesque", ${sans}`,
  },
};

/** Body fonts: interface and running text. */
export const bodyFonts: Record<BodyFont, BodyFontSpec> = {
  inter: {
    family: "Inter",
    label: "Inter",
    stack: `"Inter", ${sans}`,
    averageCharWidth: 0.4629,
    measure: "30em",
  },
  "source-sans-3": {
    family: "Source Sans 3",
    label: "Source Sans 3",
    stack: `"Source Sans 3", ${sans}`,
    averageCharWidth: 0.4046,
    measure: "26.25em",
  },
  "atkinson-hyperlegible-next": {
    family: "Atkinson Hyperlegible Next",
    label: "Atkinson Hyperlegible Next",
    stack: `"Atkinson Hyperlegible Next", ${sans}`,
    averageCharWidth: 0.4301,
    measure: "28em",
  },
};
