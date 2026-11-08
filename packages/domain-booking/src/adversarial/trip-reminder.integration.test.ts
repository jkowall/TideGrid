/**
 * The trip reminder (W3-G2.16-rest): written with the confirmation, sent a
 * day before the trip leaves, never after the booking is canceled, and never
 * within two hours of departure, however long a retry waited.
 */
import { createDb } from "@tidegrid/database";
import type {} from "@tidegrid/database/global-setup";
import { tripAllocator } from "@tidegrid/domain-inventory/testing";
import { enqueueMessage, FakeEmailProvider } from "@tidegrid/domain-messaging";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";
import { cancelBooking, previewCancellation } from "../index.ts";
import { type CheckoutFixture, createCheckoutFixture, fakeProvider } from "../test-fixtures.ts";
import {
  acceptedFor,
  addLocalHostname,
  asGuest,
  asSystem,
  type Booked,
  book,
  deliveredToken,
  deliverMail,
  departIn,
  makeDue,
  messageOf,
  redeem,
  type SelfServiceWorld,
} from "./self-service-harness.ts";

const env = inject("integrationDb");

interface ReminderRow {
  id: string;
  state: string;
  dedupe_key: string;
  link_purpose: string | null;
  last_error_code: string | null;
  due_lead_hours: number;
}

