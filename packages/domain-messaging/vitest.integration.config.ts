import { defineConfig } from "vitest/config";

// Runs enqueueing, delivery, and the fake provider against a throwaway PostgreSQL
// 17 as tidegrid_app. The shared global setup migrates the database and
// rotates the runtime password.
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
