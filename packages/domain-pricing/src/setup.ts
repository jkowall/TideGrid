import { recordAudit, type TenantContext, type TenantTransaction } from "@tidegrid/database";
import { sql } from "kysely";
import { normalizePromotionCode } from "./compute.ts";
import type { Discount } from "./terms.ts";
import {
  isPromotionCode,
  isReason,
  type PolicyInput,
  type PriceListInput,
  type PromotionTermsInput,
  type TaxRateInput,
  type TermsProblem,
  validatePolicy,
  validatePriceList,
  validatePromotionTerms,
  validateTaxRate,
} from "./validate.ts";

/**
 * Commands that append a version of a product's price list or policy, a tax
 * rate, or a promotion. Nothing is ever edited: a change is a new version,
 * and the highest version is current. The seed configures the demo through
 * these, so seeded terms pass the same validation a console will. Staff
 * endpoints for them arrive with the console goal.
 *
 * Each command takes a per-aggregate transaction lock before reading the
 * current version, so two concurrent changes get consecutive versions instead
 * of one failing on the key. Each records an audit event.
 */

export type VersionResult =
  | { kind: "created"; version: number }
  | { kind: "not_found" }
  | { kind: "invalid"; problems: TermsProblem[] };

async function lock(trx: TenantTransaction, key: string): Promise<void> {
  await sql`select pg_advisory_xact_lock(hashtextextended(${key}, 0))`.execute(trx);
}

function withReason(problems: TermsProblem[], reason: string): TermsProblem[] {
  return isReason(reason) ? problems : [...problems, "invalid_reason"];
}

/** Appends a product's next price list version: its tickets or charter price, fees, and add-ons. */
export async function createPriceListVersion(
  trx: TenantTransaction,
  ctx: TenantContext,
  input: PriceListInput & { productId: string; reason: string },
): Promise<VersionResult> {
  const product = await trx
    .selectFrom("products")
    .select(["id", "kind"])
    .where("tenant_id", "=", ctx.tenantId)
    .where("id", "=", input.productId)
    .executeTakeFirst();
  if (!product) return { kind: "not_found" };
  const problems = withReason(validatePriceList(product.kind, input), input.reason);
  if (problems.length > 0) return { kind: "invalid", problems };

  await lock(trx, `tidegrid.price_list:${ctx.tenantId}:${product.id}`);
  const current = await trx
    .selectFrom("price_list_versions")
    .select((eb) => eb.fn.max("version").as("version"))
    .where("tenant_id", "=", ctx.tenantId)
    .where("product_id", "=", product.id)
    .executeTakeFirst();
  const version = (current?.version ?? 0) + 1;
  await trx
    .insertInto("price_list_versions")
    .values({
      tenant_id: ctx.tenantId,
      product_id: product.id,
      version,
      product_kind: product.kind,
      reason: input.reason,
    })
    .execute();
  const base = {
    tenant_id: ctx.tenantId,
    product_id: product.id,
    version,
    product_kind: product.kind,
  };
  const items = [
    ...(input.tickets ?? []).map((t, i) => ({
      ...base,
      item_kind: "ticket" as const,
      code: t.code,
      name: t.name,
      unit_amount: t.unitAmount,
      taxable: t.taxable,
      sort_order: i,
    })),
    ...(input.charter
      ? [
          {
            ...base,
            item_kind: "charter" as const,
            code: "charter",
            name: input.charter.name,
            unit_amount: input.charter.amount,
            taxable: input.charter.taxable,
            sort_order: 0,
          },
        ]
      : []),
    ...(input.fees ?? []).map((f, i) => ({
      ...base,
      item_kind: "fee" as const,
      code: f.code,
      name: f.name,
      unit_amount: f.unitAmount,
      taxable: f.taxable,
      basis: f.basis,
      sort_order: i,
    })),
    ...(input.addOns ?? []).map((a, i) => ({
      ...base,
      item_kind: "add_on" as const,
      code: a.code,
      name: a.name,
      unit_amount: a.unitAmount,
      taxable: a.taxable,
      basis: a.quantityRule,
      max_quantity: a.maxQuantity,
      available_from: a.availableFrom ?? null,
      available_until: a.availableUntil ?? null,
      sort_order: i,
    })),
  ];
  await trx.insertInto("price_list_items").values(items).execute();
  await recordAudit(trx, ctx, {
    action: "price_list.version_created",
    subjectType: "product",
    subjectId: product.id,
    reason: input.reason,
    after: {
      version,
      tickets: (input.tickets ?? []).map((t) => ({ code: t.code, unitAmount: t.unitAmount })),
      charterAmount: input.charter?.amount ?? null,
      fees: (input.fees ?? []).map((f) => ({ code: f.code, unitAmount: f.unitAmount })),
      addOns: (input.addOns ?? []).map((a) => ({ code: a.code, unitAmount: a.unitAmount })),
    },
  });
  return { kind: "created", version };
}

