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
 * bare name such as localhost), an optional port, then a path, query, or
 * fragment. Nothing before the host, so no user name or password. The same
 * pattern as the database's check.
 */
const IMPORTANT_LINK_URL =
  /^https:\/\/[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)*\.[A-Za-z]{2,63}(?::[0-9]{1,5})?(?:[/?#].*)?$/;
// biome-ignore lint/suspicious/noControlCharactersInRegex: the pattern exists to find them.
const CONTROL_OR_SPACE = /[\u0000-\u0020\u007f-\u009f\u2028\u2029]/;
// biome-ignore lint/suspicious/noControlCharactersInRegex: the pattern exists to find them.
const CONTROL = /[\u0000-\u001f\u007f-\u009f]/;

/** True for an address an important link may hold. */
export function isImportantLinkUrl(value: string): boolean {
  return (
    value.length >= 12 &&
    value.length <= 2048 &&
    !CONTROL_OR_SPACE.test(value) &&
    IMPORTANT_LINK_URL.test(value)
  );
}

/** The host a guest is told the link opens, lowercased, without the port. */
export function importantLinkHost(url: string): string {
  const rest = url.slice("https://".length);
  const end = rest.search(/[/?#:]/);
  return (end === -1 ? rest : rest.slice(0, end)).toLowerCase();
}

const Label = z
  .string()
  .min(1)
  .max(60)
  .refine(
    (v) => v === v.trim() && !CONTROL.test(v),
    "No leading or trailing spaces or control characters",
  )
  .describe("The link's name, as guests see it");
const Description = z
  .string()
  .min(1)
  .max(200)
  .refine((v) => !CONTROL.test(v), "No control characters")
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
