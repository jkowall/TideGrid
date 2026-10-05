/**
 * Synthetic commercial terms for the demo operators (G2.5): each product's
 * price list and policy, each operator's tax rates, and one promotion code
 * per operator. Everything goes through the pricing commands, so seeded terms
 * pass the same validation and audit a console will.
 *
 * Idempotent. A product that already has a price list or policy keeps it, a
 * tax rate is matched by name, and a promotion by code. Demo Harbor adds its
 * taxes on top of prices; Demo Reef's prices include its tax, so the demo
 * shows both treatments. Names and rates are synthetic.
 */
import {
  createDb,
  inTenantTransaction,
  type TenantContext,
  type TenantTransaction,
} from "@tidegrid/database";
import {
  createPolicyVersion,
  createPriceListVersion,
  createPromotion,
  createTaxRate,
  type PolicyInput,
  type PriceListInput,
} from "@tidegrid/domain-pricing";

const REASON = "Synthetic demo pricing";

interface TermsPlan {
  priceList: PriceListInput;
  policy: PolicyInput;
}

interface PricingPlan {
  taxRates: { name: string; ratePpm: number; inclusive: boolean }[];
  promotion: {
    code: string;
    discount:
      | { kind: "percent"; percentOffBp: number }
      | { kind: "fixed_amount"; amountOff: number };
    startsAt: string;
    endsAt: string;
    /** Product names, or every product. */
    products: "all" | string[];
  };
  /** Terms by product name, as the catalog seed names products. */
  products: Record<string, TermsPlan>;
}

const policyText = (hours: number, late: string) => ({
  cancellation: `Cancel at least ${hours} hours before departure for a full refund. ${late}`,
  reschedule: `Move to another departure at least ${hours} hours before your trip, subject to space.`,
  noShow: "Guests who miss the departure are not refunded.",
  operatorCancellation:
    "If we cancel, you choose a full refund to your original payment or a credit for a future trip.",
  weather:
    "The captain decides on the day whether conditions allow the trip. If we cancel for weather, the operator cancellation terms apply.",
});

