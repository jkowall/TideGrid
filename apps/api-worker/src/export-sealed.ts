import type { FieldKeyring } from "@tidegrid/database";
import { openEvidenceFields } from "@tidegrid/domain-waivers";

type JsonObject = Record<string, unknown>;

/**
 * For the tenant export (W3-OPS-4): a sealed waiver evidence row comes out
 * with its personal fields opened into their usual columns, so the operator
 * gets what was recorded, not ciphertext. The client address stays out, as
 * the export leaves it out of every table.
 */
export function openSealedEvidence(tenantId: string, fields: FieldKeyring | undefined) {
  return async <T extends JsonObject>(table: string, row: T): Promise<T> => {
    const sealed = row.personal_sealed;
    if (table !== "waiver_evidence" || typeof sealed !== "string") return row;
    const opened = await openEvidenceFields(fields, tenantId, String(row.id), sealed);
    const { personal_sealed: _sealed, ...rest } = row;
    return {
      ...rest,
      participant_name: opened.participantName,
      signer_name: opened.signerName,
      signature_text: opened.signatureText,
      recipient_email: opened.recipientEmail,
      user_agent: opened.userAgent,
    } as unknown as T;
  };
}
