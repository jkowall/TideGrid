// Build check (G2.14b): every entry in dist/sw.js's precache list must be a
// file the build wrote. A phantom entry would make the service worker cache
// whatever the server answers for it (the SPA fallback's index.html, under a
// script URL, for a year), or fail every install once missing assets 404.
import { existsSync, readFileSync } from "node:fs";

const dist = new URL("../dist/", import.meta.url);
const sw = readFileSync(new URL("sw.js", dist), "utf8");
const match = /precache:\[([^\]]*)\]/.exec(sw);
if (!match) {
  if (sw.includes("unregister") && !sw.includes("precache")) {
    console.log("dist/sw.js is the kill switch: no precache to check");
    process.exit(0);
  }
  console.error("dist/sw.js has no precache list");
  process.exit(1);
}
const entries = [...(match[1] ?? "").matchAll(/[`"']([^`"']+)[`"']/g)].map((m) => m[1] ?? "");
if (entries.length === 0) {
  console.error("dist/sw.js precaches nothing");
  process.exit(1);
}
const missing = entries.filter((entry) => !existsSync(new URL(`.${entry}`, dist)));
if (missing.length > 0) {
  console.error(`dist/sw.js precaches files the build did not write: ${missing.join(", ")}`);
  process.exit(1);
}
console.log(`dist/sw.js precache: ${entries.length} entries, all present`);
