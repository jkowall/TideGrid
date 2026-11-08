/**
 * The 0014 residuals closed (W1-0014-RESIDUALS, migration 0019), for a
 * writer with tidegrid_app's credentials that skips the service. Writers use
 * the runtime role through inTenantTransaction; the admin builds fixtures and
 * reads state.
 *
 * R1 to R5:
 * - R1, the two templates' keys (D4 C): a booking_confirmation or
 *   booking_canceled message goes out only under its booking's own key, the
 *   original or a staff resend's, so it cannot escape the resend limits.
 * - R2, eligibility (D5 A): a direct resend that the service would refuse
 *   for the booking's state, a trip that is over, a failed refund, or an
 *   earlier email being sent is refused by the ledger, and leaves nothing.
 * - R3, a cancellation in progress: a direct confirmation resend waits for
 *   it, then is refused, instead of going out for a canceled booking. R3b,
 *   the same for a claim of the original held open: refused in_progress.
 * - R4, the service path: still sends each kind, and maps the database's
 *   eligibility refusals if it ever meets them.
 * - R5, the catalog: the new function is an invoker with search_path pinned,
 *   and the ledger's trigger is still bound.
 *
 * The waiver send_after case (D6) is in
 * packages/domain-waivers/src/adversarial/sending-limits.integration.test.ts.
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
import { enqueueMessage, FakeEmailProvider } from "@tidegrid/domain-messaging";
import { sql } from "kysely";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";
import {
  cancelBooking,
  previewCancellation,
  type ResendKind,
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
  addLocalHostname,
  asGuest,
  asSystem,
  type Booked,
  book,
  departIn,
  type SelfServiceWorld,
} from "./self-service-harness.ts";

const env = inject("integrationDb");

const templateOf = { confirmation: "booking_confirmation", cancellation: "booking_canceled" };

/** "code" or "code:constraint" for a database error, "ok" when it succeeded. */
async function outcome(p: Promise<unknown>): Promise<string> {
  try {
    await p;
    return "ok";
  } catch (e) {
    const err = e as { code?: unknown; constraint_name?: unknown } | null;
    if (typeof err?.code !== "string") throw e;
    return typeof err.constraint_name === "string"
      ? `${err.code}:${err.constraint_name}`
      : err.code;
  }
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe.skipIf(!env)("adversarial: the 0014 residuals closed for direct writers (0019)", () => {
  let world: SelfServiceWorld;
  let runtime: ReturnType<typeof createDb>;
  let A: CheckoutFixture;
  let trips: ReturnType<typeof tripAllocator>;
  const staff = randomUUID();

  function staffContext(tenantId: string): TenantContext {
    return { tenantId, actorType: "staff", actorId: staff, requestId: `rr-${randomUUID()}` };
  }

  /** A message of `template` under `key`, written straight into the transaction. */
  async function message(
    trx: TenantTransaction,
    ctx: TenantContext,
    m: { key: string; template: string; bookingId?: string },
  ): Promise<string> {
    const made = await enqueueMessage(trx, ctx, {
      dedupeKey: m.key,
      template: m.template,
      templateVersion: 1,
      to: { email: "synthetic.direct@example.test" },
      ...(m.bookingId ? { bookingId: m.bookingId } : {}),
      content: { subject: "Direct", blocks: [{ kind: "paragraph", text: "Written directly." }] },
    });
    if (made.kind !== "enqueued") throw new Error(`setup: ${JSON.stringify(made)}`);
    return made.messageId;
  }

  /** A direct writer's message alone, committed. */
  function directMessage(m: { key: string; template: string; bookingId?: string }) {
    const ctx = staffContext(A.id);
    return inTenantTransaction(world.db, ctx, (trx) => message(trx, ctx, m));
  }

  /** A whole direct resend: its message and its ledger row, generation 1, committed. */
  function directResend(bookingId: string, kind: ResendKind, generation = 1) {
    const ctx = staffContext(A.id);
    return inTenantTransaction(world.db, ctx, async (trx) => {
      const id = await message(trx, ctx, {
        key: `booking.resend:${bookingId}:${generation}`,
        template: templateOf[kind],
        bookingId,
      });
      await sql`insert into booking_email_resends (tenant_id, booking_id, generation, kind, message_id)
                values (${A.id}, ${bookingId}, ${generation}, ${kind}, ${id})`.execute(trx);
      return id;
    });
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
    return done.cancellation;
  }

  /** The booking's staff resend messages and ledger rows: what a refusal must leave empty. */
  async function resendsOf(bookingId: string) {
    const [row] = await world.admin<{ messages: number; ledger: number }[]>`
      select (select count(*)::int from public.email_messages
               where booking_id = ${bookingId} and starts_with(dedupe_key, 'booking.resend:'))
               as messages,
             (select count(*)::int from public.booking_email_resends
               where booking_id = ${bookingId}) as ledger`;
    return row;
  }

  /** Whether a runtime writer is waiting on a row lock in a ledger insert, within about 2.5 s. */
  async function writerWaitsOnRow(): Promise<boolean> {
    for (let i = 0; i < 50; i += 1) {
      const [row] = await world.admin<{ n: number }[]>`
        select count(*)::int as n from pg_stat_activity
         where usename = 'tidegrid_app' and wait_event_type = 'Lock'
           and wait_event in ('tuple', 'transactionid')
           and query ilike '%booking_email_resends%'`;
      if ((row?.n ?? 0) > 0) return true;
      await sleep(50);
    }
    return false;
  }

  beforeAll(async () => {
    if (!env) return;
    const admin = postgres(env.adminUrl, { max: 4, onnotice: () => {} });
    runtime = createDb(env.runtimeUrl, { max: 8 });
    world = {
      admin,
      db: runtime.db,
      payments: fakeProvider(runtime.db),
      mail: new FakeEmailProvider({ db: runtime.db, environment: "local" }),
    };
    A = await createCheckoutFixture(admin, runtime.db, "rres-a", { days: 20 });
    await addLocalHostname(admin, A);
    trips = tripAllocator(A);
  });

  afterAll(async () => {
    await runtime?.end();
    await world?.admin.end({ timeout: 5 });
  });

  it("R1. a confirmation or cancellation notice goes out only under its booking's own key (D4 C)", async () => {
    const b = await book(world, A, trips.shared(), 1);
    const other = await book(world, A, trips.shared(), 1);
    const cases: [string, { key: string; template: string; bookingId?: string }][] = [
      [
        "a confirmation under a key of the writer's own",
        {
          key: `adv.confirm:${b.bookingId}`,
          template: "booking_confirmation",
          bookingId: b.bookingId,
        },
      ],
      [
        "a cancellation notice under another booking's original key",
        {
          key: `booking.canceled:${other.bookingId}`,
          template: "booking_canceled",
          bookingId: b.bookingId,
        },
      ],
      [
        "a confirmation under another booking's resend key",
        {
          key: `booking.resend:${other.bookingId}:1`,
          template: "booking_confirmation",
          bookingId: b.bookingId,
        },
      ],
      [
        "a cancellation notice naming no booking",
        { key: `booking.canceled:${b.bookingId}`, template: "booking_canceled" },
      ],
      [
        "a confirmation under the cancellation notice's key",
        {
          key: `booking.canceled:${b.bookingId}`,
          template: "booking_confirmation",
          bookingId: b.bookingId,
        },
      ],
      [
        "a cancellation notice under a key of the writer's own",
        {
          key: `adv.canceled:${b.bookingId}:2`,
          template: "booking_canceled",
          bookingId: b.bookingId,
        },
      ],
    ];
    const answers: [string, string][] = [];
    for (const [label, m] of cases) answers.push([label, await outcome(directMessage(m))]);
    expect(answers).toEqual(cases.map(([label]) => [label, "23514:email_messages_booking_key"]));
    // Only the original confirmation each booking's checkout queued.
    const rows = await world.admin<{ dedupe_key: string }[]>`
      select dedupe_key from public.email_messages
       where booking_id in (${b.bookingId}, ${other.bookingId})
         and template in ('booking_confirmation', 'booking_canceled')
       order by dedupe_key`;
    expect(rows.map((r) => r.dedupe_key).sort()).toEqual(
      [`booking.confirmation:${b.bookingId}`, `booking.confirmation:${other.bookingId}`].sort(),
    );
    // An original before its time: the notice for a booking still standing,
    // which would leave the real notice a duplicate that never goes out.
    expect(
      await outcome(
        directMessage({
          key: `booking.canceled:${b.bookingId}`,
          template: "booking_canceled",
          bookingId: b.bookingId,
        }),
      ),
    ).toBe("23514:email_messages_booking_state");
    // The original key is taken: a second message under it is a duplicate, never a second send.
    const again = await inTenantTransaction(world.db, staffContext(A.id), (trx) =>
      enqueueMessage(trx, staffContext(A.id), {
        dedupeKey: `booking.confirmation:${b.bookingId}`,
        template: "booking_confirmation",
        templateVersion: 1,
        to: { email: "synthetic.direct@example.test" },
        bookingId: b.bookingId,
        content: { subject: "Again", blocks: [{ kind: "paragraph", text: "Again." }] },
      }),
    );
    expect(again.kind).toBe("duplicate");
  });

  it("R2. a direct resend the service would refuse is refused by the ledger, and leaves nothing (D5 A)", async () => {
    // The booking's state: a cancellation notice for a standing booking, a
    // confirmation for a canceled one.
    const standing = await book(world, A, trips.shared(), 1);
    const canceled = await book(world, A, trips.shared(), 1);
    await cancel(canceled);
    // The trip is over.
    const endedTrip = trips.shared();
    const ended = await book(world, A, endedTrip, 1);
    await departIn(world.admin, endedTrip, -3 * 24 * 60);
    // The cancellation's refund failed.
    const refused = await book(world, A, trips.shared(), 1);
    const record = await cancel(refused);
    if (!record.refundId) throw new Error("setup: the fixture policy gives no refund");
    const refusing = new FlakyProvider(world.payments);
    refusing.failRefund = "reject";
    expect((await settleRefund(world.db, refusing, guestContext(A.id), record.refundId)).kind).toBe(
      "failed",
    );
    // The original confirmation is being sent: claimed, its lease running.
    const sending = await book(world, A, trips.shared(), 1);
    await asSystem(world.db, A.id, (trx) =>
      sql`update email_messages
             set state = 'sending', attempts = attempts + 1, provider = 'fake',
                 lease_expires_at = now() + interval '5 minutes'
           where tenant_id = ${A.id} and booking_id = ${sending.bookingId}
             and template = 'booking_confirmation'`.execute(trx),
    );

    const cases: [string, Booked, ResendKind, string][] = [
      ["a notice for a standing booking", standing, "cancellation", "kind_mismatch"],
      ["a confirmation for a canceled booking", canceled, "confirmation", "kind_mismatch"],
      ["a confirmation after the trip", ended, "confirmation", "trip_over"],
      ["a notice whose refund failed", refused, "cancellation", "refund_failed"],
      ["a confirmation while the original is being sent", sending, "confirmation", "in_progress"],
    ];
    const answers: [string, string][] = [];
    for (const [label, b, kind] of cases) {
      answers.push([label, await outcome(directResend(b.bookingId, kind))]);
    }
    expect(answers).toEqual(
      cases.map(([label, , , code]) => [label, `23514:booking_email_resends_${code}`]),
    );
    for (const [, b] of cases)
      expect(await resendsOf(b.bookingId)).toEqual({ messages: 0, ledger: 0 });

    // The same writer, for each email that fits: written.
    expect(await outcome(directResend(standing.bookingId, "confirmation"))).toBe("ok");
    expect(await outcome(directResend(canceled.bookingId, "cancellation"))).toBe("ok");
  });

  it("R3. a direct confirmation resend waits for a cancellation in progress, then is refused", async () => {
    const b = await book(world, A, trips.shared(), 1);
    const terms = await asGuest(world.db, A.id, (trx) =>
      previewCancellation(trx, A.id, b.bookingId),
    );
    if (!terms) throw new Error("setup: no terms");
    let release = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let reached = () => {};
    const held = new Promise<void>((resolve) => {
      reached = resolve;
    });
    // The cancellation is written, and its transaction held open.
    const canceling = asGuest(world.db, A.id, async (trx, ctx) => {
      const done = await cancelBooking(trx, ctx, {
        bookingId: b.bookingId,
        expectedRefundAmount: terms.refundAmount,
      });
      reached();
      await gate;
      return done.kind;
    });
    await held;
    const writing = outcome(directResend(b.bookingId, "confirmation"));
    // The writer waits on the booking's row, not on anything else. The gate
    // opens whatever the probe finds, so a failure here never holds the
    // tenant's resend lock for the cases after it.
    let waiting = false;
    try {
      waiting = await writerWaitsOnRow();
    } finally {
      release();
    }
    expect(waiting).toBe(true);
    expect(await canceling).toBe("canceled");
    expect(await writing).toBe("23514:booking_email_resends_kind_mismatch");
    expect(await resendsOf(b.bookingId)).toEqual({ messages: 0, ledger: 0 });
  });

  it("R3b. a direct resend waits for a claim of the original held open, then is refused in_progress", async () => {
    const b = await book(world, A, trips.shared(), 1);
    let release = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let reached = () => {};
    const held = new Promise<void>((resolve) => {
      reached = resolve;
    });
    // The original confirmation is claimed in a transaction held open.
    const claiming = asSystem(world.db, A.id, async (trx) => {
      await sql`update email_messages
                   set state = 'sending', attempts = attempts + 1, provider = 'fake',
                       lease_expires_at = now() + interval '5 minutes'
                 where tenant_id = ${A.id} and booking_id = ${b.bookingId}
                   and template = 'booking_confirmation'`.execute(trx);
      reached();
      await gate;
    });
    await held;
    const writing = outcome(directResend(b.bookingId, "confirmation"));
    let waiting = false;
    try {
      waiting = await writerWaitsOnRow();
    } finally {
      release();
    }
    expect(waiting).toBe(true);
    await claiming;
    expect(await writing).toBe("23514:booking_email_resends_in_progress");
    expect(await resendsOf(b.bookingId)).toEqual({ messages: 0, ledger: 0 });
  });

  it("R4. the service still resends each kind that fits, under the new checks", async () => {
    const b = await book(world, A, trips.shared(), 1);
    const ctx = staffContext(A.id);
    const sent = await inTenantTransaction(world.db, ctx, (trx) =>
      resendBookingEmail(trx, ctx, {
        bookingId: b.bookingId,
        kind: "confirmation",
        reason: "guest_did_not_receive",
      }),
    );
    expect(sent.kind).toBe("queued");
    const c = await book(world, A, trips.shared(), 1);
    await cancel(c);
    const notice = await inTenantTransaction(world.db, ctx, (trx) =>
      resendBookingEmail(trx, ctx, {
        bookingId: c.bookingId,
        kind: "cancellation",
        reason: "guest_asked_again",
      }),
    );
    expect(notice.kind).toBe("queued");
    expect(await resendsOf(b.bookingId)).toEqual({ messages: 1, ledger: 1 });
    expect(await resendsOf(c.bookingId)).toEqual({ messages: 1, ledger: 1 });
  });

  it("R5. the catalog: an invoker function with search_path pinned, run as the writer, and the trigger still bound", async () => {
    const fns = await world.admin<
      { name: string; definer: boolean; config: string[]; runtime: boolean; volatility: string }[]
    >`
      select p.proname as name, p.prosecdef as definer, p.proconfig as config,
             has_function_privilege('tidegrid_app', p.oid, 'EXECUTE') as runtime,
             p.provolatile::text as volatility
        from pg_proc p join pg_namespace n on n.oid = p.pronamespace
       where n.nspname = 'app'
         and p.proname in ('booking_resend_eligibility_refusal', 'check_booking_email_resend',
                           'check_email_message')
       order by p.proname`;
    const pinned = ["search_path=pg_catalog, pg_temp"];
    expect(fns).toEqual([
      {
        name: "booking_resend_eligibility_refusal",
        definer: false,
        config: pinned,
        runtime: true,
        volatility: "s",
      },
      {
        name: "check_booking_email_resend",
        definer: false,
        config: pinned,
        runtime: false,
        volatility: "v",
      },
      {
        name: "check_email_message",
        definer: false,
        config: pinned,
        runtime: false,
        volatility: "v",
      },
    ]);
    const [bound] = await world.admin<{ n: number }[]>`
      select count(*)::int as n from pg_trigger t join pg_proc p on p.oid = t.tgfoid
       where t.tgrelid = 'public.booking_email_resends'::regclass
         and t.tgname = 'booking_email_resends_check' and p.proname = 'check_booking_email_resend'`;
    expect(bound?.n).toBe(1);
  });
});
