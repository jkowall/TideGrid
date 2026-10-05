import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const css = readFileSync(new URL("./console.css", import.meta.url), "utf8");

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

describe("static files", () => {
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
