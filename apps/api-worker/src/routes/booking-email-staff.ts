import { createRoute, type OpenAPIHono, z } from "@hono/zod-openapi";
import {
  BookingEmailResendRequest,
  BookingEmailResendResponse,
  BookingParams,
  IdempotencyKey,
} from "@tidegrid/contracts";
import { isUuid } from "@tidegrid/database";
import { type ResendResult, resendBookingEmail } from "@tidegrid/domain-booking";
import type { AppDeps, AppEnv } from "../context.ts";
import { deliverAfterCommit, emailSettings } from "../email.ts";
import type { Bindings } from "../env.ts";
import { ApiError } from "../errors.ts";
import { withStaffTenant } from "../staff-tenant.ts";
import { errorBody, staffSecurity } from "./responses.ts";

const resendPath = "/v1/staff/tenants/{tenantId}/bookings/{bookingId}/emails/resend";

/**
 * Whether this deployment sends email: the fake or Cloudflare is on; off and
 * refused configurations are off, and their messages stay queued.
 */
export function emailDelivery(env: Bindings): "on" | "off" {
  const kind = emailSettings(env).kind;
  return kind === "fake" || kind === "cloudflare" ? "on" : "off";
}

type Refusal = Exclude<ResendResult, { kind: "queued" } | { kind: "not_found" }>;

/** A refusal's code and words for staff; times are instants, never personal data. */
function refusalBody(refused: Refusal): { code: string; message: string } {
  const after = refused.availableAt ? `; try after ${refused.availableAt.toISOString()}` : "";
  switch (refused.code) {
    case "kind_mismatch":
      return {
        code: "booking_email_kind_mismatch",
        message:
          "The booking's state has no email of this kind: a confirmation goes to a confirmed booking, a cancellation notice to a canceled one",
      };
    case "trip_over":
      return { code: "booking_trip_over", message: "The trip has ended" };
    case "refund_failed":
      return {
        code: "booking_email_refund_failed",
        message:
          "The refund failed, so the cancellation notice would say money is on its way when it is not",
      };
    case "limit":
      return {
        code: "booking_email_resend_limit",
        message: "This booking's email has been sent again 5 times already",
      };
    case "too_soon":
      return {
        code: "booking_email_too_soon",
        message: `It was sent again less than 10 minutes ago${after}`,
      };
    case "rate_limited":
      return {
        code: "booking_email_rate_limited",
        message: `This operator has sent 50 emails again in the last hour${after}`,
      };
    case "in_progress":
      return {
        code: "booking_email_in_progress",
        message: "An earlier email of this kind is being sent right now; try again in a minute",
      };
    case "email_invalid":
      return {
        code: "booking_email_invalid",
        message: "TideGrid could not build this email from the booking's details",
      };
  }
}

/**
 * Staff resend of a booking's email (G2.16b): the confirmation, with a new
 * management link, or the cancellation notice. Owners and booking staff hold
 * messages.resend; finance is refused. Another tenant's booking, an unknown
 * id, and a malformed one answer the same 404.
 */
