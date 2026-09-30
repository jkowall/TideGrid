import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// The guest site calls the API across origins, as it does in production, so
// the browser sends the page's Origin and the API resolves the tenant from it.
// Locally, open http://<slug>.book.localhost:<port>: browsers resolve every
// *.localhost name to this machine, and Vite accepts *.localhost hosts.
//
//   GUEST_DEV_PORT   dev server port (default 5173)
//   VITE_API_BASE    API origin the page calls (default http://localhost:8787)
const port = Number(process.env.GUEST_DEV_PORT ?? 5173);

export default defineConfig({
  plugins: [react()],
  build: { outDir: "dist", sourcemap: true },
  server: { port, strictPort: true },
  preview: { port, strictPort: true },
});
