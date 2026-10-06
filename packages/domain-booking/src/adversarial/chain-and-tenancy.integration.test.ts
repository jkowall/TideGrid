/**
 * G2.7 adversarial tests for the chain of custody and tenant isolation, below
 * the services. Direct SQL as tidegrid_app and as the owner role tries to mark
 * a payment succeeded, confirm a checkout, insert a booking, pay an order, and
 * rewrite or delete the inbox, and every attempt is refused by a trigger or a
 * privilege. Then two tenants: every service command and read, given another
 * tenant's ids, secrets, events, or a transaction bound to another tenant,
 * finds nothing and changes nothing.
 */
import { randomUUID } from "node:crypto";
import {
  createDb,
  inTenantTransaction,
  setTenantContext,
  type TenantContext,
  type TenantTransaction,
} from "@tidegrid/database";
import type {} from "@tidegrid/database/global-setup";
import { tripAllocator } from "@tidegrid/domain-inventory/testing";
import { recordProviderEvent } from "@tidegrid/domain-payments";
import { sql } from "kysely";
import postgres from "postgres";
import { afterAll, beforeAll, describe, inject, it } from "vitest";
import {
  cancelCheckoutSession,
  createCheckoutSession,
  ensureProviderPayment,
  expireCheckoutSessions,
  getCheckoutSession,
  handleVerifiedEvent,
  listFinalizationExceptions,
  listTripBookings,
  processProviderEvent,
  settleRefund,
} from "../index.ts";
import {
  type CheckoutFixture,
  createCheckoutFixture,
  fakeProvider,
  guestContext,
  newSecret,
  quoteFor,
  verifiedFakeEvent,
} from "../test-fixtures.ts";
import {
  asGuest,
  auditLedger,
  backdateMany,
  bodyFor,
  checkoutInput,
  deliver,
  eventBody,
  expireTenant,
  FlakyProvider,
  type Opened,
  openCheckout,
  outcomeOf,
  type Runtime,
  refusal,
  type Sql,
  settle,
  settleFake,
  stateOf,
  sweepCtx,
  systemCtx,
  type World,
} from "./harness.ts";

const env = inject("integrationDb");

interface Ids {
  payment: string;
  order: string;
  hold: string;
  trip: string;
  inbox: string | null;
}

