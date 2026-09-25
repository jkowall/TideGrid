import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createApp } from "../src/app.ts";

const here = dirname(fileURLToPath(import.meta.url));
const out = join(here, "..", "..", "..", "packages", "contracts", "generated", "openapi.json");
const app = createApp();
const doc = app.getOpenAPI31Document({
  openapi: "3.1.0",
  info: { title: "TideGrid API", version: "0.0.0" },
});
await mkdir(dirname(out), { recursive: true });
await writeFile(out, `${JSON.stringify(doc, null, 2)}\n`);
console.log(`wrote ${out}`);
