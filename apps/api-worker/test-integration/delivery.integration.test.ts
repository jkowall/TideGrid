/**
 * The delivery foundation (W3-G2.3) against real PostgreSQL: the cron
 * publishes outbox events to a queue, the consumer runs each handler once,
 * duplicates and concurrent deliveries change nothing, a poison message lands
 * in a dead letter, a reviewed replay runs only the missing handler, a lost
 * hint is sent again, a refused send waits, and cleanup removes only expired,
 * unused rows. The queue is an in-memory stand-in here; the Workers test
 * runtime suite (test/delivery-queue.test.ts) drives the same handler through
 * Miniflare's queue.
 */
import { randomUUID } from "node:crypto";
import {
  consumeDelivery,
  createDb,
  type DeliveryHandler,
  type DeliveryMessage,
  enqueueOutbox,
  inTenantTransaction,
  listDeadLetters,
  publishOutbox,
  ReplayRefusedError,
  recordDeadLetter,
  replayDeadLetter,
  type TenantContext,
} from "@tidegrid/database";
import type {} from "@tidegrid/database/global-setup";
import { createCheckoutSession, ensureProviderPayment } from "@tidegrid/domain-booking";
import {
  type CheckoutFixture,
  createCheckoutFixture,
  fakeProvider,
  guestContext,
  newSecret,
  quoteFor,
} from "@tidegrid/domain-booking/testing";
import { tripAllocator } from "@tidegrid/domain-inventory/testing";
import { FAKE_MINIMUM_AMOUNT } from "@tidegrid/domain-payments";
import { createLogger } from "@tidegrid/observability";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";
import { main as outboxDlq } from "../../../packages/database/src/outbox-dlq.ts";
import {
  handleDeliveryBatch,
  MAX_CONSUMER_ATTEMPTS,
  type QueueBatchLike,
  type QueueDeps,
  runQueue,
} from "../src/delivery.ts";
import type { Bindings } from "../src/env.ts";
import { runScheduled } from "../src/scheduled.ts";

type Sql = ReturnType<typeof postgres>;

const env = inject("integrationDb");

/** A queue message stand-in that records what the handler decided. */
function fakeMessage(body: unknown, attempts = 1) {
  const m = {
    body,
    attempts,
    acked: false,
    retried: null as null | { delaySeconds?: number },
    ack() {
      m.acked = true;
    },
    retry(options?: { delaySeconds?: number }) {
      m.retried = options ?? {};
    },
  };
  return m;
}

