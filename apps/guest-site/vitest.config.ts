import { defineConfig } from "vitest/config";

// Unit tests run in Node; component tests opt into jsdom with a
// `@vitest-environment jsdom` comment at the top of the file.
export default defineConfig({
  test: {
    include: ["src/**/*.test.ts", "src/**/*.test.tsx"],
    environment: "node",
  },
});
