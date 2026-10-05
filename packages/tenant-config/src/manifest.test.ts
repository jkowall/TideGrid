import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { contrastRatio, PublicBrand } from "@tidegrid/contracts";
import { afterAll, describe, expect, it } from "vitest";
import {
  brandConfigFromManifest,
  localHostnameFor,
  parseTenantManifest,
  previewHostnameFor,
  TenantConfigError,
} from "./index.ts";
import { defaultTenantsDir, loadTenantManifests } from "./node.ts";

const goodLogo = await readFile(join(defaultTenantsDir, "demo-harbor/logo.svg"), "utf8");

describe("config/tenants manifests", () => {
  it("all validate against the brand contract", async () => {
    const tenants = await loadTenantManifests();
    expect(tenants.map((t) => t.manifest.slug)).toEqual(["demo-harbor", "demo-reef"]);
    for (const { manifest, brand } of tenants) {
      expect(manifest.previewHostname).toBe(previewHostnameFor(manifest.slug));
      expect(brand.logo?.src).toMatch(/^data:image\/svg\+xml;base64,/);
      expect(PublicBrand.safeParse({ ...brand, version: 1 }).success).toBe(true);
    }
  });

  it("describe two clearly different brands", async () => {
    const [harbor, reef] = await loadTenantManifests();
    if (!harbor || !reef) throw new Error("expected two tenants");
    expect(harbor.brand.fonts.display).not.toBe(reef.brand.fonts.display);
    expect(harbor.brand.fonts.body).not.toBe(reef.brand.fonts.body);
    // Far apart as colors, not just different values.
    expect(contrastRatio(harbor.brand.colors.primary, reef.brand.colors.primary)).toBeGreaterThan(
      1.5,
    );
    expect(contrastRatio(harbor.brand.colors.accent, reef.brand.colors.accent)).toBeGreaterThan(
      1.2,
    );
    expect(harbor.brand.name).not.toBe(reef.brand.name);
  });

  it("contain only synthetic contact details", async () => {
    for (const { brand } of await loadTenantManifests()) {
      if (brand.contact.email) expect(brand.contact.email).toMatch(/@[a-z0-9-]+\.test$/);
      // 555-0100 through 555-0199 is reserved for fiction.
      if (brand.contact.phone) expect(brand.contact.phone).toMatch(/^\+1\d{3}55501\d{2}$/);
      expect(brand.contact.website).toBeUndefined();
    }
  });
});

