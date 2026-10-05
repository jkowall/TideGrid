import { createDb } from "@tidegrid/database";
import { sweepExpiredHolds } from "@tidegrid/domain-inventory";
import { createLogger, newRequestId } from "@tidegrid/observability";
import { type Bindings, databaseUrl } from "./env.ts";

function errorAttributes(error: unknown): Record<string, unknown> {
  const code = (error as { code?: unknown } | null)?.code;
  return {
    "error.type": error instanceof Error ? error.name : "unknown",
    ...(typeof code === "string" ? { "db.response.status_code": code } : {}),
  };
}

/**
 * Scheduled work for the API Worker, run by the cron trigger in wrangler.jsonc.
 * Today there is one job: expire capacity holds whose instant has passed,
 * across tenants, one tenant transaction at a time. Correctness never waits
 * for this run; it writes the expiry down and emits the events. A second cron
 * job would dispatch on `controller.cron` here. Each run opens one connection
 * and closes it before returning.
 */
export async function runScheduled(
  _controller: Pick<ScheduledController, "cron">,
  env: Bindings,
  options: { log?: (line: string) => void } = {},
): Promise<void> {
  const runId = newRequestId();
  const log = createLogger(
    {
      "tidegrid.request_id": runId,
      "tidegrid.environment": env.ENVIRONMENT,
      "event.name": "hold_sweep",
    },
    options.log,
  );
  const url = databaseUrl(env);
  if (!url) {
    log.warn("hold_sweep_skipped", { "error.type": "database_unconfigured" });
    return;
  }
  const started = Date.now();
  const handle = createDb(url, { max: 1 });
  try {
    const report = await sweepExpiredHolds(handle.db, {
      runId,
      onTenantError: (tenantId, error) =>
        log.error("hold_sweep_tenant_failed", {
          "tidegrid.tenant_id": tenantId,
          ...errorAttributes(error),
        }),
    });
    log.info("hold_sweep", {
      "tidegrid.hold_sweep.tenant_count": report.tenants,
      "tidegrid.hold_sweep.expired_count": report.expired,
      "tidegrid.hold_sweep.failed_tenant_count": report.failedTenants,
      "tidegrid.hold_sweep.complete": report.complete,
      duration_ms: Date.now() - started,
    });
  } catch (error) {
    log.error("hold_sweep_failed", {
      ...errorAttributes(error),
      duration_ms: Date.now() - started,
    });
    throw error;
  } finally {
    await handle.end();
  }
}
