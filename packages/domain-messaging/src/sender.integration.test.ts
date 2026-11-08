/**
 * Per-operator sender domains and suppression (W3-G2.16-rest, migration 0026),
 * against a throwaway PostgreSQL 17 as tidegrid_app, with the admin
 * connection only where the admin acts (adding, verifying, and retiring a
 * domain, lifting a suppression). Two tenants throughout. Messages go through
 * the Cloudflare adapter over its recorded fixture; events follow the
 * documented shapes.
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
  cloudflareEmailEvent,
  FIXTURE_ACCOUNT_ID,
  FIXTURE_SENDING_DOMAIN,
} from "./cloudflare-events-fixture.ts";
import { type CloudflareEmailFixture, createCloudflareEmailFixture } from "./cloudflare-fixture.ts";
import {
  ADDRESS_SUPPRESSED,
  createCloudflareEmailProvider,
  type DeliveryOptions,
  deliverTenantMessages,
  type EmailEventsConfig,
  enqueueMessage,
  ingestEmailEvent,
  type SenderPolicy,
  sweepEmail,
} from "./index.ts";

type Sql = ReturnType<typeof postgres>;

const env = inject("integrationDb");
const SHARED = `bookings@${FIXTURE_SENDING_DOMAIN}`;
const config: EmailEventsConfig = {
  accountId: FIXTURE_ACCOUNT_ID,
  sendingDomain: FIXTURE_SENDING_DOMAIN,
};

describe.skipIf(!env)("per-operator sender domains and suppression (W3-G2.16-rest)", () => {
  let admin: Sql;
  let runtime: ReturnType<typeof createDb>;
  const run = randomUUID().slice(0, 8);
  const addr = (label: string) => `sd.${run}.${label}@example.test`;
  const domainOf = (label: string) => `${label}-${run}.harbor.example`;

  const ctxFor = (tenantId: string): TenantContext => ({
    tenantId,
    actorType: "system",
    actorId: "sender-test",
    requestId: `req-${randomUUID()}`,
  });
  const inTenant = <T>(tenantId: string, fn: (trx: TenantTransaction) => Promise<T>) =>
    inTenantTransaction(runtime.db, ctxFor(tenantId), fn);
  /** A direct writer with tidegrid_app's credentials, in one tenant's transaction. */
  const asWriter = (tenantId: string, fn: (trx: TenantTransaction) => Promise<unknown>) =>
    inTenant(tenantId, fn).then(
      () => null,
      (e: { code?: string; constraint_name?: string }) => ({
        code: e.code,
        constraint: e.constraint_name,
      }),
    );

  async function newTenant(label: string): Promise<string> {
    const id = randomUUID();
    await admin`insert into public.tenants (id, slug, display_name)
      values (${id}, ${`sd-${label}-${id.slice(0, 8)}`}, ${`Sender ${label}`})`;
    return id;
  }

  /** The admin's own functions, on the admin connection, as the CLI calls them. */
  const adminAdd = (tenantId: string, domain: string, mailbox = "bookings") =>
    admin`select app.sender_domain_add(${tenantId}::uuid, ${domain}, ${mailbox}) as id`;
  const adminVerify = (tenantId: string, domain: string) =>
    admin`select app.sender_domain_verify(${tenantId}::uuid, ${domain}, 'SPF, DKIM, DMARC pass in the fixture') as changed`;
  const adminRetire = (tenantId: string, domain: string) =>
    admin`select app.sender_domain_retire(${tenantId}::uuid, ${domain}, 'test retire') as changed`;

  function provider(fixture: CloudflareEmailFixture, labels: string[]) {
    return createCloudflareEmailProvider({
      binding: fixture.binding,
      recipients: { kind: "only", addresses: new Set(labels.map(addr)) },
      environment: "local",
      timeoutMs: 500,
    });
  }

  async function enqueue(tenantId: string, label: string, key = label): Promise<string> {
    const { messageId } = await inTenant(tenantId, (trx) =>
      enqueueMessage(trx, ctxFor(tenantId), {
        dedupeKey: `sd.message:${run}-${key}`,
        template: "sd_message",
        templateVersion: 1,
        to: { email: addr(label), name: "Synthetic Guest" },
        content: { subject: `Synthetic ${label}`, blocks: [{ kind: "paragraph", text: "x" }] },
      }),
    );
    return messageId;
  }

  function deliver(
    tenantId: string,
    fixture: CloudflareEmailFixture,
    labels: string[],
    senderPolicy?: SenderPolicy,
  ) {
    const options: DeliveryOptions = {
      provider: provider(fixture, labels),
      fromAddress: SHARED,
      runId: `run-${randomUUID()}`,
      ...(senderPolicy ? { senderPolicy } : {}),
    };
    return deliverTenantMessages(runtime.db, tenantId, options);
  }

  const message = async (id: string) =>
    (
      await admin<
        {
          state: string;
          last_error_code: string | null;
          provider_message_id: string | null;
          attempts: number;
        }[]
      >`
        select state, last_error_code, provider_message_id, attempts
          from public.email_messages where id = ${id}`
    )[0];

  beforeAll(async () => {
    if (!env) return;
    admin = postgres(env.adminUrl, { max: 2, onnotice: () => {} });
    runtime = createDb(env.runtimeUrl, { max: 4 });
  });

  afterAll(async () => {
    await runtime?.end();
    await admin?.end({ timeout: 5 });
  });

  it("S1 sends from the shared address until a domain is verified, then from the operator's own", async () => {
    const T = await newTenant("s1");
    const domain = domainOf("s1");
    const fixture = createCloudflareEmailFixture();
    await enqueue(T, "s1a");
    await deliver(T, fixture, ["s1a", "s1b", "s1c"]);
    expect(fixture.sends.at(-1)?.builder.from.email).toBe(SHARED);

    // Pending sends nothing from the domain.
    await adminAdd(T, domain, "trips");
    await enqueue(T, "s1b");
    await deliver(T, fixture, ["s1a", "s1b", "s1c"]);
    expect(fixture.sends.at(-1)?.builder.from.email).toBe(SHARED);

    expect((await adminVerify(T, domain))[0]?.changed).toBe(true);
    expect((await adminVerify(T, domain))[0]?.changed).toBe(false);
    await enqueue(T, "s1c");
    await deliver(T, fixture, ["s1a", "s1b", "s1c"]);
    expect(fixture.sends.at(-1)?.builder.from.email).toBe(`trips@${domain}`);
    // The display name is still the operator's, with the relay suffix.
    expect(fixture.sends.at(-1)?.builder.from.name).toMatch(/ via TideGrid$/);

    // Retired, mail goes back to the shared sender.
    expect((await adminRetire(T, domain))[0]?.changed).toBe(true);
    await enqueue(T, "s1a", "s1a-again");
    await deliver(T, fixture, ["s1a", "s1b", "s1c"]);
    expect(fixture.sends.at(-1)?.builder.from.email).toBe(SHARED);

    // Every step left an audit row naming the domain, by the admin.
    const audit = await admin<{ action: string }[]>`
      select action from public.audit_events
       where tenant_id = ${T} and subject_type = 'tenant_sender_domain' order by id`;
    expect(audit.map((a) => a.action)).toEqual([
      "email.sender_domain_added",
      "email.sender_domain_verified",
      "email.sender_domain_retired",
    ]);
  });

  it("S2 under operator_only, holds an operator with no verified domain and sends nothing", async () => {
    const T = await newTenant("s2");
    const fixture = createCloudflareEmailFixture();
    const id = await enqueue(T, "s2");
    const report = await deliver(T, fixture, ["s2"], "operator_only");
    expect(report).toMatchObject({ claimed: 0, held: "sender_unverified", stopped: null });
    expect(fixture.sends).toHaveLength(0);
    expect(await message(id)).toMatchObject({ state: "queued", attempts: 0 });

    await adminAdd(T, domainOf("s2"));
    expect(await deliver(T, fixture, ["s2"], "operator_only")).toMatchObject({
      held: "sender_unverified",
    });
    await adminVerify(T, domainOf("s2"));
    expect(await deliver(T, fixture, ["s2"], "operator_only")).toMatchObject({
      sent: 1,
      held: null,
    });
    expect(fixture.sends[0]?.builder.from.email).toBe(`bookings@${domainOf("s2")}`);
  });

  it("S2b a held operator's lapsed attempt still ends, as outcome_unknown", async () => {
    const T = await newTenant("s2b");
    const id = await enqueue(T, "s2b");
    await admin`update public.email_messages
                   set state = 'sending', attempts = 1, provider = 'cloudflare',
                       lease_expires_at = now() + interval '1 second'
                 where id = ${id}`;
    await new Promise((resolve) => setTimeout(resolve, 1_200));
    const fixture = createCloudflareEmailFixture();
    const report = await deliver(T, fixture, ["s2b"], "operator_only");
    expect(report).toMatchObject({ failed: 1, held: "sender_unverified" });
    expect(fixture.sends).toHaveLength(0);
    expect(await message(id)).toMatchObject({
      state: "failed",
      last_error_code: "outcome_unknown",
    });
  });

  it("S3 the sweep holds one operator and still serves another", async () => {
    const held = await newTenant("s3-held");
    const ready = await newTenant("s3-ready");
    await adminAdd(ready, domainOf("s3"));
    await adminVerify(ready, domainOf("s3"));
    const heldId = await enqueue(held, "s3-held");
    const readyId = await enqueue(ready, "s3-ready");
    const fixture = createCloudflareEmailFixture();
    const turns: string[] = [];
    const report = await sweepEmail(runtime.db, {
      provider: provider(fixture, ["s3-held", "s3-ready"]),
      fromAddress: SHARED,
      runId: `run-${randomUUID()}`,
      senderPolicy: "operator_only",
      tenantLimit: 500,
      onTurnStart: (tenantId) => turns.push(tenantId),
    });
    // The held operator had its one turn, and no second one.
    expect(turns.filter((t) => t === held)).toHaveLength(1);
    expect(turns).toContain(ready);
    expect(report.heldTenants).toBeGreaterThanOrEqual(1);
    expect(report.accountFault).toBe(false);
    expect(await message(heldId)).toMatchObject({ state: "queued" });
    expect(await message(readyId)).toMatchObject({ state: "sent" });
  });

  it("S4 a provider that refuses the operator's own sender holds that operator's run", async () => {
    const T = await newTenant("s4");
    await adminAdd(T, domainOf("s4"));
    await adminVerify(T, domainOf("s4"));
    // The binding allows only the shared sender, as the repository's does.
    const fixture = createCloudflareEmailFixture({ allowedSenderAddresses: [SHARED] });
    const id = await enqueue(T, "s4");
    const second = await enqueue(T, "s4", "s4-second");
    const report = await deliver(T, fixture, ["s4"]);
    // The run stopped at the first refusal: the second was never claimed.
    expect(await message(second)).toMatchObject({ state: "queued", attempts: 0 });
    expect(report).toMatchObject({ claimed: 1, held: "sender_unverified", stopped: null });
    // The attempt is given back and waits, as an account-level fault's is.
    expect(await message(id)).toMatchObject({
      state: "queued",
      attempts: 0,
      last_error_code: "sender_not_verified",
    });
  });

  it("S4b any other account-level fault on an operator's own sender holds that operator, except a suspended account", async () => {
    const T = await newTenant("s4b");
    await adminAdd(T, domainOf("s4b"));
    await adminVerify(T, domainOf("s4b"));
    const fixture = createCloudflareEmailFixture();
    await enqueue(T, "s4b");
    fixture.failNext("E_DAILY_LIMIT_EXCEEDED");
    expect(await deliver(T, fixture, ["s4b"])).toMatchObject({
      held: "sender_fault",
      stopped: null,
    });
    await admin`update public.email_messages set next_attempt_at = now()
                 where tenant_id = ${T} and state = 'queued'`;
    fixture.failNext("E_ACCOUNT_SUSPENDED");
    expect(await deliver(T, fixture, ["s4b"])).toMatchObject({
      held: null,
      stopped: "account_fault",
    });
  });

  it("S5 the runtime cannot add, verify, or retire a domain", async () => {
    const T = await newTenant("s5");
    expect(
      await asWriter(T, (trx) =>
        sql`insert into tenant_sender_domains (tenant_id, domain) values (${T}, ${domainOf("s5")})`.execute(
          trx,
        ),
      ),
    ).toMatchObject({ code: "42501" });
    await adminAdd(T, domainOf("s5"));
    expect(
      await asWriter(T, (trx) =>
        sql`update tenant_sender_domains set status = 'verified' where tenant_id = ${T}`.execute(
          trx,
        ),
      ),
    ).toMatchObject({ code: "42501" });
    for (const fn of [
      sql`select app.sender_domain_add(${T}::uuid, ${domainOf("s5b")}, 'bookings')`,
      sql`select app.sender_domain_verify(${T}::uuid, ${domainOf("s5")}, 'x')`,
      sql`select app.sender_domain_retire(${T}::uuid, ${domainOf("s5")}, 'x')`,
      sql`select app.email_suppression_lift(${T}::uuid, 'a@example.test', 'x')`,
    ]) {
      expect(await asWriter(T, (trx) => fn.execute(trx))).toMatchObject({ code: "42501" });
    }
    // It can read its own row, and never another tenant's.
    const other = await newTenant("s5-other");
    const mine = await inTenant(T, (trx) =>
      sql<{ domain: string }>`select domain from tenant_sender_domains`.execute(trx),
    );
    expect(mine.rows.map((r) => r.domain)).toEqual([domainOf("s5")]);
    const theirs = await inTenant(other, (trx) =>
      sql<{ domain: string }>`select domain from tenant_sender_domains`.execute(trx),
    );
    expect(theirs.rows).toEqual([]);
  });

  it("S6 the database refuses a second live domain, one operator's domain for another, overlaps, TideGrid names, and backward moves", async () => {
    const A = await newTenant("s6a");
    const B = await newTenant("s6b");
    await adminAdd(A, domainOf("s6"));
    const refused = (p: Promise<unknown>) =>
      p.then(
        () => null,
        (e: { code?: string; constraint_name?: string }) => e.constraint_name ?? e.code,
      );
    expect(await refused(adminAdd(A, domainOf("s6-second")))).toBe(
      "tenant_sender_domains_one_live",
    );
    expect(await refused(adminAdd(B, domainOf("s6")))).toBe("tenant_sender_domains_domain_live");
    expect(await refused(adminAdd(B, "mail.tidegrid.us"))).toBe(
      "tenant_sender_domains_domain_check",
    );
    expect(await refused(adminAdd(B, "xn--tdegrd-pvfe.example"))).toBe(
      "tenant_sender_domains_domain_check",
    );
    // Nor a parent or subdomain of another operator's live domain.
    expect(await refused(adminAdd(B, `sub.${domainOf("s6")}`))).toBe(
      "tenant_sender_domains_overlap",
    );
    expect(await refused(adminAdd(B, "harbor.example"))).toBe("tenant_sender_domains_overlap");
    await adminVerify(A, domainOf("s6"));
    expect(
      await refused(
        admin`update public.tenant_sender_domains set status = 'pending' where tenant_id = ${A}`,
      ),
    ).toBe("tenant_sender_domains_transition");
    expect(
      await refused(
        admin`update public.tenant_sender_domains set domain = 'other.example' where tenant_id = ${A}`,
      ),
    ).toBe("tenant_sender_domains_immutable");
    expect(
      await refused(admin`delete from public.tenant_sender_domains where tenant_id = ${A}`),
    ).toBe("tenant_sender_domains_transition");
    // Once retired, another operator may take the name.
    await adminRetire(A, domainOf("s6"));
    expect(await refused(adminAdd(B, domainOf("s6")))).toBeNull();
  });

  /** Sends one message from a tenant and answers its provider id. */
  async function sentMessage(T: string, label: string) {
    const fixture = createCloudflareEmailFixture();
    const id = await enqueue(T, label);
    await deliver(T, fixture, [label]);
    const m = await message(id);
    if (m?.state !== "sent" || !m.provider_message_id) throw new Error(`not sent: ${label}`);
    return { id, providerId: m.provider_message_id };
  }

  const suppressions = (T: string) =>
    admin<{ address: string; reason: string; lifted_at: Date | null }[]>`
      select address, reason, lifted_at from public.email_suppressions
       where tenant_id = ${T} order by created_at`;

  it("S7 a hard bounce or a complaint suppresses the address for that operator only", async () => {
    const A = await newTenant("s7a");
    const B = await newTenant("s7b");
    const first = await sentMessage(A, "s7");
    const hard = await ingestEmailEvent(
      runtime.db,
      config,
      cloudflareEmailEvent("bounced", { messageId: first.providerId, eventId: `s7-hard-${run}` }),
    );
    expect(hard).toMatchObject({ outcome: "applied", suppressed: true });
    expect(await suppressions(A)).toMatchObject([{ address: addr("s7"), reason: "hard_bounce" }]);
    // Operator A's next mail to the address fails with no provider call.
    const fixture = createCloudflareEmailFixture();
    const next = await enqueue(A, "s7", "s7-next");
    const report = await deliver(A, fixture, ["s7"]);
    expect(report.items).toEqual([
      expect.objectContaining({ messageId: next, outcome: "failed", code: ADDRESS_SUPPRESSED }),
    ]);
    expect(fixture.sends).toHaveLength(0);
    // Operator B still sends to it.
    const theirs = await enqueue(B, "s7", "s7-b");
    await deliver(B, fixture, ["s7"]);
    expect(await message(theirs)).toMatchObject({ state: "sent" });
    expect(await suppressions(B)).toEqual([]);
  });

  it("S8 a soft bounce suppresses nothing; a later complaint does; a duplicate adds nothing", async () => {
    const T = await newTenant("s8");
    const m = await sentMessage(T, "s8");
    const soft = await ingestEmailEvent(
      runtime.db,
      config,
      cloudflareEmailEvent("bounced", {
        messageId: m.providerId,
        eventId: `s8-soft-${run}`,
        bounceType: "soft",
      }),
    );
    expect(soft).toMatchObject({ outcome: "applied" });
    expect(soft.suppressed).toBeUndefined();
    expect(await suppressions(T)).toEqual([]);
    const complaint = cloudflareEmailEvent("complained", {
      messageId: m.providerId,
      eventId: `s8-complaint-${run}`,
    });
    expect(await ingestEmailEvent(runtime.db, config, complaint)).toMatchObject({
      outcome: "recorded",
      suppressed: true,
    });
    expect(await ingestEmailEvent(runtime.db, config, complaint)).toMatchObject({
      outcome: "duplicate",
    });
    expect(await suppressions(T)).toMatchObject([{ reason: "complaint" }]);
  });

  it("S9 the admin lifts a suppression with an audit row that names no address", async () => {
    const T = await newTenant("s9");
    const m = await sentMessage(T, "s9");
    await ingestEmailEvent(
      runtime.db,
      config,
      cloudflareEmailEvent("complained", { messageId: m.providerId, eventId: `s9-c-${run}` }),
    );
    const lift = () =>
      admin`select app.email_suppression_lift(${T}::uuid, ${` ${addr("s9").toUpperCase()} `}, 'Guest asked us to') as changed`;
    expect((await lift())[0]?.changed).toBe(true);
    expect((await lift())[0]?.changed).toBe(false);
    const rows = await suppressions(T);
    expect(rows[0]?.lifted_at).not.toBeNull();
    const audit = await admin<
      { subject_id: string; before_state: unknown; after_state: unknown }[]
    >`
      select subject_id, before_state, after_state from public.audit_events
       where tenant_id = ${T} and action = 'email.suppression_lifted'`;
    expect(audit).toHaveLength(1);
    expect(JSON.stringify(audit)).not.toContain("@");
    // Lifted, mail goes again.
    const fixture = createCloudflareEmailFixture();
    const again = await enqueue(T, "s9", "s9-again");
    await deliver(T, fixture, ["s9"]);
    expect(await message(again)).toMatchObject({ state: "sent" });
  });

  it("S10 the runtime cannot suppress an address no event reported, or lift or remove one", async () => {
    const T = await newTenant("s10");
    const m = await sentMessage(T, "s10");
    const r = await ingestEmailEvent(
      runtime.db,
      config,
      cloudflareEmailEvent("bounced", {
        messageId: m.providerId,
        eventId: `s10-soft-${run}`,
        bounceType: "soft",
      }),
    );
    expect(r.outcome).toBe("applied");
    const [ev] = await admin<{ id: string }[]>`
      select id from public.email_events where message_id = ${m.id}`;
    // A soft bounce cannot be passed off as a hard one, nor another address.
    expect(
      await asWriter(T, (trx) =>
        sql`insert into email_suppressions (tenant_id, address, reason, event_id)
            values (${T}, ${addr("s10")}, 'hard_bounce', ${ev?.id})`.execute(trx),
      ),
    ).toEqual({ code: "23514", constraint: "email_suppressions_event" });
    const hard = await ingestEmailEvent(
      runtime.db,
      config,
      cloudflareEmailEvent("bounced", { messageId: m.providerId, eventId: `s10-hard-${run}` }),
    );
    expect(hard).toMatchObject({ outcome: "recorded", suppressed: true });
    const [hardEv] = await admin<{ id: string }[]>`
      select id from public.email_events where message_id = ${m.id} and bounce_type = 'hard'`;
    expect(
      await asWriter(T, (trx) =>
        sql`insert into email_suppressions (tenant_id, address, reason, event_id)
            values (${T}, 'someone.else@example.test', 'hard_bounce', ${hardEv?.id})`.execute(trx),
      ),
    ).toEqual({ code: "23514", constraint: "email_suppressions_event" });
    expect(
      await asWriter(T, (trx) =>
        sql`update email_suppressions set lift_reason = 'x' where tenant_id = ${T}`.execute(trx),
      ),
    ).toMatchObject({ code: "42501" });
    expect(
      await asWriter(T, (trx) =>
        sql`delete from email_suppressions where tenant_id = ${T}`.execute(trx),
      ),
    ).toMatchObject({ code: "42501" });
    // Another tenant cannot see it.
    const other = await newTenant("s10-other");
    const seen = await inTenant(other, (trx) =>
      sql<{ n: number }>`select count(*)::int as n from email_suppressions`.execute(trx),
    );
    expect(seen.rows[0]?.n).toBe(0);
  });

  it("S10b a bounce with no recorded kind cannot back a hard-bounce suppression", async () => {
    const T = await newTenant("s10b");
    const m = await sentMessage(T, "s10b");
    const body = cloudflareEmailEvent("bounced", {
      messageId: m.providerId,
      eventId: `s10b-${run}`,
    });
    delete (body.payload as { bounce?: unknown }).bounce;
    expect(await ingestEmailEvent(runtime.db, config, body)).toMatchObject({ outcome: "applied" });
    expect(await suppressions(T)).toEqual([]);
    const [ev] = await admin<{ id: string; bounce_type: string | null }[]>`
      select id, bounce_type from public.email_events where message_id = ${m.id}`;
    expect(ev?.bounce_type).toBeNull();
    expect(
      await asWriter(T, (trx) =>
        sql`insert into email_suppressions (tenant_id, address, reason, event_id)
            values (${T}, ${addr("s10b")}, 'hard_bounce', ${ev?.id})`.execute(trx),
      ),
    ).toEqual({ code: "23514", constraint: "email_suppressions_event" });
  });

  it("S6b two overlapping adds for different operators at once: the second waits, then is refused", async () => {
    const A = await newTenant("s6b-a");
    const B = await newTenant("s6b-b");
    const parent = domainOf("s6b");
    const other = postgres(env?.adminUrl ?? "", { max: 1, onnotice: () => {} });
    try {
      let releaseFirst: () => void = () => undefined;
      const held = new Promise<void>((resolve) => {
        releaseFirst = resolve;
      });
      const first = admin.begin(async (tx) => {
        await tx`select app.sender_domain_add(${A}::uuid, ${parent}, 'bookings')`;
        await held;
      });
      // Let the first take the lock before the second starts.
      await new Promise((resolve) => setTimeout(resolve, 200));
      const second = other
        .begin(async (tx) => {
          await tx`select app.sender_domain_add(${B}::uuid, ${`mail.${parent}`}, 'bookings')`;
        })
        .then(
          () => null,
          (e: { constraint_name?: string }) => e.constraint_name,
        );
      await new Promise((resolve) => setTimeout(resolve, 300));
      releaseFirst();
      await first;
      expect(await second).toBe("tenant_sender_domains_overlap");
    } finally {
      await other.end({ timeout: 5 });
    }
  });

  it("S11 the consumer accepts an operator's verified domain and refuses one it never verified", async () => {
    const A = await newTenant("s11a");
    const B = await newTenant("s11b");
    const domainA = domainOf("s11a");
    const domainB = domainOf("s11b");
    await adminAdd(A, domainA);
    await adminVerify(A, domainA);
    await adminAdd(B, domainB);
    await adminVerify(B, domainB);
    const m = await sentMessage(A, "s11");
    const event = (domain: string, id: string) =>
      cloudflareEmailEvent("complained", { messageId: m.providerId, eventId: id, domain });
    // Operator B's domain, on operator A's message: refused and retried.
    expect(
      await ingestEmailEvent(runtime.db, config, event(domainB, `s11-b-${run}`)),
    ).toMatchObject({ outcome: "refused_domain" });
    // A domain nobody verified, on an id that joins nothing: refused.
    expect(
      await ingestEmailEvent(
        runtime.db,
        config,
        cloudflareEmailEvent("complained", {
          messageId: `nothing-${run}`,
          eventId: `s11-x-${run}`,
          domain: "unknown.example",
        }),
      ),
    ).toMatchObject({ outcome: "refused_domain" });
    // A verified domain, on an id that joins nothing: kept as unmatched.
    expect(
      await ingestEmailEvent(
        runtime.db,
        config,
        cloudflareEmailEvent("complained", {
          messageId: `nothing-${run}`,
          eventId: `s11-y-${run}`,
          domain: domainB,
        }),
      ),
    ).toMatchObject({ outcome: "unmatched" });
    // Its own domain: applied, and still after the domain is retired.
    await adminRetire(A, domainA);
    expect(
      await ingestEmailEvent(runtime.db, config, event(domainA, `s11-a-${run}`)),
    ).toMatchObject({ outcome: "applied", suppressed: true });
    // Events the consumer drops are still refused from a domain nobody verified.
    expect(
      await ingestEmailEvent(
        runtime.db,
        config,
        cloudflareEmailEvent("delivered", {
          messageId: m.providerId,
          eventId: `s11-d1-${run}`,
          domain: "unknown.example",
        }),
      ),
    ).toMatchObject({ outcome: "refused_domain" });
    expect(
      await ingestEmailEvent(
        runtime.db,
        config,
        cloudflareEmailEvent("delivered", {
          messageId: m.providerId,
          eventId: `s11-d2-${run}`,
          domain: domainB,
        }),
      ),
    ).toMatchObject({ outcome: "ignored" });
    // A name that is not a domain is refused.
    expect(
      await ingestEmailEvent(runtime.db, config, event("not a domain", `s11-z-${run}`)),
    ).toMatchObject({ outcome: "refused_domain" });
  });
});
