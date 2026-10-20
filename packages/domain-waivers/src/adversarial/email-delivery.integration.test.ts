/**
 * G2.15 adversarial: the email side of waivers, against the waiver contract
 * ("Email and links": resend limits, no duplicates, delivery is not
 * signature) and the architecture's rules that workers recheck cancellation,
 * participant membership, current assignment, recipient, and completed
 * evidence before sending, and that recipient correction revokes old access
 * (docs/v2/04-architecture.md, Waivers).
 *
 * - A failed email shows email_failed while the request stays pending.
 * - A late email failure after signing never changes the signature.
 * - The resend limits hold at the database for a direct insert, for the owner
 *   and for tidegrid_app: 5 generations, 10 minutes to the same address, and
 *   a corrected address at once.
 * - An email that is in flight when its request is corrected or signed, and
 *   that the provider defers, is retried later by the messaging module's
 *   delivery job. These tests hold the provider's answer open with a wrapper
 *   around the fake provider, then let the real job retry.
 */
import { randomUUID } from "node:crypto";
import { inTenantTransaction } from "@tidegrid/database";
import type {} from "@tidegrid/database/global-setup";
import type { BookingHooks } from "@tidegrid/domain-booking";
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";
import { listBookingWaivers, sendWaiverRequest, type WaiverDeps } from "../index.ts";
import {
  adult,
  createWaiverFixture,
  deliverMail,
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
  deliverWith,
  fakeMail,
  holdingProvider,
  liveRequest,
  messageOf,
  name,
  openWorld,
  Rollback,
  redeem,
  type Sql,
  settle,
  sign,
  systemCtx,
  tokenOfMessage,
  trips,
  uniqueEmail,
  type World,
  within,
} from "./harness.ts";

const env = inject("integrationDb");

