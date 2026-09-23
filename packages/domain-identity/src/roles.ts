import type { StaffRole } from "@tidegrid/contracts";

/**
 * Permissions checked by the API. Each endpoint names exactly one. The matrix
 * follows the pilot product scope: owners manage staff and configuration,
 * booking staff manage bookings and messages but not people or billing, and
 * finance reads financial records and history without changing anything.
 */
export type Permission = "members.read" | "members.manage" | "audit.read";

const matrix: Record<StaffRole, readonly Permission[]> = {
  owner: ["members.read", "members.manage", "audit.read"],
  booking_staff: [],
  finance: ["audit.read"],
};

export function can(role: StaffRole, permission: Permission): boolean {
  return matrix[role]?.includes(permission) ?? false;
}

export function permissionsFor(role: StaffRole): readonly Permission[] {
  return matrix[role] ?? [];
}
