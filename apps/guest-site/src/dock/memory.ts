import type { Found } from "./api.ts";

/**
 * The matched lookup, held in this tab's memory only, so a guest who signs
 * for one person can come back to the party for the next without typing the
 * code again. Never in storage or a URL: a reload, or 15 minutes, forgets it.
 */
let held: Found | null = null;

export function rememberLookup(found: Found): void {
  held = found;
}

export function recallLookup(now = Date.now()): Found | null {
  if (held && held.endsAt <= now) held = null;
  return held;
}

export function forgetLookup(): void {
  held = null;
}
