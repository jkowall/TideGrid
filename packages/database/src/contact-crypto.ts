/**
 * Guest contact details sealed by the application (W3-OPS-4, owner decision
 * 2026-11-15: every guest contact detail, in phases). Builds on
 * field-crypto.ts: the values are sealed with AES-256-GCM under the keyring,
 * and what SQL must still compare or search is kept as blind index tokens.
 *
 * - **Where the keyring comes from.** A database handle carries a field
 *   policy (`bindFieldPolicy`): how to get the keyring, and whether sealing is
 *   required. `inTenantTransaction` hands the policy to each transaction, so a
 *   command reads it with `contactKeys(trx)` without threading it through
 *   every call. A handle with no policy writes plain values, as the demo's
 *   local and preview environments do. A required policy with no keyring
 *   throws FieldKeyringError, so staging and production never write a plain
 *   contact detail.
 * - **Email.** One blind index purpose for every table (`email`), over the
 *   address as stored (lowercase), so SQL can match a booker to a credit
 *   account or a delivery to its message without reading either address.
 * - **Names.** Each word of a name, lowercased and normalized, is its own
 *   token (`name_word`). Staff search then matches whole words, not parts of
 *   words; a full email address matches, not part of one.
 */
import type { Kysely } from "kysely";
import {
  blindIndex,
  type FieldKeyring,
  FieldKeyringError,
  type FieldPlace,
  openField,
  sealField,
} from "./field-crypto.ts";

export interface FieldPolicy {
  /** The keyring, or undefined where none is configured. */
  keyring: () => Promise<FieldKeyring | undefined>;
  /** True where a contact detail may never be written plain (staging, production). */
  required: boolean;
}

const policies = new WeakMap<object, FieldPolicy>();

/** Give a database handle (and every transaction it opens) a field policy. */
// biome-ignore lint/suspicious/noExplicitAny: any Kysely database
export function bindFieldPolicy(db: Kysely<any>, policy: FieldPolicy | null): void {
  if (policy) policies.set(db, policy);
  else policies.delete(db);
}

/** Pass a handle's policy on to a transaction it opened (tenant.ts). */
export function inheritFieldPolicy(from: object, to: object): void {
  const policy = policies.get(from);
  if (policy) policies.set(to, policy);
}

/**
 * The keyring for contact details in this transaction, or undefined where
 * contact details are written plain. Throws FieldKeyringError where sealing is
 * required and no keyring is configured.
 */
export async function contactKeys(trx: object): Promise<FieldKeyring | undefined> {
  const policy = policies.get(trx);
  if (!policy) return undefined;
  const keyring = await policy.keyring();
  if (!keyring && policy.required) {
    throw new FieldKeyringError("contact details must be sealed here, and no keyring is set");
  }
  return keyring;
}

/** The keyring, for reading a sealed value: a sealed row with no keyring is an error, never blank. */
export async function contactKeysToOpen(trx: object): Promise<FieldKeyring> {
  const policy = policies.get(trx);
  const keyring = policy ? await policy.keyring() : undefined;
  if (!keyring) throw new FieldKeyringError("a sealed contact detail needs the keyring to read");
  return keyring;
}

/** The blind index of an email address, as stored (lowercase). */
export function emailToken(
  keyring: FieldKeyring,
  tenantId: string,
  email: string,
): Promise<string> {
  return blindIndex(keyring, tenantId, "email", email.trim().toLowerCase());
}

/** A name's words: normalized, lowercased, split on anything not a letter or digit, unique. */
export function nameWords(name: string): string[] {
  const words = name
    .normalize("NFKC")
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter((w) => w.length > 0);
  return [...new Set(words)];
}

/** One token per word of a name, for whole-word search. */
export async function nameTokens(
  keyring: FieldKeyring,
  tenantId: string,
  name: string,
): Promise<string[]> {
  const words = nameWords(name);
  return Promise.all(words.map((w) => blindIndex(keyring, tenantId, "name_word", w)));
}

/** Seal a small JSON object of contact details for its place. */
export function sealContact(
  keyring: FieldKeyring,
  place: FieldPlace,
  value: Record<string, string | null>,
): Promise<string> {
  return sealField(keyring, place, JSON.stringify(value));
}

/** Open a sealed contact object. Throws FieldDecryptError when it cannot. */
export async function openContact(
  keyring: FieldKeyring,
  place: FieldPlace,
  sealed: string,
): Promise<Record<string, string | null>> {
  const parsed: unknown = JSON.parse(await openField(keyring, place, sealed));
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("a sealed contact detail is not an object");
  }
  return parsed as Record<string, string | null>;
}
