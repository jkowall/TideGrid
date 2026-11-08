/**
 * The delivery foundation (W3-G2.3): outbox publication to a queue, an
 * idempotent consumer, dead letters, replay, and cleanup.
 *
 * PostgreSQL stays the record of truth. A queue message is a hint that names
 * one outbox event by tenant and id; it carries no payload. The consumer reads
 * the event in that tenant's own transaction and runs each handler that has no
 * outcome yet, writing the outcome row in the handler's transaction. So a
 * duplicate message, a retry, or a replay runs each handler at most once per
 * committed outcome (at-least-once delivery, idempotent handlers: coordinator
 * default D1). A handler with an effect outside the database, such as a log
 * line, may repeat that effect if the process dies between the effect and the
 * commit.
 *
 * The publisher runs on the cron. It sends due events, and sends again an
 * event published long ago and never delivered (a lost hint), until the event
 * has been sent `maxPublishAttempts` times; then it records a dead letter
 * instead. The cron's other sweeps stay as the backstop for the work they
 * already do, so a stopped queue delays only the new handlers.
 */
import { type Kysely, sql } from "kysely";
import { recordAudit } from "./audit.ts";
import { recordSweepTurn, runFairSweep } from "./fair-sweep.ts";
import {
  inTenantTransaction,
  isUuid,
  type TenantContext,
  type TenantTransaction,
} from "./tenant.ts";
import type { Database, DeadLetterSource, JsonObject } from "./types.ts";

/** The queue message body. Version 1: ids only, never the payload. */
export interface DeliveryMessage {
  v: 1;
  tenantId: string;
  /** The outbox event id, a decimal string (the column is bigint). */
  outboxId: string;
  topic: string;
}

const outboxIdPattern = /^[1-9][0-9]{0,18}$/;
const topicPattern = /^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$/;
const handlerPattern = /^[a-z][a-z0-9_]{0,62}$/;
const errorCodePattern = /^[A-Za-z0-9_.:-]{1,120}$/;

/** A message body this code wrote, or null for anything else. */
export function parseDeliveryMessage(body: unknown): DeliveryMessage | null {
  if (body === null || typeof body !== "object" || Array.isArray(body)) return null;
  const b = body as Record<string, unknown>;
  if (b.v !== 1) return null;
  if (!isUuid(b.tenantId)) return null;
  if (typeof b.outboxId !== "string" || !outboxIdPattern.test(b.outboxId)) return null;
  if (typeof b.topic !== "string" || !topicPattern.test(b.topic)) return null;
  return { v: 1, tenantId: b.tenantId, outboxId: b.outboxId, topic: b.topic };
}

/** A short, safe error code for a column or a log: the error's name or SQLSTATE. */
export function deliveryErrorCode(error: unknown): string {
  if (error instanceof DeliveryHandlerError) return error.code;
  const code = (error as { code?: unknown } | null)?.code;
  const candidate =
    typeof code === "string" && code.length > 0
      ? `pg:${code}`
      : error instanceof Error
        ? error.name
        : "unknown";
  return errorCodePattern.test(candidate) ? candidate : "unknown";
}

/** The event a handler sees. */
export interface DeliveredEvent {
  tenantId: string;
  outboxId: string;
  topic: string;
  aggregateType: string;
  aggregateId: string;
  payload: JsonObject;
  createdAt: Date;
}

/**
 * One consumer of outbox events. `handle` runs inside the tenant transaction
 * that also records its outcome, so its database writes and the outcome
 * commit together or not at all. It must not throw for an event it decides
 * to ignore; throwing means "try again later".
 */
export interface DeliveryHandler {
  /** Lowercase, 1 to 63 characters: the outcome row's key. Never rename one. */
  name: string;
  topics: readonly string[];
  handle(trx: TenantTransaction, ctx: TenantContext, event: DeliveredEvent): Promise<void>;
}

