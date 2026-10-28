import { randomUUID } from "node:crypto";
import { createDb } from "@tidegrid/database";
import type {} from "@tidegrid/database/global-setup";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";
import { createFakeHostnameProvider } from "./fake.ts";
import {
  activateCustomHostname,
  disableHostname,
  HostnameNameRefusedError,
  requestCustomHostname,
  sweepHostnames,
} from "./lifecycle.ts";

type Sql = ReturnType<typeof postgres>;

const env = inject("integrationDb");

async function pgError(p: Promise<unknown>): Promise<string> {
  try {
    await p;
  } catch (err) {
    return (err as { code?: string }).code ?? "no-code";
  }
  return "no-error";
}

/**
 * The custom hostname lifecycle of migration 0011 (G2.14b) against a real
 * PostgreSQL 17, with two tenants throughout, a suspended third, and the
 * scripted fake provider driven in this process. Custom names live under
 * example.com, which RFC 2606 reserves, so no operator domain appears.
 */
describe.skipIf(!env)("custom hostname lifecycle (0011)", () => {
  let admin: Sql;
  let runtime: Sql;
  let adminDb: ReturnType<typeof createDb>;
  let runtimeDb: ReturnType<typeof createDb>;
  const run = randomUUID().slice(0, 8);
  const A = { id: randomUUID(), slug: `hn-a-${run}` };
  const B = { id: randomUUID(), slug: `hn-b-${run}` };
  const C = { id: randomUUID(), slug: `hn-c-${run}` }; // suspended
  const actor = { actorId: "lifecycle-test", requestId: `test-${run}` };
  const name = (label: string) => `${label}-${run}.example.com`;
  // One provider for the whole suite, as one zone would be: a sweep reads
  // every due hostname, so each must be known to the provider it reads.
  const shared = createFakeHostnameProvider();

  /** One runtime transaction bound to `tenantId`, as inTenantTransaction would bind it. */
  function asTenant<T>(tenantId: string | null, fn: (tx: Sql) => Promise<T>): Promise<T> {
    return runtime.begin(async (tx) => {
      if (tenantId) {
        await tx`select set_config('app.tenant_id', ${tenantId}, true),
                        set_config('app.actor_type', 'system', true)`;
      }
      return fn(tx as unknown as Sql);
    }) as Promise<T>;
  }

  async function resolves(host: string): Promise<string | null> {
    const [row] = await runtime<{ tenant_id: string }[]>`
      select tenant_id from app.resolve_hostname(${host})`;
    return row?.tenant_id ?? null;
  }

  async function state(host: string) {
    const [row] = await admin<
      {
        status: string;
        kind: string;
        verified: boolean;
        hostname_state: string | null;
        certificate_state: string | null;
        provider_hostname_id: string | null;
        last_error_code: string | null;
      }[]
    >`
      select h.status, h.kind, h.verified_at is not null as verified, p.hostname_state,
             p.certificate_state, p.provider_hostname_id, p.last_error_code
        from public.tenant_hostnames h
        left join public.tenant_hostname_provisioning p
          on p.hostname = h.hostname and p.tenant_id = h.tenant_id
       where h.hostname = ${host}`;
    return row;
  }

  async function audits(tenantId: string, host: string): Promise<string[]> {
    const rows = await admin<{ action: string }[]>`
      select action from public.audit_events
       where tenant_id = ${tenantId} and subject_type = 'tenant_hostname' and subject_id = ${host}
       order by id`;
    return rows.map((r) => r.action);
  }

  /** Make every check of this tenant's hostnames due now. */
  async function due(tenantId: string) {
    await admin`update public.tenant_hostname_provisioning
                   set next_check_at = now() - interval '1 second'
                 where tenant_id = ${tenantId}`;
  }

  /** Request, then activate once the fake reports both states active. */
  async function activeHost(
    provider: ReturnType<typeof createFakeHostnameProvider>,
    tenantId: string,
    host: string,
  ) {
    const requested = await requestCustomHostname(adminDb.db, provider, {
      tenantId,
      hostname: host,
      actor,
    });
    expect(requested.kind).toBe("requested");
    provider.advance(host, { hostnameState: "active", certificateState: "active" });
    const activated = await activateCustomHostname(adminDb.db, provider, {
      tenantId,
      hostname: host,
      actor,
    });
    expect(activated.kind).toBe("activated");
  }

  beforeAll(async () => {
    if (!env) return;
    admin = postgres(env.adminUrl, { max: 2, onnotice: () => {} });
    runtime = postgres(env.runtimeUrl, { max: 2, onnotice: () => {} });
    adminDb = createDb(env.adminUrl, { max: 2 });
    runtimeDb = createDb(env.runtimeUrl, { max: 2 });
    await admin`insert into public.tenants (id, slug, display_name, status) values
      (${A.id}, ${A.slug}, 'Hostname Tenant A', 'active'),
      (${B.id}, ${B.slug}, 'Hostname Tenant B', 'active'),
      (${C.id}, ${C.slug}, 'Hostname Tenant C', 'suspended')`;
  });

  afterAll(async () => {
    await runtimeDb?.end();
    await adminDb?.end();
    await runtime?.end();
    await admin?.end();
  });

  it("requests, records, activates, and resolves only after both provider states are active", async () => {
    const provider = shared;
    const host = name("book-a");
    const requested = await requestCustomHostname(adminDb.db, provider, {
      tenantId: A.id,
      hostname: host,
      actor,
    });
    expect(requested).toMatchObject({ kind: "requested", adopted: false });
    expect(await state(host)).toMatchObject({
      status: "pending",
      kind: "custom",
      verified: false,
      hostname_state: "pending",
      certificate_state: "pending",
    });
    expect(await resolves(host)).toBeNull();
    // The instructions are public DNS targets, stored with the record.
    const [stored] = await admin<{ instructions: { kind: string; name?: string }[] }[]>`
      select instructions from public.tenant_hostname_provisioning where hostname = ${host}`;
    expect(stored?.instructions.map((i) => i.kind)).toContain("cname");
    expect(stored?.instructions).toContainEqual(
      expect.objectContaining({ kind: "txt", name: `_cf-custom-hostname.${host}` }),
    );

    // An active hostname with a pending certificate does not activate.
    provider.advance(host, { hostnameState: "active", certificateState: "pending" });
    expect(
      (
        await activateCustomHostname(adminDb.db, provider, {
          tenantId: A.id,
          hostname: host,
          actor,
        })
      ).kind,
    ).toBe("not_ready");

    // The runtime records checks; a reading of both active never promotes.
    provider.advance(host, { hostnameState: "active", certificateState: "active" });
    await due(A.id);
    const report = await sweepHostnames(runtimeDb.db, { provider, runId: `sweep-${run}` });
    expect(report.checked).toBeGreaterThanOrEqual(1);
    expect(await state(host)).toMatchObject({
      status: "pending",
      hostname_state: "active",
      certificate_state: "active",
    });
    expect(await resolves(host)).toBeNull();

    const activated = await activateCustomHostname(adminDb.db, provider, {
      tenantId: A.id,
      hostname: host,
      actor,
    });
    expect(activated.kind).toBe("activated");
    expect(await state(host)).toMatchObject({ status: "active", verified: true });
    expect(await resolves(host)).toBe(A.id);
    expect(await audits(A.id, host)).toEqual([
      "hostname.requested",
      "hostname.provider_attached",
      "hostname.activated",
    ]);
  });

  it("demotes an active hostname the provider reports moved, and resolution fails closed", async () => {
    const provider = shared;
    const host = name("moved-a");
    await activeHost(provider, A.id, host);
    // Not due yet: an active row is rechecked hourly.
    const [before] = await runtime<{ n: number }[]>`
      select count(*)::int as n from app.hostname_sweep_tenants(1000) where tenant_id = ${A.id}`;
    provider.advance(host, { hostnameState: "moved" });
    await due(A.id);
    const [selected] = await runtime<{ n: number }[]>`
      select count(*)::int as n from app.hostname_sweep_tenants(1000) where tenant_id = ${A.id}`;
    expect(selected?.n).toBe(1);
    expect(before?.n).toBeLessThanOrEqual(1);
    const report = await sweepHostnames(runtimeDb.db, { provider, runId: `sweep-${run}` });
    expect(report.demoted).toBeGreaterThanOrEqual(1);
    expect(await state(host)).toMatchObject({ status: "disabled", hostname_state: "moved" });
    expect(await resolves(host)).toBeNull();
    expect((await audits(A.id, host)).at(-1)).toBe("hostname.demoted");
  });

  it("demotes on a failed certificate, a deleted record, or a record that names another host", async () => {
    const provider = shared;
    const failed = name("cert-a");
    const gone = name("gone-a");
    await activeHost(provider, B.id, failed);
    await activeHost(provider, B.id, gone);
    provider.advance(failed, { certificateState: "failed" });
    const goneId = provider.records().find((r) => r.hostname === gone)?.providerId;
    if (!goneId) throw new Error("setup: no record");
    await provider.remove(goneId);
    await due(B.id);
    await sweepHostnames(runtimeDb.db, { provider, runId: `sweep-${run}` });
    expect(await state(failed)).toMatchObject({ status: "disabled", certificate_state: "failed" });
    expect(await state(gone)).toMatchObject({
      status: "disabled",
      hostname_state: "deleted",
      last_error_code: "provider_record_missing",
    });
    expect(await resolves(failed)).toBeNull();
    expect(await resolves(gone)).toBeNull();
  });

  it("keeps a hostname whose certificate is expiring servable, and reports it", async () => {
    const provider = shared;
    const host = name("expiring-b");
    await activeHost(provider, B.id, host);
    provider.advance(host, { certificateState: "expiring" });
    await due(B.id);
    const expiring: string[] = [];
    await sweepHostnames(runtimeDb.db, {
      provider,
      runId: `sweep-${run}`,
      onExpiring: (_tenant, h) => expiring.push(h),
    });
    expect(expiring).toContain(host);
    expect(await state(host)).toMatchObject({ status: "active", certificate_state: "expiring" });
    expect(await resolves(host)).toBe(B.id);
  });

  it("fails closed at once when an admin disables a hostname", async () => {
    const provider = shared;
    const host = name("disable-a");
    await activeHost(provider, A.id, host);
    expect(await resolves(host)).toBe(A.id);
    expect(
      await disableHostname(adminDb.db, {
        tenantId: A.id,
        hostname: host,
        reason: "Operator left the demo",
        actor,
      }),
    ).toBe(true);
    expect(await resolves(host)).toBeNull();
    expect(
      await disableHostname(adminDb.db, { tenantId: A.id, hostname: host, reason: "again", actor }),
    ).toBe(false);
    expect((await audits(A.id, host)).filter((a) => a === "hostname.disabled")).toHaveLength(1);
    // Disabled reserves the name: it never moves again, even for the owner role.
    expect(
      await pgError(
        admin`update public.tenant_hostnames set status = 'pending' where hostname = ${host}`,
      ),
    ).toBe("23514");
  });

  it("expires a pending claim that ran out", async () => {
    const host = name("claim-a");
    // A reservation whose seven days have passed, written by the admin role
    // directly because no function backdates a claim.
    await admin.begin(async (tx) => {
      await tx`insert into public.tenant_hostnames (hostname, tenant_id, kind, status)
        values (${host}, ${A.id}, 'custom', 'pending')`;
      await tx`insert into public.tenant_hostname_provisioning
          (tenant_id, hostname, provider, claim_expires_at)
        values (${A.id}, ${host}, 'fake', now() - interval '1 minute')`;
    });
    const provider = shared;
    provider.plantRecord(host);
    const providerId = provider.records().find((r) => r.hostname === host)?.providerId;
    await admin`select app.hostname_attach_provider(${A.id}::uuid, ${host}, ${providerId ?? null}, '[]'::jsonb)`;
    const [listed] = await runtime<{ n: number }[]>`
      select count(*)::int as n from app.hostname_sweep_tenants(1000) where tenant_id = ${A.id}`;
    expect(listed?.n).toBe(1);
    const report = await sweepHostnames(runtimeDb.db, { provider, runId: `sweep-${run}` });
    expect(report.expired).toBeGreaterThanOrEqual(1);
    expect(await state(host)).toMatchObject({ status: "disabled", last_error_code: "expired" });
    expect((await audits(A.id, host)).at(-1)).toBe("hostname.expired");
  });

  it("refuses a name another tenant holds, in any status", async () => {
    const provider = shared;
    const pendingHost = name("held-pending");
    const activeHostName = name("held-active");
    const disabledHost = name("held-disabled");
    await requestCustomHostname(adminDb.db, provider, {
      tenantId: A.id,
      hostname: pendingHost,
      actor,
    });
    await activeHost(provider, A.id, activeHostName);
    await activeHost(provider, A.id, disabledHost);
    await disableHostname(adminDb.db, {
      tenantId: A.id,
      hostname: disabledHost,
      reason: "test",
      actor,
    });
    const previewHost = `${A.slug}.book.example.test`;
    await admin`insert into public.tenant_hostnames (hostname, tenant_id, kind, status, verified_at)
      values (${previewHost}, ${A.id}, 'preview', 'active', now())`;
    for (const host of [pendingHost, activeHostName, disabledHost]) {
      const code = await pgError(
        requestCustomHostname(adminDb.db, createFakeHostnameProvider(), {
          tenantId: B.id,
          hostname: host,
          actor,
        }),
      );
      expect({ host, code }).toEqual({ host, code: "23505" });
      expect(await resolves(host)).not.toBe(B.id);
    }
    // The database refuses it directly too, preview names included.
    for (const host of [pendingHost, activeHostName, disabledHost, previewHost]) {
      expect(
        await pgError(admin`select app.hostname_request(${B.id}::uuid, ${host}, 'fake')`),
      ).not.toBe("no-error");
    }
  });

  it("refuses the name rules in the service and in the database", async () => {
    const provider = createFakeHostnameProvider();
    for (const bad of [
      "harbor.com",
      `x-${run}.tidegrid.us`,
      `x-${run}.book.tidegrid.us`,
      `x-${run}.shop.workers.dev`,
      `x-${run}.shop.test`,
      `x-${run}.shop.localhost`,
      `x-${run}.xn--bcher-kva.com`,
      `X-${run}.example.com`,
    ]) {
      await expect(
        requestCustomHostname(adminDb.db, provider, { tenantId: A.id, hostname: bad, actor }),
      ).rejects.toBeInstanceOf(HostnameNameRefusedError);
      expect({
        bad,
        code: await pgError(admin`select app.hostname_request(${A.id}::uuid, ${bad}, 'fake')`),
      }).toEqual({ bad, code: "23514" });
    }
    // Label boundaries: a name that merely contains a refused suffix is fine.
    expect(
      await pgError(
        admin`select app.hostname_request(${A.id}::uuid, ${`book-${run}.eviltidegrid.us`}, 'fake')`,
      ),
    ).toBe("no-error");
    // A suspended tenant cannot request one.
    expect(
      await pgError(
        admin`select app.hostname_request(${C.id}::uuid, ${name("suspended")}, 'fake')`,
      ),
    ).toBe("23503");
    expect(provider.calls).toEqual([]);
  });

  it("refuses activation without both states active, on a provider id mismatch, on a preview row, and from the runtime", async () => {
    const provider = shared;
    const host = name("activate-b");
    await requestCustomHostname(adminDb.db, provider, { tenantId: B.id, hostname: host, actor });
    const providerId = (await state(host))?.provider_hostname_id;
    if (!providerId) throw new Error("setup: no provider id");
    for (const [hostnameState, certificateState] of [
      ["active", "pending"],
      ["pending", "active"],
      ["active", "expiring"],
      ["moved", "active"],
    ] as const) {
      expect(
        await pgError(
          admin`select app.hostname_activate(${B.id}::uuid, ${host}, ${providerId}, ${hostnameState}, ${certificateState})`,
        ),
      ).toBe("23514");
    }
    expect(
      await pgError(
        admin`select app.hostname_activate(${B.id}::uuid, ${host}, 'fake-ch-9999', 'active', 'active')`,
      ),
    ).toBe("23514");
    // The other tenant's id for the same name does not reach it.
    expect(
      await pgError(
        admin`select app.hostname_activate(${A.id}::uuid, ${host}, ${providerId}, 'active', 'active')`,
      ),
    ).toBe("23514");
    const preview = `${B.slug}.book.example.test`;
    await admin`insert into public.tenant_hostnames (hostname, tenant_id, kind, status)
      values (${preview}, ${B.id}, 'preview', 'pending')`;
    expect(
      await pgError(
        admin`select app.hostname_activate(${B.id}::uuid, ${preview}, ${providerId}, 'active', 'active')`,
      ),
    ).toBe("23514");
    // The owner role cannot skip the function: a direct update is refused
    // while the provisioning row's states are not both active.
    expect(
      await pgError(
        admin`update public.tenant_hostnames set status = 'active', verified_at = now() where hostname = ${host}`,
      ),
    ).toBe("23514");
    // The runtime holds no EXECUTE on any admin function.
    for (const call of [
      (tx: Sql) =>
        tx`select app.hostname_activate(${B.id}::uuid, ${host}, ${providerId}, 'active', 'active')`,
      (tx: Sql) => tx`select app.hostname_request(${B.id}::uuid, ${name("rt")}, 'fake')`,
      (tx: Sql) =>
        tx`select app.hostname_attach_provider(${B.id}::uuid, ${host}, 'x', '[]'::jsonb)`,
      (tx: Sql) => tx`select app.hostname_disable(${B.id}::uuid, ${host}, 'x')`,
    ]) {
      expect(await pgError(asTenant(B.id, call))).toBe("42501");
    }
    expect(await state(host)).toMatchObject({ status: "pending" });
  });

  it("refuses a recorded check for another tenant, a mismatched provider id, or no context", async () => {
    const provider = shared;
    const host = name("check-a");
    await activeHost(provider, A.id, host);
    const providerId = (await state(host))?.provider_hostname_id;
    const record = (tx: Sql, tenant: string, id: string | null | undefined) =>
      tx`select app.hostname_record_check(${tenant}::uuid, ${host}, ${id ?? null}, 'moved', 'failed', null)`;
    // B's transaction naming A, A's transaction naming B, and no tenant at all.
    expect(await pgError(asTenant(B.id, (tx) => record(tx, A.id, providerId)))).toBe("42501");
    expect(await pgError(asTenant(A.id, (tx) => record(tx, B.id, providerId)))).toBe("42501");
    expect(await pgError(asTenant(null, (tx) => record(tx, A.id, providerId)))).toBe("42501");
    expect(await pgError(asTenant(A.id, (tx) => record(tx, A.id, "fake-ch-9999")))).toBe("42501");
    expect(await pgError(asTenant(A.id, (tx) => record(tx, A.id, null)))).toBe("42501");
    expect(await state(host)).toMatchObject({ status: "active", hostname_state: "active" });
    expect(await resolves(host)).toBe(A.id);
  });

  it("adopts a record after a lost create answer, and never a near-match or a foreign record", async () => {
    const provider = shared;
    const lost = name("lost-a");
    provider.loseNextAnswer();
    const adopted = await requestCustomHostname(adminDb.db, provider, {
      tenantId: A.id,
      hostname: lost,
      actor,
    });
    expect(adopted).toMatchObject({ kind: "requested", adopted: true });
    expect((await audits(A.id, lost)).includes("hostname.provider_adopted")).toBe(true);
    expect((await state(lost))?.provider_hostname_id).toBe(
      provider.records().find((r) => r.hostname === lost)?.providerId,
    );

    // A foreign record of the same name: refused, and no id is stored.
    const foreign = name("foreign-b");
    provider.plantRecord(foreign, { foreign: true });
    const refused = await requestCustomHostname(adminDb.db, provider, {
      tenantId: B.id,
      hostname: foreign,
      actor,
    });
    expect(refused.kind).toBe("already_exists");
    expect((await state(foreign))?.provider_hostname_id).toBeNull();

    // A lost answer with only a near-match in the zone: nothing adopted.
    const near = name("near-b");
    provider.plantRecord(`shop.${near}`, { foreign: true });
    provider.timeoutNext();
    const unavailable = await requestCustomHostname(adminDb.db, provider, {
      tenantId: B.id,
      hostname: near,
      actor,
    });
    expect(unavailable.kind).toBe("provider_unavailable");
    expect((await state(near))?.provider_hostname_id).toBeNull();
    // Running the request again resumes the reservation.
    const resumed = await requestCustomHostname(adminDb.db, provider, {
      tenantId: B.id,
      hostname: near,
      actor,
    });
    expect(resumed).toMatchObject({ kind: "requested", adopted: false });
  });

  it("stops the sweep on a provider 429 storm and stays within its call budget", async () => {
    const provider = shared;
    const hosts = [name("storm-1"), name("storm-2"), name("storm-3")];
    for (const h of hosts) await activeHost(provider, B.id, h);
    await due(B.id);
    provider.failNext({ status: 429, retryAfterSeconds: 300 });
    const before = provider.calls.length;
    const report = await sweepHostnames(runtimeDb.db, { provider, runId: `sweep-${run}` });
    expect(report).toMatchObject({ throttled: true, retryAfterSeconds: 300, complete: false });
    // The failed call is the only one this run made to the provider.
    expect(provider.calls.length - before).toBeLessThanOrEqual(1);
    for (const h of hosts) expect(await state(h)).toMatchObject({ status: "active" });

    const capped = await sweepHostnames(runtimeDb.db, {
      provider,
      runId: `sweep-${run}`,
      maxProviderCalls: 1,
    });
    expect(capped.checked).toBe(1);
    expect(capped.complete).toBe(false);
  });

  it("guards the tables for every role", async () => {
    const provider = shared;
    const host = name("guard-a");
    await requestCustomHostname(adminDb.db, provider, { tenantId: A.id, hostname: host, actor });
    for (const change of [
      admin`update public.tenant_hostnames set tenant_id = ${B.id} where hostname = ${host}`,
      admin`update public.tenant_hostnames set kind = 'preview' where hostname = ${host}`,
      admin`update public.tenant_hostnames set verified_at = now() where hostname = ${host}`,
      admin`update public.tenant_hostname_provisioning set provider = 'cloudflare_saas' where hostname = ${host}`,
      admin`update public.tenant_hostname_provisioning set claim_expires_at = now() where hostname = ${host}`,
      admin`update public.tenant_hostname_provisioning set provider_hostname_id = 'other' where hostname = ${host}`,
    ]) {
      expect(await pgError(change)).toBe("23514");
    }
    // A hostname with provisioning cannot be renamed either: the key refuses it.
    expect(
      await pgError(
        admin`update public.tenant_hostnames set hostname = ${name("renamed")} where hostname = ${host}`,
      ),
    ).not.toBe("no-error");
    // No role deletes or truncates provisioning, the owner included.
    expect(
      await pgError(
        admin`delete from public.tenant_hostname_provisioning where hostname = ${host}`,
      ),
    ).toBe("55000");
    expect(await pgError(admin`truncate public.tenant_hostname_provisioning`)).toBe("55000");
    // The runtime writes neither table directly.
    expect(
      await pgError(
        asTenant(
          A.id,
          (
            tx,
          ) => tx`insert into public.tenant_hostname_provisioning (tenant_id, hostname, provider, claim_expires_at)
            values (${A.id}, ${name("rt-insert")}, 'fake', now())`,
        ),
      ),
    ).toBe("42501");
    expect(
      await pgError(
        asTenant(
          A.id,
          (tx) =>
            tx`update public.tenant_hostnames set status = 'disabled' where hostname = ${host}`,
        ),
      ),
    ).toBe("42501");
    expect(
      await pgError(
        asTenant(
          A.id,
          (tx) =>
            tx`update public.tenant_hostname_provisioning set hostname_state = 'active' where hostname = ${host}`,
        ),
      ),
    ).toBe("42501");
    // Provisioning attaches only to a pending custom hostname of the same tenant.
    const preview = `${A.slug}-p.book.example.test`;
    await admin`insert into public.tenant_hostnames (hostname, tenant_id, kind, status, verified_at)
      values (${preview}, ${A.id}, 'preview', 'active', now())`;
    expect(
      await pgError(
        admin`insert into public.tenant_hostname_provisioning (tenant_id, hostname, provider, claim_expires_at)
          values (${A.id}, ${preview}, 'fake', now() + interval '1 day')`,
      ),
    ).toBe("23514");
  });

  it("admits the platform kind for its allowlist only", async () => {
    // Rolled back, so demo.tidegrid.us maps to no test tenant afterwards.
    const allowed = await pgError(
      admin.begin(async (tx) => {
        await tx`insert into public.tenant_hostnames (hostname, tenant_id, kind, status, verified_at)
          values ('demo.tidegrid.us', ${A.id}, 'platform', 'active', now())
          on conflict (hostname) do nothing`;
        throw Object.assign(new Error("rollback"), { code: "rollback" });
      }),
    );
    expect(allowed).toBe("rollback");
    expect(
      await pgError(
        admin`insert into public.tenant_hostnames (hostname, tenant_id, kind, status, verified_at)
          values (${`other-${run}.tidegrid.us`}, ${A.id}, 'platform', 'active', now())`,
      ),
    ).toBe("23514");
  });

  it("refuses injection-shaped hostnames in every new function", async () => {
    const shapes = [
      "'; drop table public.tenant_hostnames; --",
      "a.example.com' or '1'='1",
      "a.example.com\u0000",
      "%",
      "_",
      "",
    ];
    for (const s of shapes) {
      expect(
        await pgError(admin`select app.hostname_request(${A.id}::uuid, ${s}, 'fake')`),
      ).not.toBe("no-error");
      expect(
        await pgError(
          admin`select app.hostname_attach_provider(${A.id}::uuid, ${s}, 'x', '[]'::jsonb)`,
        ),
      ).not.toBe("no-error");
      expect(
        await pgError(
          admin`select app.hostname_activate(${A.id}::uuid, ${s}, 'x', 'active', 'active')`,
        ),
      ).not.toBe("no-error");
      expect(await pgError(admin`select app.hostname_disable(${A.id}::uuid, ${s}, 'x')`)).not.toBe(
        "no-error",
      );
      expect(
        await pgError(
          asTenant(
            A.id,
            (tx) =>
              tx`select app.hostname_record_check(${A.id}::uuid, ${s}, 'x', 'active', 'active', null)`,
          ),
        ),
      ).not.toBe("no-error");
    }
    const [tables] = await admin<{ n: number }[]>`
      select count(*)::int as n from pg_class where relname = 'tenant_hostnames'`;
    expect(tables?.n).toBe(1);
    // The limit is clamped, never trusted.
    const rows = await runtime`select * from app.hostname_sweep_tenants(-5)`;
    expect(rows.length).toBeLessThanOrEqual(1);
    const many = await runtime`select * from app.hostname_sweep_tenants(1000000)`;
    expect(many.length).toBeLessThanOrEqual(1000);
  });
});
