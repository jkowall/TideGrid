/**
 * The staff resend limits held by the database (G2.16b follow-up, migration
 * 0014): the append-only ledger `booking_email_resends`, its check trigger,
 * the facts function the service and the trigger share, and the deferred
 * check that a `booking.resend:` message commits only with its ledger row.
 * These cases write as tidegrid_app, through inTenantTransaction, the way a
 * writer that bypasses the service would. The admin connection builds
 * fixtures, seeds ledger rows with the check trigger off, moves ledger times
 * back, and reads stored state.
 *
 * What these prove (packet section 7, DB1 to DB10):
 * - A bypass writer is bound: a resend message without its ledger row fails
 *   at commit, and a ledger row is refused past the limits D4 fixed (5
 *   deliverable per booking, 10 minutes after the newest of any state, 50 of
 *   any state per operator per hour), exactly, under the tenant's advisory
 *   lock, for every writer admitted under READ COMMITTED.
 * - A ledger row names the message its own transaction queued for its
 *   booking, generation, and kind, and nothing of another tenant.
 * - The service maps a limit the trigger raises to its typed refusal, and the
 *   service and a direct insert agree at every boundary.
 */
import { randomUUID } from "node:crypto";
import {
  createDb,
  inTenantTransaction,
  setTenantContext,
  type TenantContext,
  type TenantTransaction,
} from "@tidegrid/database";
import type {} from "@tidegrid/database/global-setup";
import { tripAllocator } from "@tidegrid/domain-inventory/testing";
import { cancelMessage, enqueueMessage, FakeEmailProvider } from "@tidegrid/domain-messaging";
import { sql } from "kysely";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";
import {
  cancelBooking,
  previewCancellation,
  type ResendKind,
  type ResendResult,
  resendBookingEmail,
} from "../index.ts";
import { type CheckoutFixture, createCheckoutFixture, fakeProvider } from "../test-fixtures.ts";
import {
  addLocalHostname,
  asGuest,
  asSystem,
  type Booked,
  book,
  messagesOf,
  type SelfServiceWorld,
} from "./self-service-harness.ts";

const env = inject("integrationDb");

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const templateOf = { confirmation: "booking_confirmation", cancellation: "booking_canceled" };

/** A seeded resend's delivery: deliverable unless canceled before any attempt. */
type SeedState = "queued" | "sent" | "canceled" | "attempted_canceled";

/** What a direct writer names: the ledger row, and its message when it differs. */
interface Direct {
  bookingId: string;
  generation: number;
  kind?: ResendKind;
  message?: { key?: string; template?: string; bookingId?: string } | { id: string };
  /** Columns the trigger stamps; a writer that names them is overridden. */
  forged?: boolean;
}

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

const answerOf = (r: ResendResult) => (r.kind === "refused" ? r.code : r.kind);

/** The trigger's refusal for each service answer, so DB8 can compare them. */
const directFor: Record<string, string> = {
  queued: "ok",
  limit: "23514:booking_email_resends_limit",
  too_soon: "23514:booking_email_resends_interval",
  rate_limited: "23514:booking_email_resends_rate",
};

