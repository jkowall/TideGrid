/**
 * W1-WAIVER-RENEWAL adversarial suite, on the local PostgreSQL 17 container
 * (TIDEGRID_EPHEMERAL_DB=1), synthetic data only.
 *
 * - D1: a guest with a spent, lapsed, or replaced emailed link gets a new one
 *   at the address the last one went to, at most three a day, and the answer
 *   never depends on whether anything was sent. A link that still works, a
 *   staff-assisted code, another operator's token, and an address that
 *   changed renew nothing.
 * - D2: five sends, then a staff reset with a reason allows five more,
 *   audited, held by the database for every writer.
 * - D3: a guardian's address that is also a participant's own address on the
 *   booking is flagged to staff, not blocked.
 * - W3-G2.15-rest: the booker sends a person's waiver email again from the
 *   management page, to the same address only, sharing the person's three a
 *   day, and never while an email is on its way.
 */
import { randomUUID } from "node:crypto";
import { inTenantTransaction, type TenantContext } from "@tidegrid/database";
import type {} from "@tidegrid/database/global-setup";
import type { BookingHooks } from "@tidegrid/domain-booking";
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";
import {
  BOOKER_RESEND_REASON,
  listBookingWaivers,
  renewWaiverLink,
  resendWaiverForBooker,
  resetWaiverSendCount,
  sendWaiverRequest,
  startAssistedSigning,
  type WaiverDeps,
} from "../index.ts";
import {
  adult,
  createWaiverFixture,
  fixtureDeps,
  fixtureHooks,
  linkFor,
  minor,
  type WaiverFixture,
} from "../test-fixtures.ts";
import {
  ageDeliveries,
  asApp,
  book,
  closeWorld,
  guestCtx,
  liveRequest,
  name,
  openFor,
  openWorld,
  redeem,
  refusal,
  sign,
  systemCtx,
  trips,
  type World,
} from "./harness.ts";

const env = inject("integrationDb");

