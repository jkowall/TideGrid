/**
 * Adversarial suite for accountless access (lane 1, G2.11c and the G2.16
 * email shim), against packages/domain-messaging/README.md ("Access links in
 * email", "Access links and guest sessions", "Delivery") and migration 0008.
 *
 * Invariants under attack: a link token is stored only as a SHA-256 hash; it
 * is consumed once, atomically, only by an explicit redemption; another
 * tenant's or another purpose's token is invalid and consumes nothing; a newer
 * email's link supersedes older unused ones, so the newest email's link is the
 * one that works; a session lasts at most 12 hours and is bound to one tenant,
 * booking, and purpose; renewals send at most three link emails per booking
 * an hour, to the booker's address on file; email goes out once per message.
 */
import { createHash, randomUUID } from "node:crypto";
import { createDb, inTenantTransaction } from "@tidegrid/database";
import type {} from "@tidegrid/database/global-setup";
import { tripAllocator } from "@tidegrid/domain-inventory/testing";
import {
  type EmailProvider,
  EmailProviderUnavailableError,
  enqueueMessage,
  FakeEmailProvider,
  issueAccessLink,
  openGuestSession,
  redeemAccessLink,
  revokeAccessLinks,
  revokeGuestSessions,
} from "@tidegrid/domain-messaging";
import { sql } from "kysely";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";
import {
  manageSession,
  openManageSessionFromCheckout,
  putParticipant,
  renewManageLink,
  requestManageLink,
} from "../index.ts";
import { type CheckoutFixture, createCheckoutFixture, fakeProvider } from "../test-fixtures.ts";
import { gate, RACE_ROUNDS, refusal, settle, startAt } from "./harness.ts";
import {
  acceptedFor,
  addLocalHostname,
  asGuest,
  asSystem,
  type Booked,
  book,
  deliveredToken,
  deliverMail,
  makeDue,
  messageOf,
  messagesOf,
  redeem,
  type SelfServiceWorld,
  syntheticBooker,
  tokenIn,
} from "./self-service-harness.ts";

const env = inject("integrationDb");
const ROUNDS = Math.max(4, RACE_ROUNDS);

const sha256 = (text: string) => createHash("sha256").update(text).digest("hex");

