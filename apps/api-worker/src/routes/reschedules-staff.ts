import { createRoute, type OpenAPIHono, z } from "@hono/zod-openapi";
import {
  BookingParams,
  IdempotencyKey,
  ReschedulePreviewResponse,
  StaffRescheduleRequest,
  StaffRescheduleResponse,
} from "@tidegrid/contracts";
import { isUuid } from "@tidegrid/database";
import {
  previewReschedule,
  type ReschedulePreview,
  type RescheduleResult,
  rescheduleBooking,
} from "@tidegrid/domain-booking";
import { can } from "@tidegrid/domain-identity";
import { bookingHooksFor } from "../booking-hooks.ts";
import type { AppDeps, AppEnv } from "../context.ts";
import { deliverAfterCommit } from "../email.ts";
import { ApiError } from "../errors.ts";
import { withStaffTenant } from "../staff-tenant.ts";
import { errorBody, staffSecurity } from "./responses.ts";

const reschedulePath = "/v1/staff/tenants/{tenantId}/bookings/{bookingId}/reschedule";

const notFound = () => new ApiError(404, "booking_not_found", "No such booking for this tenant");

/** The preview in the contract's shape: no booking id, the guest's view has none either. */
export function previewJson(p: ReschedulePreview) {
  const { bookingId: _bookingId, ...rest } = p;
  return JSON.parse(JSON.stringify(rest));
}

/**
 * A refused move as the API answers it, for guest and staff alike. `moved`
 * and `already_moved` are the caller's.
 */
export function rescheduleRefusal(
  result: Exclude<RescheduleResult, { kind: "moved" | "already_moved" }>,
  notFoundError: () => ApiError,
): ApiError {
  switch (result.kind) {
    case "not_found":
      return notFoundError();
    case "not_confirmed":
      return new ApiError(409, "booking_canceled", "This booking was canceled; it can't move");
    case "trip_departed":
      return new ApiError(409, "trip_departed", "This trip has departed; the booking can't move");
    case "past_cutoff":
      return new ApiError(
        409,
        "reschedule_cutoff_passed",
        "This booking is past its change cutoff; only the operator can move it now",
      );
    case "booking_changed":
      return new ApiError(
        409,
        "booking_changed",
        "The booking is no longer on the trip you saw; read the options again",
      );
    case "trip_not_found":
      return new ApiError(
        409,
        "trip_not_eligible",
        "That trip is not another departure of this booking's trip that has not left",
      );
    case "trip_unavailable":
      return new ApiError(
        409,
        "trip_unavailable",
        `That trip can't take this booking now (${result.issue}); read the options again`,
      );
  }
}

/**
 * Staff move a whole booking to another trip of its product
 * (W3-G2.11-rest). Another tenant's booking, an unknown id, and a malformed
 * one answer the same 404.
 */