describe.skipIf(!env).concurrent("G2.7 adversarial: chain of custody and tenancy", () => {
  let admin: Sql;
  let runtime: Runtime;
  let world: World;
  let A: CheckoutFixture;
  let B: CheckoutFixture;
  let tripsA: ReturnType<typeof tripAllocator>;
  let tripsB: ReturnType<typeof tripAllocator>;
  /** A's checkouts in every state. */
  let open: Opened;
  let confirmed: Opened;
  let unfulfilled: Opened;
  let failed: Opened;
  let expired: Opened;
  let successInbox: string;
  let failureInbox: string;

  beforeAll(async () => {
    if (!env) return;
    admin = postgres(env.adminUrl, { max: 6, onnotice: () => {} });
    runtime = createDb(env.runtimeUrl, { max: 24 });
    world = { admin, db: runtime.db, provider: fakeProvider(runtime.db) };
    [A, B] = await Promise.all([
      createCheckoutFixture(admin, runtime.db, "advcha"),
      createCheckoutFixture(admin, runtime.db, "advchb"),
    ]);
    tripsA = tripAllocator(A);
    tripsB = tripAllocator(B);
    [open, confirmed, unfulfilled, failed, expired] = await Promise.all([
      openCheckout(world, A, tripsA.shared(), 1),
      openCheckout(world, A, tripsA.shared(), 2),
      openCheckout(world, A, tripsA.shared(), 3),
      openCheckout(world, A, tripsA.shared(), 1),
      openCheckout(world, A, tripsA.shared(), 1),
    ]);
    // Confirmed through a verified success.
    const paid = await settleFake(world, confirmed, "succeeded");
    await deliver(world, paid.body);
    // Unfulfilled: canceled by the guest, then paid anyway.
    await asGuest(runtime.db, A.id, (trx, ctx) =>
      cancelCheckoutSession(trx, ctx, {
        sessionId: unfulfilled.sessionId,
        secret: unfulfilled.secret,
      }),
    );
    await deliver(world, (await settleFake(world, unfulfilled, "succeeded")).body);
    // Failed through a verified failure.
    await deliver(world, (await settleFake(world, failed, "failed")).body);
    // Expired by the sweep.
    await backdateMany(admin, [expired.sessionId]);
    await expireTenant(runtime.db, A.id);
    const [s] = await admin<{ id: string }[]>`
      select id from public.provider_events where event_id = ${paid.id}`;
    const [f] = await admin<{ id: string }[]>`
      select e.id from public.provider_events e
       where e.tenant_id = ${A.id} and e.payment_ref = ${failed.paymentRef}
         and e.event_type = 'payment.failed'`;
    if (!s || !f) throw new Error("fixture events were not recorded");
    successInbox = s.id;
    failureInbox = f.id;
  });

  afterAll(async () => {
    await runtime?.end();
    await admin?.end({ timeout: 5 });
  });

  const ids = async (o: Opened): Promise<Ids> => {
    const [row] = await admin<
      { payment: string; order: string; hold: string; trip: string; inbox: string | null }[]
    >`
      select p.id as payment, o.id as order, s.hold_id as hold, s.trip_id as trip,
             p.succeeded_event_id as inbox
        from public.checkout_sessions s
        join public.payments p on p.checkout_session_id = s.id
        join public.orders o on o.checkout_session_id = s.id
       where s.id = ${o.sessionId}`;
    if (!row) throw new Error("no checkout");
    return row;
  };

  /** One statement as tidegrid_app, in its own transaction bound to `tenantId`. */
  const asRuntime = <T>(tenantId: string, fn: (trx: TenantTransaction) => Promise<T>) =>
    inTenantTransaction(runtime.db, systemCtx(tenantId), fn);

  const bookingValues = (o: Opened, i: Ids) => sql`
    (${A.id}, ${
      "ABCDEFGH".slice(0, 4) +
      randomUUID()
        .replace(/[^0-9a-f]/g, "")
        .slice(0, 4)
        .toUpperCase()
        .replace(/[ILOU]/g, "A")
    },
     ${o.sessionId}, ${i.order}, ${i.payment}, ${i.hold}, ${i.trip}, ${o.party}, false)`;

  it("refuses the runtime every shortcut to a paid or confirmed checkout", async ({ expect }) => {
    const [o, c, u, f, e] = await Promise.all(
      [open, confirmed, unfulfilled, failed, expired].map(ids),
    );
    if (!o || !c || !u || !f || !e) throw new Error("no ids");
    const attempts: [string, () => Promise<unknown>, { code: string; constraint?: string }][] = [
      [
        "mark a payment succeeded without evidence",
        () =>
          asRuntime(A.id, (trx) =>
            sql`update payments set state = 'succeeded' where id = ${o.payment}`.execute(trx),
          ),
        { code: "23514", constraint: "payments_evidence" },
      ],
      [
        "mark a payment succeeded with a failure event as evidence",
        () =>
          asRuntime(A.id, (trx) =>
            sql`update payments set state = 'succeeded', succeeded_event_id = ${failureInbox}
               where id = ${o.payment}`.execute(trx),
          ),
        { code: "23514", constraint: "payments_evidence" },
      ],
      [
        "mark a payment succeeded with another payment's success",
        () =>
          asRuntime(A.id, (trx) =>
            sql`update payments set state = 'succeeded', succeeded_event_id = ${successInbox}
               where id = ${o.payment}`.execute(trx),
          ),
        { code: "23514", constraint: "payments_evidence" },
      ],
      [
        "confirm an open checkout",
        () =>
          asRuntime(A.id, (trx) =>
            sql`update checkout_sessions set state = 'confirmed' where id = ${open.sessionId}`.execute(
              trx,
            ),
          ),
        { code: "23514", constraint: "checkout_sessions_evidence" },
      ],
      [
        "close an open checkout as unfulfilled without a refund",
        () =>
          asRuntime(A.id, (trx) =>
            sql`update checkout_sessions set state = 'unfulfilled' where id = ${open.sessionId}`.execute(
              trx,
            ),
          ),
        { code: "23514", constraint: "checkout_sessions_evidence" },
      ],
      [
        "reopen an expired checkout",
        () =>
          asRuntime(A.id, (trx) =>
            sql`update checkout_sessions set state = 'open' where id = ${expired.sessionId}`.execute(
              trx,
            ),
          ),
        { code: "23514", constraint: "checkout_sessions_transition" },
      ],
      [
        "confirm an expired checkout",
        () =>
          asRuntime(A.id, (trx) =>
            sql`update checkout_sessions set state = 'confirmed' where id = ${expired.sessionId}`.execute(
              trx,
            ),
          ),
        { code: "23514", constraint: "checkout_sessions_evidence" },
      ],
      [
        "confirm an unfulfilled checkout",
        () =>
          asRuntime(A.id, (trx) =>
            sql`update checkout_sessions set state = 'confirmed' where id = ${unfulfilled.sessionId}`.execute(
              trx,
            ),
          ),
        { code: "23514", constraint: "checkout_sessions_transition" },
      ],
      [
        "pay an order without a booking",
        () =>
          asRuntime(A.id, (trx) =>
            sql`update orders set status = 'paid' where id = ${o.order}`.execute(trx),
          ),
        { code: "23514", constraint: "orders_evidence" },
      ],
      [
        "revive a void order",
        () =>
          asRuntime(A.id, (trx) =>
            sql`update orders set status = 'pending' where id = ${f.order}`.execute(trx),
          ),
        { code: "23514", constraint: "orders_transition" },
      ],
      [
        "book an open checkout with a pending payment",
        () =>
          asRuntime(A.id, (trx) =>
            sql`insert into bookings (tenant_id, reference, checkout_session_id, order_id, payment_id,
                hold_id, trip_id, party_size, reacquired)
              values ${bookingValues(open, o)}`.execute(trx),
          ),
        { code: "23514", constraint: "bookings_evidence" },
      ],
      [
        "book an open checkout after confirming its hold directly",
        () =>
          asRuntime(A.id, async (trx) => {
            await sql`update capacity_holds set state = 'confirmed' where id = ${o.hold}`.execute(
              trx,
            );
            return sql`insert into bookings (tenant_id, reference, checkout_session_id, order_id,
                payment_id, hold_id, trip_id, party_size, reacquired)
              values ${bookingValues(open, o)}`.execute(trx);
          }),
        { code: "23514", constraint: "bookings_evidence" },
      ],
      [
        "book an unfulfilled checkout whose payment succeeded",
        () =>
          asRuntime(A.id, (trx) =>
            sql`insert into bookings (tenant_id, reference, checkout_session_id, order_id, payment_id,
                hold_id, trip_id, party_size, reacquired)
              values ${bookingValues(unfulfilled, u)}`.execute(trx),
          ),
        { code: "23514", constraint: "bookings_evidence" },
      ],
      [
        "book a confirmed checkout a second time",
        () =>
          asRuntime(A.id, (trx) =>
            sql`insert into bookings (tenant_id, reference, checkout_session_id, order_id, payment_id,
                hold_id, trip_id, party_size, reacquired)
              values ${bookingValues(confirmed, c)}`.execute(trx),
          ),
        { code: "23514", constraint: "bookings_evidence" },
      ],
      [
        "rewrite a processed event's outcome",
        () =>
          asRuntime(A.id, (trx) =>
            sql`update provider_events set outcome = 'released' where id = ${successInbox}`.execute(
              trx,
            ),
          ),
        { code: "23514", constraint: "provider_events_transition" },
      ],
      [
        "send a processed event back to received",
        () =>
          asRuntime(A.id, (trx) =>
            sql`update provider_events set processing_state = 'received', outcome = null
               where id = ${successInbox}`.execute(trx),
          ),
        { code: "23514", constraint: "provider_events_transition" },
      ],
      [
        "change an event's amount",
        () =>
          asRuntime(A.id, (trx) =>
            sql`update provider_events set amount = 1 where id = ${successInbox}`.execute(trx),
          ),
        { code: "42501" },
      ],
      [
        "delete an event",
        () =>
          asRuntime(A.id, (trx) =>
            sql`delete from provider_events where id = ${successInbox}`.execute(trx),
          ),
        { code: "42501" },
      ],
      [
        "delete a booking",
        () =>
          asRuntime(A.id, (trx) =>
            sql`delete from bookings where checkout_session_id = ${confirmed.sessionId}`.execute(
              trx,
            ),
          ),
        { code: "42501" },
      ],
      [
        "change where money goes",
        () =>
          asRuntime(A.id, (trx) =>
            sql`update payment_accounts set account_ref = 'acct_fake_elsewhere'`.execute(trx),
          ),
        { code: "42501" },
      ],
      [
        "add a connected account",
        () =>
          asRuntime(A.id, (trx) =>
            sql`insert into payment_accounts (tenant_id, provider, account_ref)
              values (${A.id}, 'stripe', 'acct_elsewhere')`.execute(trx),
          ),
        { code: "42501" },
      ],
      [
        "lower a payment's amount",
        () =>
          asRuntime(A.id, (trx) =>
            sql`update payments set amount = 1 where id = ${o.payment}`.execute(trx),
          ),
        { code: "42501" },
      ],
      [
        "move a checkout's expiry",
        () =>
          asRuntime(A.id, (trx) =>
            sql`update checkout_sessions set expires_at = now() + interval '1 hour'
               where id = ${open.sessionId}`.execute(trx),
          ),
        { code: "42501" },
      ],
      [
        "change a recorded provider payment id",
        () =>
          asRuntime(A.id, (trx) =>
            sql`update payments set provider_payment_id = ${`fpay_${"Q".repeat(24)}`}
               where id = ${o.payment}`.execute(trx),
          ),
        { code: "23514", constraint: "payments_immutable" },
      ],
      [
        "refund a pending payment",
        () =>
          asRuntime(A.id, (trx) =>
            sql`insert into payment_refunds (tenant_id, payment_id, amount, reason, idempotency_key)
              values (${A.id}, ${o.payment}, ${open.amount}, 'unfulfilled_payment',
                      ${`adv_refund:${randomUUID()}`})`.execute(trx),
          ),
        { code: "23514", constraint: "payment_refunds_payment" },
      ],
      [
        "refund an unfulfilled payment a second time",
        () =>
          asRuntime(A.id, (trx) =>
            sql`insert into payment_refunds (tenant_id, payment_id, amount, reason, idempotency_key)
              values (${A.id}, ${u.payment}, ${unfulfilled.amount}, 'unfulfilled_payment',
                      ${`adv_refund:${randomUUID()}`})`.execute(trx),
          ),
        { code: "23505", constraint: "payment_refunds_one_per_payment" },
      ],
      [
        "refund part of a payment",
        () =>
          asRuntime(A.id, (trx) =>
            sql`insert into payment_refunds (tenant_id, payment_id, amount, reason, idempotency_key)
              values (${A.id}, ${c.payment}, 1, 'unfulfilled_payment',
                      ${`adv_refund:${randomUUID()}`})`.execute(trx),
          ),
        { code: "23514", constraint: "payment_refunds_payment" },
      ],
      [
        "insert a checkout that starts confirmed",
        () =>
          asRuntime(A.id, (trx) =>
            sql`insert into checkout_sessions (id, tenant_id, quote_id, trip_id, party_size, hold_id,
                policy_version, state, expires_at, secret_hash, booker_name, booker_email)
              select ${randomUUID()}, tenant_id, quote_id, trip_id, party_size, hold_id,
                     policy_version, 'confirmed', expires_at, secret_hash, booker_name, booker_email
                from checkout_sessions where id = ${open.sessionId}`.execute(trx),
          ),
        { code: "23514", constraint: "checkout_sessions_transition" },
      ],
      [
        "add a line to a committed order",
        () =>
          asRuntime(A.id, (trx) =>
            sql`insert into order_lines (tenant_id, order_id, line_no, kind, code, name, basis,
                quantity, unit_amount, amount, taxable)
              values (${A.id}, ${o.order}, 150, 'fee', 'extra', 'Extra', 'per_booking', 1, 100,
                      100, false)`.execute(trx),
          ),
        { code: "55000" },
      ],
    ];
    const got: Record<string, { code: string; constraint?: string }> = {};
    const want: Record<string, { code: string; constraint?: string }> = {};
    for (const [name, attempt, expected] of attempts) {
      const r = await refusal(attempt());
      got[name] =
        expected.constraint === undefined
          ? { code: r.code }
          : { ...r, constraint: r.constraint ?? "" };
      want[name] = expected;
    }
    expect(got).toEqual(want);
    // Nothing moved.
    expect(await stateOf(admin, open.sessionId)).toMatchObject({
      session: "open",
      hold: "active",
      order: "pending",
      payment: "pending",
      bookings: 0,
    });
    expect(await auditLedger(admin, [A.id])).toEqual([]);
  });

  // Sequential (lead's change after this suite's first run): TRUNCATE ...
  // CASCADE takes ACCESS EXCLUSIVE on the inbox and every table that refers
  // to it, one by one, before its trigger can refuse. Run beside the other
  // tests in this concurrent suite, it was once refused by the deadlock
  // detector (40P01) instead of the trigger (55000). Alone, it meets the trigger.
  it.sequential("refuses the owner role every shortcut too", async ({ expect }) => {
    const [o, c] = await Promise.all([open, confirmed].map(ids));
    if (!o || !c) throw new Error("no ids");
    const attempts: [string, () => Promise<unknown>, { code: string; constraint?: string }][] = [
      [
        "mark a payment succeeded without evidence",
        () => admin`update public.payments set state = 'succeeded' where id = ${o.payment}`,
        { code: "23514", constraint: "payments_evidence" },
      ],
      [
        "confirm an open checkout",
        () =>
          admin`update public.checkout_sessions set state = 'confirmed' where id = ${open.sessionId}`,
        { code: "23514", constraint: "checkout_sessions_evidence" },
      ],
      [
        "book an open checkout",
        () => admin`insert into public.bookings (tenant_id, reference, checkout_session_id, order_id,
                payment_id, hold_id, trip_id, party_size, reacquired)
              values (${A.id}, 'ZZZZ2222', ${open.sessionId}, ${o.order}, ${o.payment}, ${o.hold},
                      ${o.trip}, ${open.party}, false)`,
        { code: "23514", constraint: "bookings_evidence" },
      ],
      [
        "pay an order without a booking",
        () => admin`update public.orders set status = 'paid' where id = ${o.order}`,
        { code: "23514", constraint: "orders_evidence" },
      ],
      [
        "change an event's amount",
        () =>
          admin`update public.provider_events set amount = amount + 1 where id = ${successInbox}`,
        { code: "23514", constraint: "provider_events_immutable" },
      ],
      [
        "send a processed event back to received",
        () => admin`update public.provider_events set processing_state = 'received', outcome = null
               where id = ${successInbox}`,
        { code: "23514", constraint: "provider_events_transition" },
      ],
      [
        "delete a booking",
        () => admin`delete from public.bookings where checkout_session_id = ${confirmed.sessionId}`,
        { code: "55000" },
      ],
      [
        "change a booking",
        () => admin`update public.bookings set party_size = party_size + 1
               where checkout_session_id = ${confirmed.sessionId}`,
        { code: "55000" },
      ],
      [
        "truncate the inbox",
        () => admin`truncate public.provider_events cascade`,
        { code: "55000" },
      ],
      [
        "move a checkout's expiry later",
        () => admin`update public.checkout_sessions set expires_at = expires_at + interval '1 hour'
               where id = ${open.sessionId}`,
        { code: "23514", constraint: "checkout_sessions_expiry" },
      ],
      [
        "change a payment's amount",
        () => admin`update public.payments set amount = amount - 1 where id = ${c.payment}`,
        { code: "23514", constraint: "payments_immutable" },
      ],
      [
        "reopen a settled refund",
        () => admin`update public.payment_refunds r set state = 'requested'
                from public.payments p
               where p.id = r.payment_id and p.checkout_session_id = ${unfulfilled.sessionId}`,
        { code: "23514", constraint: "payment_refunds_transition" },
      ],
      [
        "rewrite a fake provider event",
        () => admin`update public.fake_provider_events set body = '{}'
               where payment_id = ${confirmed.paymentRef}`,
        { code: "55000" },
      ],
    ];
    const got: Record<string, { code: string; constraint?: string }> = {};
    const want: Record<string, { code: string; constraint?: string }> = {};
    for (const [name, attempt, expected] of attempts) {
      const r = await refusal(attempt());
      got[name] =
        expected.constraint === undefined
          ? { code: r.code }
          : { ...r, constraint: r.constraint ?? "" };
      want[name] = expected;
    }
    expect(got).toEqual(want);
    expect(await stateOf(admin, confirmed.sessionId)).toMatchObject({
      session: "confirmed",
      bookings: 1,
    });
    expect(await auditLedger(admin, [A.id])).toEqual([]);
  });

  it("finds nothing and changes nothing when a service is given another tenant's checkout", async ({
    expect,
  }) => {
    const before = await stateOf(admin, open.sessionId);
    // Reads: B's guest with A's id and secret; and a transaction bound to B
    // asked for A by name.
    expect(
      await asGuest(runtime.db, B.id, (trx) =>
        getCheckoutSession(trx, B.id, { sessionId: open.sessionId, secret: open.secret }),
      ),
    ).toBeNull();
    expect(
      await asGuest(runtime.db, B.id, (trx) =>
        getCheckoutSession(trx, A.id, { sessionId: open.sessionId, secret: open.secret }),
      ),
    ).toBeNull();
    // Cancel from B, and from a transaction bound to B with A's context.
    expect(
      await asGuest(runtime.db, B.id, (trx, ctx) =>
        cancelCheckoutSession(trx, ctx, { sessionId: open.sessionId, secret: open.secret }),
      ),
    ).toEqual({ kind: "not_found" });
    expect(
      await inTenantTransaction(runtime.db, guestContext(B.id), (trx) =>
        cancelCheckoutSession(trx, guestContext(A.id), {
          sessionId: open.sessionId,
          secret: open.secret,
        }),
      ),
    ).toEqual({ kind: "not_found" });
    // The provider payment, from B.
    expect(
      await ensureProviderPayment(runtime.db, world.provider, guestContext(B.id), open.sessionId),
    ).toEqual({ kind: "not_found" });
    // A's quote, at B.
    const quoteA = await quoteFor(runtime.db, A.id, tripsA.shared(), 1);
    expect(
      await asGuest(runtime.db, B.id, (trx, ctx) =>
        createCheckoutSession(trx, ctx, checkoutInput(quoteA, newSecret())),
      ),
    ).toEqual({ kind: "quote_not_found" });
    // Staff reads, by B and by a transaction bound to B naming A.
    const confirmedIds = await ids(confirmed);
    await asGuest(runtime.db, B.id, async (trx) => {
      expect(await listTripBookings(trx, B.id, confirmedIds.trip)).toBeNull();
      expect(await listTripBookings(trx, A.id, confirmedIds.trip)).toBeNull();
      const exceptions = [
        ...(await listFinalizationExceptions(trx, B.id, { limit: 100 })),
        ...(await listFinalizationExceptions(trx, A.id, { limit: 100 })),
      ];
      expect(exceptions.filter((e) => e.checkoutSessionId === unfulfilled.sessionId)).toEqual([]);
    });
    // The sweep for B never expires A's lapsed checkout.
    const lapsed = await openCheckout(world, A, tripsA.shared(), 1, { ensure: false });
    await backdateMany(admin, [lapsed.sessionId]);
    const swept = await inTenantTransaction(runtime.db, sweepCtx(B.id), (trx) =>
      expireCheckoutSessions(trx, sweepCtx(B.id), { limit: 100 }),
    );
    expect(swept.expired).not.toContain(lapsed.sessionId);
    expect((await stateOf(admin, lapsed.sessionId)).session).toBe("open");
    expect(await stateOf(admin, open.sessionId)).toEqual(before);
  });

  it("keeps another tenant's inbox events and refunds out of reach", async ({ expect }) => {
    // An event A recorded and never processed.
    const pending = await openCheckout(world, A, tripsA.shared(), 1);
    const body = (await settleFake(world, pending, "succeeded")).body;
    const event = await verifiedFakeEvent(world.provider, body);
    const ctxA = systemCtx(A.id, "fake-webhook");
    const recorded = await inTenantTransaction(runtime.db, ctxA, (trx) =>
      recordProviderEvent(trx, ctxA, event),
    );
    const fromB = await settle(
      inTenantTransaction(runtime.db, sweepCtx(B.id), (trx) =>
        processProviderEvent(trx, sweepCtx(B.id), recorded.inboxId),
      ),
    );
    expect(fromB).toMatchObject({ ok: false, message: "inbox event not found in this tenant" });
    expect(
      await inTenantTransaction(runtime.db, sweepCtx(B.id), (trx) =>
        processProviderEvent(trx, sweepCtx(B.id), recorded.inboxId, { skipLocked: true }),
      ),
    ).toBeNull();
    expect((await stateOf(admin, pending.sessionId)).session).toBe("open");
    // A refund A requested and could not send.
    const lost = await openCheckout(world, A, tripsA.shared(), 1);
    await asGuest(runtime.db, A.id, (trx, ctx) =>
      cancelCheckoutSession(trx, ctx, { sessionId: lost.sessionId, secret: lost.secret }),
    );
    const flaky = new FlakyProvider(world.provider);
    flaky.failRefund = "before";
    await deliver(world, (await settleFake(world, lost, "succeeded")).body, flaky);
    const [refund] = await admin<{ id: string }[]>`
      select id from public.payment_refunds where payment_id = ${lost.paymentId}`;
    if (!refund) throw new Error("no refund");
    expect(await settleRefund(runtime.db, world.provider, sweepCtx(B.id), refund.id)).toEqual({
      kind: "not_pending",
    });
    expect(await stateOf(admin, lost.sessionId)).toMatchObject({
      refund: "requested",
      fakeRefunds: 0,
    });
    // A's own requests finish both.
    expect(
      await inTenantTransaction(runtime.db, ctxA, (trx) =>
        processProviderEvent(trx, ctxA, recorded.inboxId),
      ),
    ).toMatchObject({ outcome: "confirmed" });
    expect(await settleRefund(runtime.db, world.provider, sweepCtx(A.id), refund.id)).toMatchObject(
      {
        kind: "succeeded",
      },
    );
    expect(await auditLedger(admin, [A.id, B.id])).toEqual([]);
  });

  it("matches an event only within the tenant that owns the account it names", async ({
    expect,
  }) => {
    const target = await openCheckout(world, A, tripsA.shared(), 1);
    const targetB = await openCheckout(world, B, tripsB.shared(), 1);
    // B's account, A's payment reference and payment id.
    const crossed = bodyFor(target, "payment.succeeded", { accountRef: B.accountRef });
    const handled = await deliver(world, crossed);
    expect(handled).toMatchObject({
      kind: "processed",
      tenantId: B.id,
      outcome: "unmatched_payment",
    });
    const crossedId = (JSON.parse(crossed) as { id: string }).id;
    const recordedIn = await admin<{ tenant_id: string }[]>`
      select tenant_id from public.provider_events where event_id = ${crossedId}`;
    expect(recordedIn.map((r) => r.tenant_id)).toEqual([B.id]);
    // A's account, B's payment.
    expect(
      outcomeOf(
        await deliver(world, bodyFor(targetB, "payment.succeeded", { accountRef: A.accountRef })),
      ),
    ).toBe("unmatched_payment");
    // A failure naming B's account with A's payment changes nothing either.
    expect(
      outcomeOf(
        await deliver(world, bodyFor(target, "payment.failed", { accountRef: B.accountRef })),
      ),
    ).toBe("unmatched_payment");
    for (const o of [target, targetB]) {
      expect(await stateOf(admin, o.sessionId)).toMatchObject({
        session: "open",
        hold: "active",
        payment: "pending",
        bookings: 0,
        exceptions: [],
      });
    }
    // An event id A already recorded, sent again naming B's account: nothing is
    // recorded in B and A's event is untouched.
    const [eventA] = await admin<{ event_id: string; amount: number; outcome: string }[]>`
      select event_id, amount, outcome from public.provider_events where id = ${successInbox}`;
    if (!eventA) throw new Error("no event");
    const reused = eventBody({
      type: "payment.succeeded",
      accountRef: B.accountRef,
      paymentRef: targetB.paymentRef ?? "",
      amount: targetB.amount,
      clientReference: targetB.paymentId,
      eventId: eventA.event_id,
    });
    const verified = await verifiedFakeEvent(world.provider, reused);
    const outcome = await settle(
      handleVerifiedEvent(runtime.db, world.provider, verified, {
        requestId: `wh-${randomUUID()}`,
      }),
    );
    // Lead's change after this suite's first run: the conflict used to throw
    // (a 500 the provider would retry forever). It now answers like a changed
    // body under a known id, which the route acknowledges and logs as an error.
    expect(outcome).toEqual({ ok: true, value: { kind: "payload_mismatch", tenantId: B.id } });
    const sameId = await admin<{ tenant_id: string; amount: number; outcome: string }[]>`
      select tenant_id, amount, outcome from public.provider_events where event_id = ${eventA.event_id}`;
    expect([...sameId]).toEqual([
      { tenant_id: A.id, amount: eventA.amount, outcome: eventA.outcome },
    ]);
    expect((await stateOf(admin, targetB.sessionId)).session).toBe("open");
    expect(await auditLedger(admin, [A.id, B.id])).toEqual([]);
  });

  it("keeps the fake provider's payments inside their tenant", async ({ expect }) => {
    const ref = open.paymentRef ?? "";
    expect(await world.provider.getPayment(B.id, ref)).toBeNull();
    expect(await world.provider.settlePayment(B.id, ref, "succeeded", Date.now())).toEqual({
      kind: "not_found",
    });
    await expect(
      world.provider.refundPayment({
        accountRef: B.accountRef,
        paymentRef: confirmed.paymentRef ?? "",
        amount: confirmed.amount,
        currency: "USD",
        idempotencyKey: `adv_refund:${randomUUID()}`,
      }),
    ).rejects.toMatchObject({ code: "payment_unknown" });
    expect((await world.provider.getPayment(A.id, ref))?.status).toBe("pending");
    expect((await stateOf(admin, confirmed.sessionId)).fakeRefunds).toBe(0);
  });

  it("shows another tenant's rows to no runtime transaction and lets none point at them", async ({
    expect,
  }) => {
    const c = await ids(confirmed);
    const counts = await asRuntime(B.id, async (trx) => {
      const { rows } = await sql<Record<string, number>>`
        select (select count(*)::int from checkout_sessions where id = ${confirmed.sessionId}) as sessions,
               (select count(*)::int from orders where id = ${c.order}) as orders,
               (select count(*)::int from order_lines where order_id = ${c.order}) as lines,
               (select count(*)::int from payments where id = ${c.payment}) as payments,
               (select count(*)::int from bookings where checkout_session_id = ${confirmed.sessionId}) as bookings,
               (select count(*)::int from provider_events where id = ${successInbox}) as events,
               (select count(*)::int from payment_refunds where tenant_id = ${A.id}) as refunds,
               (select count(*)::int from finalization_exceptions where tenant_id = ${A.id}) as exceptions,
               (select count(*)::int from payment_accounts where tenant_id = ${A.id}) as accounts,
               (select count(*)::int from fake_provider_payments where tenant_id = ${A.id}) as fake_payments`.execute(
        trx,
      );
      return rows[0];
    });
    expect(counts).toEqual({
      sessions: 0,
      orders: 0,
      lines: 0,
      payments: 0,
      bookings: 0,
      events: 0,
      refunds: 0,
      exceptions: 0,
      accounts: 0,
      fake_payments: 0,
    });
    const updated = await asRuntime(B.id, (trx) =>
      sql`update checkout_sessions set state = 'canceled' where id = ${open.sessionId}`.execute(
        trx,
      ),
    );
    expect((updated as { numAffectedRows?: bigint }).numAffectedRows ?? 0n).toBe(0n);
    // B's transaction cannot record an event for A's account, nor a booking for A's checkout.
    expect(
      await refusal(
        asRuntime(B.id, (trx) =>
          sql`insert into provider_events (tenant_id, provider, event_id, event_type, provider_type,
                account_ref, payload_sha256)
              values (${B.id}, 'fake', ${`fevt_${"Y".repeat(24)}`}, 'other', 'other', ${A.accountRef},
                      ${"0".repeat(64)})`.execute(trx),
        ),
      ),
    ).toMatchObject({ code: "23503" });
    expect(
      (
        await refusal(
          asRuntime(B.id, (trx) =>
            sql`insert into bookings (tenant_id, reference, checkout_session_id, order_id,
                  payment_id, hold_id, trip_id, party_size, reacquired)
                values (${B.id}, 'YYYY3333', ${confirmed.sessionId}, ${c.order}, ${c.payment},
                        ${c.hold}, ${c.trip}, ${confirmed.party}, false)`.execute(trx),
          ),
        )
      ).code,
    ).toMatch(/^(23503|23514)$/);
    // The two cross-tenant lookups return tenant ids and a status, nothing else.
    const accountColumns = await asRuntime(B.id, async (trx) => {
      const { rows } = await sql<Record<string, unknown>>`
        select * from app.resolve_payment_account('fake', ${A.accountRef})`.execute(trx);
      return rows.map((r) => Object.keys(r).sort());
    });
    expect(accountColumns).toEqual([["account_status", "tenant_id"]]);
    const sweepColumns = await asRuntime(B.id, async (trx) => {
      const { rows } = await sql<Record<string, unknown>>`
        select * from app.checkout_sweep_tenants(1000, 0)`.execute(trx);
      return [...new Set(rows.map((r) => Object.keys(r).join(",")))];
    });
    expect(sweepColumns.every((c) => c === "tenant_id")).toBe(true);
  });

  it("refuses to open, process, or expire a checkout above READ COMMITTED, and writes nothing", async ({
    expect,
  }) => {
    const inLevel = <T>(
      level: "repeatable read" | "serializable",
      ctx: TenantContext,
      fn: (trx: TenantTransaction) => Promise<T>,
    ) =>
      runtime.db
        .transaction()
        .setIsolationLevel(level)
        .execute(async (trx) => {
          await setTenantContext(trx, ctx);
          return fn(trx);
        });
    // Opening.
    const quote = await quoteFor(runtime.db, A.id, tripsA.shared(), 1);
    const guest = guestContext(A.id);
    const opened = await settle(
      inLevel("serializable", guest, (trx) =>
        createCheckoutSession(trx, guest, checkoutInput(quote, newSecret())),
      ),
    );
    expect(opened).toMatchObject({ ok: false, code: "25000" });
    const [none] = await admin<{ n: number }[]>`
      select count(*)::int as n from public.checkout_sessions where quote_id = ${quote.quoteId}`;
    expect(none?.n).toBe(0);
    // Processing a recorded success.
    const o = await openCheckout(world, A, tripsA.shared(), 1);
    const event = await verifiedFakeEvent(
      world.provider,
      (await settleFake(world, o, "succeeded")).body,
    );
    const ctx = systemCtx(A.id, "fake-webhook");
    const recorded = await inTenantTransaction(runtime.db, ctx, (trx) =>
      recordProviderEvent(trx, ctx, event),
    );
    const processed = await settle(
      inLevel("repeatable read", ctx, (trx) => processProviderEvent(trx, ctx, recorded.inboxId)),
    );
    expect(processed).toMatchObject({ ok: false, code: "25000" });
    expect(await stateOf(admin, o.sessionId)).toMatchObject({
      session: "open",
      payment: "pending",
      bookings: 0,
    });
    // Expiring a lapsed checkout.
    const lapsed = await openCheckout(world, A, tripsA.shared(), 1, { ensure: false });
    await backdateMany(admin, [lapsed.sessionId]);
    const sweep = sweepCtx(A.id);
    const expiredAbove = await settle(
      inLevel("repeatable read", sweep, (trx) =>
        expireCheckoutSessions(trx, sweep, { limit: 100 }),
      ),
    );
    expect(expiredAbove).toMatchObject({ ok: false, code: "25000" });
    expect((await stateOf(admin, lapsed.sessionId)).session).toBe("open");
    // At READ COMMITTED the same work goes through.
    expect(
      await inTenantTransaction(runtime.db, ctx, (trx) =>
        processProviderEvent(trx, ctx, recorded.inboxId),
      ),
    ).toMatchObject({ outcome: "confirmed" });
    expect(await auditLedger(admin, [A.id])).toEqual([]);
  });
});
