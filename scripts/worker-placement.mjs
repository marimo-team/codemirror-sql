import { execFileSync } from "node:child_process";
import {
  cpSync,
  createReadStream,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { basename, dirname, extname, join, resolve, sep } from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { gzipSync } from "node:zlib";

const CONTENT_SECURITY_POLICY = [
  "base-uri 'none'",
  "connect-src 'self'",
  "default-src 'none'",
  "object-src 'none'",
  "script-src 'self'",
  "worker-src 'self'",
].join("; ");
const PARSER_MARKERS = [
  "NodeSQLParser",
  "whiteListCheck",
  "trimQuery",
  "columnList",
  "tableList",
];
const BIGQUERY_GZIP_LIMIT = 50 * 1024;
const POSTGRESQL_GZIP_LIMIT = 68 * 1024;
const WORKER_TOTAL_GZIP_LIMIT = 120 * 1024;
const WORKER_TOTAL_RAW_LIMIT = 570 * 1024;
const MIME_TYPES = new Map([
  [".css", "text/css; charset=utf-8"],
  [".html", "text/html; charset=utf-8"],
  [".js", "text/javascript; charset=utf-8"],
  [".json", "application/json; charset=utf-8"],
]);
const repository = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const fixtureSource = join(repository, "test", "worker-placement");
const packageManagerExecutable = process.env.npm_execpath;

function parseArguments(arguments_) {
  let reportPath = process.env.WORKER_PLACEMENT_REPORT;
  let index = arguments_[0] === "--" ? 1 : 0;
  for (; index < arguments_.length; index += 1) {
    const argument = arguments_[index];
    if (argument !== "--report" || index + 1 >= arguments_.length) {
      throw new Error(
        "Usage: pnpm run test:worker-placement -- [--report <path>]",
      );
    }
    reportPath = arguments_[index + 1];
    index += 1;
  }
  return reportPath === undefined
    ? undefined
    : resolve(repository, reportPath);
}

function run(command, arguments_, cwd, capture = false) {
  return execFileSync(command, arguments_, {
    cwd,
    encoding: "utf8",
    env: {
      ...process.env,
      COREPACK_ENABLE_DOWNLOAD_PROMPT: "0",
      npm_config_manage_package_manager_versions: "false",
      npm_config_package_manager_strict_version: "false",
    },
    stdio: capture ? ["ignore", "pipe", "inherit"] : "inherit",
  });
}

function runPackageManager(arguments_, cwd, capture = false) {
  if (!packageManagerExecutable) {
    throw new Error(
      "Worker placement must run through a package-manager script",
    );
  }
  return run(
    process.execPath,
    [packageManagerExecutable, ...arguments_],
    cwd,
    capture,
  );
}

function sha256(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function listFiles(directory) {
  const files = [];
  const pending = [directory];
  while (pending.length > 0) {
    const current = pending.pop();
    if (current === undefined) {
      continue;
    }
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const path = join(current, entry.name);
      if (entry.isDirectory()) {
        pending.push(path);
      } else if (entry.isFile()) {
        files.push(path);
      }
    }
  }
  return files.sort();
}

function bundleReport(directory) {
  const files = listFiles(directory).map((path) => {
    const contents = readFileSync(path);
    return {
      file: path.slice(directory.length + 1).split(sep).join("/"),
      gzipBytes: gzipSync(contents).length,
      rawBytes: contents.length,
    };
  });
  return {
    files,
    gzipBytes: files.reduce((total, file) => total + file.gzipBytes, 0),
    rawBytes: files.reduce((total, file) => total + file.rawBytes, 0),
  };
}

function requireModuleTrace(path) {
  const trace = JSON.parse(readFileSync(path, "utf8"));
  if (
    typeof trace !== "object" ||
    trace === null ||
    !Array.isArray(trace.chunks)
  ) {
    throw new Error(`${basename(path)} did not contain a chunk trace`);
  }
  return trace;
}

function chunkMap(trace, workersDirectory) {
  const chunks = new Map();
  for (const chunk of trace.chunks) {
    if (
      typeof chunk !== "object" ||
      chunk === null ||
      typeof chunk.fileName !== "string" ||
      !Array.isArray(chunk.imports) ||
      !Array.isArray(chunk.dynamicImports) ||
      !Array.isArray(chunk.moduleIds) ||
      chunks.has(chunk.fileName) ||
      !existsSync(join(workersDirectory, chunk.fileName))
    ) {
      throw new Error("Worker module trace contained an invalid chunk");
    }
    chunks.set(chunk.fileName, chunk);
  }
  return chunks;
}

function reachableChunks(chunks, roots, includeDynamicImports) {
  const reachable = new Set();
  const pending = [...roots];
  while (pending.length > 0) {
    const fileName = pending.pop();
    if (fileName === undefined || reachable.has(fileName)) {
      continue;
    }
    const chunk = chunks.get(fileName);
    if (chunk === undefined) {
      throw new Error(`Chunk trace referenced missing chunk ${fileName}`);
    }
    reachable.add(fileName);
    pending.push(...chunk.imports);
    if (includeDynamicImports) {
      pending.push(...chunk.dynamicImports);
    }
  }
  return reachable;
}

function metricsForFiles(report, fileNames) {
  const filesByName = new Map(
    report.files.map((file) => [file.file, file]),
  );
  const files = [...fileNames].sort().map((fileName) => {
    const file = filesByName.get(fileName);
    if (file === undefined) {
      throw new Error(`Bundle report omitted traced file ${fileName}`);
    }
    return file;
  });
  return {
    files: files.map((file) => file.file),
    gzipBytes: files.reduce(
      (total, file) => total + file.gzipBytes,
      0,
    ),
    rawBytes: files.reduce(
      (total, file) => total + file.rawBytes,
      0,
    ),
  };
}

function verifyWorkerAssets(workersDirectory) {
  const report = bundleReport(workersDirectory);
  const pageTrace = requireModuleTrace(
    join(workersDirectory, "page-module-trace.json"),
  );
  const workerTrace = requireModuleTrace(
    join(workersDirectory, "worker-module-trace.json"),
  );
  const pageChunks = chunkMap(pageTrace, workersDirectory);
  const workerChunks = chunkMap(workerTrace, workersDirectory);
  const pageEntry = pageTrace.chunks.find(
    (chunk) => chunk.isEntry === true,
  );
  const workerEntry = workerTrace.chunks.find(
    (chunk) =>
      chunk.isEntry === true &&
      chunk.facadeModuleId?.endsWith(
        "src/parser-worker-entry.js",
      ),
  );
  if (pageEntry === undefined || workerEntry === undefined) {
    throw new Error("Build traces omitted a page or parser worker entry");
  }

  const manifest = JSON.parse(
    readFileSync(
      join(workersDirectory, ".vite", "manifest.json"),
      "utf8",
    ),
  );
  const manifestEntry = Object.values(manifest).find(
    (entry) => entry?.isEntry === true,
  );
  if (
    manifestEntry === undefined ||
    manifestEntry.file !== pageEntry.fileName
  ) {
    throw new Error("Vite manifest did not identify the traced page entry");
  }
  const pageReachable = reachableChunks(
    pageChunks,
    [pageEntry.fileName],
    true,
  );
  const pageModuleIds = [...pageReachable].flatMap(
    (fileName) => pageChunks.get(fileName)?.moduleIds ?? [],
  );
  if (
    pageModuleIds.some((moduleId) =>
      moduleId.includes("/node-sql-parser/"),
    )
  ) {
    throw new Error("Page entry graph included a parser grammar");
  }
  const pageSource = readFileSync(
    join(workersDirectory, pageEntry.fileName),
    "utf8",
  );
  if (!pageSource.includes(basename(workerEntry.fileName))) {
    throw new Error("Page entry did not reference the traced parser worker");
  }

  const allWorkerModuleIds = workerTrace.chunks.flatMap(
    (chunk) => chunk.moduleIds,
  );
  const nodeSqlParserModuleIds = allWorkerModuleIds.filter(
    (moduleId) => moduleId.includes("/node-sql-parser/"),
  );
  const postgresqlModuleIds = nodeSqlParserModuleIds.filter(
    (moduleId) =>
      moduleId.endsWith(
        "/node-sql-parser/build/postgresql.js",
      ),
  );
  const bigqueryModuleIds = nodeSqlParserModuleIds.filter(
    (moduleId) =>
      moduleId.endsWith("/node-sql-parser/build/bigquery.js"),
  );
  const unexpectedParserModuleIds = nodeSqlParserModuleIds.filter(
    (moduleId) =>
      !moduleId.endsWith(
        "/node-sql-parser/build/postgresql.js",
      ) &&
      !moduleId.endsWith(
        "/node-sql-parser/build/bigquery.js",
      ),
  );
  if (
    postgresqlModuleIds.length === 0 ||
    bigqueryModuleIds.length === 0 ||
    unexpectedParserModuleIds.length > 0
  ) {
    throw new Error(
      `Worker graph did not contain only the two exact deep builds: ${unexpectedParserModuleIds.join(", ")}`,
    );
  }

  const postgresqlChunk = workerTrace.chunks.find((chunk) =>
    chunk.moduleIds.some((moduleId) =>
      moduleId.endsWith(
        "/node-sql-parser/build/postgresql.js",
      ),
    ),
  );
  const bigqueryChunk = workerTrace.chunks.find((chunk) =>
    chunk.moduleIds.some((moduleId) =>
      moduleId.endsWith("/node-sql-parser/build/bigquery.js"),
    ),
  );
  if (
    postgresqlChunk === undefined ||
    bigqueryChunk === undefined ||
    postgresqlChunk.fileName === bigqueryChunk.fileName
  ) {
    throw new Error("Dialect builds did not emit separate lazy chunks");
  }
  const staticWorkerEntry = reachableChunks(
    workerChunks,
    [workerEntry.fileName],
    false,
  );
  if (
    staticWorkerEntry.has(postgresqlChunk.fileName) ||
    staticWorkerEntry.has(bigqueryChunk.fileName)
  ) {
    throw new Error("Parser worker statically included a grammar chunk");
  }
  const completeWorkerGraph = reachableChunks(
    workerChunks,
    [workerEntry.fileName],
    true,
  );
  if (
    !completeWorkerGraph.has(postgresqlChunk.fileName) ||
    !completeWorkerGraph.has(bigqueryChunk.fileName)
  ) {
    throw new Error("Parser worker could not reach both grammar chunks");
  }

  const postgresqlClosure = reachableChunks(
    workerChunks,
    [postgresqlChunk.fileName],
    false,
  );
  const bigqueryClosure = reachableChunks(
    workerChunks,
    [bigqueryChunk.fileName],
    false,
  );
  const sharedGrammarChunks = new Set(
    [...postgresqlClosure].filter((fileName) =>
      bigqueryClosure.has(fileName),
    ),
  );
  const postgresqlMetrics = metricsForFiles(
    report,
    postgresqlClosure,
  );
  const bigqueryMetrics = metricsForFiles(report, bigqueryClosure);
  const sharedMetrics = metricsForFiles(
    report,
    sharedGrammarChunks,
  );
  const workerEntryMetrics = metricsForFiles(
    report,
    staticWorkerEntry,
  );
  if (postgresqlMetrics.gzipBytes > POSTGRESQL_GZIP_LIMIT) {
    throw new Error(
      `PostgreSQL graph exceeded ${POSTGRESQL_GZIP_LIMIT} gzip bytes: ${postgresqlMetrics.gzipBytes}`,
    );
  }
  if (bigqueryMetrics.gzipBytes > BIGQUERY_GZIP_LIMIT) {
    throw new Error(
      `BigQuery graph exceeded ${BIGQUERY_GZIP_LIMIT} gzip bytes: ${bigqueryMetrics.gzipBytes}`,
    );
  }
  if (report.gzipBytes > WORKER_TOTAL_GZIP_LIMIT) {
    throw new Error(
      `Worker output exceeded ${WORKER_TOTAL_GZIP_LIMIT} gzip bytes: ${report.gzipBytes}`,
    );
  }
  if (report.rawBytes > WORKER_TOTAL_RAW_LIMIT) {
    throw new Error(
      `Worker output exceeded ${WORKER_TOTAL_RAW_LIMIT} raw bytes: ${report.rawBytes}`,
    );
  }
  return {
    ...report,
    dialects: {
      bigquery: {
        ...bigqueryMetrics,
        gzipLimit: BIGQUERY_GZIP_LIMIT,
      },
      postgresql: {
        ...postgresqlMetrics,
        gzipLimit: POSTGRESQL_GZIP_LIMIT,
      },
    },
    graph: {
      allowedParserModuleIds: [
        "node-sql-parser/build/bigquery.js",
        "node-sql-parser/build/postgresql.js",
      ],
      pageEntry: pageEntry.fileName,
      parserWorkerEntry: workerEntry.fileName,
      sharedGrammarChunks: sharedMetrics,
      workerEntry: workerEntryMetrics,
    },
    limits: {
      gzipBytes: WORKER_TOTAL_GZIP_LIMIT,
      rawBytes: WORKER_TOTAL_RAW_LIMIT,
    },
  };
}

function verifyCoreExcludesParser(coreDirectory) {
  const moduleIds = JSON.parse(
    readFileSync(join(coreDirectory, "module-ids.json"), "utf8"),
  );
  if (!Array.isArray(moduleIds)) {
    throw new Error("Core module trace was not an array");
  }
  const parserModules = moduleIds.filter(
    (moduleId) =>
      typeof moduleId === "string" &&
      moduleId.includes("/node-sql-parser/"),
  );
  if (parserModules.length > 0) {
    throw new Error(
      `Core-only build included parser modules: ${parserModules.join(", ")}`,
    );
  }
  const workerModules = moduleIds.filter(
    (moduleId) =>
      typeof moduleId === "string" &&
      /(?:^|[/\\])[^/\\]*worker[^/\\]*\.[cm]?[jt]s$/i.test(moduleId),
  );
  if (workerModules.length > 0) {
    throw new Error(
      `Core-only build included worker modules: ${workerModules.join(", ")}`,
    );
  }
  for (const path of listFiles(coreDirectory)) {
    const extension = extname(path);
    if (extension !== ".js" && extension !== ".json") {
      continue;
    }
    if (/worker/i.test(basename(path))) {
      throw new Error(`Core-only build emitted worker asset ${basename(path)}`);
    }
    const contents = readFileSync(path, "utf8");
    const marker = PARSER_MARKERS.find((candidate) =>
      contents.includes(candidate),
    );
    if (marker !== undefined) {
      throw new Error(
        `Core-only output ${basename(path)} contained parser marker ${marker}`,
      );
    }
    if (extension === ".js" && /new\s+Worker\s*\(/.test(contents)) {
      throw new Error(
        `Core-only output ${basename(path)} contained a worker constructor`,
      );
    }
  }
  return moduleIds.length;
}

function verifySsrImport(fixtureDirectory) {
  const source = `
Object.defineProperty(globalThis, "window", {
  configurable: true,
  get() {
    throw new Error("SSR import read window");
  },
});
Object.defineProperty(globalThis, "Worker", {
  configurable: true,
  get() {
    throw new Error("SSR import read Worker");
  },
});
const api = await import("@marimo-team/codemirror-sql/vnext");
if (
  typeof api.createSqlLanguageService !== "function" ||
  typeof api.duckdbDialect !== "function"
) {
  throw new Error("Packed SSR import was incomplete");
}
`;
  run(
    process.execPath,
    ["--input-type=module", "--eval", source],
    fixtureDirectory,
  );
}

function startStaticServer(directory) {
  const root = resolve(directory);
  const server = createServer((request, response) => {
    const requestUrl = new URL(
      request.url ?? "/",
      "http://worker-placement.invalid",
    );
    const relativePath =
      requestUrl.pathname === "/"
        ? "workers.html"
        : decodeURIComponent(requestUrl.pathname.slice(1));
    const path = resolve(root, relativePath);
    if (path !== root && !path.startsWith(`${root}${sep}`)) {
      response.writeHead(403);
      response.end("forbidden");
      return;
    }
    if (!existsSync(path) || !statSync(path).isFile()) {
      response.writeHead(404);
      response.end("not found");
      return;
    }
    response.writeHead(200, {
      "Cache-Control": "no-store",
      "Content-Security-Policy": CONTENT_SECURITY_POLICY,
      "Content-Type":
        MIME_TYPES.get(extname(path)) ??
        "application/octet-stream",
      "Cross-Origin-Resource-Policy": "same-origin",
      "X-Content-Type-Options": "nosniff",
    });
    createReadStream(path).pipe(response);
  });
  return new Promise((resolvePromise, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (address === null || typeof address === "string") {
        reject(new Error("Static server did not acquire a TCP port"));
        return;
      }
      resolvePromise({
        close: async () =>
          await new Promise((resolveClose, rejectClose) => {
            server.close((error) => {
              if (error) {
                rejectClose(error);
              } else {
                resolveClose();
              }
            });
          }),
        url: `http://127.0.0.1:${address.port}/workers.html`,
      });
    });
  });
}

