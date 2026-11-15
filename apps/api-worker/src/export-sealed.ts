import { type FieldKeyring, FieldKeyringError, openContact } from "@tidegrid/database";
import { openEvidenceFields } from "@tidegrid/domain-waivers";

type JsonObject = Record<string, unknown>;

/**
 * For the tenant export (W3-OPS-4): a sealed row comes out with its personal
 * fields opened into their usual columns, so the operator gets what was
 * recorded, not ciphertext. The client address stays out, as the export
 * leaves it out of every table.
 *
 * - waiver_evidence (0054): the signer's and participant's details.
 * - checkout_sessions (0055): the booker's name and email.
 * - import_customers (0055): the imported customer's name, email, and phone.
 *
 * The blind index tokens stay in the export: a credit account written sealed
 * is keyed by its email token alone, and the same token on a checkout is how
 * the export ties that account to its customer.
 */
export function openSealedEvidence(tenantId: string, fields: FieldKeyring | undefined) {
  const keyring = (): FieldKeyring => {
    if (!fields) throw new FieldKeyringError("a sealed contact detail needs the keyring to export");
    return fields;
  };
  return async <T extends JsonObject>(table: string, row: T): Promise<T> => {
    if (table === "waiver_evidence" && typeof row.personal_sealed === "string") {
      const opened = await openEvidenceFields(
        fields,
        tenantId,
        String(row.id),
        row.personal_sealed,
      );
      const { personal_sealed: _sealed, ...rest } = row;
      return {
        ...rest,
        participant_name: opened.participantName,
        signer_name: opened.signerName,
        signature_text: opened.signatureText,
        recipient_email: opened.recipientEmail,
        user_agent: opened.userAgent,
      } as unknown as T;
    }
    if (table === "checkout_sessions" && typeof row.booker_sealed === "string") {
      const opened = await openContact(
        keyring(),
        { tenantId, field: "checkout_sessions.booker_sealed" },
        row.booker_sealed,
      );
      const { booker_sealed: _sealed, ...rest } = row;
      return {
        ...rest,
        booker_name: opened.name ?? null,
        booker_email: opened.email ?? null,
      } as unknown as T;
    }
    if (table === "import_customers" && typeof row.contact_sealed === "string") {
      const opened = await openContact(
        keyring(),
        { tenantId, field: "import_customers.contact_sealed" },
        row.contact_sealed,
      );
      const { contact_sealed: _sealed, ...rest } = row;
      return {
        ...rest,
        full_name: opened.name ?? null,
        email: opened.email ?? null,
        phone: opened.phone ?? null,
      } as unknown as T;
    }
    return row;
  };
}
