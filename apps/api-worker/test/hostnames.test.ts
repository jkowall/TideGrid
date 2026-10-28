import { createExecutionContext, env, SELF } from "cloudflare:test";
import { createFakeHostnameProvider } from "@tidegrid/domain-hostnames";
import { describe, expect, it } from "vitest";
import type { Bindings } from "../src/env.ts";
import { PreflightProjection } from "../src/hostnames/cors.ts";
import { hostnameProvider, hostnameSettings } from "../src/hostnames.ts";
import { GuestGateway } from "../src/index.ts";

const base = env as unknown as Bindings;
const zone = "0123456789abcdef0123456789abcdef";

describe("custom hostname provider selection (G2.14b)", () => {
  it("is off unless a provider is named", () => {
    expect(hostnameSettings({ ...base })).toEqual({
      kind: "off",
      reason: "unset",
    });
    expect(hostnameProvider({ ...base })).toBeNull();
  });

  it("accepts the fake only in local development and never beside a SaaS zone", () => {
    expect(hostnameSettings({ ...base, ENVIRONMENT: "local", HOSTNAME_PROVIDER: "fake" })).toEqual({
      kind: "fake",
    });
    for (const environment of ["preview", "staging", "production"] as const) {
      expect(
        hostnameSettings({ ...base, ENVIRONMENT: environment, HOSTNAME_PROVIDER: "fake" }),
      ).toEqual({ kind: "refused", reason: "fake_outside_local" });
    }
    for (const environment of ["local", "preview", "production"] as const) {
      expect(
        hostnameSettings({
          ...base,
          ENVIRONMENT: environment,
          HOSTNAME_PROVIDER: "fake",
          CF_SAAS_ZONE_ID: zone,
        }),
      ).toEqual({ kind: "refused", reason: "fake_with_zone" });
    }
    expect(hostnameSettings({ ...base, HOSTNAME_PROVIDER: "stripe" })).toEqual({
      kind: "refused",
      reason: "unknown_provider",
    });
  });

  it("reads only an injected fake, because a fake built in a Worker knows no hostname", () => {
    const local = { ...base, ENVIRONMENT: "local" as const, HOSTNAME_PROVIDER: "fake" };
    expect(hostnameProvider(local)).toBeNull();
    const fake = createFakeHostnameProvider();
    expect(hostnameProvider(local, fake)).toBe(fake);
    expect(hostnameProvider({ ...local, ENVIRONMENT: "preview" }, fake)).toBeNull();
  });

  it("needs the zone and the token for Cloudflare for SaaS", () => {
    const saas = { ...base, ENVIRONMENT: "preview" as const, HOSTNAME_PROVIDER: "cloudflare_saas" };
    expect(hostnameSettings(saas)).toEqual({ kind: "off", reason: "zone_missing" });
    expect(hostnameSettings({ ...saas, CF_SAAS_ZONE_ID: zone })).toEqual({
      kind: "off",
      reason: "token_missing",
    });
    const on = { ...saas, CF_SAAS_ZONE_ID: zone, CF_SAAS_API_TOKEN: "synthetic-token" };
    expect(hostnameSettings(on)).toMatchObject({
      kind: "cloudflare_saas",
      routingTarget: "customers.tidegrid.us",
    });
    expect(hostnameProvider(on)?.name).toBe("cloudflare_saas");
  });
});

describe("the preflight projection (G2.14b)", () => {
  it("keeps at most its capacity, least recently used out first", () => {
    const cache = new PreflightProjection(3, 30_000);
    for (const o of ["https://a.example.com", "https://b.example.com", "https://c.example.com"]) {
      cache.set(o, true, 0);
    }
    expect(cache.get("https://a.example.com", 1)).toBe(true);
    cache.set("https://d.example.com", false, 1);
    expect(cache.size).toBe(3);
    expect(cache.get("https://b.example.com", 2)).toBeUndefined();
    expect(cache.get("https://a.example.com", 2)).toBe(true);
    expect(cache.get("https://d.example.com", 2)).toBe(false);
  });

  it("forgets positives and negatives alike after 30 seconds", () => {
    const cache = new PreflightProjection();
    cache.set("https://a.example.com", true, 0);
    cache.set("https://b.example.com", false, 0);
    expect(cache.get("https://a.example.com", 29_999)).toBe(true);
    expect(cache.get("https://a.example.com", 30_000)).toBeUndefined();
    expect(cache.get("https://b.example.com", 30_001)).toBeUndefined();
  });

  it("stays capped under a flood of unique origins", () => {
    const cache = new PreflightProjection();
    for (let i = 0; i < 5_000; i++) cache.set(`https://h${i}.example.com`, false, 0);
    expect(cache.size).toBe(1_000);
  });
});

