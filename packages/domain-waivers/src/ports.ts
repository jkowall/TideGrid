/**
 * What waivers need from the rest of the system, as narrow ports, so this
 * module never writes another module's tables: who a booking's participants
 * are, how a message is queued, and where the guest site lives. The API wires
 * them to the participant model and the transactional email outbox.
 */
import type { TenantContext, TenantTransaction } from "@tidegrid/database";

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
}

export interface ParticipantDirectory {
  /** A booking's current participants in a stable order; removed ones are not listed. */
  list(trx: TenantTransaction, tenantId: string, bookingId: string): Promise<WaiverParticipant[]>;
}

/** Everything a waiver request email says. The link carries the raw entry token. */
export interface WaiverRequestMessage {
  /** waiver:<requestId>:<generation>: a retry of one generation never sends twice. */
  idempotencyKey: string;
  to: string;
  requestId: string;
  generation: number;
  requiredSigner: "participant" | "guardian";
  participantName: string;
  operatorName: string;
  trip: { name: string; when: string; place: string; bookingReference: string };
  /** The guest site's /waiver page with the token in its fragment, which no server receives. */
  link: string;
  linkExpiresAt: Date;
}

export interface WaiverMailer {
  /**
   * Queue the message in the caller's transaction, so it exists only if the
   * request and its delivery commit. Returns the message's id when the
   * mailer keeps one.
   */
  enqueue(
    trx: TenantTransaction,
    ctx: TenantContext,
    message: WaiverRequestMessage,
  ): Promise<{ messageId: string | null }>;
}

export interface WaiverDeps {
  participants: ParticipantDirectory;
  mailer: WaiverMailer;
  /**
   * The guest site's origin for a tenant, such as
   * https://demo-harbor.book.tidegrid.us, or null when it has none; links in
   * email open there.
   */
  guestOrigin(trx: TenantTransaction, tenantId: string): Promise<string | null>;
}
