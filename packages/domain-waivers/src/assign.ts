/**
 * Automatic assignment. When a booking confirms, and whenever a participant
 * is added to a confirmed booking, each participant without a live request
 * gets one, for the version that applies now, and its first delivery is
 * queued. Everything runs in the caller's transaction, so the requests exist
 * only if the confirmation or the addition commits.
 *
 * Idempotent: a per-booking transaction lock serializes assignment for one
 * booking, a participant with a pending or signed request is skipped, and the
 * assignment key (tenant, booking, participant, version) refuses a duplicate
 * at the database. A retried confirmation or addition creates nothing new and
 * sends nothing.
 */
import {
  enqueueOutbox,
  isUuid,
  recordAudit,
  type TenantContext,
  type TenantTransaction,
  type WaiverSignerRole,
} from "@tidegrid/database";
import { sql } from "kysely";
import { loadBookingContext } from "./booking.ts";
import { type SendResult, sendWaiverRequest } from "./delivery.ts";
import type { WaiverDeps, WaiverParticipant } from "./ports.ts";
import { type ApplicableVersion, findApplicableVersion } from "./templates.ts";

export interface AssignedRequest {
  requestId: string;
  participantId: string;
  requiredSigner: WaiverSignerRole;
  /** What the first delivery did; a missing address leaves the request waiting. */
  delivery: SendResult;
}

export interface AssignResult {
  /** False when no waiver applies to the booking's product. */
  required: boolean;
  version: ApplicableVersion | null;
  created: AssignedRequest[];
  /** Participants that already had a pending or signed request. */
  alreadyAssigned: number;
}

/** Serializes waiver assignment for one booking. */
export async function lockBookingWaivers(
  trx: TenantTransaction,
  tenantId: string,
  bookingId: string,
): Promise<void> {
  await sql`select pg_advisory_xact_lock(hashtextextended(${`tidegrid.waivers:${tenantId}:${bookingId}`}, 0))`.execute(
    trx,
  );
}

export function requiredSignerFor(participant: WaiverParticipant): WaiverSignerRole {
  return participant.minor ? "guardian" : "participant";
}

/**
 * Assign the booking's waivers: for every current participant, or only the
 * ones named. The booking must be confirmed in this transaction's view.
 */
export async function assignBookingWaivers(
  trx: TenantTransaction,
  ctx: TenantContext,
  deps: WaiverDeps,
  input: { bookingId: string; participantIds?: readonly string[] },
): Promise<AssignResult> {
  if (!isUuid(input.bookingId)) throw new TypeError("booking id must be a UUID");
  await lockBookingWaivers(trx, ctx.tenantId, input.bookingId);
  const booking = await loadBookingContext(trx, ctx.tenantId, input.bookingId);
  if (!booking) throw new Error("booking not found in this tenant");
  if (booking.state !== "confirmed") {
    return { required: false, version: null, created: [], alreadyAssigned: 0 };
  }
  const version = await findApplicableVersion(trx, ctx.tenantId, booking.productId);
  if (!version) return { required: false, version: null, created: [], alreadyAssigned: 0 };

  const wanted = input.participantIds ? new Set(input.participantIds) : null;
  const participants = (await deps.participants.list(trx, ctx.tenantId, booking.bookingId)).filter(
    (p) => wanted === null || wanted.has(p.id),
  );
  const live = new Set(
    (
      await trx
        .selectFrom("waiver_requests")
        .select("participant_id")
        .where("tenant_id", "=", ctx.tenantId)
        .where("booking_id", "=", booking.bookingId)
        .where("state", "in", ["pending", "signed"])
        .execute()
    ).map((r) => r.participant_id),
  );

  const created: AssignedRequest[] = [];
  let alreadyAssigned = 0;
  for (const participant of participants) {
    if (live.has(participant.id)) {
      alreadyAssigned++;
      continue;
    }
    const requiredSigner = requiredSignerFor(participant);
    const { rows } = await sql<{ id: string }>`
      insert into waiver_requests (tenant_id, booking_id, participant_id, template_id,
        template_version, content_sha256, required_signer)
      values (${ctx.tenantId}, ${booking.bookingId}, ${participant.id}, ${version.templateId},
              ${version.version}, ${version.contentSha256}, ${requiredSigner})
      on conflict do nothing
      returning id`.execute(trx);
    const requestId = rows[0]?.id;
    if (!requestId) {
      // The assignment key already holds this participant and version: a
      // request that was revoked or superseded keeps it, and is not reopened.
      alreadyAssigned++;
      continue;
    }
    await recordAudit(trx, ctx, {
      action: "waiver_request.assigned",
      subjectType: "waiver_request",
      subjectId: requestId,
      after: {
        bookingId: booking.bookingId,
        participantId: participant.id,
        templateId: version.templateId,
        templateVersion: version.version,
        contentSha256: version.contentSha256,
        requiredSigner,
      },
    });
    await enqueueOutbox(trx, ctx, {
      topic: "waiver.request.assigned",
      aggregateType: "waiver_request",
      aggregateId: requestId,
      payload: {
        requestId,
        bookingId: booking.bookingId,
        participantId: participant.id,
        templateId: version.templateId,
        templateVersion: version.version,
      },
    });
    const delivery = await sendWaiverRequest(trx, ctx, deps, {
      requestId,
      kind: "initial",
      reason: null,
      booking,
      participant,
    });
    created.push({ requestId, participantId: participant.id, requiredSigner, delivery });
  }
  return { required: true, version, created, alreadyAssigned };
}
