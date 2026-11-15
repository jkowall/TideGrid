/**
 * Field encryption with versioned keys held outside the database (W3-OPS-4,
 * ADR 0019 as retained in docs/v2/06; docs/v2/08 security controls).
 *
 * Personal fields are sealed in the application with AES-256-GCM before they
 * reach PostgreSQL, so the database, its branches, its backups, and anyone
 * who reads them hold only ciphertext. The keys live in a Worker secret
 * (`FIELD_ENCRYPTION_KEYS`), never in the database or the repository; the
 * owner keeps the root copy outside the runtime account.
 *
 * - **Versioned.** Every sealed value names its key id. New values use the
 *   keyring's current key; older ids stay readable while their key is in the
 *   keyring, so a rotation adds a key and makes it current, and retires the
 *   old one only once nothing needs it.
 * - **Bound to its place.** The additional authenticated data is the tenant
 *   and the field's place (table and column), so a sealed value copied to
 *   another tenant, table, or column does not open.
 * - **Blind index.** `blindIndex` is a keyed HMAC-SHA256 of a normalized value
 *   for exact-match lookups (an email address) without storing the value. It
 *   uses its own key and includes the tenant, so the same address gives
 *   unrelated tokens at two operators.
 *
 * Works in Node and in Workers (WebCrypto only).
 */

/** WebCrypto's key type, as both Node and Workers declare it. */
type CryptoKey = Awaited<ReturnType<typeof crypto.subtle.importKey>>;

const FORMAT = "tgf1";
const KEY_ID = /^[a-z0-9]{1,16}$/;
const SEALED = /^tgf1:([a-z0-9]{1,16}):([A-Za-z0-9_-]{24,})$/;

export interface FieldKeyring {
  /** The key id new values are sealed with. */
  readonly current: string;
  readonly keys: ReadonlyMap<string, CryptoKey>;
  /** The HMAC key for blind indexes. */
  readonly index: CryptoKey;
}

/** The keyring secret is missing, malformed, or names a key it lacks. */
export class FieldKeyringError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FieldKeyringError";
  }
}

/** A sealed value that cannot be opened: unknown key, wrong place, or damaged. */
export class FieldDecryptError extends Error {
  constructor(readonly keyId: string | null) {
    super(`a sealed field could not be opened${keyId ? ` (key ${keyId})` : ""}`);
    this.name = "FieldDecryptError";
  }
}

function fromBase64(text: string): Uint8Array {
  const normal = text.replace(/-/g, "+").replace(/_/g, "/");
  const binary = atob(normal);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}

function toBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function keyBytes(name: string, value: unknown): Uint8Array<ArrayBuffer> {
  if (typeof value !== "string") throw new FieldKeyringError(`key ${name} is not a string`);
  let bytes: Uint8Array;
  try {
    bytes = fromBase64(value);
  } catch {
    throw new FieldKeyringError(`key ${name} is not base64`);
  }
  if (bytes.byteLength !== 32) throw new FieldKeyringError(`key ${name} is not 32 bytes`);
  return new Uint8Array(bytes);
}

/**
 * Reads the keyring secret: JSON `{"current": "k1", "keys": {"k1": "<base64
 * of 32 random bytes>"}, "index": "<base64 of 32 random bytes>"}`. Key ids are
 * 1 to 16 lowercase letters and digits. Throws FieldKeyringError, never
 * echoing a key.
 */
