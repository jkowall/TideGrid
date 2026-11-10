import type { ConfigContext, ExpoConfig } from "expo/config";
import { withAppBuildGradle } from "expo/config-plugins";
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
  // Stores need a build number that grows with every upload of the same version.
  const buildText = process.env.TIDEGRID_BUILD_NUMBER;
  const release = process.env.TIDEGRID_RELEASE === "1";
  if (release && !/^[1-9][0-9]{0,8}$/.test(buildText ?? "")) {
    throw new Error("Set TIDEGRID_BUILD_NUMBER to a whole number above the last upload");
  }
  const buildNumber = buildText && /^[1-9][0-9]{0,8}$/.test(buildText) ? Number(buildText) : 1;
  const assets = `./assets/${variant.slug}`;
  const base: ExpoConfig = {
    ...config,
    name: variant.appName,
    slug: `tidegrid-${variant.slug}`,
    scheme: `tidegrid-${variant.slug}`,
    version: "0.1.0",
    orientation: "portrait",
    userInterfaceStyle: "light",
    icon: `${assets}/icon.png`,
    ios: {
      bundleIdentifier: variant.iosBundleId,
      buildNumber: String(buildNumber),
      supportsTablet: false,
      // The app uses only the platform's own HTTPS and Keychain: exempt.
      config: { usesNonExemptEncryption: false },
    },
    android: {
      package: variant.androidPackage,
      versionCode: buildNumber,
      adaptiveIcon: {
        foregroundImage: `${assets}/adaptive-foreground.png`,
        backgroundColor: variant.iconBackground,
      },
    },
    extra: {
      variant: variant.slug,
      apiBase,
      guestOrigin,
    },
  };
  return release ? withUploadSigning(base) : base;
};

/**
 * A release build for Google Play is signed with the owner's upload key,
 * never the template's debug key. The key and its passwords stay on the
 * owner's Mac: Gradle reads them from ~/.gradle/gradle.properties
 * (TIDEGRID_UPLOAD_STORE_FILE, TIDEGRID_UPLOAD_STORE_PASSWORD,
 * TIDEGRID_UPLOAD_KEY_ALIAS, TIDEGRID_UPLOAD_KEY_PASSWORD) and stops if any
 * is missing. If the template changes shape, prebuild stops rather than
 * shipping a debug-signed build.
 */
function withUploadSigning(config: ExpoConfig): ExpoConfig {
  return withAppBuildGradle(config, (mod) => {
    const gradle = mod.modResults.contents;
    const block = `signingConfigs {
        upload {
            def need = { String name ->
                def value = project.findProperty(name)
                if (!value) throw new GradleException("Set " + name + " in ~/.gradle/gradle.properties")
                return value
            }
            storeFile file(need("TIDEGRID_UPLOAD_STORE_FILE"))
            storePassword need("TIDEGRID_UPLOAD_STORE_PASSWORD")
            keyAlias need("TIDEGRID_UPLOAD_KEY_ALIAS")
            keyPassword need("TIDEGRID_UPLOAD_KEY_PASSWORD")
        }`;
    const release = /(release\s*\{[^}]*?)signingConfig signingConfigs\.debug/;
    if (!gradle.includes("signingConfigs {") || !release.test(gradle)) {
      throw new Error("android/app/build.gradle changed shape: upload signing not applied");
    }
    mod.modResults.contents = gradle
      .replace("signingConfigs {", block)
      .replace(release, "$1signingConfig signingConfigs.upload");
    return mod;
  });
}