describe.skipIf(!env)("W1-WAIVER-RENEWAL adversarial: link renewal and the send count", () => {
  let world: World;
  let A: WaiverFixture;
  let B: WaiverFixture;
  let nextTrip: () => string;
  let deps: WaiverDeps;
  let hooks: BookingHooks;
  let staffA: string;

  const staffCtx = (tenantId: string, staffId: string): TenantContext => ({
    tenantId,
    actorType: "staff",
    actorId: staffId,
    requestId: `renew-${randomUUID()}`,
    sourceIp: null,
  });

  function renew(tenantId: string, token: string) {
    const ctx = guestCtx(tenantId);
    return inTenantTransaction(world.db, ctx, (trx) => renewWaiverLink(trx, ctx, deps, { token }));
  }

  function bookerResend(tenantId: string, bookingId: string, position: number, name: string) {
    const ctx = guestCtx(tenantId);
    return inTenantTransaction(world.db, ctx, (trx) =>
      resendWaiverForBooker(trx, ctx, deps, { bookingId, position, name }),
    );
  }

  function resend(tenantId: string, requestId: string) {
    const ctx = systemCtx(tenantId);
    return inTenantTransaction(world.db, ctx, (trx) =>
      sendWaiverRequest(trx, ctx, deps, { requestId, kind: "resend", reason: "test resend" }),
    );
  }

  function reset(tenantId: string, requestId: string, ctx = staffCtx(tenantId, staffA)) {
    return inTenantTransaction(world.db, ctx, (trx) =>
      resetWaiverSendCount(trx, ctx, { requestId, reason: "Guest checked the address" }),
    );
  }

  async function deliveries(requestId: string) {
    return world.admin<{ generation: number; actor_type: string; recipient_email: string }[]>`
      select generation, actor_type, recipient_email from public.waiver_deliveries
       where request_id = ${requestId} order by generation`;
  }

  /** A named adult with their first email sent, and that email's token. */
  async function invited(
    label: string,
    email = `${label.toLowerCase().replace(/ /g, ".")}@example.test`,
  ) {
    const booked = await book(world, A, nextTrip(), 1, hooks);
    const pid = await name(world, A.id, booked.bookingId, 1, adult(label, email), hooks);
    const req = (await liveRequest(world.admin, booked.bookingId, pid)).id;
    const { token } = await linkFor(world.admin, world.db, A.id, req);
    return { booked, pid, req, token, email };
  }

  async function addStaff(tenant: WaiverFixture, display: string): Promise<string> {
    const id = randomUUID();
    await world.admin`insert into public.staff_users (id, email, display_name)
      values (${id}, ${`renew-${id.slice(0, 8)}@example.test`}, ${display})`;
    await world.admin`insert into public.tenant_memberships (tenant_id, user_id, role, display_name)
      values (${tenant.id}, ${id}, 'booking_staff', ${display})`;
    return id;
  }

  beforeAll(async () => {
    if (!env) return;
    world = openWorld(env, 12);
    deps = fixtureDeps();
    hooks = fixtureHooks();
    A = await createWaiverFixture(world.admin, world.db, "wvna", { days: 16 });
    B = await createWaiverFixture(world.admin, world.db, "wvnb", { days: 2 });
    nextTrip = trips(A);
    staffA = await addStaff(A, "Rene Desk");
  });

  afterAll(async () => {
    await closeWorld(world);
  });

  it("sends a spent link's guest a new one, to the same address, and the new link works", async () => {
    const { req, token, email } = await invited("Ola Opened");
    // A link that still works renews nothing.
    expect(await renew(A.id, token)).toEqual({ kind: "skipped", reason: "still_usable" });
    expect((await redeem(world, A.id, token)).kind).toBe("opened");
    await ageDeliveries(world.admin, req);
    expect(await renew(A.id, token)).toEqual({ kind: "renewed", generation: 2 });
    // While that email is still on its way, nothing more is renewed.
    await ageDeliveries(world.admin, req);
    expect(await renew(A.id, token)).toEqual({ kind: "skipped", reason: "email_pending" });
    const rows = await deliveries(req);
    expect(rows.at(-1)).toEqual({ generation: 2, actor_type: "guest", recipient_email: email });
    const fresh = await linkFor(world.admin, world.db, A.id, req);
    expect(fresh.to).toBe(email);
    expect(fresh.token).not.toBe(token);
    // While the new link waits unopened, the old token renews nothing, so it
    // cannot spend the guest's sends or replace their newest link.
    await ageDeliveries(world.admin, req);
    expect(await renew(A.id, token)).toEqual({ kind: "skipped", reason: "still_usable" });
    expect((await redeem(world, A.id, fresh.token)).kind).toBe("opened");
    // The audit names the guest's renewal, with no address.
    const [audit] = await world.admin<{ after_state: string }[]>`
      select after_state::text from public.audit_events
       where subject_id = ${req} and action = 'waiver_request.renewed'`;
    expect(audit?.after_state).not.toContain(email);
  }, 120_000);

  it.each([
    ["refused", "test", { kind: "renewed", generation: 3 }],
    ["whose outcome is unknown", "outcome_unknown", { kind: "skipped", reason: "still_usable" }],
    ["retried until it gave up", "retries_exhausted", { kind: "skipped", reason: "still_usable" }],
  ] as const)(
    "after a resend the provider %s, renews only if its link cannot have arrived",
    async (label, code, expected) => {
      const { req, token } = await invited(
        `Rio ${{ test: "Refused", outcome_unknown: "Unknown", retries_exhausted: "Exhausted" }[code]}`,
      );
      expect((await redeem(world, A.id, token)).kind).toBe("opened");
      await ageDeliveries(world.admin, req);
      expect(await resend(A.id, req)).toMatchObject({ kind: "sent", generation: 2 });
      // Delivered, so its link exists; then the provider's refusal comes back.
      await linkFor(world.admin, world.db, A.id, req);
      await world.admin.begin(async (tx) => {
        await tx`alter table public.email_messages disable trigger email_messages_rules`;
        await tx`update public.email_messages
                  set state = 'failed', sent_at = null, provider_message_id = null,
                      failed_at = now(), last_error_code = ${code}
                where dedupe_key = ${`waiver.request:${req}:2`}`;
        await tx`alter table public.email_messages enable trigger email_messages_rules`;
      });
      await ageDeliveries(world.admin, req);
      expect(await renew(A.id, token)).toEqual(expected);
    },
    120_000,
  );

  it("renews past a retried send's second token once the guest opened the email's own", async () => {
    const { req, token } = await invited("Dee Dupe");
    // A deduplicating provider's retry issued a second token for the same
    // message, which the guest never received.
    await world.admin`
      insert into public.guest_access_links
        (tenant_id, booking_id, participant_id, purpose, subject_ref, message_id, token_hash,
         expires_at)
      select tenant_id, booking_id, participant_id, purpose, subject_ref, message_id,
             encode(sha256(gen_random_uuid()::text::bytea), 'hex'), expires_at
        from public.guest_access_links
       where subject_ref = ${`waiver_request:${req}`} and message_id is not null`;
    expect(await renew(A.id, token)).toEqual({ kind: "skipped", reason: "still_usable" });
    expect((await redeem(world, A.id, token)).kind).toBe("opened");
    await ageDeliveries(world.admin, req);
    expect(await renew(A.id, token)).toEqual({ kind: "renewed", generation: 2 });
  }, 120_000);

  it("renews nothing for an unknown token, a crew code, another operator, or a changed address", async () => {
    const { booked, pid, req, token } = await invited("Uma Unknown");
    expect(await renew(A.id, "A".repeat(43))).toEqual({ kind: "skipped", reason: "invalid" });
    expect(await renew(A.id, "short")).toEqual({ kind: "skipped", reason: "invalid" });
    // Another operator's site finds nothing for this token.
    await redeem(world, A.id, token);
    await ageDeliveries(world.admin, req);
    expect(await renew(B.id, token)).toEqual({ kind: "skipped", reason: "invalid" });

    // A crew code, spent: the dock issues those, not the guest's mailbox.
    const ctx = staffCtx(A.id, staffA);
    const code = await inTenantTransaction(world.db, ctx, (trx) =>
      startAssistedSigning(trx, ctx, deps, {
        requestId: req,
        mode: "participant_qr",
        identityChecked: true,
      }),
    );
    if (code.kind !== "issued") throw new Error(JSON.stringify(code));
    const crewToken = code.token;
    expect((await redeem(world, A.id, crewToken)).kind).toBe("opened");
    expect(await renew(A.id, crewToken)).toEqual({ kind: "skipped", reason: "invalid" });

    // A corrected address had its own email; the old link, opened before the
    // change, renews nothing, even once the 10 minutes have passed and the new
    // address's link is spent.
    await name(
      world,
      A.id,
      booked.bookingId,
      1,
      adult("Uma Unknown", "uma.new@example.test"),
      hooks,
    );
    expect(await liveRequest(world.admin, booked.bookingId, pid)).toMatchObject({ id: req });
    const moved = await linkFor(world.admin, world.db, A.id, req);
    expect(moved.to).toBe("uma.new@example.test");
    await redeem(world, A.id, moved.token);
    await ageDeliveries(world.admin, req);
    const before = (await deliveries(req)).length;
    expect(await renew(A.id, token)).toEqual({ kind: "skipped", reason: "not_renewable" });
    expect((await deliveries(req)).length).toBe(before);
    const [renewed] = await world.admin<{ n: number }[]>`
      select count(*)::int as n from public.waiver_deliveries
       where request_id = ${req} and guest_renewal`;
    expect(renewed?.n).toBe(0);
  }, 120_000);

  it("allows three renewals a day for a participant, held by the database too", async () => {
    const { req, token, email } = await invited("Tri Three");
    await redeem(world, A.id, token);
    let current = token;
    for (const generation of [2, 3, 4]) {
      await ageDeliveries(world.admin, req);
      expect(await renew(A.id, current)).toEqual({ kind: "renewed", generation });
      current = (await linkFor(world.admin, world.db, A.id, req)).token;
      await redeem(world, A.id, current);
    }
    await ageDeliveries(world.admin, req);
    expect(await renew(A.id, current)).toEqual({ kind: "skipped", reason: "renewal_limit" });

    // A direct writer as the guest: a fourth today, or another address, is refused.
    const direct = (to: string) =>
      world.app.begin(async (tx) => {
        await tx`select set_config('app.tenant_id', ${A.id}, true),
                        set_config('app.actor_type', 'guest', true)`;
        const [m] = await tx<{ id: string }[]>`
          insert into public.email_messages
            (dedupe_key, template, template_version, booking_id, participant_id, subject_ref,
             to_email, from_name, subject, html_body, text_body, link_purpose, link_path,
             link_ttl_seconds, link_slot)
          select ${`waiver.request:${req}:5`}, template, template_version, booking_id,
                 participant_id, subject_ref, ${to}, from_name, subject, html_body, text_body,
                 link_purpose, link_path, link_ttl_seconds, md5(random()::text)
            from public.email_messages where subject_ref = ${`waiver_request:${req}`} limit 1
          returning id`;
        await tx`insert into public.waiver_deliveries
                   (request_id, generation, kind, recipient_email, message_id, reason,
                    guest_renewal)
                 values (${req}, 5, 'resend', ${to}, ${m?.id ?? ""}, 'direct', true)`;
      });
    expect(await refusal(direct(email))).toMatch(/waiver_deliveries_guest_limit/);
    expect(await refusal(direct("someone.else@example.test"))).toMatch(/waiver_deliveries_guest\b/);
  }, 180_000);

  it("allows five more sends after a staff reset, with a reason, audited, and only when used up", async () => {
    const { req } = await invited("Fay Five");
    expect(await reset(A.id, req)).toEqual({ kind: "not_needed" });
    for (const generation of [2, 3, 4, 5]) {
      await ageDeliveries(world.admin, req);
      expect(await resend(A.id, req)).toMatchObject({ kind: "sent", generation });
    }
    await ageDeliveries(world.admin, req);
    expect(await resend(A.id, req)).toEqual({ kind: "limit_reached" });

    // The staff read offers the reset.
    const read = async () => {
      const [row] = await world.admin<{ booking_id: string }[]>`
        select booking_id from public.waiver_requests where id = ${req}`;
      const ctx = systemCtx(A.id);
      const w = await inTenantTransaction(world.db, ctx, (trx) =>
        listBookingWaivers(trx, A.id, row?.booking_id ?? ""),
      );
      return w?.participants[0]?.request;
    };
    expect(await read()).toMatchObject({
      sendsLeft: 0,
      canResetSends: true,
      resendAvailableAt: null,
    });

    // Only a staff member resets it; the database holds that for every writer.
    const sys = systemCtx(A.id);
    await expect(
      inTenantTransaction(world.db, sys, (trx) =>
        resetWaiverSendCount(trx, sys, { requestId: req, reason: "x" }),
      ),
    ).rejects.toThrow();
    expect(
      await refusal(
        asApp(
          world,
          A.id,
          (
            tx,
          ) => tx`insert into public.waiver_send_resets (request_id, after_generation, actor_id, reason)
                     values (${req}, 5, 'waiver-adversary', 'direct')`,
        ),
      ),
    ).toMatch(/waiver_send_resets_staff/);
    // Another operator's staff finds nothing.
    expect(await reset(B.id, req, staffCtx(B.id, staffA))).toEqual({ kind: "not_found" });

    expect(await reset(A.id, req)).toEqual({ kind: "reset", afterGeneration: 5, sendsAllowed: 5 });
    expect(await reset(A.id, req)).toEqual({ kind: "not_needed" });
    expect(await read()).toMatchObject({ sendsLeft: 5, canResetSends: false });
    expect(await resend(A.id, req)).toMatchObject({ kind: "sent", generation: 6 });
    const [audit] = await world.admin<{ reason: string; actor_id: string }[]>`
      select reason, actor_id from public.audit_events
       where subject_id = ${req} and action = 'waiver_request.send_count_reset'`;
    expect(audit).toEqual({ reason: "Guest checked the address", actor_id: staffA });
    const [row] = await world.admin<{ id: string }[]>`
      select id from public.waiver_send_resets where request_id = ${req}`;
    expect(
      await refusal(world.admin`delete from public.waiver_send_resets where id = ${row?.id ?? ""}`),
    ).not.toBe("no-error");
    expect(
      await asApp(world, B.id, (tx) => tx`select 1 from public.waiver_send_resets`),
    ).toHaveLength(0);

    // A generation past five since the reset is refused at the database.
    for (const generation of [7, 8, 9, 10]) {
      await ageDeliveries(world.admin, req);
      expect(await resend(A.id, req)).toMatchObject({ kind: "sent", generation });
    }
    await ageDeliveries(world.admin, req);
    expect(await resend(A.id, req)).toEqual({ kind: "limit_reached" });

    // Two more resets reach the 20 in all, and nothing goes past it.
    for (const after of [10, 15]) {
      expect(await reset(A.id, req)).toEqual({
        kind: "reset",
        afterGeneration: after,
        sendsAllowed: 5,
      });
      for (let generation = after + 1; generation <= after + 5; generation += 1) {
        await ageDeliveries(world.admin, req);
        expect(await resend(A.id, req)).toMatchObject({ kind: "sent", generation });
      }
    }
    await ageDeliveries(world.admin, req);
    expect(await resend(A.id, req)).toEqual({ kind: "limit_reached" });
    expect(await reset(A.id, req)).toEqual({ kind: "not_needed" });
    expect(await read()).toMatchObject({ sendsLeft: 0, canResetSends: false });
    // The database holds the same ceiling for a direct writer.
    expect(
      await refusal(world.admin`
        insert into public.waiver_send_resets (tenant_id, request_id, after_generation, actor_id, reason)
        values (${A.id}, ${req}, 20, ${staffA}, 'direct')`),
    ).toMatch(/waiver_send_resets/);
    expect(
      await refusal(
        world.admin.begin(async (tx) => {
          const [m] = await tx<{ id: string }[]>`
            insert into public.email_messages
              (tenant_id, dedupe_key, template, template_version, booking_id, participant_id,
               subject_ref, to_email, from_name, subject, html_body, text_body, link_purpose,
               link_path, link_ttl_seconds, link_slot)
            select tenant_id, ${`waiver.request:${req}:21`}, template, template_version, booking_id,
                   participant_id, subject_ref, to_email, from_name, subject, html_body, text_body,
                   link_purpose, link_path, link_ttl_seconds, md5(random()::text)
              from public.email_messages where subject_ref = ${`waiver_request:${req}`}
             order by created_at desc limit 1
            returning id`;
          await tx`insert into public.waiver_deliveries
                     (tenant_id, request_id, generation, kind, recipient_email, message_id, reason)
                   select tenant_id, request_id, 21, 'resend', recipient_email, ${m?.id ?? ""}, 'direct'
                     from public.waiver_deliveries where request_id = ${req}
                    order by generation desc limit 1`;
        }),
      ),
    ).toMatch(/waiver_deliveries_generation/);
  }, 480_000);

  it("lets the booker send a person's waiver again, to the same address, sharing their three a day", async () => {
    const booked = await book(world, A, nextTrip(), 1, hooks);
    const email = "bea.booker@example.test";
    const pid = await name(world, A.id, booked.bookingId, 1, adult("Bea Booker", email), hooks);
    const req = (await liveRequest(world.admin, booked.bookingId, pid)).id;
    const sent = (generation: number) => ({ kind: "sent", generation });
    const refused = (reason: string) => ({ kind: "refused", reason, retryAfter: null });
    // The first email is still on its way: nothing more goes out.
    expect(await bookerResend(A.id, booked.bookingId, 1, "Bea Booker")).toEqual(
      refused("email_pending"),
    );
    const first = await linkFor(world.admin, world.db, A.id, req);
    // Delivered moments ago: the 10 minutes between emails to one address hold.
    expect(await bookerResend(A.id, booked.bookingId, 1, "Bea Booker")).toMatchObject({
      kind: "refused",
      reason: "too_soon",
      retryAfter: expect.any(Date),
    });
    await ageDeliveries(world.admin, req);
    expect(await bookerResend(A.id, booked.bookingId, 1, "Bea Booker")).toEqual(sent(2));
    const rows = await deliveries(req);
    expect(rows.at(-1)).toEqual({ generation: 2, actor_type: "guest", recipient_email: email });
    const [audit] = await world.admin<{ reason: string; actor_type: string }[]>`
      select reason, actor_type from public.audit_events
       where subject_id = ${req} and action = 'waiver_request.resent_by_booker'`;
    expect(audit).toEqual({ reason: BOOKER_RESEND_REASON, actor_type: "guest" });
    // The new email's link works and replaces the first, as any resend does.
    const second = await linkFor(world.admin, world.db, A.id, req);
    expect(second.to).toBe(email);
    expect(second.token).not.toBe(first.token);
    expect((await redeem(world, A.id, first.token)).kind).toBe("replaced");

    // The person's own renewal and the booker's share three a day.
    await ageDeliveries(world.admin, req);
    expect(await bookerResend(A.id, booked.bookingId, 1, "Bea Booker")).toEqual(sent(3));
    const third = await linkFor(world.admin, world.db, A.id, req);
    await redeem(world, A.id, second.token);
    await redeem(world, A.id, third.token);
    await ageDeliveries(world.admin, req);
    expect(await renew(A.id, third.token)).toEqual({ kind: "renewed", generation: 4 });
    await linkFor(world.admin, world.db, A.id, req);
    await ageDeliveries(world.admin, req);
    expect(await bookerResend(A.id, booked.bookingId, 1, "Bea Booker")).toEqual(
      refused("limit_reached"),
    );
    expect((await deliveries(req)).length).toBe(4);
  }, 180_000);

  it("refuses the booker's resend for no one, another operator, a signed waiver, or no address", async () => {
    const booked = await book(world, A, nextTrip(), 3, hooks);
    const refused = (reason: string) => ({ kind: "refused", reason, retryAfter: null });
    const signedPid = await name(
      world,
      A.id,
      booked.bookingId,
      1,
      adult("Sid Signed", "sid.signed@example.test"),
      hooks,
    );
    await name(world, A.id, booked.bookingId, 2, adult("Nia Noaddress", null), hooks);
    // Place 3 is not named; place 9 does not exist.
    expect(await bookerResend(A.id, booked.bookingId, 3, "Anyone")).toEqual(refused("not_found"));
    expect(await bookerResend(A.id, booked.bookingId, 9, "Anyone")).toEqual(refused("not_found"));
    // Another operator's site finds nothing for this booking.
    expect(await bookerResend(B.id, booked.bookingId, 1, "Sid Signed")).toEqual(
      refused("not_found"),
    );
    expect(await bookerResend(A.id, randomUUID(), 1, "Sid Signed")).toEqual(refused("not_found"));
    // A name the place no longer has: the party changed since the page loaded.
    expect(await bookerResend(A.id, booked.bookingId, 1, "Someone Else")).toEqual(
      refused("changed"),
    );
    // No address: nothing ever went out, so nothing goes out again.
    expect(await bookerResend(A.id, booked.bookingId, 2, "Nia Noaddress")).toEqual(
      refused("not_sent"),
    );
    // Signed: nothing to send.
    const req = (await liveRequest(world.admin, booked.bookingId, signedPid)).id;
    const opened = await openFor(world, A.id, req);
    expect((await sign(world, A.id, deps, opened.session)).kind).toBe("signed");
    await ageDeliveries(world.admin, req);
    expect(await bookerResend(A.id, booked.bookingId, 1, "Sid Signed")).toEqual(
      refused("not_pending"),
    );
    // Only a guest's transaction sends this way.
    const sys = systemCtx(A.id);
    await expect(
      inTenantTransaction(world.db, sys, (trx) =>
        resendWaiverForBooker(trx, sys, deps, {
          bookingId: booked.bookingId,
          position: 2,
          name: "Nia Noaddress",
        }),
      ),
    ).rejects.toThrow(/only a booker/);
  }, 120_000);

  it("refuses the booker's resend at the five sends and for one of two at once, and follows a new address", async () => {
    const booked = await book(world, A, nextTrip(), 1, hooks);
    const pid = await name(
      world,
      A.id,
      booked.bookingId,
      1,
      adult("Cy Change", "cy.one@example.test"),
      hooks,
    );
    const req = (await liveRequest(world.admin, booked.bookingId, pid)).id;
    await linkFor(world.admin, world.db, A.id, req);
    await ageDeliveries(world.admin, req);
    // Two at once: the request's lock orders them, and the second finds the first's email on its way.
    const both = await Promise.all([
      bookerResend(A.id, booked.bookingId, 1, "Cy Change"),
      bookerResend(A.id, booked.bookingId, 1, "Cy Change"),
    ]);
    expect(both.map((r) => (r.kind === "sent" ? "sent" : r.reason)).sort()).toEqual([
      "email_pending",
      "sent",
    ]);
    await linkFor(world.admin, world.db, A.id, req);
    // A staff resend brings the waiver to its five sends; the booker's is refused.
    for (const generation of [3, 4, 5]) {
      await ageDeliveries(world.admin, req);
      expect(await resend(A.id, req)).toMatchObject({ kind: "sent", generation });
      await linkFor(world.admin, world.db, A.id, req);
    }
    await ageDeliveries(world.admin, req);
    expect(await bookerResend(A.id, booked.bookingId, 1, "Cy Change")).toMatchObject({
      kind: "refused",
      reason: "limit_reached",
    });

    // A corrected address had its own email; the booker's resend then goes there only.
    const moved = await book(world, A, nextTrip(), 1, hooks);
    const mpid = await name(
      world,
      A.id,
      moved.bookingId,
      1,
      adult("Mo Moved", "mo.old@example.test"),
      hooks,
    );
    const mreq = (await liveRequest(world.admin, moved.bookingId, mpid)).id;
    await linkFor(world.admin, world.db, A.id, mreq);
    await name(world, A.id, moved.bookingId, 1, adult("Mo Moved", "mo.new@example.test"), hooks);
    await linkFor(world.admin, world.db, A.id, mreq);
    await ageDeliveries(world.admin, mreq);
    expect(await bookerResend(A.id, moved.bookingId, 1, "Mo Moved")).toMatchObject({
      kind: "sent",
    });
    expect((await deliveries(mreq)).at(-1)?.recipient_email).toBe("mo.new@example.test");
  }, 240_000);

  it("flags a guardian's address that is also a participant's own, and not a family of minors", async () => {
    const booked = await book(world, A, nextTrip(), 3, hooks);
    const shared = "pat.parent@example.test";
    await name(world, A.id, booked.bookingId, 1, adult("Pat Parent", shared), hooks);
    await name(
      world,
      A.id,
      booked.bookingId,
      2,
      minor("Kim Kid", { name: "Pat Parent", email: shared }),
      hooks,
    );
    await name(
      world,
      A.id,
      booked.bookingId,
      3,
      minor("Lee Kid", { name: "Gale Guard", email: "gale.guard@example.test" }),
      hooks,
    );
    const ctx = systemCtx(A.id);
    const read = await inTenantTransaction(world.db, ctx, (trx) =>
      listBookingWaivers(trx, A.id, booked.bookingId),
    );
    expect(read?.participants.map((p) => p.request?.sharedAddress)).toEqual([false, true, false]);
  }, 120_000);

  it("does not flag minors whose own email fields hold their shared guardian's address", async () => {
    const booked = await book(world, A, nextTrip(), 2, hooks);
    const family = "fay.family@example.test";
    for (const [position, kid] of [
      [1, "Mo Kid"],
      [2, "Ned Kid"],
    ] as const) {
      await name(
        world,
        A.id,
        booked.bookingId,
        position,
        { ...minor(kid, { name: "Fay Family", email: family }), email: family },
        hooks,
      );
    }
    const read = await inTenantTransaction(world.db, systemCtx(A.id), (trx) =>
      listBookingWaivers(trx, A.id, booked.bookingId),
    );
    expect(read?.participants.map((p) => p.request?.sharedAddress)).toEqual([false, false]);
  }, 120_000);
});
