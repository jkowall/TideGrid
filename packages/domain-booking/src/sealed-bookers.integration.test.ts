import { randomUUID } from "node:crypto";
import {
  bindFieldPolicy,
  createDb,
  type FieldKeyring,
  FieldKeyringError,
  inTenantTransaction,
  newFieldKeyringSecret,
  parseFieldKeyring,
  type TenantContext,
  type TenantTransaction,
} from "@tidegrid/database";
import type {} from "@tidegrid/database/global-setup";
import { tripAllocator } from "@tidegrid/domain-inventory/testing";
import { FAKE_MINIMUM_AMOUNT, type FakePaymentProvider } from "@tidegrid/domain-payments";
import { sql } from "kysely";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";
import {
  adjustCredit,
  bookerCreditKey,
  changeBookerContact,
  createCheckoutSession,
  creditAccountForBooking,
  ensureCreditAccount,
  ensureProviderPayment,
  getBookingDetail,
  redeemCredit,
  searchBookings,
  sweepCheckouts,
} from "./index.ts";
import {
  backdateCheckout,
  type CheckoutFixture,
  confirmBooking,
  createCheckoutFixture,
  fakeProvider,
  guestContext,
  newSecret,
  quoteFor,
} from "./test-fixtures.ts";

type Sql = ReturnType<typeof postgres>;

const env = inject("integrationDb");

function staffContext(tenantId: string): TenantContext {
  return {
    tenantId,
    actorType: "staff",
    actorId: `user:${randomUUID()}`,
    requestId: `req-${randomUUID()}`,
    sourceIp: null,
  };
}

/**
 * Sealed bookers (W3-OPS-4, 0055, owner decision 2026-11-15): where the
 * database handle carries a field keyring, a checkout's booker is written
 * sealed with blind index tokens, never plain, and every reader opens it.
 * Search matches whole words and whole addresses, a credit account is keyed by
 * the email token, a correction stays sealed, and retention clears it. A
 * handle that must seal and has no keyring refuses to write; one with no
 * keyring cannot read a sealed booker.
 */
