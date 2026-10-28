/**
 * Tenant and brand configuration for synthetic tenants, and the hostname
 * mapping rules. Pure: safe in any runtime. The file loader lives in
 * `@tidegrid/tenant-config/node`.
 */
export { type BrandConfig, brandSchemaVersion } from "@tidegrid/contracts";
export {
  type CustomHostnameProblem,
  customHostnameMaxLength,
  customHostnameProblem,
  isLoopbackOnlyHostname,
  localHostnameFor,
  localHostSuffix,
  previewHostnameFor,
  previewHostSuffix,
  refusedCustomHostnameSuffixes,
  reservedSlugs,
  slugPattern,
  slugProblem,
} from "./hostnames.ts";
export {
  brandConfigFromManifest,
  describeIssues,
  logoMediaTypeFor,
  parseTenantManifest,
  TenantConfigError,
  TenantManifest,
} from "./manifest.ts";