describe.skipIf(!env)("the delivery foundation (W3-G2.3)", () => {
  let admin: Sql;
  let runtime: ReturnType<typeof createDb>;
  let A: CheckoutFixture;
  let B: CheckoutFixture;
  let lines: string[] = [];
  const log = (line: string) => lines.push(line);
  const parsed = () => lines.map((l) => JSON.parse(l) as Record<string, unknown>);

  const sys = (tenantId: string): TenantContext => ({
    tenantId,
    actorType: "system",
    actorId: "delivery-test",
    requestId: `test-${randomUUID()}`,
  });

  async function enqueue(tenantId: string, topic: string): Promise<string> {
    const ctx = sys(tenantId);
    const aggregateId = `agg-${randomUUID()}`;
    await inTenantTransaction(runtime.db, ctx, (trx) =>
      enqueueOutbox(trx, ctx, {
        topic,
        aggregateType: "test",
        aggregateId,
        payload: { marker: aggregateId },
      }),
    );
    const [row] = await admin<{ id: string }[]>`
      select id::text from public.outbox_events where tenant_id = ${tenantId} and aggregate_id = ${aggregateId}`;
    if (!row) throw new Error("no outbox row");
    return row.id;
  }

  async function eventRow(tenantId: string, id: string) {
    const [row] = await admin<
      {
        published_at: Date | null;
        delivered_at: Date | null;
        attempts: number;
        last_error: string | null;
        available_at: Date;
      }[]
    >`select published_at, delivered_at, attempts, last_error, available_at
        from public.outbox_events where tenant_id = ${tenantId} and id = ${id}`;
    if (!row) throw new Error("no outbox row");
    return row;
  }

  async function deliveries(tenantId: string, id: string): Promise<string[]> {
    const rows = await admin<{ handler: string }[]>`
      select handler from public.outbox_deliveries
       where tenant_id = ${tenantId} and outbox_event_id = ${id} order by handler`;
    return rows.map((r) => r.handler);
  }

  /** A queue binding stand-in: keeps every message the cron sends. */
  function captureQueue() {
    const sent: DeliveryMessage[] = [];
    let refuse: Error | null = null;
    const queue = {
      send: async () => {
        throw new Error("the publisher sends batches");
      },
      sendBatch: async (batch: Iterable<{ body: DeliveryMessage }>) => {
        if (refuse) throw refuse;
        for (const m of batch) sent.push(m.body);
      },
    } as unknown as Queue;
    return {
      queue,
      sent,
      refuseWith: (e: Error | null) => {
        refuse = e;
      },
    };
  }

  const bindings = (queue?: Queue): Bindings => ({
    ENVIRONMENT: "local",
    BUILD_ID: "integration",
    DATABASE_URL: env?.runtimeUrl ?? "",
    ...(queue ? { OUTBOX_QUEUE: queue } : {}),
  });

  /** Publish only the given events, through the real publisher, to an array. */
  async function publishOnly(
    ids: Set<string>,
    sender?: (m: readonly DeliveryMessage[]) => Promise<void>,
    batchSize?: number,
  ) {
    const sent: DeliveryMessage[] = [];
    const report = await publishOutbox(runtime.db, {
      send:
        sender ??
        (async (messages) => {
          for (const m of messages) if (ids.has(m.outboxId)) sent.push(m);
        }),
      runId: `pub-${randomUUID()}`,
      lostAfterSeconds: 60,
      ...(batchSize ? { batchSize } : {}),
    });
    return { sent, report };
  }

  beforeAll(async () => {
    if (!env) return;
    admin = postgres(env.adminUrl, { max: 2, onnotice: () => {} });
    runtime = createDb(env.runtimeUrl, { max: 4 });
    // Other suites share this database and leave events undelivered, across
    // more tenants than one run lists. Mark them delivered, as the migration
    // does for history, so each run below sees only this suite's events.
    await admin`update public.outbox_events
                   set published_at = coalesce(published_at, now()), delivered_at = now()
                 where delivered_at is null`;
    A = await createCheckoutFixture(admin, runtime.db, "dlv-a");
    B = await createCheckoutFixture(admin, runtime.db, "dlv-b");
  });

  afterAll(async () => {
    await runtime?.end();
    await admin?.end();
  });

  it("publishes from the cron, delivers once, and ignores a duplicate", async () => {
    lines = [];
    const alertId = await enqueue(A.id, "checkout.finalization_exception.raised");
    const quietId = await enqueue(B.id, "catalog.product.published");
    const q = captureQueue();
    await runScheduled({ cron: "*/15 * * * *" }, bindings(q.queue), { log });

    const publish = parsed().find((l) => l.message === "outbox_publish");
    expect(publish).toBeDefined();
    const ours = q.sent.filter((m) => m.outboxId === alertId || m.outboxId === quietId);
    expect(ours).toHaveLength(2);
    // Ids only: the message never carries the payload.
    for (const m of ours)
      expect(Object.keys(m).sort()).toEqual(["outboxId", "tenantId", "topic", "v"]);
    expect((await eventRow(A.id, alertId)).published_at).not.toBeNull();
    expect((await eventRow(A.id, alertId)).delivered_at).toBeNull();

    lines = [];
    const batch = { queue: "tidegrid-outbox-test", messages: ours.map((m) => fakeMessage(m)) };
    await runQueue(batch, bindings(), { log });
    expect(batch.messages.every((m) => m.acked && m.retried === null)).toBe(true);
    expect(await deliveries(A.id, alertId)).toEqual(["ops_alert"]);
    expect(await deliveries(B.id, quietId)).toEqual([]);
    expect((await eventRow(A.id, alertId)).delivered_at).not.toBeNull();
    expect((await eventRow(B.id, quietId)).delivered_at).not.toBeNull();
    const alerts = parsed().filter((l) => l.message === "outbox_alert");
    expect(alerts).toHaveLength(1);
    expect(alerts[0]?.["tidegrid.outbox.id"]).toBe(alertId);
    // The alert carries ids, never the payload.
    expect(JSON.stringify(alerts[0])).not.toContain("marker");

    lines = [];
    const again = { queue: "tidegrid-outbox-test", messages: ours.map((m) => fakeMessage(m, 2)) };
    await runQueue(again, bindings(), { log });
    expect(again.messages.every((m) => m.acked)).toBe(true);
    expect(parsed().filter((l) => l.message === "outbox_alert")).toHaveLength(0);
    expect(await deliveries(A.id, alertId)).toEqual(["ops_alert"]);

    // Delivered events are not published again.
    const next = captureQueue();
    await runScheduled({ cron: "*/15 * * * *" }, bindings(next.queue), { log });
    expect(next.sent.filter((m) => m.outboxId === alertId || m.outboxId === quietId)).toEqual([]);
  });

  it("runs a handler once when two deliveries of one message race", async () => {
    const id = await enqueue(A.id, "test.delivery.race");
    let runs = 0;
    const slow: DeliveryHandler = {
      name: "slow_once",
      topics: ["test.delivery.race"],
      handle: async () => {
        runs += 1;
        await new Promise((r) => setTimeout(r, 200));
      },
    };
    const { sent } = await publishOnly(new Set([id]));
    expect(sent).toHaveLength(1);
    const message = sent[0] as DeliveryMessage;
    const results = await Promise.all([
      consumeDelivery(runtime.db, message, [slow]),
      consumeDelivery(runtime.db, message, [slow]),
    ]);
    expect(runs).toBe(1);
    expect(results.map((r) => (r.kind === "delivered" ? r.ran.length : -1)).sort()).toEqual([0, 1]);
    expect(await deliveries(A.id, id)).toEqual(["slow_once"]);
  });

  it("dead-letters a poison message, and a reviewed replay runs only the missing handler", async () => {
    const id = await enqueue(A.id, "test.delivery.poison");
    let goodRuns = 0;
    let poisoned = true;
    const handlers: DeliveryHandler[] = [
      {
        name: "good",
        topics: ["test.delivery.poison"],
        handle: async (trx, ctx) => {
          goodRuns += 1;
          // A database write in the handler commits with its outcome row.
          await trx
            .insertInto("audit_events")
            .values({
              tenant_id: ctx.tenantId,
              actor_type: "system",
              actor_id: "delivery-test",
              action: "test.delivery.good",
              subject_type: "outbox_event",
              subject_id: id,
            })
            .execute();
        },
      },
      {
        name: "poison",
        topics: ["test.delivery.poison"],
        handle: async () => {
          if (poisoned) throw new RangeError("always fails");
        },
      },
    ];
    const deps: QueueDeps = {
      consume: (m, runId) => consumeDelivery(runtime.db, m, handlers, { runId }),
      deadLetter: (m, input, runId) => recordDeadLetter(runtime.db, m, input, { runId }),
    };
    const { sent } = await publishOnly(new Set([id]));
    const body = sent[0];
    const testLog = createLogger({}, log);
    lines = [];
    for (let attempt = 1; attempt <= MAX_CONSUMER_ATTEMPTS; attempt += 1) {
      const msg = fakeMessage(body, attempt);
      const batch: QueueBatchLike = { queue: "tidegrid-outbox-test", messages: [msg] };
      await handleDeliveryBatch(batch, deps, testLog, `run-${attempt}`);
      if (attempt < MAX_CONSUMER_ATTEMPTS) {
        expect({ attempt, acked: msg.acked, retried: msg.retried }).toEqual({
          attempt,
          acked: false,
          retried: { delaySeconds: 30 * 2 ** (attempt - 1) },
        });
      } else {
        expect({ acked: msg.acked, retried: msg.retried }).toEqual({ acked: true, retried: null });
      }
    }
    // The good handler ran once, though the message was delivered five times.
    expect(goodRuns).toBe(1);
    expect(await deliveries(A.id, id)).toEqual(["good"]);
    const [count] = await admin<{ n: number }[]>`
      select count(*)::int as n from public.audit_events
       where tenant_id = ${A.id} and action = 'test.delivery.good' and subject_id = ${id}`;
    expect(count?.n).toBe(1);

    const letters = await admin<
      { id: string; handler: string; error_code: string; source: string; attempts: number }[]
    >`select id::text, handler, error_code, source, attempts from public.outbox_dead_letters
        where tenant_id = ${A.id} and outbox_event_id = ${id}`;
    expect(letters).toEqual([
      {
        id: expect.any(String),
        handler: "poison",
        error_code: "RangeError",
        source: "consumer",
        attempts: 5,
      },
    ]);
    const dead = parsed().find((l) => l.message === "outbox_dead_lettered");
    expect(dead?.["tidegrid.outbox.handler"]).toBe("poison");
    expect((await eventRow(A.id, id)).last_error).toBe("dead_letter:RangeError");

    // Listed for the operator, across tenants.
    const listed = await listDeadLetters(runtime.db);
    expect(
      listed.some((l) => l.tenantId === A.id && l.outboxId === id && l.handler === "poison"),
    ).toBe(true);

    // An open dead letter keeps the event out of the lost-hint resend.
    await admin`update public.outbox_events set published_at = now() - interval '2 hours'
      where tenant_id = ${A.id} and id = ${id}`;
    expect((await publishOnly(new Set([id]))).sent).toEqual([]);

    // A second report while one is open changes nothing.
    expect(
      await recordDeadLetter(runtime.db, body as DeliveryMessage, {
        errorCode: "queue_retries_exhausted",
        attempts: 7,
        source: "queue",
      }),
    ).toBe("already_open");

    const letterId = letters[0]?.id as string;
    const operator: TenantContext = {
      tenantId: A.id,
      actorType: "support",
      actorId: "ops-replay-test",
      requestId: `replay-${randomUUID()}`,
    };
    await expect(
      replayDeadLetter(runtime.db, operator, { deadLetterId: letterId, reason: "   " }),
    ).rejects.toBeInstanceOf(ReplayRefusedError);
    // Another tenant cannot see, let alone replay, A's dead letter.
    await expect(
      replayDeadLetter(
        runtime.db,
        { ...operator, tenantId: B.id },
        { deadLetterId: letterId, reason: "x" },
      ),
    ).rejects.toMatchObject({ code: "not_found" });

    poisoned = false;
    await replayDeadLetter(runtime.db, operator, {
      deadLetterId: letterId,
      reason: "Fixed the handler",
    });
    await expect(
      replayDeadLetter(runtime.db, operator, { deadLetterId: letterId, reason: "Twice" }),
    ).rejects.toMatchObject({ code: "already_replayed" });
    const [closed] = await admin<
      { replayed_by: string; replay_reason: string; replayed: boolean }[]
    >`
      select replayed_by, replay_reason, replayed_at is not null as replayed
        from public.outbox_dead_letters where tenant_id = ${A.id} and id = ${letterId}`;
    expect(closed).toEqual({
      replayed_by: "support:ops-replay-test",
      replay_reason: "Fixed the handler",
      replayed: true,
    });
    const [audit] = await admin<{ reason: string }[]>`
      select reason from public.audit_events
       where tenant_id = ${A.id} and action = 'outbox.dead_letter.replayed' and subject_id = ${letterId}`;
    expect(audit?.reason).toBe("Fixed the handler");
    expect((await eventRow(A.id, id)).published_at).toBeNull();

    const replayed = await publishOnly(new Set([id]));
    expect(replayed.sent).toHaveLength(1);
    const outcome = await consumeDelivery(
      runtime.db,
      replayed.sent[0] as DeliveryMessage,
      handlers,
    );
    expect(outcome).toEqual({ kind: "delivered", ran: ["poison"] });
    expect(goodRuns).toBe(1);
    expect(await deliveries(A.id, id)).toEqual(["good", "poison"]);
    expect((await eventRow(A.id, id)).delivered_at).not.toBeNull();
  });

  it("refuses to change a dead letter or an event's content, and nobody deletes either", async () => {
    const id = await enqueue(B.id, "test.delivery.immutable");
    await recordDeadLetter(
      runtime.db,
      { v: 1, tenantId: B.id, outboxId: id, topic: "test.delivery.immutable" },
      { errorCode: "Error", attempts: 5, source: "consumer" },
    );
    const code = async (p: Promise<unknown>) => {
      try {
        await p;
        return "no-error";
      } catch (e) {
        return (e as { code?: string }).code ?? "no-code";
      }
    };
    expect(
      await code(admin`update public.outbox_dead_letters set error_code = 'Other'
        where tenant_id = ${B.id} and outbox_event_id = ${id}`),
    ).toBe("55000");
    expect(
      await code(
        admin`delete from public.outbox_dead_letters where tenant_id = ${B.id} and outbox_event_id = ${id}`,
      ),
    ).toBe("55000");
    expect(
      await code(
        admin`update public.outbox_events set payload = '{}'::jsonb where tenant_id = ${B.id} and id = ${id}`,
      ),
    ).toBe("55000");
    expect(
      await code(admin`delete from public.outbox_events where tenant_id = ${B.id} and id = ${id}`),
    ).toBe("55000");
    // A replay needs a named actor.
    expect(
      await code(
        admin.begin(async (tx) => {
          await tx`select set_config('app.actor_id', '', true)`;
          await tx`update public.outbox_dead_letters set replay_reason = 'no actor'
            where tenant_id = ${B.id} and outbox_event_id = ${id}`;
        }),
      ),
    ).toBe("42501");
  });

  it("does not deliver an event to another tenant's message", async () => {
    const id = await enqueue(A.id, "checkout.finalization_exception.raised");
    const forged: DeliveryMessage = {
      v: 1,
      tenantId: B.id,
      outboxId: id,
      topic: "checkout.finalization_exception.raised",
    };
    let ran = false;
    const outcome = await consumeDelivery(runtime.db, forged, [
      {
        name: "spy",
        topics: ["checkout.finalization_exception.raised"],
        handle: async () => {
          ran = true;
        },
      },
    ]);
    expect(outcome).toEqual({ kind: "missing" });
    expect(ran).toBe(false);
    expect(
      await recordDeadLetter(runtime.db, forged, { errorCode: "x", attempts: 1, source: "queue" }),
    ).toBe("missing");
  });

  it("sends a lost hint again, then dead-letters an event sent too often", async () => {
    const id = await enqueue(B.id, "test.delivery.lost");
    const first = await publishOnly(new Set([id]));
    expect(first.sent).toHaveLength(1);
    // The hint is lost: nothing consumes it. Time passes.
    await admin`update public.outbox_events set published_at = now() - interval '2 minutes'
      where tenant_id = ${B.id} and id = ${id}`;
    const second = await publishOnly(new Set([id]));
    expect(second.sent).toHaveLength(1);
    expect(second.report.resent).toBeGreaterThanOrEqual(1);
    expect((await eventRow(B.id, id)).attempts).toBe(2);

    await admin`update public.outbox_events set published_at = now() - interval '2 minutes', attempts = 10
      where tenant_id = ${B.id} and id = ${id}`;
    const third = await publishOnly(new Set([id]));
    expect(third.sent).toEqual([]);
    expect(third.report.deadLettered).toBeGreaterThanOrEqual(1);
    const [letter] = await admin<{ source: string; error_code: string }[]>`
      select source, error_code from public.outbox_dead_letters
       where tenant_id = ${B.id} and outbox_event_id = ${id} and replayed_at is null`;
    expect(letter).toEqual({ source: "publisher", error_code: "publish_attempts_exhausted" });
  });

  it("never lets parked dead letters hold back a tenant's newer events", async () => {
    const parked: string[] = [];
    for (let i = 0; i < 3; i += 1) {
      const id = await enqueue(B.id, "test.delivery.parked");
      await recordDeadLetter(
        runtime.db,
        { v: 1, tenantId: B.id, outboxId: id, topic: "test.delivery.parked" },
        { errorCode: "Error", attempts: 5, source: "consumer" },
      );
      parked.push(id);
    }
    const fresh = await enqueue(B.id, "test.delivery.parked");
    const { sent } = await publishOnly(new Set([...parked, fresh]), undefined, 2);
    expect(sent.map((m) => m.outboxId)).toEqual([fresh]);
  });

  it("refuses a replay by a system job, and records nothing for an event already delivered", async () => {
    const id = await enqueue(A.id, "test.delivery.late");
    const message: DeliveryMessage = {
      v: 1,
      tenantId: A.id,
      outboxId: id,
      topic: "test.delivery.late",
    };
    await recordDeadLetter(runtime.db, message, {
      errorCode: "Error",
      attempts: 5,
      source: "consumer",
    });
    const [letter] = await admin<{ id: string }[]>`
      select id::text from public.outbox_dead_letters where tenant_id = ${A.id} and outbox_event_id = ${id}`;
    await expect(
      replayDeadLetter(runtime.db, sys(A.id), { deadLetterId: letter?.id ?? "", reason: "job" }),
    ).rejects.toMatchObject({ code: "bad_actor" });

    const other = await enqueue(A.id, "test.delivery.late");
    const late: DeliveryMessage = { ...message, outboxId: other };
    const { sent } = await publishOnly(new Set([other]));
    expect(sent).toHaveLength(1);
    expect(await consumeDelivery(runtime.db, late, [])).toEqual({ kind: "delivered", ran: [] });
    expect(
      await recordDeadLetter(runtime.db, late, { errorCode: "x", attempts: 7, source: "queue" }),
    ).toBe("delivered");
  });

  it("keeps an event unpublished and waits when the queue refuses a send", async () => {
    const id = await enqueue(A.id, "test.delivery.refused");
    const before = Date.now();
    const { report } = await publishOnly(new Set([id]), async () => {
      throw new TypeError("queue unavailable");
    });
    expect(report.sendFailures).toBeGreaterThanOrEqual(1);
    expect(report.stopped).toBe(true);
    const row = await eventRow(A.id, id);
    expect(row.published_at).toBeNull();
    // A refused send is not an attempt: an outage never makes dead letters.
    expect(row.attempts).toBe(0);
    expect(row.last_error).toBe("send_failed:TypeError");
    expect(new Date(row.available_at).getTime()).toBeGreaterThan(before + 20_000);
    // Not due yet, so the next run leaves it alone.
    expect((await publishOnly(new Set([id]))).sent).toEqual([]);
  });

  it("records a dead letter from the queue's own DLQ, and acks a body it did not write", async () => {
    const id = await enqueue(A.id, "test.delivery.dlq");
    lines = [];
    const good = fakeMessage({ v: 1, tenantId: A.id, outboxId: id, topic: "test.delivery.dlq" }, 7);
    const junk = fakeMessage({ hello: "world" });
    await runQueue({ queue: "tidegrid-outbox-test-dlq", messages: [good, junk] }, bindings(), {
      log,
    });
    expect(good.acked && junk.acked).toBe(true);
    const [letter] = await admin<{ source: string; error_code: string; attempts: number }[]>`
      select source, error_code, attempts from public.outbox_dead_letters
       where tenant_id = ${A.id} and outbox_event_id = ${id}`;
    expect(letter).toEqual({ source: "queue", error_code: "queue_retries_exhausted", attempts: 7 });
    expect(parsed().some((l) => l.message === "outbox_message_invalid")).toBe(true);
    expect(lines.join("\n")).not.toContain("world");
  });

  it("lists and replays a dead letter through the reviewed command, dry run first", async () => {
    const id = await enqueue(B.id, "test.delivery.command");
    await recordDeadLetter(
      runtime.db,
      { v: 1, tenantId: B.id, outboxId: id, topic: "test.delivery.command" },
      { handler: "ops_alert", errorCode: "RangeError", attempts: 5, source: "consumer" },
    );
    const [letter] = await admin<{ id: string }[]>`
      select id::text from public.outbox_dead_letters where tenant_id = ${B.id} and outbox_event_id = ${id}`;
    const previous = process.env.DATABASE_URL;
    process.env.DATABASE_URL = env?.runtimeUrl ?? "";
    try {
      const out: string[] = [];
      expect(await outboxDlq(["list"], (l) => out.push(l))).toBe(0);
      const listed = out.map((l) => JSON.parse(l) as Record<string, unknown>);
      expect(
        listed.some((l) => l.id === letter?.id && l.tenantId === B.id && l.handler === "ops_alert"),
      ).toBe(true);
      expect(out.join("\n")).not.toContain("marker");

      const args = ["replay", "--tenant", B.id, "--id", letter?.id ?? "", "--operator", "ops.test"];
      const dry: string[] = [];
      expect(await outboxDlq([...args, "--reason", "Handler fixed"], (l) => dry.push(l))).toBe(0);
      expect(dry.at(-1)).toContain("dryRun");
      expect((await eventRow(B.id, id)).last_error).toBe("dead_letter:RangeError");

      const done: string[] = [];
      expect(
        await outboxDlq([...args, "--reason", "Handler fixed", "--go"], (l) => done.push(l)),
      ).toBe(0);
      expect(JSON.parse(done.at(-1) ?? "{}")).toMatchObject({ replayed: true, outboxId: id });
      expect((await eventRow(B.id, id)).published_at).toBeNull();
      const again: string[] = [];
      expect(await outboxDlq([...args, "--reason", "Again", "--go"], (l) => again.push(l))).toBe(1);
      expect(await outboxDlq(["replay", "--tenant", B.id], () => {})).toBe(2);
    } finally {
      if (previous === undefined) delete process.env.DATABASE_URL;
      else process.env.DATABASE_URL = previous;
    }
  });

  it("skips publication without a queue binding", async () => {
    lines = [];
    await runScheduled({ cron: "*/15 * * * *" }, bindings(), { log });
    const skipped = parsed().find((l) => l.message === "outbox_publish_skipped");
    expect(skipped?.["tidegrid.outbox.reason"]).toBe("queue_unconfigured");
    expect(parsed().some((l) => l.message === "delivery_cleanup")).toBe(true);
  });

  it("cleans up expired idempotency keys and unused quotes a week late, and keeps the rest", async () => {
    const ctx = sys(A.id);
    const key = (k: string) => ({
      tenant_id: A.id,
      scope: "test.cleanup",
      principal: "system:test",
      key: k,
      request_hash: "a".repeat(64),
      status: "completed" as const,
      response_status: 200,
      response_body: {},
      completed_at: new Date(),
    });
    const oldKey = `old-${randomUUID()}`;
    const newKey = `new-${randomUUID()}`;
    await inTenantTransaction(runtime.db, ctx, async (trx) => {
      await trx
        .insertInto("idempotency_keys")
        .values([key(oldKey), key(newKey)])
        .execute();
    });
    await admin`update public.idempotency_keys set expires_at = now() - interval '8 days'
      where tenant_id = ${A.id} and key = ${oldKey}`;
    await admin`update public.idempotency_keys set expires_at = now() - interval '6 days'
      where tenant_id = ${A.id} and key = ${newKey}`;

    const trips = tripAllocator(A);
    const unused = await quoteFor(runtime.db, A.id, trips.shared(), 1);
    const recent = await quoteFor(runtime.db, A.id, trips.shared(), 1);
    const used = await quoteFor(runtime.db, A.id, trips.shared(), 1);
    const g = guestContext(A.id);
    const created = await inTenantTransaction(runtime.db, g, (trx) =>
      createCheckoutSession(trx, g, {
        quoteId: used.quoteId,
        acceptedPolicyVersion: used.policy.version,
        booker: { name: "Cleanup Booker", email: "cleanup@example.test" },
        secret: newSecret(),
        clientAddress: null,
        provider: "fake",
        minimumAmount: FAKE_MINIMUM_AMOUNT,
      }),
    );
    expect(created.kind).toBe("created");
    if (created.kind === "created") {
      await ensureProviderPayment(runtime.db, fakeProvider(runtime.db), g, created.session.id);
    }
    // Time passes: two quotes expired over a week ago. Triggers are off for
    // this admin edit only, as the clock moving would need no write at all.
    await admin.begin(async (tx) => {
      await tx`set local session_replication_role = replica`;
      for (const q of [unused.quoteId, used.quoteId]) {
        await tx`update public.quotes
                    set quoted_at = quoted_at - interval '8 days',
                        expires_at = expires_at - interval '8 days'
                  where tenant_id = ${A.id} and id = ${q}`;
      }
    });

    // Outside the cleanup function nobody deletes a quote, the owner included.
    const refused =
      await admin`delete from public.quotes where tenant_id = ${A.id} and id = ${unused.quoteId}`
        .then(() => "no-error")
        .catch((e: { code?: string }) => e.code);
    expect(refused).toBe("55000");

    // Repeat until the shared database has nothing older left to remove.
    for (let i = 0; i < 20; i += 1) {
      const [r] = await admin<{ k: number; q: number }[]>`
        select idempotency_keys_deleted as k, quotes_deleted as q from app.delivery_cleanup(5000)`;
      if (r?.k === 0 && r?.q === 0) break;
    }
    const keys = await admin<{ key: string }[]>`
      select key from public.idempotency_keys where tenant_id = ${A.id} and key in (${oldKey}, ${newKey})`;
    expect(keys.map((k) => k.key)).toEqual([newKey]);
    const quotes = await admin<{ id: string }[]>`
      select id from public.quotes where tenant_id = ${A.id}
         and id in (${unused.quoteId}, ${recent.quoteId}, ${used.quoteId}) order by id`;
    expect(quotes.map((q) => q.id).sort()).toEqual([recent.quoteId, used.quoteId].sort());
    const [lineCount] = await admin<{ n: number }[]>`
      select count(*)::int as n from public.quote_lines where tenant_id = ${A.id} and quote_id = ${unused.quoteId}`;
    expect(lineCount?.n).toBe(0);
  });

  it("gives the runtime only what the delivery foundation needs", async () => {
    const rows = await admin<{ proname: string; prosecdef: boolean; runtime: boolean }[]>`
      select p.proname, p.prosecdef, has_function_privilege('tidegrid_app', p.oid, 'EXECUTE') as runtime
        from pg_proc p join pg_namespace n on n.oid = p.pronamespace
       where n.nspname = 'app'
         and p.proname in ('outbox_publish_tenants', 'outbox_dead_letter_tenants', 'delivery_cleanup',
                           'check_outbox_event_update', 'check_outbox_dead_letter')
       order by p.proname`;
    expect(rows.map((r) => ({ ...r }))).toEqual([
      { proname: "check_outbox_dead_letter", prosecdef: false, runtime: false },
      { proname: "check_outbox_event_update", prosecdef: false, runtime: false },
      { proname: "delivery_cleanup", prosecdef: true, runtime: true },
      { proname: "outbox_dead_letter_tenants", prosecdef: true, runtime: true },
      { proname: "outbox_publish_tenants", prosecdef: true, runtime: true },
    ]);
    // Still no DELETE anywhere for the runtime.
    const [del] = await admin<{ n: number }[]>`
      select count(*)::int as n from pg_class c join pg_namespace n on n.oid = c.relnamespace
       where n.nspname = 'public' and c.relkind = 'r' and has_table_privilege('tidegrid_app', c.oid, 'DELETE')`;
    expect(del?.n).toBe(0);
  });
});
