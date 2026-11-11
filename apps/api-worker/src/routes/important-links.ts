import { createRoute, type OpenAPIHono, z } from "@hono/zod-openapi";
import {
  IdempotencyKey,
  ImportantLinkInput,
  ImportantLinkResponse,
  ImportantLinksResponse,
  PublicImportantLinksResponse,
  StaffTenantParams,
} from "@tidegrid/contracts";
import { inTenantTransaction, isUuid } from "@tidegrid/database";
import {
  archiveImportantLink,
  createImportantLink,
  guestImportantLinks,
  type ImportantLinkResult,
  listImportantLinks,
  updateImportantLink,
} from "@tidegrid/domain-catalog";
import type { AppDeps, AppEnv } from "../context.ts";
import { getDb } from "../db.ts";
import { ApiError } from "../errors.ts";
import { resolvePublicTenant } from "../public-tenant.ts";
import { withStaffTenant } from "../staff-tenant.ts";
import { errorBody, staffSecurity } from "./responses.ts";

export const importantLinksPath = "/v1/staff/tenants/{tenantId}/important-links";
export const importantLinkPath = "/v1/staff/tenants/{tenantId}/important-links/{linkId}";
export const importantLinkArchivePath =
  "/v1/staff/tenants/{tenantId}/important-links/{linkId}/archive";
export const publicImportantLinksPath = "/v1/public/important-links";

const LinkParams = StaffTenantParams.extend({
  linkId: z.string().describe("Important link UUID; anything else answers 404"),
});

const notFound = () =>
  new ApiError(404, "important_link_not_found", "No such important link for this tenant");

/** The saved link, or the refusal as an API error. */
function saved(result: ImportantLinkResult) {
  switch (result.kind) {
    case "saved":
      return { link: result.link };
    case "not_found":
      throw notFound();
    case "archived":
      throw new ApiError(
        409,
        "important_link_archived",
        "This link is archived and does not change; add a new one",
      );
    case "limit_reached":
      throw new ApiError(
        409,
        "important_links_limit",
        "An operator keeps at most 25 active important links, and 500 in all with archived ones",
      );
    case "unknown_product":
      throw new ApiError(
        409,
        "important_link_unknown_product",
        "A listed product is not one of this operator's products",
      );
  }
}

const responses = {
  400: errorBody("Request did not match the contract"),
  401: errorBody("Not signed in"),
  403: errorBody("Role does not allow this"),
  404: errorBody("No such tenant or link"),
  409: errorBody(
    "The link is archived (important_link_archived), the operator already has 25 active links or 500 in all (important_links_limit), or a product is not the operator's (important_link_unknown_product)",
  ),
  422: errorBody("idempotency_key_reused"),
};

/**
 * Important links (W3-G2.14b-rest): owners add, edit, reorder, and archive an
 * operator's named HTTPS links (catalog.manage); every role reads them
 * (catalog.read). Guests see the ones for their booking's product in the
 * booking they manage, and the site's links for every trip here.
 */
