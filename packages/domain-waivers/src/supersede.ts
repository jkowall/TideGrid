/**
 * Moving unsigned work to a new version, when the operator publishes one and
 * asks for it. Each pending request on an older version of the template, for
 * a confirmed booking whose trip has not started, is superseded by a request
 * for the new version, which goes out at once; the old request's links and
 * sessions stop working. Signed requests and their evidence never change.
 *
 * It runs after the version's publish commits, in transactions of its own:
 *
 * 1. a check that the version exists and is in effect now;
 * 2. a barrier: the tenant's assignment key taken exclusive and let go at
 *    once, which waits for every assignment that might have read the older
 *    version (each holds the key shared until it commits); any assignment
 *    after that reads the new version;
 * 3. the move itself, booking by booking, under each booking's lock.
 *
 * Holding the key through the move would deadlock: an assignment holds its
 * booking's lock while it waits for the key, and the move needs that lock.
 */
import {
  type Database,
  enqueueOutbox,
  inTenantTransaction,
  isUuid,
  recordAudit,
  type TenantContext,
  type TenantTransaction,
} from "@tidegrid/database";
import { type Kysely, sql } from "kysely";
import { assignmentLockKey, lockBookingForWaivers, requiredSignerFor } from "./assign.ts";
import { sendWaiverRequest } from "./delivery.ts";
import { closeRequestAccess } from "./links.ts";
import type { WaiverDeps } from "./ports.ts";

/** At most this many requests move in one publish; the rest keep their version. */
export const SUPERSEDE_LIMIT = 500;

export type ReassignResult =
  | { kind: "reassigned"; moved: number }
  | { kind: "not_found" }
  /** Unsigned requests move only to a version in effect now. */
  | { kind: "not_in_effect" };

/**
 * Move unsigned requests on the template's older versions to `version`, a
 * version whose publish has committed. Call it after the publish's
 * transaction, never inside one.
 */
export async function reassignUnsignedRequests(
  db: Kysely<Database>,
  ctx: TenantContext,
  deps: WaiverDeps,
  input: { templateId: string; version: number },
): Promise<ReassignResult> {
  if (!isUuid(input.templateId) || !Number.isInteger(input.version)) return { kind: "not_found" };
  const target = await inTenantTransaction(db, ctx, async (trx) => {
    const { rows } = await sql<{ in_effect: boolean }>`
      select (effective_from <= clock_timestamp()
              and (effective_until is null or effective_until > clock_timestamp()))
             as in_effect
        from waiver_template_versions
       where tenant_id = ${ctx.tenantId} and template_id = ${input.templateId}
         and version = ${input.version}`.execute(trx);
    return rows[0] ?? null;
  });
  if (!target) return { kind: "not_found" };
  if (!target.in_effect) return { kind: "not_in_effect" };
  await inTenantTransaction(db, ctx, async (trx) => {
    await sql`select pg_advisory_xact_lock(hashtextextended(${assignmentLockKey(ctx.tenantId)}, 0))`.execute(
      trx,
    );
  });
  const moved = await inTenantTransaction(db, ctx, (trx) =>
    supersedeUnsignedRequests(trx, ctx, deps, input),
  );
  return { kind: "reassigned", moved };
}

async function supersedeUnsignedRequests(
  trx: TenantTransaction,
  ctx: TenantContext,
  deps: WaiverDeps,
  input: { templateId: string; version: number },
): Promise<number> {
  // One move per template at a time: a later move waits for an earlier one to
  // commit, then sees its replacements among its own candidates. Assignments
  // never take this key, so it adds no wait to them.
  await sql`select pg_advisory_xact_lock(hashtextextended(${`tidegrid.waiver_move:${ctx.tenantId}:${input.templateId}`}, 0))`.execute(
    trx,
  );
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
    await closeRequestAccess(trx, ctx, old, { link: "withdrawn", session: "superseded" });
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
      whenAllowed: true,
    });
    moved++;
  }
  return moved;
}