describe.skipIf(!env)("G2.15 adversarial: email and delivery", () => {
  let world: World;
  let A: WaiverFixture;
  let nextTrip: () => string;
  let deps: WaiverDeps;
  let hooks: BookingHooks;

  beforeAll(async () => {
    if (!env) return;
    world = openWorld(env, 12);
    deps = fixtureDeps();
    hooks = fixtureHooks();
    A = await createWaiverFixture(world.admin, world.db, "wve", { days: 10 });
    nextTrip = trips(A);
  });

  afterAll(async () => {
    await closeWorld(world);
  });

  async function status(bookingId: string) {
    const found = await inTenantTransaction(world.db, systemCtx(A.id), (trx) =>
      listBookingWaivers(trx, A.id, bookingId),
    );
    const [p] = found?.participants ?? [];
    if (!p) throw new Error("no participant status");
    return p;
  }

  async function requestRow(requestId: string) {
    const [row] = await world.admin<
      { state: string; signed_at: Date | null; updated_at: Date; generations: number }[]
    >`select r.state, r.signed_at, r.updated_at,
             (select count(*)::int from public.waiver_deliveries d where d.request_id = r.id)
               as generations
        from public.waiver_requests r where r.id = ${requestId}`;
    if (!row) throw new Error("no request");
    return row;
  }

  /** Live (unused, unrevoked, unexpired) waiver links of a request. */
  async function liveLinks(requestId: string) {
    const [row] = await world.admin<{ n: number }[]>`
      select count(*)::int as n from public.guest_access_links
       where subject_ref = ${`waiver_request:${requestId}`}
         and consumed_at is null and revoked_at is null and expires_at > now()`;
    return row?.n ?? -1;
  }

  async function staffResend(requestId: string) {
    const ctx = systemCtx(A.id, "staff-resend");
    return inTenantTransaction(world.db, ctx, (trx) =>
      sendWaiverRequest(trx, ctx, deps, { requestId, kind: "resend", reason: "Guest asked" }),
    );
  }

  it("shows a failed email as email_failed while the request stays pending, and a correction sends at once", async () => {
    const booked = await book(world, A, nextTrip(), 1, hooks);
    const bounce = `bo.${randomUUID().slice(0, 8)}+bounce@example.test`;
    const pid = await name(world, A.id, booked.bookingId, 1, adult("Bo Bounce", bounce), hooks);
    const request = await liveRequest(world.admin, booked.bookingId, pid);
    const before = await requestRow(request.id);
    await deliverMail(world.db, A.id);
    expect((await messageOf(world.admin, request.id, 1)).state).toBe("failed");
    const failed = await status(booked.bookingId);
    expect(failed.status).toBe("email_failed");
    expect(failed.request).toMatchObject({
      state: "pending",
      delivery: { generation: 1, message: { state: "failed", failureCode: "bounced" } },
    });
    expect(failed.request?.resendAvailableAt).not.toBeNull();
    // Delivery never touched the request itself.
    expect(await requestRow(request.id)).toEqual(before);

    const fixed = uniqueEmail("bo.fixed");
    await name(world, A.id, booked.bookingId, 1, adult("Bo Bounce", fixed), hooks);
    const corrected = await status(booked.bookingId);
    expect(corrected.status).toBe("waiting");
    expect(corrected.request?.delivery?.generation).toBe(2);
    expect((await linkFor(world.admin, world.db, A.id, request.id)).to).toBe(fixed);
    expect((await requestRow(request.id)).state).toBe("pending");
  }, 180_000);

  it("keeps a waiver signed when an email that was in flight at signing fails afterwards", async () => {
    const booked = await book(world, A, nextTrip(), 1, hooks);
    const pid = await name(world, A.id, booked.bookingId, 1, adult("Lee Late"), hooks);
    const request = await liveRequest(world.admin, booked.bookingId, pid);
    const opened = await redeem(
      world,
      A.id,
      (await linkFor(world.admin, world.db, A.id, request.id)).token,
    );
    if (opened.kind !== "opened") throw new Error("did not open");
    await ageDeliveries(world.admin, request.id);
    expect(await staffResend(request.id)).toMatchObject({ kind: "sent", generation: 2 });
    const second = await messageOf(world.admin, request.id, 2);
    const hold = holdingProvider(world.db, second.id);
    const run = settle(deliverWith(world.db, A.id, hold.provider));
    try {
      await within(hold.held, 60_000, "the resend reaching the provider");
      expect((await sign(world, A.id, deps, opened.session)).kind).toBe("signed");
    } finally {
      hold.decide("rejected");
    }
    expect((await within(run, 60_000, "the delivery run")).ok).toBe(true);
    const signed = await requestRow(request.id);
    // Signing canceled the email in flight; the provider's later refusal
    // records nothing on it (the messaging module's cancelMessage contract).
    expect((await messageOf(world.admin, request.id, 2)).state).toBe("canceled");
    expect(signed.state).toBe("signed");
    expect((await status(booked.bookingId)).status).toBe("signed");
    const [evidence] = await world.admin<{ n: number }[]>`
        select count(*)::int as n from public.waiver_evidence where request_id = ${request.id}`;
    expect(evidence?.n).toBe(1);
    // Another delivery run changes nothing either.
    await deliverMail(world.db, A.id);
    expect(await requestRow(request.id)).toEqual(signed);
  }, 180_000);

  it("holds the resend limits at the database for a direct insert, for the owner and for tidegrid_app", async () => {
    const booked = await book(world, A, nextTrip(), 1, hooks);
    const addresses = Array.from({ length: 6 }, (_, i) => uniqueEmail(`rae${i + 1}`));
    const pid = await name(
      world,
      A.id,
      booked.bookingId,
      1,
      adult("Rae Rate", addresses[0]),
      hooks,
    );
    const r = (await liveRequest(world.admin, booked.bookingId, pid)).id;
    const message = (tx: Sql, generation: number, to: string) => tx<{ id: string }[]>`
        insert into public.email_messages (tenant_id, dedupe_key, template, template_version,
          booking_id, participant_id, subject_ref, to_email, from_name, subject, html_body,
          text_body, link_purpose, link_path, link_ttl_seconds, link_slot)
        values (${A.id}, ${`waiver.request:${r}:${generation}`}, 'waiver_request', 1,
                ${booked.bookingId}, ${pid}, ${`waiver_request:${r}`}, ${to}, 'Synthetic Operator',
                'Synthetic subject', '<p>Synthetic</p>', 'Synthetic', 'waiver_sign', '/waiver', 3600,
                ${"ab".repeat(16)})
        returning id`;
    const delivery = (tx: Sql, generation: number, to: string, messageId: string) => tx`
        insert into public.waiver_deliveries (tenant_id, request_id, generation, kind,
          recipient_email, message_id, reason)
        values (${A.id}, ${r}, ${generation}, 'resend', ${to}, ${messageId}, 'Direct insert')`;
    /** "accepted" when both statements ran (then rolled back), else the refusal. */
    const attempt = async (
      run: (fn: (tx: Sql) => Promise<unknown>) => Promise<unknown>,
      generation: number,
      messageTo: string,
      deliveryTo = messageTo,
    ) => {
      const settled = await settle(
        run(async (tx) => {
          const [m] = await message(tx, generation, messageTo);
          await delivery(tx, generation, deliveryTo, m?.id ?? "");
          throw new Rollback();
        }),
      );
      if (settled.ok) return "committed";
      if (settled.message === "rolled back on purpose") return "accepted";
      return settled.constraint ? `${settled.code}:${settled.constraint}` : settled.code;
    };
    const asOwner = (fn: (tx: Sql) => Promise<unknown>) =>
      world.admin.begin((tx) => fn(tx as unknown as Sql));
    const asRuntime = (fn: (tx: Sql) => Promise<unknown>) => asApp(world, A.id, fn);
    const [a1, a2, a3, , , a6] = addresses as [string, string, string, string, string, string];

    // The same address within ten minutes: refused for both roles.
    expect(await attempt(asOwner, 2, a1)).toBe("23514:waiver_deliveries_rate");
    expect(await attempt(asRuntime, 2, a1)).toBe("23514:waiver_deliveries_rate");
    // A corrected address goes at once (each statement ran; the transaction was ours to undo).
    expect(await attempt(asOwner, 2, a2)).toBe("accepted");
    expect(await attempt(asRuntime, 2, a2)).toBe("accepted");
    // No skipped generation, and no delivery that names another address's message.
    expect(await attempt(asOwner, 3, a2)).toBe("23514:waiver_deliveries_sequence");
    expect(await attempt(asOwner, 2, a2, a3)).toBe("23514:waiver_deliveries_message");

    // Four corrections later the request has five generations, the most there are.
    for (const to of addresses.slice(1, 5)) {
      await name(world, A.id, booked.bookingId, 1, adult("Rae Rate", to), hooks);
    }
    expect((await requestRow(r)).generations).toBe(5);
    expect(await attempt(asOwner, 6, a6)).toBe("23514:waiver_deliveries_generation_check");
    expect(await attempt(asRuntime, 6, a6)).toBe("23514:waiver_deliveries_generation_check");
    await ageDeliveries(world.admin, r);
    expect(await staffResend(r)).toEqual({ kind: "limit_reached" });

    // Nothing goes to a request that is no longer pending.
    await name(
      world,
      A.id,
      booked.bookingId,
      1,
      minor("Rae Rate", { name: "Ros Rate", email: uniqueEmail("ros") }),
      hooks,
    );
    expect((await requestRow(r)).state).toBe("revoked");
    expect(await attempt(asOwner, 6, a6)).toBe("23514:waiver_deliveries_request");
  }, 180_000);

  it("gives a corrected-away address no working link, even when its email was in flight at the correction", async () => {
    const booked = await book(world, A, nextTrip(), 1, hooks);
    const old = uniqueEmail("ora.old");
    const fresh = uniqueEmail("ora.new");
    const pid = await name(world, A.id, booked.bookingId, 1, adult("Ora Inflight", old), hooks);
    const request = await liveRequest(world.admin, booked.bookingId, pid);
    const first = await messageOf(world.admin, request.id, 1);
    // The delivery job claims the first email, issues its link, commits, and calls the provider;
    const hold = holdingProvider(world.db, first.id);
    const run = settle(deliverWith(world.db, A.id, hold.provider));
    try {
      const held = await within(hold.held, 60_000, "the first email reaching the provider");
      expect(held.email.to.email).toBe(old);
      // the guest corrects the address meanwhile;
      await name(world, A.id, booked.bookingId, 1, adult("Ora Inflight", fresh), hooks);
    } finally {
      // and the provider answers that it cannot accept mail just now.
      hold.decide("unavailable");
    }
    expect((await within(run, 60_000, "the delivery run")).ok).toBe(true);
    // Time passes for the job's retry (a queued message's time may only move earlier).
    await world.admin`update public.email_messages set next_attempt_at = now()
                          where id = ${first.id} and state = 'queued'`;
    await deliverWith(world.db, A.id, fakeMail(world.db));

    const second = await messageOf(world.admin, request.id, 2);
    expect(second.to_email).toBe(fresh);
    const freshToken = await tokenOfMessage(world, A.id, second.id);
    const oldToken = await tokenOfMessage(world, A.id, first.id);
    const outcome = {
      correctedAddress: freshToken ? (await redeem(world, A.id, freshToken)).kind : "no email",
      oldAddressOpens: oldToken ? (await redeem(world, A.id, oldToken)).kind === "opened" : false,
    };
    // The corrected address opens the waiver; the old address opens nothing.
    expect(outcome).toEqual({ correctedAddress: "opened", oldAddressOpens: false });
  }, 180_000);

  it("never sends a signing link again for a waiver that was signed while its email was in flight", async () => {
    const booked = await book(world, A, nextTrip(), 1, hooks);
    const pid = await name(world, A.id, booked.bookingId, 1, adult("Sam Signed"), hooks);
    const request = await liveRequest(world.admin, booked.bookingId, pid);
    const opened = await redeem(
      world,
      A.id,
      (await linkFor(world.admin, world.db, A.id, request.id)).token,
    );
    if (opened.kind !== "opened") throw new Error("did not open");
    await ageDeliveries(world.admin, request.id);
    expect(await staffResend(request.id)).toMatchObject({ kind: "sent", generation: 2 });
    const second = await messageOf(world.admin, request.id, 2);
    const hold = holdingProvider(world.db, second.id);
    const run = settle(deliverWith(world.db, A.id, hold.provider));
    try {
      await within(hold.held, 60_000, "the resend reaching the provider");
      expect((await sign(world, A.id, deps, opened.session)).kind).toBe("signed");
    } finally {
      hold.decide("unavailable");
    }
    expect((await within(run, 60_000, "the delivery run")).ok).toBe(true);
    await world.admin`update public.email_messages set next_attempt_at = now()
                          where id = ${second.id} and state = 'queued'`;
    await deliverWith(world.db, A.id, fakeMail(world.db));
    // Signed means the waiver's links are done and no request email goes out after it.
    expect({
      liveLinks: await liveLinks(request.id),
      resentAfterSigning: (await messageOf(world.admin, request.id, 2)).state === "sent",
    }).toEqual({ liveLinks: 0, resentAfterSigning: false });
  }, 180_000);

  it("ends the old address's access when an address is corrected after the fifth generation", async () => {
    const booked = await book(world, A, nextTrip(), 1, hooks);
    const addresses = Array.from({ length: 6 }, (_, i) => uniqueEmail(`cap${i + 1}`));
    const pid = await name(
      world,
      A.id,
      booked.bookingId,
      1,
      adult("Cam Capped", addresses[0]),
      hooks,
    );
    const r = (await liveRequest(world.admin, booked.bookingId, pid)).id;
    for (const to of addresses.slice(1, 5)) {
      await name(world, A.id, booked.bookingId, 1, adult("Cam Capped", to), hooks);
    }
    const fifth = await linkFor(world.admin, world.db, A.id, r);
    expect(fifth.to).toBe(addresses[4]);
    // A sixth address: there is no sixth generation to send, but the fifth
    // address is no longer this participant's.
    await name(world, A.id, booked.bookingId, 1, adult("Cam Capped", addresses[5]), hooks);
    expect((await requestRow(r)).generations).toBe(5);
    expect((await redeem(world, A.id, fifth.token)).kind).toBe("replaced");
  }, 180_000);

  // Every change of who gets the email cancels the old message itself, with
  // the messaging module's cancelMessage, in the transaction that makes the
  // change. Revoking links alone would leave a queued email, which has no link
  // yet, to go out later with a fresh one.
  describe("every recipient change cancels the old message, queued or not", () => {
    async function messages(requestId: string) {
      return world.admin<{ generation: number; state: string; to: string; code: string | null }[]>`
        select d.generation, m.state, m.to_email as to, m.last_error_code as code
          from public.waiver_deliveries d
          join public.email_messages m on m.tenant_id = d.tenant_id and m.id = d.message_id
         where d.request_id = ${requestId} order by d.generation`;
    }

    it("a corrected guardian address", async () => {
      const booked = await book(world, A, nextTrip(), 1, hooks);
      const old = uniqueEmail("gwen.old");
      const fresh = uniqueEmail("gwen.new");
      const kid = (email: string) => minor("Kai Kid", { name: "Gwen Guardian", email });
      const pid = await name(world, A.id, booked.bookingId, 1, kid(old), hooks);
      const request = await liveRequest(world.admin, booked.bookingId, pid);
      expect((await messages(request.id)).map((m) => m.state)).toEqual(["queued"]);
      await name(world, A.id, booked.bookingId, 1, kid(fresh), hooks);
      expect(await messages(request.id)).toEqual([
        { generation: 1, state: "canceled", to: old, code: "recipient_changed" },
        { generation: 2, state: "queued", to: fresh, code: null },
      ]);
      await deliverMail(world.db, A.id);
      expect((await messages(request.id)).map((m) => [m.state, m.to])).toEqual([
        ["canceled", old],
        ["sent", fresh],
      ]);
      expect(await liveLinks(request.id)).toBe(1);
    }, 180_000);

    it("a corrected participant address", async () => {
      const booked = await book(world, A, nextTrip(), 1, hooks);
      const old = uniqueEmail("pat.old");
      const fresh = uniqueEmail("pat.new");
      const pid = await name(world, A.id, booked.bookingId, 1, adult("Pat Moved", old), hooks);
      const request = await liveRequest(world.admin, booked.bookingId, pid);
      await name(world, A.id, booked.bookingId, 1, adult("Pat Moved", fresh), hooks);
      expect(await messages(request.id)).toEqual([
        { generation: 1, state: "canceled", to: old, code: "recipient_changed" },
        { generation: 2, state: "queued", to: fresh, code: null },
      ]);
      await deliverMail(world.db, A.id);
      expect((await messages(request.id)).map((m) => m.state)).toEqual(["canceled", "sent"]);
    }, 180_000);

    it("a resend while the old generation is still queued", async () => {
      const booked = await book(world, A, nextTrip(), 1, hooks);
      const to = uniqueEmail("ren.queued");
      const pid = await name(world, A.id, booked.bookingId, 1, adult("Ren Queued", to), hooks);
      const request = await liveRequest(world.admin, booked.bookingId, pid);
      await ageDeliveries(world.admin, request.id);
      expect(await staffResend(request.id)).toMatchObject({ kind: "sent", generation: 2 });
      expect(await messages(request.id)).toEqual([
        { generation: 1, state: "canceled", to, code: "resent" },
        { generation: 2, state: "queued", to, code: null },
      ]);
      await deliverMail(world.db, A.id);
      expect((await messages(request.id)).map((m) => m.state)).toEqual(["canceled", "sent"]);
      expect(await liveLinks(request.id)).toBe(1);
    }, 180_000);

    it("an address removed from the booking, queued or already sent", async () => {
      const booked = await book(world, A, nextTrip(), 2, hooks);
      // Queued when the address goes.
      const quinn = uniqueEmail("quinn.gone");
      const q = await name(world, A.id, booked.bookingId, 1, adult("Quinn Gone", quinn), hooks);
      const qRequest = await liveRequest(world.admin, booked.bookingId, q);
      await name(world, A.id, booked.bookingId, 1, adult("Quinn Gone", null), hooks);
      expect(await messages(qRequest.id)).toEqual([
        { generation: 1, state: "canceled", to: quinn, code: "recipient_changed" },
      ]);
      // Sent, with a link, when the address goes.
      const sam = uniqueEmail("sam.gone");
      const s = await name(world, A.id, booked.bookingId, 2, adult("Sam Gone", sam), hooks);
      const sRequest = await liveRequest(world.admin, booked.bookingId, s);
      const { token } = await linkFor(world.admin, world.db, A.id, sRequest.id);
      await name(world, A.id, booked.bookingId, 2, adult("Sam Gone", null), hooks);
      expect((await redeem(world, A.id, token)).kind).toBe("replaced");
      await deliverMail(world.db, A.id);
      expect(await liveLinks(qRequest.id)).toBe(0);
      expect(await liveLinks(sRequest.id)).toBe(0);
      const found = await inTenantTransaction(world.db, systemCtx(A.id), (trx) =>
        listBookingWaivers(trx, A.id, booked.bookingId),
      );
      expect(found?.participants.map((p) => [p.status, p.request?.resendAvailableAt])).toEqual([
        ["no_address", null],
        ["no_address", null],
      ]);
    }, 180_000);
  });
});
