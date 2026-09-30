import type {} from "@tidegrid/database/global-setup";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";
import { addDays, isValidTimeZone, localAt, offsetMinutesAt, startOfLocalDay } from "./index.ts";

type Sql = ReturnType<typeof postgres>;

const env = inject("integrationDb");
const DAY_MS = 86_400_000;

/**
 * Zones where the runtime's zone data and PostgreSQL's disagreed when this was
 * written (2026-09-30: Node 24.21 with tz 2026a, Neon PostgreSQL 17.11).
 * PostgreSQL reads Vancouver and Edmonton as keeping daylight time through the
 * 2026-27 winter; the runtime does not. The two read Casablanca and El Aaiun an
 * hour apart for most of the year. Generation skips and names such departures
 * instead of storing a guessed time. This list only keeps new drift from
 * arriving unnoticed; a zone that stops drifting may be removed.
 */
const KNOWN_DRIFT = new Set([
  "America/Vancouver",
  "America/Edmonton",
  "Africa/Casablanca",
  "Africa/El_Aaiun",
]);

describe.skipIf(!env)("runtime zone data against PostgreSQL", () => {
  let admin: Sql;

  beforeAll(() => {
    if (!env) return;
    admin = postgres(env.adminUrl, { max: 1, onnotice: () => {} });
  });

  afterAll(async () => {
    await admin?.end();
  });

  it("reads offsets and day boundaries the same for every accepted zone, apart from known drift", async () => {
    const pgZones = new Set(
      (await admin<{ name: string }[]>`select name from pg_timezone_names`).map((r) => r.name),
    );
    const zones = Intl.supportedValuesOf("timeZone").filter(
      (z) => isValidTimeZone(z) && pgZones.has(z),
    );
    expect(zones.length).toBeGreaterThan(300);

    // Noon UTC every day for three years.
    const first = Date.UTC(2026, 9, 1, 12);
    const samples = Array.from({ length: 3 * 366 }, (_, n) => first + n * DAY_MS);
    const sampleText = samples.map((ms) => new Date(ms).toISOString());

    const drift = new Set<string>();
    const boundaries: { zone: string; date: string; startsAt: string }[] = [];
    for (let i = 0; i < zones.length; i += 50) {
      const chunk = zones.slice(i, i + 50);
      const rows = await admin<{ zone: string; offsets: number[] }[]>`
        select z.zone,
               array_agg((extract(epoch from timezone(z.zone, t.at::timestamptz)
                          - timezone('UTC', t.at::timestamptz)) / 60)::int order by t.n) as offsets
          from unnest(${chunk}::text[]) as z(zone)
          cross join unnest(${sampleText}::text[]) with ordinality as t(at, n)
         group by z.zone`;
      for (const row of rows) {
        const ours = samples.map((ms) => offsetMinutesAt(row.zone, ms));
        if (ours.some((offset, n) => offset !== row.offsets[n])) {
          drift.add(row.zone);
          continue;
        }
        // Where the offset changed between two samples, a clock change fell in
        // between. Check the first instant of each local day around it.
        ours.forEach((offset, n) => {
          if (n === 0 || offset === ours[n - 1]) return;
          const date = localAt(row.zone, samples[n] ?? first).date;
          for (const day of [addDays(date, -1), date, addDays(date, 1)]) {
            const startsAt = new Date(startOfLocalDay(row.zone, day).epochMs).toISOString();
            boundaries.push({ zone: row.zone, date: day, startsAt });
          }
        });
      }
    }
    expect([...drift].filter((z) => !KNOWN_DRIFT.has(z)).sort()).toEqual([]);
    for (const zone of [
      "America/New_York",
      "Pacific/Honolulu",
      "Europe/London",
      "Australia/Sydney",
    ]) {
      expect(drift.has(zone), zone).toBe(false);
    }

    // The same test the blackout trigger applies: the instant falls on the day,
    // and one second earlier falls on the day before.
    expect(boundaries.length).toBeGreaterThan(100);
    const disagreements = await admin<{ zone: string; date: string }[]>`
      select b.zone, b.day as date
        from unnest(${boundaries.map((b) => b.zone)}::text[],
                    ${boundaries.map((b) => b.date)}::text[],
                    ${boundaries.map((b) => b.startsAt)}::text[]) as b(zone, day, starts_at)
       where timezone(b.zone, b.starts_at::timestamptz)::date <> b.day::date
          or timezone(b.zone, b.starts_at::timestamptz - interval '1 second')::date <> b.day::date - 1`;
    expect(disagreements).toEqual([]);
  });
});
