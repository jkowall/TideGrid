import { guestSurface, type PublicBrand } from "@tidegrid/contracts";

/** The public identity the gateway returns beside the brand. */
export interface PublicTenant {
  slug: string;
  name: string;
}

/**
 * The web app manifest for one tenant's host (G2.14b). Every member comes
 * from the published, validated brand; nothing here is a default tenant.
 * Brand text reaches the manifest as JSON string values only.
 */

/** short_name: the brand name, cut at a word boundary to 12 characters (G2.14b, D6). */
export function shortNameFor(name: string): string {
  const max = 12;
  const chars = Array.from(name.trim());
  if (chars.length <= max) return chars.join("");
  const cut = chars.slice(0, max).join("");
  const space = cut.lastIndexOf(" ");
  return (space >= 4 ? cut.slice(0, space) : cut).trimEnd();
}

export const ICON_PATHS = { any: "/icons/icon.svg", maskable: "/icons/maskable.svg" } as const;

export function buildManifest(brand: PublicBrand) {
  return {
    id: "/",
    name: brand.name,
    short_name: shortNameFor(brand.name),
    description: `Book trips with ${brand.name}`,
    start_url: "/",
    scope: "/",
    display: "standalone",
    theme_color: brand.colors.primary,
    background_color: guestSurface.page,
    lang: brand.locale,
    icons: [
      { src: ICON_PATHS.any, sizes: "any", type: "image/svg+xml", purpose: "any" },
      { src: ICON_PATHS.maskable, sizes: "any", type: "image/svg+xml", purpose: "maskable" },
    ],
  };
}

/** A strong validator for the manifest and icons: the tenant and its brand version. */
export function etagFor(tenant: PublicTenant, brand: PublicBrand, part: string): string {
  return `"${tenant.slug}.${brand.version}.${part}"`;
}
