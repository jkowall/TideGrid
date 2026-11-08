/**
 * Per-operator sender domains and suppression (W3-G2.16-rest, migration 0027).
 *
 * Sender. An operator whose sending domain is verified sends from its own
 * address on it (`<local part>@<domain>`); the display name stays the
 * operator's name and " via TideGrid" (W1-SENDER-GUARD). Only the admin
 * connection adds, verifies, and retires a domain, so the runtime never sends
 * from a domain nobody checked. Without a verified domain the deployment's
 * policy decides:
 *
 * - `shared` (the default): the shared TideGrid sender, as before.
 * - `operator_only`: nothing is sent. The operator's mail stays queued, the
 *   run reports the tenant as held, and it goes out once a domain is
 *   verified. This is the pilot's setting: the Core live gate asks each
 *   operator to send from its own authenticated domain.
 *
 * Suppression. A complaint or a hard bounce the provider reports stops that
 * operator's later mail to the address, and only that operator's. Delivery
 * reads it when it claims a message and fails a suppressed one as
 * `address_suppressed` with no provider call.
 */
import type { TenantTransaction } from "@tidegrid/database";
import { sql } from "kysely";

export type SenderPolicy = "shared" | "operator_only";
export const SENDER_POLICIES: readonly SenderPolicy[] = ["shared", "operator_only"];

/** Why delivery failed a message to a suppressed address, with no provider call. */
export const ADDRESS_SUPPRESSED = "address_suppressed";

/** The operator's verified sending address, or null when it has none. */
export async function operatorSenderAddress(
  trx: TenantTransaction,
  tenantId: string,
): Promise<string | null> {
  const { rows } = await sql<{ local_part: string; domain: string }>`
    select local_part, domain from tenant_sender_domains
     where tenant_id = ${tenantId} and status = 'verified'
     limit 1`.execute(trx);
  const row = rows[0];
  return row ? `${row.local_part}@${row.domain}` : null;
}

/**
 * Who a message is sent from under a policy: the operator's verified address,
 * else the shared sender, else (operator_only) null, and nothing is sent.
 */
export async function senderAddressFor(
  trx: TenantTransaction,
  tenantId: string,
  policy: SenderPolicy,
  sharedAddress: string,
): Promise<string | null> {
  const own = await operatorSenderAddress(trx, tenantId);
  if (own) return own;
  return policy === "operator_only" ? null : sharedAddress;
}

/** Whether the operator has an active suppression of this address. */
export async function isSuppressed(
  trx: TenantTransaction,
  tenantId: string,
  address: string,
): Promise<boolean> {
  const { rows } = await sql<{ found: boolean }>`
    select exists (
      select 1 from email_suppressions
       where tenant_id = ${tenantId} and address = ${address} and lifted_at is null
    ) as found`.execute(trx);
  return rows[0]?.found === true;
}