describe.skipIf(!env)("the trip reminder (W3-G2.16-rest)", () => {
  let world: SelfServiceWorld;
  let runtime: ReturnType<typeof createDb>;
  let A: CheckoutFixture;
  let trips: ReturnType<typeof tripAllocator>;

  async function reminderOf(bookingId: string): Promise<ReminderRow[]> {
    return world.admin<ReminderRow[]>`
      select m.id, m.state, m.dedupe_key, m.link_purpose, m.last_error_code,
             extract(epoch from (t.starts_at - m.next_attempt_at))::int / 3600 as due_lead_hours
        from public.email_messages m
        join public.bookings b on b.id = m.booking_id
        join public.scheduled_trips t on t.id = b.trip_id
       where m.booking_id = ${bookingId} and m.template = 'booking_reminder'`;
  }

  async function cancel(b: Booked) {
    const terms = await asGuest(world.db, A.id, (trx) =>
      previewCancellation(trx, A.id, b.bookingId),
    );
    if (!terms) throw new Error("setup: no terms");
    const done = await asGuest(world.db, A.id, (trx, ctx) =>
      cancelBooking(trx, ctx, { bookingId: b.bookingId, expectedRefundAmount: terms.refundAmount }),
    );
    if (done.kind !== "canceled") throw new Error(`setup cancel: ${done.kind}`);
  }

  beforeAll(async () => {
    if (!env) return;
    const admin = postgres(env.adminUrl, { max: 2, onnotice: () => {} });
    runtime = createDb(env.runtimeUrl, { max: 6 });
    world = {
      admin,
      db: runtime.db,
      payments: fakeProvider(runtime.db),
      mail: new FakeEmailProvider({ db: runtime.db, environment: "local" }),
    };
    A = await createCheckoutFixture(admin, runtime.db, "ss-reminder-a", { days: 30 });
    await addLocalHostname(admin, A);
    trips = tripAllocator(A);
  });

  afterAll(async () => {
    await runtime?.end();
    await world?.admin.end({ timeout: 5 });
  });

  it("queues one reminder with the booking, due a day before the trip, and sends nothing early", async () => {
    const b = await book(world, A, trips.shared(), 1);
    const [reminder, ...more] = await reminderOf(b.bookingId);
    expect(more).toEqual([]);
    expect(reminder).toMatchObject({
      state: "queued",
      dedupe_key: `booking.reminder:${b.bookingId}`,
      link_purpose: "booking_manage",
      due_lead_hours: 24,
    });
    await deliverMail(world, A.id);
    await deliverMail(world, A.id);
    expect((await reminderOf(b.bookingId))[0]?.state).toBe("queued");
    expect(await acceptedFor(world.admin, reminder?.id ?? "")).toBeNull();
  });

  it("sends a due reminder with a management link that opens the booking", async () => {
    const b = await book(world, A, trips.shared(), 1);
    const [reminder] = await reminderOf(b.bookingId);
    if (!reminder) throw new Error("setup: no reminder");
    await deliverMail(world, A.id);
    await makeDue(world.admin, reminder.id);
    await deliverMail(world, A.id);
    expect(await messageOf(world.admin, reminder.id)).toMatchObject({ state: "sent" });
    const accepted = await acceptedFor(world.admin, reminder.id);
    expect(accepted?.html).toContain("Your trip is coming up");
    expect(accepted?.text).toContain(b.reference);
    const token = await deliveredToken(world.admin, reminder.id);
    expect((await redeem(world, A.id, token)).kind).toBe("opened");
  });

  it("writes no reminder for a trip that leaves too soon for one", async () => {
    const tripId = trips.shared();
    await departIn(world.admin, tripId, 25 * 60);
    const b = await book(world, A, tripId, 1);
    expect(await reminderOf(b.bookingId)).toEqual([]);
    const [confirmation] = await world.admin<{ n: number }[]>`
      select count(*)::int as n from public.email_messages
       where booking_id = ${b.bookingId} and template = 'booking_confirmation'`;
    expect(confirmation?.n).toBe(1);
  });

  it("cancels the waiting reminder with the booking, and it never goes out", async () => {
    const b = await book(world, A, trips.shared(), 1);
    const [reminder] = await reminderOf(b.bookingId);
    if (!reminder) throw new Error("setup: no reminder");
    await cancel(b);
    expect(await messageOf(world.admin, reminder.id)).toMatchObject({
      state: "canceled",
      last_error_code: "booking_canceled",
    });
    await deliverMail(world, A.id);
    expect(await acceptedFor(world.admin, reminder.id)).toBeNull();
  });

  it("cancels a reminder at claim once its trip leaves within two hours, with no send", async () => {
    const tripId = trips.shared();
    const b = await book(world, A, tripId, 1);
    const [reminder] = await reminderOf(b.bookingId);
    if (!reminder) throw new Error("setup: no reminder");
    await deliverMail(world, A.id);
    // A retry waited too long: the trip now leaves in an hour.
    await departIn(world.admin, tripId, 60);
    await makeDue(world.admin, reminder.id);
    const report = await deliverMail(world, A.id);
    expect(report.items).toContainEqual(
      expect.objectContaining({
        messageId: reminder.id,
        outcome: "canceled",
        code: "reminder_too_late",
      }),
    );
    expect(await messageOf(world.admin, reminder.id)).toMatchObject({
      state: "canceled",
      last_error_code: "reminder_too_late",
    });
    expect(await acceptedFor(world.admin, reminder.id)).toBeNull();
    const [links] = await world.admin<{ n: number }[]>`
      select count(*)::int as n from public.guest_access_links where message_id = ${reminder.id}`;
    expect(links?.n).toBe(0);
  });

  it("cancels at claim a reminder written for a booking already canceled", async () => {
    const b = await book(world, A, trips.shared(), 1);
    await deliverMail(world, A.id);
    await cancel(b);
    // A reminder that got past the cancellation's own sweep of pending email:
    // the claim still refuses it.
    const late = await asSystem(world.db, A.id, (trx, ctx) =>
      enqueueMessage(trx, ctx, {
        dedupeKey: `test.reminder:${b.bookingId}`,
        template: "booking_reminder",
        templateVersion: 1,
        to: { email: b.bookerEmail },
        bookingId: b.bookingId,
        content: {
          subject: "Trip reminder",
          blocks: [{ kind: "paragraph", text: "A synthetic reminder." }],
        },
      }),
    );
    await deliverMail(world, A.id);
    await deliverMail(world, A.id);
    expect(await messageOf(world.admin, late.messageId)).toMatchObject({
      state: "canceled",
      last_error_code: "reminder_too_late",
    });
    expect(await acceptedFor(world.admin, late.messageId)).toBeNull();
  });
});
