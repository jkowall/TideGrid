/**
 * Adversarial suite for transactional email delivery (lane 1, the G2.16 demo
 * shim), against packages/domain-messaging/README.md ("Enqueueing a message",
 * "Message status", "Delivery", "The fake provider") and migration 0009.
 *
 * Invariants under attack: a message is enqueued once per key and tenant; it
 * is sent once, with its id as the provider's idempotency key; a temporary
 * failure retries after 1, 5, 15, and 60 minutes, then 4 hours, and fails
 * after six attempts as retries_exhausted; only the latest attempt's outcome
 * is recorded; a queued message may be canceled, a claimed one goes out;
 * status reads carry no recipient or content. Messages here carry no access
 * link, so no booking is needed; links are attacked in the domain-booking
 * adversarial suite.
 *
 * Every call under test runs as tidegrid_app; the admin connection makes time
 * pass by moving instants earlier and reads stored state.
 */
import { randomUUID } from "node:crypto";
import {
  createDb,
  inTenantTransaction,
  type TenantContext,
  type TenantTransaction,
} from "@tidegrid/database";
import type {} from "@tidegrid/database/global-setup";
import { sql } from "kysely";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";
import {
  cancelMessage,
  deliverTenantMessages,
  type EmailContent,
  type EmailProvider,
  EmailProviderRejectedError,
  EmailProviderUnavailableError,
  enqueueMessage,
  FakeEmailProvider,
  getMessageStatus,
  MAX_DELIVERY_ATTEMPTS,
  type OutgoingEmail,
  RETRY_BACKOFF_SECONDS,
  type TenantDeliveryReport,
} from "./index.ts";

type Sql = ReturnType<typeof postgres>;

const env = inject("integrationDb");

type Outcome<T> =
  | { ok: true; value: T }
  | { ok: false; code: string; constraint: string | null; message: string };

async function settle<T>(p: Promise<T>): Promise<Outcome<T>> {
  try {
    return { ok: true, value: await p };
  } catch (err) {
    const e = err as { code?: unknown; constraint_name?: unknown; message?: unknown };
    return {
      ok: false,
      code: typeof e.code === "string" ? e.code : "no-code",
      constraint: typeof e.constraint_name === "string" ? e.constraint_name : null,
      message: String(e.message ?? err),
    };
  }
}

async function refusal(p: Promise<unknown>): Promise<{ code: string; constraint: string | null }> {
  const settled = await settle(p);
  if (settled.ok) throw new Error("expected a database refusal, and the statement succeeded");
  return { code: settled.code, constraint: settled.constraint };
}

