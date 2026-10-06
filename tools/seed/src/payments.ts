/**
 * Synthetic connected accounts for the demo operators (G2.7). The demo pays
 * through the fake provider, so each operator gets one synthetic account
 * reference, `acct_fake_<slug>`, where direct charges land. Payment accounts
 * are onboarding data the runtime can only read, so the seed writes them as
 * the admin role. Idempotent: an operator that has a fake account keeps it.
 */
import type postgres from "postgres";

export async function seedPaymentAccounts(
  sql: postgres.Sql,
  tenants: readonly { id: string; slug: string }[],
): Promise<{ created: number; existing: number }> {
  let created = 0;
  let existing = 0;
  for (const tenant of tenants) {
    const rows = await sql`
      insert into public.payment_accounts (tenant_id, provider, account_ref)
      values (${tenant.id}, 'fake', ${`acct_fake_${tenant.slug}`})
      on conflict do nothing
      returning account_ref`;
    if (rows.length > 0) created += 1;
    else existing += 1;
  }
  return { created, existing };
}
