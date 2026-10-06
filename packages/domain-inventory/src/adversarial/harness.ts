/**
 * Shared helpers for the G2.6 adversarial suites (Node only, integration tests).
 * Every call under test runs as tidegrid_app over real PostgreSQL connections;
 * the admin connection builds fixtures, moves time by backdating holds, and
 * observes stored state. Nothing is mocked.
 *
 * Race size comes from the environment so a stress run can raise it:
 * RACE_ROUNDS (default 2) rounds per race, RACE_SESSIONS (default 24, 20 to 28)
 * concurrent sessions per round. Every race prints one RACE_STATS line.
 */
import { randomUUID } from "node:crypto";
import { appendFileSync } from "node:fs";
import {
  type createDb,
  inTenantTransaction,
  type TenantContext,
  type TenantTransaction,
} from "@tidegrid/database";
import type postgres from "postgres";
import { acquireHold, type Hold } from "../holds.ts";
import { createTenantFixture, type TenantFixture } from "../test-fixtures.ts";

export type Sql = ReturnType<typeof postgres>;
export type Runtime = ReturnType<typeof createDb>;

function envInt(name: string, fallback: number, min: number, max: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new RangeError(`${name} must be a whole number from ${min} to ${max}`);
  }
  return value;
}

export const RACE_ROUNDS = envInt("RACE_ROUNDS", 2, 1, 40);
export const RACE_SESSIONS = envInt("RACE_SESSIONS", 24, 20, 28);

/**
 * Head starts, by round, for one side of a race. A side that needs fewer round
 * trips before it queues on the trip lock otherwise wins every round, and the
 * other order is never tested. Round 0 has no head start; later rounds do.
 */
export const STAGGER_MS = [0, 300, 150] as const;

/** A test timeout that grows with the number of rounds. */
export function raceTimeout(perRoundMs: number): number {
  return 90_000 + RACE_ROUNDS * perRoundMs;
}

export const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export const owner = () => `checkout_session:${randomUUID()}`;

export function context(tenantId: string, actorId = "adversary"): TenantContext {
  return { tenantId, actorType: "system", actorId, requestId: `adv-${randomUUID()}` };
}

/** A promise that one side opens and others wait on. */
export function gate() {
  let open!: () => void;
  const opened = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { open, opened };
}

/**
 * Releases every party at once when the last one arrives. Times out instead of
 * hanging when a party never arrives, for example when a pool is too small.
 */
export function barrier(parties: number, timeoutMs = 90_000) {
  let arrived = 0;
  let open!: () => void;
  let fail!: (error: Error) => void;
  const opened = new Promise<void>((resolve, reject) => {
    open = resolve;
    fail = reject;
  });
  opened.catch(() => {});
  const timer = setTimeout(
    () => fail(new Error(`barrier: ${arrived} of ${parties} parties arrived in ${timeoutMs} ms`)),
    timeoutMs,
  );
  opened.then(
    () => clearTimeout(timer),
    () => clearTimeout(timer),
  );
  return {
    opened,
    arrive(): Promise<void> {
      arrived += 1;
      if (arrived === parties) open();
      return opened;
    },
  };
}

/** Start `fn` when the barrier opens. A failed barrier never surfaces as an unhandled rejection. */
export function whenOpen<T>(start: ReturnType<typeof barrier>, fn: () => Promise<T>): Promise<T> {
  const p = start.opened.then(fn);
  p.catch(() => {});
  return p;
}

export type Outcome<T> =
  | { ok: true; value: T }
  | { ok: false; code: string; constraint: string | null; message: string };

/** Resolve to the value or to the error's SQLSTATE and constraint, never throw. */
export async function settle<T>(p: Promise<T>): Promise<Outcome<T>> {
  try {
    return { ok: true, value: await p };
  } catch (err) {
    const e = err as { code?: unknown; constraint_name?: unknown; message?: unknown };
    return {
      ok: false,
      code: typeof e.code === "string" ? e.code : "no-code",
      constraint: typeof e.constraint_name === "string" ? e.constraint_name : null,
      message: String(e.message ?? err),
    };
  }
}

