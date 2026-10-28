/**
 * A corrected address against email in flight (lane 1, G2.16 shim; raised by
 * lane 2 for waiver requests). A participant's email names its link's
 * booking, purpose, participant, and subject. When the guest corrects the
 * address, the caller revokes the old address's links as recipient_changed,
 * cancels the old message, and enqueues one to the new address, in one
 * transaction. Whatever the delivery job is doing at that moment, once that
 * transaction commits:
 *
 * - no link in any email to the old address opens anything;
 * - the old message is never claimed again, so no retry mints a fresh link
 *   for the old address;
 * - the new address's email carries the one live link.
 *
 * Revoking the subject's links for a closing reason (recipient_changed,
 * completed, withdrawn, booking_canceled) closes its pending email by itself,
 * under the message rows' locks: a message never claimed (no link yet), one
 * retrying, and one a claim holds at that moment are all canceled, and no
 * link they carry stays live. The claim keeps a backstop for a link revoked
 * outside that function. And a claim never waits behind a participant change
 * in progress, so a correction waiting for a claim cannot deadlock.
 */
import { randomBytes, randomUUID } from "node:crypto";
import { createDb } from "@tidegrid/database";
import type {} from "@tidegrid/database/global-setup";
import { tripAllocator } from "@tidegrid/domain-inventory/testing";
import {
  cancelMessage,
  deliverTenantMessages,
  type EmailProvider,
  EmailProviderUnavailableError,
  enqueueMessage,
  FakeEmailProvider,
  redeemAccessLink,
  revokeAccessLinks,
} from "@tidegrid/domain-messaging";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";
import { putParticipant } from "../index.ts";
import { type CheckoutFixture, createCheckoutFixture, fakeProvider } from "../test-fixtures.ts";
import {
  acceptedFor,
  addLocalHostname,
  asGuest,
  asSystem,
  book,
  deliverMail,
  FROM_ADDRESS,
  LINK_ORIGIN,
  makeDue,
  messageOf,
  type SelfServiceWorld,
  tokenIn,
} from "./self-service-harness.ts";

const env = inject("integrationDb");

