import { createRoute, type OpenAPIHono } from "@hono/zod-openapi";
import { ParticipantListResponse, StaffParticipantParams } from "@tidegrid/contracts";
import { listParticipants } from "@tidegrid/domain-booking";
import type { AppDeps, AppEnv } from "../context.ts";
import { ApiError } from "../errors.ts";
import { withStaffTenant } from "../staff-tenant.ts";
import { errorBody, staffSecurity } from "./responses.ts";

const participantsPath = "/v1/staff/tenants/{tenantId}/bookings/{bookingId}/participants";

/**
 * Staff read of a booking's participants (lane 1, G2.11c). Participants are
 * personal data, so only roles that hold `bookings.read` (owners and booking
 * staff) read them, as with the booker's name and the roster; finance is
 * refused. Read-only: the guest names the party through the management link.
 */
export function registerParticipantStaffRoutes(app: OpenAPIHono<AppEnv>, deps: AppDeps) {
  app.use("/v1/staff/tenants/:tenantId/bookings/:bookingId/participants", async (c, next) => {
    await next();
    c.header("Cache-Control", "no-store");
  });

  const route = createRoute({
    method: "get",
    path: participantsPath,
    tags: ["staff", "bookings"],
    summary: "A booking's participants",
    description:
      "Owners and booking staff. The party as the guest has named it so far, by place, with the party size; places without a participant are not listed. A minor's guardian is included. Finance does not hold bookings.read and is refused. Another tenant's booking, an unknown id, and a malformed one answer the same 404.",
    security: staffSecurity,
    request: { params: StaffParticipantParams },
    responses: {
      200: {
        content: { "application/json": { schema: ParticipantListResponse } },
        description: "The booking's participants",
      },
      401: errorBody("Not signed in"),
      403: errorBody("Role does not allow this"),
      404: errorBody("No such tenant or booking (booking_not_found)"),
    },
  });

  app.openapi(route, async (c) => {
    const { tenantId, bookingId } = c.req.valid("param");
    const { body } = await withStaffTenant(
      c,
      deps,
      { tenantId, permission: "bookings.read", snapshot: true },
      async (trx) => {
        const party = await listParticipants(trx, tenantId, bookingId);
        if (!party) throw new ApiError(404, "booking_not_found", "No such booking for this tenant");
        return { party: { ...party } };
      },
    );
    return c.json(body as ParticipantListResponse, 200);
  });
}
