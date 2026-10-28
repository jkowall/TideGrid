import { randomUUID } from "node:crypto";
import { createDb, inTenantTransaction, type TenantContext } from "@tidegrid/database";
import type {} from "@tidegrid/database/global-setup";
import postgres from "postgres";
import { afterAll, beforeAll, describe, inject } from "vitest";
import { createFakePaymentProvider, type FakePaymentProvider } from "./fake.ts";
import { recordProviderEvent } from "./inbox.ts";
import {
  describePaymentProviderContract,
  type ProviderDelivery,
} from "./payment-provider.contract.ts";

type Sql = ReturnType<typeof postgres>;

const env = inject("integrationDb");
const secret = "payments-contract-fake-secret-0123456789";

// The fake resolves accounts in SQL, so its half of the contract needs a database.
describe.skipIf(!env)("the fake provider against the shared payment provider contract", () => {
  let admin: Sql;
  let runtime: ReturnType<typeof createDb>;
  let fake: FakePaymentProvider;
  const tenant = { id: "", account: "" };

  beforeAll(async () => {
    if (!env) return;
    admin = postgres(env.adminUrl, { max: 2, onnotice: () => {} });
    runtime = createDb(env.runtimeUrl, { max: 4 });
    fake = createFakePaymentProvider({ db: runtime.db, secret, environment: "local" });
    tenant.id = randomUUID();
    const slug = `contract-${tenant.id.slice(0, 8)}`;
    tenant.account = `acct_fake_${slug}`;
    // Test setup writes the account over the admin connection; the runtime only reads it.
    await admin`insert into public.tenants (id, slug, display_name) values (${tenant.id}, ${slug}, ${slug})`;
    await admin`insert into public.payment_accounts (tenant_id, provider, account_ref)
      values (${tenant.id}, 'fake', ${tenant.account})`;
  });

  afterAll(async () => {
    await runtime?.end();
    await admin?.end({ timeout: 5 });
  });

  const ctx = (): TenantContext => ({
    tenantId: tenant.id,
    actorType: "system",
    actorId: "payments-contract-test",
    requestId: `req-${randomUUID()}`,
  });

  async function settle(
    paymentRef: string,
    outcome: "succeeded" | "failed",
  ): Promise<ProviderDelivery> {
    const nowMs = Date.now();
    const settled = await fake.settlePayment(tenant.id, paymentRef, outcome, nowMs);
    if (settled.kind === "not_found") throw new Error("the fake payment was not found");
    const signature = await fake.signDelivery(settled.event.body, nowMs);
    return { rawBody: settled.event.body, signatureHeader: signature.value, nowMs };
  }

  describePaymentProviderContract("fake over a real database", () => ({
    provider: fake,
    accountRef: tenant.account,
    succeed: (paymentRef) => settle(paymentRef, "succeeded"),
    failFinally: (paymentRef) => settle(paymentRef, "failed"),
    async redeliver(delivery) {
      // The fake redelivers the stored bytes, signed afresh.
      const nowMs = delivery.nowMs + 60_000;
      const signature = await fake.signDelivery(delivery.rawBody, nowMs);
      return { rawBody: delivery.rawBody, signatureHeader: signature.value, nowMs };
    },
    async record(event) {
      const context = ctx();
      const recorded = await inTenantTransaction(runtime.db, context, (trx) =>
        recordProviderEvent(trx, context, event),
      );
      return { duplicate: recorded.duplicate, samePayload: recorded.samePayload };
    },
  }));
});
