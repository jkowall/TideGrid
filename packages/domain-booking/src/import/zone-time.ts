/**
 * Local wall-clock times in an IANA zone, for the import's trip rows
 * (W3-G2.13). The same rules as the catalog's schedule times: a time in a
 * spring-forward gap does not exist, and one in a fall-back hour happens twice.
 * Pure; uses the runtime's Intl data.
 */

const MINUTE_MS = 60_000;
const DAY_MS = 86_400_000;
const ZONE = /^(?:UTC|[A-Z][A-Za-z_]+(?:\/[A-Z0-9][A-Za-z0-9_+-]*)+)$/;

const formatters = new Map<string, Intl.DateTimeFormat>();

function formatterFor(zone: string): Intl.DateTimeFormat {
  let formatter = formatters.get(zone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat("en-US", {
      timeZone: zone,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });
    formatters.set(zone, formatter);
  }
  return formatter;
}

/** An IANA zone the runtime knows, spelled as the database stores it (no Etc/ zones). */
export function isKnownZone(zone: string): boolean {
  if (!ZONE.test(zone)) return false;
  if (zone !== "UTC" && (/^etc\//i.test(zone) || !zone.split("/").every((s) => /[a-z]/.test(s)))) {
    return false;
  }
  try {
    formatterFor(zone);
    return true;
  } catch {
    return false;
  }
}

function wallParts(zone: string, epochMs: number) {
  const p = { year: 0, month: 0, day: 0, hour: 0, minute: 0, second: 0 };
  for (const part of formatterFor(zone).formatToParts(new Date(epochMs))) {
    if (part.type in p) p[part.type as keyof typeof p] = Number(part.value);
  }
  return p;
}

/** The zone's offset from UTC in minutes at an instant. */
export function offsetAt(zone: string, epochMs: number): number {
  const whole = Math.floor(epochMs / 1000) * 1000;
  const p = wallParts(zone, whole);
  return Math.round(
    (Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second) - whole) / MINUTE_MS,
  );
}

/** The local date (YYYY-MM-DD) at an instant. */
export function localDateAt(zone: string, epochMs: number): string {
  const p = wallParts(zone, epochMs);
  return `${String(p.year).padStart(4, "0")}-${String(p.month).padStart(2, "0")}-${String(p.day).padStart(2, "0")}`;
}

export type LocalInstants =
  | { kind: "unique"; epochMs: number; offsetMinutes: number }
  | { kind: "ambiguous"; options: { epochMs: number; offsetMinutes: number }[] }
  | { kind: "nonexistent" };

/** Every instant at which the zone's clocks read this date and time. */
export function instantsFor(zone: string, date: string, time: string): LocalInstants {
  const [y, mo, d] = date.split("-").map(Number) as [number, number, number];
  const [h, mi] = time.split(":").map(Number) as [number, number];
  const wall = Date.UTC(y, mo - 1, d, h, mi);
  const found: { epochMs: number; offsetMinutes: number }[] = [];
  for (const offsetMinutes of new Set([
    offsetAt(zone, wall - DAY_MS),
    offsetAt(zone, wall + DAY_MS),
  ])) {
    const epochMs = wall - offsetMinutes * MINUTE_MS;
    if (offsetAt(zone, epochMs) === offsetMinutes) found.push({ epochMs, offsetMinutes });
  }
  found.sort((a, b) => a.epochMs - b.epochMs);
  if (found.length >= 2) return { kind: "ambiguous", options: found };
  const [one] = found;
  return one ? { kind: "unique", ...one } : { kind: "nonexistent" };
}