function gate() {
  let open!: () => void;
  const opened = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { open, opened };
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

const content = (subject: string): EmailContent => ({
  subject,
  blocks: [
    { kind: "heading", text: "Synthetic" },
    { kind: "paragraph", text: "A synthetic message for the adversarial suite." },
  ],
});

describe.skipIf(!env)("adversarial: email delivery, retries, and the fake provider", () => {
  let admin: Sql;
  let runtime: ReturnType<typeof createDb>;
  let fake: FakeEmailProvider;
  let A: string;
  let B: string;

  const ctxFor = (tenantId: string): TenantContext => ({
    tenantId,
    actorType: "system",
    actorId: "messaging-adversary",
    requestId: `adv-${randomUUID()}`,
  });
  const inTenant = <T>(
    tenantId: string,
    fn: (trx: TenantTransaction, ctx: TenantContext) => Promise<T>,
  ) => {
    const ctx = ctxFor(tenantId);
    return inTenantTransaction(runtime.db, ctx, (trx) => fn(trx, ctx));
  };
  const deliver = (
    tenantId: string,
    provider: EmailProvider = fake,
    extra: { leaseSeconds?: number } = {},
  ): Promise<TenantDeliveryReport> =>
    deliverTenantMessages(runtime.db, tenantId, {
      provider,
      fromAddress: "bookings@tidegrid.test",
      runId: `run-${randomUUID()}`,
      ...extra,
    });
  const enqueue = (
    tenantId: string,
    key: string,
    to = "guest@example.test",
    notBefore: Date | null = null,
  ) =>
    inTenant(tenantId, (trx, ctx) =>
      enqueueMessage(trx, ctx, {
        dedupeKey: `adv.message:${key}`,
        template: "adv_message",
        templateVersion: 1,
        to: { email: to, name: "Synthetic Guest" },
        content: content(`Synthetic ${key}`),
        notBefore,
      }),
    );
  async function row(messageId: string) {
    const [r] = await admin<
      {
        state: string;
        attempts: number;
        last_error_code: string | null;
        provider_message_id: string | null;
        failed: boolean;
        wait: number | null;
      }[]
    >`
      select state, attempts, last_error_code, provider_message_id, failed_at is not null as failed,
             case when state = 'queued' and last_attempt_at is not null
                  then extract(epoch from next_attempt_at - last_attempt_at)::int end as wait
        from public.email_messages where id = ${messageId}`;
    if (!r) throw new Error(`no message ${messageId}`);
    return r;
  }
  async function makeDue(messageId: string) {
    await admin`update public.email_messages set next_attempt_at = now() - interval '1 second'
               where id = ${messageId} and state = 'queued' and next_attempt_at > now()`;
  }
  async function lapseLease(messageId: string) {
    await admin`update public.email_messages set lease_expires_at = now() - interval '1 second'
               where id = ${messageId} and state = 'sending'`;
  }
  async function deliveries(tenantId: string, key: string) {
    const [r] = await admin<{ accepted: number; unavailable: number; rejected: number }[]>`
      select count(*) filter (where result = 'accepted')::int as accepted,
             count(*) filter (where result = 'unavailable')::int as unavailable,
             count(*) filter (where result = 'rejected')::int as rejected
        from public.fake_email_deliveries
       where tenant_id = ${tenantId} and idempotency_key = ${key}`;
    return r ?? { accepted: 0, unavailable: 0, rejected: 0 };
  }
  /** Tenants app.email_delivery_tenants names, as the runtime sees them. */
  async function dueTenants(): Promise<string[]> {
    const { rows } = await sql<{ tenant_id: string }>`
      select tenant_id from app.email_delivery_tenants(1000)`.execute(runtime.db);
    return rows.map((r) => r.tenant_id);
  }
  async function newTenant(label: string): Promise<string> {
    const id = randomUUID();
    const slug = `${label}-${id.slice(0, 8)}`;
    await admin`insert into public.tenants (id, slug, display_name)
      values (${id}, ${slug}, ${`Messaging ${slug}`})`;
    return id;
  }

  /** A provider that counts calls and answers as told. */
  function scripted(answer: (email: OutgoingEmail) => Promise<{ providerMessageId: string }>) {
    const calls: string[] = [];
    const provider: EmailProvider = {
      name: "fake",
      send: async (email) => {
        calls.push(email.idempotencyKey);
        return answer(email);
      },
    };
    return { provider, calls };
  }

  beforeAll(async () => {
    if (!env) return;
    admin = postgres(env.adminUrl, { max: 3, onnotice: () => {} });
    runtime = createDb(env.runtimeUrl, { max: 10 });
    fake = new FakeEmailProvider({ db: runtime.db, environment: "local" });
    A = await newTenant("adv-msg-a");
    B = await newTenant("adv-msg-b");
  });

  afterAll(async () => {
    await runtime?.end();
    await admin?.end({ timeout: 5 });
  });

  it("retries a temporary failure after 1, 5, 15, and 60 minutes, then 4 hours, and fails after six attempts", async () => {
    const { messageId } = await enqueue(A, "exhaust");
    const down = scripted(async () => {
      throw new EmailProviderUnavailableError();
    });
    const waits: (number | null)[] = [];
    for (let attempt = 1; attempt <= MAX_DELIVERY_ATTEMPTS; attempt++) {
      await makeDue(messageId);
      const run = await deliver(A, down.provider);
      const item = run.items.find((i) => i.messageId === messageId);
      const stored = await row(messageId);
      expect(stored.attempts).toBe(attempt);
      if (attempt < MAX_DELIVERY_ATTEMPTS) {
        expect(item).toMatchObject({ outcome: "retry", code: "provider_unavailable" });
        expect(stored).toMatchObject({ state: "queued", last_error_code: "provider_unavailable" });
        waits.push(stored.wait);
      } else {
        expect(item).toMatchObject({ outcome: "failed", code: "retries_exhausted" });
        expect(stored).toMatchObject({
          state: "failed",
          last_error_code: "retries_exhausted",
          failed: true,
        });
      }
    }
    expect(RETRY_BACKOFF_SECONDS).toEqual([60, 300, 900, 3600, 14_400]);
    // Each wait is the schedule's, give or take the seconds one run takes.
    waits.forEach((wait, i) => {
      const want = [60, 300, 900, 3600, 14_400][i] ?? 0;
      expect(wait ?? -1).toBeGreaterThanOrEqual(want);
      expect(wait ?? Number.POSITIVE_INFINITY).toBeLessThan(want + 30);
    });
    expect(down.calls.filter((k) => k === messageId)).toHaveLength(MAX_DELIVERY_ATTEMPTS);
    // Failed for good: no later run tries again.
    await deliver(A, down.provider);
    expect(down.calls.filter((k) => k === messageId)).toHaveLength(MAX_DELIVERY_ATTEMPTS);
    const status = await inTenant(A, (trx) => getMessageStatus(trx, A, messageId));
    expect(status).toMatchObject({
      state: "failed",
      attempts: 6,
      failureCode: "retries_exhausted",
    });
    expect(status?.failedAt).not.toBeNull();
  });

  it("stops after six attempts even when every attempt crashed past its lease, without sending again", async () => {
    const T = await newTenant("adv-msg-crash");
    const { messageId } = await enqueue(T, "crash");
    for (let attempt = 1; attempt <= MAX_DELIVERY_ATTEMPTS; attempt++) {
      // A claim that crashed before it could send or record anything.
      await admin`update public.email_messages
                     set state = 'sending', attempts = attempts + 1, provider = 'fake',
                         lease_expires_at = now() + interval '2 minutes'
                   where id = ${messageId}`;
      expect(await dueTenants()).not.toContain(T);
      await lapseLease(messageId);
      expect(await dueTenants()).toContain(T);
    }
    const counting = scripted((email) => fake.send(email));
    const run = await deliver(T, counting.provider);
    expect(run.items).toEqual([
      {
        messageId,
        attempt: MAX_DELIVERY_ATTEMPTS + 1,
        outcome: "failed",
        code: "retries_exhausted",
      },
    ]);
    expect(counting.calls).toEqual([]);
    expect(await row(messageId)).toMatchObject({
      state: "failed",
      attempts: MAX_DELIVERY_ATTEMPTS + 1,
      last_error_code: "retries_exhausted",
    });
    expect(await dueTenants()).not.toContain(T);
  });

  it("records an attempt's outcome only while it is the latest: a stale failure never undoes a send", async () => {
    for (const stale of [
      () => new EmailProviderUnavailableError(),
      () => new EmailProviderRejectedError("bounced"),
      () => new Error("socket hang up"),
    ]) {
      const { messageId } = await enqueue(A, `stale-${randomUUID()}`);
      const entered = gate();
      const release = gate();
      // The first run stalls before the provider answers; its lease lapses meanwhile.
      const stalling: EmailProvider = {
        name: "fake",
        send: async (email) => {
          if (email.idempotencyKey !== messageId) return fake.send(email);
          entered.open();
          await release.opened;
          throw stale();
        },
      };
      const first = settle(deliver(A, stalling));
      await entered.opened;
      await lapseLease(messageId);
      const second = await deliver(A);
      expect(second.items.find((i) => i.messageId === messageId)).toMatchObject({
        outcome: "sent",
        attempt: 2,
      });
      release.open();
      const late = await first;
      if (!late.ok) throw new Error(`the stalled run failed: ${late.message}`);
      expect(late.value.items.find((i) => i.messageId === messageId)).toMatchObject({
        outcome: "superseded",
        attempt: 1,
      });
      expect(await row(messageId)).toMatchObject({
        state: "sent",
        attempts: 2,
        last_error_code: null,
      });
      expect((await deliveries(A, messageId)).accepted).toBe(1);
    }
  });

  it("sends the email the provider first accepted when an attempt crashed after sending", async () => {
    const { messageId } = await enqueue(A, "crash-after-send");
    // A run sends, then dies before recording: the message stays sending.
    const dying: EmailProvider = {
      name: "fake",
      send: async (email) => {
        const accepted = await fake.send(email);
        if (email.idempotencyKey === messageId) {
          await lapseLease(messageId);
          throw new EmailProviderUnavailableError("provider_unavailable", "the answer was lost");
        }
        return accepted;
      },
    };
    await deliver(A, dying);
    expect(await row(messageId)).toMatchObject({ state: "queued", attempts: 1 });
    const [first] = await admin<{ id: string }[]>`
      select id from public.fake_email_deliveries
       where idempotency_key = ${messageId} and result = 'accepted'`;
    await makeDue(messageId);
    await deliver(A);
    expect(await row(messageId)).toMatchObject({
      state: "sent",
      attempts: 2,
      provider_message_id: first?.id,
    });
    expect((await deliveries(A, messageId)).accepted).toBe(1);
  });

  it("cancels a queued or sending message or finds it sent, never both canceled and recorded sent", async () => {
    const seen = new Set<string>();
    for (let round = 0; round < 8; round++) {
      const { messageId } = await enqueue(B, `cancel-race-${randomUUID()}`);
      const go = gate();
      const cancel = go.opened.then(async () => {
        if (round % 2 === 1) await sleep(5);
        return inTenant(B, (trx, ctx) => cancelMessage(trx, ctx, messageId));
      });
      const run = go.opened.then(async () => {
        if (round % 2 === 0) await sleep(5);
        return deliver(B);
      });
      go.open();
      const [canceled, ran] = await Promise.all([settle(cancel), settle(run)]);
      if (!canceled.ok || !ran.ok) throw new Error("a racer failed");
      const stored = await row(messageId);
      const sent = (await deliveries(B, messageId)).accepted;
      if (canceled.value.kind === "canceled") {
        // Canceled before its claim, nothing went out; canceled mid-send, the
        // email may have gone out once, and the message still records canceled.
        expect(stored.state).toBe("canceled");
        expect(sent).toBeLessThanOrEqual(canceled.value.inFlight ? 1 : 0);
      } else {
        expect(canceled.value).toMatchObject({ kind: "not_cancelable" });
        expect(stored.state).toBe("sent");
        expect(sent).toBe(1);
      }
      seen.add(canceled.value.kind);
    }
    expect(seen.size).toBeGreaterThan(0);
  });

  it("enqueues one message per key, even concurrently, and keys never cross tenants", async () => {
    const key = `same-${randomUUID()}`;
    const go = gate();
    const racing = Array.from({ length: 8 }, () => settle(go.opened.then(() => enqueue(A, key))));
    go.open();
    const results = await Promise.all(racing);
    const ids = new Set<string>();
    let enqueued = 0;
    for (const r of results) {
      if (!r.ok) throw new Error(`${r.code} ${r.message}`);
      ids.add(r.value.messageId);
      if (r.value.kind === "enqueued") enqueued += 1;
    }
    expect(enqueued).toBe(1);
    expect(ids.size).toBe(1);
    const inB = await enqueue(B, key);
    expect(inB.kind).toBe("enqueued");
    expect(ids.has(inB.messageId)).toBe(false);
    const [counts] = await admin<{ a: number; b: number }[]>`
      select count(*) filter (where tenant_id = ${A})::int as a,
             count(*) filter (where tenant_id = ${B})::int as b
        from public.email_messages where dedupe_key = ${`adv.message:${key}`}`;
    expect(counts).toEqual({ a: 1, b: 1 });
    // Another tenant cannot read, cancel, or claim it.
    const [aId] = [...ids];
    if (!aId) throw new Error("no id");
    expect(await inTenant(B, (trx) => getMessageStatus(trx, B, aId))).toBeNull();
    expect(await inTenant(B, (trx, ctx) => cancelMessage(trx, ctx, aId))).toEqual({
      kind: "not_found",
    });
    const runB = await deliver(B);
    expect(runB.items.map((i) => i.messageId)).not.toContain(aId);
    await deliver(A);
    expect((await deliveries(A, aId)).accepted).toBe(1);
    expect((await deliveries(B, inB.messageId)).accepted).toBe(1);
    expect((await deliveries(B, aId)).accepted).toBe(0);
  });

  it("waits for notBefore, never jumps the queue, and lists a tenant only with due work", async () => {
    const T = await newTenant("adv-msg-later");
    const later = await enqueue(T, "later", "guest@example.test", new Date(Date.now() + 3_600_000));
    expect(await dueTenants()).not.toContain(T);
    expect((await deliver(T)).claimed).toBe(0);
    const past = await enqueue(T, "past", "guest@example.test", new Date(Date.now() - 86_400_000));
    const [clamped] = await admin<{ ok: boolean }[]>`
      select next_attempt_at >= created_at as ok from public.email_messages where id = ${past.messageId}`;
    expect(clamped?.ok).toBe(true);
    expect(await dueTenants()).toContain(T);
    const run = await deliver(T);
    expect(run.items.map((i) => i.messageId)).toEqual([past.messageId]);
    expect((await row(later.messageId)).state).toBe("queued");
    expect(await dueTenants()).not.toContain(T);
    // The tenant list names tenants and nothing else.
    const { rows } = await sql<Record<string, unknown>>`
      select * from app.email_delivery_tenants(1000)`.execute(runtime.db);
    for (const r of rows) expect(Object.keys(r)).toEqual(["tenant_id"]);
  });

  it("reads a message's status without its recipient or its content", async () => {
    const recipient = "status.private@example.test";
    const { messageId } = await enqueue(A, `status-${randomUUID()}`, recipient);
    await deliver(A);
    const status = await inTenant(A, (trx) => getMessageStatus(trx, A, messageId));
    expect(Object.keys(status ?? {}).sort()).toEqual(
      [
        "attempts",
        "canceledAt",
        "createdAt",
        "failedAt",
        "failureCode",
        "id",
        "lastAttemptAt",
        "nextAttemptAt",
        "provider",
        "sentAt",
        "state",
        "template",
        "templateVersion",
      ].sort(),
    );
    const text = JSON.stringify(status);
    expect(text).not.toContain(recipient);
    expect(text).not.toContain("Synthetic status");
    expect(text).not.toContain("adversarial suite");
  });

  it("claims only due work, as one more attempt under a lease of at most ten minutes, for every role", async () => {
    const T = await newTenant("adv-msg-claim");
    const later = await enqueue(T, "later", "guest@example.test", new Date(Date.now() + 3_600_000));
    const claim = (messageId: string, lease: string) =>
      admin`update public.email_messages
               set state = 'sending', attempts = attempts + 1, provider = 'fake',
                   lease_expires_at = now() + ${lease}::interval
             where id = ${messageId}`;
    expect(await refusal(claim(later.messageId, "1 minute"))).toEqual({
      code: "23514",
      constraint: "email_messages_claim",
    });
    const now = await enqueue(T, "now");
    expect(await refusal(claim(now.messageId, "11 minutes"))).toEqual({
      code: "23514",
      constraint: "email_messages_claim",
    });
    await claim(now.messageId, "5 minutes");
    // A live lease is not claimed again, and a delivery run leaves it alone.
    expect(await refusal(claim(now.messageId, "1 minute"))).toEqual({
      code: "23514",
      constraint: "email_messages_claim",
    });
    expect((await deliver(T)).claimed).toBe(0);
    // A lease never grows.
    expect(
      await refusal(admin`update public.email_messages
          set lease_expires_at = lease_expires_at + interval '1 minute' where id = ${now.messageId}`),
    ).toEqual({ code: "23514", constraint: "email_messages_transition" });
    // A message being sent can be canceled; it is then never claimed again.
    const doomed = await enqueue(T, "doomed");
    await claim(doomed.messageId, "5 minutes");
    expect(await inTenant(T, (trx, ctx) => cancelMessage(trx, ctx, doomed.messageId))).toEqual({
      kind: "canceled",
      inFlight: true,
      revokedLinks: 0,
    });
    expect(await row(doomed.messageId)).toMatchObject({ state: "canceled", attempts: 1 });
    // A run asking for a longer lease than the database allows claims nothing.
    await lapseLease(now.messageId);
    const greedy = await settle(deliver(T, fake, { leaseSeconds: 601 }));
    expect(greedy).toMatchObject({ ok: false, code: "23514", constraint: "email_messages_claim" });
    expect(await row(now.messageId)).toMatchObject({ state: "sending", attempts: 1 });
    const run = await deliver(T);
    expect(run.items).toEqual([
      { messageId: now.messageId, attempt: 2, outcome: "sent", code: null },
    ]);
  });

  it("tries a fail-once recipient once per due run when runs overlap, then sends it once", async () => {
    const T = await newTenant("adv-msg-flaky");
    const { messageId } = await enqueue(T, "flaky", "synthetic.flaky+fail-once@example.test");
    const runs = await Promise.all([deliver(T), deliver(T), deliver(T)]);
    expect(runs.reduce((n, r) => n + r.claimed, 0)).toBe(1);
    expect(await row(messageId)).toMatchObject({
      state: "queued",
      attempts: 1,
      last_error_code: "provider_unavailable",
    });
    expect(await deliveries(T, messageId)).toEqual({ accepted: 0, unavailable: 1, rejected: 0 });
    await makeDue(messageId);
    const again = await Promise.all([deliver(T), deliver(T), deliver(T)]);
    expect(again.reduce((n, r) => n + r.sent, 0)).toBe(1);
    // Sent on its second attempt, it no longer reports the first attempt's error.
    expect(await row(messageId)).toMatchObject({
      state: "sent",
      attempts: 2,
      last_error_code: null,
    });
    expect(await deliveries(T, messageId)).toEqual({ accepted: 1, unavailable: 1, rejected: 0 });
  });

  it("reports a canceled message's own reason, or none, never an earlier attempt's error", async () => {
    const T = await newTenant("adv-msg-cancel-code");
    const plain = await enqueue(T, "plain", "synthetic.plain+fail-once@example.test");
    const named = await enqueue(T, "named", "synthetic.named+fail-once@example.test");
    await deliver(T);
    expect(await row(plain.messageId)).toMatchObject({
      state: "queued",
      last_error_code: "provider_unavailable",
    });
    await inTenant(T, (trx, ctx) => cancelMessage(trx, ctx, plain.messageId));
    await inTenant(T, (trx, ctx) =>
      cancelMessage(trx, ctx, named.messageId, { code: "recipient_changed" }),
    );
    expect(
      (await inTenant(T, (trx) => getMessageStatus(trx, T, plain.messageId)))?.failureCode,
    ).toBeNull();
    expect(
      (await inTenant(T, (trx) => getMessageStatus(trx, T, named.messageId)))?.failureCode,
    ).toBe("recipient_changed");
  });

  it("fails a bounced recipient at once and never tries it again", async () => {
    const T = await newTenant("adv-msg-bounce");
    const { messageId } = await enqueue(T, "bounce", "synthetic.gone+bounce@example.test");
    await deliver(T);
    await deliver(T);
    expect(await row(messageId)).toMatchObject({
      state: "failed",
      attempts: 1,
      last_error_code: "bounced",
    });
    expect(await deliveries(T, messageId)).toEqual({ accepted: 0, unavailable: 0, rejected: 1 });
    const status = await inTenant(T, (trx) => getMessageStatus(trx, T, messageId));
    expect(status).toMatchObject({ state: "failed", failureCode: "bounced", attempts: 1 });
  });

  it("keeps the fake's first acceptance per key under concurrent sends, and refuses production", async () => {
    expect(() => new FakeEmailProvider({ db: runtime.db, environment: "production" })).toThrow();
    const key = randomUUID();
    const email = (subject: string): OutgoingEmail => ({
      idempotencyKey: key,
      tenantId: A,
      from: { email: "bookings@tidegrid.test", name: "Synthetic Sender" },
      replyTo: null,
      to: { email: "guest@example.test", name: "Synthetic Guest" },
      subject,
      html: `<p>${subject}</p>`,
      text: subject,
    });
    const go = gate();
    const racing = Array.from({ length: 6 }, (_, i) =>
      settle(go.opened.then(() => fake.send(email(`Synthetic send ${i}`)))),
    );
    go.open();
    const ids = new Set<string>();
    for (const r of await Promise.all(racing)) {
      if (!r.ok) throw new Error(`${r.code} ${r.message}`);
      ids.add(r.value.providerMessageId);
    }
    expect(ids.size).toBe(1);
    expect((await deliveries(A, key)).accepted).toBe(1);
    // The same key in another tenant's mailbox is another email.
    const other = await fake.send({ ...email("Synthetic other tenant"), tenantId: B });
    expect(ids.has(other.providerMessageId)).toBe(false);
    expect(await fake.getMailboxMessage(B, [...ids][0] ?? "")).toBeNull();
  });
});
