import { type FieldKeyring, parseFieldKeyring } from "@tidegrid/database";
import type { Bindings } from "./env.ts";

/**
 * The field keyring (W3-OPS-4), from the `FIELD_ENCRYPTION_KEYS` Worker
 * secret: JSON with the current key id, the AES-256 keys by id, and the blind
 * index key (packages/database/src/field-crypto.ts). Parsed once per isolate
 * for each secret value. A malformed secret throws FieldKeyringError, so the
 * request fails closed rather than writing plain fields.
 */
const parsed = new Map<string, Promise<FieldKeyring>>();

export async function fieldKeyring(env: Bindings): Promise<FieldKeyring | undefined> {
  const secret = env.FIELD_ENCRYPTION_KEYS;
  if (!secret) return undefined;
  let keyring = parsed.get(secret);
  if (!keyring) {
    keyring = parseFieldKeyring(secret);
    keyring.catch(() => parsed.delete(secret));
    parsed.clear();
    parsed.set(secret, keyring);
  }
  return keyring;
}

/**
 * Staging and production never write personal waiver evidence in plain
 * columns: without a keyring they refuse to sign. Local and preview, on
 * synthetic data, may.
 */
export function sealingRequired(env: Bindings): boolean {
  return env.ENVIRONMENT === "staging" || env.ENVIRONMENT === "production";
}
