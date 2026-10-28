import { cloudflareTest } from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";

// The guest Worker's unit tests run in workerd, with stub bindings and no dist/.
export default defineConfig({
  plugins: [cloudflareTest({ wrangler: { configPath: "./worker/wrangler.test.jsonc" } })],
  test: { include: ["worker/**/*.test.ts"] },
});
