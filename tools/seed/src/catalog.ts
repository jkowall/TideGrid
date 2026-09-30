/**
 * Synthetic catalog for the demo operators: a location, boats, published
 * products, seasonal schedules, blackouts, and a fixed season of trips. It goes
 * through the catalog services, so seeded data passes the same validation and
 * audit a console will. Idempotent: an operator that already has locations
 * keeps its catalog, and trip generation skips departures that exist.
 */
import { createDb, inTenantTransaction, type TenantContext } from "@tidegrid/database";
import {
  addDays,
  checkRange,
  createBlackout,
  createBoat,
  createLocation,
  createProduct,
  createSchedule,
  generateTrips,
  type IsoWeekday,
  MAX_RANGE_DAYS,
  publishProduct,
} from "@tidegrid/domain-catalog";

/** The season the demo sells. Fixed dates keep reruns identical. */
const SEASON_START = "2026-09-01";
const SEASON_END = "2027-05-31";
const REASON = "Synthetic demo catalog";

interface ProductPlan {
  key: string;
  kind: "shared_seat" | "private_charter";
  name: string;
  summary: string;
  durationMinutes: number;
  bookingCutoffMinutes: number;
  turnaroundBufferMinutes: number;
  maxPartySize: number;
  seatLimit: number | null;
  boat: string;
  weekdays: IsoWeekday[];
  startTimes: string[];
}

interface CatalogPlan {
  location: { name: string; timeZone: string; meetingPoint: string; meetingInstructions: string };
  boats: { key: string; name: string; guestCapacity: number }[];
  products: ProductPlan[];
  blackouts: (
    | { kind: "tenant"; startsOn: string; endsOn: string; reason: string }
    | { kind: "boat"; boat: string; startsOn: string; endsOn: string; reason: string }
  )[];
}

const everyDay: IsoWeekday[] = [1, 2, 3, 4, 5, 6, 7];

/** Plans by tenant slug. New York observes daylight saving; Honolulu does not. */
const plans: Record<string, CatalogPlan> = {
  "demo-harbor": {
    location: {
      name: "Harbor Marina, Dock C",
      timeZone: "America/New_York",
      meetingPoint: "Dock C, slip 14",
      meetingInstructions: "Check in at the dock office 20 minutes before departure.",
    },
    boats: [
      { key: "lark", name: "Sea Lark", guestCapacity: 24 },
      { key: "heron", name: "Blue Heron", guestCapacity: 12 },
    ],
    products: [
      {
        key: "sunset",
        kind: "shared_seat",
        name: "Sunset Harbor Cruise",
        summary: "Ninety minutes along the harbor at golden hour.",
        durationMinutes: 90,
        bookingCutoffMinutes: 60,
        turnaroundBufferMinutes: 30,
        maxPartySize: 10,
        seatLimit: 20,
        boat: "lark",
        weekdays: everyDay,
        startTimes: ["18:00"],
      },
      {
        key: "charter",
        kind: "private_charter",
        name: "Private Half-Day Charter",
        summary: "The whole boat for your group, with a captain, for four hours.",
        durationMinutes: 240,
        bookingCutoffMinutes: 1440,
        turnaroundBufferMinutes: 60,
        maxPartySize: 12,
        seatLimit: null,
        boat: "heron",
        weekdays: [6, 7],
        startTimes: ["08:00", "13:00"],
      },
    ],
    blackouts: [
      {
        kind: "tenant",
        startsOn: "2026-12-25",
        endsOn: "2026-12-25",
        reason: "Closed for the holiday",
      },
      {
        kind: "tenant",
        startsOn: "2027-01-01",
        endsOn: "2027-01-01",
        reason: "Closed for the holiday",
      },
    ],
  },
  "demo-reef": {
    location: {
      name: "Reef Point Harbor",
      timeZone: "Pacific/Honolulu",
      meetingPoint: "Slip 7, next to the dive shop",
      meetingInstructions: "Bring your certification card. Reef-safe sunscreen only.",
    },
    boats: [
      { key: "runner", name: "Coral Runner", guestCapacity: 16 },
      { key: "manta", name: "Manta", guestCapacity: 6 },
    ],
    products: [
      {
        key: "dive",
        kind: "shared_seat",
        name: "Two-Tank Morning Dive",
        summary: "Two reef sites before the wind picks up. Certified divers only.",
        durationMinutes: 240,
        bookingCutoffMinutes: 720,
        turnaroundBufferMinutes: 45,
        maxPartySize: 6,
        seatLimit: 12,
        boat: "runner",
        weekdays: [1, 2, 3, 4, 5, 6],
        startTimes: ["07:30"],
      },
      {
        key: "snorkel",
        kind: "shared_seat",
        name: "Afternoon Snorkel Sail",
        summary: "A calm-water snorkel stop and a sail home.",
        durationMinutes: 150,
        bookingCutoffMinutes: 120,
        turnaroundBufferMinutes: 30,
        maxPartySize: 8,
        seatLimit: null,
        boat: "runner",
        weekdays: [2, 4, 6],
        startTimes: ["13:00"],
      },
      {
        key: "private",
        kind: "private_charter",
        name: "Private Dive Charter",
        summary: "Your group, your sites, and a dedicated guide.",
        durationMinutes: 240,
        bookingCutoffMinutes: 2880,
        turnaroundBufferMinutes: 60,
        maxPartySize: 6,
        seatLimit: null,
        boat: "manta",
        weekdays: [1, 3, 5],
        startTimes: ["08:00"],
      },
    ],
    blackouts: [
      {
        kind: "boat",
        boat: "manta",
        startsOn: "2026-11-09",
        endsOn: "2026-11-13",
        reason: "Scheduled engine service",
      },
    ],
  },
};

