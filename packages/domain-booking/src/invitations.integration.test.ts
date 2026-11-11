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
  enqueueMessage,
  FakeEmailProvider,
  resolveGuestSession,
} from "@tidegrid/domain-messaging";
import type { FakePaymentProvider } from "@tidegrid/domain-payments";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";
import {
  cancelBooking,
  getParticipantProfile,
  inviteParticipant,
  openParticipantSession,
  type ParticipantSession,
  participantSession,
  previewCancellation,
  putParticipant,
  removeParticipant,
  updateOwnDetails,
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

async function failure(p: Promise<unknown>): Promise<{ code?: string; constraint?: string }> {
  try {
    await p;
  } catch (err) {
    const e = err as { code?: string; constraint_name?: string };
    return {
      ...(e.code ? { code: e.code } : {}),
      ...(e.constraint_name ? { constraint: e.constraint_name } : {}),
    };
  }
  throw new Error("expected a database error");
}

describe.skipIf(!env)("participant invitations and their own details (W3-G2.11-rest)", () => {
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
  /** A guest context acting as one session, as the API sets it. */
  const sessionCtx = (tenantId: string, sessionId: string): TenantContext => ({
    ...guestContext(tenantId),
    actorId: `guest_session:${sessionId}`,
  });
  /** Run as the session: the context's actor is what the database stamps. */
  const asSession = <T>(
    tenantId: string,
    sessionId: string,
    fn: (trx: TenantTransaction, ctx: TenantContext) => Promise<T>,
  ): Promise<T> => as(sessionCtx(tenantId, sessionId), fn);
  const put = (
    ctx: TenantContext,
    bookingId: string,
    position: number,
    details: Parameters<typeof putParticipant>[2]["details"],
  ) => as(ctx, (trx, c) => putParticipant(trx, c, { bookingId, position, details }));
  const invite = (tenantId: string, bookingId: string, position: number) =>
    as(guestContext(tenantId), (trx, c) => inviteParticipant(trx, c, { bookingId, position }));
  const deliver = (tenant: CheckoutFixture) =>
    deliverTenantMessages(runtime.db, tenant.id, {
      provider: mail,
      fromAddress: "bookings@tidegrid.test",
      guestLinkOrigin: "http://{slug}.book.localhost:5301",
      environment: "local",
      runId: `run-${randomUUID()}`,
    });
  /** The link token of the newest invitation the fake mailbox holds for an address. */
  async function tokenFor(tenant: CheckoutFixture, to: string): Promise<string> {
    const inbox = await mail.listMailbox(tenant.id);
    const sent = inbox.filter((m) => m.to === to && m.subject.startsWith("Your place on"));
    // Newest first.
    const last = sent[0];
    if (!last) throw new Error(`no invitation to ${to}`);
    const message = await mail.getMailboxMessage(tenant.id, last.id);
    const token = /\/participant#t=([A-Za-z0-9_-]{43})/.exec(message?.html ?? "")?.[1];
    if (!token) throw new Error("no participant link in the invitation");
    return token;
  }
  const open = (tenant: CheckoutFixture, token: string) =>
    as(guestContext(tenant.id), (trx, c) => openParticipantSession(trx, c, { token }));
  async function openedSession(tenant: CheckoutFixture, token: string) {
    const opened = await open(tenant, token);
    if (opened.kind !== "opened") throw new Error(`not opened: ${opened.kind}`);
    const s = opened.session;
    return {
      token: s.token,
      session: {
        sessionId: s.sessionId,
        bookingId: s.bookingId,
        participantId: s.participantId as string,
        expiresAt: s.expiresAt,
      } satisfies ParticipantSession,
    };
  }
  const resolve = (tenantId: string, token: string) =>
    as(guestContext(tenantId), (trx) => participantSession(trx, tenantId, token));

  beforeAll(async () => {
    if (!env) return;
    admin = postgres(env.adminUrl, { max: 2, onnotice: () => {} });
    runtime = createDb(env.runtimeUrl, { max: 8 });
    payments = fakeProvider(runtime.db);
    mail = new FakeEmailProvider({ db: runtime.db, environment: "local" });
    A = await createCheckoutFixture(admin, runtime.db, "inv-a");
    B = await createCheckoutFixture(admin, runtime.db, "inv-b");
    tripsA = tripAllocator(A);
    for (const t of [A, B]) {
      await admin`insert into public.tenant_hostnames (hostname, tenant_id, kind, status, verified_at)
        values (${`${t.slug}.book.localhost`}, ${t.id}, 'preview', 'active', now())`;
    }
  });

  afterAll(async () => {
    await runtime?.end();
    await admin?.end({ timeout: 5 });
  });

  it("emails the participant's own address a link that shows and corrects only their details", async () => {
    const { bookingId } = await confirmBooking(runtime.db, payments, A, tripsA.shared(), 3, {
      booker: { name: "Bea Booker", email: "bea@example.test" },
    });
    const g = guestContext(A.id);
    await put(g, bookingId, 1, { name: "Bea Booker", isMinor: false, email: "bea@example.test" });
    await put(g, bookingId, 2, { name: "Cal Crew", isMinor: false, email: "cal@example.test" });
    await put(g, bookingId, 3, { name: "Dee Diver", isMinor: false, email: "dee@example.test" });

    const invited = await invite(A.id, bookingId, 2);
    expect(invited).toMatchObject({ kind: "invited", recipient: "participant" });
    const [msg] = await admin<{ to_email: string; template: string; link_purpose: string }[]>`
      select to_email, template, link_purpose from public.email_messages
       where booking_id = ${bookingId} and link_purpose = 'participant_profile'`;
    expect(msg).toEqual({
      to_email: "cal@example.test",
      template: "participant_invitation",
      link_purpose: "participant_profile",
    });
    // The audit row says who was written to, never the address.
    const [audit] = await admin<{ after_state: Record<string, unknown> }[]>`
      select after_state from public.audit_events
       where tenant_id = ${A.id} and action = 'participant.invited'
       order by occurred_at desc limit 1`;
    expect(audit?.after_state).toEqual({ bookingId, position: 2, recipient: "participant" });
    expect(JSON.stringify(audit)).not.toContain("cal@example.test");

    await deliver(A);
    const token = await tokenFor(A, "cal@example.test");
    // Another operator's site, and the booking's management, open nothing with it.
    expect(await open(B, token)).toEqual({ kind: "invalid" });
    const { token: sessionToken, session } = await openedSession(A, token);
    expect(await open(A, token)).toEqual({ kind: "used" });
    // The session is the participant's only: not a management session.
    expect(await as(g, (trx) => manageSession(trx, A.id, sessionToken))).toBeNull();
    expect(await resolve(B.id, sessionToken)).toBeNull();
    expect(await resolve(A.id, sessionToken)).toMatchObject({ bookingId });

    const profile = await as(g, (trx) => getParticipantProfile(trx, A.id, session));
    expect(profile).toMatchObject({
      participant: { position: 2, name: "Cal Crew", email: "cal@example.test", isMinor: false },
      bookingState: "confirmed",
      bookedBy: "Bea",
      editable: true,
    });
    const body = JSON.stringify(profile);
    for (const other of ["Dee Diver", "dee@example.test", "bea@example.test"]) {
      expect(body).not.toContain(other);
    }

    const updated = await asSession(A.id, session.sessionId, (trx, c) =>
      updateOwnDetails(trx, c, session, { name: "Calvin Crew", email: "cal@example.test" }),
    );
    expect(updated).toMatchObject({ kind: "updated", changed: ["name"] });
    const [row] = await admin<{ full_name: string }[]>`
      select full_name from public.booking_participants where booking_id = ${bookingId} and position = 3`;
    expect(row?.full_name).toBe("Dee Diver");
  });

  it("goes to a minor's guardian, keeps the minor a minor, and ends other access when the address changes", async () => {
    const { bookingId } = await confirmBooking(runtime.db, payments, A, tripsA.shared(), 2);
    const g = guestContext(A.id);
    await put(g, bookingId, 1, {
      name: "Kit Kid",
      isMinor: true,
      guardian: { name: "Gail Guardian", email: "gail@example.test" },
    });
    await put(g, bookingId, 2, { name: "Oli Other", isMinor: false, email: "oli@example.test" });
    expect(await invite(A.id, bookingId, 1)).toMatchObject({
      kind: "invited",
      recipient: "guardian",
    });
    expect(await invite(A.id, bookingId, 1)).toMatchObject({ kind: "invited" });
    await deliver(A);
    // Two emails; the newer link replaced the older one.
    const inbox = (await mail.listMailbox(A.id)).filter((m) => m.to === "gail@example.test");
    expect(inbox.length).toBe(2);
    const older = await mail.getMailboxMessage(A.id, inbox[1]?.id ?? "");
    const olderToken = /\/participant#t=([A-Za-z0-9_-]{43})/.exec(older?.html ?? "")?.[1];
    if (!olderToken) throw new Error("no older link");
    expect(await open(A, olderToken)).toEqual({ kind: "superseded" });
    const first = await openedSession(A, await tokenFor(A, "gail@example.test"));

    // A third invitation, queued but not sent, and a second session through it later.
    expect(await invite(A.id, bookingId, 1)).toMatchObject({ kind: "invited" });
    await deliver(A);
    const second = await openedSession(A, await tokenFor(A, "gail@example.test"));
    expect(await invite(A.id, bookingId, 1)).toEqual({ kind: "limit_reached" });

    // A minor's own session cannot make them an adult, by the service or directly.
    expect(
      await asSession(A.id, first.session.sessionId, (trx, c) =>
        updateOwnDetails(trx, c, first.session, { name: "Kit Kid", email: null, guardian: null }),
      ),
    ).toEqual({ kind: "details_invalid", field: "guardian" });
    expect(
      await failure(
        asSession(A.id, first.session.sessionId, (trx, c) =>
          putParticipant(trx, c, {
            bookingId,
            position: 1,
            details: { name: "Kit Kid", isMinor: false },
          }),
        ),
      ),
    ).toEqual({ code: "42501", constraint: "booking_participants_profile_session" });
    // Nor change, or name, anyone else.
    for (const position of [2]) {
      expect(
        await failure(
          asSession(A.id, first.session.sessionId, (trx, c) =>
            putParticipant(trx, c, {
              bookingId,
              position,
              details: { name: "Mallory", isMinor: false },
            }),
          ),
        ),
      ).toEqual({ code: "42501", constraint: "booking_participants_profile_session" });
    }

    // The guardian corrects their own address: this session stays, the other ends.
    const changed = await asSession(A.id, first.session.sessionId, (trx, c) =>
      updateOwnDetails(trx, c, first.session, {
        name: "Kit Kid",
        guardian: { name: "Gail Guardian", email: "gail.new@example.test" },
      }),
    );
    expect(changed).toMatchObject({ kind: "updated", changed: ["guardianEmail"] });
    expect(await resolve(A.id, first.token)).not.toBeNull();
    expect(await resolve(A.id, second.token)).toBeNull();
  });

  it("refuses an empty place, an adult without an address, and any other recipient", async () => {
    const { bookingId } = await confirmBooking(runtime.db, payments, A, tripsA.shared(), 3);
    const g = guestContext(A.id);
    await put(g, bookingId, 1, { name: "No Mail", isMinor: false });
    await put(g, bookingId, 2, { name: "Has Mail", isMinor: false, email: "has@example.test" });
    expect(await invite(A.id, bookingId, 1)).toEqual({ kind: "no_address" });
    expect(await invite(A.id, bookingId, 3)).toEqual({ kind: "place_not_named" });
    expect(await invite(A.id, bookingId, 4)).toEqual({
      kind: "position_out_of_range",
      partySize: 3,
    });
    expect(await invite(B.id, bookingId, 2)).toEqual({ kind: "booking_not_found" });
    const [has] = await admin<{ id: string }[]>`
      select id from public.booking_participants where booking_id = ${bookingId} and position = 2`;
    // The database sends an invitation only to the participant's own address.
    expect(
      await failure(
        as(g, (trx, c) =>
          enqueueMessage(trx, c, {
            dedupeKey: `test.invite:${randomUUID()}`,
            template: "participant_invitation",
            templateVersion: 1,
            to: { email: "someone.else@example.test" },
            bookingId,
            participantId: has?.id ?? null,
            content: {
              subject: "Invitation",
              blocks: [{ kind: "action", label: "Open", href: "access_link" }],
            },
            accessLink: { purpose: "participant_profile", path: "/participant", ttlSeconds: 3600 },
          }),
        ),
      ),
    ).toEqual({ code: "23514", constraint: "email_messages_profile_recipient" });
  });

  it("closes a queued invitation when the booker changes the address, and ends access on removal and cancellation", async () => {
    const { bookingId } = await confirmBooking(runtime.db, payments, A, tripsA.shared(), 3);
    const g = guestContext(A.id);
    await put(g, bookingId, 1, { name: "Pat One", isMinor: false, email: "pat@example.test" });
    await put(g, bookingId, 2, { name: "Quin Two", isMinor: false, email: "quin@example.test" });
    await put(g, bookingId, 3, { name: "Rae Three", isMinor: false, email: "rae@example.test" });

    // Queued for Pat, then the booker corrects Pat's address before it goes.
    const queued = await invite(A.id, bookingId, 1);
    if (queued.kind !== "invited") throw new Error(queued.kind);
    await put(g, bookingId, 1, { name: "Pat One", isMinor: false, email: "pat2@example.test" });
    const [closed] = await admin<{ state: string; last_error_code: string }[]>`
      select state, last_error_code from public.email_messages where id = ${queued.messageId}`;
    expect(closed).toEqual({ state: "canceled", last_error_code: "recipient_changed" });

    // Quin opens a session; removing Quin ends it and leaves nothing to read.
    await invite(A.id, bookingId, 2);
    await invite(A.id, bookingId, 3);
    await deliver(A);
    const quin = await openedSession(A, await tokenFor(A, "quin@example.test"));
    const removed = await as(g, (trx, c) =>
      removeParticipant(trx, c, { bookingId, position: 2, partySize: 3 }),
    );
    expect(removed.kind).toBe("removed");
    expect(await resolve(A.id, quin.token)).toBeNull();
    expect(await as(g, (trx) => getParticipantProfile(trx, A.id, quin.session))).toBeNull();
    expect(await invite(A.id, bookingId, 2)).toEqual({ kind: "place_removed" });

    // Rae's link, sent before the cancellation, opens nothing after it.
    const raeToken = await tokenFor(A, "rae@example.test");
    const terms = await as(g, (trx) => previewCancellation(trx, A.id, bookingId));
    if (!terms) throw new Error("no terms");
    const canceled = await as(g, (trx, c) =>
      cancelBooking(trx, c, { bookingId, expectedRefundAmount: terms.refundAmount }),
    );
    expect(canceled.kind).toBe("canceled");
    expect(await open(A, raeToken)).toEqual({ kind: "revoked" });
    expect(await invite(A.id, bookingId, 3)).toEqual({ kind: "booking_canceled" });
    const [live] = await admin<{ n: number }[]>`
      select count(*)::int as n from public.guest_access_links
       where booking_id = ${bookingId} and purpose = 'participant_profile'
         and consumed_at is null and revoked_at is null`;
    expect(live?.n).toBe(0);
    // And no session of this purpose can be opened for it, even directly.
    const [anyone] = await admin<{ id: string }[]>`
      select id from public.booking_participants where booking_id = ${bookingId} and position = 3`;
    expect(
      await as(g, (trx) => resolveGuestSession(trx, A.id, quin.token, "participant_profile")),
    ).toBeNull();
    expect(anyone?.id).toBeDefined();
  });

  it("cancels an invitation still queued when the trip leaves, and the operator's other mail still goes", async () => {
    const late = await confirmBooking(runtime.db, payments, A, tripsA.shared(), 1);
    await put(guestContext(A.id), late.bookingId, 1, {
      name: "Tia Tardy",
      isMinor: false,
      email: "tia@example.test",
    });
    const queued = await invite(A.id, late.bookingId, 1);
    if (queued.kind !== "invited") throw new Error(queued.kind);
    // The trip leaves before the delivery job gets to it.
    await admin`
      with t as (select date_trunc('minute', now()) - interval '400 days' as s)
      update public.scheduled_trips st
         set starts_at = t.s, ends_at = t.s + make_interval(mins => st.duration_minutes),
             boat_free_at = t.s + (st.boat_free_at - st.starts_at),
             local_date = (t.s at time zone st.time_zone)::date,
             local_start_time = (t.s at time zone st.time_zone)::time(0)
        from t, public.bookings b
       where b.id = ${late.bookingId} and st.id = b.trip_id`;
    const other = await confirmBooking(runtime.db, payments, A, tripsA.shared(), 1);
    await put(guestContext(A.id), other.bookingId, 1, {
      name: "Uma Ontime",
      isMinor: false,
      email: "uma@example.test",
    });
    const fine = await invite(A.id, other.bookingId, 1);
    if (fine.kind !== "invited") throw new Error(fine.kind);

    const run = await deliver(A);
    expect(run.items.find((i) => i.messageId === queued.messageId)).toMatchObject({
      outcome: "canceled",
    });
    expect(run.items.find((i) => i.messageId === fine.messageId)?.outcome).toBe("sent");
    const [row] = await admin<{ state: string; last_error_code: string }[]>`
      select state, last_error_code from public.email_messages where id = ${queued.messageId}`;
    expect(row).toEqual({ state: "canceled", last_error_code: "invitation_closed" });
    const [links] = await admin<{ n: number }[]>`
      select count(*)::int as n from public.guest_access_links where message_id = ${queued.messageId}`;
    expect(links?.n).toBe(0);
  });

  it("closes a queued invitation when its participant is removed", async () => {
    const { bookingId } = await confirmBooking(runtime.db, payments, A, tripsA.shared(), 2);
    const g = guestContext(A.id);
    await put(g, bookingId, 2, { name: "Vic Leaving", isMinor: false, email: "vic@example.test" });
    const queued = await invite(A.id, bookingId, 2);
    if (queued.kind !== "invited") throw new Error(queued.kind);
    const removed = await as(g, (trx, c) =>
      removeParticipant(trx, c, { bookingId, position: 2, partySize: 2 }),
    );
    expect(removed.kind).toBe("removed");
    const [row] = await admin<{ state: string; last_error_code: string }[]>`
      select state, last_error_code from public.email_messages where id = ${queued.messageId}`;
    expect(row).toEqual({ state: "canceled", last_error_code: "access_withdrawn" });
  });

  it("clamps a link to the trip's start", async () => {
    const { bookingId } = await confirmBooking(runtime.db, payments, A, tripsA.shared(), 1);
    await put(guestContext(A.id), bookingId, 1, {
      name: "Sol Solo",
      isMinor: false,
      email: "sol@example.test",
    });
    await invite(A.id, bookingId, 1);
    await deliver(A);
    const [link] = await admin<{ clamped: boolean }[]>`
      select l.expires_at <= t.starts_at as clamped
        from public.guest_access_links l
        join public.bookings b on b.id = l.booking_id
        join public.scheduled_trips t on t.id = b.trip_id
       where l.booking_id = ${bookingId} and l.purpose = 'participant_profile'`;
    expect(link?.clamped).toBe(true);
  });
});
