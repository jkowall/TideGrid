import { createRoute, type OpenAPIHono } from "@hono/zod-openapi";
import {
  BookingDetailResponse,
  BookingListQuery,
  BookingListResponse,
  BookingParams,
  BookingReferenceParams,
  BookingReferenceResponse,
  FinalizationExceptionQuery,
  FinalizationExceptionsResponse,
  normalizeBookingReference,
  StaffTenantParams,
  TripBookingsResponse,
  TripParams,
  TripRosterResponse,
} from "@tidegrid/contracts";
import {
  findBookingByReference,
  getBookingDetail,
  getTripRoster,
  listDayBookings,
  listExceptionsPage,
  listTripBookings,
} from "@tidegrid/domain-booking";
import { can } from "@tidegrid/domain-identity";
import type { Context } from "hono";
import type { AppDeps, AppEnv } from "../context.ts";
import { ApiError } from "../errors.ts";
import { type StaffTenantContext, withStaffTenant } from "../staff-tenant.ts";
import { errorBody, staffSecurity } from "./responses.ts";

const tripBookingsPath = "/v1/staff/tenants/{tenantId}/trips/{tripId}/bookings";
const exceptionsPath = "/v1/staff/tenants/{tenantId}/finalization-exceptions";
const dayBookingsPath = "/v1/staff/tenants/{tenantId}/bookings";
const bookingPath = "/v1/staff/tenants/{tenantId}/bookings/{bookingId}";
const referencePath = "/v1/staff/tenants/{tenantId}/booking-references/{reference}";
const rosterPath = "/v1/staff/tenants/{tenantId}/trips/{tripId}/roster";

const bookingNotFound = () =>
  new ApiError(404, "booking_not_found", "No such booking for this tenant");
const tripNotFound = () => new ApiError(404, "trip_not_found", "No such trip for this tenant");
const cursorInvalid = () =>
  new ApiError(400, "cursor_invalid", "The cursor names nothing in this listing");

/**
 * Whether this request's role may see the booker's name and email. The
 * permission that admits a route is checked first, by withStaffTenant; this
 * decides only which fields leave. Reads leave them out of the query itself.
 */
const seesBooker = (ctx: StaffTenantContext) => can(ctx.access.role, "bookings.read");

/** Booking reads carry personal data or money; no cache keeps them. */
function noStore(c: Context<AppEnv>) {
  c.header("Cache-Control", "no-store");
}

/**
 * Staff booking reads. G2.7 added a trip's bookings and the finalization
 * exceptions; the console (G2.12b) adds a day's bookings, one booking in
 * detail, a lookup by reference, and a trip's roster, and pages the
 * exceptions. Read-only. Owners, booking staff, and finance read bookings and
 * payments; only owners and booking staff receive the booker's name and
 * email, and only they read rosters.
 */
