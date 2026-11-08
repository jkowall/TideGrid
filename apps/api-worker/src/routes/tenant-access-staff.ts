import { createRoute, type OpenAPIHono, z } from "@hono/zod-openapi";
import {
  DeletionRequestCreateRequest,
  DeletionRequestResponse,
  DeletionRequestWithdrawRequest,
  IdempotencyKey,
  InvitationListResponse,
  InvitationParams,
  InvitationResponse,
  MemberParams,
  MemberResponse,
  MemberStatusRequest,
  StaffTenantParams,
  SupportGrantCreateRequest,
  SupportGrantListResponse,
  SupportGrantParams,
  SupportGrantResponse,
  SupportGrantRevokeRequest,
  TenantExportResponse,
} from "@tidegrid/contracts";
import { inTenantTransaction, isUuid, type JsonObject, recordAudit } from "@tidegrid/database";
import {
  createDeletionRequest,
  exportTenantData,
  getOpenDeletionRequest,
  issueSupportGrant,
  listInvitations,
  listSupportGrants,
  respondToInvitation,
  revokeSupportGrant,
  setMemberStatus,
  withdrawDeletionRequest,
} from "@tidegrid/domain-identity";
import { requirePrincipal } from "../auth/principal.ts";
import type { AppDeps, AppEnv } from "../context.ts";
import { getDb } from "../db.ts";
import { ApiError } from "../errors.ts";
import { withStaffTenant } from "../staff-tenant.ts";
import { errorBody, staffSecurity } from "./responses.ts";

const memberStatusPath = "/v1/staff/tenants/{tenantId}/members/{userId}/status";
const invitationsPath = "/v1/staff/invitations";
const supportGrantsPath = "/v1/staff/tenants/{tenantId}/support-grants";
const supportGrantRevokePath = "/v1/staff/tenants/{tenantId}/support-grants/{grantId}/revoke";
const exportPath = "/v1/staff/tenants/{tenantId}/export";
const deletionPath = "/v1/staff/tenants/{tenantId}/deletion-request";
const deletionWithdrawPath = "/v1/staff/tenants/{tenantId}/deletion-request/withdraw";

const memberNotFound = () => new ApiError(404, "member_not_found", "No such member of this tenant");

/**
 * Tenant access remainder (W3-G2.2b, without managed OIDC and MFA): member
 * enable and disable, invitation answers, TideGrid support grants, the data
 * export, and the account deletion request. Owners alone change any of it;
 * a support agent in through a grant reads none of it.
 */
