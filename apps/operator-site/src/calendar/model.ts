import type { StaffTrip, TripSalesState, TripSalesStateRequest } from "@tidegrid/contracts";
import type { IconName, StatusTone } from "@tidegrid/design-system/components";
import {
  addDays,
  earlier,
  formatDate,
  formatTripTime,
  isLocalDate,
  type LocalDate,
  later,
  startOfWeek,
} from "@tidegrid/design-system/format";

/**
 * The calendar's rules, apart from React: weeks, how each sales state reads,
 * which changes a trip offers, and how each API failure reads.
 */

/** Weeks run Sunday to Saturday, so Nov 1 to 7, 2026 is one week. */
export function weekOf(date: LocalDate): { start: LocalDate; end: LocalDate; days: LocalDate[] } {
  const start = startOfWeek(date);
  const days = Array.from({ length: 7 }, (_, i) => addDays(start, i));
  return { start, end: addDays(start, 6), days };
}

/** Staff page two years back and two years ahead of today. */
export const horizonDays = 730;
/** The API's date range: weeks must start on or after the first and end by the last. */
const apiFirstDate = "2000-01-02";
const apiLastDate = "2099-12-30";

/** The first and last week a person can reach, as the Sundays that start them. */
export function weekBounds(today: LocalDate): { first: LocalDate; last: LocalDate } {
  const firstAllowed = startOfWeek(addDays(apiFirstDate, 6));
  const lastAllowed = startOfWeek(addDays(apiLastDate, -6));
  return {
    first: later(firstAllowed, startOfWeek(addDays(today, -horizonDays))),
    last: earlier(lastAllowed, startOfWeek(addDays(today, horizonDays))),
  };
}

/** A week start kept within the bounds. */
export function clampWeek(start: LocalDate, today: LocalDate): LocalDate {
  const { first, last } = weekBounds(today);
  return later(first, earlier(startOfWeek(start), last));
}

/**
 * Read `?week=` from the address: any date in the week, kept within two years
 * of today, or this week when it is missing or unreadable.
 */
export function readWeek(search: string, today: LocalDate): LocalDate {
  const value = new URLSearchParams(search).get("week") ?? "";
  return isLocalDate(value) ? clampWeek(value, today) : startOfWeek(today);
}

/** Whether a value is a sales state this console knows how to show. */
export function isKnownSalesState(value: unknown): value is TripSalesState {
  return typeof value === "string" && Object.hasOwn(salesStates, value);
}

export const salesStates: Record<
  TripSalesState,
  { label: string; tone: StatusTone; icon: IconName; meaning: string }
> = {
  draft: { label: "Draft", tone: "pending", icon: "pencil", meaning: "Not on sale yet." },
  published: {
    label: "Published",
    tone: "ready",
    icon: "check-circle",
    meaning: "On sale to guests until the booking cutoff.",
  },
  closed: {
    label: "Closed",
    tone: "warning",
    icon: "lock",
    meaning: "Sales closed by staff. Guests can't book it.",
  },
  canceled: {
    label: "Canceled",
    tone: "blocked",
    icon: "x-octagon",
    meaning: "The trip will not run. Final.",
  },
  completed: {
    label: "Completed",
    tone: "neutral",
    icon: "flag",
    meaning: "The trip ran. Final.",
  },
};

export type ActionKind = "publish" | "reopen" | "close" | "complete" | "cancel";

export interface ActionCopy {
  to: TripSalesStateRequest["to"];
  /** The button on the trip. */
  button: string;
  icon: IconName;
  /** The dialog. */
  title: string;
  confirm: string;
  busy: string;
  back: string;
  /** Said after the change. */
  done: string;
  /**
   * Destructive and final: the dialog is the danger kind and its one action
   * is a danger button. Completing is final too, but it records what
   * happened, so it confirms with an ordinary primary action.
   */
  danger: boolean;
}

export const actionCopy: Record<ActionKind, ActionCopy> = {
  publish: {
    to: "published",
    button: "Publish",
    icon: "check-circle",
    title: "Publish this trip?",
    confirm: "Publish trip",
    busy: "Publishing…",
    back: "Keep as draft",
    done: "Published",
    danger: false,
  },
  reopen: {
    to: "published",
    button: "Reopen sales",
    icon: "unlock",
    title: "Reopen sales?",
    confirm: "Reopen sales",
    busy: "Reopening…",
    back: "Keep closed",
    done: "Sales reopened",
    danger: false,
  },
  close: {
    to: "closed",
    button: "Close sales",
    icon: "lock",
    title: "Close sales?",
    confirm: "Close sales",
    busy: "Closing sales…",
    back: "Keep selling",
    done: "Sales closed",
    danger: false,
  },
  complete: {
    to: "completed",
    button: "Mark completed",
    icon: "flag",
    title: "Mark this trip completed?",
    confirm: "Mark completed",
    busy: "Saving…",
    back: "Not yet",
    done: "Marked completed",
    danger: false,
  },
  cancel: {
    to: "canceled",
    button: "Cancel trip",
    icon: "x-octagon",
    title: "Cancel this trip?",
    confirm: "Cancel trip",
    busy: "Canceling…",
    back: "Keep trip",
    done: "Trip canceled",
    danger: true,
  },
};

