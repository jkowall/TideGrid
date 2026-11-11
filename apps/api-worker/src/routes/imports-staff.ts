import { createRoute, type OpenAPIHono, z } from "@hono/zod-openapi";
import {
  IdempotencyKey,
  ImportDryRunRequest,
  ImportDryRunResponse,
  MAX_IMPORT_ISSUES_LISTED,
  StaffTenantParams,
} from "@tidegrid/contracts";
import { renderImportErrors, runImportDryRun } from "@tidegrid/domain-booking";
import type { AppDeps, AppEnv } from "../context.ts";
import { ApiError } from "../errors.ts";
import { withStaffTenant } from "../staff-tenant.ts";
import { errorBody, staffSecurity } from "./responses.ts";

export const importDryRunsPath = "/v1/staff/tenants/{tenantId}/import-dry-runs";

/** JSON-safe copy: the result holds only strings, numbers, booleans, and nulls. */
const plain = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

/**
 * The standard CSV import (W3-G2.13), part 1: the dry run. Owners only
 * (imports.run). Nothing from the files is written; the run's counts and
 * totals are recorded, so a later commit step can require a clean dry run of
 * the same files.
 */
export function registerImportStaffRoutes(app: OpenAPIHono<AppEnv>, deps: AppDeps) {
  app.use("/v1/staff/tenants/:tenantId/import-dry-runs", async (c, next) => {
    c.header("Cache-Control", "no-store");
    await next();
    c.header("Cache-Control", "no-store");
  });

  const dryRunRoute = createRoute({
    method: "post",
    path: importDryRunsPath,
    tags: ["staff", "imports"],
    summary: "Check a standard CSV import batch without importing it",
    description: [
      "Owners only (imports.run). The batch is the manifest and the files it declares totals for, as the standard CSV import draft defines them (coordinator default, pending the owner's approval). Every row is checked against the operator's products, boats, trips, and capacity at the time of the check; nothing from the files is written.",
      "The answer lists the issues (the first 500) and the full errors.csv, the accepted and refused rows per file, and each declared control total beside the computed one. A run is clean when no row is refused and every total matches. The run's counts and totals are recorded under its batch and run number; a run number already used is refused (409 import_run_number_used). Committing a batch is a later step. Idempotent by key.",
    ].join("\n\n"),
    security: staffSecurity,
    request: {
      params: StaffTenantParams,
      headers: z.object({ "idempotency-key": IdempotencyKey }),
      body: {
        required: true,
        content: { "application/json": { schema: ImportDryRunRequest } },
      },
    },
    responses: {
      200: {
        content: { "application/json": { schema: ImportDryRunResponse } },
        description: "The dry run's result",
      },
      400: errorBody("Request did not match the contract"),
      401: errorBody("Not signed in"),
      403: errorBody("Role does not allow this"),
      404: errorBody("No such tenant"),
      409: errorBody(
        "The batch already has this run number (import_run_number_used), or its earlier runs name another source system (import_source_changed)",
      ),
      422: errorBody("idempotency_key_reused"),
    },
  });

  app.openapi(dryRunRoute, async (c) => {
    const { tenantId } = c.req.valid("param");
    const key = c.req.valid("header")["idempotency-key"];
    const input = c.req.valid("json");
    const { body, replayed } = await withStaffTenant(
      c,
      deps,
      {
        tenantId,
        permission: "imports.run",
        idempotency: {
          scope: "staff.import_dry_runs.create",
          key,
          route: importDryRunsPath,
          params: {},
          body: input,
          successStatus: 200,
        },
      },
      async (trx, ctx) => {
        const checked = await runImportDryRun(trx, ctx, input.files);
        if (checked.kind === "run_number_used") {
          throw new ApiError(
            409,
            "import_run_number_used",
            `Batch ${checked.batchId} already has run ${checked.runNumber}; use the next run number`,
          );
        }
        if (checked.kind === "source_changed") {
          throw new ApiError(
            409,
            "import_source_changed",
            `Batch ${checked.batchId} was run before from another source system`,
          );
        }
        const r = checked.result;
        const response: ImportDryRunResponse = {
          run: {
            id: checked.runId,
            batchId: r.manifest?.batchId ?? null,
            runNumber: r.manifest?.runNumber ?? null,
            sourceSystem: r.manifest?.sourceSystem ?? null,
            contentHash: checked.contentHash,
            checkedAt: checked.checkedAt,
            clean: r.clean,
            errorCount: r.errorCount,
            warningCount: r.warningCount,
            files: r.files,
            controls: r.controls,
            issues: r.issues.slice(0, MAX_IMPORT_ISSUES_LISTED),
            issuesTruncated: r.issues.length > MAX_IMPORT_ISSUES_LISTED,
          },
          errorsCsv: renderImportErrors(r),
        };
        return plain(response);
      },
    );
    if (replayed) c.header("Idempotent-Replayed", "true");
    return c.json(body as ImportDryRunResponse, 200);
  });
}
