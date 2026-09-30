/**
 * Node-only loader for config/tenants. Used by the seed and by tests; never
 * bundled into a Worker or a web app.
 */
import { readdir, readFile, realpath } from "node:fs/promises";
import { join, sep } from "node:path";
import { fileURLToPath } from "node:url";
import type { BrandConfig } from "@tidegrid/contracts";
import {
  brandConfigFromManifest,
  parseTenantManifest,
  TenantConfigError,
  type TenantManifest,
} from "./manifest.ts";

/** The repository's synthetic tenant manifests. */
export const defaultTenantsDir = fileURLToPath(
  new URL("../../../config/tenants/", import.meta.url),
);

export interface LoadedTenant {
  /** Manifest file name, `<slug>.json`. */
  file: string;
  manifest: TenantManifest;
  /** Validated stored brand, logo embedded. */
  brand: BrandConfig;
}

async function loadOne(root: string, file: string): Promise<LoadedTenant> {
  let raw: unknown;
  try {
    raw = JSON.parse(await readFile(join(root, file), "utf8"));
  } catch (err) {
    throw new TenantConfigError([`not valid JSON (${(err as Error).message})`]);
  }
  const manifest = parseTenantManifest(raw);
  if (file !== `${manifest.slug}.json`) {
    throw new TenantConfigError([`the file must be named ${manifest.slug}.json`]);
  }
  let logoBytes: Uint8Array | undefined;
  const logoFile = manifest.brand.logo?.file;
  if (logoFile) {
    let real: string;
    try {
      real = await realpath(join(root, logoFile));
    } catch {
      throw new TenantConfigError([`brand.logo.file: ${logoFile} does not exist`]);
    }
    // The pattern already rules out traversal; this also rules out symlinks.
    if (!real.startsWith(`${root}${sep}${manifest.slug}${sep}`)) {
      throw new TenantConfigError([`brand.logo.file: ${logoFile} resolves outside its folder`]);
    }
    logoBytes = new Uint8Array(await readFile(real));
  }
  return { file, manifest, brand: brandConfigFromManifest(manifest, logoBytes) };
}

/**
 * Load and validate every `*.json` manifest in a directory, sorted by file
 * name. Reports every invalid manifest at once. Throws TenantConfigError.
 */
export async function loadTenantManifests(dir = defaultTenantsDir): Promise<LoadedTenant[]> {
  const root = await realpath(dir);
  const files = (await readdir(root)).filter((f) => f.endsWith(".json")).sort();
  const loaded: LoadedTenant[] = [];
  const problems: string[] = [];
  for (const file of files) {
    try {
      loaded.push(await loadOne(root, file));
    } catch (err) {
      const details = err instanceof TenantConfigError ? err.problems : [(err as Error).message];
      for (const d of details) problems.push(`${file}: ${d}`);
    }
  }
  if (problems.length > 0) throw new TenantConfigError(problems);
  return loaded;
}
