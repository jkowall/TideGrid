import { createRoute, type OpenAPIHono, z } from "@hono/zod-openapi";
import {
  IdempotencyKey,
  ImportCommitRequest,
  ImportCommitResponse,
  ImportDryRunRequest,
  ImportDryRunResponse,
  ImportRunParams,
  ImportWaiverEmailResponse,
  MAX_IMPORT_ISSUES_LISTED,
  StaffTenantParams,
} from "@tidegrid/contracts";
import {
  type ImportCommitResult,
  renderImportErrors,
  runImportCommit,
  runImportDryRun,
} from "@tidegrid/domain-booking";
import { releaseImportWaiverEmail } from "@tidegrid/domain-waivers";
import type { AppDeps, AppEnv } from "../context.ts";
import { ApiError } from "../errors.ts";
import { withStaffTenant } from "../staff-tenant.ts";
import { errorBody, staffSecurity } from "./responses.ts";

export const importDryRunsPath = "/v1/staff/tenants/{tenantId}/import-dry-runs";
export const importCommitsPath = "/v1/staff/tenants/{tenantId}/import-commits";
export const importWaiverEmailPath =
  "/v1/staff/tenants/{tenantId}/import-runs/{runId}/waiver-email";

/** JSON-safe copy: the result holds only strings, numbers, booleans, and nulls. */
const plain = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

/**
 * The standard CSV import, part 1 of W3-G2.13: the dry run. Owners only
 * (imports.run). Nothing from the files is written; the run's counts and
 * totals are recorded, so a later commit step can require a clean dry run of
 * the same files.
 */
