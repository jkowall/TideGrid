/**
 * The sender identity guard (W1-SENDER-GUARD) against a throwaway PostgreSQL
 * 17 as tidegrid_app. A brand's name leads the sender display name only when
 * it passes the sender name rule and reads as the tenant's provisioned
 * display name, which the runtime role cannot change. Stored brands are
 * written as the admin, past the contract, the way a corrupt or older row
 * would be.
 */
import { randomUUID } from "node:crypto";
import { createDb, inTenantTransaction, type TenantContext } from "@tidegrid/database";
import type {} from "@tidegrid/database/global-setup";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";
import { createCloudflareEmailFixture } from "./cloudflare-fixture.ts";
import { FakeEmailProvider } from "./fake.ts";
import { createCloudflareEmailProvider, deliverTenantMessages, enqueueMessage } from "./index.ts";

type Sql = ReturnType<typeof postgres>;

const env = inject("integrationDb");
const FROM = "bookings@tidegrid.test";
const GUEST = "guard.guest@example.test";

const brandConfig = (name: string, email = "hello@guard-harbor.test") => ({
  name,
  colors: { primary: "#0b3c5d", accent: "#e0a526" },
  fonts: { display: "fraunces", body: "source-sans-3" },
  contact: { email },
  legal: { terms: "/legal/terms", privacy: "/legal/privacy" },
  locale: "en-US",
  capabilities: [],
});

