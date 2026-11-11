import { createRoute, type OpenAPIHono, z } from "@hono/zod-openapi";
import {
  BookingMessagesResponse,
  IdempotencyKey,
  ParticipantInvitationResponse,
  ParticipantListResponse,
  ParticipantPosition,
  StaffParticipantParams,
  StaffRemoveParticipantRequest,
  StaffRemoveParticipantResponse,
} from "@tidegrid/contracts";
import { isUuid } from "@tidegrid/database";
import {
  inviteParticipant,
  listParticipants,
  type RemoveParticipantResult,
  removeParticipant,
  resendAvailability,
} from "@tidegrid/domain-booking";
import { can } from "@tidegrid/domain-identity";
import { listBookingMessages } from "@tidegrid/domain-messaging";
import { bookingHooksFor } from "../booking-hooks.ts";
import type { AppDeps, AppEnv } from "../context.ts";
import { deliverAfterCommit } from "../email.ts";
import { ApiError } from "../errors.ts";
import { withStaffTenant } from "../staff-tenant.ts";
import { emailDelivery } from "./booking-email-staff.ts";
import { invitationRefusal } from "./participant-public.ts";
import { errorBody, staffSecurity } from "./responses.ts";

const participantsPath = "/v1/staff/tenants/{tenantId}/bookings/{bookingId}/participants";
const messagesPath = "/v1/staff/tenants/{tenantId}/bookings/{bookingId}/messages";
const removalPath =
  "/v1/staff/tenants/{tenantId}/bookings/{bookingId}/participants/{position}/removal";
const invitationPath =
  "/v1/staff/tenants/{tenantId}/bookings/{bookingId}/participants/{position}/invitation";

/**
 * A refused party change as the API answers it, for guest and staff alike.
 * `removed` and `already_removed` are the caller's.
 */