export function hasDeparted(trip: Pick<StaffTrip, "startsAt">, now: Date): boolean {
  return Date.parse(trip.startsAt) <= now.getTime();
}

export function cutoffPassed(trip: Pick<StaffTrip, "salesCloseAt">, now: Date): boolean {
  return Date.parse(trip.salesCloseAt) <= now.getTime();
}

/**
 * The changes a trip offers, in the API's transition rules: publish from
 * draft, close from published, reopen from closed, cancel from any state that
 * is not final, and complete once the trip has departed.
 *
 * Publishing, closing, and reopening only matter while guests can still book,
 * so they are offered until the booking cutoff. After it, a trip that has not
 * left offers cancel only, and a departed trip offers complete and cancel.
 */
export function actionsFor(
  trip: Pick<StaffTrip, "salesState" | "startsAt" | "salesCloseAt">,
  now: Date,
) {
  if (trip.salesState === "canceled" || trip.salesState === "completed") return [];
  if (hasDeparted(trip, now)) {
    return trip.salesState === "draft"
      ? (["cancel"] as ActionKind[])
      : (["complete", "cancel"] as ActionKind[]);
  }
  if (cutoffPassed(trip, now)) return ["cancel"] as ActionKind[];
  const sales: Record<"draft" | "published" | "closed", ActionKind> = {
    draft: "publish",
    published: "close",
    closed: "reopen",
  };
  return [sales[trip.salesState], "cancel"] as ActionKind[];
}

/** What the dialog says a change does, in the operator's words, for this trip now. */
export function consequence(
  kind: ActionKind,
  trip: { cutoff: string; cutoffPassed: boolean; departed: boolean; blackedOut: boolean },
): string {
  const hidden = trip.blackedOut
    ? " A blackout covers this trip, so guests don't see it while the blackout applies."
    : "";
  switch (kind) {
    case "publish":
      return trip.blackedOut
        ? "A blackout covers this trip, so guests can't see or book it while the blackout applies, even once it is published."
        : `Guests can book this trip until the booking cutoff, ${trip.cutoff}.`;
    case "reopen":
      return trip.blackedOut
        ? "A blackout covers this trip, so guests can't see or book it while the blackout applies, even with sales open."
        : `Guests can book this trip again until the booking cutoff, ${trip.cutoff}.`;
    case "close":
      return `Guests can't book this trip while sales are closed. Existing bookings stay as they are, and you can reopen sales before the booking cutoff, ${trip.cutoff}.${hidden}`;
    case "complete":
      return "This records that the trip ran. Completed is final.";
    case "cancel":
      if (trip.departed) {
        return "Canceling is final. It records that this trip did not run, and it can't be marked completed afterwards. Existing bookings are not changed.";
      }
      if (trip.cutoffPassed) {
        return "Canceling is final. Online booking for this trip has already closed, and it can't be reopened or completed. Existing bookings are not changed.";
      }
      return "Canceling is final. Guests can't book the trip from now on, and it can't be reopened or completed. Existing bookings are not changed.";
  }
}

/**
 * The trip's start on the marina's clock, with the zone's short name in the
 * hour clocks go back, when the same time happens twice.
 */
export function tripStart(trip: Pick<StaffTrip, "localStartTime" | "startsAt" | "timeZone">) {
  return formatTripTime(trip.localStartTime, trip.startsAt, trip.timeZone);
}

/** A trip as one line, for dialogs and announcements: "Sunset Harbor Cruise, Sun, Nov 1, 6:00 PM". */
export function tripLine(
  trip: Pick<StaffTrip, "productName" | "localDate" | "localStartTime" | "startsAt" | "timeZone">,
) {
  return `${trip.productName}, ${formatDate(trip.localDate, "medium")}, ${tripStart(trip)}`;
}

/**
 * Seats for the calendar. Seats left only mean something while the trip can
 * still sell, so a trip that has left, or is final, shows its size instead.
 * Taken seats say how they are taken (G2.6): booked, or held by a checkout
 * that has not ended yet.
 */
