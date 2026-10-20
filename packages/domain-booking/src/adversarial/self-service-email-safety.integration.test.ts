/**
 * The confirmation email never holds a paid booking hostage (lane 1, review
 * F2). The email is written inside the confirming transaction, after the
 * payment is recorded and the booking row is written. A stored value the
 * email cannot carry, or any other failure writing it, must leave the booking
 * confirmed: the email is written under a savepoint, a failure is audited for
 * staff, and the confirmation commits.
 */
import { createDb } from "@tidegrid/database";
import type {} from "@tidegrid/database/global-setup";
import { tripAllocator } from "@tidegrid/domain-inventory/testing";
import { FakeEmailProvider } from "@tidegrid/domain-messaging";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";
import { type CheckoutFixture, createCheckoutFixture, fakeProvider } from "../test-fixtures.ts";
import {
  addLocalHostname,
  book,
  deliverMail,
  messagesOf,
  type SelfServiceWorld,
} from "./self-service-harness.ts";

const env = inject("integrationDb");
const tab = String.fromCharCode(9);
const lf = String.fromCharCode(10);

/** Whether a text holds any C0 or C1 control character. */
const hasControl = (text: string) =>
  [...text].some((ch) => {
    const code = ch.charCodeAt(0);
    return code < 0x20 || (code >= 0x7f && code <= 0x9f);
  });

describe.skipIf(!env)("adversarial: the confirmation email never undoes a paid booking", () => {
  let world: SelfServiceWorld;
  let runtime: ReturnType<typeof createDb>;
  let A: CheckoutFixture;
  let B: CheckoutFixture;
  let tripsA: ReturnType<typeof tripAllocator>;
  let tripsB: ReturnType<typeof tripAllocator>;

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
    [A, B] = await Promise.all([
      createCheckoutFixture(admin, runtime.db, "ss-mail-a", { days: 20 }),
      createCheckoutFixture(admin, runtime.db, "ss-mail-b", { days: 22 }),
    ]);
    for (const t of [A, B]) await addLocalHostname(admin, t);
    tripsA = tripAllocator(A);
    tripsB = tripAllocator(B);
  });

  afterAll(async () => {
    await runtime?.end();
    await world?.admin.end({ timeout: 5 });
  });

  it("confirms a booking whose product name carries a tab and a newline, with a one-line subject", async () => {
    const tripId = tripsA.shared();
    await world.admin`
      update public.products p set name = ${`Sunset${tab}Harbor${lf}Cruise`}
        from public.scheduled_trips t
       where t.id = ${tripId} and p.tenant_id = t.tenant_id and p.id = t.product_id`;
    const b = await book(world, A, tripId, 1);
    const [confirmation] = await messagesOf(world.admin, b.bookingId);
    expect(confirmation).toMatchObject({ template: "booking_confirmation", state: "queued" });
    const [stored] = await world.admin<{ subject: string }[]>`
      select subject from public.email_messages where id = ${confirmation?.id ?? null}`;
    expect(stored?.subject).toMatch(/^Booking \S+ confirmed: Sunset Harbor Cruise, /);
    expect(hasControl(stored?.subject ?? "")).toBe(false);
    await deliverMail(world, A.id);
    expect((await messagesOf(world.admin, b.bookingId))[0]).toMatchObject({ state: "sent" });
  });

  it("confirms the booking and audits the failure when its email cannot be written", async () => {
    // Any failure writing the email, here the database refusing every message of this operator.
    await world.admin.unsafe(`
      create or replace function public.test_refuse_email() returns trigger
        language plpgsql as $$
      begin
        raise exception 'no email for this operator' using errcode = '23514';
      end $$`);
    await world.admin.unsafe(`
      create trigger test_refuse_email before insert on public.email_messages
        for each row when (new.tenant_id = '${B.id}'::uuid)
        execute function public.test_refuse_email()`);
    try {
      const b = await book(world, B, tripsB.shared(), 2);
      const [booking] = await world.admin<{ state: string; payment: string }[]>`
        select b.state, p.state as payment from public.bookings b
          join public.payments p on p.id = b.payment_id
         where b.id = ${b.bookingId}`;
      expect(booking).toEqual({ state: "confirmed", payment: "succeeded" });
      expect(await messagesOf(world.admin, b.bookingId)).toEqual([]);
      const audits = await world.admin<{ action: string; after_state: { error?: string } }[]>`
        select action, after_state from public.audit_events
         where tenant_id = ${B.id} and subject_id = ${b.bookingId}
           and action = 'booking.confirmation_email_failed'`;
      expect(audits).toHaveLength(1);
      const [event] = await world.admin<{ n: number }[]>`
        select count(*)::int as n from public.outbox_events
         where tenant_id = ${B.id} and topic = 'booking.confirmation_email_failed'
           and payload->>'bookingId' = ${b.bookingId}`;
      expect(event?.n).toBe(1);
      // The rest of the confirmation committed with it: the hold is confirmed.
      const [hold] = await world.admin<{ state: string }[]>`
        select state from public.capacity_holds where id = ${b.holdId}`;
      expect(hold?.state).toBe("confirmed");
    } finally {
      await world.admin.unsafe("drop trigger if exists test_refuse_email on public.email_messages");
      await world.admin.unsafe("drop function if exists public.test_refuse_email()");
    }
  });
});
