import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    allowOnly: false,
    coverage: {
      enabled: false,
      exclude: [
        "src/**/*.test.ts",
        "src/**/__tests__/**",
        "src/**/browser_tests/**",
        "src/debug.ts",
      ],
      excludeAfterRemap: true,
      include: ["src/**/*.ts"],
      provider: "v8",
      reporter: ["text", "json", "html", "json-summary"],
      reportOnFailure: true,
      thresholds: {
        branches: 85.85,
        functions: 90.94,
        lines: 91.52,
        statements: 91.61,
      },
    },
    environment: "jsdom",
    exclude: ["src/**/browser_tests/**/*.test.ts"],
    include: ["src/**/*.test.ts", "src/**/__tests__/**/*.test.ts"],
    passWithNoTests: false,
    watch: false,
  },
});
