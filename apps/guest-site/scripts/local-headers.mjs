// Local-only: let a built guest site call a local API (G2.14b).
//
// The committed public/_headers lets the page connect only to
// https://api.tidegrid.us, and a static test pins that. A local or CI run
// against `wrangler dev` needs the local API in connect-src too. With
// GUEST_LOCAL_API set to a loopback origin, this writes that origin into the
// built dist/_headers only. Without it, it does nothing, so a release build
// is never touched. Earlier lanes patched the file by hand.
import { readFileSync, writeFileSync } from "node:fs";

const value = process.env.GUEST_LOCAL_API;
if (!value) process.exit(0);

let origin;
try {
  origin = new URL(value).origin;
} catch {
  console.error("GUEST_LOCAL_API must be an origin such as http://localhost:8961");
  process.exit(2);
}
const host = new URL(origin).hostname;
if (origin !== value || !(host === "localhost" || host === "127.0.0.1")) {
  console.error("GUEST_LOCAL_API must be a loopback origin, such as http://localhost:8961");
  process.exit(2);
}

const file = new URL("../dist/_headers", import.meta.url);
const headers = readFileSync(file, "utf8");
const next = headers.replace(
  "connect-src 'self' https://api.tidegrid.us",
  `connect-src 'self' https://api.tidegrid.us ${origin}`,
);
if (next === headers) {
  console.error("dist/_headers has no connect-src to extend");
  process.exit(1);
}
writeFileSync(file, next);
console.log(`dist/_headers: connect-src also allows ${origin} (local build only)`);