describe.skipIf(!env)("sealed bookers (W3-OPS-4, 0055)", () => {
  let admin: Sql;
  let sealed: ReturnType<typeof createDb>;
  let plain: ReturnType<typeof createDb>;
  let payments: FakePaymentProvider;
  let keyring: FieldKeyring;
  let A: CheckoutFixture;
  let B: CheckoutFixture;
  let tripsA: ReturnType<typeof tripAllocator>;
  let tripsB: ReturnType<typeof tripAllocator>;

  const as = <T>(
    ctx: TenantContext,
    fn: (trx: TenantTransaction, ctx: TenantContext) => Promise<T>,
    db = sealed.db,
  ): Promise<T> => inTenantTransaction(db, ctx, (trx) => fn(trx, ctx));

  const stored = async (sessionId: string) => {
    const [row] = await admin<
      {
        booker_name: string | null;
        booker_email: string | null;
        booker_sealed: string | null;
        booker_email_index: string | null;
        booker_name_index: string[] | null;
        booker_redacted_at: Date | null;
      }[]
    >`select booker_name, booker_email, booker_sealed, booker_email_index, booker_name_index,
             booker_redacted_at
        from public.checkout_sessions where id = ${sessionId}`;
    if (!row) throw new Error("no checkout");
    return row;
  };

  const search = (tenantId: string, q: string) =>
    as(staffContext(tenantId), (trx) =>
      searchBookings(trx, tenantId, { q, limit: 50, withBooker: true }),
    ).then((r) => {
      if (r.kind !== "ok") throw new Error(r.kind);
      return r.results;
    });

  beforeAll(async () => {
    if (!env) return;
    admin = postgres(env.adminUrl, { max: 2, onnotice: () => {} });
    keyring = await parseFieldKeyring(newFieldKeyringSecret());
    sealed = createDb(env.runtimeUrl, { max: 4 });
    bindFieldPolicy(sealed.db, { keyring: async () => keyring, required: true });
    plain = createDb(env.runtimeUrl, { max: 2 });
    payments = fakeProvider(sealed.db);
    A = await createCheckoutFixture(admin, sealed.db, "seal-a", { days: 14 });
    B = await createCheckoutFixture(admin, sealed.db, "seal-b");
    tripsA = tripAllocator(A);
    tripsB = tripAllocator(B);
  });

  afterAll(async () => {
    await sealed?.end();
    await plain?.end();
    await admin?.end({ timeout: 5 });
  });

  it("writes the booker sealed with tokens, and every reader opens it", async () => {
    const run = randomUUID().slice(0, 8);
    const email = `ana.oneil-${run}@example.test`;
    const booked = await confirmBooking(sealed.db, payments, A, tripsA.shared(), 2, {
      booker: { name: "Ana María O'Neil", email: email.toUpperCase() },
    });
    const row = await stored(booked.checkoutSessionId);
    expect(row.booker_name).toBeNull();
    expect(row.booker_email).toBeNull();
    expect(row.booker_sealed).toMatch(/^tgf1:k1:/);
    expect(row.booker_email_index).toMatch(/^[0-9a-f]{64}$/);
    // Four words (ana, maría, o, neil) and the exact name.
    expect(row.booker_name_index).toHaveLength(5);

    const detail = await as(staffContext(A.id), (trx) =>
      getBookingDetail(trx, A.id, booked.bookingId, { withBooker: true }),
    );
    expect(detail?.booker).toEqual({ name: "Ana María O'Neil", email });

    // A handle with no keyring cannot read it, and never reads it as blank.
    const unread = await as(
      staffContext(A.id),
      (trx) => getBookingDetail(trx, A.id, booked.bookingId, { withBooker: true }),
      plain.db,
    ).catch((e: unknown) => e);
    expect(unread).toBeInstanceOf(FieldKeyringError);
  });

  it("finds a sealed booker by whole words and the whole address, never by part", async () => {
    const run = randomUUID().slice(0, 8);
    const email = `kai.${run}@example.test`;
    const booked = await confirmBooking(sealed.db, payments, A, tripsA.shared(), 1, {
      booker: { name: `Kai Zephyr${run}`, email },
    });
    const ids = async (q: string) => (await search(A.id, q)).map((r) => r.id);
    expect(await ids(`zephyr${run}`)).toEqual([booked.bookingId]);
    expect(await ids(`KAI ZEPHYR${run}`)).toEqual([booked.bookingId]);
    expect(await ids(email.toUpperCase())).toEqual([booked.bookingId]);
    const [hit] = await search(A.id, email);
    expect(hit?.booker).toEqual({ name: `Kai Zephyr${run}`, email });
    // Part of a word, or part of an address, matches nothing on a sealed row.
    expect(await ids(`zephyr${run.slice(0, 4)}`)).toEqual([]);
    expect(await ids(`kai.${run}`)).toEqual([]);
    expect(await ids("example.test")).not.toContain(booked.bookingId);
    // Another tenant's tokens for the same name are different, and it finds nothing.
    expect(await search(B.id, `zephyr${run}`)).toEqual([]);
  });

  it("gives the same address unrelated tokens at two tenants", async () => {
    const email = `same-${randomUUID().slice(0, 8)}@example.test`;
    const a = await confirmBooking(sealed.db, payments, A, tripsA.shared(), 1, {
      booker: { name: "Same Person", email },
    });
    const b = await confirmBooking(sealed.db, payments, B, tripsB.shared(), 1, {
      booker: { name: "Same Person", email },
    });
    const ra = await stored(a.checkoutSessionId);
    const rb = await stored(b.checkoutSessionId);
    expect(ra.booker_email_index).not.toEqual(rb.booker_email_index);
    expect(ra.booker_name_index).not.toEqual(rb.booker_name_index);
  });

  it("keeps a corrected booker sealed, and records what changed by its tokens", async () => {
    const run = randomUUID().slice(0, 8);
    const booked = await confirmBooking(sealed.db, payments, A, tripsA.shared(), 1, {
      booker: { name: "Bo Typo", email: `bo-${run}@exmaple.test` },
    });
    const before = await stored(booked.checkoutSessionId);
    const result = await as(staffContext(A.id), (trx, c) =>
      changeBookerContact(trx, c, {
        bookingId: booked.bookingId,
        name: "Bo Typo",
        email: `bo-${run}@example.test`,
      }),
    );
    expect(result).toMatchObject({
      kind: "changed",
      change: { nameChanged: false, emailChanged: true },
    });
    const after = await stored(booked.checkoutSessionId);
    expect(after.booker_name).toBeNull();
    expect(after.booker_sealed).not.toEqual(before.booker_sealed);
    expect(after.booker_name_index).toEqual(before.booker_name_index);
    expect(after.booker_email_index).not.toEqual(before.booker_email_index);
    const detail = await as(staffContext(A.id), (trx) =>
      getBookingDetail(trx, A.id, booked.bookingId, { withBooker: true }),
    );
    expect(detail?.booker).toEqual({ name: "Bo Typo", email: `bo-${run}@example.test` });

    // A sealed booker never turns plain, even by the runtime writing it directly.
    const refused = await as(staffContext(A.id), (trx) =>
      sql`update checkout_sessions set booker_name = 'Plain Now', booker_sealed = null,
            booker_email_index = null, booker_name_index = null
          where id = ${booked.checkoutSessionId}`.execute(trx),
    ).catch((e: unknown) => e);
    expect(refused).toMatchObject({
      code: "23514",
      constraint_name: "checkout_sessions_booker_place",
    });
  });

  it("records a correction of case or punctuation alone, and takes a name of many words", async () => {
    const run = randomUUID().slice(0, 8);
    const email = `case-${run}@example.test`;
    const booked = await confirmBooking(sealed.db, payments, A, tripsA.shared(), 1, {
      booker: { name: "Ana Example", email },
    });
    for (const name of [
      "ANA Example",
      "ANA Example.",
      "a b c d e f g h i j k l m n o p q r s t u v w x y z 1 2 3 4 5 6 7 8 9",
    ]) {
      const result = await as(staffContext(A.id), (trx, c) =>
        changeBookerContact(trx, c, { bookingId: booked.bookingId, name, email }),
      );
      expect(result).toMatchObject({
        kind: "changed",
        change: { nameChanged: true, emailChanged: false },
      });
    }
    expect((await stored(booked.checkoutSessionId)).booker_name_index).toHaveLength(36);
  });

  it("keys a sealed booker's credit by the email token, and matches only that booker", async () => {
    const run = randomUUID().slice(0, 8);
    const email = `credit-${run}@example.test`;
    const first = await confirmBooking(sealed.db, payments, A, tripsA.shared(), 1, {
      booker: { name: "Cy Credit", email },
    });
    const second = await confirmBooking(sealed.db, payments, A, tripsA.shared(), 1, {
      booker: { name: "Cy Credit", email: email.toUpperCase() },
    });
    const stranger = await confirmBooking(sealed.db, payments, A, tripsA.shared(), 1, {
      booker: { name: "Cy Credit", email: `other-${run}@example.test` },
    });
    const ctx = staffContext(A.id);
    const accountId = await as(ctx, async (trx, c) => {
      const key = await bookerCreditKey(trx, A.id, first.bookingId);
      expect(key).toEqual({ email: null, index: expect.stringMatching(/^[0-9a-f]{64}$/) });
      if (!key) throw new Error("no key");
      const id = await ensureCreditAccount(trx, c, key);
      const adjusted = await adjustCredit(trx, c, {
        accountId: id,
        amount: 5_000,
        reason: "goodwill",
        idempotencyKey: `seal-adjust:${run}`,
      });
      expect(adjusted.kind).toBe("applied");
      return id;
    });
    const [account] = await admin<
      { customer_email: string | null; customer_email_index: string }[]
    >`
      select customer_email, customer_email_index from public.credit_accounts where id = ${accountId}`;
    expect(account?.customer_email).toBeNull();
    expect(account?.customer_email_index).toEqual(
      (await stored(first.checkoutSessionId)).booker_email_index,
    );

    // The same address on another booking finds the same account.
    const found = await as(ctx, (trx) => creditAccountForBooking(trx, A.id, second.bookingId));
    expect(found?.id).toBe(accountId);
    expect(found?.balance).toBe(5_000);
    expect(
      await as(ctx, (trx) => creditAccountForBooking(trx, A.id, stranger.bookingId)),
    ).toBeNull();

    // Redeeming on the booker's own booking works; on a stranger's, the database refuses.
    const redeemed = await as(ctx, (trx, c) =>
      redeemCredit(trx, c, {
        accountId,
        bookingId: second.bookingId,
        amount: 1_000,
        idempotencyKey: `seal-redeem:${run}`,
      }),
    );
    expect(redeemed.kind).toBe("applied");
    const wrong = await as(ctx, (trx, c) =>
      redeemCredit(trx, c, {
        accountId,
        bookingId: stranger.bookingId,
        amount: 1_000,
        idempotencyKey: `seal-redeem-wrong:${run}`,
      }),
    ).catch((e: unknown) => e);
    expect(wrong).toBeInstanceOf(Error);
  });

  it("refuses to write a booker where sealing is required and no keyring is set", async () => {
    const strict = createDb(env?.runtimeUrl ?? "", { max: 1 });
    bindFieldPolicy(strict.db, { keyring: async () => undefined, required: true });
    try {
      const quote = await quoteFor(strict.db, A.id, tripsA.shared(), 1);
      const err = await as(
        guestContext(A.id),
        (trx, c) =>
          createCheckoutSession(trx, c, {
            quoteId: quote.quoteId,
            acceptedPolicyVersion: quote.policy.version,
            booker: { name: "No Keys", email: "no-keys@example.test" },
            secret: newSecret(),
            clientAddress: null,
            provider: "fake",
            minimumAmount: FAKE_MINIMUM_AMOUNT,
          }),
        strict.db,
      ).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(FieldKeyringError);
    } finally {
      await strict.end();
    }
  });

  it("writes plain where the handle has no keyring, as local and preview do", async () => {
    const plainPayments = fakeProvider(plain.db);
    const booked = await confirmBooking(plain.db, plainPayments, A, tripsA.shared(), 1, {
      booker: { name: "Pat Plain", email: "pat.plain@example.test" },
    });
    expect(await stored(booked.checkoutSessionId)).toMatchObject({
      booker_name: "Pat Plain",
      booker_email: "pat.plain@example.test",
      booker_sealed: null,
      booker_email_index: null,
      booker_name_index: null,
    });
    // The sealed handle reads a plain row as it is.
    const detail = await as(staffContext(A.id), (trx) =>
      getBookingDetail(trx, A.id, booked.bookingId, { withBooker: true }),
    );
    expect(detail?.booker).toEqual({ name: "Pat Plain", email: "pat.plain@example.test" });
  });

  it("clears a sealed booker and its tokens when retention redacts an abandoned checkout", async () => {
    const quote = await quoteFor(sealed.db, A.id, tripsA.shared(), 1);
    const created = await as(guestContext(A.id), (trx, c) =>
      createCheckoutSession(trx, c, {
        quoteId: quote.quoteId,
        acceptedPolicyVersion: quote.policy.version,
        booker: { name: "Gone Sealed", email: `gone-${randomUUID().slice(0, 8)}@example.test` },
        secret: newSecret(),
        clientAddress: null,
        provider: "fake",
        minimumAmount: FAKE_MINIMUM_AMOUNT,
      }),
    );
    if (created.kind !== "created") throw new Error(JSON.stringify(created));
    const ready = await ensureProviderPayment(
      sealed.db,
      payments,
      guestContext(A.id),
      created.session.id,
    );
    if (ready.kind !== "ready") throw new Error(JSON.stringify(ready));
    await backdateCheckout(admin, created.session.id);
    await sweepCheckouts(sealed.db, { runId: `seal-${randomUUID()}`, provider: payments });
    await admin.begin(async (tx) => {
      await tx`set local session_replication_role = replica`;
      await tx`update public.checkout_sessions
                  set expired_at = expired_at - interval '40 days'
                where id = ${created.session.id}`;
    });
    expect((await stored(created.session.id)).booker_sealed).not.toBeNull();
    await sql`select * from app.retention_redact_abandoned_checkouts(30, 5000)`.execute(sealed.db);
    expect(await stored(created.session.id)).toMatchObject({
      booker_name: "Redacted",
      booker_email: "redacted@redacted.invalid",
      booker_sealed: null,
      booker_email_index: null,
      booker_name_index: null,
    });
    expect((await stored(created.session.id)).booker_redacted_at).not.toBeNull();
  });
});
