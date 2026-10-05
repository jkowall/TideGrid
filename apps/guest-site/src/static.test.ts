import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("static files", () => {
  it("serves a neutral favicon so /favicon.ico is never a 404", () => {
    const index = readFileSync(new URL("../index.html", import.meta.url), "utf8");
    expect(index).toContain('<link rel="icon" href="/favicon.ico" sizes="32x32" />');
    expect(index).toContain('<link rel="icon" href="/favicon.svg" type="image/svg+xml" />');
    expect(existsSync(new URL("../public/favicon.ico", import.meta.url))).toBe(true);
    const icon = readFileSync(new URL("../public/favicon.svg", import.meta.url), "utf8");
    // Neutral: the TideGrid palette's muted ink, not an operator's or TideGrid's brand color.
    expect(icon).toContain('fill="#52615a"');
    expect(icon).not.toMatch(/#a7d129|#143f2e|#0e2b1f/i);
  });

  it("sets running text at the brand's reading measure, never wider", () => {
    const css = readFileSync(new URL("./guest.css", import.meta.url), "utf8");
    expect(css).toMatch(/\.guest-hero__tagline \{[^}]*max-width: var\(--measure\);/);
    // A paragraph with no maximum ran to 82 characters in the footer.
    expect(css).not.toMatch(/max-width:\s*none/);
  });

  it("never breaks a phone number across lines", () => {
    const css = readFileSync(new URL("./guest.css", import.meta.url), "utf8");
    expect(css).toMatch(/\.guest-phone \{\s*white-space: nowrap;\s*\}/);
    const contact = readFileSync(new URL("./Contact.tsx", import.meta.url), "utf8");
    expect(contact).toContain('Call <span className="guest-phone">{formatPhone(phone)}</span>');
  });

  it("wraps the whole app in an error boundary with the designed failure screen", () => {
    const main = readFileSync(new URL("./main.tsx", import.meta.url), "utf8");
    expect(main).toMatch(
      /<ErrorBoundary fallback=\{<CrashedState \/>\}>\s*<App \/>\s*<\/ErrorBoundary>/,
    );
  });
});
