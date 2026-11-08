import { randomUUID } from "node:crypto";
import { createDb, inTenantTransaction, type TenantContext } from "@tidegrid/database";
import type {} from "@tidegrid/database/global-setup";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";
import { UnverifiedProviderEventError } from "./inbox.ts";
import {
  createFakePaymentProvider,
  type FakePaymentProvider,
  recordProviderEvent,
} from "./index.ts";

type Sql = ReturnType<typeof postgres>;

const env = inject("integrationDb");
const secret = "payments-provenance-fake-secret-0123456789";

/**
 * The runtime brand against a real database (W1-PROVENANCE): a real event is
 * recorded, and a spread copy of it, which the compiler accepts, is refused
 * before any row is written, whatever it changes.
 */
describe.skipIf(!env)("the inbox refuses an unverified copy against a real database", () => {
  let admin: Sql;
  let runtime: ReturnType<typeof createDb>;
  let fake: FakePaymentProvider;
  let tenant: { id: string; account: string };

  const ctx = (tenantId: string): TenantContext => ({
    tenantId,
    actorType: "system",
    actorId: "provenance-test",
    requestId: `req-${randomUUID()}`,
  });

  beforeAll(async () => {
    if (!env) return;
    admin = postgres(env.adminUrl, { max: 2, onnotice: () => {} });
    runtime = createDb(env.runtimeUrl, { max: 4 });
    fake = createFakePaymentProvider({ db: runtime.db, secret, environment: "local" });
    const id = randomUUID();
    const slug = `prov-${id.slice(0, 8)}`;
    await admin`insert into public.tenants (id, slug, display_name) values (${id}, ${slug}, ${slug})`;
    const account = `acct_fake_${slug}`;
    await admin`insert into public.payment_accounts (tenant_id, provider, account_ref)
      values (${id}, 'fake', ${account})`;
    tenant = { id, account };
  });

  afterAll(async () => {
    await runtime?.end();
    await admin?.end({ timeout: 5 });
  });

  it("records the verified event and refuses its spread copies", async () => {
    const payment = await fake.createPayment({
      accountRef: tenant.account,
      amount: 5000,
      currency: "USD",
      idempotencyKey: `key:${randomUUID()}`,
      clientReference: randomUUID(),
    });
    const settled = await fake.settlePayment(
      tenant.id,
      payment.paymentRef,
      "succeeded",
      Date.now(),
    );
    if (settled.kind === "not_found") throw new Error("not found");
    const now = Date.now();
    const signature = await fake.signDelivery(settled.event.body, now);
    const checked = await fake.verifyWebhook({
      rawBody: settled.event.body,
      signatureHeader: signature.value,
      nowMs: now,
    });
    if (checked.kind !== "verified") throw new Error(checked.reason);
    const event = checked.event;
    const c = ctx(tenant.id);
    const rows = async (eventId: string) =>
      (
        await admin<{ n: number }[]>`
          select count(*)::int as n from public.provider_events
           where provider = 'fake' and event_id = ${eventId}`
      )[0]?.n;

    // A copy under a new event id, as if a second success had arrived.
    const newId = `fevt_${"Q".repeat(24)}`;
    const copies = [
      { ...event, eventId: newId },
      { ...event, eventId: newId, payment: event.payment && { ...event.payment, amount: 1 } },
      { ...event },
    ];
    for (const copy of copies) {
      await expect(
        inTenantTransaction(runtime.db, c, (trx) => recordProviderEvent(trx, c, copy)),
      ).rejects.toBeInstanceOf(UnverifiedProviderEventError);
    }
    expect(await rows(newId)).toBe(0);
    expect(await rows(event.eventId)).toBe(0);

    // The real event records, once.
    const first = await inTenantTransaction(runtime.db, c, (trx) =>
      recordProviderEvent(trx, c, event),
    );
    expect(first).toMatchObject({ duplicate: false, processingState: "received" });
    expect(await rows(event.eventId)).toBe(1);
    // A spread of it under its own id is still refused, not read as a duplicate.
    await expect(
      inTenantTransaction(runtime.db, c, (trx) =>
        recordProviderEvent(trx, c, { ...event, payloadSha256: "0".repeat(64) }),
      ),
    ).rejects.toBeInstanceOf(UnverifiedProviderEventError);
    const [row] = await admin<{ amount: number; payload_sha256: string }[]>`
      select amount, payload_sha256 from public.provider_events
       where provider = 'fake' and event_id = ${event.eventId}`;
    expect(row).toEqual({ amount: 5000, payload_sha256: event.payloadSha256 });
  });
});
