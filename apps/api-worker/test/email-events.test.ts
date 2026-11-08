import { createExecutionContext, env, waitOnExecutionContext } from "cloudflare:test";
import type { Database } from "@tidegrid/database";
import type { Kysely } from "kysely";
import { describe, expect, it } from "vitest";
import {
  consumeEmailEvents,
  isEmailEventsBatch,
  retryDelaySeconds,
  sendingDomain,
} from "../src/email-events.ts";
import type { Bindings } from "../src/env.ts";
import worker from "../src/index.ts";

/**
 * The email events consumer's queue handling (W1-EMAIL-EVENTS), without a
 * database. Joining and recording are covered against PostgreSQL in
 * packages/domain-messaging/src/events.integration.test.ts.
 */

const ACCOUNT = "00000000000000000000000000c0ffee";
const DOMAIN = "mail.tidegrid.test";

interface Recorded {
  acked: string[];
  retried: string[];
  retriedAll: number;
}

function batch(queue: string, bodies: unknown[]): MessageBatch<unknown> & Recorded {
  const recorded: Recorded = { acked: [], retried: [], retriedAll: 0 };
  const messages = bodies.map((body, i) => ({
    id: `m${i}`,
    timestamp: new Date(0),
    attempts: 1,
    body,
    ack: () => recorded.acked.push(`m${i}`),
    retry: (options?: { delaySeconds?: number }) => {
      expect(options?.delaySeconds).toBeGreaterThan(0);
      recorded.retried.push(`m${i}`);
    },
  }));
  return Object.assign(recorded, {
    queue,
    messages,
    ackAll: () => {
      for (const m of messages) m.ack();
    },
    retryAll: () => {
      recorded.retriedAll += 1;
    },
  }) as unknown as MessageBatch<unknown> & Recorded;
}

function event(type: string, over: { accountId?: string; domain?: string } = {}) {
  return {
    type: `cf.email.sending.message.${type}`,
    source: { type: "email.sending", zoneId: "0".repeat(32), domain: over.domain ?? DOMAIN },
    payload: { eventId: `evt-${type}-0001`, messageId: "0101018f7d0c4d9a-msg-deadbeef" },
    metadata: {
      accountId: over.accountId ?? ACCOUNT,
      eventSubscriptionId: "0".repeat(32),
      eventSchemaVersion: 1,
      eventTimestamp: "2026-11-08T12:00:00.000Z",
    },
  };
}

/** A database the refusals must never touch. */
const untouchable = new Proxy(
  {},
  {
    get() {
      throw new Error("the database was used");
    },
  },
) as Kysely<Database>;

const configured = (over: Partial<Bindings> = {}): Bindings => ({
  ...env,
  EMAIL_EVENTS_QUEUE: "tidegrid-email-events",
  EMAIL_EVENTS_ACCOUNT_ID: ACCOUNT,
  EMAIL_FROM_ADDRESS: `bookings@${DOMAIN}`,
  ...over,
});

const lines = () => {
  const out: Record<string, unknown>[] = [];
  return { out, log: (line: string) => out.push(JSON.parse(line)) };
};

describe("email events queue consumer (W1-EMAIL-EVENTS)", () => {
  it("backs off from 30 seconds, doubling, up to an hour", () => {
    expect([0, 1, 2, 3, 8, 50].map(retryDelaySeconds)).toEqual([30, 30, 60, 120, 3600, 3600]);
  });

  it("takes the sending domain from the sender address", () => {
    expect(sendingDomain(configured())).toBe(DOMAIN);
    const { EMAIL_FROM_ADDRESS: _unset, ...noSender } = configured();
    expect(sendingDomain(noSender)).toBe("tidegrid.us");
  });

  it("knows its queue only by the configured name", () => {
    expect(isEmailEventsBatch({ queue: "tidegrid-email-events" }, configured())).toBe(true);
    expect(isEmailEventsBatch({ queue: "tidegrid-outbox-1" }, configured())).toBe(false);
    expect(isEmailEventsBatch({ queue: "tidegrid-email-events" }, env)).toBe(false);
    expect(isEmailEventsBatch({ queue: "" }, configured({ EMAIL_EVENTS_QUEUE: " " }))).toBe(false);
  });

  it("retries the whole batch while the account id is missing or malformed", async () => {
    const { EMAIL_EVENTS_ACCOUNT_ID: _unset, ...missing } = configured();
    for (const bindings of [
      missing,
      configured({ EMAIL_EVENTS_ACCOUNT_ID: "" }),
      configured({ EMAIL_EVENTS_ACCOUNT_ID: "not-hex" }),
    ]) {
      const b = batch("tidegrid-email-events", [event("bounced")]);
      const { out, log } = lines();
      await consumeEmailEvents(b, bindings, {
        log,
        db: untouchable,
      });
      expect(b.retriedAll).toBe(1);
      expect(b.acked).toEqual([]);
      expect(out).toEqual([expect.objectContaining({ message: "email_events_unconfigured" })]);
    }
  });

  it("retries the whole batch when no database is configured", async () => {
    const b = batch("tidegrid-email-events", [event("bounced")]);
    const { out, log } = lines();
    await consumeEmailEvents(b, configured(), { log });
    expect(b.retriedAll).toBe(1);
    expect(out).toEqual([
      expect.objectContaining({
        message: "email_events_skipped",
        "error.type": "database_unconfigured",
      }),
    ]);
  });

  it("retries refused events, acknowledges invalid and dropped ones, without touching the database", async () => {
    const b = batch("tidegrid-email-events", [
      event("bounced", { accountId: "11111111111111111111111111111111" }),
      event("complained", { domain: "other.example.test" }),
      { type: "something else" },
      event("delivered"),
      { ...event("bounced"), payload: { eventId: "short", messageId: "x-msg-1" } },
    ]);
    const { out, log } = lines();
    await consumeEmailEvents(b, configured(), { log, db: untouchable });
    // A refusal, or a shape this code does not know, is retried, so a wrong
    // setting or a new schema dead-letters real events instead of dropping
    // them; a malformed event in a known shape, or a dropped type, is final.
    expect(b.acked).toEqual(["m3", "m4"]);
    expect(b.retried).toEqual(["m0", "m1", "m2"]);
    expect(out.map((l) => [l.message, l["tidegrid.email_event.outcome"]])).toEqual([
      ["email_event_refused", "refused_account"],
      ["email_event_refused", "refused_domain"],
      ["email_event_refused", "invalid"],
      ["email_event", "ignored"],
      ["email_event_refused", "invalid"],
    ]);
    // No address, subject, or account id reaches a log line.
    expect(JSON.stringify(out)).not.toMatch(/@|c0ffee|1111111111/);
  });

  it("retries one message whose database work fails, and acknowledges the rest", async () => {
    const b = batch("tidegrid-email-events", [event("bounced"), event("delivered")]);
    const { out, log } = lines();
    await consumeEmailEvents(b, configured(), { log, db: untouchable });
    expect(b.retried).toEqual(["m0"]);
    expect(b.acked).toEqual(["m1"]);
    expect(out[0]).toMatchObject({ level: "error", message: "email_event_failed" });
  });

  it("is the default export's queue handler, and leaves an unknown queue's batch for retry", async () => {
    expect(typeof worker.queue).toBe("function");
    const b = batch("someone-elses-queue", [event("bounced")]);
    const ctx = createExecutionContext();
    await worker.queue(b, configured(), ctx);
    await waitOnExecutionContext(ctx);
    expect(b.retriedAll).toBe(1);
    expect(b.acked).toEqual([]);
  });
});
