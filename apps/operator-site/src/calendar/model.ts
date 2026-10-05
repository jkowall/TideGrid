import type { StaffTrip, TripSalesState, TripSalesStateRequest } from "@tidegrid/contracts";
import type { IconName, StatusTone } from "@tidegrid/design-system/components";
import {
  addDays,
  formatClock,
  formatDate,
  isLocalDate,
  type LocalDate,
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

/** Read `?week=` from the address: any date in the week, or this week when missing or wrong. */
export function readWeek(search: string, today: LocalDate): LocalDate {
  const value = new URLSearchParams(search).get("week") ?? "";
  return startOfWeek(isLocalDate(value) ? value : today);
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

/**
 * The changes a trip offers, in the API's transition rules: publish from
 * draft, close from published, reopen from closed, cancel from any state that
 * is not final, and complete once the trip has departed. Opening or closing
 * sales on a trip that has left is pointless, so a departed trip offers
 * complete and cancel only.
 */
export function actionsFor(trip: Pick<StaffTrip, "salesState" | "startsAt">, now: Date) {
  const departed = hasDeparted(trip, now);
  const actions: ActionKind[] = [];
  switch (trip.salesState) {
    case "draft":
      if (!departed) actions.push("publish");
      actions.push("cancel");
      break;
    case "published":
      actions.push(departed ? "complete" : "close", "cancel");
      break;
    case "closed":
      actions.push(departed ? "complete" : "reopen", "cancel");
      break;
    case "canceled":
    case "completed":
      break;
  }
  return actions;
}

/** What the dialog says the change does, in the operator's words. */
export function consequence(kind: ActionKind, cutoff: string): string {
  switch (kind) {
    case "publish":
      return `Guests can book this trip until the booking cutoff, ${cutoff}.`;
    case "reopen":
      return `Guests can book this trip again until the booking cutoff, ${cutoff}.`;
    case "close":
      return "Guests can't book this trip while sales are closed. Existing bookings stay as they are, and you can reopen sales later.";
    case "complete":
      return "This records that the trip ran. Completed is final.";
    case "cancel":
      return "Canceling is final. The trip stops selling, and it can't be reopened or completed. Existing bookings are not changed.";
  }
}

/** A trip as one line, for dialogs and announcements: "Sunset Harbor Cruise, Sun, Nov 1, 6:00 PM". */
export function tripLine(trip: Pick<StaffTrip, "productName" | "localDate" | "localStartTime">) {
  return `${trip.productName}, ${formatDate(trip.localDate, "medium")}, ${formatClock(trip.localStartTime)}`;
}

/** Why a change did not happen, from the API's answer. */
export type ActionFailure =
  | { kind: "conflict" }
  | { kind: "not_departed" }
  | { kind: "signed_out" }
  | { kind: "forbidden" }
  | { kind: "not_found" }
  | { kind: "key_reused" }
  | { kind: "invalid" }
  | { kind: "unreachable" }
  | { kind: "unavailable" };

export function failureFrom(status: number, code: string | undefined): ActionFailure {
  if (status === 409 && code === "trip_state_conflict") return { kind: "conflict" };
  if (status === 409 && code === "trip_not_departed") return { kind: "not_departed" };
  if (status === 401) return { kind: "signed_out" };
  if (status === 403) return { kind: "forbidden" };
  if (status === 404) return { kind: "not_found" };
  if (status === 422) return { kind: "key_reused" };
  if (status === 400) return { kind: "invalid" };
  return { kind: "unavailable" };
}

/**
 * Plain words for a failure. `retry`: the form stays, because sending the
 * same change again can work (and the API makes it happen once).
 */
export function failureCopy(
  failure: ActionFailure,
  trip: Pick<StaffTrip, "localStartTime" | "localDate">,
  current: TripSalesState | undefined,
): { title: string; body: string; retry: boolean } {
  switch (failure.kind) {
    case "conflict":
      return {
        title: "Someone changed this trip first",
        body: current
          ? `It's ${salesStates[current].label.toLowerCase()} now, so nothing was changed. Check it on the calendar, then try again if you still need to.`
          : "Nothing was changed. The calendar now shows the trip as it is.",
        retry: false,
      };
    case "not_departed":
      return {
        title: "This trip hasn't departed yet",
        body: `You can mark it completed after it leaves at ${formatClock(trip.localStartTime)} on ${formatDate(trip.localDate, "medium")}.`,
        retry: false,
      };
    case "signed_out":
      return {
        title: "You're signed out",
        body: "Nothing was changed. Sign in again, then make the change.",
        retry: false,
      };
    case "forbidden":
      return {
        title: "Your role can't change trips",
        body: "Nothing was changed. An owner or booking staff member can make this change.",
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
