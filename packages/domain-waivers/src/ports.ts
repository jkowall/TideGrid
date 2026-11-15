/**
 * What waivers need from the booking module, as a narrow port, so this module
 * never writes another module's tables: who a booking's participants are. The
 * API wires it to the participant model (participants.ts). Email and its
 * links go through the messaging module's declared calls.
 */
import type { FieldKeyring, TenantTransaction } from "@tidegrid/database";

/** A participant as waivers see one. */
export interface WaiverParticipant {
  id: string;
  bookingId: string;
  /** The name the booking gives, which an adult's typed signature must match. */
  name: string;
  /**
   * Where the request goes: the participant's own address, or for a minor a
   * parent's or guardian's. Null when the booking has none yet; the request
   * then waits, shown as missing a contact.
   */
  email: string | null;
  /** A minor never signs; a parent or legal guardian signs for them. */
  minor: boolean;
  /** A minor's parent or guardian, as the booking names them; their signature must match it. */
  guardianName: string | null;
}

export interface ParticipantDirectory {
  /** A booking's current participants in a stable order; removed ones are not listed. */
  list(trx: TenantTransaction, tenantId: string, bookingId: string): Promise<WaiverParticipant[]>;
}

/**
 * Where signed PDFs live once real evidence exists (W3-OPS-4): a private
 * bucket with object lock. Keys are content-addressed
 * (`waivers/<tenant>/<sha256>.pdf`), so writing the same bytes twice is
 * harmless and a key never names other bytes. The API wires it to the R2
 * binding (apps/api-worker/src/evidence-store.ts); without one the PDF stays
 * in the evidence row, as the demo always kept it.
 */
export interface EvidenceDocumentStore {
  /**
   * Stores the bytes under the key, or confirms the same bytes are already
   * there. Throws when it cannot, so the signature does not commit.
   */
  put(key: string, bytes: Uint8Array, sha256: string): Promise<void>;
  /** The bytes under the key, or null when no object has it. */
  get(key: string): Promise<Uint8Array | null>;
}

export interface WaiverDeps {
  participants: ParticipantDirectory;
  /** Absent: the PDF is kept in the evidence row (demo, local, preview). */
  documents?: EvidenceDocumentStore;
  /**
   * The field keyring (W3-OPS-4, 0054). Present: new evidence seals its
   * personal fields. Absent: they are written plain (demo, local, preview),
   * and a sealed row cannot be read.
   */
  fields?: FieldKeyring;
}
