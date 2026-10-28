/**
 * Console booking search (pre-pilot hardening, item 5, Part B).
 *
 * B0 is a spike: can the runtime role, under forced row-level security, use a
 * trigram index on the booker's name at all? It runs on one admin connection
 * in one transaction that always rolls back, so nothing it creates outlives
 * it, and it logs what the planner chose (a line starting B0_SPIKE).
 *
 * B1 is the search rewrite: the same bookings, count, order, and pages as the
 * single condition it replaces, which this file keeps as a literal reference
 * query. Two tenants throughout.
 */

import {
  createDb,
  inTenantTransaction,
  snapshotRead,
  type TenantContext,
} from "@tidegrid/database";
import type {} from "@tidegrid/database/global-setup";
import { tripAllocator } from "@tidegrid/domain-inventory/testing";
import type { FakePaymentProvider } from "@tidegrid/domain-payments";
import { type RawBuilder, sql } from "kysely";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";
import { cancelBooking, previewCancellation } from "./cancel.ts";
import {
  emailFragment,
  escapeLike,
  nameWords,
  referencePrefix,
  searchBookings,
  searchShape,
} from "./search.ts";
import {
  type CheckoutFixture,
  confirmBooking,
  createCheckoutFixture,
  fakeProvider,
  guestContext,
} from "./test-fixtures.ts";

type Sql = ReturnType<typeof postgres>;

const env = inject("integrationDb");

interface PlanNode {
  "Node Type"?: string;
  "Index Name"?: string;
  Plans?: PlanNode[];
}

/** Every index a plan's nodes name. */
function indexesIn(plan: unknown): string[] {
  const out: string[] = [];
  const walk = (node: PlanNode) => {
    if (node["Index Name"]) out.push(node["Index Name"]);
    for (const child of node.Plans ?? []) walk(child);
  };
  const root = (plan as { Plan: PlanNode }[])[0]?.Plan;
  if (root) walk(root);
  return out;
}

const bookers = [
  { name: "Luis Fernández", email: "luis.fernandez@gmail.test" },
  { name: "Seán O'Brien", email: "sean.obrien@example.test" },
  { name: "Jean-Luc Picard", email: "jl@enterprise.test" },
  { name: "Ann_Lee 100%", email: "ann_lee%1@ex.test" },
  { name: "Back\\Slash Person", email: "back\\slash@ex.test" },
  { name: "jo smith", email: "jo.smith@gmail.test" },
  { name: "JO SMITHERS", email: "smithers@gmail.test" },
  { name: "Ada Lovelace", email: "ada@a.b.test" },
];

