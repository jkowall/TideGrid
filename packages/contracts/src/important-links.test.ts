import { describe, expect, it } from "vitest";
import { ImportantLinkInput, importantLinkHost, isImportantLinkUrl } from "./important-links.ts";

describe("isImportantLinkUrl", () => {
  it.each([
    "https://example.com/",
    "https://www.example.com",
    "https://parks.example.org/permits?season=2026#fishing",
    "https://Example.COM/a",
    "https://xn--pple-43d.com/",
    "https://shop.example.com:8443/",
    "https://shop.example.com:1/",
    "https://shop.example.com:65535/",
  ])("accepts %s", (url) => {
    expect(isImportantLinkUrl(url)).toBe(true);
  });

  it.each([
    ["plain http", "http://example.com/"],
    ["upper-case scheme", "HTTPS://example.com/"],
    ["javascript", "javascript:alert(1)"],
    ["an IP address", "https://10.0.0.1/"],
    ["a user name", "https://user@example.com/"],
    ["a user and password", "https://user:pw@example.com/"],
    ["a backslash before the host ends", "https://example.com\\@evil.com/"],
    ["a trailing dot", "https://example.com./"],
    ["a bare name", "https://localhost/"],
    ["port 0", "https://example.com:0/"],
    ["port 65536", "https://example.com:65536/"],
    ["port 99999", "https://example.com:99999/"],
    ["a leading-zero port", "https://example.com:0443/"],
    [".local", "https://printer.local/"],
    [".localhost", "https://app.localhost/"],
    [".localdomain", "https://localhost.localdomain/"],
    [".internal", "https://metadata.google.internal/"],
    [".home.arpa", "https://router.home.arpa/"],
    [".test", "https://site.test/"],
    [".onion", "https://abcdefghij.onion/"],
    ["a space", "https://example.com/a b"],
    ["a no-break space", "https://example.com/a b"],
    ["a C1 control", "https://example.com/a\u0085b"],
    ["a line separator", "https://example.com/a b"],
    ["a direction override", "https://example.com/a‮b"],
    ["a zero-width space", "https://example.com/a​b"],
    ["a label over 63 characters", `https://${"a".repeat(64)}.com/`],
    ["too long", `https://example.com/${"a".repeat(2048)}`],
  ])("refuses %s", (_why, url) => {
    expect(isImportantLinkUrl(url)).toBe(false);
  });
});

describe("importantLinkHost", () => {
  it.each([
    "https://Example.COM/a",
    "https://shop.example.com:8443/x?y#z",
    "https://shop.example.com:443/",
    "https://parks.example.org?season=2026",
    "https://parks.example.org#top",
  ])("matches the browser's host for %s", (url) => {
    expect(importantLinkHost(url)).toBe(new URL(url).host);
  });
});

describe("ImportantLinkInput", () => {
  const base = {
    label: "Fishing license",
    url: "https://example.com/",
    description: null,
    productIds: null,
    position: 0,
  };
  it("accepts a plain link", () => {
    expect(ImportantLinkInput.safeParse(base).success).toBe(true);
  });
  it.each([
    ["a name with a space at the end", { label: "Parking " }],
    ["a name with a no-break space at the start", { label: " Parking" }],
    ["a name with a direction override", { label: "Parking ‮map" }],
    ["a name with a zero-width space", { label: "Park​ing" }],
    ["a note that is only spaces", { description: "   " }],
    ["a note with a C1 control", { description: "Bring \u0085 cash" }],
    ["an unknown field", { extra: 1 }],
  ])("refuses %s", (_why, change) => {
    expect(ImportantLinkInput.safeParse({ ...base, ...change }).success).toBe(false);
  });
});
