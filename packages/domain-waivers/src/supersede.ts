/**
 * Moving unsigned work to a new version, when the operator publishes one and
 * asks for it. Each pending request on an older version of the template, for
 * a confirmed booking whose trip has not started, is superseded by a request
 * for the new version, which goes out at once; the old request's links and
 * sessions stop working. Signed requests and their evidence never change.
 */
import {
  enqueueOutbox,
  recordAudit,
  type TenantContext,
  type TenantTransaction,
} from "@tidegrid/database";
import { sql } from "kysely";
import { lockBookingForWaivers, requiredSignerFor } from "./assign.ts";
import { sendWaiverRequest } from "./delivery.ts";
import type { WaiverDeps } from "./ports.ts";

/** At most this many requests move in one publish; the rest keep their version. */
export const SUPERSEDE_LIMIT = 500;

export async function supersedeUnsignedRequests(
  trx: TenantTransaction,
  ctx: TenantContext,
  deps: WaiverDeps,
  input: { templateId: string; version: number },
): Promise<number> {
  const target = await trx
    .selectFrom("waiver_template_versions")
    .select(["content_sha256"])
    .where("tenant_id", "=", ctx.tenantId)
    .where("template_id", "=", input.templateId)
    .where("version", "=", input.version)
    .executeTakeFirstOrThrow();
  const { rows: candidates } = await sql<{ id: string; booking_id: string }>`
    select r.id, r.booking_id
      from waiver_requests r
      join bookings b on b.tenant_id = r.tenant_id and b.id = r.booking_id
      join scheduled_trips t on t.tenant_id = b.tenant_id and t.id = b.trip_id
     where r.tenant_id = ${ctx.tenantId} and r.template_id = ${input.templateId}
       and r.template_version < ${input.version} and r.state = 'pending'
       and b.state = 'confirmed' and t.starts_at > now()
     order by r.booking_id, r.id
     limit ${SUPERSEDE_LIMIT}`.execute(trx);

  let moved = 0;
  let lockedBooking: string | null = null;
  for (const candidate of candidates) {
    if (candidate.booking_id !== lockedBooking) {
      await lockBookingForWaivers(trx, ctx.tenantId, candidate.booking_id);
      lockedBooking = candidate.booking_id;
    }
    const { rows } = await sql<{ id: string; booking_id: string; participant_id: string }>`
      select id, booking_id, participant_id from waiver_requests
       where tenant_id = ${ctx.tenantId} and id = ${candidate.id} and state = 'pending'
         for no key update`.execute(trx);
    const old = rows[0];
    // Signed or ended since the list was read: it keeps what it has.
    if (!old) continue;
    const participant = (await deps.participants.list(trx, ctx.tenantId, old.booking_id)).find(
      (p) => p.id === old.participant_id,
    );
    if (!participant) continue;
    const replacementId = crypto.randomUUID();
    await sql`
      update waiver_requests set state = 'superseded', superseded_by = ${replacementId}
       where tenant_id = ${ctx.tenantId} and id = ${old.id}`.execute(trx);
    await sql`
      insert into waiver_requests (id, tenant_id, booking_id, participant_id, template_id,
        template_version, content_sha256, required_signer)
      values (${replacementId}, ${ctx.tenantId}, ${old.booking_id}, ${old.participant_id},
              ${input.templateId}, ${input.version}, ${target.content_sha256},
              ${requiredSignerFor(participant)})`.execute(trx);
    await sql`
      update waiver_access_tokens set revoked_at = now(), revoked_reason = 'superseded'
       where tenant_id = ${ctx.tenantId} and request_id = ${old.id}
         and redeemed_at is null and revoked_at is null`.execute(trx);
    await sql`
      update waiver_signing_sessions set revoked_at = now(), revoked_reason = 'superseded'
       where tenant_id = ${ctx.tenantId} and request_id = ${old.id} and revoked_at is null`.execute(
      trx,
    );
    await recordAudit(trx, ctx, {
      action: "waiver_request.superseded",
      subjectType: "waiver_request",
      subjectId: old.id,
      before: { state: "pending" },
      after: { state: "superseded", supersededBy: replacementId, templateVersion: input.version },
    });
    await enqueueOutbox(trx, ctx, {
      topic: "waiver.request.superseded",
      aggregateType: "waiver_request",
      aggregateId: old.id,
      payload: { requestId: old.id, supersededBy: replacementId, bookingId: old.booking_id },
    });
    await recordAudit(trx, ctx, {
      action: "waiver_request.assigned",
      subjectType: "waiver_request",
      subjectId: replacementId,
      after: {
        bookingId: old.booking_id,
        participantId: old.participant_id,
        templateId: input.templateId,
        templateVersion: input.version,
        contentSha256: target.content_sha256,
        requiredSigner: requiredSignerFor(participant),
        replaces: old.id,
      },
    });
    await sendWaiverRequest(trx, ctx, deps, {
      requestId: replacementId,
      kind: "initial",
      reason: null,
      participant,
    });
    moved++;
  }
  return moved;
}