async function runChromium(fixtureDirectory, workersDirectory) {
  const fixtureRequire = createRequire(
    join(fixtureDirectory, "package.json"),
  );
  const { chromium } = fixtureRequire("playwright");
  const staticServer = await startStaticServer(workersDirectory);
  let browser;
  let result;
  let operationError;
  try {
    browser = await chromium.launch({ headless: true });
    const page = await browser.newPage();
    const browserErrors = [];
    page.on("console", (message) => {
      if (message.type() === "error") {
        browserErrors.push(`console: ${message.text()}`);
      }
    });
    page.on("pageerror", (error) => {
      browserErrors.push(`page: ${error.message}`);
    });
    const response = await page.goto(staticServer.url, {
      waitUntil: "load",
    });
    if (
      response === null ||
      response.headers()["content-security-policy"] !==
        CONTENT_SECURITY_POLICY
    ) {
      throw new Error("Fixture did not receive the strict CSP header");
    }
    await page.waitForFunction(
      () =>
        document.body.dataset.status === "passed" ||
        document.body.dataset.status === "failed",
      undefined,
      { timeout: 20_000 },
    );
    const status = await page.locator("body").getAttribute("data-status");
    if (status !== "passed") {
      throw new Error(
        `Worker fixture failed: ${await page.locator("#result").textContent()}`,
      );
    }
    if (browserErrors.length > 0) {
      throw new Error(browserErrors.join("\n"));
    }
    const timings = await page.evaluate(
      () => globalThis.__CODEMIRROR_SQL_WORKER_PLACEMENT__,
    );
    if (
      typeof timings !== "object" ||
      timings === null ||
      typeof timings.workerReadyMs !== "number" ||
      typeof timings.postgresql?.firstRequestRoundTripMs !==
        "number" ||
      typeof timings.bigquery?.firstRequestRoundTripMs !== "number"
    ) {
      throw new Error("Browser fixture returned malformed timing data");
    }
    result = {
      browserVersion: browser.version(),
      csp: CONTENT_SECURITY_POLICY,
      timings,
    };
  } catch (error) {
    operationError = error;
  }

  const cleanupErrors = [];
  if (browser !== undefined) {
    try {
      await browser.close();
    } catch (error) {
      cleanupErrors.push(error);
    }
  }
  try {
    await staticServer.close();
  } catch (error) {
    cleanupErrors.push(error);
  }
  if (operationError !== undefined) {
    if (cleanupErrors.length > 0) {
      throw new AggregateError(
        [operationError, ...cleanupErrors],
        "Worker browser verification and cleanup failed",
      );
    }
    throw operationError;
  }
  if (cleanupErrors.length > 0) {
    throw new AggregateError(
      cleanupErrors,
      "Worker browser verification cleanup failed",
    );
  }
  if (result === undefined) {
    throw new Error("Worker browser verification produced no result");
  }
  return result;
}