/** Appends a product's next policy version. */
export async function createPolicyVersion(
  trx: TenantTransaction,
  ctx: TenantContext,
  input: PolicyInput & { productId: string; reason: string },
): Promise<VersionResult> {
  const product = await trx
    .selectFrom("products")
    .select("id")
    .where("tenant_id", "=", ctx.tenantId)
    .where("id", "=", input.productId)
    .executeTakeFirst();
  if (!product) return { kind: "not_found" };
  const problems = withReason(validatePolicy(input), input.reason);
  if (problems.length > 0) return { kind: "invalid", problems };

  await lock(trx, `tidegrid.policy:${ctx.tenantId}:${product.id}`);
  const current = await trx
    .selectFrom("policy_versions")
    .select((eb) => eb.fn.max("version").as("version"))
    .where("tenant_id", "=", ctx.tenantId)
    .where("product_id", "=", product.id)
    .executeTakeFirst();
  const version = (current?.version ?? 0) + 1;
  await trx
    .insertInto("policy_versions")
    .values({
      tenant_id: ctx.tenantId,
      product_id: product.id,
      version,
      change_cutoff_minutes: input.changeCutoffMinutes,
      before_cutoff_remedy: input.beforeCutoff.remedy,
      before_cutoff_refund_bp: input.beforeCutoff.refundBp ?? null,
      after_cutoff_remedy: input.afterCutoff.remedy,
      after_cutoff_refund_bp: input.afterCutoff.refundBp ?? null,
      no_show_remedy: input.noShow.remedy,
      no_show_refund_bp: input.noShow.refundBp ?? null,
      cancellation_text: input.text.cancellation,
      reschedule_text: input.text.reschedule,
      no_show_text: input.text.noShow,
      operator_cancellation_text: input.text.operatorCancellation,
      weather_text: input.text.weather,
      reason: input.reason,
    })
    .execute();
  await recordAudit(trx, ctx, {
    action: "policy.version_created",
    subjectType: "product",
    subjectId: product.id,
    reason: input.reason,
    after: {
      version,
      changeCutoffMinutes: input.changeCutoffMinutes,
      beforeCutoff: input.beforeCutoff.remedy,
      afterCutoff: input.afterCutoff.remedy,
      noShow: input.noShow.remedy,
    },
  });
  return { kind: "created", version };
}

export type CreateTaxRateResult =
  | { kind: "created"; taxRateId: string; version: number }
  | { kind: "invalid"; problems: TermsProblem[] };

/** A new tax rate, active from its first version. */
export async function createTaxRate(
  trx: TenantTransaction,
  ctx: TenantContext,
  input: TaxRateInput & { reason: string },
): Promise<CreateTaxRateResult> {
  const problems = withReason(validateTaxRate(input), input.reason);
  if (problems.length > 0) return { kind: "invalid", problems };
  // Web Crypto, available in Node and in Workers alike.
  const taxRateId = crypto.randomUUID();
  await insertTaxRateVersion(trx, ctx, { ...input, taxRateId, version: 1, active: true });
  return { kind: "created", taxRateId, version: 1 };
}

/** The next version of a tax rate; `active: false` retires it. */
export async function createTaxRateVersion(
  trx: TenantTransaction,
  ctx: TenantContext,
  input: TaxRateInput & { taxRateId: string; active: boolean; reason: string },
): Promise<VersionResult> {
  const problems = withReason(validateTaxRate(input), input.reason);
  if (problems.length > 0) return { kind: "invalid", problems };
  await lock(trx, `tidegrid.tax_rate:${ctx.tenantId}:${input.taxRateId}`);
  const current = await trx
    .selectFrom("tax_rate_versions")
    .select((eb) => eb.fn.max("version").as("version"))
    .where("tenant_id", "=", ctx.tenantId)
    .where("tax_rate_id", "=", input.taxRateId)
    .executeTakeFirst();
  if (!current?.version) return { kind: "not_found" };
  const version = current.version + 1;
  await insertTaxRateVersion(trx, ctx, { ...input, version });
  return { kind: "created", version };
}

async function insertTaxRateVersion(
  trx: TenantTransaction,
  ctx: TenantContext,
  input: TaxRateInput & { taxRateId: string; version: number; active: boolean; reason: string },
): Promise<void> {
  await trx
    .insertInto("tax_rate_versions")
    .values({
      tenant_id: ctx.tenantId,
      tax_rate_id: input.taxRateId,
      version: input.version,
      name: input.name,
      rate_ppm: input.ratePpm,
      inclusive: input.inclusive,
      active: input.active,
      reason: input.reason,
    })
    .execute();
  await recordAudit(trx, ctx, {
    action: "tax_rate.version_created",
    subjectType: "tax_rate",
    subjectId: input.taxRateId,
    reason: input.reason,
    after: {
      version: input.version,
      name: input.name,
      ratePpm: input.ratePpm,
      inclusive: input.inclusive,
      active: input.active,
    },
  });
}

