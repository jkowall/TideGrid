/**
 * Adversarial suite for the guest's cancellation and party through the API
 * (lane 1, G2.11c): POST /v1/public/manage/cancellation, its terms, PUT
 * /v1/public/manage/participants/{position}, and the payment webhook after a
 * cancellation. Contracts: packages/contracts/src/self-service.ts and
 * participants.ts, packages/domain-booking/README.md ("Cancellation within
 * policy"), and migration 0009.
 *
 * A booking is canceled once: a repeat with the same key replays, with any
 * other key answers 200 with the canceled booking; one cancellation row, one
 * refund for the computed amount, seats released, one cancellation email. A
 * late or duplicate payment event for a canceled booking changes nothing.
 * Synthetic data only.
 */
import { randomUUID } from "node:crypto";
import { createDb, inTenantTransaction, type TenantContext } from "@tidegrid/database";
import type {} from "@tidegrid/database/global-setup";
import { sweepCheckouts } from "@tidegrid/domain-booking";
import {
  type CheckoutFixture,
  confirmBooking,
  craftedFakeEventBody,
  createCheckoutFixture,
  fakeProvider,
  TEST_FAKE_SECRET,
} from "@tidegrid/domain-booking/testing";
import { tripAllocator } from "@tidegrid/domain-inventory/testing";
import {
  createFakePaymentProvider,
  type FakePaymentProvider,
  type PaymentProvider,
  ProviderUnavailableError,
  signatureHeaderValue,
} from "@tidegrid/domain-payments";
import { createPolicyVersion } from "@tidegrid/domain-pricing";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";
import { createApp } from "../src/app.ts";

type Sql = ReturnType<typeof postgres>;
// biome-ignore lint/suspicious/noExplicitAny: response bodies are checked field by field.
type Json = Record<string, any>;

const env = inject("integrationDb");

interface Tenant extends CheckoutFixture {
  host: string;
}

/** The fake provider, except that refunds never get an answer. */
function refundsUnanswered(real: FakePaymentProvider): PaymentProvider {
  return {
    name: real.name,
    signatureHeader: real.signatureHeader,
    minimumAmount: (currency) => real.minimumAmount(currency),
    createPayment: (input) => real.createPayment(input),
    retrievePayment: (input) => real.retrievePayment(input),
    refundPayment: async () => {
      throw new ProviderUnavailableError("simulated outage: the refund call timed out");
    },
    verifyWebhook: (input) => real.verifyWebhook(input),
  };
}