describe.skipIf(!env)("adversarial: staff resend limits held by the database (0014)", () => {
  let world: SelfServiceWorld;
  let runtime: ReturnType<typeof createDb>;
  /** Per-booking cases. */
  let A: CheckoutFixture;
  /** Another tenant, for binding. */
  let B: CheckoutFixture;
  /** The operator's hourly cap; each case clears the hour first. */
  let R: CheckoutFixture;
  let tripsA: ReturnType<typeof tripAllocator>;
  let tripsB: ReturnType<typeof tripAllocator>;
  let tripsR: ReturnType<typeof tripAllocator>;
  const staffOne = randomUUID();
  const rollback = new Error("always roll back");

  function staffContext(tenantId: string, requestId = `g216b-fu-${randomUUID()}`): TenantContext {
    return { tenantId, actorType: "staff", actorId: staffOne, requestId };
  }

  /** A message and its ledger row, written straight into the caller's transaction. */
  async function directWrite(
    trx: TenantTransaction,
    ctx: TenantContext,
    d: Direct,
  ): Promise<{ messageId: string }> {
    const kind = d.kind ?? "confirmation";
    let messageId: string;
    if (d.message && "id" in d.message) {
      messageId = d.message.id;
    } else {
      const made = await enqueueMessage(trx, ctx, {
        dedupeKey: d.message?.key ?? `booking.resend:${d.bookingId}:${d.generation}`,
        template: d.message?.template ?? templateOf[kind],
        templateVersion: 1,
        to: { email: "synthetic.direct@example.test" },
        bookingId: d.message?.bookingId ?? d.bookingId,
        content: {
          subject: "Direct resend",
          blocks: [{ kind: "paragraph", text: "Written directly." }],
        },
      });
      if (made.kind !== "enqueued") throw new Error(`setup: ${JSON.stringify(made)}`);
      messageId = made.messageId;
    }
    if (d.forged) {
      await sql`insert into booking_email_resends
                  (tenant_id, booking_id, generation, kind, message_id,
                   actor_type, actor_id, api_request_id, created_at)
                values (${ctx.tenantId}, ${d.bookingId}, ${d.generation}, ${kind}, ${messageId},
                        'guest', 'forged-actor', 'forged-request', now() - interval '1 day')`.execute(
        trx,
      );
    } else {
      await sql`insert into booking_email_resends (tenant_id, booking_id, generation, kind, message_id)
                values (${ctx.tenantId}, ${d.bookingId}, ${d.generation}, ${kind}, ${messageId})`.execute(
        trx,
      );
    }
    return { messageId };
  }

  /** A direct writer that commits. */
  function direct(tenant: CheckoutFixture, d: Direct, ctx = staffContext(tenant.id)) {
    return inTenantTransaction(world.db, ctx, (trx) => directWrite(trx, ctx, d));
  }

  /** Run `fn` as the runtime in a transaction that always rolls back, and return its answer. */
  async function rolledBack<T>(
    ctx: TenantContext,
    fn: (trx: TenantTransaction) => Promise<T>,
  ): Promise<T> {
    const box: { value?: T; set: boolean } = { set: false };
    try {
      await inTenantTransaction(world.db, ctx, async (trx) => {
        box.value = await fn(trx);
        box.set = true;
        throw rollback;
      });
    } catch (e) {
      if (e !== rollback) throw e;
    }
    if (!box.set) throw new Error("no answer");
    return box.value as T;
  }

  /** The service's answer and a direct insert's, each rolled back, against the same rows. */
  async function bothAnswer(
    tenant: CheckoutFixture,
    bookingId: string,
    generation: number,
    before: (trx: TenantTransaction) => Promise<void> = async () => {},
  ): Promise<{ service: string; direct: string }> {
    const ctx = staffContext(tenant.id);
    const service = await rolledBack(ctx, async (trx) => {
      await before(trx);
      return answerOf(
        await resendBookingEmail(trx, ctx, {
          bookingId,
          kind: "confirmation",
          reason: "guest_did_not_receive",
        }),
      );
    });
    const directly = await outcome(
      rolledBack(ctx, async (trx) => {
        await before(trx);
        await directWrite(trx, ctx, { bookingId, generation });
      }),
    );
    return { service, direct: directly };
  }

  let ledgerPresent: boolean | undefined;
  async function hasLedger(): Promise<boolean> {
    if (ledgerPresent === undefined) {
      const [row] = await world.admin<{ present: boolean }[]>`
        select to_regclass('public.booking_email_resends') is not null as present`;
      ledgerPresent = row?.present === true;
    }
    return ledgerPresent;
  }

  /**
   * Earlier resends written by the admin with the check trigger off, as a
   * fixture: one message and one ledger row per generation, in one
   * transaction, in the state asked for. Before 0014 there is no ledger, and
   * the seed writes the messages alone: that is how DB1 shows a bypass
   * committing on 0013, its failing-first run.
   */
  async function seed(
    tenant: CheckoutFixture,
    bookingId: string,
    generations: number[],
    options: { state?: SeedState; kind?: ResendKind } = {},
  ): Promise<string[]> {
    const kind = options.kind ?? "confirmation";
    const state = options.state ?? "sent";
    const ledger = await hasLedger();
    return world.admin.begin(async (tx) => {
      if (ledger) {
        await tx`alter table public.booking_email_resends disable trigger booking_email_resends_check`;
      }
      const ids: string[] = [];
      for (const generation of generations) {
        const [m] = await tx<{ id: string }[]>`
          insert into public.email_messages (tenant_id, dedupe_key, template, template_version,
              booking_id, to_email, from_name, subject, html_body, text_body)
          values (${tenant.id}, ${`booking.resend:${bookingId}:${generation}`}, ${templateOf[kind]},
                  1, ${bookingId}, 'synthetic.seeded@example.test', 'Synthetic Operator',
                  'Seeded resend', '<p>Seeded.</p>', 'Seeded.')
          returning id`;
        if (!m) throw new Error("setup: no seeded message");
        if (state !== "queued" && state !== "canceled") {
          await tx`update public.email_messages
                      set state = 'sending', attempts = 1, provider = 'fake',
                          lease_expires_at = now() + interval '2 minutes'
                    where id = ${m.id}`;
        }
        if (state === "sent") {
          await tx`update public.email_messages
                      set state = 'sent', provider_message_id = ${`seed-${m.id}`} where id = ${m.id}`;
        } else if (state !== "queued") {
          await tx`update public.email_messages
                      set state = 'canceled', last_error_code = 'resent' where id = ${m.id}`;
        }
        if (ledger) {
          await tx`insert into public.booking_email_resends
                      (tenant_id, booking_id, generation, kind, message_id, actor_type)
                    values (${tenant.id}, ${bookingId}, ${generation}, ${kind}, ${m.id}, 'system')`;
        }
        ids.push(m.id);
      }
      if (ledger) {
        await tx`alter table public.booking_email_resends enable trigger booking_email_resends_check`;
      }
      return ids;
    });
  }

  /** Make time pass for ledger rows: move them earlier, with the append-only guard off for that statement. */
  async function backdate(
    where: { tenantId: string; bookingId?: string },
    minutes: number,
  ): Promise<void> {
    await world.admin.begin(async (tx) => {
      await tx`alter table public.booking_email_resends disable trigger booking_email_resends_append_only`;
      await tx`update public.booking_email_resends
                  set created_at = created_at - make_interval(mins => ${minutes})
                where tenant_id = ${where.tenantId}
                  and (${where.bookingId ?? null}::uuid is null
                       or booking_id = ${where.bookingId ?? null}::uuid)`;
      await tx`alter table public.booking_email_resends enable trigger booking_email_resends_append_only`;
    });
  }

  /** Set a booking's newest ledger row to `at` minus `ago`, exactly, on the database clock's text. */
  async function newestAt(bookingId: string, at: string, ago: string): Promise<void> {
    await world.admin.begin(async (tx) => {
      await tx`alter table public.booking_email_resends disable trigger booking_email_resends_append_only`;
      await tx`update public.booking_email_resends
                  set created_at = ${at}::timestamptz - ${ago}::interval
                where booking_id = ${bookingId}
                  and generation = (select max(generation) from public.booking_email_resends
                                     where booking_id = ${bookingId})`;
      await tx`alter table public.booking_email_resends enable trigger booking_email_resends_append_only`;
    });
  }

  /** Empty the operator's last hour, so a rate case starts from what it seeds. */
  const clearHour = (tenant: CheckoutFixture) => backdate({ tenantId: tenant.id }, 61);

  async function hourCount(tenant: CheckoutFixture): Promise<number> {
    const [row] = await world.admin<{ n: number }[]>`
      select count(*)::int as n from public.booking_email_resends
       where tenant_id = ${tenant.id} and created_at > now() - interval '1 hour'`;
    return row?.n ?? -1;
  }

  async function ledgerOf(bookingId: string) {
    return world.admin<
      {
        generation: number;
        kind: string;
        message_id: string;
        actor_type: string;
        actor_id: string | null;
        api_request_id: string | null;
        created_at: Date;
      }[]
    >`
      select generation, kind, message_id, actor_type, actor_id, api_request_id, created_at
        from public.booking_email_resends where booking_id = ${bookingId} order by generation`;
  }

  async function resendMessagesOf(bookingId: string): Promise<string[]> {
    const rows = await world.admin<{ dedupe_key: string }[]>`
      select dedupe_key from public.email_messages
       where booking_id = ${bookingId} and starts_with(dedupe_key, 'booking.resend:')
       order by created_at, id`;
    return rows.map((r) => r.dedupe_key);
  }

  async function auditRows(bookingId: string): Promise<number> {
    const [row] = await world.admin<{ n: number }[]>`
      select count(*)::int as n from public.audit_events
       where subject_id = ${bookingId} and action = 'booking.email_resent'`;
    return row?.n ?? -1;
  }

  /** Writers waiting for the tenant's resend lock, from pg_locks. */
  async function waitingOnResendLock(tenant: CheckoutFixture): Promise<number> {
    const [row] = await world.admin<{ n: number }[]>`
      select count(*)::int as n from pg_locks
       where locktype = 'advisory' and not granted and objsubid = 1
         and ((classid::bigint << 32) | objid::bigint)
             = hashtextextended(${`tidegrid.booking_resend:${tenant.id}`}, 0)`;
    return row?.n ?? -1;
  }

  async function poll(what: string, done: () => Promise<boolean>): Promise<void> {
    for (let i = 0; i < 200; i += 1) {
      if (await done()) return;
      await sleep(50);
    }
    throw new Error(`timed out waiting for ${what}`);
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
  }

  async function serviceResend(tenant: CheckoutFixture, bookingId: string, kind: ResendKind) {
    const ctx = staffContext(tenant.id);
    return inTenantTransaction(world.db, ctx, (trx) =>
      resendBookingEmail(trx, ctx, { bookingId, kind, reason: "guest_did_not_receive" }),
    );
  }

  beforeAll(async () => {
    if (!env) return;
    const admin = postgres(env.adminUrl, { max: 4, onnotice: () => {} });
    runtime = createDb(env.runtimeUrl, { max: 10 });
    world = {
      admin,
      db: runtime.db,
      payments: fakeProvider(runtime.db),
      mail: new FakeEmailProvider({ db: runtime.db, environment: "local" }),
    };
    [A, B, R] = await Promise.all([
      createCheckoutFixture(admin, runtime.db, "rsdb-a", { days: 20 }),
      createCheckoutFixture(admin, runtime.db, "rsdb-b", { days: 4 }),
      createCheckoutFixture(admin, runtime.db, "rsdb-r", { days: 30 }),
    ]);
    for (const t of [A, B, R]) await addLocalHostname(admin, t);
    tripsA = tripAllocator(A);
    tripsB = tripAllocator(B);
    tripsR = tripAllocator(R);
  });

  afterAll(async () => {
    await runtime?.end();
    await world?.admin.end({ timeout: 5 });
  });

  it("DB1. a resend message without its ledger row fails at commit, past 5 deliverable resends", async () => {
    const b = await book(world, A, tripsA.shared(), 1);
    await seed(A, b.bookingId, [1, 2, 3, 4, 5]);
    const ctx = staffContext(A.id);
    const sixth = await outcome(
      inTenantTransaction(world.db, ctx, (trx) =>
        enqueueMessage(trx, ctx, {
          dedupeKey: `booking.resend:${b.bookingId}:6`,
          template: "booking_confirmation",
          templateVersion: 1,
          to: { email: "synthetic.bypass@example.test" },
          bookingId: b.bookingId,
          content: { subject: "Bypass", blocks: [{ kind: "paragraph", text: "No ledger row." }] },
        }),
      ),
    );
    expect(sixth).toBe("23514:email_messages_staff_resend");
    expect(await resendMessagesOf(b.bookingId)).toHaveLength(5);
  });

  it("DB2. a direct writer is refused past each limit: 5 deliverable, 10 minutes (F4), 50 an hour (F5)", async () => {
    // The 6th deliverable, well after the 5th.
    const full = await book(world, A, tripsA.shared(), 1);
    await seed(A, full.bookingId, [1, 2, 3, 4, 5]);
    await backdate({ tenantId: A.id, bookingId: full.bookingId }, 11);
    expect(await outcome(direct(A, { bookingId: full.bookingId, generation: 6 }))).toBe(
      "23514:booking_email_resends_limit",
    );

    // Within 10 minutes of the newest.
    const recent = await book(world, A, tripsA.shared(), 1);
    await seed(A, recent.bookingId, [1]);
    await backdate({ tenantId: A.id, bookingId: recent.bookingId }, 9);
    expect(await outcome(direct(A, { bookingId: recent.bookingId, generation: 2 }))).toBe(
      "23514:booking_email_resends_interval",
    );

    // The newest was canceled with its booking: it still starts the 10 minutes.
    const canceled = await book(world, A, tripsA.shared(), 1);
    const sent = await serviceResend(A, canceled.bookingId, "confirmation");
    if (sent.kind !== "queued") throw new Error(`setup: ${JSON.stringify(sent)}`);
    await cancel(A, canceled);
    expect(
      await world.admin`select state, attempts from public.email_messages where id = ${sent.messageId}`,
    ).toEqual([{ state: "canceled", attempts: 0 }]);
    expect(
      await outcome(
        direct(A, { bookingId: canceled.bookingId, generation: 2, kind: "cancellation" }),
      ),
    ).toBe("23514:booking_email_resends_interval");

    // The 51st in the hour, across bookings, ten of the 50 canceled before any attempt.
    await clearHour(R);
    const one = await book(world, R, tripsR.shared(), 1);
    const two = await book(world, R, tripsR.shared(), 1);
    await seed(
      R,
      one.bookingId,
      Array.from({ length: 25 }, (_, i) => i + 1),
    );
    const queued = await seed(
      R,
      two.bookingId,
      Array.from({ length: 25 }, (_, i) => i + 1),
      {
        state: "queued",
      },
    );
    for (const id of queued.slice(0, 10)) {
      const done = await asSystem(world.db, R.id, (trx, ctx) =>
        cancelMessage(trx, ctx, id, { code: "resent" }),
      );
      expect(done).toMatchObject({ kind: "canceled", inFlight: false });
    }
    const target = await book(world, R, tripsR.shared(), 1);
    expect(await outcome(direct(R, { bookingId: target.bookingId, generation: 1 }))).toBe(
      "23514:booking_email_resends_rate",
    );
    expect(await hourCount(R)).toBe(50);
  });

  it("DB3. an attempted-then-canceled resend counts toward the 5 (F3); one canceled before any attempt does not (6b)", async () => {
    const attempted = await book(world, A, tripsA.shared(), 1);
    await seed(A, attempted.bookingId, [1, 2, 3, 4]);
    await seed(A, attempted.bookingId, [5], { state: "attempted_canceled" });
    const unsent = await book(world, A, tripsA.shared(), 1);
    await seed(A, unsent.bookingId, [1, 2, 3, 4]);
    await seed(A, unsent.bookingId, [5], { state: "canceled" });
    for (const b of [attempted, unsent])
      await backdate({ tenantId: A.id, bookingId: b.bookingId }, 11);

    const [facts] = await world.admin<{ attempted: number; unsent: number }[]>`
      select (select deliverable from app.booking_resend_facts(${A.id}, ${attempted.bookingId}, now())) as attempted,
             (select deliverable from app.booking_resend_facts(${A.id}, ${unsent.bookingId}, now())) as unsent`;
    expect(facts).toEqual({ attempted: 5, unsent: 4 });
    expect(await outcome(direct(A, { bookingId: attempted.bookingId, generation: 6 }))).toBe(
      "23514:booking_email_resends_limit",
    );
    expect(await outcome(direct(A, { bookingId: unsent.bookingId, generation: 6 }))).toBe("ok");
  });

  it("DB4. six direct writers on six bookings at 49 an hour: exactly one commits, five are refused _rate", async () => {
    await clearHour(R);
    const seeded = await book(world, R, tripsR.shared(), 1);
    await seed(
      R,
      seeded.bookingId,
      Array.from({ length: 49 }, (_, i) => i + 1),
    );
    const targets: Booked[] = [];
    for (let i = 0; i < 6; i += 1) targets.push(await book(world, R, tripsR.shared(), 1));

    const reached = targets.map(() => false);
    let openFirst = () => {};
    let openRest = () => {};
    const firstGate = new Promise<void>((resolve) => {
      openFirst = resolve;
    });
    const restGate = new Promise<void>((resolve) => {
      openRest = resolve;
    });
    const writer = (i: number) => {
      const ctx = staffContext(R.id);
      return outcome(
        inTenantTransaction(world.db, ctx, async (trx) => {
          await directWrite(trx, ctx, { bookingId: targets[i]?.bookingId ?? "", generation: 1 });
          reached[i] = true;
          await (i === 0 ? firstGate : restGate);
        }),
      );
    };
    const first = writer(0);
    await poll("writer 1 at the barrier", async () => reached[0] === true);
    const rest = [1, 2, 3, 4, 5].map(writer);
    // Each of the other five is either waiting for the tenant's lock or at the barrier.
    await poll("writers 2 to 6 to wait or reach the barrier", async () => {
      const at = reached.slice(1).filter(Boolean).length;
      return at + (await waitingOnResendLock(R)) === 5;
    });
    openFirst();
    const firstOutcome = await first;
    openRest();
    const outcomes = [firstOutcome, ...(await Promise.all(rest))];
    expect(outcomes[0]).toBe("ok");
    expect(outcomes.slice(1)).toEqual(Array(5).fill("23514:booking_email_resends_rate"));
    expect(await hourCount(R)).toBe(50);
    for (const t of targets.slice(1)) expect(await resendMessagesOf(t.bookingId)).toEqual([]);
  });

  it("DB5. a ledger row names its own transaction's message for its booking, generation, and kind, in its own tenant", async () => {
    const b = await book(world, A, tripsA.shared(), 1);
    const other = await book(world, A, tripsA.shared(), 1);
    const foreign = await book(world, B, tripsB.shared(), 1);
    const foreignResend = await serviceResend(B, foreign.bookingId, "confirmation");
    if (foreignResend.kind !== "queued") throw new Error("setup: B's resend");

    // A resend message committed earlier, without a ledger row: written by
    // the admin with triggers off, which no runtime writer can do.
    const earlier = await world.admin.begin(async (tx) => {
      await tx`set local session_replication_role = replica`;
      const [m] = await tx<{ id: string }[]>`
        insert into public.email_messages (tenant_id, dedupe_key, template, template_version,
            booking_id, to_email, from_name, subject, html_body, text_body)
        values (${A.id}, ${`booking.resend:${other.bookingId}:1`}, 'booking_confirmation', 1,
                ${other.bookingId}, 'synthetic.earlier@example.test', 'Synthetic Operator',
                'Earlier', '<p>Earlier.</p>', 'Earlier.')
        returning id`;
      return m?.id ?? "";
    });

    const cases: [string, Direct, string][] = [
      [
        "a key for another generation",
        {
          bookingId: b.bookingId,
          generation: 1,
          message: { key: `booking.resend:${b.bookingId}:2` },
        },
        "23514:booking_email_resends_message",
      ],
      [
        "a template that is not the kind's",
        { bookingId: b.bookingId, generation: 1, message: { template: "booking_canceled" } },
        "23514:booking_email_resends_message",
      ],
      [
        "another booking's message",
        {
          bookingId: b.bookingId,
          generation: 1,
          message: { key: `booking.resend:${other.bookingId}:9`, bookingId: other.bookingId },
        },
        "23514:booking_email_resends_message",
      ],
      [
        "a message from an earlier transaction",
        { bookingId: other.bookingId, generation: 1, message: { id: earlier } },
        "23514:booking_email_resends_message",
      ],
      [
        "another tenant's booking",
        { bookingId: foreign.bookingId, generation: 1, message: { bookingId: b.bookingId } },
        "23514:booking_email_resends_message",
      ],
      [
        "another tenant's message",
        { bookingId: b.bookingId, generation: 1, message: { id: foreignResend.messageId } },
        "23514:booking_email_resends_message",
      ],
      [
        "a generation gap",
        { bookingId: b.bookingId, generation: 2 },
        "23514:booking_email_resends_sequence",
      ],
    ];
    const answers: [string, string][] = [];
    for (const [label, d] of cases) answers.push([label, await outcome(direct(A, d))]);
    expect(answers).toEqual(cases.map(([label, , expected]) => [label, expected]));
    expect(await ledgerOf(b.bookingId)).toEqual([]);
    expect(await ledgerOf(foreign.bookingId)).toHaveLength(1);

    // Rule 10, as the admin with the check off for that statement: a row
    // cannot pair one tenant with another tenant's booking or message.
    const [own] = await messagesOf(world.admin, b.bookingId);
    if (!own) throw new Error("setup: no confirmation");
    const crossed = (bookingId: string, messageId: string) =>
      outcome(
        world.admin.begin(async (tx) => {
          await tx`alter table public.booking_email_resends disable trigger booking_email_resends_check`;
          await tx`insert into public.booking_email_resends
                      (tenant_id, booking_id, generation, kind, message_id, actor_type)
                    values (${A.id}, ${bookingId}, 999, 'confirmation', ${messageId}, 'system')`;
          await tx`alter table public.booking_email_resends enable trigger booking_email_resends_check`;
        }),
      );
    expect(await crossed(foreign.bookingId, own.id)).toBe(
      "23503:booking_email_resends_tenant_id_booking_id_fkey",
    );
    expect(await crossed(b.bookingId, foreignResend.messageId)).toBe(
      "23503:booking_email_resends_tenant_id_message_id_fkey",
    );
    const keys = await world.admin<{ def: string }[]>`
      select pg_get_constraintdef(oid) as def from pg_constraint
       where conrelid = 'public.booking_email_resends'::regclass and contype = 'f'`;
    expect(keys.map((k) => k.def).sort()).toEqual([
      "FOREIGN KEY (tenant_id) REFERENCES tenants(id)",
      "FOREIGN KEY (tenant_id, booking_id) REFERENCES bookings(tenant_id, id)",
      "FOREIGN KEY (tenant_id, message_id) REFERENCES email_messages(tenant_id, id)",
    ]);

    // Leave no orphan behind for other cases: the earlier message is canceled.
    await world.admin`update public.email_messages set state = 'canceled' where id = ${earlier}`;
  });

  it("DB6. the ledger is append-only: UPDATE, DELETE, and TRUNCATE raise for the admin; the runtime has no privilege", async () => {
    const b = await book(world, A, tripsA.shared(), 1);
    await seed(A, b.bookingId, [1]);
    const asAdmin = (statement: (tx: postgres.TransactionSql) => Promise<unknown>) =>
      outcome(
        world.admin.begin(async (tx) => {
          await statement(tx);
          throw rollback;
        }),
      );
    expect(
      await asAdmin(
        (tx) => tx`update public.booking_email_resends set kind = 'cancellation'
                    where booking_id = ${b.bookingId}`,
      ),
    ).toBe("55000");
    expect(
      await asAdmin(
        (tx) => tx`delete from public.booking_email_resends where booking_id = ${b.bookingId}`,
      ),
    ).toBe("55000");
    expect(await asAdmin((tx) => tx`truncate public.booking_email_resends`)).toBe("55000");

    const asRuntime = (statement: (trx: TenantTransaction) => Promise<unknown>) =>
      outcome(inTenantTransaction(world.db, staffContext(A.id), statement));
    expect(
      await asRuntime((trx) =>
        sql`update booking_email_resends set kind = 'cancellation'
             where booking_id = ${b.bookingId}`.execute(trx),
      ),
    ).toBe("42501");
    expect(
      await asRuntime((trx) =>
        sql`delete from booking_email_resends where booking_id = ${b.bookingId}`.execute(trx),
      ),
    ).toBe("42501");
    expect(await asRuntime((trx) => sql`truncate booking_email_resends`.execute(trx))).toBe(
      "42501",
    );
    expect(await ledgerOf(b.bookingId)).toHaveLength(1);
  });

  it("DB7. the service maps a limit the trigger raises to its typed refusal, and writes nothing for it", async () => {
    await clearHour(R);
    const seeded = await book(world, R, tripsR.shared(), 1);
    await seed(
      R,
      seeded.bookingId,
      Array.from({ length: 49 }, (_, i) => i + 1),
    );
    const b = await book(world, R, tripsR.shared(), 1);
    const before = await messagesOf(world.admin, b.bookingId);

    // Hold every email_messages write: the service passes its checks (its row
    // locks and reads do not conflict with this mode) and waits at its first
    // write. The 50th row lands, on another booking, before it continues.
    const conn = await world.admin.reserve();
    let result: ResendResult | undefined;
    try {
      await conn`begin`;
      await conn`lock table public.email_messages in share row exclusive mode`;
      const pending = serviceResend(R, b.bookingId, "confirmation");
      await poll("the service to wait on email_messages", async () => {
        const [row] = await world.admin<{ n: number }[]>`
          select count(*)::int as n from pg_locks
           where relation = 'public.email_messages'::regclass and not granted`;
        return (row?.n ?? 0) > 0;
      });
      await conn`alter table public.booking_email_resends disable trigger booking_email_resends_check`;
      const [m] = await conn<{ id: string }[]>`
        insert into public.email_messages (tenant_id, dedupe_key, template, template_version,
            booking_id, to_email, from_name, subject, html_body, text_body)
        values (${R.id}, ${`booking.resend:${seeded.bookingId}:50`}, 'booking_confirmation', 1,
                ${seeded.bookingId}, 'synthetic.seeded@example.test', 'Synthetic Operator',
                'Seeded resend', '<p>Seeded.</p>', 'Seeded.')
        returning id`;
      await conn`insert into public.booking_email_resends
                    (tenant_id, booking_id, generation, kind, message_id, actor_type)
                  values (${R.id}, ${seeded.bookingId}, 50, 'confirmation', ${m?.id ?? ""}, 'system')`;
      await conn`alter table public.booking_email_resends enable trigger booking_email_resends_check`;
      await conn`commit`;
      result = await pending;
    } finally {
      conn.release();
    }
    const [fiftieth] = await world.admin<{ at: Date }[]>`
      select created_at + interval '1 hour' as at from public.booking_email_resends
       where tenant_id = ${R.id} and created_at > now() - interval '1 hour'
       order by created_at desc offset 49 limit 1`;
    expect(result).toEqual({ kind: "refused", code: "rate_limited", availableAt: fiftieth?.at });
    expect(await resendMessagesOf(b.bookingId)).toEqual([]);
    expect(await ledgerOf(b.bookingId)).toEqual([]);
    expect(await auditRows(b.bookingId)).toBe(0);
    expect(await messagesOf(world.admin, b.bookingId)).toEqual(before);
  });

  it("DB8. at each boundary the service and a direct insert agree: 5th and 6th, 9:59 and 10:00, 50th and 51st", async () => {
    const answers: Record<string, { service: string; direct: string }> = {};

    // Deliverable: the 5th is allowed, the 6th refused.
    const limit = await book(world, A, tripsA.shared(), 1);
    await seed(A, limit.bookingId, [1, 2, 3, 4]);
    await backdate({ tenantId: A.id, bookingId: limit.bookingId }, 11);
    answers.fifth = await bothAnswer(A, limit.bookingId, 5);
    await seed(A, limit.bookingId, [5]);
    await backdate({ tenantId: A.id, bookingId: limit.bookingId }, 11);
    answers.sixth = await bothAnswer(A, limit.bookingId, 6);

    // The interval, to the transaction's own clock: 9:59 is refused, 10:00 allowed.
    const soon = await book(world, A, tripsA.shared(), 1);
    await seed(A, soon.bookingId, [1]);
    const at = (ago: string) => async (trx: TenantTransaction) => {
      const { rows } = await sql<{ now: string }>`select now()::text as now`.execute(trx);
      await newestAt(soon.bookingId, rows[0]?.now ?? "", ago);
    };
    answers["9:59"] = await bothAnswer(A, soon.bookingId, 2, at("9 minutes 59 seconds"));
    answers["10:00"] = await bothAnswer(A, soon.bookingId, 2, at("10 minutes"));

    // The operator's hour: the 50th is allowed, the 51st refused.
    await clearHour(R);
    const seeded = await book(world, R, tripsR.shared(), 1);
    await seed(
      R,
      seeded.bookingId,
      Array.from({ length: 49 }, (_, i) => i + 1),
    );
    const busy = await book(world, R, tripsR.shared(), 1);
    answers["50th"] = await bothAnswer(R, busy.bookingId, 1);
    await seed(R, seeded.bookingId, [50]);
    answers["51st"] = await bothAnswer(R, busy.bookingId, 1);

    expect(answers).toEqual({
      fifth: { service: "queued", direct: "ok" },
      sixth: { service: "limit", direct: directFor.limit },
      "9:59": { service: "too_soon", direct: directFor.too_soon },
      "10:00": { service: "queued", direct: "ok" },
      "50th": { service: "queued", direct: "ok" },
      "51st": { service: "rate_limited", direct: directFor.rate_limited },
    });
  });

  it("DB9. a REPEATABLE READ or SERIALIZABLE writer is refused 25000, so a stale snapshot cannot pass the hour", async () => {
    await clearHour(R);
    const seeded = await book(world, R, tripsR.shared(), 1);
    await seed(
      R,
      seeded.bookingId,
      Array.from({ length: 49 }, (_, i) => i + 1),
    );
    const fiftieth = await book(world, R, tripsR.shared(), 1);
    const late = await book(world, R, tripsR.shared(), 1);

    // The snapshot writer reads before the 50th row commits, then writes the 51st.
    let snapshotTaken = () => {};
    let resume = () => {};
    const taken = new Promise<void>((resolve) => {
      snapshotTaken = resolve;
    });
    const gate = new Promise<void>((resolve) => {
      resume = resolve;
    });
    const ctx = staffContext(R.id);
    const stale = outcome(
      world.db
        .transaction()
        .setIsolationLevel("repeatable read")
        .execute(async (trx) => {
          await setTenantContext(trx, ctx);
          snapshotTaken();
          await gate;
          await directWrite(trx, ctx, { bookingId: late.bookingId, generation: 1 });
        }),
    );
    await taken;
    expect(await outcome(direct(R, { bookingId: fiftieth.bookingId, generation: 1 }))).toBe("ok");
    resume();
    expect(await stale).toBe("25000");
    expect(await hourCount(R)).toBe(50);

    // Both snapshot levels, with nothing else going on.
    await clearHour(R);
    for (const level of ["repeatable read", "serializable"] as const) {
      const b = await book(world, R, tripsR.shared(), 1);
      const writer = staffContext(R.id);
      expect(
        await outcome(
          world.db
            .transaction()
            .setIsolationLevel(level)
            .execute(async (trx) => {
              await setTenantContext(trx, writer);
              await directWrite(trx, writer, { bookingId: b.bookingId, generation: 1 });
            }),
        ),
      ).toBe("25000");
      expect(await ledgerOf(b.bookingId)).toEqual([]);
    }
  });

  it("DB10. the ledger row's actor comes from the transaction's settings; a writer with none is the system", async () => {
    const viaService = await book(world, A, tripsA.shared(), 1);
    const requestId = `g216b-fu-${randomUUID()}`;
    const ctx = staffContext(A.id, requestId);
    const sent = await inTenantTransaction(world.db, ctx, (trx) =>
      resendBookingEmail(trx, ctx, {
        bookingId: viaService.bookingId,
        kind: "confirmation",
        reason: "other",
      }),
    );
    expect(sent.kind).toBe("queued");
    expect(await ledgerOf(viaService.bookingId)).toEqual([
      expect.objectContaining({
        actor_type: "staff",
        actor_id: staffOne,
        api_request_id: requestId,
      }),
    ]);

    // A direct writer that names the stamped columns is overridden.
    const forged = await book(world, A, tripsA.shared(), 1);
    const support: TenantContext = {
      tenantId: A.id,
      actorType: "support",
      actorId: "support-desk-1",
      requestId: "support-request-1",
    };
    await direct(A, { bookingId: forged.bookingId, generation: 1, forged: true }, support);
    const [row] = await ledgerOf(forged.bookingId);
    expect(row).toMatchObject({
      actor_type: "support",
      actor_id: "support-desk-1",
      api_request_id: "support-request-1",
    });
    const [clock] = await world.admin<{ fresh: boolean }[]>`
      select ${row?.created_at ?? null}::timestamptz > now() - interval '1 minute' as fresh`;
    expect(clock?.fresh).toBe(true);

    // The admin, with no settings at all, is the system, and is bound too.
    const bare = await book(world, A, tripsA.shared(), 1);
    await world.admin.begin(async (tx) => {
      const [m] = await tx<{ id: string }[]>`
        insert into public.email_messages (tenant_id, dedupe_key, template, template_version,
            booking_id, to_email, from_name, subject, html_body, text_body)
        values (${A.id}, ${`booking.resend:${bare.bookingId}:1`}, 'booking_confirmation', 1,
                ${bare.bookingId}, 'synthetic.admin@example.test', 'Synthetic Operator',
                'Admin resend', '<p>Admin.</p>', 'Admin.')
        returning id`;
      await tx`insert into public.booking_email_resends
                  (tenant_id, booking_id, generation, kind, message_id, actor_type, actor_id)
                values (${A.id}, ${bare.bookingId}, 1, 'confirmation', ${m?.id ?? ""}, 'staff', 'forged')`;
    });
    expect(await ledgerOf(bare.bookingId)).toEqual([
      expect.objectContaining({ actor_type: "system", actor_id: null, api_request_id: null }),
    ]);
  });
});
