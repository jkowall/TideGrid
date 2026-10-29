import { defineConfig } from "vitest/config";

// Runs templates, assignment, tokens, signing, and evidence against a
// throwaway PostgreSQL 17 as tidegrid_app. The shared global setup migrates the
// database and rotates the runtime password. Race tests open several
// connections at once; files still run one at a time.
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