export function registerTenantAccessStaffRoutes(app: OpenAPIHono<AppEnv>, deps: AppDeps) {
  // Members ------------------------------------------------------------------------

  const memberStatusRoute = createRoute({
    method: "post",
    path: memberStatusPath,
    tags: ["staff"],
    summary: "Enable or disable a member",
    description: [
      "Owners only. disabled ends the member's access here at once; when it was their last active membership, it also signs them out of every session. active enables a member who accepted, or sends a fresh seven-day invitation to one who never did (including one whose invitation lapsed).",
      "Nobody changes their own status (409 member_self), and the last active owner stays (409 member_last_owner). The reason is recorded in the audit history. Idempotent by key.",
    ].join("\n\n"),
    security: staffSecurity,
    request: {
      params: MemberParams,
      headers: z.object({ "idempotency-key": IdempotencyKey }),
      body: { required: true, content: { "application/json": { schema: MemberStatusRequest } } },
    },
    responses: {
      200: {
        content: { "application/json": { schema: MemberResponse } },
        description: "The member as they are now",
      },
      400: errorBody("Invalid request"),
      401: errorBody("Not signed in"),
      403: errorBody("Role or origin does not allow this"),
      404: errorBody("No such tenant, or no such member (member_not_found)"),
      409: errorBody("Your own status (member_self), or the last active owner (member_last_owner)"),
      422: errorBody("Idempotency key reused with a different request"),
    },
  });

  app.openapi(memberStatusRoute, async (c) => {
    const { tenantId, userId } = c.req.valid("param");
    const input = c.req.valid("json");
    const key = c.req.valid("header")["idempotency-key"];
    const result = await withStaffTenant(
      c,
      deps,
      {
        tenantId,
        permission: "members.manage",
        idempotency: {
          scope: "members.status",
          key,
          route: memberStatusPath,
          params: { userId },
          body: input,
          successStatus: 200,
        },
      },
      async (trx, ctx) => {
        if (!isUuid(userId)) throw memberNotFound();
        const changed = await setMemberStatus(trx, ctx, userId, input);
        switch (changed.kind) {
          case "not_found":
            throw memberNotFound();
          case "self":
            throw new ApiError(409, "member_self", "You cannot change your own status");
          case "last_owner":
            throw new ApiError(
              409,
              "member_last_owner",
              "This tenant needs at least one active owner",
            );
          default:
            return { member: changed.member };
        }
      },
    );
    if (result.replayed) c.header("Idempotent-Replayed", "true");
    return c.json(result.body, 200);
  });

  // Invitations -----------------------------------------------------------------------

  const listInvitationsRoute = createRoute({
    method: "get",
    path: invitationsPath,
    tags: ["staff"],
    summary: "Your pending invitations",
    description:
      "The signed-in person's own invitations that have not been answered and have not lapsed, across operators.",
    security: staffSecurity,
    responses: {
      200: {
        content: { "application/json": { schema: InvitationListResponse } },
        description: "Pending invitations",
      },
      401: errorBody("Not signed in"),
      403: errorBody("Signed in through Access but not provisioned"),
    },
  });

  app.openapi(listInvitationsRoute, async (c) => {
    const principal = await requirePrincipal(c, deps);
    const invitations = await listInvitations(getDb(c), principal.userId);
    return c.json({ invitations }, 200);
  });

  for (const answer of ["accept", "decline"] as const) {
    const route = createRoute({
      method: "post",
      path: `${invitationsPath}/{tenantId}/${answer}`,
      tags: ["staff"],
      summary: answer === "accept" ? "Accept an invitation" : "Decline an invitation",
      description:
        answer === "accept"
          ? "The invited person only. Makes their membership active with the role they were invited to."
          : "The invited person only. Their membership becomes disabled; an owner may invite them again.",
      security: staffSecurity,
      request: { params: InvitationParams },
      responses: {
        200: {
          content: { "application/json": { schema: InvitationResponse } },
          description: "Answered",
        },
        401: errorBody("Not signed in"),
        403: errorBody("Origin not allowed"),
        404: errorBody("No pending invitation here for you (invitation_not_found)"),
      },
    });

    app.openapi(route, async (c) => {
      const { tenantId } = c.req.valid("param");
      const principal = await requirePrincipal(c, deps);
      const notFound = () =>
        new ApiError(404, "invitation_not_found", "No pending invitation here for you");
      if (!isUuid(tenantId)) throw notFound();
      const ctx = {
        tenantId,
        actorType: "staff" as const,
        actorId: principal.userId,
        requestId: c.get("requestId"),
        sourceIp: c.req.header("cf-connecting-ip") ?? null,
      };
      const status = await inTenantTransaction(getDb(c), ctx, (trx) =>
        respondToInvitation(trx, ctx, answer === "accept"),
      );
      if (!status) throw notFound();
      return c.json({ tenantId, status }, 200);
    });
  }

  // Support access ------------------------------------------------------------------------

  const listGrantsRoute = createRoute({
    method: "get",
    path: supportGrantsPath,
    tags: ["staff"],
    summary: "TideGrid support access granted for this tenant",
    description: "Owners only. The latest 50 grants, newest first, open, expired, or revoked.",
    security: staffSecurity,
    request: { params: StaffTenantParams },
    responses: {
      200: {
        content: { "application/json": { schema: SupportGrantListResponse } },
        description: "Grants",
      },
      401: errorBody("Not signed in"),
      403: errorBody("Role does not allow this"),
      404: errorBody("No such tenant for this account"),
    },
  });

  app.openapi(listGrantsRoute, async (c) => {
    const { tenantId } = c.req.valid("param");
    const { body } = await withStaffTenant(
      c,
      deps,
      { tenantId, permission: "support.manage" },
      async (trx) => ({ grants: await listSupportGrants(trx) }),
    );
    return c.json(body, 200);
  });

  const createGrantRoute = createRoute({
    method: "post",
    path: supportGrantsPath,
    tags: ["staff"],
    summary: "Let a TideGrid support agent read this tenant for a while",
    description: [
      "Owners only. One TideGrid support agent, named by their sign-in address, may read this tenant for 15 minutes to 4 hours (coordinator default D1, pending owner confirmation). Support reads only: the catalog, bookings as money, payments, exceptions, and the audit history. Bookers' names and emails and the staff list stay hidden unless revealPersonalData is true. Notes are never shown. Every request support makes that reaches the tenant, allowed or refused, is recorded in the audit history; a malformed request refused before any tenant data is read is not.",
      "An address that is not an active TideGrid support agent answers 404 support_agent_not_found. An agent with an open grant here answers 409 support_grant_open. Idempotent by key.",
    ].join("\n\n"),
    security: staffSecurity,
    request: {
      params: StaffTenantParams,
      headers: z.object({ "idempotency-key": IdempotencyKey }),
      body: {
        required: true,
        content: { "application/json": { schema: SupportGrantCreateRequest } },
      },
    },
    responses: {
      201: {
        content: { "application/json": { schema: SupportGrantResponse } },
        description: "Granted",
      },
      400: errorBody("Invalid request"),
      401: errorBody("Not signed in"),
      403: errorBody("Role or origin does not allow this"),
      404: errorBody("No such tenant, or not a TideGrid support agent (support_agent_not_found)"),
      409: errorBody("That agent already has an open grant here (support_grant_open)"),
      422: errorBody("Idempotency key reused with a different request"),
    },
  });

  app.openapi(createGrantRoute, async (c) => {
    const { tenantId } = c.req.valid("param");
    const input = c.req.valid("json");
    const key = c.req.valid("header")["idempotency-key"];
    const result = await withStaffTenant(
      c,
      deps,
      {
        tenantId,
        permission: "support.manage",
        idempotency: {
          scope: "support.grant",
          key,
          route: supportGrantsPath,
          body: input,
          successStatus: 201,
        },
      },
      async (trx, ctx) => {
        const issued = await issueSupportGrant(trx, ctx, input);
        if (issued.kind === "unknown_agent") {
          throw new ApiError(
            404,
            "support_agent_not_found",
            "That address is not an active TideGrid support agent",
          );
        }
        if (issued.kind === "already_open") {
          throw new ApiError(
            409,
            "support_grant_open",
            "That agent already has an open grant here",
          );
        }
        return { grant: issued.grant };
      },
    );
    if (result.replayed) c.header("Idempotent-Replayed", "true");
    return c.json(result.body, 201);
  });

  const revokeGrantRoute = createRoute({
    method: "post",
    path: supportGrantRevokePath,
    tags: ["staff"],
    summary: "End a support grant now",
    description: "Owners only. Idempotent by key. A grant that is not open answers 404.",
    security: staffSecurity,
    request: {
      params: SupportGrantParams,
      headers: z.object({ "idempotency-key": IdempotencyKey }),
      body: {
        required: true,
        content: { "application/json": { schema: SupportGrantRevokeRequest } },
      },
    },
    responses: {
      200: {
        content: { "application/json": { schema: SupportGrantResponse } },
        description: "Revoked",
      },
      400: errorBody("Invalid request"),
      401: errorBody("Not signed in"),
      403: errorBody("Role or origin does not allow this"),
      404: errorBody("No such tenant, or no open grant (support_grant_not_found)"),
      422: errorBody("Idempotency key reused with a different request"),
    },
  });

  app.openapi(revokeGrantRoute, async (c) => {
    const { tenantId, grantId } = c.req.valid("param");
    const input = c.req.valid("json");
    const key = c.req.valid("header")["idempotency-key"];
    const notFound = () =>
      new ApiError(404, "support_grant_not_found", "No open support grant with that id here");
    const result = await withStaffTenant(
      c,
      deps,
      {
        tenantId,
        permission: "support.manage",
        idempotency: {
          scope: "support.revoke",
          key,
          route: supportGrantRevokePath,
          params: { grantId },
          body: input,
          successStatus: 200,
        },
      },
      async (trx, ctx) => {
        if (!isUuid(grantId)) throw notFound();
        const revoked = await revokeSupportGrant(trx, ctx, grantId, input.reason);
        if (revoked.kind === "not_open") throw notFound();
        return { grant: revoked.grant };
      },
    );
    if (result.replayed) c.header("Idempotent-Replayed", "true");
    return c.json(result.body, 200);
  });

  // Data export --------------------------------------------------------------------------

  const exportRoute = createRoute({
    method: "get",
    path: exportPath,
    tags: ["staff"],
    summary: "Export this tenant's data",
    description:
      "Owners only. The tenant's records as one JSON document, one section per table, each up to 10,000 rows with a truncated flag, all read at one moment. Bookers, participants, waiver evidence, notes, and the audit history are included; sign-in and guest link credentials, token hashes, provider idempotency keys, client addresses, email messages, and short-lived working state are not. Each export is recorded in the audit history before it is read.",
    security: staffSecurity,
    request: { params: StaffTenantParams },
    responses: {
      200: {
        content: { "application/json": { schema: TenantExportResponse } },
        description: "The export, as an attachment",
      },
      401: errorBody("Not signed in"),
      403: errorBody("Role does not allow this"),
      404: errorBody("No such tenant for this account"),
    },
  });

  app.openapi(exportRoute, async (c) => {
    const { tenantId } = c.req.valid("param");
    await withStaffTenant(c, deps, { tenantId, permission: "data.export" }, async (trx, ctx) => {
      await recordAudit(trx, ctx, {
        action: "tenant.data_exported",
        subjectType: "tenant",
        subjectId: tenantId,
        before: null,
        after: { format: "tidegrid.tenant-export.v1" },
      });
      return {} as JsonObject;
    });
    const { body } = await withStaffTenant(
      c,
      deps,
      { tenantId, permission: "data.export", snapshot: true },
      async (trx, ctx) =>
        (await exportTenantData(trx, ctx.access.tenant, {
          now: deps.now?.() ?? new Date(),
        })) as unknown as JsonObject,
    );
    c.header(
      "Content-Disposition",
      `attachment; filename="tidegrid-export-${(body.tenant as { slug: string }).slug}.json"`,
    );
    return c.json(body as TenantExportResponse, 200);
  });

  // Account deletion request ----------------------------------------------------------------

  const getDeletionRoute = createRoute({
    method: "get",
    path: deletionPath,
    tags: ["staff"],
    summary: "This tenant's open account deletion request",
    security: staffSecurity,
    request: { params: StaffTenantParams },
    responses: {
      200: {
        content: { "application/json": { schema: DeletionRequestResponse } },
        description: "The open request, or null",
      },
      401: errorBody("Not signed in"),
      403: errorBody("Role does not allow this"),
      404: errorBody("No such tenant for this account"),
    },
  });

  app.openapi(getDeletionRoute, async (c) => {
    const { tenantId } = c.req.valid("param");
    const { body } = await withStaffTenant(
      c,
      deps,
      { tenantId, permission: "account.manage" },
      async (trx) => ({ request: await getOpenDeletionRequest(trx, tenantId) }),
    );
    return c.json(body, 200);
  });

  const createDeletionRoute = createRoute({
    method: "post",
    path: deletionPath,
    tags: ["staff"],
    summary: "Ask TideGrid to close and delete this account",
    description:
      "Owners only. Type the tenant's slug again in confirmSlug. Records the request, which TideGrid follows up; nothing is deleted by this call, and the request can be withdrawn until then. One open request at a time (409 deletion_request_open); a wrong slug answers 422 deletion_slug_mismatch. Idempotent by key.",
    security: staffSecurity,
    request: {
      params: StaffTenantParams,
      headers: z.object({ "idempotency-key": IdempotencyKey }),
      body: {
        required: true,
        content: { "application/json": { schema: DeletionRequestCreateRequest } },
      },
    },
    responses: {
      201: {
        content: { "application/json": { schema: DeletionRequestResponse } },
        description: "Requested",
      },
      400: errorBody("Invalid request"),
      401: errorBody("Not signed in"),
      403: errorBody("Role or origin does not allow this"),
      404: errorBody("No such tenant for this account"),
      409: errorBody("A request is already open (deletion_request_open)"),
      422: errorBody("Wrong slug (deletion_slug_mismatch), or idempotency key reused"),
    },
  });

  app.openapi(createDeletionRoute, async (c) => {
    const { tenantId } = c.req.valid("param");
    const input = c.req.valid("json");
    const key = c.req.valid("header")["idempotency-key"];
    const result = await withStaffTenant(
      c,
      deps,
      {
        tenantId,
        permission: "account.manage",
        idempotency: {
          scope: "account.deletion_request",
          key,
          route: deletionPath,
          body: input,
          successStatus: 201,
        },
      },
      async (trx, ctx) => {
        const created = await createDeletionRequest(trx, ctx, ctx.access.tenant.slug, input);
        if (created.kind === "slug_mismatch") {
          throw new ApiError(
            422,
            "deletion_slug_mismatch",
            "Type this operator's slug exactly to confirm",
          );
        }
        if (created.kind === "already_open") {
          throw new ApiError(409, "deletion_request_open", "A deletion request is already open");
        }
        return { request: created.request };
      },
    );
    if (result.replayed) c.header("Idempotent-Replayed", "true");
    return c.json(result.body, 201);
  });

  const withdrawDeletionRoute = createRoute({
    method: "post",
    path: deletionWithdrawPath,
    tags: ["staff"],
    summary: "Withdraw the open account deletion request",
    description: "Owners only. Idempotent by key. No open request answers 404.",
    security: staffSecurity,
    request: {
      params: StaffTenantParams,
      headers: z.object({ "idempotency-key": IdempotencyKey }),
      body: {
        required: true,
        content: { "application/json": { schema: DeletionRequestWithdrawRequest } },
      },
    },
    responses: {
      200: {
        content: { "application/json": { schema: DeletionRequestResponse } },
        description: "Withdrawn",
      },
      400: errorBody("Invalid request"),
      401: errorBody("Not signed in"),
      403: errorBody("Role or origin does not allow this"),
      404: errorBody("No such tenant, or no open request (deletion_request_not_found)"),
      422: errorBody("Idempotency key reused with a different request"),
    },
  });

  app.openapi(withdrawDeletionRoute, async (c) => {
    const { tenantId } = c.req.valid("param");
    const input = c.req.valid("json");
    const key = c.req.valid("header")["idempotency-key"];
    const result = await withStaffTenant(
      c,
      deps,
      {
        tenantId,
        permission: "account.manage",
        idempotency: {
          scope: "account.deletion_withdraw",
          key,
          route: deletionWithdrawPath,
          body: input,
          successStatus: 200,
        },
      },
      async (trx, ctx) => {
        const withdrawn = await withdrawDeletionRequest(trx, ctx, input.reason);
        if (withdrawn.kind === "none_open") {
          throw new ApiError(
            404,
            "deletion_request_not_found",
            "There is no open deletion request",
          );
        }
        return { request: withdrawn.request };
      },
    );
    if (result.replayed) c.header("Idempotent-Replayed", "true");
    return c.json(result.body, 200);
  });
}