/** One or more handlers threw; the first one's name and code are kept. */
export class DeliveryHandlerError extends Error {
  readonly handler: string;
  readonly code: string;
  constructor(handler: string, code: string) {
    super(`delivery handler ${handler} failed (${code})`);
    this.name = "DeliveryHandlerError";
    this.handler = handler;
    this.code = code;
  }
}

export type ConsumeOutcome =
  /** Every matching handler has an outcome now; `ran` lists the ones that ran this time. */
  | { kind: "delivered"; ran: string[] }
  /** No event with that id in that tenant (or a topic that does not match). */
  | { kind: "missing" };

function validateHandlers(handlers: readonly DeliveryHandler[]): void {
  const seen = new Set<string>();
  for (const h of handlers) {
    if (!handlerPattern.test(h.name)) throw new TypeError(`bad handler name ${h.name}`);
    if (seen.has(h.name)) throw new TypeError(`duplicate handler name ${h.name}`);
    seen.add(h.name);
  }
}

const lockKey = (tenantId: string, outboxId: string) => `tidegrid.outbox:${tenantId}:${outboxId}`;

/**
 * Consume one message. Each matching handler without an outcome runs in its
 * own tenant transaction, which first takes a lock on the event so that two
 * deliveries of the same message never run one handler twice. A handler that
 * throws does not stop the others; after all have had their turn, the first
 * failure is thrown as a DeliveryHandlerError and the caller retries. When
 * every matching handler has an outcome, the event is marked delivered.
 */
export async function consumeDelivery(
  db: Kysely<Database>,
  message: DeliveryMessage,
  handlers: readonly DeliveryHandler[],
  options: { runId?: string | null } = {},
): Promise<ConsumeOutcome> {
  validateHandlers(handlers);
  const ctx: TenantContext = {
    tenantId: message.tenantId,
    actorType: "system",
    actorId: "outbox-consumer",
    requestId: options.runId ?? null,
  };
  const row = await inTenantTransaction(db, ctx, (trx) =>
    trx
      .selectFrom("outbox_events")
      .select(["id", "topic", "aggregate_type", "aggregate_id", "payload", "created_at"])
      .where("tenant_id", "=", ctx.tenantId)
      .where("id", "=", message.outboxId)
      .executeTakeFirst(),
  );
  // The topic in the message is a hint only; the row decides. A mismatch
  // means the message is not about this event.
  if (!row || row.topic !== message.topic) return { kind: "missing" };
  const event: DeliveredEvent = {
    tenantId: ctx.tenantId,
    outboxId: String(row.id),
    topic: row.topic,
    aggregateType: row.aggregate_type,
    aggregateId: row.aggregate_id,
    payload: (row.payload ?? {}) as JsonObject,
    createdAt: new Date(row.created_at),
  };
  const matching = handlers.filter((h) => h.topics.includes(event.topic));
  const ran: string[] = [];
  let failure: DeliveryHandlerError | null = null;
  for (const handler of matching) {
    try {
      const didRun = await inTenantTransaction(db, ctx, async (trx) => {
        await sql`select pg_advisory_xact_lock(hashtextextended(${lockKey(ctx.tenantId, event.outboxId)}, 0))`.execute(
          trx,
        );
        const done = await trx
          .selectFrom("outbox_deliveries")
          .select("handler")
          .where("tenant_id", "=", ctx.tenantId)
          .where("outbox_event_id", "=", event.outboxId)
          .where("handler", "=", handler.name)
          .executeTakeFirst();
        if (done) return false;
        await handler.handle(trx, ctx, event);
        await trx
          .insertInto("outbox_deliveries")
          .values({
            tenant_id: ctx.tenantId,
            outbox_event_id: event.outboxId,
            handler: handler.name,
            request_id: ctx.requestId ?? null,
          })
          .execute();
        return true;
      });
      if (didRun) ran.push(handler.name);
    } catch (error) {
      failure ??= new DeliveryHandlerError(handler.name, deliveryErrorCode(error));
    }
  }
  if (failure) throw failure;
  await inTenantTransaction(db, ctx, (trx) =>
    trx
      .updateTable("outbox_events")
      .set({ delivered_at: sql<Date>`clock_timestamp()`, last_error: null })
      .where("tenant_id", "=", ctx.tenantId)
      .where("id", "=", event.outboxId)
      .where("delivered_at", "is", null)
      .where("published_at", "is not", null)
      .execute(),
  );
  return { kind: "delivered", ran };
}

