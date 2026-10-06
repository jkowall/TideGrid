import type { PolicyTerms, Quote, QuoteLine, QuoteTax, TripOffer } from "@tidegrid/contracts";
import {
  isUuid,
  type QuoteLinesTable,
  type TenantContext,
  type TenantTransaction,
} from "@tidegrid/database";
import { toOffsetDateTime } from "@tidegrid/domain-catalog";
import type { Insertable } from "kysely";
import {
  addOnAvailableOn,
  changeCutoffAt,
  normalizePromotionCode,
  type PartySelection,
  type PricedDiscount,
  priceQuote,
  type QuoteProblem,
} from "./compute.ts";
import {
  dateOnly,
  findPromotion,
  findTripForSale,
  loadPolicy,
  loadPriceList,
  loadTaxRates,
} from "./load.ts";
import type { Discount, PolicyVersion } from "./terms.ts";

/** How long a quote's prices hold for starting checkout. */
export const QUOTE_TTL_MINUTES = 30;

function instant(value: Date | string): string {
  return (typeof value === "string" ? new Date(value) : value).toISOString();
}

/** A policy version as the guest sees it for one trip. */
export function policyTerms(policy: PolicyVersion, tripStartsAtMs: number): PolicyTerms {
  return {
    version: policy.version,
    changeCutoffMinutes: policy.changeCutoffMinutes,
    changeCutoffAt: changeCutoffAt(policy, tripStartsAtMs).toISOString(),
    beforeCutoff: { ...policy.beforeCutoff },
    afterCutoff: { ...policy.afterCutoff },
    noShow: { ...policy.noShow },
    text: { ...policy.text },
  };
}

/** "HARBOR10, 10% off" or "REEF25, $25.00 off". */
export function discountLabel(code: string, discount: Discount): string {
  if (discount.kind === "percent") {
    const whole = Math.floor(discount.percentOffBp / 100);
    const rest = discount.percentOffBp % 100;
    const percent =
      rest === 0 ? `${whole}` : `${whole}.${String(rest).padStart(2, "0").replace(/0$/, "")}`;
    return `${code}, ${percent}% off`;
  }
  const dollars = Math.floor(discount.amountOff / 100).toLocaleString("en-US");
  const cents = String(discount.amountOff % 100).padStart(2, "0");
  return `${code}, $${dollars}.${cents} off`;
}

// Offer ---------------------------------------------------------------------------

export type TripOfferResult =
  | { kind: "offer"; offer: TripOffer }
  | { kind: "trip_not_found" }
  | { kind: "trip_not_on_sale" }
  | { kind: "pricing_unavailable" };

/**
 * What the operator sells for one bookable trip under its current versions:
 * ticket types or the charter price, the add-ons offered on the trip's date,
 * mandatory fees, active tax rates, and the policy.
 */