/** Inclusive date ranges no longer than one generation request allows. */
function chunks(start: string, end: string): { from: string; to: string }[] {
  const out: { from: string; to: string }[] = [];
  for (let from = start; from <= end; from = addDays(from, MAX_RANGE_DAYS + 1)) {
    const last = addDays(from, MAX_RANGE_DAYS);
    const to = last < end ? last : end;
    if (checkRange(from, to)) throw new Error(`bad seed range ${from}..${to}`);
    out.push({ from, to });
  }
  return out;
}

export async function seedCatalog(
  url: string,
  tenants: readonly { id: string; slug: string }[],
): Promise<void> {
  const { db, end } = createDb(url, { max: 1 });
  try {
    let trips = 0;
    let skipped = 0;
    for (const tenant of tenants) {
      const plan = plans[tenant.slug];
      if (!plan) continue;
      const ctx: TenantContext = { tenantId: tenant.id, actorType: "system", actorId: "seed" };
      const scheduleIds = await inTenantTransaction(db, ctx, async (trx) => {
        const existing = await trx
          .selectFrom("schedules")
          .select("id")
          .where("tenant_id", "=", tenant.id)
          .orderBy("created_at")
          .execute();
        if (existing.length > 0) return existing.map((s) => s.id);

        const locationId = await createLocation(trx, ctx, { ...plan.location, reason: REASON });
        const boatIds = new Map<string, string>();
        for (const boat of plan.boats) {
          boatIds.set(boat.key, await createBoat(trx, ctx, { ...boat, reason: REASON }));
        }
        const boatId = (key: string) => {
          const id = boatIds.get(key);
          if (!id) throw new Error(`seed plan names unknown boat ${key}`);
          return id;
        };
        const ids: string[] = [];
        for (const p of plan.products) {
          const productId = await createProduct(trx, ctx, {
            locationId,
            kind: p.kind,
            name: p.name,
            summary: p.summary,
            durationMinutes: p.durationMinutes,
            bookingCutoffMinutes: p.bookingCutoffMinutes,
            turnaroundBufferMinutes: p.turnaroundBufferMinutes,
            maxPartySize: p.maxPartySize,
            seatLimit: p.seatLimit,
            eligibleBoatIds: [boatId(p.boat)],
            reason: REASON,
          });
          const published = await publishProduct(trx, ctx, { productId, reason: REASON });
          if (published.kind !== "published") {
            throw new Error(`seed product ${p.key} did not publish: ${JSON.stringify(published)}`);
          }
          const schedule = await createSchedule(trx, ctx, {
            productId,
            boatId: boatId(p.boat),
            startsOn: SEASON_START,
            endsOn: SEASON_END,
            weekdays: p.weekdays,
            startTimes: p.startTimes,
            reason: REASON,
          });
          if (schedule.kind !== "created") {
            throw new Error(`seed schedule ${p.key} was rejected: ${JSON.stringify(schedule)}`);
          }
          ids.push(schedule.id);
        }
        for (const b of plan.blackouts) {
          await createBlackout(trx, ctx, {
            scope:
              b.kind === "tenant"
                ? { kind: "tenant", timeZone: plan.location.timeZone }
                : { kind: "boat", boatId: boatId(b.boat), timeZone: plan.location.timeZone },
            startsOn: b.startsOn,
            endsOn: b.endsOn,
            reason: b.reason,
          });
        }
        return ids;
      });

      for (const scheduleId of scheduleIds) {
        for (const range of chunks(SEASON_START, SEASON_END)) {
          const result = await inTenantTransaction(db, ctx, (trx) =>
            generateTrips(trx, ctx, {
              scheduleId,
              fromDate: range.from,
              toDate: range.to,
              publish: true,
              reason: REASON,
            }),
          );
          if (result.kind !== "generated") {
            throw new Error(`seed generation failed: ${JSON.stringify(result)}`);
          }
          trips += result.created.length;
          skipped += result.skipped.length;
        }
      }
    }
    console.log(
      `seeded catalog: ${trips} new trip(s) for ${SEASON_START} to ${SEASON_END}; ${skipped} departure(s) skipped for blackouts or clock changes`,
    );
  } finally {
    await end();
  }
}
