/**
 * The booking's participants as waivers see them, read through the booking
 * module's declared interface (`listParticipants`), never its tables. An adult
 * signs for themselves at their own address; a minor's parent or guardian
 * signs at the guardian's address.
 */
import type { TenantTransaction } from "@tidegrid/database";
import { listParticipants } from "@tidegrid/domain-booking";
import type { ParticipantDirectory, WaiverDeps, WaiverParticipant } from "./ports.ts";

export const bookingParticipantDirectory: ParticipantDirectory = {
  async list(trx: TenantTransaction, tenantId: string, bookingId: string) {
    const party = await listParticipants(trx, tenantId, bookingId);
    if (!party) return [];
    return party.participants.map(
      (p): WaiverParticipant => ({
        id: p.id,
        bookingId,
        name: p.name,
        email: p.isMinor ? (p.guardian?.email ?? null) : p.email,
        minor: p.isMinor,
        guardianName: p.isMinor ? (p.guardian?.name ?? null) : null,
      }),
    );
  },
};

/** What the API and the seed pass: the booking module's own participants. */
export const defaultWaiverDeps: WaiverDeps = { participants: bookingParticipantDirectory };