export type CreatePromotionResult =
  | { kind: "created"; promotionId: string; version: number }
  | { kind: "code_taken" }
  | { kind: "invalid"; problems: TermsProblem[] };

/** Checks that every named product belongs to this tenant. */
async function productsExist(
  trx: TenantTransaction,
  tenantId: string,
  input: PromotionTermsInput,
): Promise<boolean> {
  if ("all" in input.products) return true;
  const ids = [...input.products.productIds];
  const found = await trx
    .selectFrom("products")
    .select("id")
    .where("tenant_id", "=", tenantId)
    .where("id", "in", ids)
    .execute();
  return found.length === ids.length;
}

/** A new promotion code with its first terms. Codes are stored upper case and never change. */
export async function createPromotion(
  trx: TenantTransaction,
  ctx: TenantContext,
  input: PromotionTermsInput & { code: string; reason: string },
): Promise<CreatePromotionResult> {
  const code = normalizePromotionCode(input.code);
  const problems = withReason(validatePromotionTerms(input), input.reason);
  if (!isPromotionCode(code)) problems.unshift("invalid_code");
  if (problems.length === 0 && !(await productsExist(trx, ctx.tenantId, input))) {
    problems.push("invalid_products");
  }
  if (problems.length > 0) return { kind: "invalid", problems };

  await lock(trx, `tidegrid.promotion_code:${ctx.tenantId}:${code}`);
  const taken = await trx
    .selectFrom("promotions")
    .select("id")
    .where("tenant_id", "=", ctx.tenantId)
    .where("code", "=", code)
    .executeTakeFirst();
  if (taken) return { kind: "code_taken" };
  const { id } = await trx
    .insertInto("promotions")
    .values({ tenant_id: ctx.tenantId, code })
    .returning("id")
    .executeTakeFirstOrThrow();
  await insertPromotionVersion(trx, ctx, { ...input, promotionId: id, version: 1, active: true });
  await recordAudit(trx, ctx, {
    action: "promotion.created",
    subjectType: "promotion",
    subjectId: id,
    reason: input.reason,
    after: { code },
  });
  return { kind: "created", promotionId: id, version: 1 };
}

/** The next version of a promotion's terms; `active: false` retires the code. */
export async function createPromotionVersion(
  trx: TenantTransaction,
  ctx: TenantContext,
  input: PromotionTermsInput & { promotionId: string; active: boolean; reason: string },
): Promise<VersionResult> {
  const problems = withReason(validatePromotionTerms(input), input.reason);
  if (problems.length === 0 && !(await productsExist(trx, ctx.tenantId, input))) {
    problems.push("invalid_products");
  }
  if (problems.length > 0) return { kind: "invalid", problems };
  await lock(trx, `tidegrid.promotion:${ctx.tenantId}:${input.promotionId}`);
  const current = await trx
    .selectFrom("promotion_versions")
    .select((eb) => eb.fn.max("version").as("version"))
    .where("tenant_id", "=", ctx.tenantId)
    .where("promotion_id", "=", input.promotionId)
    .executeTakeFirst();
  if (!current?.version) return { kind: "not_found" };
  const version = current.version + 1;
  await insertPromotionVersion(trx, ctx, { ...input, version });
  return { kind: "created", version };
}

async function insertPromotionVersion(
  trx: TenantTransaction,
  ctx: TenantContext,
  input: PromotionTermsInput & {
    promotionId: string;
    version: number;
    active: boolean;
    reason: string;
  },
): Promise<void> {
  const d: Discount = input.discount;
  const all = "all" in input.products;
  await trx
    .insertInto("promotion_versions")
    .values({
      tenant_id: ctx.tenantId,
      promotion_id: input.promotionId,
      version: input.version,
      discount_kind: d.kind,
      amount_off: d.kind === "fixed_amount" ? d.amountOff : null,
      percent_off_bp: d.kind === "percent" ? d.percentOffBp : null,
      starts_at: input.startsAt,
      ends_at: input.endsAt,
      applies_to_all_products: all,
      active: input.active,
      reason: input.reason,
    })
    .execute();
  if (!("all" in input.products)) {
    await trx
      .insertInto("promotion_version_products")
      .values(
        input.products.productIds.map((productId) => ({
          tenant_id: ctx.tenantId,
          promotion_id: input.promotionId,
          version: input.version,
          product_id: productId,
        })),
      )
      .execute();
  }
  await recordAudit(trx, ctx, {
    action: "promotion.version_created",
    subjectType: "promotion",
    subjectId: input.promotionId,
    reason: input.reason,
    after: {
      version: input.version,
      discount: { ...d },
      startsAt: input.startsAt.toISOString(),
      endsAt: input.endsAt.toISOString(),
      products: "all" in input.products ? "all" : [...input.products.productIds],
      active: input.active,
    },
  });
}
