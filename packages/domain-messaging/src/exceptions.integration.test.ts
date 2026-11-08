/**
 * The tenant-wide email exceptions read (W1-EMAIL-EXC) against a real
 * database, as tidegrid_app under row-level security:
 *
 * - it lists a tenant's failed messages, newest first, split into failed,
 *   outcome_unknown, and delivery_failed, and leaves out sent and queued ones;
 * - a message about no booking lists with no booking;
 * - pages walk the whole list once, and a cursor that names no failed
 *   message of the tenant is cursor_invalid;
 * - two tenants: under tenant B's transaction, tenant A's id lists nothing
 *   and A's cursor is cursor_invalid, and no answer carries an address.
 * Bookings, the sent-later flag, and the route's roles are in
 * apps/api-worker/test-integration/email-exceptions.integration.test.ts.
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
import {
  deliverTenantMessages,
  type EmailProvider,
  EmailProviderRejectedError,
  EmailProviderUnavailableError,
  enqueueMessage,
  listEmailExceptions,
  type OutgoingEmail,
} from "./index.ts";

type Sql = ReturnType<typeof postgres>;

const env = inject("integrationDb");

/**
 * A provider that does not deduplicate, scripted by the recipient's local
 * part: +reject bounces, +undeliverable is delivery_failed, +unknown never
 * answers (outcome_unknown), and anything else is accepted.
 */
const scripted: EmailProvider = {
  name: "cloudflare",
  deduplicates: false,
  async send(email: OutgoingEmail) {
    const local = email.to.email.split("@")[0] ?? "";
    if (local.endsWith("+reject")) throw new EmailProviderRejectedError("bounced");
    if (local.endsWith("+undeliverable")) throw new EmailProviderRejectedError("delivery_failed");
    if (local.endsWith("+unknown")) throw new EmailProviderUnavailableError("provider_unavailable");
    return { providerMessageId: `test-${email.idempotencyKey}` };
  },
};

