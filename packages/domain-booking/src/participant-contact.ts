/**
 * A participant's name and addresses, plain or sealed (0056, W3-OPS-4). Where
 * the transaction has a field keyring (packages/database/src/contact-crypto.ts)
 * a participant is written sealed, as one value holding the name, the email,
 * and a minor's guardian's name and email, beside a blind index token of each
 * address; where it has none, plain, as before. A row never moves between the
 * two: a correction keeps the row's mode.
 *
 * Every reader of a participant's details selects `contact_sealed` beside the
 * plain columns and passes the row through `openParticipantRows`, which fills
 * the plain columns from the sealed value, so code written for plain rows
 * reads them unchanged. Participants have no name search, so no name tokens.
 */
import {
  contactKeys,
  contactKeysToOpen,
  emailToken,
  openContact,
  sealContact,
  type TenantTransaction,
} from "@tidegrid/database";

const PLACE = "booking_participants.contact_sealed";

/** A participant's details as stored plain: trimmed names, lowercased addresses. */
export interface ParticipantContact {
  full_name: string;
  email: string | null;
  guardian_name: string | null;
  guardian_email: string | null;
}

/** The columns a participant's details are written in. */
export interface ParticipantContactColumns {
  full_name: string | null;
  email: string | null;
  guardian_name: string | null;
  guardian_email: string | null;
  contact_sealed: string | null;
  email_index: string | null;
  guardian_email_index: string | null;
}

/**
 * The columns for these details: sealed with tokens where there is a keyring,
 * plain otherwise. `like` keeps a corrected participant where it was written.
 */
export async function participantContactColumns(
  trx: TenantTransaction,
  tenantId: string,
  contact: ParticipantContact,
  like?: { sealed: boolean },
): Promise<ParticipantContactColumns> {
  const keyring =
    like === undefined
      ? await contactKeys(trx)
      : like.sealed
        ? await contactKeysToOpen(trx)
        : undefined;
  if (!keyring) {
    return { ...contact, contact_sealed: null, email_index: null, guardian_email_index: null };
  }
  return {
    full_name: null,
    email: null,
    guardian_name: null,
    guardian_email: null,
    contact_sealed: await sealContact(
      keyring,
      { tenantId, field: PLACE },
      {
        name: contact.full_name,
        email: contact.email,
        guardianName: contact.guardian_name,
        guardianEmail: contact.guardian_email,
      },
    ),
    email_index: contact.email === null ? null : await emailToken(keyring, tenantId, contact.email),
    guardian_email_index:
      contact.guardian_email === null
        ? null
        : await emailToken(keyring, tenantId, contact.guardian_email),
  };
}

/** A participant row's detail columns as read. */
export interface ParticipantContactRow {
  full_name?: string | null;
  email?: string | null;
  guardian_name?: string | null;
  guardian_email?: string | null;
  contact_sealed?: string | null;
}

/**
 * Rows with their participants' details opened in place. A sealed row with no
 * keyring throws, never reads blank; rows with no sealed value pass through.
 */
export async function openParticipantRows<T extends ParticipantContactRow>(
  trx: TenantTransaction,
  tenantId: string,
  rows: T[],
): Promise<T[]> {
  if (!rows.some((r) => r.contact_sealed)) return rows;
  const keyring = await contactKeysToOpen(trx);
  return Promise.all(
    rows.map(async (row) => {
      if (!row.contact_sealed) return row;
      const opened = await openContact(keyring, { tenantId, field: PLACE }, row.contact_sealed);
      if (typeof opened.name !== "string") throw new Error("a sealed participant has no name");
      const text = (v: string | null | undefined) => (typeof v === "string" ? v : null);
      return {
        ...row,
        full_name: opened.name,
        email: text(opened.email),
        guardian_name: text(opened.guardianName),
        guardian_email: text(opened.guardianEmail),
      };
    }),
  );
}

/** One row, opened as `openParticipantRows` does. */
export async function openParticipantRow<T extends ParticipantContactRow>(
  trx: TenantTransaction,
  tenantId: string,
  row: T,
): Promise<T> {
  const [opened] = await openParticipantRows(trx, tenantId, [row]);
  return opened as T;
}
