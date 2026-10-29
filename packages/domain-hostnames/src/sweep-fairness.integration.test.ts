/**
 * Sweep fairness for the hostname sweep (pre-pilot hardening, item 5, Part
 * D). The shared test database holds other suites' tenants with due
 * hostnames, so every sweep here is limited to this file's tenants
 * (`onlyTenants`) with a tenant limit above every tenant in the database, and
 * list assertions are relative facts among this file's tenants. Each test
 * builds fresh tenants, because stamps outlive a test. With no stamps the list
 * is id order (0013), so the tenant that would hog a run takes an id that
 * sorts first and the tenant it would starve one that sorts last.
 */
import { randomUUID } from "node:crypto";
import { createDb } from "@tidegrid/database";
import type {} from "@tidegrid/database/global-setup";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";
import { createFakeHostnameProvider } from "./fake.ts";
import {
  activateCustomHostname,
  type HostnameSweepOptions,
  requestCustomHostname,
  sweepHostnames,
} from "./lifecycle.ts";
import {
  type CustomHostnameProvider,
  HostnameProviderRejectedError,
  HostnameProviderUnavailableError,
} from "./provider.ts";

type Sql = ReturnType<typeof postgres>;

const env = inject("integrationDb");

describe.skipIf(!env)("the hostname sweep takes fair turns across tenants", () => {
  let admin: Sql;
  let runtime: Sql;
  let adminDb: ReturnType<typeof createDb>;
  let runtimeDb: ReturnType<typeof createDb>;
  const run = randomUUID().slice(0, 8);
  const actor = { actorId: "sweep-fairness-test", requestId: `fair-${run}` };
  const name = (label: string) => `${label}-${run}.example.com`;
  // One provider for the file, with ids of its own: provider ids are unique
  // across the database, and lifecycle.integration.test.ts uses the default
  // prefix in the same database.
  const fake = createFakeHostnameProvider({ idPrefix: `fair-${run}` });
  /** Every tenant this file made, for the cleanup. */
  const mine: string[] = [];
  let sequence = 0;

  /** A fresh tenant whose id sorts before (`low`) or after (`high`) every random id. */
  async function tenant(label: string, sort: "low" | "high" | "any" = "any"): Promise<string> {
    sequence += 1;
    const n = sequence.toString(16).padStart(4, "0");
    const id =
      sort === "low"
        ? `00000000-0000-4000-8000-${run}${n}`
        : sort === "high"
          ? `ffffffff-ffff-4fff-bfff-${run}${n}`
          : randomUUID();
    await admin`insert into public.tenants (id, slug, display_name)
      values (${id}, ${`fr-${label}-${run}`}, ${`Fair ${label}`})`;
    mine.push(id);
    return id;
  }

  /** `n` hostnames that sort by their number once all are due at one instant. */
  const hosts = (label: string, n: number) =>
    Array.from({ length: n }, (_, i) => name(`${label}-${String(i + 1).padStart(2, "0")}`));

  /** Request, then activate once the fake reports both states active. */
  async function activeHost(tenantId: string, host: string) {
    const requested = await requestCustomHostname(adminDb.db, fake, {
      tenantId,
      hostname: host,
      actor,
    });
    expect(requested.kind).toBe("requested");
    fake.advance(host, { hostnameState: "active", certificateState: "active" });
    const activated = await activateCustomHostname(adminDb.db, fake, {
      tenantId,
      hostname: host,
      actor,
    });
    expect(activated.kind).toBe("activated");
  }

  /**
   * A pending reservation with a provider record whose claim ran out a minute
   * ago, written by the admin role directly because no function backdates a
   * claim.
   */
  async function endedClaim(tenantId: string, host: string) {
    await admin.begin(async (tx) => {
      await tx`insert into public.tenant_hostnames (hostname, tenant_id, kind, status)
        values (${host}, ${tenantId}, 'custom', 'pending')`;
      await tx`insert into public.tenant_hostname_provisioning
          (tenant_id, hostname, provider, claim_expires_at)
        values (${tenantId}, ${host}, 'fake', now() - interval '1 minute')`;
    });
    fake.plantRecord(host);
    const providerId = fake.records().find((r) => r.hostname === host)?.providerId ?? null;
    await admin`select app.hostname_attach_provider(${tenantId}::uuid, ${host},
      ${providerId}, '[]'::jsonb)`;
  }

  /** Make every check of these tenants' hostnames due now; stamps are untouched. */
  async function due(...tenantIds: string[]) {
    await admin`update public.tenant_hostname_provisioning
                   set next_check_at = now() - interval '1 second'
                 where tenant_id in ${admin(tenantIds)}`;
  }

  /** A tenant limit above every tenant in the database. */
  async function everyTenant(): Promise<number> {
    const [row] = await admin<{ n: number }[]>`select count(*)::int as n from public.tenants`;
    return (row?.n ?? 0) + 1;
  }

  /** The runtime's due list, as the sweep reads it, kept to `ours` in its order. */
  async function listed(ours: readonly string[]): Promise<string[]> {
    const rows = await runtime<{ tenant_id: string }[]>`
      select tenant_id from app.hostname_sweep_tenants(${await everyTenant()})`;
    return rows.map((r) => r.tenant_id).filter((id) => ours.includes(id));
  }

  /** The tenants among `ids` with a hostname stamp, least recently stamped first. */
  async function stamps(ids: readonly string[]): Promise<string[]> {
    const rows = await admin<{ tenant_id: string }[]>`
      select tenant_id from public.sweep_turns
       where sweep = 'hostname' and tenant_id in ${admin(ids)}
       order by last_turn_at, tenant_id`;
    return rows.map((r) => r.tenant_id);
  }

  async function checkRow(host: string) {
    const [row] = await admin<
      {
        status: string;
        hostname_state: string | null;
        certificate_state: string | null;
        last_error_code: string | null;
        checked: Date | null;
        next: Date;
        attempts: number;
        due: boolean;
      }[]
    >`
      select h.status, p.hostname_state, p.certificate_state, p.last_error_code,
             p.last_checked_at as checked, p.next_check_at as next, p.check_attempts as attempts,
             p.next_check_at <= now() as due
        from public.tenant_hostname_provisioning p
        join public.tenant_hostnames h on h.hostname = p.hostname and h.tenant_id = p.tenant_id
       where p.hostname = ${host}`;
    if (!row) throw new Error(`no row for ${host}`);
    return row;
  }

  /**
   * The file's fake behind a stand-in that logs each hostname read, in order.
   * `answer` runs first and may throw a provider error for that read.
   */
  function reads(answer?: (host: string) => void | Promise<void>) {
    const read: string[] = [];
    const provider: CustomHostnameProvider = {
      name: "fake",
      routingTarget: () => fake.routingTarget(),
      create: (input) => fake.create(input),
      get: async (id, expected) => {
        read.push(expected);
        await answer?.(expected);
        return fake.get(id, expected);
      },
      findByHostname: (h) => fake.findByHostname(h),
      refreshValidation: (id, h) => fake.refreshValidation(id, h),
      remove: (id) => fake.remove(id),
    };
    return { provider, read };
  }

  /** One sweep over `ours` only, with every tenant in the database listed. */
  async function sweep(
    ours: readonly string[],
    provider: CustomHostnameProvider,
    options: Partial<HostnameSweepOptions> = {},
  ) {
    const turns: string[] = [];
    const failures: string[] = [];
    const report = await sweepHostnames(runtimeDb.db, {
      provider,
      runId: `fair-${randomUUID()}`,
      onlyTenants: ours,
      tenantLimit: await everyTenant(),
      onTurnStart: (tenantId, pass) => turns.push(`${tenantId}@${pass}`),
      onTenantError: (tenantId) => failures.push(tenantId),
      ...options,
    });
    return { report, turns, failures };
  }

  /** A low-id hog and a high-id victim, each with active hostnames due now. */
  async function pair(label: string, hogCount: number, victimCount: number) {
    const hog = await tenant(`${label}-hog`, "low");
    const victim = await tenant(`${label}-victim`, "high");
    const hogHosts = hosts(`${label}-hog`, hogCount);
    const victimHosts = hosts(`${label}-victim`, victimCount);
    for (const h of hogHosts) await activeHost(hog, h);
    for (const h of victimHosts) await activeHost(victim, h);
    await due(hog, victim);
    return { hog, victim, hogHosts, victimHosts };
  }

  beforeAll(async () => {
    if (!env) return;
    admin = postgres(env.adminUrl, { max: 2, onnotice: () => {} });
    runtime = postgres(env.runtimeUrl, { max: 2, onnotice: () => {} });
    adminDb = createDb(env.adminUrl, { max: 2 });
    runtimeDb = createDb(env.runtimeUrl, { max: 2 });
  });

  afterAll(async () => {
    try {
      // Leave nothing of this file due, so the unfiltered sweeps of
      // lifecycle.integration.test.ts never meet it, whatever the file order.
      // A pending row whose claim ran out stays due whatever its next check
      // says, so one last sweep expires those, with no provider call.
      if (admin && mine.length > 0) {
        await admin`update public.tenant_hostname_provisioning
                       set next_check_at = now() + interval '1 day'
                     where tenant_id in ${admin(mine)}`;
        await sweepHostnames(runtimeDb.db, {
          provider: fake,
          runId: `fair-cleanup-${run}`,
          onlyTenants: mine,
          tenantLimit: await everyTenant(),
        });
      }
    } finally {
      await runtimeDb?.end();
      await adminDb?.end();
      await runtime?.end();
      await admin?.end();
    }
  });

  it("reads the high-id tenant's hostname before the low-id tenant's sixth", async () => {
    const { hog, victim, victimHosts } = await pair("f1a", 12, 1);
    const { provider, read } = reads();
    const { report } = await sweep([hog, victim], provider);
    // Before Part D the low id drained its twelve first: the victim was read 13th.
    expect(read.indexOf(victimHosts[0] ?? "")).toBe(5);
    expect(read).toHaveLength(13);
    expect(new Set(read).size).toBe(13);
    expect(report.checked).toBe(13);
  });

  it("lists the victim ahead of the hog on the next run", async () => {
    const { hog, victim } = await pair("f1b", 12, 1);
    await sweep([hog, victim], reads().provider);
    await due(hog, victim);
    // Before Part D nothing wrote a hostname stamp, so id order stood: the hog first.
    expect(await listed([hog, victim])).toEqual([victim, hog]);
    // The hog was stamped again at its first extra turn, after the victim's stamp.
    expect(await stamps([hog, victim])).toEqual([victim, hog]);
  });

  it("gives the hog turns of up to five around the victim's one", async () => {
    const { hog, victim } = await pair("f1c", 12, 1);
    const { report, turns } = await sweep([hog, victim], reads().provider);
    expect(turns).toEqual([`${hog}@1`, `${victim}@1`, `${hog}@2`, `${hog}@3`]);
    expect(report).toMatchObject({ turns: 4, passes: 3 });
  });

  it.each([
    {
      stop: "throttle",
      key: "thr",
      fault: () => new HostnameProviderUnavailableError(429, 300),
      options: {},
      fields: { throttled: true, retryAfterSeconds: 300, providerFault: null, failedTenants: 0 },
    },
    {
      stop: "account fault",
      key: "flt",
      fault: () => new HostnameProviderRejectedError("http_401", undefined, 401),
      options: {},
      fields: { throttled: false, providerFault: "http_401", failedTenants: 1 },
    },
    {
      stop: "call limit",
      key: "cap",
      fault: null,
      options: { maxProviderCalls: 1 },
      fields: { throttled: false, providerFault: null, failedTenants: 0, checked: 1 },
    },
  ])(
    "keeps the place of a tenant reached after a $stop",
    async ({ key, fault, options, fields }) => {
      const hog = await tenant(`f2${key}-hog`, "low");
      const victim = await tenant(`f2${key}-victim`, "high");
      const hogHost = name(`f2${key}-hog`);
      const victimHost = name(`f2${key}-victim`);
      const endedHost = name(`f2${key}-ended`);
      await activeHost(hog, hogHost);
      await activeHost(victim, victimHost);
      await endedClaim(victim, endedHost);
      await due(hog, victim);
      const before = await checkRow(victimHost);
      const { provider, read } = reads(() => {
        if (fault) throw fault();
      });
      const { report, failures } = await sweep([hog, victim], provider, options);
      // The hog's reading moved its next check; the stops record nothing for it.
      if (key === "cap") await due(hog);
      // Before Part D nothing wrote a hostname stamp, so id order stood: the hog first.
      expect(await listed([hog, victim])).toEqual([victim, hog]);
      expect(read).toEqual([hogHost]);
      expect(await checkRow(endedHost)).toMatchObject({
        status: "disabled",
        last_error_code: "expired",
      });
      expect(await checkRow(victimHost)).toEqual(before);
      // Only the hog's turn could read the provider, so only the hog was stamped.
      expect(await stamps([hog, victim])).toEqual([hog]);
      expect(report).toMatchObject({ expiryOnlyTurns: 1, complete: false, expired: 1, ...fields });
      expect(failures).toEqual(key === "flt" ? [hog] : []);
    },
  );

  it("moves a tenant whose read always fails behind a tenant it has never served", async () => {
    const poison = await tenant("f3-poison", "low");
    const other = await tenant("f3-other", "high");
    await activeHost(poison, name("f3-poison"));
    await activeHost(other, name("f3-other"));
    await due(poison);
    const { provider } = reads(() => {
      throw new Error("poison");
    });
    const { report, failures } = await sweep([poison], provider);
    expect(report).toMatchObject({ failedTenants: 1, checked: 0, complete: false });
    expect(failures).toEqual([poison]);
    // Nothing was recorded for the poison row, so it is still due.
    await due(other);
    // Before Part D the lower id led every run while its read kept failing.
    expect(await listed([poison, other])).toEqual([other, poison]);
  });

  it("still serves a tenant at most perTenantLimit rows a run", async () => {
    const t = await tenant("f4-cap");
    for (const h of hosts("f4", 7)) await activeHost(t, h);
    await due(t);
    const { provider, read } = reads();
    const starts: number[] = [];
    const { report } = await sweep([t], provider, {
      perTenantLimit: 6,
      onTurnStart: () => starts.push(read.length),
    });
    expect(report).toMatchObject({ checked: 6, complete: false });
    const [left] = await admin<{ n: number }[]>`
      select count(*)::int as n from public.tenant_hostname_provisioning
       where tenant_id = ${t} and next_check_at <= now()`;
    expect(left?.n).toBe(1);
    // Turns of five and one (D-E1 A): the second started after five reads.
    expect(starts).toEqual([0, 5]);
    expect(report.turns).toBe(2);
  });

  it("starts nothing on a zero budget", async () => {
    const t = await tenant("f5-zero");
    await activeHost(t, name("f5-zero"));
    await due(t);
    const { provider, read } = reads();
    const { report } = await sweep([t], provider, { budgetMs: 0 });
    expect(read).toEqual([]);
    expect(report).toMatchObject({ tenants: 0, checked: 0, complete: false });
    expect(await stamps([t])).toEqual([]);
    expect(report).toMatchObject({ turns: 0, deferredTenants: 1 });
  });

  it("reports complete when both tenants finish inside every limit", async () => {
    const { hog, victim } = await pair("f6", 2, 1);
    const { provider, read } = reads();
    const { report } = await sweep([hog, victim], provider);
    expect(read).toHaveLength(3);
    expect(report).toMatchObject({ checked: 3, complete: true });
    expect(report).toMatchObject({
      turns: 2,
      passes: 1,
      deferredTenants: 0,
      stampFailures: 0,
      expiryOnlyTurns: 0,
      providerCalls: 3,
    });
  });

  it("expires ended claims in pass 2 after a throttle, and stamps no turn that cannot read", async () => {
    const hog = await tenant("f7-hog", "low");
    const victim = await tenant("f7-victim", "high");
    const hogHosts = hosts("f7-hog", 7);
    const ended = hosts("f7-ended", 6);
    const victimHost = name("f7-victim");
    for (const h of hogHosts) await activeHost(hog, h);
    await activeHost(victim, victimHost);
    for (const h of ended) await endedClaim(victim, h);
    await due(hog, victim);
    const before = await checkRow(victimHost);
    const { provider, read } = reads((host) => {
      if (host === hogHosts[5]) throw new HostnameProviderUnavailableError(429, 300);
    });
    const { report, turns } = await sweep([hog, victim], provider);
    // Five ended claims in the victim's first turn, the sixth in its second.
    expect(report.expired).toBe(6);
    for (const h of ended) {
      expect(await checkRow(h)).toMatchObject({ status: "disabled", last_error_code: "expired" });
    }
    expect(read).not.toContain(victimHost);
    expect(await checkRow(victimHost)).toEqual(before);
    // The hog was stamped again at pass 2, before its read was throttled; the
    // victim's pass-2 turn, expiry only, was not.
    expect(await stamps([hog, victim])).toEqual([victim, hog]);
    expect(turns).toEqual([`${hog}@1`, `${victim}@1`, `${hog}@2`, `${victim}@2`]);
    expect(report).toMatchObject({ expiryOnlyTurns: 1, throttled: true, complete: false });
  });

  it("stamps no tenant once the call limit is reached at the end of a turn", async () => {
    const { hog, victim, hogHosts } = await pair("f8", 6, 1);
    let mark = "";
    const { provider, read } = reads(async (host) => {
      // A database instant after the hog's pass-1 stamp and before any pass-2 stamp.
      if (host === hogHosts[4]) {
        const [row] = await admin<{ at: string }[]>`select clock_timestamp()::text as at`;
        mark = row?.at ?? "";
      }
    });
    const { report } = await sweep([hog, victim], provider, { maxProviderCalls: 5 });
    expect(report).toMatchObject({ checked: 5, complete: false });
    expect(read).toEqual(hogHosts.slice(0, 5));
    expect(await stamps([victim])).toEqual([]);
    const [hogStamp] = await admin<{ earlier: boolean }[]>`
      select last_turn_at < ${mark}::timestamptz as earlier from public.sweep_turns
       where tenant_id = ${hog} and sweep = 'hostname'`;
    // Stamped before its first turn, and not again at pass 2.
    expect(hogStamp?.earlier).toBe(true);
    expect(report).toMatchObject({ expiryOnlyTurns: 2, providerCalls: 5 });
  });

  it("starts no read once the budget runs out inside a turn", async () => {
    const first = await tenant("f9-first", "low");
    const second = await tenant("f9-second", "high");
    const rows = hosts("f9-first", 5);
    const secondHost = name("f9-second");
    for (const h of rows) await activeHost(first, h);
    await activeHost(second, secondHost);
    await due(first, second);
    const untouched = [rows[3] ?? "", rows[4] ?? "", secondHost];
    const before = await Promise.all(untouched.map(checkRow));
    // The clock passes the budget while the provider answers the third read.
    let now = 0;
    const { provider, read } = reads((host) => {
      if (host === rows[2]) now = 30_000;
    });
    const { report } = await sweep([first, second], provider, {
      budgetMs: 20_000,
      clock: () => now,
    });
    expect(read).toEqual(rows.slice(0, 3));
    expect(await Promise.all(untouched.map(checkRow))).toEqual(before);
    expect(report).toMatchObject({ tenants: 1, checked: 3, complete: false });

    // The next run, inside its budget, reads the two rows the first left.
    const next = reads();
    await sweep([first], next.provider);
    expect(next.read).toEqual(rows.slice(3));
    expect(report).toMatchObject({ turns: 1, deferredTenants: 1 });
  });

  it("serves the victim's first turn before the hog's account fault, and fails the hog once", async () => {
    const { hog, victim, hogHosts, victimHosts } = await pair("f10", 6, 6);
    const { provider, read } = reads((host) => {
      if (host === hogHosts[5]) throw new HostnameProviderRejectedError("http_401", undefined, 401);
    });
    const { report, turns, failures } = await sweep([hog, victim], provider);
    // Before Part D the hog drained first, faulted, and the victim read nothing.
    expect(read.filter((h) => victimHosts.includes(h))).toEqual(victimHosts.slice(0, 5));
    expect(report).toMatchObject({ failedTenants: 1, providerFault: "http_401" });
    expect(failures).toEqual([hog]);
    // The fault ended the hog's turns; the victim's second turn was expiry only.
    expect(turns).toEqual([`${hog}@1`, `${victim}@1`, `${hog}@2`, `${victim}@2`]);
    expect(report.expiryOnlyTurns).toBe(1);
    expect(read).not.toContain(victimHosts[5]);
    expect(await checkRow(victimHosts[5] ?? "")).toMatchObject({ status: "active", due: true });
  });

  it("reports incomplete when the unfiltered list fills the tenant limit", async () => {
    // Two due tenants of this file, so a list of one is full whatever else is
    // due. The unstamped low id sorts ahead of the high id, so the one listed
    // tenant is never the target: only the unfiltered count says more wait.
    const decoy = await tenant("f11-decoy", "low");
    const target = await tenant("f11-target", "high");
    await activeHost(decoy, name("f11-decoy"));
    await activeHost(target, name("f11-target"));
    await due(decoy, target);
    const { provider, read } = reads();
    const { report } = await sweep([target], provider, { tenantLimit: 1 });
    expect(read).toEqual([]);
    expect(report).toMatchObject({ tenants: 0, complete: false });
  });

  it.each([0, 1.5, 1001])(
    "refuses a turn of %s hostnames before it reads",
    async (turnHostnames) => {
      const { provider, read } = reads();
      await expect(
        sweepHostnames(runtimeDb.db, {
          provider,
          runId: `fair-${run}`,
          onlyTenants: [],
          turnHostnames,
        }),
      ).rejects.toThrow(RangeError);
      expect(read).toEqual([]);
    },
  );
});
