import type { TenantTransaction } from "@tidegrid/database";
import { sql } from "kysely";

/**
 * The operator's tax rates as staff see them (W3-G2.5-TAX staff screens):
 * each rate's current version, with its location's name. Active rates by
 * name, then retired ones.
 */
export interface TaxRateView {
  id: string;
  version: number;
  name: string;
  ratePpm: number;
  inclusive: boolean;
  active: boolean;
  locationId: string | null;
  locationName: string | null;
  reason: string;
  changedAt: string;
}

interface Row {
  tax_rate_id: string;
  version: number;
  name: string;
  rate_ppm: number;
  inclusive: boolean;
  active: boolean;
  location_id: string | null;
  location_name: string | null;
  reason: string;
  created_at: Date | string;
}

const toView = (r: Row): TaxRateView => ({
  id: r.tax_rate_id,
  version: r.version,
  name: r.name,
  ratePpm: r.rate_ppm,
  inclusive: r.inclusive,
  active: r.active,
  locationId: r.location_id,
  locationName: r.location_name,
  reason: r.reason,
  changedAt: new Date(r.created_at).toISOString(),
});

export async function listTaxRates(
  trx: TenantTransaction,
  tenantId: string,
  only?: string,
): Promise<TaxRateView[]> {
  const { rows } = await sql<Row>`
    select distinct on (v.tax_rate_id)
           v.tax_rate_id, v.version, v.name, v.rate_ppm, v.inclusive, v.active,
           v.location_id, l.name as location_name, v.reason, v.created_at
      from tax_rate_versions v
      left join locations l on l.tenant_id = v.tenant_id and l.id = v.location_id
     where v.tenant_id = ${tenantId}
       ${only === undefined ? sql`` : sql`and v.tax_rate_id = ${only}`}
     order by v.tax_rate_id, v.version desc`.execute(trx);
  return rows
    .map(toView)
    .sort((a, b) =>
      a.active !== b.active
        ? a.active
          ? -1
          : 1
        : a.name.localeCompare(b.name, "en") || a.id.localeCompare(b.id),
    );
}

/** One rate's current version, or null when this tenant has no such rate. */
export async function getTaxRate(
  trx: TenantTransaction,
  tenantId: string,
  taxRateId: string,
): Promise<TaxRateView | null> {
  return (await listTaxRates(trx, tenantId, taxRateId))[0] ?? null;
}
