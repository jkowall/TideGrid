import { z } from "zod";

/**
 * Important links (W3-G2.14b-rest, docs/v2/02 brand configuration): an
 * operator's named HTTPS links for guests, for every trip or for named
 * products. Guests see the links that apply to their booking beside its
 * arrival instructions, each marked as leaving the operator's site with the
 * host it opens. The database holds every writer to the same address rule
 * (packages/database/migrations/0041_important_links.sql).
 */

export const MAX_IMPORTANT_LINKS = 25;
export const MAX_IMPORTANT_LINK_PRODUCTS = 20;

/**
 * https, a host name ending in a letters-only label (never an IP address or a
 * bare name such as localhost), an optional port from 1 to 65535, then a
 * path, query, or fragment. Nothing before the host, so no user name or
 * password. The same pattern as the database's check.
 */
const IMPORTANT_LINK_URL =
  /^https:\/\/[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)*\.[A-Za-z]{2,63}(?::(?:[1-9][0-9]{0,3}|[1-5][0-9]{4}|6[0-4][0-9]{3}|65[0-4][0-9]{2}|655[0-2][0-9]|6553[0-5]))?(?:[/?#].*)?$/;
/** Names reserved for local networks or special use; a link never points at one. */
const RESERVED_HOST =
  /(?:^|\.)(?:localhost|localdomain|local|internal|intranet|lan|home|corp|private|test|invalid|example|onion|arpa|alt)$/;
/**
 * Control characters, line and paragraph separators, and characters that
 * change text direction or take no width. The database refuses the same set.
 */
const INVISIBLE =
  // biome-ignore lint/suspicious/noControlCharactersInRegex: the pattern exists to find them.
  /[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u2028-\u202e\u2060-\u2064\u2066-\u2069\ufeff]/;
const SPACE = /\s/;
/** At least one character that is not a space. */
const VISIBLE = /[^\s\u00a0\u1680\u2000-\u200a\u202f\u205f\u3000]/;
/** The spaces the database also refuses at either end of a name. */
const EDGE_SPACE =
  /^[\s\u00a0\u1680\u2000-\u200a\u202f\u205f\u3000]|[\s\u00a0\u1680\u2000-\u200a\u202f\u205f\u3000]$/;

/** True for an address an important link may hold. */
export function isImportantLinkUrl(value: string): boolean {
  return (
    value.length >= 12 &&
    value.length <= 2048 &&
    !INVISIBLE.test(value) &&
    !SPACE.test(value) &&
    IMPORTANT_LINK_URL.test(value) &&
    !RESERVED_HOST.test(importantLinkHost(value).replace(/:.*$/, ""))
  );
}

/**
 * The host a guest is told the link opens, lowercased, with its port unless
 * the port is the usual 443 (as the browser's URL host shows it).
 */
export function importantLinkHost(url: string): string {
  const rest = url.slice("https://".length);
  const end = rest.search(/[/?#]/);
  const host = (end === -1 ? rest : rest.slice(0, end)).toLowerCase();
  const colon = host.indexOf(":");
  if (colon === -1) return host;
  const port = host.slice(colon + 1);
  return port === "443" ? host.slice(0, colon) : `${host.slice(0, colon)}:${port}`;
}

const Label = z
  .string()
  .min(1)
  .max(60)
  .refine(
    (v) => !EDGE_SPACE.test(v) && !INVISIBLE.test(v),
    "No leading or trailing spaces, control characters, or hidden direction marks",
  )
  .describe("The link's name, as guests see it");
const Description = z
  .string()
  .min(1)
  .max(200)
  .refine(
    (v) => VISIBLE.test(v) && !INVISIBLE.test(v),
    "Some text, without control characters or hidden direction marks",
  )
  .describe("An optional short note under the name");
const Url = z
  .string()
  .max(2048)
  .refine(isImportantLinkUrl, "An https address with a host name, without a user name or password")
  .describe("An https address with a host name; no IP address, user name, or password");

export const ImportantLinkInput = z
  .strictObject({
    label: Label,
    url: Url,
    description: Description.nullable(),
    productIds: z
      .array(z.uuid())
      .min(1)
      .max(MAX_IMPORTANT_LINK_PRODUCTS)
      .nullable()
      .describe("Null for every trip; otherwise the products whose bookings show it"),
    position: z.number().int().min(0).max(999).describe("Lower comes first"),
  })
  .describe("An important link as the owner enters it");
export type ImportantLinkInput = z.infer<typeof ImportantLinkInput>;

export const ImportantLink = z.object({
  id: z.uuid(),
  label: z.string(),
  url: z.string(),
  host: z.string().describe("The host the link opens, shown to guests"),
  description: z.string().nullable(),
  productIds: z.array(z.uuid()).nullable(),
  position: z.number().int(),
  status: z.enum(["active", "archived"]),
  updatedAt: z.iso.datetime({ offset: true }),
});
export type ImportantLink = z.infer<typeof ImportantLink>;

export const ImportantLinkResponse = z.object({ link: ImportantLink });
export type ImportantLinkResponse = z.infer<typeof ImportantLinkResponse>;

export const ImportantLinksResponse = z.object({
  links: z.array(ImportantLink).describe("Active links by position, then archived ones"),
});
export type ImportantLinksResponse = z.infer<typeof ImportantLinksResponse>;

/** What a guest sees: no ids, products, or history. */
export const GuestImportantLink = z.object({
  label: z.string(),
  url: z.string(),
  host: z.string().describe("Shown beside the link, so guests know it leaves the operator's site"),
  description: z.string().nullable(),
});
export type GuestImportantLink = z.infer<typeof GuestImportantLink>;

export const PublicImportantLinksResponse = z.object({
  links: z.array(GuestImportantLink).max(MAX_IMPORTANT_LINKS),
});
export type PublicImportantLinksResponse = z.infer<typeof PublicImportantLinksResponse>;
