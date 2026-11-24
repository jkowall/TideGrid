import type { Membership } from "@tidegrid/contracts";
import { Icon } from "@tidegrid/design-system/components";
import { addDays, isLocalDate, type LocalDate, startOfWeek } from "@tidegrid/design-system/format";
import { useEffect, useRef, useState } from "react";
import type { FocusOnArrival } from "../PageHeader.tsx";
import { CalendarPage } from "./Calendar.tsx";
import { MonthPage } from "./MonthView.tsx";

type CalendarMode = "week" | "month";

/** `?view=month` opens the month; anything else, the week. */
export function readMode(search: string): CalendarMode {
  return new URLSearchParams(search).get("view") === "month" ? "month" : "week";
}

/**
 * The Calendar page: the week view (trips with their changes and Book), or the
 * month at a glance (2026-11-24). Week and Month at the end of the bar switch
 * between them. Going to the month opens the month of the week shown; a date
 * in the month opens its week.
 */
export function CalendarView({
  membership,
  focusHeading,
}: { membership: Membership } & FocusOnArrival) {
  const [mode, setMode] = useState<CalendarMode>(() => readMode(window.location.search));
  const focusSwitch = useRef(false);
  const [openDay, setOpenDay] = useState<LocalDate | undefined>();

  useEffect(() => {
    void mode;
    if (focusSwitch.current) {
      focusSwitch.current = false;
      document.getElementById(`cal-view-${mode}`)?.focus();
    }
  }, [mode]);

  /**
   * The month a date was picked in, so Month from that week returns to it even
   * when the week starts in the month before. Null: this month.
   */
  const fromMonth = useRef<string | null | undefined>(undefined);

  const go = (next: CalendarMode, date?: LocalDate, moveFocus = true) => {
    const params = new URLSearchParams(window.location.search);
    if (next === "month") {
      const week = params.get("week");
      params.delete("week");
      params.set("view", "month");
      const remembered = fromMonth.current;
      fromMonth.current = undefined;
      const valid = (value: string | null) => value !== null && isLocalDate(value);
      const overlaps = (monthValue: string, weekStart: LocalDate) =>
        weekStart <= addDays(`${monthValue}-01`, 41) &&
        addDays(weekStart, 6) >= `${monthValue}-01` &&
        (weekStart.slice(0, 7) === monthValue || addDays(weekStart, 6).slice(0, 7) === monthValue);
      if (week && valid(week) && !(remembered && overlaps(remembered, week))) {
        // The month holding most of the week: its Wednesday.
        params.set("month", addDays(startOfWeek(week), 3).slice(0, 7));
      } else if (remembered) {
        params.set("month", remembered);
      } else {
        params.delete("month");
      }
    } else {
      const month = params.get("month");
      fromMonth.current = month;
      params.delete("view");
      params.delete("month");
      if (date) params.set("week", date);
      else if (month && isLocalDate(`${month}-01`)) params.set("week", `${month}-01`);
    }
    const search = params.toString() ? `?${params}` : "";
    const { pathname, hash } = window.location;
    window.history.replaceState(window.history.state, "", `${pathname}${search}${hash}`);
    focusSwitch.current = moveFocus;
    setOpenDay(next === "week" ? date : undefined);
    setMode(next);
  };

  const viewSwitch = (
    // biome-ignore lint/a11y/useSemanticElements: a pair of toggle buttons, not a fieldset of inputs.
    <div className="cal-view" role="group" aria-label="Calendar view">
      {(["week", "month"] as const).map((m) => (
        <button
          key={m}
          type="button"
          id={`cal-view-${m}`}
          className="cal-view__option"
          aria-pressed={mode === m}
          onClick={() => mode !== m && go(m)}
        >
          <Icon name={m === "week" ? "list" : "calendar"} />
          {m === "week" ? "Week" : "Month"}
        </button>
      ))}
    </div>
  );

  return mode === "month" ? (
    <MonthPage
      key="month"
      membership={membership}
      focusHeading={focusHeading}
      viewSwitch={viewSwitch}
      onOpenWeek={(date) => go("week", date, false)}
    />
  ) : (
    <CalendarPage
      key="week"
      membership={membership}
      focusHeading={focusHeading}
      viewSwitch={viewSwitch}
      openDay={openDay}
    />
  );
}