export function errorsOf<T>(outcomes: readonly Outcome<T>[]) {
  return outcomes.flatMap((o) => (o.ok ? [] : [o]));
}

export function valuesOf<T>(outcomes: readonly Outcome<T>[]): T[] {
  return outcomes.flatMap((o) => (o.ok ? [o.value] : []));
}

/** Rejects with a named error when `p` takes longer than `ms`. */
export async function within<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      p,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${what} took longer than ${ms} ms`)), ms);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

// Sessions --------------------------------------------------------------------------

/** One service call in one runtime transaction bound to `tenantId`. */
export function inTenant<T>(
  db: Runtime["db"],
  tenantId: string,
  fn: (trx: TenantTransaction, ctx: TenantContext) => Promise<T>,
): Promise<T> {
  const ctx = context(tenantId);
  return inTenantTransaction(db, ctx, (trx) => fn(trx, ctx));
}

/** `n` service sessions, each in its own runtime transaction, released together. */
export function serviceRace<T>(
  db: Runtime["db"],
  tenantId: string,
  n: number,
  start: ReturnType<typeof barrier>,
  fn: (trx: TenantTransaction, ctx: TenantContext, i: number) => Promise<T>,
): Promise<Outcome<T>[]> {
  return Promise.all(
    Array.from({ length: n }, (_, i) =>
      settle(
        inTenant(db, tenantId, async (trx, ctx) => {
          await start.arrive();
          return fn(trx, ctx, i);
        }),
      ),
    ),
  );
}

export const acquireFor = (
  trx: TenantTransaction,
  ctx: TenantContext,
  tripId: string,
  partySize: number,
  ownerRef = owner(),
) => acquireHold(trx, ctx, { ownerRef, tripId, partySize, ttlSeconds: 600 });

/** Acquire through the service, sequentially, for setup; anything but acquired throws. */
export async function acquiredHold(
  db: Runtime["db"],
  tenantId: string,
  tripId: string,
  party: number,
  ownerRef = owner(),
): Promise<Hold> {
  const result = await inTenant(db, tenantId, (trx, ctx) =>
    acquireFor(trx, ctx, tripId, party, ownerRef),
  );
  if (result.kind !== "acquired") throw new Error(`setup acquire got ${result.kind}`);
  return result.hold;
}

export function ofKind<T extends { kind: string }, K extends T["kind"]>(
  items: readonly T[],
  kind: K,
): Extract<T, { kind: K }>[] {
  return items.filter((i): i is Extract<T, { kind: K }> => i.kind === kind);
}

// Trips -----------------------------------------------------------------------------

export interface TripRef {
  tenantId: string;
  tripId: string;
}

/**
 * Hands out unused fixture trips, building another synthetic tenant through the
 * real catalog services whenever the current ones run out.
 */
export function tripSource(admin: Sql, db: Runtime["db"], label: string, days = 60) {
  const fixtures: TenantFixture[] = [];
  const used = { shared: 0, charter: 0 };
  async function take(key: "shared" | "charter"): Promise<TripRef> {
    const n = used[key];
    used[key] += 1;
    const index = Math.floor(n / days);
    while (fixtures.length <= index) {
      fixtures.push(await createTenantFixture(admin, db, `${label}${fixtures.length}`, { days }));
    }
    const fixture = fixtures[index];
    const tripId = fixture?.trips[key][n % days];
    if (!fixture || !tripId) throw new Error(`no ${key} trip ${n}`);
    return { tenantId: fixture.id, tripId };
  }
  return {
    shared: () => take("shared"),
    charter: () => take("charter"),
    tenantIds: () => fixtures.map((f) => f.id),
  };
}

// Stored state ----------------------------------------------------------------------

export interface TripUsage {
  tripId: string;
  tenantId: string;
  capacity: number;
  productKind: string;
  salesState: string;
  /** Seats of holds stored active or confirmed: the invariant's sum. */
  counted: number;
  countedHolds: number;
  wholeBoats: number;
  /** Seats that take capacity by the database clock (what reads show). */
  live: number;
}

const usageColumns = (admin: Sql) => admin`
  select t.id as trip_id, t.tenant_id, t.seat_capacity, p.kind as product_kind, t.sales_state,
         coalesce(sum(h.seats) filter (where h.state in ('active', 'confirmed')), 0)::int as counted,
         count(h.id) filter (where h.state in ('active', 'confirmed'))::int as counted_holds,
         count(h.id) filter (where h.kind = 'whole_boat'
                               and h.state in ('active', 'confirmed'))::int as whole_boats,
         coalesce(sum(h.seats) filter (where h.state = 'confirmed'
                       or (h.state = 'active' and h.expires_at > now())), 0)::int as live
    from public.scheduled_trips t
    join public.products p on p.tenant_id = t.tenant_id and p.id = t.product_id
    left join public.capacity_holds h on h.tenant_id = t.tenant_id and h.trip_id = t.id`;

interface UsageRow {
  trip_id: string;
  tenant_id: string;
  seat_capacity: number;
  product_kind: string;
  sales_state: string;
  counted: number;
  counted_holds: number;
  whole_boats: number;
  live: number;
}

function toUsage(r: UsageRow): TripUsage {
  return {
    tripId: r.trip_id,
    tenantId: r.tenant_id,
    capacity: r.seat_capacity,
    productKind: r.product_kind,
    salesState: r.sales_state,
    counted: r.counted,
    countedHolds: r.counted_holds,
    wholeBoats: r.whole_boats,
    live: r.live,
  };
}

/** Stored usage of the given trips, as the admin role sees it. */
export async function usageOfTrips(admin: Sql, tripIds: readonly string[]): Promise<TripUsage[]> {
  if (tripIds.length === 0) return [];
  const rows = await admin<UsageRow[]>`
    ${usageColumns(admin)}
     where t.id in ${admin(tripIds as string[])}
     group by t.id, t.tenant_id, t.seat_capacity, p.kind, t.sales_state`;
  return rows.map(toUsage);
}

/** Stored usage of every trip of the given tenants. */
export async function usageOfTenants(
  admin: Sql,
  tenantIds: readonly string[],
): Promise<TripUsage[]> {
  if (tenantIds.length === 0) return [];
  const rows = await admin<UsageRow[]>`
    ${usageColumns(admin)}
     where t.tenant_id in ${admin(tenantIds as string[])}
     group by t.id, t.tenant_id, t.seat_capacity, p.kind, t.sales_state`;
  return rows.map(toUsage);
}

/** Trips that break the capacity invariant: oversold, or more than one counted charter hold. */
export function oversold(rows: readonly TripUsage[]): TripUsage[] {
  return rows.filter(
    (r) =>
      r.counted > r.capacity ||
      r.live > r.capacity ||
      r.wholeBoats > 1 ||
      (r.productKind === "private_charter" && r.countedHolds > 1),
  );
}

export async function usageOf(admin: Sql, tripId: string): Promise<TripUsage> {
  const [row] = await usageOfTrips(admin, [tripId]);
  if (!row) throw new Error(`no trip ${tripId}`);
  return row;
}

export interface StoredHold {
  id: string;
  tenant_id: string;
  trip_id: string;
  owner_ref: string;
  kind: string;
  party_size: number;
  seats: number;
  state: string;
  expires_at: Date;
  confirmed_at: Date | null;
  released_at: Date | null;
  expired_at: Date | null;
}

export async function holdsOnTrip(admin: Sql, tripId: string): Promise<StoredHold[]> {
  return admin<StoredHold[]>`
    select id, tenant_id, trip_id, owner_ref, kind, party_size, seats, state, expires_at,
           confirmed_at, released_at, expired_at
      from public.capacity_holds where trip_id = ${tripId} order by created_at, id`;
}

export async function holdsByIds(admin: Sql, ids: readonly string[]): Promise<StoredHold[]> {
  if (ids.length === 0) return [];
  return admin<StoredHold[]>`
    select id, tenant_id, trip_id, owner_ref, kind, party_size, seats, state, expires_at,
           confirmed_at, released_at, expired_at
      from public.capacity_holds where id in ${admin(ids as string[])} order by created_at, id`;
}

export async function holdsOfTenants(
  admin: Sql,
  tenantIds: readonly string[],
): Promise<StoredHold[]> {
  if (tenantIds.length === 0) return [];
  return admin<StoredHold[]>`
    select id, tenant_id, trip_id, owner_ref, kind, party_size, seats, state, expires_at,
           confirmed_at, released_at, expired_at
      from public.capacity_holds where tenant_id in ${admin(tenantIds as string[])}
     order by created_at, id`;
}

/** Move a hold's expiry `seconds` into the past (admin only), as time passing would. */
export async function expireByClock(admin: Sql, holdIds: readonly string[], seconds = 5) {
  if (holdIds.length === 0) return;
  const rows = await admin`
    update public.capacity_holds set expires_at = now() - make_interval(secs => ${seconds})
     where id in ${admin(holdIds as string[])} returning id`;
  if (rows.length !== holdIds.length) throw new Error("not every hold was backdated");
}

// Histories -------------------------------------------------------------------------

interface AuditRow {
  id: string;
  tenant_id: string;
  subject_id: string;
  action: string;
  actor_id: string | null;
  request_id: string | null;
  after_state: Record<string, unknown> | null;
}

interface EventRow {
  id: string;
  tenant_id: string;
  aggregate_id: string;
  topic: string;
  payload: Record<string, unknown>;
}

const transitions: Record<string, Record<string, string>> = {
  active: { "hold.confirmed": "confirmed", "hold.released": "released", "hold.expired": "expired" },
  expired: { "hold.confirmed": "confirmed" },
  confirmed: { "hold.released": "released" },
  released: {},
};

export interface HistorySummary {
  problems: string[];
  /** Audit actions per hold, in order. */
  actions: Map<string, string[]>;
  audits: AuditRow[];
}

/**
 * Check that every hold's audit trail is a legal path through the state
 * machine that ends in its stored state, that each transition has exactly one
 * audit row and one outbox event in the hold's own tenant, in the same order,
 * and that the stored timestamps match the transitions. Returns problems found.
 */
export async function checkHistories(
  admin: Sql,
  holdIds: readonly string[],
): Promise<HistorySummary> {
  const problems: string[] = [];
  const actions = new Map<string, string[]>();
  if (holdIds.length === 0) return { problems, actions, audits: [] };
  const holds = await holdsByIds(admin, holdIds);
  if (holds.length !== new Set(holdIds).size) {
    problems.push(`expected ${new Set(holdIds).size} holds, found ${holds.length}`);
  }
  const audits = await admin<AuditRow[]>`
    select id, tenant_id, subject_id, action, actor_id, request_id, after_state
      from public.audit_events
     where subject_type = 'capacity_hold' and subject_id in ${admin(holdIds as string[])}
     order by id`;
  const events = await admin<EventRow[]>`
    select id, tenant_id, aggregate_id, topic, payload from public.outbox_events
     where aggregate_type = 'capacity_hold' and aggregate_id in ${admin(holdIds as string[])}
     order by id`;
  const byHold = <T extends { id: string }>(rows: T[], key: (r: T) => string) => {
    const map = new Map<string, T[]>();
    for (const r of rows) {
      const list = map.get(key(r)) ?? [];
      list.push(r);
      map.set(key(r), list);
    }
    for (const list of map.values()) list.sort((a, b) => Number(BigInt(a.id) - BigInt(b.id)));
    return map;
  };
  const auditsBy = byHold(audits, (r) => r.subject_id);
  const eventsBy = byHold(events, (r) => r.aggregate_id);
  for (const hold of holds) {
    const trail = auditsBy.get(hold.id) ?? [];
    const topics = (eventsBy.get(hold.id) ?? []).map((e) => e.topic);
    const names = trail.map((a) => a.action);
    actions.set(hold.id, names);
    const where = `hold ${hold.id}`;
    if (names[0] !== "hold.acquired") problems.push(`${where}: first audit ${names[0]}`);
    let state = "active";
    for (const [i, audit] of trail.entries()) {
      if (i === 0) continue;
      const to = transitions[state]?.[audit.action];
      if (!to) {
        problems.push(`${where}: illegal ${audit.action} from ${state}`);
        continue;
      }
      if (audit.action === "hold.confirmed") {
        const reacquired = audit.after_state?.reacquired;
        if (reacquired !== (state === "expired")) {
          problems.push(`${where}: confirmed from ${state} says reacquired=${String(reacquired)}`);
        }
      }
      if (
        audit.action === "hold.expired" &&
        audit.actor_id !== "hold-expiry" &&
        audit.actor_id !== "hold-sweep"
      ) {
        problems.push(`${where}: expired by actor ${audit.actor_id}`);
      }
      state = to;
    }
    if (state !== hold.state) problems.push(`${where}: audit ends ${state}, stored ${hold.state}`);
    const expectedTopics = names.map((n) => `inventory.${n}`);
    if (JSON.stringify(topics) !== JSON.stringify(expectedTopics)) {
      problems.push(`${where}: events ${topics.join(",")} for audits ${names.join(",")}`);
    }
    for (const event of eventsBy.get(hold.id) ?? []) {
      if (event.tenant_id !== hold.tenant_id) problems.push(`${where}: event in another tenant`);
      const p = event.payload;
      if (p.holdId !== hold.id || p.tripId !== hold.trip_id || p.ownerRef !== hold.owner_ref) {
        problems.push(`${where}: event payload ${JSON.stringify(p)}`);
      }
      if (Object.keys(p).length !== 3) problems.push(`${where}: event carries extra fields`);
    }
    for (const audit of trail) {
      if (audit.tenant_id !== hold.tenant_id) problems.push(`${where}: audit in another tenant`);
    }
    const has = (a: string) => names.includes(a);
    if ((hold.confirmed_at !== null) !== has("hold.confirmed")) {
      problems.push(`${where}: confirmed_at ${String(hold.confirmed_at)} vs audits`);
    }
    if ((hold.released_at !== null) !== has("hold.released")) {
      problems.push(`${where}: released_at ${String(hold.released_at)} vs audits`);
    }
    if ((hold.expired_at !== null) !== has("hold.expired")) {
      problems.push(`${where}: expired_at ${String(hold.expired_at)} vs audits`);
    }
  }
  return { problems, actions, audits };
}

// Locks -------------------------------------------------------------------------------

/** Wait until backend `pid` is blocked on a lock; returns the blocking backends. */
export async function waitUntilBlocked(admin: Sql, pid: number, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const [row] = await admin<{ blockers: number[] }[]>`
      select pg_blocking_pids(${pid}::int) as blockers`;
    if (row && row.blockers.length > 0) return row.blockers;
    if (Date.now() > deadline) throw new Error(`backend ${pid} never waited on a lock`);
    await sleep(20);
  }
}

// Reporting -----------------------------------------------------------------------

export interface RoundStats {
  sessions: number;
  successes: number;
  refusals: number;
  errors: number;
  oversell: number;
}

/** One machine-readable line per race for the verification log. */
export function reportRace(
  race: string,
  rounds: readonly RoundStats[],
  extra: Record<string, unknown> = {},
): void {
  const sum = (k: keyof RoundStats) => rounds.reduce((n, r) => n + r[k], 0);
  const line = {
    race,
    rounds: rounds.length,
    sessionsPerRound: rounds[0]?.sessions ?? 0,
    successes: sum("successes"),
    refusals: sum("refusals"),
    errors: sum("errors"),
    oversell: sum("oversell"),
    ...extra,
  };
  const text = `RACE_STATS ${JSON.stringify(line)}`;
  console.log(text);
  // Vitest hides the console output of passing tests; a run can ask for a file too.
  const file = process.env.RACE_STATS_FILE;
  if (file) appendFileSync(file, `${text}\n`);
}
