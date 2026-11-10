import { readdirSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { endpointFor, Variant, variantFor, variants } from "./variant.ts";

const tenantsDir = new URL("../../../config/tenants/", import.meta.url);

describe("variants", () => {
  it("every variant file is registered, valid, and names a synthetic tenant", () => {
    const files = readdirSync(new URL("../variants/", import.meta.url)).filter((f) =>
      f.endsWith(".json"),
    );
    expect(files.map((f) => f.replace(/\.json$/, "")).sort()).toEqual(Object.keys(variants).sort());
    for (const slug of Object.keys(variants)) {
      const variant = variantFor(slug);
      expect(variant, slug).not.toBeNull();
      const tenant = JSON.parse(readFileSync(new URL(`${slug}.json`, tenantsDir), "utf8")) as {
        slug: string;
        previewHostname: string;
        brand: { colors: { primary: string } };
      };
      expect(variant?.slug).toBe(tenant.slug);
      expect(variant?.guestOrigin).toBe(`https://${tenant.previewHostname}`);
      expect(variant?.iconBackground).toBe(tenant.brand.colors.primary.toLowerCase());
    }
  });

  it("each variant has its store icons", () => {
    for (const slug of Object.keys(variants)) {
      for (const name of ["icon.png", "adaptive-foreground.png"]) {
        const png = readFileSync(new URL(`../assets/${slug}/${name}`, import.meta.url));
        // PNG signature, then the IHDR width and height: 1024 by 1024.
        expect(png.subarray(1, 4).toString("latin1"), `${slug}/${name}`).toBe("PNG");
        expect(png.readUInt32BE(16)).toBe(1024);
        expect(png.readUInt32BE(20)).toBe(1024);
      }
      // Apple refuses an app icon with transparency: color type 2 is RGB without alpha.
      const icon = readFileSync(new URL(`../assets/${slug}/icon.png`, import.meta.url));
      expect(icon[25], `${slug} icon color type`).toBe(2);
    }
  });

  it("store identities are unique across variants", () => {
    const all = Object.keys(variants).map((s) => variantFor(s) as Variant);
    expect(new Set(all.map((v) => v.iosBundleId)).size).toBe(all.length);
    expect(new Set(all.map((v) => v.androidPackage)).size).toBe(all.length);
  });

  it("an unknown, missing, or inherited name selects nothing", () => {
    expect(variantFor(undefined)).toBeNull();
    expect(variantFor("")).toBeNull();
    expect(variantFor("demo-elsewhere")).toBeNull();
    expect(variantFor("toString")).toBeNull();
    expect(variantFor("__proto__")).toBeNull();
  });

  it("refuses a variant whose file names another slug", () => {
    const reefFile = variants["demo-reef"];
    expect(variantFor("demo-harbor", { "demo-harbor": reefFile })).toBeNull();
  });

  it("refuses an extra field or an http guest origin", () => {
    const reef = variants["demo-reef"] as Variant;
    expect(Variant.safeParse({ ...reef, extra: 1 }).success).toBe(false);
    expect(
      Variant.safeParse({ ...reef, guestOrigin: "http://demo-reef.book.tidegrid.us" }).success,
    ).toBe(false);
  });
});

describe("endpointFor", () => {
  const harbor = variantFor("demo-harbor") as Variant;

  it("defaults to the deployed API and the variant's own guest origin", () => {
    expect(endpointFor(harbor)).toEqual({
      apiBase: "https://api.tidegrid.us",
      origin: "https://demo-harbor.book.tidegrid.us",
    });
  });

  it("allows a local origin only for the same tenant", () => {
    expect(
      endpointFor(harbor, {
        apiBase: "http://192.168.1.20:8787",
        origin: "http://demo-harbor.book.localhost:5361",
      }),
    ).toEqual({
      apiBase: "http://192.168.1.20:8787",
      origin: "http://demo-harbor.book.localhost:5361",
    });
    expect(endpointFor(harbor, { origin: "http://demo-reef.book.localhost:5361" })).toBeNull();
    expect(endpointFor(harbor, { origin: "https://demo-reef.book.tidegrid.us" })).toBeNull();
    expect(
      endpointFor(harbor, { origin: "http://demo-harbor.book.localhost.evil.test" }),
    ).toBeNull();
  });

  it("refuses an API base with a path, userinfo, a query, a fragment, or another scheme", () => {
    for (const apiBase of [
      "https://api.tidegrid.us/v1",
      "https://user:pass@api.tidegrid.us",
      "https://api.tidegrid.us?x",
      "https://api.tidegrid.us#x",
      "ftp://api.tidegrid.us",
      42,
    ]) {
      expect(endpointFor(harbor, { apiBase }), String(apiBase)).toBeNull();
    }
  });

  it("allows plain http only with the variant's local origin", () => {
    expect(endpointFor(harbor, { apiBase: "http://192.168.1.20:8787" })).toBeNull();
    expect(endpointFor(harbor, { apiBase: "https://staging.tidegrid.test" })).toEqual({
      apiBase: "https://staging.tidegrid.test",
      origin: "https://demo-harbor.book.tidegrid.us",
    });
  });
});
