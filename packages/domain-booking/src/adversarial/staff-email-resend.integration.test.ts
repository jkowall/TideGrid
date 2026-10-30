/**
 * Staff resend of a booking's email (G2.16b): the confirmation, with a new
 * management link, or the cancellation notice, sent again as a new message by
 * an owner or booking staff from the console. Every call under test runs as
 * tidegrid_app over real PostgreSQL connections; the admin connection only
 * builds fixtures and reads stored state.
 *
 * What these prove (packet section 7, domain cases 1 to 14):
 * - At most once per message: a resend is a new message with its own id; an
 *   unknown outcome, the resend's own included, is never sent again on a
 *   provider that does not deduplicate (the Cloudflare recorder below).
 * - The link rule: the resend's token is minted at send time; the earlier
 *   link is superseded then, never revoked, so it still renews.
 * - Limits across requests and staff, counted from committed rows under the
 *   booking's lock: 5 deliverable resends, 10 minutes apart, 50 an hour per
 *   operator. Time-dependent cases use the service's `at` clock, since the
 *   email_messages trigger fixes created_at to now() (0009:579, 592-612).
 * - Every refusal is decided before any write, in a fixed order, and a
 *   refused request leaves every earlier message as it was.
 * - Audit names ids and codes only; status reads flag a resend and carry no
 *   recipient or content; another tenant reaches nothing.
 *
 * `booking_email_invalid` cannot be reached with stored data: a booker's name
 * is 1 to 120 characters with no controls (0007:158-159) and immutable
 * (0007:614), and the composers cut every text they use. The service keeps
 * the refusal under a savepoint as a guard, and case 10 forces a TypeError
 * from `enqueueMessage` through a pass-through module mock to prove it.
 */
import { randomUUID } from "node:crypto";
import { createDb, inTenantTransaction, type TenantContext } from "@tidegrid/database";
import type {} from "@tidegrid/database/global-setup";
import { tripAllocator } from "@tidegrid/domain-inventory/testing";
import {
  type CloudflareEmailBuilder,
  createCloudflareEmailProvider,
  type EmailProvider,
  enqueueMessage,
  FakeEmailProvider,
  listBookingMessages,
  type SendEmailBinding,
} from "@tidegrid/domain-messaging";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, inject, it, vi } from "vitest";
import {
  cancelBooking,
  previewCancellation,
  type ResendFacts,
  type ResendKind,
  type ResendReason,
  type ResendResult,
  refusalsOf,
  renewManageLink,
  requestManageLink,
  resendAvailability,
  resendBookingEmail,
  settleRefund,
} from "../index.ts";
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
  asSystem,
  type Booked,
  book,
  deliverMail,
  departIn,
  messageOf,
  messagesOf,
  redeem,
  type SelfServiceWorld,
  tokenIn,
} from "./self-service-harness.ts";

// Case 10: a composer that throws, as a programmer error would. Off unless a
// test sets the count; every other call goes to the real enqueueMessage.
const fault = vi.hoisted(() => ({ enqueue: 0 }));
vi.mock("@tidegrid/domain-messaging", async (importOriginal) => {
  const real = await importOriginal<typeof import("@tidegrid/domain-messaging")>();
  return {
    ...real,
    enqueueMessage: (...args: Parameters<typeof real.enqueueMessage>) => {
      if (fault.enqueue > 0) {
        fault.enqueue -= 1;
        throw new TypeError("a recipient's name must be 1 to 120 characters");
      }
      return real.enqueueMessage(...args);
    },
  };
});

const env = inject("integrationDb");

interface Recorder {
  binding: SendEmailBinding;
  sends: CloudflareEmailBuilder[];
  failNext(code: string): void;
}

/** An inline stand-in for the send_email binding, as cloudflare-email.integration.test.ts uses. */
function recorder(): Recorder {
  const sends: CloudflareEmailBuilder[] = [];
  const faults: string[] = [];
  let n = 0;
  return {
    sends,
    failNext: (code) => faults.push(code),
    binding: {
      send: async (builder) => {
        sends.push(structuredClone(builder));
        const code = faults.shift();
        if (code) throw Object.assign(new Error(`${code} for a synthetic booker`), { code });
        n += 1;
        return { messageId: `0101018f7d0c4d9a-rsd-${String(n).padStart(8, "0")}` };
      },
    },
  };
}

const callsFor = (rec: Recorder, messageId: string) =>
  rec.sends.filter((b) => b.headers["X-TideGrid-Message-Id"] === messageId);

interface ResendRow {
  id: string;
  dedupe_key: string;
  template: string;
  state: string;
  attempts: number;
  last_error_code: string | null;
  created_at: Date;
}

