/**
 * Console search cost evidence (pre-pilot hardening, item 5, 6.5, and the
 * search latency goal). Off by default: it runs only with
 * TIDEGRID_SEARCH_BENCH=1, on a throwaway commit of a draft PR, and logs
 * B_BENCH lines. It gates on equality only: before and after must give the
 * same whole outcome in every case.
 *
 * It grows one tenant to about BENCH_BOOKINGS bookings by cloning one real
 * booking's rows as the owner with triggers and foreign keys off
 * (session_replication_role = replica). That bypass is acceptable only in a
 * throwaway CI database, which is the only place this runs. Names and emails
 * get a realistic spread of surnames and mail domains. Five more synthetic
 * bookings carry a rare token on the tenant's last trip. Then it times whole
 * requests as the runtime role, the b6d0247 search ("before",
 * search-baseline.testing.ts) and today's ("after") interleaved, each under
 * forced custom plans and forced generic plans, and EXPLAINs every statement
 * both ways. A second tenant with as many bookings spread over about 1,300
 * trips follows, so its load never changes the first tenant's numbers.
 */
import { availableParallelism } from "node:os";
import { isDeepStrictEqual } from "node:util";
import { createDb, inTenantTransaction, snapshotRead } from "@tidegrid/database";
import type {} from "@tidegrid/database/global-setup";
import { addDays, createSchedule, generateTrips } from "@tidegrid/domain-catalog";
import { systemContext, tripAllocator } from "@tidegrid/domain-inventory/testing";
import { CompiledQuery, sql } from "kysely";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";
import { type BookingSearchOutcome, type BookingSearchQuery, searchBookings } from "./search.ts";
import { baselineSearch } from "./search-baseline.testing.ts";
import {
  type CheckoutFixture,
  confirmBooking,
  createCheckoutFixture,
  fakeProvider,
  guestContext,
} from "./test-fixtures.ts";

type Sql = ReturnType<typeof postgres>;

const env = inject("integrationDb");
const on = true;
const N = Number(process.env.BENCH_BOOKINGS ?? 50_000);
/** Timed requests per case and plan mode, after the warm-ups. */
const AFTER_RUNS = 60;
const BEFORE_RUNS = 20;
const WARMUPS = 3;
/** Rare synthetic bookings on the last trip, carrying a token nothing else holds. */
const LATE = 5;

/** Per table, the columns a clone must change; every other column is copied from the template. */
const overrides: Record<string, Record<string, string>> = {
  checkout_sessions: {
    id: "i.cs",
    quote_id: "i.quote",
    hold_id: "i.hold",
    booker_name: "i.name",
    booker_email: "i.email",
  },
  orders: { id: "i.ord", checkout_session_id: "i.cs", quote_id: "i.quote" },
  payments: {
    id: "i.pay",
    checkout_session_id: "i.cs",
    order_id: "i.ord",
    idempotency_key: "'bench_key_' || i.g",
    provider_payment_id: "'benchpay_' || i.g",
  },
  bookings: {
    id: "i.bk",
    reference: "i.ref",
    checkout_session_id: "i.cs",
    order_id: "i.ord",
    payment_id: "i.pay",
    hold_id: "i.hold",
    trip_id: "i.trip",
    confirmed_at: "now() - make_interval(secs => i.g)",
  },
};

/** The spread of names every cloned booking gets, from its generator value g. */
const benchName = `(array['James','Mary','Luis','Ana','Wei','Fatima','John','Maria','David','Sarah',
                      'Ahmed','Priya','Carlos','Emma','Noah','Olivia','Liam','Sofia','Jean','Aiko'])
                 [1 + (g % 20)] || ' ' ||
               (array['Smith','Johnson','Garcia','Brown','Nguyen','Fernandez','Lee','Martin','Kim',
                      'Lopez','Patel','Wilson','Anderson','Taylor','Thomas','Moore','Jackson',
                      'White','Harris','Clark','Lewis','Robinson','Walker','Young','Allen'])
                 [1 + ((g * 7) % 25)] ||
               case when g % 9 = 0 then '-' || (array['Ortiz','Reyes','Cruz'])[1 + (g % 3)] else '' end`;
