import { HostnameProviderRejectedError } from "./provider.ts";

/**
 * Refusals about the account, the token, or the zone rather than one record
 * (G2.14b, W1-SAAS-PREP). Every other hostname would get the same answer, so
 * a caller records nothing for the hostname it was reading and stops reading
 * the provider: the sweep ends its provider reads as `providerFault`, and the
 * admin CLI prints a refusal that names the token and the zone.
 *
 * - any HTTP 401 or 403, whatever Cloudflare code it carries (an expired,
 *   rotated, or mis-scoped token);
 * - the Cloudflare codes below, whatever the HTTP status;
 * - on an exact-name lookup only, a 404: the zone itself is missing or out of
 *   the token's reach, since a lookup with no match answers an empty list.
 *
 * Any code not listed is treated as about the one record.
 *
 * UNVERIFIED against live Cloudflare. The codes are Cloudflare's
 * authentication and routing errors as remembered from its API: 9106 and
 * 9109 (missing or invalid credentials), 10000 (authentication error), 6003,
 * 6103, and 6111 (invalid request headers, a bad Authorization header), and
 * 7003 (an object identifier that routes nowhere). The recorded-shape fixture
 * answers with these shapes. They count as verified only at the first real
 * request, the runbook's P10 (A18), by recording the code a rotated or
 * wrong-zone token returns.
 */
export const ACCOUNT_LEVEL_REFUSAL_CODES: readonly string[] = Object.freeze([
  "http_401",
  "http_403",
  "cloudflare_9106",
  "cloudflare_9109",
  "cloudflare_10000",
  "cloudflare_6003",
  "cloudflare_6103",
  "cloudflare_6111",
  "cloudflare_7003",
]);

/** False until the first real request at P10 records the codes Cloudflare returns. */
export const ACCOUNT_LEVEL_REFUSALS_VERIFIED = false;

const accountLevelCodes = new Set(ACCOUNT_LEVEL_REFUSAL_CODES);

/**
 * Whether a provider error refuses the whole account rather than one record.
 * `lookup` is true for an exact-name lookup, where a 404 means the zone.
 */
export function isAccountLevelRefusal(error: unknown, options: { lookup?: boolean } = {}): boolean {
  if (!(error instanceof HostnameProviderRejectedError)) return false;
  if (error.httpStatus === 401 || error.httpStatus === 403) return true;
  if (accountLevelCodes.has(error.code)) return true;
  return options.lookup === true && error.code === "http_404";
}
