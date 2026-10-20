/**
 * Waiver templates and their immutable versions. A template applies to every
 * product of the operator (scope operator) or to one product (scope product),
 * which takes precedence. Publishing appends a version; nothing is ever
 * edited. The applicable version for a product is the highest version in
 * effect now of its product template, or else of the operator template.
 */
import {
  enqueueOutbox,
  isUuid,
  recordAudit,
  type TenantContext,
  type TenantTransaction,
} from "@tidegrid/database";
import { sql } from "kysely";
import {
  normalizeWaiverText,
  validateWaiverText,
  type WaiverText,
  type WaiverTextProblem,
} from "./content.ts";
import { RENDERING_VERSION } from "./render.ts";

export type TemplateScopeInput = { scope: "operator" } | { scope: "product"; productId: string };

export type CreateTemplateResult =
  | { kind: "created"; templateId: string }
  /** The operator, or the product, already has a template; it is returned unchanged. */
  | { kind: "exists"; templateId: string }
  | { kind: "product_not_found" }
  | { kind: "invalid"; message: string };

async function lock(trx: TenantTransaction, key: string): Promise<void> {
  await sql`select pg_advisory_xact_lock(hashtextextended(${key}, 0))`.execute(trx);
}

function isReason(reason: string): boolean {
  return reason.trim().length >= 1 && reason.length <= 500;
}

/** A template for the operator or one product; one each, ever. */
export async function createWaiverTemplate(
  trx: TenantTransaction,
  ctx: TenantContext,
  input: TemplateScopeInput & { name: string; reason: string },
): Promise<CreateTemplateResult> {
  const name = input.name.normalize("NFC").replace(/\s+/g, " ").trim();
  if (name.length < 1 || name.length > 80) {
    return { kind: "invalid", message: "A template name is 1 to 80 characters" };
  }
  if (!isReason(input.reason)) return { kind: "invalid", message: "Give a reason" };
  const productId = input.scope === "product" ? input.productId : null;
  if (productId !== null) {
    if (!isUuid(productId)) return { kind: "product_not_found" };
    const product = await trx
      .selectFrom("products")
      .select("id")
      .where("tenant_id", "=", ctx.tenantId)
      .where("id", "=", productId)
      .executeTakeFirst();
    if (!product) return { kind: "product_not_found" };
  }
  await lock(trx, `tidegrid.waiver_templates:${ctx.tenantId}`);
  const existing = await trx
    .selectFrom("waiver_templates")
    .select("id")
    .where("tenant_id", "=", ctx.tenantId)
    .where("scope", "=", input.scope)
    .$if(productId !== null, (q) => q.where("product_id", "=", productId as string))
    .executeTakeFirst();
  if (existing) return { kind: "exists", templateId: existing.id };
  const created = await trx
    .insertInto("waiver_templates")
    .values({
      tenant_id: ctx.tenantId,
      scope: input.scope,
      product_id: productId,
      name,
      reason: input.reason,
    })
    .returning("id")
    .executeTakeFirstOrThrow();
  await recordAudit(trx, ctx, {
    action: "waiver_template.created",
    subjectType: "waiver_template",
    subjectId: created.id,
    reason: input.reason,
    after: { scope: input.scope, productId },
  });
  return { kind: "created", templateId: created.id };
}

export interface PublishVersionInput {
  templateId: string;
  text: WaiverText;
  /** When it takes effect; never earlier than now. Defaults to now. */
  effectiveFrom?: Date;
  effectiveUntil?: Date | null;
  reason: string;
}

export type PublishVersionResult =
  | {
      kind: "published";
      version: number;
      contentSha256: string;
      effectiveFrom: Date;
    }
  | { kind: "not_found" }
  | {
      kind: "invalid";
      problems: (WaiverTextProblem | { field: string; code: string; message: string })[];
    };

/**
 * Append the next version of a template. The database numbers it, stamps its
 * hash, and refuses an edit of any earlier version for every role. To move
 * unsigned requests to it as well, call reassignUnsignedRequests (supersede.ts)
 * after this transaction commits.
 */