export function partyChangeRefusal(
  result: Exclude<RemoveParticipantResult, { kind: "removed" | "already_removed" }>,
  notFoundError: () => ApiError,
): ApiError {
  switch (result.kind) {
    case "not_found":
      return notFoundError();
    case "not_confirmed":
      return new ApiError(409, "booking_canceled", "This booking was canceled");
    case "not_shared_seat":
      return new ApiError(
        409,
        "party_change_not_allowed",
        "A private charter's party does not take seats; no place can be given up",
      );
    case "trip_departed":
      return new ApiError(409, "trip_departed", "This trip has departed; the party can't change");
    case "past_cutoff":
      return new ApiError(
        409,
        "party_change_cutoff_passed",
        "This booking is past its change cutoff; only the operator can change the party now",
      );
    case "booking_changed":
      return new ApiError(
        409,
        "booking_changed",
        "The party is no longer the size you saw; read the booking again",
      );
    case "place_not_found":
      return new ApiError(409, "place_not_found", "The party has no such place now");
    case "last_place":
      return new ApiError(
        409,
        "last_place",
        "This is the only place left; cancel the booking instead",
      );
    case "trip_unavailable":
      return new ApiError(
        409,
        "trip_unavailable",
        `The trip can't keep the smaller party now (${result.issue})`,
      );
  }
}

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

  app.use(
    "/v1/staff/tenants/:tenantId/bookings/:bookingId/participants/:position/removal",
    async (c, next) => {
      c.header("Cache-Control", "no-store");
      await next();
      c.header("Cache-Control", "no-store");
    },
  );

  const removalRoute = createRoute({
    method: "post",
    path: removalPath,
    tags: ["staff", "bookings"],
    summary: "Give up one place in a shared-seat party",
    description: [
      "Owners and booking staff (bookings.reschedule). The party shrinks by one: the participant named at the place, if any, is removed and their waivers withdrawn, and the seat goes back on sale, in one transaction on the same trip. The price does not change. Places keep their numbers; the place given up is never named again.",
      "Before the policy's change cutoff anyone with bookings.reschedule may do it. At or after the cutoff it needs overrideReason, and overrideReason needs bookings.override (owners). Never after the trip has left, never the last place (cancel instead), and never on a private charter.",
      "partySize is the size the caller saw; if it is another now, nothing changes. Idempotent by key; a repeat of the same change with another key answers 200 with the first change.",
    ].join("\n\n"),
    security: staffSecurity,
    request: {
      params: StaffParticipantParams.extend({ position: ParticipantPosition }),
      headers: z.object({ "idempotency-key": IdempotencyKey }),
      body: {
        required: true,
        content: { "application/json": { schema: StaffRemoveParticipantRequest } },
      },
    },
    responses: {
      200: {
        content: { "application/json": { schema: StaffRemoveParticipantResponse } },
        description: "The change",
      },
      400: errorBody("Request did not match the contract"),
      401: errorBody("Not signed in"),
      403: errorBody("Role does not allow this (an override needs bookings.override)"),
      404: errorBody("No such tenant or booking (booking_not_found)"),
      409: errorBody(
        "The booking was canceled (booking_canceled), is a private charter (party_change_not_allowed), its trip has departed (trip_departed), it is past its cutoff without an override (party_change_cutoff_passed), the party is not partySize now (booking_changed), the party has no such place (place_not_found), it is the last place (last_place), or the trip can't keep the smaller party (trip_unavailable)",
      ),
      422: errorBody("idempotency_key_reused"),
    },
  });

  app.openapi(removalRoute, async (c) => {
    const { tenantId, bookingId, position } = c.req.valid("param");
    const key = c.req.valid("header")["idempotency-key"];
    const input = c.req.valid("json");
    const overrideReason = input.overrideReason ?? null;
    const notFound = () =>
      new ApiError(404, "booking_not_found", "No such booking for this tenant");
    let removed = false;
    const answer = await withStaffTenant(
      c,
      deps,
      {
        tenantId,
        permission: "bookings.reschedule",
        idempotency: {
          scope: "bookings.staff_participant_removal",
          key,
          route: removalPath,
          params: { bookingId, position: String(position) },
          body: input,
          successStatus: 200,
        },
      },
      async (trx, ctx) => {
        if (overrideReason !== null && !can(ctx.access.role, "bookings.override")) {
          throw new ApiError(403, "forbidden", "Only an owner changes a party against its policy");
        }
        if (!isUuid(bookingId)) throw notFound();
        const result = await removeParticipant(
          trx,
          ctx,
          { bookingId, position, partySize: input.partySize, overrideReason },
          bookingHooksFor(c.env, deps),
        );
        if (result.kind === "removed") removed = true;
        if (result.kind === "removed" || result.kind === "already_removed") {
          return { change: JSON.parse(JSON.stringify(result.change)) };
        }
        throw partyChangeRefusal(result, notFound);
      },
    );
    if (answer.replayed) c.header("Idempotent-Replayed", "true");
    if (removed) deliverAfterCommit(c, deps, answer.ctx.tenantId);
    return c.json(answer.body as StaffRemoveParticipantResponse, 200);
  });

  app.use(
    "/v1/staff/tenants/:tenantId/bookings/:bookingId/participants/:position/invitation",
    async (c, next) => {
      c.header("Cache-Control", "no-store");
      await next();
      c.header("Cache-Control", "no-store");
    },
  );

  const invitationRoute = createRoute({
    method: "post",
    path: invitationPath,
    tags: ["staff", "bookings"],
    summary: "Invite one participant to check their own details",
    description: [
      "Owners and booking staff (messages.resend). Emails the participant named at the place a link of their own, to the participant's own address on file, or a minor's guardian's; never to an address in the request. The link opens only that participant's details and the trip, and works once, for seven days or until the trip leaves. A newer invitation's link replaces an older unused one.",
      "At most 3 invitations a person in 24 hours, and 20 a booking, whoever sends them. Idempotent by key.",
    ].join("\n\n"),
    security: staffSecurity,
    request: {
      params: StaffParticipantParams.extend({ position: ParticipantPosition }),
      headers: z.object({ "idempotency-key": IdempotencyKey }),
    },
    responses: {
      202: {
        content: { "application/json": { schema: ParticipantInvitationResponse } },
        description: "Queued; it goes out after this request",
      },
      400: errorBody("Request did not match the contract"),
      401: errorBody("Not signed in"),
      403: errorBody("Role does not allow this"),
      404: errorBody("No such tenant or booking (booking_not_found)"),
      409: errorBody(
        "The booking was canceled (booking_canceled), its trip has departed (trip_departed), the place was given up (place_removed), nobody is named there yet (participant_not_named), or the participant has no email of their own (participant_no_email)",
      ),
      422: errorBody(
        "No such place in this party (position_out_of_range), or idempotency_key_reused",
      ),
      429: errorBody(
        "Too many invitations for this person or booking today (invitation_limit_reached)",
      ),
    },
  });

  app.openapi(invitationRoute, async (c) => {
    const { tenantId, bookingId, position } = c.req.valid("param");
    const key = c.req.valid("header")["idempotency-key"];
    const notFound = () =>
      new ApiError(404, "booking_not_found", "No such booking for this tenant");
    let invited = false;
    const answer = await withStaffTenant(
      c,
      deps,
      {
        tenantId,
        permission: "messages.resend",
        idempotency: {
          scope: "bookings.staff_participant_invitation",
          key,
          route: invitationPath,
          params: { bookingId, position: String(position) },
          body: {},
          successStatus: 202,
        },
      },
      async (trx, ctx) => {
        if (!isUuid(bookingId)) throw notFound();
        const result = await inviteParticipant(trx, ctx, { bookingId, position });
        if (result.kind !== "invited") throw invitationRefusal(result, notFound);
        invited = true;
        return { status: "accepted" as const, recipient: result.recipient };
      },
    );
    if (answer.replayed) c.header("Idempotent-Replayed", "true");
    if (invited) deliverAfterCommit(c, deps, answer.ctx.tenantId);
    return c.json(answer.body as ParticipantInvitationResponse, 202);
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
