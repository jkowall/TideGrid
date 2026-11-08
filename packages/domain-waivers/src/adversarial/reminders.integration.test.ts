/**
 * W1-G215-REMINDERS adversarial: reminders up to a completion cutoff
 * (migration 0025), against the waiver contract
 * (packages/domain-waivers/README.md, "Reminders").
 *
 * - The schedule (D1): one reminder from 72 hours before departure, one from
 *   24 hours before, none within 2 hours; a slot an email already covered is
 *   skipped.
 * - Deduplicated across sweeps and retries, and the fake provider's mailbox
 *   shows one send per reminder.
 * - A signature, revocation, cancellation, or participant change stops a
 *   queued reminder; a corrected address gets none until its own email.
 * - Reminders never count against the staff resend limits (D2).
 * - Two tenants, and the database rules for every writer.
 *
 * Trips are moved in time by the admin with the schedule trigger off for that
 * statement, as other suites age their rows. All data is synthetic.
 */
import { randomUUID } from "node:crypto";
import { inTenantTransaction } from "@tidegrid/database";
import type {} from "@tidegrid/database/global-setup";
import type { BookingHooks } from "@tidegrid/domain-booking";
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";
import {
  listBookingWaivers,
  remindWaiverRequest,
  sendWaiverRequest,
  sweepWaiverReminders,
  type WaiverDeps,
} from "../index.ts";
import {
  adult,
  createWaiverFixture,
  fixtureDeps,
  fixtureHooks,
  minor,
  type WaiverFixture,
} from "../test-fixtures.ts";
import {
  asApp,
  book,
  closeWorld,
  deliverWith,
  fakeMail,
  liveRequest,
  name,
  openFor,
  openWorld,
  redeem,
  refusal,
  sign,
  systemCtx,
  tokenOfMessage,
  trips,
  type World,
} from "./harness.ts";

const env = inject("integrationDb");

