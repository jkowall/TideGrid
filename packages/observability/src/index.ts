/**
 * Structured logging with OpenTelemetry semantic-convention attribute names.
 * Output is one JSON object per line so Workers Logs can index it. Values that
 * could carry guest data are redacted by allowlist: only the keys below pass.
 */

export type LogLevel = "debug" | "info" | "warn" | "error";

export interface RequestAttributes {
  "http.request.method"?: string;
  "url.path"?: string;
  "http.response.status_code"?: number;
  "server.address"?: string;
  "tidegrid.request_id"?: string;
  "tidegrid.tenant_id"?: string;
  "tidegrid.environment"?: string;
  "error.type"?: string;
  "event.name"?: string;
  /** Staff user id (a UUID). Never an email address. */
  "user.id"?: string;
  duration_ms?: number;
  /** SQLSTATE of a failed database call. */
  "db.response.status_code"?: string;
  /** Hold sweep counters (G2.6). */
  "tidegrid.hold_sweep.tenant_count"?: number;
  "tidegrid.hold_sweep.expired_count"?: number;
  "tidegrid.hold_sweep.failed_tenant_count"?: number;
  "tidegrid.hold_sweep.complete"?: boolean;
  /** Fair turns, for each of the four sweeps (pre-pilot hardening, Part E). Counts only. */
  "tidegrid.hold_sweep.turn_count"?: number;
  "tidegrid.hold_sweep.pass_count"?: number;
  "tidegrid.hold_sweep.deferred_tenant_count"?: number;
  "tidegrid.hold_sweep.stamp_failure_count"?: number;
  /** Payment webhooks (G2.7): what processing did. Never an event body, id, or secret. */
  "tidegrid.payment_event.outcome"?: string;
  "tidegrid.payment_event.duplicate"?: boolean;
  /** Checkout sweep counters (G2.7). */
  "tidegrid.checkout_sweep.tenant_count"?: number;
  "tidegrid.checkout_sweep.expired_count"?: number;
  "tidegrid.checkout_sweep.skipped_count"?: number;
  "tidegrid.checkout_sweep.reprocessed_count"?: number;
  "tidegrid.checkout_sweep.refunds_settled_count"?: number;
  "tidegrid.checkout_sweep.refunds_pending_count"?: number;
  "tidegrid.checkout_sweep.failed_tenant_count"?: number;
  "tidegrid.checkout_sweep.failed_event_count"?: number;
  "tidegrid.checkout_sweep.failed_refund_count"?: number;
  "tidegrid.checkout_sweep.complete"?: boolean;
  "tidegrid.checkout_sweep.turn_count"?: number;
  "tidegrid.checkout_sweep.pass_count"?: number;
  "tidegrid.checkout_sweep.deferred_tenant_count"?: number;
  "tidegrid.checkout_sweep.stamp_failure_count"?: number;
  /** Email delivery (lane 1, the G2.16 shim): counts and codes, never a recipient or body. */
  "tidegrid.email.sent_count"?: number;
  "tidegrid.email.retried_count"?: number;
  "tidegrid.email.failed_count"?: number;
  "tidegrid.email.canceled_count"?: number;
  "tidegrid.email.reason"?: string;
  /** Cloudflare email adapter (G2.16a): TideGrid's message id, the opaque provider id, flags. Never an address. */
  "tidegrid.email.message_id"?: string;
  "tidegrid.email.provider_message_id"?: string;
  "tidegrid.email.provider_id_normalized"?: boolean;
  "tidegrid.email.stopped"?: string;
  "tidegrid.email.held"?: string;
  "tidegrid.email_sweep.tenant_count"?: number;
  "tidegrid.email_sweep.sent_count"?: number;
  "tidegrid.email_sweep.retried_count"?: number;
  "tidegrid.email_sweep.failed_count"?: number;
  "tidegrid.email_sweep.superseded_count"?: number;
  "tidegrid.email_sweep.canceled_count"?: number;
  "tidegrid.email_sweep.failed_tenant_count"?: number;
  "tidegrid.email_sweep.complete"?: boolean;
  "tidegrid.email_sweep.turn_count"?: number;
  "tidegrid.email_sweep.pass_count"?: number;
  "tidegrid.email_sweep.deferred_tenant_count"?: number;
  "tidegrid.email_sweep.stamp_failure_count"?: number;
  "tidegrid.email_sweep.held_tenant_count"?: number;
  /** The provider refused for the whole account and the run stopped. */
  "tidegrid.email_sweep.account_fault"?: boolean;
  // Email events consumer (W1-EMAIL-EVENTS): the outcome and the event's
  // type only; never an address, a subject, or the provider's text.
  "tidegrid.email_event.outcome"?: string;
  "tidegrid.email_event.type"?: string;
  "tidegrid.email_event.suppressed"?: boolean;
  "tidegrid.email_events.count"?: number;
  "tidegrid.email_events.attempts"?: number;
  /** Custom hostname sweep (G2.14b). Provider ids are opaque; no hostname or personal data. */
  "tidegrid.hostname.reason"?: string;
  "tidegrid.hostname.refusal_code"?: string;
  "tidegrid.hostname.provider_hostname_id"?: string;
  "tidegrid.hostname_sweep.tenant_count"?: number;
  "tidegrid.hostname_sweep.checked_count"?: number;
  "tidegrid.hostname_sweep.demoted_count"?: number;
  "tidegrid.hostname_sweep.expired_count"?: number;
  "tidegrid.hostname_sweep.unread_count"?: number;
  "tidegrid.hostname_sweep.failed_tenant_count"?: number;
  "tidegrid.hostname_sweep.throttled"?: boolean;
  "tidegrid.hostname_sweep.provider_fault"?: string;
  "tidegrid.hostname_sweep.complete"?: boolean;
  "tidegrid.hostname_sweep.turn_count"?: number;
  "tidegrid.hostname_sweep.pass_count"?: number;
  "tidegrid.hostname_sweep.deferred_tenant_count"?: number;
  "tidegrid.hostname_sweep.stamp_failure_count"?: number;
  "tidegrid.hostname_sweep.expiry_only_turn_count"?: number;
  "tidegrid.hostname_sweep.provider_call_count"?: number;
  /** The provider's requested wait after a 429 or 5xx, in seconds. */
  "tidegrid.hostname_sweep.retry_after_seconds"?: number;
  // Delivery foundation (W3-G2.3): ids and counts only, never a payload.
  "tidegrid.outbox.id"?: string;
  "tidegrid.outbox.topic"?: string;
  "tidegrid.outbox.aggregate_type"?: string;
  "tidegrid.outbox.aggregate_id"?: string;
  "tidegrid.outbox.handler"?: string;
  "tidegrid.outbox.reason"?: string;
  "tidegrid.outbox.dead_letter_source"?: string;
  "tidegrid.outbox.dead_letter_result"?: string;
  "tidegrid.outbox.attempts"?: number;
  "tidegrid.outbox.handler_count"?: number;
  "tidegrid.outbox.queue_dlq"?: boolean;
  "tidegrid.outbox_publish.tenant_count"?: number;
  "tidegrid.outbox_publish.published_count"?: number;
  "tidegrid.outbox_publish.resent_count"?: number;
  "tidegrid.outbox_publish.dead_lettered_count"?: number;
  "tidegrid.outbox_publish.send_failure_count"?: number;
  "tidegrid.outbox_publish.failed_tenant_count"?: number;
  "tidegrid.outbox_publish.turn_count"?: number;
  "tidegrid.outbox_publish.pass_count"?: number;
  "tidegrid.outbox_publish.deferred_tenant_count"?: number;
  "tidegrid.outbox_publish.stamp_failure_count"?: number;
  "tidegrid.outbox_publish.stopped"?: boolean;
  "tidegrid.outbox_publish.complete"?: boolean;
  "tidegrid.delivery_cleanup.idempotency_keys_deleted"?: number;
  "tidegrid.delivery_cleanup.quotes_deleted"?: number;
  "tidegrid.dock_lookup_cleanup.deleted_count"?: number;
  "tidegrid.dock_lookup_cleanup.redacted_count"?: number;
  /** Waiver reminder sweep (W1-G215-REMINDERS). Counts only. */
  "tidegrid.waiver_reminder_sweep.tenant_count"?: number;
  "tidegrid.waiver_reminder_sweep.queued_count"?: number;
  "tidegrid.waiver_reminder_sweep.skipped_count"?: number;
  "tidegrid.waiver_reminder_sweep.failed_tenant_count"?: number;
  "tidegrid.waiver_reminder_sweep.complete"?: boolean;
  "tidegrid.waiver_reminder_sweep.turn_count"?: number;
  "tidegrid.waiver_reminder_sweep.pass_count"?: number;
  "tidegrid.waiver_reminder_sweep.deferred_tenant_count"?: number;
  "tidegrid.waiver_reminder_sweep.stamp_failure_count"?: number;
  /** Import waiver email sweep (W3-G2.13, part D2). Counts only. */
  "tidegrid.import_waiver_email_sweep.tenant_count"?: number;
  "tidegrid.import_waiver_email_sweep.booking_count"?: number;
  "tidegrid.import_waiver_email_sweep.queued_count"?: number;
  /** The import run and booking a failed sweep step was on (UUIDs). */
  "tidegrid.import_waiver_email_sweep.run_id"?: string;
  "tidegrid.import_waiver_email_sweep.booking_id"?: string;
  "tidegrid.import_waiver_email_sweep.failed_booking_count"?: number;
  "tidegrid.import_waiver_email_sweep.capped_tenant_count"?: number;
  "tidegrid.import_waiver_email_sweep.failed_tenant_count"?: number;
  "tidegrid.import_waiver_email_sweep.complete"?: boolean;
  "tidegrid.import_waiver_email_sweep.turn_count"?: number;
  "tidegrid.import_waiver_email_sweep.pass_count"?: number;
  "tidegrid.import_waiver_email_sweep.deferred_tenant_count"?: number;
  "tidegrid.import_waiver_email_sweep.stamp_failure_count"?: number;
  /** Reconciliation sweep (W3-G2.10). Counts only. */
  "tidegrid.reconciliation_sweep.tenant_count"?: number;
  "tidegrid.reconciliation_sweep.assessed_count"?: number;
  "tidegrid.reconciliation_sweep.invoiced_count"?: number;
  "tidegrid.reconciliation_sweep.payments_checked_count"?: number;
  "tidegrid.reconciliation_sweep.payments_raised_count"?: number;
  "tidegrid.reconciliation_sweep.failed_tenant_count"?: number;
  "tidegrid.reconciliation_sweep.complete"?: boolean;
  "tidegrid.reconciliation_sweep.turn_count"?: number;
  "tidegrid.reconciliation_sweep.pass_count"?: number;
  "tidegrid.reconciliation_sweep.deferred_tenant_count"?: number;
  "tidegrid.reconciliation_sweep.stamp_failure_count"?: number;
}

