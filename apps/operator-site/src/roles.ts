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

/**
 * Who receives the booker's name and email, and reads trip rosters (G2.12b).
 * This mirrors the API's `bookings.read` permission for display only. The API
 * leaves the details out of every answer to anyone else, so the console never
 * relies on hiding them.
 */
export function canSeeGuests(role: StaffRole): boolean {
  return role === "owner" || role === "booking_staff";
}
