import { createRoute, type OpenAPIHono } from "@hono/zod-openapi";
import { TripAvailabilityQuery, TripAvailabilityResponse } from "@tidegrid/contracts";
import { inTenantTransaction } from "@tidegrid/database";
import { checkRange, findAvailableTrips } from "@tidegrid/domain-catalog";
import type { AppDeps, AppEnv } from "../context.ts";
import { getDb } from "../db.ts";
import { ApiError } from "../errors.ts";
import { resolvePublicTenant } from "../public-tenant.ts";
import { errorBody } from "./responses.ts";

export function registerCatalogPublicRoutes(app: OpenAPIHono<AppEnv>, deps: AppDeps) {
  const availabilityRoute = createRoute({
    method: "get",
    path: "/v1/public/trips",
    tags: ["public"],
    summary: "Bookable trips for the calling site",
    description:
      "Resolves the browser Origin to an active, verified tenant hostname, as /v1/public/tenant does, and lists that tenant's bookable trips. Grants no permission and never reveals another tenant's trips.",
    request: { query: TripAvailabilityQuery },
    responses: {
      200: {
        content: { "application/json": { schema: TripAvailabilityResponse } },
        description: "Bookable trips, sorted by start",
      },
      400: errorBody("Invalid date range or party size"),
      404: errorBody("No active tenant hostname matches the origin"),
    },
  });

  // Resolve before the query is validated (G2.14b): an unknown origin gets
  // the shared 404 even with an invalid range, as on every other public route,
  // so the answer never tells an unpublished site which inputs are valid.
  app.use(availabilityRoute.path, async (c, next) => {
    if (c.req.method === "GET") await resolvePublicTenant(c);
    await next();
  });

  app.openapi(availabilityRoute, async (c) => {
    const tenantId = await resolvePublicTenant(c);
    const query = c.req.valid("query");
    const problem = checkRange(query.from, query.to);
    if (problem === "range_too_large") {
      throw new ApiError(400, problem, "Ask for at most 93 days at a time");
    }
    if (problem) {
      throw new ApiError(
        400,
        problem,
        "Use dates from 2000-01-02 to 2099-12-30, with from on or before to",
      );
    }
    const db = getDb(c);
    const trips = await inTenantTransaction(
      db,
      {
        tenantId,
        actorType: "guest",
        actorId: null,
        requestId: c.get("requestId"),
        sourceIp: c.req.header("cf-connecting-ip") ?? null,
      },
      (trx) =>
        findAvailableTrips(trx, tenantId, {
          from: query.from,
          to: query.to,
          party: query.party,
          productId: query.product,
          now: deps.now?.() ?? new Date(),
        }),
    );
    // Availability feeds checkout, so it is never served from a cache.
    c.header("Cache-Control", "no-store");
    c.header("Vary", "Origin");
    return c.json({ trips }, 200);
  });
}
