import { bookingReferencePrefix } from "@tidegrid/contracts/references";
import { formatDate, formatDateRange, isLocalDate } from "@tidegrid/design-system/format";
import type { SearchCriteria } from "./api.ts";

/**
 * The search form's rules, apart from React (G2.12c): what a search may ask,
 * in words a person can act on, and the last search per operator.
 */

/** The dates a search may name: the calendar's service years. */
export const firstSearchDate = "2000-01-01";
export const lastSearchDate = "2099-12-31";

/**
 * The start of a booking reference, read as the API reads it: case, spaces,
 * and hyphens ignored, O, I, and L as 0, 1, and 1. Two to eight characters.
 * The same function the API's search runs, from the shared references module,
 * so the form never refuses what the API would find, or the reverse.
 */
export const referencePrefix = bookingReferencePrefix;

export interface SearchForm {
  text: string;
  from: string;
  to: string;
}

export type FieldProblems = Partial<Record<keyof SearchForm, string>>;

/**
 * The criteria a form asks for, or what to fix. `seesGuests`: the role may
 * search by name and email; otherwise the text must be the start of a
 * booking reference.
 */
export function criteriaOf(
  form: SearchForm,
  seesGuests: boolean,
): { kind: "ok"; criteria: SearchCriteria } | { kind: "invalid"; problems: FieldProblems } {
  const problems: FieldProblems = {};
  // A tab or a line break pasted into the field is a space: the API refuses
  // control characters, and no name, email, or reference holds one.
  // biome-ignore lint/suspicious/noControlCharactersInRegex: the pattern exists to replace them.
  const text = form.text.replace(/[\u0000-\u001f\u007f]+/g, " ").trim();
  const from = form.from.trim();
  const to = form.to.trim();
  if (!text && !from && !to) {
    problems.text = seesGuests
      ? "Enter a name, an email, or a booking reference, or choose dates."
      : "Enter a booking reference, or choose dates.";
  } else if (text.length === 1) {
    problems.text = "Enter at least 2 characters.";
  } else if (text.length > 120) {
    problems.text = "Enter at most 120 characters.";
  } else if (text && !seesGuests && !referencePrefix(text)) {
    problems.text =
      "Enter the start of a booking reference, such as QKG6. Your role searches by reference and date only.";
  }
  const goodDate = (value: string) =>
    isLocalDate(value) && value >= firstSearchDate && value <= lastSearchDate;
  if (from && !goodDate(from)) problems.from = "Enter a date from 2000 to 2099.";
  if (to && !goodDate(to)) problems.to = "Enter a date from 2000 to 2099.";
  if (!problems.from && !problems.to && from && to && from > to) {
    problems.to = "The last date is before the first.";
  }
  if (Object.keys(problems).length > 0) return { kind: "invalid", problems };
  return {
    kind: "ok",
    criteria: {
      ...(text ? { q: text } : {}),
      ...(from ? { from } : {}),
      ...(to ? { to } : {}),
    },
  };
}

/** Whether two searches ask the same thing: a form trimmed differently asks the same. */
export function sameCriteria(a: SearchCriteria | null, b: SearchCriteria | null): boolean {
  return a !== null && b !== null && a.q === b.q && a.from === b.from && a.to === b.to;
}

/**
 * What a search asked, in words, for the results it found: "Matching “maya”,
 * departing Nov 1 to 30, 2026." The field may have changed since, so the
 * results say which terms they belong to.
 */
export function termsText(criteria: SearchCriteria): string {
  const { q, from, to } = criteria;
  const dates =
    from && to
      ? from === to
        ? `departing ${formatDate(from, "short", { year: true })}`
        : `departing ${formatDateRange(from, to, "short")}`
      : from
        ? `departing on or after ${formatDate(from, "short", { year: true })}`
        : to
          ? `departing on or before ${formatDate(to, "short", { year: true })}`
          : "";
  if (q === undefined) return `${dates.charAt(0).toUpperCase()}${dates.slice(1)}.`;
  return dates ? `Matching “${q}”, ${dates}.` : `Matching “${q}”.`;
}

/**
 * The last search each operator ran in this tab, in memory only: Back from a
 * booking finds the results again, and nothing personal is written to the
 * address, history, or storage. A reload forgets it.
 */
const lastSearch = new Map<string, SearchForm>();

export function rememberSearch(tenantId: string, form: SearchForm): void {
  lastSearch.set(tenantId, { ...form });
}

export function recallSearch(tenantId: string): SearchForm | undefined {
  const form = lastSearch.get(tenantId);
  return form ? { ...form } : undefined;
}

export function forgetSearches(): void {
  lastSearch.clear();
}
