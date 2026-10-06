import { SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";

async function errorCode(res: Response): Promise<string> {
  return ((await res.json()) as { error: { code: string } }).error.code;
}

describe("the public entry hides staff and sign-in routes", () => {
  for (const [method, path] of [
    ["GET", "/v1/me"],
    ["POST", "/v1/auth/login-links"],
    ["POST", "/v1/auth/sessions"],
    ["DELETE", "/v1/auth/sessions/current"],
    ["GET", "/v1/staff/tenants/11111111-1111-4111-8111-111111111111/members"],
  ] as const) {
    it(`answers ${method} ${path} with the ordinary 404`, async () => {
      const res = await SELF.fetch(`https://api.test${path}`, {
        method,
        headers: { origin: "https://console.test", "content-type": "application/json" },
        body: method === "GET" ? null : "{}",
      });
      expect(res.status).toBe(404);
      expect(await errorCode(res)).toBe("not_found");
    });
  }
});

describe("staff authentication fails closed before touching the database", () => {
  it("answers 401 unauthenticated with no credentials", async () => {
    const res = await SELF.fetch("http://localhost/v1/me");
    expect(res.status).toBe(401);
    expect(await errorCode(res)).toBe("unauthenticated");
  });

  it("answers 401 for a malformed session cookie", async () => {
    const res = await SELF.fetch("http://localhost/v1/me", {
      headers: { cookie: "__Host-tg_session=not-a-token" },
    });
    expect(res.status).toBe(401);
    expect(await errorCode(res)).toBe("session_invalid");
  });

  it("refuses an Access assertion where Access is not configured", async () => {
    const res = await SELF.fetch("http://localhost/v1/me", {
      headers: { "cf-access-jwt-assertion": "eyJhbGciOiJub25lIn0.e30." },
    });
    expect(res.status).toBe(401);
    expect(await errorCode(res)).toBe("access_not_configured");
  });

  it("authenticates before revealing whether a tenant id is valid", async () => {
    const res = await SELF.fetch("http://localhost/v1/staff/tenants/not-a-uuid/members");
    expect(res.status).toBe(401);
  });
});

describe("state-changing staff requests require the console origin", () => {
  for (const [label, headers] of [
    ["no Origin", {}],
    ["a foreign Origin", { origin: "https://evil.example" }],
    ["a guest Origin", { origin: "https://guest.test" }],
  ] as const) {
    it(`rejects ${label}`, async () => {
      const res = await SELF.fetch("http://localhost/v1/auth/login-links", {
        method: "POST",
        headers: { "content-type": "application/json", ...headers },
        body: JSON.stringify({ email: "someone@example.test" }),
      });
      expect(res.status).toBe(403);
      expect(await errorCode(res)).toBe("origin_not_allowed");
    });
  }

  it("rejects a member change without the console origin even before authentication", async () => {
    const res = await SELF.fetch(
      "http://localhost/v1/staff/tenants/11111111-1111-4111-8111-111111111111/members",
      { method: "POST", headers: { "content-type": "application/json" }, body: "{}" },
    );
    expect(res.status).toBe(403);
  });
});

describe("public tenant resolution", () => {
  it("answers 404 without an Origin", async () => {
    const res = await SELF.fetch("https://api.test/v1/public/tenant");
    expect(res.status).toBe(404);
    expect(await errorCode(res)).toBe("tenant_not_found");
  });

  it("answers 404 for an IP-literal Origin", async () => {
    const res = await SELF.fetch("https://api.test/v1/public/tenant", {
      headers: { origin: "http://10.0.0.1" },
    });
    expect(res.status).toBe(404);
  });
});

describe("contract", () => {
  it("documents the staff routes and both security schemes", async () => {
    const doc = (await (await SELF.fetch("https://api.test/v1/openapi.json")).json()) as {
      paths: Record<string, unknown>;
      components: { securitySchemes: Record<string, unknown> };
    };
    expect(Object.keys(doc.paths).sort()).toEqual(
      [
        "/v1/auth/login-links",
        "/v1/auth/sessions",
        "/v1/auth/sessions/current",
        "/v1/health",
        "/v1/me",
        "/v1/public/tenant",
        "/v1/public/trips",
        "/v1/public/trips/{tripId}/offer",
        "/v1/public/quotes",
        "/v1/public/quotes/{quoteId}",
        "/v1/staff/tenants/{tenantId}/audit-events",
        "/v1/staff/tenants/{tenantId}/catalog",
        "/v1/staff/tenants/{tenantId}/members",
        "/v1/staff/tenants/{tenantId}/products/{productId}/publish",
        "/v1/staff/tenants/{tenantId}/schedules/{scheduleId}/trips",
        "/v1/staff/tenants/{tenantId}/trips",
        "/v1/staff/tenants/{tenantId}/trips/{tripId}/sales-state",
        // Capacity and holds (G2.6).
        "/v1/staff/tenants/{tenantId}/trips/{tripId}/holds",
      ].sort(),
    );
    expect(Object.keys(doc.components.securitySchemes).sort()).toEqual([
      "accessJwt",
      "sessionCookie",
    ]);
  });
});
