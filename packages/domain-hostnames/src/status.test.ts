import { describe, expect, it } from "vitest";
import type { CertificateState, HostnameState } from "./provider.ts";
import {
  cloudflareCertificateStatuses,
  cloudflareHostnameStatuses,
  mapCloudflareCertificateStatus,
  mapCloudflareHostnameStatus,
} from "./status.ts";

// The packet's mapping, written out so that a changed row fails here.
const hostnameRows: [string, HostnameState][] = [
  ["active", "active"],
  ["active_redeploying", "active"],
  ["pending", "pending"],
  ["pending_migration", "pending"],
  ["pending_provisioned", "pending"],
  ["provisioned", "pending"],
  ["test_pending", "pending"],
  ["test_active", "unknown"],
  ["test_active_apex", "unknown"],
  ["test_blocked", "blocked"],
  ["test_failed", "unknown"],
  ["moved", "moved"],
  ["blocked", "blocked"],
  ["pending_blocked", "blocked"],
  ["pending_deletion", "deleted"],
  ["deleted", "deleted"],
];

const certificateRows: [string, CertificateState][] = [
  ["active", "active"],
  ["pending_expiration", "expiring"],
  ["initializing", "pending"],
  ["pending_validation", "pending"],
  ["pending_issuance", "pending"],
  ["pending_deployment", "pending"],
  ["staging_deployment", "pending"],
  ["staging_active", "pending"],
  ["holding_deployment", "pending"],
  ["backup_issued", "pending"],
  ["expired", "failed"],
  ["inactive", "failed"],
  ["deactivating", "failed"],
  ["deleted", "failed"],
  ["pending_deletion", "failed"],
  ["pending_cleanup", "failed"],
  ["initializing_timed_out", "failed"],
  ["validation_timed_out", "failed"],
  ["issuance_timed_out", "failed"],
  ["deployment_timed_out", "failed"],
  ["deletion_timed_out", "failed"],
];

const unlisted: unknown[] = [
  "",
  "ACTIVE",
  "active ",
  " active",
  "something_new",
  null,
  undefined,
  42,
  true,
  {},
  ["active"],
  "__proto__",
  "constructor",
  "toString",
  "hasOwnProperty",
];

describe("Cloudflare hostname status mapping", () => {
  it("lists exactly the expected statuses", () => {
    expect(Object.keys(cloudflareHostnameStatuses).sort()).toEqual(
      hostnameRows.map(([status]) => status).sort(),
    );
  });

  it.each(hostnameRows)("maps %s to %s", (status, state) => {
    expect(cloudflareHostnameStatuses[status]).toBe(state);
    expect(mapCloudflareHostnameStatus(status)).toBe(state);
  });

  it.each(unlisted.map((v) => [v]))("maps the unlisted value %j to unknown", (value) => {
    expect(mapCloudflareHostnameStatus(value)).toBe("unknown");
  });
});

describe("Cloudflare certificate status mapping", () => {
  it("lists exactly the expected statuses", () => {
    expect(Object.keys(cloudflareCertificateStatuses).sort()).toEqual(
      certificateRows.map(([status]) => status).sort(),
    );
  });

  it.each(certificateRows)("maps %s to %s", (status, state) => {
    expect(cloudflareCertificateStatuses[status]).toBe(state);
    expect(mapCloudflareCertificateStatus(status)).toBe(state);
  });

  it.each(unlisted.map((v) => [v]))("maps the unlisted value %j to unknown", (value) => {
    expect(mapCloudflareCertificateStatus(value)).toBe("unknown");
  });

  it("keeps every timed-out state failed", () => {
    for (const status of Object.keys(cloudflareCertificateStatuses)) {
      if (status.endsWith("_timed_out"))
        expect(mapCloudflareCertificateStatus(status)).toBe("failed");
    }
  });
});
