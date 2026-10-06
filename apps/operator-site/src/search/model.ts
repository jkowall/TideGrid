import { isLocalDate } from "@tidegrid/design-system/format";
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
 */
export function referencePrefix(text: string): string | null {
  const compact = text.toUpperCase().replace(/[\s-]/g, "").replace(/O/g, "0").replace(/[IL]/g, "1");
  return /^[0-9A-HJKMNP-TV-Z]{2,8}$/.test(compact) ? compact : null;
}

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
  const text = form.text.trim();
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
