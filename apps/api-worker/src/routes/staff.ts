import { createRoute, type OpenAPIHono, z } from "@hono/zod-openapi";
import {
  AuditEventListResponse,
  AuditEventQuery,
  IdempotencyKey,
  MemberCreateRequest,
  MemberListResponse,
  MemberResponse,
  StaffTenantParams,
} from "@tidegrid/contracts";
import { addMember, listAuditEvents, listMembers } from "@tidegrid/domain-identity";
import type { AppDeps, AppEnv } from "../context.ts";
import { ApiError } from "../errors.ts";
import { withStaffTenant } from "../staff-tenant.ts";
import { errorBody, staffSecurity } from "./responses.ts";

const membersPath = "/v1/staff/tenants/{tenantId}/members";

export function registerStaffRoutes(app: OpenAPIHono<AppEnv>, deps: AppDeps) {
  const listMembersRoute = createRoute({
    method: "get",
    path: membersPath,
    tags: ["staff"],
    summary: "List the tenant's staff members",
    security: staffSecurity,
    request: { params: StaffTenantParams },
    responses: {
      200: {
        content: { "application/json": { schema: MemberListResponse } },
        description: "Members",
      },
      401: errorBody("Not signed in"),
      403: errorBody("Role does not allow this"),
      404: errorBody("No such tenant for this account"),
    },
  });

  app.openapi(listMembersRoute, async (c) => {
    const { tenantId } = c.req.valid("param");
    const { body } = await withStaffTenant(
      c,
      deps,
      { tenantId, permission: "members.read" },
      async (trx) => ({ members: await listMembers(trx, tenantId) }),
    );
    return c.json(body, 200);
  });

  const createMemberRoute = createRoute({
    method: "post",
    path: membersPath,
    tags: ["staff"],
    summary: "Add a staff member with a role",
    description:
      "Owner only. Idempotent: a retry with the same key and body replays the first response with `Idempotent-Replayed: true`.",
    security: staffSecurity,
    request: {
      params: StaffTenantParams,
      headers: z.object({ "idempotency-key": IdempotencyKey }),
      body: { required: true, content: { "application/json": { schema: MemberCreateRequest } } },
    },
    responses: {
      201: {
        content: { "application/json": { schema: MemberResponse } },
        description: "Member added (or the stored response replayed)",
      },
      400: errorBody("Invalid request"),
      401: errorBody("Not signed in"),
      403: errorBody("Role or origin does not allow this"),
      404: errorBody("No such tenant for this account"),
      409: errorBody("Already a member"),
      422: errorBody("Idempotency key reused with a different request"),
    },
  });

  app.openapi(createMemberRoute, async (c) => {
    const { tenantId } = c.req.valid("param");
    const input = c.req.valid("json");
    const key = c.req.valid("header")["idempotency-key"];
    const result = await withStaffTenant(
      c,
      deps,
      {
        tenantId,
        permission: "members.manage",
        idempotency: {
          scope: "members.create",
          key,
          route: membersPath,
          body: input,
          successStatus: 201,
        },
      },
      async (trx, ctx) => {
        const added = await addMember(trx, ctx, input);
        if (added.kind === "exists") {
          throw new ApiError(409, "member_exists", "That person is already a member here");
        }
        return { member: added.member };
      },
    );
    if (result.replayed) c.header("Idempotent-Replayed", "true");
    return c.json(result.body, 201);
  });

  const listAuditRoute = createRoute({
    method: "get",
    path: "/v1/staff/tenants/{tenantId}/audit-events",
    tags: ["staff"],
    summary: "Tenant audit history, newest first",
    security: staffSecurity,
    request: { params: StaffTenantParams, query: AuditEventQuery },
    responses: {
      200: {
        content: { "application/json": { schema: AuditEventListResponse } },
        description: "A page of audit events",
      },
      401: errorBody("Not signed in"),
      403: errorBody("Role does not allow this"),
      404: errorBody("No such tenant for this account"),
    },
  });

  app.openapi(listAuditRoute, async (c) => {
    const { tenantId } = c.req.valid("param");
    const { limit, before } = c.req.valid("query");
    const { body } = await withStaffTenant(c, deps, { tenantId, permission: "audit.read" }, (trx) =>
      listAuditEvents(trx, tenantId, { limit, before }),
    );
    return c.json(body, 200);
  });
}
