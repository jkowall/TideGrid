import { createRoute, type OpenAPIHono, z } from "@hono/zod-openapi";
import {
  BookingParams,
  type BookingWaivers as BookingWaiversJson,
  BookingWaiversResponse,
  IdempotencyKey,
  TripParams,
  TripWaiversResponse,
  WaiverEvidenceParams,
  WaiverRequestParams,
  WaiverResendRequest,
  WaiverResendResponse,
} from "@tidegrid/contracts";
import { isUuid } from "@tidegrid/database";
import {
  type BookingWaivers,
  listBookingWaivers,
  listTripWaivers,
  loadEvidenceDocument,
  sendWaiverRequest,
} from "@tidegrid/domain-waivers";
import type { AppDeps, AppEnv } from "../context.ts";
import { ApiError } from "../errors.ts";
import { withStaffTenant } from "../staff-tenant.ts";
import { pdfResponse, waiverDeps } from "../waivers.ts";
import { errorBody, staffSecurity } from "./responses.ts";

const bookingWaiversPath = "/v1/staff/tenants/{tenantId}/bookings/{bookingId}/waivers";
const tripWaiversPath = "/v1/staff/tenants/{tenantId}/trips/{tripId}/waivers";
const resendPath = "/v1/staff/tenants/{tenantId}/waiver-requests/{requestId}/resend";
const documentPath = "/v1/staff/tenants/{tenantId}/waiver-evidence/{evidenceId}/document";

const iso = (d: Date) => d.toISOString();

export function bookingWaiversJson(b: BookingWaivers): BookingWaiversJson {
  return {
    bookingId: b.bookingId,
    reference: b.reference,
    bookingState: b.bookingState,
    partySize: b.partySize,
    required: b.required,
    unnamedPlaces: b.unnamedPlaces,
    participants: b.participants.map((p) => ({
      participantId: p.participantId,
      position: p.position,
      name: p.name,
      minor: p.minor,
      status: p.status,
      request: p.request
        ? {
            id: p.request.id,
            state: p.request.state,
            revokedReason: p.request.revokedReason,
            requiredSigner: p.request.requiredSigner,
            templateName: p.request.templateName,
            version: p.request.version,
            assignedAt: iso(p.request.assignedAt),
            signed: p.request.signed
              ? {
                  evidenceId: p.request.signed.evidenceId,
                  signedAt: iso(p.request.signed.signedAt),
                  signerName: p.request.signed.signerName,
                  relationship: p.request.signed.relationship,
                }
              : null,
            delivery: p.request.delivery
              ? {
                  generation: p.request.delivery.generation,
                  kind: p.request.delivery.kind,
                  recipient: p.request.delivery.recipient,
                  queuedAt: iso(p.request.delivery.queuedAt),
                  message: p.request.delivery.message
                    ? {
                        state: p.request.delivery.message.state,
                        at: p.request.delivery.message.at
                          ? iso(p.request.delivery.message.at)
                          : null,
                        failureCode: p.request.delivery.message.failureCode,
                      }
                    : null,
                }
              : null,
            resendAvailableAt: p.request.resendAvailableAt
              ? iso(p.request.resendAvailableAt)
              : null,
          }
        : null,
    })),
  };
}

/**
 * Staff waiver reads and the resend command (G2.15). Waiver status names
 * participants, so reads need bookings.read (owners and booking staff), as
 * the roster does; finance is refused. Sending a request again needs
 * waivers.manage (owners and booking staff). Another tenant's id, an unknown
 * one, and a malformed one answer the same 404.
 */
