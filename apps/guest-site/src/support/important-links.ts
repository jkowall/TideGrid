import { PublicImportantLinksResponse } from "@tidegrid/contracts";
import { apiBase } from "../bootstrap.ts";

/**
 * The site's important links for every trip (W3-G2.14b-rest), for the help
 * page. The browser sends the page's Origin and the API answers for the
 * operator published there. The answer is parsed against the contract, and
 * any failure shows no links: the help page reads the same without them.
 */
export async function loadSiteLinks(
  signal?: AbortSignal,
): Promise<PublicImportantLinksResponse["links"]> {
  try {
    const res = await fetch(`${apiBase}/v1/public/important-links`, {
      credentials: "omit",
      cache: "no-store",
      referrerPolicy: "no-referrer",
      headers: { accept: "application/json" },
      ...(signal ? { signal } : {}),
    });
    if (!res.ok) return [];
    const parsed = PublicImportantLinksResponse.safeParse(await res.json().catch(() => undefined));
    return parsed.success ? parsed.data.links : [];
  } catch {
    return [];
  }
}
