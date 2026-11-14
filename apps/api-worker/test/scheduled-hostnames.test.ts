import { env } from "cloudflare:test";
import { createFakeHostnameProvider, HostnameSweepFault } from "@tidegrid/domain-hostnames";
import { describe, expect, it, vi } from "vitest";
import { runScheduled } from "../src/scheduled.ts";

// The earlier jobs succeed without the network; the hostname sweep hits an
// account-level refusal after one record it could not read.
// The outbox publisher and cleanup (W3-G2.3) run after the sweeps; env.test
// declares the queue. Here they report nothing to do.
vi.mock("@tidegrid/database", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@tidegrid/database")>()),
  publishOutbox: vi.fn(async () => ({
    tenants: 0,
    published: 0,
    resent: 0,
    deadLettered: 0,
    sendFailures: 0,
    failedTenants: 0,
    turns: 0,
    passes: 0,
    deferredTenants: 0,
    stampFailures: 0,
    stopped: false,
    complete: true,
  })),
  runDeliveryCleanup: vi.fn(async () => ({
    idempotencyKeysDeleted: 0,
    quotesDeleted: 0,
    dockLookupsDeleted: 0,
    dockLookupsRedacted: 0,
  })),
}));
vi.mock("@tidegrid/domain-inventory", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@tidegrid/domain-inventory")>()),
  sweepExpiredHolds: vi.fn(async () => ({
    tenants: 0,
    expired: 0,
    failedTenants: 0,
    complete: true,
  })),
}));
vi.mock("@tidegrid/domain-booking", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@tidegrid/domain-booking")>()),
  sweepCheckouts: vi.fn(async () => ({
    tenants: 0,
    expired: 0,
    skipped: 0,
    reprocessed: 0,
    refundsSettled: 0,
    refundsPending: 0,
    failedTenants: 0,
    failedEvents: 0,
    failedRefunds: 0,
    complete: true,
  })),
  sweepReconciliation: vi.fn(async () => ({
    tenants: 0,
    assessed: 0,
    invoiced: 0,
    paymentsChecked: 0,
    paymentsRaised: 0,
    failedTenants: 0,
    complete: true,
  })),
}));
// Retention (W3-G2.2b) runs last and touches no network here.
vi.mock("@tidegrid/domain-identity", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@tidegrid/domain-identity")>()),
  redactAbandonedCheckouts: vi.fn(async () => ({ tenants: 0, redacted: 0, complete: true })),
}));
vi.mock("@tidegrid/domain-hostnames", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@tidegrid/domain-hostnames")>();
  return {
    ...actual,
    sweepHostnames: vi.fn(async (_db, options) => {
      options.onUnread?.("tenant-1", "fake-ch-0007", "malformed_response");
      options.onTenantError?.(
        "tenant-2",
        new actual.HostnameSweepFault("http_401", "fake-ch-0009"),
      );
      return {
        tenants: 2,
        checked: 1,
        demoted: 0,
        expired: 0,
        failedTenants: 1,
        throttled: false,
        retryAfterSeconds: null,
        providerFault: "http_401",
        providerFaultHostnameId: "fake-ch-0009",
        unread: 1,
        complete: false,
      };
    }),
  };
});

describe("hostname sweep logs (G2.14b)", () => {
  it("names the refusal code and the provider record, so a rotated token reads apart from one bad record", async () => {
    const lines: string[] = [];
    await runScheduled(
      { cron: "*/15 * * * *" },
      {
        ...env,
        ENVIRONMENT: "local",
        HOSTNAME_PROVIDER: "fake",
        DATABASE_URL: "postgres://nobody:nothing@127.0.0.1:1/none",
      },
      { log: (line) => lines.push(line), hostnameProvider: createFakeHostnameProvider() },
    );
    const logged = lines.map((line) => JSON.parse(line));
    expect(logged).toContainEqual(
      expect.objectContaining({
        message: "hostname_sweep_unread",
        "tidegrid.hostname.refusal_code": "malformed_response",
        "tidegrid.hostname.provider_hostname_id": "fake-ch-0007",
      }),
    );
    expect(logged).toContainEqual(
      expect.objectContaining({
        message: "hostname_sweep_tenant_failed",
        "error.type": "HostnameSweepFault",
        "tidegrid.hostname.refusal_code": "http_401",
        "tidegrid.hostname.provider_hostname_id": "fake-ch-0009",
      }),
    );
    expect(logged).toContainEqual(
      expect.objectContaining({
        message: "hostname_sweep",
        "tidegrid.hostname_sweep.provider_fault": "http_401",
        "tidegrid.hostname_sweep.unread_count": 1,
      }),
    );
    expect(lines.join("\n")).not.toContain("nothing@");
    expect(HostnameSweepFault).toBeDefined();
  });
});
