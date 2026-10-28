/**
 * The email a cancellation leaves behind (lane 1, review M1, M2, and F7).
 *
 * - A confirmation still waiting to go out when the guest cancels (its first
 *   send failed and it is in its retry backoff) is canceled with the
 *   booking, so "You're booked" never arrives after "Your booking is
 *   canceled". Its links keep working: the guest opens the canceled booking
 *   and its refund with them.
 * - The cancellation email says the refund is on its way, not that it has
 *   arrived, and a refund the provider refuses sends a follow-up.
 */
import { createDb } from "@tidegrid/database";
import type {} from "@tidegrid/database/global-setup";
import { tripAllocator } from "@tidegrid/domain-inventory/testing";
import {
  type EmailProvider,
  EmailProviderUnavailableError,
  FakeEmailProvider,
} from "@tidegrid/domain-messaging";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";
import { cancelBooking, previewCancellation, settleRefund } from "../index.ts";
import {
  type CheckoutFixture,
  createCheckoutFixture,
  fakeProvider,
  guestContext,
} from "../test-fixtures.ts";
import { FlakyProvider } from "./harness.ts";
import {
  acceptedFor,
  addLocalHostname,
  asGuest,
  type Booked,
  book,
  deliveredToken,
  deliverMail,
  makeDue,
  messageOf,
  messagesOf,
  redeem,
  type SelfServiceWorld,
} from "./self-service-harness.ts";

const env = inject("integrationDb");

describe.skipIf(!env)("adversarial: the email a cancellation leaves behind", () => {
  let world: SelfServiceWorld;
  let runtime: ReturnType<typeof createDb>;
  let A: CheckoutFixture;
  let trips: ReturnType<typeof tripAllocator>;

  async function cancel(b: Booked) {
    const terms = await asGuest(world.db, A.id, (trx) =>
      previewCancellation(trx, A.id, b.bookingId),
    );
    if (!terms) throw new Error("setup: no terms");
    const done = await asGuest(world.db, A.id, (trx, ctx) =>
      cancelBooking(trx, ctx, { bookingId: b.bookingId, expectedRefundAmount: terms.refundAmount }),
    );
    if (done.kind !== "canceled") throw new Error(`setup cancel: ${done.kind}`);
    return done;
  }

  /** A provider that cannot be reached, as during an outage. */
  const down: EmailProvider = {
    name: "fake",
    deduplicates: true,
    send: async () => {
      throw new EmailProviderUnavailableError("provider_unavailable");
    },
  };

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
    A = await createCheckoutFixture(admin, runtime.db, "ss-cxlmail-a", { days: 30 });
    await addLocalHostname(admin, A);
    trips = tripAllocator(A);
  });

  afterAll(async () => {
    await runtime?.end();
    await world?.admin.end({ timeout: 5 });
  });

  it("cancels a confirmation still in its retry backoff, so only the cancellation goes out, and keeps its link", async () => {
    const b = await book(world, A, trips.shared(), 1);
    // The confirmation's first send meets an outage: it waits for a retry,
    // with a link already issued (the provider may have kept that email).
    await deliverMail(world, A.id, down);
    const [confirmation] = await messagesOf(world.admin, b.bookingId);
    if (!confirmation) throw new Error("setup: no confirmation");
    expect(confirmation).toMatchObject({ state: "queued", attempts: 1 });

    await cancel(b);
    expect(await messageOf(world.admin, confirmation.id)).toMatchObject({
      state: "canceled",
      last_error_code: "booking_canceled",
    });

    // Time passes and the job runs: only the cancellation email goes out.
    await makeDue(world.admin, confirmation.id);
    await deliverMail(world, A.id);
    await deliverMail(world, A.id);
    const after = await messagesOf(world.admin, b.bookingId);
    expect(after.map((m) => [m.template, m.state])).toEqual([
      ["booking_confirmation", "canceled"],
      ["booking_canceled", "sent"],
    ]);
    expect(await acceptedFor(world.admin, confirmation.id)).toBeNull();

    // The link the confirmation's attempt issued still opens the canceled booking.
    const [link] = await world.admin<{ live: number }[]>`
      select count(*)::int as live from public.guest_access_links
       where message_id = ${confirmation.id} and consumed_at is null and revoked_at is null`;
    expect(link?.live).toBe(1);
  });

  it("keeps a sent confirmation's link working after the cancellation", async () => {
    const b = await book(world, A, trips.shared(), 1);
    await deliverMail(world, A.id);
    const [confirmation] = await messagesOf(world.admin, b.bookingId);
    if (!confirmation) throw new Error("setup: no confirmation");
    const token = await deliveredToken(world.admin, confirmation.id);
    await cancel(b);
    await deliverMail(world, A.id);
    expect((await redeem(world, A.id, token)).kind).toBe("opened");
  });

  it("says the refund is on its way, and follows up once when the provider refuses it", async () => {
    const b = await book(world, A, trips.shared(), 1);
    const canceled = await cancel(b);
    const refundId = canceled.cancellation.refundId;
    if (!refundId) throw new Error("setup: no refund");
    await deliverMail(world, A.id);
    const [notice] = await world.admin<{ text_body: string }[]>`
      select text_body from public.email_messages
       where booking_id = ${b.bookingId} and template = 'booking_canceled'`;
    expect(notice?.text_body).toContain("on its way back to your original payment method");
    expect(notice?.text_body).toContain("If the refund can't be made, we'll email you.");

    const refusing = new FlakyProvider(world.payments);
    refusing.failRefund = "reject";
    expect(await settleRefund(world.db, refusing, guestContext(A.id), refundId)).toMatchObject({
      kind: "failed",
    });
    // Settling again changes nothing and writes no second follow-up.
    expect(await settleRefund(world.db, refusing, guestContext(A.id), refundId)).toEqual({
      kind: "not_pending",
    });
    await deliverMail(world, A.id);
    const followUps = await world.admin<{ state: string; text_body: string }[]>`
      select state, text_body from public.email_messages
       where booking_id = ${b.bookingId} and template = 'booking_refund_failed'`;
    expect(followUps).toHaveLength(1);
    expect(followUps[0]?.state).toBe("sent");
    expect(followUps[0]?.text_body).toContain("has not been returned yet");
  });

  it("sends no follow-up when the refund goes through", async () => {
    const b = await book(world, A, trips.shared(), 1);
    const canceled = await cancel(b);
    const refundId = canceled.cancellation.refundId;
    if (!refundId) throw new Error("setup: no refund");
    expect(
      await settleRefund(world.db, world.payments, guestContext(A.id), refundId),
    ).toMatchObject({ kind: "succeeded" });
    const [followUps] = await world.admin<{ n: number }[]>`
      select count(*)::int as n from public.email_messages
       where booking_id = ${b.bookingId} and template = 'booking_refund_failed'`;
    expect(followUps?.n).toBe(0);
  });
});
