import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react";
import { build, defineConfig, type Plugin } from "vite";
import { killSwitchSource } from "./src/sw/kill-switch.ts";

// The guest site calls the API across origins, as it does in production, so
// the browser sends the page's Origin and the API resolves the tenant from it.
// Locally, open http://<slug>.book.localhost:<port>: browsers resolve every
// *.localhost name to this machine, and Vite accepts *.localhost hosts.
//
//   GUEST_DEV_PORT        dev server port (default 5173)
//   VITE_API_BASE         API origin the page calls (default http://localhost:8787)
//   GUEST_SW_KILL_SWITCH  "1" builds the kill-switch service worker for every
//                         host: the rollback for a bad service worker (G2.14b)
const port = Number(process.env.GUEST_DEV_PORT ?? 5173);

/**
 * Builds src/sw/sw.ts into an unhashed /sw.js at the root scope (G2.14b), as
 * a classic script with no imports, and injects this build's precache list:
 * its content-hashed /assets/*.js and /assets/*.css files. The build id is a
 * hash of that list, so a new build renames the cache and its activation
 * deletes the old one.
 */
function serviceWorker(): Plugin {
  return {
    name: "tidegrid-service-worker",
    apply: "build",
    async generateBundle(_options, bundle) {
      const precache = Object.keys(bundle)
        .filter((file) => /^assets\/[^/]+\.(?:js|css)$/.test(file))
        .sort()
        .map((file) => `/${file}`);
      const buildId = createHash("sha256")
        .update(JSON.stringify(precache))
        .digest("hex")
        .slice(0, 16);
      let source: string;
      if (process.env.GUEST_SW_KILL_SWITCH === "1") {
        source = killSwitchSource;
      } else {
        const result = await build({
          configFile: false,
          logLevel: "warn",
          define: { __TIDEGRID_SW__: JSON.stringify({ precache, buildId }) },
          build: {
            write: false,
            emptyOutDir: false,
            minify: true,
            sourcemap: false,
            lib: {
              entry: fileURLToPath(new URL("./src/sw/sw.ts", import.meta.url)),
              formats: ["iife"],
              name: "tidegridServiceWorker",
              fileName: () => "sw.js",
            },
          },
        });
        const outputs = Array.isArray(result) ? result : [result];
        const chunk = outputs
          .flatMap((o) => ("output" in o ? o.output : []))
          .find((o) => o.type === "chunk");
        if (chunk?.type !== "chunk") throw new Error("the service worker did not build");
        source = chunk.code;
      }
      this.emitFile({ type: "asset", fileName: "sw.js", source });
    },
  };
}

export default defineConfig({
  plugins: [react(), serviceWorker()],
  build: {
    outDir: "dist",
    sourcemap: true,
    rollupOptions: {
      // The neutral offline page the service worker precaches (G2.14b).
      input: {
        index: fileURLToPath(new URL("./index.html", import.meta.url)),
        offline: fileURLToPath(new URL("./neutral-offline.html", import.meta.url)),
      },
    },
  },
  server: { port, strictPort: true },
  preview: { port, strictPort: true },
});
