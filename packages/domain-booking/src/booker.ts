/**
 * The booker's name and email, plain or sealed (0055, W3-OPS-4). Where the
 * transaction has a field keyring (packages/database/src/contact-crypto.ts),
 * the booker is written sealed with its blind index tokens and read back by
 * opening it; where it has none, plain, as before. Every reader of a
 * checkout's booker selects `booker_sealed` beside the plain columns and
 * passes the row through `openBooker`.
 */
import {
  contactKeys,
  contactKeysToOpen,
  emailToken,
  exactNameToken,
  nameTokens,
  openContact,
  sealContact,
  type TenantTransaction,
} from "@tidegrid/database";

const PLACE = "checkout_sessions.booker_sealed";

/** The columns a checkout's booker is written in. */
export interface BookerColumns {
  booker_name: string | null;
  booker_email: string | null;
  booker_sealed: string | null;
  booker_email_index: string | null;
  booker_name_index: string[] | null;
}

/**
 * The columns for this booker: sealed with tokens where there is a keyring,
 * plain otherwise. `like` keeps a corrected booker where it was written,
 * since a row never moves between plain and sealed (0055).
 */
export async function bookerColumns(
  trx: TenantTransaction,
  tenantId: string,
  name: string,
  email: string | null,
  like?: { sealed: boolean },
): Promise<BookerColumns> {
  const keyring =
    like === undefined
      ? await contactKeys(trx)
      : like.sealed
        ? await contactKeysToOpen(trx)
        : undefined;
  if (!keyring) {
    return {
      booker_name: name,
      booker_email: email,
      booker_sealed: null,
      booker_email_index: null,
      booker_name_index: null,
    };
  }
  const place = { tenantId, field: PLACE };
  const tokens = await nameTokens(keyring, tenantId, name);
  return {
    booker_name: null,
    booker_email: null,
    booker_sealed: await sealContact(keyring, place, { name, email }),
    booker_email_index: email === null ? null : await emailToken(keyring, tenantId, email),
    // The words, for search, and the exact name, so every correction changes
    // the tokens and a name with no letter or digit still has one.
    booker_name_index: [...tokens, await exactNameToken(keyring, tenantId, name)],
  };
}

/** A checkout row's booker columns as read. */
export interface BookerRow {
  booker_name?: string | null;
  booker_email?: string | null;
  booker_sealed?: string | null;
}

export interface Booker {
  name: string;
  email: string | null;
}

/** The booker of a row, opened when sealed. A sealed row with no keyring throws, never reads blank. */
export async function openBooker(
  trx: TenantTransaction,
  tenantId: string,
  row: BookerRow,
): Promise<Booker> {
  if (row.booker_sealed) {
    const keyring = await contactKeysToOpen(trx);
    const opened = await openContact(keyring, { tenantId, field: PLACE }, row.booker_sealed);
    if (typeof opened.name !== "string") throw new Error("a sealed booker has no name");
    return { name: opened.name, email: typeof opened.email === "string" ? opened.email : null };
  }
  if (row.booker_name === null || row.booker_name === undefined) {
    throw new Error("a checkout's booker was not read");
  }
  return { name: row.booker_name, email: row.booker_email ?? null };
}

/** How a credit account is keyed for this address: the address, or its token where sealed. */
export async function customerKey(
  trx: TenantTransaction,
  tenantId: string,
  email: string,
): Promise<{ email: string | null; index: string | null }> {
  const keyring = await contactKeys(trx);
  return keyring
    ? { email: null, index: await emailToken(keyring, tenantId, email) }
    : { email, index: null };
}

/**
 * Rows with their bookers opened in place: a sealed row's `booker_name` and
 * `booker_email` are filled from its sealed value, so code written for plain
 * rows reads them unchanged. Rows that did not select the booker pass through.
 */
export async function openBookers<T extends BookerRow>(
  trx: TenantTransaction,
  tenantId: string,
  rows: T[],
): Promise<T[]> {
  return Promise.all(
    rows.map(async (row) => {
      if (!row.booker_sealed) return row;
      const booker = await openBooker(trx, tenantId, row);
      return {
        ...row,
        booker_name: booker.name,
        booker_email: booker.email,
        booker_sealed: null,
      } as T;
    }),
  );
}