export function registerImportStaffRoutes(app: OpenAPIHono<AppEnv>, deps: AppDeps) {
  for (const path of [
    "/v1/staff/tenants/:tenantId/import-dry-runs",
    "/v1/staff/tenants/:tenantId/import-commits",
    "/v1/staff/tenants/:tenantId/import-runs/:runId/waiver-email",
  ]) {
    app.use(path, async (c, next) => {
      c.header("Cache-Control", "no-store");
      await next();
      c.header("Cache-Control", "no-store");
    });
  }

  const dryRunRoute = createRoute({
    method: "post",
    path: importDryRunsPath,
    tags: ["staff", "imports"],
    summary: "Check a standard CSV import batch without importing it",
    description: [
      "Owners only (imports.run). The batch is the manifest and the files it declares totals for, as the standard CSV import draft defines them (coordinator default, pending the owner's approval). Every row is checked against the operator's products, boats, trips, and capacity at the time of the check; nothing from the files is written.",
      "The answer lists the issues (the first 500) and the full errors.csv, the accepted and refused rows per file, and each declared control total beside the computed one. A run is clean when no row is refused and every total matches. The run's counts and totals are recorded under its batch and run number; run numbers start at 1 and go up by one, so a used or skipped number is refused (409 import_run_number_used). Committing a batch is a later step. Idempotent by key.",
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
        "The run number is not the batch's next one (import_run_number_used), or its earlier runs name another source system (import_source_changed)",
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
            `Batch ${checked.batchId} cannot take run ${checked.runNumber}; its next run number is ${checked.expected}`,
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
            issuesTruncated: r.issuesCapped || r.issues.length > MAX_IMPORT_ISSUES_LISTED,
          },
          errorsCsv: renderImportErrors(r),
        };
        return plain(response);
      },
    );
    if (replayed) c.header("Idempotent-Replayed", "true");
    return c.json(body as ImportDryRunResponse, 200);
  });

  const commitRoute = createRoute({
    method: "post",
    path: importCommitsPath,
    tags: ["staff", "imports"],
    summary: "Save a standard CSV import batch",
    description: [
      "Owners only (imports.run). The batch must follow its latest run, a clean dry run of the same files (the content hash leaves out the manifest's batch_mode and run_number), with batch_mode commit and the next run number. The files are checked again against TideGrid as it is now; a clean result is saved all or nothing: future trips (new departures in draft), customers, bookings with their participants, and legacy payments and refunds, labeled as imported and taken outside TideGrid. Rows imported before with the same values are left as they are; changed ones are refused. Private charters may carry a balance due before their trip; booking credit goes on the customer's credit account; legacy waiver status is kept for staff to read, as information only. Saving sends no email and calls no provider. Waiver email follows afterwards: the cron sends the batch's guests their waiver requests a few bookings at a time, under an hourly cap per operator, right away for a batch saved with waiver_notifications send_at_cutover, and once an owner releases it (POST .../import-runs/{runId}/waiver-email) for one saved with hold_until_staff_release. The booking's own emails are not sent for imported bookings.",
      "A commit that no longer passes its checks, or meets a change in TideGrid while saving, saves nothing and answers 200 with committed false; it is recorded, so the next try needs a fresh dry run. Idempotent by key.",
    ].join("\n\n"),
    security: staffSecurity,
    request: {
      params: StaffTenantParams,
      headers: z.object({ "idempotency-key": IdempotencyKey }),
      body: {
        required: true,
        content: { "application/json": { schema: ImportCommitRequest } },
      },
    },
    responses: {
      200: {
        content: { "application/json": { schema: ImportCommitResponse } },
        description: "The commit's result: saved, or refused with the reason",
      },
      400: errorBody("Request did not match the contract"),
      401: errorBody("Not signed in"),
      403: errorBody("Role does not allow this"),
      404: errorBody("No such tenant"),
      409: errorBody(
        "The run number is not the batch's next one (import_run_number_used); its earlier runs name another source system (import_source_changed); its latest run is not a clean dry run (import_no_clean_dry_run); the files differ from the dry run's (import_changed_since_dry_run); the batch was saved already (import_already_committed); or a booked product has no cancellation policy (import_product_missing_policy)",
      ),
      422: errorBody(
        "More new rows than one commit writes (import_too_large); send the export as several batches. Or idempotency_key_reused",
      ),
    },
  });

  app.openapi(commitRoute, async (c) => {
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
          scope: "staff.import_commits.create",
          key,
          route: importCommitsPath,
          params: {},
          body: input,
          successStatus: 200,
        },
      },
      async (trx, ctx) => plain(commitResponse(await runImportCommit(trx, ctx, input.files))),
    );
    if (replayed) c.header("Idempotent-Replayed", "true");
    return c.json(body as ImportCommitResponse, 200);
  });

  const waiverEmailRoute = createRoute({
    method: "post",
    path: importWaiverEmailPath,
    tags: ["staff", "imports", "waivers"],
    summary: "Release a saved batch's waiver email",
    description: [
      "Owners only (imports.run). A batch saved with waiver_notifications hold_until_staff_release emails its guests nothing until an owner releases it here, once; the cron then sends their waiver requests a few bookings at a time, under an hourly cap per operator, for confirmed bookings whose trip has not left. A batch saved with send_at_cutover needs no release. Safe to repeat: a later call records nothing and reports how many of the batch's bookings the cron has still to email.",
      "Only waiver email: the booking's own emails (confirmation, reminders, balance, cancellation) stay held for imported bookings. Idempotent by key.",
    ].join("\n\n"),
    security: staffSecurity,
    request: {
      params: ImportRunParams,
      headers: z.object({ "idempotency-key": IdempotencyKey }),
    },
    responses: {
      200: {
        content: { "application/json": { schema: ImportWaiverEmailResponse } },
        description: "Whether this call released the batch, and what is still waiting",
      },
      400: errorBody("Request did not match the contract"),
      401: errorBody("Not signed in"),
      403: errorBody("Role does not allow this"),
      404: errorBody("No such tenant, or no saved batch with this id (import_run_not_found)"),
      422: errorBody("idempotency_key_reused"),
    },
  });

  app.openapi(waiverEmailRoute, async (c) => {
    const { tenantId, runId } = c.req.valid("param");
    const key = c.req.valid("header")["idempotency-key"];
    const { body, replayed } = await withStaffTenant(
      c,
      deps,
      {
        tenantId,
        permission: "imports.run",
        idempotency: {
          scope: "staff.import_waiver_email.release",
          key,
          route: importWaiverEmailPath,
          params: { runId },
          body: {},
          successStatus: 200,
        },
      },
      async (trx, ctx) => {
        if (!UUID.test(runId)) {
          throw new ApiError(404, "import_run_not_found", "No saved batch with this id");
        }
        const done = await releaseImportWaiverEmail(trx, ctx, { runId });
        if (done.kind === "not_found") {
          throw new ApiError(404, "import_run_not_found", "No saved batch with this id");
        }
        return {
          runId,
          releasedNow: done.releasedNow,
          waitingBookings: done.waitingBookings,
        } satisfies ImportWaiverEmailResponse;
      },
    );
    if (replayed) c.header("Idempotent-Replayed", "true");
    return c.json(body as ImportWaiverEmailResponse, 200);
  });
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function commitResponse(done: ImportCommitResult): ImportCommitResponse {
  switch (done.kind) {
    case "run_number_used":
      throw new ApiError(
        409,
        "import_run_number_used",
        `Batch ${done.batchId} cannot take run ${done.runNumber}; its next run number is ${done.expected}`,
      );
    case "source_changed":
      throw new ApiError(
        409,
        "import_source_changed",
        `Batch ${done.batchId} was run before from another source system`,
      );
    case "no_clean_dry_run":
      throw new ApiError(
        409,
        "import_no_clean_dry_run",
        `Batch ${done.batchId} needs a clean dry run, as its latest run, before it is saved`,
      );
    case "batch_changed_since_dry_run":
      throw new ApiError(
        409,
        "import_changed_since_dry_run",
        `The files differ from batch ${done.batchId}'s clean dry run; run a dry run of these files first`,
      );
    case "already_committed":
      throw new ApiError(
        409,
        "import_already_committed",
        `Batch ${done.batchId} was saved already; send later changes as a new batch`,
      );
    case "product_missing_policy":
      throw new ApiError(
        409,
        "import_product_missing_policy",
        `A product this batch books has no cancellation policy yet: ${done.productIds.join(", ")}`,
      );
    case "too_large":
      throw new ApiError(
        422,
        "import_too_large",
        `This batch writes ${done.rows} new rows; one commit writes at most ${done.limit}. Send the export as several batches.`,
      );
  }
  const r = done.result;
  const checkedAt = done.kind === "committed" ? done.committedAt : done.checkedAt;
  // A run the database refused was recorded as not clean.
  const clean = done.kind === "committed" ? r.clean : false;
  return {
    run: {
      id: done.runId,
      batchId: r.manifest?.batchId ?? null,
      runNumber: r.manifest?.runNumber ?? null,
      sourceSystem: r.manifest?.sourceSystem ?? null,
      contentHash: done.contentHash,
      checkedAt,
      clean,
      // The run the database refused was recorded with one error.
      errorCount: done.kind === "write_refused" ? 1 : r.errorCount,
      warningCount: r.warningCount,
      files: r.files,
      controls: r.controls,
      issues: r.issues.slice(0, MAX_IMPORT_ISSUES_LISTED),
      issuesTruncated: r.issuesCapped || r.issues.length > MAX_IMPORT_ISSUES_LISTED,
    },
    errorsCsv: renderImportErrors(r),
    committed: done.kind === "committed",
    refusal:
      done.kind === "committed"
        ? null
        : done.kind === "write_refused"
          ? "write_refused"
          : "not_clean",
    refusedBy: done.kind === "write_refused" ? done.constraint : null,
    counts: done.kind === "committed" ? done.counts : null,
  };
}
