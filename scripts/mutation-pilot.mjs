import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repository = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const target = resolve(repository, "src", "language-feature-runtime.ts");
const original = readFileSync(target, "utf8");
const before = "value.length > MAX_SQL_FEATURE_RESULTS";
const after = "value.length >= MAX_SQL_FEATURE_RESULTS";
if (original.split(before).length !== 2) {
  throw new Error("Mutation pilot target is missing or ambiguous");
}

let outcome;
try {
  writeFileSync(target, original.replace(before, after));
  outcome = spawnSync(
    process.execPath,
    [
      resolve(repository, "node_modules", "vitest", "vitest.mjs"),
      "run",
      "--config",
      "vitest.config.ts",
      "src/__tests__/language-feature-runtime.test.ts",
    ],
    {
      cwd: repository,
      encoding: "utf8",
      stdio: "pipe",
    },
  );
} finally {
  writeFileSync(target, original);
}

if (outcome.status === 0) {
  throw new Error(
    "Mutation survived: the feature result limit boundary is not tested",
  );
}
if (outcome.error) throw outcome.error;
process.stdout.write("Mutation killed: feature result limit boundary\n");
