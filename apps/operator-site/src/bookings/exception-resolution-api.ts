import type {
  ExceptionResolutionReason,
  FinalizationExceptionResolution,
  FinalizationExceptionResolvedResponse,
} from "@tidegrid/contracts";
import { call, errorCode, failureOf, type ReadFailure, tenantPath } from "../http.ts";
import { isInstant, isString } from "./api.ts";

/**
 * Mark a payment exception as followed up (W1-FIN-EXC). Owners and booking
 * staff only; the API refuses finance. Never throws.
 */

/**
 * Why an exception was not marked followed up:
 * - already_resolved: someone else followed it up first;
 * - refund_pending: the automatic refund has not settled yet;
 * - key_reused: the key went with a different request.
 */
export type ResolveFailure = ReadFailure | "already_resolved" | "refund_pending" | "key_reused";

export type ResolveResult =
  | { kind: "resolved"; resolution: FinalizationExceptionResolution }
  | { kind: "failed"; reason: ResolveFailure };

/**
 * `key` is the Idempotency-Key: a new one for each new resolution, the same
 * one when the same resolution is sent again after a failure, so the API
 * records it once. The API answers without the note, so a stored replay
 * holds no copy of it; the note shown is the text sent, as the API keeps it
 * (trimmed).
 */
export async function resolveException(
  tenantId: string,
  exceptionId: string,
  input: { reasonCode: ExceptionResolutionReason; note: string | null },
  key: string,
): Promise<ResolveResult> {
  try {
    const res = await call(
      `${tenantPath(tenantId)}/finalization-exceptions/${encodeURIComponent(exceptionId)}/resolution`,
      {
        method: "POST",
        headers: {
          accept: "application/json",
          "content-type": "application/json",
          "Idempotency-Key": key,
        },
        body: JSON.stringify(
          input.note === null
            ? { reasonCode: input.reasonCode }
            : { reasonCode: input.reasonCode, note: input.note },
        ),
      },
    );
    if (res.ok) {
      const data = (await res
        .json()
        .catch(() => null)) as Partial<FinalizationExceptionResolvedResponse> | null;
      const r = data?.resolution;
      if (
        !isString(r?.id) ||
        r.reasonCode !== input.reasonCode ||
        !isString(r.resolvedBy?.userId) ||
        !isString(r.resolvedBy?.name) ||
        !isInstant(r.resolvedAt)
      ) {
        return { kind: "failed", reason: "unreadable" };
      }
      return {
        kind: "resolved",
        resolution: {
          id: r.id,
          reasonCode: r.reasonCode,
          note: input.note === null ? null : input.note.trim(),
          resolvedBy: { userId: r.resolvedBy.userId, name: r.resolvedBy.name },
          resolvedAt: r.resolvedAt,
        },
      };
    }
    if (res.status === 409) {
      const code = await errorCode(res.clone());
      if (code === "exception_already_resolved")
        return { kind: "failed", reason: "already_resolved" };
      if (code === "exception_refund_pending") return { kind: "failed", reason: "refund_pending" };
    }
    if (res.status === 422 && (await errorCode(res.clone())) === "idempotency_key_reused") {
      return { kind: "failed", reason: "key_reused" };
    }
    return { kind: "failed", reason: await failureOf(res) };
  } catch {
    return { kind: "failed", reason: "unreachable" };
  }
}
