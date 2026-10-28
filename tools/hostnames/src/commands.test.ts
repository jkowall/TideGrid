import { describe, expect, it } from "vitest";
import { cloudflareProvider, parseArgs, UsageError } from "./commands.ts";

describe("hostname CLI arguments", () => {
  it("parses each command", () => {
    expect(parseArgs(["status", "demo-harbor"])).toEqual({ kind: "status", slug: "demo-harbor" });
    expect(parseArgs(["request", "demo-harbor", "book.example.com"])).toEqual({
      kind: "request",
      slug: "demo-harbor",
      hostname: "book.example.com",
    });
    expect(parseArgs(["disable", "demo-reef", "book.example.com", "Left", "the", "demo"])).toEqual({
      kind: "disable",
      slug: "demo-reef",
      hostname: "book.example.com",
      reason: "Left the demo",
    });
    expect(parseArgs(["fake-lifecycle", "demo-reef", "book.example.com"]).kind).toBe(
      "fake-lifecycle",
    );
  });

  it("refuses anything else", () => {
    for (const argv of [
      [],
      ["status"],
      ["status", "Demo Harbor"],
      ["status", "demo-harbor", "extra"],
      ["delete", "demo-harbor", "book.example.com"],
      ["request", "demo-harbor"],
      ["request", "demo-harbor", "book.example.com", "extra"],
      ["disable", "demo-harbor", "book.example.com"],
    ]) {
      expect(() => parseArgs(argv), argv.join(" ")).toThrow(UsageError);
    }
  });

  it("needs a zone and a token for Cloudflare, and offers no fake outside fake-lifecycle", () => {
    expect(() => cloudflareProvider({})).toThrow(UsageError);
    expect(() => cloudflareProvider({ CF_SAAS_ZONE_ID: "0".repeat(32) })).toThrow(UsageError);
    const provider = cloudflareProvider({
      CF_SAAS_ZONE_ID: "0".repeat(32),
      CF_SAAS_API_TOKEN: "synthetic-token",
    });
    expect(provider.name).toBe("cloudflare_saas");
    expect(provider.routingTarget()).toBe("customers.tidegrid.us");
  });
});