export async function parseFieldKeyring(secret: string): Promise<FieldKeyring> {
  let raw: unknown;
  try {
    raw = JSON.parse(secret);
  } catch {
    throw new FieldKeyringError("the keyring is not JSON");
  }
  if (!raw || typeof raw !== "object") throw new FieldKeyringError("the keyring is not an object");
  const { current, keys, index } = raw as Record<string, unknown>;
  if (typeof current !== "string" || !KEY_ID.test(current)) {
    throw new FieldKeyringError("the keyring's current id is missing or malformed");
  }
  if (!keys || typeof keys !== "object") throw new FieldKeyringError("the keyring has no keys");
  const map = new Map<string, CryptoKey>();
  for (const [id, value] of Object.entries(keys as Record<string, unknown>)) {
    if (!KEY_ID.test(id)) throw new FieldKeyringError("a key id is malformed");
    map.set(
      id,
      await crypto.subtle.importKey("raw", keyBytes(id, value), { name: "AES-GCM" }, false, [
        "encrypt",
        "decrypt",
      ]),
    );
  }
  if (!map.has(current)) throw new FieldKeyringError("the current key is not in the keyring");
  const indexKey = await crypto.subtle.importKey(
    "raw",
    keyBytes("index", index),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  return { current, keys: map, index: indexKey };
}

/** Where a sealed value belongs: its tenant and its table and column. */
export interface FieldPlace {
  tenantId: string;
  /** "table.column", such as "waiver_evidence.personal_sealed". */
  field: string;
}

function aad(place: FieldPlace): Uint8Array<ArrayBuffer> {
  return new Uint8Array(
    new TextEncoder().encode(`tidegrid.field.v1|${place.tenantId}|${place.field}`),
  );
}

/** Seals a string with the current key: `tgf1:<key id>:<base64url of iv and ciphertext>`. */
export async function sealField(
  keyring: FieldKeyring,
  place: FieldPlace,
  plaintext: string,
): Promise<string> {
  const key = keyring.keys.get(keyring.current);
  if (!key) throw new FieldKeyringError("the current key is not in the keyring");
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(
    await crypto.subtle.encrypt(
      { name: "AES-GCM", iv, additionalData: aad(place) },
      key,
      new TextEncoder().encode(plaintext),
    ),
  );
  const out = new Uint8Array(iv.byteLength + ct.byteLength);
  out.set(iv);
  out.set(ct, iv.byteLength);
  return `${FORMAT}:${keyring.current}:${toBase64Url(out)}`;
}

/** The key id a sealed value names, or null when it is not a sealed value. */
export function sealedKeyId(sealed: string): string | null {
  return SEALED.exec(sealed)?.[1] ?? null;
}

/** Opens a sealed value for its place. Throws FieldDecryptError when it cannot. */
export async function openField(
  keyring: FieldKeyring,
  place: FieldPlace,
  sealed: string,
): Promise<string> {
  const match = SEALED.exec(sealed);
  if (!match) throw new FieldDecryptError(null);
  const [, keyId = "", body = ""] = match;
  const key = keyring.keys.get(keyId);
  if (!key) throw new FieldDecryptError(keyId);
  const bytes = fromBase64(body);
  if (bytes.byteLength < 12 + 16) throw new FieldDecryptError(keyId);
  try {
    const plain = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: bytes.slice(0, 12), additionalData: aad(place) },
      key,
      bytes.slice(12),
    );
    // Fatal, so damaged UTF-8 is refused rather than replaced.
    const fatal = { fatal: true } as ConstructorParameters<typeof TextDecoder>[1];
    return new TextDecoder("utf-8", fatal).decode(plain);
  } catch {
    throw new FieldDecryptError(keyId);
  }
}

/**
 * A blind index token: hex HMAC-SHA256 over the tenant, a purpose, and the
 * value as given (callers normalize first, such as lowercasing an email).
 */
export async function blindIndex(
  keyring: FieldKeyring,
  tenantId: string,
  purpose: string,
  value: string,
): Promise<string> {
  const mac = await crypto.subtle.sign(
    "HMAC",
    keyring.index,
    new TextEncoder().encode(`tidegrid.index.v1|${tenantId}|${purpose}|${value}`),
  );
  return [...new Uint8Array(mac)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * A fresh keyring secret with one key, for tests and for the owner's first
 * setup (the runbook prints it once, to be stored as a Worker secret).
 */
export function newFieldKeyringSecret(keyId = "k1"): string {
  const b64 = () => {
    let binary = "";
    for (const b of crypto.getRandomValues(new Uint8Array(32))) binary += String.fromCharCode(b);
    return btoa(binary);
  };
  return JSON.stringify({ current: keyId, keys: { [keyId]: b64() }, index: b64() });
}
