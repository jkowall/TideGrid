import { defineConfig } from "vitest/config";

// Unit tests cover the plain TypeScript modules only. They never import
// react-native, so they run in Node without a simulator.
export default defineConfig({
  test: {
    include: ["src/**/*.test.ts"],
    environment: "node",
  },
});
