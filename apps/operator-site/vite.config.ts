import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// Local development mirrors production: the console calls /api same-origin and
// the dev server forwards it to `wrangler dev` for the API.
//
//   CONSOLE_DEV_PORT   dev server port (default 5174)
//   API_DEV_ORIGIN     where /api goes (default http://localhost:8787)
const port = Number(process.env.CONSOLE_DEV_PORT ?? 5174);
const api = process.env.API_DEV_ORIGIN ?? "http://localhost:8787";

export default defineConfig({
  plugins: [react()],
  build: { outDir: "dist", sourcemap: true },
  server: {
    port,
    strictPort: true,
    proxy: {
      // changeOrigin sets Host to the API, so wrangler dev does not mistake the
      // console's Origin for its own and rewrite it.
      "/api": {
        target: api,
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/api/, ""),
      },
    },
  },
});
