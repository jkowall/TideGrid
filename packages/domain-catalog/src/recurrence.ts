/**
 * Recurrence expansion. A schedule rule is a seasonal pattern. Expansion turns
 * it into concrete occurrences for a window of local dates. It is pure: the
 * same rule, window, and blackouts always give the same result, and nothing
 * reads the clock or a database. Nothing here shifts a departure. A local time
 * that does not exist is skipped. A repeated one is skipped unless the rule
 * names earlier or later. A departure that overlaps a blackout is skipped.
 */
import type {
  BlackoutInterval,
  Expansion,
  ExpansionWindow,
  Occurrence,
  ScheduleRule,
  ScheduleRuleProblem,
  SkippedOccurrence,
} from "./schedule-types.ts";
import {
  MAX_DURATION_MINUTES,
  MAX_EXPANSION_DAYS,
  MAX_START_TIMES,
  MIN_DURATION_MINUTES,
} from "./schedule-types.ts";
import {
  addDays,
  daysBetween,
  isLocalDate,
  isLocalTime,
  isoWeekday,
  isValidTimeZone,
  MINUTE_MS,
  offsetMinutesAt,
  pickInstant,
  resolveLocal,
} from "./time.ts";

function hasDuplicates(values: readonly unknown[]): boolean {
  return new Set(values).size !== values.length;
}

function isWeekday(value: number): boolean {
  return Number.isInteger(value) && value >= 1 && value <= 7;
}

function compareText(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * Every problem with a rule, each once, in the order the contract declares
 * them. An empty list means the rule is valid.
 */
export function validateScheduleRule(rule: ScheduleRule): ScheduleRuleProblem[] {
  const problems: ScheduleRuleProblem[] = [];

  if (!isValidTimeZone(rule.timeZone)) problems.push("invalid_time_zone");

  // Comparing the season ends needs two real dates, so a bad date hides that check.
  if (!isLocalDate(rule.startsOn) || !isLocalDate(rule.endsOn)) {
    problems.push("invalid_date");
  } else if (daysBetween(rule.startsOn, rule.endsOn) < 0) {
    problems.push("season_ends_before_start");
  }

  if (rule.weekdays.length === 0) problems.push("no_weekdays");
  if (!rule.weekdays.every(isWeekday)) problems.push("invalid_weekday");
  if (hasDuplicates(rule.weekdays)) problems.push("duplicate_weekday");

  if (rule.startTimes.length === 0) problems.push("no_start_times");
  if (rule.startTimes.length > MAX_START_TIMES) problems.push("too_many_start_times");
  if (!rule.startTimes.every(isLocalTime)) problems.push("invalid_start_time");
  if (hasDuplicates(rule.startTimes)) problems.push("duplicate_start_time");

  const minutes = rule.durationMinutes;
  if (
    !Number.isInteger(minutes) ||
    minutes < MIN_DURATION_MINUTES ||
    minutes > MAX_DURATION_MINUTES
  ) {
    problems.push("invalid_duration");
  }

  return problems;
}

/** Reject anything that would make the expansion guess or run unbounded. */
function assertExpandable(
  rule: ScheduleRule,
  window: ExpansionWindow,
  blackouts: readonly BlackoutInterval[],
): void {
  const problems = validateScheduleRule(rule);
  if (problems.length > 0) throw new RangeError(`Invalid schedule rule: ${problems.join(", ")}`);

  const { fromDate, toDate } = window;
  if (!isLocalDate(fromDate) || !isLocalDate(toDate)) {
    throw new RangeError(`Window dates must be valid service dates: ${fromDate} to ${toDate}`);
  }
  const days = daysBetween(fromDate, toDate);
  if (days < 0) throw new RangeError(`Window ends before it starts: ${fromDate} to ${toDate}`);
  if (days > MAX_EXPANSION_DAYS) {
    throw new RangeError(
      `Window covers ${days} days, more than the limit of ${MAX_EXPANSION_DAYS}`,
    );
  }

  for (const blackout of blackouts) {
    // Written as a negated greater-than so a NaN end fails here instead of
    // comparing false against every departure and blocking none.
    if (!(blackout.endsAtMs > blackout.startsAtMs)) {
      throw new RangeError(
        `Blackout must end after it starts: ${blackout.startsAtMs} to ${blackout.endsAtMs}`,
      );
    }
  }
}

/**
 * The occurrences of a rule on local dates from `fromDate` (inclusive) to
 * `toDate` (exclusive), and the departures that were skipped with the reason.
 * Throws RangeError for an invalid rule, window, or blackout.
 */
export function expandSchedule(
  rule: ScheduleRule,
  window: ExpansionWindow,
  blackouts: readonly BlackoutInterval[] = [],
): Expansion {
  assertExpandable(rule, window, blackouts);

  const weekdays = new Set<number>(rule.weekdays);
  // Sort a copy: the rule belongs to the caller.
  const times = [...rule.startTimes].sort();
  const occurrences: Occurrence[] = [];
  const skipped: SkippedOccurrence[] = [];

  // Every date here is a validated YYYY-MM-DD, so string order is calendar order.
  const first = window.fromDate > rule.startsOn ? window.fromDate : rule.startsOn;
  for (let date = first; date < window.toDate && date <= rule.endsOn; date = addDays(date, 1)) {
    if (!weekdays.has(isoWeekday(date))) continue;

    for (const time of times) {
      const picked = pickInstant(resolveLocal(rule.timeZone, date, time), rule.ambiguousTime);
      if (!picked.ok) {
        skipped.push({ localDate: date, localStartTime: time, reason: picked.reason });
        continue;
      }

      // Elapsed time, not wall-clock arithmetic: a trip across a transition
      // is as long as the rule says, whatever the clocks do.
      const startsAtMs = picked.instant.epochMs;
      const endsAtMs = startsAtMs + rule.durationMinutes * MINUTE_MS;

      // Half-open on both sides, so trips and blackouts that only touch do not collide.
      if (blackouts.some((b) => startsAtMs < b.endsAtMs && b.startsAtMs < endsAtMs)) {
        skipped.push({ localDate: date, localStartTime: time, reason: "blackout" });
        continue;
      }

      occurrences.push({
        localDate: date,
        localStartTime: time,
        startsAtMs,
        endsAtMs,
        startOffsetMinutes: picked.instant.offsetMinutes,
        endOffsetMinutes: offsetMinutesAt(rule.timeZone, endsAtMs),
      });
    }
  }

  // Generation order already matches, but the contract promises these orders.
  occurrences.sort((a, b) => a.startsAtMs - b.startsAtMs);
  skipped.sort(
    (a, b) =>
      compareText(a.localDate, b.localDate) || compareText(a.localStartTime, b.localStartTime),
  );
  return { occurrences, skipped };
}
