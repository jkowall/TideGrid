import type { Principal } from "@tidegrid/contracts";
import {
  claimIdempotencyKey,
  completeIdempotencyKey,
  IdempotencyKeyMismatchError,
  inTenantTransaction,
  isUuid,
  type JsonObject,
  requestHash,
  type TenantContext,
  type TenantTransaction,
} from "@tidegrid/database";
import {
  can,
  loadStaffTenantAccess,
  type Permission,
  type StaffTenantAccess,
} from "@tidegrid/domain-identity";
import type { Context } from "hono";
import { requirePrincipal } from "./auth/principal.ts";
import type { AppDeps, AppEnv } from "./context.ts";
import { getDb } from "./db.ts";
import { ApiError, tenantNotFound } from "./errors.ts";

export interface StaffTenantContext extends TenantContext {
  principal: Principal;
  access: StaffTenantAccess;
}

export interface IdempotentCommand {
  /** Operation name, for example `members.create`. */
  scope: string;
  key: string;
  /** Route template, so the same body on another route never matches. */
  route: string;
  /** Path ids beyond the tenant, so the same key on another resource never replays. */
  params?: Record<string, string>;
  body: unknown;
  successStatus: number;
}

/**
 * Run a staff request against one tenant in one transaction:
 * authenticate, bind tenant and actor context, confirm an active membership
 * (404 otherwise, so tenants cannot be probed), check the named permission
 * (403), optionally claim an idempotency key, run the command, store its
 * response for replay, and commit. Any thrown error rolls everything back.
 */
export async function withStaffTenant<T extends JsonObject>(
  c: Context<AppEnv>,
  deps: AppDeps,
  options: { tenantId: string; permission: Permission; idempotency?: IdempotentCommand },
  run: (trx: TenantTransaction, ctx: StaffTenantContext) => Promise<T>,
): Promise<{ body: T; status: number; replayed: boolean }> {
  const principal = await requirePrincipal(c, deps);
  if (!isUuid(options.tenantId)) throw tenantNotFound();
  const ctx: TenantContext = {
    tenantId: options.tenantId,
    actorType: "staff",
    actorId: principal.userId,
    requestId: c.get("requestId"),
    sourceIp: c.req.header("cf-connecting-ip") ?? null,
  };
  const idem = options.idempotency;
  const claim = idem
    ? {
        scope: idem.scope,
        principal: `staff:${principal.userId}`,
        key: idem.key,
        requestHash: await requestHash({
          method: c.req.method,
          route: idem.route,
          params: { ...idem.params, tenantId: options.tenantId },
          body: idem.body,
        }),
      }
    : null;

  try {
    return await inTenantTransaction(getDb(c), ctx, async (trx) => {
      const access = await loadStaffTenantAccess(trx, options.tenantId, principal.userId);
      if (!access) throw tenantNotFound();
      if (access.tenant.status !== "active") {
        throw new ApiError(403, "tenant_suspended", "This tenant is suspended");
      }
      if (!can(access.role, options.permission)) {
        throw new ApiError(403, "forbidden", "Your role does not allow this action");
      }
      if (claim && idem) {
        const claimed = await claimIdempotencyKey(trx, ctx, claim);
        if (claimed.kind === "replay") {
          return { body: claimed.body as T, status: claimed.status, replayed: true };
        }
      }
      const body = await run(trx, { ...ctx, principal, access });
      if (claim && idem) {
        await completeIdempotencyKey(trx, ctx, claim, { status: idem.successStatus, body });
      }
      return { body, status: idem?.successStatus ?? 200, replayed: false };
    });
  } catch (err) {
    if (err instanceof IdempotencyKeyMismatchError) {
      throw new ApiError(422, "idempotency_key_reused", err.message);
    }
    throw err;
  }
}