const plans: Record<string, PricingPlan> = {
  "demo-harbor": {
    taxRates: [
      { name: "State sales tax", ratePpm: 60_000, inclusive: false },
      { name: "County surtax", ratePpm: 10_000, inclusive: false },
    ],
    promotion: {
      code: "HARBOR10",
      discount: { kind: "percent", percentOffBp: 1000 },
      startsAt: "2026-09-01T00:00:00-04:00",
      endsAt: "2027-06-01T00:00:00-04:00",
      products: "all",
    },
    products: {
      "Sunset Harbor Cruise": {
        priceList: {
          tickets: [
            { code: "adult", name: "Adult", unitAmount: 4500, taxable: true },
            { code: "child", name: "Child (3 to 12)", unitAmount: 2500, taxable: true },
            { code: "infant", name: "Infant (under 3)", unitAmount: 0, taxable: false },
          ],
          fees: [
            {
              code: "harbor_fee",
              name: "Harbor fee",
              unitAmount: 250,
              basis: "per_participant",
              taxable: false,
            },
          ],
          addOns: [
            {
              code: "photo",
              name: "Souvenir photo",
              unitAmount: 1200,
              quantityRule: "per_booking",
              maxQuantity: 2,
              taxable: true,
            },
            {
              code: "drinks",
              name: "Drink voucher",
              unitAmount: 800,
              quantityRule: "per_participant",
              maxQuantity: 2,
              taxable: true,
            },
            {
              code: "holiday_toast",
              name: "Holiday toast",
              unitAmount: 1500,
              quantityRule: "per_participant",
              maxQuantity: 1,
              taxable: true,
              availableFrom: "2026-12-15",
              availableUntil: "2027-01-02",
            },
          ],
        },
        policy: {
          changeCutoffMinutes: 1440,
          beforeCutoff: { remedy: "full_refund" },
          afterCutoff: { remedy: "none" },
          noShow: { remedy: "none" },
          text: policyText(24, "Later cancellations are not refunded."),
        },
      },
      "Private Half-Day Charter": {
        priceList: {
          charter: { name: "Whole boat, up to 12 guests", amount: 120_000, taxable: true },
          fees: [
            {
              code: "fuel",
              name: "Fuel surcharge",
              unitAmount: 7500,
              basis: "per_booking",
              taxable: true,
            },
          ],
          addOns: [
            {
              code: "lunch",
              name: "Catered lunch",
              unitAmount: 2500,
              quantityRule: "per_participant",
              maxQuantity: 1,
              taxable: true,
            },
            {
              code: "tackle",
              name: "Fishing tackle",
              unitAmount: 1500,
              quantityRule: "per_participant",
              maxQuantity: 1,
              taxable: true,
            },
          ],
        },
        policy: {
          changeCutoffMinutes: 10_080,
          beforeCutoff: { remedy: "full_refund" },
          afterCutoff: { remedy: "credit" },
          noShow: { remedy: "none" },
          text: policyText(
            168,
            "Later cancellations receive a credit for a future charter instead of a refund.",
          ),
        },
      },
    },
  },
  "demo-reef": {
    taxRates: [{ name: "General excise tax", ratePpm: 47_120, inclusive: true }],
    promotion: {
      code: "REEF25",
      discount: { kind: "fixed_amount", amountOff: 2500 },
      startsAt: "2026-09-01T00:00:00-10:00",
      endsAt: "2027-06-01T00:00:00-10:00",
      products: ["Two-Tank Morning Dive", "Afternoon Snorkel Sail"],
    },
    products: {
      "Two-Tank Morning Dive": {
        priceList: {
          tickets: [{ code: "diver", name: "Certified diver", unitAmount: 16_500, taxable: true }],
          fees: [
            {
              code: "park_fee",
              name: "Marine park fee",
              unitAmount: 1000,
              basis: "per_participant",
              taxable: false,
            },
          ],
          addOns: [
            {
              code: "gear",
              name: "Full gear rental",
              unitAmount: 3500,
              quantityRule: "per_participant",
              maxQuantity: 1,
              taxable: true,
            },
            {
              code: "nitrox",
              name: "Nitrox fills",
              unitAmount: 2000,
              quantityRule: "per_participant",
              maxQuantity: 1,
              taxable: true,
            },
          ],
        },
        policy: {
          changeCutoffMinutes: 2880,
          beforeCutoff: { remedy: "full_refund" },
          afterCutoff: { remedy: "percent_refund", refundBp: 5000 },
          noShow: { remedy: "none" },
          text: policyText(48, "Later cancellations are refunded at 50%."),
        },
      },
      "Afternoon Snorkel Sail": {
        priceList: {
          tickets: [
            { code: "adult", name: "Adult", unitAmount: 8900, taxable: true },
            { code: "child", name: "Child (5 to 12)", unitAmount: 5900, taxable: true },
          ],
          fees: [
            {
              code: "park_fee",
              name: "Marine park fee",
              unitAmount: 1000,
              basis: "per_participant",
              taxable: false,
            },
          ],
          addOns: [
            {
              code: "snorkel_set",
              name: "Snorkel set rental",
              unitAmount: 1000,
              quantityRule: "per_participant",
              maxQuantity: 1,
              taxable: true,
            },
            {
              code: "sunscreen",
              name: "Reef-safe sunscreen",
              unitAmount: 1400,
              quantityRule: "per_booking",
              maxQuantity: 3,
              taxable: true,
            },
          ],
        },
        policy: {
          changeCutoffMinutes: 1440,
          beforeCutoff: { remedy: "full_refund" },
          afterCutoff: { remedy: "credit" },
          noShow: { remedy: "none" },
          text: policyText(24, "Later cancellations receive a credit for a future trip."),
        },
      },
      "Private Dive Charter": {
        priceList: {
          charter: { name: "Whole boat, up to 6 divers", amount: 165_000, taxable: true },
          fees: [
            {
              code: "park_fee",
              name: "Marine park fee",
              unitAmount: 1000,
              basis: "per_participant",
              taxable: false,
            },
          ],
          addOns: [
            {
              code: "photographer",
              name: "Underwater photographer",
              unitAmount: 25_000,
              quantityRule: "per_booking",
              maxQuantity: 1,
              taxable: true,
            },
            {
              code: "whale_watch",
              name: "Whale-watch extension",
              unitAmount: 6000,
              quantityRule: "per_participant",
              maxQuantity: 1,
              taxable: true,
              availableFrom: "2026-12-15",
              availableUntil: "2027-04-15",
            },
          ],
        },
        policy: {
          changeCutoffMinutes: 10_080,
          beforeCutoff: { remedy: "full_refund" },
          afterCutoff: { remedy: "percent_refund", refundBp: 5000 },
          noShow: { remedy: "none" },
          text: policyText(168, "Later cancellations are refunded at 50%."),
        },
      },
    },
  },
};