const allowedKeys = new Set<keyof RequestAttributes>([
  "http.request.method",
  "url.path",
  "http.response.status_code",
  "server.address",
  "tidegrid.request_id",
  "tidegrid.tenant_id",
  "tidegrid.environment",
  "error.type",
  "event.name",
  "user.id",
  "duration_ms",
  "db.response.status_code",
  "tidegrid.hold_sweep.tenant_count",
  "tidegrid.hold_sweep.expired_count",
  "tidegrid.hold_sweep.failed_tenant_count",
  "tidegrid.hold_sweep.complete",
  // Fair turns (pre-pilot hardening, Part E).
  "tidegrid.hold_sweep.turn_count",
  "tidegrid.hold_sweep.pass_count",
  "tidegrid.hold_sweep.deferred_tenant_count",
  "tidegrid.hold_sweep.stamp_failure_count",
  "tidegrid.payment_event.outcome",
  "tidegrid.payment_event.duplicate",
  "tidegrid.checkout_sweep.tenant_count",
  "tidegrid.checkout_sweep.expired_count",
  "tidegrid.checkout_sweep.skipped_count",
  "tidegrid.checkout_sweep.reprocessed_count",
  "tidegrid.checkout_sweep.refunds_settled_count",
  "tidegrid.checkout_sweep.refunds_pending_count",
  "tidegrid.checkout_sweep.failed_tenant_count",
  "tidegrid.checkout_sweep.failed_event_count",
  "tidegrid.checkout_sweep.failed_refund_count",
  "tidegrid.checkout_sweep.complete",
  "tidegrid.checkout_sweep.turn_count",
  "tidegrid.checkout_sweep.pass_count",
  "tidegrid.checkout_sweep.deferred_tenant_count",
  "tidegrid.checkout_sweep.stamp_failure_count",
  // Email delivery (lane 1, the G2.16 shim).
  "tidegrid.email.sent_count",
  "tidegrid.email.retried_count",
  "tidegrid.email.failed_count",
  "tidegrid.email.canceled_count",
  "tidegrid.email.reason",
  // Cloudflare email adapter (G2.16a).
  "tidegrid.email.message_id",
  "tidegrid.email.provider_message_id",
  "tidegrid.email.provider_id_normalized",
  "tidegrid.email.stopped",
  "tidegrid.email.held",
  "tidegrid.email_sweep.tenant_count",
  "tidegrid.email_sweep.sent_count",
  "tidegrid.email_sweep.retried_count",
  "tidegrid.email_sweep.failed_count",
  "tidegrid.email_sweep.superseded_count",
  "tidegrid.email_sweep.canceled_count",
  "tidegrid.email_sweep.failed_tenant_count",
  "tidegrid.email_sweep.complete",
  "tidegrid.email_sweep.turn_count",
  "tidegrid.email_sweep.pass_count",
  "tidegrid.email_sweep.deferred_tenant_count",
  "tidegrid.email_sweep.stamp_failure_count",
  "tidegrid.email_sweep.held_tenant_count",
  "tidegrid.email_sweep.account_fault",
  // Email events consumer (W1-EMAIL-EVENTS).
  "tidegrid.email_event.outcome",
  "tidegrid.email_event.type",
  "tidegrid.email_event.suppressed",
  "tidegrid.email_events.count",
  "tidegrid.email_events.attempts",
  // Custom hostname sweep (G2.14b).
  "tidegrid.hostname.reason",
  "tidegrid.hostname.refusal_code",
  "tidegrid.hostname.provider_hostname_id",
  "tidegrid.hostname_sweep.tenant_count",
  "tidegrid.hostname_sweep.checked_count",
  "tidegrid.hostname_sweep.demoted_count",
  "tidegrid.hostname_sweep.expired_count",
  "tidegrid.hostname_sweep.unread_count",
  "tidegrid.hostname_sweep.failed_tenant_count",
  "tidegrid.hostname_sweep.throttled",
  "tidegrid.hostname_sweep.provider_fault",
  "tidegrid.hostname_sweep.complete",
  "tidegrid.hostname_sweep.turn_count",
  "tidegrid.hostname_sweep.pass_count",
  "tidegrid.hostname_sweep.deferred_tenant_count",
  "tidegrid.hostname_sweep.stamp_failure_count",
  "tidegrid.hostname_sweep.expiry_only_turn_count",
  "tidegrid.hostname_sweep.provider_call_count",
  "tidegrid.hostname_sweep.retry_after_seconds",
  // Delivery foundation (W3-G2.3): ids and counts only, never a payload.
  "tidegrid.outbox.id",
  "tidegrid.outbox.topic",
  "tidegrid.outbox.aggregate_type",
  "tidegrid.outbox.aggregate_id",
  "tidegrid.outbox.handler",
  "tidegrid.outbox.reason",
  "tidegrid.outbox.dead_letter_source",
  "tidegrid.outbox.dead_letter_result",
  "tidegrid.outbox.attempts",
  "tidegrid.outbox.handler_count",
  "tidegrid.outbox.queue_dlq",
  "tidegrid.outbox_publish.tenant_count",
  "tidegrid.outbox_publish.published_count",
  "tidegrid.outbox_publish.resent_count",
  "tidegrid.outbox_publish.dead_lettered_count",
  "tidegrid.outbox_publish.send_failure_count",
  "tidegrid.outbox_publish.failed_tenant_count",
  "tidegrid.outbox_publish.turn_count",
  "tidegrid.outbox_publish.pass_count",
  "tidegrid.outbox_publish.deferred_tenant_count",
  "tidegrid.outbox_publish.stamp_failure_count",
  "tidegrid.outbox_publish.stopped",
  "tidegrid.outbox_publish.complete",
  "tidegrid.delivery_cleanup.idempotency_keys_deleted",
  "tidegrid.delivery_cleanup.quotes_deleted",
  // Dock QR lookup retention (0050).
  "tidegrid.dock_lookup_cleanup.deleted_count",
  "tidegrid.dock_lookup_cleanup.redacted_count",
  // Waiver reminder sweep (W1-G215-REMINDERS).
  "tidegrid.waiver_reminder_sweep.tenant_count",
  "tidegrid.waiver_reminder_sweep.queued_count",
  "tidegrid.waiver_reminder_sweep.skipped_count",
  "tidegrid.waiver_reminder_sweep.failed_tenant_count",
  "tidegrid.waiver_reminder_sweep.complete",
  "tidegrid.waiver_reminder_sweep.turn_count",
  "tidegrid.waiver_reminder_sweep.pass_count",
  "tidegrid.waiver_reminder_sweep.deferred_tenant_count",
  "tidegrid.waiver_reminder_sweep.stamp_failure_count",
  // Import waiver email sweep (W3-G2.13, part D2).
  "tidegrid.import_waiver_email_sweep.tenant_count",
  "tidegrid.import_waiver_email_sweep.booking_count",
  "tidegrid.import_waiver_email_sweep.queued_count",
  "tidegrid.import_waiver_email_sweep.run_id",
  "tidegrid.import_waiver_email_sweep.booking_id",
  "tidegrid.import_waiver_email_sweep.failed_booking_count",
  "tidegrid.import_waiver_email_sweep.capped_tenant_count",
  "tidegrid.import_waiver_email_sweep.failed_tenant_count",
  "tidegrid.import_waiver_email_sweep.complete",
  "tidegrid.import_waiver_email_sweep.turn_count",
  "tidegrid.import_waiver_email_sweep.pass_count",
  "tidegrid.import_waiver_email_sweep.deferred_tenant_count",
  "tidegrid.import_waiver_email_sweep.stamp_failure_count",
  // Reconciliation sweep (W3-G2.10).
  "tidegrid.reconciliation_sweep.tenant_count",
  "tidegrid.reconciliation_sweep.assessed_count",
  "tidegrid.reconciliation_sweep.invoiced_count",
  "tidegrid.reconciliation_sweep.payments_checked_count",
  "tidegrid.reconciliation_sweep.payments_raised_count",
  "tidegrid.reconciliation_sweep.failed_tenant_count",
  "tidegrid.reconciliation_sweep.complete",
  "tidegrid.reconciliation_sweep.turn_count",
  "tidegrid.reconciliation_sweep.pass_count",
  "tidegrid.reconciliation_sweep.deferred_tenant_count",
  "tidegrid.reconciliation_sweep.stamp_failure_count",
]);

