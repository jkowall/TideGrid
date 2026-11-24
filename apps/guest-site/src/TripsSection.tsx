import { Icon } from "@tidegrid/design-system/components";
import { later, todayIn } from "@tidegrid/design-system/format";
import { useEffect, useRef, useState } from "react";
import { TripCalendar } from "./TripCalendar.tsx";
import {
  clampStart,
  monthOf,
  readCalendarQuery,
  readQuery,
  readView,
  type TripView,
  writeCalendarQuery,
  writeQuery,
} from "./trips.ts";
import { UpcomingTrips } from "./UpcomingTrips.tsx";

/**
 * The home page's trips: a calendar to pick a date from (the default), or the
 * four-week list. The guest switches with Calendar and List beside the
 * heading; the address carries `view=list` for the list, so a reload or a
 * shared link keeps the choice. Switching keeps the party size and the dates:
 * the list starts at the month shown (or today), and the calendar opens the
 * month the list starts in.
 */
export function TripsSection() {
  const [view, setView] = useState<TripView>(() => readView(window.location.search));
  const focusAfterSwitch = useRef(false);

  useEffect(() => {
    void view;
    if (focusAfterSwitch.current) {
      focusAfterSwitch.current = false;
      document.getElementById(`trips-view-${view}`)?.focus();
    }
  }, [view]);

  const switchTo = (next: TripView) => {
    if (next === view) return;
    const today = todayIn();
    const search = window.location.search;
    const nextSearch =
      next === "list"
        ? (() => {
            const calendar = readCalendarQuery(search, today);
            const start = clampStart(later(calendar.date ?? calendar.month, today), today);
            return writeQuery({ start, party: calendar.party }, today, true);
          })()
        : (() => {
            const list = readQuery(search, today);
            return writeCalendarQuery(
              // The list's first date stays picked, unless it is simply today.
              {
                month: monthOf(list.start),
                party: list.party,
                date: list.start > today ? list.start : null,
              },
              today,
            );
          })();
    const { pathname, hash } = window.location;
    window.history.replaceState(window.history.state, "", `${pathname}${nextSearch}${hash}`);
    focusAfterSwitch.current = true;
    setView(next);
  };

  const viewSwitch = <ViewSwitch view={view} onSwitch={switchTo} />;
  return view === "list" ? (
    <UpcomingTrips key="list" list viewSwitch={viewSwitch} />
  ) : (
    <TripCalendar key="calendar" viewSwitch={viewSwitch} />
  );
}

function ViewSwitch({ view, onSwitch }: { view: TripView; onSwitch: (view: TripView) => void }) {
  return (
    // biome-ignore lint/a11y/useSemanticElements: a pair of toggle buttons, not a fieldset of inputs.
    <div className="trips-view" role="group" aria-label="Show trips as">
      <button
        type="button"
        id="trips-view-calendar"
        className="trips-view__option"
        aria-pressed={view === "calendar"}
        onClick={() => onSwitch("calendar")}
      >
        <Icon name="calendar" />
        Calendar
      </button>
      <button
        type="button"
        id="trips-view-list"
        className="trips-view__option"
        aria-pressed={view === "list"}
        onClick={() => onSwitch("list")}
      >
        <Icon name="list" />
        List
      </button>
    </div>
  );
}
