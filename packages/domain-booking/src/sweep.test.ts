import type { TenantContext } from "@tidegrid/database";
import { describe, expect, it } from "vitest";
import type { SettleRefundResult } from "./finalize.ts";
import {
  type CheckoutSweepOptions,
  type CheckoutSweepStore,
  type ExpireCheckoutsResult,
  runCheckoutSweep,
  type WindowQuery,
} from "./sweep.ts";

type CheckoutKind = "due" | "busy" | "inconsistent";
type EventKind = "ok" | "fails" | { refund: string };
type RefundOutcome = "succeeded" | "failed" | "unknown" | "throws" | "not_pending";

/**
 * The checkout sweep's store without a database: per tenant, open checkouts,
 * received events, and requested refunds, in age order. It honors the window
 * queries the way the SQL does, and logs every call.
 */
class FakeStore implements CheckoutSweepStore {
  readonly checkouts = new Map<string, { id: string; kind: CheckoutKind }[]>();
  readonly events = new Map<string, { id: string; kind: EventKind }[]>();
  readonly refunds = new Map<string, { id: string; outcome: RefundOutcome }[]>();
  readonly order: string[] = [];
  readonly stamped: string[] = [];
  readonly log: string[] = [];
  readonly sent: string[] = [];
  settleRefund: CheckoutSweepStore["settleRefund"];

  constructor(withProvider = true) {
    this.settleRefund = withProvider ? (ctx, id) => this.settle(ctx, id) : null;
  }

  tenant(id: string): this {
    this.order.push(id);
    return this;
  }

  async listTenants(limit: number): Promise<string[]> {
    return this.order.slice(0, limit);
  }

  async stamp(ctx: TenantContext): Promise<void> {
    this.stamped.push(ctx.tenantId);
  }

  async expire(ctx: TenantContext, limit: number): Promise<ExpireCheckoutsResult> {
    this.log.push(`expire:${ctx.tenantId}`);
    const open = this.checkouts.get(ctx.tenantId) ?? [];
    const batch = open.slice(0, limit);
    const result: ExpireCheckoutsResult = { expired: [], skipped: [], inconsistent: [] };
    for (const c of batch) {
      if (c.kind === "due") result.expired.push(c.id);
      else {
        result.skipped.push(c.id);
        if (c.kind === "inconsistent") result.inconsistent.push({ id: c.id, holdState: null });
      }
    }
    this.checkouts.set(
      ctx.tenantId,
      open.filter((c) => !result.expired.includes(c.id)),
    );
    return result;
  }

  async receivedEvents(ctx: TenantContext, query: WindowQuery): Promise<string[]> {
    return (this.events.get(ctx.tenantId) ?? [])
      .map((e) => e.id)
      .filter((id) => !query.excluding.includes(id))
      .slice(0, query.limit);
  }

  async processEvent(ctx: TenantContext, inboxId: string) {
    this.log.push(`event:${inboxId}`);
    const events = this.events.get(ctx.tenantId) ?? [];
    const event = events.find((e) => e.id === inboxId);
    if (!event) return null;
    if (event.kind === "fails") throw new Error(`event ${inboxId} fails`);
    this.events.set(
      ctx.tenantId,
      events.filter((e) => e.id !== inboxId),
    );
    if (typeof event.kind === "object") {
      const refunds = this.refunds.get(ctx.tenantId) ?? [];
      refunds.push({ id: event.kind.refund, outcome: "succeeded" });
      this.refunds.set(ctx.tenantId, refunds);
      return { refundId: event.kind.refund };
    }
    return { refundId: null };
  }

  async requestedRefunds(ctx: TenantContext, query: WindowQuery): Promise<string[]> {
    return (this.refunds.get(ctx.tenantId) ?? [])
      .map((r) => r.id)
      .filter((id) => !query.excluding.includes(id))
      .slice(0, query.limit);
  }

  private async settle(ctx: TenantContext, refundId: string): Promise<SettleRefundResult> {
    this.sent.push(refundId);
    this.log.push(`refund:${refundId}`);
    const refunds = this.refunds.get(ctx.tenantId) ?? [];
    const refund = refunds.find((r) => r.id === refundId);
    if (!refund) return { kind: "not_pending" };
    if (refund.outcome === "throws") throw new Error(`refund ${refundId} fails`);
    if (refund.outcome === "unknown") return { kind: "unknown" };
    this.refunds.set(
      ctx.tenantId,
      refunds.filter((r) => r.id !== refundId),
    );
    if (refund.outcome === "not_pending") return { kind: "not_pending" };
    return refund.outcome === "succeeded"
      ? { kind: "succeeded", providerRefundId: `re_${refundId}` }
      : { kind: "failed", failureCode: "declined" };
  }
}

