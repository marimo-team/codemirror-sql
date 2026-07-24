import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { transformWithOxc } from "vite";

const arguments_ = process.argv.slice(2).filter((argument) => argument !== "--");
if (arguments_.length !== 1) {
  throw new Error("Usage: pnpm run test:coverage:changed -- <git-base>");
}
let [base] = arguments_;
if (/^0+$/.test(base)) {
  const defaultBranch = process.env.DEFAULT_BRANCH ?? "main";
  base = execFileSync(
    "git",
    ["merge-base", "HEAD", `refs/remotes/origin/${defaultBranch}`],
    { encoding: "utf8" },
  ).trim();
}

execFileSync("git", ["rev-parse", "--verify", `${base}^{commit}`], {
  encoding: "utf8",
  stdio: "pipe",
});

const changedProductionFiles = execFileSync(
  "git",
  ["diff", "--name-only", "--diff-filter=ACMR", `${base}...HEAD`, "--", "src"],
  { encoding: "utf8" },
)
  .trim()
  .split("\n")
  .filter(
    (path) =>
      path.endsWith(".ts") &&
      !path.endsWith(".test.ts") &&
      !path.includes("/__tests__/") &&
      !path.includes("/browser_tests/") &&
      path !== "src/debug.ts",
  );
const changedRuntimeFiles = (
  await Promise.all(
    changedProductionFiles.map(async (path) => {
      const result = await transformWithOxc(readFileSync(path, "utf8"), path);
      const measurableCode = result.code
        .split("\n")
        .filter((line) => !/^\s*(?:import\b|export\s*(?:\{|\*))/.test(line))
        .join("\n")
        .trim();
      return measurableCode.length > 0 ? path : null;
    }),
  )
).filter((path) => path !== null);

execFileSync(
  "pnpm",
  [
    "exec",
    "vitest",
    "run",
    "--config",
    "vitest.config.ts",
    "--coverage",
    `--coverage.changed=${base}`,
    "--coverage.thresholds.perFile=true",
    "--coverage.thresholds.lines=95",
    "--coverage.thresholds.statements=95",
    "--coverage.thresholds.functions=95",
    "--coverage.thresholds.branches=95",
  ],
  {
    encoding: "utf8",
    stdio: "inherit",
  },
);

if (changedRuntimeFiles.length > 0) {
  const summary = JSON.parse(readFileSync("coverage/coverage-summary.json", "utf8"));
  const totals = summary.total;
  if (
    !totals ||
    (totals.lines.total === 0 && totals.statements.total === 0)
  ) {
    throw new Error(
      `Changed runtime files produced no measurable coverage: ${changedRuntimeFiles.join(", ")}`,
    );
  }
}
