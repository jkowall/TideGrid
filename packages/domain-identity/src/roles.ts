import type { StaffRole } from "@tidegrid/contracts";

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
 * finance sends none.
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
  | "messages.resend";

const matrix: Record<StaffRole, readonly Permission[]> = {
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
  ],
  finance: ["audit.read", "catalog.read", "payments.read"],
};

export function can(role: StaffRole, permission: Permission): boolean {
  return matrix[role]?.includes(permission) ?? false;
}

export function permissionsFor(role: StaffRole): readonly Permission[] {
  return matrix[role] ?? [];
}
