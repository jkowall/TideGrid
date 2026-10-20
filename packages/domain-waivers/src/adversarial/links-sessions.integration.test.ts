/**
 * G2.15 adversarial: waiver links and signing sessions, against the waiver
 * contract ("Links and sessions" and its table of what ends access) and the
 * database rule that a signing session exists only beside the consumption of
 * its own waiver link in the same transaction.
 *
 * - A link opens one session, once, at its own operator, for its own purpose,
 *   and nothing after a resend replaced it, the waiver was signed, the address
 *   was corrected, the participant changed, the booking was canceled, a new
 *   version superseded it, or it expired.
 * - Concurrent redemptions of one token open exactly one session.
 * - A redemption racing a corrected address leaves no open session.
 * - A forged session row is refused for the owner and for tidegrid_app.
 */
import { randomUUID } from "node:crypto";
import { inTenantTransaction } from "@tidegrid/database";
import type {} from "@tidegrid/database/global-setup";
import { type BookingHooks, putParticipant } from "@tidegrid/domain-booking";
import { hashLinkToken, issueAccessLink, redeemAccessLink } from "@tidegrid/domain-messaging";
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";
import {
  createWaiverHooks,
  defaultWaiverDeps,
  loadWaiverSession,
  publishWaiverTemplateVersion,
  reassignUnsignedRequests,
  redeemWaiverToken,
  sendWaiverRequest,
  type WaiverDeps,
} from "../index.ts";
import {
  adult,
  createWaiverFixture,
  FIXTURE_TEXT,
  fixtureDeps,
  fixtureHooks,
  linkFor,
  minor,
  type WaiverFixture,
} from "../test-fixtures.ts";
import {
  ageDeliveries,
  asApp,
  barrier,
  book,
  closeWorld,
  guestCtx,
  liveRequest,
  name,
  openWorld,
  Rollback,
  redeem,
  refusal,
  type Sql,
  settle,
  sign,
  systemCtx,
  trips,
  uniqueEmail,
  type World,
} from "./harness.ts";

const env = inject("integrationDb");
const ROUNDS = 3;
const CONTENDERS = 8;

