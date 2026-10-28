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

/**
 * Slugs no tenant may take, because the preview pattern would put the tenant
 * on a platform name (`api`, `console`, `demo`, `status`, `customers`, and the
 * SaaS fallback origin) or a name people read as the platform's own (G2.14b).
 */
export const reservedSlugs: readonly string[] = [
  "www",
  "api",
  "console",
  "demo",
  "status",
  "customers",
  "saas-fallback",
];

/** Why a slug cannot be a tenant's, or null when it can. */
export function slugProblem(slug: string): "not_a_slug" | "reserved" | "idn_label" | null {
  if (!slugPattern.test(slug)) return "not_a_slug";
  if (reservedSlugs.includes(slug)) return "reserved";
  // Punycode labels are refused for the demo (G2.14b, D13): a lookalike
  // Unicode name could pass for another operator.
  if (slug.startsWith("xn--")) return "idn_label";
  return null;
}

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

/**
 * Suffixes no custom hostname may equal or end in, on a label boundary: the
 * platform's own zones, the Workers and Pages zones, and the reserved and
 * special-use names (RFC 2606, RFC 6761, RFC 6762, RFC 7686, RFC 8375, RFC
 * 9476, and the internal TLD). The database function app.hostname_request
 * holds the same list.
 */
export const refusedCustomHostnameSuffixes: readonly string[] = [
  "tidegrid.us",
  "workers.dev",
  "pages.dev",
  "localhost",
  "test",
  "example",
  "invalid",
  "onion",
  "local",
  "internal",
  "arpa",
  "alt",
];

/** The longest custom hostname accepted; an audit subject holds at most 200 characters. */
export const customHostnameMaxLength = 200;

export type CustomHostnameProblem =
  | "malformed"
  | "too_long"
  | "too_few_labels"
  | "reserved_suffix"
  | "idn_label";

const ldhLabel = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/;
const topLabel = /^[a-z]([a-z0-9-]{0,61}[a-z0-9])?$/;

/**
 * Why a name cannot be requested as a tenant's custom hostname, or null when
 * it can. The name must already be normalized: lowercase, ASCII, no trailing
 * dot. A custom name has at least three labels, so no apex domain is ever
 * attached (the decision register), ends in none of the refused suffixes,
 * and carries no punycode label (G2.14b, D13).
 */
export function customHostnameProblem(hostname: string): CustomHostnameProblem | null {
  if (hostname.length === 0 || hostname !== hostname.toLowerCase()) return "malformed";
  if (hostname.length > customHostnameMaxLength) return "too_long";
  const labels = hostname.split(".");
  const last = labels.at(-1) ?? "";
  if (!topLabel.test(last) || !labels.slice(0, -1).every((l) => ldhLabel.test(l))) {
    return "malformed";
  }
  if (labels.length < 3) return "too_few_labels";
  for (const suffix of refusedCustomHostnameSuffixes) {
    if (hostname === suffix || hostname.endsWith(`.${suffix}`)) return "reserved_suffix";
  }
  if (labels.some((l) => l.startsWith("xn--"))) return "idn_label";
  return null;
}