describe.skipIf(!env)("the sender identity guard against a real database", () => {
  let admin: Sql;
  let runtime: ReturnType<typeof createDb>;

  beforeAll(async () => {
    if (!env) return;
    admin = postgres(env.adminUrl, { max: 2, onnotice: () => {} });
    runtime = createDb(env.runtimeUrl, { max: 2 });
  });

  afterAll(async () => {
    await runtime?.end();
    await admin?.end({ timeout: 5 });
  });

  async function tenant(
    displayName: string,
    brand?: ReturnType<typeof brandConfig>,
  ): Promise<string> {
    const id = randomUUID();
    await admin`insert into public.tenants (id, slug, display_name)
      values (${id}, ${`guard-${id.slice(0, 8)}`}, ${displayName})`;
    if (brand) {
      await admin`insert into public.brand_config_versions (tenant_id, version, schema_version, config)
        values (${id}, 1, 1, ${admin.json(brand)})`;
      await admin`insert into public.brand_activations (tenant_id, version, reason)
        values (${id}, 1, 'test')`;
    }
    return id;
  }

  async function enqueued(tenantId: string) {
    const ctx: TenantContext = {
      tenantId,
      actorType: "system",
      actorId: "sender-guard-test",
      requestId: `req-${randomUUID()}`,
    };
    const result = await inTenantTransaction(runtime.db, ctx, (trx) =>
      enqueueMessage(trx, ctx, {
        dedupeKey: `test.guard:${randomUUID()}`,
        template: "test_message",
        templateVersion: 1,
        to: { email: GUEST, name: "Guard Guest" },
        content: { subject: "Synthetic", blocks: [{ kind: "paragraph", text: "Synthetic." }] },
      }),
    );
    const [row] = await admin<
      {
        id: string;
        from_name: string;
        reply_to: string | null;
        html_body: string;
        text_body: string;
      }[]
    >`select id, from_name, reply_to, html_body, text_body
        from public.email_messages where id = ${result.messageId}`;
    if (!row) throw new Error("no message");
    return row;
  }

  it("uses a brand's name that reads as the provisioned name, and sends it via TideGrid", async () => {
    const id = await tenant("GUARD HARBOR CHARTERS", brandConfig("Guard Harbor Charters"));
    const row = await enqueued(id);
    expect(row.from_name).toBe("Guard Harbor Charters");
    expect(row.reply_to).toBe("hello@guard-harbor.test");
    expect(row.text_body.startsWith("Guard Harbor Charters\n")).toBe(true);

    const fixture = createCloudflareEmailFixture();
    const provider = createCloudflareEmailProvider({
      binding: fixture.binding,
      recipients: { kind: "only", addresses: new Set([GUEST]) },
      environment: "local",
    });
    const report = await deliverTenantMessages(runtime.db, id, {
      provider,
      fromAddress: FROM,
      runId: `run-${randomUUID()}`,
    });
    expect(report.items.find((i) => i.messageId === row.id)).toMatchObject({ outcome: "sent" });
    const sent = fixture.sends.find((s) => s.builder.headers["X-TideGrid-Message-Id"] === row.id);
    expect(sent?.builder.from).toEqual({ email: FROM, name: "Guard Harbor Charters via TideGrid" });
  });

  it("never sends as another tenant: a brand that names another operator falls back to the provisioned name", async () => {
    await tenant("Guard Reef Divers", brandConfig("Guard Reef Divers"));
    const impostor = await tenant("Guard Impostor Tours", brandConfig("Guard Reef Divers"));
    const row = await enqueued(impostor);
    expect(row.from_name).toBe("Guard Impostor Tours");
    expect(row.html_body).not.toContain("Guard Reef Divers");
    expect(row.text_body).not.toContain("Guard Reef Divers");
    // The brand's colors and contact still apply; only the name is bound.
    expect(row.reply_to).toBe("hello@guard-harbor.test");
  });

  it.each([
    ["TideGrid staff", "TideGrid Support"],
    ["a lookalike", "T1deGr1d Bookings"],
    ["a Unicode confusable", "TіdeGrіd"],
    ["a Cf format character", "Guard‮Harbor"],
    ["a reserved staff name", "Customer Support"],
    ["an unfolded Latin lookalike", "\u01ac\u0268\u0256\u0247\u0193\u024d\u0268\u0256"],
    [
      "unfolded text after the provisioned name",
      "Guard Neutral Tours \u01c0 \u01ae\u0268\u0256\u025b \u01e4\u027d\u0268\u0256",
    ],
    ["staff words and a digit", "Support Team 2"],
  ])("refuses a stored brand named as %s and uses the neutral brand", async (_label, name) => {
    const id = await tenant("Guard Neutral Tours", brandConfig(name));
    const row = await enqueued(id);
    expect(row.from_name).toBe("Guard Neutral Tours");
    expect(row.reply_to).toBeNull();
    expect(row.html_body).not.toContain(name);
  });

  it("refuses a stored brand whose reply-to names TideGrid in its local part", async () => {
    const id = await tenant(
      "Guard Local Tours",
      brandConfig("Guard Local Tours", "tidegrid.support@guard-harbor.test"),
    );
    const row = await enqueued(id);
    expect(row.from_name).toBe("Guard Local Tours");
    expect(row.reply_to).toBeNull();
    expect(row.html_body).not.toContain("tidegrid.support");
  });

  it("refuses a stored brand whose reply-to sits on a TideGrid domain", async () => {
    const id = await tenant(
      "Guard Reply Tours",
      brandConfig("Guard Reply Tours", "support@tidegrid.us"),
    );
    const row = await enqueued(id);
    expect(row.from_name).toBe("Guard Reply Tours");
    expect(row.reply_to).toBeNull();
    expect(row.html_body).not.toContain("tidegrid.us");
  });

  /** A queued message written past enqueueMessage, as one queued before the guard would be. */
  async function stored(tenantId: string, fromName: string, replyTo: string | null) {
    const [row] = await admin<{ id: string }[]>`
      insert into public.email_messages (tenant_id, dedupe_key, template, template_version,
        to_email, to_name, from_name, reply_to, subject, html_body, text_body)
      values (${tenantId}, ${`test.guard:${randomUUID()}`}, 'test_message', 1, ${GUEST},
              'Guard Guest', ${fromName}, ${replyTo}, 'Synthetic', '<p>Synthetic.</p>',
              'Synthetic.')
      returning id`;
    if (!row) throw new Error("no message");
    return row.id;
  }

  // Pull request review fix G1: delivery checks the stored sender again.
  it("delivers a pending message stored with another operator's name and a TideGrid reply-to under the provisioned name", async () => {
    await tenant("Guard Pending Reef", brandConfig("Guard Pending Reef"));
    const impostor = await tenant(
      "Guard Pending Impostor",
      brandConfig("Guard Pending Impostor", "hello@guard-impostor.test"),
    );
    const cases: [string, string | null][] = [
      ["Guard Pending Reef", "support@tidegrid.us"],
      ["T!de!Gr!d", "support@xn--tdegrd-pvfe.test"],
      ["GUARD PENDING IMPOSTOR", "tide1grid@guard-impostor.test"],
      ["Guard Pending Impostor", "hello@guard-impostor.test"],
    ];
    const ids = [];
    for (const [fromName, replyTo] of cases) ids.push(await stored(impostor, fromName, replyTo));

    const fixture = createCloudflareEmailFixture();
    const provider = createCloudflareEmailProvider({
      binding: fixture.binding,
      recipients: { kind: "only", addresses: new Set([GUEST]) },
      environment: "local",
    });
    const report = await deliverTenantMessages(runtime.db, impostor, {
      provider,
      fromAddress: FROM,
      runId: `run-${randomUUID()}`,
    });
    const sent = (id: string) => {
      expect(report.items.find((i) => i.messageId === id)).toMatchObject({ outcome: "sent" });
      const send = fixture.sends.find((s) => s.builder.headers["X-TideGrid-Message-Id"] === id);
      if (!send) throw new Error("not sent");
      return send.builder;
    };
    const [reef, lookalike, upper, clean] = ids as [string, string, string, string];
    expect(sent(reef).from).toEqual({ email: FROM, name: "Guard Pending Impostor via TideGrid" });
    expect(sent(reef).replyTo).toBeUndefined();
    expect(sent(lookalike).from).toEqual({
      email: FROM,
      name: "Guard Pending Impostor via TideGrid",
    });
    expect(sent(lookalike).replyTo).toBeUndefined();
    // A stored name that reads as the brand's name is kept as written.
    expect(sent(upper).from).toEqual({ email: FROM, name: "GUARD PENDING IMPOSTOR via TideGrid" });
    expect(sent(upper).replyTo).toBeUndefined();
    expect(sent(clean).from).toEqual({ email: FROM, name: "Guard Pending Impostor via TideGrid" });
    expect(sent(clean).replyTo).toBe("hello@guard-impostor.test");
  });

  it("delivers a stored impostor name through the fake provider under the provisioned name too", async () => {
    await tenant("Guard Fake Reef", brandConfig("Guard Fake Reef"));
    const impostor = await tenant("Guard Fake Impostor");
    const id = await stored(impostor, "Guard Fake Reef", "support@tidegrid.us");
    const fake = new FakeEmailProvider({ db: runtime.db, environment: "local" });
    const report = await deliverTenantMessages(runtime.db, impostor, {
      provider: fake,
      fromAddress: FROM,
      runId: `run-${randomUUID()}`,
    });
    expect(report.items.find((i) => i.messageId === id)).toMatchObject({ outcome: "sent" });
    const [delivery] = await admin<{ from_name: string; reply_to: string | null }[]>`
      select from_name, reply_to from public.fake_email_deliveries
       where tenant_id = ${impostor} and idempotency_key = ${id}`;
    expect(delivery).toEqual({ from_name: "Guard Fake Impostor", reply_to: null });
  });

  it("never sends under a reserved provisioned name either", async () => {
    const id = await tenant("TideGrid Staff");
    const row = await enqueued(id);
    expect(row.from_name).toBe("Your trip operator");
    expect(row.text_body).not.toContain("TideGrid Staff");
  });
});
