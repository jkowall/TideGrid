import type { ConfigContext, ExpoConfig } from "expo/config";
import { endpointFor, variantFor } from "./src/variant.ts";

/**
 * One source, one build per operator. TIDEGRID_VARIANT names the variant
 * file in variants/; a missing or invalid one stops the build rather than
 * falling back to another operator. Nothing here is secret.
 */
export default ({ config }: ConfigContext): ExpoConfig => {
  const slug = process.env.TIDEGRID_VARIANT;
  const variant = variantFor(slug);
  if (!variant) {
    throw new Error(
      `Set TIDEGRID_VARIANT to one of the files in variants/ (got ${JSON.stringify(slug)})`,
    );
  }
  const apiBase = process.env.TIDEGRID_API_BASE || undefined;
  const guestOrigin = process.env.TIDEGRID_GUEST_ORIGIN || undefined;
  // A build for testers (TIDEGRID_RELEASE=1) always uses the deployed API and
  // the variant's own host, so a value left over from local work cannot ship.
  if (process.env.TIDEGRID_RELEASE === "1" && (apiBase || guestOrigin)) {
    throw new Error("Unset TIDEGRID_API_BASE and TIDEGRID_GUEST_ORIGIN for a release build");
  }
  const overrides = {
    ...(apiBase ? { apiBase } : {}),
    ...(guestOrigin ? { origin: guestOrigin } : {}),
  };
  if (!endpointFor(variant, overrides)) {
    throw new Error(
      "TIDEGRID_API_BASE must be https, unless TIDEGRID_GUEST_ORIGIN is this variant's own http://<slug>.book.localhost[:port]",
    );
  }
  return {
    ...config,
    name: variant.appName,
    slug: `tidegrid-${variant.slug}`,
    scheme: `tidegrid-${variant.slug}`,
    version: "0.1.0",
    orientation: "portrait",
    userInterfaceStyle: "light",
    ios: { bundleIdentifier: variant.iosBundleId, supportsTablet: false },
    android: { package: variant.androidPackage },
    extra: {
      variant: variant.slug,
      apiBase,
      guestOrigin,
    },
  };
};
