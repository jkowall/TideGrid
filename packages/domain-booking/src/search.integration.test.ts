/**
 * Console booking search (pre-pilot hardening, item 5, Part B).
 *
 * B0: can the runtime role, under forced row-level security, use a trigram
 * index on the booker's name at all? It runs on one admin connection in one
 * transaction that always rolls back, so nothing it creates outlives it, and
 * it logs what the planner chose (a line starting B0_SPIKE). On PostgreSQL 17
 * it cannot: LIKE and ILIKE are not leakproof, so the planner keeps them
 * above the tenant policy and never uses the index for them (D4 B, pg_trgm
 * deferred). The test asserts that, so a change in the planner shows up here.
 *
 * The search gate: search returns the same bookings, count, order, and pages
 * as its condition kept here as a literal reference query, across the cases
 * an index or a rewrite would have to keep (B1). It also returns the same
 * whole outcome, every field of every row, the count, the cursor, and the
 * refusals, as the b6d0247 search kept literally in search-baseline.testing.ts,
 * across every text arm, date ranges, limits, paging to the end, ties at every
 * level of the order, canceled and staff-assisted bookings, and both roles.
 * Any later search change must pass it. Two tenants throughout.
 *
 * The plan test: as the runtime, under custom and generic plans, the page's
 * one Limit over the matching bookings reads only the matching tables, and no
 * detail join sits under it. Finance's statements never name the checkout,
 * and every join names its tenant.
 */

import { randomUUID } from "node:crypto";
import {
  createDb,
  inTenantTransaction,
  snapshotRead,
  type TenantContext,
} from "@tidegrid/database";
import type {} from "@tidegrid/database/global-setup";
import { tripAllocator } from "@tidegrid/domain-inventory/testing";
import { FAKE_MINIMUM_AMOUNT, type FakePaymentProvider } from "@tidegrid/domain-payments";
import { createQuote } from "@tidegrid/domain-pricing";
import { CompiledQuery, type RawBuilder, sql } from "kysely";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";
import { cancelBooking, previewCancellation } from "./cancel.ts";
import { ensureProviderPayment } from "./checkout.ts";
import { handleVerifiedEvent } from "./finalize.ts";
import {
  type BookingSearchOutcome,
  type BookingSearchQuery,
  emailFragment,
  escapeLike,
  nameWords,
  referencePrefix,
  searchBookings,
} from "./search.ts";
import { baselineSearch } from "./search-baseline.testing.ts";
import { openStaffCheckout } from "./staff-checkout.ts";
import {
  type CheckoutFixture,
  confirmBooking,
  createCheckoutFixture,
  fakeProvider,
  guestContext,
  verifiedFakeEvent,
} from "./test-fixtures.ts";

type Sql = ReturnType<typeof postgres>;

const env = inject("integrationDb");

interface PlanNode {
  "Node Type"?: string;
  "Index Name"?: string;
  "Relation Name"?: string;
  Alias?: string;
  Plans?: PlanNode[];
}

/** A node and every node under it. */
function subtree(node: PlanNode): PlanNode[] {
  return [node, ...(node.Plans ?? []).flatMap(subtree)];
}

/** The page's detail aliases: none may sit under the Limit that picks its bookings. */
const detailAliases = ["b1", "t1", "s1", "p", "bt", "o", "pay", "r1"];

/**
 * The Limit over the matching bookings (alias b): how many there are, which
 * tables it reads, and which detail aliases sit under it.
 */
function matchingLimit(plan: PlanNode) {
  const limits = subtree(plan).filter(
    (n) => n["Node Type"] === "Limit" && subtree(n).some((c) => c.Alias === "b"),
  );
  const under = limits.length === 1 && limits[0] ? subtree(limits[0]) : [];
  return {
    limits: limits.length,
    relations: [...new Set(under.flatMap((n) => n["Relation Name"] ?? []))].sort(),
    detailAliases: under.flatMap((n) =>
      n.Alias && detailAliases.includes(n.Alias) ? n.Alias : [],
    ),
  };
}

