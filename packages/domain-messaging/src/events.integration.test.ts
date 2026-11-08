/**
 * Email bounce and complaint events (W1-EMAIL-EVENTS, migrations 0020 and
 * 0021), against a throwaway PostgreSQL 17 as tidegrid_app. Two tenants
 * throughout. Messages are sent through the Cloudflare adapter over its
 * recorded fixture, so each carries a provider id the way a real send would;
 * events follow the documented shapes (cloudflare-events-fixture.ts).
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
  cloudflareEmailEvent,
  FIXTURE_ACCOUNT_ID,
  FIXTURE_OTHER_ACCOUNT_ID,
  FIXTURE_SENDING_DOMAIN,
} from "./cloudflare-events-fixture.ts";
import { createCloudflareEmailFixture } from "./cloudflare-fixture.ts";
import {
  createCloudflareEmailProvider,
  deliverTenantMessages,
  type EmailEventsConfig,
  enqueueMessage,
  getMessageStatus,
  ingestEmailEvent,
  normalizeCloudflareMessageId,
} from "./index.ts";

type Sql = ReturnType<typeof postgres>;

const env = inject("integrationDb");
const FROM = `bookings@${FIXTURE_SENDING_DOMAIN}`;
const config: EmailEventsConfig = {
  accountId: FIXTURE_ACCOUNT_ID,
  sendingDomain: FIXTURE_SENDING_DOMAIN,
};

describe.skipIf(!env)("email bounce and complaint events (W1-EMAIL-EVENTS)", () => {
  let admin: Sql;
  let runtime: ReturnType<typeof createDb>;
  let A: string;
  let B: string;
  const run = randomUUID().slice(0, 8);
  const addr = (label: string) => `ev.${run}.${label}@example.test`;

  const ctxFor = (tenantId: string): TenantContext => ({
    tenantId,
    actorType: "system",
    actorId: "email-events-test",
    requestId: `req-${randomUUID()}`,
  });
  const inTenant = <T>(tenantId: string, fn: (trx: TenantTransaction) => Promise<T>) =>
    inTenantTransaction(runtime.db, ctxFor(tenantId), fn);

  async function newTenant(label: string): Promise<string> {
    const id = randomUUID();
    const slug = `ev-${label}-${id.slice(0, 8)}`;
    await admin`insert into public.tenants (id, slug, display_name)
      values (${id}, ${slug}, ${`Events ${slug}`})`;
    return id;
  }

  /** One message, sent through the adapter; answers its id and the provider's id. */
  async function sent(
    tenantId: string,
    label: string,
    answerId?: string,
  ): Promise<{ id: string; providerId: string }> {
    const fixture = createCloudflareEmailFixture({ allowedSenderAddresses: [FROM] });
    if (answerId) fixture.answerId(answerId);
    const provider = createCloudflareEmailProvider({
      binding: fixture.binding,
      recipients: { kind: "only", addresses: new Set([addr(label)]) },
      environment: "local",
      timeoutMs: 500,
    });
    const { messageId } = await inTenant(tenantId, (trx) =>
      enqueueMessage(trx, ctxFor(tenantId), {
        dedupeKey: `ev.message:${run}-${label}`,
        template: "ev_message",
        templateVersion: 1,
        to: { email: addr(label), name: "Synthetic Guest" },
        content: { subject: `Synthetic ${label}`, blocks: [{ kind: "paragraph", text: "x" }] },
      }),
    );
    await deliverTenantMessages(runtime.db, tenantId, {
      provider,
      fromAddress: FROM,
      runId: `run-${randomUUID()}`,
    });
    const [r] = await admin<{ state: string; provider_message_id: string | null }[]>`
      select state, provider_message_id from public.email_messages where id = ${messageId}`;
    if (r?.state !== "sent" || !r.provider_message_id) throw new Error(`not sent: ${label}`);
    return { id: messageId, providerId: r.provider_message_id };
  }

  const ingest = (body: unknown) => ingestEmailEvent(runtime.db, config, body);
  const eventRows = (messageId: string) => admin<
    { event_id: string; event_type: string; applied: boolean; tenant_id: string }[]
  >`select event_id, event_type, applied, tenant_id from public.email_events
     where message_id = ${messageId} order by received_at`;
  const unmatchedCount = async (eventId: string) =>
    (
      await admin<{ n: number }[]>`select count(*)::int as n from public.email_events_unmatched
        where event_id = ${eventId}`
    )[0]?.n ?? 0;
  const counts = async () =>
    (
      await admin<{ events: number; unmatched: number }[]>`
        select (select count(*)::int from public.email_events) as events,
               (select count(*)::int from public.email_events_unmatched) as unmatched`
    )[0];
  /** A direct writer with tidegrid_app's credentials, in one tenant's transaction. */
  const asWriter = (tenantId: string, fn: (trx: TenantTransaction) => Promise<unknown>) =>
    inTenant(tenantId, fn).then(
      () => null,
      (e: { code?: string; constraint_name?: string }) => ({
        code: e.code,
        constraint: e.constraint_name,
      }),
    );

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

  it("E1 applies a verified bounce to its message once, and staff read it", async () => {
    const m = await sent(A, "e1");
    const result = await ingest(
      cloudflareEmailEvent("bounced", { messageId: m.providerId, eventId: `e1-${run}-0001` }),
    );
    expect(result).toEqual({
      outcome: "applied",
      eventType: "bounced",
      tenantId: A,
      messageId: m.id,
    });
    const status = await inTenant(A, (trx) => getMessageStatus(trx, A, m.id));
    expect(status).toMatchObject({
      state: "sent",
      deliveryReport: {
        kind: "bounced",
        bounceType: "hard",
        detailCode: "5.1.1",
        reportedAt: "2026-11-08T12:00:00.000Z",
      },
    });
    expect(await eventRows(m.id)).toEqual([
      { event_id: `e1-${run}-0001`, event_type: "bounced", applied: true, tenant_id: A },
    ]);
  });

  it("E2 makes duplicates and replays no-ops, and keeps the first outcome", async () => {
    const m = await sent(A, "e2");
    const bounce = cloudflareEmailEvent("bounced", {
      messageId: m.providerId,
      eventId: `e2-${run}-bounce`,
      bounceType: "soft",
    });
    const complaint = cloudflareEmailEvent("complained", {
      messageId: m.providerId,
      eventId: `e2-${run}-complaint`,
      timestamp: "2026-11-08T13:00:00.000Z",
    });
    expect((await ingest(bounce)).outcome).toBe("applied");
    expect((await ingest(bounce)).outcome).toBe("duplicate");
    expect((await ingest(complaint)).outcome).toBe("recorded");
    expect((await ingest(complaint)).outcome).toBe("duplicate");
    // A queue redelivers the same body.
    expect((await ingest(structuredClone(bounce))).outcome).toBe("duplicate");
    const status = await inTenant(A, (trx) => getMessageStatus(trx, A, m.id));
    expect(status?.deliveryReport).toMatchObject({ kind: "bounced", bounceType: "soft" });
    expect((await eventRows(m.id)).map((r) => [r.event_type, r.applied])).toEqual([
      ["bounced", true],
      ["complained", false],
    ]);
  });

  it("E3 refuses another account's or another sending domain's event, recording nothing", async () => {
    const m = await sent(A, "e3");
    const before = await counts();
    const foreignAccount = await ingest(
      cloudflareEmailEvent("bounced", {
        messageId: m.providerId,
        accountId: FIXTURE_OTHER_ACCOUNT_ID,
      }),
    );
    const foreignDomain = await ingest(
      cloudflareEmailEvent("bounced", { messageId: m.providerId, domain: "other.example.test" }),
    );
    const parentDomain = await ingest(
      cloudflareEmailEvent("complained", { messageId: m.providerId, domain: "tidegrid.test" }),
    );
    expect(foreignAccount.outcome).toBe("refused_account");
    expect(foreignDomain.outcome).toBe("refused_domain");
    expect(parentDomain.outcome).toBe("refused_domain");
    expect(await counts()).toEqual(before);
    const status = await inTenant(A, (trx) => getMessageStatus(trx, A, m.id));
    expect(status?.deliveryReport).toBeNull();
  });

  it("E4 records an unknown message id once, joined to nothing", async () => {
    const eventId = `e4-${run}-unknown`;
    const body = cloudflareEmailEvent("bounced", {
      messageId: `${run}aaaaaaaa-msg-0000000000000000`,
      eventId,
    });
    const before = await counts();
    expect(await ingest(body)).toEqual({ outcome: "unmatched", eventType: "bounced" });
    expect(await ingest(body)).toEqual({ outcome: "duplicate", eventType: "bounced" });
    expect(await unmatchedCount(eventId)).toBe(1);
    const after = await counts();
    expect(after?.events).toBe(before?.events);
  });

  it("E5 drops delivered, deferred, failed, and rejected events", async () => {
    const m = await sent(A, "e5");
    const before = await counts();
    for (const type of ["delivered", "deferred", "failed", "rejected"] as const) {
      expect((await ingest(cloudflareEmailEvent(type, { messageId: m.providerId }))).outcome).toBe(
        "ignored",
      );
    }
    expect(await counts()).toEqual(before);
  });

  it("E5b drops a bounce that is not final, so a later delivery is not mislabeled", async () => {
    const m = await sent(A, "e5b");
    const body = cloudflareEmailEvent("bounced", { messageId: m.providerId, bounceType: "soft" });
    (body.payload as { terminal: boolean }).terminal = false;
    expect((await ingest(body)).outcome).toBe("ignored");
    expect(await eventRows(m.id)).toEqual([]);
  });

  it("E6 joins only the tenant whose message it is, and another tenant reads nothing", async () => {
    const a = await sent(A, "e6a");
    const b = await sent(B, "e6b");
    const result = await ingest(
      cloudflareEmailEvent("complained", { messageId: b.providerId, eventId: `e6-${run}-b` }),
    );
    expect(result).toMatchObject({ outcome: "applied", tenantId: B, messageId: b.id });
    expect(await inTenant(A, (trx) => getMessageStatus(trx, A, b.id))).toBeNull();
    expect((await inTenant(A, (trx) => getMessageStatus(trx, A, a.id)))?.deliveryReport).toBeNull();
    expect(
      (await inTenant(B, (trx) => getMessageStatus(trx, B, b.id)))?.deliveryReport,
    ).toMatchObject({ kind: "complained", detailCode: "abuse" });
    // Tenant A's runtime sees none of B's events.
    const seen = await inTenant(A, (trx) =>
      trx.selectFrom("email_events").select("id").where("message_id", "=", b.id).execute(),
    );
    expect(seen).toEqual([]);
  });

  it("E7 joins an id the adapter normalized at send, by the same rule", async () => {
    const raw = `<${run}.${"z".repeat(40)}@cloudflare-email.example.test>!`;
    const { id: normalized, normalized: changed } = await normalizeCloudflareMessageId(raw);
    expect(changed).toBe(true);
    const m = await sent(A, "e7", raw);
    expect(m.providerId).toBe(normalized);
    const result = await ingest(cloudflareEmailEvent("bounced", { messageId: raw }));
    expect(result).toMatchObject({ outcome: "applied", messageId: m.id });
  });

  it("E8 applies exactly one of two events that race for one message", async () => {
    const m = await sent(A, "e8");
    const results = await Promise.all([
      ingest(cloudflareEmailEvent("bounced", { messageId: m.providerId, eventId: `e8-${run}-1` })),
      ingest(
        cloudflareEmailEvent("complained", { messageId: m.providerId, eventId: `e8-${run}-2` }),
      ),
    ]);
    expect(results.map((r) => r.outcome).sort()).toEqual(["applied", "recorded"]);
    expect((await eventRows(m.id)).filter((r) => r.applied)).toHaveLength(1);
  });

  it("E9 refuses a direct writer that attaches an event to a message it does not fit", async () => {
    const a = await sent(A, "e9a");
    const b = await sent(B, "e9b");
    const row = (over: Record<string, unknown>) => ({
      provider: "cloudflare" as const,
      event_id: `e9-${randomUUID()}`,
      event_type: "bounced" as const,
      provider_message_id: a.providerId,
      message_id: a.id,
      occurred_at: new Date(),
      applied: false,
      ...over,
    });
    const insert = (tenantId: string, over: Record<string, unknown>) =>
      asWriter(tenantId, (trx) =>
        trx
          .insertInto("email_events")
          .values({ tenant_id: tenantId, ...row(over) } as never)
          .execute(),
      );
    // Another tenant's message, from A's transaction: no such message here.
    expect(await insert(A, { message_id: b.id, provider_message_id: b.providerId })).toMatchObject({
      code: "23514",
      constraint: "email_events_message",
    });
    // A row claiming B's tenant, from A's transaction: the check trigger
    // cannot see B's message, and row-level security would refuse the row.
    const claimed = await asWriter(A, (trx) =>
      trx
        .insertInto("email_events")
        .values({
          tenant_id: B,
          ...row({ message_id: b.id, provider_message_id: b.providerId }),
        } as never)
        .execute(),
    );
    expect(["23514", "42501"]).toContain(claimed?.code);
    // The id the event names must be the message's own.
    expect(await insert(A, { provider_message_id: b.providerId })).toMatchObject({
      constraint: "email_events_message",
    });
    // A message that was never sent.
    const { messageId: queued } = await inTenant(A, (trx) =>
      enqueueMessage(trx, ctxFor(A), {
        dedupeKey: `ev.message:${run}-e9-queued`,
        template: "ev_message",
        templateVersion: 1,
        to: { email: addr("e9q"), name: null },
        content: { subject: "Queued", blocks: [{ kind: "paragraph", text: "x" }] },
      }),
    );
    expect(await insert(A, { message_id: queued })).toMatchObject({
      constraint: "email_events_message",
    });
    // Append-only: no update or delete, for the runtime or the owner.
    expect(
      await asWriter(A, (trx) =>
        trx
          .updateTable("email_events")
          .set({ applied: true } as never)
          .where("message_id", "=", a.id)
          .execute(),
      ),
    ).toMatchObject({ code: "42501" });
    const fault = await admin`delete from public.email_events where true`.then(
      () => null,
      (e: { code?: string }) => e.code,
    );
    expect(fault).toBe("55000");
    // The unmatched table and the trigger function are out of the runtime's reach.
    expect(
      await asWriter(A, (trx) =>
        trx
          .selectFrom("email_events_unmatched" as never)
          .selectAll()
          .execute(),
      ),
    ).toMatchObject({ code: "42501" });
  });

  it("E10 holds the catalog: forced RLS, no DELETE, pinned definer functions, a valid unique index", async () => {
    const tables = await admin<
      { relname: string; forced: boolean; enabled: boolean; policies: string[] }[]
    >`select c.relname, c.relforcerowsecurity as forced, c.relrowsecurity as enabled,
             array(select p.polname::text from pg_policy p where p.polrelid = c.oid order by 1) as policies
        from pg_class c join pg_namespace n on n.oid = c.relnamespace
       where n.nspname = 'public' and c.relname in ('email_events', 'email_events_unmatched')
       order by c.relname`;
    expect(tables).toEqual([
      { relname: "email_events", forced: true, enabled: true, policies: ["tenant_isolation"] },
      { relname: "email_events_unmatched", forced: true, enabled: true, policies: [] },
    ]);
    const privileges = await admin<{ t: string; p: string[] }[]>`
      select t, array(select p from unnest(array['SELECT','INSERT','UPDATE','DELETE','TRUNCATE']) p
                       where has_table_privilege('tidegrid_app', ('public.' || t)::regclass, p) order by p) as p
        from unnest(array['email_events', 'email_events_unmatched']) t order by t`;
    expect(privileges).toEqual([
      { t: "email_events", p: ["INSERT", "SELECT"] },
      { t: "email_events_unmatched", p: [] },
    ]);
    const fns = await admin<
      { proname: string; definer: boolean; config: string[] | null; pub: boolean; app: boolean }[]
    >`select p.proname, p.prosecdef as definer, p.proconfig as config,
             has_function_privilege('public', p.oid, 'EXECUTE') as pub,
             has_function_privilege('tidegrid_app', p.oid, 'EXECUTE') as app
        from pg_proc p join pg_namespace n on n.oid = p.pronamespace
       where n.nspname = 'app'
         and p.proname in ('resolve_email_message', 'record_unmatched_email_event', 'check_email_event')
       order by p.proname`;
    expect(fns).toEqual([
      {
        proname: "check_email_event",
        definer: false,
        config: ["search_path=pg_catalog, pg_temp"],
        pub: false,
        app: false,
      },
      {
        proname: "record_unmatched_email_event",
        definer: true,
        config: ["search_path=pg_catalog, pg_temp"],
        pub: false,
        app: true,
      },
      {
        proname: "resolve_email_message",
        definer: true,
        config: ["search_path=pg_catalog, pg_temp"],
        pub: false,
        app: true,
      },
    ]);
    // The unmatched table's sequence is out of reach too, and the owner can prune the table.
    const [seq] = await admin<{ usage: boolean; select: boolean }[]>`
      select has_sequence_privilege('tidegrid_app', 'public.email_events_unmatched_id_seq', 'USAGE') as usage,
             has_sequence_privilege('tidegrid_app', 'public.email_events_unmatched_id_seq', 'SELECT') as select`;
    expect(seq).toEqual({ usage: false, select: false });
    await admin`delete from public.email_events_unmatched where event_id = ${`e4-${run}-unknown`}`;
    const [index] = await admin<{ valid: boolean; unique: boolean; def: string }[]>`
      select i.indisvalid as valid, i.indisunique as unique, pg_get_indexdef(i.indexrelid) as def
        from pg_index i join pg_class c on c.oid = i.indexrelid
       where c.relname = 'email_messages_provider_message_once'`;
    expect(index).toMatchObject({ valid: true, unique: true });
    expect(index?.def).toMatch(
      /\(provider, provider_message_id\) WHERE \(provider_message_id IS NOT NULL\)/,
    );
  });
});
