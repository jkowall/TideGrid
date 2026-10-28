import { createRoute, type OpenAPIHono } from "@hono/zod-openapi";
import { PublicExperienceResponse } from "@tidegrid/contracts";
import type { AppEnv } from "../context.ts";
import { getDb } from "../db.ts";
import { ApiError } from "../errors.ts";
import { loadPublicExperience, notPublished, publicOrigin } from "../public-tenant.ts";
import { errorBody } from "./responses.ts";

const brandUnavailable = () =>
  new ApiError(503, "brand_unavailable", "This booking site is temporarily unavailable");

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
    // The strict origin parser, as on every other public route (G2.14b): a
    // non-canonical origin never reaches the database and gets the same 404.
    const origin = publicOrigin(c);
    if (!origin) throw notPublished();
    const found = await loadPublicExperience(getDb(c), origin.host);
    if (found.kind === "miss") throw notPublished();
    if (found.kind === "withheld") {
      // Allowlisted attributes only; stored configuration never reaches a log.
      c.get("log").error(`public_experience_withheld version ${found.version ?? "none"}`, {
        "event.name": "public_experience_withheld",
        "tidegrid.tenant_id": found.tenantId,
        "error.type": found.reason,
      });
      throw brandUnavailable();
    }
    c.header("Cache-Control", "private, max-age=60");
    c.header("Vary", "Origin");
    return c.json(found.experience, 200);
  });
}
