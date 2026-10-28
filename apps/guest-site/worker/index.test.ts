import { type PublicBrand, svgLogoProblem } from "@tidegrid/contracts";
import { brandConfigFromManifest, parseTenantManifest } from "@tidegrid/tenant-config";
import { describe, expect, it } from "vitest";
import harborLogo from "../../../config/tenants/demo-harbor/logo.svg?raw";
import harborManifest from "../../../config/tenants/demo-harbor.json";
import reefLogo from "../../../config/tenants/demo-reef/logo.svg?raw";
import reefManifest from "../../../config/tenants/demo-reef.json";
import { killSwitchSource } from "../src/sw/kill-switch.ts";
import { ICON_CSP } from "./headers.ts";
import { neutralIcon, tenantIcon } from "./icons.ts";
import { type GuestEnv, handle } from "./index.ts";
import { shortNameFor } from "./manifest.ts";

function experience(manifest: unknown, logo: string, version = 3) {
  const parsed = parseTenantManifest(manifest);
  const brand = brandConfigFromManifest(parsed, new TextEncoder().encode(logo));
  return {
    tenant: { slug: parsed.slug, name: parsed.displayName },
    brand: { ...brand, version } as PublicBrand,
  };
}

const harbor = experience(harborManifest, harborLogo);
const reef = experience(reefManifest, reefLogo);

const SW_BODY = "/* built service worker */ self.addEventListener('fetch', () => {});";

/** A stub gateway and asset store, and a log of what the gateway was asked. */
function stubEnv(options: { throws?: boolean; answer?: (host: string) => unknown } = {}) {
  const asked: string[] = [];
  const assetsAsked: string[] = [];
  const env: GuestEnv = {
    ASSETS: {
      async fetch(request: Request) {
        const path = new URL(request.url).pathname;
        assetsAsked.push(path);
        if (path === "/sw.js") {
          return new Response(SW_BODY, { headers: { "content-type": "text/javascript" } });
        }
        return new Response("<!doctype html><title>spa</title>", {
          headers: { "content-type": "text/html" },
        });
      },
    },
    GuestGateway: {
      async resolveHost(host: string) {
        asked.push(host);
        if (options.throws) throw new Error("gateway down");
        if (options.answer) return options.answer(host);
        if (host === "demo-harbor.book.tidegrid.us") return { kind: "found", experience: harbor };
        if (host === "demo-reef.book.tidegrid.us") return { kind: "found", experience: reef };
        if (host === "draft.book.tidegrid.us") {
          return { kind: "found", experience: { tenant: harbor.tenant } };
        }
        return { kind: "miss" };
      },
    },
  };
  return { env, asked, assetsAsked };
}

function get(url: string, headers: Record<string, string> = {}) {
  return new Request(url, { headers });
}

const securityHeaders = ["x-content-type-options", "referrer-policy", "x-robots-tag"];

function expectSecurityHeaders(res: Response) {
  for (const name of securityHeaders) expect(res.headers.get(name), name).toBeTruthy();
  expect(res.headers.get("x-content-type-options")).toBe("nosniff");
  expect(res.headers.get("content-security-policy")).toMatch(/default-src 'none'/);
}

