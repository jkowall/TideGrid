/**
 * Fair turns for the cron's cross-tenant sweeps (pre-pilot hardening, item 5;
 * coordinator default D1 A, pending owner confirmation).
 *
 * Each sweep's list function (0013) names its due tenants least recently
 * served first. `runFairSweep` then spends the run's budget in two kinds of
 * pass:
 *
 * 1. Pass 1 gives each listed tenant one quantum of work, in list order, while
 *    budget remains. Before a tenant's first turn the sweep stamps it, in a
 *    transaction of its own, so the next run lists it behind every tenant it
 *    has not reached yet. A turn that then throws has still moved its tenant to
 *    the back: work that fails every run cannot hold the head of the list.
 * 2. Later passes go round the tenants whose last quantum said there is more,
 *    until the budget runs out or nobody has more. A quiet run still drains a
 *    single busy tenant. A tenant's first extra turn stamps it once more, so
 *    the tenants that got extra turns this run sort behind the ones that got
 *    one, and extra turns rotate across runs instead of always going to the
 *    same tenants.
 *
 * No turn starts once the budget is spent, the first included, so a zero
 * budget starts none. A turn in flight finishes its quantum. The scheduler
 * knows nothing about items: each sweep keeps its own item logic, and any
 * state a tenant's turns share within a run, in its own per-run map.
 *
 * With T due tenants, and each run that does not overlap another starting at
 * least m turns (m no more than the tenant limit), every due tenant gets a turn
 * within ceil(T / m) runs. The unit tests hold that bound; integration tests
 * assert relative order only, because the shared test database holds other
 * suites' tenants.
 */
import { type Kysely, sql } from "kysely";
import { inTenantTransaction, type TenantContext } from "./tenant.ts";
import type { Database, SweepName } from "./types.ts";

export interface FairTurnResult {
  /** Items this turn worked on. A turn that worked on none cannot ask for more. */
  units: number;
  /** Another quantum could do more for this tenant now. */
  more: boolean;
}

export interface FairSweepReport {
  /** Tenants given at least one turn. */
  tenants: number;
  turns: number;
  /** Passes that started at least one turn. */
  passes: number;
  /** Tenants listed but given no turn: the budget ran out first. */
  deferredTenants: number;
  /** Tenants whose turn threw; they get no further turn this run. */
  failedTenants: number;
  /** Stamps that failed; each tenant still took its turn. */
  stampFailures: number;
  /**
   * False when a listed tenant got no turn, a tenant still had more at the end
   * (or asked for more without doing anything), the list reached the tenant
   * limit, or a tenant failed.
   */
  complete: boolean;
}

export interface FairSweepOptions {
  /** Due tenants, already least recently served first (the 0013 list functions). */
  listTenants: () => Promise<readonly string[]>;
  /** The limit the list was asked for; a full list means more tenants may wait. */
  tenantLimit: number;
  /** Move the tenant to the back of the next run's list. */
  stamp: (tenantId: string) => Promise<void>;
  /** Whether to stamp a tenant before its first turn and its first extra turn. Default: always. */
  stampWhen?: (tenantId: string) => boolean;
  /** One quantum of work for one tenant. */
  turn: (tenantId: string, pass: number) => Promise<FairTurnResult>;
  /** No turn starts once this many milliseconds have passed; zero or less starts none. */
  budgetMs: number;
  /** Milliseconds clock for the budget. */
  clock: () => number;
  /** When the budget started; default: when the call starts. */
  startedAt?: number;
  /** A safety valve only. Default 1,000. */
  maxPasses?: number;
  /** Called just before each turn, after the stamp. */
  onTurnStart?: (tenantId: string, pass: number) => void;
  /** A stamp failed (the turn still runs) or a turn threw (the tenant gets no more turns). */
  onTenantError: (tenantId: string, error: unknown, during: "stamp" | "turn") => void;
}

export const DEFAULT_FAIR_SWEEP_MAX_PASSES = 1000;

