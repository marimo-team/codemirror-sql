import { playwright } from "@vitest/browser-playwright";
import { defineConfig } from "vitest/config";

const configuredBrowser = process.env.VITEST_BROWSER ?? "chromium";
if (
  configuredBrowser !== "chromium" &&
  configuredBrowser !== "firefox" &&
  configuredBrowser !== "webkit"
) {
  throw new Error(`Unsupported browser: ${configuredBrowser}`);
}

export default defineConfig({
  optimizeDeps: {
    include: [
      "@codemirror/lang-sql",
      "node-sql-parser/build/bigquery.js",
      "node-sql-parser/build/postgresql.js",
    ],
  },
  test: {
    allowOnly: false,
    browser: {
      enabled: true,
      headless: true,
      instances: [{ browser: configuredBrowser }],
      provider: playwright(),
      ui: false,
    },
    include: ["src/**/browser_tests/**/*.test.ts"],
    passWithNoTests: false,
    testTimeout: 5000,
    watch: false,
  },
});