describe("guest Worker: per-tenant manifest (G2.14b)", () => {
  it("serves each brand's own manifest on its own host", async () => {
    const { env } = stubEnv();
    for (const [host, ex] of [
      ["demo-harbor.book.tidegrid.us", harbor],
      ["demo-reef.book.tidegrid.us", reef],
    ] as const) {
      const res = await handle(get(`https://${host}/manifest.webmanifest`), env);
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toBe("application/manifest+json");
      expect(res.headers.get("cache-control")).toBe("no-cache");
      expect(res.headers.get("etag")).toBe(`"${ex.tenant.slug}.3.manifest"`);
      expectSecurityHeaders(res);
      const manifest = (await res.json()) as Record<string, unknown>;
      expect(manifest).toMatchObject({
        id: "/",
        start_url: "/",
        scope: "/",
        display: "standalone",
        name: ex.brand.name,
        theme_color: ex.brand.colors.primary,
        background_color: "#f6f7f6",
        lang: "en-US",
      });
      const other = ex === harbor ? reef : harbor;
      const text = JSON.stringify(manifest);
      expect(text).not.toContain(other.brand.name);
      expect(text).not.toContain(other.brand.colors.primary);
    }
  });

  it("answers a matching ETag with 304", async () => {
    const { env } = stubEnv();
    const res = await handle(
      get("https://demo-reef.book.tidegrid.us/manifest.webmanifest", {
        "if-none-match": '"demo-reef.3.manifest"',
      }),
      env,
    );
    expect(res.status).toBe(304);
  });

  it("answers 404 no-store for a definite miss and for an operator with no brand yet", async () => {
    const { env } = stubEnv();
    for (const host of ["nobody.book.tidegrid.us", "draft.book.tidegrid.us"]) {
      const res = await handle(get(`https://${host}/manifest.webmanifest`), env);
      expect({ host, status: res.status }).toEqual({ host, status: 404 });
      expect(res.headers.get("cache-control")).toBe("no-store");
      expect(res.headers.get("clear-site-data")).toBeNull();
      expectSecurityHeaders(res);
    }
  });

  it("answers 503 no-store when the gateway throws or answers outside the contract", async () => {
    for (const env of [
      stubEnv({ throws: true }).env,
      stubEnv({ answer: () => ({ kind: "withheld" }) }).env,
      stubEnv({ answer: () => ({ kind: "found", experience: { tenant: { slug: "X" } } }) }).env,
      stubEnv({ answer: () => null }).env,
    ]) {
      for (const path of ["/manifest.webmanifest", "/sw.js", "/icons/icon.svg"]) {
        const res = await handle(get(`https://demo-harbor.book.tidegrid.us${path}`), env);
        expect({ path, status: res.status }).toEqual({ path, status: 503 });
        expect(res.headers.get("cache-control")).toBe("no-store");
        expect(res.headers.get("clear-site-data")).toBeNull();
        const body = await res.text();
        expect(body).not.toContain("unregister");
        expect(body).not.toBe(killSwitchSource);
        expectSecurityHeaders(res);
      }
    }
  });
});

describe("guest Worker: host handling (G2.14b)", () => {
  it("reads the tenant from the request URL only, never from Host or X-Forwarded-Host", async () => {
    const { env, asked } = stubEnv();
    const res = await handle(
      get("https://nobody.book.tidegrid.us/manifest.webmanifest", {
        host: "demo-harbor.book.tidegrid.us",
        "x-forwarded-host": "demo-harbor.book.tidegrid.us",
        forwarded: "host=demo-harbor.book.tidegrid.us",
        origin: "https://demo-harbor.book.tidegrid.us",
      }),
      env,
    );
    expect(res.status).toBe(404);
    expect(asked).toEqual(["nobody.book.tidegrid.us"]);
  });

  it("asks the gateway nothing for any other path, which goes to the assets", async () => {
    const { env, asked, assetsAsked } = stubEnv();
    for (const path of ["/", "/manage", "/assets/index-abc.js", "/support", "/manifest.json"]) {
      const res = await handle(get(`https://demo-harbor.book.tidegrid.us${path}`), env);
      expect(res.status).toBe(200);
    }
    expect(asked).toEqual([]);
    expect(assetsAsked).toHaveLength(5);
  });

  it("refuses methods other than GET and HEAD on its own paths", async () => {
    const { env, asked } = stubEnv();
    const res = await handle(
      new Request("https://demo-harbor.book.tidegrid.us/sw.js", { method: "POST", body: "x" }),
      env,
    );
    expect(res.status).toBe(405);
    expect(asked).toEqual([]);
  });
});

