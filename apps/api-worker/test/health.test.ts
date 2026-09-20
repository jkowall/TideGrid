import { SELF } from "cloudflare:test";
import { HealthResponse } from "@tidegrid/contracts";
import { describe, expect, it } from "vitest";

describe("GET /v1/health", () => {
  it("reports degraded and unconfigured when no database is bound", async () => {
    const res = await SELF.fetch("https://api.test/v1/health");
    expect(res.status).toBe(200);
    expect(res.headers.get("x-request-id")).toMatch(/[0-9a-f-]{36}/);
    const body = HealthResponse.parse(await res.json());
    expect(body.status).toBe("degraded");
    expect(body.database).toBe("unconfigured");
    expect(body.environment).toBe("local");
  });

  it("echoes a well-formed caller-supplied request id and replaces a bad one", async () => {
    const good = await SELF.fetch("https://api.test/v1/health", {
      headers: { "x-request-id": "trace-abc-12345" },
    });
    expect(good.headers.get("x-request-id")).toBe("trace-abc-12345");
    const bad = await SELF.fetch("https://api.test/v1/health", {
      headers: { "x-request-id": "<script>" },
    });
    expect(bad.headers.get("x-request-id")).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("returns a contract-shaped 404 with a request id", async () => {
    const res = await SELF.fetch("https://api.test/v1/nope");
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: { code: string; requestId: string } };
    expect(body.error.code).toBe("not_found");
    expect(body.error.requestId).toBeTruthy();
  });

  it("serves the OpenAPI document", async () => {
    const res = await SELF.fetch("https://api.test/v1/openapi.json");
    expect(res.status).toBe(200);
    const doc = (await res.json()) as { openapi: string; paths: Record<string, unknown> };
    expect(doc.openapi).toBe("3.1.0");
    expect(Object.keys(doc.paths)).toContain("/v1/health");
  });
});

describe("CORS", () => {
  it("allows a configured origin and exposes the request id", async () => {
    const res = await SELF.fetch("https://api.test/v1/health", {
      headers: { origin: "https://guest.test" },
    });
    expect(res.headers.get("access-control-allow-origin")).toBe("https://guest.test");
    expect(res.headers.get("access-control-expose-headers")).toContain("X-Request-Id");
  });

  it("answers a preflight for a configured origin", async () => {
    const res = await SELF.fetch("https://api.test/v1/health", {
      method: "OPTIONS",
      headers: {
        origin: "https://console.test",
        "access-control-request-method": "POST",
        "access-control-request-headers": "idempotency-key",
      },
    });
    expect(res.status).toBe(204);
    expect(res.headers.get("access-control-allow-origin")).toBe("https://console.test");
    expect(res.headers.get("access-control-allow-headers")).toContain("Idempotency-Key");
  });

  it("does not reflect an unknown origin", async () => {
    const res = await SELF.fetch("https://api.test/v1/health", {
      headers: { origin: "https://evil.example" },
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("access-control-allow-origin")).toBeNull();
  });
});
