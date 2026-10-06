import type { TenantContext, TenantTransaction } from "@tidegrid/database";
import { createPolicyVersion, createPriceListVersion } from "@tidegrid/domain-pricing";

/**
 * The least a product needs to publish since G2.5, through the real pricing
 * commands: one price list (an adult ticket or the charter price) and one
 * policy version.
 */
export async function addSaleTerms(
  trx: TenantTransaction,
  ctx: TenantContext,
  productId: string,
): Promise<void> {
  const { kind } = await trx
    .selectFrom("products")
    .select("kind")
    .where("tenant_id", "=", ctx.tenantId)
    .where("id", "=", productId)
    .executeTakeFirstOrThrow();
  const price = await createPriceListVersion(trx, ctx, {
    productId,
    ...(kind === "shared_seat"
      ? { tickets: [{ code: "adult", name: "Adult", unitAmount: 5000, taxable: true }] }
      : { charter: { name: "Whole boat", amount: 100000, taxable: true } }),
    reason: "fixture",
  });
  if (price.kind !== "created") throw new Error(`fixture price list: ${JSON.stringify(price)}`);
  const policy = await createPolicyVersion(trx, ctx, {
    productId,
    changeCutoffMinutes: 1440,
    beforeCutoff: { remedy: "full_refund" },
    afterCutoff: { remedy: "none" },
    noShow: { remedy: "none" },
    text: {
      cancellation: "Fixture cancellation terms.",
      reschedule: "Fixture reschedule terms.",
      noShow: "Fixture no-show terms.",
      operatorCancellation: "Fixture operator cancellation terms.",
      weather: "Fixture weather terms.",
    },
    reason: "fixture",
  });
  if (policy.kind !== "created") throw new Error(`fixture policy: ${JSON.stringify(policy)}`);
}