export async function getTripOffer(
  trx: TenantTransaction,
  tenantId: string,
  tripId: string,
  now: Date,
): Promise<TripOfferResult> {
  const found = await findTripForSale(trx, tenantId, tripId, now);
  if (found.kind === "not_found") return { kind: "trip_not_found" };
  if (found.kind === "not_on_sale") return { kind: "trip_not_on_sale" };
  const trip = found.trip;
  const priceList = await loadPriceList(trx, tenantId, trip.productId);
  const policy = await loadPolicy(trx, tenantId, trip.productId);
  if (!priceList || !policy || priceList.productKind !== trip.productKind) {
    return { kind: "pricing_unavailable" };
  }
  const taxRates = await loadTaxRates(trx, tenantId);
  return {
    kind: "offer",
    offer: {
      tripId: trip.tripId,
      product: {
        id: trip.productId,
        name: trip.productName,
        kind: trip.productKind,
        minPartySize: trip.minPartySize,
        maxPartySize: trip.maxPartySize,
      },
      trip: {
        timeZone: trip.timeZone,
        localDate: trip.localDate,
        localStartTime: trip.localStartTime,
        startsAt: trip.startsAt,
        startsAtLocal: trip.startsAtLocal,
      },
      currency: "USD",
      priceListVersion: priceList.version,
      tickets: priceList.tickets.map((t) => ({
        code: t.code,
        name: t.name,
        unitAmount: t.unitAmount,
        taxable: t.taxable,
      })),
      charter: priceList.charter ? { ...priceList.charter } : null,
      addOns: priceList.addOns
        .filter((a) => addOnAvailableOn(a, trip.localDate))
        .map((a) => ({
          code: a.code,
          name: a.name,
          unitAmount: a.unitAmount,
          quantityRule: a.quantityRule,
          maxQuantity: a.maxQuantity,
          taxable: a.taxable,
        })),
      fees: priceList.fees.map((f) => ({
        code: f.code,
        name: f.name,
        unitAmount: f.unitAmount,
        basis: f.basis,
        taxable: f.taxable,
      })),
      taxes: taxRates.map((r) => ({ name: r.name, ratePpm: r.ratePpm, inclusive: r.inclusive })),
      policy: policyTerms(policy, Date.parse(trip.startsAt)),
    },
  };
}

// Quotes --------------------------------------------------------------------------

export interface CreateQuoteInput {
  tripId: string;
  party: PartySelection;
  addOns: readonly { code: string; quantity: number }[];
  /** As the guest typed it, or null. */
  promotionCode: string | null;
  now: Date;
}

export type CreateQuoteResult =
  | { kind: "created"; quote: Quote }
  | { kind: "trip_not_found" }
  | { kind: "trip_not_on_sale" }
  | { kind: "rejected"; problems: QuoteProblem[] };

/**
 * Prices a party on a bookable trip under the current versions and stores the
 * result as an immutable quote: the versions it used, a snapshot of the trip,
 * every line, and the totals. The response is read back from what was stored.
 * Idempotency is the caller's: the API claims a key in the same transaction.
 */
