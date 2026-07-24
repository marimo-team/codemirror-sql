import { resolve } from "node:path";
import { defineConfig } from "vite";

function moduleTrace() {
  return {
    name: "worker-placement-core-module-trace",
    generateBundle(_options, bundle) {
      const moduleIds = new Set();
      for (const output of Object.values(bundle)) {
        if (output.type === "chunk") {
          for (const moduleId of Object.keys(output.modules)) {
            moduleIds.add(moduleId.replaceAll("\\", "/"));
          }
        }
      }
      this.emitFile({
        fileName: "module-ids.json",
        source: `${JSON.stringify([...moduleIds].sort(), null, 2)}\n`,
        type: "asset",
      });
    },
  };
}

export default defineConfig({
  base: "/",
  build: {
    emptyOutDir: true,
    manifest: true,
    outDir: "core-dist",
    rollupOptions: {
      input: resolve(import.meta.dirname, "core.html"),
    },
  },
  plugins: [moduleTrace()],
});
