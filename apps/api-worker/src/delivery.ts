/**
 * The async side of the delivery foundation (W3-G2.3): the queue consumer, its
 * dead letter path, and the handlers it runs. The same Worker script serves
 * HTTP, the cron, and the queue; which deployment consumes the queue is set in
 * wrangler.jsonc, and only env.test declares the queue today.
 *
 * A message names one outbox event (see @tidegrid/database's delivery.ts).
 * The consumer acks it once every matching handler has an outcome. A failure
 * is retried with a growing delay; on its last attempt the consumer records a
 * dead letter in PostgreSQL and acks. If even that fails, the message is
 * retried, and the queue's own dead letter queue hands it to the DLQ consumer
 * here, which records the dead letter with source "queue".
 */
import {
  type ConsumeOutcome,
  consumeDelivery,
  createDb,
  type DeliveryHandler,
  DeliveryHandlerError,
  type DeliveryMessage,
  deliveryErrorCode,
  parseDeliveryMessage,
  recordDeadLetter,
} from "@tidegrid/database";
import { createLogger, newRequestId } from "@tidegrid/observability";
import { type Bindings, databaseUrl } from "./env.ts";

/** Attempts the consumer makes before it records a dead letter itself. */
export const MAX_CONSUMER_ATTEMPTS = 5;

/** Seconds before retry n (1-based): 30, 60, 120, 240, capped at 900. */
export function retryDelaySeconds(attempts: number): number {
  return Math.min(900, 30 * 2 ** Math.max(0, attempts - 1));
}

/** The DLQ's messages arrive on a queue whose name ends in -dlq. */
export function isDeadLetterQueue(queueName: string): boolean {
  return queueName.endsWith("-dlq");
}

type Log = ReturnType<typeof createLogger>;

/**
 * Topics an operator should hear about as soon as they happen: a booking that
 * could not be finalized, a refund the provider refused, a confirmation email
 * that failed. The handler writes one warning line with ids only. The cron
 * and the console already show these; the line is the early signal.
 */
export const OPS_ALERT_TOPICS = [
  "checkout.finalization_exception.raised",
  "payment.refund.failed",
  "booking.confirmation_email_failed",
] as const;

export function deliveryHandlers(log: Log): DeliveryHandler[] {
  return [
    {
      name: "ops_alert",
      topics: OPS_ALERT_TOPICS,
      handle: async (_trx, _ctx, event) => {
        log.warn("outbox_alert", {
          "tidegrid.tenant_id": event.tenantId,
          "tidegrid.outbox.id": event.outboxId,
          "tidegrid.outbox.topic": event.topic,
          "tidegrid.outbox.aggregate_type": event.aggregateType,
          "tidegrid.outbox.aggregate_id": event.aggregateId,
        });
      },
    },
  ];
}

/** What the queue handler needs from the database; tests pass fakes. */
export interface QueueDeps {
  consume: (message: DeliveryMessage, runId: string) => Promise<ConsumeOutcome>;
  deadLetter: (
    message: DeliveryMessage,
    input: {
      handler: string | null;
      errorCode: string;
      attempts: number;
      source: "consumer" | "queue";
    },
    runId: string,
  ) => Promise<"recorded" | "already_open" | "missing" | "delivered">;
}

/** One queue message, as much of Cloudflare's Message as this code uses. */
export interface QueueMessageLike {
  readonly body: unknown;
  readonly attempts: number;
  ack(): void;
  retry(options?: { delaySeconds?: number }): void;
}

export interface QueueBatchLike {
  readonly queue: string;
  readonly messages: readonly QueueMessageLike[];
}

function messageAttributes(m: DeliveryMessage): Record<string, unknown> {
  return {
    "tidegrid.tenant_id": m.tenantId,
    "tidegrid.outbox.id": m.outboxId,
    "tidegrid.outbox.topic": m.topic,
  };
}

/**
 * Handle one batch. Messages are handled one at a time and each is acked or
 * retried on its own, so one poison message never holds back the others.
 */
