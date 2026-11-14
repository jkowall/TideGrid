import { createRoute, type OpenAPIHono, z } from "@hono/zod-openapi";
import {
  BalanceDueChangeRequest,
  BalanceLinkAccepted,
  BookingBalanceResponse,
  BookingParams,
  IdempotencyKey,
} from "@tidegrid/contracts";
import { changeBalanceDueDate, sendBalanceLink } from "@tidegrid/domain-booking";
import type { AppDeps, AppEnv } from "../context.ts";
import { deliverAfterCommit } from "../email.ts";
import { ApiError } from "../errors.ts";
import { withStaffTenant } from "../staff-tenant.ts";
import { emailDelivery } from "./booking-email-staff.ts";
import { errorBody, staffSecurity } from "./responses.ts";

const dueDatePath = "/v1/staff/tenants/{tenantId}/bookings/{bookingId}/balance/due-date";
const linkPath = "/v1/staff/tenants/{tenantId}/bookings/{bookingId}/balance/link";

const notFound = () => new ApiError(404, "booking_not_found", "No such booking for this tenant");

/**
 * A private charter's balance, as staff act on it (W3-G2.8): move the due date
 * with a reason (owners, bookings.override), and email the
 * guest the link to pay it (messages.resend). Another tenant's booking, an
 * unknown id, and a malformed one answer the same 404. Nothing here moves
 * money: the guest pays by card, or staff record an external payment.
 */
export function registerBalanceStaffRoutes(app: OpenAPIHono<AppEnv>, deps: AppDeps) {
  app.use("/v1/staff/tenants/:tenantId/bookings/:bookingId/balance/*", async (c, next) => {
    c.header("Cache-Control", "no-store");
    await next();
    c.header("Cache-Control", "no-store");
  });

  const dueDateRoute = createRoute({
    method: "post",
    path: dueDatePath,
    tags: ["staff", "bookings"],
    summary: "Move a balance's due date",
    description: [
      "Owners only. Moves when a private charter's balance is due, with a reason kept with the change and in the audit history. The reminders for the old date are canceled and new ones are written for the new date (7 days and 1 day before). The new date must be before the trip starts; it may be in the past, which makes the balance overdue now.",
      "Idempotent by key. 409 no_balance when the booking paid in full at checkout or was canceled; 422 invalid_due_date when the date is not before the trip.",
    ].join("\n\n"),
    security: staffSecurity,
    request: {
      params: BookingParams,
      headers: z.object({ "idempotency-key": IdempotencyKey }),
      body: {
        required: true,
        content: { "application/json": { schema: BalanceDueChangeRequest } },
      },
    },
    responses: {
      200: {
        content: { "application/json": { schema: BookingBalanceResponse } },
        description: "The balance with its new due date",
      },
      400: errorBody("Request did not match the contract"),
      401: errorBody("Not signed in"),
      403: errorBody("Role does not allow this"),
      404: errorBody("No such tenant or booking (booking_not_found)"),
      409: errorBody("The booking has no balance (no_balance)"),
      422: errorBody(
        "The due date is not before the trip (invalid_due_date), or idempotency_key_reused",
      ),
    },
  });

  app.openapi(dueDateRoute, async (c) => {
    const { tenantId, bookingId } = c.req.valid("param");
    const key = c.req.valid("header")["idempotency-key"];
    const input = c.req.valid("json");
    const { body, replayed } = await withStaffTenant(
      c,
      deps,
      {
        tenantId,
        permission: "bookings.override",
        idempotency: {
          scope: "bookings.balance_due_date",
          key,
          route: dueDatePath,
          params: { bookingId },
          body: input,
          successStatus: 200,
        },
      },
      async (trx, ctx) => {
        const changed = await changeBalanceDueDate(trx, ctx, {
          bookingId,
          dueAt: new Date(input.dueAt),
          reason: input.reason,
        });
        switch (changed.kind) {
          case "changed":
            return { balance: changed.balance };
          case "not_found":
            throw notFound();
          case "no_balance":
            throw new ApiError(409, "no_balance", "This booking has no balance to move");
          case "invalid_due_date":
            throw new ApiError(422, "invalid_due_date", "The due date must be before the trip");
        }
      },
    );
    if (replayed) c.header("Idempotent-Replayed", "true");
    return c.json(body as BookingBalanceResponse, 200);
  });

  const linkRoute = createRoute({
    method: "post",
    path: linkPath,
    tags: ["staff", "bookings"],
    summary: "Email the guest the balance link",
    description: [
      "Owners and booking staff. Emails the booker, at the address on file, a link to their booking where they pay what is owed now. At most 3 an hour per booking.",
      "Idempotent by key. 409 nothing_owed when nothing is owed, the booking was canceled, or its trip has left; 409 booking_email_off when this environment sends no email (nothing stored for the key); 429 balance_link_rate_limited past the hourly limit.",
    ].join("\n\n"),
    security: staffSecurity,
    request: {
      params: BookingParams,
      headers: z.object({ "idempotency-key": IdempotencyKey }),
    },
    responses: {
      202: {
        content: { "application/json": { schema: BalanceLinkAccepted } },
        description: "Queued; it goes out at once, or with the next delivery run",
      },
      400: errorBody("Request did not match the contract"),
      401: errorBody("Not signed in"),
      403: errorBody("Role does not allow this"),
      404: errorBody("No such tenant or booking (booking_not_found)"),
      409: errorBody(
        "Nothing is owed (nothing_owed), email is off here (booking_email_off), or the booking was imported and its batch's email is not released yet (booking_imported)",
      ),
      422: errorBody("idempotency_key_reused"),
      429: errorBody("Three links went out in the last hour (balance_link_rate_limited)"),
    },
  });

  app.openapi(linkRoute, async (c) => {
    const { tenantId, bookingId } = c.req.valid("param");
    const key = c.req.valid("header")["idempotency-key"];
    const { body, replayed } = await withStaffTenant(
      c,
      deps,
      {
        tenantId,
        permission: "messages.resend",
        idempotency: {
          scope: "bookings.balance_link",
          key,
          route: linkPath,
          params: { bookingId },
          body: {},
          successStatus: 202,
        },
      },
      async (trx, ctx) => {
        if (emailDelivery(c.env) === "off") {
          throw new ApiError(
            409,
            "booking_email_off",
            "Email is off in this environment, so nothing would be sent",
          );
        }
        const sent = await sendBalanceLink(trx, ctx, bookingId);
        switch (sent.kind) {
          case "enqueued":
            return { status: "accepted" as const, messageId: sent.messageId };
          case "not_found":
            throw notFound();
          case "nothing_owed":
            throw new ApiError(409, "nothing_owed", "Nothing is owed on this booking");
          case "imported_booking":
            throw new ApiError(
              409,
              "booking_imported",
              "This booking was imported from an earlier system, and its email waits until the import batch is released",
            );
          case "rate_limited":
            throw new ApiError(
              429,
              "balance_link_rate_limited",
              `The balance link went out ${sent.limit} times in the last hour; try later`,
            );
        }
      },
    );
    if (replayed) c.header("Idempotent-Replayed", "true");
    else deliverAfterCommit(c, deps, tenantId);
    return c.json(body as BalanceLinkAccepted, 202);
  });
}