const reportPath = parseArguments(process.argv.slice(2));
const temporaryDirectory = mkdtempSync(
  join(tmpdir(), "codemirror-sql-worker-placement-"),
);

try {
  runPackageManager(["run", "build"], repository);
  const packOutput = JSON.parse(
    runPackageManager(
      [
        "pack",
        "--json",
        "--pack-destination",
        temporaryDirectory,
      ],
      repository,
      true,
    ),
  );
  const manifest = Array.isArray(packOutput) ? packOutput[0] : packOutput;
  if (!manifest || typeof manifest.filename !== "string") {
    throw new Error("pnpm pack did not report an archive");
  }
  const archive = join(temporaryDirectory, basename(manifest.filename));
  const fixtureDirectory = join(temporaryDirectory, "fixture");
  cpSync(fixtureSource, fixtureDirectory, { recursive: true });
  runPackageManager(
    ["install", "--frozen-lockfile", "--ignore-scripts"],
    fixtureDirectory,
  );

  const packageDirectory = join(
    fixtureDirectory,
    "node_modules",
    "@marimo-team",
    "codemirror-sql",
  );
  mkdirSync(packageDirectory, { recursive: true });
  run(
    "tar",
    ["-xzf", archive, "-C", packageDirectory, "--strip-components=1"],
    fixtureDirectory,
  );
  const packedPackage = JSON.parse(
    readFileSync(join(packageDirectory, "package.json"), "utf8"),
  );
  const fixturePackage = JSON.parse(
    readFileSync(join(fixtureDirectory, "package.json"), "utf8"),
  );
  if (
    packedPackage.name !== "@marimo-team/codemirror-sql" ||
    packedPackage.version !== manifest.version ||
    packedPackage.dependencies?.["node-sql-parser"] !== "5.4.0"
  ) {
    throw new Error("Extracted package did not match the pnpm pack manifest");
  }
  if (
    fixturePackage.dependencies?.["node-sql-parser"] !==
    packedPackage.dependencies["node-sql-parser"]
  ) {
    throw new Error(
      "Fixture direct parser dependency did not match the packed transitive dependency",
    );
  }
  verifySsrImport(fixtureDirectory);

  runPackageManager(["run", "build:core"], fixtureDirectory);
  runPackageManager(["run", "build:workers"], fixtureDirectory);
  const coreDirectory = join(fixtureDirectory, "core-dist");
  const workersDirectory = join(fixtureDirectory, "workers-dist");
  const coreModuleCount = verifyCoreExcludesParser(coreDirectory);
  const chromiumResult = await runChromium(
    fixtureDirectory,
    workersDirectory,
  );
  const workerBundles = verifyWorkerAssets(workersDirectory);
  if (
    chromiumResult.timings.resources.mainBeforeCreation.length !== 0
  ) {
    throw new Error("Browser reported eager parser worker loading");
  }
  const report = {
    bundles: {
      core: bundleReport(coreDirectory),
      workers: workerBundles,
    },
    evidence: {
      coreModuleCount,
      coreParserModules: 0,
      exactTarballSsrImport: true,
      exactNodeSqlParserDependency: "5.4.0",
      fixtureDirectDependencyReason:
        "The fixture installs dependencies before extracting the exact tarball",
      parserMarkerCount: PARSER_MARKERS.length,
      strictSameOriginCsp: true,
    },
    package: {
      archive: basename(archive),
      archiveSha256: sha256(archive),
      name: packedPackage.name,
      version: packedPackage.version,
    },
    runtime: {
      chromium: chromiumResult.browserVersion,
      node: process.version,
      platform: `${process.platform}-${process.arch}`,
    },
    schemaVersion: 1,
    timingsMs: chromiumResult.timings,
  };
  const serializedReport = `${JSON.stringify(report, null, 2)}\n`;
  process.stdout.write(serializedReport);
  if (reportPath !== undefined) {
    mkdirSync(dirname(reportPath), { recursive: true });
    writeFileSync(reportPath, serializedReport);
  }
} finally {
  if (
    basename(temporaryDirectory).startsWith(
      "codemirror-sql-worker-placement-",
    )
  ) {
    rmSync(temporaryDirectory, { force: true, recursive: true });
  }
}
