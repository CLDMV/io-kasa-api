import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.vitest.mjs"],
    environment: "node",
    testTimeout: 10_000,
    hookTimeout: 10_000,
    reporters: "default"
  }
});
