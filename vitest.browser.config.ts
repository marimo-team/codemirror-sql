import { playwright } from "@vitest/browser-playwright";
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    allowOnly: false,
    browser: {
      enabled: true,
      headless: true,
      instances: [{ browser: "chromium" }],
      provider: playwright(),
      ui: false,
    },
    include: ["src/**/browser_tests/**/*.test.ts"],
    passWithNoTests: false,
    testTimeout: 5000,
    watch: false,
  },
});
