/**
 * Console search cost evidence (pre-pilot hardening, item 5, 6.5). Off by
 * default: it runs only with TIDEGRID_SEARCH_BENCH=1, once, on a throwaway
 * commit of a draft PR, and logs a B_BENCH line. Not a gate.
 *
 * It grows one tenant to about BENCH_BOOKINGS bookings by cloning one real
 * booking's rows as the owner with triggers and foreign keys off
 * (session_replication_role = replica). That bypass is acceptable only in a
 * throwaway CI database, which is the only place this runs. Names and emails
 * get a realistic spread of surnames and mail domains. Then it times the
 * whole request, cursor-free first page and count in one snapshot, as the
 * runtime role.
 */
import { createDb, inTenantTransaction, snapshotRead } from "@tidegrid/database";
import type {} from "@tidegrid/database/global-setup";
import { tripAllocator } from "@tidegrid/domain-inventory/testing";
import { sql } from "kysely";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";
import { searchBookings, searchShape } from "./search.ts";
import {
  confirmBooking,
  createCheckoutFixture,
  fakeProvider,
  guestContext,
} from "./test-fixtures.ts";

type Sql = ReturnType<typeof postgres>;

const env = inject("integrationDb");
const on = true; // THROWAWAY: one benchmark run, reverted next commit
const N = Number(process.env.BENCH_BOOKINGS ?? 50_000);

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

