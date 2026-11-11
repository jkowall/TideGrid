import type { StaffRole } from "@tidegrid/contracts";

/**
 * Support access (W3-G2.2b): a TideGrid support agent let in by an owner's
 * grant reads, and never writes. A masked grant reads what finance reads:
 * the catalog, money, and the audit history, without the booker's name or
 * email. An owner may choose to reveal personal data, which adds bookings
 * with their bookers and the staff list. Neither reads notes, which are free
 * text that can mention a guest.
 */
export type SupportRole = "support_masked" | "support_unmasked";

/** A member's role, or the role a support grant stands in for. */
export type AccessRole = StaffRole | SupportRole;

/**
 * Permissions checked by the API. Each endpoint names exactly one. The matrix
 * follows the pilot product scope: owners manage staff and configuration,
 * booking staff manage bookings and messages but not people or billing, and
 * finance reads financial records and history without changing anything.
 * Everyone reads the catalog and calendar; only owners change the catalog, and
 * owners and booking staff open, close, cancel, and complete trips. Every role
 * reads bookings as money: references, parties, totals, payments, refunds,
 * and payment exceptions (`payments.read`). Only owners and booking staff
 * (`bookings.read`) also receive the booker's name and email, which the API
 * leaves out of every response for anyone else, and read trip rosters (G2.7,
 * G2.12b). Owners and booking staff read and write a booking's internal
 * notes (G2.12c); finance does neither, since a note is free text that can
 * mention a guest (the owner's decision of 2026-10-19). Owners and booking
 * staff create staff-assisted bookings for a guest who phoned, emailed, or
 * walked up (`bookings.create`, G2.12d); finance changes no booking. Owners
 * and booking staff send a booking's email again (`messages.resend`, G2.16b);
 * finance sends none. Owners and booking staff mark a payment exception as
 * followed up (`exceptions.resolve`, W1-FIN-EXC); finance reads the
 * resolutions as part of the exceptions and resolves none. Owners and booking
 * staff cancel a confirmed booking with its policy's remedy or that value as
 * booking credit (`bookings.cancel`, W3-G2.9); only owners override the
 * policy, with a reason (`bookings.override`), and adjust a booker's credit
 * balance (`credits.adjust`). Finance reads refunds and their exceptions
 * (`payments.read`) and changes none. External money (W3-G2.10): owners and
 * booking staff record cash, check, or other tender a guest paid
 * (`payments.record`); only owners record money paid back outside the card
 * flow (`payments.refund_external`). Owners and finance read TideGrid's fee
 * invoices (`fees.read`); finance still changes nothing. Owners and booking
 * staff move a booking to another trip of its product, or give up a place in
 * a shared-seat party, before its change cutoff (`bookings.reschedule`,
 * W3-G2.11-rest); after the cutoff only an owner, with a reason
 * (`bookings.override`).
 */
export type Permission =
  | "members.read"
  | "members.manage"
  | "audit.read"
  | "catalog.read"
  | "catalog.manage"
  | "trips.manage"
  | "bookings.read"
  | "payments.read"
  // Console completion (G2.12c).
  | "notes.read"
  | "notes.write"
  // Waivers (G2.15): send a participant's waiver request again.
  | "waivers.manage"
  // Staff-assisted bookings (G2.12d): quote, open, pay through the shim, cancel.
  | "bookings.create"
  // Booking email (G2.16b): send a booking's confirmation or cancellation notice again.
  | "messages.resend"
  // Exception resolution (W1-FIN-EXC): mark a payment exception as followed up.
  | "exceptions.resolve"
  // Refunds and credit (W3-G2.9): cancel a confirmed booking with its policy's
  // remedy or its value as credit; override the policy with a reason; adjust
  // a booker's credit balance with a reason.
  | "bookings.cancel"
  | "bookings.override"
  | "credits.adjust"
  // Tenant access remainder (W3-G2.2b), owners only: grant TideGrid support
  // access, export the tenant's data, and ask for the account's deletion.
  | "support.manage"
  | "data.export"
  | "account.manage"
  // External payment and reconciliation (W3-G2.10).
  | "payments.record"
  | "payments.refund_external"
  | "fees.read"
  // Moving a booking to another trip (W3-G2.11-rest).
  | "bookings.reschedule"
  // The standard CSV import (W3-G2.13), owners only.
  | "imports.run";

const matrix: Record<AccessRole, readonly Permission[]> = {
  owner: [
    "members.read",
    "members.manage",
    "audit.read",
    "catalog.read",
    "catalog.manage",
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
    "bookings.override",
    "credits.adjust",
    "support.manage",
    "data.export",
    "account.manage",
    "payments.record",
    "payments.refund_external",
    "fees.read",
    "bookings.reschedule",
    "imports.run",
  ],
  booking_staff: [
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
  ],
  finance: ["audit.read", "catalog.read", "payments.read", "fees.read"],
  support_masked: ["audit.read", "catalog.read", "payments.read", "fees.read"],
  support_unmasked: [
    "audit.read",
    "catalog.read",
    "payments.read",
    "bookings.read",
    "members.read",
    "fees.read",
  ],
};

export function can(role: AccessRole, permission: Permission): boolean {
  return matrix[role]?.includes(permission) ?? false;
}

export function permissionsFor(role: AccessRole): readonly Permission[] {
  return matrix[role] ?? [];
}