describe("guest Worker: service worker and kill switch (G2.14b)", () => {
  it("serves the built service worker, uncached, for a resolved host", async () => {
    const { env } = stubEnv();
    const res = await handle(get("https://demo-harbor.book.tidegrid.us/sw.js"), env);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("text/javascript; charset=utf-8");
    expect(res.headers.get("cache-control")).toBe("no-cache");
    expect(res.headers.get("clear-site-data")).toBeNull();
    expect(res.headers.get("content-security-policy")).toBe(
      "default-src 'none'; connect-src 'self'",
    );
    expect(await res.text()).toBe(SW_BODY);
  });

  it("serves the kill switch with Clear-Site-Data cache only on a definite miss", async () => {
    const { env } = stubEnv();
    const res = await handle(get("https://nobody.book.tidegrid.us/sw.js"), env);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("text/javascript; charset=utf-8");
    expect(res.headers.get("clear-site-data")).toBe('"cache"');
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(await res.text()).toBe(killSwitchSource);
  });

  it("never serves the SPA fallback as the service worker", async () => {
    const { env } = stubEnv();
    env.ASSETS = {
      fetch: async () =>
        new Response("<!doctype html>", { headers: { "content-type": "text/html" } }),
    };
    const res = await handle(get("https://demo-harbor.book.tidegrid.us/sw.js"), env);
    expect(res.status).toBe(503);
  });

  it("keeps the kill switch to caches: no storage, no navigation", () => {
    expect(killSwitchSource).toContain("caches");
    expect(killSwitchSource).toContain("unregister");
    for (const banned of ["localStorage", "sessionStorage", "indexedDB", "navigate", "import"]) {
      expect(killSwitchSource).not.toContain(banned);
    }
  });
});

describe("guest Worker: icons (G2.14b, D3(a))", () => {
  it("serves each brand's mark on its primary, under the icon policy", async () => {
    const { env } = stubEnv();
    for (const [host, ex] of [
      ["demo-harbor.book.tidegrid.us", harbor],
      ["demo-reef.book.tidegrid.us", reef],
    ] as const) {
      for (const path of ["/icons/icon.svg", "/icons/maskable.svg"]) {
        const res = await handle(get(`https://${host}${path}`), env);
        expect(res.status).toBe(200);
        expect(res.headers.get("content-type")).toBe("image/svg+xml");
        expect(res.headers.get("content-security-policy")).toBe(ICON_CSP);
        expect(res.headers.get("x-content-type-options")).toBe("nosniff");
        const svg = await res.text();
        expect(svgLogoProblem(svg)).toBeNull();
        expect(svg).toContain(`fill="${ex.brand.colors.primary}"`);
        expect(svg).toContain("<svg xmlns");
      }
    }
  });

  it("answers 404 for an unknown icon path and for a miss", async () => {
    const { env } = stubEnv();
    expect(
      (await handle(get("https://demo-harbor.book.tidegrid.us/icons/x.png"), env)).status,
    ).toBe(404);
    expect((await handle(get("https://nobody.book.tidegrid.us/icons/icon.svg"), env)).status).toBe(
      404,
    );
  });

  it("falls back to the neutral mark with no logo, a lockup, or a raster mark", () => {
    const { logo: _logo, ...noLogo } = harbor.brand;
    const brands: PublicBrand[] = [
      noLogo as PublicBrand,
      {
        ...harbor.brand,
        logo: {
          kind: "lockup",
          src: harbor.brand.logo?.src ?? "",
          alt: "Lockup",
          width: 256,
          height: 64,
        },
      } as PublicBrand,
      {
        ...harbor.brand,
        logo: {
          kind: "mark",
          src: "data:image/png;base64,iVBORw0KGgo=",
          alt: "",
          width: 64,
          height: 64,
        },
      } as PublicBrand,
    ];
    for (const brand of brands) {
      for (const purpose of ["any", "maskable"] as const) {
        const svg = tenantIcon(brand, purpose);
        expect(svg).toBe(neutralIcon(brand, purpose));
        expect(svgLogoProblem(svg)).toBeNull();
        expect(svg).not.toContain("data:");
      }
    }
  });

  it("escapes the brand name in the icon title", () => {
    const brand = { ...harbor.brand, name: "Sea & Sky <Tours>" } as PublicBrand;
    const svg = tenantIcon(brand, "any");
    expect(svg).toContain("<title>Sea &amp; Sky &lt;Tours&gt;</title>");
    expect(svgLogoProblem(svg)).toBeNull();
  });
});

describe("short_name (G2.14b, D6)", () => {
  it("cuts the brand name at a word boundary to 12 characters", () => {
    expect(shortNameFor("Demo Reef")).toBe("Demo Reef");
    expect(shortNameFor("Demo Harbor Charters")).toBe("Demo Harbor");
    expect(shortNameFor("Supercalifragilistic")).toBe("Supercalifra");
    expect(Array.from(shortNameFor("Ölmühle Bootstouren")).length).toBeLessThanOrEqual(12);
  });
});
