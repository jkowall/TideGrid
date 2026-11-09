import { createRoute, type OpenAPIHono, z } from "@hono/zod-openapi";
import {
  BookingParams,
  ExternalSettlementRequest,
  ExternalSettlementResponse,
  ExternalSettlementsResponse,
  FeeInvoicesResponse,
  IdempotencyKey,
  PaymentDisputesResponse,
  PaymentReconciliationExceptionsResponse,
  ReconciliationQuery,
  ReconciliationReportResponse,
  StaffTenantParams,
} from "@tidegrid/contracts";
import { isUuid } from "@tidegrid/database";
import {
  listDisputes,
  listExternalSettlements,
  listFeeInvoices,
  listPaymentReconciliationExceptions,
  reconciliationReport,
  recordExternalSettlement,
} from "@tidegrid/domain-booking";
import type { AppDeps, AppEnv } from "../context.ts";
import { ApiError } from "../errors.ts";
import { withStaffTenant } from "../staff-tenant.ts";
import { errorBody, staffSecurity } from "./responses.ts";

const settlementsPath = "/v1/staff/tenants/{tenantId}/bookings/{bookingId}/external-settlements";
const disputesPath = "/v1/staff/tenants/{tenantId}/disputes";
const paymentExceptionsPath = "/v1/staff/tenants/{tenantId}/payment-reconciliation-exceptions";
const reportPath = "/v1/staff/tenants/{tenantId}/reconciliation";
const invoicesPath = "/v1/staff/tenants/{tenantId}/fee-invoices";

const notFound = () => new ApiError(404, "booking_not_found", "No such booking for this tenant");

/** JSON-safe copy: the domain's views hold only strings, numbers, booleans, and nulls. */
const plain = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

/**
 * External payment and reconciliation (W3-G2.10). Another tenant's booking,
 * an unknown id, and a malformed one answer the same 404. Every read runs in
 * one snapshot, so its figures describe one moment.
 */
