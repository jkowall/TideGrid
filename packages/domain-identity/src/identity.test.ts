import { StaffRole } from "@tidegrid/contracts";
import { describe, expect, it } from "vitest";
import { can, EXPORT_TABLES, exportRow, normalizeHostname, permissionsFor } from "./index.ts";

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
    expect(permissionsFor("booking_staff")).toEqual([
      "catalog.read",
      "trips.manage",
      "bookings.read",
      "payments.read",
      "notes.read",
      "notes.write",
      "waivers.manage",
      "bookings.create",
      "messages.resend",
      "exceptions.resolve",
      "bookings.cancel",
      "payments.record",
      "bookings.reschedule",
    ]);
    expect(permissionsFor("finance")).toEqual([
      "audit.read",
      "catalog.read",
      "payments.read",
      "fees.read",
    ]);
  });

  it("lets only owners and booking staff read and write a booking's notes, never finance", () => {
    expect(StaffRole.options.filter((r) => can(r, "notes.read"))).toEqual([
      "owner",
      "booking_staff",
    ]);
    expect(StaffRole.options.filter((r) => can(r, "notes.write"))).toEqual([
      "owner",
      "booking_staff",
    ]);
  });

  it("shows bookers' contact details to owners and booking staff, and payment exceptions to all", () => {
    expect(StaffRole.options.filter((r) => can(r, "bookings.read"))).toEqual([
      "owner",
      "booking_staff",
    ]);
    expect(StaffRole.options.filter((r) => can(r, "payments.read"))).toEqual([
      "owner",
      "booking_staff",
      "finance",
    ]);
  });

  it("lets owners and booking staff send a waiver request again, not finance (G2.15)", () => {
    expect(StaffRole.options.filter((r) => can(r, "waivers.manage"))).toEqual([
      "owner",
      "booking_staff",
    ]);
  });

  it("lets owners and booking staff create staff-assisted bookings, never finance (G2.12d)", () => {
    expect(StaffRole.options.filter((r) => can(r, "bookings.create"))).toEqual([
      "owner",
      "booking_staff",
    ]);
  });

  it("lets owners and booking staff resolve a payment exception, never finance (W1-FIN-EXC)", () => {
    expect(StaffRole.options.filter((r) => can(r, "exceptions.resolve"))).toEqual([
      "owner",
      "booking_staff",
    ]);
  });

  it("lets owners and booking staff send a booking's email again, never finance (G2.16b)", () => {
    expect(StaffRole.options.filter((r) => can(r, "messages.resend"))).toEqual([
      "owner",
      "booking_staff",
    ]);
    expect(permissionsFor("owner")).toContain("messages.resend");
  });

  it("lets owners and booking staff cancel, and only owners override or adjust credit (W3-G2.9)", () => {
    expect(StaffRole.options.filter((r) => can(r, "bookings.cancel"))).toEqual([
      "owner",
      "booking_staff",
    ]);
    expect(StaffRole.options.filter((r) => can(r, "bookings.override"))).toEqual(["owner"]);
    expect(StaffRole.options.filter((r) => can(r, "credits.adjust"))).toEqual(["owner"]);
  });

  it("lets owners and booking staff record external money, owners alone pay it back (W3-G2.10)", () => {
    expect(StaffRole.options.filter((r) => can(r, "payments.record"))).toEqual([
      "owner",
      "booking_staff",
    ]);
    expect(StaffRole.options.filter((r) => can(r, "payments.refund_external"))).toEqual(["owner"]);
    expect(StaffRole.options.filter((r) => can(r, "fees.read"))).toEqual(["owner", "finance"]);
  });

  it("lets owners and booking staff move a booking, owners alone past its cutoff (W3-G2.11-rest)", () => {
    expect(StaffRole.options.filter((r) => can(r, "bookings.reschedule"))).toEqual([
      "owner",
      "booking_staff",
    ]);
  });

  it("keeps the standard CSV import with owners (W3-G2.13)", () => {
    expect(StaffRole.options.filter((r) => can(r, "imports.run"))).toEqual(["owner"]);
  });

  it("keeps support access, export, and the deletion request with owners (W3-G2.2b)", () => {
    for (const permission of ["support.manage", "data.export", "account.manage"] as const) {
      expect(StaffRole.options.filter((r) => can(r, permission))).toEqual(["owner"]);
    }
  });

  it("lets support read only, and masked unless the owner revealed personal data (W3-G2.2b)", () => {
    expect(permissionsFor("support_masked")).toEqual(permissionsFor("finance"));
    expect(permissionsFor("support_unmasked")).toEqual([
      "audit.read",
      "catalog.read",
      "payments.read",
      "bookings.read",
      "members.read",
      "fees.read",
    ]);
    for (const role of ["support_masked", "support_unmasked"] as const) {
      expect(permissionsFor(role).filter((p) => !p.endsWith(".read"))).toEqual([]);
      expect(can(role, "notes.read")).toBe(false);
    }
    expect(can("support_masked", "bookings.read")).toBe(false);
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

describe("tenant export (W3-G2.2b)", () => {
  it("drops credentials, provider keys, and client addresses from every row", () => {
    expect(
      exportRow({
        id: "1",
        booker_email: "guest@example.test",
        secret_hash: "x",
        token_hash: "x",
        session_hash: "x",
        client_key: "x",
        idempotency_key: "x",
        source_ip: "203.0.113.9",
        signing_secret: "x",
        reference: "ABCD2345",
        document: "\\x255044",
      }),
    ).toEqual({ id: "1", booker_email: "guest@example.test", reference: "ABCD2345" });
  });

  it("leaves out credential, link, and working-state tables", () => {
    for (const table of [
      "staff_sessions",
      "staff_login_tokens",
      "guest_access_links",
      "guest_sessions",
      "idempotency_keys",
      "outbox_events",
      "email_messages",
      "waiver_deliveries",
      "waiver_signing_sessions",
      "support_access_grants",
    ]) {
      expect(EXPORT_TABLES as readonly string[]).not.toContain(table);
    }
  });
});
