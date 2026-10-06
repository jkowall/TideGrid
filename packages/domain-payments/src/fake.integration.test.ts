import { randomUUID } from "node:crypto";
import { createDb, inTenantTransaction, type TenantContext } from "@tidegrid/database";
import type {} from "@tidegrid/database/global-setup";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";
import {
  createFakePaymentProvider,
  type FakePaymentProvider,
  ProviderRejectedError,
  recordProviderEvent,
  resolvePaymentAccount,
  type VerifiedProviderEvent,
} from "./index.ts";

type Sql = ReturnType<typeof postgres>;

const env = inject("integrationDb");
const secret = "payments-integration-fake-secret-0123456789";

describe.skipIf(!env)("the fake provider and the inbox against a real database", () => {
  let admin: Sql;
  let runtime: ReturnType<typeof createDb>;
  let fake: FakePaymentProvider;
  const tenants: { id: string; account: string }[] = [];

  const ctx = (tenantId: string): TenantContext => ({
    tenantId,
    actorType: "system",
    actorId: "payments-test",
    requestId: `req-${randomUUID()}`,
  });

  async function tenant(label: string) {
    const id = randomUUID();
    const slug = `${label}-${id.slice(0, 8)}`;
    await admin`insert into public.tenants (id, slug, display_name) values (${id}, ${slug}, ${slug})`;
    const account = `acct_fake_${slug}`;
    await admin`insert into public.payment_accounts (tenant_id, provider, account_ref)
      values (${id}, 'fake', ${account})`;
    return { id, account };
  }

  const create = (account: string, overrides: Partial<{ amount: number; key: string }> = {}) =>
    fake.createPayment({
      accountRef: account,
      amount: overrides.amount ?? 5000,
      currency: "USD",
      idempotencyKey: overrides.key ?? `key:${randomUUID()}`,
      clientReference: randomUUID(),
    });

  async function verified(body: string): Promise<VerifiedProviderEvent> {
    const now = Date.now();
    const signature = await fake.signDelivery(body, now);
    const checked = await fake.verifyWebhook({
      rawBody: body,
      signatureHeader: signature.value,
      nowMs: now,
    });
    if (checked.kind !== "verified") throw new Error(checked.reason);
    return checked.event;
  }

  async function rejection(p: Promise<unknown>): Promise<string> {
    try {
      await p;
    } catch (err) {
      if (err instanceof ProviderRejectedError) return err.code;
      throw err;
    }
    throw new Error("expected a refusal");
  }

  beforeAll(async () => {
    if (!env) return;
    admin = postgres(env.adminUrl, { max: 2, onnotice: () => {} });
    runtime = createDb(env.runtimeUrl, { max: 6 });
    fake = createFakePaymentProvider({ db: runtime.db, secret, environment: "local" });
    tenants.push(await tenant("pay-a"), await tenant("pay-b"));
  });

  afterAll(async () => {
    await runtime?.end();
    await admin?.end({ timeout: 5 });
  });

  it("creates one payment per idempotency key and refuses the key for another payment", async () => {
    const [a] = tenants;
    if (!a) throw new Error("no tenant");
    const key = `key:${randomUUID()}`;
    const clientReference = randomUUID();
    const input = {
      accountRef: a.account,
      amount: 4321,
      currency: "USD" as const,
      idempotencyKey: key,
      clientReference,
    };
    const [first, second] = await Promise.all([
      fake.createPayment(input),
      fake.createPayment(input),
    ]);
    expect(second?.paymentRef).toBe(first?.paymentRef);
    expect(second?.clientSecret).toBe(first?.clientSecret);
    expect(first).toMatchObject({ status: "pending", amount: 4321, amountRefunded: 0 });
    expect(await rejection(fake.createPayment({ ...input, amount: 4322 }))).toBe(
      "idempotency_key_reused",
    );
    expect(await rejection(create(a.account, { amount: 49 }))).toBe("amount_invalid");
    expect(await rejection(create("acct_fake_nobody"))).toBe("account_unknown");
  });

  it("settles a payment once, whichever outcome arrives first", async () => {
    const [a] = tenants;
    if (!a) throw new Error("no tenant");
    for (let round = 0; round < 3; round++) {
      const payment = await create(a.account);
      const now = Date.now();
      const results = await Promise.all([
        fake.settlePayment(a.id, payment.paymentRef, "succeeded", now),
        fake.settlePayment(a.id, payment.paymentRef, "failed", now),
        fake.settlePayment(a.id, payment.paymentRef, "succeeded", now),
      ]);
      const settled = results.filter((r) => r.kind === "settled");
      expect(settled).toHaveLength(1);
      const view = await fake.getPayment(a.id, payment.paymentRef);
      expect(view?.events).toHaveLength(1);
      const first = settled[0];
      if (first?.kind !== "settled") throw new Error("nothing settled");
      for (const r of results) {
        if (r.kind === "not_found") throw new Error("not found");
        expect(r.event.id).toBe(first.event.id);
      }
      expect(view?.status).toBe(first.event.type === "payment.succeeded" ? "succeeded" : "failed");
    }
  });

  it("refunds a paid payment once per key, never more than was paid", async () => {
    const [a] = tenants;
    if (!a) throw new Error("no tenant");
    const unpaid = await create(a.account, { amount: 1000 });
    const refund = (paymentRef: string, key: string, amount = 1000) =>
      fake.refundPayment({
        accountRef: a.account,
        paymentRef,
        amount,
        currency: "USD",
        idempotencyKey: key,
      });
    expect(await rejection(refund(unpaid.paymentRef, `rf:${randomUUID()}`))).toBe(
      "payment_not_succeeded",
    );
    const paid = await create(a.account, { amount: 1000 });
    await fake.settlePayment(a.id, paid.paymentRef, "succeeded", Date.now());
    const key = `rf:${randomUUID()}`;
    const [r1, r2] = await Promise.all([
      refund(paid.paymentRef, key),
      refund(paid.paymentRef, key),
    ]);
    expect(r2?.refundRef).toBe(r1?.refundRef);
    expect(await rejection(refund(paid.paymentRef, `rf:${randomUUID()}`, 1))).toBe(
      "amount_exceeds_payment",
    );
    expect((await fake.getPayment(a.id, paid.paymentRef))?.amountRefunded).toBe(1000);

    // Different keys racing for the full amount of another payment: one wins.
    const raced = await create(a.account, { amount: 1000 });
    await fake.settlePayment(a.id, raced.paymentRef, "succeeded", Date.now());
    const attempts = await Promise.allSettled(
      Array.from({ length: 4 }, () => refund(raced.paymentRef, `rf:${randomUUID()}`)),
    );
    expect(attempts.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect((await fake.getPayment(a.id, raced.paymentRef))?.amountRefunded).toBe(1000);
  });

  it("keeps each tenant's payments to itself", async () => {
    const [a, b] = tenants;
    if (!a || !b) throw new Error("no tenants");
    const payment = await create(a.account);
    expect(await fake.getPayment(b.id, payment.paymentRef)).toBeNull();
    expect(await fake.settlePayment(b.id, payment.paymentRef, "succeeded", Date.now())).toEqual({
      kind: "not_found",
    });
    expect(await fake.getPayment(a.id, payment.paymentRef)).toMatchObject({ status: "pending" });
    expect(await resolvePaymentAccount(runtime.db, "fake", a.account)).toEqual({
      tenantId: a.id,
      status: "active",
    });
    expect(await resolvePaymentAccount(runtime.db, "stripe", a.account)).toBeNull();
  });

  it("records an event once per id and notices a different body under the same id", async () => {
    const [a, b] = tenants;
    if (!a || !b) throw new Error("no tenants");
    const payment = await create(a.account);
    const settled = await fake.settlePayment(a.id, payment.paymentRef, "succeeded", Date.now());
    if (settled.kind === "not_found") throw new Error("not found");
    const event = await verified(settled.event.body);
    const record = (tenantId: string, e: VerifiedProviderEvent) => {
      const c = ctx(tenantId);
      return inTenantTransaction(runtime.db, c, (trx) => recordProviderEvent(trx, c, e));
    };
    const first = await record(a.id, event);
    expect(first).toMatchObject({ duplicate: false, processingState: "received" });
    expect(await record(a.id, event)).toMatchObject({
      duplicate: true,
      samePayload: true,
      inboxId: first.inboxId,
    });
    const altered = await verified(settled.event.body.replace('"usd"', '"usd" '));
    expect(await record(a.id, altered)).toMatchObject({ duplicate: true, samePayload: false });
    // Recording it in another tenant fails: the event names A's account.
    const other = await verified(
      settled.event.body.replace(settled.event.id, `fevt_${"Z".repeat(24)}`),
    );
    await expect(record(b.id, other)).rejects.toMatchObject({ code: "23503" });
    // Nobody may change a recorded event's content.
    await expect(
      admin`update public.provider_events set amount = amount + 1 where id = ${first.inboxId}`,
    ).rejects.toMatchObject({ code: "23514" });
  });
});