export async function publishWaiverTemplateVersion(
  trx: TenantTransaction,
  ctx: TenantContext,
  input: PublishVersionInput,
): Promise<PublishVersionResult> {
  if (!isUuid(input.templateId)) return { kind: "not_found" };
  const template = await trx
    .selectFrom("waiver_templates")
    .select(["id"])
    .where("tenant_id", "=", ctx.tenantId)
    .where("id", "=", input.templateId)
    .executeTakeFirst();
  if (!template) return { kind: "not_found" };
  const text = normalizeWaiverText(input.text);
  const problems: PublishVersionResult & { kind: "invalid" } = {
    kind: "invalid",
    problems: validateWaiverText(text),
  };
  if (!isReason(input.reason)) {
    problems.problems.push({ field: "reason", code: "required", message: "Give a reason" });
  }
  if (input.effectiveUntil && input.effectiveFrom && input.effectiveUntil <= input.effectiveFrom) {
    problems.problems.push({
      field: "effectiveUntil",
      code: "before_start",
      message: "A version ends after it takes effect",
    });
  }
  if (problems.problems.length > 0) return problems;

  await lock(trx, `tidegrid.waiver_template:${ctx.tenantId}:${template.id}`);
  const current = await trx
    .selectFrom("waiver_template_versions")
    .select((eb) => eb.fn.max("version").as("version"))
    .where("tenant_id", "=", ctx.tenantId)
    .where("template_id", "=", template.id)
    .executeTakeFirst();
  const version = (current?.version ?? 0) + 1;
  const row = await trx
    .insertInto("waiver_template_versions")
    .values({
      tenant_id: ctx.tenantId,
      template_id: template.id,
      version,
      title: text.title,
      body: text.body,
      acknowledgments: text.acknowledgments,
      rendering_version: RENDERING_VERSION,
      effective_from: input.effectiveFrom ?? new Date(0),
      effective_until: input.effectiveUntil ?? null,
      reason: input.reason,
    })
    .returning(["content_sha256", "effective_from"])
    .executeTakeFirstOrThrow();
  await recordAudit(trx, ctx, {
    action: "waiver_template.version_published",
    subjectType: "waiver_template",
    subjectId: template.id,
    reason: input.reason,
    after: {
      version,
      contentSha256: row.content_sha256,
      effectiveFrom: row.effective_from.toISOString(),
      effectiveUntil: input.effectiveUntil?.toISOString() ?? null,
    },
  });
  await enqueueOutbox(trx, ctx, {
    topic: "waiver.template.version_published",
    aggregateType: "waiver_template",
    aggregateId: template.id,
    payload: { templateId: template.id, version, contentSha256: row.content_sha256 },
  });
  return {
    kind: "published",
    version,
    contentSha256: row.content_sha256,
    effectiveFrom: row.effective_from,
  };
}

export interface ApplicableVersion {
  templateId: string;
  templateName: string;
  scope: "operator" | "product";
  version: number;
  contentSha256: string;
}

/**
 * The version a new request for this product gets now, by the database
 * clock, or null when no waiver applies.
 */
export async function findApplicableVersion(
  trx: TenantTransaction,
  tenantId: string,
  productId: string,
): Promise<ApplicableVersion | null> {
  const { rows } = await sql<{
    template_id: string;
    name: string;
    scope: "operator" | "product";
    version: number;
    content_sha256: string;
  }>`
    select t.id as template_id, t.name, t.scope, v.version, v.content_sha256
      from waiver_templates t
      join waiver_template_versions v on v.tenant_id = t.tenant_id and v.template_id = t.id
     where t.tenant_id = ${tenantId}
       and (t.scope = 'operator' or (t.scope = 'product' and t.product_id = ${productId}))
       and v.effective_from <= now()
       and (v.effective_until is null or v.effective_until > now())
     order by (t.scope = 'product') desc, v.version desc
     limit 1`.execute(trx);
  const row = rows[0];
  if (!row) return null;
  return {
    templateId: row.template_id,
    templateName: row.name,
    scope: row.scope,
    version: row.version,
    contentSha256: row.content_sha256,
  };
}

export interface TemplateVersionText extends WaiverText {
  templateId: string;
  version: number;
  contentSha256: string;
  renderingVersion: number;
}

export async function loadTemplateVersion(
  trx: TenantTransaction,
  tenantId: string,
  templateId: string,
  version: number,
): Promise<TemplateVersionText | null> {
  const row = await trx
    .selectFrom("waiver_template_versions")
    .select(["title", "body", "acknowledgments", "content_sha256", "rendering_version"])
    .where("tenant_id", "=", tenantId)
    .where("template_id", "=", templateId)
    .where("version", "=", version)
    .executeTakeFirst();
  if (!row) return null;
  return {
    templateId,
    version,
    title: row.title,
    body: row.body,
    acknowledgments: row.acknowledgments,
    contentSha256: row.content_sha256,
    renderingVersion: row.rendering_version,
  };
}
