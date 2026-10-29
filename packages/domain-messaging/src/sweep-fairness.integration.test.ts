/**
 * Sweep fairness for the email sweep (pre-pilot hardening, item 5, Part C).
 * The shared test database holds other suites' tenants with due mail, so
 * these tests assert relative facts among their own tenants only: the order
 * their mail was sent and the order their turns started. Each test builds
 * fresh tenants, because stamps outlive a test.
 */
import { randomUUID } from "node:crypto";
import { createDb, inTenantTransaction, type TenantContext } from "@tidegrid/database";
import type {} from "@tidegrid/database/global-setup";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";
import { type EmailProvider, enqueueMessage, FakeEmailProvider, sweepEmail } from "./index.ts";

type Sql = ReturnType<typeof postgres>;

const env = inject("integrationDb");
const FROM = "bookings@tidegrid.test";

describe.skipIf(!env)("the email sweep takes fair turns across tenants", () => {
  let admin: Sql;
  let rt: Sql;
  let runtime: ReturnType<typeof createDb>;
  let fake: FakeEmailProvider;

  async function tenant(label: string): Promise<string> {
    const id = randomUUID();
    await admin`insert into public.tenants (id, slug, display_name)
      values (${id}, ${`${label}-${id.slice(0, 8)}`}, ${`Fair mail ${label}`})`;
    return id;
  }

  /** Two fresh tenants, the lower id first: the order before 0013 served it first. */
  async function pair(label: string): Promise<[string, string]> {
    const ids = [await tenant(`${label}-1`), await tenant(`${label}-2`)].sort();
    return [ids[0] as string, ids[1] as string];
  }

  /** `n` messages due now for the tenant, oldest first. */
  async function due(tenantId: string, n: number): Promise<string[]> {
    const ids: string[] = [];
    for (let i = 0; i < n; i++) {
      const ctx: TenantContext = {
        tenantId,
        actorType: "system",
        actorId: "fair-mail-test",
        requestId: `req-${randomUUID()}`,
      };
      const queued = await inTenantTransaction(runtime.db, ctx, (trx) =>
        enqueueMessage(trx, ctx, {
          dedupeKey: `test.fair:${randomUUID()}`,
          template: "test_message",
          templateVersion: 1,
          to: { email: "guest@example.test", name: "Test Guest" },
          content: { subject: `Fair ${i}`, blocks: [{ kind: "paragraph", text: "Fair." }] },
        }),
      );
      ids.push(queued.messageId);
    }
    await admin`update public.email_messages set next_attempt_at = now() - interval '1 second'
      where id in ${admin(ids)} and state = 'queued'`;
    return ids;
  }

  /** These messages that were sent, in the order they were sent. */
  const sentOrder = async (ids: readonly string[]) =>
    (
      await admin<{ id: string }[]>`
        select id from public.email_messages
         where id in ${admin(ids)} and state = 'sent' order by sent_at, id`
    ).map((r) => r.id);

  const states = async (ids: readonly string[]) =>
    (
      await admin<{ state: string }[]>`
        select state from public.email_messages where id in ${admin(ids)}`
    ).map((r) => r.state);

  const listed = async (ours: readonly string[]) =>
    (await rt<{ tenant_id: string }[]>`select tenant_id from app.email_delivery_tenants(1000)`)
      .map((r) => r.tenant_id)
      .filter((id) => ours.includes(id));

  async function sweep(
    ours: readonly string[],
    options: { provider?: EmailProvider; budgetMs?: number } = {},
  ) {
    const turns: string[] = [];
    const report = await sweepEmail(runtime.db, {
      provider: options.provider ?? fake,
      fromAddress: FROM,
      runId: `fair-${randomUUID()}`,
      tenantLimit: 1000,
      budgetMs: options.budgetMs ?? 60_000,
      onTurnStart: (tenantId, pass) => {
        if (ours.includes(tenantId)) turns.push(`${tenantId}@${pass}`);
      },
    });
    return { turns, report };
  }

  beforeAll(async () => {
    if (!env) return;
    admin = postgres(env.adminUrl, { max: 2, onnotice: () => {} });
    rt = postgres(env.runtimeUrl, { max: 2, onnotice: () => {} });
    runtime = createDb(env.runtimeUrl, { max: 4 });
    fake = new FakeEmailProvider({ db: runtime.db, environment: "local" });
  });

  afterAll(async () => {
    await runtime?.end();
    await rt?.end({ timeout: 5 });
    await admin?.end({ timeout: 5 });
  });

  it("sends the high-id tenant's mail before the low-id tenant's second quantum of five", async () => {
    const [hog, victim] = await pair("fair-mail");
    const hogs = await due(hog, 12);
    const [mine] = await due(victim, 1);
    const { turns } = await sweep([hog, victim]);
    // Before 0013 the hog's twelve were all sent first. Within a tenant the
    // claim order is the delivery's own, so only the victim's place is fixed.
    const order = await sentOrder([...hogs, mine ?? ""]);
    expect(order).toHaveLength(13);
    expect(order.indexOf(mine ?? "")).toBe(5);
    expect(turns.slice(0, 3)).toEqual([`${hog}@1`, `${victim}@1`, `${hog}@2`]);
  });

  it("still sends at most 25 of one tenant's messages a run", async () => {
    const t = await tenant("fair-mail-cap");
    const ids = await due(t, 30);
    const { report } = await sweep([t]);
    expect(report.failedTenants).toBe(0);
    expect((await states(ids)).filter((s) => s === "sent")).toHaveLength(25);
  });

  it("lists a tenant it has never served first, and a tenant after its turn behind it", async () => {
    const [low, high] = await pair("fair-mail-order");
    await due(low, 1);
    await sweep([low, high]);
    await due(low, 1);
    await due(high, 1);
    // Before 0013: id order, the low id first, every run.
    expect(await listed([low, high])).toEqual([high, low]);
  });

  it("claims nothing once its budget leaves no room for a send (D9 B)", async () => {
    const t = await tenant("fair-mail-deadline");
    const ids = await due(t, 3);
    // A provider whose one send may take 10 s; a 5 s budget has no room for it.
    const slow: EmailProvider = {
      name: fake.name,
      deduplicates: true,
      sendTimeoutMs: 10_000,
      send: (email) => fake.send(email),
    };
    const { report, turns } = await sweep([t], { provider: slow, budgetMs: 5_000 });
    expect(report.complete).toBe(false);
    expect(await states(ids)).toEqual(["queued", "queued", "queued"]);
    // No turn starts at all, ours included, so nobody is stamped or counted as
    // served for a turn that could send nothing; every listed tenant waits.
    expect(turns).toEqual([]);
    expect(report).toMatchObject({ tenants: 0, turns: 0, claimed: 0 });
    expect(report.deferredTenants).toBeGreaterThanOrEqual(1);
    const [stamps] = await admin<{ n: number }[]>`
      select count(*)::int as n from public.sweep_turns where tenant_id = ${t} and sweep = 'email'`;
    expect(stamps?.n).toBe(0);
    expect((await listed([t]))[0]).toBe(t);
  });

  it("delivers a tenant's backlog across several turns of one run", async () => {
    const t = await tenant("fair-mail-origin");
    const ids = await due(t, 12);
    const { turns } = await sweep([t]);
    expect(turns.length).toBeGreaterThanOrEqual(3);
    expect((await states(ids)).filter((s) => s === "sent")).toHaveLength(12);
  });
});
