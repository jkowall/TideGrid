import { afterEach, describe, expect, it, vi } from "vitest";
import { integrationAdminUrl, isNeonHost } from "./testing.ts";

describe("isNeonHost", () => {
  it("is true for Neon endpoints, direct and pooled", () => {
    expect(isNeonHost("postgresql://o:p@ep-cool-name-123.us-east-2.aws.neon.tech/neondb")).toBe(
      true,
    );
    expect(
      isNeonHost("postgresql://o:p@ep-x-pooler.eu-central-1.aws.neon.tech/db?sslmode=require"),
    ).toBe(true);
  });

  it("is false for the local container and look-alike hosts", () => {
    expect(isNeonHost("postgresql://postgres:postgres@127.0.0.1:55432/tidegrid")).toBe(false);
    expect(isNeonHost("postgresql://postgres:postgres@localhost:5432/tidegrid")).toBe(false);
    expect(isNeonHost("postgresql://o:p@neon.tech.example.com/db")).toBe(false);
    expect(isNeonHost("postgresql://o:p@notneon.tech/db")).toBe(false);
  });
});

describe("integrationAdminUrl", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("fails rather than skips in CI when DATABASE_URL is unset", () => {
    vi.stubEnv("CI", "true");
    vi.stubEnv("DATABASE_URL", "");
    expect(() => integrationAdminUrl()).toThrow(/DATABASE_URL is required in CI/);
  });

  it("skips outside CI when DATABASE_URL is unset", () => {
    vi.stubEnv("CI", "");
    vi.stubEnv("DATABASE_URL", "");
    expect(integrationAdminUrl()).toBeNull();
  });

  it("refuses a database not marked as throwaway", () => {
    vi.stubEnv("DATABASE_URL", "postgresql://postgres:postgres@127.0.0.1:55432/tidegrid");
    vi.stubEnv("TIDEGRID_EPHEMERAL_DB", "");
    expect(() => integrationAdminUrl()).toThrow(/TIDEGRID_EPHEMERAL_DB=1/);
  });
});
