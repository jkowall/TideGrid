import type { TenantContext, TenantTransaction } from "@tidegrid/database";

/**
 * Test fixture only: the least a product needs to publish since G2.5, one
 * price list version and one policy version, written directly so the catalog
 * tests do not depend on the pricing package (which depends on this one).
 * Real terms go through the commands in @tidegrid/domain-pricing.
 */
export async function addMinimalSaleTerms(
  trx: TenantTransaction,
  ctx: TenantContext,
  productId: string,
): Promise<void> {
  const product = await trx
    .selectFrom("products")
    .select("kind")
    .where("tenant_id", "=", ctx.tenantId)
    .where("id", "=", productId)
    .executeTakeFirstOrThrow();
  const version = {
    tenant_id: ctx.tenantId,
    product_id: productId,
    version: 1,
    product_kind: product.kind,
  };
  await trx
    .insertInto("price_list_versions")
    .values({ ...version, reason: "fixture" })
    .execute();
  await trx
    .insertInto("price_list_items")
    .values({
      ...version,
      item_kind: product.kind === "shared_seat" ? "ticket" : "charter",
      code: product.kind === "shared_seat" ? "adult" : "charter",
      name: product.kind === "shared_seat" ? "Adult" : "Whole boat",
      unit_amount: product.kind === "shared_seat" ? 5000 : 100000,
      taxable: false,
      sort_order: 0,
    })
    .execute();
  await trx
    .insertInto("policy_versions")
    .values({
      tenant_id: ctx.tenantId,
      product_id: productId,
      version: 1,
      change_cutoff_minutes: 1440,
      before_cutoff_remedy: "full_refund",
      after_cutoff_remedy: "none",
      no_show_remedy: "none",
      cancellation_text: "Fixture cancellation terms.",
      reschedule_text: "Fixture reschedule terms.",
      no_show_text: "Fixture no-show terms.",
      operator_cancellation_text: "Fixture operator cancellation terms.",
      weather_text: "Fixture weather terms.",
      reason: "fixture",
    })
    .execute();
}
