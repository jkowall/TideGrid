import { describe, expect, it } from "vitest";
import { onboardingSteps, parseArgs, senderDomainProblem, UsageError } from "./commands.ts";

describe("email admin CLI arguments (W3-G2.16-rest)", () => {
  it("parses each command", () => {
    expect(parseArgs(["domain-status", "demo-harbor"])).toEqual({
      kind: "domain-status",
      slug: "demo-harbor",
    });
    expect(parseArgs(["domain-add", "demo-harbor", "Mail.Harbor.Example"])).toEqual({
      kind: "domain-add",
      slug: "demo-harbor",
      domain: "mail.harbor.example",
      mailbox: "bookings",
    });
    expect(
      parseArgs(["domain-add", "demo-harbor", "harbor.example", "--mailbox", "Trips"]),
    ).toMatchObject({ mailbox: "trips" });
    expect(
      parseArgs(["domain-verify", "demo-harbor", "harbor.example", "SPF,", "DKIM", "pass"]),
    ).toEqual({
      kind: "domain-verify",
      slug: "demo-harbor",
      domain: "harbor.example",
      evidence: "SPF, DKIM pass",
    });
    expect(parseArgs(["domain-retire", "demo-harbor", "harbor.example", "moved"])).toMatchObject({
      reason: "moved",
    });
    expect(parseArgs(["suppressions", "demo-harbor"])).toEqual({
      kind: "suppressions",
      slug: "demo-harbor",
    });
    expect(
      parseArgs(["suppression-lift", "demo-harbor", " Guest@Example.Test ", "asked", "us"]),
    ).toEqual({
      kind: "suppression-lift",
      slug: "demo-harbor",
      address: "guest@example.test",
      reason: "asked us",
    });
  });

  it("refuses what the database would refuse, before connecting", () => {
    const bad: string[][] = [
      [],
      ["domain-status"],
      ["domain-status", "Not A Slug"],
      ["domain-status", "demo-harbor", "extra"],
      ["unknown", "demo-harbor"],
      ["domain-add", "demo-harbor"],
      ["domain-add", "demo-harbor", "localhost"],
      ["domain-add", "demo-harbor", "mail.tidegrid.us"],
      ["domain-add", "demo-harbor", "tidegrid.example"],
      ["domain-add", "demo-harbor", "xn--tdegrd-pvfe.example"],
      ["domain-add", "demo-harbor", "harbor.example", "--mailbox"],
      ["domain-add", "demo-harbor", "harbor.example", "--mailbox", "a..b"],
      ["domain-add", "demo-harbor", "harbor.example", "--other", "x"],
      [
        "domain-add",
        "demo-harbor",
        `${"a".repeat(63)}.${"b".repeat(63)}.${"c".repeat(63)}.${"d".repeat(50)}.example`,
        "--mailbox",
        "m".repeat(20),
      ],
      ["domain-verify", "demo-harbor", "harbor.example"],
      ["domain-retire", "demo-harbor", "harbor.example", "  "],
      ["suppression-lift", "demo-harbor", "guest@example.test"],
      ["suppression-lift", "demo-harbor", "guest@example.test", "for", "guest@example.test"],
      ["domain-verify", "demo-harbor", "harbor.example", "dmarc", "rua=ops@harbor.example"],
      ["domain-retire", "demo-harbor", "harbor.example", "asked", "by", "a@b.example"],
    ];
    for (const argv of bad) expect(() => parseArgs(argv), argv.join(" ")).toThrow(UsageError);
  });

  it("names why a domain is refused", () => {
    expect(senderDomainProblem("harbor.example")).toBeNull();
    expect(senderDomainProblem("mail.tidegrid.us")).toBe("names TideGrid");
    expect(senderDomainProblem("xn--abc.example")).toBe("has an internationalized (xn--) label");
    expect(senderDomainProblem("HARBOR.example")).toBe("not a lowercase domain name");
  });

  it("prints the owner's steps and never claims to have done them", () => {
    const lines = onboardingSteps("harbor.example", "bookings");
    expect(lines[0]).toContain("pending");
    expect(lines.join("\n")).toContain("bookings@harbor.example");
    expect(lines.join("\n")).toContain("none of them run from here");
  });
});
