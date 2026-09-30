import { createRoute, type OpenAPIHono, z } from "@hono/zod-openapi";
import {
  CatalogResponse,
  GenerateTripsRequest,
  GenerateTripsResponse,
  IdempotencyKey,
  ProductParams,
  ProductResponse,
  PublishProductRequest,
  ScheduleParams,
  StaffTenantParams,
  StaffTripListResponse,
  StaffTripQuery,
  TripParams,
  TripResponse,
  TripSalesStateRequest,
} from "@tidegrid/contracts";
import { isUuid } from "@tidegrid/database";
import {
  changeTripSalesState,
  checkRange,
  generateTrips,
  listTrips,
  loadCatalog,
  publishProduct,
  type RangeProblem,
} from "@tidegrid/domain-catalog";
import type { AppDeps, AppEnv } from "../context.ts";
import { ApiError } from "../errors.ts";
import { withStaffTenant } from "../staff-tenant.ts";
import { errorBody, staffSecurity } from "./responses.ts";

const catalogPath = "/v1/staff/tenants/{tenantId}/catalog";
const tripsPath = "/v1/staff/tenants/{tenantId}/trips";
const generatePath = "/v1/staff/tenants/{tenantId}/schedules/{scheduleId}/trips";
const salesStatePath = "/v1/staff/tenants/{tenantId}/trips/{tripId}/sales-state";
const publishPath = "/v1/staff/tenants/{tenantId}/products/{productId}/publish";

const idempotencyHeader = z.object({ "idempotency-key": IdempotencyKey });

function rangeError(problem: RangeProblem): ApiError {
  return problem === "range_too_large"
    ? new ApiError(400, problem, "Ask for at most 93 days at a time")
    : new ApiError(400, problem, "The start date must be on or before the end date");
}

/** A malformed id answers like a missing one, so ids cannot be probed. */
function requireId(id: string, what: "trip" | "product" | "schedule"): string {
  if (!isUuid(id)) throw notFound(what);
  return id;
}

function notFound(what: "trip" | "product" | "schedule"): ApiError {
  return new ApiError(404, `${what}_not_found`, `No such ${what} for this tenant`);
}