describe.skipIf(!env)("the email exceptions read against a real database (W1-EMAIL-EXC)", () => {
  let admin: Sql;
  let runtime: ReturnType<typeof createDb>;
  let A: string;
  let B: string;

  const ctxFor = (tenantId: string): TenantContext => ({
    tenantId,
    actorType: "system",
    actorId: "exceptions-test",
    requestId: `req-${randomUUID()}`,
  });
  const inTenant = <T>(
    tenantId: string,
    fn: (trx: TenantTransaction, ctx: TenantContext) => Promise<T>,
  ) => {
    const ctx = ctxFor(tenantId);
    return inTenantTransaction(runtime.db, ctx, (trx) => fn(trx, ctx));
  };

  async function enqueue(tenantId: string, local: string): Promise<string> {
    const result = await inTenant(tenantId, (trx, ctx) =>
      enqueueMessage(trx, ctx, {
        dedupeKey: `test.exceptions:${randomUUID()}`,
        template: "test_message",
        templateVersion: 1,
        to: { email: `${local}@example.test`, name: "Synthetic Guest" },
        content: {
          subject: "A synthetic message",
          blocks: [{ kind: "paragraph", text: "Nothing real." }],
        },
      }),
    );
    return result.messageId;
  }

  const deliver = (tenantId: string) =>
    deliverTenantMessages(runtime.db, tenantId, {
      provider: scripted,
      fromAddress: "bookings@tidegrid.test",
      runId: `run-${randomUUID()}`,
    });

  /** The tenant's failed messages as the admin reads them, in the list's order. */
  async function failedIds(tenantId: string): Promise<string[]> {
    const rows = await admin<{ id: string }[]>`
      select id from public.email_messages
       where tenant_id = ${tenantId} and state = 'failed'
       order by failed_at desc, id desc`;
    return rows.map((r) => r.id);
  }

  let ids: Record<"bounced" | "undeliverable" | "unknown" | "sent" | "queued", string>;
  let inB: string;

  beforeAll(async () => {
    if (!env) return;
    admin = postgres(env.adminUrl, { max: 2, onnotice: () => {} });
    runtime = createDb(env.runtimeUrl, { max: 4 });
    A = randomUUID();
    B = randomUUID();
    for (const [id, slug] of [
      [A, `exc-a-${A.slice(0, 8)}`],
      [B, `exc-b-${B.slice(0, 8)}`],
    ] as const) {
      await admin`insert into public.tenants (id, slug, display_name) values (${id}, ${slug}, ${`Exceptions ${slug}`})`;
    }
    ids = {
      bounced: await enqueue(A, "first+reject"),
      undeliverable: await enqueue(A, "second+undeliverable"),
      unknown: await enqueue(A, "third+unknown"),
      sent: await enqueue(A, "fourth"),
      queued: "",
    };
    await deliver(A);
    // Queued after the run: still waiting, so not an exception.
    ids.queued = await enqueue(A, "fifth+reject");
    inB = await enqueue(B, "other+reject");
    await deliver(B);
  });

  afterAll(async () => {
    await runtime?.end();
    await admin?.end({ timeout: 5 });
  });

  it("lists the tenant's failed messages newest first, each with how it ended, and nothing else", async () => {
    const page = await inTenant(A, (trx) => listEmailExceptions(trx, A, { limit: 50 }));
    if (page.kind !== "page") throw new Error("expected a page");
    expect(page.nextBefore).toBeNull();
    expect(page.exceptions.map((e) => e.id)).toEqual(await failedIds(A));
    const byId = new Map(page.exceptions.map((e) => [e.id, e]));
    expect(byId.get(ids.bounced)).toMatchObject({
      template: "test_message",
      kind: "booking",
      state: "failed",
      failureCode: "bounced",
      attempts: 1,
      staffResend: false,
      laterSent: false,
      booking: null,
    });
    expect(byId.get(ids.undeliverable)).toMatchObject({
      state: "delivery_failed",
      failureCode: "delivery_failed",
    });
    expect(byId.get(ids.unknown)).toMatchObject({
      state: "outcome_unknown",
      failureCode: "outcome_unknown",
    });
    expect(byId.has(ids.sent)).toBe(false);
    expect(byId.has(ids.queued)).toBe(false);
    expect(byId.has(inB)).toBe(false);
    for (const e of page.exceptions) expect(Date.parse(e.failedAt)).not.toBeNaN();
    // No recipient, name, subject, or body.
    const text = JSON.stringify(page);
    for (const secret of ["@", "Synthetic Guest", "synthetic message", "Nothing real"]) {
      expect(text).not.toContain(secret);
    }
  });

  it("walks the list a page at a time, once, and refuses a cursor that names no failed message of the tenant", async () => {
    const seen: string[] = [];
    let before: string | undefined;
    for (let i = 0; i < 10; i++) {
      const page = await inTenant(A, (trx) =>
        listEmailExceptions(trx, A, { limit: 1, ...(before ? { before } : {}) }),
      );
      if (page.kind !== "page") throw new Error("expected a page");
      seen.push(...page.exceptions.map((e) => e.id));
      if (page.nextBefore === null) break;
      expect(page.nextBefore).toBe(page.exceptions.at(-1)?.id);
      before = page.nextBefore;
    }
    expect(seen).toEqual(await failedIds(A));

    for (const cursor of [randomUUID(), ids.sent, ids.queued, inB]) {
      const page = await inTenant(A, (trx) =>
        listEmailExceptions(trx, A, { limit: 10, before: cursor }),
      );
      expect(page, cursor).toEqual({ kind: "cursor_invalid" });
    }
  });

  it("finds nothing of tenant A from tenant B's transaction, by id or by cursor", async () => {
    // Row-level security holds even when the query names A's tenant id.
    const named = await inTenant(B, (trx) => listEmailExceptions(trx, A, { limit: 50 }));
    expect(named).toEqual({ kind: "page", exceptions: [], nextBefore: null });
    const cursor = await inTenant(B, (trx) =>
      listEmailExceptions(trx, A, { limit: 50, before: ids.bounced }),
    );
    expect(cursor).toEqual({ kind: "cursor_invalid" });
    const ownCursor = await inTenant(B, (trx) =>
      listEmailExceptions(trx, B, { limit: 50, before: ids.bounced }),
    );
    expect(ownCursor).toEqual({ kind: "cursor_invalid" });

    const own = await inTenant(B, (trx) => listEmailExceptions(trx, B, { limit: 50 }));
    if (own.kind !== "page") throw new Error("expected a page");
    expect(own.exceptions.map((e) => e.id)).toEqual([inB]);
  });
});
