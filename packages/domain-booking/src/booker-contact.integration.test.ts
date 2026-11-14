import { randomUUID } from "node:crypto";
import {
  createDb,
  inTenantTransaction,
  type TenantContext,
  type TenantTransaction,
} from "@tidegrid/database";
import type {} from "@tidegrid/database/global-setup";
import { tripAllocator } from "@tidegrid/domain-inventory/testing";
import {
  deliverTenantMessages,
  FakeEmailProvider,
  redeemAccessLink,
} from "@tidegrid/domain-messaging";
import type { FakePaymentProvider } from "@tidegrid/domain-payments";
import { createPriceListVersion } from "@tidegrid/domain-pricing";
import { sql } from "kysely";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";
import { maskEmail } from "./emails.ts";
import {
  type ChangeBookerContactInput,
  cancelBooking,
  changeBookerContact,
  getManagedBooking,
  listBookerContactChanges,
  MAX_CONTACT_CHANGES_PER_DAY,
  openManageSession,
  openManageSessionFromCheckout,
  previewCancellation,
  renewManageLink,
  requestManageLink,
} from "./index.ts";
import { manageSession } from "./manage.ts";
import {
  type CheckoutFixture,
  confirmBooking,
  createCheckoutFixture,
  fakeProvider,
  guestContext,
} from "./test-fixtures.ts";

type Sql = ReturnType<typeof postgres>;

const env = inject("integrationDb");

function staffContext(tenantId: string): TenantContext {
  return {
    tenantId,
    actorType: "staff",
    actorId: `user:${randomUUID()}`,
    requestId: `req-${randomUUID()}`,
    sourceIp: null,
  };
}

async function failure(p: Promise<unknown>): Promise<{ code?: string; constraint?: string }> {
  try {
    await p;
  } catch (err) {
    const e = err as { code?: string; constraint_name?: string; cause?: unknown };
    const inner = (e.code ? e : (e.cause ?? e)) as { code?: string; constraint_name?: string };
    return {
      ...(inner.code ? { code: inner.code } : {}),
      ...(inner.constraint_name ? { constraint: inner.constraint_name } : {}),
    };
  }
  throw new Error("expected a database error");
}