export async function runFairSweep(options: FairSweepOptions): Promise<FairSweepReport> {
  const { clock, budgetMs } = options;
  const started = options.startedAt ?? clock();
  const overBudget = () => budgetMs <= 0 || clock() - started >= budgetMs;
  const maxPasses = Math.max(1, options.maxPasses ?? DEFAULT_FAIR_SWEEP_MAX_PASSES);

  // A tenant listed twice would take two first turns; the list functions never
  // repeat one, but the scheduler does not depend on it.
  const listed = [...new Set(await options.listTenants())];
  const report: FairSweepReport = {
    tenants: 0,
    turns: 0,
    passes: 0,
    deferredTenants: 0,
    failedTenants: 0,
    stampFailures: 0,
    complete: false,
  };

  let stalled = false;
  /** One turn; true when the tenant wants another. */
  const take = async (tenantId: string, pass: number): Promise<boolean> => {
    options.onTurnStart?.(tenantId, pass);
    report.turns += 1;
    report.passes = Math.max(report.passes, pass);
    try {
      const { units, more } = await options.turn(tenantId, pass);
      if (!more) return false;
      // A turn that did nothing yet asks for more would spin until the budget
      // ran out. It gets no further turn, and the run does not claim to be done.
      if (!(units > 0)) {
        stalled = true;
        return false;
      }
      return true;
    } catch (error) {
      report.failedTenants += 1;
      options.onTenantError(tenantId, error, "turn");
      return false;
    }
  };

  const stamp = async (tenantId: string) => {
    if (!(options.stampWhen?.(tenantId) ?? true)) return;
    try {
      await options.stamp(tenantId);
    } catch (error) {
      report.stampFailures += 1;
      options.onTenantError(tenantId, error, "stamp");
    }
  };

  let waiting: string[] = [];
  let index = 0;
  for (; index < listed.length; index += 1) {
    if (overBudget()) break;
    const tenantId = listed[index] as string;
    await stamp(tenantId);
    report.tenants += 1;
    if (await take(tenantId, 1)) waiting.push(tenantId);
  }
  report.deferredTenants = listed.length - index;

  let pass = 1;
  let stopped = report.deferredTenants > 0;
  while (!stopped && waiting.length > 0 && pass < maxPasses) {
    pass += 1;
    const next: string[] = [];
    for (let i = 0; i < waiting.length; i += 1) {
      if (overBudget()) {
        stopped = true;
        next.push(...waiting.slice(i));
        break;
      }
      const tenantId = waiting[i] as string;
      // A tenant's first extra turn stamps it again, behind every tenant that
      // got only one turn. Without it the extra turns of every run would go to
      // the same tenants, the ones a fixed rotation puts at the head of the list.
      if (pass === 2) await stamp(tenantId);
      if (await take(tenantId, pass)) next.push(tenantId);
    }
    waiting = next;
  }

  report.complete =
    listed.length < options.tenantLimit &&
    report.deferredTenants === 0 &&
    waiting.length === 0 &&
    !stalled &&
    report.failedTenants === 0;
  return report;
}

/**
 * Stamp one tenant's turn for one sweep, in a transaction of its own under
 * that tenant's context, so a turn that fails afterwards cannot undo it. The
 * run id is kept for an operator reading the table; it is cut to 128
 * characters, the column's bound.
 */
export async function recordSweepTurn(
  db: Kysely<Database>,
  ctx: TenantContext,
  sweep: SweepName,
): Promise<void> {
  const runId = ctx.requestId ? ctx.requestId.slice(0, 128) : null;
  await inTenantTransaction(db, ctx, async (trx) => {
    await sql`
      insert into sweep_turns (tenant_id, sweep, run_id)
      values (${ctx.tenantId}, ${sweep}, ${runId})
      on conflict (tenant_id, sweep)
        do update set last_turn_at = now(), run_id = excluded.run_id`.execute(trx);
  });
}
