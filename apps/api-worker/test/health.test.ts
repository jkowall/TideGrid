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

  it("echoes a caller-supplied request id", async () => {
    const res = await SELF.fetch("https://api.test/v1/health", {
      headers: { "x-request-id": "abc-123" },
    });
    expect(res.headers.get("x-request-id")).toBe("abc-123");
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
