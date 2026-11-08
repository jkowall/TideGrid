import { randomUUID } from "node:crypto";
import { createDb, inTenantTransaction } from "@tidegrid/database";
import type {} from "@tidegrid/database/global-setup";
import { tripAllocator } from "@tidegrid/domain-inventory/testing";
import { FAKE_MINIMUM_AMOUNT, type FakePaymentProvider } from "@tidegrid/domain-payments";
import { sql } from "kysely";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";
import {
  createCheckoutSession,
  ensureProviderPayment,
  handleVerifiedEvent,
  sweepCheckouts,
} from "./index.ts";
import {
  backdateCheckout,
  type CheckoutFixture,
  confirmBooking,
  createCheckoutFixture,
  fakeProvider,
  guestContext,
  newSecret,
  quoteFor,
  verifiedFakeEvent,
} from "./test-fixtures.ts";

type Sql = ReturnType<typeof postgres>;

const env = inject("integrationDb");

async function failure(p: Promise<unknown>): Promise<{ code?: string; constraint?: string }> {
  try {
    await p;
  } catch (err) {
    const e = err as { code?: string; constraint_name?: string };
    return {
      ...(e.code ? { code: e.code } : {}),
      ...(e.constraint_name ? { constraint: e.constraint_name } : {}),
    };
  }
  throw new Error("expected a database error");
}

/**
 * Retention of abandoned checkouts (W3-G2.2b, coordinator default D2): the
 * booker's name and email on a checkout that expired, failed, or was
 * canceled, with no booking and no successful payment, are replaced with a
 * fixed redaction once the retention period has passed. The database decides
 * what qualifies, for every role, and a late success on a redacted checkout
 * is refunded rather than booked.
 */
