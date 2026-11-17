/**
 * Sealed email (W3-OPS-4, 0057, owner decision 2026-11-15): where the
 * database handle carries a field keyring, a message's recipient, name,
 * subject, and bodies are sealed, `to_email` holds the address key, and the
 * delivery job opens them to send. A hard bounce suppresses the key, which
 * stops later mail to the same address. Against a throwaway PostgreSQL 17 as
 * tidegrid_app; messages go through the Cloudflare adapter's fixture.
 */
import { randomUUID } from "node:crypto";
import {
  bindFieldPolicy,
  createDb,
  type FieldKeyring,
  FieldKeyringError,
  inTenantTransaction,
  newFieldKeyringSecret,
  parseFieldKeyring,
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
  cancelMessage,
  createCloudflareEmailProvider,
  deliverTenantMessages,
  enqueueMessage,
  ingestEmailEvent,
  SEALED_ADDRESS_MISMATCH,
} from "./index.ts";

type Sql = ReturnType<typeof postgres>;

const env = inject("integrationDb");
const SHARED = `bookings@${FIXTURE_SENDING_DOMAIN}`;

describe.skipIf(!env)("sealed email (W3-OPS-4, 0057)", () => {
  let admin: Sql;
  let sealed: ReturnType<typeof createDb>;
  let plain: ReturnType<typeof createDb>;
  let keyring: FieldKeyring;
  const run = randomUUID().slice(0, 8);
  const addr = (label: string) => `se.${run}.${label}@example.test`;

  const ctxFor = (tenantId: string): TenantContext => ({
    tenantId,
    actorType: "system",
    actorId: "sealed-email-test",
    requestId: `req-${randomUUID()}`,
  });
  const inTenant = <T>(
    tenantId: string,
    fn: (trx: TenantTransaction) => Promise<T>,
    db = sealed.db,
  ) => inTenantTransaction(db, ctxFor(tenantId), fn);

  async function newTenant(label: string): Promise<string> {
    const id = randomUUID();
    await admin`insert into public.tenants (id, slug, display_name)
      values (${id}, ${`se-${label}-${id.slice(0, 8)}`}, ${`Sealed ${label}`})`;
    return id;
  }

  async function enqueue(
    tenantId: string,
    label: string,
    key = label,
    db = sealed.db,
  ): Promise<string> {
    const { messageId } = await inTenant(
      tenantId,
      (trx) =>
        enqueueMessage(trx, ctxFor(tenantId), {
          dedupeKey: `se.message:${run}-${key}`,
          template: "se_message",
          templateVersion: 1,
          to: { email: addr(label).toUpperCase(), name: "Ana Example" },
          content: {
            subject: `Hello Ana ${label}`,
            blocks: [{ kind: "paragraph", text: "Hi Ana, see you on the dock." }],
          },
        }),
      db,
    );
    return messageId;
  }

  const deliver = (
    tenantId: string,
    fixture: CloudflareEmailFixture,
    labels: string[],
    db = sealed.db,
  ) =>
    deliverTenantMessages(db, tenantId, {
      provider: createCloudflareEmailProvider({
        binding: fixture.binding,
        recipients: { kind: "only", addresses: new Set(labels.map(addr)) },
        environment: "local",
        timeoutMs: 500,
      }),
      fromAddress: SHARED,
      runId: `run-${randomUUID()}`,
    });

  const stored = async (id: string) => {
    const [row] = await admin<
      {
        to_email: string;
        to_email_index: string | null;
        to_name: string | null;
        subject: string | null;
        html_body: string | null;
        text_body: string | null;
        content_sealed: string | null;
        state: string;
        last_error_code: string | null;
        provider_message_id: string | null;
      }[]
    >`select to_email, to_email_index, to_name, subject, html_body, text_body, content_sealed,
             state, last_error_code, provider_message_id
        from public.email_messages where id = ${id}`;
    if (!row) throw new Error("no message");
    return row;
  };

  beforeAll(async () => {
    if (!env) return;
    admin = postgres(env.adminUrl, { max: 2, onnotice: () => {} });
    keyring = await parseFieldKeyring(newFieldKeyringSecret());
    sealed = createDb(env.runtimeUrl, { max: 4 });
    bindFieldPolicy(sealed.db, { keyring: async () => keyring, required: true });
    plain = createDb(env.runtimeUrl, { max: 2 });
  });

  afterAll(async () => {
    await sealed?.end();
    await plain?.end();
    await admin?.end({ timeout: 5 });
  });

  it("stores a key and sealed content, and sends the opened address, name, and content", async () => {
    const T = await newTenant("e1");
    const id = await enqueue(T, "e1");
    const row = await stored(id);
    expect(row).toMatchObject({ to_name: null, subject: null, html_body: null, text_body: null });
    expect(row.to_email).toBe(`${row.to_email_index}@sealed.invalid`);
    expect(row.to_email_index).toMatch(/^[0-9a-f]{64}$/);
    expect(row.content_sealed).toMatch(/^tgf1:k1:/);
    // The ciphertext is left out: random base64url can spell "Ana" by chance.
    const { content_sealed: _ciphertext, ...readable } = row;
    expect(JSON.stringify(readable)).not.toMatch(/Ana|example\.test/);

    // A handle with no keyring cannot send it, and never sends it blank.
    const fixture = createCloudflareEmailFixture();
    await expect(deliver(T, fixture, ["e1"], plain.db)).rejects.toBeInstanceOf(FieldKeyringError);
    expect(fixture.sends).toHaveLength(0);

    await deliver(T, fixture, ["e1"]);
    expect((await stored(id)).state).toBe("sent");
    const sent = fixture.sends.at(-1)?.builder;
    expect(sent?.to).toEqual({ email: addr("e1"), name: "Ana Example" });
    expect(sent?.subject).toBe("Hello Ana e1");
    expect(sent?.text).toContain("Hi Ana, see you on the dock.");
  });

  it("refuses a sealed message with plain content, or a plain one with a key", async () => {
    const T = await newTenant("e2");
    const id = await enqueue(T, "e2");
    const row = await stored(id);
    const insert = (values: { to_email: string; subject: string | null; sealed: string | null }) =>
      inTenant(T, (trx) =>
        sql`insert into email_messages (tenant_id, dedupe_key, template, template_version,
              to_email, from_name, subject, html_body, text_body, content_sealed)
            values (${T}, ${`se.raw:${randomUUID()}`}, 'se_message', 1, ${values.to_email},
                    'Sealed', ${values.subject}, ${values.subject}, ${values.subject},
                    ${values.sealed})`.execute(trx),
      ).then(
        () => null,
        (e: { constraint_name?: string }) => e.constraint_name ?? String(e),
      );
    expect(
      await insert({ to_email: row.to_email, subject: "Hi", sealed: row.content_sealed }),
    ).toBe("email_messages_content_place");
    expect(await insert({ to_email: row.to_email, subject: "Hi", sealed: null })).toBe(
      "email_messages_content_place",
    );
    expect(await insert({ to_email: addr("x"), subject: null, sealed: row.content_sealed })).toBe(
      "email_messages_content_place",
    );
    // Cancel it, so no sealed message is left due for another suite's sweep,
    // which runs without the keyring.
    await inTenant(T, (trx) => cancelMessage(trx, ctxFor(T), id));
    expect((await stored(id)).state).toBe("canceled");
  });

  it("suppresses the address key on a hard bounce, which stops the next mail to that address", async () => {
    const T = await newTenant("e3");
    const fixture = createCloudflareEmailFixture();
    const first = await enqueue(T, "e3");
    await deliver(T, fixture, ["e3"]);
    const sent = await stored(first);
    if (!sent.provider_message_id) throw new Error("not sent");
    const hard = await ingestEmailEvent(
      sealed.db,
      { accountId: FIXTURE_ACCOUNT_ID, sendingDomain: FIXTURE_SENDING_DOMAIN },
      cloudflareEmailEvent("bounced", {
        messageId: sent.provider_message_id,
        eventId: `se-hard-${run}`,
      }),
    );
    expect(hard).toMatchObject({ outcome: "applied", suppressed: true });
    const suppressions = await admin<{ address: string }[]>`
      select address from public.email_suppressions where tenant_id = ${T}`;
    expect(suppressions).toEqual([{ address: sent.to_email }]);

    const next = await enqueue(T, "e3", "e3-next");
    const before = fixture.sends.length;
    const report = await deliver(T, fixture, ["e3"]);
    expect(report.items).toEqual([
      expect.objectContaining({ messageId: next, outcome: "failed", code: ADDRESS_SUPPRESSED }),
    ]);
    expect(fixture.sends).toHaveLength(before);
  });

  it("refuses to send a sealed value copied onto another recipient's address key", async () => {
    const T = await newTenant("e4");
    const fixture = createCloudflareEmailFixture();
    const ana = await enqueue(T, "e4a");
    const ben = await enqueue(T, "e4b");
    const [a, b] = [await stored(ana), await stored(ben)];
    // Ben's key and index, Ana's sealed content: the database's shape rules
    // hold, so only the delivery job can tell.
    const copy = await inTenant(T, (trx) =>
      sql<{ id: string }>`insert into email_messages (tenant_id, dedupe_key, template,
            template_version, to_email, to_email_index, from_name, content_sealed)
          values (${T}, ${`se.copy:${randomUUID()}`}, 'se_message', 1, ${b.to_email},
                  ${b.to_email_index}, 'Sealed', ${a.content_sealed})
          returning id`.execute(trx),
    ).then((r) => r.rows[0]?.id);
    const report = await deliver(T, fixture, ["e4a", "e4b"]);
    expect(report.items).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ messageId: ana, outcome: "sent" }),
        expect.objectContaining({ messageId: ben, outcome: "sent" }),
        expect.objectContaining({
          messageId: copy,
          outcome: "failed",
          code: SEALED_ADDRESS_MISMATCH,
        }),
      ]),
    );
    expect(fixture.sends).toHaveLength(2);
    if (!copy) throw new Error("no copy");
    expect(await stored(copy)).toMatchObject({
      state: "failed",
      last_error_code: SEALED_ADDRESS_MISMATCH,
    });
  });

  it("applies a suppression recorded before the environment sealed to a sealed message", async () => {
    const T = await newTenant("e5");
    const fixture = createCloudflareEmailFixture();
    // Written plain, sent, and hard bounced: the suppression holds the address.
    const first = await enqueue(T, "e5", "e5", plain.db);
    await deliver(T, fixture, ["e5"], plain.db);
    const sent = await stored(first);
    if (!sent.provider_message_id) throw new Error("not sent");
    await ingestEmailEvent(
      plain.db,
      { accountId: FIXTURE_ACCOUNT_ID, sendingDomain: FIXTURE_SENDING_DOMAIN },
      cloudflareEmailEvent("bounced", {
        messageId: sent.provider_message_id,
        eventId: `se-legacy-${run}`,
      }),
    );
    expect(
      await admin<{ address: string }[]>`
        select address from public.email_suppressions where tenant_id = ${T}`,
    ).toEqual([{ address: addr("e5") }]);

    // The next message is sealed and keyed; the plain suppression still stops it.
    const next = await enqueue(T, "e5", "e5-next");
    expect((await stored(next)).to_email).toMatch(/@sealed\.invalid$/);
    const before = fixture.sends.length;
    const report = await deliver(T, fixture, ["e5"]);
    expect(report.items).toEqual([
      expect.objectContaining({ messageId: next, outcome: "failed", code: ADDRESS_SUPPRESSED }),
    ]);
    expect(fixture.sends).toHaveLength(before);
  });
});
