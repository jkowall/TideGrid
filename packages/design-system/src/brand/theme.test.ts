import { describe, expect, it } from "vitest";
import {
  applyBrandTheme,
  type BrandTheme,
  bodyFonts,
  brandCssVariables,
  displayFonts,
  tidegridTheme,
} from "./index.ts";

const harbor: BrandTheme = {
  colors: { primary: "#0b3c5d", accent: "#e0a526" },
  fonts: { display: "fraunces", body: "source-sans-3" },
};

describe("brand to CSS variables", () => {
  it("maps a brand to exactly the six brand properties", () => {
    expect(brandCssVariables(harbor)).toEqual({
      "--brand-primary": "#0b3c5d",
      "--brand-primary-ink": "#ffffff",
      "--brand-accent": "#e0a526",
      "--font-display": displayFonts.fraunces.stack,
      "--font-ui": bodyFonts["source-sans-3"].stack,
      "--measure": "26.25em",
    });
  });

  it("maps the TideGrid defaults to the values in tokens.css", () => {
    expect(brandCssVariables(tidegridTheme)).toMatchObject({
      "--brand-primary": "#143f2e",
      "--brand-accent": "#a7d129",
      "--font-display": expect.stringMatching(/^"Sora", /),
      "--font-ui": expect.stringMatching(/^"Inter", /),
      "--measure": "30em",
    });
  });

  it("emits only hex colors and constant font stacks", () => {
    for (const theme of [harbor, tidegridTheme]) {
      const vars = brandCssVariables(theme);
      for (const key of ["--brand-primary", "--brand-primary-ink", "--brand-accent"] as const) {
        expect(vars[key]).toMatch(/^#[0-9a-f]{6}$/);
      }
      expect(Object.values(displayFonts).map((f) => f.stack)).toContain(vars["--font-display"]);
      expect(Object.values(bodyFonts).map((f) => f.stack)).toContain(vars["--font-ui"]);
    }
  });

  it("refuses values that could carry style, and brands that fail contrast", () => {
    const attempts: BrandTheme[] = [
      {
        ...harbor,
        colors: { primary: "#0b3c5d; background: url(https://evil.test)", accent: "#e0a526" },
      },
      { ...harbor, colors: { primary: "var(--x)", accent: "#e0a526" } },
      { ...harbor, colors: { primary: "#a7d129", accent: "#0e2b1f" } },
      { ...harbor, fonts: { display: "x; color: red" as never, body: "inter" } },
      { ...harbor, fonts: { display: "sora", body: "toString" as never } },
      { ...harbor, fonts: { display: "__proto__" as never, body: "inter" } },
    ];
    for (const theme of attempts) expect(() => brandCssVariables(theme)).toThrow();
  });

  it("applies the variables to a root and restores what was there", () => {
    const values = new Map<string, string>([["--brand-primary", "#143f2e"]]);
    const root = {
      style: {
        getPropertyValue: (n: string) => values.get(n) ?? "",
        setProperty: (n: string, v: string) => void values.set(n, v),
        removeProperty: (n: string) => {
          const old = values.get(n) ?? "";
          values.delete(n);
          return old;
        },
      },
    };
    const restore = applyBrandTheme(root, harbor);
    expect(Object.fromEntries(values)).toEqual(brandCssVariables(harbor));
    restore();
    expect(Object.fromEntries(values)).toEqual({ "--brand-primary": "#143f2e" });
  });
});