export function registerReconciliationStaffRoutes(app: OpenAPIHono<AppEnv>, deps: AppDeps) {
  for (const path of [
    "/v1/staff/tenants/:tenantId/bookings/:bookingId/external-settlements",
    "/v1/staff/tenants/:tenantId/disputes",
    "/v1/staff/tenants/:tenantId/payment-reconciliation-exceptions",
    "/v1/staff/tenants/:tenantId/reconciliation",
    "/v1/staff/tenants/:tenantId/fee-invoices",
  ]) {
    app.use(path, async (c, next) => {
      c.header("Cache-Control", "no-store");
      await next();
      c.header("Cache-Control", "no-store");
    });
  }

  const listSettlementsRoute = createRoute({
    method: "get",
    path: settlementsPath,
    tags: ["staff", "bookings"],
    summary: "Money recorded outside the card flow for this booking",
    description:
      "Every role that reads payments (payments.read). Cash, check, and other tender recorded against the booking, oldest first, and what a refund may still return.",
    security: staffSecurity,
    request: { params: BookingParams },
    responses: {
      200: {
        content: { "application/json": { schema: ExternalSettlementsResponse } },
        description: "The booking's external settlements",
      },
      401: errorBody("Not signed in"),
      403: errorBody("Role does not allow this"),
      404: errorBody("No such tenant or booking (booking_not_found)"),
    },
  });

  app.openapi(listSettlementsRoute, async (c) => {
    const { tenantId, bookingId } = c.req.valid("param");
    const { body } = await withStaffTenant(
      c,
      deps,
      { tenantId, permission: "payments.read", snapshot: true },
      async (trx) => {
        if (!isUuid(bookingId)) throw notFound();
        const listed = await listExternalSettlements(trx, tenantId, bookingId);
        if (!listed) throw notFound();
        return plain(listed);
      },
    );
    return c.json(body as ExternalSettlementsResponse, 200);
  });

  const recordRoute = createRoute({
    method: "post",
    path: settlementsPath,
    tags: ["staff", "bookings"],
    summary: "Record cash, check, or other tender against this booking",
    description: [
      "A payment: owners and booking staff (payments.record). A refund: owners only (payments.refund_external). Recorded with a reason, kept with the record and in the audit history. Changes no card payment and moves no money: it records money that already changed hands.",
      "A refund returns at most the money that came in and at most what the booking cost, less refunds so far (409 external_refund_too_large), and reverses TideGrid's fee on its eligible share. Idempotent by key.",
    ].join("\n\n"),
    security: staffSecurity,
    request: {
      params: BookingParams,
      headers: z.object({ "idempotency-key": IdempotencyKey }),
      body: {
        required: true,
        content: { "application/json": { schema: ExternalSettlementRequest } },
      },
    },
    responses: {
      200: {
        content: { "application/json": { schema: ExternalSettlementResponse } },
        description: "The record",
      },
      400: errorBody("Request did not match the contract"),
      401: errorBody("Not signed in"),
      403: errorBody("Role does not allow this"),
      404: errorBody("No such tenant or booking (booking_not_found)"),
      409: errorBody("The refund is larger than allowed (external_refund_too_large)"),
      422: errorBody("idempotency_key_reused"),
    },
  });

  app.openapi(recordRoute, async (c) => {
    const { tenantId, bookingId } = c.req.valid("param");
    const key = c.req.valid("header")["idempotency-key"];
    const input = c.req.valid("json");
    const permission = input.kind === "refund" ? "payments.refund_external" : "payments.record";
    const { body, replayed } = await withStaffTenant(
      c,
      deps,
      {
        tenantId,
        permission,
        idempotency: {
          scope: "payments.external",
          key,
          route: settlementsPath,
          params: { bookingId },
          body: input,
          successStatus: 200,
        },
      },
      async (trx, ctx) => {
        if (!isUuid(bookingId)) throw notFound();
        const recorded = await recordExternalSettlement(trx, ctx, {
          bookingId,
          kind: input.kind,
          tender: input.tender,
          amount: input.amount,
          reason: input.reason,
          tenderReference: input.tenderReference ?? null,
          // The client's key may hold characters or a length the record's key
          // refuses, so the record takes a digest of the actor and the key.
          idempotencyKey: `external:${await sha256Hex(`${ctx.actorId}:${key}`)}`,
        });
        if (recorded.kind === "not_found") throw notFound();
        if (recorded.kind === "key_reused") {
          throw new ApiError(422, "idempotency_key_reused", "This key was used for another record");
        }
        if (recorded.kind === "refund_too_large") {
          throw new ApiError(
            409,
            "external_refund_too_large",
            `A refund may return at most ${recorded.refundable} cents now`,
          );
        }
        const listed = await listExternalSettlements(trx, tenantId, bookingId);
        return plain({ settlement: recorded.settlement, refundable: listed?.refundable ?? 0 });
      },
    );
    if (replayed) c.header("Idempotent-Replayed", "true");
    return c.json(body as ExternalSettlementResponse, 200);
  });

  const disputesRoute = createRoute({
    method: "get",
    path: disputesPath,
    tags: ["staff", "bookings"],
    summary: "Card payments the cardholder disputed",
    description:
      "Every role that reads payments (payments.read). Disputes (chargebacks) the payment provider reported through its verified events, newest first, at most 100: status, amount, the network's reason code, the payment, and its booking. An open dispute needs the operator's answer in the provider's own dashboard; TideGrid shows it and changes nothing.",
    security: staffSecurity,
    request: { params: StaffTenantParams },
    responses: {
      200: {
        content: { "application/json": { schema: PaymentDisputesResponse } },
        description: "The disputes",
      },
      401: errorBody("Not signed in"),
      403: errorBody("Role does not allow this"),
      404: errorBody("No such tenant"),
    },
  });

  app.openapi(disputesRoute, async (c) => {
    const { tenantId } = c.req.valid("param");
    const { body } = await withStaffTenant(
      c,
      deps,
      { tenantId, permission: "payments.read", snapshot: true },
      async (trx) => ({ disputes: plain(await listDisputes(trx, tenantId, 100)) }),
    );
    return c.json(body as PaymentDisputesResponse, 200);
  });

  const paymentExceptionsRoute = createRoute({
    method: "get",
    path: paymentExceptionsPath,
    tags: ["staff", "bookings"],
    summary: "Pending payments the provider disagrees about",
    description:
      "Every role that reads payments (payments.read). A payment still pending past its checkout's hold is looked up at the provider about once an hour for 7 days. When the provider says it was paid, will never be paid, does not exist, or has another amount, the reading is listed here once, newest first, at most 100. Nothing is changed by a reading: a booking confirms, and a payment fails, only from the provider's verified event.",
    security: staffSecurity,
    request: { params: StaffTenantParams },
    responses: {
      200: {
        content: {
          "application/json": { schema: PaymentReconciliationExceptionsResponse },
        },
        description: "The readings",
      },
      401: errorBody("Not signed in"),
      403: errorBody("Role does not allow this"),
      404: errorBody("No such tenant"),
    },
  });

  app.openapi(paymentExceptionsRoute, async (c) => {
    const { tenantId } = c.req.valid("param");
    const { body } = await withStaffTenant(
      c,
      deps,
      { tenantId, permission: "payments.read", snapshot: true },
      async (trx) => ({
        exceptions: plain(await listPaymentReconciliationExceptions(trx, tenantId, 100)),
      }),
    );
    return c.json(body as PaymentReconciliationExceptionsResponse, 200);
  });

  const reportRoute = createRoute({
    method: "get",
    path: reportPath,
    tags: ["staff", "bookings"],
    summary: "The month's reconciliation",
    description: [
      "Owners, finance, and support (fees.read). Every booking with fee or external-money activity in the month: eligible value assessed when it closed, eligible value refunded, money recorded outside the card flow, and TideGrid's fee entries. Then the totals, the fee ledgers' own total as the control total, and whether they match.",
      "Also the share of the closed bookings' value received by card or recorded externally, against the 98% target in the commercial model.",
    ].join("\n\n"),
    security: staffSecurity,
    request: { params: StaffTenantParams, query: ReconciliationQuery },
    responses: {
      200: {
        content: { "application/json": { schema: ReconciliationReportResponse } },
        description: "The reconciliation",
      },
      400: errorBody("Request did not match the contract"),
      401: errorBody("Not signed in"),
      403: errorBody("Role does not allow this"),
      404: errorBody("No such tenant"),
    },
  });

  app.openapi(reportRoute, async (c) => {
    const { tenantId } = c.req.valid("param");
    const { month } = c.req.valid("query");
    const { body } = await withStaffTenant(
      c,
      deps,
      { tenantId, permission: "fees.read", snapshot: true },
      async (trx) => ({ ...plain(await reconciliationReport(trx, tenantId, month)) }),
    );
    return c.json(body as ReconciliationReportResponse, 200);
  });

  const invoicesRoute = createRoute({
    method: "get",
    path: invoicesPath,
    tags: ["staff"],
    summary: "TideGrid's fee invoices to this operator",
    description:
      "Owners, finance, and support (fees.read). One draft per billing month, newest first: the subscription, the month's variable fee from the fee ledgers, a negative balance carried forward against later variable fees only, and the annual-minimum true-up in the 12th month of each contract year. Drafts only: sending waits on TideGrid's billing tool.",
    security: staffSecurity,
    request: { params: StaffTenantParams },
    responses: {
      200: {
        content: { "application/json": { schema: FeeInvoicesResponse } },
        description: "The invoices",
      },
      401: errorBody("Not signed in"),
      403: errorBody("Role does not allow this"),
      404: errorBody("No such tenant"),
    },
  });

  app.openapi(invoicesRoute, async (c) => {
    const { tenantId } = c.req.valid("param");
    const { body } = await withStaffTenant(
      c,
      deps,
      { tenantId, permission: "fees.read", snapshot: true },
      async (trx) => ({ invoices: plain(await listFeeInvoices(trx, tenantId)) }),
    );
    return c.json(body as FeeInvoicesResponse, 200);
  });
}

async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}