export async function handleDeliveryBatch(
  batch: QueueBatchLike,
  deps: QueueDeps,
  log: Log,
  runId: string,
): Promise<void> {
  const dlq = isDeadLetterQueue(batch.queue);
  for (const msg of batch.messages) {
    const message = parseDeliveryMessage(msg.body);
    if (!message) {
      // Not a body this code wrote: nothing to retry it into. Logged without
      // the body, which may hold anything.
      log.error("outbox_message_invalid", { "tidegrid.outbox.queue_dlq": dlq });
      msg.ack();
      continue;
    }
    if (dlq) {
      try {
        const result = await deps.deadLetter(
          message,
          {
            handler: null,
            errorCode: "queue_retries_exhausted",
            attempts: msg.attempts,
            source: "queue",
          },
          runId,
        );
        log.error("outbox_dead_lettered", {
          ...messageAttributes(message),
          "tidegrid.outbox.dead_letter_source": "queue",
          "tidegrid.outbox.dead_letter_result": result,
        });
        msg.ack();
      } catch (error) {
        log.error("outbox_dead_letter_failed", {
          ...messageAttributes(message),
          "error.type": deliveryErrorCode(error),
        });
        msg.retry({ delaySeconds: retryDelaySeconds(msg.attempts) });
      }
      continue;
    }
    try {
      const outcome = await deps.consume(message, runId);
      if (outcome.kind === "missing") {
        log.warn("outbox_event_missing", messageAttributes(message));
      } else if (outcome.kind === "parked") {
        // A late or duplicate hint for a dead-lettered event: the replay
        // command is the only way it runs again.
        log.warn("outbox_event_parked", messageAttributes(message));
      } else if (outcome.ran.length > 0) {
        log.info("outbox_delivered", {
          ...messageAttributes(message),
          "tidegrid.outbox.handler_count": outcome.ran.length,
        });
      }
      msg.ack();
    } catch (error) {
      const handler = error instanceof DeliveryHandlerError ? error.handler : null;
      const errorCode = deliveryErrorCode(error);
      if (msg.attempts < MAX_CONSUMER_ATTEMPTS) {
        log.warn("outbox_delivery_retry", {
          ...messageAttributes(message),
          ...(handler ? { "tidegrid.outbox.handler": handler } : {}),
          "error.type": errorCode,
          "tidegrid.outbox.attempts": msg.attempts,
        });
        msg.retry({ delaySeconds: retryDelaySeconds(msg.attempts) });
        continue;
      }
      try {
        const result = await deps.deadLetter(
          message,
          { handler, errorCode, attempts: msg.attempts, source: "consumer" },
          runId,
        );
        log.error("outbox_dead_lettered", {
          ...messageAttributes(message),
          ...(handler ? { "tidegrid.outbox.handler": handler } : {}),
          "error.type": errorCode,
          "tidegrid.outbox.attempts": msg.attempts,
          "tidegrid.outbox.dead_letter_source": "consumer",
          "tidegrid.outbox.dead_letter_result": result,
        });
        msg.ack();
      } catch (recordError) {
        // The database is unreachable too. Retry; after the queue's own
        // max_retries the DLQ consumer records it.
        log.error("outbox_dead_letter_failed", {
          ...messageAttributes(message),
          "error.type": deliveryErrorCode(recordError),
        });
        msg.retry({ delaySeconds: retryDelaySeconds(msg.attempts) });
      }
    }
  }
}

/** The Worker's queue entry: one connection per batch. */
export async function runQueue(
  batch: QueueBatchLike,
  env: Bindings,
  options: { log?: (line: string) => void; deps?: QueueDeps } = {},
): Promise<void> {
  const runId = newRequestId();
  const log = createLogger(
    {
      "tidegrid.request_id": runId,
      "tidegrid.environment": env.ENVIRONMENT,
      "event.name": "outbox_consumer",
    },
    options.log,
  );
  if (options.deps) {
    await handleDeliveryBatch(batch, options.deps, log, runId);
    return;
  }
  const url = databaseUrl(env);
  if (!url) {
    // Nothing can be recorded. Retry every message; the queue's DLQ takes
    // them in the end, and the outbox rows wait for the lost-hint resend.
    log.error("outbox_consumer_skipped", { "error.type": "database_unconfigured" });
    for (const m of batch.messages) m.retry({ delaySeconds: retryDelaySeconds(m.attempts) });
    return;
  }
  const handle = createDb(url, { max: 1 });
  try {
    const handlers = deliveryHandlers(log);
    await handleDeliveryBatch(
      batch,
      {
        consume: (message, id) => consumeDelivery(handle.db, message, handlers, { runId: id }),
        deadLetter: (message, input, id) =>
          recordDeadLetter(handle.db, message, input, { runId: id }),
      },
      log,
      runId,
    );
  } finally {
    await handle.end();
  }
}

/** The publisher's sender for a Cloudflare queue binding. */
export function queueSender(queue: Queue): (messages: readonly DeliveryMessage[]) => Promise<void> {
  return async (messages) => {
    if (messages.length === 0) return;
    await queue.sendBatch(messages.map((body) => ({ body, contentType: "json" as const })));
  };
}
