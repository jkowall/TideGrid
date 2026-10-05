import { StaffRole } from "@tidegrid/contracts";
import { describe, expect, it } from "vitest";
import { can, normalizeHostname, permissionsFor } from "./index.ts";

describe("role permissions", () => {
  it("lets only owners read and manage members", () => {
    expect(StaffRole.options.filter((r) => can(r, "members.manage"))).toEqual(["owner"]);
    expect(StaffRole.options.filter((r) => can(r, "members.read"))).toEqual(["owner"]);
  });

  it("lets owners and finance read audit history, not booking staff", () => {
    expect(StaffRole.options.filter((r) => can(r, "audit.read"))).toEqual(["owner", "finance"]);
  });

  it("lets every role read the catalog, only owners change it, and owners and booking staff move trips", () => {
    expect(StaffRole.options.filter((r) => can(r, "catalog.read"))).toEqual([
      "owner",
      "booking_staff",
      "finance",
    ]);
    expect(StaffRole.options.filter((r) => can(r, "catalog.manage"))).toEqual(["owner"]);
    expect(StaffRole.options.filter((r) => can(r, "trips.manage"))).toEqual([
      "owner",
      "booking_staff",
    ]);
    expect(permissionsFor("booking_staff")).toEqual(["catalog.read", "trips.manage"]);
    expect(permissionsFor("finance")).toEqual(["audit.read", "catalog.read"]);
  });

  it("denies unknown roles", () => {
    expect(can("admin" as never, "members.read")).toBe(false);
  });
});

describe("normalizeHostname", () => {
  it.each([
    ["demo-harbor.book.tidegrid.us", "demo-harbor.book.tidegrid.us"],
    ["Demo-Harbor.Book.TideGrid.US.", "demo-harbor.book.tidegrid.us"],
    ["https://book.operator.example:8443", "book.operator.example"],
    ["book.bücher.example", "book.xn--bcher-kva.example"],
  ])("normalizes %s", (input, expected) => {
    expect(normalizeHostname(input)).toBe(expected);
  });

  it.each([
    "",
    "localhost",
    "null",
    "10.0.0.1",
    "https://[::1]",
    "under_score.example",
    "-lead.example",
    "trail-.example",
    "host.123",
    "has space.example",
    `${"a".repeat(64)}.example`,
    undefined,
    null,
  ])("rejects %s", (input) => {
    expect(normalizeHostname(input as string)).toBeNull();
  });
});
