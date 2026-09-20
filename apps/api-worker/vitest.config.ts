import { cloudflareTest } from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: "./wrangler.jsonc" },
      miniflare: {
        bindings: {
          ENVIRONMENT: "local",
          BUILD_ID: "test",
          ALLOWED_ORIGINS: "https://guest.test,https://console.test",
        },
      },
    }),
  ],
  test: { include: ["test/**/*.test.ts"] },
});
