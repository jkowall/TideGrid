import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
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
    const booking = readFileSync(new URL("./booking.css", import.meta.url), "utf8");
    expect(booking).not.toMatch(/max-width:\s*none/);
    expect(booking).toMatch(/\.booking-policy__full dd \{[^}]*max-width: var\(--measure\);/);
  });

  it("uses only the tenant's brand slots on the booking page, never the TideGrid palette", () => {
    const booking = readFileSync(new URL("./booking.css", import.meta.url), "utf8");
    expect(booking).not.toMatch(
      /--tg-(deep-forest|pine-green|tide-lime|harbor)|#a7d129|#143f2e|#0e2b1f/i,
    );
    expect(booking).toMatch(/background: var\(--brand-primary\)/);
  });

  it("never breaks a phone number across lines", () => {
    const css = readFileSync(new URL("./guest.css", import.meta.url), "utf8");
    expect(css).toMatch(/\.guest-phone \{\s*white-space: nowrap;\s*\}/);
    const contact = readFileSync(new URL("./Contact.tsx", import.meta.url), "utf8");
    expect(contact).toContain('Call <span className="guest-phone">{formatPhone(phone)}</span>');
  });

  it("keeps the guest policy strict: no inline script or style, and the API as the only connection", () => {
    const headers = readFileSync(new URL("../public/_headers", import.meta.url), "utf8");
    const policy = /Content-Security-Policy: (.+)/.exec(headers)?.[1] ?? "";
    const directives = new Map(
      policy.split(";").map((d) => {
        const [name = "", ...values] = d.trim().split(/\s+/);
        return [name, values.join(" ")];
      }),
    );
    expect(policy).not.toMatch(/unsafe-inline|unsafe-eval|unsafe-hashes|\*/);
    expect(directives.get("style-src")).toBe("'self'");
    expect(directives.get("script-src")).toBe("'self' https://static.cloudflareinsights.com");
    // The checkout talks to the API and nothing else (the beacon is Cloudflare's).
    expect(directives.get("connect-src")).toBe(
      "'self' https://api.tidegrid.us https://cloudflareinsights.com",
    );
    expect(directives.get("form-action")).toBe("'self'");
    expect(directives.get("frame-ancestors")).toBe("'none'");
  });

  it("keeps checkout secrets out of storage that outlives the tab", () => {
    const sources = readdirSync(new URL("./", import.meta.url), { recursive: true })
      .map(String)
      .filter((name) => /\.(ts|tsx)$/.test(name) && !/\.test\.tsx?$|fixtures\.ts$/.test(name));
    expect(sources.length).toBeGreaterThan(10);
    for (const name of sources) {
      const source = readFileSync(new URL(`./${name}`, import.meta.url), "utf8");
      // Any use in code, not a mention in a comment.
      const local = /\b(localStorage|indexedDB)\s*[.[]|document\.cookie/.test(source);
      expect({ name, local }).toEqual({ name, local: false });
      // Only the resume record touches sessionStorage, and it is scoped to one checkout.
      if (name !== join("booking", "resume.ts")) {
        const session = /\bsessionStorage\s*[.[]/.test(source);
        expect({ name, session }).toEqual({ name, session: false });
      }
    }
  });

  it("wraps the whole app in an error boundary with the designed failure screen", () => {
    const main = readFileSync(new URL("./main.tsx", import.meta.url), "utf8");
    expect(main).toMatch(
      /<ErrorBoundary fallback=\{<CrashedState \/>\}>\s*<App \/>\s*<\/ErrorBoundary>/,
    );
  });
});
