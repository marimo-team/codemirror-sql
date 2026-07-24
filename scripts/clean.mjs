import { rmSync } from "node:fs";
import { basename, resolve } from "node:path";

const outputDirectory = resolve("dist");
if (basename(outputDirectory) !== "dist") {
  throw new Error(`Refusing to clean unexpected path: ${outputDirectory}`);
}

rmSync(outputDirectory, { force: true, recursive: true });
