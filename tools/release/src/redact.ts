/**
 * Redaction rules (invariants 6 and 12). Every line nov1 prints or journals
 * passes through redact(). Every argv it spawns passes assertArgvSafe(), which
 * refuses instead of redacting: a secret in argv is already visible to `ps`.
 */
import { Refusal } from "./core.ts";

const rules: [RegExp, string][] = [
  // A URL with credentials, any scheme: keep the scheme and host.
  [/\b([a-z][a-z0-9+.-]*):\/\/[^\s/@:]+:[^\s/@]*@/gi, "$1://<credentials-redacted>@"],
  // Stripe keys and signing secrets.
  [/\b(sk|rk|pk)_(test|live)_[A-Za-z0-9_]+/g, "$1_$2_<redacted>"],
  [/\bwhsec_[A-Za-z0-9_]+/g, "whsec_<redacted>"],
  // Connected account ids (invariant 12).
  [/\bacct_[A-Za-z0-9_-]+/g, "acct_<redacted>"],
  // Long hex such as a webhook secret from openssl rand -hex 32.
  [/\b[0-9a-f]{64,}\b/gi, "<hex-redacted>"],
  // Cloudflare API tokens are 40 characters of [A-Za-z0-9_-]; any bearer value.
  [/\b(Bearer)\s+[A-Za-z0-9._~+/=-]{16,}/g, "$1 <redacted>"],
];

/** An address outside the reserved .test domains (and example ones) is personal data. */
const address = /\b[A-Za-z0-9._%+-]+@([A-Za-z0-9.-]+\.[A-Za-z]{2,})\b/g;

function keepAddress(domain: string): boolean {
  const d = domain.toLowerCase();
  return d === "test" || d.endsWith(".test");
}

export function redact(text: string): string {
  let result = text;
  for (const [pattern, replacement] of rules) result = result.replace(pattern, replacement);
  return result.replace(address, (match, domain: string) =>
    keepAddress(domain) ? match : "<address-redacted>",
  );
}

/** True when the text carries something redact() would remove. */
export function hasSecretShape(text: string): boolean {
  return redact(text) !== text;
}

/**
 * Refuse an argv that would carry a secret, an account id, a personal address,
 * a credentialed URL, or --api-key, before anything is spawned.
 */
export function assertArgvSafe(cmd: string, args: readonly string[]): void {
  for (const arg of [cmd, ...args]) {
    if (/^--api-key(=|$)/.test(arg)) throw new Refusal("--api-key is refused in any argv");
    if (hasSecretShape(arg)) {
      throw new Refusal(`refused to spawn ${cmd}: an argument looks like a secret or an id`);
    }
  }
}
