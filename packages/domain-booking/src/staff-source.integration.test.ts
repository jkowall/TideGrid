/**
 * G2.12d against a real database, as tidegrid_app: where a checkout and its
 * booking came from (migration 0012), and the staff checkout commands.
 *
 * - A staff actor with a UUID id opens a staff-assisted checkout with its
 *   channel and opener; a guest, the system, or a staff actor without a UUID
 *   opens a direct one, whatever it sends. None of the three columns changes
 *   afterwards, for the runtime or the admin.
 * - book() is unchanged and inserts the default source; the bookings trigger
 *   sets it from the checkout, so a staff checkout confirmed through a
 *   verified event is staff_assisted and a direct one stays direct.
 * - A staff checkout takes the guest's late paths: a success after its hold
 *   expired reacquires the seats or is refunded in full with an exception, and
 *   the sweep expires it and its hold.
 * - The per-staff open-checkout limit, the staff cancel, and the test payment
 *   request's refusals and audit.
 *
 * Two tenants throughout: every staff command reads another tenant's ids as
 * nothing.
 */
import { randomUUID } from "node:crypto";
import {
  createDb,
  inTenantTransaction,
  type TenantContext,
  type TenantTransaction,
} from "@tidegrid/database";
import type {} from "@tidegrid/database/global-setup";
import { tripAllocator } from "@tidegrid/domain-inventory/testing";
import { FAKE_MINIMUM_AMOUNT, type FakePaymentProvider } from "@tidegrid/domain-payments";
import { createQuote } from "@tidegrid/domain-pricing";
import { sql } from "kysely";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";
import {
  cancelStaffCheckout,
  createCheckoutSession,
  ensureProviderPayment,
  expireCheckoutSessions,
  getStaffCheckout,
  handleVerifiedEvent,
  listFinalizationExceptions,
  MAX_OPEN_CHECKOUTS_PER_CLIENT,
  openStaffCheckout,
  requestStaffTestPayment,
} from "./index.ts";
import {
  backdateCheckout,
  type CheckoutFixture,
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

const attestations = { policyToldToGuest: true, emailReadBack: true } as const;
const booker = { name: "Phone Guest", email: "Phone.Guest@Example.TEST" };

describe.skipIf(!env)("staff-assisted checkouts and booking source (G2.12d)", () => {
  let admin: Sql;
  let runtime: ReturnType<typeof createDb>;
  let provider: FakePaymentProvider;
  let A: CheckoutFixture;
  let B: CheckoutFixture;
  let tripsA: ReturnType<typeof tripAllocator>;
  let tripsB: ReturnType<typeof tripAllocator>;
  /** Booking staff at A, a second staff member at A, and booking staff at B. */
  let deskA: string;
  let ownerA: string;
  let deskB: string;

  async function member(tenantId: string, role: "owner" | "booking_staff"): Promise<string> {
    const id = randomUUID();
    await admin`insert into public.staff_users (id, email, display_name)
      values (${id}, ${`g212d-${id.slice(0, 8)}@example.test`}, ${role})`;
    await admin`insert into public.tenant_memberships (tenant_id, user_id, role, display_name)
      values (${tenantId}, ${id}, ${role}, ${role === "owner" ? "Olive Owner" : "Ben Desk"})`;
    return id;
  }

  const staffCtx = (tenantId: string, userId: string): TenantContext => ({
    tenantId,
    actorType: "staff",
    actorId: userId,
    requestId: `req-${randomUUID()}`,
    sourceIp: null,
  });

  const asStaff = <T>(
    tenantId: string,
    userId: string,
    fn: (trx: TenantTransaction, ctx: TenantContext) => Promise<T>,
  ): Promise<T> => {
    const ctx = staffCtx(tenantId, userId);
    return inTenantTransaction(runtime.db, ctx, (trx) => fn(trx, ctx));
  };

  /** A quote priced by a staff member, as the staff quote route prices it. */
  async function staffQuote(
    tenant: CheckoutFixture,
    userId: string,
    tripId: string,
    party: number,
    charter = false,
  ) {
    const created = await asStaff(tenant.id, userId, (trx, ctx) =>
      createQuote(trx, ctx, {
        tripId,
        party: charter
          ? { kind: "charter", guests: party }
          : { kind: "tickets", tickets: [{ code: "adult", quantity: party }] },
        addOns: [],
        promotionCode: null,
        now: new Date(),
      }),
    );
    if (created.kind !== "created") throw new Error(`staff quote: ${JSON.stringify(created)}`);
    return created.quote;
  }

  async function openStaff(
    tenant: CheckoutFixture,
    userId: string,
    tripId: string,
    party: number,
    options: { charter?: boolean; channel?: "phone" | "email" | "walk_up" } = {},
  ) {
    const quote = await staffQuote(tenant, userId, tripId, party, options.charter ?? false);
    const created = await asStaff(tenant.id, userId, (trx, ctx) =>
      openStaffCheckout(trx, ctx, {
        quoteId: quote.quoteId,
        acceptedPolicyVersion: quote.policy.version,
        booker,
        channel: options.channel ?? "phone",
        attestations,
        provider: "fake",
        minimumAmount: FAKE_MINIMUM_AMOUNT,
      }),
    );
    if (created.kind !== "created") throw new Error(`staff checkout: ${JSON.stringify(created)}`);
    const ready = await ensureProviderPayment(
      runtime.db,
      provider,
      staffCtx(tenant.id, userId),
      created.session.id,
    );
    if (ready.kind !== "ready") throw new Error(`payment: ${JSON.stringify(ready)}`);
    return { quote, session: created.session, paymentRef: ready.paymentRef };
  }

  async function openGuest(
    tenant: CheckoutFixture,
    tripId: string,
    party: number,
    charter = false,
  ) {
    const quote = await quoteFor(runtime.db, tenant.id, tripId, party, { charter });
    const ctx = guestContext(tenant.id);
    const created = await inTenantTransaction(runtime.db, ctx, (trx) =>
      createCheckoutSession(trx, ctx, {
        quoteId: quote.quoteId,
        acceptedPolicyVersion: quote.policy.version,
        booker,
        secret: newSecret(),
        clientAddress: null,
        provider: "fake",
        minimumAmount: FAKE_MINIMUM_AMOUNT,
      }),
    );
    if (created.kind !== "created") throw new Error(`guest checkout: ${JSON.stringify(created)}`);
    const ready = await ensureProviderPayment(runtime.db, provider, ctx, created.session.id);
    if (ready.kind !== "ready") throw new Error(`payment: ${JSON.stringify(ready)}`);
    return { quote, session: created.session, paymentRef: ready.paymentRef };
  }

  async function pay(tenant: CheckoutFixture, paymentRef: string, outcome: "succeeded" | "failed") {
    const settled = await provider.settlePayment(tenant.id, paymentRef, outcome, Date.now());
    if (settled.kind === "not_found") throw new Error("no fake payment");
    const event = await verifiedFakeEvent(provider, settled.event.body);
    const handled = await handleVerifiedEvent(runtime.db, provider, event, {
      requestId: `wh-${randomUUID()}`,
    });
    if (handled.kind !== "processed") throw new Error(`webhook: ${JSON.stringify(handled)}`);
    return handled;
  }

  async function row(sessionId: string) {
    const [found] = await admin<
      {
        source: string;
        channel: string | null;
        opened_by: string | null;
        state: string;
        hold: string;
        order: string;
        payment: string;
        booking_source: string | null;
        refund: string | null;
      }[]
    >`
      select s.source, s.channel, s.opened_by, s.state, h.state as hold, o.status as order,
             p.state as payment, b.source as booking_source,
             (select r.state from public.payment_refunds r where r.payment_id = p.id) as refund
        from public.checkout_sessions s
        join public.capacity_holds h on h.id = s.hold_id
        join public.orders o on o.checkout_session_id = s.id
        join public.payments p on p.checkout_session_id = s.id
        left join public.bookings b on b.checkout_session_id = s.id
       where s.id = ${sessionId}`;
    if (!found) throw new Error(`no checkout ${sessionId}`);
    return found;
  }

  beforeAll(async () => {
    if (!env) return;
    admin = postgres(env.adminUrl, { max: 4, onnotice: () => {} });
    runtime = createDb(env.runtimeUrl, { max: 8 });
    provider = fakeProvider(runtime.db);
    [A, B] = await Promise.all([
      createCheckoutFixture(admin, runtime.db, "g212d-a", { days: 14 }),
      createCheckoutFixture(admin, runtime.db, "g212d-b", { days: 4 }),
    ]);
    tripsA = tripAllocator(A);
    tripsB = tripAllocator(B);
    deskA = await member(A.id, "booking_staff");
    ownerA = await member(A.id, "owner");
    deskB = await member(B.id, "booking_staff");
  }, 180_000);

  afterAll(async () => {
    await runtime?.end();
    await admin?.end({ timeout: 5 });
  });

  it("stamps a staff checkout staff_assisted with its opener and channel", async () => {
    const { session } = await openStaff(A, deskA, tripsA.shared(), 2, { channel: "walk_up" });
    expect(await row(session.id)).toMatchObject({
      source: "staff_assisted",
      channel: "walk_up",
      opened_by: deskA,
      state: "open",
      hold: "active",
      order: "pending",
      payment: "pending",
    });
    const [audit] = await admin<{ actor_type: string; actor_id: string; after: unknown }[]>`
      select actor_type, actor_id, after_state as after from public.audit_events
       where tenant_id = ${A.id} and subject_id = ${session.id}
         and action = 'checkout.session_opened'`;
    expect(audit).toMatchObject({
      actor_type: "staff",
      actor_id: deskA,
      after: {
        source: "staff_assisted",
        channel: "walk_up",
        policyAcceptance: "staff_attested",
        attestations: { policyToldToGuest: true, emailReadBack: true },
      },
    });
    // No booker detail in the audit row or the outbox event.
    const text = JSON.stringify(
      await admin`select after_state from public.audit_events where subject_id = ${session.id}`,
    ).toLowerCase();
    expect(text).not.toContain("phone guest");
    expect(text).not.toContain("phone.guest");
  });

  it("stamps every other writer direct, whatever it sends", async () => {
    const asks = { channel: "phone" as const, attestations };
    const contexts: TenantContext[] = [
      guestContext(A.id),
      { tenantId: A.id, actorType: "system", actorId: deskA, requestId: "sys" },
      // A staff actor whose id is not a UUID cannot be a member: direct.
      { tenantId: A.id, actorType: "staff", actorId: "adv", requestId: "adv" },
    ];
    for (const ctx of contexts) {
      const quote = await quoteFor(runtime.db, A.id, tripsA.shared(), 1);
      const created = await inTenantTransaction(runtime.db, ctx, (trx) =>
        createCheckoutSession(trx, ctx, {
          quoteId: quote.quoteId,
          acceptedPolicyVersion: quote.policy.version,
          booker,
          secret: newSecret(),
          clientAddress: null,
          provider: "fake",
          minimumAmount: FAKE_MINIMUM_AMOUNT,
          staff: asks,
        }),
      );
      if (created.kind !== "created") throw new Error(`checkout: ${JSON.stringify(created)}`);
      expect({ actor: ctx.actorType, ...(await row(created.session.id)) }).toMatchObject({
        actor: ctx.actorType,
        source: "direct",
        channel: null,
        opened_by: null,
      });
    }
  });

  it("refuses a staff checkout without its channel", async () => {
    const quote = await staffQuote(A, deskA, tripsA.shared(), 1);
    const ctx = staffCtx(A.id, deskA);
    expect(
      await failure(
        inTenantTransaction(runtime.db, ctx, (trx) =>
          createCheckoutSession(trx, ctx, {
            quoteId: quote.quoteId,
            acceptedPolicyVersion: quote.policy.version,
            booker,
            secret: newSecret(),
            clientAddress: null,
            provider: "fake",
            minimumAmount: FAKE_MINIMUM_AMOUNT,
          }),
        ),
      ),
    ).toEqual({ code: "23514", constraint: "checkout_sessions_staff_channel" });
  });

  it("never changes a checkout's source, channel, or opener, for the runtime or the admin", async () => {
    const staff = await openStaff(A, deskA, tripsA.shared(), 1);
    const guest = await openGuest(A, tripsA.shared(), 1);
    for (const set of [
      sql`source = 'direct'`,
      sql`channel = 'email'`,
      sql`opened_by = null`,
      sql`source = 'staff_assisted'`,
    ]) {
      for (const id of [staff.session.id, guest.session.id]) {
        // The runtime holds UPDATE on state only.
        expect(
          await failure(
            asStaff(A.id, deskA, (trx) =>
              sql`update checkout_sessions set ${set} where id = ${id}`.execute(trx),
            ),
          ),
        ).toMatchObject({ code: "42501" });
      }
    }
    const s = staff.session.id;
    const g = guest.session.id;
    for (const [id, change] of [
      [s, () => admin`update public.checkout_sessions set channel = 'email' where id = ${s}`],
      [s, () => admin`update public.checkout_sessions set opened_by = ${ownerA} where id = ${s}`],
      [
        s,
        () =>
          admin`update public.checkout_sessions
                   set source = 'direct', channel = null, opened_by = null where id = ${s}`,
      ],
      [
        g,
        () =>
          admin`update public.checkout_sessions
                   set source = 'staff_assisted', channel = 'phone', opened_by = ${deskA}
                 where id = ${g}`,
      ],
    ] as const) {
      expect({ id, ...(await failure(change())) }).toEqual({
        id,
        code: "23514",
        constraint: "checkout_sessions_source_immutable",
      });
    }
    expect(await row(staff.session.id)).toMatchObject({
      source: "staff_assisted",
      channel: "phone",
      opened_by: deskA,
    });
    expect(await row(guest.session.id)).toMatchObject({ source: "direct", channel: null });
  });

  it("confirms a staff checkout as staff_assisted through the verified event, and a direct one as direct", async () => {
    const staff = await openStaff(A, deskA, tripsA.shared(), 2);
    const guest = await openGuest(A, tripsA.shared(), 2);
    expect((await pay(A, staff.paymentRef, "succeeded")).outcome).toBe("confirmed");
    expect((await pay(A, guest.paymentRef, "succeeded")).outcome).toBe("confirmed");
    expect(await row(staff.session.id)).toMatchObject({
      source: "staff_assisted",
      state: "confirmed",
      hold: "confirmed",
      order: "paid",
      payment: "succeeded",
      booking_source: "staff_assisted",
    });
    expect(await row(guest.session.id)).toMatchObject({
      source: "direct",
      state: "confirmed",
      booking_source: "direct",
    });
    // The booking's source never changes either.
    expect(
      await failure(
        admin`update public.bookings set source = 'direct' where checkout_session_id = ${staff.session.id}`,
      ),
    ).toEqual({ code: "23514", constraint: "bookings_immutable" });
    // The staff view shows the booking.
    const view = await asStaff(A.id, deskA, (trx) => getStaffCheckout(trx, A.id, staff.session.id));
    expect(view).toMatchObject({
      state: "confirmed",
      channel: "phone",
      paymentState: "succeeded",
      booking: { reference: expect.stringMatching(/^[0-9A-HJKMNP-TV-Z]{8}$/) },
    });
  });

  it("names the bookings trigger to fire first, beside an unchanged evidence trigger", async () => {
    const triggers = await admin<{ name: string }[]>`
      select tgname as name from pg_trigger
       where tgrelid = 'public.bookings'::regclass and not tgisinternal
         and tgname in ('bookings_a_source', 'bookings_evidence', 'bookings_lifecycle')
       order by tgname`;
    expect(triggers.map((t) => t.name)).toEqual([
      "bookings_a_source",
      "bookings_evidence",
      "bookings_lifecycle",
    ]);
    // app.check_booking does not read the source, so their order cannot matter.
    const [fn] = await admin<{ src: string }[]>`
      select prosrc as src from pg_proc p join pg_namespace n on n.oid = p.pronamespace
       where n.nspname = 'app' and p.proname = 'check_booking'`;
    expect(fn?.src).not.toMatch(/source/);
  });

  it("refuses a guest's quote, another tenant's, an unknown one, and a malformed id", async () => {
    const guestQuote = await quoteFor(runtime.db, A.id, tripsA.shared(), 1);
    const otherTenant = await staffQuote(B, deskB, tripsB.shared(), 1);
    for (const quoteId of [guestQuote.quoteId, otherTenant.quoteId, randomUUID(), "nope"]) {
      const opened = await asStaff(A.id, deskA, (trx, ctx) =>
        openStaffCheckout(trx, ctx, {
          quoteId,
          acceptedPolicyVersion: 1,
          booker,
          channel: "email",
          attestations,
          provider: "fake",
          minimumAmount: FAKE_MINIMUM_AMOUNT,
        }),
      );
      expect({ quoteId, kind: opened.kind }).toEqual({ quoteId, kind: "quote_not_found" });
    }
    // A guest context cannot open a staff checkout at all.
    const ctx = guestContext(A.id);
    await expect(
      inTenantTransaction(runtime.db, ctx, (trx) =>
        openStaffCheckout(trx, ctx, {
          quoteId: guestQuote.quoteId,
          acceptedPolicyVersion: guestQuote.policy.version,
          booker,
          channel: "email",
          attestations,
          provider: "fake",
          minimumAmount: FAKE_MINIMUM_AMOUNT,
        }),
      ),
    ).rejects.toThrow(TypeError);
  });

  it("holds each staff member to the open-checkout limit, apart from guests and colleagues", async () => {
    const tripId = tripsA.shared();
    for (let i = 0; i < MAX_OPEN_CHECKOUTS_PER_CLIENT; i++) await openStaff(A, ownerA, tripId, 1);
    const quote = await staffQuote(A, ownerA, tripId, 1);
    const refused = await asStaff(A.id, ownerA, (trx, ctx) =>
      openStaffCheckout(trx, ctx, {
        quoteId: quote.quoteId,
        acceptedPolicyVersion: quote.policy.version,
        booker,
        channel: "phone",
        attestations,
        provider: "fake",
        minimumAmount: FAKE_MINIMUM_AMOUNT,
      }),
    );
    expect(refused).toEqual({ kind: "too_many_checkouts", limit: MAX_OPEN_CHECKOUTS_PER_CLIENT });
    // A colleague and a guest are not counted against the owner, nor the owner against them.
    expect((await openStaff(A, deskA, tripId, 1)).session.state).toBe("open");
    expect((await openGuest(A, tripId, 1)).session.state).toBe("open");
    // Nothing was written for the refused one.
    const [count] = await admin<{ n: number }[]>`
      select count(*)::int as n from public.checkout_sessions where quote_id = ${quote.quoteId}`;
    expect(count?.n).toBe(0);
  });

  it("takes the guest's late paths: a success after expiry reacquires or is refunded", async () => {
    const deskA = await member(A.id, "booking_staff");
    const tripId = tripsA.charter();
    const late = await openStaff(A, deskA, tripId, 2, { charter: true });
    await backdateCheckout(admin, late.session.id);
    const expired = await asStaff(A.id, deskA, (trx, ctx) =>
      expireCheckoutSessions(trx, ctx, { limit: 100 }),
    );
    expect(expired.expired).toContain(late.session.id);
    expect(await row(late.session.id)).toMatchObject({ state: "expired", hold: "expired" });
    expect((await pay(A, late.paymentRef, "succeeded")).outcome).toBe("confirmed_reacquired");
    expect(await row(late.session.id)).toMatchObject({
      state: "confirmed",
      hold: "confirmed",
      booking_source: "staff_assisted",
    });

    // Another staff charter expires, a guest takes the boat, and the late
    // success is refunded in full with an exception.
    const other = tripsA.charter();
    const lost = await openStaff(A, deskA, other, 2, { charter: true });
    await backdateCheckout(admin, lost.session.id);
    const taker = await openGuest(A, other, 3, true);
    expect(taker.session.state).toBe("open");
    const handled = await pay(A, lost.paymentRef, "succeeded");
    expect(handled).toMatchObject({ outcome: "refund_required", refund: { kind: "succeeded" } });
    expect(await row(lost.session.id)).toMatchObject({
      state: "unfulfilled",
      hold: "expired",
      order: "void",
      payment: "succeeded",
      booking_source: null,
      refund: "succeeded",
    });
    const exceptions = await asStaff(A.id, deskA, (trx) =>
      listFinalizationExceptions(trx, A.id, { limit: 20 }),
    );
    expect(exceptions.find((e) => e.checkoutSessionId === lost.session.id)).toMatchObject({
      reason: "no_capacity",
      refund: { state: "succeeded", amount: lost.session.amount },
    });
    const view = await asStaff(A.id, deskA, (trx) => getStaffCheckout(trx, A.id, lost.session.id));
    expect(view).toMatchObject({
      state: "unfulfilled",
      booking: null,
      refund: { state: "succeeded", amount: lost.session.amount },
    });
  });

  it("lets staff cancel an open staff checkout, and refunds a success that comes after", async () => {
    const deskA = await member(A.id, "booking_staff");
    const opened = await openStaff(A, deskA, tripsA.shared(), 3);
    const guest = await openGuest(A, tripsA.shared(), 1);
    // A guest's checkout, another tenant's, an unknown, and a malformed id read as nothing.
    for (const [tenantId, userId, sessionId] of [
      [A.id, deskA, guest.session.id],
      [B.id, deskB, opened.session.id],
      [A.id, deskA, randomUUID()],
      [A.id, deskA, "nope"],
    ] as const) {
      const kind = (
        await asStaff(tenantId, userId, (trx, ctx) => cancelStaffCheckout(trx, ctx, { sessionId }))
      ).kind;
      expect({ sessionId, kind }).toEqual({ sessionId, kind: "not_found" });
    }
    const canceled = await asStaff(A.id, ownerA, (trx, ctx) =>
      cancelStaffCheckout(trx, ctx, { sessionId: opened.session.id }),
    );
    expect(canceled.kind).toBe("canceled");
    const again = await asStaff(A.id, ownerA, (trx, ctx) =>
      cancelStaffCheckout(trx, ctx, { sessionId: opened.session.id }),
    );
    expect(again.kind).toBe("unchanged");
    expect(await row(opened.session.id)).toMatchObject({
      state: "canceled",
      hold: "released",
      order: "void",
    });
    const [audit] = await admin<{ actor_type: string; actor_id: string; reason: string }[]>`
      select actor_type, actor_id, reason from public.audit_events
       where tenant_id = ${A.id} and subject_id = ${opened.session.id}
         and action = 'checkout.session_canceled'`;
    expect(audit).toEqual({
      actor_type: "staff",
      actor_id: ownerA,
      reason: "checkout canceled by staff",
    });

    // The test payment request refuses it and writes nothing.
    const asked = await asStaff(A.id, deskA, (trx, ctx) =>
      requestStaffTestPayment(trx, ctx, { sessionId: opened.session.id, outcome: "succeed" }),
    );
    expect(asked).toEqual({ kind: "not_open", state: "canceled" });

    // The residual race: a payment that succeeds anyway is refunded in full.
    const handled = await pay(A, opened.paymentRef, "succeeded");
    expect(handled).toMatchObject({ outcome: "refund_required", refund: { kind: "succeeded" } });
    expect(await row(opened.session.id)).toMatchObject({
      state: "unfulfilled",
      payment: "succeeded",
      refund: "succeeded",
      booking_source: null,
    });
  });

  it("records who asked for a test payment, and refuses one past the hold or not staff's", async () => {
    const deskA = await member(A.id, "booking_staff");
    const opened = await openStaff(A, deskA, tripsA.shared(), 1);
    const asked = await asStaff(A.id, deskA, (trx, ctx) =>
      requestStaffTestPayment(trx, ctx, { sessionId: opened.session.id, outcome: "fail" }),
    );
    expect(asked).toEqual({ kind: "requested", paymentRef: opened.paymentRef });
    const [audit] = await admin<{ actor_type: string; actor_id: string; after: unknown }[]>`
      select actor_type, actor_id, after_state as after from public.audit_events
       where tenant_id = ${A.id} and subject_id = ${opened.session.id}
         and action = 'checkout.test_payment_requested'`;
    expect(audit).toEqual({
      actor_type: "staff",
      actor_id: deskA,
      after: { outcome: "fail", provider: "fake" },
    });
    const view = await asStaff(A.id, deskA, (trx) =>
      getStaffCheckout(trx, A.id, opened.session.id),
    );
    expect(view?.lastTestPayment).toMatchObject({ outcome: "fail" });

    const guest = await openGuest(A, tripsA.shared(), 1);
    expect(
      await asStaff(A.id, deskA, (trx, ctx) =>
        requestStaffTestPayment(trx, ctx, { sessionId: guest.session.id, outcome: "succeed" }),
      ),
    ).toEqual({ kind: "not_found" });
    expect(
      await asStaff(B.id, deskB, (trx, ctx) =>
        requestStaffTestPayment(trx, ctx, { sessionId: opened.session.id, outcome: "succeed" }),
      ),
    ).toEqual({ kind: "not_found" });
    expect(
      await asStaff(B.id, deskB, (trx) => getStaffCheckout(trx, B.id, opened.session.id)),
    ).toBeNull();

    await backdateCheckout(admin, opened.session.id);
    expect(
      await asStaff(A.id, deskA, (trx, ctx) =>
        requestStaffTestPayment(trx, ctx, { sessionId: opened.session.id, outcome: "succeed" }),
      ),
    ).toEqual({ kind: "not_open", state: "expired" });
  });
});
