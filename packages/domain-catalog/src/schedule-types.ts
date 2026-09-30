import type { Disambiguation, IsoWeekday, LocalDate, LocalTime } from "./time.ts";

/**
 * The recurrence contract. A schedule is a seasonal pattern: every listed
 * weekday between two dates, at one or more local departure times, in one IANA
 * zone. Expansion turns it into concrete occurrences; the catalog service
 * stores those as scheduled trips.
 */
export interface ScheduleRule {
  /** IANA zone, snapshotted from the product's location when the schedule is created. */
  timeZone: string;
  /** First service date, inclusive. */
  startsOn: LocalDate;
  /** Last service date, inclusive. */
  endsOn: LocalDate;
  /** Days the schedule runs. Non-empty, no duplicates. */
  weekdays: readonly IsoWeekday[];
  /** Local departure times on each service day. Non-empty, no duplicates, at most 24. */
  startTimes: readonly LocalTime[];
  /** Trip length. The end instant is the start instant plus this many minutes of elapsed time. */
  durationMinutes: number;
  /** What to do with a departure that falls in a fall-back overlap. Gaps are always skipped. */
  ambiguousTime: Disambiguation;
}

/** Local dates in the rule's zone: `fromDate` inclusive, `toDate` exclusive. */
export interface ExpansionWindow {
  fromDate: LocalDate;
  toDate: LocalDate;
}

/** A blackout that applies to the schedule, as a half-open UTC interval. */
export interface BlackoutInterval {
  startsAtMs: number;
  endsAtMs: number;
}

export interface Occurrence {
  localDate: LocalDate;
  localStartTime: LocalTime;
  startsAtMs: number;
  endsAtMs: number;
  startOffsetMinutes: number;
  endOffsetMinutes: number;
}

export type SkipReason = "nonexistent_local_time" | "ambiguous_local_time" | "blackout";

export interface SkippedOccurrence {
  localDate: LocalDate;
  localStartTime: LocalTime;
  reason: SkipReason;
}

export interface Expansion {
  /** Sorted by start instant. */
  occurrences: Occurrence[];
  /** Sorted by local date, then local time. */
  skipped: SkippedOccurrence[];
}

export type ScheduleRuleProblem =
  | "invalid_time_zone"
  | "invalid_date"
  | "season_ends_before_start"
  | "no_weekdays"
  | "invalid_weekday"
  | "duplicate_weekday"
  | "no_start_times"
  | "too_many_start_times"
  | "invalid_start_time"
  | "duplicate_start_time"
  | "invalid_duration";

/** Largest window one expansion may cover, which bounds a single generation request. */
export const MAX_EXPANSION_DAYS = 400;
export const MAX_START_TIMES = 24;
export const MIN_DURATION_MINUTES = 15;
export const MAX_DURATION_MINUTES = 1440;