describe.skipIf(!env)("retention of abandoned checkouts", () => {
  let admin: Sql;
  let runtime: ReturnType<typeof createDb>;
  let provider: FakePaymentProvider;
  let A: CheckoutFixture;
  let B: CheckoutFixture;

  async function openCheckout(tenant: CheckoutFixture, tripId: string, email: string) {
    const quote = await quoteFor(runtime.db, tenant.id, tripId, 1);
    const ctx = guestContext(tenant.id);
    const created = await inTenantTransaction(runtime.db, ctx, (trx) =>
      createCheckoutSession(trx, ctx, {
        quoteId: quote.quoteId,
        acceptedPolicyVersion: quote.policy.version,
        booker: { name: "Gone Guest", email },
        secret: newSecret(),
        clientAddress: null,
        provider: "fake",
        minimumAmount: FAKE_MINIMUM_AMOUNT,
      }),
    );
    if (created.kind !== "created") throw new Error(`checkout: ${JSON.stringify(created)}`);
    const ready = await ensureProviderPayment(runtime.db, provider, ctx, created.session.id);
    if (ready.kind !== "ready") throw new Error(`payment: ${JSON.stringify(ready)}`);
    return { id: created.session.id, paymentRef: ready.paymentRef };
  }

  /** Move a checkout's end into the past; triggers off for this one admin transaction. */
  async function age(sessionId: string, days: number) {
    await admin.begin(async (tx) => {
      await tx`set local session_replication_role = replica`;
      await tx`update public.checkout_sessions
                  set expired_at = expired_at - make_interval(days => ${days}),
                      failed_at = failed_at - make_interval(days => ${days}),
                      canceled_at = canceled_at - make_interval(days => ${days}),
                      confirmed_at = confirmed_at - make_interval(days => ${days})
                where id = ${sessionId}`;
    });
  }

  const booker = async (id: string) => {
    const [row] =
      await admin`select booker_name, booker_email, booker_redacted_at is not null as redacted
      from public.checkout_sessions where id = ${id}`;
    return row;
  };

  beforeAll(async () => {
    if (!env) return;
    admin = postgres(env.adminUrl, { max: 2, onnotice: () => {} });
    runtime = createDb(env.runtimeUrl, { max: 2 });
    provider = fakeProvider(runtime.db);
    A = await createCheckoutFixture(admin, runtime.db, "ret-a");
    B = await createCheckoutFixture(admin, runtime.db, "ret-b");
  });

  afterAll(async () => {
    await runtime?.end();
    await admin?.end({ timeout: 5 });
  });

  it("redacts only abandoned checkouts past the period, and audits per tenant", async () => {
    const tripsA = tripAllocator(A);
    const tripsB = tripAllocator(B);
    const run = randomUUID().slice(0, 8);

    // Expired, long ago (A); failed, long ago (B); expired, recently (A).
    const expired = await openCheckout(A, tripsA.shared(), `exp-${run}@example.test`);
    await backdateCheckout(admin, expired.id);
    await sweepCheckouts(runtime.db, { runId: `ret-${run}`, provider });
    const failed = await openCheckout(B, tripsB.shared(), `fail-${run}@example.test`);
    const settled = await provider.settlePayment(B.id, failed.paymentRef, "failed", Date.now());
    if (settled.kind === "not_found") throw new Error("no fake payment");
    await handleVerifiedEvent(
      runtime.db,
      provider,
      await verifiedFakeEvent(provider, settled.event.body),
      {
        requestId: `ret-${run}`,
      },
    );
    const recent = await openCheckout(A, tripsA.shared(), `recent-${run}@example.test`);
    await backdateCheckout(admin, recent.id);
    await sweepCheckouts(runtime.db, { runId: `ret2-${run}`, provider });
    // Confirmed long ago: a booking keeps its booker.
    const confirmed = await confirmBooking(runtime.db, provider, A, tripsA.shared(), 1, {
      booker: { name: "Kept Guest", email: `kept-${run}@example.test` },
    });

    await age(expired.id, 40);
    await age(failed.id, 40);
    await age(confirmed.checkoutSessionId, 40);

    // The runtime cannot write the booker itself.
    expect(
      await failure(
        inTenantTransaction(runtime.db, guestContext(A.id), (trx) =>
          sql`update public.checkout_sessions set booker_name = 'Redacted',
                booker_email = 'redacted@redacted.invalid', booker_redacted_at = now()
              where id = ${expired.id}`.execute(trx),
        ),
      ),
    ).toEqual({ code: "42501" });

    const { rows } = await sql<{ tenant_id: string; redacted: number }>`
      select * from app.retention_redact_abandoned_checkouts(30, 5000)`.execute(runtime.db);
    const counts = Object.fromEntries(rows.map((r) => [r.tenant_id, r.redacted]));
    expect(counts[A.id]).toBe(1);
    expect(counts[B.id]).toBe(1);

    for (const id of [expired.id, failed.id]) {
      expect(await booker(id)).toEqual({
        booker_name: "Redacted",
        booker_email: "redacted@redacted.invalid",
        redacted: true,
      });
    }
    expect(await booker(recent.id)).toMatchObject({ booker_name: "Gone Guest", redacted: false });
    expect(await booker(confirmed.checkoutSessionId)).toMatchObject({
      booker_name: "Kept Guest",
      redacted: false,
    });
    const audits = await admin`select tenant_id, actor_type, actor_id, after_state
      from public.audit_events
      where action = 'retention.checkout_bookers_redacted' and tenant_id in (${A.id}, ${B.id})
      order by tenant_id`;
    expect(audits).toHaveLength(2);
    expect(audits[0]).toMatchObject({
      actor_type: "system",
      actor_id: "retention",
      after_state: { count: 1, olderThanDays: 30 },
    });

    // A second run finds nothing more here.
    const again = await sql<{ tenant_id: string; redacted: number }>`
      select * from app.retention_redact_abandoned_checkouts(30, 5000)`.execute(runtime.db);
    expect(again.rows.filter((r) => r.tenant_id === A.id || r.tenant_id === B.id)).toEqual([]);

    // A late success on the redacted checkout's pending payment is refunded,
    // never booked under the redacted booker.
    const late = await provider.settlePayment(A.id, expired.paymentRef, "succeeded", Date.now());
    if (late.kind === "not_found") throw new Error("no fake payment");
    const handled = await handleVerifiedEvent(
      runtime.db,
      provider,
      await verifiedFakeEvent(provider, late.event.body),
      { requestId: `ret-late-${run}` },
    );
    expect(handled).toMatchObject({ outcome: "refund_required" });
    const [after] = await admin`select s.state,
        (select count(*)::int from public.bookings b where b.checkout_session_id = s.id) as bookings,
        (select reason from public.finalization_exceptions f where f.checkout_session_id = s.id) as reason
      from public.checkout_sessions s where s.id = ${expired.id}`;
    expect(after).toEqual({ state: "unfulfilled", bookings: 0, reason: "session_redacted" });
    expect(await booker(expired.id)).toMatchObject({ booker_name: "Redacted", redacted: true });
  });

  it("refuses any other redaction, for every role", async () => {
    const trips = tripAllocator(A);
    const run = randomUUID().slice(0, 8);
    const recent = await openCheckout(A, trips.shared(), `r2-${run}@example.test`);
    await backdateCheckout(admin, recent.id);
    await sweepCheckouts(runtime.db, { runId: `ret3-${run}`, provider });
    const kept = await confirmBooking(runtime.db, provider, A, trips.shared(), 1);
    await age(kept.checkoutSessionId, 40);
    const open = await openCheckout(A, trips.shared(), `open-${run}@example.test`);

    const redact = (id: string) =>
      admin`update public.checkout_sessions set booker_name = 'Redacted',
              booker_email = 'redacted@redacted.invalid', booker_redacted_at = now()
            where id = ${id}`;
    // Too recent, has a booking, still open.
    for (const id of [recent.id, kept.checkoutSessionId, open.id]) {
      expect(await failure(redact(id))).toEqual({
        code: "23514",
        constraint: "checkout_sessions_redaction",
      });
    }
    // Only the booker changes in a redaction.
    await age(recent.id, 40);
    expect(
      await failure(
        admin`update public.checkout_sessions set booker_name = 'Redacted',
                booker_email = 'redacted@redacted.invalid', booker_redacted_at = now(),
                party_size = party_size + 1
              where id = ${recent.id}`,
      ),
    ).toEqual({ code: "23514", constraint: "checkout_sessions_redaction" });
    // The fixed values only.
    expect(
      await failure(
        admin`update public.checkout_sessions set booker_name = 'Someone',
                booker_redacted_at = now() where id = ${recent.id}`,
      ),
    ).toMatchObject({ code: "23514" });
    await redact(recent.id);
    // Permanent, and an insert is never redacted.
    expect(
      await failure(
        admin`update public.checkout_sessions set booker_redacted_at = null where id = ${recent.id}`,
      ),
    ).toEqual({ code: "23514", constraint: "checkout_sessions_redaction" });
    expect(
      await failure(
        admin`update public.checkout_sessions set booker_name = 'Back Again' where id = ${recent.id}`,
      ),
    ).toMatchObject({ code: "23514" });
    // Nor is a booking ever written for it directly, whatever else it names.
    expect(
      await failure(
        admin`insert into public.bookings (tenant_id, checkout_session_id)
              values (${A.id}, ${recent.id})`,
      ),
    ).toEqual({ code: "23514", constraint: "checkout_sessions_redaction" });
    // A redacted checkout never becomes a booking, for every role.
    expect(
      await failure(
        admin`update public.checkout_sessions set state = 'confirmed', confirmed_at = now()
              where id = ${recent.id}`,
      ),
    ).toEqual({ code: "23514", constraint: "checkout_sessions_redaction" });
    // Out-of-range periods are refused, the floor being 30 days.
    expect(
      await failure(
        sql`select * from app.retention_redact_abandoned_checkouts(29, 10)`.execute(runtime.db),
      ),
    ).toEqual({ code: "22023" });
    expect(
      await failure(
        sql`select * from app.retention_redact_abandoned_checkouts(0, 10)`.execute(runtime.db),
      ),
    ).toEqual({ code: "22023" });
  });
});
