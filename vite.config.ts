import { playwright } from "@vitest/browser-playwright";
import { defineConfig } from "vitest/config";

export default defineConfig({
  root: process.env.VITEST ? "." : "demo",
  test: {
    watch: false,
    coverage: {
      enabled: true,
      provider: "v8",
      reportOnFailure: true,
      reporter: ["text", "json", "html", "json-summary"],
      include: ["src/**/*.ts"],
      exclude: ["src/**/*.test.ts", "src/**/__tests__/**", "src/debug.ts"],
    },
    projects: [
      {
        test: {
          environment: "jsdom",
          exclude: ["src/**/browser_tests/**/*.test.ts"],
          include: ["src/**/*.test.ts", "src/**/__tests__/**/*.test.ts"],
        }
      },
      {
        test: {
          name: "browser",
          browser: {
            enabled: true,
            provider: playwright({
              launchOptions: process.env.CI ? { channel: "chrome" } : undefined,
            }),
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