/** And of mail domains: four in ten at gmail.com. */
const benchEmail = `'guest' || g || '@' ||
               (array['gmail.com','gmail.com','gmail.com','gmail.com','yahoo.com','outlook.com',
                      'icloud.com','hotmail.com','proton.me','divecenter.com'])[1 + (g % 10)]`;

type Shape = "before" | "after";
type PlanMode = "custom" | "generic";
const shapes: Record<Shape, typeof searchBookings> = {
  before: baselineSearch,
  after: searchBookings,
};

interface Case {
  tenant: "A" | "B";
  /** common, mid, rare, none, early, finance, or paging. */
  class: string;
  name: string;
  tenantId: string;
  query: BookingSearchQuery;
}

interface Node {
  "Node Type": string;
  "Relation Name"?: string;
  "Index Name"?: string;
  Alias?: string;
  "Plan Rows"?: number;
  "Actual Total Time"?: number;
  "Actual Rows"?: number;
  "Actual Loops"?: number;
  Plans?: Node[];
}

interface Explained {
  Plan: Node;
  "Execution Time"?: number;
  JIT?: { Functions?: number; Timing?: { Total?: number } };
}

function nodesOf(root: Node): Node[] {
  const all: Node[] = [];
  const walk = (n: Node) => {
    all.push(n);
    for (const c of n.Plans ?? []) walk(c);
  };
  walk(root);
  return all;
}

const describeNode = (n: Node) =>
  `${n["Node Type"]}${n["Relation Name"] ? ` ${n["Relation Name"]}` : ""}${n.Alias && n.Alias !== n["Relation Name"] ? ` ${n.Alias}` : ""}${n["Index Name"] ? ` (${n["Index Name"]})` : ""}`;

/** The slowest nodes of a timed plan by their own time: inclusive time times loops, less their children's. Relative only. */
function hotspots(root: Node): string[] {
  const total = (n: Node) => (n["Actual Total Time"] ?? 0) * (n["Actual Loops"] ?? 1);
  return nodesOf(root)
    .map((n) => ({
      what: describeNode(n),
      ms: total(n) - (n.Plans ?? []).reduce((sum, c) => sum + total(c), 0),
      rows: n["Actual Rows"] ?? 0,
      loops: n["Actual Loops"] ?? 1,
    }))
    .sort((a, b) => b.ms - a.ms)
    .slice(0, 6)
    .map((n) => `${n.what}: ${Math.round(n.ms * 10) / 10} ms, ${n.rows} rows x ${n.loops}`);
}

/** Estimated against actual rows for the bookings, checkout, and Limit nodes. */
function estimates(root: Node) {
  return nodesOf(root)
    .filter(
      (n) =>
        n["Node Type"] === "Limit" ||
        n["Relation Name"] === "bookings" ||
        n["Relation Name"] === "checkout_sessions",
    )
    .map((n) => ({
      node: describeNode(n),
      planRows: n["Plan Rows"],
      actualRows: n["Actual Rows"],
      loops: n["Actual Loops"],
    }));
}

/** The most rows any orders, payments, or refunds scan produced, over all its loops. */
function detailRows(root: Node): number {
  return Math.max(
    0,
    ...nodesOf(root)
      .filter((n) => ["orders", "payments", "payment_refunds"].includes(n["Relation Name"] ?? ""))
      .map((n) => (n["Actual Rows"] ?? 0) * (n["Actual Loops"] ?? 1)),
  );
}

/** Which of the search's statements this is. */
function labelOf(text: string): "cursor" | "count" | "page" | "context" {
  if (!/from bookings b\b/.test(text)) return "context";
  if (text.includes("count(*)")) return "count";
  if (text.includes("order by")) return "page";
  return "cursor";
}

/** A captured parameter as a typed-later SQL literal, for EXECUTE under a generic plan. */
function literal(value: unknown): string {
  if (typeof value === "number" && Number.isInteger(value)) return String(value);
  if (typeof value === "string") return `'${value.replace(/'/g, "''")}'`;
  throw new TypeError(`no literal for ${typeof value}`);
}

/**
 * A distribution-free interval for the q quantile from order statistics: the
 * ranks l and u (1-based) with P(X(l) <= x_q <= X(u)) >= conf, or null where
 * n is too small for that side.
 */
