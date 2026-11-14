import { createDb, publishOutbox, runDeliveryCleanup } from "@tidegrid/database";
import { sweepCheckouts, sweepReconciliation } from "@tidegrid/domain-booking";
import {
  type CustomHostnameProvider,
  HostnameSweepFault,
  sweepHostnames,
} from "@tidegrid/domain-hostnames";
import { redactAbandonedCheckouts } from "@tidegrid/domain-identity";
import { sweepExpiredHolds } from "@tidegrid/domain-inventory";
import { sweepEmail } from "@tidegrid/domain-messaging";
import {
  defaultWaiverDeps,
  sweepImportWaiverEmail,
  sweepWaiverReminders,
} from "@tidegrid/domain-waivers";
import { createLogger, newRequestId } from "@tidegrid/observability";
import { bookingHooks } from "./booking-hooks.ts";
import { queueSender } from "./delivery.ts";
import { deliverySettings, emailProvider, emailSettings, sendErrorAttributes } from "./email.ts";
import { type Bindings, databaseUrl } from "./env.ts";
import { hostnameProvider, hostnameSettings } from "./hostnames.ts";
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
 * Eight jobs, in order, on one connection:
 *
 * 1. The hold sweep expires capacity holds whose instant has passed, across
 *    tenants, one tenant transaction at a time.
 * 2. The checkout sweep (G2.7) expires open checkouts past their instant,
 *    processes inbox events a failed request left received, and sends refunds
 *    whose outcome is unknown again with their idempotency keys, a canceled
 *    booking's refund included. Then the reconciliation sweep (W3-G2.10)
 *    records TideGrid's fee on bookings that closed, drafts the fee invoice
 *    of any billing month that ended, and reads the provider about pending
 *    payments past their checkout's hold. A reading never changes a payment:
 *    one that disagrees is listed for staff, and only the provider's
 *    verified event confirms or fails a payment.
 * 3. The waiver reminder sweep (W1-G215-REMINDERS) queues the reminders
 *    unsigned waivers are due, before the email sweep sends them. Skipped
 *    when email is off. Then the import waiver email sweep (W3-G2.13, part
 *    D2) queues the waiver emails saved import batches owe, about 100 per
 *    operator a run. Skipped when email is off. Then the email sweep (lane 1, the G2.16 shim) sends due messages, retries
 *    temporary failures, and finishes attempts whose lease lapsed. Skipped
 *    when email is off.
 * 4. The hostname sweep (G2.14b) reads the custom-hostname provider for every
 *    hostname whose check is due and records the reading in that tenant's
 *    own transaction. It demotes only on a definitive negative (moved,
 *    blocked, deleted, or a failed certificate) and never promotes. An
 *    account-level refusal, a 429, or a 5xx records nothing for the hostname
 *    being read and ends the provider reads; a refusal about one record is
 *    recorded with no change. Earlier readings stand, and ended claims still
 *    expire until the budget runs out. Skipped when custom hostnames are
 *    off.
 * 5. The outbox publisher (W3-G2.3) sends due outbox events to the queue,
 *    sends again any hint that looks lost, and records a dead letter for an
 *    event sent too often without a delivery. Skipped when no OUTBOX_QUEUE
 *    binding is configured, which today is every deployed configuration.
 * 6. Cleanup (W3-G2.3) removes completed idempotency keys and unused quotes
 *    a week past their expiry, through app.delivery_cleanup, and dock QR
 *    lookups more than 30 days old, through app.waiver_dock_cleanup (0050).
 * 7. Retention (W3-G2.2b) replaces the booker's name and email on abandoned
 *    checkouts older than 30 days (coordinator default D2) with a fixed
 *    redaction, up to 500 a run, and records one audit event per tenant.
 *
 * Correctness never waits for any of them; they write the facts down, emit the
 * events, and finish interrupted work. A failed job is logged and rethrown, so
 * the cron invocation that awaits it fails too, and the next run starts over.
 */
