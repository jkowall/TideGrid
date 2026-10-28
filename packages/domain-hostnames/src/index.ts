/**
 * Custom hostnames and tenant selection by hostname (G2.14b): the strict
 * origin parser every public route uses, the provider-neutral adapter with its
 * scripted fake and the Cloudflare for SaaS client, and the hostname
 * lifecycle. Safe in a Worker: nothing here imports Node.
 */
export {
  type CloudflareHostnameOptions,
  createCloudflareHostnameProvider,
} from "./cloudflare.ts";
export {
  createFakeHostnameProvider,
  type FakeHostnameOptions,
  type FakeHostnameProvider,
} from "./fake.ts";
export {
  type ActivateOutcome,
  type AdminActor,
  activateCustomHostname,
  DEFAULT_HOSTNAME_SWEEP_BUDGET_MS,
  DEFAULT_HOSTNAME_SWEEP_PER_TENANT,
  DEFAULT_HOSTNAME_SWEEP_PROVIDER_CALLS,
  DEFAULT_HOSTNAME_SWEEP_TENANT_LIMIT,
  disableHostname,
  HostnameNameRefusedError,
  type HostnameSweepOptions,
  type HostnameSweepReport,
  type RequestOutcome,
  requestCustomHostname,
  sweepHostnames,
} from "./lifecycle.ts";
export {
  type DeploymentEnvironment,
  type HostPolicy,
  type ParsedOrigin,
  parseBrowserOrigin,
  parseHostname,
  parseRequestHost,
} from "./origin.ts";
export {
  type CertificateState,
  type CertificateValidation,
  type CustomHostnameProvider,
  type HostnameInstruction,
  type HostnameProviderName,
  HostnameProviderRejectedError,
  HostnameProviderUnavailableError,
  type HostnameState,
  isActivatable,
  isServable,
  type ProviderHostname,
} from "./provider.ts";
export {
  cloudflareCertificateStatuses,
  cloudflareHostnameStatuses,
  mapCloudflareCertificateStatus,
  mapCloudflareHostnameStatus,
} from "./status.ts";