export function registerReschedulesStaffRoutes(app: OpenAPIHono<AppEnv>, deps: AppDeps) {
  app.use("/v1/staff/tenants/:tenantId/bookings/:bookingId/reschedule", async (c, next) => {
    c.header("Cache-Control", "no-store");
    await next();
    c.header("Cache-Control", "no-store");
  });

  const previewRoute = createRoute({
    method: "get",
    path: reschedulePath,
    tags: ["staff", "bookings"],
    summary: "What moving this booking now would do",
    description: [
      "Owners and booking staff (bookings.reschedule). Whether the booking may move now without an override, the policy's reschedule text and cutoff, and the other trips of its product it could move to, soonest first, each with whether it would take the booking now. The price does not change. Read-only and advisory.",
      "Order: authentication (401), membership (404), permission (403), then the booking (404).",
    ].join("\n\n"),
    security: staffSecurity,
    request: { params: BookingParams },
    responses: {
      200: {
        content: { "application/json": { schema: ReschedulePreviewResponse } },
        description: "The preview",
      },
      401: errorBody("Not signed in"),
      403: errorBody("Role does not allow this"),
      404: errorBody("No such tenant or booking (booking_not_found)"),
    },
  });

  app.openapi(previewRoute, async (c) => {
    const { tenantId, bookingId } = c.req.valid("param");
    const { body } = await withStaffTenant(
      c,
      deps,
      { tenantId, permission: "bookings.reschedule", snapshot: true },
      async (trx) => {
        const preview = await previewReschedule(trx, tenantId, bookingId);
        if (!preview) throw notFound();
        return { preview: previewJson(preview) };
      },
    );
    return c.json(body as ReschedulePreviewResponse, 200);
  });

  const moveRoute = createRoute({
    method: "post",
    path: reschedulePath,
    tags: ["staff", "bookings"],
    summary: "Move a booking to another trip",
    description: [
      "Owners and booking staff (bookings.reschedule). One transaction: the seats on the new trip are taken first, then the booking moves and its old seats go back on sale; if the new trip has no room, nothing changes. The price does not change. The guest is emailed the new time, and the trip reminder follows the booking.",
      "Before the policy's change cutoff anyone with bookings.reschedule may move it. At or after the cutoff it needs overrideReason, and overrideReason needs bookings.override (owners). No booking moves after its trip has left.",
      "Idempotent by key. A repeat of the same move with another key answers 200 with the first move.",
    ].join("\n\n"),
    security: staffSecurity,
    request: {
      params: BookingParams,
      headers: z.object({ "idempotency-key": IdempotencyKey }),
      body: {
        required: true,
        content: { "application/json": { schema: StaffRescheduleRequest } },
      },
    },
    responses: {
      200: {
        content: { "application/json": { schema: StaffRescheduleResponse } },
        description: "The move",
      },
      400: errorBody("Request did not match the contract"),
      401: errorBody("Not signed in"),
      403: errorBody("Role does not allow this (an override needs bookings.override)"),
      404: errorBody("No such tenant or booking (booking_not_found)"),
      409: errorBody(
        "The booking was canceled (booking_canceled), its trip has departed (trip_departed), it is past its cutoff without an override (reschedule_cutoff_passed), it is no longer on fromTripId (booking_changed), the trip is not another departure of its product (trip_not_eligible), or the trip can't take it now (trip_unavailable)",
      ),
      422: errorBody("idempotency_key_reused"),
    },
  });

  app.openapi(moveRoute, async (c) => {
    const { tenantId, bookingId } = c.req.valid("param");
    const key = c.req.valid("header")["idempotency-key"];
    const input = c.req.valid("json");
    const overrideReason = input.overrideReason ?? null;
    let moved = false;
    const answer = await withStaffTenant(
      c,
      deps,
      {
        tenantId,
        permission: "bookings.reschedule",
        idempotency: {
          scope: "bookings.staff_reschedule",
          key,
          route: reschedulePath,
          params: { bookingId },
          body: input,
          successStatus: 200,
        },
      },
      async (trx, ctx) => {
        if (overrideReason !== null && !can(ctx.access.role, "bookings.override")) {
          throw new ApiError(403, "forbidden", "Only an owner moves a booking against its policy");
        }
        if (!isUuid(bookingId)) throw notFound();
        const result = await rescheduleBooking(trx, ctx, {
          bookingId,
          fromTripId: input.fromTripId,
          toTripId: input.toTripId,
          overrideReason,
          hooks: bookingHooksFor(c.env, deps),
        });
        if (result.kind === "moved") moved = true;
        if (result.kind === "moved" || result.kind === "already_moved") {
          return { move: JSON.parse(JSON.stringify(result.move)) };
        }
        throw rescheduleRefusal(result, notFound);
      },
    );
    if (answer.replayed) c.header("Idempotent-Replayed", "true");
    if (moved) deliverAfterCommit(c, deps, answer.ctx.tenantId);
    return c.json(answer.body as StaffRescheduleResponse, 200);
  });
}
