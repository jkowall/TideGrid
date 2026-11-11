import type {
  CatalogResponse,
  ImportantLink,
  ImportantLinkInput,
  ImportantLinkResponse,
  ImportantLinksResponse,
} from "@tidegrid/contracts";
import { call, errorCode, failureOf, type ReadFailure, tenantPath } from "../http.ts";

/**
 * Important links (W3-G2.14b-rest): the console's calls. Every role reads the
 * operator's links; owners add, change, and archive them. The API decides who
 * may; the console's role check only decides what to show. No call throws.
 */

export type Read<T> = { kind: "ok"; value: T } | { kind: "failed"; reason: ReadFailure };

/** A trip a link can be limited to: the operator's product, by name. */
export interface LinkProduct {
  id: string;
  name: string;
}

export interface LinksPage {
  links: ImportantLink[];
  products: LinkProduct[];
}

const isString = (v: unknown): v is string => typeof v === "string";

/** Whether an answer has what the page shows, in a form it can show. */
export function isLink(value: unknown): value is ImportantLink {
  const l = value as Partial<ImportantLink> | null;
  return (
    isString(l?.id) &&
    isString(l.label) &&
    isString(l.url) &&
    isString(l.host) &&
    (l.description === null || isString(l.description)) &&
    (l.productIds === null || (Array.isArray(l.productIds) && l.productIds.every(isString))) &&
    Number.isInteger(l.position) &&
    (l.status === "active" || l.status === "archived")
  );
}

const linksPath = (tenantId: string) => `${tenantPath(tenantId)}/important-links`;

/** The operator's links and its products, for naming the trips a link shows on. */
export async function loadLinks(tenantId: string, signal?: AbortSignal): Promise<Read<LinksPage>> {
  try {
    const [linksRes, catalogRes] = await Promise.all([
      call(linksPath(tenantId), { headers: { accept: "application/json" } }, signal),
      call(`${tenantPath(tenantId)}/catalog`, { headers: { accept: "application/json" } }, signal),
    ]);
    if (!linksRes.ok) return { kind: "failed", reason: await failureOf(linksRes) };
    const body = (await linksRes
      .json()
      .catch(() => null)) as Partial<ImportantLinksResponse> | null;
    if (!Array.isArray(body?.links) || !body.links.every(isLink)) {
      return { kind: "failed", reason: "unreadable" };
    }
    // Without the catalog, links still show; their trips are named "a trip".
    let products: LinkProduct[] = [];
    if (catalogRes.ok) {
      const catalog = (await catalogRes
        .json()
        .catch(() => null)) as Partial<CatalogResponse> | null;
      products = (Array.isArray(catalog?.products) ? catalog.products : [])
        .filter((p) => isString(p?.id) && isString(p.name))
        .map((p) => ({ id: p.id, name: p.name }));
    }
    return { kind: "ok", value: { links: body.links, products } };
  } catch {
    return { kind: "failed", reason: signal?.aborted ? "unavailable" : "unreachable" };
  }
}

/** Why a change was not saved. */
export type SaveFailure = ReadFailure | "archived" | "limit" | "unknown_product" | "key_reused";

export type SaveResult =
  | { kind: "saved"; link: ImportantLink }
  | { kind: "failed"; reason: SaveFailure };

async function save(
  path: string,
  method: "POST" | "PUT",
  body: ImportantLinkInput | null,
  key: string,
): Promise<SaveResult> {
  try {
    const res = await call(path, {
      method,
      headers: {
        accept: "application/json",
        "Idempotency-Key": key,
        ...(body ? { "content-type": "application/json" } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    if (res.ok) {
      const answer = (await res.json().catch(() => null)) as Partial<ImportantLinkResponse> | null;
      return isLink(answer?.link)
        ? { kind: "saved", link: answer.link }
        : { kind: "failed", reason: "unreadable" };
    }
    if (res.status === 409) {
      const code = await errorCode(res);
      if (code === "important_link_archived") return { kind: "failed", reason: "archived" };
      if (code === "important_links_limit") return { kind: "failed", reason: "limit" };
      if (code === "important_link_unknown_product") {
        return { kind: "failed", reason: "unknown_product" };
      }
      return { kind: "failed", reason: "unavailable" };
    }
    if (res.status === 422) return { kind: "failed", reason: "key_reused" };
    return { kind: "failed", reason: await failureOf(res) };
  } catch {
    return { kind: "failed", reason: "unreachable" };
  }
}

/** Add a link. `key`: one per link, kept when the same link is sent again after a failure. */
export function addLink(tenantId: string, input: ImportantLinkInput, key: string) {
  return save(linksPath(tenantId), "POST", input, key);
}

/** Replace a link's name, address, note, trips, and position. */
export function changeLink(
  tenantId: string,
  linkId: string,
  input: ImportantLinkInput,
  key: string,
) {
  return save(`${linksPath(tenantId)}/${encodeURIComponent(linkId)}`, "PUT", input, key);
}

/** Archive a link: guests stop seeing it, and it never changes again. */
export function archiveLink(tenantId: string, linkId: string, key: string) {
  return save(`${linksPath(tenantId)}/${encodeURIComponent(linkId)}/archive`, "POST", null, key);
}
