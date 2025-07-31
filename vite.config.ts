import { defineConfig } from "vitest/config";

export default defineConfig({
  root: process.env.VITEST ? "." : "demo",
  test: {
    environment: "jsdom",
    watch: false,
    coverage: {
      provider: "v8",
      reporter: ["text", "json", "html"],
      include: ["src/**/*.ts"],
      exclude: ["src/**/*.test.ts", "src/**/__tests__/**", "src/debug.ts"],
    },
  },
  base: "/codemirror-sql/",
});
