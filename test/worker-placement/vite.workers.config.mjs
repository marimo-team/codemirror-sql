import { resolve } from "node:path";
import { defineConfig } from "vite";

export default defineConfig({
  base: "/",
  build: {
    emptyOutDir: true,
    manifest: true,
    outDir: "workers-dist",
    rollupOptions: {
      input: resolve(import.meta.dirname, "workers.html"),
    },
  },
  worker: {
    format: "es",
  },
});
