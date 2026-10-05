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
 */
import postgres from "postgres";
import { seedCatalog } from "./catalog.ts";

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

const ownerEmails = (process.env.SEED_OWNER_EMAILS ?? "")
  .split(",")
  .map((e) => e.trim().toLowerCase())
  .filter((e) => e.length > 0);
for (const email of ownerEmails) {
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
    console.error("SEED_OWNER_EMAILS contains an invalid address.");
    process.exit(2);
  }
}

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
    const people = [
      ...demoStaff.map((s) => ({ ...s, tenants: [s.tenant] })),
      ...ownerEmails.map((email) => ({
        email,
        name: email.split("@")[0] ?? "Owner",
        role: "owner" as const,
        tenants: [0, 1],
      })),
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

  const [summary] = await sql<{ tenants: number; staff: number; memberships: number }[]>`
    select (select count(*)::int from public.tenants where id in ${sql(demoTenants.map((t) => t.id))}) as tenants,
           (select count(*)::int from public.tenant_memberships where tenant_id in ${sql(demoTenants.map((t) => t.id))}) as memberships,
           (select count(distinct user_id)::int from public.tenant_memberships where tenant_id in ${sql(demoTenants.map((t) => t.id))}) as staff`;
  console.log(
    `seeded ${summary?.tenants} demo operators, ${summary?.staff} staff, ${summary?.memberships} memberships` +
      (ownerEmails.length
        ? ` (${ownerEmails.length} owner address(es) from SEED_OWNER_EMAILS)`
        : ""),
  );
} finally {
  await sql.end();
}
