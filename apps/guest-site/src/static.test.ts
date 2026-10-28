import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { previewHostnameFor } from "@tidegrid/tenant-config";
import { loadTenantManifests } from "@tidegrid/tenant-config/node";
import { describe, expect, it } from "vitest";
import { precacheFrom } from "../vite.config.ts";

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
    // The page fetches only from the API. 'self' is for Cloudflare Web Analytics:
    // its automatically injected beacon reports to this site's own /cdn-cgi/rum,
    // as https://developers.cloudflare.com/web-analytics/faq/ says;
    // cloudflareinsights.com takes the manually added beacon's reports.
    expect(directives.get("connect-src")).toBe(
      "'self' https://api.tidegrid.us https://cloudflareinsights.com",
    );
    expect(directives.get("form-action")).toBe("'self'");
    expect(directives.get("frame-ancestors")).toBe("'none'");
    // G2.14b: explicit, so neither falls back to script-src and admits the
    // analytics host as a worker or manifest source.
    expect(directives.get("worker-src")).toBe("'self'");
    expect(directives.get("manifest-src")).toBe("'self'");
  });

  it("serves sw.js uncached and hashed assets immutable (G2.14b)", () => {
    const headers = readFileSync(new URL("../public/_headers", import.meta.url), "utf8");
    expect(headers).toMatch(
      /\n\/sw\.js\n {2}Cache-Control: no-cache\n {2}Content-Type: text\/javascript/,
    );
    expect(headers).toMatch(
      /\n\/assets\/\*\n {2}Cache-Control: public, max-age=31536000, immutable\n/,
    );
    const index = readFileSync(new URL("../index.html", import.meta.url), "utf8");
    expect(index).toContain('<link rel="manifest" href="/manifest.webmanifest" />');
    // No apple-touch-icon under D3(a): the Worker serves SVG icons only.
    expect(index).not.toContain("apple-touch-icon");
  });

  it("keeps the offline page neutral: no tenant, no script, no API (G2.14b)", () => {
    const offline = readFileSync(new URL("../neutral-offline.html", import.meta.url), "utf8");
    expect(offline).not.toMatch(/<script|api\.tidegrid\.us|demo-harbor|demo-reef|{{/);
    expect(offline).toContain("Booking needs a connection");
  });

  /** Every non-test source the guest site ships: the page and the edge Worker. */
  function shippedSources(): { name: string; source: string }[] {
    const roots = [new URL("./", import.meta.url), new URL("../worker/", import.meta.url)];
    return roots.flatMap((root) =>
      readdirSync(root, { recursive: true })
        .map(String)
        .filter((name) => /\.(ts|tsx)$/.test(name) && !/\.test\.tsx?$|fixtures\.ts$/.test(name))
        .map((name) => ({
          name: root.pathname.endsWith("/worker/") ? join("..", "worker", name) : name,
          source: readFileSync(new URL(name, root), "utf8"),
        })),
    );
  }

  it("scans the edge Worker as well as the page", () => {
    const names = shippedSources().map((s) => s.name);
    expect(names).toContain(join("..", "worker", "index.ts"));
    expect(names).toContain(join("sw", "sw.ts"));
  });

  it("confines the service worker and cache APIs to the service worker and its registration (G2.14b)", () => {
    const allowed = new Set([
      join("sw", "sw.ts"),
      join("sw", "kill-switch.ts"),
      join("sw", "register.ts"),
    ]);
    for (const { name, source } of shippedSources()) {
      const uses = /\bcaches\s*\.|navigator\.serviceWorker|\bserviceWorker\s*\./.test(source);
      expect({ name, uses }).toEqual({ name, uses: uses && allowed.has(name) });
    }
  });

  it("keeps checkout secrets out of storage that outlives the tab", () => {
    const sources = shippedSources();
    expect(sources.length).toBeGreaterThan(10);
    for (const { name, source } of sources) {
      // Any use in code, not a mention in a comment.
      const local = /\b(localStorage|indexedDB)\s*[.[]|document\.cookie/.test(source);
      expect({ name, local }).toEqual({ name, local: false });
      // Only resume.ts touches sessionStorage (one open checkout, and the last
      // confirmation), manage/session.ts (one booking session, lane 1), and
      // waiver/session.ts (one open waiver signing session, G2.15).
      if (
        name !== join("booking", "resume.ts") &&
        name !== join("manage", "session.ts") &&
        name !== join("waiver", "session.ts")
      ) {
        const session = /\bsessionStorage\s*[.[?]/.test(source);
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

describe("service worker precache list (G2.14b)", () => {
  it("lists only hashed assets the build writes, never an empty CSS-entry chunk", () => {
    expect(
      precacheFrom({
        "index.html": { type: "asset" },
        "assets/index-a1.js": { type: "chunk", code: "console.log(1)" },
        "assets/index-a1.css": { type: "asset" },
        "assets/offline-b2.js": { type: "chunk", code: "\n" },
        "assets/offline-b2.css": { type: "asset" },
        "assets/index-a1.js.map": { type: "asset" },
        "assets/inter-c3.woff2": { type: "asset" },
      }),
    ).toEqual(["/assets/index-a1.css", "/assets/index-a1.js", "/assets/offline-b2.css"]);
  });

  it("checks every precache entry against dist/ in every build", () => {
    const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
    for (const script of ["build", "release", "release:dry"]) {
      expect(pkg.scripts[script]).toMatch(/^vite build && node scripts\/check-precache\.mjs && /);
    }
  });
});

describe("guest Worker configuration (G2.14b)", () => {
  const wrangler = readFileSync(new URL("../wrangler.jsonc", import.meta.url), "utf8");

  it("routes exactly each synthetic tenant's preview hostname and the platform name, and nothing else", async () => {
    const top = wrangler.slice(0, wrangler.indexOf('"env"'));
    const patterns = [...top.matchAll(/"pattern":\s*"([^"]+)"/g)].map((m) => m[1]);
    const tenants = await loadTenantManifests();
    // The demo.tidegrid.us cutover (Nov 1 runbook C4): the one platform name
    // 0011 admits, and workers.dev off.
    expect(patterns.sort()).toEqual(
      [...tenants.map((t) => previewHostnameFor(t.manifest.slug)), "demo.tidegrid.us"].sort(),
    );
    expect(top).toMatch(/"workers_dev": false/);
    for (const t of tenants)
      expect(t.manifest.previewHostname).toBe(previewHostnameFor(t.manifest.slug));
    expect(top).toMatch(/"custom_domain": true/);
  });

  it("keeps named environments off the preview hostnames", () => {
    const envs = wrangler.slice(wrangler.indexOf('"env"'));
    expect(envs).not.toMatch(/"pattern"/);
    expect(envs.match(/"routes": \[\]/g)).toHaveLength(2);
  });

  it("runs the Worker first only for the PWA paths, bound to the API's GuestGateway", () => {
    const first = [...wrangler.matchAll(/"run_worker_first": (\[[^\]]*\])/g)].map((m) =>
      JSON.parse(m[1] ?? "[]"),
    );
    expect(first.length).toBe(3);
    for (const list of first) {
      expect(list).toEqual(["/manifest.webmanifest", "/icons/*", "/sw.js"]);
    }
    const top = wrangler.slice(0, wrangler.indexOf('"env"'));
    expect(top).toMatch(
      /"services": \[\s*\{ "binding": "GuestGateway", "service": "tidegrid-api", "entrypoint": "GuestGateway" \}\s*\]/,
    );
  });
});
