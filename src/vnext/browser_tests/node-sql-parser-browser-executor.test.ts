import { expect, test } from "vitest";
import {
  createNodeSqlParserBrowserExecutor,
  type NodeSqlParserBrowserExecutor,
  type NodeSqlParserBrowserExecutorEventType,
  type NodeSqlParserBrowserExecutorWorker,
} from "../node-sql-parser-browser-executor.js";

const REAL_WORKER_LIMITS = Object.freeze({
  executionDeadlineMs: 4_000,
  maxQueuedRequests: 4,
  maxQueuedTextUnits: 32_768,
  queueDeadlineMs: 4_000,
  startupDeadlineMs: 4_000,
});
const FAILURE_WORKER_LIMITS = Object.freeze({
  ...REAL_WORKER_LIMITS,
  executionDeadlineMs: 250,
  queueDeadlineMs: 250,
  startupDeadlineMs: 250,
});

function adaptWorker(
  worker: Worker,
): NodeSqlParserBrowserExecutorWorker {
  type Listener = (event: unknown) => void;
  const errorListeners = new Map<
    Listener,
    (event: ErrorEvent) => void
  >();
  const messageListeners = new Map<
    Listener,
    (event: MessageEvent<unknown>) => void
  >();
  const messageErrorListeners = new Map<
    Listener,
    (event: MessageEvent<unknown>) => void
  >();

  return {
    addEventListener(
      type: NodeSqlParserBrowserExecutorEventType,
      listener: Listener,
    ): void {
      switch (type) {
        case "error": {
          const adapter = (event: ErrorEvent): void => {
            listener(event);
          };
          errorListeners.set(listener, adapter);
          worker.addEventListener("error", adapter);
          return;
        }
        case "message": {
          const adapter = (event: MessageEvent<unknown>): void => {
            listener(event);
          };
          messageListeners.set(listener, adapter);
          worker.addEventListener("message", adapter);
          return;
        }
        case "messageerror": {
          const adapter = (event: MessageEvent<unknown>): void => {
            listener(event);
          };
          messageErrorListeners.set(listener, adapter);
          worker.addEventListener("messageerror", adapter);
        }
      }
    },
    postMessage(message: unknown): void {
      worker.postMessage(message);
    },
    removeEventListener(
      type: NodeSqlParserBrowserExecutorEventType,
      listener: Listener,
    ): void {
      switch (type) {
        case "error": {
          const adapter = errorListeners.get(listener);
          if (adapter !== undefined) {
            errorListeners.delete(listener);
            worker.removeEventListener("error", adapter);
          }
          return;
        }
        case "message": {
          const adapter = messageListeners.get(listener);
          if (adapter !== undefined) {
            messageListeners.delete(listener);
            worker.removeEventListener("message", adapter);
          }
          return;
        }
        case "messageerror": {
          const adapter = messageErrorListeners.get(listener);
          if (adapter !== undefined) {
            messageErrorListeners.delete(listener);
            worker.removeEventListener("messageerror", adapter);
          }
        }
      }
    },
    terminate(): void {
      worker.terminate();
      errorListeners.clear();
      messageListeners.clear();
      messageErrorListeners.clear();
    },
  };
}

function createSilentWorker(): NodeSqlParserBrowserExecutorWorker {
  return adaptWorker(
    new Worker(
      new URL(
        "./fixtures/node-sql-parser-silent-worker.js",
        import.meta.url,
      ),
      {
        name: "codemirror-sql-parser-silent-test",
        type: "module",
      },
    ),
  );
}

function createCrashWorker(): NodeSqlParserBrowserExecutorWorker {
  return adaptWorker(
    new Worker(
      new URL(
        "./fixtures/node-sql-parser-crash-worker.js",
        import.meta.url,
      ),
      {
        name: "codemirror-sql-parser-crash-test",
        type: "module",
      },
    ),
  );
}

function createRecoveryWorker(
  name: string,
): NodeSqlParserBrowserExecutorWorker {
  return adaptWorker(
    new Worker(
      new URL(
        "../node-sql-parser-browser-worker.ts",
        import.meta.url,
      ),
      { name, type: "module" },
    ),
  );
}

function submitQuery(
  executor: NodeSqlParserBrowserExecutor,
  grammar: "bigquery" | "postgresql",
  text: string,
) {
  return executor.submit({ grammar, text }).result;
}

test(
  "runs sequential cold, warm, and cross-grammar work through the production worker",
  { timeout: 15_000 },
  async () => {
    const executor =
      createNodeSqlParserBrowserExecutor(REAL_WORKER_LIMITS);
    try {
      await expect(
        submitQuery(
          executor,
          "postgresql",
          "SELECT 1 AS cold_value",
        ),
      ).resolves.toStrictEqual({
        kind: "parsed",
        statementKind: "query",
      });
      await expect(
        submitQuery(
          executor,
          "postgresql",
          "SELECT 2 AS warm_value",
        ),
      ).resolves.toStrictEqual({
        kind: "parsed",
        statementKind: "query",
      });
      await expect(
        submitQuery(
          executor,
          "bigquery",
          "SELECT `project.dataset.table`.id FROM `project.dataset.table`",
        ),
      ).resolves.toStrictEqual({
        kind: "parsed",
        statementKind: "query",
      });
    } finally {
      executor.dispose();
    }
  },
);

test(
  "retires a silent active parse and serves later work on a fresh generation",
  { timeout: 10_000 },
  async () => {
    let generation = 0;
    const executor = createNodeSqlParserBrowserExecutor({
      ...FAILURE_WORKER_LIMITS,
      workerFactory: () => {
        generation += 1;
        return generation === 1
          ? createSilentWorker()
          : createRecoveryWorker(
              "codemirror-sql-parser-recovery-test",
            );
      },
    });
    try {
      await expect(
        submitQuery(executor, "postgresql", "SELECT 1"),
      ).resolves.toStrictEqual({
        code: "execution-timeout",
        kind: "failed",
      });
      await expect(
        submitQuery(executor, "postgresql", "SELECT 2"),
      ).resolves.toStrictEqual({
        kind: "parsed",
        statementKind: "query",
      });
      expect(generation).toBe(2);
    } finally {
      executor.dispose();
    }
  },
);

test(
  "retires a crashed active parse and serves later work on a fresh generation",
  { timeout: 10_000 },
  async () => {
    let generation = 0;
    const executor = createNodeSqlParserBrowserExecutor({
      ...FAILURE_WORKER_LIMITS,
      workerFactory: () => {
        generation += 1;
        return generation === 1
          ? createCrashWorker()
          : createRecoveryWorker(
              "codemirror-sql-parser-crash-recovery-test",
            );
      },
    });
    try {
      await expect(
        submitQuery(executor, "postgresql", "SELECT 1"),
      ).resolves.toStrictEqual({
        code: "worker-failure",
        kind: "failed",
      });
      await expect(
        submitQuery(executor, "bigquery", "SELECT 2"),
      ).resolves.toStrictEqual({
        kind: "parsed",
        statementKind: "query",
      });
      expect(generation).toBe(2);
    } finally {
      executor.dispose();
    }
  },
);