export interface DeadLetterInput {
  handler?: string | null;
  errorCode: string;
  attempts: number;
  source: DeadLetterSource;
}

/**
 * Record a dead letter for one message, in its tenant's transaction. At most
 * one is open per event: a second report while one is open changes nothing.
 * Returns "recorded", "already_open", or "missing" (no such event).
 */
export async function recordDeadLetter(
  db: Kysely<Database>,
  message: DeliveryMessage,
  input: DeadLetterInput,
  options: { runId?: string | null } = {},
): Promise<"recorded" | "already_open" | "missing"> {
  const ctx: TenantContext = {
    tenantId: message.tenantId,
    actorType: "system",
    actorId: "outbox-consumer",
    requestId: options.runId ?? null,
  };
  const handler = input.handler && handlerPattern.test(input.handler) ? input.handler : null;
  const errorCode = errorCodePattern.test(input.errorCode) ? input.errorCode : "unknown";
  return inTenantTransaction(db, ctx, async (trx) => {
    const row = await trx
      .selectFrom("outbox_events")
      .select(["topic"])
      .where("tenant_id", "=", ctx.tenantId)
      .where("id", "=", message.outboxId)
      .executeTakeFirst();
    if (!row) return "missing";
    const inserted = await sql<{ id: string }>`
      insert into outbox_dead_letters
        (tenant_id, outbox_event_id, topic, handler, error_code, attempts, source)
      values (${ctx.tenantId}, ${message.outboxId}, ${row.topic}, ${handler}, ${errorCode},
              ${Math.max(0, Math.trunc(input.attempts))}, ${input.source})
      on conflict (tenant_id, outbox_event_id) where replayed_at is null do nothing
      returning id`.execute(trx);
    await trx
      .updateTable("outbox_events")
      .set({ last_error: `dead_letter:${errorCode}`.slice(0, 120) })
      .where("tenant_id", "=", ctx.tenantId)
      .where("id", "=", message.outboxId)
      .execute();
    return inserted.rows.length > 0 ? "recorded" : "already_open";
  });
}

export interface DeadLetterRow {
  tenantId: string;
  id: string;
  outboxId: string;
  topic: string;
  handler: string | null;
  errorCode: string;
  attempts: number;
  source: DeadLetterSource;
  deadLetteredAt: Date;
}

/** Open dead letters across tenants, oldest first within each tenant. */
export async function listDeadLetters(
  db: Kysely<Database>,
  options: { tenantLimit?: number; perTenant?: number; runId?: string | null } = {},
): Promise<DeadLetterRow[]> {
  const { rows: tenants } = await sql<{ tenant_id: string }>`
    select tenant_id from app.outbox_dead_letter_tenants(${options.tenantLimit ?? 100})`.execute(
    db,
  );
  const out: DeadLetterRow[] = [];
  for (const { tenant_id } of tenants) {
    const ctx: TenantContext = {
      tenantId: tenant_id,
      actorType: "system",
      actorId: "outbox-dead-letters",
      requestId: options.runId ?? null,
    };
    const rows = await inTenantTransaction(db, ctx, (trx) =>
      trx
        .selectFrom("outbox_dead_letters")
        .select([
          "id",
          "outbox_event_id",
          "topic",
          "handler",
          "error_code",
          "attempts",
          "source",
          "dead_lettered_at",
        ])
        .where("tenant_id", "=", tenant_id)
        .where("replayed_at", "is", null)
        .orderBy("id")
        .limit(Math.max(1, Math.min(options.perTenant ?? 100, 1000)))
        .execute(),
    );
    for (const r of rows)
      out.push({
        tenantId: tenant_id,
        id: String(r.id),
        outboxId: String(r.outbox_event_id),
        topic: r.topic,
        handler: r.handler,
        errorCode: r.error_code,
        attempts: r.attempts,
        source: r.source,
        deadLetteredAt: new Date(r.dead_lettered_at),
      });
  }
  return out;
}