export async function createQuote(
  trx: TenantTransaction,
  ctx: TenantContext,
  input: CreateQuoteInput,
): Promise<CreateQuoteResult> {
  const found = await findTripForSale(trx, ctx.tenantId, input.tripId, input.now);
  if (found.kind === "not_found") return { kind: "trip_not_found" };
  if (found.kind === "not_on_sale") return { kind: "trip_not_on_sale" };
  const trip = found.trip;
  const priceList = await loadPriceList(trx, ctx.tenantId, trip.productId);
  const policy = await loadPolicy(trx, ctx.tenantId, trip.productId);
  if (!priceList || !policy) {
    return { kind: "rejected", problems: [{ code: "pricing_unavailable" }] };
  }
  const taxRates = await loadTaxRates(trx, ctx.tenantId);
  const promotion =
    input.promotionCode === null
      ? null
      : await findPromotion(trx, ctx.tenantId, normalizePromotionCode(input.promotionCode));

  const outcome = priceQuote({
    nowMs: input.now.getTime(),
    subject: {
      productId: trip.productId,
      productKind: trip.productKind,
      localDate: trip.localDate,
      minPartySize: trip.minPartySize,
      maxPartySize: trip.maxPartySize,
      capacityRemaining: trip.capacityRemaining,
    },
    priceList,
    taxRates,
    promotion,
    selection: { party: input.party, addOns: input.addOns, promotionCode: input.promotionCode },
  });
  if (outcome.kind === "rejected") return { kind: "rejected", problems: outcome.problems };
  const priced = outcome.quote;
  const discount: PricedDiscount | null = priced.discount;

  const { id } = await trx
    .insertInto("quotes")
    .values({
      tenant_id: ctx.tenantId,
      trip_id: trip.tripId,
      product_id: trip.productId,
      product_kind: trip.productKind,
      product_name: trip.productName,
      trip_time_zone: trip.timeZone,
      trip_local_date: trip.localDate,
      trip_local_start_time: trip.exactLocalStartTime,
      trip_starts_at: trip.startsAt,
      trip_start_utc_offset_minutes: trip.startOffsetMinutes,
      price_list_version: priceList.version,
      policy_version: policy.version,
      promotion_id: discount?.promotionId ?? null,
      promotion_version: discount?.version ?? null,
      party_size: priced.partySize,
      subtotal_amount: priced.totals.subtotal,
      discount_amount: priced.totals.discount,
      fee_amount: priced.totals.fees,
      tax_amount: priced.totals.tax,
      included_tax_amount: priced.totals.includedTax,
      total_amount: priced.totals.total,
      quoted_at: input.now,
      expires_at: new Date(input.now.getTime() + QUOTE_TTL_MINUTES * 60_000),
    })
    .returning("id")
    .executeTakeFirstOrThrow();

  const lines: Insertable<QuoteLinesTable>[] = priced.lines.map((l) => ({
    tenant_id: ctx.tenantId,
    quote_id: id,
    line_no: l.lineNo,
    kind: l.kind,
    code: l.code,
    name: l.name,
    basis: l.basis,
    quantity: l.quantity,
    unit_amount: l.unitAmount,
    amount: l.amount,
    discount_amount: l.discountAmount,
    taxable: l.taxable,
  }));
  if (discount) {
    lines.push({
      tenant_id: ctx.tenantId,
      quote_id: id,
      line_no: discount.lineNo,
      kind: "discount",
      code: discount.code,
      name: discountLabel(discount.code, discount.discount),
      basis: null,
      quantity: 1,
      unit_amount: discount.amount,
      amount: -discount.amount,
      discount_amount: 0,
      taxable: false,
    });
  }
  await trx.insertInto("quote_lines").values(lines).execute();
  const taxes = priced.lines.flatMap((l) =>
    l.taxes.map((t) => ({
      tenant_id: ctx.tenantId,
      quote_id: id,
      line_no: l.lineNo,
      tax_rate_id: t.taxRateId,
      tax_rate_version: t.version,
      taxable_amount: t.taxableAmount,
      amount: t.amount,
    })),
  );
  if (taxes.length > 0) await trx.insertInto("quote_line_taxes").values(taxes).execute();

  const quote = await getQuote(trx, ctx.tenantId, id);
  if (!quote) throw new Error("quote vanished inside its own transaction");
  return { kind: "created", quote };
}

/**
 * A stored quote, exactly as it was priced. It reads only the snapshot and
 * the immutable versions it names, so later changes to prices, taxes,
 * promotions, policies, or the catalog never alter it.
 */
