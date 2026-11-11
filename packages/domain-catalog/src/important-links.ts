import {
  type GuestImportantLink,
  type ImportantLink,
  type ImportantLinkInput,
  importantLinkHost,
} from "@tidegrid/contracts";
import { recordAudit, type TenantContext, type TenantTransaction } from "@tidegrid/database";
import { sql } from "kysely";

/**
 * Important links (W3-G2.14b-rest): an operator's named HTTPS links for
 * guests, for every trip or for named products (docs/v2/02). Owners add,
 * edit, reorder, and archive them; nothing is deleted. The database checks
 * every writer (0041): the address rule, the text limits, the products being
 * the tenant's own, and at most 25 active links (500 in all).
 */

interface LinkRow {
  id: string;
  label: string;
  url: string;
  description: string | null;
  product_ids: string[] | null;
  position: number;
  status: "active" | "archived";
  updated_at: Date;
}

function toLink(r: LinkRow): ImportantLink {
  return {
    id: r.id,
    label: r.label,
    url: r.url,
    host: importantLinkHost(r.url),
    description: r.description,
    productIds: r.product_ids,
    position: r.position,
    status: r.status,
    updatedAt: new Date(r.updated_at).toISOString(),
  };
}

const COLUMNS = [
  "id",
  "label",
  "url",
  "description",
  "product_ids",
  "position",
  "status",
  "updated_at",
] as const;

/**
 * Every link of the tenant: active ones first, then archived ones, each by
 * position, then by when it was added. Guests see active ones in the same order.
 */
export async function listImportantLinks(
  trx: TenantTransaction,
  tenantId: string,
): Promise<ImportantLink[]> {
  const rows = await trx
    .selectFrom("important_links")
    .select(COLUMNS)
    .where("tenant_id", "=", tenantId)
    .orderBy(sql`case when status = 'active' then 0 else 1 end`)
    .orderBy("position")
    .orderBy("created_at")
    .orderBy("id")
    .execute();
  return rows.map((r) => toLink(r as LinkRow));
}

/**
 * The active links a guest of this product sees: those for every trip and
 * those naming the product, by position. With no product, only the links for
 * every trip.
 */
export async function guestImportantLinks(
  trx: TenantTransaction,
  tenantId: string,
  productId: string | null,
): Promise<GuestImportantLink[]> {
  let query = trx
    .selectFrom("important_links")
    .select(["label", "url", "description"])
    .where("tenant_id", "=", tenantId)
    .where("status", "=", "active");
  query =
    productId === null
      ? query.where("product_ids", "is", null)
      : query.where((eb) =>
          eb.or([
            eb("product_ids", "is", null),
            eb(sql<string>`${productId}::uuid`, "=", sql<string>`any(product_ids)`),
          ]),
        );
  const rows = await query.orderBy("position").orderBy("created_at").orderBy("id").execute();
  return rows.map((r) => ({
    label: r.label,
    url: r.url,
    host: importantLinkHost(r.url),
    description: r.description,
  }));
}

export type ImportantLinkResult =
  | { kind: "saved"; link: ImportantLink }
  | { kind: "not_found" }
  | { kind: "archived" }
  | { kind: "limit_reached" }
  | { kind: "unknown_product" };

/** Maps the database's refusals to results; anything else is thrown. */
function refusal(err: unknown): ImportantLinkResult | null {
  const e = err as { code?: string; constraint_name?: string; constraint?: string };
  const constraint = e.constraint_name ?? e.constraint;
  if (constraint === "important_links_limit" || constraint === "important_links_total") {
    return { kind: "limit_reached" };
  }
  if (constraint === "important_links_products") return { kind: "unknown_product" };
  if (constraint === "important_links_archived") return { kind: "archived" };
  return null;
}

