import { randomUUID } from "node:crypto";
import { createDb } from "@tidegrid/database";
import type {} from "@tidegrid/database/global-setup";
import {
  type CustomHostnameProvider,
  createFakeHostnameProvider,
  type FakeHostnameProvider,
  HostnameProviderUnavailableError,
  type ProviderHostname,
} from "@tidegrid/domain-hostnames";
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";
import { customHostnameRow, runCommand, UsageError } from "./commands.ts";
import { releaseInterruptedRequest } from "./release.ts";
import type { WorkerRoute, WorkersRoutesClient } from "./routes.ts";

const env = inject("integrationDb");

describe.skipIf(!env)("hostname CLI on a throwaway database", () => {
  let handle: ReturnType<typeof createDb>;
  const run = randomUUID().slice(0, 8);
  const slug = `cli-${run}`;
  const host = `book-${run}.example.com`;

  beforeAll(async () => {
    if (!env) return;
    handle = createDb(env.adminUrl, { max: 1 });
    await handle.sql`insert into public.tenants (id, slug, display_name)
      values (${randomUUID()}, ${slug}, 'CLI Tenant')`;
  });
  afterAll(async () => {
    await handle?.end();
  });

  it("runs the whole fake lifecycle in one process", async () => {
    const lines = await runCommand(
      handle.db,
      { kind: "fake-lifecycle", slug, hostname: host },
      { TIDEGRID_EPHEMERAL_DB: "1" },
    );
    expect(lines).toEqual([
      "request: requested",
      "resolves before validation: false",
      "activate before validation: not_ready",
      "activate after validation: activated",
      "resolves when active: true",
      "sweep after the CNAME moved: 1 demoted",
      "resolves after demotion: false",
      "disable: already disabled",
    ]);
    const status = await runCommand(handle.db, { kind: "status", slug }, {});
    expect(status).toEqual([`${host}  custom  disabled  hostname moved  certificate active`]);
  });

  it("refuses the fake outside a throwaway database and an unknown tenant", async () => {
    await expect(
      runCommand(handle.db, { kind: "fake-lifecycle", slug, hostname: `x-${host}` }, {}),
    ).rejects.toBeInstanceOf(UsageError);
    await expect(
      runCommand(handle.db, { kind: "status", slug: `nobody-${run}` }, {}),
    ).rejects.toBeInstanceOf(UsageError);
  });

  // W1-SAAS-PREP ------------------------------------------------------------------

  const fake = createFakeHostnameProvider({ idPrefix: `cli-${run}` });

  async function newTenant(label: string): Promise<string> {
    const tenantSlug = `cli-${label}-${run}`;
    await handle.sql`insert into public.tenants (id, slug, display_name)
      values (${randomUUID()}, ${tenantSlug}, ${`CLI ${label}`})`;
    return tenantSlug;
  }

  /** Request and activate through the commands, on the fake. */
  async function activeHost(tenantSlug: string, hostname: string) {
    const deps = { provider: fake };
    const requested = await runCommand(
      handle.db,
      { kind: "request", slug: tenantSlug, hostname },
      {},
      deps,
    );
    expect(requested[0]).toBe(`${hostname}: requested`);
    fake.advance(hostname, { hostnameState: "active", certificateState: "active" });
    const activated = await runCommand(
      handle.db,
      { kind: "activate", slug: tenantSlug, hostname },
      {},
      deps,
    );
    expect(activated).toEqual([`${hostname}: active`]);
  }

  /** An in-memory routes endpoint for one zone, with every call logged. */
  function routesStub(initial: Omit<WorkerRoute, "id">[] = []) {
    const routes: WorkerRoute[] = initial.map((r, i) => ({ ...r, id: `r${i}` }));
    const calls: string[] = [];
    const client: WorkersRoutesClient = {
      list: async () => {
        calls.push("list");
        return routes.map((r) => ({ ...r }));
      },
      create: async (pattern, script) => {
        calls.push(`create ${pattern} ${script}`);
        const route = { id: `r${routes.length}`, pattern, script };
        routes.push(route);
        return { ...route };
      },
      remove: async (id) => {
        calls.push(`remove ${id}`);
        routes.splice(
          routes.findIndex((r) => r.id === id),
          1,
        );
      },
    };
    return { client, calls, routes };
  }

  /** A routes client that fails the test if any call reaches it. */
  const noCalls: WorkersRoutesClient = {
    list: async () => {
      throw new Error("a dry run made a call");
    },
    create: async () => {
      throw new Error("a dry run made a call");
    },
    remove: async () => {
      throw new Error("a dry run made a call");
    },
  };

  it("routes an active custom hostname: a dry run by default, then --apply (W1-SAAS-PREP)", async () => {
    const tenantSlug = await newTenant("route");
    const hostname = `route-${run}.example.com`;
    await activeHost(tenantSlug, hostname);
    const route = (extra: { remove?: boolean; apply?: boolean }) => ({
      kind: "route" as const,
      slug: tenantSlug,
      hostname,
      remove: extra.remove ?? false,
      apply: extra.apply ?? false,
    });

    // A dry run needs no token and makes no call.
    const dry = await runCommand(handle.db, route({}), {}, { routes: noCalls });
    expect(dry[0]).toBe(`${hostname}: dry run, no call made`);
    expect(dry.join("\n")).toContain(`"pattern":"${hostname}/*","script":"tidegrid-guest"`);
    const dryRemove = await runCommand(handle.db, route({ remove: true }), {}, { routes: noCalls });
    expect(dryRemove.join("\n")).toContain("would delete");

    // --apply without a token or an injected client is refused before any call.
    await expect(runCommand(handle.db, route({ apply: true }), {})).rejects.toBeInstanceOf(
      UsageError,
    );

    const stub = routesStub([{ pattern: "*/*", script: "someone-else" }]);
    const env = { CF_SAAS_ROUTE_SCRIPT: "tidegrid-guest-preview" };
    expect(
      await runCommand(handle.db, route({ apply: true }), env, { routes: stub.client }),
    ).toEqual([`${hostname}: routed ${hostname}/* to tidegrid-guest-preview (route r1)`]);
    expect(
      (await runCommand(handle.db, route({ apply: true }), env, { routes: stub.client }))[0],
    ).toContain("already routed");
    expect(stub.calls).toEqual(["list", `create ${hostname}/* tidegrid-guest-preview`, "list"]);

    // After a disable, the route can still be removed; the wildcard stays.
    await runCommand(
      handle.db,
      { kind: "disable", slug: tenantSlug, hostname, reason: "Removal test" },
      {},
    );
    expect(
      await runCommand(handle.db, route({ apply: true }), env, { routes: stub.client }),
    ).toEqual([`${hostname}: refused: disabled, and only an active hostname is routed`]);
    expect(
      await runCommand(handle.db, route({ remove: true, apply: true }), env, {
        routes: stub.client,
      }),
    ).toEqual([`${hostname}: removed route r1`]);
    expect(stub.routes.map((r) => r.pattern)).toEqual(["*/*"]);
  });

  it("refuses a route for a pending name, another tenant's name, or a name nobody holds", async () => {
    const owner = await newTenant("route-owner");
    const other = await newTenant("route-other");
    const active = `owned-${run}.example.com`;
    await activeHost(owner, active);
    const pending = `pending-${run}.example.com`;
    await runCommand(
      handle.db,
      { kind: "request", slug: owner, hostname: pending },
      {},
      { provider: fake },
    );
    const cases: [string, string, string][] = [
      [owner, pending, `${pending}: refused: pending, and only an active hostname is routed`],
      [other, active, `${active}: refused: not a custom hostname of ${other}`],
      [
        owner,
        `nobody-${run}.example.com`,
        `nobody-${run}.example.com: refused: not a custom hostname of ${owner}`,
      ],
    ];
    for (const [tenantSlug, hostname, expected] of cases) {
      const lines = await runCommand(
        handle.db,
        { kind: "route", slug: tenantSlug, hostname, remove: false, apply: true },
        {},
        { routes: noCalls },
      );
      expect(lines).toEqual([expected]);
    }
    await expect(
      runCommand(
        handle.db,
        {
          kind: "route",
          slug: owner,
          hostname: "demo-harbor.book.tidegrid.us",
          remove: false,
          apply: false,
        },
        {},
        { routes: noCalls },
      ),
    ).rejects.toBeInstanceOf(UsageError);
  });

  /** The fake, with a create that acts and then loses the process before the id is stored. */
  function dyingAfterCreate(provider: FakeHostnameProvider): CustomHostnameProvider {
    return {
      name: provider.name,
      routingTarget: () => provider.routingTarget(),
      create: async (input) => {
        await provider.create(input);
        throw new Error("the process died after the provider acted");
      },
      get: (id, h) => provider.get(id, h),
      findByHostname: (h) => provider.findByHostname(h),
      refreshValidation: (id, h) => provider.refreshValidation(id, h),
      remove: (id) => provider.remove(id),
    };
  }

  async function storedId(hostname: string): Promise<string | null> {
    const [row] = await handle.sql<{ id: string | null }[]>`
      select provider_hostname_id as id from public.tenant_hostname_provisioning
       where hostname = ${hostname}`;
    return row?.id ?? null;
  }

  it("releases the record an interrupted request left, and resumes the request (W1-SAAS-PREP)", async () => {
    const tenantSlug = await newTenant("release");
    const hostname = `release-${run}.example.com`;
    const deps = { provider: fake };
    await expect(
      runCommand(
        handle.db,
        { kind: "request", slug: tenantSlug, hostname },
        {},
        {
          provider: dyingAfterCreate(fake),
        },
      ),
    ).rejects.toThrow("the process died");
    const orphan = (await fake.findByHostname(hostname))?.providerId ?? "";
    expect(orphan).not.toBe("");
    expect(await storedId(hostname)).toBeNull();
    // The documented dead end: request again is already_exists.
    expect(
      await runCommand(handle.db, { kind: "request", slug: tenantSlug, hostname }, {}, deps),
    ).toEqual([`${hostname}: already_exists`]);

    const release = (apply: boolean, providerId: string | null) => ({
      kind: "release" as const,
      slug: tenantSlug,
      hostname,
      apply,
      providerId,
    });
    const dry = await runCommand(handle.db, release(false, null), {}, deps);
    expect(dry[0]).toMatch(
      new RegExp(
        `^${hostname}: provider record ${orphan} \\(hostname pending, certificate pending\\); reserved at \\d{4}-`,
      ),
    );
    expect(dry.at(-1)).toBe(
      `  hostnames release ${tenantSlug} ${hostname} --apply --provider-id ${orphan}`,
    );
    expect((await fake.findByHostname(hostname))?.providerId).toBe(orphan);

    const wrong = await runCommand(handle.db, release(true, "fake-other"), {}, deps);
    expect(wrong.at(-1)).toContain(
      "refused: --provider-id fake-other does not name the record found",
    );
    expect((await fake.findByHostname(hostname))?.providerId).toBe(orphan);

    const applied = await runCommand(handle.db, release(true, orphan), {}, deps);
    expect(applied[1]).toBe(`deleted provider record ${orphan}`);
    expect(applied[2]).toBe(`${hostname}: requested`);
    expect(applied).toContain("Publish these records:");
    const fresh = await storedId(hostname);
    expect(fresh).not.toBeNull();
    expect(fresh).not.toBe(orphan);
    expect((await fake.findByHostname(hostname))?.providerId).toBe(fresh);
    const audits = await handle.sql<
      { action: string; after: { provider_hostname_id: string } | null }[]
    >`
      select action, after_state as after from public.audit_events
       where subject_type = 'tenant_hostname' and subject_id = ${hostname}
         and action = 'hostname.provider_released'`;
    expect(audits).toEqual([
      { action: "hostname.provider_released", after: { provider_hostname_id: orphan } },
    ]);

    // Nothing is interrupted any more, so release refuses.
    expect(await runCommand(handle.db, release(true, fresh), {}, deps)).toEqual([
      `${hostname}: nothing to release: its provider id is stored, so the request was not interrupted`,
    ]);
    expect((await fake.findByHostname(hostname))?.providerId).toBe(fresh);
  });

  it("resumes a request that never reached the provider, and refuses rows it must not touch", async () => {
    const tenantSlug = await newTenant("release-none");
    const other = await newTenant("release-other");
    const hostname = `release-none-${run}.example.com`;
    const deps = { provider: fake };
    await expect(
      runCommand(
        handle.db,
        { kind: "request", slug: tenantSlug, hostname },
        {},
        {
          provider: {
            ...dyingAfterCreate(fake),
            create: async () => {
              throw new Error("the process died before the provider acted");
            },
          },
        },
      ),
    ).rejects.toThrow("before the provider acted");
    const release = (slug: string, apply: boolean) => ({
      kind: "release" as const,
      slug,
      hostname,
      apply,
      providerId: null,
    });
    const dry = await runCommand(handle.db, release(tenantSlug, false), {}, deps);
    expect(dry[0]).toMatch(new RegExp(`^${hostname}: no provider record holds this name`));
    expect(dry[1]).toContain("dry run: nothing changed");
    expect(await storedId(hostname)).toBeNull();
    // Another tenant cannot release this tenant's reservation.
    expect(await runCommand(handle.db, release(other, true), {}, deps)).toEqual([
      `${hostname}: nothing to release: not a custom hostname of this tenant`,
    ]);
    const applied = await runCommand(handle.db, release(tenantSlug, true), {}, deps);
    expect(applied[1]).toBe(`${hostname}: requested`);
    expect(await storedId(hostname)).not.toBeNull();

    // A disabled name is never released.
    await runCommand(
      handle.db,
      { kind: "disable", slug: tenantSlug, hostname, reason: "Release test" },
      {},
    );
    expect(await runCommand(handle.db, release(tenantSlug, true), {}, deps)).toEqual([
      `${hostname}: nothing to release: disabled, not pending`,
    ]);
  });

  // W1-SAAS-PREP review fixes ------------------------------------------------------

  /** An interrupted request of a new tenant: the record exists, its id is not stored. */
  async function interrupted(label: string) {
    const tenantSlug = await newTenant(label);
    const hostname = `${label}-${run}.example.com`;
    await expect(
      runCommand(
        handle.db,
        { kind: "request", slug: tenantSlug, hostname },
        {},
        { provider: dyingAfterCreate(fake) },
      ),
    ).rejects.toThrow("the process died");
    const orphan = (await fake.findByHostname(hostname))?.providerId ?? "";
    expect(orphan).not.toBe("");
    const release = (apply: boolean, providerId: string | null) => ({
      kind: "release" as const,
      slug: tenantSlug,
      hostname,
      apply,
      providerId,
    });
    return { tenantSlug, hostname, orphan, release };
  }

  async function releaseAudits(hostname: string) {
    return handle.sql<{ action: string; after: { provider_hostname_id: string } | null }[]>`
      select action, after_state as after from public.audit_events
       where subject_type = 'tenant_hostname' and subject_id = ${hostname}
         and action like 'hostname.provider_release%'
       order by id`;
  }

  /** The fake, whose exact-name lookup after a delete misbehaves as `after` says. */
  function afterDelete(after: "throws" | "lags"): CustomHostnameProvider {
    let lastSeen: ProviderHostname | null = null;
    let removed = false;
    return {
      ...dyingAfterCreate(fake),
      create: (input) => fake.create(input),
      remove: async (id) => {
        await fake.remove(id);
        removed = true;
      },
      findByHostname: async (h) => {
        if (!removed) {
          lastSeen = await fake.findByHostname(h);
          return lastSeen;
        }
        removed = false;
        if (after === "throws") throw new HostnameProviderUnavailableError(null);
        // A lagging read still shows the deleted record once.
        return lastSeen;
      },
    };
  }

  it("audits the delete before the follow-up lookup, whatever that lookup does (review R2, S2)", async () => {
    for (const after of ["throws", "lags"] as const) {
      const { hostname, orphan, release } = await interrupted(`release-${after}`);
      const provider = afterDelete(after);
      if (after === "throws") {
        await expect(
          runCommand(handle.db, release(true, orphan), {}, { provider }),
        ).rejects.toBeInstanceOf(HostnameProviderUnavailableError);
      } else {
        const lines = await runCommand(handle.db, release(true, orphan), {}, { provider });
        expect(lines.at(-1)).toBe(
          "refused: a record still holds this name after the delete; nothing resumed",
        );
      }
      expect(await fake.findByHostname(hostname)).toBeNull();
      expect(await storedId(hostname)).toBeNull();
      expect(await releaseAudits(hostname)).toEqual([
        { action: "hostname.provider_release_started", after: { provider_hostname_id: orphan } },
        { action: "hostname.provider_released", after: { provider_hostname_id: orphan } },
      ]);
    }
  });

  it("never resumes a reservation whose seven-day claim has ended (review S1)", async () => {
    const { tenantSlug, hostname, orphan, release } = await interrupted("release-stale");
    // The claim is immutable; backdate it with triggers off, as an interruption
    // more than seven days old would leave it.
    await handle.sql.begin(async (tx) => {
      await tx`set local session_replication_role = replica`;
      await tx`update public.tenant_hostname_provisioning
                  set claim_expires_at = now() - interval '1 day'
                where hostname = ${hostname}`;
    });
    const deps = { provider: fake };
    const dry = await runCommand(handle.db, release(false, null), {}, deps);
    expect(dry[0]).toContain(`provider record ${orphan}`);
    expect(dry[0]).toContain("claim ended at");
    expect(dry.join("\n")).toContain("--apply deletes this record and does not resume");

    const applied = await runCommand(handle.db, release(true, orphan), {}, deps);
    expect(applied).toContain(`deleted provider record ${orphan}`);
    expect(applied.at(-2)).toMatch(/^not resumed: the seven-day claim ended at /);
    expect(applied).not.toContain(`${hostname}: requested`);
    expect(await fake.findByHostname(hostname)).toBeNull();
    expect(await storedId(hostname)).toBeNull();
    expect((await releaseAudits(hostname)).map((a) => a.action)).toEqual([
      "hostname.provider_release_started",
      "hostname.provider_released",
    ]);

    // With no record left, release still refuses to resume, dry run or not.
    for (const apply of [false, true]) {
      const lines = await runCommand(handle.db, release(apply, null), {}, deps);
      expect(lines[0]).toMatch(new RegExp(`^${hostname}: no provider record holds this name`));
      expect(lines.at(-2)).toMatch(/^not resumed: the seven-day claim ended at /);
    }
    expect(await storedId(hostname)).toBeNull();
    expect(await fake.findByHostname(hostname)).toBeNull();
    expect(await runCommand(handle.db, { kind: "status", slug: tenantSlug }, {})).toEqual([
      `${hostname}  custom  pending  hostname pending  certificate pending`,
    ]);
  });

  it("reads this tenant's rows inside a tenant transaction (review R3)", async () => {
    const owner = await newTenant("rls-owner");
    const active = `rls-${run}.example.com`;
    await activeHost(owner, active);
    const { hostname, orphan } = await interrupted("rls-release");
    const [owners] = await handle.sql<{ id: string }[]>`
      select id from public.tenants where slug = ${owner}`;
    const [releasers] = await handle.sql<{ id: string }[]>`
      select t.id from public.tenants t
        join public.tenant_hostnames h on h.tenant_id = t.id
       where h.hostname = ${hostname}`;
    // A role that does not bypass row-level security sees no tenant row
    // outside a tenant transaction.
    const restricted = createDb(env?.adminUrl ?? "", { max: 1 });
    try {
      await restricted.sql`set role tidegrid_app`;
      expect(await customHostnameRow(restricted.db, owners?.id ?? "", active)).toEqual({
        kind: "custom",
        status: "active",
      });
      const lines = await releaseInterruptedRequest(restricted.db, fake, {
        tenantId: releasers?.id ?? "",
        slug: "rls-release",
        hostname,
        apply: false,
        providerId: null,
        actor: { actorId: "hostname-cli", requestId: `cli-${randomUUID()}` },
      });
      expect(lines[0]).toContain(`provider record ${orphan}`);
    } finally {
      await restricted.end();
    }
  });
});