describe.skipIf(!env)("adversarial: guest cancellation and party through the API", () => {
  let admin: Sql;
  let runtime: ReturnType<typeof createDb>;
  let app: ReturnType<typeof createApp>;
  let appRefundsDown: ReturnType<typeof createApp>;
  let payments: FakePaymentProvider;
  let A: Tenant;
  let C: Tenant;
  let tripsA: ReturnType<typeof tripAllocator>;
  let tripsC: ReturnType<typeof tripAllocator>;
  let bookerCount = 0;

  const bindings = () => ({
    ENVIRONMENT: "local" as const,
    BUILD_ID: "integration",
    DATABASE_URL: env?.runtimeUrl ?? "",
    ALLOWED_ORIGINS: "https://console.test",
    STAFF_ORIGINS: "https://console.test",
    PAYMENT_PROVIDER: "fake",
    FAKE_PAYMENT_WEBHOOK_SECRET: TEST_FAKE_SECRET,
    EMAIL_PROVIDER: "fake",
    GUEST_LINK_ORIGIN: "https://{slug}.book.example.test",
  });
  const executionCtx = { waitUntil: () => {}, passThroughOnException: () => {}, props: {} };

  async function request(
    method: string,
    path: string,
    opts: {
      origin?: string;
      body?: unknown;
      raw?: string;
      headers?: Record<string, string>;
      via?: ReturnType<typeof createApp>;
    } = {},
  ) {
    const headers = new Headers(opts.headers);
    if (opts.origin) headers.set("origin", opts.origin);
    if (opts.body !== undefined || opts.raw !== undefined) {
      headers.set("content-type", "application/json");
    }
    const res = await (opts.via ?? app).request(
      `http://localhost${path}`,
      {
        method,
        headers,
        body: opts.raw ?? (opts.body === undefined ? null : JSON.stringify(opts.body)),
      },
      bindings(),
      executionCtx,
    );
    const text = await res.text();
    let json: Json = {};
    try {
      json = text ? (JSON.parse(text) as Json) : {};
    } catch {
      json = { text };
    }
    return { status: res.status, headers: res.headers, json, text };
  }

  const guest = (t: Tenant) => `https://${t.host}`;
  const bearer = (token: string) => ({ authorization: `Bearer ${token}` });

  function booker(label: string) {
    bookerCount += 1;
    return {
      name: `Synthetic ${label} ${bookerCount}`,
      email: `synthetic.${label}.${bookerCount}@example.test`,
    };
  }

  async function booked(t: Tenant, party = 2, trip?: string) {
    const tripId = trip ?? (t === A ? tripsA : tripsC).shared();
    const made = await confirmBooking(runtime.db, payments, t, tripId, party, {
      booker: booker("canceler"),
    });
    const res = await request(
      "POST",
      `/v1/public/checkout-sessions/${made.checkoutSessionId}/manage-session`,
      { origin: guest(t), headers: bearer(made.secret) },
    );
    if (res.status !== 201) throw new Error(`setup session: ${res.status} ${res.text}`);
    return { ...made, tripId, session: res.json.session.token as string };
  }

  const terms = async (t: Tenant, session: string) => {
    const res = await request("GET", "/v1/public/manage/cancellation", {
      origin: guest(t),
      headers: bearer(session),
    });
    if (res.status !== 200) throw new Error(`terms: ${res.status} ${res.text}`);
    return res.json.terms;
  };

  const cancel = (
    t: Tenant,
    session: string,
    expectedRefundAmount: number,
    key = `adv-${randomUUID()}`,
    via?: ReturnType<typeof createApp>,
  ) =>
    request("POST", "/v1/public/manage/cancellation", {
      origin: guest(t),
      headers: { ...bearer(session), "idempotency-key": key },
      body: { expectedRefundAmount },
      ...(via ? { via } : {}),
    });

  const putParticipant = (
    t: Tenant,
    session: string,
    position: number | string,
    body: unknown,
    key = `adv-${randomUUID()}`,
  ) =>
    request("PUT", `/v1/public/manage/participants/${position}`, {
      origin: guest(t),
      headers: { ...bearer(session), "idempotency-key": key },
      body,
    });

  async function stored(bookingId: string) {
    const [row] = await admin<
      {
        state: string;
        hold: string;
        payment: string;
        order: string;
        cancellations: number;
        refunds: number;
        refund_state: string | null;
        refund_amount: number | null;
        refund_key: string | null;
        fake_refunds: number;
        fake_key: string | null;
        exceptions: number;
        confirmations: number;
        cancellation_emails: number;
        participants: number;
      }[]
    >`
      select b.state, h.state as hold, p.state as payment, o.status as order,
             (select count(*)::int from public.booking_cancellations c where c.booking_id = b.id)
               as cancellations,
             (select count(*)::int from public.payment_refunds r where r.payment_id = p.id)
               as refunds,
             (select r.state from public.payment_refunds r where r.payment_id = p.id) as refund_state,
             (select r.amount from public.payment_refunds r where r.payment_id = p.id)
               as refund_amount,
             (select r.idempotency_key from public.payment_refunds r where r.payment_id = p.id)
               as refund_key,
             (select count(*)::int from public.fake_provider_refunds f
               where f.tenant_id = b.tenant_id and f.payment_id = p.provider_payment_id)
               as fake_refunds,
             (select f.idempotency_key from public.fake_provider_refunds f
               where f.tenant_id = b.tenant_id and f.payment_id = p.provider_payment_id
               limit 1) as fake_key,
             (select count(*)::int from public.finalization_exceptions e
               where e.checkout_session_id = b.checkout_session_id) as exceptions,
             (select count(*)::int from public.email_messages m
               where m.booking_id = b.id and m.template = 'booking_confirmation') as confirmations,
             (select count(*)::int from public.email_messages m
               where m.booking_id = b.id and m.template = 'booking_canceled')
               as cancellation_emails,
             (select count(*)::int from public.booking_participants x where x.booking_id = b.id)
               as participants
        from public.bookings b
        join public.capacity_holds h on h.id = b.hold_id
        join public.payments p on p.id = b.payment_id
        join public.orders o on o.id = b.order_id
       where b.id = ${bookingId}`;
    if (!row) throw new Error(`no booking ${bookingId}`);
    return row;
  }

  async function withHost(fixture: CheckoutFixture): Promise<Tenant> {
    const host = `${fixture.slug}.book.example.test`;
    await admin`insert into public.tenant_hostnames (hostname, tenant_id, kind, status, verified_at)
      values (${host}, ${fixture.id}, 'preview', 'active', now())`;
    return { ...fixture, host };
  }

  async function webhook(body: string) {
    return request("POST", "/v1/webhooks/payments/fake", {
      raw: body,
      headers: { "fake-signature": await signatureHeaderValue(TEST_FAKE_SECRET, Date.now(), body) },
    });
  }

  beforeAll(async () => {
    if (!env) return;
    admin = postgres(env.adminUrl, { max: 3, onnotice: () => {} });
    runtime = createDb(env.runtimeUrl, { max: 12 });
    payments = fakeProvider(runtime.db);
    const [a, c] = await Promise.all([
      createCheckoutFixture(admin, runtime.db, "sscx-a", { days: 30 }),
      createCheckoutFixture(admin, runtime.db, "sscx-c", { days: 4 }),
    ]);
    A = await withHost(a);
    C = await withHost(c);
    tripsA = tripAllocator(A);
    tripsC = tripAllocator(C);
    // C's policy gives credit after a thirty-day cutoff: every C trip is past it.
    const ctx: TenantContext = {
      tenantId: C.id,
      actorType: "system",
      actorId: "adv",
      requestId: "adv",
    };
    await inTenantTransaction(runtime.db, ctx, async (trx) => {
      const made = await createPolicyVersion(trx, ctx, {
        productId: C.products.shared,
        changeCutoffMinutes: 43_200,
        beforeCutoff: { remedy: "full_refund" },
        afterCutoff: { remedy: "credit" },
        noShow: { remedy: "none" },
        text: {
          cancellation: "Synthetic: credit within thirty days.",
          reschedule: "Synthetic reschedule terms.",
          noShow: "Synthetic no-show terms.",
          operatorCancellation: "Synthetic operator terms.",
          weather: "Synthetic weather terms.",
        },
        reason: "adversarial credit policy",
      });
      if (made.kind !== "created") throw new Error(`policy: ${JSON.stringify(made)}`);
    });
    app = createApp({ deliverEmailAfterCommit: false });
    appRefundsDown = createApp({
      deliverEmailAfterCommit: false,
      paymentProvider: (db) =>
        refundsUnanswered(
          createFakePaymentProvider({ db, secret: TEST_FAKE_SECRET, environment: "local" }),
        ),
    });
  });

  afterAll(async () => {
    await runtime?.end();
    await admin?.end({ timeout: 5 });
  });

  it("cancels once by key: the same key replays, another key answers with the canceled booking", async () => {
    const b = await booked(A, 2);
    const shown = await terms(A, b.session);
    expect(shown).toMatchObject({ cancelable: true, remedy: "full_refund", refusal: null });
    const key = `adv-${randomUUID()}`;
    const first = await cancel(A, b.session, shown.refundAmount, key);
    expect(first.status).toBe(200);
    expect(first.headers.get("cache-control")).toBe("no-store");
    expect(first.json.booking).toMatchObject({
      id: b.bookingId,
      state: "canceled",
      partyEditable: false,
      cancellation: { remedy: "full_refund", refundAmount: shown.refundAmount },
      refund: { state: "succeeded", amount: shown.refundAmount },
      cancellationTerms: { cancelable: false, refusal: "already_canceled" },
    });
    const replay = await cancel(A, b.session, shown.refundAmount, key);
    expect(replay.status).toBe(200);
    expect(replay.headers.get("idempotent-replayed")).toBe("true");
    expect(replay.json.booking.id).toBe(b.bookingId);
    expect(replay.json.booking.cancellation).toEqual(first.json.booking.cancellation);
    for (const amount of [0, shown.refundAmount + 1]) {
      const other = await cancel(A, b.session, amount);
      expect(other.status).toBe(200);
      expect(other.headers.get("idempotent-replayed")).toBeNull();
      expect(other.json.booking).toMatchObject({ id: b.bookingId, state: "canceled" });
      expect(other.json.booking.cancellation).toEqual(first.json.booking.cancellation);
    }
    const reused = await cancel(A, b.session, 0, key);
    expect([reused.status, reused.json.error?.code]).toEqual([422, "idempotency_key_reused"]);
    expect(await stored(b.bookingId)).toMatchObject({
      state: "canceled",
      hold: "released",
      payment: "succeeded",
      order: "paid",
      cancellations: 1,
      refunds: 1,
      refund_state: "succeeded",
      refund_amount: shown.refundAmount,
      fake_refunds: 1,
      cancellation_emails: 1,
    });
  });

  it("cancels once under concurrent requests, with different keys and with one key", async () => {
    const spread = await booked(A, 2);
    const amount = (await terms(A, spread.session)).refundAmount;
    const many = await Promise.all(
      Array.from({ length: 5 }, () => cancel(A, spread.session, amount)),
    );
    for (const res of many) {
      expect(res.status).toBe(200);
      expect(res.json.booking).toMatchObject({ id: spread.bookingId, state: "canceled" });
    }
    expect(await stored(spread.bookingId)).toMatchObject({
      cancellations: 1,
      refunds: 1,
      fake_refunds: 1,
      cancellation_emails: 1,
      hold: "released",
    });

    const same = await booked(A, 2);
    const key = `adv-${randomUUID()}`;
    const keyed = await Promise.all(
      Array.from({ length: 5 }, () => cancel(A, same.session, amount, key)),
    );
    expect(keyed.map((r) => r.status)).toEqual([200, 200, 200, 200, 200]);
    expect(keyed.filter((r) => r.headers.get("idempotent-replayed") === "true")).toHaveLength(4);
    expect(await stored(same.bookingId)).toMatchObject({
      cancellations: 1,
      refunds: 1,
      fake_refunds: 1,
      cancellation_emails: 1,
    });
  });

  it("answers with the refund requested when the provider does not answer, and a sweep sends it once", async () => {
    const b = await booked(A, 1);
    const amount = (await terms(A, b.session)).refundAmount;
    const res = await cancel(A, b.session, amount, undefined, appRefundsDown);
    expect(res.status).toBe(200);
    expect(res.json.booking).toMatchObject({
      state: "canceled",
      refund: { state: "requested", amount, settledAt: null },
    });
    expect(await stored(b.bookingId)).toMatchObject({
      state: "canceled",
      refund_state: "requested",
      fake_refunds: 0,
    });
    const report = await sweepCheckouts(runtime.db, {
      runId: `adv-${randomUUID()}`,
      provider: payments,
      graceSeconds: 0,
    });
    expect(report.refundsSettled).toBeGreaterThanOrEqual(1);
    const after = await stored(b.bookingId);
    expect(after).toMatchObject({ refund_state: "succeeded", fake_refunds: 1 });
    expect(after.fake_key).toBe(after.refund_key);
    const read = await request("GET", "/v1/public/manage/booking", {
      origin: guest(A),
      headers: bearer(b.session),
    });
    expect(read.json.booking.refund).toMatchObject({ state: "succeeded", amount });
    // The guest's own retry neither cancels again nor sends a second refund.
    const again = await cancel(A, b.session, amount);
    expect(again.status).toBe(200);
    expect(await stored(b.bookingId)).toMatchObject({ refunds: 1, fake_refunds: 1 });
  });

  it("changes nothing when late or duplicate payment webhooks arrive for a canceled booking", async () => {
    const paymentOf = async (bookingId: string) => {
      const [p] = await admin<{ id: string; ref: string; amount: number; body: string }[]>`
        select p.id, p.provider_payment_id as ref, p.amount, e.body
          from public.bookings b join public.payments p on p.id = b.payment_id
          join public.fake_provider_events e on e.payment_id = p.provider_payment_id
         where b.id = ${bookingId}`;
      if (!p) throw new Error("no payment");
      return p;
    };
    const crafted = (p: { id: string; ref: string; amount: number }, type: string) =>
      craftedFakeEventBody({
        type,
        accountRef: A.accountRef,
        paymentRef: p.ref,
        amount: p.amount,
        clientReference: p.id,
      });

    const b = await booked(A, 2);
    const amount = (await terms(A, b.session)).refundAmount;
    expect((await cancel(A, b.session, amount)).status).toBe(200);
    const p = await paymentOf(b.bookingId);
    for (let i = 0; i < 2; i++) {
      const replay = await webhook(p.body);
      expect([replay.status, replay.json]).toEqual([
        200,
        { received: true, duplicate: true, outcome: "confirmed" },
      ]);
    }
    const late = await webhook(crafted(p, "payment.succeeded"));
    expect([late.status, late.json.outcome]).toEqual([200, "already_succeeded"]);
    const failed = await webhook(crafted(p, "payment.failed"));
    expect([failed.status, failed.json.outcome]).toEqual([200, "ignored_after_success"]);
    const settled = await stored(b.bookingId);
    expect(settled).toMatchObject({
      state: "canceled",
      payment: "succeeded",
      order: "paid",
      cancellations: 1,
      refunds: 1,
      refund_state: "succeeded",
      fake_refunds: 1,
      exceptions: 0,
      confirmations: 1,
      cancellation_emails: 1,
    });

    // The same events racing the cancellation itself.
    const r = await booked(A, 2);
    const rp = await paymentOf(r.bookingId);
    const raced = await Promise.all([
      cancel(A, r.session, amount),
      webhook(crafted(rp, "payment.succeeded")),
      webhook(crafted(rp, "payment.failed")),
      webhook(rp.body),
    ]);
    expect(raced.map((x) => x.status)).toEqual([200, 200, 200, 200]);
    expect(raced[1]?.json.outcome).toBe("already_succeeded");
    expect(raced[2]?.json.outcome).toBe("ignored_after_success");
    expect(await stored(r.bookingId)).toMatchObject({
      state: "canceled",
      payment: "succeeded",
      cancellations: 1,
      refunds: 1,
      fake_refunds: 1,
      exceptions: 0,
      cancellation_emails: 1,
    });
  });

  it("refuses what the policy and the clock do not allow, and changes nothing", async () => {
    // Terms that moved: the guest sends an amount canceling now does not give.
    const b = await booked(A, 2);
    const shown = await terms(A, b.session);
    const moved = await cancel(A, b.session, shown.refundAmount + 1);
    expect([moved.status, moved.json.error?.code]).toEqual([409, "cancellation_terms_changed"]);
    expect(await stored(b.bookingId)).toMatchObject({
      state: "confirmed",
      cancellations: 0,
      refunds: 0,
      cancellation_emails: 0,
    });

    // A departed trip: no cancellation and no party changes.
    const d = await booked(A, 2);
    expect(
      (await putParticipant(A, d.session, 1, { name: "Synthetic Aboard", isMinor: false })).status,
    ).toBe(200);
    await admin`
      with t as (select date_trunc('minute', now()) - interval '2 days' as s)
      update public.scheduled_trips st
         set starts_at = t.s, ends_at = t.s + make_interval(mins => st.duration_minutes),
             local_date = (t.s at time zone st.time_zone)::date,
             local_start_time = (t.s at time zone st.time_zone)::time(0)
        from t where st.id = ${d.tripId}`;
    const gone = await terms(A, d.session);
    expect(gone).toMatchObject({ cancelable: false, refusal: "trip_departed" });
    const late = await cancel(A, d.session, gone.refundAmount);
    expect([late.status, late.json.error?.code]).toEqual([409, "trip_departed"]);
    for (const position of [1, 2]) {
      const res = await putParticipant(A, d.session, position, {
        name: "Synthetic Too Late",
        isMinor: false,
      });
      expect([res.status, res.json.error?.code]).toEqual([409, "trip_departed"]);
    }
    const read = await request("GET", "/v1/public/manage/booking", {
      origin: guest(A),
      headers: bearer(d.session),
    });
    expect(read.json.booking).toMatchObject({ state: "confirmed", partyEditable: false });
    expect(await stored(d.bookingId)).toMatchObject({
      state: "confirmed",
      cancellations: 0,
      participants: 1,
    });

    // A policy that gives credit here: the operator issues it, not the guest.
    const c = await booked(C, 1);
    const credit = await terms(C, c.session);
    expect(credit).toMatchObject({
      cancelable: false,
      refusal: "remedy_requires_operator",
      remedy: "credit",
      refundAmount: 0,
    });
    const refused = await cancel(C, c.session, 0);
    expect([refused.status, refused.json.error?.code]).toEqual([409, "remedy_requires_operator"]);
    expect(await stored(c.bookingId)).toMatchObject({
      state: "confirmed",
      hold: "confirmed",
      cancellations: 0,
      refunds: 0,
    });
  });

  it("names the party within its limits, idempotently, and never after a cancellation", async () => {
    const b = await booked(A, 2);
    const invalid: [string, number | string, unknown][] = [
      ["place zero", 0, { name: "Synthetic Zero", isMinor: false }],
      ["place past the largest party", 501, { name: "Synthetic Far", isMinor: false }],
      ["not a place", "first", { name: "Synthetic Word", isMinor: false }],
      ["a minor without a guardian", 1, { name: "Synthetic Minor", isMinor: true }],
      [
        "an adult with a guardian",
        1,
        {
          name: "Synthetic Adult",
          isMinor: false,
          guardian: { name: "Synthetic Parent", email: "parent@example.test" },
        },
      ],
      ["a control character", 1, { name: "Synthetic\u0007Bell", isMinor: false }],
      [
        "a non-ASCII address",
        1,
        { name: "Synthetic Accent", isMinor: false, email: "rené@example.test" },
      ],
      ["an empty name", 1, { name: "   ", isMinor: false }],
    ];
    for (const [label, position, body] of invalid) {
      const res = await putParticipant(A, b.session, position, body);
      expect(res.status, label).toBe(400);
    }
    const past = await putParticipant(A, b.session, 3, { name: "Synthetic Third", isMinor: false });
    expect([past.status, past.json.error?.code]).toEqual([422, "position_out_of_range"]);
    expect((await stored(b.bookingId)).participants).toBe(0);

    const minor = {
      name: "  Synthetic Junior  ",
      isMinor: true,
      guardian: { name: "Synthetic Guardian", email: "Guardian.Person@Example.Test" },
    };
    const key = `adv-${randomUUID()}`;
    const made = await putParticipant(A, b.session, 1, minor, key);
    expect(made.status).toBe(200);
    expect(made.json).toMatchObject({
      created: true,
      participant: {
        position: 1,
        name: "Synthetic Junior",
        isMinor: true,
        guardian: { name: "Synthetic Guardian", email: "guardian.person@example.test" },
      },
    });
    const replay = await putParticipant(A, b.session, 1, minor, key);
    expect(replay.headers.get("idempotent-replayed")).toBe("true");
    expect(replay.json).toEqual(made.json);
    const unchanged = await putParticipant(A, b.session, 1, minor);
    expect(unchanged.json).toMatchObject({
      created: false,
      participant: { id: made.json.participant.id },
    });
    const reused = await putParticipant(
      A,
      b.session,
      1,
      { name: "Synthetic Other", isMinor: false },
      key,
    );
    expect([reused.status, reused.json.error?.code]).toEqual([422, "idempotency_key_reused"]);
    const [audits] = await admin<{ added: number; updated: number; leaked: number }[]>`
      select count(*) filter (where action = 'participant.added')::int as added,
             count(*) filter (where action = 'participant.updated')::int as updated,
             count(*) filter (where (coalesce(before_state::text, '') || coalesce(after_state::text, ''))
                                    ilike '%synthetic junior%'
                                 or (coalesce(before_state::text, '') || coalesce(after_state::text, ''))
                                    ilike '%guardian.person%')::int as leaked
        from public.audit_events where subject_id = ${made.json.participant.id}`;
    expect(audits).toEqual({ added: 1, updated: 0, leaked: 0 });

    const amount = (await terms(A, b.session)).refundAmount;
    expect((await cancel(A, b.session, amount)).status).toBe(200);
    for (const position of [1, 2]) {
      const res = await putParticipant(A, b.session, position, {
        name: "Synthetic After",
        isMinor: false,
      });
      expect([res.status, res.json.error?.code]).toEqual([409, "booking_canceled"]);
    }
    expect((await stored(b.bookingId)).participants).toBe(1);
  });
});
