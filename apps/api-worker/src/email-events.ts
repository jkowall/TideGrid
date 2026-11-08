import { createDb, type Database } from "@tidegrid/database";
import { emailEventsConfig, type IngestResult, ingestEmailEvent } from "@tidegrid/domain-messaging";
import { createLogger, newRequestId } from "@tidegrid/observability";
import type { Kysely } from "kysely";
import { DEFAULT_FROM_ADDRESS } from "./email.ts";
import { type Bindings, databaseUrl } from "./env.ts";

/**
 * The email events consumer (W1-EMAIL-EVENTS). Cloudflare publishes Email
 * Sending events (delivered, bounced, complained, and so on) to a queue named
 * by an event subscription; this Worker consumes that queue. Nothing in the
 * repository declares the queue, its consumer, or the subscription: the live
 * step is the owner's, and until then this code never runs in a deployment.
 *
 * Which queue: EMAIL_EVENTS_QUEUE names it. A batch from any other queue is
 * left to the Worker's other consumers (see src/index.ts).
 *
 * Whose events: EMAIL_EVENTS_ACCOUNT_ID (the account's id, a secret so it
 * never enters the repository) and the sending domain: the domain of
 * EMAIL_FROM_ADDRESS, or an operator's verified sending domain (0024, checked
 * in the database). An event from another account or domain is refused,
 * recorded nowhere, and retried, so a wrong setting sends real events to the
 * queue's dead-letter queue instead of dropping them. These checks are claims
 * in the event's body, not authentication: the queue's producers are the
 * trust boundary, so no other producer may be bound to it. Without a valid configuration
 * or a database, every message is retried, so the queue's retry and
 * dead-letter settings decide what happens to events while it is off.
 *
 * Each message is processed on its own: a database error retries that message
 * only, as does a refusal (above); every other outcome (applied, recorded,
 * duplicate, unmatched, ignored, invalid) is final and acknowledged. Logs carry the event's
 * type, the outcome, and the tenant and message ids it joined, never an
 * address, subject, or provider text.
 */

/** While the consumer is off (no account id or database): try again in ten minutes. */
const offDelaySeconds = 600;
/** Invalid reasons that mean "a shape this code does not know yet", not a bad event. */
const retriedReasons = new Set(["schema_version", "type_unknown", "source_invalid"]);

/** Backoff for a retried message: 30 s, doubling per attempt, at most an hour. */
export function retryDelaySeconds(attempts: number): number {
  const n = Math.max(1, Math.floor(attempts));
  return Math.min(3600, 30 * 2 ** Math.min(n - 1, 7));
}

/** The domain of the configured sender, lowercased; undefined when it has none. */
export function sendingDomain(env: Bindings): string | undefined {
  const from = env.EMAIL_FROM_ADDRESS || DEFAULT_FROM_ADDRESS;
  const at = from.lastIndexOf("@");
  return at === -1 ? undefined : from.slice(at + 1);
}

/** Whether this batch is the email events queue's. */
export function isEmailEventsBatch(batch: Pick<MessageBatch, "queue">, env: Bindings): boolean {
  const name = env.EMAIL_EVENTS_QUEUE?.trim();
  return !!name && batch.queue === name;
}

export interface ConsumeOptions {
  log?: (line: string) => void;
  /** A test's database; otherwise one connection from DATABASE_URL, closed after the batch. */
  db?: Kysely<Database>;
}

export async function consumeEmailEvents(
  batch: MessageBatch<unknown>,
  env: Bindings,
  options: ConsumeOptions = {},
): Promise<void> {
  const log = createLogger(
    {
      "tidegrid.request_id": newRequestId(),
      "tidegrid.environment": env.ENVIRONMENT,
      "event.name": "email_events",
    },
    options.log,
  );
  const config = emailEventsConfig(env.EMAIL_EVENTS_ACCOUNT_ID, sendingDomain(env));
  if (!config) {
    log.warn("email_events_unconfigured", { "tidegrid.email_events.count": batch.messages.length });
    batch.retryAll({ delaySeconds: offDelaySeconds });
    return;
  }
  let db = options.db;
  let end: (() => Promise<void>) | undefined;
  if (!db) {
    const url = databaseUrl(env);
    if (!url) {
      log.warn("email_events_skipped", { "error.type": "database_unconfigured" });
      batch.retryAll({ delaySeconds: offDelaySeconds });
      return;
    }
    const handle = createDb(url, { max: 1 });
    db = handle.db;
    end = () => handle.end();
  }
  try {
    for (const message of batch.messages) {
      let result: IngestResult;
      try {
        result = await ingestEmailEvent(db, config, message.body);
      } catch (error) {
        const code = (error as { code?: unknown } | null)?.code;
        log.error("email_event_failed", {
          "error.type": error instanceof Error ? error.name : "unknown",
          ...(typeof code === "string" ? { "db.response.status_code": code } : {}),
          "tidegrid.email_events.attempts": message.attempts,
        });
        message.retry({ delaySeconds: retryDelaySeconds(message.attempts) });
        continue;
      }
      const attrs = {
        "tidegrid.email_event.outcome": result.outcome,
        ...(result.eventType ? { "tidegrid.email_event.type": result.eventType } : {}),
        ...(result.reason ? { "error.type": result.reason } : {}),
        ...(result.tenantId ? { "tidegrid.tenant_id": result.tenantId } : {}),
        ...(result.messageId ? { "tidegrid.email.message_id": result.messageId } : {}),
        ...(result.suppressed ? { "tidegrid.email_event.suppressed": true } : {}),
      };
      if (result.outcome === "refused_account" || result.outcome === "refused_domain") {
        // Retried, not acknowledged: until the live payload is confirmed
        // (O-P7 A9), a wrong account id or domain setting would otherwise drop
        // every real event. The queue's retry limit and dead-letter queue keep
        // them for the owner to look at.
        log.warn("email_event_refused", attrs);
        message.retry({ delaySeconds: retryDelaySeconds(message.attempts) });
        continue;
      }
      // An event this code cannot read because its shape changed (a new
      // schema version, type, or source) is retried for the same reason; a
      // malformed one in a shape it knows is final.
      if (result.outcome === "invalid" && retriedReasons.has(result.reason ?? "")) {
        log.warn("email_event_refused", attrs);
        message.retry({ delaySeconds: retryDelaySeconds(message.attempts) });
        continue;
      }
      if (result.outcome === "invalid") {
        log.warn("email_event_refused", attrs);
      } else {
        log.info("email_event", attrs);
      }
      message.ack();
    }
  } finally {
    await end?.();
  }
}
