import { describe, expect, it } from "vitest";
import {
  type DeploymentEnvironment,
  parseBrowserOrigin,
  parseHostname,
  parseRequestHost,
} from "./origin.ts";

const local = { environment: "local" } as const;
const deployed: DeploymentEnvironment[] = ["preview", "staging", "production"];

function everywhere(origin: string | null | undefined) {
  return {
    local: parseBrowserOrigin(origin, local),
    ...Object.fromEntries(deployed.map((e) => [e, parseBrowserOrigin(origin, { environment: e })])),
  };
}

describe("strict origin parser (G2.14b, D12 and D13)", () => {
  it("accepts a canonical https origin in every environment", () => {
    for (const parsed of Object.values(everywhere("https://demo-harbor.book.tidegrid.us"))) {
      expect(parsed).toEqual({
        origin: "https://demo-harbor.book.tidegrid.us",
        host: "demo-harbor.book.tidegrid.us",
      });
    }
    // One trailing slash is tolerated; the canonical origin is what comes back.
    expect(parseBrowserOrigin("https://book.harbor.com/", { environment: "production" })).toEqual({
      origin: "https://book.harbor.com",
      host: "book.harbor.com",
    });
  });

  it("refuses http outside local, and locally for anything but *.localhost", () => {
    for (const e of deployed) {
      expect(parseBrowserOrigin("http://book.harbor.com", { environment: e })).toBeNull();
      expect(
        parseBrowserOrigin("http://demo-harbor.book.localhost", { environment: e }),
      ).toBeNull();
    }
    expect(parseBrowserOrigin("http://book.harbor.com", local)).toBeNull();
    expect(parseBrowserOrigin("http://demo-harbor.book.localhost:5361", local)).toEqual({
      origin: "http://demo-harbor.book.localhost:5361",
      host: "demo-harbor.book.localhost",
    });
  });

  it("refuses a trailing dot everywhere", () => {
    for (const parsed of Object.values(everywhere("https://book.harbor.com."))) {
      expect(parsed).toBeNull();
    }
    expect(parseBrowserOrigin("http://demo-harbor.book.localhost.:5361", local)).toBeNull();
  });

  it("refuses an explicit port outside local, and a default port everywhere", () => {
    for (const e of deployed) {
      expect(parseBrowserOrigin("https://book.harbor.com:8443", { environment: e })).toBeNull();
    }
    expect(parseBrowserOrigin("https://book.harbor.com:8443", local)?.host).toBe("book.harbor.com");
    for (const parsed of Object.values(everywhere("https://book.harbor.com:443"))) {
      expect(parsed).toBeNull();
    }
    expect(parseBrowserOrigin("http://a.book.localhost:80", local)).toBeNull();
  });

  it("refuses userinfo, paths, queries, and fragments", () => {
    for (const origin of [
      "https://user@book.harbor.com",
      "https://user:pw@book.harbor.com",
      "https://book.harbor.com/path",
      "https://book.harbor.com//",
      "https://book.harbor.com?x=1",
      "https://book.harbor.com?",
      "https://book.harbor.com#x",
      "https://book.harbor.com\\",
    ]) {
      for (const parsed of Object.values(everywhere(origin))) expect(parsed, origin).toBeNull();
    }
  });

  it("refuses uppercase, which no browser sends", () => {
    for (const origin of ["https://Book.Harbor.com", "HTTPS://book.harbor.com"]) {
      for (const parsed of Object.values(everywhere(origin))) expect(parsed, origin).toBeNull();
    }
  });

  it("refuses Unicode and punycode hostnames", () => {
    for (const origin of ["https://bücher.example.com", "https://xn--bcher-kva.example.com"]) {
      for (const parsed of Object.values(everywhere(origin))) expect(parsed, origin).toBeNull();
    }
  });

  it("refuses IP literals, localhost, null, and empty or absent origins", () => {
    for (const origin of [
      "https://10.0.0.1",
      "http://127.0.0.1:8961",
      "https://[::1]",
      "http://[::1]:5361",
      "http://localhost:5361",
      "https://localhost",
      "null",
      "",
      " ",
      null,
      undefined,
    ]) {
      for (const parsed of Object.values(everywhere(origin))) {
        expect(parsed, String(origin)).toBeNull();
      }
    }
  });

  it("refuses a 64-character label and over-long input", () => {
    const long = `https://${"a".repeat(64)}.harbor.com`;
    for (const parsed of Object.values(everywhere(long))) expect(parsed).toBeNull();
    expect(parseBrowserOrigin(`https://${"a".repeat(63)}.harbor.com`, local)?.host).toBe(
      `${"a".repeat(63)}.harbor.com`,
    );
    expect(parseBrowserOrigin(`https://${"a.".repeat(160)}com`, local)).toBeNull();
  });

  it("drops loopback-only hosts outside local, even over https", () => {
    for (const e of deployed) {
      expect(
        parseBrowserOrigin("https://demo-harbor.book.localhost", { environment: e }),
      ).toBeNull();
    }
    expect(parseBrowserOrigin("https://demo-harbor.book.localhost", local)?.host).toBe(
      "demo-harbor.book.localhost",
    );
  });

  it("refuses control characters, white space, and other schemes", () => {
    for (const origin of [
      "https://book.harbor.com\n",
      "https://book.harbor.com ",
      "https://bo\tok.harbor.com",
      "ftp://book.harbor.com",
      "file://book.harbor.com",
      "chrome-extension://abcdefghijklmnop",
      "book.harbor.com",
    ]) {
      for (const parsed of Object.values(everywhere(origin))) expect(parsed, origin).toBeNull();
    }
  });
});

describe("request host and bare hostname parsing", () => {
  it("reads only the request URL's hostname, with the same rules", () => {
    expect(parseRequestHost("https://demo-harbor.book.tidegrid.us/sw.js", local)).toBe(
      "demo-harbor.book.tidegrid.us",
    );
    expect(
      parseRequestHost("http://demo-reef.book.localhost:5361/manifest.webmanifest", local),
    ).toBe("demo-reef.book.localhost");
    expect(
      parseRequestHost("https://demo-reef.book.localhost/sw.js", { environment: "preview" }),
    ).toBeNull();
    expect(parseRequestHost("https://book.harbor.com./sw.js", local)).toBeNull();
    expect(parseRequestHost("https://10.0.0.1/sw.js", local)).toBeNull();
    expect(parseRequestHost("not a url", local)).toBeNull();
  });

  it("checks a bare hostname again instead of trusting the caller", () => {
    expect(parseHostname("book.harbor.com", { environment: "production" })).toBe("book.harbor.com");
    for (const bad of [
      "Book.Harbor.com",
      "book.harbor.com.",
      "https://book.harbor.com",
      "book.harbor.com:443",
      "xn--bcher-kva.example.com",
      "localhost",
      "",
      42,
      null,
    ]) {
      expect(parseHostname(bad, { environment: "production" }), String(bad)).toBeNull();
    }
    expect(parseHostname("a.book.localhost", { environment: "production" })).toBeNull();
    expect(parseHostname("a.book.localhost", local)).toBe("a.book.localhost");
  });
});
