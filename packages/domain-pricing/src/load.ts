import { isUuid, type TenantTransaction } from "@tidegrid/database";
import { findAvailableTrips } from "@tidegrid/domain-catalog";
import type {
  AddOnItem,
  ChargeBasis,
  Discount,
  FeeItem,
  PolicyRemedy,
  PolicyVersion,
  PriceList,
  ProductKind,
  PromotionTerms,
  TaxRate,
  TicketItem,
} from "./terms.ts";

/**
 * Reads of the current terms. Every query names its tenant explicitly;
 * row-level security is the backstop. "Current" is the highest version.
 */

/** postgres.js reads a date column as a Date at UTC midnight of that date. */
export function dateOnly(value: Date | string): string {
  return typeof value === "string" ? value.slice(0, 10) : value.toISOString().slice(0, 10);
}

export async function loadPriceList(
  trx: TenantTransaction,
  tenantId: string,
  productId: string,
): Promise<PriceList | null> {
  const head = await trx
    .selectFrom("price_list_versions")
    .select(["version", "product_kind"])
    .where("tenant_id", "=", tenantId)
    .where("product_id", "=", productId)
    .orderBy("version", "desc")
    .limit(1)
    .executeTakeFirst();
  if (!head) return null;
  const items = await trx
    .selectFrom("price_list_items")
    .selectAll()
    .where("tenant_id", "=", tenantId)
    .where("product_id", "=", productId)
    .where("version", "=", head.version)
    .orderBy("sort_order")
    .orderBy("code")
    .execute();
  const tickets: TicketItem[] = [];
  const fees: FeeItem[] = [];
  const addOns: AddOnItem[] = [];
  let charter: PriceList["charter"] = null;
  for (const i of items) {
    const base = { code: i.code, name: i.name, unitAmount: i.unit_amount, taxable: i.taxable };
    if (i.item_kind === "ticket") tickets.push(base);
    else if (i.item_kind === "charter") {
      charter = { name: i.name, amount: i.unit_amount, taxable: i.taxable };
    } else if (i.item_kind === "fee") fees.push({ ...base, basis: i.basis as ChargeBasis });
    else {
      addOns.push({
        ...base,
        quantityRule: i.basis as ChargeBasis,
        maxQuantity: i.max_quantity ?? 1,
        availableFrom: i.available_from === null ? null : dateOnly(i.available_from),
        availableUntil: i.available_until === null ? null : dateOnly(i.available_until),
      });
    }
  }
  return {
    productId,
    version: head.version,
    productKind: head.product_kind,
    tickets,
    charter,
    fees,
    addOns,
  };
}

interface PolicyRow {
  product_id: string;
  version: number;
  change_cutoff_minutes: number;
  before_cutoff_remedy: PolicyRemedy;
  before_cutoff_refund_bp: number | null;
  after_cutoff_remedy: PolicyRemedy;
  after_cutoff_refund_bp: number | null;
  no_show_remedy: PolicyRemedy;
  no_show_refund_bp: number | null;
  cancellation_text: string;
  reschedule_text: string;
  no_show_text: string;
  operator_cancellation_text: string;
  weather_text: string;
}

export function toPolicyVersion(row: PolicyRow): PolicyVersion {
  return {
    productId: row.product_id,
    version: row.version,
    changeCutoffMinutes: row.change_cutoff_minutes,
    beforeCutoff: { remedy: row.before_cutoff_remedy, refundBp: row.before_cutoff_refund_bp },
    afterCutoff: { remedy: row.after_cutoff_remedy, refundBp: row.after_cutoff_refund_bp },
    noShow: { remedy: row.no_show_remedy, refundBp: row.no_show_refund_bp },
    text: {
      cancellation: row.cancellation_text,
      reschedule: row.reschedule_text,
      noShow: row.no_show_text,
      operatorCancellation: row.operator_cancellation_text,
      weather: row.weather_text,
    },
  };
}

/** The current policy, or a named version when one is given. */
export async function loadPolicy(
  trx: TenantTransaction,
  tenantId: string,
  productId: string,
  version?: number,
): Promise<PolicyVersion | null> {
  let query = trx
    .selectFrom("policy_versions")
    .selectAll()
    .where("tenant_id", "=", tenantId)
    .where("product_id", "=", productId);
  query =
    version === undefined
      ? query.orderBy("version", "desc").limit(1)
      : query.where("version", "=", version);
  const row = await query.executeTakeFirst();
  return row ? toPolicyVersion(row) : null;
}

/**
 * Every tax rate whose current version is active, ordered by name and then
 * id. Quotes keep this order for their tax lines.
 */