export function registerImportantLinkRoutes(app: OpenAPIHono<AppEnv>, deps: AppDeps) {
  const listRoute = createRoute({
    method: "get",
    path: importantLinksPath,
    tags: ["staff", "catalog"],
    summary: "The operator's important links",
    security: staffSecurity,
    request: { params: StaffTenantParams },
    responses: {
      200: {
        content: { "application/json": { schema: ImportantLinksResponse } },
        description: "Active links by position, then archived ones",
      },
      401: responses[401],
      403: responses[403],
      404: errorBody("No such tenant for this account"),
    },
  });

  app.openapi(listRoute, async (c) => {
    const { tenantId } = c.req.valid("param");
    const { body } = await withStaffTenant(
      c,
      deps,
      { tenantId, permission: "catalog.read" },
      async (trx) => ({ links: await listImportantLinks(trx, tenantId) }),
    );
    return c.json(body, 200);
  });

  const createLinkRoute = createRoute({
    method: "post",
    path: importantLinksPath,
    tags: ["staff", "catalog"],
    summary: "Add an important link",
    description:
      "Owners only. An https address with a host name (no IP address, user name, password, or name kept for local networks such as .local or .internal) and a port from 1 to 65535 if any, a name of up to 60 characters, an optional note of up to 200, every trip or up to 20 of the operator's products, and a position. At most 25 active links and 500 in all. Idempotent by key.",
    security: staffSecurity,
    request: {
      params: StaffTenantParams,
      headers: z.object({ "idempotency-key": IdempotencyKey }),
      body: { required: true, content: { "application/json": { schema: ImportantLinkInput } } },
    },
    responses: {
      201: {
        content: { "application/json": { schema: ImportantLinkResponse } },
        description: "The new link",
      },
      ...responses,
    },
  });

  app.openapi(createLinkRoute, async (c) => {
    const { tenantId } = c.req.valid("param");
    const key = c.req.valid("header")["idempotency-key"];
    const input = c.req.valid("json");
    const { body, replayed } = await withStaffTenant(
      c,
      deps,
      {
        tenantId,
        permission: "catalog.manage",
        idempotency: {
          scope: "staff.important_links.create",
          key,
          route: importantLinksPath,
          body: input,
          successStatus: 201,
        },
      },
      async (trx, ctx) => saved(await createImportantLink(trx, ctx, input)),
    );
    if (replayed) c.header("Idempotent-Replayed", "true");
    return c.json(body as ImportantLinkResponse, 201);
  });

  const updateRoute = createRoute({
    method: "put",
    path: importantLinkPath,
    tags: ["staff", "catalog"],
    summary: "Change an important link",
    description:
      "Owners only. Replaces the name, address, note, products, and position, under the same rules as adding one. An archived link does not change. Idempotent by key.",
    security: staffSecurity,
    request: {
      params: LinkParams,
      headers: z.object({ "idempotency-key": IdempotencyKey }),
      body: { required: true, content: { "application/json": { schema: ImportantLinkInput } } },
    },
    responses: {
      200: {
        content: { "application/json": { schema: ImportantLinkResponse } },
        description: "The link as saved",
      },
      ...responses,
    },
  });

  app.openapi(updateRoute, async (c) => {
    const { tenantId, linkId } = c.req.valid("param");
    if (!isUuid(linkId)) throw notFound();
    const key = c.req.valid("header")["idempotency-key"];
    const input = c.req.valid("json");
    const { body, replayed } = await withStaffTenant(
      c,
      deps,
      {
        tenantId,
        permission: "catalog.manage",
        idempotency: {
          scope: "staff.important_links.update",
          key,
          route: importantLinkPath,
          params: { linkId },
          body: input,
          successStatus: 200,
        },
      },
      async (trx, ctx) => saved(await updateImportantLink(trx, ctx, linkId, input)),
    );
    if (replayed) c.header("Idempotent-Replayed", "true");
    return c.json(body as ImportantLinkResponse, 200);
  });

  const archiveRoute = createRoute({
    method: "post",
    path: importantLinkArchivePath,
    tags: ["staff", "catalog"],
    summary: "Archive an important link",
    description:
      "Owners only. Guests stop seeing it at once, and it never changes again. Idempotent by key.",
    security: staffSecurity,
    request: {
      params: LinkParams,
      headers: z.object({ "idempotency-key": IdempotencyKey }),
    },
    responses: {
      200: {
        content: { "application/json": { schema: ImportantLinkResponse } },
        description: "The archived link",
      },
      401: responses[401],
      403: responses[403],
      404: responses[404],
      409: errorBody("The link is already archived (important_link_archived)"),
      422: responses[422],
    },
  });

  app.openapi(archiveRoute, async (c) => {
    const { tenantId, linkId } = c.req.valid("param");
    if (!isUuid(linkId)) throw notFound();
    const key = c.req.valid("header")["idempotency-key"];
    const { body, replayed } = await withStaffTenant(
      c,
      deps,
      {
        tenantId,
        permission: "catalog.manage",
        idempotency: {
          scope: "staff.important_links.archive",
          key,
          route: importantLinkArchivePath,
          params: { linkId },
          body: {},
          successStatus: 200,
        },
      },
      async (trx, ctx) => saved(await archiveImportantLink(trx, ctx, linkId)),
    );
    if (replayed) c.header("Idempotent-Replayed", "true");
    return c.json(body as ImportantLinkResponse, 200);
  });

  const publicRoute = createRoute({
    method: "get",
    path: publicImportantLinksPath,
    tags: ["public"],
    summary: "The calling site's important links for every trip",
    description:
      "Resolves the browser Origin to an active, verified tenant hostname, as /v1/public/tenant does, and lists the operator's active important links that apply to every trip, by position. A booking's product links come with the booking the guest manages. Grants no permission.",
    responses: {
      200: {
        content: { "application/json": { schema: PublicImportantLinksResponse } },
        description: "The links, by position",
      },
      404: errorBody("No active tenant hostname matches the origin"),
    },
  });

  app.openapi(publicRoute, async (c) => {
    const tenantId = await resolvePublicTenant(c);
    const links = await inTenantTransaction(
      getDb(c),
      {
        tenantId,
        actorType: "guest",
        actorId: null,
        requestId: c.get("requestId"),
        sourceIp: c.req.header("cf-connecting-ip") ?? null,
      },
      (trx) => guestImportantLinks(trx, tenantId, null),
    );
    // Not cached, so an archived link disappears at once, as the archive route says.
    c.header("Cache-Control", "no-store");
    c.header("Vary", "Origin");
    return c.json({ links }, 200);
  });
}
