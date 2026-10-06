/**
 * Small, pure helpers: the guest's capability secret, the per-client key, and
 * booking references. Runs in Workers and Node.
 */

/** 32 random bytes, base64url without padding: 43 characters. */
export const checkoutSecretPattern = /^[A-Za-z0-9_-]{43}$/;

const encoder = new TextEncoder();

async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", encoder.encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** Only this hash of the guest's secret is stored or compared. */
export async function hashCheckoutSecret(secret: string): Promise<string> {
  if (!checkoutSecretPattern.test(secret)) {
    throw new TypeError("a checkout secret is 43 base64url characters");
  }
  return sha256Hex(`checkout-secret:${secret}`);
}

/**
 * The key the per-client limit counts by: a hash of the tenant and the
 * client's address, so the address itself is not stored on the session.
 */
export function clientKeyFor(tenantId: string, address: string): Promise<string> {
  return sha256Hex(`checkout-client:${tenantId}:${address}`);
}

/** Crockford base32: digits and letters without I, L, O, or U. */
const referenceAlphabet = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
export const bookingReferencePattern = /^[0-9A-HJKMNP-TV-Z]{8}$/;

/** Eight unbiased random characters, 40 bits; the database keeps them unique per tenant. */
export function newBookingReference(): string {
  let out = "";
  for (const b of crypto.getRandomValues(new Uint8Array(8))) out += referenceAlphabet[b & 31];
  return out;
}
