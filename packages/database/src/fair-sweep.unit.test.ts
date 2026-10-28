import { describe, expect, it } from "vitest";
import { type FairSweepReport, type FairTurnResult, runFairSweep } from "./fair-sweep.ts";

/**
 * A fake database for the scheduler: tenants with a backlog counted in
 * quanta, the stamps the 0013 list functions sort by, and a clock that moves
 * one millisecond per quantum. `order: "id"` is the mutation that restores the
 * list order before 0013; the mutation checks below show the fairness tests
 * fail under it.
 */
class World {
  readonly backlog = new Map<string, number>();
  readonly stamps = new Map<string, number>();
  readonly poison = new Set<string>();
  readonly failStamp = new Set<string>();
  readonly declineStamp = new Set<string>();
  /** Every turn taken, in order, with its run and pass. */
  readonly turns: { run: number; tenant: string; pass: number }[] = [];
  now = 0;
  run = 0;
  private seq = 0;

  constructor(readonly order: "lru" | "id" = "lru") {}

  add(tenant: string, quanta: number): void {
    this.backlog.set(tenant, quanta);
  }

  list(limit: number): string[] {
    const due = [...this.backlog].filter(([, q]) => q > 0).map(([t]) => t);
    const byId = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
    if (this.order === "id") return due.sort(byId).slice(0, limit);
    // ORDER BY last_turn_at NULLS FIRST, tenant_id
    return due
      .sort((a, b) => {
        const sa = this.stamps.get(a) ?? Number.NEGATIVE_INFINITY;
        const sb = this.stamps.get(b) ?? Number.NEGATIVE_INFINITY;
        return sa === sb ? byId(a, b) : sa - sb;
      })
      .slice(0, limit);
  }

  async sweep(
    options: { budgetMs: number; tenantLimit?: number; maxPasses?: number; cost?: number } = {
      budgetMs: 1000,
    },
  ): Promise<{ report: FairSweepReport; errors: string[] }> {
    this.run += 1;
    const run = this.run;
    const tenantLimit = options.tenantLimit ?? 100;
    const cost = options.cost ?? 1;
    const errors: string[] = [];
    const report = await runFairSweep({
      listTenants: async () => this.list(tenantLimit),
      tenantLimit,
      stamp: async (tenant) => {
        if (this.failStamp.has(tenant)) throw new Error("stamp failed");
        this.seq += 1;
        this.stamps.set(tenant, this.seq);
      },
      stampWhen: (tenant) => !this.declineStamp.has(tenant),
      turn: async (tenant, pass): Promise<FairTurnResult> => {
        this.turns.push({ run, tenant, pass });
        this.now += cost;
        if (this.poison.has(tenant)) throw new Error("poison");
        const left = this.backlog.get(tenant) ?? 0;
        const done = Math.min(1, left);
        this.backlog.set(tenant, left - done);
        return { units: done, more: left - done > 0 };
      },
      budgetMs: options.budgetMs,
      clock: () => this.now,
      ...(options.maxPasses ? { maxPasses: options.maxPasses } : {}),
      onTenantError: (tenant, error) => errors.push(`${tenant}:${(error as Error).message}`),
    });
    return { report, errors };
  }

  turnsIn(run: number): string[] {
    return this.turns.filter((t) => t.run === run).map((t) => `${t.tenant}@${t.pass}`);
  }
}

const HOG = "00000000-0000-4000-8000-000000000000";
const VICTIM = "ffffffff-ffff-4fff-bfff-ffffffffffff";
const tenant = (n: number) => `${n.toString(16).padStart(8, "0")}-0000-4000-8000-000000000000`;

/** The checkout and hold loops at ca943a7: each tenant drained, in list order. */
async function drainInOrder(world: World, budgetMs: number): Promise<void> {
  world.run += 1;
  const started = world.now;
  for (const t of world.list(100)) {
    if (world.now - started >= budgetMs) break;
    for (;;) {
      world.turns.push({ run: world.run, tenant: t, pass: 1 });
      world.now += 1;
      const left = (world.backlog.get(t) ?? 0) - 1;
      world.backlog.set(t, Math.max(0, left));
      if (left <= 0 || world.now - started >= budgetMs) break;
    }
  }
}

const jain = (xs: number[]) =>
  xs.reduce((a, b) => a + b, 0) ** 2 / (xs.length * xs.reduce((a, b) => a + b * b, 0));

