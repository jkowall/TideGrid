/**
 * After-commit email delivery's window (G2.16-live prep, 2026-11-07), against
 * a real PostgreSQL 17 as the runtime role. The window counts from the moment
 * the delivery's connection is ready, capped by the request's own start plus
 * the 30 s `waitUntil` budget (`afterCommitDeadline` in src/email.ts).
 *
 * The clock is scripted: the request's start, then the ready connection, then
 * every read delivery makes. A provider bounded like Cloudflare (10 s per
 * send) reserves 12 s per claim. The first two cases stayed queued before the
 * change, when the window counted from the request's start alone.
 */
import { randomUUID } from "node:crypto";
import { createDb, inTenantTransaction, type TenantContext } from "@tidegrid/database";
import type {} from "@tidegrid/database/global-setup";
import {
  type EmailProvider,
  enqueueMessage,
  FakeEmailProvider,
  type OutgoingEmail,
} from "@tidegrid/domain-messaging";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";
import type { AppDeps } from "../src/context.ts";
import { CLOUDFLARE_SEND_TIMEOUT_MS, deliverAfterCommit } from "../src/email.ts";

type Sql = ReturnType<typeof postgres>;

const env = inject("integrationDb");

describe.skipIf(!env)("after-commit delivery's window", () => {
  let admin: Sql;
  let runtime: ReturnType<typeof createDb>;
  const run = randomUUID().slice(0, 8);

  beforeAll(async () => {
    if (!env) return;
    admin = postgres(env.adminUrl, { max: 2, onnotice: () => {} });
    runtime = createDb(env.runtimeUrl, { max: 2 });
  });

  afterAll(async () => {
    await runtime?.end();
    await admin?.end({ timeout: 5 });
  });

  /** A tenant of its own per case, with one queued email that carries no link. */
  async function tenantWithMail(label: string): Promise<{ tenantId: string; messageId: string }> {
    const tenantId = randomUUID();
    const slug = `ac-${label}-${tenantId.slice(0, 8)}`;
    await admin`insert into public.tenants (id, slug, display_name)
      values (${tenantId}, ${slug}, ${`After commit ${slug}`})`;
    const ctx: TenantContext = {
      tenantId,
      actorType: "system",
      actorId: "after-commit-test",
      requestId: `req-${randomUUID()}`,
    };
    const done = await inTenantTransaction(runtime.db, ctx, (trx) =>
      enqueueMessage(trx, ctx, {
        dedupeKey: `ac.message:${run}-${label}`,
        template: "ac_message",
        templateVersion: 1,
        to: { email: `ac.${run}.${label}@example.test`, name: "Synthetic Guest" },
        content: {
          subject: `Synthetic ${label}`,
          blocks: [{ kind: "paragraph", text: "A synthetic message for the window suite." }],
        },
      }),
    );
    return { tenantId, messageId: done.messageId };
  }

  /**
   * Runs after-commit delivery. The clock reads the request's start, then
   * each offset in turn (the ready connection first, then delivery's checks),
   * then the last offset again.
   */
  async function deliverWith(tenantId: string, offsets: number[]) {
    const start = 1_800_000_000_000;
    const reads = [start, ...offsets.map((o) => start + o)];
    const last = start + (offsets.at(-1) ?? 0);
    let clockReads = 0;
    const clock = () => {
      clockReads += 1;
      return reads.shift() ?? last;
    };
    const fake = new FakeEmailProvider({ db: runtime.db, environment: "local" });
    let sends = 0;
    // Bounded like the Cloudflare adapter, so each claim reserves 10 s plus the margin.
    const provider: EmailProvider = {
      name: "fake",
      deduplicates: true,
      sendTimeoutMs: CLOUDFLARE_SEND_TIMEOUT_MS,
      send: (email: OutgoingEmail) => {
        sends += 1;
        return fake.send(email);
      },
    };
    const deps: AppDeps = { emailProvider: () => provider, emailClock: clock };
    const pending: Promise<unknown>[] = [];
    const logged: Record<string, unknown>[] = [];
    const log = {
      info: (_event: string, attributes: Record<string, unknown>) => void logged.push(attributes),
      error: () => {},
      warn: () => {},
    };
    const c = {
      env: {
        ENVIRONMENT: "local",
        BUILD_ID: "integration",
        DATABASE_URL: env?.runtimeUrl ?? "",
        GUEST_LINK_ORIGIN: "http://{slug}.book.localhost:5361",
      },
      get: (key: string) => (key === "log" ? log : `req-${run}`),
      executionCtx: { waitUntil: (p: Promise<unknown>) => void pending.push(p) },
    };
    deliverAfterCommit(c as never, deps, tenantId);
    expect(pending).toHaveLength(1);
    await Promise.all(pending);
    const summary = logged.find((a) => a["event.name"] === "email_delivery");
    return { sends, stopped: summary?.["tidegrid.email.stopped"] ?? null, clockReads };
  }

  async function stateOf(messageId: string) {
    const [r] = await admin<{ state: string; attempts: number }[]>`
      select state, attempts from public.email_messages where id = ${messageId}`;
    return r;
  }

  it("sends after a 15 s connect: the window counts from the ready connection", async () => {
    const { tenantId, messageId } = await tenantWithMail("slow-connect");
    // Start, ready, the check before the claim, the check after it, the next check.
    expect(await deliverWith(tenantId, [15_000, 15_000])).toMatchObject({
      sends: 1,
      clockReads: 5,
    });
    expect(await stateOf(messageId)).toEqual({ state: "sent", attempts: 1 });
  });

  it("sends at 10 s after a 5 s connect, which the old 18 s window from the start refused", async () => {
    const { tenantId, messageId } = await tenantWithMail("five-ten");
    expect(await deliverWith(tenantId, [5_000, 10_000])).toMatchObject({ sends: 1 });
    expect(await stateOf(messageId)).toEqual({ state: "sent", attempts: 1 });
  });

  it("claims nothing once a send could end past the 30 s budget, and leaves the mail queued", async () => {
    const { tenantId, messageId } = await tenantWithMail("past-budget");
    expect(await deliverWith(tenantId, [19_000, 19_000])).toEqual({
      sends: 0,
      stopped: "deadline",
      clockReads: 3,
    });
    expect(await stateOf(messageId)).toEqual({ state: "queued", attempts: 0 });
  });

  it("never starts a send once a slow claim leaves no time for it, and retries it later", async () => {
    const { tenantId, messageId } = await tenantWithMail("slow-claim");
    // Ready at 5 s (deadline 23 s); the check before the claim at 5 s passes,
    // and the claim takes until 14 s, when a 10 s send would end at 24 s.
    expect(await deliverWith(tenantId, [5_000, 5_000, 14_000])).toMatchObject({
      sends: 0,
      stopped: "deadline",
    });
    expect(await stateOf(messageId)).toEqual({ state: "queued", attempts: 1 });
  });

  it("sends at once on a ready connection", async () => {
    const { tenantId, messageId } = await tenantWithMail("at-once");
    expect(await deliverWith(tenantId, [0, 0])).toMatchObject({ sends: 1 });
    expect(await stateOf(messageId)).toEqual({ state: "sent", attempts: 1 });
  });
});
