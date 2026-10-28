/**
 * Sweep fairness for the checkout sweep (pre-pilot hardening, item 5, Part A).
 * The shared test database holds other suites' tenants with due work, so the
 * tests that run the whole sweep assert relative facts among their own
 * tenants only: the order their turns start and the order their work was
 * written. The tests that count a report's fields run the same store over
 * their own tenants only. Each test builds fresh tenants, because stamps
 * outlive a test.
 */
import { randomUUID } from "node:crypto";
import { createDb, inTenantTransaction, type TenantContext } from "@tidegrid/database";
import type {} from "@tidegrid/database/global-setup";
import { tripAllocator } from "@tidegrid/domain-inventory/testing";
import {
  FAKE_MINIMUM_AMOUNT,
  type FakePaymentProvider,
  type PaymentProvider,
  ProviderUnavailableError,
  recordProviderEvent,
} from "@tidegrid/domain-payments";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";
import {
  cancelCheckoutSession,
  createCheckoutSession,
  ensureProviderPayment,
  handleVerifiedEvent,
  sweepCheckouts,
} from "./index.ts";
import { type CheckoutSweepStore, checkoutSweepStore, runCheckoutSweep } from "./sweep.ts";
import {
  backdateCheckout,
  type CheckoutFixture,
  craftedFakeEventBody,
  createCheckoutFixture,
  fakeProvider,
  guestContext,
  newSecret,
  quoteFor,
  verifiedFakeEvent,
} from "./test-fixtures.ts";

type Sql = ReturnType<typeof postgres>;

const env = inject("integrationDb");