const A = "00000000-0000-4000-8000-00000000000a";
const B = "ffffffff-ffff-4fff-bfff-00000000000b";
const ids = (prefix: string, n: number) => Array.from({ length: n }, (_, i) => `${prefix}${i}`);

async function sweep(store: FakeStore, options: Partial<CheckoutSweepOptions> = {}) {
  const errors: string[] = [];
  const turns: string[] = [];
  const report = await runCheckoutSweep(store, {
    runId: "run-1",
    graceSeconds: 0,
    budgetMs: 60_000,
    onError: (tenantId, item, _error, id) => errors.push(`${tenantId}:${item}:${id ?? ""}`),
    onTurnStart: (tenantId, pass) => turns.push(`${tenantId}@${pass}`),
    ...options,
  });
  return { report, errors, turns };
}

describe("the checkout sweep's turns", () => {
  it("serves the second tenant's expiry before the first tenant's second batch", async () => {
    const store = new FakeStore().tenant(A).tenant(B);
    store.checkouts.set(
      A,
      ids("a", 5).map((id) => ({ id, kind: "due" })),
    );
    store.checkouts.set(B, [{ id: "b0", kind: "due" }]);
    const { report, turns } = await sweep(store, { batchSize: 2 });
    expect(turns).toEqual([`${A}@1`, `${B}@1`, `${A}@2`, `${A}@3`]);
    expect(store.log.filter((l) => l.startsWith("expire"))).toEqual([
      `expire:${A}`,
      `expire:${B}`,
      `expire:${A}`,
      `expire:${A}`,
    ]);
    expect(report).toMatchObject({ tenants: 2, expired: 6, turns: 4, passes: 3, complete: true });
    expect(store.stamped).toEqual([A, B, A]);
  });

  it("ends the expiry step on a full batch of skipped checkouts", async () => {
    const store = new FakeStore().tenant(A);
    store.checkouts.set(A, [
      { id: "busy0", kind: "busy" },
      { id: "busy1", kind: "busy" },
    ]);
    const { report } = await sweep(store, { batchSize: 2 });
    expect(store.log).toEqual([`expire:${A}`]);
    expect(report).toMatchObject({ expired: 0, skipped: 2, turns: 1, complete: true });
  });

  it("reports an inconsistent checkout once a run, and counts each skipped checkout once", async () => {
    const store = new FakeStore().tenant(A);
    store.checkouts.set(A, [
      { id: "bad", kind: "inconsistent" },
      { id: "busy", kind: "busy" },
      ...ids("due", 4).map((id) => ({ id, kind: "due" as const })),
    ]);
    const { report, errors } = await sweep(store, { batchSize: 3 });
    // Batches: bad, busy, due0; bad, busy, due1; ... until one expires nothing new.
    expect(report.expired).toBe(4);
    expect(report.skipped).toBe(2);
    expect(errors).toEqual([`${A}:checkouts:bad`]);
    // An inconsistent checkout is reported, not a failure.
    expect(report.complete).toBe(true);
  });

  it("processes a healthy event behind ten that always fail, and counts each failure once", async () => {
    const store = new FakeStore().tenant(A);
    store.events.set(A, [
      ...ids("bad", 12).map((id) => ({ id, kind: "fails" as const })),
      { id: "good", kind: "ok" },
    ]);
    const { report, errors } = await sweep(store);
    expect(store.log).toContain("event:good");
    expect(report).toMatchObject({ reprocessed: 1, failedEvents: 12, complete: false });
    expect(errors.filter((e) => e.includes(":inbox_event:"))).toHaveLength(12);
    // Each event attempted once in the run.
    expect(store.log.filter((l) => l.startsWith("event:"))).toHaveLength(13);
  });

  it("counts eleven requested refunds without a provider as pending once each, over several passes", async () => {
    const store = new FakeStore(false).tenant(A);
    store.refunds.set(
      A,
      ids("r", 11).map((id) => ({ id, outcome: "unknown" as const })),
    );
    // Enough events to keep the tenant's turns going for several passes.
    store.events.set(
      A,
      ids("e", 35).map((id) => ({ id, kind: "ok" as const })),
    );
    const { report } = await sweep(store);
    expect(report.passes).toBeGreaterThanOrEqual(4);
    expect(report).toMatchObject({ reprocessed: 35, refundsPending: 11, refundsSettled: 0 });
    expect(store.sent).toEqual([]);
  });

  it("sends a refund whose answer is unknown once a run, and counts it pending once", async () => {
    const store = new FakeStore().tenant(A);
    store.refunds.set(A, [
      { id: "lost", outcome: "unknown" },
      ...ids("ok", 14).map((id) => ({ id, outcome: "succeeded" as const })),
    ]);
    const { report } = await sweep(store);
    expect(store.sent.filter((id) => id === "lost")).toHaveLength(1);
    expect(report).toMatchObject({ refundsSettled: 14, refundsPending: 1, passes: 2 });
  });

  it("counts a refund that throws as failed and pending, once", async () => {
    const store = new FakeStore().tenant(A);
    store.refunds.set(A, [
      { id: "bug", outcome: "throws" },
      { id: "fine", outcome: "succeeded" },
    ]);
    const { report, errors } = await sweep(store);
    expect(report).toMatchObject({
      refundsSettled: 1,
      refundsPending: 1,
      failedRefunds: 1,
      complete: false,
    });
    expect(errors).toEqual([`${A}:refund:bug`]);
  });

  it("settles a refund that a later pass's event requests", async () => {
    const store = new FakeStore().tenant(A);
    store.events.set(A, [
      ...ids("e", 10).map((id) => ({ id, kind: "ok" as const })),
      { id: "late", kind: { refund: "from-late" } },
    ]);
    const { report } = await sweep(store);
    expect(store.sent).toEqual(["from-late"]);
    expect(report).toMatchObject({
      reprocessed: 11,
      refundsSettled: 1,
      refundsPending: 0,
      complete: true,
    });
  });

  it("serves the second tenant's events and refunds before the first tenant's second quantum", async () => {
    const store = new FakeStore().tenant(A).tenant(B);
    store.events.set(
      A,
      ids("ae", 3).map((id) => ({ id, kind: "ok" as const })),
    );
    store.refunds.set(
      A,
      ids("ar", 3).map((id) => ({ id, outcome: "succeeded" as const })),
    );
    store.events.set(B, [{ id: "be", kind: "ok" }]);
    store.refunds.set(B, [{ id: "br", outcome: "succeeded" }]);
    const { turns } = await sweep(store, { turnItems: 1 });
    expect(turns.slice(0, 3)).toEqual([`${A}@1`, `${B}@1`, `${A}@2`]);
    expect(store.log.filter((l) => !l.startsWith("expire:")).slice(0, 5)).toEqual([
      "event:ae0",
      "refund:ar0",
      "event:be",
      "refund:br",
      "event:ae1",
    ]);
  });

  it("starts no turn with a zero budget", async () => {
    const store = new FakeStore().tenant(A);
    store.checkouts.set(A, [{ id: "a", kind: "due" }]);
    const { report } = await sweep(store, { budgetMs: 0 });
    expect(report).toMatchObject({ tenants: 0, turns: 0, deferredTenants: 1, complete: false });
    expect(store.log).toEqual([]);
    expect(store.stamped).toEqual([]);
  });

  it("counts refunds left unsent by the budget as pending, and is not complete", async () => {
    let now = 0;
    const store = new FakeStore().tenant(A);
    store.refunds.set(
      A,
      ids("r", 5).map((id) => ({ id, outcome: "succeeded" as const })),
    );
    const settle = store.settleRefund;
    store.settleRefund = async (ctx, id) => {
      now += 10;
      if (!settle) throw new Error("no provider");
      return settle(ctx, id);
    };
    const { report } = await sweep(store, { budgetMs: 25, clock: () => now });
    expect(store.sent).toEqual(["r0", "r1", "r2"]);
    expect(report).toMatchObject({ refundsSettled: 3, refundsPending: 2, complete: false });
  });

  it("reports a failed stamp as a stamp, and still takes the turn", async () => {
    const store = new FakeStore().tenant(A);
    store.checkouts.set(A, [{ id: "a", kind: "due" }]);
    store.stamp = async () => {
      throw new Error("stamp");
    };
    const { report, errors } = await sweep(store);
    expect(errors).toEqual([`${A}:stamp:`]);
    expect(report).toMatchObject({ expired: 1, failedTenants: 0, complete: true });
  });

  it("finishes the run, counting a failure once, when the onError observer throws", async () => {
    const store = new FakeStore().tenant(A).tenant(B);
    store.checkouts.set(B, [{ id: "b0", kind: "due" }]);
    store.expire = async (ctx, limit) => {
      if (ctx.tenantId === A) throw new Error("expiry fails");
      return FakeStore.prototype.expire.call(store, ctx, limit);
    };
    const report = await runCheckoutSweep(store, {
      runId: "run-1",
      graceSeconds: 0,
      onError: () => {
        throw new Error("observer");
      },
    });
    expect(report).toMatchObject({ tenants: 2, failedTenants: 1, expired: 1, complete: false });
  });

  it("refuses a turn size outside 1 to 1000", async () => {
    await expect(sweep(new FakeStore(), { turnItems: 0 })).rejects.toThrow(RangeError);
  });
});
