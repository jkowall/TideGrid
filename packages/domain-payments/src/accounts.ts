import type { Database, TenantTransaction } from "@tidegrid/database";
import { type Kysely, sql } from "kysely";
import type { PaymentProviderName } from "./adapter.ts";

/** "acct_" and up to 64 letters, digits, underscores, or hyphens: acct_fake_demo-harbor. */
export const accountRefPattern = /^acct_[A-Za-z0-9_-]{1,64}$/;

export interface ResolvedAccount {
  tenantId: string;
  status: "active" | "disabled";
}

/**
 * The tenant that owns a connected account, for a provider callback that names
 * the account and nothing else. Runs outside any tenant context through the
 * definer function app.resolve_payment_account, which returns the tenant id and
 * the account's status only. Money that moved on a disabled account must still
 * be recorded, so the caller decides what the status allows.
 */
export async function resolvePaymentAccount(
  db: Kysely<Database>,
  provider: PaymentProviderName,
  accountRef: string,
): Promise<ResolvedAccount | null> {
  if (!accountRefPattern.test(accountRef)) return null;
  const { rows } = await sql<{ tenant_id: string; account_status: "active" | "disabled" }>`
    select tenant_id, account_status from app.resolve_payment_account(${provider}, ${accountRef})
  `.execute(db);
  const row = rows[0];
  return row ? { tenantId: row.tenant_id, status: row.account_status } : null;
}

/** The tenant's account at one provider, read under its own row-level security. */
export async function getPaymentAccount(
  trx: TenantTransaction,
  tenantId: string,
  provider: PaymentProviderName,
): Promise<{ accountRef: string; status: "active" | "disabled" } | null> {
  const row = await trx
    .selectFrom("payment_accounts")
    .select(["account_ref", "status"])
    .where("tenant_id", "=", tenantId)
    .where("provider", "=", provider)
    .executeTakeFirst();
  return row ? { accountRef: row.account_ref, status: row.status } : null;
}
