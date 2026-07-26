import { defineConfig } from "vitest/config";

const performanceTests = "src/**/*-performance.test.ts";

export default defineConfig({
  test: {
    allowOnly: false,
    coverage: {
      enabled: false,
      exclude: [
        "src/**/*.test.ts",
        "src/**/__tests__/**",
        "src/**/browser_tests/**",
        "src/node-sql-parser-browser-worker.ts",
      ],
      excludeAfterRemap: true,
      include: ["src/**/*.ts"],
      provider: "v8",
      reporter: ["text", "json", "html", "json-summary"],
      reportOnFailure: true,
      thresholds: {
        branches: 96,
        functions: 99,
        lines: 97,
        statements: 97,
      },
    },
    environment: "jsdom",
    exclude: [
      "src/**/browser_tests/**/*.test.ts",
      performanceTests,
    ],
    include: ["src/**/*.test.ts", "src/**/__tests__/**/*.test.ts"],
    passWithNoTests: false,
    watch: false,
  },
});
