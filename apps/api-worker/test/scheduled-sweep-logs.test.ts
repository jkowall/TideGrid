import { env } from "cloudflare:test";
import { createFakeHostnameProvider } from "@tidegrid/domain-hostnames";
import { describe, expect, it, vi } from "vitest";
import { runScheduled } from "../src/scheduled.ts";

// The four sweeps report full reports with distinct counts, and each meets
// one failed stamp, as the domain contract reports it: to onStampError, or to
// onTenantError without it (hold, email, hostname), and as item "stamp" to the
// checkout sweep's onError. No job touches the network.
const run = vi.hoisted(() => ({ accountFault: true, retryAfterSeconds: 47 as number | null }));

vi.mock("@tidegrid/domain-inventory", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@tidegrid/domain-inventory")>()),
  sweepExpiredHolds: vi.fn(async (_db, options) => {
    (options.onStampError ?? options.onTenantError)?.("hold-tenant", new Error("stamp"));
    return {
      tenants: 3,
      expired: 4,
      failedTenants: 0,
      complete: false,
      turns: 11,
      passes: 12,
      deferredTenants: 13,
      stampFailures: 14,
    };
  }),
}));
vi.mock("@tidegrid/domain-booking", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@tidegrid/domain-booking")>()),
  sweepCheckouts: vi.fn(async (_db, options) => {
    options.onError?.("checkout-tenant", "stamp", new Error("stamp"));
    return {
      tenants: 2,
      expired: 1,
      skipped: 0,
      reprocessed: 0,
      refundsSettled: 0,
      refundsPending: 0,
      failedTenants: 0,
      failedEvents: 0,
      failedRefunds: 0,
      complete: false,
      turns: 21,
      passes: 22,
      deferredTenants: 23,
      stampFailures: 24,
    };
  }),
}));
vi.mock("@tidegrid/domain-messaging", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@tidegrid/domain-messaging")>()),
  sweepEmail: vi.fn(async (_db, options) => {
    (options.onStampError ?? options.onTenantError)?.("email-tenant", new Error("stamp"));
    return {
      tenants: 5,
      claimed: 6,
      sent: 6,
      retried: 0,
      failed: 0,
      canceled: 0,
      superseded: 0,
      failedTenants: 0,
      complete: false,
      accountFault: run.accountFault,
      turns: 31,
      passes: 32,
      deferredTenants: 33,
      stampFailures: 34,
    };
  }),
}));
vi.mock("@tidegrid/domain-hostnames", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@tidegrid/domain-hostnames")>()),
  sweepHostnames: vi.fn(async (_db, options) => {
    (options.onStampError ?? options.onTenantError)?.("hostname-tenant", new Error("stamp"));
    return {
      tenants: 7,
      checked: 8,
      demoted: 0,
      expired: 1,
      failedTenants: 0,
      throttled: run.retryAfterSeconds !== null,
      retryAfterSeconds: run.retryAfterSeconds,
      providerFault: null,
      providerFaultHostnameId: null,
      unread: 0,
      complete: false,
      turns: 41,
      passes: 42,
      deferredTenants: 43,
      stampFailures: 44,
      expiryOnlyTurns: 45,
      providerCalls: 46,
    };
  }),
}));

/** One cron run with every job on, as parsed log lines. */
async function cronRun(): Promise<{ logged: Record<string, unknown>[]; raw: string }> {
  const lines: string[] = [];
  await runScheduled(
    { cron: "*/15 * * * *" },
    {
      ...env,
      ENVIRONMENT: "local",
      EMAIL_PROVIDER: "fake",
      HOSTNAME_PROVIDER: "fake",
      DATABASE_URL: "postgres://nobody:nothing@127.0.0.1:1/none",
    },
    { log: (line) => lines.push(line), hostnameProvider: createFakeHostnameProvider() },
  );
  return { logged: lines.map((line) => JSON.parse(line)), raw: lines.join("\n") };
}

