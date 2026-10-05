import {
  type BodyFont,
  brandContrastProblems,
  type DisplayFont,
  HexColor,
  primaryInk,
} from "@tidegrid/contracts";
import { bodyFonts, displayFonts } from "./fonts.ts";

/** The theme inputs of a brand: two colors and two fonts. */
export interface BrandTheme {
  colors: { primary: string; accent: string };
  fonts: { display: DisplayFont; body: BodyFont };
}

/** The custom properties a brand sets. Nothing else is ever written. */
export type BrandCssVariables = {
  "--brand-primary": string;
  "--brand-primary-ink": string;
  "--brand-accent": string;
  "--font-display": string;
  "--font-ui": string;
  /** The reading measure calibrated for the body font. */
  "--measure": string;
};

/** The TideGrid theme: Pine Green and Tide Lime, Sora and Inter. */
export const tidegridTheme: BrandTheme = {
  colors: { primary: "#143f2e", accent: "#a7d129" },
  fonts: { display: "sora", body: "inter" },
};

/**
 * Map a brand to the CSS custom properties it may set. The output is built
 * only from validated hex colors and constant font stacks, so tenant data can
 * never place anything else in a style. The checks repeat the contract on
 * purpose: this is the last step before a value reaches the page. Throws on
 * anything the contract would reject.
 */
export function brandCssVariables(theme: BrandTheme): BrandCssVariables {
  const primary = HexColor.parse(theme.colors.primary);
  const accent = HexColor.parse(theme.colors.accent);
  const problems = brandContrastProblems({ primary, accent });
  if (problems.length > 0) throw new RangeError(problems.join("; "));
  if (!Object.hasOwn(displayFonts, theme.fonts.display)) {
    throw new RangeError(`unsupported display font: ${String(theme.fonts.display)}`);
  }
  if (!Object.hasOwn(bodyFonts, theme.fonts.body)) {
    throw new RangeError(`unsupported body font: ${String(theme.fonts.body)}`);
  }
  return {
    "--brand-primary": primary,
    "--brand-primary-ink": primaryInk(primary),
    "--brand-accent": accent,
    "--font-display": displayFonts[theme.fonts.display].stack,
    "--font-ui": bodyFonts[theme.fonts.body].stack,
    "--measure": bodyFonts[theme.fonts.body].measure,
  };
}

/**
 * Apply a brand to a document root and return a function that restores the
 * previous values. Uses the CSSOM, which a style-src policy without
 * 'unsafe-inline' still allows.
 */
export function applyBrandTheme(root: { style: CSSStyleDeclarationLike }, theme: BrandTheme) {
  const variables = brandCssVariables(theme);
  const previous = new Map<string, string>();
  for (const [name, value] of Object.entries(variables)) {
    previous.set(name, root.style.getPropertyValue(name));
    root.style.setProperty(name, value);
  }
  return () => {
    for (const [name, value] of previous) {
      if (value) root.style.setProperty(name, value);
      else root.style.removeProperty(name);
    }
  };
}

/** The part of CSSStyleDeclaration the theme needs, so this module stays DOM-free. */
export interface CSSStyleDeclarationLike {
  getPropertyValue(name: string): string;
  setProperty(name: string, value: string): void;
  removeProperty(name: string): string;
}
