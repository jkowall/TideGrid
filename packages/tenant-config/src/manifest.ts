import { BrandConfig, type LogoMediaType } from "@tidegrid/contracts";
import { z } from "zod";
import { previewHostnameFor, slugPattern } from "./hostnames.ts";

/**
 * A synthetic tenant manifest in config/tenants: the tenant's identity, its
 * preview hostname, and its brand as `BrandConfig` allows it, except that the
 * logo names a file beside the manifest instead of embedding it. Loading a
 * manifest turns that file into the stored data URI and validates the result
 * against the brand contract, so a manifest can hold nothing a published
 * brand could not.
 */

/** `<slug>/<name>.<svg|png|webp>`: one folder per tenant, no traversal. */
const logoFilePattern = /^[a-z0-9]+(?:-[a-z0-9]+)*\/[a-z0-9]+(?:-[a-z0-9]+)*\.(svg|png|webp)$/;

const ManifestLogo = z
  .looseObject({
    file: z
      .string()
      .regex(
        logoFilePattern,
        "Name a logo file in the tenant's folder, such as demo-harbor/logo.svg",
      ),
  })
  .refine((logo) => !("src" in logo), "Name the logo file; a manifest may not embed a data URI");

export const TenantManifest = z
  .strictObject({
    slug: z.string().regex(slugPattern, "Use a lowercase slug such as demo-harbor"),
    displayName: z
      .string()
      .min(1)
      .max(120)
      .refine((v) => v === v.trim(), "Remove leading and trailing spaces"),
    previewHostname: z.string(),
    /** Checked in full against BrandConfig once the logo file is read. */
    brand: z.looseObject({ logo: ManifestLogo.optional() }),
  })
  .superRefine((manifest, ctx) => {
    if (!slugPattern.test(manifest.slug)) return;
    const expected = previewHostnameFor(manifest.slug);
    if (manifest.previewHostname !== expected) {
      ctx.addIssue({
        code: "custom",
        path: ["previewHostname"],
        message: `The preview hostname for ${manifest.slug} is ${expected}`,
      });
    }
    const file = manifest.brand.logo?.file;
    if (file && !file.startsWith(`${manifest.slug}/`)) {
      ctx.addIssue({
        code: "custom",
        path: ["brand", "logo", "file"],
        message: `Keep the logo in the tenant's own folder, ${manifest.slug}/`,
      });
    }
  });
export type TenantManifest = z.infer<typeof TenantManifest>;

const mediaTypes: Record<string, LogoMediaType> = {
  svg: "image/svg+xml",
  png: "image/png",
  webp: "image/webp",
};

export function logoMediaTypeFor(file: string): LogoMediaType {
  const type = mediaTypes[file.slice(file.lastIndexOf(".") + 1)];
  if (!type) throw new RangeError(`unsupported logo file type: ${file}`);
  return type;
}

function toBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(binary);
}

/** A manifest or brand that does not validate, with every problem listed. */
export class TenantConfigError extends Error {
  constructor(readonly problems: string[]) {
    super(`Invalid tenant configuration:\n- ${problems.join("\n- ")}`);
    this.name = "TenantConfigError";
  }
}

export function describeIssues(error: z.ZodError, prefix = ""): string[] {
  return error.issues.map((issue) => {
    const path = [prefix, ...issue.path.map(String)].filter(Boolean).join(".");
    return `${path || "(root)"}: ${issue.message}`;
  });
}

/** Validate a parsed manifest document. Throws TenantConfigError. */
export function parseTenantManifest(input: unknown): TenantManifest {
  const parsed = TenantManifest.safeParse(input);
  if (!parsed.success) throw new TenantConfigError(describeIssues(parsed.error));
  return parsed.data;
}

/**
 * Build the stored brand configuration from a manifest and its logo file, and
 * validate it against the brand contract. Throws TenantConfigError.
 */
export function brandConfigFromManifest(
  manifest: TenantManifest,
  logoBytes?: Uint8Array,
): BrandConfig {
  const { logo, ...fields } = manifest.brand;
  const brand: Record<string, unknown> = { ...fields };
  if (logo) {
    if (!logoBytes) throw new TenantConfigError([`brand.logo.file: ${logo.file} was not read`]);
    const { file, ...logoFields } = logo;
    brand.logo = {
      ...logoFields,
      src: `data:${logoMediaTypeFor(file)};base64,${toBase64(logoBytes)}`,
    };
  }
  const parsed = BrandConfig.safeParse(brand);
  if (!parsed.success) throw new TenantConfigError(describeIssues(parsed.error, "brand"));
  return parsed.data;
}
