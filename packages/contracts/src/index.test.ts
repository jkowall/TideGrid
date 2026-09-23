import { describe, expect, it } from "vitest";
import {
  ErrorResponse,
  HealthResponse,
  MemberCreateRequest,
  OpaqueToken,
  StaffRole,
} from "./index.ts";

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

  it("lists exactly the three pilot roles", () => {
    expect(StaffRole.options).toEqual(["owner", "booking_staff", "finance"]);
  });

  it("requires a reason and a known role to add a member", () => {
    const base = { email: "a@example.test", displayName: "A", role: "owner", reason: "hire" };
    expect(MemberCreateRequest.safeParse(base).success).toBe(true);
    expect(MemberCreateRequest.safeParse({ ...base, reason: "  " }).success).toBe(false);
    expect(MemberCreateRequest.safeParse({ ...base, role: "admin" }).success).toBe(false);
  });

  it("accepts only 43-character base64url opaque tokens", () => {
    expect(OpaqueToken.safeParse("a".repeat(43)).success).toBe(true);
    expect(OpaqueToken.safeParse("a".repeat(42)).success).toBe(false);
    expect(OpaqueToken.safeParse(`${"a".repeat(42)}=`).success).toBe(false);
  });
});
