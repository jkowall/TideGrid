/**
 * Words and numbers for guest email (lane 1, G2.11c), in US English, on the
 * marina's clock. Pure; runs in Workers and Node, both of which carry the
 * time zone data `Intl` needs.
 */
import type { ExtraView, OrderLineView, PartyView } from "./console.ts";

const usd = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" });

/** "$1,234.56" from integer cents; "-$11.50" for a negative amount. */
export function money(cents: number): string {
  return usd.format(cents / 100);
}

/** "Saturday, November 7, 2026 at 9:00 AM EST", on the trip's own clock. */
export function tripWhen(startsAt: string, timeZone: string): string {
  const at = new Date(startsAt);
  const day = new Intl.DateTimeFormat("en-US", {
    timeZone,
    weekday: "long",
    year: "numeric",
    month: "long",
    day: "numeric",
  }).format(at);
  const time = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hour: "numeric",
    minute: "2-digit",
    timeZoneName: "short",
  }).format(at);
  return `${day} at ${time}`;
}

/** "Nov 7" for a subject line. */
export function shortDay(startsAt: string, timeZone: string): string {
  return new Intl.DateTimeFormat("en-US", { timeZone, month: "short", day: "numeric" }).format(
    new Date(startsAt),
  );
}

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/** "2 × Adult, 1 × Child (3 to 12)", or "Whole boat, up to 6 guests, 4 aboard". */
export function partyText(party: PartyView): string {
  if (party.kind === "charter")
    return `${party.charter}, ${plural(party.guests, "guest", "guests")} aboard`;
  return party.tickets.map((t) => `${t.quantity} × ${t.name}`).join(", ");
}

export function extrasText(extras: readonly ExtraView[]): string | null {
  return extras.length === 0 ? null : extras.map((e) => `${e.quantity} × ${e.name}`).join(", ");
}

// biome-ignore lint/suspicious/noControlCharactersInRegex: the pattern exists to remove them.
const controls = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g;

// biome-ignore lint/suspicious/noControlCharactersInRegex: the pattern exists to remove them.
const anyControl = /[\u0000-\u001f\u007f-\u009f]+/g;

function fit(plain: string, max: number): string {
  const value = plain.length > 0 ? plain : "-";
  return value.length <= max ? value : `${value.slice(0, max - 1).trimEnd()}…`;
}

/**
 * Text from stored data, made safe for a message's body: control characters
 * other than tab and newline become spaces and anything past `max` is cut
 * with an ellipsis, so a long or odd value can never stop a booking's email
 * from being written. A subject, a preview, or a recipient's name takes
 * `singleLine` instead.
 */
export function clean(text: string, max: number): string {
  return fit(text.replace(controls, " ").trim(), max);
}

/**
 * Text from stored data for a one-line field (a subject, a preview, a
 * recipient's name): every C0 and C1 control, tab and newline included,
 * becomes a single space, then as `clean`.
 */
export function singleLine(text: string, max: number): string {
  return fit(text.replace(anyControl, " ").replace(/ {2,}/g, " ").trim(), max);
}

/** The first name a greeting uses: the first word of the booker's name. */
export function firstName(name: string): string {
  return clean(name, 120).split(/\s+/)[0] ?? "there";
}

/**
 * An order as receipt rows: the trip price, extras, fees, discount, and added
 * taxes as the order holds them, then the total; taxes already inside the
 * prices are noted after it, not added.
 */
export function receiptRows(order: {
  lines: readonly OrderLineView[];
  totals: { total: number; includedTax: number };
}): { label: string; amount: string; strong?: boolean }[] {
  const rows: { label: string; amount: string; strong?: boolean }[] = [];
  for (const line of order.lines) {
    if (line.kind === "tax") {
      if (line.taxInclusive) continue;
      rows.push({ label: clean(line.name, 200), amount: money(line.amount) });
    } else if (line.kind === "discount") {
      rows.push({ label: clean(line.name, 200), amount: money(line.amount) });
    } else {
      const label = line.quantity > 1 ? `${line.quantity} × ${line.name}` : line.name;
      rows.push({ label: clean(label, 200), amount: money(line.amount) });
    }
  }
  rows.push({ label: "Total paid", amount: money(order.totals.total), strong: true });
  if (order.totals.includedTax > 0) {
    rows.push({ label: "Includes taxes of", amount: money(order.totals.includedTax) });
  }
  return rows;
}