/** What a seed run added. */
export interface PricingSeedCounts {
  priceLists: number;
  policies: number;
  taxRates: number;
  promotions: number;
}

/**
 * Adds a product's price list and policy when it has none. The catalog seed
 * calls this before publishing a product, which needs both since G2.5.
 */
export async function seedProductTerms(
  trx: TenantTransaction,
  ctx: TenantContext,
  tenantSlug: string,
  productName: string,
  productId: string,
  counts?: PricingSeedCounts,
): Promise<void> {
  const plan = plans[tenantSlug]?.products[productName];
  if (!plan) throw new Error(`no seed pricing for ${tenantSlug} product ${productName}`);
  const hasPrice = await trx
    .selectFrom("price_list_versions")
    .select("version")
    .where("tenant_id", "=", ctx.tenantId)
    .where("product_id", "=", productId)
    .executeTakeFirst();
  if (!hasPrice) {
    const created = await createPriceListVersion(trx, ctx, {
      ...plan.priceList,
      productId,
      reason: REASON,
    });
    if (created.kind !== "created") {
      throw new Error(`seed price list for ${productName} failed: ${JSON.stringify(created)}`);
    }
    if (counts) counts.priceLists += 1;
  }
  const hasPolicy = await trx
    .selectFrom("policy_versions")
    .select("version")
    .where("tenant_id", "=", ctx.tenantId)
    .where("product_id", "=", productId)
    .executeTakeFirst();
  if (!hasPolicy) {
    const created = await createPolicyVersion(trx, ctx, {
      ...plan.policy,
      productId,
      reason: REASON,
    });
    if (created.kind !== "created") {
      throw new Error(`seed policy for ${productName} failed: ${JSON.stringify(created)}`);
    }
    if (counts) counts.policies += 1;
  }
}

/**
 * Brings every demo operator's terms up to the plan: product terms for
 * products seeded before G2.5, then tax rates and the promotion code.
 */
export async function seedPricing(
  url: string,
  tenants: readonly { id: string; slug: string }[],
): Promise<PricingSeedCounts> {
  const counts: PricingSeedCounts = { priceLists: 0, policies: 0, taxRates: 0, promotions: 0 };
  const { db, end } = createDb(url, { max: 1 });
  try {
    for (const tenant of tenants) {
      const plan = plans[tenant.slug];
      if (!plan) continue;
      const ctx: TenantContext = { tenantId: tenant.id, actorType: "system", actorId: "seed" };
      await inTenantTransaction(db, ctx, async (trx) => {
        const products = await trx
          .selectFrom("products")
          .select(["id", "name"])
          .where("tenant_id", "=", tenant.id)
          .execute();
        const productId = (name: string) => {
          const found = products.find((p) => p.name === name);
          if (!found) throw new Error(`seed pricing names unknown product ${name}`);
          return found.id;
        };
        for (const name of Object.keys(plan.products)) {
          await seedProductTerms(trx, ctx, tenant.slug, name, productId(name), counts);
        }

        const existingRates = await trx
          .selectFrom("tax_rate_versions")
          .select("name")
          .where("tenant_id", "=", tenant.id)
          .execute();
        for (const rate of plan.taxRates) {
          if (existingRates.some((r) => r.name === rate.name)) continue;
          const created = await createTaxRate(trx, ctx, { ...rate, reason: REASON });
          if (created.kind !== "created") {
            throw new Error(`seed tax rate ${rate.name} failed: ${JSON.stringify(created)}`);
          }
          counts.taxRates += 1;
        }

        const promo = plan.promotion;
        const exists = await trx
          .selectFrom("promotions")
          .select("id")
          .where("tenant_id", "=", tenant.id)
          .where("code", "=", promo.code)
          .executeTakeFirst();
        if (!exists) {
          const created = await createPromotion(trx, ctx, {
            code: promo.code,
            discount: promo.discount,
            startsAt: new Date(promo.startsAt),
            endsAt: new Date(promo.endsAt),
            products:
              promo.products === "all"
                ? { all: true }
                : { productIds: promo.products.map(productId) },
            reason: REASON,
          });
          if (created.kind !== "created") {
            throw new Error(`seed promotion ${promo.code} failed: ${JSON.stringify(created)}`);
          }
          counts.promotions += 1;
        }
      });
    }
    console.log(
      `seeded pricing: ${counts.priceLists} price list(s) and ${counts.policies} policy version(s) backfilled for products created earlier, ${counts.taxRates} tax rate(s) and ${counts.promotions} promotion(s) added`,
    );
    return counts;
  } finally {
    await end();
  }
}
