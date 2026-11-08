/**
 * Stripe's published webhook source addresses, committed and versioned
 * (W1-STRIPE-WEBHOOK D2, a coordinator default pending the owner). Under the
 * Stripe provider the webhook route refuses any request whose client address
 * is not on this list, before it reads the body (D3). The signature check
 * still runs on every request the list lets through: the list narrows who can
 * reach the route, and the signature stays the credential.
 *
 * A change to this list is a reviewed pull request that bumps
 * `STRIPE_WEBHOOK_IPS_VERSION` and passes the check step in the package
 * README ("Refreshing the list"). Nothing here fetches the list at runtime.
 *
 * Provenance of this version: Stripe publishes the list at
 * `STRIPE_WEBHOOK_IPS_SOURCE` and on its IP addresses page. That file could
 * not be read from the build container on 2026-11-08 (the network policy
 * refused the host), so this version is the list as the coordinator knew it
 * on that date. It is unverified against Stripe's page; the owner verifies it
 * with the README's check step before any Stripe-live window.
 */

/** Where Stripe publishes the list, as JSON with one key, `WEBHOOKS`. */
export const STRIPE_WEBHOOK_IPS_SOURCE = "https://stripe.com/files/ips/ips_webhooks.json";

/** The date this list was last compared with the source, or written down. */
export const STRIPE_WEBHOOK_IPS_VERSION = "2026-11-08";

/** Whether this version was checked against the source with the README's step. */
export const STRIPE_WEBHOOK_IPS_VERIFIED = false;

/** IPv4 only, in the dotted form Cloudflare's `CF-Connecting-IP` carries. */
export const STRIPE_WEBHOOK_IPS: readonly string[] = Object.freeze([
  "3.18.12.63",
  "3.130.192.231",
  "13.235.14.237",
  "13.235.122.149",
  "18.211.135.69",
  "35.154.171.200",
  "52.15.183.38",
  "54.88.130.119",
  "54.88.130.237",
  "54.187.174.169",
  "54.187.205.235",
  "54.187.216.72",
]);

const listed: ReadonlySet<string> = new Set(STRIPE_WEBHOOK_IPS);

/**
 * Whether a client address is one of Stripe's webhook addresses. Exact match
 * only: no trimming, no list parsing, no CIDR, no IPv4-mapped IPv6. Anything
 * that is not exactly a listed address, a missing one included, is refused.
 */
export function isStripeWebhookIp(address: string | null | undefined): boolean {
  return typeof address === "string" && listed.has(address);
}

export type StripeWebhookIpsComparison =
  | { kind: "same"; count: number }
  | { kind: "different"; missing: string[]; extra: string[] }
  | { kind: "unreadable"; reason: string };

/**
 * Compare a copy of Stripe's published file with the committed list, for the
 * refresh check step. `missing` are published but not committed; `extra` are
 * committed but no longer published.
 */
export function compareStripeWebhookIps(published: unknown): StripeWebhookIpsComparison {
  const list = (published as { WEBHOOKS?: unknown } | null)?.WEBHOOKS;
  if (!Array.isArray(list) || list.length === 0) {
    return { kind: "unreadable", reason: "no non-empty WEBHOOKS array" };
  }
  if (!list.every((entry): entry is string => typeof entry === "string")) {
    return { kind: "unreadable", reason: "a WEBHOOKS entry is not a string" };
  }
  const source = new Set(list);
  const missing = [...source].filter((ip) => !listed.has(ip)).sort();
  const extra = STRIPE_WEBHOOK_IPS.filter((ip) => !source.has(ip)).sort();
  if (missing.length === 0 && extra.length === 0) {
    return { kind: "same", count: source.size };
  }
  return { kind: "different", missing, extra };
}