describe("public CORS without a database (G2.14b)", () => {
  async function call(path: string, origin: string, method = "GET") {
    return SELF.fetch(`https://api.test${path}`, {
      method,
      headers: {
        origin,
        ...(method === "OPTIONS"
          ? {
              "access-control-request-method": "POST",
              "access-control-request-headers": "content-type",
            }
          : {}),
      },
    });
  }

  it("answers a rejected origin's bootstrap with the shared 404, no grant, and Vary", async () => {
    for (const origin of [
      "http://10.0.0.1",
      "null",
      "https://book.example.com.",
      "https://book.example.com:443",
      "http://book.example.com",
      "https://Book.Example.com",
      "https://xn--bcher-kva.example.com",
      "https://user@book.example.com",
    ]) {
      const res = await call("/v1/public/tenant", origin);
      expect({ origin, status: res.status }).toEqual({ origin, status: 404 });
      expect(((await res.json()) as { error: { code: string } }).error.code).toBe(
        "tenant_not_found",
      );
      expect(res.headers.get("access-control-allow-origin")).toBeNull();
      expect(res.headers.get("vary")).toMatch(/\bOrigin\b/);
      expect(res.headers.get("access-control-allow-credentials")).toBeNull();
    }
  });

  it("refuses a rejected origin on every other public route before any database call", async () => {
    for (const path of [
      "/v1/public/trips?from=2099-01-01&to=2000-01-01",
      "/v1/public/trips?party=nope",
      "/v1/public/quotes/00000000-0000-4000-8000-000000000000",
    ]) {
      const res = await call(path, "http://10.0.0.1");
      expect({ path, status: res.status }).toEqual({ path, status: 404 });
      expect(res.headers.get("access-control-allow-origin")).toBeNull();
      expect(res.headers.get("vary")).toMatch(/\bOrigin\b/);
    }
  });

  it("answers preflights with Vary and no grant for a rejected origin", async () => {
    for (const path of ["/v1/public/tenant", "/v1/public/quotes"]) {
      const res = await call(path, "https://book.example.com:443", "OPTIONS");
      expect(res.status).toBe(204);
      expect(res.headers.get("access-control-allow-origin")).toBeNull();
      expect(res.headers.get("vary")).toMatch(/\bOrigin\b/);
    }
  });

  it("lets any strictly parsed origin preflight the bootstrap, never with credentials", async () => {
    const res = await call("/v1/public/tenant", "https://book.example.com", "OPTIONS");
    expect(res.headers.get("access-control-allow-origin")).toBe("https://book.example.com");
    expect(res.headers.get("access-control-allow-credentials")).toBeNull();
    expect(res.headers.get("vary")).toMatch(/\bOrigin\b/);
  });

  it("keeps staff routes on their own allowlist", async () => {
    const res = await call("/v1/staff/memberships", "https://book.example.com", "OPTIONS");
    expect(res.headers.get("access-control-allow-origin")).toBeNull();
  });
});

describe("GuestGateway (G2.14b)", () => {
  it("exposes one method and no fetch, so no app route is reachable through it", () => {
    expect(Object.getOwnPropertyNames(GuestGateway.prototype).sort()).toEqual([
      "constructor",
      "resolveHost",
    ]);
    const gateway = new GuestGateway(createExecutionContext(), env);
    expect((gateway as unknown as { fetch?: unknown }).fetch).toBeUndefined();
  });

  it("parses the host itself and answers a definite miss without the database", async () => {
    const gateway = new GuestGateway(createExecutionContext(), env);
    for (const host of [
      "Book.Example.com",
      "book.example.com.",
      "https://book.example.com",
      "book.example.com:443",
      "10.0.0.1",
      "localhost",
      "xn--bcher-kva.example.com",
      "",
      42,
      null,
      { toString: () => "book.example.com" },
    ]) {
      expect(await gateway.resolveHost(host)).toEqual({ kind: "miss" });
    }
    const preview = new GuestGateway(createExecutionContext(), {
      ...env,
      ENVIRONMENT: "preview",
    } as never);
    expect(await preview.resolveHost("demo-harbor.book.localhost")).toEqual({ kind: "miss" });
  });

  it("throws on an accepted host when the database is unreachable, which is not a miss", async () => {
    const gateway = new GuestGateway(createExecutionContext(), env);
    await expect(gateway.resolveHost("demo-harbor.book.tidegrid.us")).rejects.toThrow(
      /database_unconfigured/,
    );
  });
});