describe.skipIf(!env || !on)("console search cost at pilot volume (benchmark)", () => {
  let admin: Sql;
  let runtime: ReturnType<typeof createDb>;
  let tenantId: string;

  beforeAll(async () => {
    if (!env) return;
    admin = postgres(env.adminUrl, { max: 2, onnotice: () => {} });
    runtime = createDb(env.runtimeUrl, { max: 2 });
    const provider = fakeProvider(runtime.db);
    const t = await createCheckoutFixture(admin, runtime.db, "bench", { days: 40 });
    tenantId = t.id;
    const trips = tripAllocator(t);
    const template = await confirmBooking(runtime.db, provider, t, trips.shared(), 1);
    const started = Date.now();
    await admin.begin(async (tx) => {
      await tx`set local session_replication_role = replica`;
      await tx`
        create temp table bench_ids on commit drop as
        select g,
               gen_random_uuid() as cs, gen_random_uuid() as quote, gen_random_uuid() as hold,
               gen_random_uuid() as ord, gen_random_uuid() as pay, gen_random_uuid() as bk,
               (select array_agg(id) from public.scheduled_trips where tenant_id = ${tenantId})
                 [1 + (g % 40)] as trip,
               -- Eight Crockford characters from the number, never a real reference's.
               (select string_agg(substr('0123456789ABCDEFGHJKMNPQRSTVWXYZ',
                                         1 + ((g / (32 ^ k)::bigint) % 32)::int, 1), '' order by k desc)
                  from generate_series(0, 7) k) as ref,
               (array['James','Mary','Luis','Ana','Wei','Fatima','John','Maria','David','Sarah',
                      'Ahmed','Priya','Carlos','Emma','Noah','Olivia','Liam','Sofia','Jean','Aiko'])
                 [1 + (g % 20)] || ' ' ||
               (array['Smith','Johnson','Garcia','Brown','Nguyen','Fernandez','Lee','Martin','Kim',
                      'Lopez','Patel','Wilson','Anderson','Taylor','Thomas','Moore','Jackson',
                      'White','Harris','Clark','Lewis','Robinson','Walker','Young','Allen'])
                 [1 + ((g * 7) % 25)] ||
               case when g % 9 = 0 then '-' || (array['Ortiz','Reyes','Cruz'])[1 + (g % 3)] else '' end
                 as name,
               'guest' || g || '@' ||
               (array['gmail.com','gmail.com','gmail.com','gmail.com','yahoo.com','outlook.com',
                      'icloud.com','hotmail.com','proton.me','divecenter.com'])[1 + (g % 10)]
                 as email
          from generate_series(1, ${N}) g`;
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
    await admin`analyze public.checkout_sessions`;
    await admin`analyze public.bookings`;
    await admin`analyze public.orders`;
    await admin`analyze public.payments`;
    console.log(`B_BENCH_LOAD ${JSON.stringify({ bookings: N, ms: Date.now() - started })}`);
  }, 600_000);

  afterAll(async () => {
    await runtime?.end();
    await admin?.end({ timeout: 5 });
  });

  interface Node {
    "Node Type": string;
    "Relation Name"?: string;
    "Index Name"?: string;
    "Actual Total Time"?: number;
    "Actual Rows"?: number;
    "Actual Loops"?: number;
    Plans?: Node[];
  }

  /** The slowest nodes of a plan, by their own total time, for the log. */
  function hotspots(root: Node): string[] {
    const all: Node[] = [];
    const walk = (n: Node) => {
      all.push(n);
      for (const c of n.Plans ?? []) walk(c);
    };
    walk(root);
    return all
      .map((n) => ({
        what: `${n["Node Type"]}${n["Relation Name"] ? ` ${n["Relation Name"]}` : ""}${n["Index Name"] ? ` (${n["Index Name"]})` : ""}`,
        ms: Math.round((n["Actual Total Time"] ?? 0) * (n["Actual Loops"] ?? 1)),
        rows: n["Actual Rows"] ?? 0,
        loops: n["Actual Loops"] ?? 1,
      }))
      .sort((a, b) => b.ms - a.ms)
      .slice(0, 6)
      .map((n) => `${n.what}: ${n.ms} ms, ${n.rows} rows x ${n.loops}`);
  }

  /**
   * Every statement searchBookings emits for `q`, captured through a plugin,
   * then each one EXPLAIN ANALYZEd as the runtime under the tenant's context.
   */
  async function explainRequest(q: string) {
    const captured: { sql: string; parameters: readonly unknown[] }[] = [];
    const db = runtime.db.withPlugin({
      transformQuery: (args) => {
        const compiled = runtime.db.getExecutor().compileQuery(args.node, args.queryId);
        if (/from bookings/.test(compiled.sql)) {
          captured.push({ sql: compiled.sql, parameters: compiled.parameters });
        }
        return args.node;
      },
      transformResult: async (args) => args.result,
    });
    await inTenantTransaction(
      db,
      guestContext(tenantId),
      (trx) => searchBookings(trx, tenantId, { q, limit: 25, withBooker: true }),
      snapshotRead,
    );
    const out: unknown[] = [];
    for (const statement of captured) {
      const result = await runtime.sql.begin(async (tx) => {
        await tx`select set_config('app.tenant_id', ${tenantId}, true)`;
        await tx`set local statement_timeout = '90s'`;
        const [row] = await tx.unsafe(
          `explain (analyze, buffers, format json) ${statement.sql}`,
          statement.parameters as never[],
        );
        return row?.["QUERY PLAN"] as { "Execution Time": number; Plan: Node }[];
      });
      const root = result?.[0];
      out.push({
        statement: statement.sql.includes("count(*)") ? "count" : "page",
        executionMs: root ? Math.round(root["Execution Time"]) : null,
        hot: root ? hotspots(root.Plan) : [],
      });
    }
    return out;
  }

  it("times the request for common and rare fragments, and explains each statement", async () => {
    const [{ n } = { n: 0 }] = await admin<{ n: number }[]>`
      select count(*)::int as n from public.bookings where tenant_id = ${tenantId}`;
    expect(n).toBeGreaterThanOrEqual(N);
    // "@g" takes the single statement (no trigram) and matches the same gmail
    // addresses as "gmail" in the arms, so the two shapes compare like for like.
    for (const q of ["@g", "gmail", "smith", "zyxwv"]) {
      console.log(
        `B_BENCH_EXPLAIN ${JSON.stringify({ q, shape: searchShape(q, true), statements: await explainRequest(q) })}`,
      );
    }
    for (const q of ["@g", "gmail", "smith", "zyxwv", "luis fernandez"]) {
      const times: number[] = [];
      let total = 0;
      for (let i = 0; i < 3; i++) {
        const t0 = performance.now();
        const found = await inTenantTransaction(
          runtime.db,
          guestContext(tenantId),
          async (trx) => {
            await sql`set local statement_timeout = '90s'`.execute(trx);
            return searchBookings(trx, tenantId, { q, limit: 25, withBooker: true });
          },
          snapshotRead,
        );
        times.push(Math.round(performance.now() - t0));
        if (found.kind === "ok") total = found.total;
      }
      console.log(
        `B_BENCH_REQUEST ${JSON.stringify({ q, shape: searchShape(q, true), total, ms: times })}`,
      );
    }
  }, 1_200_000);
});
