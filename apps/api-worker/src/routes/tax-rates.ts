import { createRoute, type OpenAPIHono, z } from "@hono/zod-openapi";
import {
  IdempotencyKey,
  StaffTenantParams,
  TaxRateChange,
  TaxRateInput,
  TaxRateResponse,
  TaxRatesResponse,
} from "@tidegrid/contracts";
import { isUuid, type TenantContext, type TenantTransaction } from "@tidegrid/database";
import {
  createTaxRate,
  createTaxRateVersion,
  getTaxRate,
  listTaxRates,
  type TermsProblem,
} from "@tidegrid/domain-pricing";
import type { AppDeps, AppEnv } from "../context.ts";
import { ApiError } from "../errors.ts";
import { withStaffTenant } from "../staff-tenant.ts";
import { errorBody, staffSecurity } from "./responses.ts";

export const taxRatesPath = "/v1/staff/tenants/{tenantId}/tax-rates";
export const taxRateVersionsPath = "/v1/staff/tenants/{tenantId}/tax-rates/{taxRateId}/versions";

const RateParams = StaffTenantParams.extend({
  taxRateId: z.string().describe("Tax rate UUID; anything else answers 404"),
});

const notFound = () => new ApiError(404, "tax_rate_not_found", "No such tax rate for this tenant");

/** A refusal from the pricing rules as an API error. */
function refused(problems: TermsProblem[]): never {
  if (problems.includes("invalid_location")) {
    throw new ApiError(
      422,
      "tax_rate_unknown_location",
      "The location is not one of this operator's locations",
    );
  }
  throw new ApiError(400, "validation_failed", `The tax rate was refused: ${problems.join(", ")}`);
}

async function saved(trx: TenantTransaction, ctx: TenantContext, taxRateId: string) {
  const taxRate = await getTaxRate(trx, ctx.tenantId, taxRateId);
  if (!taxRate) throw new Error("a saved tax rate was not found");
  return { taxRate };
}

const writeResponses = {
  400: errorBody("Request did not match the contract"),
  401: errorBody("Not signed in"),
  403: errorBody("Role does not allow this"),
  404: errorBody("No such tenant or tax rate"),
  422: errorBody(
    "The location is not this operator's (tax_rate_unknown_location), or idempotency_key_reused",
  ),
};

/**
 * Tax rates (W3-G2.5-TAX staff screens): owners add a rate and change it by
 * appending a version with a reason (catalog.manage); every role reads them
 * (catalog.read). A change never alters a quote already made.
 */
export function registerTaxRateRoutes(app: OpenAPIHono<AppEnv>, deps: AppDeps) {
  const listRoute = createRoute({
    method: "get",
    path: taxRatesPath,
    tags: ["staff", "catalog"],
    summary: "The operator's tax rates",
    security: staffSecurity,
    request: { params: StaffTenantParams },
    responses: {
      200: {
        content: { "application/json": { schema: TaxRatesResponse } },
        description: "Each rate as it is now: active ones by name, then retired ones",
      },
      401: writeResponses[401],
      403: writeResponses[403],
      404: errorBody("No such tenant for this account"),
    },
  });

  app.openapi(listRoute, async (c) => {
    const { tenantId } = c.req.valid("param");
    const { body } = await withStaffTenant(
      c,
      deps,
      { tenantId, permission: "catalog.read" },
      async (trx) => ({ taxRates: await listTaxRates(trx, tenantId) }),
    );
    return c.json(body, 200);
  });

  const createRateRoute = createRoute({
    method: "post",
    path: taxRatesPath,
    tags: ["staff", "catalog"],
    summary: "Add a tax rate",
    description:
      "Owners only. A name of up to 80 characters, a rate from 0.0001% to 50% in parts per million, whether prices include it, every location or one of the operator's locations, and a reason. New quotes use it at once. Idempotent by key.",
    security: staffSecurity,
    request: {
      params: StaffTenantParams,
      headers: z.object({ "idempotency-key": IdempotencyKey }),
      body: { required: true, content: { "application/json": { schema: TaxRateInput } } },
    },
    responses: {
      201: {
        content: { "application/json": { schema: TaxRateResponse } },
        description: "The new rate",
      },
      ...writeResponses,
    },
  });

  app.openapi(createRateRoute, async (c) => {
    const { tenantId } = c.req.valid("param");
    const key = c.req.valid("header")["idempotency-key"];
    const input = c.req.valid("json");
    const { body, replayed } = await withStaffTenant(
      c,
      deps,
      {
        tenantId,
        permission: "catalog.manage",
        idempotency: {
          scope: "staff.tax_rates.create",
          key,
          route: taxRatesPath,
          body: input,
          successStatus: 201,
        },
      },
      async (trx, ctx) => {
        const result = await createTaxRate(trx, ctx, input);
        if (result.kind === "invalid") refused(result.problems);
        return saved(trx, ctx, result.taxRateId);
      },
    );
    if (replayed) c.header("Idempotent-Replayed", "true");
    return c.json(body as TaxRateResponse, 201);
  });

  const versionRoute = createRoute({
    method: "post",
    path: taxRateVersionsPath,
    tags: ["staff", "catalog"],
    summary: "Change a tax rate",
    description:
      "Owners only. Restates the whole rate, with a reason, as its next version: its name, rate, whether prices include it, its location, and whether it is active (false retires it). New quotes use it at once; quotes already made keep the version they used. Idempotent by key.",
    security: staffSecurity,
    request: {
      params: RateParams,
      headers: z.object({ "idempotency-key": IdempotencyKey }),
      body: { required: true, content: { "application/json": { schema: TaxRateChange } } },
    },
    responses: {
      201: {
        content: { "application/json": { schema: TaxRateResponse } },
        description: "The rate as it is now",
      },
      ...writeResponses,
    },
  });

  app.openapi(versionRoute, async (c) => {
    const { tenantId, taxRateId } = c.req.valid("param");
    if (!isUuid(taxRateId)) throw notFound();
    const key = c.req.valid("header")["idempotency-key"];
    const input = c.req.valid("json");
    const { body, replayed } = await withStaffTenant(
      c,
      deps,
      {
        tenantId,
        permission: "catalog.manage",
        idempotency: {
          scope: "staff.tax_rates.version",
          key,
          route: taxRateVersionsPath,
          params: { taxRateId },
          body: input,
          successStatus: 201,
        },
      },
      async (trx, ctx) => {
        const result = await createTaxRateVersion(trx, ctx, { ...input, taxRateId });
        if (result.kind === "not_found") throw notFound();
        if (result.kind === "invalid") refused(result.problems);
        return saved(trx, ctx, taxRateId);
      },
    );
    if (replayed) c.header("Idempotent-Replayed", "true");
    return c.json(body as TaxRateResponse, 201);
  });
}