export async function getQuote(
  trx: TenantTransaction,
  tenantId: string,
  quoteId: string,
): Promise<Quote | null> {
  if (!isUuid(quoteId)) return null;
  const head = await trx
    .selectFrom("quotes")
    .selectAll()
    .where("tenant_id", "=", tenantId)
    .where("id", "=", quoteId)
    .executeTakeFirst();
  if (!head) return null;
  const lineRows = await trx
    .selectFrom("quote_lines")
    .selectAll()
    .where("tenant_id", "=", tenantId)
    .where("quote_id", "=", quoteId)
    .orderBy("line_no")
    .execute();
  const taxRows = await trx
    .selectFrom("quote_line_taxes as t")
    .innerJoin("tax_rate_versions as r", (j) =>
      j
        .onRef("r.tenant_id", "=", "t.tenant_id")
        .onRef("r.tax_rate_id", "=", "t.tax_rate_id")
        .onRef("r.version", "=", "t.tax_rate_version"),
    )
    .select([
      "t.line_no",
      "t.tax_rate_id",
      "t.tax_rate_version",
      "t.taxable_amount",
      "t.amount",
      "r.name",
      "r.rate_ppm",
      "r.inclusive",
    ])
    .where("t.tenant_id", "=", tenantId)
    .where("t.quote_id", "=", quoteId)
    .orderBy("t.line_no")
    .orderBy("r.name")
    .orderBy("t.tax_rate_id")
    .execute();
  const policy = await loadPolicy(trx, tenantId, head.product_id, head.policy_version);
  if (!policy) throw new Error("quote names a policy version that does not exist");
  const promotion =
    head.promotion_id === null || head.promotion_version === null
      ? null
      : await trx
          .selectFrom("promotions as p")
          .innerJoin("promotion_versions as v", (j) =>
            j.onRef("v.tenant_id", "=", "p.tenant_id").onRef("v.promotion_id", "=", "p.id"),
          )
          .select(["p.code", "v.version", "v.discount_kind", "v.amount_off", "v.percent_off_bp"])
          .where("p.tenant_id", "=", tenantId)
          .where("p.id", "=", head.promotion_id)
          .where("v.version", "=", head.promotion_version)
          .executeTakeFirstOrThrow();

  const lines: QuoteLine[] = lineRows.map((l) => ({
    lineNo: l.line_no,
    kind: l.kind,
    code: l.code,
    name: l.name,
    basis: l.basis,
    quantity: l.quantity,
    unitAmount: l.unit_amount,
    amount: l.amount,
    discountAmount: l.discount_amount,
    taxable: l.taxable,
    taxes: taxRows
      .filter((t) => t.line_no === l.line_no)
      .map((t) => ({
        taxRateId: t.tax_rate_id,
        name: t.name,
        ratePpm: t.rate_ppm,
        inclusive: t.inclusive,
        taxableAmount: t.taxable_amount,
        amount: t.amount,
      })),
  }));
  const taxes: QuoteTax[] = [];
  for (const t of [...taxRows].sort((a, b) =>
    a.name !== b.name ? (a.name < b.name ? -1 : 1) : a.tax_rate_id < b.tax_rate_id ? -1 : 1,
  )) {
    const total = taxes.find((x) => x.taxRateId === t.tax_rate_id);
    if (total) {
      total.taxableAmount += t.taxable_amount;
      total.amount += t.amount;
    } else {
      taxes.push({
        taxRateId: t.tax_rate_id,
        version: t.tax_rate_version,
        name: t.name,
        ratePpm: t.rate_ppm,
        inclusive: t.inclusive,
        taxableAmount: t.taxable_amount,
        amount: t.amount,
      });
    }
  }
  const localDate = dateOnly(head.trip_local_date);
  const localStartTime = head.trip_local_start_time.slice(0, 5);
  return {
    quoteId: head.id,
    tripId: head.trip_id,
    product: { id: head.product_id, name: head.product_name, kind: head.product_kind },
    trip: {
      timeZone: head.trip_time_zone,
      localDate,
      localStartTime,
      startsAt: instant(head.trip_starts_at),
      startsAtLocal: toOffsetDateTime(
        localDate,
        localStartTime,
        head.trip_start_utc_offset_minutes,
      ),
    },
    partySize: head.party_size,
    currency: "USD",
    priceListVersion: head.price_list_version,
    lines,
    taxes,
    promotion: promotion
      ? {
          code: promotion.code,
          version: promotion.version,
          discountKind: promotion.discount_kind,
          amountOff: promotion.amount_off,
          percentOffBp: promotion.percent_off_bp,
        }
      : null,
    totals: {
      subtotal: head.subtotal_amount,
      discount: head.discount_amount,
      fees: head.fee_amount,
      tax: head.tax_amount,
      includedTax: head.included_tax_amount,
      total: head.total_amount,
      amountDueNow: head.total_amount,
    },
    policy: policyTerms(policy, new Date(head.trip_starts_at).getTime()),
    quotedAt: instant(head.quoted_at),
    expiresAt: instant(head.expires_at),
  };
}
