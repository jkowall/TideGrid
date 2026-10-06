import { createRoute, type OpenAPIHono } from "@hono/zod-openapi";
import {
  FinalizationExceptionQuery,
  FinalizationExceptionsResponse,
  StaffTenantParams,
  TripBookingsResponse,
  TripParams,
} from "@tidegrid/contracts";
import { listFinalizationExceptions, listTripBookings } from "@tidegrid/domain-booking";
import type { AppDeps, AppEnv } from "../context.ts";
import { ApiError } from "../errors.ts";
import { withStaffTenant } from "../staff-tenant.ts";
import { errorBody, staffSecurity } from "./responses.ts";

const bookingsPath = "/v1/staff/tenants/{tenantId}/trips/{tripId}/bookings";
const exceptionsPath = "/v1/staff/tenants/{tenantId}/finalization-exceptions";

/**
 * Staff reads for checkout (G2.7): a trip's bookings, and the payments that
 * could not become bookings. Read-only; the console goal builds on them.
 */
export function registerBookingStaffRoutes(app: OpenAPIHono<AppEnv>, deps: AppDeps) {
  const bookingsRoute = createRoute({
    method: "get",
    path: bookingsPath,
    tags: ["staff", "bookings"],
    summary: "A trip's bookings",
    description:
      "Owners and booking staff. Every booking on the trip, oldest first, with the booker's name and email, the order, and the payment.",
    security: staffSecurity,
    request: { params: TripParams },
    responses: {
      200: {
        content: { "application/json": { schema: TripBookingsResponse } },
        description: "The trip's bookings",
      },
      401: errorBody("Not signed in"),
      403: errorBody("Role does not allow this"),
      404: errorBody("No such tenant or trip"),
    },
  });

  app.openapi(bookingsRoute, async (c) => {
    const { tenantId, tripId } = c.req.valid("param");
    const { body } = await withStaffTenant(
      c,
      deps,
      { tenantId, permission: "bookings.read" },
      async (trx) => {
        const bookings = await listTripBookings(trx, tenantId, tripId);
        if (!bookings) throw new ApiError(404, "trip_not_found", "No such trip for this tenant");
        return { bookings: bookings.map((b) => ({ ...b })) };
      },
    );
    return c.json(body, 200);
  });

  const exceptionsRoute = createRoute({
    method: "get",
    path: exceptionsPath,
    tags: ["staff", "bookings"],
    summary: "Payments that could not become bookings",
    description:
      "Every role. Verified payments whose capacity was gone, whose trip changed, or whose checkout had already failed or been canceled, newest first, with the state of the automatic full refund. A payment_mismatch is not refunded automatically.",
    security: staffSecurity,
    request: { params: StaffTenantParams, query: FinalizationExceptionQuery },
    responses: {
      200: {
        content: { "application/json": { schema: FinalizationExceptionsResponse } },
        description: "The exceptions",
      },
      401: errorBody("Not signed in"),
      403: errorBody("Role does not allow this"),
      404: errorBody("No such tenant"),
    },
  });

  app.openapi(exceptionsRoute, async (c) => {
    const { tenantId } = c.req.valid("param");
    const { limit } = c.req.valid("query");
    const { body } = await withStaffTenant(
      c,
      deps,
      { tenantId, permission: "payments.read" },
      async (trx) => ({
        exceptions: (await listFinalizationExceptions(trx, tenantId, { limit })).map((e) => ({
          ...e,
        })),
      }),
    );
    return c.json(body, 200);
  });
}
