import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    allowOnly: false,
    environment: "jsdom",
    include: ["src/**/*-performance.test.ts"],
    passWithNoTests: false,
    watch: false,
  },
});
