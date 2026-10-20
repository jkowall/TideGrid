/**
 * Waivers on the booking lifecycle (lane 1's hooks, packages/domain-booking/
 * src/hooks.ts). Each runs inside the transaction that confirms the booking or
 * changes its party, after that change's own locks, so a request and its first
 * email commit or roll back with it:
 *
 * - bookingConfirmed: assign every participant named so far.
 * - participantAdded: assign the new participant.
 * - participantUpdated: a change of who must sign (minor or not), or a new
 *   name for the participant or for the guardian who signed, on a signed
 *   waiver, ends the request and assigns a new one; a corrected address on a
 *   pending request sends it there at once.
 * - bookingCanceled: end every request on the booking.
 *
 * None of them refuses: confirmation and party changes never wait on waivers.
 */
import type { TenantContext, TenantTransaction } from "@tidegrid/database";
import type { BookingHooks, ParticipantUpdatedEvent } from "@tidegrid/domain-booking";
import { sql } from "kysely";
import { assignBookingWaivers, lockBookingForWaivers, requiredSignerFor } from "./assign.ts";
import { sendWaiverRequest } from "./delivery.ts";
import type { WaiverDeps } from "./ports.ts";
import { revokeBookingWaivers, revokeParticipantWaivers } from "./revoke.ts";

export const CORRECTED_ADDRESS_REASON = "The address on the booking was corrected";

export async function onParticipantUpdated(
  trx: TenantTransaction,
  ctx: TenantContext,
  deps: WaiverDeps,
  event: ParticipantUpdatedEvent,
): Promise<void> {
  await lockBookingForWaivers(trx, ctx.tenantId, event.bookingId);
  const participant = (await deps.participants.list(trx, ctx.tenantId, event.bookingId)).find(
    (p) => p.id === event.participantId,
  );
  if (!participant) return;
  const { rows } = await sql<{
    id: string;
    state: "pending" | "signed";
    required_signer: "participant" | "guardian";
  }>`
    select id, state, required_signer from waiver_requests
     where tenant_id = ${ctx.tenantId} and booking_id = ${event.bookingId}
       and participant_id = ${event.participantId} and state in ('pending', 'signed')
       for no key update`.execute(trx);
  const live = rows[0];
  if (!live) {
    // Nothing live: assign now, as for a new participant.
    await assignBookingWaivers(trx, ctx, deps, {
      bookingId: event.bookingId,
      participantIds: [event.participantId],
    });
    return;
  }
  const signerChanged = requiredSignerFor(participant) !== live.required_signer;
  // A signature is a named person's: a new name for the participant, or for
  // the guardian who signed for a minor, asks for a new one.
  const signerField = live.required_signer === "guardian" ? "guardianName" : "name";
  const renamedAfterSigning =
    live.state === "signed" &&
    (event.changed.includes("name") || event.changed.includes(signerField));
  if (signerChanged || renamedAfterSigning) {
    await revokeParticipantWaivers(trx, ctx, {
      bookingId: event.bookingId,
      participantId: event.participantId,
      reason: "participant_changed",
    });
    await assignBookingWaivers(trx, ctx, deps, {
      bookingId: event.bookingId,
      participantIds: [event.participantId],
    });
    return;
  }
  const addressField = participant.minor ? "guardianEmail" : "email";
  if (live.state === "pending" && event.changed.includes(addressField)) {
    await sendWaiverRequest(trx, ctx, deps, {
      requestId: live.id,
      kind: "resend",
      reason: CORRECTED_ADDRESS_REASON,
      participant,
      whenAllowed: true,
    });
  }
}

/** The hooks the API passes on every path that confirms a booking or changes its party. */
export function createWaiverHooks(deps: WaiverDeps): BookingHooks {
  return {
    async bookingConfirmed(trx, ctx, event) {
      await assignBookingWaivers(trx, ctx, deps, { bookingId: event.bookingId });
    },
    async participantAdded(trx, ctx, event) {
      await assignBookingWaivers(trx, ctx, deps, {
        bookingId: event.bookingId,
        participantIds: [event.participantId],
      });
    },
    async participantUpdated(trx, ctx, event) {
      await onParticipantUpdated(trx, ctx, deps, event);
    },
    async bookingCanceled(trx, ctx, event) {
      await revokeBookingWaivers(trx, ctx, { bookingId: event.bookingId });
    },
  };
}
