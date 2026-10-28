/**
 * Delivery over the Cloudflare email adapter and its recorded fixture
 * (G2.16a), against a throwaway PostgreSQL 17 as tidegrid_app. Two tenants
 * throughout. Messages here carry no access link (a link needs a booking);
 * link-carrying kinds are covered in
 * packages/domain-booking/src/adversarial/cloudflare-email.integration.test.ts.
 *
 * Cloudflare documents no idempotency key, so the adapter says
 * `deduplicates: false`, and delivery must never repeat a send whose outcome
 * is unknown (coordinator default D1 B, at most once). The fake's path is
 * unchanged. An account-level fault stops the run and the sweep (D2 B). A
 * run with a deadline stops claiming in time.
 */
import { randomUUID } from "node:crypto";
import {
  createDb,
  inTenantTransaction,
  type TenantContext,
  type TenantTransaction,
} from "@tidegrid/database";
import type {} from "@tidegrid/database/global-setup";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";
import { createCloudflareEmailFixture } from "./cloudflare-fixture.ts";
import {
  createCloudflareEmailProvider,
  type DeliveryOptions,
  deliverTenantMessages,
  type EmailContent,
  type EmailProvider,
  EmailProviderUnavailableError,
  enqueueMessage,
  FakeEmailProvider,
  getMessageStatus,
  type RecipientPolicy,
  sweepEmail,
  type TenantDeliveryReport,
} from "./index.ts";

type Sql = ReturnType<typeof postgres>;

const env = inject("integrationDb");
const FROM = "bookings@tidegrid.test";

const content = (subject: string): EmailContent => ({
  subject,
  blocks: [
    { kind: "heading", text: "Synthetic" },
    { kind: "paragraph", text: "A synthetic message for the Cloudflare adapter suite." },
  ],
});

