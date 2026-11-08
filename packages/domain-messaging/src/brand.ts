import {
  BrandConfig,
  brandSchemaVersion,
  fallbackSenderName,
  sameSenderName,
  senderNameProblem,
} from "@tidegrid/contracts";
import type { TenantTransaction } from "@tidegrid/database";
import { sql } from "kysely";
import { type EmailBrand, neutralBrandColors } from "./render.ts";

/**
 * The tenant's active brand for email, read in the caller's transaction: its
 * latest activation's configuration, validated against the brand contract
 * again, as the public bootstrap does. A tenant without a published brand, or
 * whose stored brand fails validation, gets its display name in the neutral
 * TideGrid colors and no contact details: email never fails on a brand.
 *
 * The name is bound to the tenant's provisioned display name, which TideGrid
 * sets and the runtime role cannot change (W1-SENDER-GUARD). A brand's name
 * is used only when it reads as that name (`sameSenderName`); otherwise the
 * email uses the provisioned name, so a brand cannot send as another
 * operator. A provisioned name that fails the sender name rule becomes
 * "Your trip operator".
 */
export async function loadEmailBrand(
  trx: TenantTransaction,
  tenantId: string,
): Promise<EmailBrand> {
  const { rows } = await sql<{
    display_name: string;
    schema_version: number | null;
    config: unknown;
  }>`
    select t.display_name, v.schema_version, v.config
      from tenants t
      left join lateral (
        select a.version from brand_activations a
         where a.tenant_id = t.id order by a.id desc limit 1) a on true
      left join brand_config_versions v on v.tenant_id = t.id and v.version = a.version
     where t.id = ${tenantId}`.execute(trx);
  const row = rows[0];
  if (!row) throw new Error("the tenant is not visible in its own transaction");
  const provisioned =
    senderNameProblem(row.display_name) === null ? row.display_name : fallbackSenderName;
  const neutral: EmailBrand = {
    name: provisioned,
    primary: neutralBrandColors.primary,
    accent: neutralBrandColors.accent,
    contactEmail: null,
    contactPhone: null,
  };
  if (row.schema_version !== brandSchemaVersion) return neutral;
  const parsed = BrandConfig.safeParse(row.config);
  if (!parsed.success) return neutral;
  const brand = parsed.data;
  return {
    name: sameSenderName(brand.name, row.display_name) ? brand.name : provisioned,
    primary: brand.colors.primary,
    accent: brand.colors.accent,
    contactEmail: brand.contact.email ?? null,
    contactPhone: brand.contact.phone ?? null,
  };
}
