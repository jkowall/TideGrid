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
import {
  cancelMessage,
  deliverTenantMessages,
  type EmailContent,
  type EmailProvider,
  enqueueMessage,
  FakeEmailProvider,
  getMessageStatus,
  sweepEmail,
} from "./index.ts";

type Sql = ReturnType<typeof postgres>;

const env = inject("integrationDb");

async function failure(p: Promise<unknown>): Promise<{ code?: string; constraint?: string }> {
  try {
    await p;
  } catch (err) {
    const e = err as { code?: string; constraint_name?: string };
    return {
      ...(e.code ? { code: e.code } : {}),
      ...(e.constraint_name ? { constraint: e.constraint_name } : {}),
    };
  }
  throw new Error("expected a database error");
}

const content = (subject: string): EmailContent => ({
  subject,
  blocks: [
    { kind: "heading", text: "Hello <there>" },
    { kind: "paragraph", text: "A synthetic message." },
  ],
});

describe.skipIf(!env)(
  "email messages, delivery, and the fake provider against a real database",
  () => {
    let admin: Sql;
    let runtime: ReturnType<typeof createDb>;
    let fake: FakeEmailProvider;
    let A: string;
    let B: string;

    const ctxFor = (tenantId: string): TenantContext => ({
      tenantId,
      actorType: "system",
      actorId: "messaging-test",
      requestId: `req-${randomUUID()}`,
    });
    const inTenant = <T>(
      tenantId: string,
      fn: (trx: TenantTransaction, ctx: TenantContext) => Promise<T>,
    ) => {
      const ctx = ctxFor(tenantId);
      return inTenantTransaction(runtime.db, ctx, (trx) => fn(trx, ctx));
    };
    const deliver = (tenantId: string, provider: EmailProvider = fake) =>
      deliverTenantMessages(runtime.db, tenantId, {
        provider,
        fromAddress: "bookings@tidegrid.test",
        runId: `run-${randomUUID()}`,
      });
    async function enqueue(tenantId: string, key: string, to = "guest@example.test") {
      return inTenant(tenantId, (trx, ctx) =>
        enqueueMessage(trx, ctx, {
          dedupeKey: `test.message:${key}`,
          template: "test_message",
          templateVersion: 1,
          to: { email: to, name: "Test Guest" },
          content: content(`Message ${key}`),
        }),
      );
    }
    async function stateOf(messageId: string) {
      const [row] = await admin<
        {
          state: string;
          attempts: number;
          last_error_code: string | null;
          provider_message_id: string | null;
        }[]
      >`select state, attempts, last_error_code, provider_message_id
        from public.email_messages where id = ${messageId}`;
      return row;
    }
    async function makeDue(messageId: string) {
      await admin`update public.email_messages set next_attempt_at = now() - interval '1 second'
                 where id = ${messageId} and state = 'queued'`;
    }
    async function accepted(tenantId: string, key: string) {
      const [row] = await admin<{ n: number }[]>`
      select count(*)::int as n from public.fake_email_deliveries
       where tenant_id = ${tenantId} and idempotency_key = ${key} and result = 'accepted'`;
      return row?.n ?? 0;
    }

    beforeAll(async () => {
      if (!env) return;
      admin = postgres(env.adminUrl, { max: 2, onnotice: () => {} });
      runtime = createDb(env.runtimeUrl, { max: 4 });
      fake = new FakeEmailProvider({ db: runtime.db, environment: "local" });
      A = randomUUID();
      B = randomUUID();
      for (const [id, slug] of [
        [A, `msg-a-${A.slice(0, 8)}`],
        [B, `msg-b-${B.slice(0, 8)}`],
      ] as const) {
        await admin`insert into public.tenants (id, slug, display_name) values (${id}, ${slug}, ${`Messaging ${slug}`})`;
      }
      // Tenant A publishes a brand; B has none and gets the neutral one.
      await admin`insert into public.brand_config_versions (tenant_id, version, schema_version, config)
      values (${A}, 1, 1, ${admin.json({
        name: "Msg Harbor",
        colors: { primary: "#0b3c5d", accent: "#e0a526" },
        fonts: { display: "fraunces", body: "source-sans-3" },
        contact: { email: "Hello@Msg-Harbor.test" },
        legal: { terms: "/legal/terms", privacy: "/legal/privacy" },
        locale: "en-US",
        capabilities: [],
      })})`;
      await admin`insert into public.brand_activations (tenant_id, version, reason) values (${A}, 1, 'test')`;
    });

    afterAll(async () => {
      await runtime?.end();
      await admin?.end({ timeout: 5 });
    });

    it("enqueues once per key, rendered with the tenant's brand, and only with its transaction", async () => {
      const first = await enqueue(A, "brand");
      expect(first.kind).toBe("enqueued");
      const again = await enqueue(A, "brand");
      expect(again).toEqual({ kind: "duplicate", messageId: first.messageId });
      const [row] = await admin<
        {
          from_name: string;
          reply_to: string | null;
          html_body: string;
          to_email: string;
          state: string;
        }[]
      >`select from_name, reply_to, html_body, to_email, state from public.email_messages where id = ${first.messageId}`;
      expect(row).toMatchObject({
        from_name: "Msg Harbor",
        reply_to: "hello@msg-harbor.test",
        to_email: "guest@example.test",
        state: "queued",
      });
      expect(row?.html_body).toContain("Hello &lt;there&gt;");
      expect(row?.html_body).toContain("background:#0b3c5d");

      const neutral = await enqueue(B, "brand");
      const [b] = await admin<{ from_name: string; reply_to: string | null }[]>`
      select from_name, reply_to from public.email_messages where id = ${neutral.messageId}`;
      expect(b).toEqual({ from_name: expect.stringMatching(/^Messaging msg-b-/), reply_to: null });

      // Rolled back with its transaction: nothing is left to send.
      await expect(
        inTenant(A, async (trx, ctx) => {
          await enqueueMessage(trx, ctx, {
            dedupeKey: "test.message:rolled-back",
            template: "test_message",
            templateVersion: 1,
            to: { email: "guest@example.test" },
            content: content("Never sent"),
          });
          throw new Error("the change failed");
        }),
      ).rejects.toThrow("the change failed");
      const [gone] = await admin<{ n: number }[]>`
      select count(*)::int as n from public.email_messages where dedupe_key = 'test.message:rolled-back'`;
      expect(gone?.n).toBe(0);
    });

    it("sends once: a replayed run and a replayed enqueue send nothing more", async () => {
      const { messageId } = await enqueue(A, "once");
      const run = await deliver(A);
      expect(run.items.find((i) => i.messageId === messageId)).toMatchObject({
        outcome: "sent",
        attempt: 1,
      });
      expect(await stateOf(messageId)).toMatchObject({ state: "sent", attempts: 1 });
      const replay = await deliver(A);
      expect(replay.items.find((i) => i.messageId === messageId)).toBeUndefined();
      expect((await enqueue(A, "once")).kind).toBe("duplicate");
      await deliver(A);
      expect(await accepted(A, messageId)).toBe(1);
      const status = await inTenant(A, (trx) => getMessageStatus(trx, A, messageId));
      expect(status).toMatchObject({
        state: "sent",
        attempts: 1,
        failureCode: null,
        provider: "fake",
      });
      expect(status?.lastAttemptAt).not.toBeNull();
      expect(status?.sentAt).not.toBeNull();
    });

    it("retries a temporary failure with a backoff, then sends once", async () => {
      const { messageId } = await enqueue(A, "retry", "flaky+fail-once@example.test");
      await deliver(A);
      const [queued] = await admin<
        { state: string; attempts: number; code: string; wait: number }[]
      >`
      select state, attempts, last_error_code as code,
             extract(epoch from next_attempt_at - now())::int as wait
        from public.email_messages where id = ${messageId}`;
      expect(queued).toMatchObject({ state: "queued", attempts: 1, code: "provider_unavailable" });
      expect(queued?.wait).toBeGreaterThan(30);
      // Not due yet: another run leaves it alone.
      const early = await deliver(A);
      expect(early.items.find((i) => i.messageId === messageId)).toBeUndefined();
      await makeDue(messageId);
      await deliver(A);
      expect(await stateOf(messageId)).toMatchObject({ state: "sent", attempts: 2 });
      expect(await accepted(A, messageId)).toBe(1);
      const [rows] = await admin<{ n: number }[]>`
      select count(*)::int as n from public.fake_email_deliveries
       where idempotency_key = ${messageId} and result = 'unavailable'`;
      expect(rows?.n).toBe(1);
    });

    it("fails a refused message at once and keeps the code", async () => {
      const { messageId } = await enqueue(A, "bounce", "nobody+bounce@example.test");
      await deliver(A);
      expect(await stateOf(messageId)).toMatchObject({
        state: "failed",
        attempts: 1,
        last_error_code: "bounced",
      });
      expect(await accepted(A, messageId)).toBe(0);
      const status = await inTenant(A, (trx) => getMessageStatus(trx, A, messageId));
      expect(status).toMatchObject({ state: "failed", failureCode: "bounced" });
    });

    it("never sends twice when the outcome was lost or a lapsed lease is claimed again", async () => {
      // Lost answer: the provider accepted, then the call failed in transit.
      const lost = await enqueue(A, "lost");
      const losing: EmailProvider = {
        name: "fake",
        send: async (email) => {
          await fake.send(email);
          throw new Error("connection reset after the provider accepted");
        },
      };
      await deliver(A, losing);
      expect(await stateOf(lost.messageId)).toMatchObject({
        state: "queued",
        attempts: 1,
        last_error_code: "send_error",
      });
      await makeDue(lost.messageId);
      await deliver(A);
      expect(await stateOf(lost.messageId)).toMatchObject({ state: "sent", attempts: 2 });
      expect(await accepted(A, lost.messageId)).toBe(1);

      // A run that stalls past its lease: another run claims the message again
      // and sends it with the same key; the stalled run's answer is superseded.
      const stalled = await enqueue(A, "stalled");
      let second: Awaited<ReturnType<typeof deliver>> | undefined;
      const stalling: EmailProvider = {
        name: "fake",
        send: async (email) => {
          const sent = await fake.send(email);
          if (email.idempotencyKey === stalled.messageId && !second) {
            await admin`update public.email_messages set lease_expires_at = now() - interval '1 second'
                       where id = ${stalled.messageId}`;
            second = await deliver(A);
          }
          return sent;
        },
      };
      const first = await deliver(A, stalling);
      expect(first.items.find((i) => i.messageId === stalled.messageId)?.outcome).toBe(
        "superseded",
      );
      expect(second?.items.find((i) => i.messageId === stalled.messageId)).toMatchObject({
        outcome: "sent",
        attempt: 2,
      });
      expect(await stateOf(stalled.messageId)).toMatchObject({ state: "sent", attempts: 2 });
      expect(await accepted(A, stalled.messageId)).toBe(1);
    });

    it("claims each message once when runs overlap", async () => {
      const ids: string[] = [];
      for (let i = 0; i < 6; i++) ids.push((await enqueue(B, `overlap-${i}`)).messageId);
      const runs = await Promise.all([deliver(B), deliver(B), deliver(B)]);
      const sent = runs.flatMap((r) => r.items).filter((i) => ids.includes(i.messageId));
      expect(sent.filter((i) => i.outcome === "sent")).toHaveLength(6);
      for (const id of ids) expect(await accepted(B, id)).toBe(1);
    });

    it("cancels a message once, only its tenant's, and the sweep finds every tenant with due mail", async () => {
      const queued = await enqueue(A, "cancel");
      expect(await inTenant(A, (trx, ctx) => cancelMessage(trx, ctx, queued.messageId))).toEqual({
        kind: "canceled",
        inFlight: false,
        revokedLinks: 0,
      });
      expect(await inTenant(A, (trx, ctx) => cancelMessage(trx, ctx, queued.messageId))).toEqual({
        kind: "not_cancelable",
        state: "canceled",
      });
      // Another tenant cannot see it.
      expect(await inTenant(B, (trx, ctx) => cancelMessage(trx, ctx, queued.messageId))).toEqual({
        kind: "not_found",
      });
      const a = await enqueue(A, "sweep");
      const b = await enqueue(B, "sweep");
      const report = await sweepEmail(runtime.db, {
        provider: fake,
        fromAddress: "bookings@tidegrid.test",
        runId: `sweep-${randomUUID()}`,
      });
      expect(report.failedTenants).toBe(0);
      expect(await stateOf(a.messageId)).toMatchObject({ state: "sent" });
      expect(await stateOf(b.messageId)).toMatchObject({ state: "sent" });
      expect(await stateOf(queued.messageId)).toMatchObject({ state: "canceled" });
      expect(await accepted(A, queued.messageId)).toBe(0);
    });

    it("keeps content fixed and states one way, for every role", async () => {
      const { messageId } = await enqueue(A, "rules");
      const refused: [() => Promise<unknown>, string][] = [
        [
          () =>
            admin`update public.email_messages set to_email = 'other@example.test' where id = ${messageId}`,
          "email_messages_immutable",
        ],
        [
          () => admin`update public.email_messages set state = 'sent' where id = ${messageId}`,
          "email_messages_transition",
        ],
        [
          () =>
            admin`update public.email_messages set next_attempt_at = now() + interval '1 day'
                 where id = ${messageId}`,
          "email_messages_transition",
        ],
      ];
      for (const [statement, constraint] of refused) {
        expect(await failure(statement())).toEqual({ code: "23514", constraint });
      }
      expect(
        (await failure(admin`delete from public.email_messages where id = ${messageId}`)).code,
      ).toBe("55000");
      expect(
        await failure(
          admin`insert into public.email_messages (tenant_id, dedupe_key, template, template_version,
                to_email, from_name, subject, html_body, text_body, state)
              values (${A}, 'test.message:born-sent', 't', 1, 'x@example.test', 'X', 'S', 'h', 't', 'sent')`,
        ),
      ).toEqual({ code: "23514", constraint: "email_messages_transition" });
      // The runtime holds no DELETE, and another tenant's id under its own context is refused.
      expect(
        (
          await failure(
            inTenant(B, (trx) =>
              trx
                .insertInto("email_messages")
                .values({
                  tenant_id: A,
                  dedupe_key: "test.message:cross",
                  template: "t",
                  template_version: 1,
                  to_email: "x@example.test",
                  from_name: "X",
                  subject: "S",
                  html_body: "h",
                  text_body: "t",
                })
                .execute(),
            ),
          )
        ).code,
      ).toBe("42501");
      await deliver(A);
    });
  },
);