describe.skipIf(!env)("console booking search, B0 and B1", () => {
  let admin: Sql;
  let runtime: ReturnType<typeof createDb>;
  let provider: FakePaymentProvider;
  let A: CheckoutFixture;
  let B: CheckoutFixture;
  const references: string[] = [];

  /** The search as the console runs it: one read-only snapshot as the runtime role. */
  const search = (
    tenantId: string,
    q: string | undefined,
    withBooker: boolean,
    limit = 100,
    after?: string,
  ) =>
    inTenantTransaction(
      runtime.db,
      guestContext(tenantId),
      (trx) =>
        searchBookings(trx, tenantId, {
          ...(q === undefined ? {} : { q }),
          limit,
          ...(after === undefined ? {} : { after }),
          withBooker,
        }),
      snapshotRead,
    );

  /**
   * The search before B1, kept literally: one condition over the booking and
   * its checkout, every match ordered as the page orders them.
   */
  async function reference(tenantId: string, q: string, withBooker: boolean): Promise<string[]> {
    const parts: RawBuilder<unknown>[] = [];
    const prefix = referencePrefix(q);
    if (prefix) parts.push(sql`b.reference like ${`${prefix}%`}`);
    if (withBooker) {
      const words = nameWords(q).map(
        (word) => sql`s.booker_name ilike ${`%${escapeLike(word)}%`} escape '\\'`,
      );
      if (words.length > 0) parts.push(sql`(${sql.join(words, sql` and `)})`);
      const email = emailFragment(q);
      if (email) parts.push(sql`s.booker_email like ${`%${escapeLike(email)}%`} escape '\\'`);
    }
    const condition = parts.length === 0 ? sql`false` : sql`(${sql.join(parts, sql` or `)})`;
    const join = withBooker
      ? sql`join checkout_sessions s on s.tenant_id = b.tenant_id and s.id = b.checkout_session_id`
      : sql``;
    return inTenantTransaction(runtime.db, guestContext(tenantId), async (trx) => {
      const { rows } = await sql<{ id: string }>`
        select b.id from bookings b
          join scheduled_trips t on t.tenant_id = b.tenant_id and t.id = b.trip_id
          ${join}
         where b.tenant_id = ${tenantId} and ${condition}
         order by t.starts_at, t.id, b.confirmed_at, b.id`.execute(trx);
      return rows.map((r) => r.id);
    });
  }

  beforeAll(async () => {
    if (!env) return;
    admin = postgres(env.adminUrl, { max: 2, onnotice: () => {} });
    runtime = createDb(env.runtimeUrl, { max: 4 });
    provider = fakeProvider(runtime.db);
    A = await createCheckoutFixture(admin, runtime.db, "search-a", { days: 12 });
    B = await createCheckoutFixture(admin, runtime.db, "search-b", { days: 6 });
    const tripsA = tripAllocator(A);
    const tripsB = tripAllocator(B);
    for (const [i, booker] of bookers.entries()) {
      // Two bookings on some trips, so the order's ties fall to confirmation.
      const trip = i % 3 === 2 ? (A.trips.shared[0] ?? "") : tripsA.shared();
      const booked = await confirmBooking(runtime.db, provider, A, trip, 1, { booker });
      references.push(booked.reference);
    }
    // One of them canceled: search still finds it.
    const canceled = await confirmBooking(runtime.db, provider, A, tripsA.shared(), 1, {
      booker: { name: "Cancel Lation", email: "gone@gmail.test" },
    });
    references.push(canceled.reference);
    const ctx: TenantContext = guestContext(A.id);
    const terms = await inTenantTransaction(runtime.db, ctx, (trx) =>
      previewCancellation(trx, A.id, canceled.bookingId),
    );
    const result = await inTenantTransaction(runtime.db, ctx, (trx) =>
      cancelBooking(trx, ctx, {
        bookingId: canceled.bookingId,
        expectedRefundAmount: terms?.refundAmount ?? 0,
      }),
    );
    if (result.kind !== "canceled") throw new Error(`cancel: ${JSON.stringify(result)}`);
    // The other tenant has guests whose names and emails A's searches would match.
    for (const booker of [
      { name: "Luis Fernández", email: "luis.fernandez@gmail.test" },
      { name: "Zebulon Quixote", email: "zq@other.test" },
    ]) {
      await confirmBooking(runtime.db, provider, B, tripsB.shared(), 1, { booker });
    }
  });

  afterAll(async () => {
    await runtime?.end();
    await admin?.end({ timeout: 5 });
  });

  it("B0: shows whether the runtime can use a trigram index under row-level security", async () => {
    const rollback = new Error("always roll back");
    const spike: Record<string, unknown> = {};
    await expect(
      admin.begin(async (tx) => {
        spike.leakproof = Object.fromEntries(
          (
            await tx<{ proname: string; proleakproof: boolean }[]>`
              select proname, proleakproof from pg_proc
               where proname in ('textlike', 'texticlike', 'texteq', 'uuid_eq')
               order by proname`
          ).map((r) => [r.proname, r.proleakproof]),
        );
        await tx`create extension if not exists pg_trgm with schema public`;
        await tx`create index b0_spike_booker_name_trgm on public.checkout_sessions
                   using gin (booker_name public.gin_trgm_ops)`;
        await tx`analyze public.checkout_sessions`;
        const [built] = await tx<{ n: number }[]>`
          select count(*)::int as n from pg_class where relname = 'b0_spike_booker_name_trgm'`;
        expect(built?.n).toBe(1);
        await tx`set local enable_seqscan = off`;
        const query = `select s.id from public.checkout_sessions s
                        where s.tenant_id = $1 and s.booker_name ilike $2`;
        const explain = async (label: string) => {
          const [row] = await tx.unsafe(`explain (format json) ${query}`, [A.id, "%ern%"]);
          spike[label] = indexesIn(row?.["QUERY PLAN"]);
        };
        // Control: the owner bypasses row-level security, so it may use the index.
        await explain("adminCustom");
        // The runtime role, under forced row-level security, in the same transaction.
        await tx`set local role tidegrid_app`;
        await tx`select set_config('app.tenant_id', ${A.id}, true)`;
        const [visible] = await tx<{ n: number }[]>`
          select count(*)::int as n from pg_class where relname = 'b0_spike_booker_name_trgm'`;
        spike.indexVisibleToRuntime = visible?.n === 1;
        await explain("runtimeCustom");
        // And under a generic plan, as postgres.js's prepared statements can get.
        await tx.unsafe(`prepare b0_spike(uuid, text) as ${query}`);
        await tx`set local plan_cache_mode = force_generic_plan`;
        const [generic] = await tx.unsafe(
          `explain (format json) execute b0_spike('${A.id}', '%ern%')`,
        );
        spike.runtimeGeneric = indexesIn(generic?.["QUERY PLAN"]);
        // A name-only query without the tenant filter, so only the trigram index could serve it.
        const [bare] = await tx.unsafe(
          `explain (format json) select s.id from public.checkout_sessions s where s.booker_name ilike '%ern%'`,
        );
        spike.runtimeNoTenantFilter = indexesIn(bare?.["QUERY PLAN"]);
        throw rollback;
      }),
    ).rejects.toBe(rollback);
    console.log(`B0_SPIKE ${JSON.stringify(spike)}`);
    expect(spike.adminCustom).toContain("b0_spike_booker_name_trgm");
    expect(spike.indexVisibleToRuntime).toBe(true);
    // Nothing persists.
    const [left] = await admin<{ n: number }[]>`
      select count(*)::int as n from pg_class where relname = 'b0_spike_booker_name_trgm'`;
    expect(left?.n).toBe(0);
    const [ext] = await admin<{ n: number }[]>`
      select count(*)::int as n from pg_extension where extname = 'pg_trgm'`;
    expect(ext?.n).toBe(0);
  });

  const texts = [
    // Case, words, and the name or the email.
    "fernández",
    "FERNANDEZ",
    "Luis Fernández",
    "luis fern",
    "smith",
    "SMITH",
    "jo smith",
    "Jo Smithers",
    "jo",
    "j",
    "ann_lee",
    "ann_",
    "100%",
    "%1@",
    "back\\slash",
    "\\",
    "_",
    "o'brien",
    "O'B",
    "J-L",
    "Jean-Luc",
    "a.b",
    "@gm",
    "gmail",
    "gmail.test",
    "@ex.test",
    "lovelace ada",
    "one two three four five six seven",
    "Luis Fernández Luis Fernández Luis Fernández",
    "Cancel",
    "gone@gmail",
    "nobody",
  ];

  it("B1: returns the same bookings, in the same order, as the single condition", async () => {
    const reads = [
      ...texts,
      // References: a prefix of two and of eight, typed with spaces, hyphens, and lookalikes.
      ...references.flatMap((r) => [
        r.slice(0, 2),
        r.slice(0, 8),
        `${r.slice(0, 4)} ${r.slice(4, 6)}`,
        `${r.slice(0, 4).toLowerCase()}-${r.slice(4, 6).toLowerCase()}`,
        r.slice(0, 6).replace(/0/g, "O").replace(/1/g, "l"),
      ]),
    ];
    let arms = 0;
    for (const q of reads) {
      for (const withBooker of [true, false]) {
        if (searchShape(q, withBooker) === "arms") arms += 1;
        const expected = await reference(A.id, q, withBooker);
        const found = await search(A.id, q, withBooker);
        if (found.kind !== "ok") throw new Error(`search: ${found.kind}`);
        expect({ q, withBooker, ids: found.results.map((r) => r.id), total: found.total }).toEqual({
          q,
          withBooker,
          ids: expected,
          total: expected.length,
        });
        expect(found.matchedOn).toEqual(
          withBooker ? ["reference", "booker_name", "booker_email"] : ["reference"],
        );
      }
    }
    // Most texts take the rewritten shape for staff, so the comparison is not vacuous.
    expect(arms).toBeGreaterThan(reads.length / 2);
    // Something matched, and the canceled booking is among the matches.
    expect((await reference(A.id, "gmail", true)).length).toBeGreaterThanOrEqual(4);
    const cancel = await search(A.id, "Cancel", true);
    expect(cancel.kind === "ok" && cancel.results.map((r) => r.state)).toEqual(["canceled"]);
  });

  it("B1: pages across a cursor exactly as the single condition orders them", async () => {
    for (const q of ["gmail", "test", "smith"]) {
      const expected = await reference(A.id, q, true);
      const seen: string[] = [];
      let after: string | undefined;
      for (let page = 0; page < 20; page++) {
        const found = await search(A.id, q, true, 2, after);
        if (found.kind !== "ok") throw new Error(`search: ${found.kind}`);
        expect(found.total).toBe(expected.length);
        seen.push(...found.results.map((r) => r.id));
        if (!found.nextAfter) break;
        after = found.nextAfter;
      }
      expect({ q, seen }).toEqual({ q, seen: expected });
    }
    // A cursor from another search's results is refused, in either shape.
    const other = await reference(A.id, "lovelace", true);
    const refused = await search(A.id, "gmail", true, 2, other[0]);
    expect(refused.kind).toBe("cursor_invalid");
  });

  it("B1: never returns another tenant's booking by name, email, or reference", async () => {
    const own = await search(B.id, "Quixote", true);
    expect(own.kind === "ok" && own.total).toBe(1);
    for (const q of ["Quixote", "zq@other", "other.test"]) {
      const found = await search(A.id, q, true);
      expect({ q, found: found.kind === "ok" ? found.total : found.kind }).toEqual({ q, found: 0 });
    }
    // The same name in both tenants: each sees its own only.
    const inA = await search(A.id, "Fernández", true);
    const inB = await search(B.id, "Fernández", true);
    const idsA = inA.kind === "ok" ? inA.results.map((r) => r.id) : [];
    const idsB = inB.kind === "ok" ? inB.results.map((r) => r.id) : [];
    expect(idsA).toHaveLength(1);
    expect(idsB).toHaveLength(1);
    expect(idsA).not.toEqual(idsB);
    // A's references, searched from B.
    for (const r of references) {
      const found = await search(B.id, r, true);
      expect(found.kind === "ok" && found.results.map((x) => x.reference)).not.toContain(r);
    }
  });
});
