import type { StaffRole } from "@tidegrid/contracts";

export const roleLabels: Record<StaffRole, string> = {
  owner: "Owner",
  booking_staff: "Booking staff",
  finance: "Finance (read-only)",
};

/** A role as a noun in a sentence: "Your role, finance, ..." */
export const roleNames: Record<StaffRole, string> = {
  owner: "owner",
  booking_staff: "booking staff",
  finance: "finance",
};

/**
 * Who may publish, close, reopen, cancel, or complete a trip. This mirrors the
 * API's `trips.manage` permission for display only; the API decides.
 */
export function canChangeTrips(role: StaffRole): boolean {
  return role === "owner" || role === "booking_staff";
}
