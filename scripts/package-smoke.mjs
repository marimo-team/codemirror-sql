import { execFileSync } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
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

function withRenamedPaths(paths, operation) {
  const renamedPaths = [];
  let operationError;
  let operationFailed = false;
  try {
    for (const path of paths) {
      renameSync(path, `${path}.isolated`);
      renamedPaths.push(path);
    }
    operation();
  } catch (error) {
    operationFailed = true;
    operationError = error;
  }

  const restorationErrors = [];
  for (const path of renamedPaths.reverse()) {
    try {
      renameSync(`${path}.isolated`, path);
    } catch (error) {
      restorationErrors.push(error);
    }
  }
  if (restorationErrors.length > 0) {
    throw new AggregateError(
      operationFailed
        ? [operationError, ...restorationErrors]
        : restorationErrors,
      "Package isolation failed and could not restore every dependency",
    );
  }
  if (operationFailed) {
    throw operationError;
  }
}

function verifyRenameRollback(directory) {
  const existingPath = join(directory, "isolation-rollback");
  mkdirSync(existingPath);
  let failed = false;
  try {
    withRenamedPaths(
      [existingPath, join(directory, "missing-isolation-path")],
      () => {},
    );
  } catch {
    failed = true;
  }
  if (
    !failed ||
    !existsSync(existingPath) ||
    existsSync(`${existingPath}.isolated`)
  ) {
    throw new Error("Package isolation did not roll back a partial rename");
  }
  rmSync(existingPath, { recursive: true });
}

try {
  verifyRenameRollback(temporaryDirectory);
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
    join(temporaryDirectory, "vnext-consumer.mjs"),
    `import {
  createSqlLanguageService,
  defineSqlDialect,
} from "@marimo-team/codemirror-sql/vnext";

const service = createSqlLanguageService({
  dialects: [defineSqlDialect({ displayName: "DuckDB", id: "duckdb" })],
});
const session = service.openDocument({
  context: { dialect: "duckdb" },
  text: "SELECT 1",
});
session.update({
  kind: "document",
  baseRevision: session.revision,
  document: { kind: "replace", text: "SELECT 2" },
});
service.dispose();
`,
  );

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
import {
  createSqlLanguageService,
  defineSqlDialect,
  type SqlDocumentContext,
  type SqlTextRange,
} from "@marimo-team/codemirror-sql/vnext";
import commonKeywords from "@marimo-team/codemirror-sql/data/common-keywords.json" with { type: "json" };
import duckdbKeywords from "@marimo-team/codemirror-sql/data/duckdb-keywords.json" with { type: "json" };

interface HostContext extends SqlDocumentContext {
  readonly engine: string;
}

const extensions: Extension[] = [
  sqlCompletion({ dialect: DuckDBDialect }),
  sqlExtension(),
];
const parser = new NodeSqlParser();
const service = createSqlLanguageService<HostContext>({
  dialects: [defineSqlDialect({ displayName: "DuckDB", id: "duckdb" })],
});
const session = service.openDocument({
  context: { dialect: "duckdb", engine: "local" },
  text: "SELECT 1",
});
const range: SqlTextRange = { from: 0, to: 6 };
session.update({
  kind: "document",
  baseRevision: session.revision,
  document: { kind: "changes", changes: [{ from: 7, insert: "2", to: 8 }] },
});

void extensions;
void parser;
void range;
void session;
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
import * as vnext from "@marimo-team/codemirror-sql/vnext";
import commonKeywords from "@marimo-team/codemirror-sql/data/common-keywords.json" with { type: "json" };
import duckdbKeywords from "@marimo-team/codemirror-sql/data/duckdb-keywords.json" with { type: "json" };

if (typeof api.sqlExtension !== "function" || typeof api.NodeSqlParser !== "function") {
  throw new Error("Root package exports are incomplete");
}
if (!dialects.BigQueryDialect || !dialects.DremioDialect || !dialects.DuckDBDialect) {
  throw new Error("Dialect package exports are incomplete");
}
if (
  typeof vnext.createSqlLanguageService !== "function" ||
  typeof vnext.defineSqlDialect !== "function"
) {
  throw new Error("vNext package exports are incomplete");
}
if (!commonKeywords.keywords || !duckdbKeywords.keywords) {
  throw new Error("Keyword data exports are incomplete");
}

const state = EditorState.create({ doc: "SELECT 1" });
const parseResult = await new api.NodeSqlParser().parse("SELECT 1", { state });
if (!parseResult.success || !parseResult.ast) {
  throw new Error("The packaged parser could not load its runtime dependency");
}

const service = vnext.createSqlLanguageService({
  dialects: [vnext.defineSqlDialect({ displayName: "DuckDB", id: "duckdb" })],
});
const session = service.openDocument({
  context: { dialect: "duckdb" },
  text: "SELECT 1",
});
const originalRevision = session.revision;
const updatedRevision = session.update({
  kind: "document",
  baseRevision: originalRevision,
  document: { kind: "replace", text: "SELECT 2" },
});
if (session.isCurrent(originalRevision) || !session.isCurrent(updatedRevision)) {
  throw new Error("The packaged vNext session violated revision identity");
}
service.dispose();
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
  const isolatedDependencies = [
    join(temporaryDirectory, "node_modules", "node-sql-parser"),
    join(temporaryDirectory, "node_modules", "@codemirror"),
  ];
  withRenamedPaths(isolatedDependencies, () => {
    run(process.execPath, ["vnext-consumer.mjs"], temporaryDirectory);
  });
  run(process.execPath, ["consumer.mjs"], temporaryDirectory);
} finally {
  if (basename(temporaryDirectory).startsWith("codemirror-sql-package-")) {
    rmSync(temporaryDirectory, { force: true, recursive: true });
  }
}
