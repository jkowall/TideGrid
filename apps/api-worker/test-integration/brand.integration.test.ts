import { randomUUID } from "node:crypto";
import { BrandConfig, type PublicExperienceResponse } from "@tidegrid/contracts";
import type {} from "@tidegrid/database/global-setup";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";
import { createApp } from "../src/app.ts";

type Sql = ReturnType<typeof postgres>;
type Json = Record<string, unknown> & {
  error?: { code: string; message: string; requestId: string };
};

const env = inject("integrationDb");

async function pgError(p: Promise<unknown>): Promise<string> {
  try {
    await p;
  } catch (err) {
    return (err as { code?: string }).code ?? "no-code";
  }
  return "no-error";
}

const svg = (fill: string) =>
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64" width="64" height="64"><title>Fixture</title><circle cx="32" cy="32" r="30" fill="${fill}"/></svg>`;
const dataUri = (text: string) =>
  `data:image/svg+xml;base64,${Buffer.from(text).toString("base64")}`;

function brand(label: string, primary: string, accent: string, display: string, body: string) {
  return BrandConfig.parse({
    name: `Fixture ${label}`,
    tagline: `Synthetic trips for ${label}`,
    colors: { primary, accent },
    fonts: { display, body },
    logo: {
      src: dataUri(svg(primary)),
      kind: "mark",
      alt: `Fixture ${label}`,
      width: 64,
      height: 64,
    },
    contact: { email: `hello@${label.toLowerCase()}.test`, phone: "+13055550100" },
    legal: { terms: "/legal/terms", privacy: `https://${label.toLowerCase()}.test/privacy` },
    locale: "en-US",
    capabilities: [],
  });
}

