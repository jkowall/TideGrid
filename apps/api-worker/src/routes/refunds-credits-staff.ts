import { createRoute, type OpenAPIHono, z } from "@hono/zod-openapi";
import {
  BookingParams,
  CreditAccountResponse,
  CreditAdjustRequest,
  IdempotencyKey,
  RefundExceptionsResponse,
  StaffCancellationPreviewResponse,
  StaffCancelRequest,
  StaffCancelResponse,
  StaffTenantParams,
} from "@tidegrid/contracts";
import { isUuid, type TenantContext } from "@tidegrid/database";
import {
  adjustCredit,
  type CancellationRecord,
  type CreditAccountView,
  CreditKeyReusedError,
  creditAccountForBooking,
  ensureCreditAccount,
  listRefundExceptions,
  previewStaffCancellation,
  settleRefund,
  staffCancelBooking,
} from "@tidegrid/domain-booking";
import { can } from "@tidegrid/domain-identity";
import { sql } from "kysely";
import { bookingHooksFor } from "../booking-hooks.ts";
import type { AppDeps, AppEnv } from "../context.ts";
import { getDb } from "../db.ts";
import { deliverAfterCommit } from "../email.ts";
import { ApiError } from "../errors.ts";
import { providerFor } from "../payments.ts";
import { withStaffTenant } from "../staff-tenant.ts";
import { errorBody, staffSecurity } from "./responses.ts";

const cancellationPath = "/v1/staff/tenants/{tenantId}/bookings/{bookingId}/cancellation";
const creditPath = "/v1/staff/tenants/{tenantId}/bookings/{bookingId}/credit";
const adjustPath = "/v1/staff/tenants/{tenantId}/bookings/{bookingId}/credit/adjustments";
const exceptionsPath = "/v1/staff/tenants/{tenantId}/refund-exceptions";

const notFound = () => new ApiError(404, "booking_not_found", "No such booking for this tenant");

function cancellationJson(c: CancellationRecord) {
  return {
    canceledAt: c.canceledAt,
    by: c.by,
    remedy: c.remedy,
    refundBp: c.refundBp,
    refundAmount: c.refundAmount,
    creditAmount: c.creditAmount,
    overridden: c.overridden,
    paidAmount: c.paidAmount,
    cutoffAt: c.cutoffAt,
    beforeCutoff: c.beforeCutoff,
    policyVersion: c.policyVersion,
  };
}

function accountJson(account: CreditAccountView | null) {
  return {
    account: account
      ? {
          id: account.id,
          balance: account.balance,
          currency: account.currency,
          entries: account.entries.map((e) => ({
            id: e.id,
            kind: e.kind,
            amount: e.amount,
            balanceAfter: e.balanceAfter,
            bookingId: e.bookingId,
            reason: e.reason,
            by: e.by,
            createdAt: e.createdAt,
          })),
        }
      : null,
  };
}

/**
 * Staff cancellation with the credit alternative, booking credit, and refund
 * exceptions (W3-G2.9). Another tenant's booking, an unknown id, and a
 * malformed one answer the same 404.
 */