function quantileRanks(n: number, q: number, conf: number): [number | null, number | null] {
  const cdf: number[] = [];
  let pmf = (1 - q) ** n;
  let acc = 0;
  for (let k = 0; k <= n; k++) {
    acc += pmf;
    cdf[k] = acc;
    pmf = (pmf * (n - k) * q) / ((k + 1) * (1 - q));
  }
  const alpha = (1 - conf) / 2;
  let lower: number | null = null;
  for (let r = 1; r <= n; r++) if ((cdf[r - 1] ?? 1) <= alpha) lower = r;
  let upper: number | null = null;
  for (let r = n; r >= 1; r--) if ((cdf[r - 1] ?? 0) >= 1 - alpha) upper = r;
  return [lower, upper];
}

/** p50, p95 (nearest rank), its 90% interval, and max, in milliseconds. */
function summary(ms: number[]) {
  const s = [...ms].sort((a, b) => a - b);
  const n = s.length;
  const at = (rank: number | null) =>
    rank === null ? null : Math.round((s[rank - 1] ?? Number.NaN) * 10) / 10;
  const [lo, hi] = quantileRanks(n, 0.95, 0.9);
  return {
    p50: at(Math.ceil(0.5 * n)),
    p95: at(Math.ceil(0.95 * n)),
    p95lo: at(lo),
    p95hi: at(hi),
    max: at(n),
    runs: n,
  };
}

