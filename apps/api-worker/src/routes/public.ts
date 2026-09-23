import { createRoute, type OpenAPIHono } from "@hono/zod-openapi";
import { PublicTenantResponse } from "@tidegrid/contracts";
import { normalizeHostname } from "@tidegrid/domain-identity";
import { sql } from "kysely";
import type { AppEnv } from "../context.ts";
import { getDb } from "../db.ts";
import { ApiError } from "../errors.ts";
import { errorBody } from "./responses.ts";

const notPublished = () =>
  new ApiError(404, "tenant_not_found", "No operator is published at this address");

export function registerPublicRoutes(app: OpenAPIHono<AppEnv>) {
  const tenantByOrigin = createRoute({
    method: "get",
    path: "/v1/public/tenant",
    tags: ["public"],
    summary: "Public brand context for the calling site",
    description:
      "Resolves the browser Origin to an active, verified tenant hostname. Selects public context only; grants no permission.",
    responses: {
      200: {
        content: { "application/json": { schema: PublicTenantResponse } },
        description: "The operator published at this origin",
      },
      404: errorBody("No active tenant hostname matches the origin"),
    },
  });

  app.openapi(tenantByOrigin, async (c) => {
    const host = normalizeHostname(c.req.header("origin"));
    if (!host) throw notPublished();
    const { rows } = await sql<{ tenant_slug: string; tenant_name: string }>`
      select tenant_slug, tenant_name from app.resolve_hostname(${host})
    `.execute(getDb(c));
    const row = rows[0];
    if (!row) throw notPublished();
    c.header("Cache-Control", "private, max-age=60");
    c.header("Vary", "Origin");
    return c.json({ tenant: { slug: row.tenant_slug, name: row.tenant_name } }, 200);
  });
}
