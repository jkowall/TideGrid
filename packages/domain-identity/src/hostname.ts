const label = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/;
const topLabel = /^[a-z]([a-z0-9-]{0,61}[a-z0-9])?$/;

/**
 * Normalize a hostname or origin to the form stored in tenant_hostnames:
 * lowercase, punycode, no port, no trailing dot. Returns null for anything that
 * cannot be a tenant hostname, including IP literals, single labels, and
 * malformed input, so callers fail closed.
 */
export function normalizeHostname(input: string | null | undefined): string | null {
  if (typeof input !== "string") return null;
  const raw = input.trim();
  if (raw.length === 0 || raw.length > 300 || /\s/.test(raw)) return null;
  let host: string;
  try {
    host = new URL(raw.includes("://") ? raw : `https://${raw}`).hostname;
  } catch {
    return null;
  }
  if (host.startsWith("[")) return null;
  host = host.toLowerCase().replace(/\.$/, "");
  if (host.length === 0 || host.length > 253) return null;
  const labels = host.split(".");
  const last = labels.at(-1);
  if (labels.length < 2 || !last || !topLabel.test(last)) return null;
  return labels.slice(0, -1).every((l) => label.test(l)) ? host : null;
}
