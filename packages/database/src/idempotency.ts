import type { TenantContext, TenantTransaction } from "./tenant.ts";
import type { JsonObject } from "./types.ts";

export interface IdempotencyClaim {
  /** Operation name, dotted and lowercase: `members.create`. */
  scope: string;
  /** Who is acting, for example `staff:<uuid>`. Keys never cross principals. */
  principal: string;
  key: string;
  /** SHA-256 hex of the canonical request; see `requestHash`. */
  requestHash: string;
}

export type ClaimResult = { kind: "new" } | { kind: "replay"; status: number; body: JsonObject };

/** The same key was reused with a different request. */
export class IdempotencyKeyMismatchError extends Error {
  constructor() {
    super("idempotency key was already used with a different request");
    this.name = "IdempotencyKeyMismatchError";
  }
}

/**
 * Claim a key inside the command's transaction, before any domain write.
 *
 * - New key: the insert succeeds and the command proceeds.
 * - Duplicate in flight: the insert waits on the primary key until the first
 *   transaction finishes. If it committed, this call replays its response; if
 *   it rolled back, this call claims the key and proceeds.
 * - Completed key: replay the stored response when the request matches, or
 *   raise `IdempotencyKeyMismatchError` when it does not.
 */
export async function claimIdempotencyKey(
  trx: TenantTransaction,
  ctx: TenantContext,
  claim: IdempotencyClaim,
): Promise<ClaimResult> {
  const inserted = await trx
    .insertInto("idempotency_keys")
    .values({
      tenant_id: ctx.tenantId,
      scope: claim.scope,
      principal: claim.principal,
      key: claim.key,
      request_hash: claim.requestHash,
    })
    .onConflict((oc) => oc.columns(["tenant_id", "scope", "principal", "key"]).doNothing())
    .returning("key")
    .executeTakeFirst();
  if (inserted) return { kind: "new" };

  const existing = await trx
    .selectFrom("idempotency_keys")
    .select(["request_hash", "status", "response_status", "response_body"])
    .where("tenant_id", "=", ctx.tenantId)
    .where("scope", "=", claim.scope)
    .where("principal", "=", claim.principal)
    .where("key", "=", claim.key)
    .executeTakeFirst();
  if (!existing) {
    // The conflicting row belongs to this tenant, so it must be visible.
    throw new Error("idempotency conflict row is not visible; tenant context is inconsistent");
  }
  if (existing.request_hash !== claim.requestHash) throw new IdempotencyKeyMismatchError();
  if (existing.status !== "completed" || existing.response_status === null) {
    throw new Error("idempotency key is visible before completion; claim invariant broken");
  }
  return { kind: "replay", status: existing.response_status, body: existing.response_body ?? {} };
}

/** Store the successful response in the same transaction, just before commit. */
export async function completeIdempotencyKey(
  trx: TenantTransaction,
  ctx: TenantContext,
  claim: IdempotencyClaim,
  response: { status: number; body: JsonObject },
): Promise<void> {
  if (response.status < 200 || response.status > 299) {
    throw new RangeError("only successful responses are stored for replay");
  }
  const result = await trx
    .updateTable("idempotency_keys")
    .set({
      status: "completed",
      response_status: response.status,
      response_body: response.body,
      completed_at: new Date(),
    })
    .where("tenant_id", "=", ctx.tenantId)
    .where("scope", "=", claim.scope)
    .where("principal", "=", claim.principal)
    .where("key", "=", claim.key)
    .where("status", "=", "in_progress")
    .executeTakeFirst();
  if (result.numUpdatedRows !== 1n) {
    throw new Error("idempotency key was not claimed in this transaction");
  }
}

/** JSON with object keys sorted at every depth, so equal requests hash equally. */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(",")}}`;
}

/** SHA-256 hex over method, route, path parameters, and canonical body. */
export async function requestHash(parts: {
  method: string;
  route: string;
  params?: Record<string, string>;
  body?: unknown;
}): Promise<string> {
  const text = [
    parts.method.toUpperCase(),
    parts.route,
    canonicalJson(parts.params ?? {}),
    canonicalJson(parts.body ?? null),
  ].join("\n");
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