describe.skipIf(!env)("W1-G215-REMINDERS adversarial: waiver reminders", () => {
  let world: World;
  let A: WaiverFixture;
  let B: WaiverFixture;
  let nextTrip: () => string;
  let deps: WaiverDeps;
  let hooks: BookingHooks;

  /**
   * Move a trip to leave `hours` from now, on a boat of its own so it meets
   * no other departure. The admin, with the schedule trigger off.
   */
  async function departIn(tripId: string, hours: number) {
    await world.admin.begin(async (tx) => {
      await tx`alter table public.scheduled_trips disable trigger scheduled_trips_consistency`;
      const [boat] = await tx<{ id: string }[]>`
        insert into public.boats (tenant_id, name, guest_capacity)
        select b.tenant_id, ${`Moved ${randomUUID().slice(0, 8)}`}, b.guest_capacity
          from public.scheduled_trips t join public.boats b on b.tenant_id = t.tenant_id and b.id = t.boat_id
         where t.id = ${tripId}
        returning id`;
      await tx`insert into public.product_boats (tenant_id, product_id, boat_id)
               select tenant_id, product_id, ${boat?.id ?? ""} from public.scheduled_trips
                where id = ${tripId}`;
      await tx`update public.scheduled_trips
                  set boat_id = ${boat?.id ?? ""}, schedule_id = null,
                      boat_free_at = now() + make_interval(mins => ${Math.round(hours * 60)}) + (boat_free_at - starts_at),
                      ends_at = now() + make_interval(mins => ${Math.round(hours * 60)}) + (ends_at - starts_at),
                      starts_at = now() + make_interval(mins => ${Math.round(hours * 60)})
                where id = ${tripId}`;
      await tx`alter table public.scheduled_trips enable trigger scheduled_trips_consistency`;
    });
  }

  /** Make the request's emails look sent `days` ago. */
  async function ageEmails(requestId: string, days: number) {
    await world.admin.begin(async (tx) => {
      await tx`alter table public.waiver_deliveries disable trigger waiver_deliveries_append_only`;
      await tx`update public.waiver_deliveries
                  set created_at = created_at - make_interval(days => ${days}),
                      send_after = send_after - make_interval(days => ${days})
                where request_id = ${requestId}`;
      await tx`alter table public.waiver_deliveries enable trigger waiver_deliveries_append_only`;
      await tx`alter table public.waiver_reminders disable trigger waiver_reminders_append_only`;
      await tx`update public.waiver_reminders
                  set created_at = created_at - make_interval(days => ${days})
                where request_id = ${requestId}`;
      await tx`alter table public.waiver_reminders enable trigger waiver_reminders_append_only`;
      // Sent then, too: the grace counts from when an email went out.
      await tx`alter table public.email_messages disable trigger email_messages_rules`;
      await tx`update public.email_messages
                  set sent_at = sent_at - make_interval(days => ${days}),
                      last_attempt_at = last_attempt_at - make_interval(days => ${days})
                where subject_ref = ${`waiver_request:${requestId}`}`;
      await tx`alter table public.email_messages enable trigger email_messages_rules`;
    });
  }

  function remind(tenantId: string, requestId: string) {
    const ctx = systemCtx(tenantId, "waiver-reminders");
    return inTenantTransaction(world.db, ctx, (trx) =>
      remindWaiverRequest(trx, ctx, deps, requestId),
    );
  }

  async function remindersOf(requestId: string) {
    return world.admin<{ slot: string; message_id: string; state: string }[]>`
      select w.slot, w.message_id, m.state from public.waiver_reminders w
        join public.email_messages m on m.id = w.message_id
       where w.request_id = ${requestId} order by w.created_at`;
  }

  /** A booked adult with their first email sent and aged, on a trip `hours` away. */
  async function waiting(
    hours: number,
    label = "Rhea Remind",
    who: ReturnType<typeof adult> = adult(label),
  ) {
    const tripId = nextTrip();
    const booked = await book(world, A, tripId, 1, hooks);
    const pid = await name(world, A.id, booked.bookingId, 1, who, hooks);
    const req = (await liveRequest(world.admin, booked.bookingId, pid)).id;
    await deliverWith(world.db, A.id, fakeMail(world.db));
    await ageEmails(req, 10);
    await departIn(tripId, hours);
    return { tripId, booked, pid, req };
  }

  beforeAll(async () => {
    if (!env) return;
    world = openWorld(env, 12);
    deps = fixtureDeps();
    hooks = fixtureHooks();
    A = await createWaiverFixture(world.admin, world.db, "wvra", { days: 16 });
    B = await createWaiverFixture(world.admin, world.db, "wvrb", { days: 2 });
    nextTrip = trips(A);
  });

  afterAll(async () => {
    await closeWorld(world);
  });

  it("reminds at 72 and 24 hours before departure, once each, and never within 2 hours", async () => {
    const { tripId, req } = await waiting(100);
    expect(await remind(A.id, req)).toEqual({ kind: "skipped", reason: "outside_window" });

    await departIn(tripId, 70);
    const first = await remind(A.id, req);
    expect(first).toMatchObject({ kind: "queued", slot: "72h" });
    // A retry, and a sweep, find it done.
    expect(await remind(A.id, req)).toEqual({ kind: "skipped", reason: "already_reminded" });
    await sweepWaiverReminders(world.db, { runId: `t-${randomUUID()}`, deps });
    expect(await remindersOf(req)).toHaveLength(1);

    // The fake provider sends it once, with a link that works; the first
    // email's unused link is replaced.
    const mail = fakeMail(world.db);
    await deliverWith(world.db, A.id, mail);
    await deliverWith(world.db, A.id, mail);
    const [sent] = await remindersOf(req);
    expect(sent?.state).toBe("sent");
    const [attempts] = await world.admin<{ attempts: number }[]>`
      select attempts from public.email_messages where id = ${sent?.message_id ?? ""}`;
    expect(attempts?.attempts).toBe(1);
    const token = await tokenOfMessage(world, A.id, sent?.message_id ?? "");
    expect(token).not.toBeNull();

    // A day later, the 24 hour slot.
    await ageEmails(req, 2);
    await departIn(tripId, 20);
    expect(await remind(A.id, req)).toMatchObject({ kind: "queued", slot: "24h" });
    expect((await remindersOf(req)).map((r) => r.slot)).toEqual(["72h", "24h"]);

    // The cutoff: nothing, however the slot stands.
    const late = await waiting(1.5, "Lars Late");
    expect(await remind(A.id, late.req)).toEqual({ kind: "skipped", reason: "outside_window" });
    // The newest reminder's link opens the waiver; the earlier one's was replaced.
    const [, second] = await remindersOf(req);
    expect(second?.state).toBe("sent");
    const newest = await tokenOfMessage(world, A.id, second?.message_id ?? "");
    expect((await redeem(world, A.id, token ?? "")).kind).toBe("replaced");
    expect((await redeem(world, A.id, newest ?? "")).kind).toBe("opened");
  }, 120_000);

  it("queues one reminder when sweeps run at once, and none for another operator's trip", async () => {
    const { req } = await waiting(46, "Paz Parallel");
    const other = await waiting(44, "Uma Unique");
    const runs = await Promise.all(
      [1, 2, 3].map(() => sweepWaiverReminders(world.db, { runId: `t-${randomUUID()}`, deps })),
    );
    expect(runs.reduce((n, r) => n + r.failedTenants, 0)).toBe(0);
    expect((await remindersOf(req)).map((r) => r.slot)).toEqual(["72h"]);
    expect((await remindersOf(other.req)).map((r) => r.slot)).toEqual(["72h"]);
    const [count] = await world.admin<{ n: number }[]>`
      select count(*)::int as n from public.email_messages
       where dedupe_key in (${`waiver.reminder:${req}:72h`}, ${`waiver.reminder:${other.req}:72h`})`;
    expect(count?.n).toBe(2);
  }, 120_000);

  it("skips a slot an email already covered, and a request whose address changed", async () => {
    // Booked 30 hours ahead: the first email covers the 72 hour slot.
    const tripId = nextTrip();
    const booked = await book(world, A, tripId, 2, hooks);
    await departIn(tripId, 30);
    const pid = await name(world, A.id, booked.bookingId, 1, adult("Cora Close"), hooks);
    const req = (await liveRequest(world.admin, booked.bookingId, pid)).id;
    expect(await remind(A.id, req)).toEqual({ kind: "skipped", reason: "email_since" });

    // An email that went out an hour before the 24 hour slot opened covers it
    // too, counted from when it was sent, though it was queued days earlier.
    const early = await waiting(23, "Eli Early");
    await world.admin.begin(async (tx) => {
      await tx`alter table public.email_messages disable trigger email_messages_rules`;
      await tx`update public.email_messages
                  set sent_at = now() - interval '2 hours',
                      last_attempt_at = now() - interval '2 hours'
                where subject_ref = ${`waiver_request:${early.req}`}`;
      await tx`alter table public.email_messages enable trigger email_messages_rules`;
    });
    expect(await remind(A.id, early.req)).toEqual({ kind: "skipped", reason: "email_since" });
    // The staff read agrees: no reminder is next for that slot.
    const earlyRead = await inTenantTransaction(world.db, systemCtx(A.id), (trx) =>
      listBookingWaivers(trx, A.id, early.booked.bookingId),
    );
    expect(earlyRead?.participants[0]?.request?.reminders?.next ?? null).toBeNull();

    // A participant named with no address was never emailed: no reminder.
    const quiet = await name(world, A.id, booked.bookingId, 2, adult("Nell None", null), hooks);
    const quietReq = (await liveRequest(world.admin, booked.bookingId, quiet)).id;
    expect(await remind(A.id, quietReq)).toEqual({ kind: "skipped", reason: "never_sent" });

    // A corrected address gets its own email, not a reminder to the old one.
    const moved = await waiting(60, "Ivo Moved");
    await world.admin`update public.booking_participants set email = 'ivo.new@example.test'
                       where id = ${moved.pid}`;
    expect(await remind(A.id, moved.req)).toEqual({ kind: "skipped", reason: "address_changed" });
  }, 120_000);

  it("sends no later reminder once a reminder's own link was closed by an address change", async () => {
    // The 72 hour reminder replaced the invitation's link; then the address
    // was removed and put back, which closed the reminder's link. With no new
    // invitation since, the 24 hour slot sends nothing, and the database
    // refuses one too.
    const { tripId, booked, pid, req } = await waiting(58, "Rae Restored");
    expect(await remind(A.id, req)).toMatchObject({ kind: "queued", slot: "72h" });
    await deliverWith(world.db, A.id, fakeMail(world.db));
    const [first] = await remindersOf(req);
    await world.admin`update public.guest_access_links
                         set revoked_at = now(), revoked_reason = 'recipient_changed'
                       where message_id = ${first?.message_id ?? ""}`;
    await ageEmails(req, 2);
    await departIn(tripId, 20);
    expect(await remind(A.id, req)).toEqual({ kind: "skipped", reason: "address_changed" });
    const read = await inTenantTransaction(world.db, systemCtx(A.id), (trx) =>
      listBookingWaivers(trx, A.id, booked.bookingId),
    );
    expect(read?.participants[0]?.status).toBe("email_held");
    expect(read?.participants[0]?.request?.reminders?.next ?? null).toBeNull();
    const [latest] = await world.admin<{ recipient_email: string }[]>`
      select recipient_email from public.waiver_deliveries
       where request_id = ${req} order by generation desc limit 1`;
    const to = latest?.recipient_email ?? "";
    const direct = await refusal(
      asApp(world, A.id, async (tx) => {
        const [m] = await tx<{ id: string }[]>`
          insert into public.email_messages
            (dedupe_key, template, template_version, booking_id, participant_id, subject_ref,
             to_email, from_name, subject, html_body, text_body, link_purpose, link_path,
             link_ttl_seconds, link_slot)
          select ${`waiver.reminder:${req}:24h`}, template, template_version, booking_id,
                 participant_id, subject_ref, ${to}, from_name, subject,
                 html_body, text_body, link_purpose, link_path, link_ttl_seconds,
                 md5(random()::text)
            from public.email_messages
           where subject_ref = ${`waiver_request:${req}`}
           limit 1
          returning id`;
        await tx`insert into public.waiver_reminders
                   (request_id, booking_id, participant_id, slot, message_id, recipient_email)
                 values (${req}, ${booked.bookingId}, ${pid}, '24h', ${m?.id ?? ""}, ${to})`;
      }),
    );
    expect(direct).toMatch(/waiver_reminders_recipient/);
  }, 120_000);

  it("stops at a signature, a revocation, or a participant change", async () => {
    // Signed: the queued reminder is canceled and nothing more is queued.
    const signed = await waiting(66, "Sig Ned");
    const opened = await openFor(world, A.id, signed.req);
    expect(await remind(A.id, signed.req)).toMatchObject({ kind: "queued" });
    expect((await sign(world, A.id, deps, opened.session)).kind).toBe("signed");
    expect((await remindersOf(signed.req)).map((r) => r.state)).toEqual(["canceled"]);
    expect(await remind(A.id, signed.req)).toEqual({ kind: "skipped", reason: "not_pending" });

    // A participant change (now a minor) revokes the request and its reminder.
    const changed = await waiting(62, "Max Change");
    expect(await remind(A.id, changed.req)).toMatchObject({ kind: "queued" });
    await name(
      world,
      A.id,
      changed.booked.bookingId,
      1,
      minor("Max Change", { name: "Gwen Guard", email: "gwen.guard@example.test" }),
      hooks,
    );
    expect((await remindersOf(changed.req)).map((r) => r.state)).toEqual(["canceled"]);
    expect(await remind(A.id, changed.req)).toEqual({ kind: "skipped", reason: "not_pending" });
  }, 120_000);

  it("never counts against the staff resend limits, and shows on the staff read", async () => {
    const { booked, req } = await waiting(58, "Dee Two");
    expect(await remind(A.id, req)).toMatchObject({ kind: "queued", slot: "72h" });
    const readNow = () =>
      inTenantTransaction(world.db, systemCtx(A.id), (trx) =>
        listBookingWaivers(trx, A.id, booked.bookingId),
      );
    // While the reminder is on its way, only a slot still to open is promised.
    const queued = (await readNow())?.participants[0]?.request?.reminders;
    expect(queued?.sent.map((r) => [r.slot, r.state])).toEqual([["72h", "queued"]]);
    expect(queued?.next?.slot).toBe("24h");
    expect(queued?.next?.at.getTime()).toBeGreaterThan(Date.now());
    // Staff may resend at once: the reminder is no generation and no limit.
    const ctx = { ...systemCtx(A.id), actorType: "staff" as const, actorId: randomUUID() };
    const resent = await inTenantTransaction(world.db, ctx, (trx) =>
      sendWaiverRequest(trx, ctx, deps, { requestId: req, kind: "resend", reason: "Asked" }),
    );
    expect(resent).toMatchObject({ kind: "sent", generation: 2 });
    // The resend's email replaced the reminder still queued.
    expect((await remindersOf(req)).map((r) => r.state)).toEqual(["canceled"]);
  }, 120_000);

  it("shows the newest email's outcome, and the reminder's own event time", async () => {
    const { booked, req } = await waiting(58, "Fen Failed");
    expect(await remind(A.id, req)).toMatchObject({ kind: "queued", slot: "72h" });
    const readNow = async () =>
      (
        await inTenantTransaction(world.db, systemCtx(A.id), (trx) =>
          listBookingWaivers(trx, A.id, booked.bookingId),
        )
      )?.participants[0];
    // Sent: still waiting, the 24 hour one next.
    await deliverWith(world.db, A.id, fakeMail(world.db));
    const sent = await readNow();
    expect(sent?.status).toBe("waiting");
    expect(sent?.request?.reminders?.next?.slot).toBe("24h");
    // A reminder that failed after a sent invitation shows as a failed email,
    // with the time it failed.
    await world.admin.begin(async (tx) => {
      await tx`alter table public.email_messages disable trigger email_messages_rules`;
      await tx`update public.email_messages
                  set state = 'failed', sent_at = null, provider_message_id = null,
                      failed_at = now() + interval '1 hour',
                      last_error_code = 'test'
                where dedupe_key = ${`waiver.reminder:${req}:72h`}`;
      await tx`alter table public.email_messages enable trigger email_messages_rules`;
    });
    const failed = await readNow();
    expect(failed?.status).toBe("email_failed");
    const [reminder] = failed?.request?.reminders?.sent ?? [];
    expect(reminder?.state).toBe("failed");
    expect((reminder?.at.getTime() ?? 0) - (reminder?.queuedAt.getTime() ?? 0)).toBeGreaterThan(
      30 * 60_000,
    );
  }, 120_000);

  it("signs through a reminder link, for an adult and for a guardian, with the address it went to", async () => {
    const cases = [
      { label: "Ada Adult", who: adult("Ada Adult"), to: "ada.adult@example.test" },
      {
        label: "Kit Kid",
        who: minor("Kit Kid", { name: "Gil Guard", email: "gil.guard@example.test" }),
        to: "gil.guard@example.test",
      },
    ];
    for (const c of cases) {
      const { req } = await waiting(50, c.label, c.who);
      expect(await remind(A.id, req)).toMatchObject({ kind: "queued", slot: "72h" });
      await deliverWith(world.db, A.id, fakeMail(world.db));
      const [sent] = await remindersOf(req);
      expect(sent?.state).toBe("sent");
      const token = await tokenOfMessage(world, A.id, sent?.message_id ?? "");
      const opened = await redeem(world, A.id, token ?? "");
      if (opened.kind !== "opened") throw new Error(`redeem: ${JSON.stringify(opened)}`);
      expect((await sign(world, A.id, deps, opened.session)).kind).toBe("signed");
      const [evidence] = await world.admin<{ recipient_email: string; access_method: string }[]>`
        select e.recipient_email, e.access_method from public.waiver_evidence e
          join public.waiver_signing_sessions s on s.id = e.session_id
         where s.request_id = ${req}`;
      expect(evidence).toEqual({ recipient_email: c.to, access_method: "email_link" });
    }
  }, 120_000);

  it("keeps to its own tenant, and holds the rules at the database for every writer", async () => {
    const { req, booked, pid } = await waiting(54, "Tess Tenant");
    // Another operator's context finds nothing.
    expect(await remind(B.id, req)).toEqual({ kind: "skipped", reason: "not_found" });
    expect(await remind(A.id, req)).toMatchObject({ kind: "queued" });
    const [row] = await world.admin<{ id: string; message_id: string }[]>`
      select id, message_id from public.waiver_reminders where request_id = ${req}`;
    expect(
      await asApp(world, B.id, (tx) => tx`select 1 from public.waiver_reminders`),
    ).toHaveLength(0);

    // No update, delete, or truncate, for any role.
    expect(
      await refusal(
        asApp(
          world,
          A.id,
          (tx) => tx`update public.waiver_reminders set slot = '24h' where id = ${row?.id ?? ""}`,
        ),
      ),
    ).not.toBe("no-error");
    expect(
      await refusal(world.admin`delete from public.waiver_reminders where id = ${row?.id ?? ""}`),
    ).not.toBe("no-error");

    // A second reminder for the slot, or one naming an old message, is refused.
    const insert = (slot: string, messageId: string) =>
      asApp(
        world,
        A.id,
        (tx) => tx`insert into public.waiver_reminders
                     (request_id, booking_id, participant_id, slot, message_id, recipient_email)
                   values (${req}, ${booked.bookingId}, ${pid}, ${slot}, ${messageId},
                           'tess.tenant@example.test')`,
      );
    expect(await refusal(insert("72h", row?.message_id ?? ""))).toMatch(
      /waiver_reminders_once|waiver_reminders_message|waiver_reminders_one_message/,
    );
    // The 24 hour slot has not opened for a trip 54 hours away.
    expect(await refusal(insert("24h", row?.message_id ?? ""))).toMatch(/waiver_reminders_window/);

    // A reminder row cannot name an address the invitation never went to,
    // even with a matching reminder email queued in the same transaction.
    const fresh = await waiting(50, "Fay Forge");
    const forged = await refusal(
      asApp(world, A.id, async (tx) => {
        const [m] = await tx<{ id: string }[]>`
          insert into public.email_messages
            (dedupe_key, template, template_version, booking_id, participant_id, subject_ref,
             to_email, from_name, subject, html_body, text_body, link_purpose, link_path,
             link_ttl_seconds, link_slot)
          select ${`waiver.reminder:${fresh.req}:72h`}, template, template_version, booking_id,
                 participant_id, subject_ref, 'someone.else@example.test', from_name, subject,
                 html_body, text_body, link_purpose, link_path, link_ttl_seconds,
                 md5(random()::text)
            from public.email_messages
           where subject_ref = ${`waiver_request:${fresh.req}`}
           limit 1
          returning id`;
        await tx`insert into public.waiver_reminders
                   (request_id, booking_id, participant_id, slot, message_id, recipient_email)
                 values (${fresh.req}, ${fresh.booked.bookingId}, ${fresh.pid}, '72h', ${m?.id ?? ""},
                         'someone.else@example.test')`;
      }),
    );
    expect(forged).toMatch(/waiver_reminders_recipient/);
  }, 120_000);
});