/** Runs, per tenant, in which the tenant took at least one turn. */
function servedRuns(world: World): Map<string, number[]> {
  const out = new Map<string, number[]>();
  for (const t of world.turns) {
    const runs = out.get(t.tenant) ?? [];
    if (runs.at(-1) !== t.run) runs.push(t.run);
    out.set(t.tenant, runs);
  }
  return out;
}

/** The longest wait, in runs, before a tenant's first turn or between two turns. */
function longestWait(world: World, tenants: string[], runs: number): number {
  const served = servedRuns(world);
  let worst = 0;
  for (const t of tenants) {
    const at = served.get(t) ?? [];
    if (at.length === 0) return Number.POSITIVE_INFINITY;
    let last = 0;
    for (const r of at) {
      worst = Math.max(worst, r - last);
      last = r;
    }
    worst = Math.max(worst, runs + 1 - last);
  }
  return worst;
}

describe("runFairSweep", () => {
  it("serves a high-id victim in the first run, before the low-id hog's second quantum", async () => {
    const world = new World();
    world.add(HOG, Number.POSITIVE_INFINITY);
    world.add(VICTIM, 1);
    const { report } = await world.sweep({ budgetMs: 50 });
    expect(world.backlog.get(VICTIM)).toBe(0);
    expect(world.turnsIn(1).slice(0, 3)).toEqual([`${HOG}@1`, `${VICTIM}@1`, `${HOG}@2`]);
    // Work conserving: the hog takes the rest of the budget.
    expect(report).toMatchObject({ tenants: 2, turns: 50, deferredTenants: 0, complete: false });
  });

  it("alternates two busy tenants when the budget fits one quantum a run", async () => {
    const world = new World();
    world.add(HOG, Number.POSITIVE_INFINITY);
    world.add(VICTIM, Number.POSITIVE_INFINITY);
    for (let i = 0; i < 4; i++) await world.sweep({ budgetMs: 1 });
    expect(world.turns.map((t) => t.tenant)).toEqual([HOG, VICTIM, HOG, VICTIM]);
  });

  it("keeps 250 busy tenants within ceil(T/m) runs of a turn, with a tenant limit of 100", async () => {
    const world = new World();
    const tenants = Array.from({ length: 250 }, (_, i) => tenant(i));
    for (const t of tenants) world.add(t, Number.POSITIVE_INFINITY);
    const runs = 30;
    for (let i = 0; i < runs; i++) {
      // 100 first turns and 30 more in pass 2.
      const { report } = await world.sweep({ budgetMs: 130, tenantLimit: 100 });
      expect(report).toMatchObject({ tenants: 100, turns: 130, complete: false });
      // Within a run, the tenants served differ by at most one quantum.
      const counts = new Map<string, number>();
      for (const t of world.turns.filter((x) => x.run === world.run)) {
        counts.set(t.tenant, (counts.get(t.tenant) ?? 0) + 1);
      }
      const values = [...counts.values()];
      expect(Math.max(...values) - Math.min(...values)).toBeLessThanOrEqual(1);
    }
    expect(longestWait(world, tenants, runs)).toBeLessThanOrEqual(3);
    const totals = tenants.map((t) => world.turns.filter((x) => x.tenant === t).length);
    expect(jain(totals)).toBeGreaterThanOrEqual(0.99);
  });

  it("sends a tenant whose turn always throws to the back, so it never delays the others", async () => {
    const world = new World();
    const [poison, a, b] = [tenant(0), tenant(1), tenant(2)];
    world.add(poison, Number.POSITIVE_INFINITY);
    world.add(a, Number.POSITIVE_INFINITY);
    world.add(b, Number.POSITIVE_INFINITY);
    world.poison.add(poison);
    const first = await world.sweep({ budgetMs: 2 });
    expect(first.report).toMatchObject({ failedTenants: 1, complete: false });
    expect(first.errors).toEqual([`${poison}:poison`]);
    await world.sweep({ budgetMs: 2 });
    await world.sweep({ budgetMs: 2 });
    expect(world.turnsIn(1)).toEqual([`${poison}@1`, `${a}@1`]);
    // Run 2 starts with the tenant run 1 never reached, then the poison, now oldest.
    expect(world.turnsIn(2)).toEqual([`${b}@1`, `${poison}@1`]);
    expect(world.turnsIn(3)).toEqual([`${a}@1`, `${b}@1`]);
    // A failed tenant gets no second turn in its run.
    const big = await world.sweep({ budgetMs: 100 });
    expect(world.turns.filter((t) => t.run === 4 && t.tenant === poison)).toHaveLength(1);
    expect(big.report.failedTenants).toBe(1);
  });

  it("serves a tenant that becomes due between runs in the next run", async () => {
    const world = new World();
    for (let i = 0; i < 5; i++) world.add(tenant(i), Number.POSITIVE_INFINITY);
    await world.sweep({ budgetMs: 3 });
    await world.sweep({ budgetMs: 3 });
    world.add(VICTIM, 1);
    await world.sweep({ budgetMs: 3 });
    expect(world.turnsIn(3)[0]).toBe(`${VICTIM}@1`);
  });

  it("starts no turn and writes no stamp with a zero or negative budget", async () => {
    for (const budgetMs of [0, -1]) {
      const world = new World();
      world.add(HOG, 3);
      world.add(VICTIM, 3);
      const { report } = await world.sweep({ budgetMs });
      expect(report).toEqual({
        tenants: 0,
        turns: 0,
        passes: 0,
        deferredTenants: 2,
        failedTenants: 0,
        stampFailures: 0,
        complete: false,
      });
      expect(world.stamps.size).toBe(0);
    }
  });

  it("starts no turn after the budget, but lets the turn in flight finish", async () => {
    const world = new World();
    world.add(HOG, Number.POSITIVE_INFINITY);
    world.add(VICTIM, Number.POSITIVE_INFINITY);
    // Each quantum takes 5 ms; turns start at 0 and 5, and the one started at 5 ends at 10.
    const { report } = await world.sweep({ budgetMs: 7, cost: 5 });
    expect(world.turnsIn(1)).toEqual([`${HOG}@1`, `${VICTIM}@1`]);
    expect(report).toMatchObject({ turns: 2, complete: false });
    expect(world.now).toBe(10);
  });

  it("reports a failed stamp and still takes the turn", async () => {
    const world = new World();
    world.add(HOG, 1);
    world.add(VICTIM, 1);
    world.failStamp.add(HOG);
    const { report, errors } = await world.sweep({ budgetMs: 100 });
    expect(errors).toEqual([`${HOG}:stamp failed`]);
    expect(report).toMatchObject({ tenants: 2, turns: 2, stampFailures: 1, complete: true });
    expect(world.backlog.get(HOG)).toBe(0);
    expect(world.stamps.has(HOG)).toBe(false);
  });

  it("drains one busy tenant in one run when the budget allows", async () => {
    const world = new World();
    world.add(HOG, 10);
    const { report } = await world.sweep({ budgetMs: 1000 });
    expect(world.backlog.get(HOG)).toBe(0);
    expect(report).toMatchObject({ tenants: 1, turns: 10, passes: 10, complete: true });
  });

  it("stamps a tenant again at its first extra turn, behind the tenants that got one", async () => {
    const world = new World();
    const [a, b, c] = [tenant(1), tenant(2), tenant(3)];
    for (const t of [a, b, c]) world.add(t, Number.POSITIVE_INFINITY);
    // Three first turns, then extra turns for a and b only.
    await world.sweep({ budgetMs: 5 });
    expect(world.turnsIn(1)).toEqual([`${a}@1`, `${b}@1`, `${c}@1`, `${a}@2`, `${b}@2`]);
    expect(world.list(100)).toEqual([c, a, b]);
  });

  it("keeps the place of a tenant whose stamp it declined", async () => {
    const world = new World();
    for (const t of [tenant(1), tenant(2), tenant(3)]) world.add(t, Number.POSITIVE_INFINITY);
    world.declineStamp.add(tenant(1));
    await world.sweep({ budgetMs: 3 });
    expect(world.stamps.has(tenant(1))).toBe(false);
    expect(world.list(100)[0]).toBe(tenant(1));
    await world.sweep({ budgetMs: 1 });
    expect(world.turnsIn(2)).toEqual([`${tenant(1)}@1`]);
  });

  describe("complete", () => {
    it("is true when every listed tenant is done", async () => {
      const world = new World();
      world.add(HOG, 2);
      world.add(VICTIM, 1);
      expect((await world.sweep({ budgetMs: 100 })).report).toMatchObject({
        tenants: 2,
        turns: 3,
        passes: 2,
        complete: true,
      });
    });

    it("is false when a listed tenant got no turn", async () => {
      const world = new World();
      world.add(HOG, 1);
      world.add(VICTIM, 1);
      expect((await world.sweep({ budgetMs: 1 })).report).toMatchObject({
        deferredTenants: 1,
        complete: false,
      });
    });

    it("is false when a tenant still has more at the end", async () => {
      const world = new World();
      world.add(HOG, 5);
      expect((await world.sweep({ budgetMs: 3 })).report).toMatchObject({
        deferredTenants: 0,
        turns: 3,
        complete: false,
      });
    });

    it("is false when the list reached the tenant limit", async () => {
      const world = new World();
      world.add(HOG, 1);
      world.add(VICTIM, 1);
      expect((await world.sweep({ budgetMs: 100, tenantLimit: 2 })).report).toMatchObject({
        tenants: 2,
        complete: false,
      });
    });

    it("is false when the list is full at the clamped limit, whatever limit was asked", async () => {
      const ids = Array.from({ length: 1000 }, (_, i) => tenant(i));
      const report = await runFairSweep({
        listTenants: async () => ids,
        tenantLimit: 2000,
        stamp: async () => {},
        turn: async () => ({ units: 1, more: false }),
        budgetMs: 1,
        clock: () => 0,
        onTenantError: () => {},
      });
      expect(report).toMatchObject({ tenants: 1000, deferredTenants: 0, complete: false });
    });

    it("fails only the turn when the turn observer throws", async () => {
      const errors: string[] = [];
      const report = await runFairSweep({
        listTenants: async () => [HOG, VICTIM],
        tenantLimit: 100,
        stamp: async () => {},
        turn: async () => ({ units: 1, more: false }),
        budgetMs: 1000,
        clock: () => 0,
        onTurnStart: (t) => {
          if (t === HOG) throw new Error("observer");
        },
        onTenantError: (t, error, during) =>
          errors.push(`${t}:${during}:${(error as Error).message}`),
      });
      expect(errors).toEqual([`${HOG}:turn:observer`]);
      expect(report).toMatchObject({ tenants: 2, turns: 2, failedTenants: 1, complete: false });
    });

    it("is false when a tenant failed", async () => {
      const world = new World();
      world.add(HOG, 1);
      world.poison.add(HOG);
      expect((await world.sweep({ budgetMs: 100 })).report).toMatchObject({
        failedTenants: 1,
        complete: false,
      });
    });

    it("is false, with no further turn, when a turn asks for more but did nothing", async () => {
      const turns: number[] = [];
      const report = await runFairSweep({
        listTenants: async () => [HOG],
        tenantLimit: 100,
        stamp: async () => {},
        turn: async (_t, pass) => {
          turns.push(pass);
          return { units: 0, more: true };
        },
        budgetMs: 1000,
        clock: () => 0,
        onTenantError: () => {},
      });
      expect(turns).toEqual([1]);
      expect(report).toMatchObject({ turns: 1, complete: false });
    });

    it("is false when the pass limit stops a tenant that still has more", async () => {
      const world = new World();
      world.add(HOG, 10);
      expect((await world.sweep({ budgetMs: 1000, maxPasses: 3 })).report).toMatchObject({
        turns: 3,
        passes: 3,
        complete: false,
      });
    });
  });

  describe("mutation checks: each fairness test fails against the order or loop before 0013", () => {
    it("the drain-each-tenant loop leaves the victim unserved behind the hog", async () => {
      const world = new World();
      world.add(HOG, Number.POSITIVE_INFINITY);
      world.add(VICTIM, 1);
      await drainInOrder(world, 50);
      expect(world.backlog.get(VICTIM)).toBe(1);
    });

    it("tenant id order gives a one-quantum budget to the low id every run", async () => {
      const world = new World("id");
      world.add(HOG, Number.POSITIVE_INFINITY);
      world.add(VICTIM, Number.POSITIVE_INFINITY);
      for (let i = 0; i < 4; i++) await world.sweep({ budgetMs: 1 });
      expect(world.turns.map((t) => t.tenant)).toEqual([HOG, HOG, HOG, HOG]);
    });

    it("tenant id order never reaches the 150 highest ids of 250", async () => {
      const world = new World("id");
      const tenants = Array.from({ length: 250 }, (_, i) => tenant(i));
      for (const t of tenants) world.add(t, Number.POSITIVE_INFINITY);
      for (let i = 0; i < 30; i++) await world.sweep({ budgetMs: 130, tenantLimit: 100 });
      expect(longestWait(world, tenants, 30)).toBe(Number.POSITIVE_INFINITY);
      const totals = tenants.map((t) => world.turns.filter((x) => x.tenant === t).length);
      expect(jain(totals)).toBeLessThan(0.5);
    });
  });
});
