import { createHash, randomUUID } from "node:crypto";
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
  issueAccessLink,
  openGuestSession,
  redeemAccessLink,
  resolveGuestSession,
  revokeAccessLinks,
  revokeGuestSession,
} from "@tidegrid/domain-messaging";
import type { FakePaymentProvider } from "@tidegrid/domain-payments";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";
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

describe.skipIf(!env)("accountless access links and guest sessions against a real database", () => {
  let admin: Sql;
  let runtime: ReturnType<typeof createDb>;
  let payments: FakePaymentProvider;
  let mail: FakeEmailProvider;
  let A: CheckoutFixture;
  let B: CheckoutFixture;
  let tripsA: ReturnType<typeof tripAllocator>;
  let tripsB: ReturnType<typeof tripAllocator>;

  const asGuest = <T>(
    tenantId: string,
    fn: (trx: TenantTransaction, ctx: TenantContext) => Promise<T>,
  ): Promise<T> => {
    const ctx = guestContext(tenantId);
    return inTenantTransaction(runtime.db, ctx, (trx) => fn(trx, ctx));
  };
  const book = (tenant: CheckoutFixture, party = 2) =>
    confirmBooking(runtime.db, payments, tenant, (tenant === A ? tripsA : tripsB).shared(), party);
  const issue = (tenant: CheckoutFixture, bookingId: string, extra: { messageId?: string } = {}) =>
    asGuest(tenant.id, (trx, ctx) =>
      issueAccessLink(trx, ctx, {
        bookingId,
        purpose: "booking_manage",
        ttlSeconds: 3600,
        ...extra,
      }),
    );
  const redeem = (tenant: CheckoutFixture, token: string, purpose = "booking_manage" as const) =>
    asGuest(tenant.id, (trx, ctx) => redeemAccessLink(trx, ctx, { token, purpose }));

  beforeAll(async () => {
    if (!env) return;
    admin = postgres(env.adminUrl, { max: 2, onnotice: () => {} });
    runtime = createDb(env.runtimeUrl, { max: 8 });
    payments = fakeProvider(runtime.db);
    mail = new FakeEmailProvider({ db: runtime.db, environment: "local" });
    A = await createCheckoutFixture(admin, runtime.db, "acc-a");
    B = await createCheckoutFixture(admin, runtime.db, "acc-b");
    tripsA = tripAllocator(A);
    tripsB = tripAllocator(B);
    for (const t of [A, B]) {
      await admin`insert into public.tenant_hostnames (hostname, tenant_id, kind, status, verified_at)
        values (${`${t.slug}.book.localhost`}, ${t.id}, 'preview', 'active', now())`;
    }
  });

  afterAll(async () => {
    await runtime?.end();
    await admin?.end({ timeout: 5 });
  });

  it("carries a link only in the delivered email, stores only its hash, and redeems it once", async () => {
    const { bookingId } = await book(A);
    const enqueued = await asGuest(A.id, (trx, ctx) =>
      enqueueMessage(trx, ctx, {
        dedupeKey: `test.manage_link:${bookingId}`,
        template: "booking_manage_link",
        templateVersion: 1,
        to: { email: "booker@example.test" },
        bookingId,
        content: {
          subject: "Your booking link",
          blocks: [{ kind: "action", label: "Manage your booking", href: "access_link" }],
        },
        accessLink: { purpose: "booking_manage", path: "/manage", ttlSeconds: 3600 },
      }),
    );
    // Nothing is issued until the email is sent.
    const [before] = await admin<{ n: number }[]>`
      select count(*)::int as n from public.guest_access_links where booking_id = ${bookingId}`;
    expect(before?.n).toBe(0);
    const run = await deliverTenantMessages(runtime.db, A.id, {
      provider: mail,
      fromAddress: "bookings@tidegrid.test",
      guestLinkOrigin: "http://{slug}.book.localhost:5301",
      environment: "local",
      runId: `run-${randomUUID()}`,
    });
    expect(run.items.find((i) => i.messageId === enqueued.messageId)?.outcome).toBe("sent");

    const inbox = await mail.listMailbox(A.id);
    const sent = inbox.find((m) => m.subject === "Your booking link");
    if (!sent) throw new Error("the email was not delivered");
    const message = await mail.getMailboxMessage(A.id, sent.id);
    const match = /http:\/\/[^/]+\/manage#t=([A-Za-z0-9_-]{43})/.exec(message?.html ?? "");
    const token = match?.[1];
    if (!token) throw new Error("no link in the email");
    expect(match?.[0]).toBe(`http://${A.slug}.book.localhost:5301/manage#t=${token}`);
    expect(message?.text).toContain(match?.[0]);

    // Only the hash is stored; the message keeps the marker, never the token.
    const hash = createHash("sha256").update(`access-link:${token}`).digest("hex");
    const [stored] = await admin<{ n: number; raw: number }[]>`
      select (select count(*)::int from public.guest_access_links where token_hash = ${hash}) as n,
             (select count(*)::int from public.email_messages
               where html_body like ${`%${token}%`} or text_body like ${`%${token}%`}) as raw`;
    expect(stored).toEqual({ n: 1, raw: 0 });

    // Another tenant's site, another purpose, and a malformed token are all invalid.
    expect(await redeem(B, token)).toEqual({ kind: "invalid" });
    expect(await redeem(A, token, "waiver_sign" as "booking_manage")).toEqual({ kind: "invalid" });
    expect(await redeem(A, "not-a-token")).toEqual({ kind: "invalid" });

    const first = await asGuest(A.id, async (trx, ctx) => {
      const redeemed = await redeemAccessLink(trx, ctx, { token, purpose: "booking_manage" });
      if (redeemed.kind !== "redeemed") return { redeemed, session: null };
      const session = await openGuestSession(trx, ctx, { link: redeemed.link });
      return { redeemed, session };
    });
    expect(first.redeemed).toMatchObject({
      kind: "redeemed",
      link: { bookingId, participantId: null, messageId: enqueued.messageId, subjectRef: null },
    });
    expect(await redeem(A, token)).toEqual({ kind: "used" });
    const session = first.session;
    if (!session) throw new Error("no session");
    expect(
      await asGuest(A.id, (trx) => resolveGuestSession(trx, A.id, session.token, "booking_manage")),
    ).toMatchObject({ bookingId, purpose: "booking_manage" });
    expect(
      await asGuest(B.id, (trx) => resolveGuestSession(trx, B.id, session.token, "booking_manage")),
    ).toBeNull();
  });

  it("opens one session when the same link is redeemed concurrently", async () => {
    const { bookingId } = await book(A);
    const { token } = await issue(A, bookingId);
    const results = await Promise.all(
      Array.from({ length: 6 }, () =>
        asGuest(A.id, async (trx, ctx) => {
          const redeemed = await redeemAccessLink(trx, ctx, { token, purpose: "booking_manage" });
          if (redeemed.kind === "redeemed")
            await openGuestSession(trx, ctx, { link: redeemed.link });
          return redeemed.kind;
        }),
      ),
    );
    expect(results.filter((k) => k === "redeemed")).toHaveLength(1);
    expect(results.filter((k) => k === "used")).toHaveLength(5);
    const [row] = await admin<{ n: number }[]>`
      select count(*)::int as n from public.guest_sessions where booking_id = ${bookingId}`;
    expect(row?.n).toBe(1);
  });

  it("supersedes an older email's link, and says why a link no longer works", async () => {
    const { bookingId } = await book(A);
    const messageA = randomUUID();
    const messageB = randomUUID();
    for (const id of [messageA, messageB]) {
      await admin`insert into public.email_messages (id, tenant_id, dedupe_key, template,
          template_version, booking_id, to_email, from_name, subject, html_body, text_body)
        values (${id}, ${A.id}, ${`test.message:${id}`}, 'test', 1, ${bookingId},
                'x@example.test', 'X', 'S', 'h', 't')`;
    }
    const older = await issue(A, bookingId, { messageId: messageA });
    const retried = await issue(A, bookingId, { messageId: messageA });
    // A retry of one message supersedes nothing of its own.
    expect(retried.superseded).toBe(0);
    const newer = await issue(A, bookingId, { messageId: messageB });
    expect(newer.superseded).toBe(2);
    expect(await redeem(A, older.token)).toEqual({ kind: "superseded" });
    expect(await redeem(A, retried.token)).toEqual({ kind: "superseded" });

    const revoked = await asGuest(A.id, (trx, ctx) =>
      revokeAccessLinks(trx, ctx, { bookingId, purpose: "booking_manage", reason: "completed" }),
    );
    expect(revoked).toBe(1);
    expect(await redeem(A, newer.token)).toEqual({ kind: "revoked", reason: "completed" });

    const lapsing = await issue(A, bookingId);
    await admin`update public.guest_access_links set expires_at = now() - interval '1 second'
                 where id = ${lapsing.linkId}`;
    expect(await redeem(A, lapsing.token)).toEqual({ kind: "expired" });
  });

  it("keeps links and sessions one way, for every role", async () => {
    const { bookingId } = await book(A);
    const link = await issue(A, bookingId);
    for (const [statement, constraint] of [
      [
        () =>
          admin`update public.guest_access_links set expires_at = expires_at + interval '1 day'
                 where id = ${link.linkId}`,
        "guest_access_links_immutable",
      ],
      [
        () =>
          admin`update public.guest_access_links set token_hash = repeat('0', 64) where id = ${link.linkId}`,
        "guest_access_links_immutable",
      ],
      [
        () =>
          admin`insert into public.guest_access_links (tenant_id, booking_id, purpose, token_hash, expires_at)
                values (${A.id}, ${bookingId}, 'booking_manage', repeat('1', 64), now() + interval '30 days')`,
        "guest_access_links_expiry",
      ],
    ] as const) {
      expect(await failure(statement())).toEqual({ code: "23514", constraint });
    }
    // A link used in an earlier transaction opens no session later.
    const redeemed = await redeem(A, link.token);
    if (redeemed.kind !== "redeemed") throw new Error("expected a redemption");
    expect(
      await failure(
        asGuest(A.id, (trx, ctx) => openGuestSession(trx, ctx, { link: redeemed.link })),
      ),
    ).toEqual({ code: "23514", constraint: "guest_sessions_evidence" });
    expect(
      await failure(
        admin`update public.guest_access_links set consumed_at = null where id = ${link.linkId}`,
      ),
    ).toEqual({ code: "23514", constraint: "guest_access_links_transition" });
    expect(
      (await failure(admin`delete from public.guest_access_links where id = ${link.linkId}`)).code,
    ).toBe("55000");
  });

  it("opens a session from the checkout that made the booking, and only within the hour", async () => {
    const booked = await book(A);
    const other = await book(A);
    const session = await asGuest(A.id, (trx, ctx) =>
      openGuestSession(trx, ctx, {
        checkout: { checkoutSessionId: booked.checkoutSessionId, bookingId: booked.bookingId },
      }),
    );
    expect(session).toMatchObject({ bookingId: booked.bookingId, purpose: "booking_manage" });
    // One checkout cannot open another booking's session.
    expect(
      await failure(
        asGuest(A.id, (trx, ctx) =>
          openGuestSession(trx, ctx, {
            checkout: { checkoutSessionId: booked.checkoutSessionId, bookingId: other.bookingId },
          }),
        ),
      ),
    ).toEqual({ code: "23514", constraint: "guest_sessions_evidence" });
    // Expiry and revocation end it; the database clock decides.
    await admin`update public.guest_sessions set expires_at = now() - interval '1 second'
                 where id = ${session.sessionId}`;
    expect(
      await asGuest(A.id, (trx) => resolveGuestSession(trx, A.id, session.token, "booking_manage")),
    ).toBeNull();
    const again = await asGuest(A.id, (trx, ctx) =>
      openGuestSession(trx, ctx, {
        checkout: { checkoutSessionId: other.checkoutSessionId, bookingId: other.bookingId },
      }),
    );
    expect(await asGuest(A.id, (trx, ctx) => revokeGuestSession(trx, ctx, again.sessionId))).toBe(
      true,
    );
    expect(
      await asGuest(A.id, (trx) => resolveGuestSession(trx, A.id, again.token, "booking_manage")),
    ).toBeNull();
    expect(await asGuest(A.id, (trx, ctx) => revokeGuestSession(trx, ctx, again.sessionId))).toBe(
      false,
    );
  });

  it("fails a link email whose site is not one of the tenant's hostnames", async () => {
    const { bookingId } = await book(B);
    const queued = await asGuest(B.id, (trx, ctx) =>
      enqueueMessage(trx, ctx, {
        dedupeKey: `test.manage_link:${bookingId}`,
        template: "booking_manage_link",
        templateVersion: 1,
        to: { email: "booker@example.test" },
        bookingId,
        content: {
          subject: "Your booking link",
          blocks: [{ kind: "action", label: "Manage your booking", href: "access_link" }],
        },
        accessLink: { purpose: "booking_manage", path: "/manage" },
      }),
    );
    const run = await deliverTenantMessages(runtime.db, B.id, {
      provider: mail,
      fromAddress: "bookings@tidegrid.test",
      guestLinkOrigin: "https://{slug}.book.example.test",
      runId: `run-${randomUUID()}`,
    });
    expect(run.items.find((i) => i.messageId === queued.messageId)).toMatchObject({
      outcome: "failed",
      code: "link_host_unmapped",
    });
    const [row] = await admin<{ n: number }[]>`
      select count(*)::int as n from public.guest_access_links where booking_id = ${bookingId}`;
    expect(row?.n).toBe(0);
  });
});
