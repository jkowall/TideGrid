import { describe, expect, it } from "vitest";
import { ErrorResponse, HealthResponse } from "./index.ts";

describe("contracts", () => {
  it("accepts a well-formed health response", () => {
    const parsed = HealthResponse.safeParse({
      status: "ok",
      version: "dev",
      environment: "local",
      database: "ok",
      migrations: { applied: 1, latest: "0001_foundation.sql" },
      time: "2026-09-20T12:00:00Z",
    });
    expect(parsed.success).toBe(true);
  });

  it("rejects an unknown environment", () => {
    const parsed = HealthResponse.safeParse({
      status: "ok",
      version: "dev",
      environment: "prod",
      database: "ok",
      migrations: null,
      time: "2026-09-20T12:00:00Z",
    });
    expect(parsed.success).toBe(false);
  });

  it("requires a request id on errors", () => {
    expect(ErrorResponse.safeParse({ error: { code: "x", message: "y" } }).success).toBe(false);
  });
});