describe.skipIf(!env)("G2.15 adversarial: links and sessions", () => {
  let world: World;
  let A: WaiverFixture;
  let B: WaiverFixture;
  let nextTrip: () => string;
  let deps: WaiverDeps;
  let hooks: BookingHooks;

  beforeAll(async () => {
    if (!env) return;
    world = openWorld(env, 16);
    deps = fixtureDeps();
    hooks = fixtureHooks();
    A = await createWaiverFixture(world.admin, world.db, "wvl-a", { days: 10 });
    B = await createWaiverFixture(world.admin, world.db, "wvl-b", { days: 2 });
    nextTrip = trips(A);
  });

  afterAll(async () => {
    await closeWorld(world);
  });

  const loads = async (tenantId: string, secret: string) =>
    (await inTenantTransaction(world.db, guestCtx(tenantId), (trx) =>
      loadWaiverSession(trx, tenantId, secret),
    )) !== null;

  async function linkRow(token: string) {
    const [row] = await world.admin<
      { id: string; consumed: boolean; revoked_reason: string | null; subject_ref: string }[]
    >`select id, consumed_at is not null as consumed, revoked_reason, subject_ref
        from public.guest_access_links where token_hash = ${await hashLinkToken(token)}`;
    if (!row) throw new Error("no such link");
    return row;
  }

  async function sessionsOf(requestId: string) {
    return world.admin<{ id: string; revoked_reason: string | null; open: boolean }[]>`
      select id, revoked_reason, (revoked_at is null and expires_at > now()) as open
        from public.waiver_signing_sessions where request_id = ${requestId}
       order by created_at, id`;
  }

  async function staffResend(tenantId: string, requestId: string) {
    const ctx = systemCtx(tenantId, "staff-resend");
    return inTenantTransaction(world.db, ctx, (trx) =>
      sendWaiverRequest(trx, ctx, deps, { requestId, kind: "resend", reason: "Guest asked" }),
    );
  }

  it("opens one session per link, once, and nothing once a link was replaced, completed, corrected, withdrawn, or expired", async () => {
    const booked = await book(world, A, nextTrip(), 8, hooks);
    const people = [
      adult("Una Replay"),
      adult("Rhea Resent"),
      adult("Kai Kept"),
      adult("Sig Done"),
      adult("Cora Corrected", uniqueEmail("cora.old")),
      adult("Eve Expired"),
      adult("Fay Flipped"),
      adult("Fin Flipped"),
    ];
    const ids: string[] = [];
    for (const [i, p] of people.entries()) {
      ids.push(await name(world, A.id, booked.bookingId, i + 1, p, hooks));
    }
    const req: string[] = [];
    for (const id of ids) req.push((await liveRequest(world.admin, booked.bookingId, id)).id);
    const first = async (i: number) =>
      (await linkFor(world.admin, world.db, A.id, req[i] ?? "")).token;
    const [una, rhea, kai, sig, cora, eve, fay, fin] = [0, 1, 2, 3, 4, 5, 6, 7];

    // Another operator, then its own: the link is invalid there and untouched.
    const unaToken = await first(una);
    expect((await redeem(world, B.id, unaToken)).kind).toBe("invalid");
    expect((await linkRow(unaToken)).consumed).toBe(false);
    const unaOpened = await redeem(world, A.id, unaToken);
    expect(unaOpened.kind).toBe("opened");
    if (unaOpened.kind !== "opened") return;
    expect(await loads(B.id, unaOpened.secret)).toBe(false);
    // A replay opens nothing more.
    expect((await redeem(world, A.id, unaToken)).kind).toBe("used");
    expect(await sessionsOf(req[una] ?? "")).toHaveLength(1);

    // A resend replaces the unused link once its email goes out.
    const rheaFirst = await first(rhea);
    await ageDeliveries(world.admin, req[rhea] ?? "");
    expect(await staffResend(A.id, req[rhea] ?? "")).toMatchObject({ kind: "sent", generation: 2 });
    const rheaSecond = await first(rhea);
    expect((await redeem(world, A.id, rheaFirst)).kind).toBe("replaced");
    expect((await linkRow(rheaFirst)).revoked_reason).toBe("superseded");
    expect((await redeem(world, A.id, rheaSecond)).kind).toBe("opened");
    expect(await sessionsOf(req[rhea] ?? "")).toHaveLength(1);

    // A resend to the same address leaves an open session open.
    const kaiOpened = await redeem(world, A.id, await first(kai));
    if (kaiOpened.kind !== "opened") throw new Error("kai did not open");
    await ageDeliveries(world.admin, req[kai] ?? "");
    expect(await staffResend(A.id, req[kai] ?? "")).toMatchObject({ kind: "sent" });
    await first(kai);
    expect(await loads(A.id, kaiOpened.secret)).toBe(true);

    // Signing closes every other link to the waiver; the signer's session stays.
    const sigOpened = await redeem(world, A.id, await first(sig));
    if (sigOpened.kind !== "opened") throw new Error("sig did not open");
    await ageDeliveries(world.admin, req[sig] ?? "");
    expect(await staffResend(A.id, req[sig] ?? "")).toMatchObject({ kind: "sent" });
    const sigSecond = await first(sig);
    expect((await sign(world, A.id, deps, sigOpened.session)).kind).toBe("signed");
    expect(await redeem(world, A.id, sigSecond)).toEqual({ kind: "closed", state: "signed" });
    expect((await linkRow(sigSecond)).revoked_reason).toBe("completed");
    expect(await loads(A.id, sigOpened.secret)).toBe(true);

    // A corrected address ends the old address's links and sessions at once.
    const coraOpened = await redeem(world, A.id, await first(cora));
    if (coraOpened.kind !== "opened") throw new Error("cora did not open");
    await ageDeliveries(world.admin, req[cora] ?? "");
    expect(await staffResend(A.id, req[cora] ?? "")).toMatchObject({ kind: "sent" });
    const coraUnused = await first(cora);
    const coraNew = uniqueEmail("cora.new");
    await name(world, A.id, booked.bookingId, cora + 1, adult("Cora Corrected", coraNew), hooks);
    expect((await redeem(world, A.id, coraUnused)).kind).toBe("replaced");
    expect((await linkRow(coraUnused)).revoked_reason).toBe("recipient_changed");
    expect(await loads(A.id, coraOpened.secret)).toBe(false);
    expect((await sessionsOf(req[cora] ?? "")).map((s) => s.revoked_reason)).toEqual([
      "recipient_changed",
    ]);
    const coraMail = await linkFor(world.admin, world.db, A.id, req[cora] ?? "");
    expect(coraMail.to).toBe(coraNew);
    expect((await redeem(world, A.id, coraMail.token)).kind).toBe("opened");

    // Expiry moves only earlier, for the owner too; an expired link opens nothing.
    const eveToken = await first(eve);
    const eveHash = await hashLinkToken(eveToken);
    await world.admin`update public.guest_access_links set expires_at = now()
                          where token_hash = ${eveHash}`;
    expect(
      await refusal(
        world.admin`update public.guest_access_links set expires_at = now() + interval '1 day'
                        where token_hash = ${eveHash}`,
      ),
    ).toBe("23514:guest_access_links_immutable");
    expect((await redeem(world, A.id, eveToken)).kind).toBe("expired");
    expect(await sessionsOf(req[eve] ?? "")).toEqual([]);

    // A participant who turns out to be a minor: the open session and the unused link end.
    const fayOpened = await redeem(world, A.id, await first(fay));
    if (fayOpened.kind !== "opened") throw new Error("fay did not open");
    const finToken = await first(fin);
    const guardian = { name: "Gwyn Guard", email: uniqueEmail("gwyn") };
    await name(world, A.id, booked.bookingId, fay + 1, minor("Fay Flipped", guardian), hooks);
    await name(world, A.id, booked.bookingId, fin + 1, minor("Fin Flipped", guardian), hooks);
    expect(await loads(A.id, fayOpened.secret)).toBe(false);
    expect((await sessionsOf(req[fay] ?? "")).map((s) => s.revoked_reason)).toEqual([
      "participant_changed",
    ]);
    expect(await redeem(world, A.id, finToken)).toEqual({ kind: "closed", state: "revoked" });
    expect((await linkRow(finToken)).revoked_reason).toBe("withdrawn");

    // Another purpose's link is invalid for waivers, and stays unused for its own purpose.
    const ctx = systemCtx(A.id, "manage-link");
    const manage = await inTenantTransaction(world.db, ctx, (trx) =>
      issueAccessLink(trx, ctx, {
        bookingId: booked.bookingId,
        purpose: "booking_manage",
        ttlSeconds: 3600,
      }),
    );
    expect((await redeem(world, A.id, manage.token)).kind).toBe("invalid");
    expect((await linkRow(manage.token)).consumed).toBe(false);
  }, 300_000);

  it("ends links and sessions when the booking is canceled or a new version supersedes the request", async () => {
    // Canceled: the booking module runs bookingCanceled in its cancellation.
    const canceled = await book(world, A, nextTrip(), 2, hooks);
    const openId = await name(world, A.id, canceled.bookingId, 1, adult("Cy Canceled"), hooks);
    const unusedId = await name(world, A.id, canceled.bookingId, 2, adult("Dee Unused"), hooks);
    const openReq = (await liveRequest(world.admin, canceled.bookingId, openId)).id;
    const unusedReq = (await liveRequest(world.admin, canceled.bookingId, unusedId)).id;
    const opened = await redeem(
      world,
      A.id,
      (await linkFor(world.admin, world.db, A.id, openReq)).token,
    );
    if (opened.kind !== "opened") throw new Error("did not open");
    const unused = (await linkFor(world.admin, world.db, A.id, unusedReq)).token;
    const ctx = systemCtx(A.id, "cancellation");
    await inTenantTransaction(
      world.db,
      ctx,
      (trx) =>
        createWaiverHooks(defaultWaiverDeps).bookingCanceled?.(trx, ctx, {
          bookingId: canceled.bookingId,
          cancellationId: randomUUID(),
          refundId: null,
        }) ?? Promise.resolve(),
    );
    expect(await loads(A.id, opened.secret)).toBe(false);
    expect(await redeem(world, A.id, unused)).toEqual({ kind: "closed", state: "revoked" });
    expect((await linkRow(unused)).revoked_reason).toBe("booking_canceled");
    expect((await sign(world, A.id, deps, opened.session)).kind).toBe("not_pending");
    expect((await sessionsOf(openReq)).map((s) => [s.revoked_reason, s.open])).toEqual([
      ["booking_canceled", false],
    ]);

    // Superseded: a version published with reassignUnsigned, on a tenant of its own.
    const t = await createWaiverFixture(world.admin, world.db, "wvl-ver", { days: 2 });
    const booked = await book(world, t, t.trips.shared[0] ?? "", 2, hooks);
    const sessId = await name(world, t.id, booked.bookingId, 1, adult("Sue Superseded"), hooks);
    const linkId = await name(world, t.id, booked.bookingId, 2, adult("Lin Superseded"), hooks);
    const sessReq = (await liveRequest(world.admin, booked.bookingId, sessId)).id;
    const linkReq = (await liveRequest(world.admin, booked.bookingId, linkId)).id;
    const sOpened = await redeem(
      world,
      t.id,
      (await linkFor(world.admin, world.db, t.id, sessReq)).token,
    );
    if (sOpened.kind !== "opened") throw new Error("did not open");
    const sUnused = (await linkFor(world.admin, world.db, t.id, linkReq)).token;
    const owner = systemCtx(t.id, "owner");
    const published = await inTenantTransaction(world.db, owner, (trx) =>
      publishWaiverTemplateVersion(trx, owner, {
        templateId: t.templateId,
        text: { ...FIXTURE_TEXT, title: "Fixture participation waiver, revised" },
        reason: "Synthetic revision",
      }),
    );
    expect(published).toMatchObject({ kind: "published", version: 2 });
    expect(
      await reassignUnsignedRequests(world.db, owner, deps, {
        templateId: t.templateId,
        version: 2,
      }),
    ).toEqual({ kind: "reassigned", moved: 2 });
    expect(await loads(t.id, sOpened.secret)).toBe(false);
    expect(await redeem(world, t.id, sUnused)).toEqual({ kind: "closed", state: "superseded" });
    expect((await linkRow(sUnused)).revoked_reason).toBe("withdrawn");
    expect(await sign(world, t.id, deps, sOpened.session)).toEqual({
      kind: "not_pending",
      state: "superseded",
    });
    // The replacement goes out at once, and its link opens version 2.
    const replacement = await liveRequest(world.admin, booked.bookingId, sessId);
    expect(replacement.v).toBe(2);
    expect(
      (
        await redeem(
          world,
          t.id,
          (
            await linkFor(world.admin, world.db, t.id, replacement.id)
          ).token,
        )
      ).kind,
    ).toBe("opened");
  }, 300_000);

  it("opens exactly one session when many redemptions of one token race", async () => {
    const booked = await book(world, A, nextTrip(), ROUNDS, hooks);
    for (let round = 0; round < ROUNDS; round++) {
      const pid = await name(
        world,
        A.id,
        booked.bookingId,
        round + 1,
        adult(`Rae Racer ${String.fromCharCode(65 + round)}`),
        hooks,
      );
      const requestId = (await liveRequest(world.admin, booked.bookingId, pid)).id;
      const { token } = await linkFor(world.admin, world.db, A.id, requestId);
      const start = barrier(CONTENDERS);
      const outcomes = await Promise.all(
        Array.from({ length: CONTENDERS }, () => {
          const ctx = guestCtx(A.id);
          return settle(
            inTenantTransaction(world.db, ctx, async (trx) => {
              await start.arrive();
              return redeemWaiverToken(trx, ctx, { token });
            }),
          );
        }),
      );
      expect(outcomes.filter((o) => !o.ok)).toEqual([]);
      const kinds = outcomes.map((o) => (o.ok ? o.value.kind : "error")).sort();
      expect(kinds).toEqual(["opened", ...Array(CONTENDERS - 1).fill("used")]);
      expect(await sessionsOf(requestId)).toHaveLength(1);
    }
  }, 240_000);

  it("leaves no open session when a redemption races the address being corrected", async () => {
    const booked = await book(world, A, nextTrip(), ROUNDS, hooks);
    for (let round = 0; round < ROUNDS; round++) {
      const label = `Ray Rerouted ${String.fromCharCode(65 + round)}`;
      const pid = await name(
        world,
        A.id,
        booked.bookingId,
        round + 1,
        adult(label, uniqueEmail("ray.old")),
        hooks,
      );
      const requestId = (await liveRequest(world.admin, booked.bookingId, pid)).id;
      const { token } = await linkFor(world.admin, world.db, A.id, requestId);
      const fresh = uniqueEmail("ray.new");
      const start = barrier(2);
      const gctx = guestCtx(A.id);
      const [redeemed, corrected] = await Promise.all([
        settle(
          inTenantTransaction(world.db, gctx, async (trx) => {
            await start.arrive();
            return redeemWaiverToken(trx, gctx, { token });
          }),
        ),
        settle(
          inTenantTransaction(world.db, guestCtx(A.id), async (trx) => {
            await start.arrive();
            return putParticipant(
              trx,
              guestCtx(A.id),
              { bookingId: booked.bookingId, position: round + 1, details: adult(label, fresh) },
              hooks,
            );
          }),
        ),
      ]);
      expect([redeemed.ok, corrected.ok]).toEqual([true, true]);
      if (redeemed.ok) expect(["opened", "replaced"]).toContain(redeemed.value.kind);
      if (redeemed.ok && redeemed.value.kind === "opened") {
        expect(await loads(A.id, redeemed.value.secret)).toBe(false);
      }
      expect((await sessionsOf(requestId)).filter((s) => s.open)).toEqual([]);
      // The corrected address's own email still opens the waiver.
      const mail = await linkFor(world.admin, world.db, A.id, requestId);
      expect(mail.to).toBe(fresh);
      expect((await redeem(world, A.id, mail.token)).kind).toBe("opened");
    }
  }, 240_000);

  it("refuses a signing session that was not opened by consuming its own waiver link in that transaction", async () => {
    const booked = await book(world, A, nextTrip(), 3, hooks);
    const p1 = await name(world, A.id, booked.bookingId, 1, adult("Fred Forged"), hooks);
    const p2 = await name(world, A.id, booked.bookingId, 2, adult("Gale Forged"), hooks);
    const p3 = await name(
      world,
      A.id,
      booked.bookingId,
      3,
      minor("Hal Forged", { name: "Ivy Forged", email: uniqueEmail("ivy") }),
      hooks,
    );
    const r1 = (await liveRequest(world.admin, booked.bookingId, p1)).id;
    const r2 = (await liveRequest(world.admin, booked.bookingId, p2)).id;
    const r3 = (await liveRequest(world.admin, booked.bookingId, p3)).id;
    const l1 = await linkRow((await linkFor(world.admin, world.db, A.id, r1)).token);
    const l2token = (await linkFor(world.admin, world.db, A.id, r2)).token;
    const l2 = await linkRow(l2token);
    const l3 = await linkRow((await linkFor(world.admin, world.db, A.id, r3)).token);
    const hash = (n: number) => String(n).repeat(64).slice(0, 64);

    const session = (
      tx: Sql,
      v: {
        link: string;
        request: string;
        participant: string;
        role?: string;
        ttl?: string;
        secret: string;
      },
    ) => tx`
        insert into public.waiver_signing_sessions (tenant_id, access_link_id, request_id,
          booking_id, participant_id, purpose, signer_role, secret_hash, expires_at)
        values (${A.id}, ${v.link}, ${v.request}, ${booked.bookingId}, ${v.participant}, 'sign',
                ${v.role ?? "participant"}, ${v.secret},
                now() + ${v.ttl ?? "30 minutes"}::interval)`;
    const consume = (tx: Sql, linkId: string) => tx`
        update public.guest_access_links set consumed_at = now() where id = ${linkId}`;

    // The owner cannot open a session for an unused link without consuming it.
    expect(
      await refusal(
        session(world.admin, { link: l1.id, request: r1, participant: p1, secret: hash(1) }),
      ),
    ).toBe("23514:waiver_signing_sessions_link");
    // Nor can the runtime.
    expect(
      await refusal(
        asApp(world, A.id, (tx) =>
          session(tx, { link: l1.id, request: r1, participant: p1, secret: hash(2) }),
        ),
      ),
    ).toBe("23514:waiver_signing_sessions_link");
    // A link consumed in an earlier transaction opens nothing later, for either role.
    await inTenantTransaction(world.db, guestCtx(A.id), (trx) =>
      redeemAccessLink(trx, guestCtx(A.id), { token: l2token, purpose: "waiver_sign" }),
    );
    expect(
      await refusal(
        session(world.admin, { link: l2.id, request: r2, participant: p2, secret: hash(3) }),
      ),
    ).toBe("23514:waiver_signing_sessions_link");
    expect(
      await refusal(
        asApp(world, A.id, (tx) =>
          session(tx, { link: l2.id, request: r2, participant: p2, secret: hash(4) }),
        ),
      ),
    ).toBe("23514:waiver_signing_sessions_link");
    // Consuming one participant's link opens nothing for another participant's request,
    const crossed = await refusal(
      asApp(world, A.id, async (tx) => {
        await consume(tx, l1.id);
        await session(tx, { link: l1.id, request: r2, participant: p2, secret: hash(5) });
      }),
    );
    expect(crossed).toBe("23514:waiver_signing_sessions_link");
    // nor for a signer the request does not require,
    expect(
      await refusal(
        asApp(world, A.id, async (tx) => {
          await consume(tx, l3.id);
          await session(tx, {
            link: l3.id,
            request: r3,
            participant: p3,
            role: "participant",
            secret: hash(6),
          });
        }),
      ),
    ).toBe("23514:waiver_signing_sessions_link");
    // nor for longer than two hours.
    expect(
      await refusal(
        asApp(world, A.id, async (tx) => {
          await consume(tx, l1.id);
          await session(tx, {
            link: l1.id,
            request: r1,
            participant: p1,
            ttl: "3 hours",
            secret: hash(7),
          });
        }),
      ),
    ).toBe("23514:waiver_signing_sessions_lifetime");
    // The same statements with every field right do open one: the refusals above are the rule.
    const control = await settle(
      asApp(world, A.id, async (tx) => {
        await consume(tx, l1.id);
        await session(tx, { link: l1.id, request: r1, participant: p1, secret: hash(8) });
        throw new Rollback();
      }),
    );
    expect(control.ok === false && control.message).toBe("rolled back on purpose");
    expect(await sessionsOf(r1)).toEqual([]);
    expect(await sessionsOf(r2)).toEqual([]);
    expect(await sessionsOf(r3)).toEqual([]);

    // A real session (the untouched first link still opens one) is revoked once and
    // never comes back; its expiry never moves.
    const reopened = await redeem(
      world,
      A.id,
      (await linkFor(world.admin, world.db, A.id, r1)).token,
    );
    if (reopened.kind !== "opened") throw new Error(`reopen: ${JSON.stringify(reopened)}`);
    const sid = reopened.session.id;
    await asApp(
      world,
      A.id,
      (tx) => tx`
        update public.waiver_signing_sessions set revoked_at = now(), revoked_reason = 'superseded'
         where id = ${sid}`,
    );
    expect(
      await refusal(
        asApp(
          world,
          A.id,
          (tx) => tx`
            update public.waiver_signing_sessions set revoked_at = null, revoked_reason = null
             where id = ${sid}`,
        ),
      ),
    ).toBe("23514:waiver_signing_sessions_transition");
    expect(
      await refusal(
        world.admin`update public.waiver_signing_sessions
                         set expires_at = expires_at + interval '1 hour' where id = ${sid}`,
      ),
    ).toBe("23514:waiver_signing_sessions_immutable");
    expect(await loads(A.id, reopened.secret)).toBe(false);
  }, 240_000);
});
