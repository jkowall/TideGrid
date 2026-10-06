/**
 * Waiver capabilities: the entry token an email link carries and the session
 * secret redeeming it returns. Both are 32 random bytes in base64url (43
 * characters). Only their SHA-256, under a purpose label, is stored or
 * compared, so a token hash can never be presented as a session or the other
 * way round. Runs in Workers and Node.
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

async function hashAs(label: string, secret: string): Promise<string> {
  if (!waiverSecretPattern.test(secret)) {
    throw new TypeError("a waiver secret is 43 base64url characters");
  }
  return sha256Hex(`${label}:${secret}`);
}

/** The stored form of an email link's entry token. */
export function hashWaiverToken(token: string): Promise<string> {
  return hashAs("waiver-token", token);
}

/** The stored form of a signing session's secret. */
export function hashWaiverSession(secret: string): Promise<string> {
  return hashAs("waiver-session", secret);
}