export async function runScheduled(
  _controller: Pick<ScheduledController, "cron">,
  env: Bindings,
  options: {
    log?: (line: string) => void;
    /** A test's or the admin CLI's provider; the configured fake reads only this. */
    hostnameProvider?: CustomHostnameProvider;
  } = {},
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
        // A failed stamp is not a failed tenant: its turn still ran, unless
        // the budget ran out during the stamp.
        onStampError: (tenantId, error) =>
          log.error("hold_sweep_stamp_failed", {
            "tidegrid.tenant_id": tenantId,
            ...errorAttributes(error),
          }),
      });
      log.info("hold_sweep", {
        "tidegrid.hold_sweep.tenant_count": report.tenants,
        "tidegrid.hold_sweep.expired_count": report.expired,
        "tidegrid.hold_sweep.failed_tenant_count": report.failedTenants,
        "tidegrid.hold_sweep.turn_count": report.turns,
        "tidegrid.hold_sweep.pass_count": report.passes,
        "tidegrid.hold_sweep.deferred_tenant_count": report.deferredTenants,
        "tidegrid.hold_sweep.stamp_failure_count": report.stampFailures,
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
        "tidegrid.checkout_sweep.turn_count": report.turns,
        "tidegrid.checkout_sweep.pass_count": report.passes,
        "tidegrid.checkout_sweep.deferred_tenant_count": report.deferredTenants,
        "tidegrid.checkout_sweep.stamp_failure_count": report.stampFailures,
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

    const reconciliationLog = createLogger(
      { ...base, "event.name": "reconciliation_sweep" },
      options.log,
    );
    started = Date.now();
    try {
      const report = await sweepReconciliation(handle.db, {
        runId,
        provider: paymentProvider(env, handle.db),
        onTenantError: (tenantId, error) =>
          reconciliationLog.error("reconciliation_sweep_tenant_failed", {
            "tidegrid.tenant_id": tenantId,
            ...errorAttributes(error),
          }),
        onStampError: (tenantId, error) =>
          reconciliationLog.error("reconciliation_sweep_stamp_failed", {
            "tidegrid.tenant_id": tenantId,
            ...errorAttributes(error),
          }),
      });
      reconciliationLog.info("reconciliation_sweep", {
        "tidegrid.reconciliation_sweep.tenant_count": report.tenants,
        "tidegrid.reconciliation_sweep.assessed_count": report.assessed,
        "tidegrid.reconciliation_sweep.invoiced_count": report.invoiced,
        "tidegrid.reconciliation_sweep.payments_checked_count": report.paymentsChecked,
        "tidegrid.reconciliation_sweep.payments_raised_count": report.paymentsRaised,
        "tidegrid.reconciliation_sweep.failed_tenant_count": report.failedTenants,
        "tidegrid.reconciliation_sweep.turn_count": report.turns,
        "tidegrid.reconciliation_sweep.pass_count": report.passes,
        "tidegrid.reconciliation_sweep.deferred_tenant_count": report.deferredTenants,
        "tidegrid.reconciliation_sweep.stamp_failure_count": report.stampFailures,
        "tidegrid.reconciliation_sweep.complete": report.complete,
        duration_ms: Date.now() - started,
      });
    } catch (error) {
      reconciliationLog.error("reconciliation_sweep_failed", {
        ...errorAttributes(error),
        duration_ms: Date.now() - started,
      });
      throw error;
    }

    const provider = emailProvider(env, handle.db);

    // 3a. Waiver reminders (W1-G215-REMINDERS): queue the reminder each
    //     unsigned waiver is due, 72 and 24 hours before departure and none
    //     within 2 hours, for the email sweep below to send. Skipped when
    //     email is off, so nothing piles up that would go out late.
    const reminderLog = createLogger(
      { ...base, "event.name": "waiver_reminder_sweep" },
      options.log,
    );
    if (!provider) {
      reminderLog.info("waiver_reminder_sweep_skipped", {
        "tidegrid.email.reason": emailSettings(env).kind,
      });
    } else {
      started = Date.now();
      try {
        const report = await sweepWaiverReminders(handle.db, {
          runId,
          deps: defaultWaiverDeps,
          onTenantError: (tenantId, error) =>
            reminderLog.error("waiver_reminder_sweep_tenant_failed", {
              "tidegrid.tenant_id": tenantId,
              ...errorAttributes(error),
            }),
          onStampError: (tenantId, error) =>
            reminderLog.error("waiver_reminder_sweep_stamp_failed", {
              "tidegrid.tenant_id": tenantId,
              ...errorAttributes(error),
            }),
        });
        reminderLog.info("waiver_reminder_sweep", {
          "tidegrid.waiver_reminder_sweep.tenant_count": report.tenants,
          "tidegrid.waiver_reminder_sweep.queued_count": report.queued,
          "tidegrid.waiver_reminder_sweep.skipped_count": report.skipped,
          "tidegrid.waiver_reminder_sweep.failed_tenant_count": report.failedTenants,
          "tidegrid.waiver_reminder_sweep.turn_count": report.turns,
          "tidegrid.waiver_reminder_sweep.pass_count": report.passes,
          "tidegrid.waiver_reminder_sweep.deferred_tenant_count": report.deferredTenants,
          "tidegrid.waiver_reminder_sweep.stamp_failure_count": report.stampFailures,
          "tidegrid.waiver_reminder_sweep.complete": report.complete,
          duration_ms: Date.now() - started,
        });
      } catch (error) {
        reminderLog.error("waiver_reminder_sweep_failed", {
          ...errorAttributes(error),
          duration_ms: Date.now() - started,
        });
        throw error;
      }
    }

    // 3b. Import waiver email (W3-G2.13, part D2): for saved import batches
    //     whose waiver email is due (sent at cutover, or released by an
    //     owner), create the guests' waiver requests and queue their emails,
    //     a few bookings at a time and about 100 emails per operator a run.
    //     Skipped when email is off.
    const importLog = createLogger(
      { ...base, "event.name": "import_waiver_email_sweep" },
      options.log,
    );
    if (!provider) {
      importLog.info("import_waiver_email_sweep_skipped", {
        "tidegrid.email.reason": emailSettings(env).kind,
      });
    } else {
      started = Date.now();
      try {
        const report = await sweepImportWaiverEmail(handle.db, {
          runId,
          deps: defaultWaiverDeps,
          onTenantError: (tenantId, error) =>
            importLog.error("import_waiver_email_sweep_tenant_failed", {
              "tidegrid.tenant_id": tenantId,
              ...errorAttributes(error),
            }),
          onBookingError: (tenantId, booking, error) =>
            importLog.error("import_waiver_email_sweep_booking_failed", {
              "tidegrid.tenant_id": tenantId,
              "tidegrid.import_waiver_email_sweep.run_id": booking.runId,
              "tidegrid.import_waiver_email_sweep.booking_id": booking.bookingId,
              ...errorAttributes(error),
            }),
          onStampError: (tenantId, error) =>
            importLog.error("import_waiver_email_sweep_stamp_failed", {
              "tidegrid.tenant_id": tenantId,
              ...errorAttributes(error),
            }),
        });
        importLog.info("import_waiver_email_sweep", {
          "tidegrid.import_waiver_email_sweep.tenant_count": report.tenants,
          "tidegrid.import_waiver_email_sweep.booking_count": report.bookings,
          "tidegrid.import_waiver_email_sweep.queued_count": report.queued,
          "tidegrid.import_waiver_email_sweep.failed_booking_count": report.failedBookings,
          "tidegrid.import_waiver_email_sweep.capped_tenant_count": report.cappedTenants,
          "tidegrid.import_waiver_email_sweep.failed_tenant_count": report.failedTenants,
          "tidegrid.import_waiver_email_sweep.turn_count": report.turns,
          "tidegrid.import_waiver_email_sweep.pass_count": report.passes,
          "tidegrid.import_waiver_email_sweep.deferred_tenant_count": report.deferredTenants,
          "tidegrid.import_waiver_email_sweep.stamp_failure_count": report.stampFailures,
          "tidegrid.import_waiver_email_sweep.complete": report.complete,
          duration_ms: Date.now() - started,
        });
      } catch (error) {
        importLog.error("import_waiver_email_sweep_failed", {
          ...errorAttributes(error),
          duration_ms: Date.now() - started,
        });
        throw error;
      }
    }

    // 3. Email delivery (lane 1, the G2.16 shim): send due messages, retry
    //    temporary failures, and finish attempts whose lease lapsed.
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
          onStampError: (tenantId, error) =>
            emailLog.error("email_sweep_stamp_failed", {
              "tidegrid.tenant_id": tenantId,
              ...errorAttributes(error),
            }),
          onSendError: (_messageId, error) =>
            emailLog.error("email_send_error", sendErrorAttributes(error)),
        });
        emailLog.info("email_sweep", {
          "tidegrid.email_sweep.tenant_count": report.tenants,
          "tidegrid.email_sweep.sent_count": report.sent,
          "tidegrid.email_sweep.retried_count": report.retried,
          "tidegrid.email_sweep.failed_count": report.failed,
          "tidegrid.email_sweep.superseded_count": report.superseded,
          "tidegrid.email_sweep.canceled_count": report.canceled,
          "tidegrid.email_sweep.failed_tenant_count": report.failedTenants,
          "tidegrid.email_sweep.turn_count": report.turns,
          "tidegrid.email_sweep.pass_count": report.passes,
          "tidegrid.email_sweep.deferred_tenant_count": report.deferredTenants,
          "tidegrid.email_sweep.stamp_failure_count": report.stampFailures,
          "tidegrid.email_sweep.held_tenant_count": report.heldTenants,
          // Always logged: the one stop cause the counts cannot show (D-E5 B).
          "tidegrid.email_sweep.account_fault": report.accountFault,
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

    // 4. Custom hostnames (G2.14b): read the provider for every hostname whose
    //    check is due and record it; only a definitive negative demotes.
    //    Skipped when custom hostnames are off.
    const hostnameLog = createLogger({ ...base, "event.name": "hostname_sweep" }, options.log);
    const hostnames = hostnameProvider(env, options.hostnameProvider);
    if (!hostnames) {
      const settings = hostnameSettings(env);
      hostnameLog.info("hostname_sweep_skipped", {
        "tidegrid.hostname.reason": "reason" in settings ? settings.reason : "fake_not_injected",
      });
    } else {
      started = Date.now();
      try {
        const report = await sweepHostnames(handle.db, {
          provider: hostnames,
          runId,
          onTenantError: (tenantId, error) =>
            hostnameLog.error("hostname_sweep_tenant_failed", {
              "tidegrid.tenant_id": tenantId,
              ...(error instanceof HostnameSweepFault
                ? {
                    // The refusal's code and the opaque provider record id, so
                    // a rotated token reads differently from one bad record.
                    "error.type": error.name,
                    "tidegrid.hostname.refusal_code": error.code,
                    "tidegrid.hostname.provider_hostname_id": error.providerHostnameId,
                  }
                : errorAttributes(error)),
            }),
          onStampError: (tenantId, error) =>
            hostnameLog.error("hostname_sweep_stamp_failed", {
              "tidegrid.tenant_id": tenantId,
              ...errorAttributes(error),
            }),
          onUnread: (tenantId, providerHostnameId, code) =>
            hostnameLog.warn("hostname_sweep_unread", {
              "tidegrid.tenant_id": tenantId,
              "tidegrid.hostname.refusal_code": code,
              "tidegrid.hostname.provider_hostname_id": providerHostnameId,
            }),
          onExpiring: (tenantId) =>
            hostnameLog.warn("hostname_certificate_expiring", { "tidegrid.tenant_id": tenantId }),
        });
        hostnameLog.info("hostname_sweep", {
          "tidegrid.hostname_sweep.tenant_count": report.tenants,
          "tidegrid.hostname_sweep.checked_count": report.checked,
          "tidegrid.hostname_sweep.demoted_count": report.demoted,
          "tidegrid.hostname_sweep.expired_count": report.expired,
          "tidegrid.hostname_sweep.failed_tenant_count": report.failedTenants,
          "tidegrid.hostname_sweep.throttled": report.throttled,
          "tidegrid.hostname_sweep.unread_count": report.unread,
          "tidegrid.hostname_sweep.turn_count": report.turns,
          "tidegrid.hostname_sweep.pass_count": report.passes,
          "tidegrid.hostname_sweep.deferred_tenant_count": report.deferredTenants,
          "tidegrid.hostname_sweep.stamp_failure_count": report.stampFailures,
          "tidegrid.hostname_sweep.expiry_only_turn_count": report.expiryOnlyTurns,
          "tidegrid.hostname_sweep.provider_call_count": report.providerCalls,
          // The provider's requested wait, so a long 429 storm reads apart from a short one.
          ...(report.retryAfterSeconds !== null
            ? { "tidegrid.hostname_sweep.retry_after_seconds": report.retryAfterSeconds }
            : {}),
          ...(report.providerFault
            ? {
                "tidegrid.hostname_sweep.provider_fault": report.providerFault,
                "tidegrid.hostname.provider_hostname_id": report.providerFaultHostnameId,
              }
            : {}),
          "tidegrid.hostname_sweep.complete": report.complete,
          duration_ms: Date.now() - started,
        });
      } catch (error) {
        hostnameLog.error("hostname_sweep_failed", {
          ...errorAttributes(error),
          duration_ms: Date.now() - started,
        });
        throw error;
      }
    }
    // 5. Outbox publication (W3-G2.3). Skipped without a queue binding.
    const outboxLog = createLogger({ ...base, "event.name": "outbox_publish" }, options.log);
    if (!env.OUTBOX_QUEUE) {
      outboxLog.info("outbox_publish_skipped", { "tidegrid.outbox.reason": "queue_unconfigured" });
    } else {
      started = Date.now();
      try {
        const report = await publishOutbox(handle.db, {
          send: queueSender(env.OUTBOX_QUEUE),
          runId,
          onTenantError: (tenantId, error) =>
            outboxLog.error("outbox_publish_tenant_failed", {
              "tidegrid.tenant_id": tenantId,
              ...errorAttributes(error),
            }),
          onStampError: (tenantId, error) =>
            outboxLog.error("outbox_publish_stamp_failed", {
              "tidegrid.tenant_id": tenantId,
              ...errorAttributes(error),
            }),
          onDeadLetter: (message) =>
            outboxLog.error("outbox_dead_lettered", {
              "tidegrid.tenant_id": message.tenantId,
              "tidegrid.outbox.id": message.outboxId,
              "tidegrid.outbox.topic": message.topic,
              "tidegrid.outbox.dead_letter_source": "publisher",
            }),
        });
        outboxLog.info("outbox_publish", {
          "tidegrid.outbox_publish.tenant_count": report.tenants,
          "tidegrid.outbox_publish.published_count": report.published,
          "tidegrid.outbox_publish.resent_count": report.resent,
          "tidegrid.outbox_publish.dead_lettered_count": report.deadLettered,
          "tidegrid.outbox_publish.send_failure_count": report.sendFailures,
          "tidegrid.outbox_publish.failed_tenant_count": report.failedTenants,
          "tidegrid.outbox_publish.turn_count": report.turns,
          "tidegrid.outbox_publish.pass_count": report.passes,
          "tidegrid.outbox_publish.deferred_tenant_count": report.deferredTenants,
          "tidegrid.outbox_publish.stamp_failure_count": report.stampFailures,
          "tidegrid.outbox_publish.stopped": report.stopped,
          "tidegrid.outbox_publish.complete": report.complete,
          duration_ms: Date.now() - started,
        });
      } catch (error) {
        outboxLog.error("outbox_publish_failed", {
          ...errorAttributes(error),
          duration_ms: Date.now() - started,
        });
        throw error;
      }
    }

    // 6. Cleanup (W3-G2.3): expired idempotency keys and unused quotes, and
    // dock QR lookups more than 30 days old (0050).
    const cleanupLog = createLogger({ ...base, "event.name": "delivery_cleanup" }, options.log);
    started = Date.now();
    try {
      const report = await runDeliveryCleanup(handle.db);
      cleanupLog.info("delivery_cleanup", {
        "tidegrid.delivery_cleanup.idempotency_keys_deleted": report.idempotencyKeysDeleted,
        "tidegrid.delivery_cleanup.quotes_deleted": report.quotesDeleted,
        "tidegrid.delivery_cleanup.dock_lookups_deleted": report.dockLookupsDeleted,
        "tidegrid.delivery_cleanup.dock_lookups_redacted": report.dockLookupsRedacted,
        duration_ms: Date.now() - started,
      });
    } catch (error) {
      cleanupLog.error("delivery_cleanup_failed", {
        ...errorAttributes(error),
        duration_ms: Date.now() - started,
      });
      throw error;
    }

    // 7. Retention (W3-G2.2b): redact abandoned checkouts' bookers.
    const retentionLog = createLogger({ ...base, "event.name": "retention" }, options.log);
    started = Date.now();
    try {
      const report = await redactAbandonedCheckouts(handle.db);
      retentionLog.info("retention", {
        "tidegrid.retention.tenant_count": report.tenants,
        "tidegrid.retention.redacted_count": report.redacted,
        "tidegrid.retention.complete": report.complete,
        duration_ms: Date.now() - started,
      });
    } catch (error) {
      retentionLog.error("retention_failed", {
        ...errorAttributes(error),
        duration_ms: Date.now() - started,
      });
      throw error;
    }
  } finally {
    await handle.end();
  }
}
