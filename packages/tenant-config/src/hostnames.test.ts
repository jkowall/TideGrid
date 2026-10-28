import { describe, expect, it } from "vitest";
import {
  customHostnameProblem,
  parseTenantManifest,
  previewHostnameFor,
  refusedCustomHostnameSuffixes,
  reservedSlugs,
  slugProblem,
} from "./index.ts";
import { loadTenantManifests } from "./node.ts";

describe("reserved slugs (G2.14b)", () => {
  it("refuses every platform name as a tenant slug", () => {
    expect([...reservedSlugs].sort()).toEqual(
      ["api", "console", "customers", "demo", "saas-fallback", "status", "www"].sort(),
    );
    for (const slug of reservedSlugs) expect(slugProblem(slug)).toBe("reserved");
    expect(slugProblem("demo-harbor")).toBeNull();
    expect(slugProblem("xn--bcher-kva")).toBe("idn_label");
    expect(slugProblem("Demo")).toBe("not_a_slug");
  });

  it("refuses a manifest with a reserved or punycode slug", () => {
    for (const slug of ["api", "console", "xn--bcher-kva"]) {
      expect(() =>
        parseTenantManifest({
          slug,
          displayName: "Fixture",
          previewHostname: previewHostnameFor(slug),
          brand: {},
        }),
      ).toThrow(/slug/);
    }
  });

  it("keeps every committed manifest clear of the reserved slugs", async () => {
    for (const { manifest } of await loadTenantManifests()) {
      expect(slugProblem(manifest.slug)).toBeNull();
    }
  });
});

describe("custom hostname name rules (G2.14b)", () => {
  it("matches refused suffixes on a label boundary only", () => {
    expect(customHostnameProblem("book.eviltidegrid.us")).toBeNull();
    expect(customHostnameProblem("x.tidegrid.us")).toBe("reserved_suffix");
    expect(customHostnameProblem("a.b.tidegrid.us")).toBe("reserved_suffix");
    expect(customHostnameProblem("book.notworkers.dev")).toBeNull();
  });

  it("refuses every listed suffix, as the name and under it", () => {
    expect(refusedCustomHostnameSuffixes).toEqual([
      "tidegrid.us",
      "workers.dev",
      "pages.dev",
      "localhost",
      "test",
      "example",
      "invalid",
      "onion",
      "local",
      "internal",
      "arpa",
      "alt",
    ]);
    for (const suffix of refusedCustomHostnameSuffixes) {
      expect(customHostnameProblem(`book.shop.${suffix}`), suffix).toBe("reserved_suffix");
    }
    expect(customHostnameProblem("book.workers.dev")).toBe("reserved_suffix");
  });

  it("needs at least three labels, so no apex domain is attached", () => {
    expect(customHostnameProblem("harbor.com")).toBe("too_few_labels");
    expect(customHostnameProblem("book.harbor.com")).toBeNull();
  });

  it("refuses punycode labels anywhere", () => {
    expect(customHostnameProblem("book.xn--bcher-kva.com")).toBe("idn_label");
    expect(customHostnameProblem("xn--80ak6aa92e.harbor.com")).toBe("idn_label");
  });

  it("refuses malformed and over-long names", () => {
    for (const bad of ["", "Book.Harbor.com", "book..harbor.com", "book.harbor.com.", "-a.b.com"]) {
      expect(customHostnameProblem(bad), bad).toBe("malformed");
    }
    expect(customHostnameProblem("book.harbor.1com")).toBe("malformed");
    expect(customHostnameProblem(`${"a".repeat(63)}.${"b".repeat(63)}.com`)).toBeNull();
    expect(customHostnameProblem(`${"a.".repeat(100)}com`)).toBe("too_long");
    expect(customHostnameProblem(`${"a".repeat(64)}.harbor.com`)).toBe("malformed");
  });
});
