import { createRoute, type OpenAPIHono } from "@hono/zod-openapi";
import { TripHoldsQuery, TripHoldsResponse, TripParams } from "@tidegrid/contracts";
import { isUuid } from "@tidegrid/database";
import { getTripCapacity, listTripHoldsPage } from "@tidegrid/domain-inventory";
import type { AppDeps, AppEnv } from "../context.ts";
import { ApiError } from "../errors.ts";
import { withStaffTenant } from "../staff-tenant.ts";
import { errorBody, staffSecurity } from "./responses.ts";

const holdsPath = "/v1/staff/tenants/{tenantId}/trips/{tripId}/holds";

/** A malformed id answers like a missing one, so ids cannot be probed. */
const tripNotFound = () => new ApiError(404, "trip_not_found", "No such trip for this tenant");
const cursorInvalid = () =>
  new ApiError(400, "cursor_invalid", "The cursor names nothing in this listing");

/**
 * Capacity and holds (G2.6): a read-only staff view of one trip's capacity and
 * the holds behind it, a page at a time since W1-INV-PRICING. Acquiring, confirming, and releasing holds belong to
 * checkout (G2.7), so no route here changes a hold.
 */
export function registerHoldStaffRoutes(app: OpenAPIHono<AppEnv>, deps: AppDeps) {
  const holdsRoute = createRoute({
    method: "get",
    path: holdsPath,
    tags: ["staff", "inventory"],
    summary: "A trip's capacity and its holds, a page at a time",
    description:
      "Every role. Holds in any state, a page at a time, oldest first, each marked with whether it takes capacity now (W1-INV-PRICING: limit and after). Capacity is computed by the database clock and is advisory; only acquiring a hold decides.",
    security: staffSecurity,
    request: { params: TripParams, query: TripHoldsQuery },
    responses: {
      200: {
        content: { "application/json": { schema: TripHoldsResponse } },
        description: "Capacity and holds",
      },
      400: errorBody(
        "A malformed limit or cursor (validation_failed), or a cursor that names no hold on this trip (cursor_invalid)",
      ),
      401: errorBody("Not signed in"),
      403: errorBody("Role does not allow this"),
      404: errorBody("No such tenant or trip"),
    },
  });

  app.openapi(holdsRoute, async (c) => {
    const { tenantId, tripId } = c.req.valid("param");
    const { limit, after } = c.req.valid("query");
    const { body } = await withStaffTenant(
      c,
      deps,
      { tenantId, permission: "catalog.read" },
      async (trx) => {
        if (!isUuid(tripId)) throw tripNotFound();
        const capacity = await getTripCapacity(trx, tenantId, tripId);
        if (!capacity) throw tripNotFound();
        const page = await listTripHoldsPage(trx, tenantId, tripId, {
          limit,
          ...(after === undefined ? {} : { after }),
        });
        if (page.kind === "cursor_invalid") throw cursorInvalid();
        return { capacity, holds: page.holds, nextAfter: page.nextAfter };
      },
    );
    return c.json(body, 200);
  });
}
