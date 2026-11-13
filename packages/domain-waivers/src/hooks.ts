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
 *   waiver, ends the request and assigns a new one; a new name on a pending
 *   request ends its staff-assisted codes and sessions, which staff confirmed
 *   by the old name; a corrected address on a pending request sends it there
 *   at once.
 * - bookingCanceled: end every request on the booking.
 * - bookingRescheduled: a signature carries over to the new trip only while
 *   the version it signed still applies (owner decision 2026-11-13); one
 *   signed on an older version ends, and the person is asked to sign the
 *   version in effect now.
 *
 * None of them refuses: confirmation and party changes never wait on waivers.
 */
import type { TenantContext, TenantTransaction } from "@tidegrid/database";
import type {
  BookingHooks,
  BookingRescheduledEvent,
  ParticipantUpdatedEvent,
} from "@tidegrid/domain-booking";
import { sql } from "kysely";
import {
  assignBookingWaivers,
  assignmentLockKey,
  lockBookingForWaivers,
  requiredSignerFor,
} from "./assign.ts";
import { endAssistedAccess } from "./assisted.ts";
import { loadBookingContext } from "./booking.ts";
import { sendWaiverRequest } from "./delivery.ts";
import type { WaiverDeps } from "./ports.ts";
import { revokeBookingWaivers, revokeParticipantWaivers, revokeStaleSignatures } from "./revoke.ts";
import { supersedeRequest } from "./supersede.ts";
import { findApplicableVersion } from "./templates.ts";

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
  // A pending request keeps its emailed link, but a staff-assisted code or
  // session was confirmed against the old name, so it ends.
  if (
    live.state === "pending" &&
    (event.changed.includes("name") || event.changed.includes(signerField))
  ) {
    await endAssistedAccess(
      trx,
      ctx.tenantId,
      { id: live.id, booking_id: event.bookingId, participant_id: event.participantId },
      "participant_changed",
    );
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

/**
 * After a move, every live request on a version that no longer applies is
 * brought to the version in effect now: a signature ends (`version_changed`)
 * and its person gets a new request; an unsigned request is superseded by one
 * for the current version, so nobody can sign the old text afterwards. A
 * request on the version that still applies carries over untouched.
 *
 * The requests are locked before their state is read, so a signature in
 * flight is waited for and then handled as signed. Locks: the booking first
 * (already held by the move), then the shared assignment key, then each
 * request and its messages, the order supersede.ts uses.
 */
export async function onBookingRescheduled(
  trx: TenantTransaction,
  ctx: TenantContext,
  deps: WaiverDeps,
  event: BookingRescheduledEvent,
): Promise<{ resigned: number }> {
  const locked = await lockBookingForWaivers(trx, ctx.tenantId, event.bookingId);
  if (locked?.state !== "confirmed") return { resigned: 0 };
  const booking = await loadBookingContext(trx, ctx.tenantId, event.bookingId);
  if (!booking) return { resigned: 0 };
  // As an assignment does: the version read here is the one assigned below.
  await sql`select pg_advisory_xact_lock_shared(hashtextextended(${assignmentLockKey(ctx.tenantId)}, 0))`.execute(
    trx,
  );
  const version = await findApplicableVersion(trx, ctx.tenantId, booking.productId);
  // No waiver applies now: nothing to sign again, and signatures stay.
  if (!version) return { resigned: 0 };
  const { rows } = await sql<{
    id: string;
    booking_id: string;
    participant_id: string;
    state: "pending" | "signed";
  }>`
    select id, booking_id, participant_id, state from waiver_requests
     where tenant_id = ${ctx.tenantId} and booking_id = ${event.bookingId}
       and state in ('pending', 'signed')
       and (template_id <> ${version.templateId} or template_version <> ${version.version})
     order by id
       for no key update`.execute(trx);
  let resigned = 0;
  for (const old of rows.filter((r) => r.state === "pending")) {
    const replaced = await supersedeRequest(trx, ctx, deps, old, {
      templateId: version.templateId,
      version: version.version,
      contentSha256: version.contentSha256,
    });
    if (replaced) resigned++;
  }
  const participantIds = rows.filter((r) => r.state === "signed").map((r) => r.participant_id);
  if (participantIds.length > 0) {
    await revokeStaleSignatures(trx, ctx, { bookingId: event.bookingId, participantIds });
    await assignBookingWaivers(trx, ctx, deps, {
      bookingId: event.bookingId,
      participantIds,
      version,
    });
    resigned += participantIds.length;
  }
  return { resigned };
}

/**
 * Before a move writes: the booking's live requests are locked ahead of its
 * messages, the order signing takes them (request, then its messages), so a
 * signature in flight and the move never wait on each other in a cycle.
 */
export async function onBookingRescheduling(
  trx: TenantTransaction,
  ctx: TenantContext,
  bookingId: string,
): Promise<void> {
  await sql`
    select id from waiver_requests
     where tenant_id = ${ctx.tenantId} and booking_id = ${bookingId}
       and state in ('pending', 'signed')
     order by id
       for no key update`.execute(trx);
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
    async participantRemoved(trx, ctx, event) {
      await revokeParticipantWaivers(trx, ctx, {
        bookingId: event.bookingId,
        participantId: event.participantId,
        reason: "participant_removed",
      });
    },
    async bookingCanceled(trx, ctx, event) {
      await revokeBookingWaivers(trx, ctx, { bookingId: event.bookingId });
    },
    async bookingRescheduling(trx, ctx, event) {
      await onBookingRescheduling(trx, ctx, event.bookingId);
    },
    async bookingRescheduled(trx, ctx, event) {
      await onBookingRescheduled(trx, ctx, deps, event);
    },
  };
}
