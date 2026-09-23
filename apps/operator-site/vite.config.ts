import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// Local development mirrors production: the console calls /api same-origin and
// the dev server forwards it to `wrangler dev` for the API on :8787.
export default defineConfig({
  plugins: [react()],
  build: { outDir: "dist", sourcemap: true },
  server: {
    port: 5174,
    strictPort: true,
    proxy: {
      // changeOrigin sets Host to the API, so wrangler dev does not mistake the
      // console's Origin for its own and rewrite it.
      "/api": {
        target: "http://localhost:8787",
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/api/, ""),
      },
    },
  },
});