export function registerBookingEmailStaffRoutes(app: OpenAPIHono<AppEnv>, deps: AppDeps) {
  app.use("/v1/staff/tenants/:tenantId/bookings/:bookingId/emails/resend", async (c, next) => {
    await next();
    c.header("Cache-Control", "no-store");
  });

  const route = createRoute({
    method: "post",
    path: resendPath,
    tags: ["staff", "bookings"],
    summary: "Send a booking's email again",
    description: [
      "Owners and booking staff. Sends the booking's confirmation (with a new management link) or its cancellation notice again, as a new message, to the booker's address on file, rendered from the booking as it is now. The new link is minted when the email is sent; earlier links are superseded then, and still renew. An earlier email of the same kind still waiting to go out is canceled (code resent). The reason code is recorded in the audit history. Never a retry of an earlier message: delivery sends each message at most once.",
      "Limits, for every staff member and request: at most 5 sends again per booking that were attempted or are still waiting, at least 10 minutes after the booking's last one, and 50 an hour per operator. Idempotent by key: a refusal is the key's stored answer and replays as the same 409; send again with a new key.",
      "Order: authentication (401), membership (404), permission (403), the key's replay, the booking (404), then booking_email_off (409) when this environment sends no email, which stores nothing for the key.",
    ].join("\n\n"),
    security: staffSecurity,
    request: {
      params: BookingParams,
      headers: z.object({ "idempotency-key": IdempotencyKey }),
      body: {
        required: true,
        content: { "application/json": { schema: BookingEmailResendRequest } },
      },
    },
    responses: {
      201: {
        content: { "application/json": { schema: BookingEmailResendResponse } },
        description: "Queued; it goes out at once, or with the next delivery run",
      },
      400: errorBody("Request did not match the contract"),
      401: errorBody("Not signed in"),
      403: errorBody("Role does not allow this"),
      404: errorBody("No such tenant or booking (booking_not_found)"),
      409: errorBody(
        "Email is off in this environment (booking_email_off, not stored for the key); the booking's state has no email of this kind (booking_email_kind_mismatch); the trip has ended (booking_trip_over); the refund failed (booking_email_refund_failed); sent again 5 times already (booking_email_resend_limit); sent again under 10 minutes ago (booking_email_too_soon); the operator's hourly limit is reached (booking_email_rate_limited); an earlier email of this kind is being sent right now (booking_email_in_progress); or the email could not be built (booking_email_invalid). Every refusal but booking_email_off is final for its Idempotency-Key",
      ),
      422: errorBody("idempotency_key_reused"),
    },
  });

  app.openapi(route, async (c) => {
    const { tenantId, bookingId } = c.req.valid("param");
    const key = c.req.valid("header")["idempotency-key"];
    const input = c.req.valid("json");
    const notFound = () =>
      new ApiError(404, "booking_not_found", "No such booking for this tenant");
    const { body, replayed } = await withStaffTenant(
      c,
      deps,
      {
        tenantId,
        permission: "messages.resend",
        idempotency: {
          scope: "bookings.email_resend",
          key,
          route: resendPath,
          params: { bookingId },
          body: input,
          successStatus: 201,
        },
      },
      async (trx, ctx) => {
        if (!isUuid(bookingId)) throw notFound();
        const found = await trx
          .selectFrom("bookings")
          .select("id")
          .where("tenant_id", "=", tenantId)
          .where("id", "=", bookingId)
          .executeTakeFirst();
        if (!found) throw notFound();
        // Thrown, so the key's claim rolls back with everything else: nothing
        // is stored, and the same key works once email is on.
        if (emailDelivery(c.env) === "off") {
          throw new ApiError(
            409,
            "booking_email_off",
            "Email is off in this environment, so nothing would be sent",
          );
        }
        const sent = await resendBookingEmail(trx, ctx, {
          bookingId,
          kind: input.kind,
          reason: input.reason,
        });
        if (sent.kind === "not_found") throw notFound();
        // A refusal commits as the key's stored answer, and nothing else: the
        // service decides every refusal before it writes.
        if (sent.kind === "refused") return { refusal: refusalBody(sent) };
        return {
          message: {
            id: sent.messageId,
            generation: sent.generation,
            queuedAt: sent.queuedAt.toISOString(),
          },
        };
      },
    );
    if (replayed) c.header("Idempotent-Replayed", "true");
    if ("refusal" in body) {
      const refusal = body.refusal as { code: string; message: string };
      throw new ApiError(409, refusal.code, refusal.message);
    }
    // The new email goes out at once; the cron's sweep sends it if this misses.
    if (!replayed) deliverAfterCommit(c, deps, tenantId);
    return c.json(body as BookingEmailResendResponse, 201);
  });
}
