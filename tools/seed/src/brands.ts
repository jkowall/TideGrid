/**
 * Publish each synthetic tenant's brand from config/tenants. Idempotent: a
 * tenant whose active brand already equals its manifest is left alone. A
 * changed manifest appends a new version (or reuses an identical earlier one)
 * and activates it, so earlier versions never change. Each tenant publishes in
 * one transaction with tenant context set, recording the activation's reason
 * and an audit event, the same shape a staff publish command will have.
 *
 * SEED_LOCAL_HOSTNAMES=1 also maps <slug>.book.localhost to each tenant, for
 * local development only: browsers resolve every *.localhost name to the
 * loopback interface. Never set it for a shared environment.
 */
import { brandSchemaVersion, localHostnameFor } from "@tidegrid/tenant-config";
import { type LoadedTenant, loadTenantManifests } from "@tidegrid/tenant-config/node";
import type postgres from "postgres";

type Tx = postgres.TransactionSql;

async function publishTenant(tx: Tx, tenant: LoadedTenant, localHostnames: boolean) {
  const { manifest, brand, file } = tenant;
  const [row] = await tx<{ id: string; display_name: string }[]>`
    select id, display_name from public.tenants where slug = ${manifest.slug}`;
  if (!row)
    throw new Error(`${file}: no tenant ${manifest.slug}; seed.ts creates the demo tenants`);
  if (row.display_name !== manifest.displayName) {
    throw new Error(`${file}: displayName does not match tenant ${manifest.slug}`);
  }
  const [preview] = await tx<{ tenant_id: string }[]>`
    select tenant_id from public.tenant_hostnames where hostname = ${manifest.previewHostname}`;
  if (preview?.tenant_id !== row.id) {
    throw new Error(`${file}: ${manifest.previewHostname} is not mapped to ${manifest.slug}`);
  }

  await tx`select set_config('app.tenant_id', ${row.id}, true),
                  set_config('app.actor_type', 'system', true),
                  set_config('app.actor_id', 'seed', true)`;
  await tx`select pg_advisory_xact_lock(hashtextextended(${`tidegrid.brand:${row.id}`}, 0))`;

  const config = tx.json(brand as unknown as postgres.JSONValue);
  const [active] = await tx<{ version: number; same: boolean }[]>`
    select v.version, v.config = ${config}::jsonb as same
      from public.brand_activations a
      join public.brand_config_versions v on v.tenant_id = a.tenant_id and v.version = a.version
     where a.tenant_id = ${row.id}
     order by a.id desc
     limit 1`;
  let outcome = `brand v${active?.version} unchanged`;
  if (!active?.same) {
    const [existing] = await tx<{ version: number }[]>`
      select version from public.brand_config_versions
       where tenant_id = ${row.id} and config = ${config}::jsonb
       order by version desc limit 1`;
    let version = existing?.version;
    if (version === undefined) {
      const [created] = await tx<{ version: number }[]>`
        insert into public.brand_config_versions (tenant_id, version, schema_version, config)
        select ${row.id}, coalesce(max(version), 0) + 1, ${brandSchemaVersion}, ${config}
          from public.brand_config_versions where tenant_id = ${row.id}
        returning version`;
      version = created?.version;
    }
    const reason = `Seeded from config/tenants/${file}`;
    await tx`insert into public.brand_activations (tenant_id, version, reason)
      values (${row.id}, ${version ?? null}, ${reason})`;
    await tx`insert into public.audit_events (tenant_id, action, subject_type, subject_id, reason, after_state)
      values (${row.id}, 'brand.activated', 'brand_config_version', ${String(version)}, ${reason},
              ${tx.json({ version: version ?? null })})`;
    outcome = `brand v${version} activated`;
  }

  if (localHostnames) {
    const local = localHostnameFor(manifest.slug);
    await tx`insert into public.tenant_hostnames (hostname, tenant_id, kind, status, verified_at)
      values (${local}, ${row.id}, 'preview', 'active', now()) on conflict (hostname) do nothing`;
    const [mapped] = await tx<{ tenant_id: string }[]>`
      select tenant_id from public.tenant_hostnames where hostname = ${local}`;
    if (mapped?.tenant_id !== row.id) throw new Error(`${local} is mapped to another tenant`);
    outcome += `, local host ${local}`;
  }
  return `${manifest.slug}: ${outcome}`;
}

export async function seedBrands(sql: postgres.Sql, options: { localHostnames: boolean }) {
  const [ready] = await sql<{ ok: boolean }[]>`
    select to_regclass('public.brand_activations') is not null as ok`;
  if (!ready?.ok) {
    throw new Error("The brand configuration migration is not applied. Run pnpm db:migrate first.");
  }
  const tenants = await loadTenantManifests();
  for (const tenant of tenants) {
    const line = await sql.begin((tx) => publishTenant(tx, tenant, options.localHostnames));
    console.log(`seeded ${line}`);
  }
}
