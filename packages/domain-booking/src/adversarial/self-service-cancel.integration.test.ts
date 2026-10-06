/**
 * Adversarial suite for cancellation within policy (lane 1, G2.11c), against
 * the contract in packages/domain-booking/README.md ("Cancellation within
 * policy", "Lock order") and migration 0008. A booking is canceled once, with
 * exactly one cancellation row, one refund row for the computed amount (basis
 * points of what was paid, half up), its hold released, and one cancellation
 * email. A late or duplicate payment event for a canceled booking changes
 * nothing. Refunds go out through the payment adapter with the refund row's
 * idempotency key, once.
 *
 * Races run real concurrent transactions against PostgreSQL as tidegrid_app.
 */
import { randomUUID } from "node:crypto";
import { createDb } from "@tidegrid/database";
import type {} from "@tidegrid/database/global-setup";
import { tripAllocator } from "@tidegrid/domain-inventory/testing";
import { enqueueMessage, FakeEmailProvider } from "@tidegrid/domain-messaging";
import { recordProviderEvent } from "@tidegrid/domain-payments";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";
import {
  type BookingHooks,
  type CancelBookingResult,
  cancelBooking,
  createCheckoutSession,
  getManagedBooking,
  previewCancellation,
  putParticipant,
  type SettleRefundResult,
  settleRefund,
  sweepCheckouts,
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
import { FlakyProvider, gate, RACE_ROUNDS, refusal, settle, startAt } from "./harness.ts";
import {
  asGuest,
  asSystem,
  type Booked,
  book,
  cancellationLedger,
  cancelStateOf,
  deliverEvent,
  departIn,
  halfUp,
  lateEventBody,
  outcomeOf,
  type SelfServiceWorld,
  seatsTaken,
  setPolicy,
  syntheticBooker,
} from "./self-service-harness.ts";

const env = inject("integrationDb");
const ROUNDS = Math.max(3, RACE_ROUNDS);

describe.skipIf(!env)("adversarial: cancellation within policy against late events", () => {
  let world: SelfServiceWorld;
  let runtime: ReturnType<typeof createDb>;
  let A: CheckoutFixture;
  let P: CheckoutFixture;
  let tripsA: ReturnType<typeof tripAllocator>;
  let tripsP: ReturnType<typeof tripAllocator>;

  const preview = (b: Booked) =>
    asGuest(world.db, b.tenant.id, (trx) => previewCancellation(trx, b.tenant.id, b.bookingId));

  const cancel = (b: Booked, expectedRefundAmount: number, hooks?: BookingHooks) =>
    asGuest(world.db, b.tenant.id, (trx, ctx) =>
      cancelBooking(trx, ctx, { bookingId: b.bookingId, expectedRefundAmount }, hooks),
    );

  async function termsFor(b: Booked) {
    const terms = await preview(b);
    if (!terms) throw new Error(`setup: no terms for ${b.bookingId}`);
    return terms;
  }

  const sweep = (provider: SelfServiceWorld["payments"] | FlakyProvider | null, errors: string[]) =>
    sweepCheckouts(world.db, {
      runId: `adv-sweep-${randomUUID()}`,
      provider,
      graceSeconds: 0,
      onError: (tenantId, item, error, id) => {
        if (tenantId === A.id || tenantId === P.id) {
          errors.push(`${item} ${id ?? ""}: ${String((error as Error)?.message ?? error)}`);
        }
      },
    });

  beforeAll(async () => {
    if (!env) return;
    const admin = postgres(env.adminUrl, { max: 4, onnotice: () => {} });
    runtime = createDb(env.runtimeUrl, { max: 14 });
    world = {
      admin,
      db: runtime.db,
      payments: fakeProvider(runtime.db),
      mail: new FakeEmailProvider({ db: runtime.db, environment: "local" }),
    };
    [A, P] = await Promise.all([
      createCheckoutFixture(admin, runtime.db, "ss-cxl-a", { days: 40 }),
      createCheckoutFixture(admin, runtime.db, "ss-cxl-p", { days: 12 }),
    ]);
    tripsA = tripAllocator(A);
    tripsP = tripAllocator(P);
  });

  afterAll(async () => {
    await runtime?.end();
    await world?.admin.end({ timeout: 5 });
  });

  it("cancels once while a replayed success, new successes, and a failure for its checkout race it", async () => {
    const seen: string[] = [];
    for (let round = 0; round < ROUNDS; round++) {
      const b = await book(world, A, tripsA.shared(), 2);
      const terms = await termsFor(b);
      expect(terms).toMatchObject({ cancelable: true, remedy: "full_refund", refundBp: 10000 });
      // Vary who reaches the checkout's lock first: the cancel, the events, or neither.
      const cancelDelay = [0, 25, 0][round % 3] ?? 0;
      const eventDelay = [25, 0, 0][round % 3] ?? 0;
      const go = gate();
      const racing = [
        startAt(go.opened, () => cancel(b, terms.refundAmount), cancelDelay),
        startAt(go.opened, () => deliverEvent(world, b.successBody), eventDelay),
        startAt(
          go.opened,
          () => deliverEvent(world, lateEventBody(b, "payment.succeeded")),
          eventDelay,
        ),
        startAt(go.opened, () => deliverEvent(world, lateEventBody(b, "payment.failed")), 0),
        startAt(
          go.opened,
          () => deliverEvent(world, lateEventBody(b, "payment.succeeded")),
          eventDelay,
        ),
      ] as const;
      go.open();
      const [canceled, replay, late1, failure, late2] = await Promise.all(racing);
      // No deadlock, serialization failure, or refusal lost any of the work.
      for (const r of [canceled, replay, late1, failure, late2]) {
        if (!r.ok) throw new Error(`round ${round}: ${r.code} ${r.constraint} ${r.message}`);
      }
      if (!canceled.ok || !replay.ok || !late1.ok || !failure.ok || !late2.ok) return;
      expect(canceled.value.kind).toBe("canceled");
      expect(replay.value).toMatchObject({ kind: "processed", duplicate: true });
      expect(outcomeOf(late1.value)).toBe("already_succeeded");
      expect(outcomeOf(late2.value)).toBe("already_succeeded");
      expect(outcomeOf(failure.value)).toBe("ignored_after_success");
      seen.push(outcomeOf(replay.value));

      const state = await cancelStateOf(world.admin, b.bookingId);
      expect(state).toMatchObject({
        booking: "canceled",
        hold: "released",
        payment: "succeeded",
        order: "paid",
        checkout: "confirmed",
        cancellations: 1,
        exceptions: 0,
        confirmationEmails: 1,
        cancellationEmails: 1,
      });
      expect(state.refunds).toEqual([
        expect.objectContaining({
          state: "requested",
          amount: terms.refundAmount,
          reason: "booking_canceled",
        }),
      ]);

      // The refund goes out once; every event delivered again changes nothing.
      const refundId = state.refunds[0]?.id ?? "";
      expect(
        (await settleRefund(world.db, world.payments, guestContext(A.id), refundId)).kind,
      ).toBe("succeeded");
      for (const body of [
        b.successBody,
        lateEventBody(b, "payment.succeeded"),
        lateEventBody(b, "payment.failed"),
      ]) {
        const again = await deliverEvent(world, body);
        expect(["confirmed", "already_succeeded", "ignored_after_success"]).toContain(
          outcomeOf(again),
        );
      }
      const after = await cancelStateOf(world.admin, b.bookingId);
      expect(after).toMatchObject({ booking: "canceled", cancellations: 1, fakeRefunds: 1 });
      expect(after.refunds).toHaveLength(1);
      expect(after.refunds[0]?.state).toBe("succeeded");
    }
    expect(seen.every((o) => o === "confirmed")).toBe(true);
    expect(await cancellationLedger(world.admin, [A.id])).toEqual([]);
  }, 300_000);

  it("cancels once while overlapping sweeps reprocess stranded events and resend refunds", async () => {
    const errors: string[] = [];
    for (let round = 0; round < ROUNDS; round++) {
      const b = await book(world, A, tripsA.shared(), 1);
      const terms = await termsFor(b);
      // Two events the request that verified them never processed: the sweep owns them.
      const stranded: string[] = [];
      for (const type of ["payment.succeeded", "payment.failed"] as const) {
        const event = await verifiedFakeEvent(world.payments, lateEventBody(b, type));
        const recorded = await asSystem(world.db, A.id, (trx, ctx) =>
          recordProviderEvent(trx, ctx, event),
        );
        stranded.push(recorded.inboxId);
      }
      const go = gate();
      const racing = [
        startAt(go.opened, () => cancel(b, terms.refundAmount), round % 2 === 0 ? 0 : 30),
        startAt(go.opened, () => sweep(world.payments, errors)),
        startAt(go.opened, () => sweep(world.payments, errors), 10),
      ] as const;
      go.open();
      const [canceled, first, second] = await Promise.all(racing);
      for (const r of [canceled, first, second]) {
        if (!r.ok) throw new Error(`round ${round}: ${r.code} ${r.constraint} ${r.message}`);
      }
      if (!canceled.ok) return;
      expect(canceled.value.kind).toBe("canceled");

      const outcomes = await world.admin<{ processing_state: string; outcome: string | null }[]>`
        select processing_state, outcome from public.provider_events
         where id in ${world.admin(stranded)} order by event_type desc`;
      expect(outcomes).toEqual([
        { processing_state: "processed", outcome: "already_succeeded" },
        { processing_state: "processed", outcome: "ignored_after_success" },
      ]);
      // Whatever the sweeps settled, one more finishes the rest, with the same key.
      await sweep(world.payments, errors);
      const state = await cancelStateOf(world.admin, b.bookingId);
      expect(state).toMatchObject({
        booking: "canceled",
        payment: "succeeded",
        cancellations: 1,
        exceptions: 0,
        fakeRefunds: 1,
        fakeRefunded: terms.refundAmount,
        cancellationEmails: 1,
      });
      expect(state.refunds.map((r) => r.state)).toEqual(["succeeded"]);
      const [fake] = await world.admin<{ idempotency_key: string; id: string }[]>`
        select idempotency_key, id from public.fake_provider_refunds
         where tenant_id = ${A.id} and payment_id = ${b.providerPaymentId}`;
      expect(fake).toEqual({
        idempotency_key: state.refunds[0]?.idempotencyKey,
        id: state.refunds[0]?.providerRefundId,
      });
    }
    expect(errors).toEqual([]);
    expect(await cancellationLedger(world.admin, [A.id])).toEqual([]);
  }, 300_000);

  it("orders participant changes against a cancellation: whichever commits second sees the other", async () => {
    for (let round = 0; round < ROUNDS + 1; round++) {
      const b = await book(world, A, tripsA.shared(), 3);
      const terms = await termsFor(b);
      const name = (position: number) =>
        asGuest(world.db, A.id, (trx, ctx) =>
          putParticipant(trx, ctx, {
            bookingId: b.bookingId,
            position,
            details: { name: `Synthetic Rider ${round}-${position}`, isMinor: false },
          }),
        );
      const go = gate();
      const racing = [
        startAt(go.opened, () => cancel(b, terms.refundAmount), [0, 20, 5, 0][round % 4]),
        startAt(go.opened, () => name(1), [20, 0, 0, 5][round % 4]),
        startAt(go.opened, () => name(2), [20, 0, 5, 0][round % 4]),
      ] as const;
      go.open();
      const [canceled, one, two] = await Promise.all(racing);
      for (const r of [canceled, one, two]) {
        if (!r.ok) throw new Error(`round ${round}: ${r.code} ${r.constraint} ${r.message}`);
      }
      if (!canceled.ok || !one.ok || !two.ok) return;
      expect(canceled.value.kind).toBe("canceled");
      const created = [one.value, two.value].filter((r) => r.kind === "created").length;
      for (const r of [one.value, two.value]) {
        expect(["created", "booking_canceled"]).toContain(r.kind);
      }
      // Exactly the participants the service said it named exist, each with its
      // audit row; a refused one left nothing. (Stamps are transaction starts,
      // so they do not order commits: a participant that won the booking's lock
      // may carry a later instant than the cancellation that waited for it.)
      const [stored] = await world.admin<{ participants: number; audits: number }[]>`
        select (select count(*)::int from public.booking_participants
                 where booking_id = ${b.bookingId}) as participants,
               (select count(*)::int from public.audit_events a
                  join public.booking_participants p on p.id::text = a.subject_id
                 where p.booking_id = ${b.bookingId} and a.action = 'participant.added') as audits`;
      expect(stored).toEqual({ participants: created, audits: created });
      expect(await cancelStateOf(world.admin, b.bookingId)).toMatchObject({
        booking: "canceled",
        cancellations: 1,
      });
    }
  }, 300_000);

  it("refuses a participant on a canceled booking for every role, the owner included", async () => {
    const b = await book(world, A, tripsA.shared(), 2);
    const named = await asGuest(world.db, A.id, (trx, ctx) =>
      putParticipant(trx, ctx, {
        bookingId: b.bookingId,
        position: 1,
        details: { name: "Synthetic Named", isMinor: false },
      }),
    );
    expect(named.kind).toBe("created");
    const terms = await termsFor(b);
    expect((await cancel(b, terms.refundAmount)).kind).toBe("canceled");
    expect(
      await refusal(world.admin`insert into public.booking_participants
          (tenant_id, booking_id, position, full_name, is_minor)
        values (${A.id}, ${b.bookingId}, 2, 'Synthetic Late', false)`),
    ).toEqual({ code: "23514", constraint: "booking_participants_booking_open" });
    expect(
      await refusal(world.admin`update public.booking_participants set full_name = 'Synthetic Edit'
         where booking_id = ${b.bookingId} and position = 1`),
    ).toEqual({ code: "23514", constraint: "booking_participants_booking_open" });
    // The canceled booking cannot come back, for any role.
    expect(
      await refusal(
        world.admin`update public.bookings set state = 'confirmed' where id = ${b.bookingId}`,
      ),
    ).toEqual({ code: "23514", constraint: "bookings_transition" });
  });

  it("answers a double cancel with the first record, whatever amount the second one names", async () => {
    const b = await book(world, A, tripsA.shared(), 2);
    const terms = await termsFor(b);
    const go = gate();
    const amounts = [
      terms.refundAmount,
      terms.refundAmount + 1,
      0,
      terms.refundAmount,
      terms.refundAmount - 1,
    ];
    const racing = amounts.map((amount, i) => startAt(go.opened, () => cancel(b, amount), i * 3));
    go.open();
    const results = await Promise.all(racing);
    const kinds: CancelBookingResult["kind"][] = [];
    for (const r of results) {
      if (!r.ok) throw new Error(`${r.code} ${r.constraint} ${r.message}`);
      kinds.push(r.value.kind);
    }
    expect(kinds.filter((k) => k === "canceled")).toHaveLength(1);
    // Before the winner commits a wrong amount is told the terms; after, the booking is canceled.
    expect(kinds.every((k) => ["canceled", "already_canceled", "terms_changed"].includes(k))).toBe(
      true,
    );
    const winner = results.flatMap((r) =>
      r.ok && r.value.kind === "canceled" ? [r.value.cancellation] : [],
    )[0];
    for (const amount of [terms.refundAmount, 0, 999_999]) {
      const again = await cancel(b, amount);
      expect(again).toEqual({ kind: "already_canceled", cancellation: winner });
    }
    const state = await cancelStateOf(world.admin, b.bookingId);
    expect(state).toMatchObject({ cancellations: 1, cancellationEmails: 1, hold: "released" });
    expect(state.refunds).toHaveLength(1);
    const [audit] = await world.admin<{ n: number }[]>`
      select count(*)::int as n from public.audit_events
       where subject_id = ${b.bookingId} and action = 'booking.canceled'`;
    expect(audit?.n).toBe(1);
  });

  it("changes nothing when the cutoff passes before the cancel, then cancels with no refund row", async () => {
    const tripId = tripsA.shared();
    const b = await book(world, A, tripId, 2);
    const before = await termsFor(b);
    expect(before).toMatchObject({ remedy: "full_refund", beforeCutoff: true, cancelable: true });
    // Twelve hours to departure: the 24-hour cutoff passed while the guest looked at the terms.
    await departIn(world.admin, tripId, 12 * 60);
    const changed = await cancel(b, before.refundAmount);
    expect(changed).toMatchObject({
      kind: "terms_changed",
      terms: { remedy: "none", refundBp: 0, refundAmount: 0, beforeCutoff: false },
    });
    const untouched = await cancelStateOf(world.admin, b.bookingId);
    expect(untouched).toMatchObject({
      booking: "confirmed",
      hold: "confirmed",
      cancellations: 0,
      cancellationEmails: 0,
    });
    expect(untouched.refunds).toEqual([]);
    expect(await seatsTaken(world.admin, tripId)).toBe(2);

    const canceled = await cancel(b, 0);
    expect(canceled).toMatchObject({
      kind: "canceled",
      cancellation: { remedy: "none", refundBp: 0, refundAmount: 0, refundId: null },
    });
    const after = await cancelStateOf(world.admin, b.bookingId);
    expect(after).toMatchObject({
      booking: "canceled",
      hold: "released",
      cancellations: 1,
      cancellationEmails: 1,
      fakeRefunds: 0,
    });
    expect(after.refunds).toEqual([]);
    expect(await seatsTaken(world.admin, tripId)).toBe(0);
    const [row] = await world.admin<
      { before_cutoff: boolean; cutoff_ok: boolean; refund_id: string | null }[]
    >`
      select c.before_cutoff, c.cutoff_at = c.departs_at - interval '1440 minutes' as cutoff_ok,
             c.refund_id
        from public.booking_cancellations c where c.booking_id = ${b.bookingId}`;
    expect(row).toEqual({ before_cutoff: false, cutoff_ok: true, refund_id: null });
    // Nothing is owed, so no role may write a refund for it.
    expect(
      await refusal(world.admin`insert into public.payment_refunds
          (tenant_id, payment_id, amount, currency, reason, idempotency_key)
        values (${A.id}, ${b.paymentId}, 1, 'USD', 'booking_canceled', ${`adv:${randomUUID()}`})`),
    ).toEqual({ code: "23514", constraint: "payment_refunds_payment" });
  });

  it("refuses to cancel or change the party once the trip has departed, in the service and the database", async () => {
    const tripId = tripsA.shared();
    const b = await book(world, A, tripId, 2);
    const named = await asGuest(world.db, A.id, (trx, ctx) =>
      putParticipant(trx, ctx, {
        bookingId: b.bookingId,
        position: 1,
        details: { name: "Synthetic Aboard", isMinor: false },
      }),
    );
    expect(named.kind).toBe("created");
    await departIn(world.admin, tripId, -3 * 24 * 60);
    const terms = await termsFor(b);
    expect(terms).toMatchObject({ cancelable: false, refusal: "trip_departed" });
    expect(await cancel(b, terms.refundAmount)).toEqual({ kind: "trip_departed" });
    expect(await cancel(b, 0)).toEqual({ kind: "trip_departed" });
    for (const position of [1, 2]) {
      expect(
        await asGuest(world.db, A.id, (trx, ctx) =>
          putParticipant(trx, ctx, {
            bookingId: b.bookingId,
            position,
            details: { name: "Synthetic Too Late", isMinor: false },
          }),
        ),
      ).toEqual({ kind: "trip_departed" });
    }
    const view = await asGuest(world.db, A.id, (trx) => getManagedBooking(trx, A.id, b.bookingId));
    expect(view).toMatchObject({ partyEditable: false, cancellation: { cancelable: false } });
    // A writer that skips the service cannot cancel a departed trip's booking either.
    expect(
      await refusal(world.admin`insert into public.booking_cancellations (tenant_id, booking_id,
          payment_id, product_id, policy_version, departs_at, cutoff_at, before_cutoff, remedy,
          refund_bp, paid_amount, refund_amount)
        select b.tenant_id, b.id, b.payment_id, o.product_id, o.policy_version, t.starts_at,
               t.starts_at - make_interval(mins => v.change_cutoff_minutes), false, 'none', 0,
               p.amount, 0
          from public.bookings b
          join public.orders o on o.id = b.order_id
          join public.scheduled_trips t on t.id = b.trip_id
          join public.payments p on p.id = b.payment_id
          join public.policy_versions v on v.tenant_id = o.tenant_id
               and v.product_id = o.product_id and v.version = o.policy_version
         where b.id = ${b.bookingId}`),
    ).toEqual({ code: "23514", constraint: "booking_cancellations_departed" });
    const state = await cancelStateOf(world.admin, b.bookingId);
    expect(state).toMatchObject({
      booking: "confirmed",
      hold: "confirmed",
      cancellations: 0,
      participants: 1,
    });
  });

  it("settles a refund once under concurrent settles, overlapping sweeps, and a provider that loses answers", async () => {
    const errors: string[] = [];
    const cancelled = async () => {
      const b = await book(world, A, tripsA.shared(), 2);
      const terms = await termsFor(b);
      const canceled = await cancel(b, terms.refundAmount);
      if (canceled.kind !== "canceled" || !canceled.cancellation.refundId) {
        throw new Error(`setup cancel: ${JSON.stringify(canceled)}`);
      }
      return { b, terms, refundId: canceled.cancellation.refundId };
    };

    // Six settles at once: one records the outcome, the provider refunds once.
    const one = await cancelled();
    const go = gate();
    const racing = Array.from({ length: 6 }, (_, i) =>
      startAt(
        go.opened,
        () => settleRefund(world.db, world.payments, guestContext(A.id), one.refundId),
        i % 3,
      ),
    );
    go.open();
    const settles = await Promise.all(racing);
    const kinds: SettleRefundResult["kind"][] = [];
    for (const r of settles) {
      if (!r.ok) throw new Error(`${r.code} ${r.message}`);
      kinds.push(r.value.kind);
    }
    expect(kinds.filter((k) => k === "succeeded")).toHaveLength(1);
    expect(kinds.filter((k) => k === "not_pending")).toHaveLength(5);
    const settled = await cancelStateOf(world.admin, one.b.bookingId);
    expect(settled).toMatchObject({ fakeRefunds: 1, fakeRefunded: one.terms.refundAmount });
    const [audits] = await world.admin<{ n: number }[]>`
      select count(*)::int as n from public.audit_events
       where subject_id = ${one.refundId} and action = 'payment_refund.succeeded'`;
    expect(audits?.n).toBe(1);

    // The provider refunded, then the answer was lost: the sweep asks again with the same key.
    const lost = await cancelled();
    const losing = new FlakyProvider(world.payments);
    losing.failRefund = "after";
    expect(await settleRefund(world.db, losing, guestContext(A.id), lost.refundId)).toEqual({
      kind: "unknown",
    });
    const pending = await cancelStateOf(world.admin, lost.b.bookingId);
    expect(pending.refunds.map((r) => r.state)).toEqual(["requested"]);
    expect(pending.fakeRefunds).toBe(1);
    await sweep(world.payments, errors);
    const recovered = await cancelStateOf(world.admin, lost.b.bookingId);
    expect(recovered.refunds.map((r) => r.state)).toEqual(["succeeded"]);
    expect(recovered).toMatchObject({ fakeRefunds: 1, fakeRefunded: lost.terms.refundAmount });

    // The provider never answered: two overlapping sweeps send it once, with its key.
    const silent = await cancelled();
    const down = new FlakyProvider(world.payments);
    down.failRefund = "before";
    expect(await settleRefund(world.db, down, guestContext(A.id), silent.refundId)).toEqual({
      kind: "unknown",
    });
    expect((await cancelStateOf(world.admin, silent.b.bookingId)).fakeRefunds).toBe(0);
    const go2 = gate();
    const sweeps = [
      startAt(go2.opened, () => sweep(world.payments, errors)),
      startAt(go2.opened, () => sweep(world.payments, errors), 5),
    ];
    go2.open();
    for (const r of await Promise.all(sweeps)) {
      if (!r.ok) throw new Error(`${r.code} ${r.message}`);
    }
    const sent = await cancelStateOf(world.admin, silent.b.bookingId);
    expect(sent.refunds.map((r) => r.state)).toEqual(["succeeded"]);
    expect(sent).toMatchObject({ fakeRefunds: 1, fakeRefunded: silent.terms.refundAmount });
    const [fake] = await world.admin<{ idempotency_key: string }[]>`
      select idempotency_key from public.fake_provider_refunds
       where tenant_id = ${A.id} and payment_id = ${silent.b.providerPaymentId}`;
    expect(fake?.idempotency_key).toBe(sent.refunds[0]?.idempotencyKey);
    expect(errors).toEqual([]);
    expect(await cancellationLedger(world.admin, [A.id])).toEqual([]);
  }, 300_000);

  it("keeps a refused refund failed and visible to the guest, and the sweep never sends it again", async () => {
    const errors: string[] = [];
    const b = await book(world, A, tripsA.shared(), 1);
    const terms = await termsFor(b);
    const canceled = await cancel(b, terms.refundAmount);
    if (canceled.kind !== "canceled" || !canceled.cancellation.refundId) {
      throw new Error("setup cancel");
    }
    const refusing = new FlakyProvider(world.payments);
    refusing.failRefund = "reject";
    expect(
      await settleRefund(world.db, refusing, guestContext(A.id), canceled.cancellation.refundId),
    ).toEqual({ kind: "failed", failureCode: "simulated_refusal" });
    await sweep(world.payments, errors);
    expect(
      await settleRefund(
        world.db,
        world.payments,
        guestContext(A.id),
        canceled.cancellation.refundId,
      ),
    ).toEqual({ kind: "not_pending" });
    const state = await cancelStateOf(world.admin, b.bookingId);
    expect(state.refunds).toEqual([
      expect.objectContaining({ state: "failed", failureCode: "simulated_refusal" }),
    ]);
    expect(state.fakeRefunds).toBe(0);
    const view = await asGuest(world.db, A.id, (trx) => getManagedBooking(trx, A.id, b.bookingId));
    expect(view?.booking.refund).toMatchObject({
      state: "failed",
      amount: terms.refundAmount,
      failureCode: "simulated_refusal",
    });
    expect(errors).toEqual([]);
  });

  it("rounds odd cents half up from each booking's own policy version, and the database refuses any other amount", async () => {
    // Learn what a one-adult booking with the promotion pays, then choose basis
    // points that land exactly on a half cent, just below it, and just above it.
    const probe = await quoteFor(world.db, P.id, tripsP.shared(), 1, {
      promotionCode: P.promotionCode,
    });
    const paid = probe.totals.total;
    // Search from 20%, so each of these refunds something.
    const pick = (want: (rest: number) => boolean) => {
      for (let bp = 2000; bp <= 9999; bp++) if (want((paid * bp) % 10000)) return bp;
      throw new Error(`no basis points give the wanted remainder for ${paid}`);
    };
    const cases = [
      { label: "exact half", bp: pick((rest) => rest === 5000) },
      { label: "below half", bp: pick((rest) => rest > 0 && rest < 5000) },
      { label: "above half", bp: pick((rest) => rest > 5000) },
      // One basis point of a payment under fifty dollars is under half a cent: nothing back.
      ...(paid < 5000 ? [{ label: "rounds to nothing", bp: 1 }] : []),
    ];
    const booked: { label: string; bp: number; version: number; b: Booked }[] = [];
    for (const c of cases) {
      // Thirty days' cutoff: every fixture trip is past it, so the percent applies.
      const version = await setPolicy(world, P, "shared", {
        changeCutoffMinutes: 43_200,
        beforeCutoff: { remedy: "full_refund" },
        afterCutoff: { remedy: "percent_refund", refundBp: c.bp },
      });
      const b = await book(world, P, tripsP.shared(), 1, { promotion: true });
      expect(b.amount).toBe(paid);
      booked.push({ ...c, version, b });
    }
    // A later policy version changes nothing for bookings made under earlier ones.
    await setPolicy(world, P, "shared", {
      changeCutoffMinutes: 43_200,
      beforeCutoff: { remedy: "full_refund" },
      afterCutoff: { remedy: "full_refund" },
    });
    for (const { label, bp, version, b } of booked) {
      const terms = await termsFor(b);
      const want = halfUp(paid, bp);
      expect({ label, ...terms }).toMatchObject({
        label,
        remedy: "percent_refund",
        refundBp: bp,
        paidAmount: paid,
        refundAmount: want,
        policyVersion: version,
        beforeCutoff: false,
      });
      if (label === "exact half") expect(want * 10000).toBe(paid * bp + 5000);
      if (label === "below half") expect(want).toBe(Math.floor((paid * bp) / 10000));
      if (label === "above half") expect(want).toBe(Math.ceil((paid * bp) / 10000));
      if (label === "rounds to nothing") expect(want).toBe(0);
    }
    // The database is the judge: a truncated amount, or another rate, is refused for the owner too.
    const half = booked[0];
    if (!half) throw new Error("setup: no half case");
    const truncated = Math.floor((paid * half.bp) / 10000);
    const insertTerms = (bp: number, amount: number) =>
      world.admin`insert into public.booking_cancellations (tenant_id, booking_id, payment_id,
          product_id, policy_version, departs_at, cutoff_at, before_cutoff, remedy, refund_bp,
          paid_amount, refund_amount, refund_id)
        select b.tenant_id, b.id, b.payment_id, o.product_id, o.policy_version, t.starts_at,
               t.starts_at - make_interval(mins => v.change_cutoff_minutes),
               now() < t.starts_at - make_interval(mins => v.change_cutoff_minutes),
               'percent_refund', ${bp}, p.amount, ${amount}, ${randomUUID()}::uuid
          from public.bookings b
          join public.orders o on o.id = b.order_id
          join public.scheduled_trips t on t.id = b.trip_id
          join public.payments p on p.id = b.payment_id
          join public.policy_versions v on v.tenant_id = o.tenant_id
               and v.product_id = o.product_id and v.version = o.policy_version
         where b.id = ${half.b.bookingId}`;
    expect((await refusal(insertTerms(half.bp, truncated))).code).toBe("23514");
    const otherBp = half.bp === 9999 ? 9998 : half.bp + 1;
    expect(await refusal(insertTerms(otherBp, halfUp(paid, otherBp)))).toEqual({
      code: "23514",
      constraint: "booking_cancellations_terms",
    });

    for (const { label, b } of booked) {
      const terms = await termsFor(b);
      const canceled = await cancel(b, terms.refundAmount);
      expect(canceled).toMatchObject({
        kind: "canceled",
        cancellation: {
          remedy: "percent_refund",
          refundAmount: terms.refundAmount,
          refundBp: terms.refundBp,
        },
      });
      if (canceled.kind !== "canceled") throw new Error("expected a cancellation");
      if (label === "rounds to nothing") {
        // A percent that rounds to no cents writes no refund row and moves no money.
        expect(canceled.cancellation.refundId).toBeNull();
        const state = await cancelStateOf(world.admin, b.bookingId);
        expect(state).toMatchObject({ booking: "canceled", hold: "released", fakeRefunds: 0 });
        expect(state.refunds).toEqual([]);
        continue;
      }
      if (!canceled.cancellation.refundId) throw new Error(`${label}: expected a refund`);
      expect(
        (
          await settleRefund(
            world.db,
            world.payments,
            guestContext(P.id),
            canceled.cancellation.refundId,
          )
        ).kind,
      ).toBe("succeeded");
      expect(await cancelStateOf(world.admin, b.bookingId)).toMatchObject({
        fakeRefunds: 1,
        fakeRefunded: terms.refundAmount,
      });
    }
    expect(await cancellationLedger(world.admin, [P.id])).toEqual([]);
  });

  it("rolls the whole cancellation back when its hook throws, and commits what a hook writes with it", async () => {
    const tripId = tripsA.shared();
    const b = await book(world, A, tripId, 2);
    const terms = await termsFor(b);
    const throwing: BookingHooks = {
      bookingCanceled: async (trx, ctx) => {
        await enqueueMessage(trx, ctx, {
          dedupeKey: `adv.cancel_hook:${b.bookingId}`,
          template: "adv_cancel_hook",
          templateVersion: 1,
          to: { email: "hook.observer@example.test" },
          bookingId: b.bookingId,
          content: { subject: "Hook ran", blocks: [{ kind: "paragraph", text: "Synthetic." }] },
        });
        throw new Error("the waiver module failed");
      },
    };
    const failed = await settle(cancel(b, terms.refundAmount, throwing));
    expect(failed.ok).toBe(false);
    const untouched = await cancelStateOf(world.admin, b.bookingId);
    expect(untouched).toMatchObject({
      booking: "confirmed",
      hold: "confirmed",
      cancellations: 0,
      cancellationEmails: 0,
    });
    expect(untouched.refunds).toEqual([]);
    expect(await seatsTaken(world.admin, tripId)).toBe(2);
    const [left] = await world.admin<{ messages: number; audits: number; events: number }[]>`
      select (select count(*)::int from public.email_messages
               where dedupe_key = ${`adv.cancel_hook:${b.bookingId}`}) as messages,
             (select count(*)::int from public.audit_events
               where subject_id = ${b.bookingId} and action = 'booking.canceled') as audits,
             (select count(*)::int from public.outbox_events
               where topic = 'booking.canceled' and payload->>'bookingId' = ${b.bookingId}) as events`;
    expect(left).toEqual({ messages: 0, audits: 0, events: 0 });

    const heard: { cancellationId: string; refundId: string | null }[] = [];
    const writing: BookingHooks = {
      bookingCanceled: async (trx, ctx, event) => {
        heard.push({ cancellationId: event.cancellationId, refundId: event.refundId });
        await enqueueMessage(trx, ctx, {
          dedupeKey: `adv.cancel_hook:${b.bookingId}`,
          template: "adv_cancel_hook",
          templateVersion: 1,
          to: { email: "hook.observer@example.test" },
          bookingId: b.bookingId,
          content: { subject: "Hook ran", blocks: [{ kind: "paragraph", text: "Synthetic." }] },
        });
      },
    };
    const canceled = await cancel(b, terms.refundAmount, writing);
    if (canceled.kind !== "canceled") throw new Error(`cancel: ${JSON.stringify(canceled)}`);
    const [ids] = await world.admin<{ cancellation_id: string; refund_id: string }[]>`
      select c.id as cancellation_id, r.id as refund_id
        from public.booking_cancellations c
        join public.payment_refunds r on r.id = c.refund_id
       where c.booking_id = ${b.bookingId}`;
    expect(heard).toEqual([{ cancellationId: ids?.cancellation_id, refundId: ids?.refund_id }]);
    const [written] = await world.admin<{ n: number }[]>`
      select count(*)::int as n from public.email_messages
       where dedupe_key = ${`adv.cancel_hook:${b.bookingId}`}`;
    expect(written?.n).toBe(1);
  });

  it("gives the seats back to sale: a full trip takes a new party only after a cancellation", async () => {
    const tripId = tripsA.shared();
    const big = await book(world, A, tripId, 8);
    await book(world, A, tripId, 2);
    expect(await seatsTaken(world.admin, tripId)).toBe(10);
    const attempt = async (party: number) => {
      const quoted = await settle(quoteFor(world.db, A.id, tripId, party));
      if (!quoted.ok) return "quote_refused";
      const quote = quoted.value;
      const created = await asGuest(world.db, A.id, (trx, ctx) =>
        createCheckoutSession(trx, ctx, {
          quoteId: quote.quoteId,
          acceptedPolicyVersion: quote.policy.version,
          booker: syntheticBooker("waiting"),
          secret: newSecret(),
          clientAddress: null,
          provider: "fake",
          minimumAmount: 50,
        }),
      );
      return created.kind;
    };
    expect(await attempt(1)).not.toBe("created");
    const terms = await termsFor(big);
    expect((await cancel(big, terms.refundAmount)).kind).toBe("canceled");
    expect(await seatsTaken(world.admin, tripId)).toBe(2);
    expect(await attempt(8)).toBe("created");
    expect(await seatsTaken(world.admin, tripId)).toBe(10);
  });
});
