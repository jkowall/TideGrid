/**
 * The staff resend limits held at the delivery claim (W1-RESEND-CLAIM,
 * migration 0017). Migration 0014 decides the limits when a resend is
 * written, on the ledger's stamps. A writer with tidegrid_app's credentials
 * that waits after 0014's commit check commits a resend with an old stamp,
 * and its email then goes out beside resends stamped minutes later. These
 * cases show that hole, and that every claim of a booking.resend: message,
 * by the delivery job or by a direct writer, now meets the limits at the
 * clock of the claim: 5 deliverable per booking, 10 minutes after another
 * resend of the booking was claimed, and 50 claimed per operator per hour.
 *
 * Writers use the runtime role through inTenantTransaction. The admin builds
 * fixtures, moves logged claims back to make time pass, and reads state.
 *
 * C1 to C10:
 * - C1, the hole: a resend committed after 0014's check with a stamp an hour
 *   old goes out, and a service resend of its booking written seconds later
 *   waits 10 minutes from that claim instead of going out at once.
 * - C2, the operator's hour: 50 claims bar a 51st resend 0014 allows.
 * - C3, a direct claim past each limit raises; nothing is logged.
 * - C4, concurrent claims at the boundary: exactly one goes ahead.
 * - C5, permanent refusals: the delivery job cancels the message.
 * - C6, the service path: a resend goes out at once; its own retry and the
 *   0015 give-back are not barred by its own earlier claims.
 * - C7, READ COMMITTED only.
 * - C8, lock order: a delivery run never waits on the tenant's resend lock;
 *   while a service resend holds it the run claims nothing, and a later run
 *   sends.
 * - C9, the log: stamped at the clock, names a resend message of its own
 *   booking, append-only, and isolated by tenant.
 * - C10, the catalog: forced row-level security, no DELETE, invoker
 *   functions with search_path pinned, the trigger still bound.
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
import { enqueueMessage, FakeEmailProvider } from "@tidegrid/domain-messaging";
import { sql } from "kysely";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";
import { type ResendKind, resendBookingEmail } from "../index.ts";
import { type CheckoutFixture, createCheckoutFixture, fakeProvider } from "../test-fixtures.ts";
import {
  addLocalHostname,
  asSystem,
  book,
  deliverMail,
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

describe.skipIf(!env)("adversarial: staff resend limits held at the delivery claim (0017)", () => {
  let world: SelfServiceWorld;
  let runtime: ReturnType<typeof createDb>;
  /** Per-booking cases. */
  let A: CheckoutFixture;
  /** Another tenant, for isolation. */
  let B: CheckoutFixture;
  /** The operator's hour; each case clears it first. */
  let R: CheckoutFixture;
  let tripsA: ReturnType<typeof tripAllocator>;
  let tripsB: ReturnType<typeof tripAllocator>;
  let tripsR: ReturnType<typeof tripAllocator>;
  const staff = randomUUID();

  function staffContext(tenantId: string): TenantContext {
    return { tenantId, actorType: "staff", actorId: staff, requestId: `rc-${randomUUID()}` };
  }

  async function serviceResend(tenant: CheckoutFixture, bookingId: string, kind: ResendKind) {
    const ctx = staffContext(tenant.id);
    const done = await inTenantTransaction(world.db, ctx, (trx) =>
      resendBookingEmail(trx, ctx, { bookingId, kind, reason: "guest_did_not_receive" }),
    );
    if (done.kind !== "queued") throw new Error(`setup: ${JSON.stringify(done)}`);
    return done.messageId;
  }

  /** A resend message and its ledger row, written straight into the transaction. */
  async function directWrite(
    trx: TenantTransaction,
    ctx: TenantContext,
    bookingId: string,
    generation: number,
  ): Promise<string> {
    const made = await enqueueMessage(trx, ctx, {
      dedupeKey: `booking.resend:${bookingId}:${generation}`,
      template: templateOf.confirmation,
      templateVersion: 1,
      to: { email: "synthetic.direct@example.test" },
      bookingId,
      content: { subject: "Direct resend", blocks: [{ kind: "paragraph", text: "Direct." }] },
    });
    if (made.kind !== "enqueued") throw new Error(`setup: ${JSON.stringify(made)}`);
    await sql`insert into booking_email_resends (tenant_id, booking_id, generation, kind, message_id)
              values (${ctx.tenantId}, ${bookingId}, ${generation}, 'confirmation', ${made.messageId})`.execute(
      trx,
    );
    return made.messageId;
  }

  /** A direct claim of one message, as the delivery job's claim writes it. */
  function claim(trx: TenantTransaction, tenantId: string, messageId: string) {
    return sql`update email_messages
                  set state = 'sending', attempts = attempts + 1, provider = 'fake',
                      lease_expires_at = now() + interval '2 minutes'
                where tenant_id = ${tenantId} and id = ${messageId}`.execute(trx);
  }

  function directClaim(tenant: CheckoutFixture, messageId: string) {
    return asSystem(world.db, tenant.id, (trx) => claim(trx, tenant.id, messageId));
  }

  /** Move the tenant's ledger rows, and optionally its claims, `minutes` back. */
  async function pass(
    tenant: CheckoutFixture,
    minutes: number,
    what: { ledger?: boolean; claims?: boolean } = { ledger: true, claims: true },
  ): Promise<void> {
    await world.admin.begin(async (tx) => {
      if (what.ledger) {
        await tx`alter table public.booking_email_resends disable trigger booking_email_resends_append_only`;
        await tx`update public.booking_email_resends
                    set created_at = created_at - make_interval(mins => ${minutes})
                  where tenant_id = ${tenant.id}`;
        await tx`alter table public.booking_email_resends enable trigger booking_email_resends_append_only`;
      }
      if (what.claims) {
        await tx`alter table public.booking_email_resend_claims
                   disable trigger booking_email_resend_claims_append_only`;
        await tx`update public.booking_email_resend_claims
                    set claimed_at = claimed_at - make_interval(mins => ${minutes})
                  where tenant_id = ${tenant.id}`;
        await tx`alter table public.booking_email_resend_claims
                   enable trigger booking_email_resend_claims_append_only`;
      }
    });
  }

  /** Empty the operator's last hour, on the ledger and the claims. */
  const clearHour = (tenant: CheckoutFixture) => pass(tenant, 61);

  /**
   * Earlier resends on one booking, sent, with their ledger rows, written by
   * the admin with triggers off (a fixture past the limits), and each with a
   * claim logged now: as many sends as the hole lets through at once.
   */
  async function seedClaimed(
    tenant: CheckoutFixture,
    bookingId: string,
    count: number,
  ): Promise<string[]> {
    return world.admin.begin(async (tx) => {
      await tx`set local session_replication_role = replica`;
      const ids: string[] = [];
      for (let generation = 1; generation <= count; generation += 1) {
        const [m] = await tx<{ id: string }[]>`
          insert into public.email_messages (tenant_id, dedupe_key, template, template_version,
              booking_id, to_email, from_name, subject, html_body, text_body, state, attempts,
              provider, provider_message_id, last_attempt_at, sent_at)
          values (${tenant.id}, ${`booking.resend:${bookingId}:${generation}`},
                  'booking_confirmation', 1, ${bookingId}, 'synthetic.seeded@example.test',
                  'Synthetic Operator', 'Seeded resend', '<p>Seeded.</p>', 'Seeded.', 'sent', 1,
                  'fake', ${`seed-${randomUUID()}`}, now(), now())
          returning id`;
        if (!m) throw new Error("setup: no seeded message");
        await tx`insert into public.booking_email_resends
                    (tenant_id, booking_id, generation, kind, message_id, actor_type, created_at)
                  values (${tenant.id}, ${bookingId}, ${generation}, 'confirmation', ${m.id},
                          'system', now() - interval '2 hours')`;
        await tx`insert into public.booking_email_resend_claims
                    (tenant_id, booking_id, message_id, attempt, claimed_at)
                  values (${tenant.id}, ${bookingId}, ${m.id}, 1, clock_timestamp())`;
        ids.push(m.id);
      }
      return ids;
    });
  }

  async function stateOf(messageId: string) {
    const [row] = await world.admin<
      { state: string; attempts: number; last_error_code: string | null }[]
    >`select state, attempts, last_error_code from public.email_messages where id = ${messageId}`;
    return row;
  }

  async function claimsOf(messageId: string): Promise<number> {
    const [row] = await world.admin<{ n: number }[]>`
      select count(*)::int as n from public.booking_email_resend_claims where message_id = ${messageId}`;
    return row?.n ?? -1;
  }

  async function refusalOf(tenant: CheckoutFixture, messageId: string) {
    return world.admin<{ code: string; available_at: Date | null }[]>`
      select code, available_at
        from app.booking_resend_claim_refusal(${tenant.id}, ${messageId}, clock_timestamp())`;
  }

  /** A promise and the function that settles it. */
  function gate(): { opened: Promise<void>; open: () => void } {
    let open = () => {};
    const opened = new Promise<void>((resolve) => {
      open = resolve;
    });
    return { opened, open };
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
      createCheckoutFixture(admin, runtime.db, "rsc-a", { days: 20 }),
      createCheckoutFixture(admin, runtime.db, "rsc-b", { days: 4 }),
      createCheckoutFixture(admin, runtime.db, "rsc-r", { days: 10 }),
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

  it("C1. a resend committed past 0014's check with an old stamp goes out, and the next resend of its booking waits 10 minutes from that claim", async () => {
    const b = await book(world, A, tripsA.shared(), 1);
    await deliverMail(world, A.id);
    // The hole, for real: SET CONSTRAINTS runs 0014's commit check early, and
    // the writer then holds its transaction past the bound and commits.
    const ctx = staffContext(A.id);
    const late = await outcome(
      inTenantTransaction(world.db, ctx, async (trx) => {
        await sql`select set_config('app.resend_max_transaction', '1 second', true)`.execute(trx);
        await directWrite(trx, ctx, b.bookingId, 1);
        await sql`set constraints email_messages_staff_resend immediate`.execute(trx);
        await sql`select pg_sleep(1.2)`.execute(trx);
      }),
    );
    expect(late).toBe("ok");
    const [lag] = await world.admin<{ lagged: boolean; id: string }[]>`
      select r.message_id as id, clock_timestamp() - r.created_at > interval '1 second' as lagged
        from public.booking_email_resends r where r.booking_id = ${b.bookingId}`;
    expect(lag?.lagged).toBe(true);
    // Scale that lag up: its stamp is now an hour old, as a writer that held
    // its commit for an hour would leave it. 0014 then lets a service resend
    // of the same booking through at once.
    await pass(A, 60, { ledger: true });
    const report = await deliverMail(world, A.id);
    expect(report.items.map((i) => [i.messageId, i.outcome])).toContainEqual([lag?.id, "sent"]);
    expect(await claimsOf(lag?.id ?? "")).toBe(1);

    const next = await serviceResend(A, b.bookingId, "confirmation");
    // Other mail queued behind the waiting resend, due after it.
    const other = await book(world, A, tripsA.shared(), 1);
    const [behind] = await world.admin<{ id: string; first: boolean }[]>`
      select o.id, r.next_attempt_at <= o.next_attempt_at as first
        from public.email_messages o, public.email_messages r
       where o.booking_id = ${other.bookingId} and r.id = ${next}`;
    expect(behind?.first).toBe(true);
    // The claim waits: 10 minutes from the late resend's claim, not its stamp.
    // The same run still sends the mail behind it.
    const held = await deliverMail(world, A.id);
    expect(held.items.map((i) => i.messageId)).not.toContain(next);
    expect(held.items.map((i) => [i.messageId, i.outcome])).toContainEqual([behind?.id, "sent"]);
    expect(await stateOf(next)).toMatchObject({ state: "queued", attempts: 0 });
    const [wait] = await refusalOf(A, next);
    expect(wait?.code).toBe("resend_interval");
    expect(await outcome(directClaim(A, next))).toBe("23514:email_messages_resend_interval");
    expect(await claimsOf(next)).toBe(0);

    // At 10 minutes the claim goes ahead.
    await pass(A, 10, { claims: true });
    const sent = await deliverMail(world, A.id);
    expect(sent.items.map((i) => [i.messageId, i.outcome])).toContainEqual([next, "sent"]);
    expect(await claimsOf(next)).toBe(1);
  });

  it("C2. 50 claims in the operator's hour bar a 51st resend that 0014 allows, until the oldest is an hour old", async () => {
    await clearHour(R);
    const many = await book(world, R, tripsR.shared(), 1);
    await seedClaimed(R, many.bookingId, 50);
    const b = await book(world, R, tripsR.shared(), 1);
    await deliverMail(world, R.id);
    // 0014 counts stamps, which the seed put two hours back: it allows this.
    const next = await serviceResend(R, b.bookingId, "confirmation");
    const held = await deliverMail(world, R.id);
    expect(held.items.map((i) => i.messageId)).not.toContain(next);
    const [oldest] = await world.admin<{ at: Date }[]>`
      select min(claimed_at) as at from public.booking_email_resend_claims
       where booking_id = ${many.bookingId}`;
    const [wait] = await refusalOf(R, next);
    expect(wait).toEqual({
      code: "resend_rate",
      available_at: new Date((oldest?.at.getTime() ?? 0) + 3_600_000),
    });
    expect(await outcome(directClaim(R, next))).toBe("23514:email_messages_resend_rate");

    await pass(R, 61, { claims: true });
    const sent = await deliverMail(world, R.id);
    expect(sent.items.map((i) => [i.messageId, i.outcome])).toContainEqual([next, "sent"]);
  });

  it("C3. a direct claim past each limit raises 23514, and logs nothing", async () => {
    // Interval: another resend of the booking was claimed 9 minutes ago.
    const b = await book(world, A, tripsA.shared(), 1);
    const first = await serviceResend(A, b.bookingId, "confirmation");
    expect(await outcome(directClaim(A, first))).toBe("ok");
    // Sent, so the next resend is not refused while it is in flight (0019).
    await world.admin`update public.email_messages
                         set state = 'sent', provider_message_id = ${`sent-${randomUUID()}`}
                       where id = ${first}`;
    await pass(A, 11, { ledger: true });
    const second = await asSystem(world.db, A.id, (trx, ctx) =>
      directWrite(trx, ctx, b.bookingId, 2),
    );
    await pass(A, 9, { claims: true });
    expect(await outcome(directClaim(A, second))).toBe("23514:email_messages_resend_interval");
    await pass(A, 1, { claims: true });
    expect(await outcome(directClaim(A, second))).toBe("ok");
    expect([await claimsOf(first), await claimsOf(second)]).toEqual([1, 1]);
  });

  it("C4. two claims at once at the operator's 49th: exactly one goes ahead, under the tenant's resend lock", async () => {
    await clearHour(R);
    const many = await book(world, R, tripsR.shared(), 1);
    await seedClaimed(R, many.bookingId, 49);
    const one = await book(world, R, tripsR.shared(), 1);
    const two = await book(world, R, tripsR.shared(), 1);
    const ids = await asSystem(world.db, R.id, async (trx, ctx) => [
      await directWrite(trx, ctx, one.bookingId, 1),
      await directWrite(trx, ctx, two.bookingId, 1),
    ]);
    const results = await Promise.all(ids.map((id) => outcome(directClaim(R, id))));
    expect(results.sort()).toEqual(["23514:email_messages_resend_rate", "ok"]);
    const [logged] = await world.admin<{ n: number }[]>`
      select count(*)::int as n from public.booking_email_resend_claims
       where message_id in ${world.admin(ids)}`;
    expect(logged?.n).toBe(1);
  });

  it("C5. a claim that can never go ahead is canceled by the delivery job: 5 deliverable, or no ledger row", async () => {
    // Five other resends deliverable, the sixth written with 0014's check off.
    const full = await book(world, A, tripsA.shared(), 1);
    await deliverMail(world, A.id);
    const seeded = await seedClaimed(A, full.bookingId, 5);
    await pass(A, 61, { claims: true });
    const [sixth] = await world.admin.begin(async (tx) => {
      await tx`alter table public.booking_email_resends disable trigger booking_email_resends_check`;
      const [m] = await tx<{ id: string }[]>`
        insert into public.email_messages (tenant_id, dedupe_key, template, template_version,
            booking_id, to_email, from_name, subject, html_body, text_body)
        values (${A.id}, ${`booking.resend:${full.bookingId}:6`}, 'booking_confirmation', 1,
                ${full.bookingId}, 'synthetic.seeded@example.test', 'Synthetic Operator',
                'Seeded resend', '<p>Seeded.</p>', 'Seeded.')
        returning id`;
      if (!m) throw new Error("setup");
      await tx`insert into public.booking_email_resends
                  (tenant_id, booking_id, generation, kind, message_id, actor_type)
                values (${A.id}, ${full.bookingId}, 6, 'confirmation', ${m.id}, 'system')`;
      await tx`alter table public.booking_email_resends enable trigger booking_email_resends_check`;
      return [m.id];
    });
    expect(seeded).toHaveLength(5);
    expect(await outcome(directClaim(A, sixth ?? ""))).toBe("23514:email_messages_resend_limit");
    const report = await deliverMail(world, A.id);
    expect(report.items).toContainEqual(
      expect.objectContaining({ messageId: sixth, outcome: "canceled", code: "resend_limit" }),
    );
    expect(await stateOf(sixth ?? "")).toEqual({
      state: "canceled",
      attempts: 0,
      last_error_code: "resend_limit",
    });

    // A resend message with no ledger row, written with every trigger off.
    const bare = await book(world, A, tripsA.shared(), 1);
    await deliverMail(world, A.id);
    const [orphan] = await world.admin.begin(async (tx) => {
      await tx`set local session_replication_role = replica`;
      return tx<{ id: string }[]>`
        insert into public.email_messages (tenant_id, dedupe_key, template, template_version,
            booking_id, to_email, from_name, subject, html_body, text_body)
        values (${A.id}, ${`booking.resend:${bare.bookingId}:1`}, 'booking_confirmation', 1,
                ${bare.bookingId}, 'synthetic.seeded@example.test', 'Synthetic Operator',
                'Seeded resend', '<p>Seeded.</p>', 'Seeded.')
        returning id`;
    });
    const orphaned = await deliverMail(world, A.id);
    expect(orphaned.items).toContainEqual(
      expect.objectContaining({
        messageId: orphan?.id,
        outcome: "canceled",
        code: "resend_unrecorded",
      }),
    );
  });

  it("C6. the service path: a resend goes out at once; its own retry and the 0015 give-back are not barred by its own claims", async () => {
    const b = await book(world, A, tripsA.shared(), 1);
    await deliverMail(world, A.id);
    const id = await serviceResend(A, b.bookingId, "confirmation");
    // A claim, then the 0015 give-back, then an immediate second claim.
    await asSystem(world.db, A.id, async (trx) => {
      await claim(trx, A.id, id);
    });
    await asSystem(world.db, A.id, async (trx) => {
      await sql`update email_messages
                   set state = 'queued', attempts = attempts - 1,
                       last_error_code = 'provider_quota_exceeded',
                       next_attempt_at = now() + interval '2 minutes'
                 where tenant_id = ${A.id} and id = ${id}`.execute(trx);
      await sql`update email_messages set next_attempt_at = now()
                 where tenant_id = ${A.id} and id = ${id}`.execute(trx);
    });
    const report = await deliverMail(world, A.id);
    expect(report.items.map((i) => [i.messageId, i.outcome])).toContainEqual([id, "sent"]);
    expect(await claimsOf(id)).toBe(2);
    expect(await stateOf(id)).toMatchObject({ state: "sent", attempts: 1 });
  });

  it("C7. a REPEATABLE READ or SERIALIZABLE claim of a resend is refused 25000", async () => {
    const b = await book(world, A, tripsA.shared(), 1);
    const id = await serviceResend(A, b.bookingId, "confirmation");
    for (const level of ["repeatable read", "serializable"] as const) {
      const ctx = staffContext(A.id);
      const result = await outcome(
        world.db
          .transaction()
          .setIsolationLevel(level)
          .execute(async (trx) => {
            await setTenantContext(trx, ctx);
            await claim(trx, A.id, id);
          }),
      );
      expect(result).toBe("25000");
    }
    expect(await claimsOf(id)).toBe(0);
  });

  it("C8. a delivery run never waits for a service resend on the tenant's resend lock: it claims nothing, and a later run sends", async () => {
    const b = await book(world, A, tripsA.shared(), 1);
    await deliverMail(world, A.id);
    await pass(A, 11);
    const ctx = staffContext(A.id);
    const resendHolds = gate();
    const resendGo = gate();
    const resend = inTenantTransaction(world.db, ctx, async (trx) => {
      const done = await resendBookingEmail(trx, ctx, {
        bookingId: b.bookingId,
        kind: "confirmation",
        reason: "guest_did_not_receive",
      });
      resendHolds.open();
      await resendGo.opened;
      return done;
    });
    await resendHolds.opened;
    // Due mail the run could claim, if it took the lock: a fresh booking.
    await book(world, A, tripsA.shared(), 1);
    const skipped = await deliverMail(world, A.id);
    expect(skipped.claimed).toBe(0);
    const [waiting] = await world.admin<{ n: number }[]>`
      select count(*)::int as n from pg_locks where not granted`;
    expect(waiting?.n).toBe(0);
    resendGo.open();
    const done = await resend;
    if (done.kind !== "queued") throw new Error(JSON.stringify(done));
    const report = await deliverMail(world, A.id);
    expect(report.items.map((i) => [i.messageId, i.outcome])).toContainEqual([
      done.messageId,
      "sent",
    ]);
  });

  it("C9. the log: stamped at the clock, a resend message of its own booking only, append-only, and isolated by tenant", async () => {
    const b = await book(world, A, tripsA.shared(), 1);
    const id = await serviceResend(A, b.bookingId, "confirmation");
    const other = await book(world, A, tripsA.shared(), 1);
    // A direct insert with a forged early time is stamped at the clock.
    await asSystem(world.db, A.id, (trx) =>
      sql`insert into booking_email_resend_claims (tenant_id, booking_id, message_id, attempt, claimed_at)
          values (${A.id}, ${b.bookingId}, ${id}, 1, now() - interval '1 day')`.execute(trx),
    );
    const [stamped] = await world.admin<{ recent: boolean }[]>`
      select claimed_at > now() - interval '1 minute' as recent
        from public.booking_email_resend_claims where message_id = ${id}`;
    expect(stamped?.recent).toBe(true);
    // Not a resend message of that booking.
    expect(
      await outcome(
        asSystem(world.db, A.id, (trx) =>
          sql`insert into booking_email_resend_claims (tenant_id, booking_id, message_id, attempt)
              values (${A.id}, ${other.bookingId}, ${id}, 1)`.execute(trx),
        ),
      ),
    ).toBe("23514:booking_email_resend_claims_message");
    // Append-only for the admin; no UPDATE or DELETE for the runtime.
    for (const statement of [
      world.admin`update public.booking_email_resend_claims set attempt = 2 where message_id = ${id}`,
      world.admin`delete from public.booking_email_resend_claims where message_id = ${id}`,
    ]) {
      expect(await outcome(statement)).not.toBe("ok");
    }
    expect(
      await outcome(
        asSystem(world.db, A.id, (trx) =>
          sql`delete from booking_email_resend_claims where message_id = ${id}`.execute(trx),
        ),
      ),
    ).toBe("42501");
    // Tenant B sees none of A's claims, and its own limits ignore them.
    const seen = await asSystem(world.db, B.id, (trx) =>
      sql<{ n: number }>`select count(*)::int as n from booking_email_resend_claims`.execute(trx),
    );
    expect(seen.rows[0]?.n).toBe(0);
    const bb = await book(world, B, tripsB.shared(), 1);
    const bid = await serviceResend(B, bb.bookingId, "confirmation");
    expect(await refusalOf(B, bid)).toEqual([]);
  });

  it("C10. the catalog: forced row-level security, SELECT and INSERT only, invoker functions with search_path pinned", async () => {
    const [table] = await world.admin<
      { forced: boolean; enabled: boolean; policies: string[]; privileges: string[] }[]
    >`
      select c.relforcerowsecurity as forced, c.relrowsecurity as enabled,
             array(select p.polname::text from pg_policy p where p.polrelid = c.oid) as policies,
             array(select x from unnest(array['SELECT','INSERT','UPDATE','DELETE','TRUNCATE']) x
                    where has_table_privilege('tidegrid_app', c.oid, x) order by x) as privileges
        from pg_class c where c.oid = 'public.booking_email_resend_claims'::regclass`;
    expect(table).toEqual({
      forced: true,
      enabled: true,
      policies: ["tenant_isolation"],
      privileges: ["INSERT", "SELECT"],
    });
    const fns = await world.admin<
      { name: string; definer: boolean; config: string[]; runtime: boolean }[]
    >`
      select p.proname as name, p.prosecdef as definer, p.proconfig as config,
             has_function_privilege('tidegrid_app', p.oid, 'EXECUTE') as runtime
        from pg_proc p join pg_namespace n on n.oid = p.pronamespace
       where n.nspname = 'app'
         and p.proname in ('booking_resend_claim_refusal', 'check_booking_email_resend_claim',
                           'check_email_message')
       order by p.proname`;
    const pinned = ["search_path=pg_catalog, pg_temp"];
    expect(fns).toEqual([
      { name: "booking_resend_claim_refusal", definer: false, config: pinned, runtime: true },
      { name: "check_booking_email_resend_claim", definer: false, config: pinned, runtime: false },
      { name: "check_email_message", definer: false, config: pinned, runtime: false },
    ]);
    const [bound] = await world.admin<{ n: number }[]>`
      select count(*)::int as n from pg_trigger t join pg_proc p on p.oid = t.tgfoid
       where t.tgrelid = 'public.email_messages'::regclass and t.tgname = 'email_messages_rules'
         and p.proname = 'check_email_message'`;
    expect(bound?.n).toBe(1);
  });
});
