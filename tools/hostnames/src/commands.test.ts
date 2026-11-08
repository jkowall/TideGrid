import { HostnameProviderRejectedError } from "@tidegrid/domain-hostnames";
import { describe, expect, it } from "vitest";
import {
  cloudflareProvider,
  describeError,
  parseArgs,
  UsageError,
  workersRoutesClient,
} from "./commands.ts";

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

  it("parses route and release, a dry run unless --apply (W1-SAAS-PREP)", () => {
    expect(parseArgs(["route", "demo-harbor", "book.example.com"])).toEqual({
      kind: "route",
      slug: "demo-harbor",
      hostname: "book.example.com",
      remove: false,
      apply: false,
    });
    expect(parseArgs(["route", "demo-harbor", "book.example.com", "--apply", "--remove"])).toEqual({
      kind: "route",
      slug: "demo-harbor",
      hostname: "book.example.com",
      remove: true,
      apply: true,
    });
    expect(parseArgs(["release", "demo-harbor", "book.example.com"])).toEqual({
      kind: "release",
      slug: "demo-harbor",
      hostname: "book.example.com",
      apply: false,
      providerId: null,
    });
    expect(
      parseArgs(["release", "demo-harbor", "book.example.com", "--provider-id", "abc", "--apply"]),
    ).toMatchObject({ apply: true, providerId: "abc" });
  });

  it("refuses unknown, repeated, or misplaced flags", () => {
    for (const argv of [
      ["route", "demo-harbor", "--apply"],
      ["route", "demo-harbor", "book.example.com", "--force"],
      ["route", "demo-harbor", "book.example.com", "--apply", "--apply"],
      ["route", "demo-harbor", "book.example.com", "--provider-id", "abc"],
      ["release", "demo-harbor", "book.example.com", "--remove"],
      ["release", "demo-harbor", "book.example.com", "--provider-id"],
      ["release", "demo-harbor", "book.example.com", "--provider-id", "--apply"],
      ["release", "demo-harbor", "book.example.com", "--provider-id", "abc"],
      ["request", "demo-harbor", "book.example.com", "--apply"],
    ]) {
      expect(() => parseArgs(argv), argv.join(" ")).toThrow(UsageError);
    }
  });

  it("needs a zone and a token only for route --apply", () => {
    expect(() => workersRoutesClient({})).toThrow(UsageError);
    expect(() =>
      workersRoutesClient({
        CF_SAAS_ZONE_ID: "0".repeat(32),
        CF_SAAS_API_TOKEN: "synthetic-token",
      }),
    ).not.toThrow();
  });

  // The codes are unverified until the first real request at P10.
  it("names the token and the zone on an account-level refusal, and only then", () => {
    const refused = describeError(
      new HostnameProviderRejectedError("cloudflare_10000", undefined, 403),
    );
    expect(refused).toContain("HostnameProviderRejectedError cloudflare_10000");
    expect(refused).toContain("refused the account");
    expect(refused).toContain("CF_SAAS_API_TOKEN");
    const zone = describeError(new HostnameProviderRejectedError("http_404", undefined, 404));
    expect(zone).toContain("refused the account");
    const record = describeError(
      new HostnameProviderRejectedError("cloudflare_1414", undefined, 400),
    );
    expect(record).not.toContain("refused the account");
    expect(describeError(new Error("boom"))).toBe("Error: boom");
  });
});