describe.skipIf(!env)("adversarial: a corrected address against email in flight", () => {
  let world: SelfServiceWorld;
  let runtime: ReturnType<typeof createDb>;
  let A: CheckoutFixture;
  let trips: ReturnType<typeof tripAllocator>;

  interface Scope {
    bookingId: string;
    participantId: string;
    subjectRef: string;
  }

  /** A booking with one named adult who has an address of their own. */
  async function participantWithEmail(email: string): Promise<Scope> {
    const b = await book(world, A, trips.shared(), 1);
    const put = await asGuest(world.db, A.id, (trx, ctx) =>
      putParticipant(trx, ctx, {
        bookingId: b.bookingId,
        position: 1,
        details: { name: "Synthetic Adult", isMinor: false, email },
      }),
    );
    if (put.kind !== "created") throw new Error(`setup participant: ${put.kind}`);
    return {
      bookingId: b.bookingId,
      participantId: put.participant.id,
      subjectRef: `waiver_request:${randomUUID()}`,
    };
  }

  /** A participant-scoped email with a signing link, as lane 2's waiver request is. */
  function enqueueSigning(scope: Scope, to: string, generation: number) {
    return asSystem(world.db, A.id, async (trx, ctx) => {
      const queued = await enqueueMessage(trx, ctx, {
        dedupeKey: `test.signing:${scope.subjectRef.slice(15)}:${generation}`,
        template: "test_signing",
        templateVersion: 1,
        to: { email: to, name: "Synthetic Adult" },
        bookingId: scope.bookingId,
        participantId: scope.participantId,
        subjectRef: scope.subjectRef,
        content: {
          subject: "Please sign your waiver",
          blocks: [
            { kind: "paragraph", text: "A synthetic request." },
            { kind: "action", label: "Sign the waiver", href: "access_link" },
          ],
        },
        accessLink: { purpose: "waiver_sign", path: "/waiver", ttlSeconds: 3600 },
      });
      return queued.messageId;
    });
  }

  /** The correction as lane 2 makes it: one transaction, old access closed, new email queued. */
  function correct(scope: Scope, oldMessageId: string, to: string, generation: number) {
    return asSystem(world.db, A.id, async (trx, ctx) => {
      await revokeAccessLinks(trx, ctx, {
        bookingId: scope.bookingId,
        purpose: "waiver_sign",
        participantId: scope.participantId,
        subjectRef: scope.subjectRef,
        reason: "recipient_changed",
      });
      const canceled = await cancelMessage(trx, ctx, oldMessageId, {
        linkReason: "recipient_changed",
        code: "recipient_changed",
      });
      const queued = await enqueueMessage(trx, ctx, {
        dedupeKey: `test.signing:${scope.subjectRef.slice(15)}:${generation}`,
        template: "test_signing",
        templateVersion: 1,
        to: { email: to, name: "Synthetic Adult" },
        bookingId: scope.bookingId,
        participantId: scope.participantId,
        subjectRef: scope.subjectRef,
        content: {
          subject: "Please sign your waiver",
          blocks: [{ kind: "action", label: "Sign the waiver", href: "access_link" }],
        },
        accessLink: { purpose: "waiver_sign", path: "/waiver", ttlSeconds: 3600 },
      });
      return { canceled, newMessageId: queued.messageId };
    });
  }

  const redeemSigning = (token: string) =>
    asGuest(world.db, A.id, (trx, ctx) =>
      redeemAccessLink(trx, ctx, { token, purpose: "waiver_sign" }),
    );

  /** Every provider call for one message, accepted or not. */
  async function callsFor(messageId: string): Promise<number> {
    const [row] = await world.admin<{ n: number }[]>`
      select count(*)::int as n from public.fake_email_deliveries
       where idempotency_key = ${messageId}`;
    return row?.n ?? 0;
  }

  /** Live links that name an address's emails, by the tokens those emails carried. */
  async function liveLinksOf(messageId: string): Promise<number> {
    const [row] = await world.admin<{ n: number }[]>`
      select count(*)::int as n from public.guest_access_links
       where message_id = ${messageId} and consumed_at is null and revoked_at is null`;
    return row?.n ?? 0;
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
    A = await createCheckoutFixture(admin, runtime.db, "ss-rcpt-a", { days: 30 });
    await addLocalHostname(admin, A);
    trips = tripAllocator(A);
  });

  afterAll(async () => {
    await runtime?.end();
    await world?.admin.end({ timeout: 5 });
  });

  it("revokes the link of an email being sent when its address is corrected, and never retries it", async () => {
    const scope = await participantWithEmail("old.address@example.test");
    const old = await enqueueSigning(scope, "old.address@example.test", 1);
    let inFlight: string | null = null;
    let corrected: Awaited<ReturnType<typeof correct>> | null = null;
    let oldCalls = 0;
    // The provider is slow: the guest corrects the address while the old
    // email is in its hands, and then it reports a temporary failure.
    const slow: EmailProvider = {
      name: "fake",
      send: async (email) => {
        if (email.idempotencyKey === old) {
          oldCalls += 1;
          if (!corrected) {
            inFlight = tokenIn(email.html);
            corrected = await correct(scope, old, "new.address@example.test", 2);
          }
          throw new EmailProviderUnavailableError("provider_unavailable");
        }
        return world.mail.send(email);
      },
    };
    await deliverMail(world, A.id, slow);
    if (!corrected || !inFlight) throw new Error("the provider never saw the old email");
    const done: Awaited<ReturnType<typeof correct>> = corrected;
    // The scope's revocation canceled the message mid-send and took its link;
    // the correction's own cancelMessage then finds it canceled.
    expect(done.canceled).toMatchObject({ kind: "not_cancelable", state: "canceled" });
    expect(await messageOf(world.admin, old)).toMatchObject({
      state: "canceled",
      attempts: 1,
      last_error_code: "recipient_changed",
    });
    // The email the old address may still receive opens nothing.
    expect(await redeemSigning(inFlight)).toMatchObject({
      kind: "revoked",
      reason: "recipient_changed",
    });

    // Time passes and the job runs again: the old message is never claimed.
    await makeDue(world.admin, old);
    await deliverMail(world, A.id, slow);
    await deliverMail(world, A.id, slow);
    expect(oldCalls).toBe(1);
    expect(await callsFor(old)).toBe(0);
    expect(await liveLinksOf(old)).toBe(0);

    // The new address's email went out with the one link that works.
    expect(await messageOf(world.admin, done.newMessageId)).toMatchObject({
      state: "sent",
      to_email: "new.address@example.test",
    });
    const fresh = tokenIn((await acceptedFor(world.admin, done.newMessageId))?.html ?? "");
    if (!fresh) throw new Error("the new address's email carries no link");
    expect((await redeemSigning(fresh)).kind).toBe("redeemed");
  });

  it("revokes the link a claim in progress issued when the address is corrected meanwhile", async () => {
    const scope = await participantWithEmail("old.claim@example.test");
    const old = await enqueueSigning(scope, "old.claim@example.test", 1);
    // A claim in progress: the message row locked, marked sending, and its
    // link written, all not yet committed.
    let release: () => void = () => {};
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    let claimed: () => void = () => {};
    const claiming = new Promise<void>((resolve) => {
      claimed = resolve;
    });
    const claim = world.admin.begin(async (tx) => {
      await tx`select id from public.email_messages where id = ${old} for update`;
      await tx`update public.email_messages
                  set state = 'sending', attempts = attempts + 1, provider = 'fake',
                      lease_expires_at = now() + interval '2 minutes'
                where id = ${old}`;
      await tx`insert into public.guest_access_links
                 (tenant_id, booking_id, participant_id, purpose, subject_ref, message_id,
                  token_hash, expires_at)
               values (${A.id}, ${scope.bookingId}, ${scope.participantId}, 'waiver_sign',
                       ${scope.subjectRef}, ${old}, ${randomBytes(32).toString("hex")}, now() + interval '1 hour')`;
      claimed();
      await held;
    });
    await claiming;
    const correction = correct(scope, old, "new.claim@example.test", 2);
    let settled = false;
    void correction.then(() => {
      settled = true;
    });
    await new Promise((r) => setTimeout(r, 400));
    // The correction waits for the claim rather than missing its link.
    expect(settled).toBe(false);
    release();
    await claim;
    const done = await correction;
    expect(done.canceled).toMatchObject({ kind: "not_cancelable", state: "canceled" });
    expect(await liveLinksOf(old)).toBe(0);
    expect(await messageOf(world.admin, old)).toMatchObject({
      state: "canceled",
      last_error_code: "recipient_changed",
    });
  });

  it("closes an email nobody claimed yet when its subject's links are revoked, though no link exists", async () => {
    const scope = await participantWithEmail("unsent.address@example.test");
    const old = await enqueueSigning(scope, "unsent.address@example.test", 1);
    // No delivery has run: the message is queued and has no link at all.
    const revoked = await asSystem(world.db, A.id, (trx, ctx) =>
      revokeAccessLinks(trx, ctx, {
        bookingId: scope.bookingId,
        purpose: "waiver_sign",
        participantId: scope.participantId,
        subjectRef: scope.subjectRef,
        reason: "recipient_changed",
      }),
    );
    expect(revoked).toBe(0);
    expect(await messageOf(world.admin, old)).toMatchObject({
      state: "canceled",
      attempts: 0,
      last_error_code: "recipient_changed",
    });
    const report = await deliverMail(world, A.id);
    expect(report.items.map((i) => i.messageId)).not.toContain(old);
    expect(await callsFor(old)).toBe(0);
    expect(await liveLinksOf(old)).toBe(0);
  });

  it("makes a revocation wait for a claim in progress, then closes the link that claim issued", async () => {
    const scope = await participantWithEmail("racing.claim@example.test");
    const old = await enqueueSigning(scope, "racing.claim@example.test", 1);
    let release: () => void = () => {};
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    let claimed: () => void = () => {};
    const claiming = new Promise<void>((resolve) => {
      claimed = resolve;
    });
    // A claim in progress, as the delivery job's: row locked, sending, link written.
    const claim = world.admin.begin(async (tx) => {
      await tx`select id from public.email_messages where id = ${old} for update`;
      await tx`update public.email_messages
                  set state = 'sending', attempts = attempts + 1, provider = 'fake',
                      lease_expires_at = now() + interval '2 minutes'
                where id = ${old}`;
      await tx`insert into public.guest_access_links
                 (tenant_id, booking_id, participant_id, purpose, subject_ref, message_id,
                  token_hash, expires_at)
               values (${A.id}, ${scope.bookingId}, ${scope.participantId}, 'waiver_sign',
                       ${scope.subjectRef}, ${old}, ${randomBytes(32).toString("hex")},
                       now() + interval '1 hour')`;
      claimed();
      await held;
    });
    await claiming;
    // A revocation alone, with no cancelMessage.
    const revocation = asSystem(world.db, A.id, (trx, ctx) =>
      revokeAccessLinks(trx, ctx, {
        bookingId: scope.bookingId,
        purpose: "waiver_sign",
        participantId: scope.participantId,
        subjectRef: scope.subjectRef,
        reason: "recipient_changed",
      }),
    );
    let settled = false;
    void revocation.then(() => {
      settled = true;
    });
    await new Promise((r) => setTimeout(r, 400));
    expect(settled).toBe(false);
    release();
    await claim;
    expect(await revocation).toBe(1);
    expect(await liveLinksOf(old)).toBe(0);
    expect(await messageOf(world.admin, old)).toMatchObject({
      state: "canceled",
      last_error_code: "recipient_changed",
    });
  });

  it("keeps the delivery job off an email while a revocation of its subject is in progress", async () => {
    const scope = await participantWithEmail("held.revocation@example.test");
    const old = await enqueueSigning(scope, "held.revocation@example.test", 1);
    let release: () => void = () => {};
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    let revoked: () => void = () => {};
    const revoking = new Promise<void>((resolve) => {
      revoked = resolve;
    });
    const revocation = asSystem(world.db, A.id, async (trx, ctx) => {
      await revokeAccessLinks(trx, ctx, {
        bookingId: scope.bookingId,
        purpose: "waiver_sign",
        participantId: scope.participantId,
        subjectRef: scope.subjectRef,
        reason: "recipient_changed",
      });
      revoked();
      await held;
    });
    await revoking;
    // The job runs while the revocation has not committed: it does not claim the email.
    const report = await deliverMail(world, A.id);
    expect(report.items.map((i) => i.messageId)).not.toContain(old);
    release();
    await revocation;
    await deliverMail(world, A.id);
    expect(await messageOf(world.admin, old)).toMatchObject({ state: "canceled" });
    expect(await callsFor(old)).toBe(0);
    expect(await liveLinksOf(old)).toBe(0);
  });

  it("closes a retrying email when its subject's links are revoked, even if nobody canceled it", async () => {
    const scope = await participantWithEmail("stale.address@example.test");
    const old = await enqueueSigning(scope, "stale.address@example.test", 1);
    // The first attempt fails for a while, leaving a link and a retry.
    const down: EmailProvider = {
      name: "fake",
      send: async () => {
        throw new EmailProviderUnavailableError("provider_unavailable");
      },
    };
    await deliverMail(world, A.id, down);
    expect(await messageOf(world.admin, old)).toMatchObject({ state: "queued", attempts: 1 });
    // A caller revokes the old address's links but forgets the message.
    await asSystem(world.db, A.id, (trx, ctx) =>
      revokeAccessLinks(trx, ctx, {
        bookingId: scope.bookingId,
        purpose: "waiver_sign",
        participantId: scope.participantId,
        subjectRef: scope.subjectRef,
        reason: "recipient_changed",
      }),
    );
    expect(await messageOf(world.admin, old)).toMatchObject({
      state: "canceled",
      last_error_code: "recipient_changed",
    });
    await makeDue(world.admin, old);
    const report = await deliverMail(world, A.id);
    expect(report.items.map((i) => i.messageId)).not.toContain(old);
    expect(await callsFor(old)).toBe(0);
    expect(await liveLinksOf(old)).toBe(0);
  });

  it("cancels at its claim a message whose own link was revoked outside revokeAccessLinks, instead of minting another", async () => {
    const scope = await participantWithEmail("withdrawn@example.test");
    const old = await enqueueSigning(scope, "withdrawn@example.test", 1);
    const down: EmailProvider = {
      name: "fake",
      send: async () => {
        throw new EmailProviderUnavailableError("provider_unavailable");
      },
    };
    await deliverMail(world, A.id, down);
    await world.admin`
      update public.guest_access_links set revoked_at = now(), revoked_reason = 'withdrawn'
       where message_id = ${old} and revoked_at is null and consumed_at is null`;
    await makeDue(world.admin, old);
    const report = await deliverMail(world, A.id);
    expect(report.items.find((i) => i.messageId === old)).toMatchObject({
      outcome: "canceled",
      code: "access_withdrawn",
    });
    expect(await callsFor(old)).toBe(0);
    const [links] = await world.admin<{ n: number }[]>`
      select count(*)::int as n from public.guest_access_links where message_id = ${old}`;
    expect(links?.n).toBe(1);
  });

  it("claims a participant's email without waiting behind a change to that participant in progress", async () => {
    const scope = await participantWithEmail("patient@example.test");
    const message = await enqueueSigning(scope, "patient@example.test", 1);
    let release: () => void = () => {};
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    let locked: () => void = () => {};
    const locking = new Promise<void>((resolve) => {
      locked = resolve;
    });
    // The guest's edit holds the booking and the participant until released.
    const edit = asGuest(world.db, A.id, async (trx, ctx) => {
      const put = await putParticipant(trx, ctx, {
        bookingId: scope.bookingId,
        position: 1,
        details: { name: "Synthetic Adult Renamed", isMinor: false, email: "patient@example.test" },
      });
      locked();
      await held;
      return put.kind;
    });
    await locking;
    const delivered = deliverMail(world, A.id);
    const outcome = await Promise.race([
      delivered.then(() => "delivered" as const),
      new Promise<"waited">((r) => setTimeout(() => r("waited"), 5_000)),
    ]);
    release();
    expect(await edit).toBe("updated");
    await delivered;
    expect(outcome).toBe("delivered");
    expect(await messageOf(world.admin, message)).toMatchObject({ state: "sent" });
  });

  it("sends a linked email on a one-connection pool, as the Worker runs it", async () => {
    const scope = await participantWithEmail("single.pool@example.test");
    const message = await enqueueSigning(scope, "single.pool@example.test", 1);
    // The Worker's handle: one connection for the job and the fake provider alike.
    const single = createDb(env?.runtimeUrl ?? "", { max: 1 });
    try {
      const run = deliverTenantMessages(single.db, A.id, {
        provider: new FakeEmailProvider({ db: single.db, environment: "local" }),
        fromAddress: FROM_ADDRESS,
        guestLinkOrigin: LINK_ORIGIN,
        environment: "local",
        runId: `run-${randomUUID()}`,
      });
      const outcome = await Promise.race([
        run.then(() => "delivered" as const),
        new Promise<"stuck">((r) => setTimeout(() => r("stuck"), 20_000)),
      ]);
      expect(outcome).toBe("delivered");
      expect(await messageOf(world.admin, message)).toMatchObject({ state: "sent" });
      expect(tokenIn((await acceptedFor(world.admin, message))?.html ?? "")).not.toBeNull();
    } finally {
      await Promise.race([single.end(), new Promise((r) => setTimeout(r, 5_000))]);
    }
  });
});
