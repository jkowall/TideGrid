/**
 * Hostname mapping for synthetic tenants. A hostname selects one tenant's
 * public experience and grants nothing; resolution happens in the database
 * (`app.resolve_hostname`) against verified, active rows only.
 *
 * - Preview: `<slug>.book.tidegrid.us`, the demo's shared preview pattern.
 * - Local: `<slug>.book.localhost`. Browsers resolve every `*.localhost` name
 *   to the loopback interface, so these can only ever reach a developer's own
 *   machine. The seed writes them only when asked (SEED_LOCAL_HOSTNAMES=1),
 *   never by default, so shared environments do not carry them.
 */
export const previewHostSuffix = "book.tidegrid.us";
export const localHostSuffix = "book.localhost";

/** Tenant slug, as the tenants table constrains it. */
export const slugPattern = /^[a-z0-9]([a-z0-9-]{0,38}[a-z0-9])?$/;

function assertSlug(slug: string): void {
  if (!slugPattern.test(slug)) throw new RangeError(`not a tenant slug: ${slug}`);
}

export function previewHostnameFor(slug: string): string {
  assertSlug(slug);
  return `${slug}.${previewHostSuffix}`;
}

export function localHostnameFor(slug: string): string {
  assertSlug(slug);
  return `${slug}.${localHostSuffix}`;
}

/** Whether a hostname can only resolve to this machine. */
export function isLoopbackOnlyHostname(hostname: string): boolean {
  return hostname === "localhost" || hostname.endsWith(".localhost");
}
