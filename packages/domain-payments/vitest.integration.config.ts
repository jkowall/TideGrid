import { defineConfig } from "vitest/config";

// Runs the payment adapter and inbox against a throwaway Neon branch as tidegrid_app.
// The shared global setup migrates the branch and rotates the runtime password.
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