/** The replay was refused; `code` says why. */
export class ReplayRefusedError extends Error {
  readonly code: "not_found" | "already_replayed" | "bad_reason";
  constructor(code: "not_found" | "already_replayed" | "bad_reason") {
    super(`replay refused: ${code}`);
    this.name = "ReplayRefusedError";
    this.code = code;
  }
}

/**
 * Replay one open dead letter: close it with the reason (the trigger stamps
 * who and when), write an audit row, and make its event due for publication
 * again. Only handlers with no outcome run when it is delivered. The caller's
 * context names the actor; it must not be the consumer itself.
 */
export async function replayDeadLetter(
  db: Kysely<Database>,
  ctx: TenantContext,
  input: { deadLetterId: string; reason: string },
): Promise<{ outboxId: string; topic: string }> {
  const reason = input.reason.trim();
  // The CHECK's rule, so a bad reason fails before any write.
  // biome-ignore lint/suspicious/noControlCharactersInRegex: control characters are what it refuses
  if (reason.length < 1 || reason.length > 500 || /[\u0000-\u001f\u007f-\u009f]/.test(reason)) {
    throw new ReplayRefusedError("bad_reason");
  }
  if (!outboxIdPattern.test(input.deadLetterId)) throw new ReplayRefusedError("not_found");
  return inTenantTransaction(db, ctx, async (trx) => {
    const letter = await trx
      .selectFrom("outbox_dead_letters")
      .select(["id", "outbox_event_id", "topic", "handler", "error_code", "replayed_at"])
      .where("tenant_id", "=", ctx.tenantId)
      .where("id", "=", input.deadLetterId)
      .forUpdate()
      .executeTakeFirst();
    if (!letter) throw new ReplayRefusedError("not_found");
    if (letter.replayed_at !== null) throw new ReplayRefusedError("already_replayed");
    await trx
      .updateTable("outbox_dead_letters")
      .set({ replay_reason: reason })
      .where("tenant_id", "=", ctx.tenantId)
      .where("id", "=", input.deadLetterId)
      .execute();
    await trx
      .updateTable("outbox_events")
      .set({
        published_at: null,
        delivered_at: null,
        available_at: sql<Date>`clock_timestamp()`,
        attempts: 0,
        last_error: null,
      })
      .where("tenant_id", "=", ctx.tenantId)
      .where("id", "=", String(letter.outbox_event_id))
      .execute();
    await recordAudit(trx, ctx, {
      action: "outbox.dead_letter.replayed",
      subjectType: "outbox_dead_letter",
      subjectId: String(letter.id),
      reason,
      before: {
        outboxEventId: String(letter.outbox_event_id),
        topic: letter.topic,
        handler: letter.handler,
        errorCode: letter.error_code,
      },
      after: { replayed: true },
    });
    return { outboxId: String(letter.outbox_event_id), topic: letter.topic };
  });
}

/** Sends one batch of messages to the queue; throws when the queue refuses. */
export type DeliverySender = (messages: readonly DeliveryMessage[]) => Promise<void>;

export interface PublishOptions {
  send: DeliverySender;
  runId?: string | null;
  /** Events per tenant turn; at most 100, a queue batch's limit. Default 100. */
  batchSize?: number;
  tenantLimit?: number;
  budgetMs?: number;
  clock?: () => number;
  /** A published event is a lost hint after this many seconds. Default 900. */
  lostAfterSeconds?: number;
  /** Sends before an undelivered event becomes a dead letter. Default 10. */
  maxPublishAttempts?: number;
  onTenantError?: (tenantId: string, error: unknown) => void;
  onStampError?: (tenantId: string, error: unknown) => void;
  onDeadLetter?: (message: DeliveryMessage) => void;
}