const line = (logged: Record<string, unknown>[], message: string) =>
  logged.find((l) => l.message === message);

describe("sweep logs (pre-pilot hardening, Part E)", () => {
  it("logs a failed stamp as a stamp failure, never as a tenant failure", async () => {
    run.accountFault = false;
    run.retryAfterSeconds = null;
    const { logged, raw } = await cronRun();
    const messages = logged.map((l) => String(l.message));
    expect(messages.filter((m) => m.endsWith("_tenant_failed"))).toEqual([]);
    for (const [job, tenant] of [
      ["hold", "hold-tenant"],
      ["checkout", "checkout-tenant"],
      ["email", "email-tenant"],
      ["hostname", "hostname-tenant"],
    ]) {
      expect(line(logged, `${job}_sweep_stamp_failed`)).toMatchObject({
        level: "error",
        "tidegrid.tenant_id": tenant,
        "error.type": "Error",
      });
    }
    expect(raw).not.toContain("nothing@");
  });

  it("logs each sweep's turns, passes, deferred tenants, and stamp failures", async () => {
    run.accountFault = false;
    run.retryAfterSeconds = 47;
    const { logged, raw } = await cronRun();
    expect(line(logged, "hold_sweep")).toMatchObject({
      "tidegrid.hold_sweep.turn_count": 11,
      "tidegrid.hold_sweep.pass_count": 12,
      "tidegrid.hold_sweep.deferred_tenant_count": 13,
      "tidegrid.hold_sweep.stamp_failure_count": 14,
    });
    expect(line(logged, "checkout_sweep")).toMatchObject({
      "tidegrid.checkout_sweep.turn_count": 21,
      "tidegrid.checkout_sweep.pass_count": 22,
      "tidegrid.checkout_sweep.deferred_tenant_count": 23,
      "tidegrid.checkout_sweep.stamp_failure_count": 24,
    });
    expect(line(logged, "email_sweep")).toMatchObject({
      "tidegrid.email_sweep.turn_count": 31,
      "tidegrid.email_sweep.pass_count": 32,
      "tidegrid.email_sweep.deferred_tenant_count": 33,
      "tidegrid.email_sweep.stamp_failure_count": 34,
      "tidegrid.email_sweep.account_fault": false,
    });
    expect(line(logged, "hostname_sweep")).toMatchObject({
      "tidegrid.hostname_sweep.turn_count": 41,
      "tidegrid.hostname_sweep.pass_count": 42,
      "tidegrid.hostname_sweep.deferred_tenant_count": 43,
      "tidegrid.hostname_sweep.stamp_failure_count": 44,
      "tidegrid.hostname_sweep.expiry_only_turn_count": 45,
      "tidegrid.hostname_sweep.provider_call_count": 46,
      "tidegrid.hostname_sweep.retry_after_seconds": 47,
    });
    expect(raw).not.toContain("nothing@");
  });

  it("logs the email account fault on every summary, and the retry wait only when set", async () => {
    run.accountFault = true;
    run.retryAfterSeconds = 47;
    const faulted = (await cronRun()).logged;
    expect(line(faulted, "email_sweep")).toMatchObject({
      "tidegrid.email_sweep.account_fault": true,
    });
    expect(line(faulted, "hostname_sweep")).toMatchObject({
      "tidegrid.hostname_sweep.retry_after_seconds": 47,
    });

    run.accountFault = false;
    run.retryAfterSeconds = null;
    const quiet = (await cronRun()).logged;
    expect(line(quiet, "email_sweep")).toMatchObject({
      "tidegrid.email_sweep.account_fault": false,
    });
    expect(line(quiet, "hostname_sweep")).toBeDefined();
    expect(line(quiet, "hostname_sweep")).not.toHaveProperty(
      "tidegrid.hostname_sweep.retry_after_seconds",
    );
  });
});