export async function loadTaxRates(trx: TenantTransaction, tenantId: string): Promise<TaxRate[]> {
  const rows = await trx
    .selectFrom("tax_rate_versions")
    .select(["tax_rate_id", "version", "name", "rate_ppm", "inclusive", "active"])
    .distinctOn("tax_rate_id")
    .where("tenant_id", "=", tenantId)
    .orderBy("tax_rate_id")
    .orderBy("version", "desc")
    .execute();
  return rows
    .filter((r) => r.active)
    .map((r) => ({
      taxRateId: r.tax_rate_id,
      version: r.version,
      name: r.name,
      ratePpm: r.rate_ppm,
      inclusive: r.inclusive,
    }))
    .sort((a, b) =>
      a.name !== b.name ? (a.name < b.name ? -1 : 1) : a.taxRateId < b.taxRateId ? -1 : 1,
    );
}

/** The current terms of the promotion with this code (already normalized), or null. */
export async function findPromotion(
  trx: TenantTransaction,
  tenantId: string,
  code: string,
): Promise<PromotionTerms | null> {
  const row = await trx
    .selectFrom("promotions as p")
    .innerJoin("promotion_versions as v", (j) =>
      j.onRef("v.tenant_id", "=", "p.tenant_id").onRef("v.promotion_id", "=", "p.id"),
    )
    .select([
      "p.id",
      "p.code",
      "v.version",
      "v.discount_kind",
      "v.amount_off",
      "v.percent_off_bp",
      "v.starts_at",
      "v.ends_at",
      "v.applies_to_all_products",
      "v.active",
    ])
    .where("p.tenant_id", "=", tenantId)
    .where("p.code", "=", code)
    .orderBy("v.version", "desc")
    .limit(1)
    .executeTakeFirst();
  if (!row) return null;
  const products = row.applies_to_all_products
    ? []
    : await trx
        .selectFrom("promotion_version_products")
        .select("product_id")
        .where("tenant_id", "=", tenantId)
        .where("promotion_id", "=", row.id)
        .where("version", "=", row.version)
        .orderBy("product_id")
        .execute();
  const discount: Discount =
    row.discount_kind === "percent"
      ? { kind: "percent", percentOffBp: row.percent_off_bp ?? 0 }
      : { kind: "fixed_amount", amountOff: row.amount_off ?? 0 };
  return {
    promotionId: row.id,
    version: row.version,
    code: row.code,
    active: row.active,
    discount,
    startsAtMs: new Date(row.starts_at).getTime(),
    endsAtMs: new Date(row.ends_at).getTime(),
    appliesToAllProducts: row.applies_to_all_products,
    productIds: products.map((p) => p.product_id),
  };
}

/** What a quote needs to know about the trip it prices. */
export interface SaleTrip {
  tripId: string;
  productId: string;
  productKind: ProductKind;
  productName: string;
  minPartySize: number;
  maxPartySize: number;
  capacityRemaining: number;
  timeZone: string;
  localDate: string;
  localStartTime: string;
  startsAt: string;
  startsAtLocal: string;
  startOffsetMinutes: number;
}

export type TripForSale =
  | { kind: "on_sale"; trip: SaleTrip }
  | { kind: "not_found" }
  | { kind: "not_on_sale" };

/**
 * A trip a guest may book now. Bookability is the catalog's: the trip is on
 * sale exactly when the public availability query lists it for the smallest
 * party the product allows. So quotes follow the catalog's rules (published
 * trip and product, active location and boat, before the booking cutoff,
 * clear of blackouts, and its capacity) without restating them.
 */
export async function findTripForSale(
  trx: TenantTransaction,
  tenantId: string,
  tripId: string,
  now: Date,
): Promise<TripForSale> {
  if (!isUuid(tripId)) return { kind: "not_found" };
  const row = await trx
    .selectFrom("scheduled_trips as t")
    .innerJoin("products as p", (j) =>
      j.onRef("p.tenant_id", "=", "t.tenant_id").onRef("p.id", "=", "t.product_id"),
    )
    .select(["t.product_id", "t.local_date", "t.start_utc_offset_minutes", "p.min_party_size"])
    .where("t.tenant_id", "=", tenantId)
    .where("t.id", "=", tripId)
    .executeTakeFirst();
  if (!row) return { kind: "not_found" };
  const localDate = dateOnly(row.local_date);
  const listed = await findAvailableTrips(trx, tenantId, {
    from: localDate,
    to: localDate,
    party: row.min_party_size,
    productId: row.product_id,
    now,
  });
  const trip = listed.find((t) => t.tripId === tripId);
  if (!trip) return { kind: "not_on_sale" };
  return {
    kind: "on_sale",
    trip: {
      tripId,
      productId: trip.product.id,
      productKind: trip.product.kind,
      productName: trip.product.name,
      minPartySize: trip.product.minPartySize,
      maxPartySize: trip.product.maxPartySize,
      capacityRemaining: trip.capacity.remaining,
      timeZone: trip.timeZone,
      localDate: trip.localDate,
      localStartTime: trip.localStartTime,
      startsAt: trip.startsAt,
      startsAtLocal: trip.startsAtLocal,
      startOffsetMinutes: row.start_utc_offset_minutes,
    },
  };
}
