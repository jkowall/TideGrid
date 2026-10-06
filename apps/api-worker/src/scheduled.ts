import { createDb } from "@tidegrid/database";
import { sweepCheckouts } from "@tidegrid/domain-booking";
import { sweepExpiredHolds } from "@tidegrid/domain-inventory";
import { sweepEmail } from "@tidegrid/domain-messaging";
import { createLogger, newRequestId } from "@tidegrid/observability";
import { bookingHooks } from "./booking-hooks.ts";
import { deliverySettings, emailProvider, emailSettings } from "./email.ts";
import { type Bindings, databaseUrl } from "./env.ts";
import { paymentProvider } from "./payments.ts";

function errorAttributes(error: unknown): Record<string, unknown> {
  const code = (error as { code?: unknown } | null)?.code;
  return {
    "error.type": error instanceof Error ? error.name : "unknown",
    ...(typeof code === "string" ? { "db.response.status_code": code } : {}),
  };
}

/**
 * Scheduled work for the API Worker, run by the cron trigger in wrangler.jsonc.
 * Three jobs, in order, on one connection:
 *
 * 1. The hold sweep expires capacity holds whose instant has passed, across
 *    tenants, one tenant transaction at a time.
 * 2. The checkout sweep (G2.7) expires open checkouts past their instant,
 *    processes inbox events a failed request left received, and sends refunds
 *    whose outcome is unknown again with their idempotency keys, a canceled
 *    booking's refund included.
 * 3. The email sweep (lane 1, the G2.16 shim) sends due messages, retries
 *    temporary failures, and finishes attempts whose lease lapsed. Skipped
 *    when email is off.
 *
 * Correctness never waits for either; they write the facts down, emit the
 * events, and finish interrupted work. A failed job is logged and rethrown, so
 * the cron invocation that awaits it fails too, and the next run starts over.
 */
export async function runScheduled(
  _controller: Pick<ScheduledController, "cron">,
  env: Bindings,
  options: { log?: (line: string) => void } = {},
): Promise<void> {
  const runId = newRequestId();
  const base = { "tidegrid.request_id": runId, "tidegrid.environment": env.ENVIRONMENT };
  const log = createLogger({ ...base, "event.name": "hold_sweep" }, options.log);
  const url = databaseUrl(env);
  if (!url) {
    log.warn("hold_sweep_skipped", { "error.type": "database_unconfigured" });
    return;
  }
  const handle = createDb(url, { max: 1 });
  try {
    let started = Date.now();
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
    }

    const checkoutLog = createLogger({ ...base, "event.name": "checkout_sweep" }, options.log);
    started = Date.now();
    try {
      const report = await sweepCheckouts(handle.db, {
        runId,
        provider: paymentProvider(env, handle.db),
        hooks: bookingHooks(env),
        onError: (tenantId, item, error) =>
          checkoutLog.error(`checkout_sweep_${item}_failed`, {
            "tidegrid.tenant_id": tenantId,
            ...errorAttributes(error),
          }),
      });
      checkoutLog.info("checkout_sweep", {
        "tidegrid.checkout_sweep.tenant_count": report.tenants,
        "tidegrid.checkout_sweep.expired_count": report.expired,
        "tidegrid.checkout_sweep.skipped_count": report.skipped,
        "tidegrid.checkout_sweep.reprocessed_count": report.reprocessed,
        "tidegrid.checkout_sweep.refunds_settled_count": report.refundsSettled,
        "tidegrid.checkout_sweep.refunds_pending_count": report.refundsPending,
        "tidegrid.checkout_sweep.failed_tenant_count": report.failedTenants,
        "tidegrid.checkout_sweep.failed_event_count": report.failedEvents,
        "tidegrid.checkout_sweep.failed_refund_count": report.failedRefunds,
        "tidegrid.checkout_sweep.complete": report.complete,
        duration_ms: Date.now() - started,
      });
    } catch (error) {
      checkoutLog.error("checkout_sweep_failed", {
        ...errorAttributes(error),
        duration_ms: Date.now() - started,
      });
      throw error;
    }

    // 3. Email delivery (lane 1, the G2.16 shim): send due messages, retry
    //    temporary failures, and finish attempts whose lease lapsed.
    const provider = emailProvider(env, handle.db);
    const emailLog = createLogger({ ...base, "event.name": "email_sweep" }, options.log);
    if (!provider) {
      emailLog.info("email_sweep_skipped", { "tidegrid.email.reason": emailSettings(env).kind });
    } else {
      started = Date.now();
      try {
        const report = await sweepEmail(handle.db, {
          provider,
          ...deliverySettings(env),
          runId,
          onTenantError: (tenantId, error) =>
            emailLog.error("email_sweep_tenant_failed", {
              "tidegrid.tenant_id": tenantId,
              ...errorAttributes(error),
            }),
        });
        emailLog.info("email_sweep", {
          "tidegrid.email_sweep.tenant_count": report.tenants,
          "tidegrid.email_sweep.sent_count": report.sent,
          "tidegrid.email_sweep.retried_count": report.retried,
          "tidegrid.email_sweep.failed_count": report.failed,
          "tidegrid.email_sweep.superseded_count": report.superseded,
          "tidegrid.email_sweep.failed_tenant_count": report.failedTenants,
          "tidegrid.email_sweep.complete": report.complete,
          duration_ms: Date.now() - started,
        });
      } catch (error) {
        emailLog.error("email_sweep_failed", {
          ...errorAttributes(error),
          duration_ms: Date.now() - started,
        });
        throw error;
      }
    }
  } finally {
    await handle.end();
  }
}
