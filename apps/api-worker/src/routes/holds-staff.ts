import { createRoute, type OpenAPIHono } from "@hono/zod-openapi";
import { TripHoldsResponse, TripParams } from "@tidegrid/contracts";
import { isUuid } from "@tidegrid/database";
import { getTripCapacity, listTripHolds } from "@tidegrid/domain-inventory";
import type { AppDeps, AppEnv } from "../context.ts";
import { ApiError } from "../errors.ts";
import { withStaffTenant } from "../staff-tenant.ts";
import { errorBody, staffSecurity } from "./responses.ts";

const holdsPath = "/v1/staff/tenants/{tenantId}/trips/{tripId}/holds";

/** A malformed id answers like a missing one, so ids cannot be probed. */
const tripNotFound = () => new ApiError(404, "trip_not_found", "No such trip for this tenant");

/**
 * Capacity and holds (G2.6): a read-only staff view of one trip's capacity and
 * the holds behind it. Acquiring, confirming, and releasing holds belong to
 * checkout (G2.7), so no route here changes a hold.
 */
export function registerHoldStaffRoutes(app: OpenAPIHono<AppEnv>, deps: AppDeps) {
  const holdsRoute = createRoute({
    method: "get",
    path: holdsPath,
    tags: ["staff", "inventory"],
    summary: "A trip's capacity and every hold on it",
    description:
      "Every role. Holds in any state, oldest first, each marked with whether it takes capacity now. Capacity is computed by the database clock and is advisory; only acquiring a hold decides.",
    security: staffSecurity,
    request: { params: TripParams },
    responses: {
      200: {
        content: { "application/json": { schema: TripHoldsResponse } },
        description: "Capacity and holds",
      },
      401: errorBody("Not signed in"),
      403: errorBody("Role does not allow this"),
      404: errorBody("No such tenant or trip"),
    },
  });

  app.openapi(holdsRoute, async (c) => {
    const { tenantId, tripId } = c.req.valid("param");
    const { body } = await withStaffTenant(
      c,
      deps,
      { tenantId, permission: "catalog.read" },
      async (trx) => {
        if (!isUuid(tripId)) throw tripNotFound();
        const capacity = await getTripCapacity(trx, tenantId, tripId);
        if (!capacity) throw tripNotFound();
        return { capacity, holds: await listTripHolds(trx, tenantId, tripId) };
      },
    );
    return c.json(body, 200);
  });
}
