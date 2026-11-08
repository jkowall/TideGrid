import { TenantSlug } from "@tidegrid/contracts";
import { z } from "zod";
import demoHarbor from "../variants/demo-harbor.json" with { type: "json" };
import demoReef from "../variants/demo-reef.json" with { type: "json" };

/**
 * One demo app variant: the store identity and the one operator it serves.
 * The brand itself (name, colors, copy) comes from the API at start, exactly
 * as the guest web app gets it, so a variant file holds only what a store
 * build must know before the app runs.
 */
export const Variant = z.strictObject({
  slug: TenantSlug,
  appName: z.string().min(1).max(30),
  iosBundleId: z.string().regex(/^[a-z][a-z0-9]*(\.[a-z][a-z0-9]*){2,}$/),
  androidPackage: z.string().regex(/^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*){2,}$/),
  guestOrigin: z.url({ protocol: /^https$/ }),
});
export type Variant = z.infer<typeof Variant>;

export const variants: Readonly<Record<string, unknown>> = {
  "demo-harbor": demoHarbor,
  "demo-reef": demoReef,
};

/** The variant a build names, validated, or null. Never falls back to another one. */
export function variantFor(
  slug: unknown,
  table: Readonly<Record<string, unknown>> = variants,
): Variant | null {
  if (typeof slug !== "string" || !Object.hasOwn(table, slug)) return null;
  const parsed = Variant.safeParse(table[slug]);
  if (!parsed.success || parsed.data.slug !== slug) return null;
  return parsed.data;
}

/**
 * Where a build talks to the API, and which guest origin it presents.
 * Store builds use the variant's own preview host and the deployed API over
 * https. Only a local build, whose origin is the variant's own
 * `<slug>.book.localhost`, may use plain http, such as an API on the
 * developer's machine.
 */
export interface Endpoint {
  apiBase: string;
  origin: string;
}

const httpsBase = /^https:\/\/[A-Za-z0-9.-]+(:\d{1,5})?$/;
const anyBase = /^https?:\/\/[A-Za-z0-9.-]+(:\d{1,5})?$/;

export function endpointFor(
  variant: Variant,
  overrides: { apiBase?: unknown; origin?: unknown } = {},
): Endpoint | null {
  const apiBase = overrides.apiBase ?? "https://api.tidegrid.us";
  const origin = overrides.origin ?? variant.guestOrigin;
  if (typeof apiBase !== "string" || typeof origin !== "string") return null;
  if (origin === variant.guestOrigin) {
    return httpsBase.test(apiBase) ? { apiBase, origin } : null;
  }
  // A local origin must name this variant's tenant, so a local build cannot
  // be pointed at another operator by accident.
  const local = new RegExp(`^http://${variant.slug}\\.book\\.localhost(:\\d{1,5})?$`);
  if (!local.test(origin) || !anyBase.test(apiBase)) return null;
  return { apiBase, origin };
}
