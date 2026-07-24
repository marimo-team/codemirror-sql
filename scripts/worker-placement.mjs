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
const WORKER_TOTAL_GZIP_LIMIT = 124 * 1024;
const WORKER_TOTAL_RAW_LIMIT = 590 * 1024;
const MIME_TYPES = new Map([
  [".css", "text/css; charset=utf-8"],
  [".html", "text/html; charset=utf-8"],
  [".js", "text/javascript; charset=utf-8"],
  [".json", "application/json; charset=utf-8"],
]);
const repository = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const fixtureSource = join(repository, "test", "worker-placement");
const temporaryDirectory = mkdtempSync(
  join(tmpdir(), "codemirror-sql-worker-placement-"),
);
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

function verifyWorkerAssets(workersDirectory) {
  const report = bundleReport(workersDirectory);
  const javascriptFiles = report.files.filter((file) =>
    file.file.endsWith(".js"),
  );
  const postgresqlFiles = javascriptFiles.filter((file) =>
    /postgresql/i.test(file.file),
  );
  const bigqueryFiles = javascriptFiles.filter((file) =>
    /bigquery/i.test(file.file),
  );
  if (postgresqlFiles.length === 0 || bigqueryFiles.length === 0) {
    throw new Error(
      "Worker build did not emit separate dialect assets",
    );
  }
  if (
    postgresqlFiles.some((postgresql) =>
      bigqueryFiles.some((bigquery) => bigquery.file === postgresql.file),
    )
  ) {
    throw new Error("PostgreSQL and BigQuery shared a dialect-named asset");
  }
  const postgresqlGzipBytes = postgresqlFiles.reduce(
    (total, file) => total + file.gzipBytes,
    0,
  );
  const bigqueryGzipBytes = bigqueryFiles.reduce(
    (total, file) => total + file.gzipBytes,
    0,
  );
  if (postgresqlGzipBytes > POSTGRESQL_GZIP_LIMIT) {
    throw new Error(
      `PostgreSQL assets exceeded ${POSTGRESQL_GZIP_LIMIT} gzip bytes: ${postgresqlGzipBytes}`,
    );
  }
  if (bigqueryGzipBytes > BIGQUERY_GZIP_LIMIT) {
    throw new Error(
      `BigQuery assets exceeded ${BIGQUERY_GZIP_LIMIT} gzip bytes: ${bigqueryGzipBytes}`,
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
        files: bigqueryFiles.map((file) => file.file),
        gzipBytes: bigqueryGzipBytes,
        gzipLimit: BIGQUERY_GZIP_LIMIT,
      },
      postgresql: {
        files: postgresqlFiles.map((file) => file.file),
        gzipBytes: postgresqlGzipBytes,
        gzipLimit: POSTGRESQL_GZIP_LIMIT,
      },
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
  for (const path of listFiles(coreDirectory)) {
    const extension = extname(path);
    if (extension !== ".js" && extension !== ".json") {
      continue;
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
      typeof timings.postgresql?.coldMs !== "number" ||
      typeof timings.bigquery?.coldMs !== "number"
    ) {
      throw new Error("Browser fixture returned malformed timing data");
    }
    return {
      browserVersion: browser.version(),
      csp: CONTENT_SECURITY_POLICY,
      timings,
    };
  } finally {
    if (browser !== undefined) {
      await browser.close();
    }
    await staticServer.close();
  }
}

const reportPath = parseArguments(process.argv.slice(2));

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
  if (
    packedPackage.name !== "@marimo-team/codemirror-sql" ||
    packedPackage.version !== manifest.version
  ) {
    throw new Error("Extracted package did not match the pnpm pack manifest");
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
    chromiumResult.timings.lazyResources.beforeCreation.length !== 0
  ) {
    throw new Error("Browser reported eager dialect asset loading");
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