describe.skipIf(!env)("adversarial: staff resend of a booking's email (G2.16b)", () => {
  let world: SelfServiceWorld;
  let runtime: ReturnType<typeof createDb>;
  /** Fake-provider cases. */
  let A: CheckoutFixture;
  /** Another tenant, for isolation. */
  let B: CheckoutFixture;
  /** The operator's hourly cap, filled on purpose. */
  let C: CheckoutFixture;
  /** Cloudflare recorder cases, so no other tenant's mail meets the recorder. */
  let CF: CheckoutFixture;
  let tripsA: ReturnType<typeof tripAllocator>;
  let tripsB: ReturnType<typeof tripAllocator>;
  let tripsC: ReturnType<typeof tripAllocator>;
  let tripsCF: ReturnType<typeof tripAllocator>;
  const staffOne = randomUUID();
  const staffTwo = randomUUID();
  let count = 0;
  const cfBookers: string[] = [];

  function booker(label = "resend") {
    count += 1;
    const email = `${label}.${count}.${Date.now().toString(36)}@example.test`;
    cfBookers.push(email);
    return { name: `Synthetic Resend Booker ${count}`, email };
  }

  function cloudflare(rec: Recorder): EmailProvider {
    return createCloudflareEmailProvider({
      binding: rec.binding,
      recipients: { kind: "only", addresses: new Set(cfBookers) },
      environment: "local",
    });
  }

  function staffContext(tenantId: string, actor: string): TenantContext {
    return {
      tenantId,
      actorType: "staff",
      actorId: actor,
      requestId: `g216b-${randomUUID()}`,
    };
  }

  function resend(
    tenant: CheckoutFixture,
    bookingId: string,
    kind: ResendKind,
    options: { reason?: ResendReason; at?: Date; actor?: string } = {},
  ): Promise<ResendResult> {
    const ctx = staffContext(tenant.id, options.actor ?? staffOne);
    return inTenantTransaction(world.db, ctx, (trx) =>
      resendBookingEmail(
        trx,
        ctx,
        { bookingId, kind, reason: options.reason ?? "guest_did_not_receive" },
        options.at ? { at: options.at } : {},
      ),
    );
  }

  function availability(tenant: CheckoutFixture, bookingId: string, at?: Date) {
    return asSystem(world.db, tenant.id, (trx) =>
      resendAvailability(trx, tenant.id, bookingId, at ? { at } : {}),
    );
  }

  function queued(result: ResendResult) {
    if (result.kind !== "queued")
      throw new Error(`expected a queued resend, got ${JSON.stringify(result)}`);
    return result;
  }

  /** The database clock `minutes` from now: the service's `at` for time passing. */
  async function dbLater(minutes: number): Promise<Date> {
    const [row] = await world.admin<{ at: Date }[]>`
      select now() + make_interval(mins => ${minutes}) as at`;
    if (!row) throw new Error("no clock");
    return row.at;
  }

  async function resendRows(bookingId: string): Promise<ResendRow[]> {
    return world.admin<ResendRow[]>`
      select id, dedupe_key, template, state, attempts, last_error_code, created_at
        from public.email_messages
       where booking_id = ${bookingId} and starts_with(dedupe_key, 'booking.resend:')
       order by created_at, id`;
  }

  async function auditRows(bookingId: string) {
    return world.admin<
      {
        actor_type: string;
        actor_id: string;
        reason: string;
        subject_type: string;
        after_state: Record<string, unknown>;
      }[]
    >`
      select actor_type, actor_id, reason, subject_type, after_state from public.audit_events
       where subject_id = ${bookingId} and action = 'booking.email_resent'
       order by id`;
  }

  async function liveLinks(messageId: string) {
    return world.admin<{ revoked_reason: string | null; consumed: boolean }[]>`
      select revoked_reason, consumed_at is not null as consumed
        from public.guest_access_links where message_id = ${messageId} order by created_at, id`;
  }

  async function cancel(tenant: CheckoutFixture, b: Booked) {
    const terms = await asGuest(world.db, tenant.id, (trx) =>
      previewCancellation(trx, tenant.id, b.bookingId),
    );
    if (!terms) throw new Error("setup: no terms");
    const done = await asGuest(world.db, tenant.id, (trx, ctx) =>
      cancelBooking(trx, ctx, { bookingId: b.bookingId, expectedRefundAmount: terms.refundAmount }),
    );
    if (done.kind !== "canceled") throw new Error(`setup cancel: ${done.kind}`);
    return done.cancellation;
  }

  /** An earlier staff resend written straight through enqueueMessage, as another writer would. */
  async function seedResend(
    tenant: CheckoutFixture,
    bookingId: string,
    generation: number,
    template = "booking_confirmation",
  ): Promise<string> {
    return asSystem(world.db, tenant.id, async (trx, ctx) => {
      const made = await enqueueMessage(trx, ctx, {
        dedupeKey: `booking.resend:${bookingId}:${generation}`,
        template,
        templateVersion: 1,
        to: { email: "synthetic.seeded@example.test" },
        bookingId,
        content: { subject: "Seeded resend", blocks: [{ kind: "paragraph", text: "Seeded." }] },
      });
      return made.messageId;
    });
  }

  beforeAll(async () => {
    if (!env) return;
    const admin = postgres(env.adminUrl, { max: 3, onnotice: () => {} });
    runtime = createDb(env.runtimeUrl, { max: 8 });
    world = {
      admin,
      db: runtime.db,
      payments: fakeProvider(runtime.db),
      mail: new FakeEmailProvider({ db: runtime.db, environment: "local" }),
    };
    [A, B, C, CF] = await Promise.all([
      createCheckoutFixture(admin, runtime.db, "rsd-a", { days: 30 }),
      createCheckoutFixture(admin, runtime.db, "rsd-b", { days: 4 }),
      createCheckoutFixture(admin, runtime.db, "rsd-c", { days: 6 }),
      createCheckoutFixture(admin, runtime.db, "rsd-cf", { days: 6 }),
    ]);
    for (const t of [A, B, C, CF]) await addLocalHostname(admin, t);
    tripsA = tripAllocator(A);
    tripsB = tripAllocator(B);
    tripsC = tripAllocator(C);
    tripsCF = tripAllocator(CF);
  });

  afterAll(async () => {
    await runtime?.end();
    await world?.admin.end({ timeout: 5 });
  });

  // 1, 2: at most once, over a provider that does not deduplicate -------------------------------

  it("1. sends the confirmation again after an unknown outcome, once, with a new link; the old link answers superseded", async () => {
    const rec = recorder();
    const b = await book(world, CF, tripsCF.shared(), 1, { booker: booker() });
    const cf = cloudflare(rec);
    rec.failNext("E_DELIVERY_FAILED");
    await deliverMail(world, CF.id, cf);
    const [original] = await messagesOf(world.admin, b.bookingId);
    if (!original) throw new Error("setup: no confirmation");
    expect(original).toMatchObject({
      template: "booking_confirmation",
      state: "failed",
      last_error_code: "outcome_unknown",
    });
    // The copy the provider may have delivered before its answer was lost.
    const oldToken = tokenIn(callsFor(rec, original.id)[0]?.html ?? "");
    if (!oldToken) throw new Error("setup: the first attempt carried no link");

    const sent = queued(
      await resend(CF, b.bookingId, "confirmation", { reason: "delivery_unknown" }),
    );
    expect(sent.generation).toBe(1);
    expect(sent.canceledMessageIds).toEqual([]);
    expect(await resendRows(b.bookingId)).toEqual([
      expect.objectContaining({
        id: sent.messageId,
        dedupe_key: `booking.resend:${b.bookingId}:1`,
        template: "booking_confirmation",
        state: "queued",
      }),
    ]);
    await deliverMail(world, CF.id, cf);
    await deliverMail(world, CF.id, cf);
    const copies = callsFor(rec, sent.messageId);
    expect(copies).toHaveLength(1);
    // Two binding calls in all: the original's one attempt and the resend's one.
    expect(rec.sends.map((s) => s.headers["X-TideGrid-Message-Id"])).toEqual([
      original.id,
      sent.messageId,
    ]);
    const newToken = tokenIn(copies[0]?.html ?? "");
    if (!newToken) throw new Error("the resend carried no link");
    expect(newToken).not.toBe(oldToken);
    expect((await redeem(world, CF.id, oldToken)).kind).toBe("superseded");
    expect((await redeem(world, CF.id, newToken)).kind).toBe("opened");
    expect(await messageOf(world.admin, original.id)).toMatchObject({
      state: "failed",
      last_error_code: "outcome_unknown",
    });
    expect(await messageOf(world.admin, sent.messageId)).toMatchObject({
      state: "sent",
      attempts: 1,
    });
  });

  it("1 (variant), 2. a resend whose own send has an unknown outcome is not sent again, and the earlier link still renews", async () => {
    const rec = recorder();
    const b = await book(world, CF, tripsCF.shared(), 1, { booker: booker() });
    const cf = cloudflare(rec);
    await deliverMail(world, CF.id, cf);
    const [original] = await messagesOf(world.admin, b.bookingId);
    if (!original) throw new Error("setup: no confirmation");
    const oldToken = tokenIn(callsFor(rec, original.id)[0]?.html ?? "");
    if (!oldToken) throw new Error("setup: no link");

    const sent = queued(await resend(CF, b.bookingId, "confirmation"));
    rec.failNext("E_INTERNAL_SERVER_ERROR");
    await deliverMail(world, CF.id, cf);
    await deliverMail(world, CF.id, cf);
    expect(callsFor(rec, sent.messageId)).toHaveLength(1);
    expect(await messageOf(world.admin, sent.messageId)).toMatchObject({
      state: "failed",
      last_error_code: "outcome_unknown",
    });
    // The resend's claim superseded the earlier link before the provider call.
    expect((await redeem(world, CF.id, oldToken)).kind).toBe("superseded");
    const renewed = await asGuest(world.db, CF.id, (trx, ctx) =>
      renewManageLink(trx, ctx, { token: oldToken, requestKey: `renew-${randomUUID()}` }),
    );
    expect(renewed.kind).toBe("enqueued");
  });

  it("2. a resend whose lease lapses mid-send fails as outcome_unknown with no second call", async () => {
    const rec = recorder();
    const b = await book(world, CF, tripsCF.shared(), 1, { booker: booker() });
    const cf = cloudflare(rec);
    await deliverMail(world, CF.id, cf);
    const sent = queued(await resend(CF, b.bookingId, "confirmation"));
    let second: Awaited<ReturnType<typeof deliverMail>> | undefined;
    const stalling: EmailProvider = {
      name: "cloudflare",
      deduplicates: false,
      send: async (email) => {
        const accepted = await cf.send(email);
        if (email.idempotencyKey === sent.messageId && !second) {
          await world.admin`update public.email_messages
                               set lease_expires_at = now() - interval '1 second'
                             where id = ${sent.messageId}`;
          second = await deliverMail(world, CF.id, cf);
        }
        return accepted;
      },
    };
    await deliverMail(world, CF.id, stalling);
    expect(second?.items.find((i) => i.messageId === sent.messageId)).toMatchObject({
      outcome: "failed",
      code: "outcome_unknown",
    });
    expect(callsFor(rec, sent.messageId)).toHaveLength(1);
  });

  // 3, 4: one delivery per resend, one message per request ---------------------------------------

  it("3. with the fake provider, one resend is one accepted delivery", async () => {
    const b = await book(world, A, tripsA.shared(), 1);
    await deliverMail(world, A.id);
    const sent = queued(await resend(A, b.bookingId, "confirmation"));
    await deliverMail(world, A.id);
    await deliverMail(world, A.id);
    expect((await acceptedFor(world.admin, sent.messageId))?.count).toBe(1);
    expect(await messageOf(world.admin, sent.messageId)).toMatchObject({ state: "sent" });
    const [original] = await messagesOf(world.admin, b.bookingId);
    expect((await acceptedFor(world.admin, original?.id ?? ""))?.count).toBe(1);
  });

  it("4. two concurrent resends of one booking write one message; the other answers too_soon", async () => {
    const b = await book(world, A, tripsA.shared(), 1);
    await deliverMail(world, A.id);
    const results = await Promise.all([
      resend(A, b.bookingId, "confirmation", { actor: staffOne }),
      resend(A, b.bookingId, "confirmation", { actor: staffTwo }),
    ]);
    const kinds = results.map((r) => (r.kind === "refused" ? r.code : r.kind)).sort();
    expect(kinds).toEqual(["queued", "too_soon"]);
    expect(await resendRows(b.bookingId)).toHaveLength(1);
    expect(await auditRows(b.bookingId)).toHaveLength(1);
  });

  // 5, 6: limits across requests, and the generation after a cancel ----------------------------

  it("5. waits 10 minutes between resends, and says when the next is allowed", async () => {
    const b = await book(world, A, tripsA.shared(), 1);
    await deliverMail(world, A.id);
    const first = queued(await resend(A, b.bookingId, "confirmation"));
    await deliverMail(world, A.id);
    const [row] = await resendRows(b.bookingId);
    if (!row) throw new Error("no resend row");
    const after = new Date(row.created_at.getTime() + 10 * 60_000);
    const early = await resend(A, b.bookingId, "confirmation");
    expect(early).toEqual({ kind: "refused", code: "too_soon", availableAt: after });
    expect(await availability(A, b.bookingId)).toEqual({
      kind: "confirmation",
      allowed: false,
      availableAt: after,
      remaining: 4,
      blockedBy: "too_soon",
    });
    const later = queued(await resend(A, b.bookingId, "confirmation", { at: await dbLater(11) }));
    expect(later.generation).toBe(2);
    expect(later.messageId).not.toBe(first.messageId);
  });

  it("5. stops at the fifth deliverable resend, across two staff members", async () => {
    const b = await book(world, A, tripsA.shared(), 1);
    await deliverMail(world, A.id);
    for (let k = 0; k < 5; k += 1) {
      const sent = queued(
        await resend(A, b.bookingId, "confirmation", {
          at: await dbLater(11 * k),
          actor: k % 2 === 0 ? staffOne : staffTwo,
        }),
      );
      expect(sent.generation).toBe(k + 1);
      await deliverMail(world, A.id);
    }
    const at = await dbLater(55);
    expect(await resend(A, b.bookingId, "confirmation", { at })).toEqual({
      kind: "refused",
      code: "limit",
      availableAt: null,
    });
    expect(await availability(A, b.bookingId, at)).toEqual({
      kind: "confirmation",
      allowed: false,
      availableAt: null,
      remaining: 0,
      blockedBy: "limit",
    });
    expect(new Set((await auditRows(b.bookingId)).map((a) => a.actor_id))).toEqual(
      new Set([staffOne, staffTwo]),
    );
  });

  it("5, 9. holds 50 resends an hour per operator, across bookings, and a refusal writes nothing", async () => {
    const seed = await book(world, C, tripsC.shared(), 1);
    const seeded: string[] = [];
    for (let n = 1; n <= 50; n += 1) seeded.push(await seedResend(C, seed.bookingId, n));
    const [oldest] = await world.admin<{ created_at: Date }[]>`
      select min(created_at) as created_at from public.email_messages
       where id in ${world.admin(seeded)}`;
    if (!oldest) throw new Error("setup: no seeded rows");

    // A booking whose confirmation is still queued: the refusal must leave it so.
    const b = await book(world, C, tripsC.shared(), 1);
    const before = await messagesOf(world.admin, b.bookingId);
    expect(before).toEqual([expect.objectContaining({ state: "queued" })]);
    const refused = await resend(C, b.bookingId, "confirmation");
    expect(refused).toEqual({
      kind: "refused",
      code: "rate_limited",
      availableAt: new Date(oldest.created_at.getTime() + 3_600_000),
    });
    expect(await messagesOf(world.admin, b.bookingId)).toEqual(before);
    expect(await auditRows(b.bookingId)).toEqual([]);

    const allowed = queued(await resend(C, b.bookingId, "confirmation", { at: await dbLater(61) }));
    expect(allowed.canceledMessageIds).toEqual([before[0]?.id]);
  });

  it("6a. a confirmation resend canceled with its booking does not take its generation: the cancellation resend is a new row", async () => {
    const b = await book(world, A, tripsA.shared(), 1);
    await deliverMail(world, A.id);
    const first = queued(await resend(A, b.bookingId, "confirmation"));
    await cancel(A, b);
    expect(await messageOf(world.admin, first.messageId)).toMatchObject({
      state: "canceled",
      attempts: 0,
      last_error_code: "booking_canceled",
    });
    await deliverMail(world, A.id);
    const notice = queued(await resend(A, b.bookingId, "cancellation", { at: await dbLater(11) }));
    expect(notice.generation).toBe(2);
    expect((await resendRows(b.bookingId)).map((r) => [r.dedupe_key, r.template])).toEqual([
      [`booking.resend:${b.bookingId}:1`, "booking_confirmation"],
      [`booking.resend:${b.bookingId}:2`, "booking_canceled"],
    ]);
    await deliverMail(world, A.id);
    expect(await messageOf(world.admin, notice.messageId)).toMatchObject({ state: "sent" });
    expect((await availability(A, b.bookingId, await dbLater(22)))?.remaining).toBe(4);
  });

  it("6b. a queued resend replaced 11 minutes later is canceled as resent and does not count toward the 5", async () => {
    const b = await book(world, A, tripsA.shared(), 1);
    await deliverMail(world, A.id);
    const first = queued(await resend(A, b.bookingId, "confirmation"));
    const second = queued(await resend(A, b.bookingId, "confirmation", { at: await dbLater(11) }));
    expect(second.generation).toBe(2);
    expect(second.canceledMessageIds).toEqual([first.messageId]);
    expect(await messageOf(world.admin, first.messageId)).toMatchObject({
      state: "canceled",
      attempts: 0,
      last_error_code: "resent",
    });
    await deliverMail(world, A.id);
    expect(await messageOf(world.admin, second.messageId)).toMatchObject({ state: "sent" });
    expect(await messageOf(world.admin, first.messageId)).toMatchObject({ state: "canceled" });
    expect((await availability(A, b.bookingId, await dbLater(22)))?.remaining).toBe(4);
  });

  // 7: the kind guard ----------------------------------------------------------------------------

  it("7. sends only the email that fits the booking: kind, trip end, and a failed refund", async () => {
    const standing = await book(world, A, tripsA.shared(), 1);
    expect(await resend(A, standing.bookingId, "cancellation")).toMatchObject({
      kind: "refused",
      code: "kind_mismatch",
    });

    const canceled = await book(world, A, tripsA.shared(), 1);
    await cancel(A, canceled);
    expect(await resend(A, canceled.bookingId, "confirmation")).toMatchObject({
      kind: "refused",
      code: "kind_mismatch",
    });
    expect((await availability(A, canceled.bookingId))?.kind).toBe("cancellation");

    const tripId = tripsA.shared();
    const ended = await book(world, A, tripId, 1);
    await departIn(world.admin, tripId, -3 * 24 * 60);
    expect(await resend(A, ended.bookingId, "confirmation")).toEqual({
      kind: "refused",
      code: "trip_over",
      availableAt: null,
    });

    const refused = await book(world, A, tripsA.shared(), 1);
    const record = await cancel(A, refused);
    if (!record.refundId) throw new Error("setup: the fixture policy gives no refund");
    const refusing = new FlakyProvider(world.payments);
    refusing.failRefund = "reject";
    expect((await settleRefund(world.db, refusing, guestContext(A.id), record.refundId)).kind).toBe(
      "failed",
    );
    expect(await resend(A, refused.bookingId, "cancellation")).toEqual({
      kind: "refused",
      code: "refund_failed",
      availableAt: null,
    });
    for (const id of [standing, canceled, ended, refused].map((x) => x.bookingId)) {
      expect(await resendRows(id)).toEqual([]);
      expect(await auditRows(id)).toEqual([]);
    }
  });

  // 8: an earlier email still pending ------------------------------------------------------------

  it("8a. cancels an earlier queued email of the same kind as resent, its link superseded, so it still renews", async () => {
    const b = await book(world, A, tripsA.shared(), 1, {
      booker: {
        name: "Synthetic Flaky Booker",
        email: `flaky.${randomUUID()}+fail-once@example.test`,
      },
    });
    await deliverMail(world, A.id);
    const [original] = await messagesOf(world.admin, b.bookingId);
    if (!original) throw new Error("setup: no confirmation");
    // Its first attempt was not sent: it waits to retry, holding the link that attempt issued.
    expect(original).toMatchObject({ state: "queued", attempts: 1 });
    expect(await liveLinks(original.id)).toEqual([{ revoked_reason: null, consumed: false }]);

    const sent = queued(await resend(A, b.bookingId, "confirmation"));
    expect(sent.canceledMessageIds).toEqual([original.id]);
    expect(await messageOf(world.admin, original.id)).toMatchObject({
      state: "canceled",
      last_error_code: "resent",
    });
    expect(await liveLinks(original.id)).toEqual([
      { revoked_reason: "superseded", consumed: false },
    ]);
  });

  it("8b. leaves a guest's own link email alone, and both go out", async () => {
    const b = await book(world, A, tripsA.shared(), 1);
    await deliverMail(world, A.id);
    const asked = await asGuest(world.db, A.id, (trx, ctx) =>
      requestManageLink(trx, ctx, { bookingId: b.bookingId, requestKey: `ask-${randomUUID()}` }),
    );
    if (asked.kind !== "enqueued") throw new Error(`setup: ${asked.kind}`);
    const sent = queued(await resend(A, b.bookingId, "confirmation"));
    expect(sent.canceledMessageIds).toEqual([]);
    expect(await messageOf(world.admin, asked.messageId)).toMatchObject({ state: "queued" });
    await deliverMail(world, A.id);
    expect(await messageOf(world.admin, asked.messageId)).toMatchObject({ state: "sent" });
    expect(await messageOf(world.admin, sent.messageId)).toMatchObject({
      state: "sent",
      last_error_code: null,
    });
  });

  it("8c. refuses in_progress while an earlier email of the same kind is being sent, and cancels nothing", async () => {
    const b = await book(world, A, tripsA.shared(), 1);
    const [original] = await messagesOf(world.admin, b.bookingId);
    if (!original) throw new Error("setup: no confirmation");
    let during: ResendResult | undefined;
    const stalling: EmailProvider = {
      name: "fake",
      deduplicates: true,
      send: async (email) => {
        if (email.idempotencyKey === original.id && !during) {
          during = await resend(A, b.bookingId, "confirmation");
        }
        return world.mail.send(email);
      },
    };
    await deliverMail(world, A.id, stalling);
    expect(during).toEqual({ kind: "refused", code: "in_progress", availableAt: null });
    expect(await messageOf(world.admin, original.id)).toMatchObject({ state: "sent" });
    expect(await resendRows(b.bookingId)).toEqual([]);
  });

  // 9, 10: a refusal writes nothing else ---------------------------------------------------------

  it("9. a too_soon refusal leaves every queued email queued", async () => {
    const b = await book(world, A, tripsA.shared(), 1);
    const seeded = await seedResend(A, b.bookingId, 1);
    const before = await messagesOf(world.admin, b.bookingId);
    expect(before.map((m) => m.state)).toEqual(["queued", "queued"]);
    const refused = await resend(A, b.bookingId, "confirmation");
    expect(refused).toMatchObject({ kind: "refused", code: "too_soon" });
    expect(await messagesOf(world.admin, b.bookingId)).toEqual(before);
    expect((await resendRows(b.bookingId)).map((r) => r.id)).toEqual([seeded]);
    expect(await auditRows(b.bookingId)).toEqual([]);
  });

  it("10. a composer's refusal answers email_invalid under a savepoint, and the earlier email stays queued", async () => {
    const b = await book(world, A, tripsA.shared(), 1);
    const before = await messagesOf(world.admin, b.bookingId);
    expect(before).toEqual([expect.objectContaining({ state: "queued" })]);
    fault.enqueue = 1;
    try {
      expect(await resend(A, b.bookingId, "confirmation")).toEqual({
        kind: "refused",
        code: "email_invalid",
        availableAt: null,
      });
    } finally {
      fault.enqueue = 0;
    }
    // D5's cancel ran inside the savepoint and was rolled back with it.
    expect(await messagesOf(world.admin, b.bookingId)).toEqual(before);
    expect(await resendRows(b.bookingId)).toEqual([]);
    expect(await auditRows(b.bookingId)).toEqual([]);
  });

  // 11, 12, 13: audit, status reads, tenants -----------------------------------------------------

  it("11, 12. audits ids and codes only, and status reads flag the resend without recipient or content", async () => {
    const who = { name: "Synthetic Audit Booker", email: `audit.${randomUUID()}@example.test` };
    const b = await book(world, A, tripsA.shared(), 1, { booker: who });
    await deliverMail(world, A.id);
    const [original] = await messagesOf(world.admin, b.bookingId);
    if (!original) throw new Error("setup: no confirmation");
    const sent = queued(
      await resend(A, b.bookingId, "confirmation", {
        reason: "guest_asked_again",
        actor: staffTwo,
      }),
    );
    const audits = await auditRows(b.bookingId);
    expect(audits).toHaveLength(1);
    expect(audits[0]).toEqual({
      actor_type: "staff",
      actor_id: staffTwo,
      reason: "guest_asked_again",
      subject_type: "booking",
      after_state: {
        messageId: sent.messageId,
        kind: "confirmation",
        template: "booking_confirmation",
        templateVersion: 1,
        generation: 1,
        canceledMessageIds: [],
        previous: { messageId: original.id, state: "sent", failureCode: null },
      },
    });
    const [stored] = await world.admin<{ subject: string }[]>`
      select subject from public.email_messages where id = ${sent.messageId}`;
    const auditText = JSON.stringify(audits);
    for (const secret of ["@", who.name, who.email, stored?.subject ?? "-", b.reference]) {
      expect(auditText).not.toContain(secret);
    }

    const statuses = await asSystem(world.db, A.id, (trx) =>
      listBookingMessages(trx, A.id, b.bookingId),
    );
    expect(statuses.map((m) => [m.id, m.template, m.staffResend])).toEqual([
      [original.id, "booking_confirmation", false],
      [sent.messageId, "booking_confirmation", true],
    ]);
    const statusText = JSON.stringify(statuses);
    for (const secret of [who.name, who.email, stored?.subject ?? "-", "#t="]) {
      expect(statusText).not.toContain(secret);
    }
  });

  it("13. another tenant's staff can neither send nor read a booking's email", async () => {
    const b = await book(world, A, tripsA.shared(), 1);
    const before = await messagesOf(world.admin, b.bookingId);
    expect(await resend(B, b.bookingId, "confirmation")).toEqual({ kind: "not_found" });
    expect(
      await asSystem(world.db, B.id, (trx) => listBookingMessages(trx, B.id, b.bookingId)),
    ).toEqual([]);
    expect(await availability(B, b.bookingId)).toBeNull();
    expect(await messagesOf(world.admin, b.bookingId)).toEqual(before);
    expect(await auditRows(b.bookingId)).toEqual([]);
    // And B's own booking works for B.
    const own = await book(world, B, tripsB.shared(), 1);
    expect((await resend(B, own.bookingId, "confirmation")).kind).toBe("queued");
    expect(await resend(B, randomUUID(), "confirmation")).toEqual({ kind: "not_found" });
    expect(await resend(B, "not-a-booking", "confirmation")).toEqual({ kind: "not_found" });
  });
});