/** Runs one statement under a savepoint, so a refusal leaves the transaction usable. */
async function guarded<T>(
  trx: TenantTransaction,
  run: () => Promise<T>,
): Promise<T | ImportantLinkResult> {
  await sql`savepoint important_link`.execute(trx);
  try {
    const out = await run();
    await sql`release savepoint important_link`.execute(trx);
    return out;
  } catch (err) {
    await sql`rollback to savepoint important_link`.execute(trx);
    const mapped = refusal(err);
    if (mapped) return mapped;
    throw err;
  }
}

function isResult(v: unknown): v is ImportantLinkResult {
  return typeof v === "object" && v !== null && "kind" in v;
}

const auditView = (l: ImportantLink) => ({
  label: l.label,
  url: l.url,
  description: l.description,
  productIds: l.productIds,
  position: l.position,
  status: l.status,
});

/** An owner adds a link. */
export async function createImportantLink(
  trx: TenantTransaction,
  ctx: TenantContext,
  input: ImportantLinkInput,
): Promise<ImportantLinkResult> {
  const out = await guarded(trx, () =>
    trx
      .insertInto("important_links")
      .values({
        tenant_id: ctx.tenantId,
        label: input.label,
        url: input.url,
        description: input.description,
        product_ids: input.productIds,
        position: input.position,
      })
      .returning(COLUMNS)
      .executeTakeFirstOrThrow(),
  );
  if (isResult(out)) return out;
  const link = toLink(out as LinkRow);
  await recordAudit(trx, ctx, {
    action: "important_link.created",
    subjectType: "important_link",
    subjectId: link.id,
    after: auditView(link),
  });
  return { kind: "saved", link };
}

async function lockLink(
  trx: TenantTransaction,
  tenantId: string,
  linkId: string,
): Promise<ImportantLink | null> {
  const row = await trx
    .selectFrom("important_links")
    .select(COLUMNS)
    .where("tenant_id", "=", tenantId)
    .where("id", "=", linkId)
    .forUpdate()
    .executeTakeFirst();
  return row ? toLink(row as LinkRow) : null;
}

/** An owner replaces a link's name, address, note, products, and position. */
export async function updateImportantLink(
  trx: TenantTransaction,
  ctx: TenantContext,
  linkId: string,
  input: ImportantLinkInput,
): Promise<ImportantLinkResult> {
  const before = await lockLink(trx, ctx.tenantId, linkId);
  if (!before) return { kind: "not_found" };
  if (before.status === "archived") return { kind: "archived" };
  const out = await guarded(trx, () =>
    trx
      .updateTable("important_links")
      .set({
        label: input.label,
        url: input.url,
        description: input.description,
        product_ids: input.productIds,
        position: input.position,
        updated_at: new Date(),
      })
      .where("tenant_id", "=", ctx.tenantId)
      .where("id", "=", linkId)
      .returning(COLUMNS)
      .executeTakeFirstOrThrow(),
  );
  if (isResult(out)) return out;
  const link = toLink(out as LinkRow);
  await recordAudit(trx, ctx, {
    action: "important_link.updated",
    subjectType: "important_link",
    subjectId: link.id,
    before: auditView(before),
    after: auditView(link),
  });
  return { kind: "saved", link };
}

/** An owner archives a link: guests no longer see it, and it never changes again. */
export async function archiveImportantLink(
  trx: TenantTransaction,
  ctx: TenantContext,
  linkId: string,
): Promise<ImportantLinkResult> {
  const before = await lockLink(trx, ctx.tenantId, linkId);
  if (!before) return { kind: "not_found" };
  if (before.status === "archived") return { kind: "archived" };
  const out = await guarded(trx, () =>
    trx
      .updateTable("important_links")
      .set({ status: "archived", updated_at: new Date() })
      .where("tenant_id", "=", ctx.tenantId)
      .where("id", "=", linkId)
      .returning(COLUMNS)
      .executeTakeFirstOrThrow(),
  );
  if (isResult(out)) return out;
  const link = toLink(out as LinkRow);
  await recordAudit(trx, ctx, {
    action: "important_link.archived",
    subjectType: "important_link",
    subjectId: link.id,
    before: auditView(before),
    after: auditView(link),
  });
  return { kind: "saved", link };
}
