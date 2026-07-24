import {
  createSqlLanguageService,
  duckdbDialect,
} from "@marimo-team/codemirror-sql/vnext";

const REQUEST_TIMEOUT_MS = 10_000;

function request(worker, requestValue) {
  return new Promise((resolve, reject) => {
    const startedAt = performance.now();
    const timeout = setTimeout(() => {
      reject(new Error(`Worker request ${requestValue.id} timed out`));
    }, REQUEST_TIMEOUT_MS);
    const onError = (event) => {
      clearTimeout(timeout);
      reject(
        new Error(
          event.message ||
            `Worker request ${requestValue.id} failed`,
        ),
      );
    };
    const onMessage = (event) => {
      if (event.data?.id !== requestValue.id) {
        return;
      }
      clearTimeout(timeout);
      worker.removeEventListener("error", onError);
      worker.removeEventListener("message", onMessage);
      resolve({
        response: event.data,
        roundTripMs: performance.now() - startedAt,
      });
    };
    worker.addEventListener("error", onError, { once: true });
    worker.addEventListener("message", onMessage);
    worker.postMessage(requestValue);
  });
}

function waitForReady(worker) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      reject(new Error("Parser worker ready handshake timed out"));
    }, REQUEST_TIMEOUT_MS);
    const onError = (event) => {
      clearTimeout(timeout);
      reject(
        new Error(event.message || "Parser worker startup failed"),
      );
    };
    const onMessage = (event) => {
      if (event.data?.kind !== "ready") {
        return;
      }
      clearTimeout(timeout);
      worker.removeEventListener("error", onError);
      worker.removeEventListener("message", onMessage);
      resolve(event.data);
    };
    worker.addEventListener("error", onError, { once: true });
    worker.addEventListener("message", onMessage);
  });
}

function createParserWorker() {
  return new Worker(
    new URL("./parser-worker-entry.js", import.meta.url),
    {
      name: "codemirror-sql-parser-placement",
      type: "module",
    },
  );
}

function parserResourceNames() {
  return performance
    .getEntriesByType("resource")
    .map((entry) => entry.name)
    .filter((name) => /parser-worker/i.test(name));
}

function requireParsed(result, expectedGrammar) {
  if (
    result.response.status !== "parsed" ||
    result.response.kind !== "result" ||
    result.response.grammar !== expectedGrammar ||
    result.response.astType !== "select"
  ) {
    throw new Error(`${expectedGrammar} worker request did not parse`);
  }
  if (
    result.response.descriptorEquality.NodeSQLParser !== true ||
    result.response.descriptorEquality.global !== true
  ) {
    throw new Error(
      `${expectedGrammar} worker globals were not restored exactly`,
    );
  }
}

async function measureGrammar(worker, grammar, text, firstId) {
  const first = await request(worker, {
    grammar,
    id: firstId,
    kind: "parse",
    text,
  });
  requireParsed(first, grammar);
  if (
    first.response.moduleCached !== false ||
    first.response.grammarLoadAndInitMs < 0
  ) {
    throw new Error(`${grammar} first request did not load its grammar`);
  }
  const warm = await request(worker, {
    grammar,
    id: firstId + 1,
    kind: "parse",
    text,
  });
  requireParsed(warm, grammar);
  if (
    warm.response.moduleCached !== true ||
    warm.response.grammarLoadAndInitMs !== 0
  ) {
    throw new Error(`${grammar} warm request did not reuse its parser`);
  }
  return {
    astifyMs: first.response.astifyMs,
    firstRequestRoundTripMs: first.roundTripMs,
    grammarLoadAndInitMs:
      first.response.grammarLoadAndInitMs,
    resourcesAfterFirstRequest: first.response.resources,
    warmAstifyMs: warm.response.astifyMs,
    warmRequestRoundTripMs: warm.roundTripMs,
    warmResources: warm.response.resources,
  };
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

  let worker;
  try {
    const mainResourcesBeforeCreation = parserResourceNames();
    if (mainResourcesBeforeCreation.length !== 0) {
      throw new Error(
        `Parser worker loaded before creation: ${mainResourcesBeforeCreation.join(", ")}`,
      );
    }
    const workerStartedAt = performance.now();
    worker = createParserWorker();
    const ready = await waitForReady(worker);
    const workerReadyMs = performance.now() - workerStartedAt;
    const mainResourcesAfterReady = parserResourceNames();
    if (mainResourcesAfterReady.length !== 1) {
      throw new Error("Parser worker entry did not load exactly once");
    }

    const postgresql = await measureGrammar(
      worker,
      "postgresql",
      "SELECT 1 AS value",
      1,
    );
    const postgresqlResourceNames =
      postgresql.resourcesAfterFirstRequest.map(
        (resource) => resource.name,
      );
    if (
      !postgresqlResourceNames.some((name) =>
        /postgresql/i.test(name),
      ) ||
      postgresqlResourceNames.some((name) =>
        /bigquery/i.test(name),
      )
    ) {
      throw new Error(
        "PostgreSQL request did not load only PostgreSQL resources",
      );
    }

    const bigquery = await measureGrammar(
      worker,
      "bigquery",
      "SELECT `project.dataset.table`.id FROM `project.dataset.table`",
      3,
    );
    const bigQueryResourceNames =
      bigquery.resourcesAfterFirstRequest.map(
        (resource) => resource.name,
      );
    if (
      !bigQueryResourceNames.some((name) =>
        /bigquery/i.test(name),
      ) ||
      !bigQueryResourceNames.some((name) =>
        /postgresql/i.test(name),
      )
    ) {
      throw new Error(
        "BigQuery request did not retain both lazy grammar resources",
      );
    }

    const cleanupPoison = await request(worker, {
      id: 5,
      kind: "test-cleanup-poison",
    });
    if (
      cleanupPoison.response.kind !==
        "cleanup-poison-result" ||
      cleanupPoison.response.evidence.cleanupFailed !== true ||
      cleanupPoison.response.evidence.poisonedRetryFailed !== true ||
      cleanupPoison.response.evidence.evaluations !== 1
    ) {
      throw new Error(
        "Synthetic cleanup failure did not poison its loader",
      );
    }
    if (globalThis.NodeSQLParser !== sentinel) {
      throw new Error("A parser bundle changed the browser main global");
    }
    const report = Object.freeze({
      bigquery,
      cleanupPoison: cleanupPoison.response.evidence,
      postgresql,
      resources: {
        mainAfterReady: mainResourcesAfterReady,
        mainBeforeCreation: mainResourcesBeforeCreation,
        workerAtReady: ready.resources,
      },
      workerReadyMs,
    });
    globalThis.__CODEMIRROR_SQL_WORKER_PLACEMENT__ = report;
    document.body.dataset.status = "passed";
    document.querySelector("#result").textContent =
      JSON.stringify(report);
  } finally {
    if (worker !== undefined) {
      worker.terminate();
    }
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
    error instanceof Error
      ? error.message
      : "unknown worker fixture failure";
});
