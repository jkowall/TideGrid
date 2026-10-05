import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { contrastRatio } from "@tidegrid/design-system/brand";
import { describe, expect, it } from "vitest";

const css = readFileSync(new URL("./console.css", import.meta.url), "utf8");
const calendarCss = readFileSync(new URL("./calendar/calendar.css", import.meta.url), "utf8");
const tokens = readFileSync(
  createRequire(import.meta.url).resolve("@tidegrid/design-system/tokens.css"),
  "utf8",
);

/** A color token's hex value, as tokens.css declares it. */
function token(name: string): string {
  const value = new RegExp(`${name}:\\s*(#[0-9a-f]{6});`).exec(tokens)?.[1];
  expect(value, name).toBeDefined();
  return value as string;
}

/** A translucent `rgb(r g b / a)` laid over an opaque hex color, as a hex color. */
function over(tint: string, under: string): string {
  const m = /^rgb\((\d+) (\d+) (\d+) \/ ([\d.]+)\)$/.exec(tint);
  expect(m, tint).not.toBeNull();
  const [r, g, b, a] = (m as RegExpExecArray).slice(1).map(Number) as [
    number,
    number,
    number,
    number,
  ];
  const mixed = [r, g, b].map((c, i) => {
    const base = Number.parseInt(under.slice(1 + i * 2, 3 + i * 2), 16);
    return Math.round(a * c + (1 - a) * base)
      .toString(16)
      .padStart(2, "0");
  });
  return `#${mixed.join("")}`;
}

/** The declarations of the first rule for `selector` inside `scope`. */
function rule(scope: string, selector: string): string {
  const start = scope.indexOf(`${selector} {`);
  expect(start, `${selector} rule`).toBeGreaterThanOrEqual(0);
  return scope.slice(start, scope.indexOf("}", start));
}

/** The body of the `@media` block with this exact query. */
function media(query: string): string {
  const start = css.indexOf(`@media ${query} {`);
  expect(start, `@media ${query}`).toBeGreaterThanOrEqual(0);
  let depth = 0;
  for (let i = css.indexOf("{", start); i < css.length; i++) {
    if (css[i] === "{") depth++;
    if (css[i] === "}" && --depth === 0) return css.slice(start, i);
  }
  throw new Error("unbalanced braces");
}

describe("console styles", () => {
  it("keeps the rail at its own height on a short page below desktop", () => {
    expect(rule(media("(max-width: 63.99rem)"), ".console-layout")).toMatch(
      /grid-template-rows:\s*auto 1fr;/,
    );
  });

  it("colors the no-access lock as information, not with the ready color", () => {
    const icon = rule(css, ".console-gate__icon");
    expect(icon).toMatch(/color:\s*var\(--status-info\);/);
    expect(icon).not.toContain("tide-lime");
  });

  it("renders Selected as text, not generated content", () => {
    expect(css).not.toMatch(/content:\s*"Selected"/);
  });
});

describe("calendar styles", () => {
  it("keeps the Today pill's Tide Lime text at 4.5:1 on its tint over Harbor", () => {
    const pill = rule(calendarCss, ".cal-day__today");
    expect(pill).toMatch(/color:\s*var\(--tg-tide-lime\);/);
    const tint = /background:\s*(rgb\([^)]*\));/.exec(pill)?.[1] ?? "";
    const ground = over(tint, token("--tg-harbor"));
    expect(contrastRatio(token("--tg-tide-lime"), ground)).toBeGreaterThanOrEqual(4.5);
  });
});

describe("static files", () => {
  it("allows no inline styles: the console styles only from its files and the CSSOM", () => {
    const headers = readFileSync(new URL("../public/_headers", import.meta.url), "utf8");
    const policy = /Content-Security-Policy: (.+)/.exec(headers)?.[1] ?? "";
    expect(policy).toContain("style-src 'self';");
    expect(policy).not.toContain("'unsafe-inline'");
  });

  it("wraps the whole console in an error boundary with the designed failure screen", () => {
    const main = readFileSync(new URL("./main.tsx", import.meta.url), "utf8");
    expect(main).toMatch(
      /<ErrorBoundary fallback=\{<CrashedConsole \/>\}>\s*<App \/>\s*<\/ErrorBoundary>/,
    );
  });

  it("serves a favicon so /favicon.ico is never a 404", () => {
    const index = readFileSync(new URL("../index.html", import.meta.url), "utf8");
    expect(index).toContain('<link rel="icon" href="/favicon.ico" sizes="32x32" />');
    expect(index).toContain('<link rel="icon" href="/favicon.svg" type="image/svg+xml" />');
    expect(existsSync(new URL("../public/favicon.ico", import.meta.url))).toBe(true);
    const icon = readFileSync(new URL("../public/favicon.svg", import.meta.url), "utf8");
    // The TideGrid mark: a Tide Lime wave on Deep Forest.
    expect(icon).toContain('fill="#0e2b1f"');
    expect(icon).toContain('stroke="#a7d129"');
  });
});
