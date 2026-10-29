/**
 * The console search as it ran at b6d0247, before search became one
 * statement. For tests only: the result gate compares every outcome of
 * `searchBookings` with this one, and the off-by-default benchmark times both
 * in the same run. Never exported from the package.
 *
 * Frozen here, as b6d0247 had them: the text condition, the three statements
 * (cursor check, count, page), and the row mapping. Shared with today's
 * search, imported live: the input helpers (`referencePrefix`, `escapeLike`,
 * `nameWords`, `emailFragment`, `searchFields`), `iso`, and the types. Those
 * helpers decide what matches, which no search change may move, so a change
 * to one moves both sides alike and the gate cannot see it; their own tests
 * cover them (`console-completion.test.ts`, and the contracts'
 * `console.test.ts` for the reference prefix). Do not change the frozen part
 * to match a later search.
 */

import {
  type BookingSource,
  type BookingState,
  isUuid,
  type PaymentState,
  type ProductKind,
  type RefundState,
  type TenantTransaction,
  type TripSalesState,
} from "@tidegrid/database";
import { type RawBuilder, sql } from "kysely";
import {
  type BookingSearchOutcome,
  type BookingSearchQuery,
  emailFragment,
  escapeLike,
  nameWords,
  referencePrefix,
  searchFields,
} from "./search.ts";
import { iso } from "./views.ts";

interface SearchRow {
  id: string;
  reference: string;
  state: BookingState;
  source: BookingSource;
  confirmed_at: Date | string;
  party_size: number;
  trip_id: string;
  product_name: string;
  product_kind: ProductKind;
  boat_name: string;
  time_zone: string;
  local_date: string;
  local_start_time: string;
  starts_at: Date | string;
  sales_state: TripSalesState;
  total_amount: number;
  payment_state: PaymentState;
  refund_state: RefundState | null;
  refund_amount: number | null;
  booker_name?: string;
  booker_email?: string;
}

function textCondition(q: string, withBooker: boolean): RawBuilder<unknown> {
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
  return parts.length === 0 ? sql`false` : sql`(${sql.join(parts, sql` or `)})`;
}

/** The b6d0247 search: cursor check, count, and a page that joins every match before its limit. */
export async function baselineSearch(
  trx: TenantTransaction,
  tenantId: string,
  query: BookingSearchQuery,
): Promise<BookingSearchOutcome> {
  const { withBooker } = query;
  const conditions: RawBuilder<unknown>[] = [sql`b.tenant_id = ${tenantId}`];
  if (query.from !== undefined) conditions.push(sql`t.local_date >= ${query.from}::date`);
  if (query.to !== undefined) conditions.push(sql`t.local_date <= ${query.to}::date`);
  if (query.q !== undefined) conditions.push(textCondition(query.q, withBooker));
  const where = sql.join(conditions, sql` and `);
  // Finance's search never joins the checkout, where the booker's details live.
  const bookerJoin: RawBuilder<unknown> = withBooker
    ? sql`join checkout_sessions s on s.tenant_id = b.tenant_id and s.id = b.checkout_session_id`
    : sql``;
  const from = sql`
      from bookings b
      join scheduled_trips t on t.tenant_id = b.tenant_id and t.id = b.trip_id
      ${bookerJoin}`;

  if (query.after !== undefined) {
    if (!isUuid(query.after)) return { kind: "cursor_invalid" };
    const { rows: found } = await sql<{ id: string }>`
      select b.id ${from}
       where ${where} and b.id = ${query.after}::uuid`.execute(trx);
    if (!found[0]) return { kind: "cursor_invalid" };
  }

  const { rows: counted } = await sql<{ n: number }>`
    select count(*)::int as n ${from} where ${where}`.execute(trx);

  const cursor =
    query.after === undefined
      ? sql``
      : sql`and (t.starts_at, t.id, b.confirmed_at, b.id) > (
              select t2.starts_at, t2.id, b2.confirmed_at, b2.id
                from bookings b2
                join scheduled_trips t2 on t2.tenant_id = b2.tenant_id and t2.id = b2.trip_id
               where b2.tenant_id = ${tenantId} and b2.id = ${query.after}::uuid)`;
  const bookerColumns: RawBuilder<unknown> = withBooker
    ? sql`, s.booker_name, s.booker_email`
    : sql``;
  const { rows } = await sql<SearchRow>`
    select b.id, b.reference, b.state, b.source, b.confirmed_at, b.party_size,
           t.id as trip_id, p.name as product_name, p.kind as product_kind,
           bt.name as boat_name, t.time_zone,
           to_char(t.local_date, 'YYYY-MM-DD') as local_date,
           to_char(t.local_start_time, 'HH24:MI') as local_start_time,
           t.starts_at, t.sales_state,
           o.total_amount, pay.state as payment_state,
           r.state as refund_state, r.amount as refund_amount
           ${bookerColumns}
      ${from}
      join products p on p.tenant_id = t.tenant_id and p.id = t.product_id
      join boats bt on bt.tenant_id = t.tenant_id and bt.id = t.boat_id
      join orders o on o.tenant_id = b.tenant_id and o.id = b.order_id
      join payments pay on pay.tenant_id = b.tenant_id and pay.id = b.payment_id
      -- The latest refund only, so a payment refunded in parts never repeats its booking.
      left join lateral (
        select r1.state, r1.amount from payment_refunds r1
         where r1.tenant_id = b.tenant_id and r1.payment_id = b.payment_id
         order by r1.created_at desc, r1.id desc
         limit 1
      ) r on true
     where ${where}
       ${cursor}
     order by t.starts_at, t.id, b.confirmed_at, b.id
     limit ${query.limit + 1}`.execute(trx);

  const page = rows.slice(0, query.limit);
  return {
    kind: "ok",
    results: page.map((r) => ({
      id: r.id,
      reference: r.reference,
      state: r.state,
      source: r.source,
      confirmedAt: iso(r.confirmed_at),
      trip: {
        tripId: r.trip_id,
        productName: r.product_name,
        productKind: r.product_kind,
        boatName: r.boat_name,
        timeZone: r.time_zone,
        localDate: r.local_date,
        localStartTime: r.local_start_time,
        startsAt: iso(r.starts_at),
        salesState: r.sales_state,
      },
      ...(withBooker && r.booker_name !== undefined && r.booker_email !== undefined
        ? { booker: { name: r.booker_name, email: r.booker_email } }
        : {}),
      guests: r.party_size,
      total: r.total_amount,
      currency: "USD",
      payment: {
        state: r.payment_state,
        refund:
          r.refund_state && r.refund_amount !== null
            ? { state: r.refund_state, amount: r.refund_amount }
            : null,
      },
    })),
    total: counted[0]?.n ?? 0,
    nextAfter: rows.length > query.limit ? (page.at(-1)?.id ?? null) : null,
    matchedOn: query.q === undefined ? [] : searchFields(withBooker),
  };
}