describe.skipIf(!env)("delivery over the Cloudflare email adapter (G2.16a)", () => {
  let admin: Sql;
  let runtime: ReturnType<typeof createDb>;
  let A: string;
  let B: string;
  const run = randomUUID().slice(0, 8);
  const addr = (label: string) => `cf.${run}.${label}@example.test`;

  const ctxFor = (tenantId: string): TenantContext => ({
    tenantId,
    actorType: "system",
    actorId: "cloudflare-email-test",
    requestId: `req-${randomUUID()}`,
  });
  const inTenant = <T>(
    tenantId: string,
    fn: (trx: TenantTransaction, ctx: TenantContext) => Promise<T>,
  ) => {
    const ctx = ctxFor(tenantId);
    return inTenantTransaction(runtime.db, ctx, (trx) => fn(trx, ctx));
  };
  async function enqueue(tenantId: string, key: string, to: string) {
    const done = await inTenant(tenantId, (trx, ctx) =>
      enqueueMessage(trx, ctx, {
        dedupeKey: `cf.message:${run}-${key}`,
        template: "cf_message",
        templateVersion: 1,
        to: { email: to, name: "Synthetic Guest" },
        content: content(`Synthetic ${key}`),
      }),
    );
    return done.messageId;
  }
  /** The adapter over a fresh fixture, fenced to this run's addresses. */
  function cloudflare(
    options: { recipients?: RecipientPolicy; timeoutMs?: number; tenantId?: string } = {},
  ) {
    const fixture = createCloudflareEmailFixture({
      allowedSenderAddresses: [FROM],
      ...(options.tenantId ? { tenantId: options.tenantId } : {}),
    });
    const all = [
      "ok",
      "a1",
      "a2",
      "a3",
      "b1",
      "id",
      "amb",
      "hang",
      "bug",
      "lease",
      "fake",
      "acct1",
      "acct2",
      "acct3",
      "sweep",
      "dl1",
      "dl2",
      "dl3",
      "x+bounce",
      "x+fail-once",
    ].map(addr);
    const provider = createCloudflareEmailProvider({
      binding: fixture.binding,
      recipients: options.recipients ?? { kind: "only", addresses: new Set(all) },
      environment: "local",
      timeoutMs: options.timeoutMs ?? 200,
    });
    /** The binding calls for one message, by its correlation header. */
    const callsFor = (messageId: string) =>
      fixture.sends.filter((s) => s.builder.headers["X-TideGrid-Message-Id"] === messageId).length;
    return { fixture, provider, callsFor };
  }
  const deliver = (
    tenantId: string,
    provider: EmailProvider,
    extra: Partial<DeliveryOptions> = {},
  ): Promise<TenantDeliveryReport> =>
    deliverTenantMessages(runtime.db, tenantId, {
      provider,
      fromAddress: FROM,
      runId: `run-${randomUUID()}`,
      ...extra,
    });
  async function row(messageId: string) {
    const [r] = await admin<
      {
        state: string;
        attempts: number;
        last_error_code: string | null;
        provider: string | null;
        provider_message_id: string | null;
        wait: number | null;
      }[]
    >`select state, attempts, last_error_code, provider, provider_message_id,
             case when state = 'queued' then extract(epoch from next_attempt_at - now())::int end as wait
        from public.email_messages where id = ${messageId}`;
    if (!r) throw new Error(`no message ${messageId}`);
    return r;
  }
  async function newTenant(label: string): Promise<string> {
    const id = randomUUID();
    const slug = `cf-${label}-${id.slice(0, 8)}`;
    await admin`insert into public.tenants (id, slug, display_name)
      values (${id}, ${slug}, ${`Cloudflare ${slug}`})`;
    return id;
  }
  async function makeDue(messageId: string) {
    await admin`update public.email_messages set next_attempt_at = now() - interval '1 second'
               where id = ${messageId} and state = 'queued' and next_attempt_at > now()`;
  }

  beforeAll(async () => {
    if (!env) return;
    admin = postgres(env.adminUrl, { max: 2, onnotice: () => {} });
    runtime = createDb(env.runtimeUrl, { max: 4 });
    A = await newTenant("a");
    B = await newTenant("b");
  });

  afterAll(async () => {
    await runtime?.end();
    await admin?.end({ timeout: 5 });
  });

  it("sends through the binding and records the provider and its id", async () => {
    const cf = cloudflare();
    const id = await enqueue(A, "ok", addr("ok"));
    const report = await deliver(A, cf.provider);
    expect(report.items.find((i) => i.messageId === id)).toMatchObject({ outcome: "sent" });
    const stored = await row(id);
    expect(stored).toMatchObject({ state: "sent", attempts: 1, provider: "cloudflare" });
    expect(stored.provider_message_id).toMatch(/^<[A-Za-z0-9]{36}@tidegrid\.test>$/);
    expect(cf.callsFor(id)).toBe(1);
    const sent = cf.fixture.sends.find((s) => s.builder.headers["X-TideGrid-Message-Id"] === id);
    expect(sent?.builder).toMatchObject({
      from: { email: FROM },
      to: { email: addr("ok"), name: "Synthetic Guest" },
      subject: "Synthetic ok",
      headers: { "Auto-Submitted": "auto-generated" },
    });
    expect(sent?.builder.html).toContain("A synthetic message");
    expect(sent?.builder.text).toContain("A synthetic message");
    const status = await inTenant(A, (trx) => getMessageStatus(trx, A, id));
    expect(status).toMatchObject({ state: "sent", provider: "cloudflare", failureCode: null });
  });

  it("stores a normalized id that the message table admits", async () => {
    const cf = cloudflare();
    const id = await enqueue(A, "id", addr("id"));
    cf.fixture.answerId(`{an id with spaces and braces ${"z".repeat(300)}}`);
    await deliver(A, cf.provider);
    const stored = await row(id);
    expect(stored.state).toBe("sent");
    expect(stored.provider_message_id).toMatch(/^cfh_[0-9a-f]{40}$/);
  });

  it("fails a suppressed recipient at once, and retries a rate limit with a backoff", async () => {
    const cf = cloudflare();
    const bounced = await enqueue(A, "bounce", addr("x+bounce"));
    const limited = await enqueue(A, "limited", addr("x+fail-once"));
    await deliver(A, cf.provider);
    expect(await row(bounced)).toMatchObject({
      state: "failed",
      attempts: 1,
      last_error_code: "recipient_suppressed",
    });
    const queued = await row(limited);
    expect(queued).toMatchObject({
      state: "queued",
      attempts: 1,
      last_error_code: "provider_rate_limited",
    });
    expect(queued.wait).toBeGreaterThan(30);
    await makeDue(limited);
    await deliver(A, cf.provider);
    expect(await row(limited)).toMatchObject({ state: "sent", attempts: 2 });
    expect(cf.callsFor(limited)).toBe(2);
  });

  it("fails a recipient off the allowlist with no binding call", async () => {
    const cf = cloudflare({ recipients: { kind: "only", addresses: new Set([addr("other")]) } });
    const id = await enqueue(A, "fenced", "synthetic.guest@guests.demo-reef.test");
    await deliver(A, cf.provider);
    expect(await row(id)).toMatchObject({
      state: "failed",
      attempts: 1,
      last_error_code: "recipient_not_allowed",
    });
    expect(cf.fixture.sends).toHaveLength(0);
  });

  it("never claims, sends or records another tenant's message", async () => {
    const cf = cloudflare();
    const a = await enqueue(A, "a1", addr("a1"));
    const b = await enqueue(B, "b1", addr("b1"));
    const report = await deliver(A, cf.provider);
    expect(report.items.map((i) => i.messageId)).not.toContain(b);
    expect(report.items.find((i) => i.messageId === a)?.outcome).toBe("sent");
    expect(cf.callsFor(b)).toBe(0);
    expect(await row(b)).toMatchObject({ state: "queued", attempts: 0, provider: null });
    // B's own run sends it.
    await deliver(B, cf.provider);
    expect(await row(b)).toMatchObject({ state: "sent", provider: "cloudflare" });
  });

  describe("at most once on a provider that does not deduplicate (D1 B)", () => {
    it("fails an ambiguous provider error as outcome_unknown and never sends it again", async () => {
      const cf = cloudflare();
      const id = await enqueue(A, "amb", addr("amb"));
      cf.fixture.failNext("E_INTERNAL_SERVER_ERROR");
      const first = await deliver(A, cf.provider);
      expect(first.items.find((i) => i.messageId === id)).toMatchObject({
        outcome: "failed",
        code: "outcome_unknown",
      });
      expect(await row(id)).toMatchObject({
        state: "failed",
        attempts: 1,
        last_error_code: "outcome_unknown",
        provider_message_id: null,
      });
      await deliver(A, cf.provider);
      expect(cf.callsFor(id)).toBe(1);
      const status = await inTenant(A, (trx) => getMessageStatus(trx, A, id));
      expect(status).toMatchObject({ state: "failed", failureCode: "outcome_unknown" });
    });

    it("fails a timed-out send as outcome_unknown", async () => {
      const cf = cloudflare({ timeoutMs: 30 });
      const id = await enqueue(A, "hang", addr("hang"));
      cf.fixture.hangNext();
      await deliver(A, cf.provider);
      expect(await row(id)).toMatchObject({ state: "failed", last_error_code: "outcome_unknown" });
      await deliver(A, cf.provider);
      expect(cf.callsFor(id)).toBe(1);
    });

    it("fails an unexpected throw from a non-deduplicating provider as outcome_unknown", async () => {
      const id = await enqueue(A, "bug", addr("bug"));
      let calls = 0;
      const reported: string[] = [];
      const buggy: EmailProvider = {
        name: "cloudflare",
        deduplicates: false,
        send: async () => {
          calls += 1;
          throw new Error("a bug after the provider may have accepted");
        },
      };
      await deliver(A, buggy, { onSendError: (messageId) => reported.push(messageId) });
      expect(await row(id)).toMatchObject({ state: "failed", last_error_code: "outcome_unknown" });
      expect(reported).toEqual([id]);
      await deliver(A, buggy);
      expect(calls).toBe(1);
    });

    it("fails a lapsed lease as outcome_unknown instead of sending a second copy", async () => {
      const cf = cloudflare();
      const id = await enqueue(A, "lease", addr("lease"));
      let second: TenantDeliveryReport | undefined;
      // The provider accepts, then the run stalls past its lease (a crash or a
      // waitUntil cancel looks the same): another run finds the lapsed lease.
      const stalling: EmailProvider = {
        name: "cloudflare",
        deduplicates: false,
        send: async (email) => {
          const sent = await cf.provider.send(email);
          if (email.idempotencyKey === id && !second) {
            await admin`update public.email_messages
                           set lease_expires_at = now() - interval '1 second'
                         where id = ${id}`;
            second = await deliver(A, cf.provider);
          }
          return sent;
        },
      };
      const first = await deliver(A, stalling);
      expect(second?.items.find((i) => i.messageId === id)).toMatchObject({
        outcome: "failed",
        code: "outcome_unknown",
        attempt: 1,
      });
      expect(first.items.find((i) => i.messageId === id)?.outcome).toBe("superseded");
      expect(cf.callsFor(id)).toBe(1);
      expect(await row(id)).toMatchObject({
        state: "failed",
        attempts: 1,
        last_error_code: "outcome_unknown",
      });
    });

    it("leaves the fake's path unchanged: an unknown outcome retries with the same key", async () => {
      const fake = new FakeEmailProvider({ db: runtime.db, environment: "local" });
      const id = await enqueue(A, "fake", addr("fake"));
      // A deduplicating provider (the fake, or a double that says nothing)
      // answers an unknown outcome: it is queued again, as before G2.16a.
      const lost: EmailProvider = {
        name: "fake",
        send: async (email) => {
          await fake.send(email);
          throw new EmailProviderUnavailableError();
        },
      };
      await deliver(A, lost);
      expect(await row(id)).toMatchObject({
        state: "queued",
        attempts: 1,
        last_error_code: "provider_unavailable",
      });
      await makeDue(id);
      await deliver(A, fake);
      expect(await row(id)).toMatchObject({ state: "sent", attempts: 2, provider: "fake" });
      const [n] = await admin<{ n: number }[]>`
        select count(*)::int as n from public.fake_email_deliveries
         where idempotency_key = ${id} and result = 'accepted'`;
      expect(n?.n).toBe(1);
    });
  });

  describe("account-level faults (D2 B)", () => {
    it("stop the tenant run after the first message, which retries", async () => {
      const cf = cloudflare();
      const C = await newTenant("acct");
      const ids = [
        await enqueue(C, "acct1", addr("acct1")),
        await enqueue(C, "acct2", addr("acct2")),
        await enqueue(C, "acct3", addr("acct3")),
      ];
      cf.fixture.failNext("E_SENDER_NOT_VERIFIED");
      const report = await deliver(C, cf.provider);
      expect(report.claimed).toBe(1);
      expect(report.stopped).toBe("account_fault");
      expect(report.items[0]).toMatchObject({ outcome: "retry", code: "sender_not_verified" });
      expect(cf.fixture.sends).toHaveLength(1);
      const states = await Promise.all(ids.map(row));
      expect(states.map((s) => s.state)).toEqual(["queued", "queued", "queued"]);
      expect(states.filter((s) => s.attempts === 1)).toHaveLength(1);
    });

    it("stop the sweep after the first fault, whichever tenant meets it", async () => {
      await enqueue(A, "sweep", addr("sweep"));
      await enqueue(B, "sweep", addr("sweep"));
      let calls = 0;
      const suspended: EmailProvider = {
        name: "cloudflare",
        deduplicates: false,
        send: async () => {
          calls += 1;
          throw new EmailProviderUnavailableError(
            "provider_account_suspended",
            "the email provider did not take the message: provider_account_suspended",
            { outcome: "not_sent", scope: "account" },
          );
        },
      };
      const report = await sweepEmail(runtime.db, {
        provider: suspended,
        fromAddress: FROM,
        runId: `sweep-${randomUUID()}`,
      });
      expect(calls).toBe(1);
      expect(report.accountFault).toBe(true);
      expect(report.complete).toBe(false);
      expect(report.retried).toBe(1);
    });
  });

  describe("a run with a deadline", () => {
    it("claims nothing once the budget is spent and leaves the mail queued", async () => {
      const cf = cloudflare();
      const D = await newTenant("dl1");
      const id = await enqueue(D, "dl1", addr("dl1"));
      const report = await deliver(D, cf.provider, { deadline: Date.now() + 1_000 });
      expect(report).toMatchObject({ claimed: 0, stopped: "deadline" });
      expect(await row(id)).toMatchObject({ state: "queued", attempts: 0 });
      expect(cf.callsFor(id)).toBe(0);
    });

    it("reserves the provider's send bound and a margin for each claim", async () => {
      const cf = cloudflare({ timeoutMs: 10_000 });
      const D = await newTenant("dl2");
      const ids = [await enqueue(D, "dl2", addr("dl2")), await enqueue(D, "dl3", addr("dl3"))];
      // The first check has room for one 10 s send and the 2 s margin; by
      // the second, 5 s have passed and it has not.
      let now = 1_000_000;
      const report = await deliver(D, cf.provider, {
        deadline: now + 12_500,
        clock: () => {
          const t = now;
          now += 5_000;
          return t;
        },
      });
      expect(report).toMatchObject({ claimed: 1, sent: 1, stopped: "deadline" });
      const states = (await Promise.all(ids.map(row))).map((r) => r.state).sort();
      expect(states).toEqual(["queued", "sent"]);
    });
  });
});
