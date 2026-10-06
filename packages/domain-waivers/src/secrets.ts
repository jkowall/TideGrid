/**
 * The signing session's secret: 32 random bytes in base64url (43
 * characters), returned once when a waiver link is redeemed. Only its SHA-256,
 * under a purpose label, is stored or compared. The link's own token belongs
 * to the messaging module. Runs in Workers and Node.
 */
import { sha256Hex } from "./content.ts";

export const waiverSecretPattern = /^[A-Za-z0-9_-]{43}$/;

/** 32 random bytes, base64url without padding. */
export function newWaiverSecret(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** The stored form of a signing session's secret. */
export async function hashWaiverSession(secret: string): Promise<string> {
  if (!waiverSecretPattern.test(secret)) {
    throw new TypeError("a waiver session secret is 43 base64url characters");
  }
  return sha256Hex(`waiver-session:${secret}`);
}
