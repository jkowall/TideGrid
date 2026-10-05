import { SELF } from "cloudflare:test";
import { PublicBrand, PublicExperienceResponse } from "@tidegrid/contracts";
import { describe, expect, it } from "vitest";

// The API validates every stored brand before serving it, in the Workers
// runtime. These run the same contract inside workerd, where atob and a fatal
// TextDecoder must behave as they do in Node and the browser.

const svg = (body: string) =>
  `data:image/svg+xml;base64,${btoa(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64">${body}</svg>`)}`;

const brand = (logoSrc: string) => ({
  version: 1,
  name: "Demo Harbor Charters",
  colors: { primary: "#0b3c5d", accent: "#e0a526" },
  fonts: { display: "fraunces", body: "source-sans-3" },
  logo: { src: logoSrc, kind: "mark", alt: "Demo Harbor Charters", width: 64, height: 64 },
  contact: { email: "hello@demo-harbor.test" },
  legal: { terms: "/legal/terms", privacy: "/legal/privacy" },
  locale: "en-US",
  capabilities: [],
});

describe("brand contract in the Workers runtime", () => {
  it("accepts an inert logo and refuses a script-bearing or invalid one", () => {
    expect(PublicBrand.safeParse(brand(svg('<circle cx="32" cy="32" r="30"/>'))).success).toBe(
      true,
    );
    expect(PublicBrand.safeParse(brand(svg("<script/>"))).success).toBe(false);
    expect(PublicBrand.safeParse(brand(svg('<rect onload="x"/>'))).success).toBe(false);
    // Invalid UTF-8 inside an SVG must fail closed, not throw.
    expect(PublicBrand.safeParse(brand("data:image/svg+xml;base64,/w==")).success).toBe(false);
  });

  it("keeps the bootstrap response free of anything but identity and brand", () => {
    const tenant = { slug: "demo-harbor", name: "Demo Harbor Charters" };
    expect(PublicExperienceResponse.safeParse({ tenant }).success).toBe(true);
    expect(
      PublicExperienceResponse.safeParse({ tenant, brand: brand(svg("<circle r='1'/>")) }).success,
    ).toBe(true);
    // Anything beyond slug and name, such as an internal id, is refused, not stripped.
    expect(
      PublicExperienceResponse.safeParse({
        tenant: { ...tenant, id: "7d1e5b3a-1c2f-4a8e-9b61-0a1c2e3f4a01" },
      }).success,
    ).toBe(false);
  });
});

describe("published contract", () => {
  it("documents the brand on the public bootstrap and its fail-closed 503", async () => {
    const doc = (await (await SELF.fetch("https://api.test/v1/openapi.json")).json()) as {
      paths: Record<string, { get: { responses: Record<string, unknown> } }>;
    };
    const route = doc.paths["/v1/public/tenant"]?.get;
    if (!route) throw new Error("the public bootstrap is missing from the contract");
    expect(Object.keys(route.responses).sort()).toEqual(["200", "404", "503"]);
    const schema = (
      route.responses["200"] as {
        content: { "application/json": { schema: { properties: Record<string, unknown> } } };
      }
    ).content["application/json"].schema;
    expect(Object.keys(schema.properties).sort()).toEqual(["brand", "tenant"]);
    const brandSchema = schema.properties.brand as {
      additionalProperties: boolean;
      required: string[];
    };
    expect(brandSchema.additionalProperties).toBe(false);
    expect(brandSchema.required).toContain("version");
  });

  it("publishes every pattern as a bare regex that a validator can apply", async () => {
    const doc: unknown = await (await SELF.fetch("https://api.test/v1/openapi.json")).json();
    const patterns = new Set<string>();
    const walk = (node: unknown) => {
      if (Array.isArray(node)) for (const item of node) walk(item);
      else if (node && typeof node === "object") {
        for (const [key, value] of Object.entries(node)) {
          if (key === "pattern" && typeof value === "string") patterns.add(value);
          else walk(value);
        }
      }
    };
    walk(doc);
    expect(patterns.size).toBeGreaterThan(0);
    for (const pattern of patterns) {
      // A regex written out with its flags ("…$/u") matches nothing.
      expect(pattern).not.toMatch(/\/[dgimsuvy]+$/);
      expect(() => new RegExp(pattern, "u")).not.toThrow();
    }
    // The copy pattern the contract documents accepts copy and refuses a bidi override.
    const copy = [...patterns].find((p) => p.includes("\\p{Cf}"));
    if (!copy) throw new Error("the plain-text pattern is missing from the contract");
    expect(new RegExp(copy, "u").test("Demo Harbor Charters")).toBe(true);
    expect(new RegExp(copy, "u").test("Demo ‮harbor")).toBe(false);
  });
});
