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
  ])("refuses a stored brand named as %s and uses the neutral brand", async (_label, name) => {
    const id = await tenant("Guard Neutral Tours", brandConfig(name));
    const row = await enqueued(id);
    expect(row.from_name).toBe("Guard Neutral Tours");
    expect(row.reply_to).toBeNull();
    expect(row.html_body).not.toContain(name);
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

  it("never sends under a reserved provisioned name either", async () => {
    const id = await tenant("TideGrid Staff");
    const row = await enqueued(id);
    expect(row.from_name).toBe("Your trip operator");
    expect(row.text_body).not.toContain("TideGrid Staff");
  });
});
