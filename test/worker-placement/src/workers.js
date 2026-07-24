import {
  createSqlLanguageService,
  duckdbDialect,
} from "@marimo-team/codemirror-sql/vnext";

const REQUEST_TIMEOUT_MS = 10_000;

function request(worker, id, text) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      reject(new Error(`Worker request ${id} timed out`));
    }, REQUEST_TIMEOUT_MS);
    const onError = (event) => {
      clearTimeout(timeout);
      reject(new Error(event.message || `Worker request ${id} failed`));
    };
    const onMessage = (event) => {
      if (event.data?.id !== id) {
        return;
      }
      clearTimeout(timeout);
      worker.removeEventListener("error", onError);
      worker.removeEventListener("message", onMessage);
      if (event.data.status !== "parsed") {
        reject(new Error(`Worker request ${id} did not parse`));
        return;
      }
      resolve(event.data);
    };
    worker.addEventListener("error", onError, { once: true });
    worker.addEventListener("message", onMessage);
    worker.postMessage({ id, text });
  });
}

async function measureWorker(url, text, expectedType) {
  const startedAt = performance.now();
  const worker = url();
  try {
    const cold = await request(worker, 1, text);
    const coldMs = performance.now() - startedAt;
    const warmStartedAt = performance.now();
    const warm = await request(worker, 2, text);
    const warmRoundTripMs = performance.now() - warmStartedAt;
    if (cold.astType !== expectedType || warm.astType !== expectedType) {
      throw new Error(
        `Expected ${expectedType}, received ${cold.astType}/${warm.astType}`,
      );
    }
    return {
      coldMs,
      coldParseMs: cold.parseMs,
      warmParseMs: warm.parseMs,
      warmRoundTripMs,
    };
  } finally {
    worker.terminate();
  }
}

function createPostgresqlWorker() {
  return new Worker(
    new URL("./postgresql-worker.js", import.meta.url),
    {
      name: "codemirror-sql-postgresql-placement",
      type: "module",
    },
  );
}

function createBigQueryWorker() {
  return new Worker(
    new URL("./bigquery-worker.js", import.meta.url),
    {
      name: "codemirror-sql-bigquery-placement",
      type: "module",
    },
  );
}

function dialectResourceNames() {
  return performance
    .getEntriesByType("resource")
    .map((entry) => entry.name)
    .filter((name) => /(?:bigquery|postgresql)/i.test(name));
}

async function run() {
  const service = createSqlLanguageService({
    dialects: [duckdbDialect()],
  });
  service.dispose();

  const sentinel = Object.freeze({ owner: "browser-main-thread" });
  const original = Object.getOwnPropertyDescriptor(
    globalThis,
    "NodeSQLParser",
  );
  Object.defineProperty(globalThis, "NodeSQLParser", {
    configurable: true,
    value: sentinel,
  });

  try {
    const beforeCreation = dialectResourceNames();
    if (beforeCreation.length !== 0) {
      throw new Error(
        `Dialect assets loaded before worker creation: ${beforeCreation.join(", ")}`,
      );
    }
    const postgresql = await measureWorker(
      createPostgresqlWorker,
      "SELECT 1 AS value",
      "select",
    );
    const afterPostgresql = dialectResourceNames();
    if (
      !afterPostgresql.some((name) => /postgresql/i.test(name)) ||
      afterPostgresql.some((name) => /bigquery/i.test(name))
    ) {
      throw new Error(
        "PostgreSQL creation did not load only PostgreSQL assets",
      );
    }
    const bigquery = await measureWorker(
      createBigQueryWorker,
      "SELECT `project.dataset.table`.id FROM `project.dataset.table`",
      "select",
    );
    const afterBigQuery = dialectResourceNames();
    if (!afterBigQuery.some((name) => /bigquery/i.test(name))) {
      throw new Error("BigQuery creation did not load BigQuery assets");
    }
    if (globalThis.NodeSQLParser !== sentinel) {
      throw new Error("A parser bundle changed the browser main global");
    }
    const report = Object.freeze({
      bigquery,
      lazyResources: {
        afterBigQuery,
        afterPostgresql,
        beforeCreation,
      },
      postgresql,
    });
    globalThis.__CODEMIRROR_SQL_WORKER_PLACEMENT__ = report;
    document.body.dataset.status = "passed";
    document.querySelector("#result").textContent = JSON.stringify(report);
  } finally {
    if (original === undefined) {
      Reflect.deleteProperty(globalThis, "NodeSQLParser");
    } else {
      Object.defineProperty(globalThis, "NodeSQLParser", original);
    }
  }
}

run().catch((error) => {
  document.body.dataset.status = "failed";
  document.querySelector("#result").textContent =
    error instanceof Error ? error.message : "unknown worker fixture failure";
});