describe.skipIf(!env)("adversarial: access links, guest sessions, and booking email", () => {
  let world: SelfServiceWorld;
  let runtime: ReturnType<typeof createDb>;
  let A: CheckoutFixture;
  let B: CheckoutFixture;
  let C: CheckoutFixture;
  let tripsA: ReturnType<typeof tripAllocator>;
  let tripsB: ReturnType<typeof tripAllocator>;
  let tripsC: ReturnType<typeof tripAllocator>;

  /** The confirmation email of a fresh booking, delivered, and the token it carries. */
  async function bookedWithLink(
    tenant: CheckoutFixture,
    trips: ReturnType<typeof tripAllocator>,
    party = 2,
    booker?: { name: string; email: string },
  ): Promise<{ b: Booked; messageId: string; token: string }> {
    const b = await book(world, tenant, trips.shared(), party, booker ? { booker } : {});
    const [confirmation] = await messagesOf(world.admin, b.bookingId);
    if (!confirmation) throw new Error("setup: no confirmation email");
    await deliverMail(world, tenant.id);
    const sent = await messageOf(world.admin, confirmation.id);
    if (sent.state !== "sent") throw new Error(`setup: confirmation is ${sent.state}`);
    return { b, messageId: confirmation.id, token: await deliveredToken(world.admin, sent.id) };
  }

  async function linkRow(token: string) {
    const [row] = await world.admin<
      {
        id: string;
        message_id: string | null;
        consumed: boolean;
        revoked_reason: string | null;
        sessions: number;
      }[]
    >`
      select l.id, l.message_id, l.consumed_at is not null as consumed, l.revoked_reason,
             (select count(*)::int from public.guest_sessions s where s.link_id = l.id) as sessions
        from public.guest_access_links l where l.token_hash = ${sha256(`access-link:${token}`)}`;
    return row ?? null;
  }

  /** A provider that accepts through the fake and then loses the answer, as a dropped connection would. */
  const losingAnswers = (): EmailProvider => ({
    name: "fake",
    send: async (email) => {
      await world.mail.send(email);
      throw new Error("connection reset after the provider accepted");
    },
  });

  beforeAll(async () => {
    if (!env) return;
    const admin = postgres(env.adminUrl, { max: 4, onnotice: () => {} });
    runtime = createDb(env.runtimeUrl, { max: 14 });
    world = {
      admin,
      db: runtime.db,
      payments: fakeProvider(runtime.db),
      mail: new FakeEmailProvider({ db: runtime.db, environment: "local" }),
    };
    [A, B, C] = await Promise.all([
      createCheckoutFixture(admin, runtime.db, "ss-acc-a", { days: 40 }),
      createCheckoutFixture(admin, runtime.db, "ss-acc-b", { days: 12 }),
      createCheckoutFixture(admin, runtime.db, "ss-acc-c", { days: 6 }),
    ]);
    for (const t of [A, B, C]) await addLocalHostname(admin, t);
    tripsA = tripAllocator(A);
    tripsB = tripAllocator(B);
    tripsC = tripAllocator(C);
  });

  afterAll(async () => {
    await runtime?.end();
    await world?.admin.end({ timeout: 5 });
  });

  it("uses a link or replaces it when its redemption races a newer link or a revocation, never both", async () => {
    const outcomes: string[] = [];
    for (let round = 0; round < ROUNDS; round++) {
      const { b, token } = await bookedWithLink(A, tripsA);
      const replace = (): Promise<unknown> =>
        round % 2 === 0
          ? asSystem(world.db, A.id, (trx, ctx) =>
              issueAccessLink(trx, ctx, {
                bookingId: b.bookingId,
                purpose: "booking_manage",
                ttlSeconds: 3600,
              }),
            )
          : asSystem(world.db, A.id, (trx, ctx) =>
              revokeAccessLinks(trx, ctx, {
                bookingId: b.bookingId,
                purpose: "booking_manage",
                reason: "staff",
              }),
            );
      const go = gate();
      const racing = [
        startAt(go.opened, () => redeem(world, A.id, token), round % 4 === 1 ? 10 : 0),
        startAt(go.opened, replace, round % 4 === 2 ? 10 : 0),
      ] as const;
      go.open();
      const [redeemed, replaced] = await Promise.all(racing);
      if (!redeemed.ok) throw new Error(`redeem: ${redeemed.code} ${redeemed.message}`);
      if (!replaced.ok) throw new Error(`replace: ${replaced.code} ${replaced.message}`);
      const row = await linkRow(token);
      if (!row) throw new Error("no link row");
      outcomes.push(redeemed.value.kind);
      const answer = redeemed.value;
      if (answer.kind === "opened") {
        expect(row).toMatchObject({ consumed: true, revoked_reason: null, sessions: 1 });
        const session = await asGuest(world.db, A.id, (trx) =>
          manageSession(trx, A.id, answer.session.token),
        );
        expect(session?.bookingId).toBe(b.bookingId);
      } else {
        expect(["superseded", "revoked"]).toContain(answer.kind);
        expect(row).toMatchObject({ consumed: false, sessions: 0 });
        expect(row.revoked_reason).toBe(round % 2 === 0 ? "superseded" : "staff");
      }
    }
    // Both orders happen in practice; either way the row and the answer agree.
    expect(outcomes).toHaveLength(ROUNDS);
  }, 300_000);

  it("never lets a retried older email supersede the link in a newer email the guest already holds", async () => {
    const b = await book(world, A, tripsA.shared(), 2);
    const [confirmation] = await messagesOf(world.admin, b.bookingId);
    if (!confirmation) throw new Error("setup: no confirmation");
    // The provider accepts the confirmation, but its answer is lost: the
    // message waits for a retry while the guest already holds its email.
    await deliverMail(world, A.id, losingAnswers());
    expect(await messageOf(world.admin, confirmation.id)).toMatchObject({
      state: "queued",
      attempts: 1,
      last_error_code: "send_error",
    });
    const first = await deliveredToken(world.admin, confirmation.id);

    // The guest asks for a new link and gets it at once: that email's link is now the one that works.
    const asked = await asGuest(world.db, A.id, (trx, ctx) =>
      requestManageLink(trx, ctx, { bookingId: b.bookingId, requestKey: `adv-${randomUUID()}` }),
    );
    if (asked.kind !== "enqueued") throw new Error(`setup: ${asked.kind}`);
    await deliverMail(world, A.id);
    expect(await messageOf(world.admin, asked.messageId)).toMatchObject({ state: "sent" });
    const newest = await deliveredToken(world.admin, asked.messageId);
    expect((await linkRow(first))?.revoked_reason).toBe("superseded");

    // The confirmation's retry is sent with its own key; the provider answers
    // with the email it already accepted, so no new email reaches the guest.
    await makeDue(world.admin, confirmation.id);
    await deliverMail(world, A.id);
    expect(await messageOf(world.admin, confirmation.id)).toMatchObject({
      state: "sent",
      attempts: 2,
    });
    expect((await acceptedFor(world.admin, confirmation.id))?.count).toBe(1);
    expect(await deliveredToken(world.admin, confirmation.id)).toBe(first);

    // The newest email the guest holds must still open the booking.
    const live = await world.admin<{ message_id: string | null; delivered: boolean }[]>`
      select l.message_id,
             l.token_hash in (${sha256(`access-link:${first}`)}, ${sha256(`access-link:${newest}`)})
               as delivered
        from public.guest_access_links l
       where l.booking_id = ${b.bookingId} and l.consumed_at is null and l.revoked_at is null`;
    expect(
      live.filter((l) => l.delivered),
      "after the retry, no link in any email the guest received still works",
    ).toHaveLength(1);
    expect((await redeem(world, A.id, newest)).kind).toBe("opened");
  });

  it("opens the booking with the email the provider kept after its answer was lost", async () => {
    const b = await book(world, A, tripsA.shared(), 1);
    const [confirmation] = await messagesOf(world.admin, b.bookingId);
    if (!confirmation) throw new Error("setup: no confirmation");
    await deliverMail(world, A.id, losingAnswers());
    const kept = await deliveredToken(world.admin, confirmation.id);
    await makeDue(world.admin, confirmation.id);
    await deliverMail(world, A.id);
    expect(await messageOf(world.admin, confirmation.id)).toMatchObject({
      state: "sent",
      attempts: 2,
    });
    const accepted = await acceptedFor(world.admin, confirmation.id);
    expect(accepted?.count).toBe(1);
    expect(tokenIn(accepted?.html ?? "")).toBe(kept);
    // The retry issued a link of its own that no email carries; the kept one still works.
    const [links] = await world.admin<{ n: number }[]>`
      select count(*)::int as n from public.guest_access_links where message_id = ${confirmation.id}`;
    expect(links?.n).toBe(2);
    expect((await redeem(world, A.id, kept)).kind).toBe("opened");
    expect((await redeem(world, A.id, kept)).kind).toBe("used");
  });

  it("issues one link per message and sends each once when delivery runs overlap", async () => {
    const booked: Booked[] = [];
    for (let i = 0; i < 4; i++) booked.push(await book(world, B, tripsB.shared(), 1));
    const go = gate();
    const runs = Array.from({ length: 4 }, (_, i) =>
      startAt(go.opened, () => deliverMail(world, B.id), i * 2),
    );
    go.open();
    for (const r of await Promise.all(runs)) {
      if (!r.ok) throw new Error(`${r.code} ${r.message}`);
    }
    for (const b of booked) {
      const [m] = await messagesOf(world.admin, b.bookingId);
      if (!m) throw new Error("no confirmation");
      expect(m).toMatchObject({ state: "sent", attempts: 1, to_email: b.bookerEmail });
      expect((await acceptedFor(world.admin, m.id))?.count).toBe(1);
      const [links] = await world.admin<{ n: number }[]>`
        select count(*)::int as n from public.guest_access_links where message_id = ${m.id}`;
      expect(links?.n).toBe(1);
      expect((await redeem(world, B.id, await deliveredToken(world.admin, m.id))).kind).toBe(
        "opened",
      );
    }
  });

  it("opens a session only for its link's own booking, participant, and purpose, and once per link", async () => {
    const one = await book(world, A, tripsA.shared(), 2);
    const two = await book(world, A, tripsA.shared(), 2);
    const link = await asSystem(world.db, A.id, (trx, ctx) =>
      issueAccessLink(trx, ctx, {
        bookingId: one.bookingId,
        purpose: "booking_manage",
        ttlSeconds: 3600,
      }),
    );
    // A forged link record for another booking opens nothing, and the failed
    // redemption rolls back with it, so the link still works.
    const forged = await settle(
      asGuest(world.db, A.id, async (trx, ctx) => {
        const redeemed = await redeemAccessLink(trx, ctx, {
          token: link.token,
          purpose: "booking_manage",
        });
        if (redeemed.kind !== "redeemed") throw new Error(redeemed.kind);
        return openGuestSession(trx, ctx, {
          link: { ...redeemed.link, bookingId: two.bookingId },
        });
      }),
    );
    expect(forged).toMatchObject({
      ok: false,
      code: "23514",
      constraint: "guest_sessions_evidence",
    });
    // One session per redeemed link.
    const twice = await settle(
      asGuest(world.db, A.id, async (trx, ctx) => {
        const redeemed = await redeemAccessLink(trx, ctx, {
          token: link.token,
          purpose: "booking_manage",
        });
        if (redeemed.kind !== "redeemed") throw new Error(redeemed.kind);
        await openGuestSession(trx, ctx, { link: redeemed.link });
        return openGuestSession(trx, ctx, { link: redeemed.link });
      }),
    );
    expect(twice).toMatchObject({
      ok: false,
      code: "23505",
      constraint: "guest_sessions_one_per_link",
    });
    expect((await redeem(world, A.id, link.token)).kind).toBe("opened");

    // A participant's waiver link opens that participant's session only.
    const named = await asGuest(world.db, A.id, (trx, ctx) =>
      putParticipant(trx, ctx, {
        bookingId: one.bookingId,
        position: 1,
        details: { name: "Synthetic Signer", isMinor: false },
      }),
    );
    if (named.kind !== "created") throw new Error("setup participant");
    const subjectRef = `waiver_request:${randomUUID()}`;
    const waiver = await asSystem(world.db, A.id, (trx, ctx) =>
      issueAccessLink(trx, ctx, {
        bookingId: one.bookingId,
        participantId: named.participant.id,
        purpose: "waiver_sign",
        subjectRef,
        ttlSeconds: 3600,
      }),
    );
    for (const tamper of [
      { participantId: null },
      { subjectRef: `waiver_request:${randomUUID()}` },
    ]) {
      const tampered = await settle(
        asGuest(world.db, A.id, async (trx, ctx) => {
          const redeemed = await redeemAccessLink(trx, ctx, {
            token: waiver.token,
            purpose: "waiver_sign",
          });
          if (redeemed.kind !== "redeemed") throw new Error(redeemed.kind);
          return openGuestSession(trx, ctx, { link: { ...redeemed.link, ...tamper } });
        }),
      );
      expect(tampered).toMatchObject({ ok: false, constraint: "guest_sessions_evidence" });
    }
    // The management page never accepts it, and asking does not use it up.
    expect((await redeem(world, A.id, waiver.token)).kind).toBe("invalid");
    const opened = await asGuest(world.db, A.id, async (trx, ctx) => {
      const redeemed = await redeemAccessLink(trx, ctx, {
        token: waiver.token,
        purpose: "waiver_sign",
      });
      if (redeemed.kind !== "redeemed") throw new Error(redeemed.kind);
      return openGuestSession(trx, ctx, { link: redeemed.link });
    });
    expect(opened).toMatchObject({
      bookingId: one.bookingId,
      participantId: named.participant.id,
      purpose: "waiver_sign",
      subjectRef,
    });
    // A waiver session is not a management session.
    expect(
      await asGuest(world.db, A.id, (trx) => manageSession(trx, A.id, opened.token)),
    ).toBeNull();
    // And a management link does not open a waiver.
    const manage = await asSystem(world.db, A.id, (trx, ctx) =>
      issueAccessLink(trx, ctx, {
        bookingId: two.bookingId,
        purpose: "booking_manage",
        ttlSeconds: 3600,
      }),
    );
    expect(
      await asGuest(world.db, A.id, (trx, ctx) =>
        redeemAccessLink(trx, ctx, { token: manage.token, purpose: "waiver_sign" }),
      ),
    ).toEqual({ kind: "invalid" });
    expect((await linkRow(manage.token))?.consumed).toBe(false);
  });

  it("bounds a session to 12 hours for every role, and expiries move only earlier", async () => {
    const b = await book(world, A, tripsA.shared(), 1);
    await expect(
      asGuest(world.db, A.id, (trx, ctx) =>
        openGuestSession(trx, ctx, {
          checkout: { checkoutSessionId: b.checkoutSessionId, bookingId: b.bookingId },
          ttlSeconds: 12 * 3600 + 1,
        }),
      ),
    ).rejects.toThrow(RangeError);
    // Even the owner cannot write a longer one.
    expect(
      await refusal(world.admin`insert into public.guest_sessions (tenant_id, booking_id, purpose,
          checkout_session_id, token_hash, expires_at)
        values (${A.id}, ${b.bookingId}, 'booking_manage', ${b.checkoutSessionId},
                ${sha256(randomUUID())}, now() + interval '12 hours 1 second')`),
    ).toEqual({ code: "23514", constraint: "guest_sessions_expiry" });
    const longest = await asGuest(world.db, A.id, (trx, ctx) =>
      openGuestSession(trx, ctx, {
        checkout: { checkoutSessionId: b.checkoutSessionId, bookingId: b.bookingId },
        ttlSeconds: 12 * 3600,
      }),
    );
    const [span] = await world.admin<{ seconds: number }[]>`
      select extract(epoch from expires_at - created_at)::int as seconds
        from public.guest_sessions where id = ${longest.sessionId}`;
    expect(span?.seconds).toBe(12 * 3600);
    const link = await asSystem(world.db, A.id, (trx, ctx) =>
      issueAccessLink(trx, ctx, {
        bookingId: b.bookingId,
        purpose: "booking_manage",
        ttlSeconds: 600,
      }),
    );

    // The runtime role cannot move an expiry at all.
    const asRuntime = (statement: ReturnType<typeof sql>) =>
      settle(
        inTenantTransaction(
          world.db,
          { tenantId: A.id, actorType: "system", actorId: "adv", requestId: "adv" },
          async (trx) => {
            await statement.execute(trx);
          },
        ),
      );
    expect(
      await asRuntime(sql`update guest_access_links set expires_at = now() - interval '1 second'
                           where id = ${link.linkId}`),
    ).toMatchObject({ ok: false, code: "42501" });
    expect(
      await asRuntime(sql`update guest_sessions set expires_at = now() - interval '1 second'
                           where id = ${longest.sessionId}`),
    ).toMatchObject({ ok: false, code: "42501" });
    // Nor use one that has expired.
    await world.admin`update public.guest_access_links set expires_at = now() - interval '1 second'
                       where id = ${link.linkId}`;
    expect(
      await asRuntime(
        sql`update guest_access_links set consumed_at = now() where id = ${link.linkId}`,
      ),
    ).toMatchObject({ ok: false, code: "23514", constraint: "guest_access_links_expiry" });
    expect((await redeem(world, A.id, link.token)).kind).toBe("expired");

    // The owner moves a session's expiry earlier only, and never revives one.
    expect(
      await refusal(world.admin`update public.guest_sessions
          set expires_at = expires_at + interval '1 second' where id = ${longest.sessionId}`),
    ).toEqual({ code: "23514", constraint: "guest_sessions_immutable" });
    await world.admin`update public.guest_sessions set expires_at = now() - interval '1 second'
                       where id = ${longest.sessionId}`;
    expect(
      await asGuest(world.db, A.id, (trx) => manageSession(trx, A.id, longest.token)),
    ).toBeNull();
    const revived = await asGuest(world.db, A.id, (trx, ctx) =>
      openGuestSession(trx, ctx, {
        checkout: { checkoutSessionId: b.checkoutSessionId, bookingId: b.bookingId },
      }),
    );
    await asGuest(world.db, A.id, (trx, ctx) =>
      revokeGuestSessions(trx, ctx, { bookingId: b.bookingId, purpose: "booking_manage" }),
    );
    expect(
      await refusal(
        world.admin`update public.guest_sessions set revoked_at = null where id = ${revived.sessionId}`,
      ),
    ).toEqual({ code: "23514", constraint: "guest_sessions_transition" });
    // A used link's expiry no longer moves at all.
    const used = await asSystem(world.db, A.id, (trx, ctx) =>
      issueAccessLink(trx, ctx, {
        bookingId: b.bookingId,
        purpose: "booking_manage",
        ttlSeconds: 600,
      }),
    );
    expect((await redeem(world, A.id, used.token)).kind).toBe("opened");
    expect(
      await refusal(world.admin`update public.guest_access_links
          set expires_at = now() - interval '1 second' where id = ${used.linkId}`),
    ).toEqual({ code: "23514", constraint: "guest_access_links_transition" });
  });

  it("ends every live session of one booking and no other when its sessions are revoked", async () => {
    const one = await book(world, A, tripsA.shared(), 1);
    const two = await book(world, A, tripsA.shared(), 1);
    const fromCheckout = (b: Booked) =>
      asGuest(world.db, A.id, (trx, ctx) =>
        openManageSessionFromCheckout(trx, ctx, {
          checkoutSessionId: b.checkoutSessionId,
          secret: b.secret,
        }),
      );
    const a1 = await fromCheckout(one);
    const viaLink = await asSystem(world.db, A.id, (trx, ctx) =>
      issueAccessLink(trx, ctx, {
        bookingId: one.bookingId,
        purpose: "booking_manage",
        ttlSeconds: 600,
      }),
    );
    const a2 = await redeem(world, A.id, viaLink.token);
    const b1 = await fromCheckout(two);
    if (a1.kind !== "opened" || a2.kind !== "opened" || b1.kind !== "opened") {
      throw new Error("setup sessions");
    }
    const revoked = await asGuest(world.db, A.id, (trx, ctx) =>
      revokeGuestSessions(trx, ctx, { bookingId: one.bookingId, purpose: "booking_manage" }),
    );
    expect(revoked).toBe(2);
    const live = async (token: string) =>
      (await asGuest(world.db, A.id, (trx) => manageSession(trx, A.id, token)))?.bookingId ?? null;
    expect(await live(a1.session.token)).toBeNull();
    expect(await live(a2.session.token)).toBeNull();
    expect(await live(b1.session.token)).toBe(two.bookingId);
    // Another tenant's revocation reaches nothing here.
    expect(
      await asGuest(world.db, B.id, (trx, ctx) =>
        revokeGuestSessions(trx, ctx, { bookingId: two.bookingId, purpose: "booking_manage" }),
      ),
    ).toBe(0);
    expect(await live(b1.session.token)).toBe(two.bookingId);
  });

  it("revokes only booking-level links when told null, and every participant's when told nothing", async () => {
    const b = await book(world, A, tripsA.shared(), 2);
    const named = await asGuest(world.db, A.id, (trx, ctx) =>
      putParticipant(trx, ctx, {
        bookingId: b.bookingId,
        position: 1,
        details: { name: "Synthetic Holder", isMinor: false },
      }),
    );
    if (named.kind !== "created") throw new Error("setup participant");
    const bookingLevel = await asSystem(world.db, A.id, (trx, ctx) =>
      issueAccessLink(trx, ctx, {
        bookingId: b.bookingId,
        purpose: "booking_manage",
        ttlSeconds: 600,
      }),
    );
    const personal = await asSystem(world.db, A.id, (trx, ctx) =>
      issueAccessLink(trx, ctx, {
        bookingId: b.bookingId,
        participantId: named.participant.id,
        purpose: "booking_manage",
        ttlSeconds: 600,
      }),
    );
    // Issuing the participant's link replaced none of the booking-level ones.
    expect(personal.superseded).toBe(0);
    expect(
      await asSystem(world.db, A.id, (trx, ctx) =>
        revokeAccessLinks(trx, ctx, {
          bookingId: b.bookingId,
          purpose: "booking_manage",
          participantId: null,
          reason: "withdrawn",
        }),
      ),
    ).toBe(1);
    expect((await linkRow(bookingLevel.token))?.revoked_reason).toBe("withdrawn");
    expect((await linkRow(personal.token))?.revoked_reason).toBeNull();
    expect(
      await asSystem(world.db, A.id, (trx, ctx) =>
        revokeAccessLinks(trx, ctx, {
          bookingId: b.bookingId,
          purpose: "booking_manage",
          reason: "booking_canceled",
        }),
      ),
    ).toBe(1);
    expect(await redeem(world, A.id, personal.token)).toEqual({ kind: "revoked" });
  });

  it("sends at most three renewal emails per booking an hour, even at once, and only to the booker", async () => {
    const booker = syntheticBooker("renewer");
    const { b, token } = await bookedWithLink(A, tripsA, 2, booker);
    // A participant with an address of their own never receives the booking's link.
    await asGuest(world.db, A.id, (trx, ctx) =>
      putParticipant(trx, ctx, {
        bookingId: b.bookingId,
        position: 1,
        details: { name: "Synthetic Rider", isMinor: false, email: "rider.own@example.test" },
      }),
    );
    expect((await redeem(world, A.id, token)).kind).toBe("opened");
    const go = gate();
    const racing = Array.from({ length: 6 }, (_, i) =>
      startAt(
        go.opened,
        () =>
          asGuest(world.db, A.id, (trx, ctx) =>
            renewManageLink(trx, ctx, { token, requestKey: `adv-renew-${i}-${randomUUID()}` }),
          ),
        i % 2,
      ),
    );
    go.open();
    const kinds: string[] = [];
    for (const r of await Promise.all(racing)) {
      if (!r.ok) throw new Error(`${r.code} ${r.message}`);
      kinds.push(r.value.kind);
    }
    expect(kinds.filter((k) => k === "enqueued")).toHaveLength(3);
    expect(kinds.filter((k) => k === "rate_limited")).toHaveLength(3);
    // The session's own "email me a link" shares the same budget.
    expect(
      (
        await asGuest(world.db, A.id, (trx, ctx) =>
          requestManageLink(trx, ctx, {
            bookingId: b.bookingId,
            requestKey: `adv-${randomUUID()}`,
          }),
        )
      ).kind,
    ).toBe("rate_limited");
    const links = (await messagesOf(world.admin, b.bookingId)).filter(
      (m) => m.template === "booking_manage_link",
    );
    expect(links).toHaveLength(3);
    expect(links.every((m) => m.to_email === booker.email)).toBe(true);
    const [anywhere] = await world.admin<{ n: number }[]>`
      select count(*)::int as n from public.email_messages where to_email = 'rider.own@example.test'`;
    expect(anywhere?.n).toBe(0);
  });

  it("renews nothing for another tenant's token, a session token, or a malformed one", async () => {
    const { b, token } = await bookedWithLink(A, tripsA);
    const opened = await asGuest(world.db, A.id, (trx, ctx) =>
      openManageSessionFromCheckout(trx, ctx, {
        checkoutSessionId: b.checkoutSessionId,
        secret: b.secret,
      }),
    );
    if (opened.kind !== "opened") throw new Error("setup session");
    const count = async () => {
      const [row] = await world.admin<{ n: number }[]>`
        select count(*)::int as n from public.email_messages
         where tenant_id in (${A.id}, ${B.id}) and template = 'booking_manage_link'`;
      return row?.n ?? 0;
    };
    const before = await count();
    for (const [tenant, candidate] of [
      [B, token],
      [A, opened.session.token],
      [A, "x".repeat(43)],
      [A, `${token.slice(0, 42)}=`],
      [A, ""],
    ] as const) {
      expect(
        await asGuest(world.db, tenant.id, (trx, ctx) =>
          renewManageLink(trx, ctx, { token: candidate, requestKey: `adv-${randomUUID()}` }),
        ),
      ).toEqual({ kind: "not_found" });
    }
    expect(await count()).toBe(before);
    // A session token is not a link, and a link is not a session.
    expect((await redeem(world, A.id, opened.session.token)).kind).toBe("invalid");
    expect(await asGuest(world.db, A.id, (trx) => manageSession(trx, A.id, token))).toBeNull();
  });

  it("never stores a raw link or session token, in any table it writes", async () => {
    const { messageId, token } = await bookedWithLink(A, tripsA);
    const opened = await redeem(world, A.id, token);
    if (opened.kind !== "opened") throw new Error("setup redeem");
    const session = opened.session.token;
    const [hits] = await world.admin<{ n: number }[]>`
      select (
        (select count(*) from public.email_messages
          where position(${token} in html_body || text_body) > 0
             or position(${session} in html_body || text_body) > 0)
        + (select count(*) from public.guest_access_links
            where token_hash in (${token}, ${session}, ${sha256(token)}, ${sha256(session)}))
        + (select count(*) from public.guest_sessions
            where token_hash in (${token}, ${session}, ${sha256(token)}, ${sha256(session)}))
        + (select count(*) from public.audit_events
            where position(${token} in coalesce(before_state::text, '') || coalesce(after_state::text, '')
                                       || coalesce(reason, '')) > 0
               or position(${session} in coalesce(before_state::text, '') || coalesce(after_state::text, '')
                                         || coalesce(reason, '')) > 0)
        + (select count(*) from public.outbox_events
            where position(${token} in payload::text) > 0 or position(${session} in payload::text) > 0)
        + (select count(*) from public.idempotency_keys
            where position(${token} in coalesce(response_body::text, '')) > 0
               or position(${session} in coalesce(response_body::text, '')) > 0)
      )::int as n`;
    expect(hits?.n).toBe(0);
    // What is stored is a 64-character hash, distinct for links and sessions.
    const [stored] = await world.admin<{ link: string; session: string }[]>`
      select (select token_hash from public.guest_access_links
               where message_id = ${messageId}) as link,
             (select token_hash from public.guest_sessions where id = ${opened.session.sessionId}) as session`;
    expect(stored?.link).toMatch(/^[0-9a-f]{64}$/);
    expect(stored?.session).toMatch(/^[0-9a-f]{64}$/);
    expect(stored?.link).not.toBe(stored?.session);
  });

  it("fails a link email whose site is another tenant's, unverified, or not https, and issues no link", async () => {
    const otherHost = `${A.slug}.book.localhost`;
    const pendingHost = `${C.slug}.pending.localhost`;
    await world.admin`insert into public.tenant_hostnames (hostname, tenant_id, kind, status)
      values (${pendingHost}, ${C.id}, 'custom', 'pending')`;
    const exampleHost = `${C.slug}.book.example.test`;
    await world.admin`insert into public.tenant_hostnames (hostname, tenant_id, kind, status, verified_at)
      values (${exampleHost}, ${C.id}, 'custom', 'active', now())`;
    const origins = [
      `http://${otherHost}:5301`,
      "http://{slug}.pending.localhost:5301",
      "http://{slug}.book.example.test",
      "http://{slug}.book.localhost:5301/elsewhere",
    ];
    for (const origin of origins) {
      const b = await book(world, C, tripsC.shared(), 1);
      const [confirmation] = await messagesOf(world.admin, b.bookingId);
      if (!confirmation) throw new Error("setup: no confirmation");
      const run = await deliverMail(world, C.id, world.mail, { guestLinkOrigin: origin });
      expect(
        run.items.find((i) => i.messageId === confirmation.id),
        `origin ${origin}`,
      ).toMatchObject({ outcome: "failed", code: "link_host_unmapped" });
      const [links] = await world.admin<{ n: number }[]>`
        select count(*)::int as n from public.guest_access_links where booking_id = ${b.bookingId}`;
      expect(links?.n, `origin ${origin}`).toBe(0);
      expect(await acceptedFor(world.admin, confirmation.id)).toBeNull();
    }
    // The tenant's own verified https-equivalent site works.
    const ok = await book(world, C, tripsC.shared(), 1);
    await deliverMail(world, C.id);
    const [sent] = await messagesOf(world.admin, ok.bookingId);
    expect(sent?.state).toBe("sent");
  });

  it("does not deliver an enqueued link whose transaction rolled back, and sends a retried one once", async () => {
    const b = await book(world, A, tripsA.shared(), 1);
    const flaky = syntheticBooker("flaky");
    const key = `adv.link:${b.bookingId}`;
    await expect(
      asGuest(world.db, A.id, async (trx, ctx) => {
        await enqueueMessage(trx, ctx, {
          dedupeKey: key,
          template: "adv_link",
          templateVersion: 1,
          to: { email: flaky.email },
          bookingId: b.bookingId,
          content: {
            subject: "Synthetic link",
            blocks: [{ kind: "action", label: "Open", href: "access_link" }],
          },
          accessLink: { purpose: "booking_manage", path: "/manage", ttlSeconds: 600 },
        });
        throw new Error("the change failed");
      }),
    ).rejects.toThrow("the change failed");
    const [gone] = await world.admin<{ n: number }[]>`
      select count(*)::int as n from public.email_messages where dedupe_key = ${key}`;
    expect(gone?.n).toBe(0);
    // A temporary failure first: the token issued for the refused attempt is never delivered.
    const enqueued = await asGuest(world.db, A.id, (trx, ctx) =>
      enqueueMessage(trx, ctx, {
        dedupeKey: key,
        template: "adv_link",
        templateVersion: 1,
        to: { email: "synthetic.flaky+fail-once@example.test" },
        bookingId: b.bookingId,
        content: {
          subject: "Synthetic link",
          blocks: [{ kind: "action", label: "Open", href: "access_link" }],
        },
        accessLink: { purpose: "booking_manage", path: "/manage", ttlSeconds: 600 },
      }),
    );
    const unavailable: EmailProvider = {
      name: "fake",
      send: async () => {
        throw new EmailProviderUnavailableError();
      },
    };
    await deliverMail(world, A.id, unavailable);
    expect(await messageOf(world.admin, enqueued.messageId)).toMatchObject({
      state: "queued",
      attempts: 1,
      last_error_code: "provider_unavailable",
    });
    await makeDue(world.admin, enqueued.messageId);
    await deliverMail(world, A.id); // +fail-once: the fake refuses this attempt once
    await makeDue(world.admin, enqueued.messageId);
    await deliverMail(world, A.id);
    expect(await messageOf(world.admin, enqueued.messageId)).toMatchObject({
      state: "sent",
      attempts: 3,
    });
    expect((await acceptedFor(world.admin, enqueued.messageId))?.count).toBe(1);
    const delivered = await deliveredToken(world.admin, enqueued.messageId);
    expect((await redeem(world, A.id, delivered)).kind).toBe("opened");
  });
});
