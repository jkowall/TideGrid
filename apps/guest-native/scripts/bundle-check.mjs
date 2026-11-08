// Bundle the app's JavaScript for both platforms and every variant, with no
// simulator or signing. It proves each variant's config resolves and Metro
// can bundle the shared source, including @tidegrid/contracts.
import { execFileSync } from "node:child_process";
import { readdirSync, rmSync } from "node:fs";

const variants = readdirSync(new URL("../variants/", import.meta.url))
  .filter((f) => f.endsWith(".json"))
  .map((f) => f.replace(/\.json$/, ""));
const out = new URL("../dist-check/", import.meta.url);
rmSync(out, { recursive: true, force: true });
for (const variant of variants) {
  for (const platform of ["ios", "android"]) {
    console.log(`bundle-check: ${variant} ${platform}`);
    execFileSync(
      "npx",
      [
        "expo",
        "export",
        "--platform",
        platform,
        "--output-dir",
        `dist-check/${variant}-${platform}`,
      ],
      { stdio: "inherit", env: { ...process.env, CI: "1", TIDEGRID_VARIANT: variant } },
    );
  }
}
console.log(`bundle-check: ${variants.length * 2} bundles built`);
