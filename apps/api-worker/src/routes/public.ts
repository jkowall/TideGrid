import { createRoute, type OpenAPIHono } from "@hono/zod-openapi";
import { BrandConfig, brandSchemaVersion, PublicExperienceResponse } from "@tidegrid/contracts";
import { normalizeHostname } from "@tidegrid/domain-identity";
import type { Context } from "hono";
import { sql } from "kysely";
import type { AppEnv } from "../context.ts";
import { getDb } from "../db.ts";
import { ApiError } from "../errors.ts";
import { errorBody } from "./responses.ts";

const notPublished = () =>
  new ApiError(404, "tenant_not_found", "No operator is published at this address");

const brandUnavailable = () =>
  new ApiError(503, "brand_unavailable", "This booking site is temporarily unavailable");

interface ResolvedRow {
  tenant_id: string;
  tenant_slug: string;
  tenant_name: string;
  brand_version: number | null;
  brand_schema_version: number | null;
  brand_config: unknown;
}

/** Log with allowlisted attributes only; stored configuration never reaches a log. */
function withhold(c: Context<AppEnv>, row: ResolvedRow, reason: string): never {
  c.get("log").error(`public_experience_withheld version ${row.brand_version ?? "none"}`, {
    "event.name": "public_experience_withheld",
    "tidegrid.tenant_id": row.tenant_id,
    "error.type": reason,
  });
  throw brandUnavailable();
}

export function registerPublicRoutes(app: OpenAPIHono<AppEnv>) {
  const tenantByOrigin = createRoute({
    method: "get",
    path: "/v1/public/tenant",
    tags: ["public"],
    summary: "Public experience bootstrap for the calling site",
    description:
      "Resolves the browser Origin to an active, verified tenant hostname and returns the tenant's public identity and its active brand. Selects public context only; grants no permission. Unknown, disabled, and unverified hostnames and suspended tenants all answer the same 404.",
    responses: {
      200: {
        content: { "application/json": { schema: PublicExperienceResponse } },
        description:
          "The operator published at this origin, with its active brand once it has published one",
      },
      404: errorBody("No active tenant hostname matches the origin"),
      503: errorBody("The operator's stored identity or brand failed validation and is withheld"),
    },
  });

  app.openapi(tenantByOrigin, async (c) => {
    const host = normalizeHostname(c.req.header("origin"));
    if (!host) throw notPublished();
    const { rows } = await sql<ResolvedRow>`
      select tenant_id, tenant_slug, tenant_name, brand_version, brand_schema_version, brand_config
        from app.resolve_public_brand(${host})
    `.execute(getDb(c));
    const row = rows[0];
    if (!row) throw notPublished();

    // Validate on the way out as well as on the way in. The stored config must
    // pass the stored shape exactly (a config that names its own version, or
    // carries any other extra field, fails), and the whole response must pass
    // the public contract, tenant identity included. Anything else is withheld.
    let body: unknown = { tenant: { slug: row.tenant_slug, name: row.tenant_name } };
    if (row.brand_version !== null) {
      if (row.brand_schema_version !== brandSchemaVersion) {
        withhold(c, row, "BrandSchemaVersionUnknown");
      }
      const stored = BrandConfig.safeParse(row.brand_config);
      if (!stored.success) withhold(c, row, "BrandConfigInvalid");
      body = {
        tenant: { slug: row.tenant_slug, name: row.tenant_name },
        brand: { ...stored.data, version: row.brand_version },
      };
    }
    const response = PublicExperienceResponse.safeParse(body);
    if (!response.success) withhold(c, row, "PublicExperienceInvalid");

    c.header("Cache-Control", "private, max-age=60");
    c.header("Vary", "Origin");
    return c.json(response.data, 200);
  });
}
