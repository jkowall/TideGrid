// The phone app demo (W1N-WEB): build the demo guest app (apps/guest-native)
// for the browser into dist/app, after `vite build` has written dist. The
// page public/phone/ shows it inside a phone frame. It is the same app code
// as the TestFlight build, served from the operator's own guest host, so the
// browser's Origin picks the operator as it does for the guest site.
//
// A release build always talks to the deployed API. Only a loopback API, for
// local and CI checks, may be named, and it needs this variant's local origin.
import { execFileSync } from "node:child_process";
import { existsSync, rmSync } from "node:fs";
import { fileURLToPath } from "node:url";

const variant = "demo-harbor";
const dist = fileURLToPath(new URL("../dist/", import.meta.url));
const out = fileURLToPath(new URL("../dist/app/", import.meta.url));
if (!existsSync(dist)) {
  console.error("build-phone-app: run vite build first, dist/ is missing");
  process.exit(1);
}

const localApi = process.env.GUEST_LOCAL_API;
const env = { ...process.env, CI: "1", TIDEGRID_VARIANT: variant, TIDEGRID_WEB_BASE: "/app" };
delete env.TIDEGRID_API_BASE;
delete env.TIDEGRID_GUEST_ORIGIN;
delete env.TIDEGRID_RELEASE;
if (localApi) {
  // The same loopback rule scripts/local-headers.mjs applies.
  const host = new URL(localApi).hostname;
  if (!(host === "localhost" || host === "127.0.0.1")) {
    console.error("build-phone-app: GUEST_LOCAL_API must be a loopback origin");
    process.exit(2);
  }
  env.TIDEGRID_API_BASE = localApi;
  env.TIDEGRID_GUEST_ORIGIN = `http://${variant}.book.localhost:5361`;
}

rmSync(out, { recursive: true, force: true });
// --clear: Metro inlines the app config when it transforms a file, so a
// cached transform from an earlier build could carry another API address.
execFileSync(
  "pnpm",
  [
    "--filter",
    "@tidegrid/guest-native",
    "exec",
    "expo",
    "export",
    "--platform",
    "web",
    "--output-dir",
    out,
    "--clear",
  ],
  { stdio: "inherit", env },
);
// Expo writes a metadata file the browser never needs.
rmSync(new URL("metadata.json", `file://${out}`), { force: true });
if (!existsSync(`${out}index.html`)) {
  console.error("build-phone-app: expo export wrote no index.html");
  process.exit(1);
}
console.log(
  `build-phone-app: ${variant} built into dist/app${localApi ? ` against ${localApi}` : ""}`,
);
