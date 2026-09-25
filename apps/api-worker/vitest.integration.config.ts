import { defineConfig } from "vitest/config";

// Runs the Hono app in Node against a throwaway Neon branch as tidegrid_app.
// The shared global setup migrates the branch and rotates the runtime password.
export default defineConfig({
  test: {
    include: ["test-integration/**/*.integration.test.ts"],
    environment: "node",
    globalSetup: ["../../packages/database/src/global-setup.ts"],
    fileParallelism: false,
    testTimeout: 60_000,
    hookTimeout: 120_000,
  },
});
