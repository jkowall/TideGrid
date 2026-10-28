import type { CertificateState, HostnameState } from "./provider.ts";

/**
 * Cloudflare for SaaS status strings mapped to TideGrid's states. Exhaustive
 * and fail-closed: every value in the API reference has a row, and any value
 * Cloudflare adds later maps to `unknown`, which never serves and never
 * activates. Source: the custom hostnames API reference,
 * https://developers.cloudflare.com/api/resources/custom_hostnames/methods/create/,
 * and the validation status page,
 * https://developers.cloudflare.com/cloudflare-for-platforms/cloudflare-for-saas/domain-support/hostname-validation/validation-status/.
 */
export const cloudflareHostnameStatuses: Readonly<Record<string, HostnameState>> = {
  active: "active",
  active_redeploying: "active",
  pending: "pending",
  pending_migration: "pending",
  pending_provisioned: "pending",
  provisioned: "pending",
  test_pending: "pending",
  // Test states belong to a staging zone, never to production traffic.
  test_active: "unknown",
  test_active_apex: "unknown",
  test_blocked: "blocked",
  test_failed: "unknown",
  moved: "moved",
  blocked: "blocked",
  // Both a pending and a blocked state; the stricter reading wins.
  pending_blocked: "blocked",
  pending_deletion: "deleted",
  deleted: "deleted",
};

export const cloudflareCertificateStatuses: Readonly<Record<string, CertificateState>> = {
  active: "active",
  // A valid certificate close to expiry: servable, flagged (G2.14b, D10).
  pending_expiration: "expiring",
  initializing: "pending",
  pending_validation: "pending",
  pending_issuance: "pending",
  pending_deployment: "pending",
  staging_deployment: "pending",
  staging_active: "pending",
  holding_deployment: "pending",
  backup_issued: "pending",
  expired: "failed",
  inactive: "failed",
  deactivating: "failed",
  deleted: "failed",
  pending_deletion: "failed",
  pending_cleanup: "failed",
  initializing_timed_out: "failed",
  validation_timed_out: "failed",
  issuance_timed_out: "failed",
  deployment_timed_out: "failed",
  deletion_timed_out: "failed",
};

export function mapCloudflareHostnameStatus(status: unknown): HostnameState {
  return typeof status === "string" && Object.hasOwn(cloudflareHostnameStatuses, status)
    ? (cloudflareHostnameStatuses[status] ?? "unknown")
    : "unknown";
}

export function mapCloudflareCertificateStatus(status: unknown): CertificateState {
  return typeof status === "string" && Object.hasOwn(cloudflareCertificateStatuses, status)
    ? (cloudflareCertificateStatuses[status] ?? "unknown")
    : "unknown";
}
