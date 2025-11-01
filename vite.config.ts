import { playwright } from "@vitest/browser-playwright";
import { defineConfig } from "vitest/config";

export default defineConfig({
  root: process.env.VITEST ? "." : "demo",
  test: {
    watch: false,
    coverage: {
      provider: "v8",
      reporter: ["text", "json", "html"],
      include: ["src/**/*.ts"],
      exclude: ["src/**/*.test.ts", "src/**/__tests__/**", "src/debug.ts"],
    },
    projects: [
      {
        test: {
          environment: "jsdom",
          exclude: ["src/**/browser_tests/**/*.test.ts"],
          include: ["src/**/*.test.ts", "src/**/__tests__/**/*.ts",],
        }
      },
      {
        test: {
          name: "browser",
          browser: {
            enabled: true,
            provider: playwright(),
            // https://vitest.dev/guide/browser/playwright
            instances: [
              { browser: 'chromium' },
            ],
            ui: false,
            headless: true,
          },
          include: ["src/**/browser_tests/**/*.test.ts"],
          testTimeout: 5000,
        },
      }
    ]
  },
  base: "/codemirror-sql/",
});
