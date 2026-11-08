import type { Principal } from "@tidegrid/contracts";
import {
  claimIdempotencyKey,
  completeIdempotencyKey,
  IdempotencyKeyMismatchError,
  inTenantTransaction,
  isUuid,
  type JsonObject,
  requestHash,
  snapshotRead,
  type TenantContext,
  type TenantTransaction,
} from "@tidegrid/database";
import {
  can,
  loadStaffTenantAccess,
  loadSupportAccess,
  type Permission,
  recordSupportAccess,
  type StaffTenantAccess,
} from "@tidegrid/domain-identity";
import type { Context } from "hono";
import { sql } from "kysely";
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

/** Thrown inside the request's transaction to record a support access first. */
class SupportAccessUnrecorded extends Error {
  constructor(readonly allowed: boolean) {
    super("support access not yet recorded");
    this.name = "SupportAccessUnrecorded";
  }
}

/**
 * The read-only access a TideGrid support agent has through an owner's open
 * grant (W3-G2.2b), or null. The tenant row is read under row-level security,
 * so only the transaction's own tenant can answer.
 */
async function loadSupportTenantAccess(
  trx: TenantTransaction,
  tenantId: string,
  userId: string,
): Promise<StaffTenantAccess | null> {
  const grant = await loadSupportAccess(trx, userId);
  if (!grant) return null;
  const tenant = await trx
    .selectFrom("tenants")
    .select(["id", "slug", "display_name", "status"])
    .where("id", "=", tenantId)
    .executeTakeFirst();
  if (!tenant) return null;
  return {
    tenant: { id: tenant.id, slug: tenant.slug, name: tenant.display_name, status: tenant.status },
    role: grant.revealPersonalData ? "support_unmasked" : "support_masked",
    support: grant,
  };
}

/**
 * Run a staff request against one tenant in one transaction:
 * authenticate, bind tenant and actor context, confirm an active membership
 * (404 otherwise, so tenants cannot be probed), check the named permission
 * (403), optionally claim an idempotency key, run the command, store its
 * response for replay, and commit. Any thrown error rolls everything back.
 * The staff context is returned for work after commit, such as creating a
 * provider payment (G2.12d), which opens its own transactions.
 *
 * A signed-in TideGrid support agent with no membership gets in only through
 * an owner's open grant (W3-G2.2b): read-only, masked unless the owner chose
 * otherwise, never for a command. Each such request is first recorded in the
 * tenant's audit history in a transaction of its own, so the record stands
 * even when the read fails; the request then runs with actor type `support`.
 */
export async function withStaffTenant<T extends JsonObject>(
  c: Context<AppEnv>,
  deps: AppDeps,
  options: {
    tenantId: string;
    permission: Permission;
    idempotency?: IdempotentCommand;
    /**
     * A read whose statements must see one moment, such as a page and the
     * counts beside it (G2.12b): one REPEATABLE READ, READ ONLY transaction.
     * A command cannot be one, since it writes.
     */
    snapshot?: true;
  },
  run: (trx: TenantTransaction, ctx: StaffTenantContext) => Promise<T>,
): Promise<{ body: T; status: number; replayed: boolean; ctx: TenantContext }> {
  if (options.snapshot && options.idempotency) {
    throw new TypeError("a snapshot read takes no idempotency key: it never writes");
  }
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

  /** The support access the audit history already holds for this request. */
  type Recorded = { grantId: string; allowed: boolean };
  const attempt = (recorded: Recorded | null) =>
    inTenantTransaction(
      getDb(c),
      ctx,
      async (trx) => {
        let access = await loadStaffTenantAccess(trx, options.tenantId, principal.userId);
        if (!access) {
          access = await loadSupportTenantAccess(trx, options.tenantId, principal.userId);
          if (!access) throw tenantNotFound();
        }
        if (access.tenant.status !== "active") {
          throw new ApiError(403, "tenant_suspended", "This tenant is suspended");
        }
        const allowed = can(access.role, options.permission) && !(access.support && idem);
        // Every request support makes is recorded first, the refused ones too,
        // under the very grant and decision this attempt uses: a grant
        // replaced in between means recording again.
        if (
          access.support &&
          (recorded?.grantId !== access.support.grantId || recorded.allowed !== allowed)
        ) {
          throw new SupportAccessUnrecorded(allowed);
        }
        if (!allowed) {
          throw new ApiError(403, "forbidden", "Your role does not allow this action");
        }
        if (access.support) {
          // Audit rows and stamps written in this request name support, not staff.
          await sql`select set_config('app.actor_type', 'support', true)`.execute(trx);
          ctx.actorType = "support";
        }
        if (claim && idem) {
          const claimed = await claimIdempotencyKey(trx, ctx, claim);
          if (claimed.kind === "replay") {
            return { body: claimed.body as T, status: claimed.status, replayed: true, ctx };
          }
        }
        const body = await run(trx, { ...ctx, principal, access });
        if (claim && idem) {
          await completeIdempotencyKey(trx, ctx, claim, { status: idem.successStatus, body });
        }
        return { body, status: idem?.successStatus ?? 200, replayed: false, ctx };
      },
      options.snapshot ? snapshotRead : undefined,
    );

  try {
    let recorded: Recorded | null = null;
    for (let round = 0; ; round++) {
      let allowed: boolean;
      try {
        return await attempt(recorded);
      } catch (err) {
        if (!(err instanceof SupportAccessUnrecorded) || round >= 2) throw err;
        allowed = err.allowed;
      }
      const grant = await inTenantTransaction(getDb(c), { ...ctx, actorType: "support" }, (trx) =>
        recordSupportAccess(trx, { ...ctx, actorType: "support" }, principal.userId, {
          method: c.req.method,
          route: c.req.routePath,
          permission: options.permission,
          allowed,
        }),
      );
      if (!grant) throw tenantNotFound();
      recorded = { grantId: grant.grantId, allowed };
    }
  } catch (err) {
    if (err instanceof IdempotencyKeyMismatchError) {
      throw new ApiError(422, "idempotency_key_reused", err.message);
    }
    throw err;
  }
}
