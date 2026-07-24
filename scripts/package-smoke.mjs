import { execFileSync } from "node:child_process";
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repository = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const temporaryDirectory = mkdtempSync(join(tmpdir(), "codemirror-sql-package-"));
const packageManagerExecutable = process.env.npm_execpath;
if (!packageManagerExecutable) {
  throw new Error("Package smoke must run through a package-manager script");
}
const packageManagerEnvironment = {
  ...process.env,
  npm_config_manage_package_manager_versions: "false",
  npm_config_package_manager_strict_version: "false",
};

function run(command, args, cwd) {
  execFileSync(command, args, {
    cwd,
    encoding: "utf8",
    env: {
      ...packageManagerEnvironment,
      COREPACK_ENABLE_DOWNLOAD_PROMPT: "0",
    },
    stdio: "inherit",
  });
}

function runPackageManager(args, cwd) {
  run(process.execPath, [packageManagerExecutable, ...args], cwd);
}

try {
  const packageManagerVersion = execFileSync(
    process.execPath,
    [packageManagerExecutable, "--version"],
    {
      cwd: repository,
      encoding: "utf8",
      env: packageManagerEnvironment,
    },
  ).trim();
  if (
    process.env.EXPECTED_PNPM_VERSION &&
    packageManagerVersion !== process.env.EXPECTED_PNPM_VERSION
  ) {
    throw new Error(
      `Package-manager child switched from ${process.env.EXPECTED_PNPM_VERSION} to ${packageManagerVersion}`,
    );
  }

  const packOutput = JSON.parse(
    execFileSync(
      process.execPath,
      [
        packageManagerExecutable,
        "pack",
        "--json",
        "--pack-destination",
        temporaryDirectory,
      ],
      {
        cwd: repository,
        encoding: "utf8",
        env: packageManagerEnvironment,
      },
    ),
  );
  const manifest = Array.isArray(packOutput) ? packOutput[0] : packOutput;
  if (!manifest || typeof manifest.filename !== "string") {
    throw new Error("pnpm pack did not return an archive filename");
  }

  const archive = join(temporaryDirectory, basename(manifest.filename));
  const fixture = join(repository, "test", "package-smoke");
  copyFileSync(join(fixture, "package.json"), join(temporaryDirectory, "package.json"));
  copyFileSync(join(fixture, "pnpm-lock.yaml"), join(temporaryDirectory, "pnpm-lock.yaml"));

  runPackageManager(
    ["install", "--frozen-lockfile", "--ignore-scripts"],
    temporaryDirectory,
  );

  const packageDirectory = join(
    temporaryDirectory,
    "node_modules",
    "@marimo-team",
    "codemirror-sql",
  );
  mkdirSync(packageDirectory, { recursive: true });
  run(
    "tar",
    ["-xzf", archive, "-C", packageDirectory, "--strip-components=1"],
    temporaryDirectory,
  );
  const packedPackage = JSON.parse(
    readFileSync(join(packageDirectory, "package.json"), "utf8"),
  );
  if (typeof packedPackage.dependencies?.["node-sql-parser"] !== "string") {
    throw new Error("Packed manifest does not declare node-sql-parser");
  }

  writeFileSync(
    join(temporaryDirectory, "consumer.mts"),
    `import type { Extension } from "@codemirror/state";
import {
  NodeSqlParser,
  sqlCompletion,
  sqlExtension,
} from "@marimo-team/codemirror-sql";
import {
  BigQueryDialect,
  DremioDialect,
  DuckDBDialect,
} from "@marimo-team/codemirror-sql/dialects";
import commonKeywords from "@marimo-team/codemirror-sql/data/common-keywords.json" with { type: "json" };
import duckdbKeywords from "@marimo-team/codemirror-sql/data/duckdb-keywords.json" with { type: "json" };

const extensions: Extension[] = [
  sqlCompletion({ dialect: DuckDBDialect }),
  sqlExtension(),
];
const parser = new NodeSqlParser();

void extensions;
void parser;
void BigQueryDialect;
void DremioDialect;
void commonKeywords;
void duckdbKeywords;
`,
  );

  writeFileSync(
    join(temporaryDirectory, "consumer.mjs"),
    `import { EditorState } from "@codemirror/state";
import * as api from "@marimo-team/codemirror-sql";
import * as dialects from "@marimo-team/codemirror-sql/dialects";
import commonKeywords from "@marimo-team/codemirror-sql/data/common-keywords.json" with { type: "json" };
import duckdbKeywords from "@marimo-team/codemirror-sql/data/duckdb-keywords.json" with { type: "json" };

if (typeof api.sqlExtension !== "function" || typeof api.NodeSqlParser !== "function") {
  throw new Error("Root package exports are incomplete");
}
if (!dialects.BigQueryDialect || !dialects.DremioDialect || !dialects.DuckDBDialect) {
  throw new Error("Dialect package exports are incomplete");
}
if (!commonKeywords.keywords || !duckdbKeywords.keywords) {
  throw new Error("Keyword data exports are incomplete");
}

const state = EditorState.create({ doc: "SELECT 1" });
const parseResult = await new api.NodeSqlParser().parse("SELECT 1", { state });
if (!parseResult.success || !parseResult.ast) {
  throw new Error("The packaged parser could not load its runtime dependency");
}
`,
  );

  writeFileSync(
    join(temporaryDirectory, "tsconfig.json"),
    JSON.stringify(
      {
        compilerOptions: {
          module: "NodeNext",
          moduleResolution: "NodeNext",
          noEmit: true,
          skipLibCheck: false,
          strict: true,
          target: "ES2022",
        },
        include: ["consumer.mts"],
      },
      null,
      2,
    ),
  );

  runPackageManager(["exec", "tsc", "--project", "tsconfig.json"], temporaryDirectory);
  run(process.execPath, ["consumer.mjs"], temporaryDirectory);
} finally {
  if (basename(temporaryDirectory).startsWith("codemirror-sql-package-")) {
    rmSync(temporaryDirectory, { force: true, recursive: true });
  }
}
