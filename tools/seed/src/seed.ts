/**
 * Deterministic synthetic seed. Idempotent: rerunning leaves the same state and
 * never overwrites rows it did not create. Runs as the admin role. Contains no
 * real people or businesses; `.test` addresses are reserved and undeliverable.
 *
 *   DATABASE_URL=... pnpm db:seed
 *   DATABASE_URL=... SEED_OWNER_EMAILS=a@x,b@y pnpm db:seed
 *
 * SEED_OWNER_EMAILS grants owner access to both demo operators to addresses
 * supplied at seed time, so personal addresses never enter the repository.
 * SEED_SINGLE_TENANT_OWNER=<address>:<slug> grants one operator only, and
 * SEED_OWNER_DISPLAY_NAME names new rows for these addresses (owners.ts).
 *
 *   DATABASE_URL=... SEED_DEMO_BOOKINGS=1 pnpm db:seed
 *
 * SEED_DEMO_BOOKINGS=1 also books a few synthetic guests through the real
 * checkout and the fake provider (bookings.ts). It takes about a minute the
 * first time, because one payment must arrive after its checkout ran out.
 */
import postgres from "postgres";
import { seedDemoBookings } from "./bookings.ts";
import { seedBrands } from "./brands.ts";
import { seedCatalog } from "./catalog.ts";
import { parseSeedOwners, type SeedOwner, SeedOwnerError } from "./owners.ts";
import { seedPaymentAccounts } from "./payments.ts";
import { seedPricing } from "./pricing.ts";
import { seedWaivers } from "./waivers.ts";

const url = process.env.DATABASE_URL;
if (!url) {
  console.error("DATABASE_URL is required (admin connection string).");
  process.exit(2);
}

export const demoTenants = [
  {
    id: "7d1e5b3a-1c2f-4a8e-9b61-0a1c2e3f4a01",
    slug: "demo-harbor",
    name: "Demo Harbor Charters",
    hostname: "demo-harbor.book.tidegrid.us",
  },
  {
    id: "7d1e5b3a-1c2f-4a8e-9b61-0a1c2e3f4a02",
    slug: "demo-reef",
    name: "Demo Reef Divers",
    hostname: "demo-reef.book.tidegrid.us",
  },
] as const;

const demoStaff = [
  { email: "ava.owner@demo-harbor.test", name: "Ava Owner", tenant: 0, role: "owner" },
  { email: "ben.desk@demo-harbor.test", name: "Ben Desk", tenant: 0, role: "booking_staff" },
  { email: "fay.books@demo-harbor.test", name: "Fay Books", tenant: 0, role: "finance" },
  { email: "cara.owner@demo-reef.test", name: "Cara Owner", tenant: 1, role: "owner" },
] as const;

let owners: SeedOwner[];
try {
  owners = parseSeedOwners(
    process.env,
    demoTenants.map((t) => t.slug),
  );
} catch (err) {
  if (!(err instanceof SeedOwnerError)) throw err;
  console.error(err.message);
  process.exit(2);
}
const ownerEmails = owners.map((o) => o.email);
const singleTenantOwners = owners.filter((o) => o.tenants.length === 1);

const sql = postgres(url, { max: 1, onnotice: () => {} });
try {
  const [migrated] = await sql<{ n: number }[]>`
    select count(*)::int as n from schema_migrations where name = '0002_tenancy_access_audit.sql'`;
  if (!migrated?.n) {
    console.error("Migration 0002 is not applied. Run pnpm db:migrate first.");
    process.exit(1);
  }

  await sql.begin(async (tx) => {
    for (const t of demoTenants) {
      await tx`insert into public.tenants (id, slug, display_name)
        values (${t.id}, ${t.slug}, ${t.name}) on conflict (id) do nothing`;
      await tx`insert into public.tenant_hostnames (hostname, tenant_id, kind, status, verified_at)
        values (${t.hostname}, ${t.id}, 'preview', 'active', now()) on conflict (hostname) do nothing`;
    }
    // A single-tenant owner must stay single-tenant: refuse, before any
    // write, an address that already belongs to another demo operator.
    for (const o of singleTenantOwners) {
      const keep = demoTenants[o.tenants[0] ?? -1]?.id;
      const [other] = await tx<{ n: number }[]>`
        select count(*)::int as n
          from public.tenant_memberships m
          join public.staff_users u on u.id = m.user_id
         where u.email = ${o.email}
           and m.tenant_id in ${tx(demoTenants.map((t) => t.id))}
           and m.tenant_id <> ${keep ?? ""}`;
      if (other?.n) {
        throw new SeedOwnerError(
          "SEED_SINGLE_TENANT_OWNER already belongs to another demo operator; nothing was written.",
        );
      }
    }
    const people = [
      ...demoStaff.map((s) => ({ ...s, tenants: [s.tenant] })),
      ...owners.map((o) => ({ ...o, role: "owner" as const })),
    ];
    for (const p of people) {
      await tx`insert into public.staff_users (email, display_name)
        values (${p.email}, ${p.name}) on conflict (email) do nothing`;
      const [user] = await tx<
        { id: string }[]
      >`select id from public.staff_users where email = ${p.email}`;
      for (const index of p.tenants) {
        const tenant = demoTenants[index];
        if (!tenant || !user) continue;
        await tx`insert into public.tenant_memberships (tenant_id, user_id, role, display_name)
          values (${tenant.id}, ${user.id}, ${p.role}, ${p.name}) on conflict do nothing`;
      }
    }
  });

  await seedCatalog(url, demoTenants);
  await seedPricing(url, demoTenants);
  const accounts = await seedPaymentAccounts(sql, demoTenants);
  console.log(
    `seeded fake payment accounts: ${accounts.created} new, ${accounts.existing} already present`,
  );
  // Waiver templates (G2.15): one per operator, and Demo Reef's dive waiver.
  const waivers = await seedWaivers(url, demoTenants);
  console.log(
    `seeded waiver templates: ${waivers.templates} new templates, ${waivers.versions} new versions`,
  );

  const [summary] = await sql<{ tenants: number; staff: number; memberships: number }[]>`
    select (select count(*)::int from public.tenants where id in ${sql(demoTenants.map((t) => t.id))}) as tenants,
           (select count(*)::int from public.tenant_memberships where tenant_id in ${sql(demoTenants.map((t) => t.id))}) as memberships,
           (select count(distinct user_id)::int from public.tenant_memberships where tenant_id in ${sql(demoTenants.map((t) => t.id))}) as staff`;
  console.log(
    `seeded ${summary?.tenants} demo operators, ${summary?.staff} staff, ${summary?.memberships} memberships` +
      (ownerEmails.length
        ? ` (${ownerEmails.length - singleTenantOwners.length} owner address(es) from SEED_OWNER_EMAILS` +
          `, ${singleTenantOwners.length} single-tenant)`
        : ""),
  );
  await seedBrands(sql, { localHostnames: process.env.SEED_LOCAL_HOSTNAMES === "1" });
  // Off by default: bookings made through the real checkout and verified
  // fake-provider events, so the console's booking views have something to
  // show (G2.12b).
  if (process.env.SEED_DEMO_BOOKINGS === "1") await seedDemoBookings(url, sql, demoTenants);
} catch (err) {
  if (!(err instanceof SeedOwnerError)) throw err;
  console.error(err.message);
  process.exitCode = 2;
} finally {
  // Bounded, so a compute that restarts mid-run cannot hang the command.
  await sql.end({ timeout: 5 });
}
