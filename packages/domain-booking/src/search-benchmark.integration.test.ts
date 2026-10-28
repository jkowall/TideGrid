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
const on = process.env.TIDEGRID_SEARCH_BENCH === "1";
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

const percentile = (xs: number[], p: number) => {
  const sorted = [...xs].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))] ?? 0;
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

  it("times the request for common and rare fragments", async () => {
    const [{ n } = { n: 0 }] = await admin<{ n: number }[]>`
      select count(*)::int as n from public.bookings where tenant_id = ${tenantId}`;
    expect(n).toBeGreaterThanOrEqual(N);
    const texts = [
      "gmail",
      "com",
      "smith",
      "garcia",
      "luis fernandez",
      "zyxwv",
      "guest4242",
      "7K3M",
    ];
    const results: Record<string, unknown> = {};
    for (const q of texts) {
      const times: number[] = [];
      let total = 0;
      for (let i = 0; i < 12; i++) {
        const t0 = performance.now();
        const found = await inTenantTransaction(
          runtime.db,
          guestContext(tenantId),
          (trx) => searchBookings(trx, tenantId, { q, limit: 25, withBooker: true }),
          snapshotRead,
        );
        times.push(performance.now() - t0);
        if (found.kind === "ok") total = found.total;
      }
      // The first two warm the caches and the plan.
      const warm = times.slice(2);
      results[q] = {
        shape: searchShape(q, true),
        total,
        p50: Math.round(percentile(warm, 50)),
        p95: Math.round(percentile(warm, 95)),
      };
    }
    // The count statement's plan for the commonest fragment, as the runtime.
    const plan = await inTenantTransaction(runtime.db, guestContext(tenantId), async (trx) => {
      const { rows } = await sql<{ "QUERY PLAN": unknown }>`
        explain (analyze, buffers, format json)
        select count(*) from bookings b
          join scheduled_trips t on t.tenant_id = b.tenant_id and t.id = b.trip_id
          join checkout_sessions s on s.tenant_id = b.tenant_id and s.id = b.checkout_session_id
         where b.tenant_id = ${tenantId}
           and b.id in (select nb.id from checkout_sessions ns
                          join bookings nb on nb.tenant_id = ns.tenant_id and nb.checkout_session_id = ns.id
                         where ns.tenant_id = ${tenantId} and ns.booker_name ilike '%smith%'
                        union
                        select eb.id from checkout_sessions es
                          join bookings eb on eb.tenant_id = es.tenant_id and eb.checkout_session_id = es.id
                         where es.tenant_id = ${tenantId} and es.booker_email like '%smith%')`.execute(
        trx,
      );
      const plans = rows[0]?.["QUERY PLAN"] as { "Execution Time": number }[] | undefined;
      const root = plans?.[0];
      return { executionMs: root?.["Execution Time"] };
    });
    console.log(`B_BENCH ${JSON.stringify({ bookings: N, results, countPlan: plan })}`);
  }, 600_000);
});
