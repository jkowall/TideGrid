import type { StaffRole } from "@tidegrid/contracts";

/**
 * Permissions checked by the API. Each endpoint names exactly one. The matrix
 * follows the pilot product scope: owners manage staff and configuration,
 * booking staff manage bookings and messages but not people or billing, and
 * finance reads financial records and history without changing anything.
 * Everyone reads the catalog and calendar; only owners change the catalog, and
 * owners and booking staff open, close, cancel, and complete trips.
 */
export type Permission =
  | "members.read"
  | "members.manage"
  | "audit.read"
  | "catalog.read"
  | "catalog.manage"
  | "trips.manage";

const matrix: Record<StaffRole, readonly Permission[]> = {
  owner: [
    "members.read",
    "members.manage",
    "audit.read",
    "catalog.read",
    "catalog.manage",
    "trips.manage",
  ],
  booking_staff: ["catalog.read", "trips.manage"],
  finance: ["audit.read", "catalog.read"],
};

export function can(role: StaffRole, permission: Permission): boolean {
  return matrix[role]?.includes(permission) ?? false;
}

export function permissionsFor(role: StaffRole): readonly Permission[] {
  return matrix[role] ?? [];
}