describe.skipIf(!env)("the checkout sweep takes fair turns across tenants", () => {
  let admin: Sql;
  let rt: Sql;
  let runtime: ReturnType<typeof createDb>;
  let provider: FakePaymentProvider;
  const trips = new Map<string, ReturnType<typeof tripAllocator>>();

  const tenant = async (label: string) => {
    const t = await createCheckoutFixture(admin, runtime.db, label, { days: 6 });
    trips.set(t.id, tripAllocator(t));
    return t;
  };

  /** Two fresh tenants, the lower id first: the order before 0013 served it first. */
  async function pair(label: string): Promise<[CheckoutFixture, CheckoutFixture]> {
    const one = await tenant(`${label}-1`);
    const two = await tenant(`${label}-2`);
    return one.id < two.id ? [one, two] : [two, one];
  }

  /** An open checkout for one guest, with its provider payment created. */
  async function checkout(t: CheckoutFixture) {
    const tripId = trips.get(t.id)?.shared() ?? "";
    const quote = await quoteFor(runtime.db, t.id, tripId, 1, { promotionCode: t.promotionCode });
    const secret = newSecret();
    const ctx = guestContext(t.id);
    const created = await inTenantTransaction(runtime.db, ctx, (trx) =>
      createCheckoutSession(trx, ctx, {
        quoteId: quote.quoteId,
        acceptedPolicyVersion: quote.policy.version,
        booker: { name: "Fair Booker", email: "fair@example.test" },
        secret,
        clientAddress: null,
        provider: "fake",
        minimumAmount: FAKE_MINIMUM_AMOUNT,
      }),
    );
    if (created.kind !== "created") throw new Error(`checkout: ${JSON.stringify(created)}`);
    const ready = await ensureProviderPayment(
      runtime.db,
      provider,
      guestContext(t.id),
      created.session.id,
    );
    if (ready.kind !== "ready") throw new Error(`payment: ${JSON.stringify(ready)}`);
    return { sessionId: created.session.id, secret, paymentRef: ready.paymentRef };
  }

  /** `n` open checkouts past their instant. */
  async function lapsed(t: CheckoutFixture, n: number): Promise<string[]> {
    const ids: string[] = [];
    for (let i = 0; i < n; i++) {
      const { sessionId } = await checkout(t);
      await backdateCheckout(admin, sessionId);
      ids.push(sessionId);
    }
    return ids;
  }

  /** `n` inbox events recorded and never processed, of a kind the processor ignores. */
  async function received(t: CheckoutFixture, n: number): Promise<string[]> {
    const ids: string[] = [];
    for (let i = 0; i < n; i++) {
      const body = craftedFakeEventBody({
        type: "refund.updated",
        accountRef: t.accountRef,
        paymentRef: "fpay_unused",
        amount: 0,
        clientReference: null,
      });
      const event = await verifiedFakeEvent(provider, body);
      const ctx: TenantContext = {
        tenantId: t.id,
        actorType: "system",
        actorId: "fake-webhook",
        requestId: `wh-${randomUUID()}`,
      };
      const recorded = await inTenantTransaction(runtime.db, ctx, (trx) =>
        recordProviderEvent(trx, ctx, event),
      );
      ids.push(recorded.inboxId);
    }
    return ids;
  }

  /** The fake behind a stand-in whose refunds never answer. */
  const silent = (): PaymentProvider => ({
    name: provider.name,
    signatureHeader: provider.signatureHeader,
    minimumAmount: (c) => provider.minimumAmount(c),
    createPayment: (i) => provider.createPayment(i),
    retrievePayment: (i) => provider.retrievePayment(i),
    verifyWebhook: (i) => provider.verifyWebhook(i),
    refundPayment: async () => {
      throw new ProviderUnavailableError("no answer");
    },
  });

  /** `n` refunds requested and never answered: a guest canceled, then the payment succeeded. */
  async function requested(t: CheckoutFixture, n: number): Promise<string[]> {
    const ids: string[] = [];
    for (let i = 0; i < n; i++) {
      const { sessionId, secret, paymentRef } = await checkout(t);
      const ctx = guestContext(t.id);
      await inTenantTransaction(runtime.db, ctx, (trx) =>
        cancelCheckoutSession(trx, ctx, { sessionId, secret }),
      );
      const settled = await provider.settlePayment(t.id, paymentRef, "succeeded", Date.now());
      if (settled.kind === "not_found") throw new Error("no fake payment");
      const handled = await handleVerifiedEvent(
        runtime.db,
        silent(),
        await verifiedFakeEvent(provider, settled.event.body),
        { requestId: `wh-${randomUUID()}` },
      );
      if (handled.kind !== "processed" || handled.outcome !== "refund_required") {
        throw new Error(`expected a refund, got ${JSON.stringify(handled)}`);
      }
      const [r] = await admin<{ id: string }[]>`
        select r.id from public.payment_refunds r
          join public.payments p on p.id = r.payment_id
         where p.checkout_session_id = ${sessionId} and r.state = 'requested'`;
      if (!r) throw new Error("no requested refund");
      ids.push(r.id);
    }
    return ids;
  }

  /** The whole sweep, over every due tenant in the database, recording our tenants' turns. */
  async function sweep(
    ours: readonly string[],
    options: { batchSize?: number; turnItems?: number },
  ) {
    const runId = `fair-${randomUUID()}`;
    const turns: string[] = [];
    const report = await sweepCheckouts(runtime.db, {
      runId,
      provider,
      graceSeconds: 0,
      tenantLimit: 1000,
      budgetMs: 60_000,
      ...options,
      onTurnStart: (tenantId, pass) => {
        if (ours.includes(tenantId)) turns.push(`${tenantId}@${pass}`);
      },
    });
    return { runId, turns, report };
  }

  /** Audit subjects this run wrote with `action`, in the order it wrote them. */
  const written = async (runId: string, action: string, subjects: readonly string[]) =>
    (
      await admin<{ subject_id: string }[]>`
        select subject_id from public.audit_events
         where action = ${action} and request_id = ${runId} and subject_id in ${admin(subjects)}
         order by id`
    ).map((r) => r.subject_id);

  const listed = async (ours: readonly string[]) =>
    (await rt<{ tenant_id: string }[]>`select tenant_id from app.checkout_sweep_tenants(1000, 0)`)
      .map((r) => r.tenant_id)
      .filter((id) => ours.includes(id));

  /** The database store, limited to `ours`, with faults injected where asked. */
  const store = (
    ours: readonly string[],
    overrides: Partial<CheckoutSweepStore> = {},
    withProvider = true,
  ): CheckoutSweepStore => {
    const real = checkoutSweepStore(runtime.db, withProvider ? provider : null, undefined);
    return {
      ...real,
      listTenants: async (limit, grace) =>
        (await real.listTenants(1000, grace)).filter((id) => ours.includes(id)).slice(0, limit),
      ...overrides,
    };
  };

  beforeAll(async () => {
    if (!env) return;
    admin = postgres(env.adminUrl, { max: 2, onnotice: () => {} });
    rt = postgres(env.runtimeUrl, { max: 2, onnotice: () => {} });
    runtime = createDb(env.runtimeUrl, { max: 4 });
    provider = fakeProvider(runtime.db);
  });

  afterAll(async () => {
    await runtime?.end();
    await rt?.end({ timeout: 5 });
    await admin?.end({ timeout: 5 });
  });

  it("expires the high-id tenant's checkout before the low-id tenant's second batch", async () => {
    const [hog, victim] = await pair("fair-expiry");
    const hogs = await lapsed(hog, 3);
    const [mine] = await lapsed(victim, 1);
    const { runId, turns } = await sweep([hog.id, victim.id], { batchSize: 1 });
    // Before 0013 the hog's three checkouts were all expired first.
    expect(await written(runId, "checkout.session_expired", [...hogs, mine ?? ""])).toEqual([
      hogs[0],
      mine,
      hogs[1],
      hogs[2],
    ]);
    expect(turns.slice(0, 3)).toEqual([`${hog.id}@1`, `${victim.id}@1`, `${hog.id}@2`]);
  });

  it("processes the high-id tenant's event before the low-id tenant's second", async () => {
    const [hog, victim] = await pair("fair-inbox");
    const hogs = await received(hog, 3);
    const [mine] = await received(victim, 1);
    const { turns, report } = await sweep([hog.id, victim.id], { turnItems: 1 });
    expect(report.reprocessed).toBeGreaterThanOrEqual(4);
    const order = await admin<{ id: string }[]>`
      select id from public.provider_events
       where id in ${admin([...hogs, mine ?? ""])} and processing_state = 'processed'
       order by processed_at, id`;
    expect(order.map((r) => r.id)).toEqual([hogs[0], mine, hogs[1], hogs[2]]);
    expect(turns.slice(0, 3)).toEqual([`${hog.id}@1`, `${victim.id}@1`, `${hog.id}@2`]);
  });

  it("settles the high-id tenant's refund before the low-id tenant's second", async () => {
    const [hog, victim] = await pair("fair-refund");
    const hogs = await requested(hog, 2);
    const [mine] = await requested(victim, 1);
    const { runId, turns } = await sweep([hog.id, victim.id], { turnItems: 1 });
    expect(await written(runId, "payment_refund.succeeded", [...hogs, mine ?? ""])).toEqual([
      hogs[0],
      mine,
      hogs[1],
    ]);
    expect(turns.slice(0, 3)).toEqual([`${hog.id}@1`, `${victim.id}@1`, `${hog.id}@2`]);
  });

  it("moves a tenant whose expiry always fails behind a tenant it has never served", async () => {
    const [poison, other] = await pair("fair-poison");
    await lapsed(poison, 1);
    const errors: string[] = [];
    const failing = store([poison.id, other.id], {
      expire: async () => {
        throw new Error("poison");
      },
    });
    const first = await runCheckoutSweep(failing, {
      runId: `fair-${randomUUID()}`,
      graceSeconds: 0,
      onError: (tenantId, item) => errors.push(`${tenantId}:${item}`),
    });
    expect(first).toMatchObject({ tenants: 1, failedTenants: 1, complete: false });
    expect(errors).toEqual([`${poison.id}:checkouts`]);
    // Before 0013 the lower id led every run while its work kept failing.
    await lapsed(other, 1);
    expect(await listed([poison.id, other.id])).toEqual([other.id, poison.id]);
  });

  it("counts each event and refund once a run, over several passes, on the database", async () => {
    const t = await tenant("fair-once");
    const refunds = await requested(t, 2);
    const events = await received(t, 4);
    const bad = events[1] ?? "";
    const real = checkoutSweepStore(runtime.db, null, undefined);
    const errors: string[] = [];
    const report = await runCheckoutSweep(
      store(
        [t.id],
        {
          processEvent: async (ctx, inboxId) => {
            if (inboxId === bad) throw new Error("always fails");
            return real.processEvent(ctx, inboxId);
          },
        },
        false,
      ),
      {
        runId: `fair-${randomUUID()}`,
        graceSeconds: 0,
        turnItems: 1,
        onError: (_tenantId, item, _error, id) => errors.push(`${item}:${id ?? ""}`),
      },
    );
    expect(report.passes).toBeGreaterThanOrEqual(4);
    expect(report).toMatchObject({
      tenants: 1,
      reprocessed: 3,
      failedEvents: 1,
      refundsPending: 2,
      refundsSettled: 0,
    });
    expect(errors).toEqual([`inbox_event:${bad}`]);
    const states = await admin<{ state: string }[]>`
      select state from public.payment_refunds where id in ${admin(refunds)}`;
    expect(states.map((s) => s.state)).toEqual(["requested", "requested"]);
  });
});
