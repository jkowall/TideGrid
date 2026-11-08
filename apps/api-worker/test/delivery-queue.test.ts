/**
 * The outbox queue in the Workers test runtime (W3-G2.3): env.test declares a
 * Miniflare queue, its consumer, and its DLQ. These tests drive the Worker's
 * queue entry with real MessageBatch objects and read back each message's
 * ack or retry. The database side runs against PostgreSQL in
 * test-integration/delivery.integration.test.ts.
 */
import { createExecutionContext, createMessageBatch, env, getQueueResult } from "cloudflare:test";
import type { DeliveryMessage } from "@tidegrid/database";
import { DeliveryHandlerError } from "@tidegrid/database";
import { describe, expect, it } from "vitest";
import {
  MAX_CONSUMER_ATTEMPTS,
  type QueueDeps,
  queueSender,
  retryDelaySeconds,
  runQueue,
} from "../src/delivery.ts";
import worker from "../src/index.ts";

const tenantId = "0b6a4f5e-2c1d-4e8f-9a7b-3c2d1e0f9a8b";
const body = (outboxId: string): DeliveryMessage => ({
  v: 1,
  tenantId,
  outboxId,
  topic: "checkout.finalization_exception.raised",
});
const message = (id: string, payload: unknown, attempts = 1) => ({
  id,
  timestamp: new Date(1_000),
  attempts,
  body: payload,
});

/** Fake database calls that record what the consumer asked for. */
function fakeDeps(
  options: { fail?: (m: DeliveryMessage) => Error | null; deadLetterFails?: boolean } = {},
) {
  const consumed: string[] = [];
  const deadLetters: {
    outboxId: string;
    source: string;
    handler: string | null;
    attempts: number;
  }[] = [];
  const deps: QueueDeps = {
    consume: async (m) => {
      const error = options.fail?.(m) ?? null;
      if (error) throw error;
      consumed.push(m.outboxId);
      return { kind: "delivered", ran: ["ops_alert"] };
    },
    deadLetter: async (m, input) => {
      if (options.deadLetterFails) throw new Error("database down");
      deadLetters.push({
        outboxId: m.outboxId,
        source: input.source,
        handler: input.handler,
        attempts: input.attempts,
      });
      return "recorded";
    },
  };
  return { deps, consumed, deadLetters };
}

async function run(
  queue: string,
  messages: ReturnType<typeof message>[],
  deps: QueueDeps,
  lines: string[] = [],
) {
  const batch = createMessageBatch(queue, messages);
  const ctx = createExecutionContext();
  await runQueue(batch, env, { deps, log: (l) => lines.push(l) });
  return getQueueResult(batch, ctx);
}

describe("the outbox queue in the Workers runtime", () => {
  it("declares a Miniflare queue the publisher can send a batch to", async () => {
    expect(env.OUTBOX_QUEUE).toBeDefined();
    if (!env.OUTBOX_QUEUE) return;
    await expect(queueSender(env.OUTBOX_QUEUE)([body("1"), body("2")])).resolves.toBeUndefined();
    await expect(queueSender(env.OUTBOX_QUEUE)([])).resolves.toBeUndefined();
  });

  it("acks every message the consumer delivered", async () => {
    const { deps, consumed } = fakeDeps();
    const result = await run(
      "tidegrid-outbox-test",
      [message("a", body("11")), message("b", body("12"))],
      deps,
    );
    expect(consumed).toEqual(["11", "12"]);
    expect(result.explicitAcks.sort()).toEqual(["a", "b"]);
    expect(result.retryMessages).toEqual([]);
  });

  it("retries a failure with a growing delay, one message at a time", async () => {
    const { deps, consumed } = fakeDeps({
      fail: (m) =>
        m.outboxId === "21" ? new DeliveryHandlerError("ops_alert", "RangeError") : null,
    });
    const lines: string[] = [];
    const result = await run(
      "tidegrid-outbox-test",
      [message("bad", body("21"), 2), message("good", body("22"))],
      deps,
      lines,
    );
    expect(consumed).toEqual(["22"]);
    expect(result.explicitAcks).toEqual(["good"]);
    // The test runtime reports which messages were retried, not the delay;
    // the integration suite checks the delay the consumer asks for.
    expect(result.retryMessages.map((r: { msgId: string }) => r.msgId)).toEqual(["bad"]);
    expect(retryDelaySeconds(1)).toBe(30);
    expect(retryDelaySeconds(2)).toBe(60);
    expect(retryDelaySeconds(20)).toBe(900);
    const retry = lines
      .map((l) => JSON.parse(l))
      .find((l) => l.message === "outbox_delivery_retry");
    expect(retry).toMatchObject({
      "tidegrid.outbox.handler": "ops_alert",
      "error.type": "RangeError",
    });
  });

  it("records a dead letter and acks on the last attempt", async () => {
    const { deps, deadLetters } = fakeDeps({
      fail: () => new DeliveryHandlerError("ops_alert", "RangeError"),
    });
    const result = await run(
      "tidegrid-outbox-test",
      [message("p", body("31"), MAX_CONSUMER_ATTEMPTS)],
      deps,
    );
    expect(deadLetters).toEqual([
      { outboxId: "31", source: "consumer", handler: "ops_alert", attempts: 5 },
    ]);
    expect(result.explicitAcks).toEqual(["p"]);
    expect(result.retryMessages).toEqual([]);
  });

  it("retries when even the dead letter cannot be recorded, so the queue's DLQ takes it", async () => {
    const { deps } = fakeDeps({ fail: () => new Error("down"), deadLetterFails: true });
    const result = await run(
      "tidegrid-outbox-test",
      [message("p", body("41"), MAX_CONSUMER_ATTEMPTS)],
      deps,
    );
    expect(result.explicitAcks).toEqual([]);
    expect(result.retryMessages.map((r: { msgId: string }) => r.msgId)).toEqual(["p"]);
  });

  it("records the DLQ's messages with source queue, and acks a body it did not write", async () => {
    const { deps, deadLetters, consumed } = fakeDeps();
    const lines: string[] = [];
    const result = await run(
      "tidegrid-outbox-test-dlq",
      [message("d", body("51"), 7), message("junk", { secret: "do-not-log" })],
      deps,
      lines,
    );
    expect(consumed).toEqual([]);
    expect(deadLetters).toEqual([{ outboxId: "51", source: "queue", handler: null, attempts: 7 }]);
    expect(result.explicitAcks.sort()).toEqual(["d", "junk"]);
    expect(lines.join("\n")).not.toContain("do-not-log");
  });

  it("is the default export's queue handler, and retries every message without a database", async () => {
    expect(typeof worker.queue).toBe("function");
    const batch = createMessageBatch("tidegrid-outbox-test", [message("x", body("61"))]);
    const ctx = createExecutionContext();
    await worker.queue(batch, env, ctx);
    const result = await getQueueResult(batch, ctx);
    expect(result.explicitAcks).toEqual([]);
    expect(result.retryMessages.map((r: { msgId: string }) => r.msgId)).toEqual(["x"]);
  });
});
