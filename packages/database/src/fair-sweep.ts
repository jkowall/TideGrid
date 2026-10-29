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
 * within ceil(T / m) runs. That assumes stamps land: a tenant whose stamp fails
 * every run keeps its place and takes one of the m turns every run, so with k
 * such tenants the bound becomes about ceil((T - k) / (m - k)).
 * A failed stamp is reported once a run (`stampFailures`), and the tenant is
 * not stamped again in that run. The unit tests hold that bound; integration tests
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
  /**
   * End the whole run after this turn: no further turn starts for any tenant,
   * such as when a provider refuses at the account level (Part C).
   */
  stop?: boolean;
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
  /** Tenants whose stamp failed this run; each still took its turn. */
  stampFailures: number;
  /** A turn ended the run (FairTurnResult.stop). */
  stopped: boolean;
  /**
   * False when a listed tenant got no turn, a tenant still had more at the end
   * (or asked for more without doing anything), the list reached the tenant
   * limit, a tenant failed, or a turn stopped the run.
   */
  complete: boolean;
}

export interface FairSweepOptions {
  /** Due tenants, already least recently served first (the 0013 list functions). */
  listTenants: () => Promise<readonly string[]>;
  /**
   * The limit the list was asked for; a full list means more tenants may wait.
   * The list functions clamp it to 1 to 1,000, and so does the check here.
   */
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
  // The bound the list functions apply: greatest(1, least(limit, 1000)).
  const tenantLimit = Math.min(1000, Math.max(1, Math.trunc(options.tenantLimit) || 1));

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
    stopped: false,
    complete: false,
  };

  let stalled = false;
  /** The caller's error observer; one that throws is dropped, never escapes the run. */
  const notify = (tenantId: string, error: unknown, during: "stamp" | "turn") => {
    try {
      options.onTenantError(tenantId, error, during);
    } catch {
      // Nothing to report it to; the counts still say what happened.
    }
  };
  /** One turn; true when the tenant wants another. */
  const take = async (tenantId: string, pass: number): Promise<boolean> => {
    report.turns += 1;
    report.passes = Math.max(report.passes, pass);
    try {
      // Inside the try: an observer that throws fails this turn, not the run.
      options.onTurnStart?.(tenantId, pass);
      const { units, more, stop } = await options.turn(tenantId, pass);
      if (stop) {
        report.stopped = true;
        return false;
      }
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
      notify(tenantId, error, "turn");
      return false;
    }
  };

  /** Tenants whose stamp failed this run; they are not stamped again in it. */
  const unstamped = new Set<string>();
  const stamp = async (tenantId: string) => {
    if (unstamped.has(tenantId) || !(options.stampWhen?.(tenantId) ?? true)) return;
    try {
      await options.stamp(tenantId);
    } catch (error) {
      unstamped.add(tenantId);
      report.stampFailures += 1;
      notify(tenantId, error, "stamp");
    }
  };

  let waiting: string[] = [];
  let index = 0;
  for (; index < listed.length; index += 1) {
    if (overBudget()) break;
    const tenantId = listed[index] as string;
    await stamp(tenantId);
    // A slow stamp can use up the budget; then the turn does not start either.
    if (overBudget()) break;
    report.tenants += 1;
    if (await take(tenantId, 1)) waiting.push(tenantId);
    if (report.stopped) {
      index += 1;
      break;
    }
  }
  report.deferredTenants = listed.length - index;

  let pass = 1;
  let stopped = report.deferredTenants > 0 || report.stopped;
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
      if (pass === 2) {
        await stamp(tenantId);
        if (overBudget()) {
          stopped = true;
          next.push(...waiting.slice(i));
          break;
        }
      }
      if (await take(tenantId, pass)) next.push(tenantId);
      if (report.stopped) {
        stopped = true;
        next.push(...waiting.slice(i + 1));
        break;
      }
    }
    waiting = next;
  }

  report.complete =
    listed.length < tenantLimit &&
    report.deferredTenants === 0 &&
    waiting.length === 0 &&
    !stalled &&
    !report.stopped &&
    report.failedTenants === 0;
  return report;
}

/**
 * Stamp one tenant's turn for one sweep, in a transaction of its own under
 * that tenant's context, so a turn that fails afterwards cannot undo it. A
 * stamp never moves back: of two overlapping runs, the later time stays. The
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
        do update set last_turn_at = greatest(sweep_turns.last_turn_at, now()),
                      run_id = excluded.run_id`.execute(trx);
  });
}