export function registerCatalogStaffRoutes(app: OpenAPIHono<AppEnv>, deps: AppDeps) {
  const now = () => deps.now?.() ?? new Date();

  const catalogRoute = createRoute({
    method: "get",
    path: catalogPath,
    tags: ["staff", "catalog"],
    summary: "The tenant's locations, boats, products, and schedules",
    security: staffSecurity,
    request: { params: StaffTenantParams },
    responses: {
      200: { content: { "application/json": { schema: CatalogResponse } }, description: "Catalog" },
      401: errorBody("Not signed in"),
      403: errorBody("Role does not allow this"),
      404: errorBody("No such tenant for this account"),
    },
  });

  app.openapi(catalogRoute, async (c) => {
    const { tenantId } = c.req.valid("param");
    const { body } = await withStaffTenant(
      c,
      deps,
      { tenantId, permission: "catalog.read" },
      (trx) => loadCatalog(trx, tenantId),
    );
    return c.json(body, 200);
  });

  const tripsRoute = createRoute({
    method: "get",
    path: tripsPath,
    tags: ["staff", "catalog"],
    summary: "Every trip in a local date range, in any sales state",
    security: staffSecurity,
    request: { params: StaffTenantParams, query: StaffTripQuery },
    responses: {
      200: {
        content: { "application/json": { schema: StaffTripListResponse } },
        description: "Trips sorted by start",
      },
      400: errorBody("Invalid date range"),
      401: errorBody("Not signed in"),
      403: errorBody("Role does not allow this"),
      404: errorBody("No such tenant for this account"),
    },
  });

  app.openapi(tripsRoute, async (c) => {
    const { tenantId } = c.req.valid("param");
    const { from, to } = c.req.valid("query");
    const problem = checkRange(from, to);
    if (problem) throw rangeError(problem);
    const { body } = await withStaffTenant(
      c,
      deps,
      { tenantId, permission: "catalog.read" },
      async (trx) => ({ trips: await listTrips(trx, tenantId, { from, to }) }),
    );
    return c.json(body, 200);
  });

  const generateRoute = createRoute({
    method: "post",
    path: generatePath,
    tags: ["staff", "catalog"],
    summary: "Create a schedule's trips for a local date range",
    description:
      "Owner only. Existing departures are left as they are, including canceled ones. Departures in a spring-forward gap, in an unchosen fall-back overlap, or on a blackout are skipped and listed. Idempotent by key.",
    security: staffSecurity,
    request: {
      params: ScheduleParams,
      headers: idempotencyHeader,
      body: { required: true, content: { "application/json": { schema: GenerateTripsRequest } } },
    },
    responses: {
      200: {
        content: { "application/json": { schema: GenerateTripsResponse } },
        description: "Trips created, departures already scheduled, and departures skipped",
      },
      400: errorBody("Invalid date range"),
      401: errorBody("Not signed in"),
      403: errorBody("Role or origin does not allow this"),
      404: errorBody("No such tenant or schedule"),
      409: errorBody("The schedule is not active or its product is archived"),
      422: errorBody("Idempotency key reused with a different request"),
    },
  });

  app.openapi(generateRoute, async (c) => {
    const { tenantId, scheduleId } = c.req.valid("param");
    const input = c.req.valid("json");
    const key = c.req.valid("header")["idempotency-key"];
    const problem = checkRange(input.fromDate, input.toDate);
    if (problem) throw rangeError(problem);
    const result = await withStaffTenant(
      c,
      deps,
      {
        tenantId,
        permission: "catalog.manage",
        idempotency: {
          scope: "catalog.trips.generate",
          key,
          route: generatePath,
          params: { scheduleId },
          body: input,
          successStatus: 200,
        },
      },
      async (trx, ctx) => {
        const generated = await generateTrips(trx, ctx, {
          scheduleId: requireId(scheduleId, "schedule"),
          fromDate: input.fromDate,
          toDate: input.toDate,
          publish: input.publish,
          reason: input.reason,
        });
        switch (generated.kind) {
          case "generated":
            return {
              created: generated.created,
              alreadyScheduled: generated.alreadyScheduled,
              skipped: generated.skipped,
            };
          case "not_found":
            throw notFound("schedule");
          case "schedule_inactive":
            throw new ApiError(409, "schedule_inactive", "This schedule is paused or ended");
          case "product_archived":
            throw new ApiError(409, "product_archived", "This schedule's product is archived");
          case "range":
            throw rangeError(generated.problem);
        }
      },
    );
    if (result.replayed) c.header("Idempotent-Replayed", "true");
    if (result.status !== 200) throw new Error(`unexpected stored status ${result.status}`);
    return c.json(result.body, 200);
  });

  const salesStateRoute = createRoute({
    method: "post",
    path: salesStatePath,
    tags: ["staff", "catalog"],
    summary: "Publish, close, cancel, or complete a trip",
    description:
      "Owners and booking staff. Closing or canceling stops new sales without touching existing bookings. Canceled and completed are final; completion needs the trip to have departed. Idempotent by key.",
    security: staffSecurity,
    request: {
      params: TripParams,
      headers: idempotencyHeader,
      body: { required: true, content: { "application/json": { schema: TripSalesStateRequest } } },
    },
    responses: {
      200: { content: { "application/json": { schema: TripResponse } }, description: "The trip" },
      400: errorBody("Invalid request"),
      401: errorBody("Not signed in"),
      403: errorBody("Role or origin does not allow this"),
      404: errorBody("No such tenant or trip"),
      409: errorBody("The trip cannot move to that state now"),
      422: errorBody("Idempotency key reused with a different request"),
    },
  });

  app.openapi(salesStateRoute, async (c) => {
    const { tenantId, tripId } = c.req.valid("param");
    const input = c.req.valid("json");
    const key = c.req.valid("header")["idempotency-key"];
    const result = await withStaffTenant(
      c,
      deps,
      {
        tenantId,
        permission: "trips.manage",
        idempotency: {
          scope: "catalog.trips.sales_state",
          key,
          route: salesStatePath,
          params: { tripId },
          body: input,
          successStatus: 200,
        },
      },
      async (trx, ctx) => {
        const changed = await changeTripSalesState(trx, ctx, {
          tripId: requireId(tripId, "trip"),
          to: input.to,
          reason: input.reason,
          now: now(),
        });
        switch (changed.kind) {
          case "changed":
            return { trip: changed.trip };
          case "not_found":
            throw notFound("trip");
          case "conflict":
            throw new ApiError(
              409,
              "trip_state_conflict",
              `A ${changed.from} trip cannot become ${changed.to}`,
            );
          case "not_departed":
            throw new ApiError(409, "trip_not_departed", "A trip is completed after it departs");
        }
      },
    );
    if (result.replayed) c.header("Idempotent-Replayed", "true");
    if (result.status !== 200) throw new Error(`unexpected stored status ${result.status}`);
    return c.json(result.body, 200);
  });

  const publishRoute = createRoute({
    method: "post",
    path: publishPath,
    tags: ["staff", "catalog"],
    summary: "Publish a draft product",
    description:
      "Owner only. Blocked with a specific error code when the product could not be sold: product_archived, product_location_inactive, product_missing_eligible_boat, or product_party_exceeds_capacity. Publishing a published product changes nothing. Idempotent by key.",
    security: staffSecurity,
    request: {
      params: ProductParams,
      headers: idempotencyHeader,
      body: { required: true, content: { "application/json": { schema: PublishProductRequest } } },
    },
    responses: {
      200: {
        content: { "application/json": { schema: ProductResponse } },
        description: "The product",
      },
      401: errorBody("Not signed in"),
      403: errorBody("Role or origin does not allow this"),
      404: errorBody("No such tenant or product"),
      409: errorBody("Not publishable; the code names the first problem and the message lists all"),
      422: errorBody("Idempotency key reused with a different request"),
    },
  });

  app.openapi(publishRoute, async (c) => {
    const { tenantId, productId } = c.req.valid("param");
    const input = c.req.valid("json");
    const key = c.req.valid("header")["idempotency-key"];
    const result = await withStaffTenant(
      c,
      deps,
      {
        tenantId,
        permission: "catalog.manage",
        idempotency: {
          scope: "catalog.products.publish",
          key,
          route: publishPath,
          params: { productId },
          body: input,
          successStatus: 200,
        },
      },
      async (trx, ctx) => {
        const published = await publishProduct(trx, ctx, {
          productId: requireId(productId, "product"),
          reason: input.reason,
        });
        switch (published.kind) {
          case "published":
          case "unchanged":
            return { product: published.product };
          case "not_found":
            throw notFound("product");
          case "not_publishable": {
            const [first] = published.problems;
            throw new ApiError(
              409,
              first ?? "product_not_publishable",
              `This product cannot be published yet: ${published.problems.join(", ")}`,
            );
          }
        }
      },
    );
    if (result.replayed) c.header("Idempotent-Replayed", "true");
    if (result.status !== 200) throw new Error(`unexpected stored status ${result.status}`);
    return c.json(result.body, 200);
  });
}
