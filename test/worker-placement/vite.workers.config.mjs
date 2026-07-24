import { resolve } from "node:path";
import { defineConfig } from "vite";

const fixtureRoot = `${import.meta.dirname.replaceAll("\\", "/")}/`;

function normalizeModuleId(moduleId) {
  const normalized = moduleId.replaceAll("\\", "/");
  return normalized.startsWith(fixtureRoot)
    ? normalized.slice(fixtureRoot.length)
    : normalized;
}

function moduleTrace(fileName) {
  return {
    name: `worker-placement-${fileName}`,
    generateBundle(_options, bundle) {
      const chunks = Object.values(bundle)
        .filter((output) => output.type === "chunk")
        .map((chunk) => ({
          dynamicImports: [...chunk.dynamicImports].sort(),
          facadeModuleId:
            chunk.facadeModuleId === null
              ? null
              : normalizeModuleId(chunk.facadeModuleId),
          fileName: chunk.fileName,
          imports: [...chunk.imports].sort(),
          isDynamicEntry: chunk.isDynamicEntry,
          isEntry: chunk.isEntry,
          moduleIds: Object.keys(chunk.modules)
            .map(normalizeModuleId)
            .sort(),
        }))
        .sort((left, right) =>
          left.fileName.localeCompare(right.fileName),
        );
      this.emitFile({
        fileName,
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
    outDir: "workers-dist",
    rollupOptions: {
      input: resolve(import.meta.dirname, "workers.html"),
    },
  },
  plugins: [moduleTrace("page-module-trace.json")],
  worker: {
    format: "es",
    plugins: () => [
      moduleTrace("worker-module-trace.json"),
    ],
  },
});
