/**
 * Random secrets and Idempotency-Keys, as the guest web app makes them. The
 * app sets the source once at start (expo-crypto's getRandomValues, which uses
 * the platform's secure generator); tests use Node's. Nothing here falls back
 * to Math.random: with no source, making a secret throws.
 */

type Fill = (bytes: Uint8Array) => void;

let fill: Fill | null = null;

export function setRandomSource(source: Fill): void {
  fill = source;
}

function randomBytes(n: number): Uint8Array {
  if (!fill) throw new Error("No secure random source");
  const bytes = new Uint8Array(n);
  fill(bytes);
  return bytes;
}

const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";

/** Base64url without padding, without btoa, which Hermes may lack. */
export function base64Url(bytes: Uint8Array): string {
  let out = "";
  for (let i = 0; i < bytes.length; i += 3) {
    const a = bytes[i] ?? 0;
    const b = bytes[i + 1];
    const c = bytes[i + 2];
    const n = (a << 16) | ((b ?? 0) << 8) | (c ?? 0);
    out += alphabet[(n >> 18) & 63];
    out += alphabet[(n >> 12) & 63];
    if (b !== undefined) out += alphabet[(n >> 6) & 63];
    if (c !== undefined) out += alphabet[n & 63];
  }
  return out;
}

/** The guest's capability for one checkout: 32 random bytes, 43 base64url characters. */
export function newCheckoutSecret(): string {
  return base64Url(randomBytes(32));
}

/** A random UUID (version 4). */
export function newIdempotencyKey(): string {
  const bytes = randomBytes(16);
  bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x40;
  bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80;
  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/**
 * The Idempotency-Key of one command. The same request sent again, after no
 * answer or an error, reuses the key; another body, or any request after a
 * success, gets a new one.
 */
export class CommandKey {
  #pending: { key: string; fingerprint: string } | null = null;

  for(fingerprint: string): string {
    if (this.#pending?.fingerprint !== fingerprint) {
      this.#pending = { key: newIdempotencyKey(), fingerprint };
    }
    return this.#pending.key;
  }

  done(): void {
    this.#pending = null;
  }
}

/**
 * One attempt to open a checkout: its key and the checkout secret sent with
 * it, kept while the same request is sent again, because the API answers a
 * reused key with another body with 422.
 */
export class CheckoutAttempt {
  #pending: { fingerprint: string; key: string; secret: string } | null = null;

  for(fingerprint: string): { key: string; secret: string } {
    if (this.#pending?.fingerprint !== fingerprint) {
      this.#pending = { fingerprint, key: newIdempotencyKey(), secret: newCheckoutSecret() };
    }
    return { key: this.#pending.key, secret: this.#pending.secret };
  }

  done(): void {
    this.#pending = null;
  }
}