describe.skipIf(!env || !on)("console search cost at pilot volume (benchmark)", () => {
  let admin: Sql;
  let runtime: ReturnType<typeof createDb>;
  /** One connection for every timed request, so its prepared statements show which plan ran. */
  let timing: ReturnType<typeof createDb>;
  let provider: ReturnType<typeof fakeProvider>;
  let A: CheckoutFixture;
  /** Equality, plan-mode, and row-bound problems, reported together at the end. */
  const problems: unknown[] = [];
  let explainSeq = 0;

  /**
   * Clone a tenant's template booking into rows g = first..last, with the
   * given SQL for each row's trip, name, and email. $1 is the tenant id.
   */
  async function clone(
    tenantId: string,
    template: { bookingId: string; checkoutSessionId: string },
    set: { first: number; last: number; trip: string; name: string; email: string },
  ) {
    await admin.begin(async (tx) => {
      await tx`set local session_replication_role = replica`;
      await tx.unsafe(
        `create temp table bench_ids on commit drop as
         select g,
                gen_random_uuid() as cs, gen_random_uuid() as quote, gen_random_uuid() as hold,
                gen_random_uuid() as ord, gen_random_uuid() as pay, gen_random_uuid() as bk,
                ${set.trip} as trip,
                -- Eight Crockford characters from the number, never a real reference's.
                (select string_agg(substr('0123456789ABCDEFGHJKMNPQRSTVWXYZ',
                                          1 + ((g / (32 ^ k)::bigint) % 32)::int, 1), '' order by k desc)
                   from generate_series(0, 7) k) as ref,
                ${set.name} as name,
                ${set.email} as email
           from generate_series($2::int, $3::int) g`,
        [tenantId, set.first, set.last],
      );
      for (const [table, cols] of Object.entries(overrides)) {
        const columns = (
          await tx<{ name: string }[]>`
            select column_name as name from information_schema.columns
             where table_schema = 'public' and table_name = ${table}
               and is_generated = 'NEVER' and identity_generation is null
             order by ordinal_position`
        ).map((c) => c.name);
        const keyOf: Record<string, string> = {
          checkout_sessions: template.checkoutSessionId,
          bookings: template.bookingId,
        };
        const where =
          table === "orders" || table === "payments"
            ? `tpl.checkout_session_id = '${template.checkoutSessionId}'`
            : `tpl.id = '${keyOf[table]}'`;
        const select = columns.map((c) => cols[c] ?? `tpl.${c}`).join(", ");
        await tx.unsafe(
          `insert into public.${table} (${columns.join(", ")})
           select ${select} from public.${table} tpl, bench_ids i where ${where}`,
        );
      }
    });
  }

  async function analyze() {
    for (const table of [
      "checkout_sessions",
      "bookings",
      "orders",
      "payments",
      "scheduled_trips",
      "products",
      "boats",
      "payment_refunds",
    ]) {
      await admin.unsafe(`analyze public.${table}`);
    }
  }

  beforeAll(async () => {
    if (!env) return;
    admin = postgres(env.adminUrl, { max: 2, onnotice: () => {} });
    runtime = createDb(env.runtimeUrl, { max: 2 });
    timing = createDb(env.runtimeUrl, { max: 1 });
    provider = fakeProvider(runtime.db);
    A = await createCheckoutFixture(admin, runtime.db, "bench", { days: 40 });
    const trips = tripAllocator(A);
    const template = await confirmBooking(runtime.db, provider, A, trips.shared(), 1);
    const started = Date.now();
    await clone(A.id, template, {
      first: 1,
      last: N,
      trip: `(select array_agg(id) from public.scheduled_trips where tenant_id = $1)[1 + (g % 40)]`,
      name: benchName,
      email: benchEmail,
    });
    // Synthetic: a token ("qu") only these five hold, on the last trip in the search's order.
    await clone(A.id, template, {
      first: N + 1,
      last: N + LATE,
      trip: `(select id from public.scheduled_trips where tenant_id = $1
               order by starts_at desc, id desc limit 1)`,
      name: `'Synthetic Quill'`,
      email: `'late' || g || '@bench.test'`,
    });
    await analyze();
    console.log(
      `B_BENCH_LOAD ${JSON.stringify({ tenant: "A", bookings: N + LATE, ms: Date.now() - started })}`,
    );
    const [settings] = await admin<Record<string, string>[]>`
      select version() as version, current_setting('shared_buffers') as shared_buffers,
             current_setting('work_mem') as work_mem, current_setting('jit') as jit,
             current_setting('jit_above_cost') as jit_above_cost,
             current_setting('random_page_cost') as random_page_cost,
             current_setting('max_parallel_workers_per_gather') as max_parallel_workers_per_gather`;
    console.log(`B_BENCH_ENV ${JSON.stringify({ nproc: availableParallelism(), ...settings })}`);
  }, 600_000);

  afterAll(async () => {
    await timing?.end();
    await runtime?.end();
    await admin?.end({ timeout: 5 });
  });

  /** One whole request as the console makes it, in its own snapshot, timed around the transaction. */
  async function request(shape: Shape, plan: PlanMode, c: Case, jit = true) {
    const t0 = performance.now();
    const outcome = await inTenantTransaction(
      timing.db,
      guestContext(c.tenantId),
      async (trx) => {
        await sql`select set_config('statement_timeout', '90s', true),
                         set_config('plan_cache_mode', ${`force_${plan}_plan`}, true)`.execute(trx);
        if (!jit) await sql`select set_config('jit', 'off', true)`.execute(trx);
        return shapes[shape](trx, c.tenantId, c.query);
      },
      snapshotRead,
    );
    return { ms: performance.now() - t0, outcome };
  }

  /** Custom and generic plans built so far for the search's statements on the timing connection. */
  async function planCounts(): Promise<{ custom: number; generic: number }> {
    const [row] = await timing.sql<{ custom: number; generic: number }[]>`
      select coalesce(sum(custom_plans), 0)::int as custom,
             coalesce(sum(generic_plans), 0)::int as generic
        from pg_prepared_statements where statement like ${"%from bookings b%"}`;
    return row ?? { custom: 0, generic: 0 };
  }

  /** Every statement one request emits, as compiled, with its parameters. */
  async function capture(shape: Shape, c: Case) {
    const captured: { sql: string; parameters: readonly unknown[] }[] = [];
    const db = runtime.db.withPlugin({
      transformQuery: (args) => {
        const compiled = runtime.db.getExecutor().compileQuery(args.node, args.queryId);
        captured.push({ sql: compiled.sql, parameters: compiled.parameters });
        return args.node;
      },
      transformResult: async (args) => args.result,
    });
    await inTenantTransaction(
      db,
      guestContext(c.tenantId),
      (trx) => shapes[shape](trx, c.tenantId, c.query),
      snapshotRead,
    );
    return captured.filter((s) => labelOf(s.sql) !== "context");
  }

  /** EXPLAIN one statement as the runtime under the tenant's context, with a custom or a generic plan. */
  function explain(
    c: Case,
    statement: { sql: string; parameters: readonly unknown[] },
    plan: PlanMode,
    options: string,
  ): Promise<Explained> {
    return inTenantTransaction(runtime.db, guestContext(c.tenantId), async (trx) => {
      await sql`select set_config('statement_timeout', '90s', true)`.execute(trx);
      type Row = { "QUERY PLAN": Explained[] };
      let rows: Row[];
      if (plan === "custom") {
        // Bound parameters: the planner sees their values.
        ({ rows } = await trx.executeQuery<Row>(
          CompiledQuery.raw(`explain (${options}) ${statement.sql}`, [...statement.parameters]),
        ));
      } else {
        const name = `bench_plan_${++explainSeq}`;
        await trx.executeQuery(CompiledQuery.raw(`prepare ${name} as ${statement.sql}`, []));
        await sql`select set_config('plan_cache_mode', 'force_generic_plan', true)`.execute(trx);
        ({ rows } = await trx.executeQuery<Row>(
          CompiledQuery.raw(
            `explain (${options}) execute ${name}(${statement.parameters.map(literal).join(", ")})`,
            [],
          ),
        ));
        await trx.executeQuery(CompiledQuery.raw(`deallocate ${name}`, []));
      }
      const root = rows[0]?.["QUERY PLAN"][0];
      if (!root) throw new Error("no plan");
      return root;
    });
  }

  /** EXPLAIN each statement of a case, both shapes and plan modes; returns whether any after plan used JIT. */
  async function explainCase(c: Case): Promise<Set<PlanMode>> {
    const jitModes = new Set<PlanMode>();
    for (const shape of ["before", "after"] as const) {
      const statements = await capture(shape, c);
      for (const plan of ["custom", "generic"] as const) {
        for (const statement of statements) {
          const label = labelOf(statement.sql);
          const counted = await explain(
            c,
            statement,
            plan,
            "analyze, timing off, buffers, format json",
          );
          const timed = await explain(c, statement, plan, "analyze, buffers, format json");
          // With timing off a plan names its JIT functions but not their time.
          const jit = timed.JIT ?? null;
          if (shape === "after" && (counted.JIT?.Functions ?? 0) > 0) jitModes.add(plan);
          // After the change the details are read for the page's rows only, under either plan.
          const details = detailRows(counted.Plan);
          if (shape === "after" && details > c.query.limit + 1) {
            problems.push({ kind: "detail rows", tenant: c.tenant, case: c.name, plan, details });
          }
          console.log(
            `B_BENCH_EXPLAIN ${JSON.stringify({
              tenant: c.tenant,
              case: c.name,
              shape,
              plan,
              statement: label,
              executionMs: counted["Execution Time"],
              detailRows: details,
              estimates: estimates(counted.Plan),
              jit,
              hot: hotspots(timed.Plan),
            })}`,
          );
        }
      }
    }
    return jitModes;
  }

  /**
   * Time one case: per plan mode, warm-ups of both shapes, then before and
   * after interleaved (before, after, after, after, ...), with every outcome
   * checked against the first.
   */
  async function timeCase(c: Case) {
    const role = c.query.withBooker ? "staff" : "finance";
    const expected = (await request("before", "custom", c)).outcome;
    const check = (shape: Shape, plan: string, outcome: BookingSearchOutcome) => {
      if (!isDeepStrictEqual(outcome, expected)) {
        problems.push({ kind: "outcome", tenant: c.tenant, case: c.name, shape, plan });
      }
    };
    const total = expected.kind === "ok" ? expected.total : -1;
    const series = async (plan: PlanMode, jit: boolean, afterRuns: number, beforeRuns: number) => {
      for (let i = 0; i < WARMUPS; i++) {
        for (const shape of ["before", "after"] as const) {
          check(shape, plan, (await request(shape, plan, c, jit)).outcome);
        }
      }
      const ms: Record<Shape, number[]> = { before: [], after: [] };
      const start = await planCounts();
      let a = 0;
      let b = 0;
      while (a < afterRuns || b < beforeRuns) {
        // One before for every three after.
        const shape: Shape = b < beforeRuns && (a >= afterRuns || a >= 3 * b) ? "before" : "after";
        const r = await request(shape, plan, c, jit);
        check(shape, plan, r.outcome);
        ms[shape].push(r.ms);
        if (shape === "before") b++;
        else a++;
      }
      const end = await planCounts();
      const delta = { custom: end.custom - start.custom, generic: end.generic - start.generic };
      // A recycled connection starts its counts again; that series proves nothing either way.
      const reset = delta.custom < 0 || delta.generic < 0;
      const ran =
        plan === "custom"
          ? delta.generic === 0 && delta.custom > 0
          : delta.custom === 0 && delta.generic > 0;
      if (!reset && !ran) {
        problems.push({ kind: "plan mode", tenant: c.tenant, case: c.name, plan, delta });
      }
      const label = jit ? plan : `${plan}+jit_off`;
      for (const shape of ["before", "after"] as const) {
        if (ms[shape].length === 0) continue;
        console.log(
          `B_BENCH_REQUEST ${JSON.stringify({
            tenant: c.tenant,
            class: c.class,
            case: c.name,
            q: c.query.q ?? null,
            role,
            shape,
            plan: label,
            total,
            ...summary(ms[shape]),
            prepared: reset ? "reset" : delta,
          })}`,
        );
      }
    };
    for (const plan of ["custom", "generic"] as const)
      await series(plan, true, AFTER_RUNS, BEFORE_RUNS);
    const jitModes = await explainCase(c);
    // When an after plan spends time compiling, size JIT's share with one series of 20 without it.
    for (const plan of jitModes) await series(plan, false, 20, 0);
  }

  /** The id a cursor `back` rows from the end of the "@g" matches, read as the runtime. */
  async function nearTheEnd(tenantId: string, back: number): Promise<string> {
    return inTenantTransaction(runtime.db, guestContext(tenantId), async (trx) => {
      const { rows } = await sql<{ id: string }>`
        select b.id from bookings b
          join scheduled_trips t on t.tenant_id = b.tenant_id and t.id = b.trip_id
          join checkout_sessions s on s.tenant_id = b.tenant_id and s.id = b.checkout_session_id
         where b.tenant_id = ${tenantId}
           and (s.booker_name ilike '%@g%' or s.booker_email like '%@g%')
         order by t.starts_at desc, t.id desc, b.confirmed_at desc, b.id desc
         offset ${back} limit 1`.execute(trx);
      if (!rows[0]) throw new Error("no cursor near the end");
      return rows[0].id;
    });
  }

  async function datesOf(tenantId: string): Promise<{ first: string; last: string }> {
    const [row] = await admin<{ first: string; last: string }[]>`
      select min(local_date)::text as first, max(local_date)::text as last
        from public.scheduled_trips where tenant_id = ${tenantId}`;
    if (!row) throw new Error("no trips");
    return row;
  }

  it("times the request before and after, for every fragment class, both roles and plan modes", async () => {
    const [{ n } = { n: 0 }] = await admin<{ n: number }[]>`
      select count(*)::int as n from public.bookings where tenant_id = ${A.id}`;
    expect(n).toBeGreaterThanOrEqual(N + LATE);
    const dates = await datesOf(A.id);
    const [{ reference } = { reference: "" }] = await admin<{ reference: string }[]>`
      select reference from public.bookings where tenant_id = ${A.id}
       order by reference offset ${Math.floor(N / 2)} limit 1`;
    const staff = (q: string) => ({ q, limit: 25, withBooker: true });
    const finance = (q: string) => ({ q, limit: 25, withBooker: false });
    const firstPage = await inTenantTransaction(
      runtime.db,
      guestContext(A.id),
      (trx) => searchBookings(trx, A.id, staff("@g")),
      snapshotRead,
    );
    const pageTwo = firstPage.kind === "ok" ? (firstPage.nextAfter ?? "") : "";
    const deep = await nearTheEnd(A.id, 10);
    const cases: Omit<Case, "tenant" | "tenantId">[] = [
      // "@g" and "gmail" match the same 20,000 addresses, from different patterns;
      // "gmail" is also the reference prefix GMA11, so its condition spans both tables.
      { class: "common", name: "@g", query: staff("@g") },
      { class: "common", name: "gmail", query: staff("gmail") },
      { class: "common", name: "0000", query: staff("0000") },
      {
        class: "common",
        name: "every day",
        query: { from: dates.first, to: dates.last, limit: 25, withBooker: true },
      },
      {
        class: "common",
        name: "from only",
        query: { from: dates.first, limit: 25, withBooker: true },
      },
      { class: "mid", name: "smith", query: staff("smith") },
      { class: "mid", name: "luis", query: staff("luis") },
      { class: "rare", name: "guest4999", query: staff("guest4999") },
      { class: "rare", name: "one reference", query: staff(reference) },
      { class: "none", name: "zyxwv", query: staff("zyxwv") },
      { class: "none", name: "luis fernandez", query: staff("luis fernandez") },
      // Two characters: a reference prefix that matches nothing, and a token only the last trip holds.
      { class: "early", name: "qj", query: staff("qj") },
      { class: "early", name: "qu (last trip)", query: staff("qu") },
      { class: "finance", name: "0000", query: finance("0000") },
      { class: "finance", name: "gmail", query: finance("gmail") },
      { class: "finance", name: "one reference", query: finance(reference) },
      { class: "finance", name: "zz", query: finance("zz") },
      { class: "paging", name: "@g page two", query: { ...staff("@g"), after: pageTwo } },
      { class: "paging", name: "@g ten from the end", query: { ...staff("@g"), after: deep } },
    ];
    for (const c of cases) await timeCase({ ...c, tenant: "A", tenantId: A.id });
    expect(problems).toEqual([]);
  }, 3_600_000);

  it("times a second tenant whose bookings spread over about 1,300 trips", async () => {
    const started = Date.now();
    const B = await createCheckoutFixture(admin, runtime.db, "bench-b", { days: 90 });
    // Six more 90-day runs of the shared and charter departures, through the real catalog.
    const ctx = systemContext(B.id, "bench");
    const { first } = await datesOf(B.id);
    for (let k = 1; k <= 6; k++) {
      const from = addDays(first, 90 * k);
      const to = addDays(from, 89);
      for (const [productId, boatId] of [
        [B.products.shared, B.boats.lark],
        [B.products.charter, B.boats.wren],
      ] as const) {
        const made = await inTenantTransaction(runtime.db, ctx, async (trx) => {
          const schedule = await createSchedule(trx, ctx, {
            productId,
            boatId,
            startsOn: from,
            endsOn: to,
            weekdays: [1, 2, 3, 4, 5, 6, 7],
            startTimes: ["10:00"],
            reason: "bench",
          });
          if (schedule.kind !== "created") throw new Error(`schedule: ${JSON.stringify(schedule)}`);
          return generateTrips(trx, ctx, {
            scheduleId: schedule.id,
            fromDate: from,
            toDate: to,
            publish: true,
            reason: "bench",
          });
        });
        if (made.kind !== "generated") throw new Error(`trips: ${JSON.stringify(made)}`);
      }
    }
    const [{ trips } = { trips: 0 }] = await admin<{ trips: number }[]>`
      select count(*)::int as trips from public.scheduled_trips where tenant_id = ${B.id}`;
    const template = await confirmBooking(runtime.db, provider, B, B.trips.shared[0] ?? "", 1);
    // Generator values past tenant A's, so payment keys stay unique across tenants.
    await clone(B.id, template, {
      first: N + 1001,
      last: 2 * N + 1000,
      trip: `(select array_agg(id) from public.scheduled_trips where tenant_id = $1)
               [1 + (g % ${trips})]`,
      name: benchName,
      email: benchEmail,
    });
    await analyze();
    console.log(
      `B_BENCH_LOAD ${JSON.stringify({ tenant: "B", bookings: N, trips, ms: Date.now() - started })}`,
    );
    expect(trips).toBeGreaterThanOrEqual(1000);
    // A fresh timing connection: the first one has served tenant A for a while.
    await timing.end();
    timing = createDb(env?.runtimeUrl ?? "", { max: 1 });
    const dates = await datesOf(B.id);
    const cases: Omit<Case, "tenant" | "tenantId">[] = [
      { class: "common", name: "@g", query: { q: "@g", limit: 25, withBooker: true } },
      { class: "early", name: "qj", query: { q: "qj", limit: 25, withBooker: true } },
      {
        class: "common",
        name: "every day",
        query: { from: dates.first, to: dates.last, limit: 25, withBooker: true },
      },
    ];
    for (const c of cases) await timeCase({ ...c, tenant: "B", tenantId: B.id });
    expect(problems).toEqual([]);
  }, 2_400_000);
});