const tokenLike = /^[A-Za-z0-9_-]{24,}$/;
const uuidLike = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Replace path segments that look like bearer material. Routes are designed so
 * tokens travel in fragments, bodies, and cookies, never paths; this is the
 * backstop if one ever does. UUID identifiers are kept for correlation.
 */
export function redactPath(path: string): string {
  return path
    .split("/")
    .map((segment) => (tokenLike.test(segment) && !uuidLike.test(segment) ? ":redacted" : segment))
    .join("/");
}

export function redact(attrs: Record<string, unknown>): RequestAttributes {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(attrs)) {
    if (!allowedKeys.has(k as keyof RequestAttributes) || v === undefined) continue;
    out[k] = k === "url.path" && typeof v === "string" ? redactPath(v) : v;
  }
  return out as RequestAttributes;
}

export interface Logger {
  debug(message: string, attrs?: Record<string, unknown>): void;
  info(message: string, attrs?: Record<string, unknown>): void;
  warn(message: string, attrs?: Record<string, unknown>): void;
  error(message: string, attrs?: Record<string, unknown>): void;
  child(attrs: Record<string, unknown>): Logger;
}

export function createLogger(
  base: Record<string, unknown> = {},
  sink: (line: string) => void = (line) => console.log(line),
): Logger {
  const baseAttrs = redact(base);
  const emit = (level: LogLevel, message: string, attrs?: Record<string, unknown>) => {
    sink(
      JSON.stringify({
        level,
        message,
        time: new Date().toISOString(),
        ...baseAttrs,
        ...(attrs ? redact(attrs) : {}),
      }),
    );
  };
  return {
    debug: (m, a) => emit("debug", m, a),
    info: (m, a) => emit("info", m, a),
    warn: (m, a) => emit("warn", m, a),
    error: (m, a) => emit("error", m, a),
    child: (attrs) => createLogger({ ...baseAttrs, ...attrs }, sink),
  };
}

export function newRequestId(): string {
  return crypto.randomUUID();
}