export function registerWaiverStaffRoutes(app: OpenAPIHono<AppEnv>, deps: AppDeps) {
  for (const path of [
    "/v1/staff/tenants/:tenantId/bookings/:bookingId/waivers",
    "/v1/staff/tenants/:tenantId/trips/:tripId/waivers",
    "/v1/staff/tenants/:tenantId/waiver-requests/:requestId/resend",
    "/v1/staff/tenants/:tenantId/waiver-evidence/:evidenceId/document",
  ]) {
    app.use(path, async (c, next) => {
      await next();
      c.header("Cache-Control", "no-store");
    });
  }

  const bookingRoute = createRoute({
    method: "get",
    path: bookingWaiversPath,
    tags: ["staff", "waivers"],
    summary: "A booking's waivers",
    description:
      "Owners and booking staff. Each named participant, by place, with how their waiver stands (an icon and a label in the console, never a color alone): signed, waiting, an email that failed, no address yet, or not required. Delivery and signature are separate: the latest email's state never says a waiver was signed. Addresses are masked. Finance does not hold bookings.read and is refused.",
    security: staffSecurity,
    request: { params: BookingParams },
    responses: {
      200: {
        content: { "application/json": { schema: BookingWaiversResponse } },
        description: "The booking's waivers",
      },
      401: errorBody("Not signed in"),
      403: errorBody("Role does not allow this"),
      404: errorBody("No such tenant or booking (booking_not_found)"),
    },
  });

  app.openapi(bookingRoute, async (c) => {
    const { tenantId, bookingId } = c.req.valid("param");
    const { body } = await withStaffTenant(
      c,
      deps,
      { tenantId, permission: "bookings.read", snapshot: true },
      async (trx) => {
        const waivers = await listBookingWaivers(trx, tenantId, bookingId);
        if (!waivers) {
          throw new ApiError(404, "booking_not_found", "No such booking for this tenant");
        }
        return { waivers: bookingWaiversJson(waivers) };
      },
    );
    return c.json(body as BookingWaiversResponse, 200);
  });

  const tripRoute = createRoute({
    method: "get",
    path: tripWaiversPath,
    tags: ["staff", "waivers"],
    summary: "A trip's waivers, for its roster",
    description:
      "Owners and booking staff. Every confirmed booking on the trip, oldest first, with each named participant's waiver status, and totals: signed, waiting, needing attention (no address, a failed email, or no request), and places nobody has been named for. Finance is refused.",
    security: staffSecurity,
    request: { params: TripParams },
    responses: {
      200: {
        content: { "application/json": { schema: TripWaiversResponse } },
        description: "The trip's waivers",
      },
      401: errorBody("Not signed in"),
      403: errorBody("Role does not allow this"),
      404: errorBody("No such tenant or trip (trip_not_found)"),
    },
  });

  app.openapi(tripRoute, async (c) => {
    const { tenantId, tripId } = c.req.valid("param");
    const { body } = await withStaffTenant(
      c,
      deps,
      { tenantId, permission: "bookings.read", snapshot: true },
      async (trx) => {
        const trip = await listTripWaivers(trx, tenantId, tripId);
        if (!trip) throw new ApiError(404, "trip_not_found", "No such trip for this tenant");
        return {
          tripId: trip.tripId,
          bookings: trip.bookings.map(bookingWaiversJson),
          totals: trip.totals,
        };
      },
    );
    return c.json(body as TripWaiversResponse, 200);
  });

  const resendRoute = createRoute({
    method: "post",
    path: resendPath,
    tags: ["staff", "waivers"],
    summary: "Send a participant's waiver request again",
    description: [
      "Owners and booking staff. Sends the request again, as a new delivery generation, to the address the booking has now, with a new link; the earlier links stop working. Never a new request, a new version, or a reset of a signature. The reason is recorded on the delivery and in the audit history.",
      "Limits, for every writer: at most 5 sends per request, and a send to the same address at least 10 minutes after the previous one (a corrected address goes at once). Idempotent by key.",
    ].join("\n\n"),
    security: staffSecurity,
    request: {
      params: WaiverRequestParams,
      headers: z.object({ "idempotency-key": IdempotencyKey }),
      body: { required: true, content: { "application/json": { schema: WaiverResendRequest } } },
    },
    responses: {
      201: {
        content: { "application/json": { schema: WaiverResendResponse } },
        description: "Sent",
      },
      400: errorBody("Request did not match the contract"),
      401: errorBody("Not signed in"),
      403: errorBody("Role does not allow this"),
      404: errorBody("No such tenant or waiver request (waiver_request_not_found)"),
      409: errorBody(
        "The waiver is not waiting for a signature (waiver_not_pending); the participant has no address (waiver_no_address); the last send to this address was under 10 minutes ago (waiver_resend_too_soon); it was sent 5 times already (waiver_resend_limit); or the trip has ended (waiver_trip_over)",
      ),
      422: errorBody("idempotency_key_reused"),
    },
  });

  app.openapi(resendRoute, async (c) => {
    const { tenantId, requestId } = c.req.valid("param");
    const key = c.req.valid("header")["idempotency-key"];
    const input = c.req.valid("json");
    const wdeps = waiverDeps(c.env, deps);
    const notFound = () =>
      new ApiError(404, "waiver_request_not_found", "No such waiver request for this tenant");
    const { body, replayed } = await withStaffTenant(
      c,
      deps,
      {
        tenantId,
        permission: "waivers.manage",
        idempotency: {
          scope: "waiver_requests.resend",
          key,
          route: resendPath,
          params: { requestId },
          body: input,
          successStatus: 201,
        },
      },
      async (trx, ctx) => {
        if (!isUuid(requestId)) throw notFound();
        const exists = await trx
          .selectFrom("waiver_requests")
          .select("id")
          .where("tenant_id", "=", tenantId)
          .where("id", "=", requestId)
          .executeTakeFirst();
        if (!exists) throw notFound();
        const sent = await sendWaiverRequest(trx, ctx, wdeps, {
          requestId,
          kind: "resend",
          reason: input.reason,
        });
        switch (sent.kind) {
          case "sent":
            return {
              delivery: { generation: sent.generation, queuedAt: sent.queuedAt.toISOString() },
            };
          case "not_pending":
          case "already_sent":
            throw new ApiError(
              409,
              "waiver_not_pending",
              "This waiver is not waiting for a signature",
            );
          case "no_participant":
          case "no_address":
            throw new ApiError(
              409,
              "waiver_no_address",
              "The booking has no address for this person yet",
            );
          case "too_soon":
            throw new ApiError(
              409,
              "waiver_resend_too_soon",
              `It was sent to this address less than 10 minutes ago; try after ${sent.retryAfter.toISOString()}`,
            );
          case "limit_reached":
            throw new ApiError(409, "waiver_resend_limit", "It has been sent 5 times already");
          case "trip_over":
          case "no_guest_site":
            throw new ApiError(409, "waiver_trip_over", "The trip ends too soon to send a link");
        }
      },
    );
    if (replayed) c.header("Idempotent-Replayed", "true");
    return c.json(body as WaiverResendResponse, 201);
  });

  const documentRoute = createRoute({
    method: "get",
    path: documentPath,
    tags: ["staff", "waivers"],
    summary: "A signed waiver's PDF",
    description:
      "Owners and booking staff. The PDF exactly as recorded with the evidence; its SHA-256 is the one the evidence holds. Finance is refused.",
    security: staffSecurity,
    request: { params: WaiverEvidenceParams },
    responses: {
      200: {
        content: { "application/pdf": { schema: z.string().openapi({ format: "binary" }) } },
        description: "The signed PDF",
      },
      401: errorBody("Not signed in"),
      403: errorBody("Role does not allow this"),
      404: errorBody("No such tenant or evidence (waiver_evidence_not_found)"),
    },
  });

  app.openapi(documentRoute, async (c) => {
    const { tenantId, evidenceId } = c.req.valid("param");
    let doc: { reference: string; bytes: Uint8Array<ArrayBuffer> } | undefined;
    await withStaffTenant(
      c,
      deps,
      { tenantId, permission: "bookings.read", snapshot: true },
      async (trx) => {
        const found = await loadEvidenceDocument(trx, tenantId, { evidenceId });
        if (!found) {
          throw new ApiError(
            404,
            "waiver_evidence_not_found",
            "No such signed waiver for this tenant",
          );
        }
        doc = { reference: found.bookingReference, bytes: new Uint8Array(found.document) };
        return {};
      },
    );
    if (!doc) throw new Error("the document read produced nothing");
    return pdfResponse(c, doc.bytes, `waiver-${doc.reference}-${evidenceId.slice(0, 8)}.pdf`);
  });
}
