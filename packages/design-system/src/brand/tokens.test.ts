import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  bodyFontIds,
  bodyFonts,
  contrastRatio,
  displayFontIds,
  displayFonts,
  targetCharactersPerLine,
} from "./index.ts";

const css = (name: string) => readFileSync(new URL(`../${name}`, import.meta.url), "utf8");

/** Custom properties declared in one rule block of tokens.css. */
function block(source: string, selector: string): Map<string, string> {
  const start = source.indexOf(`${selector} {`);
  if (start < 0) throw new Error(`no ${selector} block`);
  const body = source.slice(start, source.indexOf("\n}", start));
  const declarations = new Map<string, string>();
  for (const m of body.matchAll(/(--[a-z0-9-]+):\s*([^;]+);/g)) {
    declarations.set(m[1] as string, (m[2] as string).trim());
  }
  return declarations;
}

const tokens = css("tokens.css");
const root = block(tokens, ":root");
const dark = new Map([...root, ...block(tokens, ".tg-dark")]);

/** Resolve a token to a hex color through var() references in its scope. */
function hex(scope: Map<string, string>, name: string, depth = 0): string {
  const value = scope.get(name);
  if (!value || depth > 8) throw new Error(`unresolved ${name}`);
  const ref = /^var\((--[a-z0-9-]+)\)$/.exec(value);
  if (ref) return hex(scope, ref[1] as string, depth + 1);
  if (!/^#[0-9a-f]{6}$/.test(value)) throw new Error(`${name} is not a plain hex color: ${value}`);
  return value;
}

function expectContrast(scope: Map<string, string>, fg: string, bg: string, min: number) {
  const ratio = contrastRatio(hex(scope, fg), hex(scope, bg));
  expect({ pair: `${fg} on ${bg}`, passes: ratio >= min }).toEqual({
    pair: `${fg} on ${bg}`,
    passes: true,
  });
}

const statuses = ["ready", "warning", "blocked", "info", "pending"];

describe("token contrast, light guest surfaces", () => {
  const surfaces = ["--surface-page", "--surface-raised", "--surface-sunken"];

  it("keeps body and muted text at 4.5:1 on every light surface", () => {
    for (const bg of surfaces) {
      for (const fg of ["--text-strong", "--text-body", "--text-muted"])
        expectContrast(root, fg, bg, 4.5);
    }
  });

  it("keeps control borders and the focus ring at 3:1", () => {
    for (const bg of ["--surface-page", "--surface-raised"]) {
      expectContrast(root, "--border-control", bg, 3);
      expectContrast(root, "--focus-color", bg, 3);
    }
  });

  it("keeps status colors readable as text on the page and on cards", () => {
    for (const s of statuses) {
      expectContrast(root, `--status-${s}`, "--surface-page", 4.5);
      expectContrast(root, `--status-${s}`, "--surface-raised", 4.5);
    }
  });

  it("never lets Tide Lime pass as text on a light surface", () => {
    expect(contrastRatio(hex(root, "--tg-tide-lime"), hex(root, "--tg-foam"))).toBeLessThan(3);
  });

  it("keeps the danger action readable in every state and visible on cards", () => {
    expectContrast(root, "--action-danger-ink", "--action-danger-bg", 4.5);
    expectContrast(root, "--action-danger-ink", "--action-danger-bg-hover", 4.5);
    expectContrast(root, "--action-danger-bg", "--surface-raised", 3);
  });
});

describe("token contrast, dark console", () => {
  const surfaces = ["--surface-page", "--surface-raised", "--surface-sunken", "--tg-deep-forest"];

  it("keeps text at 4.5:1 on the Harbor content, cards, inputs, and the Deep Forest rail", () => {
    for (const bg of surfaces) {
      for (const fg of ["--text-strong", "--text-body", "--text-muted", "--link"]) {
        expectContrast(dark, fg, bg, 4.5);
      }
    }
  });

  it("keeps control borders and the focus ring at 3:1", () => {
    for (const bg of surfaces) {
      expectContrast(dark, "--border-control", bg, 3);
      expectContrast(dark, "--focus-color", bg, 3);
    }
  });

  it("keeps the Tide Lime action readable in every state", () => {
    expectContrast(dark, "--action-ink", "--action-bg", 4.5);
    expectContrast(dark, "--action-ink", "--action-bg-hover", 4.5);
    expectContrast(dark, "--action-bg", "--surface-page", 3);
  });

  it("keeps the danger action readable in every state and visible in a dialog", () => {
    expectContrast(dark, "--action-danger-ink", "--action-danger-bg", 4.5);
    expectContrast(dark, "--action-danger-ink", "--action-danger-bg-hover", 4.5);
    expectContrast(dark, "--action-danger-bg", "--surface-raised", 3);
  });

  it("uses the light-on-dark status variants", () => {
    for (const s of statuses) {
      for (const bg of surfaces) expectContrast(dark, `--status-${s}`, bg, 4.5);
    }
  });
});

describe("self-hosted fonts", () => {
  const faces = css("fonts.css");
  const declared = new Set([...faces.matchAll(/font-family:\s*"([^"]+)"/g)].map((m) => m[1]));

  it("declares a face for every font the contract allows, and no others", () => {
    expect(Object.keys(displayFonts).sort()).toEqual([...displayFontIds].sort());
    expect(Object.keys(bodyFonts).sort()).toEqual([...bodyFontIds].sort());
    const families = [...Object.values(displayFonts), ...Object.values(bodyFonts)].map(
      (f) => f.family,
    );
    expect([...declared].sort()).toEqual([...families].sort());
    for (const f of [...Object.values(displayFonts), ...Object.values(bodyFonts)]) {
      expect(f.stack.startsWith(`"${f.family}", `)).toBe(true);
    }
  });

  it("loads every face from a bundled package file, never from another origin", () => {
    const urls = [...faces.matchAll(/url\("([^"]+)"\)/g)].map((m) => m[1] as string);
    expect(urls.length).toBe(declared.size * 2);
    for (const url of urls) {
      expect(url).toMatch(/^@fontsource-variable\/[a-z0-9-]+\/files\/[a-z0-9-]+\.woff2$/);
    }
    expect(faces).not.toMatch(/https?:|@import|local\(/);
    expect(css("base.css")).not.toMatch(/https?:/);
  });

  it("uses only OFL-licensed packages", () => {
    const pkg = JSON.parse(css("../package.json")) as { dependencies: Record<string, string> };
    const fontPackages = Object.keys(pkg.dependencies).filter((d) => d.startsWith("@fontsource"));
    expect(fontPackages.length).toBe(6);
    for (const name of fontPackages) {
      const meta = JSON.parse(
        readFileSync(new URL(`../../node_modules/${name}/package.json`, import.meta.url), "utf8"),
      ) as { license: string };
      expect({ name, license: meta.license }).toEqual({ name, license: "OFL-1.1" });
    }
  });
});

describe("motion", () => {
  it("stops every design-system animation when reduced motion is requested", () => {
    const components = css("components.css");
    const animated = [...components.matchAll(/\.([a-z-]+)\s*\{[^}]*animation:\s*tg-/g)].map(
      (m) => m[1] as string,
    );
    expect(animated.sort()).toEqual(["tg-skeleton", "tg-spinner"]);
    const reduced = [
      ...components.matchAll(/@media \(prefers-reduced-motion: reduce\) \{([\s\S]*?)\n\}/g),
    ]
      .map((m) => m[1])
      .join("\n");
    for (const name of animated) {
      expect(reduced).toMatch(new RegExp(`\\.${name}\\s*\\{[^}]*animation:\\s*none`));
    }
    // The base sheet also shortens any other animation or transition, and it
    // has to win: a zero-specificity :where() rule loses to every component's
    // own transition, so each declaration is !important instead.
    const base = css("base.css");
    const start = base.indexOf("@media (prefers-reduced-motion: reduce) {");
    expect(start).toBeGreaterThanOrEqual(0);
    const rule = base.slice(start, base.indexOf("\n}", start));
    expect(rule).not.toContain(":where(");
    expect(rule).toMatch(/\{\s*\*,\s*\*::before,\s*\*::after\s*\{/);
    for (const declaration of [
      "animation-duration: 0.01ms !important;",
      "animation-iteration-count: 1 !important;",
      "transition-duration: 0.01ms !important;",
      "scroll-behavior: auto !important;",
    ]) {
      expect(rule).toContain(declaration);
    }
  });
});

describe("reading measure", () => {
  it("gives each body font an em measure of about 65 characters a line", () => {
    for (const [id, font] of Object.entries(bodyFonts)) {
      expect(font.measure, id).toMatch(/^\d+(\.\d+)?em$/);
      const characters = Number.parseFloat(font.measure) / font.averageCharWidth;
      expect(Math.abs(characters - targetCharactersPerLine), id).toBeLessThanOrEqual(2);
    }
  });

  it("defaults to Inter's measure and never measures running text in ch", () => {
    expect(root.get("--measure")).toBe(bodyFonts.inter.measure);
    for (const name of ["tokens.css", "base.css", "components.css"]) {
      expect(css(name), name).not.toMatch(/--measure:\s*[\d.]+ch|max-width:\s*[\d.]+ch/);
    }
    expect(css("base.css")).toMatch(/\np \{[^}]*max-width: var\(--measure\);/);
  });
});
