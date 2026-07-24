import { resolve } from "node:path";
import { defineConfig } from "vite";

function moduleTrace() {
  return {
    name: "worker-placement-core-module-trace",
    generateBundle(_options, bundle) {
      const chunks = Object.values(bundle)
        .filter((output) => output.type === "chunk")
        .map((chunk) => ({
          dynamicImports: [...chunk.dynamicImports].sort(),
          fileName: chunk.fileName,
          imports: [...chunk.imports].sort(),
          isEntry: chunk.isEntry,
          moduleIds: Object.keys(chunk.modules)
            .map((moduleId) => moduleId.replaceAll("\\", "/"))
            .sort(),
        }))
        .sort((left, right) =>
          left.fileName.localeCompare(right.fileName),
        );
      this.emitFile({
        fileName: "core-module-trace.json",
        source: `${JSON.stringify({ chunks }, null, 2)}\n`,
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