export interface PublishReport {
  tenants: number;
  published: number;
  resent: number;
  deadLettered: number;
  sendFailures: number;
  failedTenants: number;
  turns: number;
  passes: number;
  deferredTenants: number;
  stampFailures: number;
  /** The queue refused a send; the run stopped early. */
  stopped: boolean;
  complete: boolean;
}

export const DEFAULT_PUBLISH_BATCH_SIZE = 100;
export const DEFAULT_LOST_AFTER_SECONDS = 900;
export const DEFAULT_MAX_PUBLISH_ATTEMPTS = 10;

/** Seconds to wait after the queue refused a send: 30 s doubling to 15 minutes. */
export function publishBackoffSeconds(attempts: number): number {
  return Math.min(900, 30 * 2 ** Math.max(0, Math.min(attempts, 10) - 1));
}

/**
 * Publish due outbox events across tenants, one tenant transaction per batch,
 * with the fair turns the other sweeps use (0013). Rows are locked with SKIP
 * LOCKED, so two overlapping runs never send the same row in the same moment.
 * A row is marked published only after the queue accepted the batch; if the
 * process dies between the two, the row is sent again and the consumer's
 * outcome rows make that harmless.
 */
export async function publishOutbox(
  db: Kysely<Database>,
  options: PublishOptions,
): Promise<PublishReport> {
  const clock = options.clock ?? Date.now;
  const started = clock();
  const batchSize = Math.max(1, Math.min(options.batchSize ?? DEFAULT_PUBLISH_BATCH_SIZE, 100));
  const tenantLimit = options.tenantLimit ?? 100;
  const lostAfter = Math.max(
    60,
    Math.min(options.lostAfterSeconds ?? DEFAULT_LOST_AFTER_SECONDS, 86_400),
  );
  const maxAttempts = Math.max(1, options.maxPublishAttempts ?? DEFAULT_MAX_PUBLISH_ATTEMPTS);
  const contextOf = (tenantId: string): TenantContext => ({
    tenantId,
    actorType: "system",
    actorId: "outbox-publisher",
    requestId: options.runId ?? null,
  });
  let published = 0;
  let resent = 0;
  let deadLettered = 0;
  let sendFailures = 0;

  const fair = await runFairSweep({
    listTenants: async () => {
      const { rows } = await sql<{ tenant_id: string }>`
        select tenant_id from app.outbox_publish_tenants(${tenantLimit}, ${lostAfter})`.execute(db);
      return rows.map((r) => r.tenant_id);
    },
    tenantLimit,
    stamp: (tenantId) => recordSweepTurn(db, contextOf(tenantId), "outbox"),
    turn: async (tenantId) => {
      const ctx = contextOf(tenantId);
      return inTenantTransaction(db, ctx, async (trx) => {
        const { rows } = await sql<{
          id: string;
          topic: string;
          attempts: number;
          resend: boolean;
          open_letter: boolean;
        }>`
          select o.id::text as id, o.topic, o.attempts, (o.published_at is not null) as resend,
                 exists (select 1 from outbox_dead_letters d
                          where d.tenant_id = o.tenant_id and d.outbox_event_id = o.id
                            and d.replayed_at is null) as open_letter
            from outbox_events o
           where o.tenant_id = ${tenantId}
             and ((o.published_at is null and o.available_at <= now())
                  or (o.published_at is not null and o.delivered_at is null
                      and o.published_at <= now() - make_interval(secs => ${lostAfter})))
           order by o.id
           limit ${batchSize}
             for update skip locked`.execute(trx);
        const due = rows.filter((r) => !r.open_letter);
        if (due.length === 0) return { units: 0, more: false };
        // An event sent too often without a delivery stops being sent: the
        // consumer never saw it, or never finished, and someone must look.
        const exhausted = due.filter((r) => r.attempts >= maxAttempts);
        const sendable = due.filter((r) => r.attempts < maxAttempts);
        for (const r of exhausted) {
          await sql`
            insert into outbox_dead_letters
              (tenant_id, outbox_event_id, topic, handler, error_code, attempts, source)
            values (${tenantId}, ${r.id}, ${r.topic}, null, 'publish_attempts_exhausted',
                    ${r.attempts}, 'publisher')
            on conflict (tenant_id, outbox_event_id) where replayed_at is null do nothing`.execute(
            trx,
          );
          await trx
            .updateTable("outbox_events")
            .set({ last_error: "dead_letter:publish_attempts_exhausted" })
            .where("tenant_id", "=", tenantId)
            .where("id", "=", r.id)
            .execute();
          deadLettered += 1;
          options.onDeadLetter?.({ v: 1, tenantId, outboxId: r.id, topic: r.topic });
        }
        if (sendable.length === 0)
          return { units: exhausted.length, more: rows.length >= batchSize };
        const ids = sendable.map((r) => r.id);
        try {
          await options.send(
            sendable.map((r) => ({ v: 1, tenantId, outboxId: r.id, topic: r.topic })),
          );
        } catch (error) {
          sendFailures += 1;
          const code = `send_failed:${deliveryErrorCode(error)}`.slice(0, 120);
          // Not published: wait, then try again. Lost-hint rows keep their
          // published time, so they are due again at the same moment.
          for (const r of sendable) {
            const wait = publishBackoffSeconds(r.attempts + 1);
            await sql`
              update outbox_events
                 set attempts = attempts + 1, last_error = ${code},
                     available_at = now() + make_interval(secs => ${wait})
               where tenant_id = ${tenantId} and id = ${r.id}`.execute(trx);
          }
          return { units: sendable.length, more: false, stop: true };
        }
        await sql`
          update outbox_events
             set published_at = clock_timestamp(), attempts = attempts + 1, last_error = null
           where tenant_id = ${tenantId} and id = any(${ids}::bigint[])`.execute(trx);
        for (const r of sendable) {
          if (r.resend) resent += 1;
          else published += 1;
        }
        return { units: due.length, more: rows.length >= batchSize };
      });
    },
    budgetMs: options.budgetMs ?? 20_000,
    clock,
    startedAt: started,
    onTenantError: (tenantId, error, during) => {
      if (during === "stamp" && options.onStampError) options.onStampError(tenantId, error);
      else options.onTenantError?.(tenantId, error);
    },
  });
  return {
    tenants: fair.tenants,
    published,
    resent,
    deadLettered,
    sendFailures,
    failedTenants: fair.failedTenants,
    turns: fair.turns,
    passes: fair.passes,
    deferredTenants: fair.deferredTenants,
    stampFailures: fair.stampFailures,
    stopped: fair.stopped,
    complete: fair.complete,
  };
}

export interface CleanupReport {
  idempotencyKeysDeleted: number;
  quotesDeleted: number;
}

/**
 * Remove completed idempotency keys and unused quotes a week past their
 * expiry, through app.delivery_cleanup. The runtime holds no DELETE; the
 * definer function deletes only those rows.
 */
export async function runDeliveryCleanup(
  db: Kysely<Database>,
  options: { limit?: number } = {},
): Promise<CleanupReport> {
  const { rows } = await sql<{ idempotency_keys_deleted: number; quotes_deleted: number }>`
    select idempotency_keys_deleted, quotes_deleted
      from app.delivery_cleanup(${options.limit ?? 1000})`.execute(db);
  const row = rows[0];
  return {
    idempotencyKeysDeleted: row?.idempotency_keys_deleted ?? 0,
    quotesDeleted: row?.quotes_deleted ?? 0,
  };
}