/** Joins and scans in a statement's text that do not name their alias's tenant. */
function untenanted(text: string): { joins: number; problems: string[] } {
  const problems: string[] = [];
  let joins = 0;
  for (const m of text.matchAll(/\bjoin\s+(?!lateral\b)(\w+)\s+(\w+)\s+on\s+(\S+)/g)) {
    joins++;
    if (m[3] !== `${m[2]}.tenant_id`) problems.push(m[0]);
  }
  for (const m of text.matchAll(/\bfrom\s+(\w+)\s+(\w+)\b/g)) {
    if (!text.includes(`${m[2]}.tenant_id = `)) problems.push(m[0]);
  }
  return { joins, problems };
}

/** A captured parameter as a SQL literal, for EXECUTE under a generic plan. */
function literal(value: unknown): string {
  if (typeof value === "number" && Number.isInteger(value)) return String(value);
  if (typeof value === "string") return `'${value.replace(/'/g, "''")}'`;
  throw new TypeError(`no literal for ${typeof value}`);
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

describe.skipIf(!env)("console booking search: the trigram spike and the result gate", () => {
  let admin: Sql;
  let runtime: ReturnType<typeof createDb>;
  let provider: FakePaymentProvider;
  let A: CheckoutFixture;
  let B: CheckoutFixture;
  const references: string[] = [];
  /** A's bookings by booker, in the order they were made; B's booking ids. */
  const idsA: Record<string, string> = {};
  const idsB: string[] = [];
  /** Local departure dates of A's shared trips 0 and 3, and of A's last trip. */
  const days = { first: "", fourth: "", last: "" };
  const refs = { canceled: "", staff: "" };

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
   * The search's condition, kept literally: one condition over the booking and
   * its checkout, every match ordered as the page orders them. Dates, when
   * given, bound the trip's local date.
   */
  async function reference(
    tenantId: string,
    q: string | undefined,
    withBooker: boolean,
    dates: { from?: string; to?: string } = {},
  ): Promise<string[]> {
    const conditions: RawBuilder<unknown>[] = [sql`b.tenant_id = ${tenantId}`];
    if (dates.from !== undefined) conditions.push(sql`t.local_date >= ${dates.from}::date`);
    if (dates.to !== undefined) conditions.push(sql`t.local_date <= ${dates.to}::date`);
    if (q !== undefined) {
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
      conditions.push(parts.length === 0 ? sql`false` : sql`(${sql.join(parts, sql` or `)})`);
    }
    const join = withBooker
      ? sql`join checkout_sessions s on s.tenant_id = b.tenant_id and s.id = b.checkout_session_id`
      : sql``;
    return inTenantTransaction(runtime.db, guestContext(tenantId), async (trx) => {
      const { rows } = await sql<{ id: string }>`
        select b.id from bookings b
          join scheduled_trips t on t.tenant_id = b.tenant_id and t.id = b.trip_id
          ${join}
         where ${sql.join(conditions, sql` and `)}
         order by t.starts_at, t.id, b.confirmed_at, b.id`.execute(trx);
      return rows.map((r) => r.id);
    });
  }

  /**
   * One query through the b6d0247 search and through today's, in one
   * snapshot as the runtime role. Every field of the two outcomes must agree.
   */
  async function same(tenantId: string, query: BookingSearchQuery): Promise<BookingSearchOutcome> {
    const [before, after] = await inTenantTransaction(
      runtime.db,
      guestContext(tenantId),
      async (trx) => [
        await baselineSearch(trx, tenantId, query),
        await searchBookings(trx, tenantId, query),
      ],
      snapshotRead,
    );
    expect({ query, outcome: after }).toStrictEqual({ query, outcome: before });
    if (!after) throw new Error("no outcome");
    return after;
  }

  /** Every page of a search, each one checked by `same`, until nextAfter is null. */
  async function pageThrough(
    tenantId: string,
    query: Omit<BookingSearchQuery, "after">,
  ): Promise<{ ids: string[]; total: number; pages: number }> {
    const ids: string[] = [];
    let total: number | undefined;
    let after: string | undefined;
    for (let pages = 1; pages <= 200; pages++) {
      const found = await same(tenantId, { ...query, ...(after === undefined ? {} : { after }) });
      if (found.kind !== "ok") throw new Error(`page ${pages}: ${found.kind}`);
      total ??= found.total;
      expect(found.total).toBe(total);
      ids.push(...found.results.map((r) => r.id));
      if (!found.nextAfter) return { ids, total, pages };
      expect(found.results).toHaveLength(query.limit);
      expect(found.nextAfter).toBe(found.results.at(-1)?.id);
      after = found.nextAfter;
    }
    throw new Error("more than 200 pages");
  }

  /** A booking made at the desk by booking staff (G2.12d), paid through the fake provider. */
  async function staffAssisted(
    tenant: CheckoutFixture,
    tripId: string,
    booker: { name: string; email: string },
  ): Promise<string> {
    const userId = randomUUID();
    await admin`insert into public.staff_users (id, email, display_name)
      values (${userId}, ${`search-${userId.slice(0, 8)}@example.test`}, 'Desk')`;
    await admin`insert into public.tenant_memberships (tenant_id, user_id, role, display_name)
      values (${tenant.id}, ${userId}, 'booking_staff', 'Dee Desk')`;
    const ctx: TenantContext = {
      tenantId: tenant.id,
      actorType: "staff",
      actorId: userId,
      requestId: `req-${randomUUID()}`,
      sourceIp: null,
    };
    const quote = await inTenantTransaction(runtime.db, ctx, (trx) =>
      createQuote(trx, ctx, {
        tripId,
        party: { kind: "tickets", tickets: [{ code: "adult", quantity: 1 }] },
        addOns: [],
        promotionCode: null,
        now: new Date(),
      }),
    );
    if (quote.kind !== "created") throw new Error(`staff quote: ${JSON.stringify(quote)}`);
    const created = await inTenantTransaction(runtime.db, ctx, (trx) =>
      openStaffCheckout(trx, ctx, {
        quoteId: quote.quote.quoteId,
        acceptedPolicyVersion: quote.quote.policy.version,
        booker,
        channel: "walk_up",
        attestations: { policyToldToGuest: true, emailReadBack: true },
        provider: "fake",
        minimumAmount: FAKE_MINIMUM_AMOUNT,
      }),
    );
    if (created.kind !== "created") throw new Error(`staff checkout: ${JSON.stringify(created)}`);
    const ready = await ensureProviderPayment(runtime.db, provider, ctx, created.session.id);
    if (ready.kind !== "ready") throw new Error(`payment: ${JSON.stringify(ready)}`);
    const settled = await provider.settlePayment(
      tenant.id,
      ready.paymentRef,
      "succeeded",
      Date.now(),
    );
    if (settled.kind === "not_found") throw new Error("no fake payment");
    const event = await verifiedFakeEvent(provider, settled.event.body);
    const handled = await handleVerifiedEvent(runtime.db, provider, event, {
      requestId: `wh-${randomUUID()}`,
    });
    if (handled.kind !== "processed" || !handled.outcome.startsWith("confirmed")) {
      throw new Error(`confirmation: ${JSON.stringify(handled)}`);
    }
    const [row] = await admin<{ id: string; reference: string; source: string }[]>`
      select id, reference, source from public.bookings
       where tenant_id = ${tenant.id} and checkout_session_id = ${created.session.id}`;
    if (row?.source !== "staff_assisted") throw new Error(`staff booking: ${JSON.stringify(row)}`);
    return row.reference;
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
      idsA[booker.name] = booked.bookingId;
    }
    // A charter on the first day departs at the same instant as the shared
    // trip that day, on another boat, so the order falls to the trip's id.
    const tie = await confirmBooking(runtime.db, provider, A, A.trips.charter[0] ?? "", 2, {
      charter: true,
      booker: { name: "Tie Charter", email: "tie.charter@gmail.test" },
    });
    references.push(tie.reference);
    // A booking made at the desk (staff_assisted).
    refs.staff = await staffAssisted(A, tripsA.shared(), {
      name: "Walkup Desk",
      email: "walkup@gmail.test",
    });
    references.push(refs.staff);
    // One of them canceled: search still finds it.
    const canceled = await confirmBooking(runtime.db, provider, A, tripsA.shared(), 1, {
      booker: { name: "Cancel Lation", email: "gone@gmail.test" },
    });
    references.push(canceled.reference);
    refs.canceled = canceled.reference;
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
      idsB.push(
        (await confirmBooking(runtime.db, provider, B, tripsB.shared(), 1, { booker })).bookingId,
      );
    }
    // Synthetic, throwaway database only: two bookings on the first shared
    // trip get the same confirmation instant, so the order falls to the
    // booking's id. Each fixture booking confirms in its own transaction, so
    // no real tie reaches that column. Triggers are off for this one update.
    await admin.begin(async (tx) => {
      await tx`set local session_replication_role = replica`;
      const tied = await tx`
        update public.bookings
           set confirmed_at = (select confirmed_at from public.bookings
                                where id = ${idsA["Luis Fernández"] ?? ""})
         where tenant_id = ${A.id} and id = ${idsA["JO SMITHERS"] ?? ""}
        returning id`;
      if (tied.length !== 1) throw new Error("no booking to tie");
    });
    const tripDays = await admin<{ id: string; day: string }[]>`
      select id, local_date::text as day from public.scheduled_trips where tenant_id = ${A.id}`;
    const dayOf = (tripId: string | undefined) => tripDays.find((t) => t.id === tripId)?.day ?? "";
    days.first = dayOf(A.trips.shared[0]);
    days.fourth = dayOf(A.trips.shared[3]);
    days.last =
      tripDays
        .map((t) => t.day)
        .sort()
        .at(-1) ?? "";
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
    // The runtime, under forced row-level security, never uses it: the reason
    // pg_trgm is deferred (D4 B). If this starts failing, revisit D4.
    expect(spike.leakproof).toMatchObject({ textlike: false, texticlike: false });
    for (const plan of ["runtimeCustom", "runtimeGeneric", "runtimeNoTenantFilter"]) {
      const indexes = spike[plan] as string[];
      expect(Array.isArray(indexes)).toBe(true);
      expect({ plan, trigram: indexes.includes("b0_spike_booker_name_trgm") }).toEqual({
        plan,
        trigram: false,
      });
    }
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

  it("returns the same bookings, in the same order, as the reference condition", async () => {
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
    for (const q of reads) {
      for (const withBooker of [true, false]) {
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
    // Something matched, and the canceled booking is among the matches.
    expect((await reference(A.id, "gmail", true)).length).toBeGreaterThanOrEqual(4);
    const cancel = await search(A.id, "Cancel", true);
    expect(cancel.kind === "ok" && cancel.results.map((r) => r.state)).toEqual(["canceled"]);
  });

  it("pages across a cursor exactly as the reference condition orders them", async () => {
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

  /** Every text the id-level gate reads, with the reference variants. */
  const reads = () => [
    ...texts,
    ...references.flatMap((r) => [
      r.slice(0, 2),
      r.slice(0, 8),
      `${r.slice(0, 4)} ${r.slice(4, 6)}`,
      `${r.slice(0, 4).toLowerCase()}-${r.slice(4, 6).toLowerCase()}`,
      r.slice(0, 6).replace(/0/g, "O").replace(/1/g, "l"),
    ]),
    // A reference with name words: prefix 7K3M9P, words 7K3M and 9P.
    "7K3M 9P",
    // Reference (ADA), name, and email arms at once.
    "ada",
  ];

  it("returns the b6d0247 search's whole outcome for every arm, role, and limit", async () => {
    for (const q of reads()) {
      for (const withBooker of [true, false]) {
        for (const limit of [1, 2, 25, 100]) {
          await same(A.id, { q, limit, withBooker });
        }
      }
    }
  });

  it("returns the b6d0247 search's whole outcome for dates, alone and with text", async () => {
    const ranges: { from?: string; to?: string }[] = [
      { from: days.fourth },
      { to: days.fourth },
      { from: days.first, to: days.first },
      { from: days.first, to: days.last },
      // No trips in the range, and a range that ends before it starts.
      { from: "2099-01-01", to: "2099-01-31" },
      { from: days.fourth, to: days.first },
    ];
    for (const range of ranges) {
      for (const q of [undefined, "gmail", "smith", "test", references[0]?.slice(0, 4)]) {
        for (const withBooker of [true, false]) {
          const expected = await reference(A.id, q, withBooker, range);
          for (const limit of [1, 2, 25, 100]) {
            const found = await same(A.id, {
              ...(q === undefined ? {} : { q }),
              ...range,
              limit,
              withBooker,
            });
            if (found.kind !== "ok") throw new Error(`search: ${found.kind}`);
            expect({ range, q, withBooker, ids: found.results.map((r) => r.id) }).toEqual({
              range,
              q,
              withBooker,
              ids: expected.slice(0, limit),
            });
            expect(found.total).toBe(expected.length);
          }
        }
      }
    }
    // The first day holds the shared trip's three bookings and the charter's one.
    expect(
      await reference(A.id, undefined, true, { from: days.first, to: days.first }),
    ).toHaveLength(4);
    expect(await reference(A.id, undefined, true, { from: "2099-01-01" })).toEqual([]);
  });

  it("pages to the end exactly as the b6d0247 search and the reference condition do", async () => {
    const searches: { q?: string; from?: string; to?: string; withBooker: boolean }[] = [
      { q: "gmail", withBooker: true },
      { q: "test", withBooker: true },
      { q: "smith", withBooker: true },
      { from: days.first, withBooker: true },
      { from: days.first, withBooker: false },
      { to: days.last, withBooker: false },
      { q: "test", withBooker: false },
      { q: "gmail", from: days.first, to: days.fourth, withBooker: true },
    ];
    for (const { withBooker, ...rest } of searches) {
      const expected = await reference(A.id, rest.q, withBooker, rest);
      for (const limit of [1, 2]) {
        const paged = await pageThrough(A.id, { ...rest, limit, withBooker });
        expect({ ...rest, withBooker, limit, ids: paged.ids, total: paged.total }).toEqual({
          ...rest,
          withBooker,
          limit,
          ids: expected,
          total: expected.length,
        });
      }
    }
    // Finance pages every booking by date alone.
    expect((await reference(A.id, undefined, false, { from: days.first })).length).toBeGreaterThan(
      10,
    );
    // A cursor at the very last match: an empty page, no next cursor, the same total.
    const all = await reference(A.id, "gmail", true);
    const last = await same(A.id, {
      q: "gmail",
      limit: 2,
      after: all.at(-1) ?? "",
      withBooker: true,
    });
    expect(last).toStrictEqual({
      kind: "ok",
      results: [],
      total: all.length,
      nextAfter: null,
      matchedOn: ["reference", "booker_name", "booker_email"],
    });
  });

  it("refuses the same cursors as the b6d0247 search", async () => {
    const lovelace = idsA["Ada Lovelace"] ?? "";
    const firstDay = idsA["Luis Fernández"] ?? "";
    const refused: { query: BookingSearchQuery; why: string }[] = [
      { why: "not a uuid", query: { q: "gmail", limit: 2, after: "not-a-uuid", withBooker: true } },
      {
        why: "not a uuid",
        query: { q: "gmail", limit: 2, after: "not-a-uuid", withBooker: false },
      },
      {
        why: "another search's booking",
        query: { q: "gmail", limit: 2, after: lovelace, withBooker: true },
      },
      {
        why: "another tenant's booking",
        query: { q: "Fernández", limit: 2, after: idsB[0] ?? "", withBooker: true },
      },
      {
        why: "outside the dates",
        query: { from: days.fourth, limit: 2, after: firstDay, withBooker: true },
      },
      {
        why: "outside the dates",
        query: { from: days.fourth, limit: 2, after: firstDay, withBooker: false },
      },
      // Staff find Ada by name; finance reads "Lovelace" as a reference prefix, which matches nothing.
      {
        why: "a name finance cannot match",
        query: { q: "Lovelace", limit: 2, after: lovelace, withBooker: false },
      },
    ];
    for (const { query, why } of refused) {
      expect({ why, outcome: await same(A.id, query) }).toEqual({
        why,
        outcome: { kind: "cursor_invalid" },
      });
    }
    const staff = await same(A.id, { q: "Lovelace", limit: 2, after: lovelace, withBooker: true });
    expect(staff.kind === "ok" && staff.total).toBe(1);
  });

  it("returns canceled and staff-assisted bookings, and ties at every level of the order, alike", async () => {
    // The canceled booking carries its refund, for both roles.
    for (const [q, withBooker] of [
      ["Cancel", true],
      [refs.canceled, false],
    ] as const) {
      const found = await same(A.id, { q, limit: 25, withBooker });
      if (found.kind !== "ok") throw new Error(`search: ${found.kind}`);
      expect(found.results.map((r) => r.state)).toEqual(["canceled"]);
      expect(found.results[0]?.payment.refund?.amount).toBeGreaterThan(0);
    }
    // The desk's booking says where it came from, for both roles.
    for (const [q, withBooker] of [
      ["walkup", true],
      [refs.staff, false],
    ] as const) {
      const found = await same(A.id, { q, limit: 25, withBooker });
      expect(found.kind === "ok" && found.results.map((r) => r.source)).toEqual(["staff_assisted"]);
    }
    // "gmail" crosses both ties: two trips at one instant, and two bookings confirmed at one instant.
    const found = await same(A.id, { q: "gmail", limit: 100, withBooker: true });
    if (found.kind !== "ok") throw new Error(`search: ${found.kind}`);
    const pairs = found.results.slice(1).map((r, i) => [found.results[i], r] as const);
    expect(
      pairs.some(
        ([a, b]) => a?.trip.startsAt === b.trip.startsAt && a.trip.tripId !== b.trip.tripId,
      ),
    ).toBe(true);
    expect(
      pairs.some(([a, b]) => a?.trip.tripId === b.trip.tripId && a.confirmedAt === b.confirmedAt),
    ).toBe(true);
    // Page across both ties one booking at a time.
    const paged = await pageThrough(A.id, { q: "gmail", limit: 1, withBooker: true });
    expect(paged.ids).toEqual(found.results.map((r) => r.id));
  });

  /** Every statement one search emits, as compiled, with its parameters. */
  async function capture(tenantId: string, query: BookingSearchQuery) {
    const captured: { sql: string; parameters: readonly unknown[] }[] = [];
    const db = runtime.db.withPlugin({
      transformQuery: (args) => {
        const compiled = runtime.db.getExecutor().compileQuery(args.node, args.queryId);
        captured.push({ sql: compiled.sql, parameters: compiled.parameters });
        return args.node;
      },
      transformResult: async (args) => args.result,
    });
    const found = await inTenantTransaction(
      db,
      guestContext(tenantId),
      (trx) => searchBookings(trx, tenantId, query),
      snapshotRead,
    );
    return { found, captured };
  }

  let planSeq = 0;

  /**
   * One captured statement's plan as the runtime under the tenant's context:
   * custom, with the values bound, or generic, through PREPARE and EXECUTE
   * with plan_cache_mode forced.
   */
  function planOf(
    tenantId: string,
    statement: { sql: string; parameters: readonly unknown[] },
    mode: "custom" | "generic",
  ): Promise<PlanNode> {
    type Row = { "QUERY PLAN": { Plan: PlanNode }[] };
    return inTenantTransaction(runtime.db, guestContext(tenantId), async (trx) => {
      let rows: Row[];
      if (mode === "custom") {
        ({ rows } = await trx.executeQuery<Row>(
          CompiledQuery.raw(`explain (format json) ${statement.sql}`, [...statement.parameters]),
        ));
      } else {
        const name = `search_plan_${++planSeq}`;
        await trx.executeQuery(CompiledQuery.raw(`prepare ${name} as ${statement.sql}`, []));
        await sql`set local plan_cache_mode = force_generic_plan`.execute(trx);
        ({ rows } = await trx.executeQuery<Row>(
          CompiledQuery.raw(
            `explain (format json) execute ${name}(${statement.parameters.map(literal).join(", ")})`,
            [],
          ),
        ));
        await trx.executeQuery(CompiledQuery.raw(`deallocate ${name}`, []));
      }
      const plan = rows[0]?.["QUERY PLAN"][0]?.Plan;
      if (!plan) throw new Error("no plan");
      return plan;
    });
  }

  it("limits the matching bookings before any detail join, in custom and generic plans", async () => {
    const gmail = await reference(A.id, "gmail", true);
    const everyDay = await reference(A.id, undefined, false, { from: days.first });
    const prefix = references[0]?.slice(0, 4) ?? "";
    const queries: BookingSearchQuery[] = [
      { q: "gmail", limit: 2, withBooker: true },
      { q: "gmail", limit: 1, after: gmail[0] ?? "", withBooker: true },
      { from: days.first, limit: 25, withBooker: true },
      { q: prefix, limit: 25, withBooker: false },
      { from: days.first, limit: 2, withBooker: false },
      { from: days.first, limit: 1, after: everyDay[0] ?? "", withBooker: false },
    ];
    for (const query of queries) {
      const { found, captured } = await capture(A.id, query);
      // A fragment that matches, so the planner cannot fold the page away.
      expect(found.kind === "ok" && found.total).toBeGreaterThan(0);
      const search = captured.filter((s) => /from bookings b\b/.test(s.sql));
      expect(search).toHaveLength(query.after === undefined ? 2 : 3);
      // Finance never names the checkout, in any statement, with or without a cursor.
      if (!query.withBooker) {
        expect(captured.filter((s) => s.sql.includes("checkout_sessions"))).toEqual([]);
      }
      for (const statement of search) {
        const named = untenanted(statement.sql);
        expect({ query, problems: named.problems }).toEqual({ query, problems: [] });
        expect(named.joins).toBeGreaterThan(0);
      }
      const page = search.filter((s) => s.sql.includes("order by"));
      expect(page).toHaveLength(1);
      for (const mode of ["custom", "generic"] as const) {
        const plan = await planOf(A.id, page[0] ?? { sql: "", parameters: [] }, mode);
        expect({ query, mode, ...matchingLimit(plan) }).toEqual({
          query,
          mode,
          limits: 1,
          relations: query.withBooker
            ? ["bookings", "checkout_sessions", "scheduled_trips"]
            : ["bookings", "scheduled_trips"],
          detailAliases: [],
        });
        // The details are read, above that Limit.
        const aliases = subtree(plan).map((n) => n.Alias);
        expect(aliases).toEqual(expect.arrayContaining(["b1", "o", "pay", "r1"]));
        expect(aliases.includes("s1")).toBe(query.withBooker);
      }
    }
  });

  it("never returns another tenant's booking by name, email, or reference", async () => {
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
    // B's matching bookings change neither A's count nor A's pages.
    for (const q of ["Fernández", "luis", "gmail", "test"]) {
      const expected = await reference(A.id, q, true);
      const paged = await pageThrough(A.id, { q, limit: 2, withBooker: true });
      expect({ q, ids: paged.ids, total: paged.total }).toEqual({
        q,
        ids: expected,
        total: expected.length,
      });
      expect(paged.ids.filter((id) => idsB.includes(id))).toEqual([]);
    }
  });
});