// 14: the refusal order, one case per adjacent pair ------------------------------------------------

describe("the resend's refusal order (G2.16b, case 14)", () => {
  const at = new Date("2026-11-07T15:00:00.000Z");
  const clear: ResendFacts = {
    bookingState: "confirmed",
    tripEndsAt: new Date("2026-11-08T15:00:00.000Z"),
    refundFailed: false,
    deliverable: 0,
    newestResendAt: null,
    operatorResends: 0,
    operatorAvailableAt: null,
    sending: 0,
  };
  const codes = (facts: Partial<ResendFacts>, kind: ResendKind) =>
    refusalsOf({ ...clear, ...facts }, kind, at).map((r) => r.code);
  const first = (facts: Partial<ResendFacts>, kind: ResendKind) => codes(facts, kind)[0] ?? null;

  const ended = { tripEndsAt: new Date("2026-11-07T14:00:00.000Z") };
  const full = { deliverable: 5 };
  const recent = { newestResendAt: new Date("2026-11-07T14:55:00.000Z") };
  const busy = {
    operatorResends: 50,
    operatorAvailableAt: new Date("2026-11-07T15:30:00.000Z"),
  };
  const sending = { sending: 1 };

  it("allows a clear request", () => {
    expect(codes({}, "confirmation")).toEqual([]);
    expect(codes({ bookingState: "canceled" }, "cancellation")).toEqual([]);
  });

  it("kind_mismatch before trip_over", () => {
    expect(first({ bookingState: "canceled", ...ended }, "confirmation")).toBe("kind_mismatch");
  });

  it("kind_mismatch before refund_failed", () => {
    expect(first({ refundFailed: true }, "cancellation")).toBe("kind_mismatch");
  });

  it("trip_over before limit (confirmation), refund_failed before limit (cancellation)", () => {
    expect(first({ ...ended, ...full }, "confirmation")).toBe("trip_over");
    expect(first({ bookingState: "canceled", refundFailed: true, ...full }, "cancellation")).toBe(
      "refund_failed",
    );
  });

  it("trip_over is the confirmation's guard only, refund_failed the notice's only", () => {
    expect(codes({ bookingState: "canceled", ...ended }, "cancellation")).toEqual([]);
    expect(codes({ refundFailed: true }, "confirmation")).toEqual([]);
  });

  it("limit before too_soon", () => {
    expect(first({ ...full, ...recent }, "confirmation")).toBe("limit");
  });

  it("too_soon before rate_limited", () => {
    expect(first({ ...recent, ...busy }, "confirmation")).toBe("too_soon");
  });

  it("rate_limited before in_progress", () => {
    expect(first({ ...busy, ...sending }, "confirmation")).toBe("rate_limited");
  });

  it("lists every refusal that applies, in the fixed order, with when the time limits lift", () => {
    expect(
      refusalsOf(
        { ...clear, bookingState: "canceled", ...ended, ...full, ...recent, ...busy, ...sending },
        "confirmation",
        at,
      ),
    ).toEqual([
      { code: "kind_mismatch", availableAt: null },
      { code: "trip_over", availableAt: null },
      { code: "limit", availableAt: null },
      { code: "too_soon", availableAt: new Date("2026-11-07T15:05:00.000Z") },
      { code: "rate_limited", availableAt: new Date("2026-11-07T15:30:00.000Z") },
      { code: "in_progress", availableAt: null },
    ]);
  });

  it("counts the interval from the newest resend, to the millisecond", () => {
    expect(first({ newestResendAt: new Date("2026-11-07T14:50:00.000Z") }, "confirmation")).toBe(
      null,
    );
    expect(first({ newestResendAt: new Date("2026-11-07T14:50:00.001Z") }, "confirmation")).toBe(
      "too_soon",
    );
    expect(first({ deliverable: 4 }, "confirmation")).toBe(null);
    expect(first({ operatorResends: 49 }, "confirmation")).toBe(null);
    expect(first({ tripEndsAt: at }, "confirmation")).toBe("trip_over");
  });
});