export function registerRefundsCreditsStaffRoutes(app: OpenAPIHono<AppEnv>, deps: AppDeps) {
  for (const path of [
    "/v1/staff/tenants/:tenantId/bookings/:bookingId/cancellation",
    "/v1/staff/tenants/:tenantId/bookings/:bookingId/credit",
    "/v1/staff/tenants/:tenantId/bookings/:bookingId/credit/adjustments",
    "/v1/staff/tenants/:tenantId/refund-exceptions",
  ]) {
    app.use(path, async (c, next) => {
      c.header("Cache-Control", "no-store");
      await next();
      c.header("Cache-Control", "no-store");
    });
  }

  const previewRoute = createRoute({
    method: "get",
    path: cancellationPath,
    tags: ["staff", "bookings"],
    summary: "What staff canceling this booking now would do",
    description: [
      "Owners and booking staff (bookings.cancel). The policy's terms now, its value, the refund with the TideGrid fee it would reverse, and the booking credit alternative with the booker's resulting balance. Read-only; show it before confirming.",
      "Order: authentication (401), membership (404), permission (403), then the booking (404).",
    ].join("\n\n"),
    security: staffSecurity,
    request: { params: BookingParams },
    responses: {
      200: {
        content: { "application/json": { schema: StaffCancellationPreviewResponse } },
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
      { tenantId, permission: "bookings.cancel" },
      async (trx) => {
        const preview = await previewStaffCancellation(trx, tenantId, bookingId);
        if (!preview) throw notFound();
        return { preview: JSON.parse(JSON.stringify(preview)) };
      },
    );
    return c.json(body as StaffCancellationPreviewResponse, 200);
  });

  const cancelRoute = createRoute({
    method: "post",
    path: cancellationPath,
    tags: ["staff", "bookings"],
    summary: "Cancel a confirmed booking",
    description: [
      "Owners and booking staff (bookings.cancel). One transaction: the cancellation with its terms, the booking canceled, the seats released, the refund requested or the booking credit issued to the booker, and the cancellation email queued. A refund is then sent through the payment provider; its state comes back in refund.",
      "choice.kind policy applies the policy's own remedy; credit applies the policy's value as booking credit instead; override applies any remedy at any basis points with a reason, and needs bookings.override (owners).",
      "Once per booking: a repeat, with any key, answers 200 with the first cancellation. If canceling now gives another value than expectedAmount, nothing changes and the answer is 409 cancellation_terms_changed. Idempotent by key.",
    ].join("\n\n"),
    security: staffSecurity,
    request: {
      params: BookingParams,
      headers: z.object({ "idempotency-key": IdempotencyKey }),
      body: { required: true, content: { "application/json": { schema: StaffCancelRequest } } },
    },
    responses: {
      200: {
        content: { "application/json": { schema: StaffCancelResponse } },
        description: "The canceled booking's terms and refund",
      },
      400: errorBody(
        "Request did not match the contract, or an override's remedy and basis points do not fit (override_invalid)",
      ),
      401: errorBody("Not signed in"),
      403: errorBody("Role does not allow this (an override needs bookings.override)"),
      404: errorBody("No such tenant or booking (booking_not_found)"),
      409: errorBody(
        "The terms changed (cancellation_terms_changed), the trip has departed (trip_departed), or the policy gives nothing to credit (nothing_to_credit)",
      ),
      422: errorBody("idempotency_key_reused"),
    },
  });

  app.openapi(cancelRoute, async (c) => {
    const { tenantId, bookingId } = c.req.valid("param");
    const key = c.req.valid("header")["idempotency-key"];
    const input = c.req.valid("json");
    let refundId: string | null = null;
    const answer = await withStaffTenant(
      c,
      deps,
      {
        tenantId,
        permission: "bookings.cancel",
        idempotency: {
          scope: "bookings.staff_cancel",
          key,
          route: cancellationPath,
          params: { bookingId },
          body: input,
          successStatus: 200,
        },
      },
      async (trx, ctx) => {
        if (input.choice.kind === "override" && !can(ctx.access.role, "bookings.override")) {
          throw new ApiError(403, "forbidden", "Only an owner overrides a booking's policy");
        }
        if (!isUuid(bookingId)) throw notFound();
        const canceled = await staffCancelBooking(
          trx,
          ctx,
          { bookingId, choice: input.choice, expectedAmount: input.expectedAmount },
          bookingHooksFor(c.env, deps),
        );
        switch (canceled.kind) {
          case "canceled":
            refundId = canceled.cancellation.refundId;
            return { cancellation: cancellationJson(canceled.cancellation) };
          case "already_canceled":
            return { cancellation: cancellationJson(canceled.cancellation) };
          case "not_found":
            throw notFound();
          case "trip_departed":
            throw new ApiError(409, "trip_departed", "This trip has departed");
          case "remedy_requires_operator":
            throw new Error("staff are the operator");
          case "terms_changed":
            throw new ApiError(
              409,
              "cancellation_terms_changed",
              "Canceling now gives another amount; read the preview again",
            );
          case "nothing_to_credit":
            throw new ApiError(
              409,
              "nothing_to_credit",
              "The policy gives nothing here, so there is no value to credit; an owner can override it with a reason",
            );
          case "override_invalid":
            throw new ApiError(400, "override_invalid", canceled.message);
        }
      },
    );
    if (answer.replayed) c.header("Idempotent-Replayed", "true");
    const ctx: TenantContext = answer.ctx;
    // Committed. Send the refund now, outside any transaction; an unknown
    // outcome stays for the checkout sweep, which resends it with its key.
    const id = refundId as string | null;
    if (id) {
      const provider = providerFor(c, deps);
      if (provider) {
        try {
          await settleRefund(getDb(c), provider, ctx, id);
        } catch {
          c.get("log").warn("cancellation_refund_pending", {
            "event.name": "cancellation_refund_pending",
            "tidegrid.tenant_id": ctx.tenantId,
          });
        }
      }
    }
    if (!answer.replayed) deliverAfterCommit(c, deps, ctx.tenantId);
    const { body: refund } = await withStaffTenant(
      c,
      deps,
      { tenantId, permission: "bookings.cancel" },
      async (trx) => {
        const { rows } = await sql<{ state: string; amount: number }>`
          select r.state, r.amount from bookings b
            join payment_refunds r on r.tenant_id = b.tenant_id and r.payment_id = b.payment_id
           where b.tenant_id = ${tenantId} and b.id = ${bookingId}`.execute(trx);
        return { refund: rows[0] ?? null };
      },
    );
    return c.json({ ...answer.body, ...refund } as StaffCancelResponse, 200);
  });

  const creditRoute = createRoute({
    method: "get",
    path: creditPath,
    tags: ["staff", "bookings"],
    summary: "The booker's booking credit",
    description:
      "Owners and booking staff (bookings.read). The credit balance and whole ledger of the customer who made this booking, under the email they booked with; null when they have never had credit. Never expires during the pilot.",
    security: staffSecurity,
    request: { params: BookingParams },
    responses: {
      200: {
        content: { "application/json": { schema: CreditAccountResponse } },
        description: "The account",
      },
      401: errorBody("Not signed in"),
      403: errorBody("Role does not allow this"),
      404: errorBody("No such tenant or booking (booking_not_found)"),
    },
  });

  app.openapi(creditRoute, async (c) => {
    const { tenantId, bookingId } = c.req.valid("param");
    const { body } = await withStaffTenant(
      c,
      deps,
      { tenantId, permission: "bookings.read" },
      async (trx) => {
        if (!isUuid(bookingId)) throw notFound();
        const found = await trx
          .selectFrom("bookings")
          .select("id")
          .where("tenant_id", "=", tenantId)
          .where("id", "=", bookingId)
          .executeTakeFirst();
        if (!found) throw notFound();
        return accountJson(await creditAccountForBooking(trx, tenantId, bookingId));
      },
    );
    return c.json(body as CreditAccountResponse, 200);
  });

  const adjustRoute = createRoute({
    method: "post",
    path: adjustPath,
    tags: ["staff", "bookings"],
    summary: "Adjust the booker's booking credit",
    description: [
      "Owners (credits.adjust). Adds to or takes from the booker's credit balance, with a reason kept on the ledger and in the audit history. The balance never goes below zero: a larger decrease answers 409 credit_insufficient. Idempotent by key.",
    ].join("\n\n"),
    security: staffSecurity,
    request: {
      params: BookingParams,
      headers: z.object({ "idempotency-key": IdempotencyKey }),
      body: { required: true, content: { "application/json": { schema: CreditAdjustRequest } } },
    },
    responses: {
      200: {
        content: { "application/json": { schema: CreditAccountResponse } },
        description: "The account after the adjustment",
      },
      400: errorBody("Request did not match the contract"),
      401: errorBody("Not signed in"),
      403: errorBody("Role does not allow this"),
      404: errorBody("No such tenant or booking (booking_not_found)"),
      409: errorBody("The balance is smaller than the decrease (credit_insufficient)"),
      422: errorBody("idempotency_key_reused"),
    },
  });

  app.openapi(adjustRoute, async (c) => {
    const { tenantId, bookingId } = c.req.valid("param");
    const key = c.req.valid("header")["idempotency-key"];
    const input = c.req.valid("json");
    const { body, replayed } = await withStaffTenant(
      c,
      deps,
      {
        tenantId,
        permission: "credits.adjust",
        idempotency: {
          scope: "credits.adjust",
          key,
          route: adjustPath,
          params: { bookingId },
          body: input,
          successStatus: 200,
        },
      },
      async (trx, ctx) => {
        if (!isUuid(bookingId)) throw notFound();
        const { rows } = await sql<{ booker_email: string }>`
          select s.booker_email from bookings b
            join checkout_sessions s on s.tenant_id = b.tenant_id and s.id = b.checkout_session_id
           where b.tenant_id = ${tenantId} and b.id = ${bookingId}`.execute(trx);
        const email = rows[0]?.booker_email;
        if (!email) throw notFound();
        const accountId = await ensureCreditAccount(trx, ctx, email);
        try {
          const adjusted = await adjustCredit(trx, ctx, {
            accountId,
            amount: input.amount,
            reason: input.reason,
            idempotencyKey: `credit_adjust:${ctx.actorId}:${key}`,
          });
          if (adjusted.kind === "insufficient") {
            throw new ApiError(
              409,
              "credit_insufficient",
              `The balance is ${adjusted.balance} cents; it cannot go below zero`,
            );
          }
          if (adjusted.kind === "not_found") throw notFound();
        } catch (error) {
          if (error instanceof CreditKeyReusedError) {
            throw new ApiError(422, "idempotency_key_reused", error.message);
          }
          throw error;
        }
        return accountJson(await creditAccountForBooking(trx, tenantId, bookingId));
      },
    );
    if (replayed) c.header("Idempotent-Replayed", "true");
    return c.json(body as CreditAccountResponse, 200);
  });

  const exceptionsRoute = createRoute({
    method: "get",
    path: exceptionsPath,
    tags: ["staff", "bookings"],
    summary: "Refunds that need a person",
    description: [
      "Every role that reads payments (payments.read). The operator's refund exceptions, newest first, at most 100: a refund with no final answer 24 hours after it was requested, one whose lookup the provider keeps refusing, or one the provider reported failed after it had succeeded. Each says whether it is still open, its refund, its booking, and what to do next. Nothing of the provider's own refund object.",
    ].join("\n\n"),
    security: staffSecurity,
    request: { params: StaffTenantParams },
    responses: {
      200: {
        content: { "application/json": { schema: RefundExceptionsResponse } },
        description: "The exceptions",
      },
      401: errorBody("Not signed in"),
      403: errorBody("Role does not allow this"),
      404: errorBody("No such tenant"),
    },
  });

  app.openapi(exceptionsRoute, async (c) => {
    const { tenantId } = c.req.valid("param");
    const { body } = await withStaffTenant(
      c,
      deps,
      { tenantId, permission: "payments.read", snapshot: true },
      async (trx) => ({
        exceptions: JSON.parse(JSON.stringify(await listRefundExceptions(trx, tenantId, 100))),
      }),
    );
    return c.json(body as RefundExceptionsResponse, 200);
  });
}