describe("manifest validation", () => {
  const dirs: string[] = [];
  afterAll(async () => {
    for (const d of dirs) await rm(d, { recursive: true, force: true });
  });

  async function fixture(files: Record<string, string>): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), "tidegrid-tenants-"));
    dirs.push(dir);
    for (const [name, content] of Object.entries(files)) {
      await mkdir(join(dir, name, ".."), { recursive: true });
      await writeFile(join(dir, name), content);
    }
    return dir;
  }

  const manifest = (patch: Record<string, unknown> = {}, brand: Record<string, unknown> = {}) => {
    const base = JSON.parse(
      JSON.stringify({
        slug: "demo-test",
        displayName: "Demo Test Tours",
        previewHostname: "demo-test.book.tidegrid.us",
        brand: {
          name: "Demo Test Tours",
          colors: { primary: "#0b3c5d", accent: "#e0a526" },
          fonts: { display: "sora", body: "inter" },
          logo: {
            file: "demo-test/logo.svg",
            kind: "mark",
            alt: "Demo Test Tours",
            width: 64,
            height: 64,
          },
          contact: { email: "hi@demo-test.test" },
          legal: { terms: "/legal/terms", privacy: "/legal/privacy" },
          locale: "en-US",
          capabilities: [],
        },
      }),
    );
    return JSON.stringify({ ...base, ...patch, brand: { ...base.brand, ...brand } });
  };

  const problemsFor = async (files: Record<string, string>) => {
    try {
      await loadTenantManifests(await fixture(files));
      return [];
    } catch (err) {
      if (!(err instanceof TenantConfigError)) throw err;
      return err.problems;
    }
  };

  it("accepts a well-formed manifest and embeds its logo", async () => {
    const dir = await fixture({ "demo-test.json": manifest(), "demo-test/logo.svg": goodLogo });
    const [loaded] = await loadTenantManifests(dir);
    expect(loaded?.brand.logo?.src).toBe(
      `data:image/svg+xml;base64,${Buffer.from(goodLogo).toString("base64")}`,
    );
  });

  it.each([
    [
      "a file named for another slug",
      { "other.json": manifest() },
      /must be named demo-test\.json/,
    ],
    ["an unknown top-level field", { "demo-test.json": manifest({ theme: "dark" }) }, /theme/],
    [
      "a preview hostname outside the pattern",
      { "demo-test.json": manifest({ previewHostname: "demo-test.evil.test" }) },
      /preview hostname for demo-test is demo-test\.book\.tidegrid\.us/,
    ],
    [
      "a missing logo file",
      { "demo-test.json": manifest() },
      /demo-test\/logo\.svg does not exist/,
    ],
    [
      "a logo outside the tenant folder",
      {
        "demo-test.json": manifest(
          {},
          { logo: { file: "demo-harbor/logo.svg", kind: "mark", alt: "x", width: 64, height: 64 } },
        ),
      },
      /tenant's own folder/,
    ],
    [
      "a traversing logo path",
      {
        "demo-test.json": manifest(
          {},
          { logo: { file: "../etc/passwd", kind: "mark", alt: "x", width: 64, height: 64 } },
        ),
      },
      /Name a logo file/,
    ],
    [
      "an embedded data URI",
      {
        "demo-test.json": manifest(
          {},
          {
            logo: {
              file: "demo-test/logo.svg",
              src: "data:image/png;base64,AAAA",
              kind: "mark",
              alt: "x",
              width: 64,
              height: 64,
            },
          },
        ),
        "demo-test/logo.svg": goodLogo,
      },
      /may not embed a data URI/,
    ],
    [
      "a script-bearing logo",
      {
        "demo-test.json": manifest(),
        "demo-test/logo.svg": goodLogo.replace("</svg>", "<script>alert(1)</script></svg>"),
      },
      /brand\.logo\.src: element "script" is not allowed/,
    ],
    [
      "an oversized logo",
      {
        "demo-test.json": manifest(),
        "demo-test/logo.svg": goodLogo.replace(
          "</svg>",
          `<path d="${"M0 0h1v1H0z".repeat(3200)}"/></svg>`,
        ),
      },
      /larger than 32 KB/,
    ],
    [
      "a low-contrast brand",
      {
        "demo-test.json": manifest({}, { colors: { primary: "#8ecae6", accent: "#023047" } }),
        "demo-test/logo.svg": goodLogo,
      },
      /brand\.colors: Primary #8ecae6/,
    ],
    [
      "an unsupported font",
      {
        "demo-test.json": manifest({}, { fonts: { display: "papyrus", body: "inter" } }),
        "demo-test/logo.svg": goodLogo,
      },
      /brand\.fonts\.display/,
    ],
    [
      "a non-https legal link",
      {
        "demo-test.json": manifest(
          {},
          { legal: { terms: "http://demo-test.test/terms", privacy: "/legal/privacy" } },
        ),
        "demo-test/logo.svg": goodLogo,
      },
      /brand\.legal\.terms/,
    ],
    [
      "style smuggled into the brand",
      {
        "demo-test.json": manifest({}, { css: "body{display:none}" }),
        "demo-test/logo.svg": goodLogo,
      },
      /brand: Unrecognized key: "css"/,
    ],
    ["broken JSON", { "demo-test.json": "{ nope" }, /not valid JSON/],
  ])("rejects %s", async (_label, files, pattern) => {
    const problems = await problemsFor(files as Record<string, string>);
    expect(problems.join("\n")).toMatch(pattern);
  });

  it("rejects a logo symlinked out of its folder", async () => {
    const dir = await fixture({ "demo-test.json": manifest(), "secret.svg": goodLogo });
    await mkdir(join(dir, "demo-test"), { recursive: true });
    await symlink(join(dir, "secret.svg"), join(dir, "demo-test", "logo.svg"));
    await expect(loadTenantManifests(dir)).rejects.toThrow(/resolves outside its folder/);
  });

  it("reports every invalid manifest, not just the first", async () => {
    const problems = await problemsFor({
      "a-one.json": manifest({ slug: "a-one", previewHostname: "x" }),
      "b-two.json": "[]",
    });
    expect(problems.some((p) => p.startsWith("a-one.json: previewHostname"))).toBe(true);
    expect(problems.some((p) => p.startsWith("b-two.json: "))).toBe(true);
  });

  it("builds and validates a brand without touching the file system", () => {
    const parsed = parseTenantManifest(JSON.parse(manifest()));
    expect(() => brandConfigFromManifest(parsed)).toThrow(/was not read/);
    const brand = brandConfigFromManifest(parsed, new TextEncoder().encode(goodLogo));
    expect(brand.logo?.kind).toBe("mark");
  });
});

describe("hostname mapping", () => {
  it("maps slugs to preview and loopback-only local hostnames", () => {
    expect(previewHostnameFor("demo-harbor")).toBe("demo-harbor.book.tidegrid.us");
    expect(localHostnameFor("demo-reef")).toBe("demo-reef.book.localhost");
    for (const bad of ["Demo", "-x", "x-", "a.b", "", "a".repeat(41)]) {
      expect(() => previewHostnameFor(bad)).toThrow(RangeError);
      expect(() => localHostnameFor(bad)).toThrow(RangeError);
    }
  });
});