describe.skipIf(!env)("public brand bootstrap against a real database as the runtime role", () => {
  let admin: Sql;
  let runtime: Sql;
  let app: ReturnType<typeof createApp>;
  const run = randomUUID().slice(0, 8);
  const tenant = (label: string, status = "active") => ({
    id: randomUUID(),
    slug: `brand-${label}-${run}`,
    name: `Brand ${label.toUpperCase()} ${run}`,
    status,
  });
  const A = tenant("a");
  const B = tenant("b");
  const C = tenant("c", "suspended");
  const D = tenant("d"); // verified hostname, never published a brand
  const E = tenant("e"); // stored brand no longer passes the contract
  const F = tenant("f"); // stored brand carries its own version key
  const G = { ...tenant("g"), name: `Brand G ‮${run}` }; // name fails the identity contract
  const host = (t: { slug: string }) => `${t.slug}.book.example.test`;
  const hosts = {
    aPending: `pending-${run}.example.test`,
    bDisabled: `disabled-${run}.example.test`,
    unknown: `nope-${run}.example.test`,
  };
  const brandA = brand("Harbor", "#0b3c5d", "#e0a526", "fraunces", "source-sans-3");
  const brandA2 = brand("Harbor", "#1b4332", "#f4a261", "sora", "inter");
  const brandB = brand(
    "Reef",
    "#006d77",
    "#ffd166",
    "bricolage-grotesque",
    "atkinson-hyperlegible-next",
  );

  const pending: Promise<unknown>[] = [];
  const executionCtx = {
    waitUntil: (p: Promise<unknown>) => void pending.push(p),
    passThroughOnException: () => {},
    props: {},
  };

  async function bootstrap(origin: string | null) {
    const headers = new Headers();
    if (origin) headers.set("origin", origin);
    const res = await app.request(
      "http://localhost/v1/public/tenant",
      { headers },
      {
        ENVIRONMENT: "local" as const,
        BUILD_ID: "integration",
        DATABASE_URL: env?.runtimeUrl ?? "",
        ALLOWED_ORIGINS: `https://${host(A)},https://${host(B)}`,
      },
      executionCtx,
    );
    await Promise.allSettled(pending.splice(0));
    const text = await res.text();
    return { res, text, json: (text ? JSON.parse(text) : {}) as Json };
  }

  /** Publish as the runtime role inside the tenant's transaction, as a staff command would. */
  async function publish(tenantId: string, config: BrandConfig, reason: string): Promise<number> {
    return (await runtime.begin(async (tx) => {
      await tx`select set_config('app.tenant_id', ${tenantId}, true),
                      set_config('app.actor_type', 'system', true),
                      set_config('app.actor_id', 'brand-integration-test', true)`;
      const [row] = await tx<{ version: number }[]>`
        insert into public.brand_config_versions (tenant_id, version, schema_version, config)
        select ${tenantId}, coalesce(max(version), 0) + 1, 1, ${tx.json(config as never)}
          from public.brand_config_versions where tenant_id = ${tenantId}
        returning version`;
      await tx`insert into public.brand_activations (tenant_id, version, reason)
        values (${tenantId}, ${row?.version ?? 0}, ${reason})`;
      return row?.version ?? 0;
    })) as number;
  }

  async function activate(tenantId: string, version: number, reason: string) {
    await runtime.begin(async (tx) => {
      await tx`select set_config('app.tenant_id', ${tenantId}, true)`;
      await tx`insert into public.brand_activations (tenant_id, version, reason)
        values (${tenantId}, ${version}, ${reason})`;
    });
  }

  function asTenant<T>(tenantId: string | null, fn: (tx: Sql) => Promise<T>): Promise<T> {
    return runtime.begin(async (tx) => {
      if (tenantId) await tx`select set_config('app.tenant_id', ${tenantId}, true)`;
      return fn(tx as unknown as Sql);
    }) as Promise<T>;
  }

  beforeAll(async () => {
    if (!env) return;
    admin = postgres(env.adminUrl, { max: 2, onnotice: () => {} });
    runtime = postgres(env.runtimeUrl, { max: 4, onnotice: () => {} });
    app = createApp();
    for (const t of [A, B, C, D, E, F, G]) {
      await admin`insert into public.tenants (id, slug, display_name, status)
        values (${t.id}, ${t.slug}, ${t.name}, ${t.status})`;
      await admin`insert into public.tenant_hostnames (hostname, tenant_id, kind, status, verified_at)
        values (${host(t)}, ${t.id}, 'preview', 'active', now())`;
    }
    await admin`insert into public.tenant_hostnames (hostname, tenant_id, kind, status, verified_at) values
      (${hosts.aPending}, ${A.id}, 'custom', 'pending', null),
      (${hosts.bDisabled}, ${B.id}, 'custom', 'disabled', now())`;
    await publish(A.id, brandA, "fixture brand");
    await publish(B.id, brandB, "fixture brand");
    // A suspended tenant keeps its brand, which must still never be served.
    await admin`insert into public.brand_config_versions (tenant_id, version, schema_version, config)
      values (${C.id}, 1, 1, ${admin.json(brand("Gone", "#3d405b", "#f2cc8f", "sora", "inter") as never)})`;
    await admin`insert into public.brand_activations (tenant_id, version, reason) values (${C.id}, 1, 'fixture')`;
    // Written past the contract on purpose: only a writer that skips
    // validation could store this, and the API must still refuse to serve it.
    const tampered = {
      ...brand("Tampered", "#264653", "#e9c46a", "sora", "inter"),
      logo: {
        src: dataUri('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>'),
        kind: "mark",
        alt: "Tampered",
        width: 64,
        height: 64,
      },
    };
    await admin`insert into public.brand_config_versions (tenant_id, version, schema_version, config)
      values (${E.id}, 1, 1, ${admin.json(tampered as never)})`;
    await admin`insert into public.brand_activations (tenant_id, version, reason) values (${E.id}, 1, 'fixture')`;
    // Also past the contract: a stored config that names its own version.
    const versioned = { ...brand("Versioned", "#264653", "#e9c46a", "sora", "inter"), version: 99 };
    await admin`insert into public.brand_config_versions (tenant_id, version, schema_version, config)
      values (${F.id}, 1, 1, ${admin.json(versioned as never)})`;
    await admin`insert into public.brand_activations (tenant_id, version, reason) values (${F.id}, 1, 'fixture')`;
  });

  afterAll(async () => {
    await runtime?.end();
    await admin?.end();
  });

  it("returns each tenant's own active brand to its own origin", async () => {
    for (const [t, expected] of [
      [A, brandA],
      [B, brandB],
    ] as const) {
      const { res, json } = await bootstrap(`https://${host(t)}`);
      expect(res.status).toBe(200);
      expect(json).toEqual({
        tenant: { slug: t.slug, name: t.name },
        brand: { ...expected, version: 1 },
      } satisfies PublicExperienceResponse);
      expect(res.headers.get("cache-control")).toBe("private, max-age=60");
      expect(res.headers.get("vary")).toMatch(/\bOrigin\b/);
      expect(res.headers.get("access-control-allow-origin")).toBe(`https://${host(t)}`);
    }
  });

  it("carries public brand data only", async () => {
    const { text } = await bootstrap(`https://${host(A)}`);
    expect(text).not.toContain(A.id);
    for (const internal of ["tenant_id", "actor", "request_id", "reason", "schema_version"]) {
      expect(text).not.toContain(internal);
    }
  });

  it("never gives one tenant's origin another tenant's brand, even interleaved", async () => {
    const origins = Array.from({ length: 24 }, (_, i) => (i % 2 === 0 ? A : B));
    const responses = await Promise.all(origins.map((t) => bootstrap(`https://${host(t)}`)));
    responses.forEach(({ json, text }, i) => {
      const own = origins[i] === A ? A : B;
      const other = own === A ? B : A;
      const otherBrand = own === A ? brandB : brandA;
      expect((json as PublicExperienceResponse).tenant.slug).toBe(own.slug);
      for (const leak of [other.slug, other.name, otherBrand.name, otherBrand.colors.primary]) {
        expect(text).not.toContain(leak);
      }
    });
  });

  it("answers unknown, disabled, unverified, and suspended hostnames with one identical 404", async () => {
    const origins = [
      `https://${hosts.unknown}`,
      `https://${hosts.aPending}`,
      `https://${hosts.bDisabled}`,
      `https://${host(C)}`,
      "http://10.0.0.1",
      "http://localhost:5183",
      "null",
      null,
    ];
    const bodies = new Set<string>();
    for (const origin of origins) {
      const { res, json } = await bootstrap(origin);
      expect({ origin, status: res.status }).toEqual({ origin, status: 404 });
      expect(Object.keys(json)).toEqual(["error"]);
      const { requestId, ...rest } = json.error ?? { requestId: "missing" };
      expect(requestId).toMatch(/^[0-9a-f-]{36}$/);
      bodies.add(JSON.stringify(rest));
      expect(res.headers.get("cache-control")).toBeNull();
    }
    expect([...bodies]).toEqual([
      JSON.stringify({
        code: "tenant_not_found",
        message: "No operator is published at this address",
      }),
    ]);
  });

  it("returns only the identity for a verified tenant that has not published a brand", async () => {
    const { res, json } = await bootstrap(`https://${host(D)}`);
    expect(res.status).toBe(200);
    expect(json).toEqual({ tenant: { slug: D.slug, name: D.name } });
  });

  it("withholds a stored brand that no longer passes the contract", async () => {
    const { res, json, text } = await bootstrap(`https://${host(E)}`);
    expect(res.status).toBe(503);
    expect(json.error?.code).toBe("brand_unavailable");
    expect(text).not.toContain("Tampered");
    expect(text).not.toContain("data:image");
  });

  it("withholds a stored brand that names its own version instead of overwriting it", async () => {
    const { res, json, text } = await bootstrap(`https://${host(F)}`);
    expect(res.status).toBe(503);
    expect(json.error?.code).toBe("brand_unavailable");
    expect(text).not.toContain("Versioned");
  });

  it("withholds a tenant whose public name fails the identity contract", async () => {
    const { res, json, text } = await bootstrap(`https://${host(G)}`);
    expect(res.status).toBe(503);
    expect(json.error?.code).toBe("brand_unavailable");
    expect(text).not.toContain(G.slug);
  });

  it("switches to a new version on activation and leaves older versions untouched", async () => {
    const snapshot = () =>
      admin`select version, schema_version, config, created_at, actor_type, actor_id
              from public.brand_config_versions where tenant_id = ${A.id} order by version`;
    const [original] = await snapshot();

    expect(await publish(A.id, brandA2, "new season colors")).toBe(2);
    const second = await bootstrap(`https://${host(A)}`);
    expect(second.json).toEqual({
      tenant: { slug: A.slug, name: A.name },
      brand: { ...brandA2, version: 2 },
    });
    // A's newest activation names a version B never had; B's brand must not move.
    expect((await bootstrap(`https://${host(B)}`)).json).toEqual({
      tenant: { slug: B.slug, name: B.name },
      brand: { ...brandB, version: 1 },
    });

    // Going back is a new activation of the old version, not an edit.
    await activate(A.id, 1, "revert to original colors");
    const reverted = await bootstrap(`https://${host(A)}`);
    expect((reverted.json as PublicExperienceResponse).brand).toEqual({ ...brandA, version: 1 });

    const versions = await snapshot();
    expect(versions.map((v) => v.version)).toEqual([1, 2]);
    expect(versions[0]).toEqual(original);
    expect(original?.actor_type).toBe("system");
    expect(original?.actor_id).toBe("brand-integration-test");
    const activations = await admin`select version, reason, actor_type from public.brand_activations
      where tenant_id = ${A.id} order by id`;
    expect(activations.map((a) => [a.version, a.reason])).toEqual([
      [1, "fixture brand"],
      [2, "new season colors"],
      [1, "revert to original colors"],
    ]);
    // B is unaffected by A's changes.
    expect((await bootstrap(`https://${host(B)}`)).json).toEqual({
      tenant: { slug: B.slug, name: B.name },
      brand: { ...brandB, version: 1 },
    });
  });

  it("rejects UPDATE, DELETE, and TRUNCATE on brand tables for every role", async () => {
    const before =
      await admin`select count(*)::int as n from public.brand_config_versions where tenant_id = ${A.id}`;
    // Thunks, run one at a time, so no rejection is left unobserved.
    const attempts: Array<[string, () => Promise<unknown>, string]> = [
      [
        "runtime update version",
        () =>
          asTenant(A.id, (tx) => tx`update public.brand_config_versions set config = '{}'::jsonb`),
        "42501",
      ],
      [
        "runtime delete version",
        () => asTenant(A.id, (tx) => tx`delete from public.brand_config_versions`),
        "42501",
      ],
      [
        "runtime truncate version",
        () => asTenant(A.id, (tx) => tx`truncate public.brand_config_versions`),
        "42501",
      ],
      [
        "runtime update activation",
        () => asTenant(A.id, (tx) => tx`update public.brand_activations set version = 2`),
        "42501",
      ],
      [
        "runtime delete activation",
        () => asTenant(A.id, (tx) => tx`delete from public.brand_activations`),
        "42501",
      ],
      [
        "owner update version",
        () =>
          admin`update public.brand_config_versions set config = '{}'::jsonb where tenant_id = ${A.id}`,
        "55000",
      ],
      [
        "owner delete version",
        () => admin`delete from public.brand_config_versions where tenant_id = ${A.id}`,
        "55000",
      ],
      [
        "owner update activation",
        () => admin`update public.brand_activations set reason = 'x' where tenant_id = ${A.id}`,
        "55000",
      ],
      [
        "owner delete activation",
        () => admin`delete from public.brand_activations where tenant_id = ${A.id}`,
        "55000",
      ],
      ["owner truncate activations", () => admin`truncate public.brand_activations`, "55000"],
      [
        "owner truncate versions",
        () => admin`truncate public.brand_config_versions cascade`,
        "55000",
      ],
    ];
    for (const [label, attempt, code] of attempts) {
      expect({ label, code: await pgError(attempt()) }).toEqual({ label, code });
    }
    const after =
      await admin`select count(*)::int as n from public.brand_config_versions where tenant_id = ${A.id}`;
    expect(after[0]?.n).toBe(before[0]?.n);
  });

  it("keeps brand rows inside their tenant for the runtime role", async () => {
    for (const table of ["brand_config_versions", "brand_activations"]) {
      const [none] = await asTenant(
        null,
        (tx) => tx`select count(*)::int as n from ${tx(`public.${table}`)}`,
      );
      expect({ table, n: none?.n }).toEqual({ table, n: 0 });
      const seen = await asTenant(
        A.id,
        (tx) => tx`select distinct tenant_id from ${tx(`public.${table}`)}`,
      );
      expect({ table, tenants: seen.map((r) => r.tenant_id) }).toEqual({ table, tenants: [A.id] });
    }
    const cross: Array<[string, (tx: Sql) => Promise<unknown>, string]> = [
      [
        "version for B",
        (
          tx,
        ) => tx`insert into public.brand_config_versions (tenant_id, version, schema_version, config)
          values (${B.id}, 9, 1, ${tx.json(brandA as never)})`,
        "42501",
      ],
      [
        "activation for B",
        (tx) =>
          tx`insert into public.brand_activations (tenant_id, version, reason) values (${B.id}, 1, 'x')`,
        "42501",
      ],
      [
        "activation of a version that does not exist",
        (tx) =>
          tx`insert into public.brand_activations (tenant_id, version, reason) values (${A.id}, 99, 'x')`,
        "23503",
      ],
      [
        "activation without a reason",
        (tx) =>
          tx`insert into public.brand_activations (tenant_id, version, reason) values (${A.id}, 1, '')`,
        "23514",
      ],
      [
        "a non-object config",
        (
          tx,
        ) => tx`insert into public.brand_config_versions (tenant_id, version, schema_version, config)
          values (${A.id}, 50, 1, '[]'::jsonb)`,
        "23514",
      ],
      [
        "an unknown schema version",
        (
          tx,
        ) => tx`insert into public.brand_config_versions (tenant_id, version, schema_version, config)
          values (${A.id}, 51, 2, ${tx.json(brandA as never)})`,
        "23514",
      ],
      [
        "an oversized config",
        (
          tx,
        ) => tx`insert into public.brand_config_versions (tenant_id, version, schema_version, config)
          values (${A.id}, 52, 1, ${tx.json({ pad: "x".repeat(70_000) })})`,
        "23514",
      ],
    ];
    for (const [label, attempt, code] of cross) {
      expect({ label, code: await pgError(asTenant(A.id, attempt)) }).toEqual({ label, code });
    }
    // A guest context can never publish.
    const guest = await pgError(
      runtime.begin(async (tx) => {
        await tx`select set_config('app.tenant_id', ${A.id}, true), set_config('app.actor_type', 'guest', true)`;
        await tx`insert into public.brand_activations (tenant_id, version, reason) values (${A.id}, 1, 'x')`;
      }),
    );
    expect(guest).toBe("23514");
  });

  it("grants exactly SELECT and INSERT, forces row-level security, and guards the bootstrap function", async () => {
    const tables = await admin`
      select c.relname, c.relrowsecurity, c.relforcerowsecurity,
             array(select p from unnest(array['SELECT','INSERT','UPDATE','DELETE','TRUNCATE','REFERENCES','TRIGGER']) p
                    where has_table_privilege('tidegrid_app', c.oid, p) order by p) as privileges,
             (select count(*)::int from pg_policy p where p.polrelid = c.oid and p.polname = 'tenant_isolation'
                and pg_get_expr(p.polqual, p.polrelid) like '%current_tenant_id()%'
                and pg_get_expr(p.polwithcheck, p.polrelid) like '%current_tenant_id()%') as policies,
             (select count(*)::int from pg_trigger t where t.tgrelid = c.oid and not t.tgisinternal
                and t.tgfoid = 'app.reject_mutation'::regproc) as guards
        from pg_class c join pg_namespace n on n.oid = c.relnamespace
       where n.nspname = 'public' and c.relname in ('brand_config_versions', 'brand_activations')
       order by c.relname`;
    expect(tables.map((t) => ({ ...t }))).toEqual([
      {
        relname: "brand_activations",
        relrowsecurity: true,
        relforcerowsecurity: true,
        privileges: ["INSERT", "SELECT"],
        policies: 1,
        guards: 2,
      },
      {
        relname: "brand_config_versions",
        relrowsecurity: true,
        relforcerowsecurity: true,
        privileges: ["INSERT", "SELECT"],
        policies: 1,
        guards: 2,
      },
    ]);
    const [fn] = await admin`
      select p.prosecdef, p.proconfig,
             exists (select 1 from aclexplode(p.proacl) x where x.grantee = 0) as public_execute,
             has_function_privilege('tidegrid_app', p.oid, 'EXECUTE') as runtime_execute
        from pg_proc p join pg_namespace n on n.oid = p.pronamespace
       where n.nspname = 'app' and p.proname = 'resolve_public_brand'`;
    expect(fn).toEqual({
      prosecdef: true,
      proconfig: ["search_path=pg_catalog, pg_temp"],
      public_execute: false,
      runtime_execute: true,
    });
  });
});
