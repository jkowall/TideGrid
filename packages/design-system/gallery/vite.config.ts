import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// Development-only component gallery: every component in every state, on the
// light guest surface with each sample brand and on the dark console surface.
//   pnpm --filter @tidegrid/design-system gallery   (GALLERY_DEV_PORT, default 5175)
const port = Number(process.env.GALLERY_DEV_PORT ?? 5175);

export default defineConfig({
  root: fileURLToPath(new URL(".", import.meta.url)),
  plugins: [react()],
  server: { port, strictPort: true },
  build: { outDir: fileURLToPath(new URL("../dist", import.meta.url)), emptyOutDir: true },
});
