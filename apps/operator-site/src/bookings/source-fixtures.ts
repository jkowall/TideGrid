import type { BookingDayTrip, BookingListItem } from "@tidegrid/contracts";
import {
  bookers,
  charterTrip,
  dayBody,
  luisBooking,
  mayaBooking,
  priyaBooking,
  sunsetTrip,
} from "./fixtures.ts";

/**
 * G2.12e test data for the day list by source, built on the shared booking
 * fixtures without changing them. A day answer here always names its source
 * the way the API echoes it, null for every source.
 */

export const staffBookingId = "3c1f6a52-9d44-4e0b-8a6f-2b7d5c9e0a21";
export const staffBookingTwoId = "3c1f6a52-9d44-4e0b-8a6f-2b7d5c9e0a23";

/** A walk-up booked by staff on the sunset cruise. */
export const staffBooking: BookingListItem = {
  id: staffBookingId,
  reference: "K7DESK42",
  tripId: sunsetTrip.tripId,
  state: "confirmed",
  source: "staff_assisted",
  channel: "walk_up",
  confirmedAt: "2026-10-08T13:10:00.000Z",
  booker: { name: bookers.priya.name },
  party: { kind: "tickets", guests: 2, tickets: [{ code: "adult", name: "Adult", quantity: 2 }] },
  extras: [],
  total: 9000,
  currency: "USD",
  payment: { state: "succeeded", refund: null },
};

/** A booking from a source this console does not know yet: it lists, with no badge. */
export const importedBooking: BookingListItem = {
  ...luisBooking,
  id: "3c1f6a52-9d44-4e0b-8a6f-2b7d5c9e0a22",
  reference: "M9TRVL3X",
  source: "imported" as BookingListItem["source"],
  channel: null,
};

/**
 * A trip as the API sends it since G2.12e: when its sales close and whether a
 * blackout covers it. Sales close an hour before departure by default.
 */
export function bookable(
  trip: BookingDayTrip,
  over: Partial<Pick<BookingDayTrip, "salesCloseAt" | "blackedOut">> = {},
): BookingDayTrip {
  return {
    ...trip,
    salesCloseAt: new Date(Date.parse(trip.startsAt) - 3_600_000).toISOString(),
    blackedOut: false,
    ...over,
  };
}

/** A trip with counts of one source only. */
export const counted = (trip: BookingDayTrip, bookings: number, guests: number) => ({
  ...trip,
  bookings,
  guests,
});

/** Wednesday with every source: the shared day plus a staff walk-up on the sunset cruise. */
export function allSourcesBody(over: Parameters<typeof dayBody>[0] = {}) {
  return {
    ...dayBody({
      trips: [bookable(charterTrip), counted(bookable(sunsetTrip), 3, 7)],
      bookings: [priyaBooking, mayaBooking, luisBooking, staffBooking],
      ...over,
    }),
    source: null,
  };
}

/** Wednesday's staff bookings: the walk-up alone, with staff counts. */
export function staffBody(over: Parameters<typeof dayBody>[0] = {}) {
  return {
    ...dayBody({
      trips: [counted(bookable(charterTrip), 0, 0), counted(bookable(sunsetTrip), 1, 2)],
      bookings: [staffBooking],
      ...over,
    }),
    source: "staff_assisted",
  };
}

/** Wednesday's online bookings: everything but the walk-up. */
export function directBody(over: Parameters<typeof dayBody>[0] = {}) {
  return {
    ...dayBody({
      trips: [bookable(charterTrip), bookable(sunsetTrip)],
      ...over,
    }),
    source: "direct",
  };
}

/** A day with no trips, as any filter answers it. */
export const emptyDay = (date: string, source: string | null) => ({
  ...dayBody({ date, trips: [], bookings: [] }),
  source,
});
