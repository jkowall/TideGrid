import { defineConfig } from "vitest/config";

// Runs the hostname lifecycle against a throwaway PostgreSQL 17 as tidegrid_app
// and as the admin role. The shared global setup migrates the database and
// rotates the runtime password.
export default defineConfig({
  test: {
    include: ["src/**/*.integration.test.ts"],
    environment: "node",
    globalSetup: ["../database/src/global-setup.ts"],
    fileParallelism: false,
    testTimeout: 60_000,
    hookTimeout: 120_000,
  },
});