describe.skipIf(!env)("correcting the booker's contact details (W3-G2.11-rest)", () => {
  let admin: Sql;
  let runtime: ReturnType<typeof createDb>;
  let payments: FakePaymentProvider;
  let mail: FakeEmailProvider;
  let A: CheckoutFixture;
  let B: CheckoutFixture;
  let tripsA: ReturnType<typeof tripAllocator>;

  const as = <T>(
    ctx: TenantContext,
    fn: (trx: TenantTransaction, ctx: TenantContext) => Promise<T>,
  ): Promise<T> => inTenantTransaction(runtime.db, ctx, (trx) => fn(trx, ctx));
  const sessionCtx = (tenantId: string, sessionId: string): TenantContext => ({
    ...guestContext(tenantId),
    actorId: `guest_session:${sessionId}`,
  });
  const change = (ctx: TenantContext, input: ChangeBookerContactInput) =>
    as(ctx, (trx, c) => changeBookerContact(trx, c, input));
  const deliver = (tenant: CheckoutFixture) =>
    deliverTenantMessages(runtime.db, tenant.id, {
      provider: mail,
      fromAddress: "bookings@tidegrid.test",
      guestLinkOrigin: "http://{slug}.book.localhost:5301",
      environment: "local",
      runId: `run-${randomUUID()}`,
    });
  async function openFromCheckout(
    tenant: CheckoutFixture,
    booked: { checkoutSessionId: string; secret: string },
  ) {
    const opened = await as(guestContext(tenant.id), (trx, c) =>
      openManageSessionFromCheckout(trx, c, {
        checkoutSessionId: booked.checkoutSessionId,
        secret: booked.secret,
      }),
    );
    if (opened.kind !== "opened") throw new Error(`not opened: ${opened.kind}`);
    return opened.session;
  }
  async function mailTo(tenant: CheckoutFixture, to: string) {
    const inbox = await mail.listMailbox(tenant.id);
    return Promise.all(
      inbox.filter((m) => m.to === to).map((m) => mail.getMailboxMessage(tenant.id, m.id)),
    );
  }
  const manageToken = (html: string | undefined) =>
    /\/manage#t=([A-Za-z0-9_-]{43})/.exec(html ?? "")?.[1];
  async function messages(bookingId: string) {
    return admin<
      {
        template: string;
        to_email: string;
        state: string;
        last_error_code: string | null;
        next_attempt_at: Date;
        dedupe_key: string;
      }[]
    >`
      select template, to_email, state, last_error_code, next_attempt_at, dedupe_key
        from public.email_messages where booking_id = ${bookingId} order by created_at, id`;
  }

  beforeAll(async () => {
    if (!env) return;
    admin = postgres(env.adminUrl, { max: 2, onnotice: () => {} });
    runtime = createDb(env.runtimeUrl, { max: 8 });
    payments = fakeProvider(runtime.db);
    mail = new FakeEmailProvider({ db: runtime.db, environment: "local" });
    A = await createCheckoutFixture(admin, runtime.db, "bkc-a", { days: 16 });
    B = await createCheckoutFixture(admin, runtime.db, "bkc-b");
    tripsA = tripAllocator(A);
    // The first trips are too close for a reminder or a balance due a day before.
    for (let i = 0; i < 3; i += 1) {
      tripsA.shared();
      tripsA.charter();
    }
    for (const t of [A, B]) {
      await admin`insert into public.tenant_hostnames (hostname, tenant_id, kind, status, verified_at)
        values (${`${t.slug}.book.localhost`}, ${t.id}, 'preview', 'active', now())`;
    }
    const sys: TenantContext = { tenantId: A.id, actorType: "system", actorId: "test" };
    const created = await as(sys, (trx, c) =>
      createPriceListVersion(trx, c, {
        productId: A.products.charter,
        charter: { name: "Whole boat", amount: 100_000, taxable: true },
        deposit: { kind: "fixed", amount: 20_000, balanceDueDays: 1 },
        reason: "deposit terms",
      }),
    );
    if (created.kind !== "created") throw new Error(JSON.stringify(created));
  });

  afterAll(async () => {
    await runtime?.end();
    await admin?.end({ timeout: 5 });
  });

  it("moves the booking to the new address, ends the old one's access, and tells it", async () => {
    const booked = await confirmBooking(runtime.db, payments, A, tripsA.shared(), 2, {
      booker: { name: "Bea Typo", email: "bea@exmaple.test" },
    });
    // The confirmation goes out with its link; the reminder waits for its day.
    await deliver(A);
    const [confirmation] = await mailTo(A, "bea@exmaple.test");
    const oldLink = manageToken(confirmation?.html);
    expect(oldLink).toBeDefined();
    const before = await messages(booked.bookingId);
    const reminder = before.find((m) => m.template === "booking_reminder");
    expect(reminder?.state).toBe("queued");

    // Two sessions: the one making the change, and another from earlier.
    const acting = await openFromCheckout(A, booked);
    const other = await openFromCheckout(A, booked);

    const result = await change(sessionCtx(A.id, acting.sessionId), {
      bookingId: booked.bookingId,
      name: "  Bea Booker ",
      email: "Bea@Example.test",
      keepSessionId: acting.sessionId,
    });
    expect(result).toMatchObject({
      kind: "changed",
      change: { nameChanged: true, emailChanged: true, by: "guest" },
    });

    // The booking reads the new details.
    const view = await as(guestContext(A.id), (trx) =>
      getManagedBooking(trx, A.id, booked.bookingId),
    );
    expect(view?.booking.booker).toEqual({ name: "Bea Booker", email: "bea@example.test" });

    // The acting session stays; the other ends; the old link no longer opens.
    expect(
      await as(guestContext(A.id), (trx) => manageSession(trx, A.id, acting.token)),
    ).not.toBeNull();
    expect(await as(guestContext(A.id), (trx) => manageSession(trx, A.id, other.token))).toBeNull();
    const redeemed = await as(guestContext(A.id), (trx, c) =>
      redeemAccessLink(trx, c, { token: oldLink as string, purpose: "booking_manage" }),
    );
    expect(redeemed.kind).not.toBe("redeemed");

    // The old reminder is canceled; a new one waits for the same moment at the new address.
    const after = await messages(booked.bookingId);
    const reminders = after.filter((m) => m.template === "booking_reminder");
    expect(reminders).toHaveLength(2);
    expect(reminders[0]).toMatchObject({
      to_email: "bea@exmaple.test",
      state: "canceled",
      last_error_code: "recipient_changed",
    });
    expect(reminders[1]).toMatchObject({ to_email: "bea@example.test", state: "queued" });
    expect(reminders[1]?.next_attempt_at.getTime()).toBe(reminder?.next_attempt_at.getTime());

    // The old address hears of the change, without a link or the full new address.
    await deliver(A);
    const oldInbox = await mailTo(A, "bea@exmaple.test");
    const notice = oldInbox.find((m) => m?.subject.includes("email address changed"));
    expect(notice).toBeDefined();
    expect(notice?.html).not.toContain("#t=");
    expect(notice?.html).not.toContain("bea@example.test");
    expect(notice?.text).toContain(maskEmail("bea@example.test"));
    // The new address gets a link that opens the booking.
    const newInbox = await mailTo(A, "bea@example.test");
    const fresh = manageToken(newInbox.find((m) => m?.subject.startsWith("Your link"))?.html);
    expect(fresh).toBeDefined();

    // The history says who changed which field, never the values; so does the audit.
    const history = await as(guestContext(A.id), (trx) =>
      listBookerContactChanges(trx, A.id, booked.bookingId),
    );
    expect(history).toHaveLength(1);
    const [row] = await admin<{ actor_type: string; actor_id: string }[]>`
      select actor_type, actor_id from public.booking_contact_changes
       where booking_id = ${booked.bookingId}`;
    expect(row).toEqual({ actor_type: "guest", actor_id: `guest_session:${acting.sessionId}` });
    const audit = await admin<{ before_state: unknown; after_state: unknown }[]>`
      select before_state, after_state from public.audit_events
       where tenant_id = ${A.id} and subject_id = ${booked.bookingId}
         and action = 'booking.booker_contact_changed'`;
    expect(audit).toHaveLength(1);
    expect(JSON.stringify(audit)).not.toMatch(/bea@|Bea /);
    const outbox = await admin<{ payload: unknown }[]>`
      select payload from public.outbox_events
       where tenant_id = ${A.id} and topic = 'booking.booker_contact_changed'
         and aggregate_id = ${booked.bookingId}`;
    expect(outbox).toHaveLength(1);
    expect(JSON.stringify(outbox)).not.toMatch(/bea@|Bea /);
  });

  it("changes only the name without sending anything, and answers the same details as unchanged", async () => {
    const booked = await confirmBooking(runtime.db, payments, A, tripsA.shared(), 1, {
      booker: { name: "Cal Wrong", email: "cal@example.test" },
    });
    const queuedBefore = (await messages(booked.bookingId)).length;
    const session = await openFromCheckout(A, booked);
    const done = await change(sessionCtx(A.id, session.sessionId), {
      bookingId: booked.bookingId,
      name: "Cal Right",
      email: "cal@example.test",
      keepSessionId: session.sessionId,
    });
    expect(done).toMatchObject({
      kind: "changed",
      change: { nameChanged: true, emailChanged: false },
    });
    expect(await messages(booked.bookingId)).toHaveLength(queuedBefore);
    expect(
      await as(guestContext(A.id), (trx) => manageSession(trx, A.id, session.token)),
    ).not.toBeNull();

    const again = await change(sessionCtx(A.id, session.sessionId), {
      bookingId: booked.bookingId,
      name: "Cal Right",
      email: "CAL@example.test",
    });
    expect(again).toEqual({ kind: "unchanged" });
    const history = await as(guestContext(A.id), (trx) =>
      listBookerContactChanges(trx, A.id, booked.bookingId),
    );
    expect(history).toHaveLength(1);
  });

  it("lets staff correct it, ending every guest session, and moves a charter's balance reminders", async () => {
    const booked = await confirmBooking(runtime.db, payments, A, tripsA.charter(), 4, {
      charter: true,
      booker: { name: "Dee Deposit", email: "dee@example.test" },
    });
    // One reminder is due in half an hour (a retry, or a date staff moved):
    // it moves for that moment, not the schedule's.
    const soon = new Date(Date.now() + 30 * 60_000);
    await admin`
      update public.email_messages set next_attempt_at = ${soon}
       where id = (select id from public.email_messages
                    where booking_id = ${booked.bookingId}
                      and template = 'booking_balance_reminder'
                    order by next_attempt_at limit 1)`;
    const before = (await messages(booked.bookingId)).filter(
      (m) => m.template === "booking_balance_reminder" && m.state === "queued",
    );
    expect(before.length).toBeGreaterThan(0);
    const session = await openFromCheckout(A, booked);

    const done = await change(staffContext(A.id), {
      bookingId: booked.bookingId,
      name: "Dee Deposit",
      email: "dee.new@example.test",
    });
    expect(done).toMatchObject({ kind: "changed", change: { by: "staff", emailChanged: true } });
    expect(
      await as(guestContext(A.id), (trx) => manageSession(trx, A.id, session.token)),
    ).toBeNull();

    const after = (await messages(booked.bookingId)).filter(
      (m) => m.template === "booking_balance_reminder",
    );
    const moved = after.filter((m) => m.to_email === "dee.new@example.test");
    expect(moved.map((m) => m.next_attempt_at.getTime()).sort()).toEqual(
      before.map((m) => m.next_attempt_at.getTime()).sort(),
    );
    for (const m of after.filter((x) => x.to_email === "dee@example.test")) {
      expect(m).toMatchObject({ state: "canceled", last_error_code: "recipient_changed" });
    }
  });

  it("allows the guest 3 corrections a day, in the service and the database, and never locks out staff", async () => {
    const booked = await confirmBooking(runtime.db, payments, A, tripsA.shared(), 1);
    const taker = await openFromCheckout(A, booked);
    const guestAs = sessionCtx(A.id, taker.sessionId);
    for (let i = 1; i <= MAX_CONTACT_CHANGES_PER_DAY; i += 1) {
      const done = await change(guestAs, {
        bookingId: booked.bookingId,
        name: "Taken Over",
        email: `taker${i}@example.test`,
        keepSessionId: taker.sessionId,
      });
      expect(done.kind).toBe("changed");
    }
    expect(
      await change(guestAs, {
        bookingId: booked.bookingId,
        name: "Taken Over",
        email: "taker4@example.test",
        keepSessionId: taker.sessionId,
      }),
    ).toEqual({ kind: "limit_reached" });
    // A guest writer that skips the service is refused by the database.
    expect(
      await failure(
        as(guestAs, (trx) =>
          sql`update checkout_sessions set booker_name = 'Name 4'
               where id = ${booked.checkoutSessionId}`.execute(trx),
        ),
      ),
    ).toEqual({ code: "23514", constraint: "booking_contact_changes_limit" });

    // Staff restore the booking regardless, which ends the taker's session,
    // and the checkout's secret no longer opens one.
    const restored = await change(staffContext(A.id), {
      bookingId: booked.bookingId,
      name: "Fixture Booker",
      email: "booker@example.test",
    });
    expect(restored.kind).toBe("changed");
    expect(await as(guestContext(A.id), (trx) => manageSession(trx, A.id, taker.token))).toBeNull();
    const reopened = await as(guestContext(A.id), (trx, c) =>
      openManageSessionFromCheckout(trx, c, {
        checkoutSessionId: booked.checkoutSessionId,
        secret: booked.secret,
      }),
    );
    expect(reopened).toEqual({ kind: "window_closed" });
  });

  it("refuses a canceled booking, a departed trip, and another tenant", async () => {
    const canceled = await confirmBooking(runtime.db, payments, A, tripsA.shared(), 1);
    const g = guestContext(A.id);
    const terms = await as(g, (trx) => previewCancellation(trx, A.id, canceled.bookingId));
    if (!terms) throw new Error("no terms");
    const done = await as(g, (trx, c) =>
      cancelBooking(trx, c, {
        bookingId: canceled.bookingId,
        expectedRefundAmount: terms.refundAmount,
      }),
    );
    expect(done.kind).toBe("canceled");
    const input = (bookingId: string) => ({
      bookingId,
      name: "Someone Else",
      email: "else@example.test",
    });
    expect(await change(staffContext(A.id), input(canceled.bookingId))).toEqual({
      kind: "not_confirmed",
    });
    expect(
      await failure(
        as(staffContext(A.id), (trx) =>
          sql`update checkout_sessions set booker_name = 'Someone Else'
               where id = ${canceled.checkoutSessionId}`.execute(trx),
        ),
      ),
    ).toEqual({ code: "23514", constraint: "checkout_sessions_booker_contact" });

    const gone = await confirmBooking(runtime.db, payments, A, tripsA.shared(), 1);
    await admin`
      with t as (select date_trunc('minute', now()) - interval '400 days' as s)
      update public.scheduled_trips st
         set starts_at = t.s, ends_at = t.s + make_interval(mins => st.duration_minutes),
             boat_free_at = t.s + (st.boat_free_at - st.starts_at),
             local_date = (t.s at time zone st.time_zone)::date,
             local_start_time = (t.s at time zone st.time_zone)::time(0)
        from t, public.bookings b
       where b.id = ${gone.bookingId} and st.id = b.trip_id`;
    expect(await change(staffContext(A.id), input(gone.bookingId))).toEqual({
      kind: "trip_departed",
    });
    expect(
      await failure(
        as(staffContext(A.id), (trx) =>
          sql`update checkout_sessions set booker_email = 'else@example.test'
               where id = ${gone.checkoutSessionId}`.execute(trx),
        ),
      ),
    ).toEqual({ code: "23514", constraint: "checkout_sessions_booker_contact" });

    // Another operator's booking is simply not found, and its checkout is invisible.
    const theirs = await confirmBooking(runtime.db, payments, A, tripsA.shared(), 1);
    expect(await change(staffContext(B.id), input(theirs.bookingId))).toEqual({
      kind: "not_found",
    });
    const touched = await as(staffContext(B.id), (trx) =>
      sql`update checkout_sessions set booker_name = 'Someone Else'
           where id = ${theirs.checkoutSessionId}`.execute(trx),
    );
    expect(Number(touched.numAffectedRows ?? 0)).toBe(0);
  });

  it("checks the shape in the database: only the booker, and the history only from the trigger", async () => {
    const booked = await confirmBooking(runtime.db, payments, A, tripsA.shared(), 1);
    // Any other column alongside the booker is refused.
    expect(
      await failure(
        as(staffContext(A.id), (trx) =>
          sql`update checkout_sessions set booker_name = 'X Y', state = 'canceled'
               where id = ${booked.checkoutSessionId}`.execute(trx),
        ),
      ),
    ).toEqual({ code: "23514", constraint: "checkout_sessions_immutable" });
    // The runtime cannot write the history directly, nor change or delete it.
    expect(
      await failure(
        as(staffContext(A.id), (trx) =>
          sql`insert into booking_contact_changes (booking_id, name_changed, email_changed)
              values (${booked.bookingId}, true, false)`.execute(trx),
        ),
      ),
    ).toEqual({ code: "42501", constraint: "booking_contact_changes_source" });
    const done = await change(staffContext(A.id), {
      bookingId: booked.bookingId,
      name: "Fixed Name",
      email: "booker@example.test",
    });
    expect(done.kind).toBe("changed");
    expect(
      (
        await failure(
          as(staffContext(A.id), (trx) =>
            sql`update booking_contact_changes set name_changed = false
                 where booking_id = ${booked.bookingId}`.execute(trx),
          ),
        )
      ).code,
    ).toBeDefined();
    expect(
      (
        await failure(
          as(staffContext(A.id), (trx) =>
            sql`delete from booking_contact_changes where booking_id = ${booked.bookingId}`.execute(
              trx,
            ),
          ),
        )
      ).code,
    ).toBe("42501");
  });

  it("refuses a correction that waited behind another, so the final address keeps working links", async () => {
    const booked = await confirmBooking(runtime.db, payments, A, tripsA.shared(), 2, {
      booker: { name: "Old One", email: "old@example.test" },
    });
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    let started!: () => void;
    const begun = new Promise<void>((r) => {
      started = r;
    });
    // The first transaction starts, then waits; the second runs and commits.
    const first = staffContext(A.id);
    const pending = inTenantTransaction(runtime.db, first, async (trx) => {
      await sql`select now()`.execute(trx);
      started();
      await gate;
      return changeBookerContact(trx, first, {
        bookingId: booked.bookingId,
        name: "Old One",
        email: "aaa@example.test",
      });
    });
    await begun;
    const second = await change(staffContext(A.id), {
      bookingId: booked.bookingId,
      name: "Old One",
      email: "bbb@example.test",
    });
    release();
    const firstResult = await pending;
    // The one that waited changes nothing and asks for a retry: its email
    // would carry a start time earlier than the other's revocations.
    expect(firstResult).toEqual({ kind: "booking_changed" });
    if (second.kind !== "changed") throw new Error("not changed");
    const [count] = await admin<{ n: number }[]>`
      select count(*)::int as n from public.booking_contact_changes
       where booking_id = ${booked.bookingId}`;
    expect(count?.n).toBe(1);

    // bbb@ is the booker: its link and reminder stand, and the link goes out.
    const rows = await messages(booked.bookingId);
    expect(rows.some((m) => m.to_email === "aaa@example.test")).toBe(false);
    const live = rows.filter((m) => m.state === "queued" && m.to_email === "bbb@example.test");
    expect(live.map((m) => m.template).sort()).toEqual(["booking_manage_link", "booking_reminder"]);
    await deliver(A);
    const inbox = await mailTo(A, "bbb@example.test");
    expect(manageToken(inbox.find((m) => m?.subject.startsWith("Your link"))?.html)).toBeDefined();
  });

  it("renews nothing from a link sent before the email was corrected", async () => {
    const booked = await confirmBooking(runtime.db, payments, A, tripsA.shared(), 1, {
      booker: { name: "Old Inbox", email: "oldinbox@example.test" },
    });
    await deliver(A);
    const [confirmation] = await mailTo(A, "oldinbox@example.test");
    const oldLink = manageToken(confirmation?.html) as string;
    // The old link was used once, as a guest would before the change.
    const opened = await as(guestContext(A.id), (trx, c) =>
      openManageSession(trx, c, { token: oldLink }),
    );
    expect(opened.kind).toBe("opened");
    const done = await change(staffContext(A.id), {
      bookingId: booked.bookingId,
      name: "Old Inbox",
      email: "newinbox@example.test",
    });
    expect(done.kind).toBe("changed");
    const renewed = await as(guestContext(A.id), (trx, c) =>
      renewManageLink(trx, c, { token: oldLink, requestKey: randomUUID() }),
    );
    expect(renewed).toEqual({ kind: "not_found" });
  });

  it("delivers email a command wrote after waiting behind a correction, to the new address (0052)", async () => {
    const booked = await confirmBooking(runtime.db, payments, A, tripsA.shared(), 1, {
      booker: { name: "Slow Asker", email: "slow.old@example.test" },
    });
    // The confirmation's link exists, so the correction revokes one.
    await deliver(A);
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    let started!: () => void;
    const begun = new Promise<void>((r) => {
      started = r;
    });
    // A link request whose transaction starts before the correction and
    // writes after it commits.
    const asker = guestContext(A.id);
    const requestKey = `slow-${randomUUID()}`;
    const pending = inTenantTransaction(runtime.db, asker, async (trx) => {
      await sql`select now()`.execute(trx);
      started();
      await gate;
      return requestManageLink(trx, asker, { bookingId: booked.bookingId, requestKey });
    });
    await begun;
    const done = await change(staffContext(A.id), {
      bookingId: booked.bookingId,
      name: "Slow Asker",
      email: "slow.new@example.test",
    });
    expect(done.kind).toBe("changed");
    release();
    expect((await pending).kind).toBe("enqueued");
    await deliver(A);
    const rows = await messages(booked.bookingId);
    const asked = rows.find((m) => m.dedupe_key.includes(requestKey));
    expect(asked).toMatchObject({ to_email: "slow.new@example.test", state: "sent" });
  });

  it("renews nothing from an old link whose renewal waited behind the correction", async () => {
    const booked = await confirmBooking(runtime.db, payments, A, tripsA.shared(), 1, {
      booker: { name: "Racing Inbox", email: "race.old@example.test" },
    });
    await deliver(A);
    const [confirmation] = await mailTo(A, "race.old@example.test");
    const oldLink = manageToken(confirmation?.html) as string;
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    let held!: () => void;
    const holding = new Promise<void>((r) => {
      held = r;
    });
    const staff = staffContext(A.id);
    const desk = inTenantTransaction(runtime.db, staff, async (trx) => {
      const result = await changeBookerContact(trx, staff, {
        bookingId: booked.bookingId,
        name: "Racing Inbox",
        email: "race.new@example.test",
      });
      held();
      await gate;
      return result;
    });
    await holding;
    const renewal = as(guestContext(A.id), (trx, c) =>
      renewManageLink(trx, c, { token: oldLink, requestKey: randomUUID() }),
    );
    await new Promise((r) => setTimeout(r, 100));
    release();
    expect((await desk).kind).toBe("changed");
    expect(await renewal).toEqual({ kind: "not_found" });
  });

  it("refuses a guest correction whose session staff ended while it waited", async () => {
    const booked = await confirmBooking(runtime.db, payments, A, tripsA.shared(), 1, {
      booker: { name: "Real Booker", email: "real@example.test" },
    });
    const taker = await openFromCheckout(A, booked);
    // Staff hold the checkout's lock while restoring the booking; the guest's
    // request arrives meanwhile and waits behind it.
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    let restored!: () => void;
    const restoring = new Promise<void>((r) => {
      restored = r;
    });
    const staff = staffContext(A.id);
    const desk = inTenantTransaction(runtime.db, staff, async (trx) => {
      const done = await changeBookerContact(trx, staff, {
        bookingId: booked.bookingId,
        name: "Real Booker",
        email: "real.new@example.test",
      });
      restored();
      await gate;
      return done;
    });
    await restoring;
    const guestAs = sessionCtx(A.id, taker.sessionId);
    const late = change(guestAs, {
      bookingId: booked.bookingId,
      name: "Taker",
      email: "taker@example.test",
      keepSessionId: taker.sessionId,
    });
    await new Promise((r) => setTimeout(r, 100));
    release();
    expect((await desk).kind).toBe("changed");
    expect(await late).toEqual({ kind: "session_ended" });
    const view = await as(guestContext(A.id), (trx) =>
      getManagedBooking(trx, A.id, booked.bookingId),
    );
    expect(view?.booking.booker.email).toBe("real.new@example.test");
  });

  it("rewrites a reminder due within the next day for the same moment", async () => {
    const booked = await confirmBooking(runtime.db, payments, A, tripsA.shared(), 1);
    const due = new Date(Date.now() + 3 * 3600_000);
    await admin`update public.email_messages set next_attempt_at = ${due}
                 where booking_id = ${booked.bookingId} and template = 'booking_reminder'`;
    const done = await change(staffContext(A.id), {
      bookingId: booked.bookingId,
      name: "Fixture Booker",
      email: "soon@example.test",
    });
    expect(done.kind).toBe("changed");
    const moved = (await messages(booked.bookingId)).filter(
      (m) => m.template === "booking_reminder" && m.state === "queued",
    );
    expect(moved).toHaveLength(1);
    expect(moved[0]?.to_email).toBe("soon@example.test");
    expect(moved[0]?.next_attempt_at.getTime()).toBe(due.getTime());
  });

  it("masks an address to its first letters and its last domain part", () => {
    expect(maskEmail("ava.guest@example.test")).toBe("a•••@e•••.test");
    expect(maskEmail("x@mail.co.uk")).toBe("x•••@m•••.uk");
  });
});
