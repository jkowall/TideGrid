/**
 * What waivers need from the booking module, as a narrow port, so this module
 * never writes another module's tables: who a booking's participants are. The
 * API wires it to the participant model (participants.ts). Email and its
 * links go through the messaging module's declared calls.
 */
import type { TenantTransaction } from "@tidegrid/database";

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

export interface WaiverDeps {
  participants: ParticipantDirectory;
}
