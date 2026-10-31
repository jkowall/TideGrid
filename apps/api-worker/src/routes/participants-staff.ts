import { createRoute, type OpenAPIHono } from "@hono/zod-openapi";
import {
  BookingMessagesResponse,
  ParticipantListResponse,
  StaffParticipantParams,
} from "@tidegrid/contracts";
import { listParticipants, resendAvailability } from "@tidegrid/domain-booking";
import { listBookingMessages } from "@tidegrid/domain-messaging";
import type { AppDeps, AppEnv } from "../context.ts";
import { ApiError } from "../errors.ts";
import { withStaffTenant } from "../staff-tenant.ts";
import { emailDelivery } from "./booking-email-staff.ts";
import { errorBody, staffSecurity } from "./responses.ts";

const participantsPath = "/v1/staff/tenants/{tenantId}/bookings/{bookingId}/participants";
const messagesPath = "/v1/staff/tenants/{tenantId}/bookings/{bookingId}/messages";

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

  app.use("/v1/staff/tenants/:tenantId/bookings/:bookingId/messages", async (c, next) => {
    await next();
    c.header("Cache-Control", "no-store");
  });

  const messagesRoute = createRoute({
    method: "get",
    path: messagesPath,
    tags: ["staff", "bookings"],
    summary: "A booking's email and its delivery",
    description:
      "Owners and booking staff. Each message the booking caused, oldest first: its template, its delivery state, attempts, when it was sent, the last failure's code, and whether staff sent it again. No recipient or content. Provider acceptance is not proof the guest read a message. Also whether this environment sends email, and whether staff can send the booking's email again now (G2.16b; advisory, the send decides again). Finance does not hold bookings.read and is refused.",
    security: staffSecurity,
    request: { params: StaffParticipantParams },
    responses: {
      200: {
        content: { "application/json": { schema: BookingMessagesResponse } },
        description: "The booking's messages",
      },
      401: errorBody("Not signed in"),
      403: errorBody("Role does not allow this"),
      404: errorBody("No such tenant or booking (booking_not_found)"),
    },
  });

  app.openapi(messagesRoute, async (c) => {
    const { tenantId, bookingId } = c.req.valid("param");
    const { body } = await withStaffTenant(
      c,
      deps,
      { tenantId, permission: "bookings.read", snapshot: true },
      async (trx) => {
        const party = await listParticipants(trx, tenantId, bookingId);
        if (!party) throw new ApiError(404, "booking_not_found", "No such booking for this tenant");
        const messages = await listBookingMessages(trx, tenantId, bookingId);
        const availability = await resendAvailability(trx, tenantId, bookingId);
        if (!availability) {
          throw new ApiError(404, "booking_not_found", "No such booking for this tenant");
        }
        const off = emailDelivery(c.env) === "off";
        return {
          messages: messages.map((m) => ({ ...m })),
          emailDelivery: off ? "off" : "on",
          resend: {
            kind: availability.kind,
            allowed: !off && availability.allowed,
            // Email off comes first, as the send decides it before any refusal.
            availableAt: off ? null : (availability.availableAt?.toISOString() ?? null),
            remaining: availability.remaining,
            blockedBy: off ? "email_off" : availability.blockedBy,
          },
        };
      },
    );
    return c.json(body as BookingMessagesResponse, 200);
  });
}