export function registerBookingStaffRoutes(app: OpenAPIHono<AppEnv>, deps: AppDeps) {
  const tripBookingsRoute = createRoute({
    method: "get",
    path: tripBookingsPath,
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

  app.openapi(tripBookingsRoute, async (c) => {
    const { tenantId, tripId } = c.req.valid("param");
    const { body } = await withStaffTenant(
      c,
      deps,
      { tenantId, permission: "bookings.read" },
      async (trx) => {
        const bookings = await listTripBookings(trx, tenantId, tripId);
        if (!bookings) throw tripNotFound();
        return { bookings: bookings.map((b) => ({ ...b })) };
      },
    );
    noStore(c);
    return c.json(body, 200);
  });

  const exceptionsRoute = createRoute({
    method: "get",
    path: exceptionsPath,
    tags: ["staff", "bookings"],
    summary: "Payments that could not become bookings",
    description:
      "Every role. Verified payments whose capacity was gone, whose trip changed, or whose checkout had already failed or been canceled, newest first, with the trip, the checkout, the masked provider reference, and the state of the automatic full refund. A payment_mismatch is not refunded automatically. The booker's name and email, for following up, go only to roles that hold bookings.read.",
    security: staffSecurity,
    request: { params: StaffTenantParams, query: FinalizationExceptionQuery },
    responses: {
      200: {
        content: { "application/json": { schema: FinalizationExceptionsResponse } },
        description: "The exceptions",
      },
      400: errorBody("The cursor names no exception of this tenant (cursor_invalid)"),
      401: errorBody("Not signed in"),
      403: errorBody("Role does not allow this"),
      404: errorBody("No such tenant"),
    },
  });

  app.openapi(exceptionsRoute, async (c) => {
    const { tenantId } = c.req.valid("param");
    const { limit, before } = c.req.valid("query");
    const { body } = await withStaffTenant(
      c,
      deps,
      { tenantId, permission: "payments.read" },
      async (trx, ctx) => {
        const page = await listExceptionsPage(trx, tenantId, {
          limit,
          ...(before === undefined ? {} : { before }),
          withBooker: seesBooker(ctx),
        });
        if (page.kind === "cursor_invalid") throw cursorInvalid();
        return {
          exceptions: page.exceptions.map((e) => ({ ...e })),
          nextBefore: page.nextBefore,
        };
      },
    );
    noStore(c);
    return c.json(body, 200);
  });

  const dayBookingsRoute = createRoute({
    method: "get",
    path: dayBookingsPath,
    tags: ["staff", "bookings"],
    summary: "Bookings on trips departing on one local date",
    description:
      "Every role. The date's trips with their booking and guest counts, and a page of its bookings by departure and then by confirmation: reference, party, extras, total, and payment state. The booker's name goes only to roles that hold bookings.read; for any other role the field is absent.",
    security: staffSecurity,
    request: { params: StaffTenantParams, query: BookingListQuery },
    responses: {
      200: {
        content: { "application/json": { schema: BookingListResponse } },
        description: "The day's bookings",
      },
      400: errorBody(
        "A malformed date, trip id, or limit (validation_failed), or a cursor that names no booking of this tenant (cursor_invalid)",
      ),
      401: errorBody("Not signed in"),
      403: errorBody("Role does not allow this"),
      404: errorBody("No such tenant"),
    },
  });

  app.openapi(dayBookingsRoute, async (c) => {
    const { tenantId } = c.req.valid("param");
    const { date, tripId, limit, after } = c.req.valid("query");
    const { body } = await withStaffTenant(
      c,
      deps,
      { tenantId, permission: "payments.read" },
      async (trx, ctx) => {
        const result = await listDayBookings(trx, tenantId, {
          date,
          limit,
          ...(tripId === undefined ? {} : { tripId }),
          ...(after === undefined ? {} : { after }),
          withBooker: seesBooker(ctx),
        });
        if (result.kind === "cursor_invalid") throw cursorInvalid();
        return {
          date,
          trips: result.trips.map((t) => ({ ...t })),
          bookings: result.bookings.map((b) => ({ ...b })),
          nextAfter: result.nextAfter,
        };
      },
    );
    noStore(c);
    return c.json(body, 200);
  });

  const bookingRoute = createRoute({
    method: "get",
    path: bookingPath,
    tags: ["staff", "bookings"],
    summary: "One booking in detail",
    description:
      "Every role. The trip, where to meet, the party and extras, the immutable order's lines and totals, the payment with its provider reference masked, any refund, and a short timeline. The booker's name and email go only to roles that hold bookings.read; for any other role the field is absent. An unknown id and another tenant's id answer the same 404.",
    security: staffSecurity,
    request: { params: BookingParams },
    responses: {
      200: {
        content: { "application/json": { schema: BookingDetailResponse } },
        description: "The booking",
      },
      401: errorBody("Not signed in"),
      403: errorBody("Role does not allow this"),
      404: errorBody("No such tenant, or no such booking for it (booking_not_found)"),
    },
  });

  app.openapi(bookingRoute, async (c) => {
    const { tenantId, bookingId } = c.req.valid("param");
    const { body } = await withStaffTenant(
      c,
      deps,
      { tenantId, permission: "payments.read" },
      async (trx, ctx) => {
        const booking = await getBookingDetail(trx, tenantId, bookingId, {
          withBooker: seesBooker(ctx),
        });
        if (!booking) throw bookingNotFound();
        return { booking: { ...booking } };
      },
    );
    noStore(c);
    return c.json(body, 200);
  });

  const referenceRoute = createRoute({
    method: "get",
    path: referencePath,
    tags: ["staff", "bookings"],
    summary: "Find a booking by its reference",
    description:
      "Every role. The booking a reference names, as a guest quotes it: case, spaces, and hyphens are ignored, and O, I, and L read as 0, 1, and 1. Anything that cannot be a reference, an unknown reference, and another tenant's answer the same 404.",
    security: staffSecurity,
    request: { params: BookingReferenceParams },
    responses: {
      200: {
        content: { "application/json": { schema: BookingReferenceResponse } },
        description: "The booking's id, reference, trip, and local date",
      },
      401: errorBody("Not signed in"),
      403: errorBody("Role does not allow this"),
      404: errorBody("No such tenant, or no such booking for it (booking_not_found)"),
    },
  });

  app.openapi(referenceRoute, async (c) => {
    const { tenantId, reference } = c.req.valid("param");
    const { body } = await withStaffTenant(
      c,
      deps,
      { tenantId, permission: "payments.read" },
      async (trx) => {
        const normalized = normalizeBookingReference(reference);
        const found = normalized ? await findBookingByReference(trx, tenantId, normalized) : null;
        if (!found) throw bookingNotFound();
        return { booking: { ...found } };
      },
    );
    noStore(c);
    return c.json(body, 200);
  });

  const rosterRoute = createRoute({
    method: "get",
    path: rosterPath,
    tags: ["staff", "bookings"],
    summary: "A trip's roster",
    description:
      "Owners and booking staff. Every booking on the trip, oldest first, with the booker's name, the party, extras, and payment state, and the trip's time, meeting point, and totals. A booking-management view, not a passenger manifest: participants and waivers are not collected yet.",
    security: staffSecurity,
    request: { params: TripParams },
    responses: {
      200: {
        content: { "application/json": { schema: TripRosterResponse } },
        description: "The roster",
      },
      401: errorBody("Not signed in"),
      403: errorBody("Role does not allow this"),
      404: errorBody("No such tenant, or no such trip for it (trip_not_found)"),
    },
  });

  app.openapi(rosterRoute, async (c) => {
    const { tenantId, tripId } = c.req.valid("param");
    const { body } = await withStaffTenant(
      c,
      deps,
      { tenantId, permission: "bookings.read" },
      async (trx) => {
        const roster = await getTripRoster(trx, tenantId, tripId);
        if (!roster) throw tripNotFound();
        return { roster: { ...roster } };
      },
    );
    noStore(c);
    return c.json(body, 200);
  });
}
