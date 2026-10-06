import { defineConfig } from "vitest/config";

// Runs checkout, confirmation, and the sweep against a throwaway Neon branch as
// tidegrid_app. The shared global setup migrates the branch and rotates the
// runtime password. Race suites open many connections at once; files still run
// one at a time.
export default defineConfig({
  test: {
    include: ["src/**/*.integration.test.ts"],
    environment: "node",
    globalSetup: ["../database/src/global-setup.ts"],
    fileParallelism: false,
    testTimeout: 120_000,
    hookTimeout: 120_000,
  },
});
