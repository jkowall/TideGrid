import { createRoute, type OpenAPIHono, z } from "@hono/zod-openapi";
import {
  BookingEmailResendRequest,
  BookingEmailResendResponse,
  BookingParams,
  EmailExceptionQuery,
  EmailExceptionsResponse,
  IdempotencyKey,
  StaffTenantParams,
} from "@tidegrid/contracts";
import { isUuid } from "@tidegrid/database";
import { type ResendResult, resendBookingEmail } from "@tidegrid/domain-booking";
import { listEmailExceptions } from "@tidegrid/domain-messaging";
import type { AppDeps, AppEnv } from "../context.ts";
import { deliverAfterCommit, emailSettings } from "../email.ts";
import type { Bindings } from "../env.ts";
import { ApiError } from "../errors.ts";
import { withStaffTenant } from "../staff-tenant.ts";
import { errorBody, staffSecurity } from "./responses.ts";

const resendPath = "/v1/staff/tenants/{tenantId}/bookings/{bookingId}/emails/resend";
const exceptionsPath = "/v1/staff/tenants/{tenantId}/email-exceptions";

/**
 * Whether this deployment sends email: the fake or Cloudflare is on; off and
 * refused configurations are off, and their messages stay queued.
 */
export function emailDelivery(env: Bindings): "on" | "off" {
  const kind = emailSettings(env).kind;
  return kind === "fake" || kind === "cloudflare" ? "on" : "off";
}

type Refusal = Exclude<ResendResult, { kind: "queued" } | { kind: "not_found" }>;

/**
 * The database refused the resend because its transaction ran past its bound
 * (migration 0014, booking_email_resends_late), at the ledger insert or at
 * commit. The whole transaction rolled back, the key's claim with it.
 */
function ranTooLong(error: unknown): boolean {
  const e = error as { code?: unknown; constraint_name?: unknown } | null;
  return e?.code === "23514" && e.constraint_name === "booking_email_resends_late";
}

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
      "A request whose work ran longer than the database allows a resend (30 s, as when it waited behind other resends) answers 503 booking_email_busy: nothing was sent or stored, so the same request may be sent again with the same key.",
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
      503: errorBody(
        "The request ran longer than a resend may (booking_email_busy); nothing was sent or stored for the key, so send the same request again",
      ),
    },
  });

  app.openapi(route, async (c) => {
    const { tenantId, bookingId } = c.req.valid("param");
    const key = c.req.valid("header")["idempotency-key"];
    const input = c.req.valid("json");
    const notFound = () =>
      new ApiError(404, "booking_not_found", "No such booking for this tenant");
    const answer = withStaffTenant(
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
    const { body, replayed } = await answer.catch((error: unknown) => {
      if (!ranTooLong(error)) throw error;
      throw new ApiError(
        503,
        "booking_email_busy",
        "This took too long and nothing was sent; send it again",
      );
    });
    if (replayed) c.header("Idempotent-Replayed", "true");
    if ("refusal" in body) {
      const refusal = body.refusal as { code: string; message: string };
      throw new ApiError(409, refusal.code, refusal.message);
    }
    // The new email goes out at once; the cron's sweep sends it if this misses.
    if (!replayed) deliverAfterCommit(c, deps, tenantId);
    return c.json(body as BookingEmailResendResponse, 201);
  });

  registerEmailExceptionsRoute(app, deps);
}

/**
 * The tenant-wide email exceptions list (W1-EMAIL-EXC, a follow-up to G2.16b
 * D9 A): every message of the operator that stopped in the failed state,
 * newest first, a page at a time, each with its booking's reference so staff
 * follow it up on the booking. Owners and booking staff hold bookings.read;
 * finance is refused (D2), as on the booking's Email card. The read runs in
 * the tenant's transaction (withStaffTenant), and no recipient or content
 * leaves it.
 */
function registerEmailExceptionsRoute(app: OpenAPIHono<AppEnv>, deps: AppDeps) {
  app.use("/v1/staff/tenants/:tenantId/email-exceptions", async (c, next) => {
    await next();
    c.header("Cache-Control", "no-store");
  });

  const route = createRoute({
    method: "get",
    path: exceptionsPath,
    tags: ["staff", "bookings"],
    summary: "Email that could not be delivered",
    description: [
      "Owners and booking staff. Every message of the operator whose delivery stopped in the failed state, newest first by when it stopped: what it was (a booking email or a waiver request), how it ended (failed, outcome_unknown, or delivery_failed), the attempts, the last error's class, whether staff sent it, whether a later message of the same template for the same booking, participant, and subject was sent, and its booking's id, reference, and trip time zone. No recipient, subject, body, or name.",
      "Finance does not hold bookings.read and is refused (403). Order: a query that does not match the contract (400 validation_failed), authentication (401), membership (404), permission (403), then the cursor (400 cursor_invalid).",
    ].join("\n\n"),
    security: staffSecurity,
    request: { params: StaffTenantParams, query: EmailExceptionQuery },
    responses: {
      200: {
        content: { "application/json": { schema: EmailExceptionsResponse } },
        description: "A page of the operator's email exceptions",
      },
      400: errorBody(
        "The query did not match the contract (validation_failed), or the cursor names no email exception of this tenant (cursor_invalid)",
      ),
      401: errorBody("Not signed in"),
      403: errorBody("Role does not allow this"),
      404: errorBody("No such tenant"),
    },
  });

  app.openapi(route, async (c) => {
    const { tenantId } = c.req.valid("param");
    const { limit, before } = c.req.valid("query");
    const { body } = await withStaffTenant(
      c,
      deps,
      { tenantId, permission: "bookings.read", snapshot: true },
      async (trx) => {
        const page = await listEmailExceptions(trx, tenantId, {
          limit,
          ...(before === undefined ? {} : { before }),
        });
        if (page.kind === "cursor_invalid") {
          throw new ApiError(400, "cursor_invalid", "The cursor names nothing in this listing");
        }
        return {
          exceptions: page.exceptions.map((e) => ({ ...e })),
          nextBefore: page.nextBefore,
        };
      },
    );
    return c.json(body as EmailExceptionsResponse, 200);
  });
}
