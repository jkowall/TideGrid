import { defineConfig } from "vitest/config";

// Runs the admin CLI's commands against a throwaway PostgreSQL 17 on the
// admin connection. The shared global setup migrates it.
export default defineConfig({
  test: {
    include: ["src/**/*.integration.test.ts"],
    environment: "node",
    globalSetup: ["../../packages/database/src/global-setup.ts"],
    fileParallelism: false,
    testTimeout: 60_000,
    hookTimeout: 120_000,
  },
});
