import { normalizeHostname } from "@tidegrid/domain-identity";
import { isLoopbackOnlyHostname } from "@tidegrid/tenant-config";

/** The deployment environments the Workers run in, as `ENVIRONMENT` names them. */
export type DeploymentEnvironment = "local" | "preview" | "staging" | "production";

export interface HostPolicy {
  environment: DeploymentEnvironment;
}

/** A browser origin that passed the strict parser, ready for a hostname lookup. */
export interface ParsedOrigin {
  /** The canonical serialization, `https://host` (or `http://host:port` locally). */
  origin: string;
  /** The normalized hostname, as tenant_hostnames stores it. */
  host: string;
}

function hasControlCharacter(value: string): boolean {
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i);
    if (code < 0x20 || code === 0x7f) return true;
  }
  return false;
}

/**
 * Checks shared by every caller once a hostname is in hand: it must already be
 * in the stored form (lowercase ASCII, no trailing dot, at least two LDH
 * labels, not an IP literal), carry no punycode label (G2.14b, D13: no row
 * can hold one), and, outside local development, must not be a loopback-only
 * name. A `*.localhost` row is therefore inert anywhere but on a developer's
 * machine, whatever the seed wrote.
 */
function acceptHost(hostname: string, policy: HostPolicy): string | null {
  if (hostname.endsWith(".")) return null;
  const host = normalizeHostname(hostname);
  if (!host || host !== hostname) return null;
  if (host.split(".").some((label) => label.startsWith("xn--"))) return null;
  if (policy.environment !== "local" && isLoopbackOnlyHostname(host)) return null;
  return host;
}

/**
 * The strict origin parser (G2.14b). Every public route, the bootstrap
 * included, the guest Worker's gateway, CORS, and email links read a tenant's
 * hostname through it, so resolution and CORS always agree. It returns null
 * for anything that is not a canonical browser origin:
 *
 * - no Origin, or the opaque origin `null`
 * - userinfo, a query, a fragment, or a path other than empty or `/`
 * - a trailing dot (a separate browser origin for storage and service workers)
 * - a scheme other than `https:`; `http:` only in local development and only
 *   for a `*.localhost` host
 * - an explicit port, except in local development; a default port such as
 *   `:443` is never canonical, so it is refused everywhere
 * - uppercase, Unicode, or anything else a browser never sends: the value must
 *   equal its own serialization
 * - IP literals, single labels such as `localhost`, and malformed hosts
 * - outside local development, any loopback-only name
 *
 * Host, X-Forwarded-Host, and Referer are never inputs.
 */
export function parseBrowserOrigin(
  value: string | null | undefined,
  policy: HostPolicy,
): ParsedOrigin | null {
  if (typeof value !== "string") return null;
  if (value.length === 0 || value.length > 300 || value === "null") return null;
  // No white space or control characters, and none of the characters that
  // would start userinfo, a query, a fragment, or a Windows-style path.
  if (/[\s@?#\\]/.test(value) || hasControlCharacter(value)) return null;
  const raw = value.endsWith("/") ? value.slice(0, -1) : value;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (url.username || url.password || url.search || url.hash) return null;
  if (url.pathname !== "/" && url.pathname !== "") return null;
  // Uppercase, Unicode hosts, default ports, and extra slashes all serialize
  // differently from what was sent.
  if (url.origin !== raw) return null;
  const local = policy.environment === "local";
  if (url.port && !local) return null;
  if (url.protocol === "http:") {
    if (!local || !url.hostname.endsWith(".localhost")) return null;
  } else if (url.protocol !== "https:") {
    return null;
  }
  const host = acceptHost(url.hostname, policy);
  return host ? { origin: url.origin, host } : null;
}

/**
 * The hostname a request reached, for the guest Worker: only the parsed
 * request URL, never a header. The scheme and port do not select a tenant, so
 * only the hostname is checked, by the same rules as an origin's.
 */
export function parseRequestHost(requestUrl: string, policy: HostPolicy): string | null {
  let url: URL;
  try {
    url = new URL(requestUrl);
  } catch {
    return null;
  }
  return acceptHost(url.hostname, policy);
}

/**
 * A bare hostname handed across a trust boundary, such as the guest Worker's
 * RPC call: checked again rather than trusted.
 */
export function parseHostname(value: unknown, policy: HostPolicy): string | null {
  if (typeof value !== "string" || value.length === 0 || value.length > 253) return null;
  return acceptHost(value, policy);
}