export function capacityText(trip: Pick<StaffTrip, "capacity" | "salesState">, departed: boolean) {
  const { kind, total, remaining, held = 0, confirmed = 0 } = trip.capacity;
  const settled = departed || trip.salesState === "canceled" || trip.salesState === "completed";
  if (kind === "whole_boat") {
    if (confirmed > 0) return "Whole boat, booked";
    if (settled || remaining > 0) return `Whole boat, up to ${total} guests`;
    return held > 0 ? "Whole boat, held for a checkout" : "Whole boat, booked";
  }
  const taken = [confirmed > 0 && `${confirmed} booked`, !settled && held > 0 && `${held} held`]
    .filter(Boolean)
    .join(", ");
  const size = settled
    ? `${total} ${total === 1 ? "seat" : "seats"}`
    : `${remaining} of ${total} seats left`;
  return taken ? `${size}: ${taken}` : size;
}

/** Why a change did not happen, from the API's answer. */
export type ActionFailure =
  | { kind: "conflict" }
  | { kind: "not_departed" }
  | { kind: "signed_out" }
  | { kind: "forbidden" }
  | { kind: "suspended" }
  | { kind: "not_found" }
  | { kind: "key_reused" }
  | { kind: "invalid" }
  | { kind: "unreachable" }
  | { kind: "unavailable" };

export function failureFrom(status: number, code: string | undefined): ActionFailure {
  if (status === 409 && code === "trip_state_conflict") return { kind: "conflict" };
  if (status === 409 && code === "trip_not_departed") return { kind: "not_departed" };
  if (status === 401) return { kind: "signed_out" };
  if (status === 403 && code === "tenant_suspended") return { kind: "suspended" };
  if (status === 403) return { kind: "forbidden" };
  if (status === 404) return { kind: "not_found" };
  if (status === 422) return { kind: "key_reused" };
  if (status === 400) return { kind: "invalid" };
  return { kind: "unavailable" };
}

/**
 * What the calendar learned when it reloaded after a conflict: the trip's
 * state now, that the trip was not in the week, or that the reload failed.
 */
export type AfterConflict =
  | { reloaded: true; current: TripSalesState }
  | { reloaded: true; current?: undefined }
  | { reloaded: false; current?: undefined };

/**
 * Plain words for a failure. `retry`: the form stays, because sending the
 * same change again can work (and the API makes it happen once). `signIn`:
 * the way forward is signing in again.
 */
export function failureCopy(
  failure: ActionFailure,
  trip: Pick<StaffTrip, "localStartTime" | "localDate" | "startsAt" | "timeZone">,
  after: AfterConflict = { reloaded: false },
): { title: string; body: string; retry: boolean; signIn?: true } {
  switch (failure.kind) {
    case "conflict":
      return {
        title: "Someone changed this trip first",
        body: after.current
          ? `It's ${salesStates[after.current].label.toLowerCase()} now, so nothing was changed. Check it on the calendar, then try again if you still need to.`
          : after.reloaded
            ? "Nothing was changed, and the trip is no longer in this week."
            : "Nothing was changed. Reload the calendar to see the trip as it is now.",
        retry: false,
      };
    case "not_departed":
      return {
        title: "This trip hasn't departed yet",
        body: `You can mark it completed after it leaves at ${tripStart(trip)} on ${formatDate(trip.localDate, "medium")}.`,
        retry: false,
      };
    case "signed_out":
      return {
        title: "You're signed out",
        body: "Nothing was changed. Sign in again, then make the change.",
        retry: false,
        signIn: true,
      };
    case "forbidden":
      return {
        title: "Your role can't change trips",
        body: "Nothing was changed. An owner or booking staff member can make this change.",
        retry: false,
      };
    case "suspended":
      return {
        title: "This operator is suspended",
        body: "Nothing was changed. Trips can't be changed while the operator is suspended.",
        retry: false,
      };
    case "not_found":
      return {
        title: "This trip isn't on the calendar anymore",
        body: "Nothing was changed.",
        retry: false,
      };
    case "key_reused":
      return {
        title: "That change couldn't be confirmed",
        body: "Nothing was changed. Try again.",
        retry: true,
      };
    case "invalid":
      return {
        title: "Check the reason",
        body: "Use plain text of up to 500 characters, then try again.",
        retry: true,
      };
    case "unreachable":
      return {
        title: "The change didn't reach TideGrid",
        body: "Check your connection, then try again. Trying again is safe: the change happens once.",
        retry: true,
      };
    case "unavailable":
      return {
        title: "TideGrid couldn't save the change",
        body: "Try again in a moment. Trying again is safe: the change happens once.",
        retry: true,
      };
  }
}

/** The API's reason rule: 1 to 500 characters, no control characters. */
export function reasonProblem(reason: string): string | undefined {
  const value = reason.trim();
  if (value.length === 0) return "Enter a reason. It's saved in the audit history.";
  if (value.length > 500) return "Keep the reason to 500 characters or fewer.";
  // biome-ignore lint/suspicious/noControlCharactersInRegex: the pattern exists to find them.
  if (/[\u0000-\u001f\u007f]/.test(value)) return "Remove tabs and line breaks from the reason.";
  return undefined;
}
